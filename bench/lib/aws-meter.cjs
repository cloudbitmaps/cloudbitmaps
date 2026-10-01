'use strict';
/*
 * Wire-level op meter for the AWS SDK.
 *
 * WHY THIS SITS AT THE SDK LAYER, not at the library's metrics sink. The sink emits no `storage.put` event —
 * a known observability gap — and a PUT bills at 12.5x a GET, so an ingest-heavy workload priced from the sink
 * alone is materially understated. The meter counts what actually went over the wire, regardless of what the
 * library chose to report.
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
  // Teardown lists VERSIONS to empty a versioned bucket. It is a LIST like the others: missing from here, it
  // would fall through to the GET rate, the 12.5x understatement this set exists to prevent.
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
    // Depth, which a count of requests cannot show: how many were in flight at once, and the sum of every request's own
    // time from send to answer. Their ratio to the wall time says how wide a stage ran, and the wall time over the mean
    // request is how many requests it waited for one after another.
    inFlight: 0,
    peakInFlight: 0,
    requestMs: 0,
    reads: { whole: { n: 0, bytes: 0 }, suffix: { n: 0, bytes: 0 }, range: { n: 0, bytes: 0 } },
  };
}

/**
 * What kind of read a `GetObject` was, from its `Range` header.
 *
 * WHY THE SHAPE MATTERS. A single bytes-fetched figure conflates two different things. Measured request by
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
 * a phase whose op count is not known in advance. Pass the tally an earlier call returned to meter a second
 * client into the same bill.
 */
function meter(client, tally = newTally()) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const name = context.commandName ?? 'UnknownCommand';
      const klass = classify(name);
      const count = (n) => {
        tally[klass] += n;
        tally.byCommand[name] = (tally.byCommand[name] ?? 0) + n;
      };
      // The first attempt is counted BEFORE it is sent, so a request still in flight when the process dies is in
      // the tally. Bytes are counted once, as the logical payload: a retried upload sends them again, but the bill
      // is per request and throughput is about the data.
      count(1);
      const body = args?.input?.Body;
      if (typeof body?.byteLength === 'number') tally.bytesUp += body.byteLength;
      // This runs OUTSIDE the SDK's retry loop, so one call here can be several requests on the wire. The retry
      // middleware records how many on `$metadata.attempts` — on the result, and on the error when every attempt
      // failed — and each attempt is a billed request.
      const retries = (meta) =>
        Number.isInteger(meta?.attempts) && meta.attempts > 1 ? meta.attempts - 1 : 0;
      // A request is timed from send to the answer's headers, so a ranged chunk is about the whole request and a large
      // read is without its body. It is in flight from the send, a wait for a free socket included.
      tally.inFlight += 1;
      if (tally.inFlight > tally.peakInFlight) tally.peakInFlight = tally.inFlight;
      const sentAt = process.hrtime.bigint();
      let result;
      try {
        result = await next(args);
      } catch (err) {
        count(retries(err?.$metadata));
        throw err;
      } finally {
        tally.inFlight -= 1;
        tally.requestMs += Number(process.hrtime.bigint() - sentAt) / 1e6;
      }
      count(retries(result?.output?.$metadata));
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
    // `initialize` sees the command before the SDK resolves it, which is where `context.commandName` is set. It is
    // also OUTSIDE the retry loop (`retryMiddleware`, at `finalizeRequest`), which is why retries are read from the
    // attempt count above rather than seen one by one. A meter that took this step for one inside the loop would
    // count each send once, and every retry would go unbilled.
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
