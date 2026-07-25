/*
 * Wire-level AWS op meter — counts what the account is actually BILLED for.
 *
 * The library's `IMetricsSink` emits only `cold.get` / `warm.read` / `warm.write`. That is deliberate (a lean,
 * vendor-neutral seam) but it means our own instrumentation cannot see:
 *   - **S3 PUTs** — the ingest path, billed at `putPerMillion` = **12.5× a GET** at us-east-1 on-demand
 *   - **S3 LIST** — also billed at the PUT rate
 *   - **S3 DELETE** — free, but worth counting to prove teardown ran
 *   - **registry** reads/writes — the registry driver isn't wired to the sink at all
 * Publishing a cost figure computed from an op set that omits the most expensive write would be an overclaim,
 * so the calibration harness meters one level lower: an AWS SDK middleware on the client itself. Every command
 * the drivers issue is counted by name, whatever the library does or doesn't choose to report.
 *
 * For DynamoDB it goes further and injects `ReturnConsumedCapacity: 'TOTAL'` into every input, then reads the
 * capacity units back off the response. That turns the DynamoDB half of the bill from *our estimate of what
 * AWS would charge* (size → ceil → units, which mis-rounds on a size-varied workload) into **the number AWS
 * itself reports consuming**. Injecting the field changes no semantics — it only asks the service to include
 * capacity in its reply.
 *
 * Harness-only. Nothing here is part of the published packages.
 */
'use strict';
const { Buffer } = require('node:buffer');

/** S3 commands billed at the PUT/COPY/POST/LIST rate. Every `UploadPart` is its own billed request. */
const S3_PUT_CLASS = new Set([
  // The harness's own bucket lifecycle is billed at the PUT rate too — leaving it out made "counts every real
  // request" untrue, even though the projection's slack kept the ceiling safe.
  'CreateBucketCommand',
  'PutBucketTaggingCommand',
  'PutObjectCommand',
  'CopyObjectCommand',
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'CompleteMultipartUploadCommand',
  'AbortMultipartUploadCommand',
]);
const S3_GET_CLASS = new Set(['GetObjectCommand', 'HeadObjectCommand', 'HeadBucketCommand']);
const S3_LIST_CLASS = new Set(['ListObjectsV2Command', 'ListObjectsCommand']);
const S3_DELETE_CLASS = new Set([
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'DeleteBucketCommand',
]);

/**
 * DynamoDB commands that ACCEPT `ReturnConsumedCapacity`.
 *
 * Note the reason is NOT that control-plane commands reject the field — probed at the wire, the SDK's schema
 * serializer simply DROPS an unmodelled member, so `CreateTable`'s body never carries it. The gate is kept
 * because relying on that silent drop is fragile, and because it documents which commands can report capacity.
 */
const DDB_CAPACITY_CAPABLE = new Set([
  'GetItemCommand',
  'QueryCommand',
  'ScanCommand',
  'BatchGetItemCommand',
  'PutItemCommand',
  'UpdateItemCommand',
  'DeleteItemCommand',
  'BatchWriteItemCommand',
  'TransactWriteItemsCommand',
  'TransactGetItemsCommand',
]);

/** DynamoDB commands whose consumed capacity is billed as READ vs WRITE units. */
const DDB_READ = new Set([
  'GetItemCommand',
  'QueryCommand',
  'ScanCommand',
  'BatchGetItemCommand',
  'TransactGetItemsCommand',
]);
const DDB_WRITE = new Set([
  'PutItemCommand',
  'UpdateItemCommand',
  'DeleteItemCommand',
  'BatchWriteItemCommand',
  'TransactWriteItemsCommand',
]);

/**
 * Create a meter. Call `meter.attach(client, 's3' | 'dynamodb')` on each SDK client BEFORE driving any work.
 * Returns `{ tally, commands, attach, snapshot }` where `tally` is the `costOf()`-shaped op set.
 */
function createAwsMeter() {
  const tally = {
    'cold.get': { n: 0, bytes: 0 },
    'cold.put': { n: 0, bytes: 0 },
    'cold.list': { n: 0, bytes: 0 },
    'cold.delete': { n: 0, bytes: 0 },
    'warm.read': { n: 0, bytes: 0 },
    'warm.write': { n: 0, bytes: 0 },
    // Read verbatim off DynamoDB's `ConsumedCapacity` — what AWS says it charged, not what we predicted.
    'warm.units': { read: 0, write: 0 },
  };
  /** Every command name seen, with a per-ATTEMPT count — the audit trail behind the aggregated slots above. */
  const commands = Object.create(null);
  /** Attempts that came back 4xx/5xx. Billed, and a non-zero count means the latency sample includes them. */
  const failures = Object.create(null);
  /** HTTP attempts per command name — `attempts > commands` means the SDK retried, and AWS billed each try. */
  const attempts = Object.create(null);
  /** Attempts that never got a response (transport-level). NOT billed, so deliberately not in `tally`. */
  const transportErrors = Object.create(null);

  function attach(client, kind) {
    // TWO middlewares, because neither step can do the whole job — verified empirically against the SDK:
    //
    //   `initialize`   outermost: `await next()` yields the FULLY DESERIALIZED output, so `ConsumedCapacity` and
    //                  `ContentLength` are readable here. But it sits ABOVE the retry middleware, so it runs
    //                  once per COMMAND regardless of how many HTTP attempts that took.
    //   `deserialize`  runs INSIDE the retry loop — once per HTTP ATTEMPT, which is what AWS actually bills.
    //                  But a middleware added at this step wraps the SDK's own deserializer, so `next()` returns
    //                  only `{ response }`; `output` is not parsed yet (probed: `result keys = response`).
    //
    // So: attempts (the billed count) are tallied at `deserialize`; capacity units and byte sizes are added at
    // `initialize`. Counting requests at `initialize` would under-report a throttled run — precisely the case a
    // calibration run exists to catch.
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const name = context.commandName ?? 'UnknownCommand';
        if (
          kind === 'dynamodb' &&
          args.input !== null &&
          typeof args.input === 'object' &&
          DDB_CAPACITY_CAPABLE.has(name)
        ) {
          // Only DATA-plane commands accept this. CreateTable/DescribeTable/DeleteTable reject it outright, and
          // the calibration harness issues those through this same metered client.
          // A COPY, not a mutation: `args.input` belongs to the caller, and a frozen or reused input would
          // throw under 'use strict'. Safe today only because every driver builds its input inline.
          args = { ...args, input: { ...args.input, ReturnConsumedCapacity: 'TOTAL' } };
        }
        const requestBytes = byteLength(args.input?.Body);

        let result;
        try {
          result = await next(args);
        } catch (err) {
          // A FAILED data-plane command still consumes capacity, and DynamoDB reports it on the error when
          // `ReturnConsumedCapacity` was requested — a `ConditionalCheckFailedException` from an OCC conflict is
          // the common case here, and there are plenty of those. Losing it would under-report the warm cost of
          // exactly the contended workloads worth calibrating.
          const failedUnits = sumCapacity(err?.ConsumedCapacity);
          if (kind === 'dynamodb' && failedUnits !== undefined) {
            if (DDB_READ.has(name)) tally['warm.units'].read += failedUnits;
            else if (DDB_WRITE.has(name)) tally['warm.units'].write += failedUnits;
          }
          commands[name] = (commands[name] ?? 0) + 1;
          throw err;
        }
        const out = result.output ?? {};
        commands[name] = (commands[name] ?? 0) + 1;

        // Sizes + capacity: only available here, where the output is parsed.
        if (kind === 's3') {
          if (S3_PUT_CLASS.has(name) && requestBytes !== undefined) {
            tally['cold.put'].bytes += requestBytes;
          } else if (S3_GET_CLASS.has(name) && typeof out.ContentLength === 'number') {
            tally['cold.get'].bytes += out.ContentLength;
          }
        } else if (kind === 'dynamodb') {
          // `ConsumedCapacity` is an OBJECT on single-item commands but an ARRAY on Batch*/Transact* — reading
          // `.CapacityUnits` off the array yields undefined and silently drops those units.
          const units = sumCapacity(out.ConsumedCapacity);
          if (units !== undefined) {
            if (DDB_READ.has(name)) tally['warm.units'].read += units;
            else if (DDB_WRITE.has(name)) tally['warm.units'].write += units;
          }
        }
        return result;
      },
      { step: 'initialize', name: 'crCalibrationTotals', override: true },
    );

    client.middlewareStack.add(
      (next, context) => async (args) => {
        const name = context.commandName ?? 'UnknownCommand';
        const slotFor = () =>
          kind === 's3'
            ? S3_PUT_CLASS.has(name)
              ? 'cold.put'
              : S3_GET_CLASS.has(name)
                ? 'cold.get'
                : S3_LIST_CLASS.has(name)
                  ? 'cold.list'
                  : S3_DELETE_CLASS.has(name)
                    ? 'cold.delete'
                    : undefined
            : DDB_READ.has(name)
              ? 'warm.read'
              : DDB_WRITE.has(name)
                ? 'warm.write'
                : undefined;
        const countAttempt = () => {
          attempts[name] = (attempts[name] ?? 0) + 1;
          const slot = slotFor();
          if (slot !== undefined) tally[slot].n += 1;
        };

        // Classification here is off the HTTP STATUS, not off whether `next()` threw — the two are not the same
        // at this step, and getting it backwards is exactly what happened:
        //   * a 4xx (`ConditionalCheckFailedException`, the dominant OCC case) RESOLVES here, because the SDK's
        //     own deserializer — the thing that turns it into a rejection — sits OUTSIDE this middleware. It was
        //     being recorded as a clean success, so `failedAttempts` published `{}` on runs full of conflicts.
        //   * a transport failure (ECONNREFUSED — nothing reached AWS, nothing billed) REJECTS here, and was
        //     being counted both as a "failure" and as a billed request.
        try {
          const result = await next(args);
          const status = result?.response?.statusCode;
          countAttempt(); // a response came back, so a request was billed
          if (typeof status === 'number' && status >= 400) {
            failures[name] = (failures[name] ?? 0) + 1;
          }
          return result;
        } catch (err) {
          // No response: the request never completed a round trip, so AWS did not bill it. Recorded separately
          // from billed attempts so a flaky network can't inflate the cost figure.
          transportErrors[name] = (transportErrors[name] ?? 0) + 1;
          throw err;
        }
      },
      { step: 'deserialize', name: 'crCalibrationAttempts', override: true },
    );
  }

  return {
    tally,
    commands,
    attempts,
    failures,
    transportErrors,
    attach,
    /** A deep copy, so a caller can mark a phase boundary without the totals moving underneath them. */
    snapshot() {
      return {
        tally: JSON.parse(JSON.stringify(tally)),
        commands: { ...commands },
        attempts: { ...attempts },
        failures: { ...failures },
        transportErrors: { ...transportErrors },
      };
    },
  };
}

/** Total capacity units from a `ConsumedCapacity`: an object on single-item commands, an array on batches. */
function sumCapacity(cc) {
  if (cc === undefined || cc === null) return undefined;
  const list = Array.isArray(cc) ? cc : [cc];
  let total = 0;
  let saw = false;
  for (const entry of list) {
    if (typeof entry?.CapacityUnits === 'number') {
      total += entry.CapacityUnits;
      saw = true;
    }
  }
  return saw ? total : undefined;
}

/** Byte length of an SDK request body, for the shapes our drivers actually pass (Uint8Array / string). */
function byteLength(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) return body.byteLength;
  return undefined; // a stream — length unknown here; the phase's own accounting covers it
}

/** Per-slot difference between two snapshots, so each phase can report the ops IT issued. */
function deltaOf(before, after) {
  const out = {};
  for (const k of Object.keys(after.tally)) {
    const a = after.tally[k];
    const b = before.tally[k] ?? {};
    out[k] =
      k === 'warm.units'
        ? { read: a.read - (b.read ?? 0), write: a.write - (b.write ?? 0) }
        : { n: a.n - (b.n ?? 0), bytes: a.bytes - (b.bytes ?? 0) };
  }
  return out;
}

module.exports = { createAwsMeter, deltaOf };
