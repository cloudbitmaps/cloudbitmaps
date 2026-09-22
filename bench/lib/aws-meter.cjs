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
  return { put: 0, get: 0, free: 0, bytesUp: 0, bytesDown: 0, byCommand: Object.create(null) };
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
      if (Number.isFinite(len)) tally.bytesDown += len;
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

module.exports = { meter, priceTally, classify, newTally, PUT_CLASS, FREE };
