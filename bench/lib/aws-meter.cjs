'use strict';
/*
 * Wire-level op meter for the AWS SDK.
 *
 * WHY THIS SITS AT THE SDK LAYER, not at the library's metrics sink. The sink emits no `storage.put` event —
 * a known observability gap — and a PUT bills at 12.5x a GET, so an ingest-heavy workload priced from the sink
 * alone is materially understated. The previous calibration run learned this the expensive way; the meter is
 * the fix, and it counts what actually went over the wire regardless of what the library chose to report.
 *
 * It is a middleware, not a wrapper around individual calls: anything the SDK sends is counted, including
 * requests the driver makes that the caller never asked for (a multipart upload's per-part PUTs, a retry, a
 * HEAD behind a probe). A meter you have to remember to call is a meter that undercounts.
 *
 * Billing classes, not HTTP verbs. S3 prices PUT/COPY/POST/LIST together and GET/SELECT together, so a
 * `ListObjectsV2` costs the same as a `PutObject` and eight times a `GetObject`. Counting by verb would put
 * LIST in the cheap bucket and understate any workload that enumerates.
 */

/** S3 commands that bill at the PUT/COPY/POST/LIST rate. Everything else that bills is a GET-class read. */
const PUT_CLASS = new Set([
  'PutObjectCommand',
  'CopyObjectCommand',
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'CompleteMultipartUploadCommand',
  'ListObjectsV2Command',
  'ListObjectsCommand',
  // Teardown lists VERSIONS to empty a versioned bucket. It is a LIST like the others, and it was missing
  // here — so it fell through to the GET rate, the 12.5x understatement this set exists to prevent.
  'ListObjectVersionsCommand',
  'ListMultipartUploadsCommand',
  'ListPartsCommand',
  'CreateBucketCommand',
]);

/**
 * Commands AWS does not bill as a request.
 *
 * DELETE is free, and so is aborting a multipart upload. Listing them explicitly rather than treating
 * "unknown" as free is the point: an unrecognised command lands in the GET class and is *counted*, so a new
 * call added to a driver shows up in the bill rather than silently costing nothing.
 */
const FREE = new Set([
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'DeleteBucketCommand',
  'AbortMultipartUploadCommand',
]);

/** A fresh, zeroed tally. */
function newTally() {
  return {
    put: 0,
    get: 0,
    free: 0,
    bytesUp: 0,
    bytesDown: 0,
    byCommand: Object.create(null),
    reads: { whole: { n: 0, bytes: 0 }, suffix: { n: 0, bytes: 0 }, range: { n: 0, bytes: 0 } },
  };
}

/**
 * What kind of read a `GetObject` was, from its `Range` header.
 *
 * WHY THE SHAPE MATTERS. A single bytes-fetched figure conflated two different things. Measured request by
 * request, one cold intersect of two ~1 MB segments was 2 whole-object reads of the pointer (158 B each), 2
 * SUFFIX reads of the last 256 KiB of each generation — the reader grabs a generous tail so the footer and index
 * come back in one round trip — and 200 explicit ranges of ~516 B, one per shared chunk. The payload was 4.9% of
 * the objects, exactly the published 100-of-2,000; the tail reads were another 24.9%, and a combined "29.8%
 * fetched" said neither thing. The shape separates them without having to know the file format.
 */
function rangeShape(range) {
  if (range === undefined || range === null || range === '') return 'whole';
  return /^bytes=-\d+$/.test(String(range)) ? 'suffix' : 'range';
}

/**
 * Classify one command name into a billing class.
 *
 * Exported for the tests: the classification IS the price, so it is the part that has to be pinned. A
 * misfiled LIST understates an enumerating workload by 12.5x and nothing downstream would notice.
 */
function classify(commandName) {
  if (FREE.has(commandName)) return 'free';
  if (PUT_CLASS.has(commandName)) return 'put';
  return 'get';
}

/**
 * Attach the meter to an S3 client and return the tally it fills.
 *
 * The tally is live: read it during a run to enforce a spend ceiling mid-phase, which is the only way to bound
 * a phase whose op count is not known in advance.
 */
function meter(client) {
  const tally = newTally();
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const name = context.commandName ?? 'UnknownCommand';
      const klass = classify(name);
      tally[klass] += 1;
      tally.byCommand[name] = (tally.byCommand[name] ?? 0) + 1;
      const body = args?.input?.Body;
      if (typeof body?.byteLength === 'number') tally.bytesUp += body.byteLength;
      const result = await next(args);
      const len = Number(result?.output?.ContentLength);
      if (Number.isFinite(len)) {
        tally.bytesDown += len;
        if (name === 'GetObjectCommand') {
          const shape = tally.reads[rangeShape(args?.input?.Range)];
          shape.n += 1;
          shape.bytes += len;
        }
      }
      return result;
    },
    // `initialize` sees the command before the SDK resolves it, which is where `context.commandName` is set
    // and where a retry re-enters — so retries are counted individually, as AWS bills them.
    { step: 'initialize', name: 'cloudbitmapsMeter' },
  );
  return tally;
}

/**
 * Price a tally with a {@link PricingProfile}'s storage rates.
 *
 * Storage-months are deliberately NOT included: a calibration run holds its bytes for minutes, and prorating a
 * monthly rate over a few minutes produces a number small enough to look like zero and precise enough to be
 * quoted. Request cost is what this run measures; storage cost is what `estimateCost` models.
 */
function priceTally(tally, pricing) {
  const put = (tally.put * pricing.storage.putPerMillion) / 1e6;
  const get = (tally.get * pricing.storage.getPerMillion) / 1e6;
  return { putUSD: put, getUSD: get, totalUSD: put + get };
}

module.exports = { meter, priceTally, classify, rangeShape, newTally, PUT_CLASS, FREE };
