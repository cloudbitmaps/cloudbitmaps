'use strict';
/*
 * Timed samples that survive a transient fault: a sample that meets one is discarded and run again, never retried
 * inside.
 *
 * WHY THIS EXISTS. The workload's client makes one attempt per request and every timed store runs with its own retry
 * off (`clientConfigs`, `TIMED_STORE` in `calibrate-guards.cjs`), so no retry's backoff can sit inside a latency
 * sample and every request count is exact. With nothing else, one transient fault anywhere in a run's requests (up to
 * ~94,600 GET-class and 364 PUT-class at the default workload) would fail the whole run, and a partial run is not
 * evidence. One in-region run failed on a single transient connection fault after about 86,300 requests; at that rate
 * a run of this size would finish about a third of the time.
 *
 * So a SAMPLE — one cold intersect, one point read, one `andNot` call, the warm stage's priming pass — that fails with
 * a transient fault is abandoned whole. Its requests were billed, so they stay in the stage's requests and in the bill,
 * and are recorded beside the stage as a discard: which sample, the error's name, its transport code, the SDK's
 * attempt count, and the requests it made. The sample then runs again from the start, from a state the failed attempt
 * left nothing cached in: on a fresh store, or, for a point read that assumes a store in a given state, on that store
 * (a first `count()` once the store has forgotten the segment, a `has()` on an open segment as it was). The latency
 * and request-count figures and the exact-count checks see only the attempt that finished, which makes exactly the
 * requests a fault-free sample makes; the bill counts both; and the discard count is stated beside the figures.
 *
 * BOUNDED, AND PROJECTED. A run discards at most DISCARDS_PER_RUN samples and a stage at most DISCARDS_PER_STAGE; one
 * more transient fault fails the run. The projection allows DISCARDS_PER_RUN samples at the bound of the most
 * expensive sample the run makes (`projectStages`), so a run that discards every sample it may still fits under the
 * projection it was checked against before anything was created.
 *
 * WHAT IS NOT A SAMPLE. A load. A write that fails transiently may still have landed — its object, or its pointer, with
 * only the answer lost — so the same load run again is a reload of that name, which makes more requests than the first
 * load the projection bounds, and `firstLoads` refuses it. A load that meets a transient fault fails the run. Nor is a
 * warm read: it makes no request, so it cannot meet a fault, and one that does make a request fails its stage anyway.
 */
const { setTimeout: sleepFor } = require('node:timers/promises');

const { chainOf, faultOf, isInterruption } = require('./calibrate-process.cjs');

/** The most samples a run discards. One more transient fault fails the run. */
const DISCARDS_PER_RUN = 3;
/** The most samples one stage discards, so no stage's figures can be mostly samples run a second time. */
const DISCARDS_PER_STAGE = 2;

/**
 * How long nothing may be sent or answered before a failed sample counts as finished. A cold intersect that fails keeps
 * its window of chunk reads in flight and starts one more, and an `andNot` call fetches an exclude's chunk only after
 * the include's arrives, so a failed sample goes on sending for a while. What it sends is its own, and has to be
 * counted against it, not against the sample after it: so the harness waits until nothing is in flight and nothing new
 * has been sent for this long. A gap between one of its requests answering and the next one it sends is a body read
 * and a decode, well under this.
 *
 * The limit of that: the meter takes a request out of flight when its HEADERS arrive (`aws-meter.cjs`), not its body.
 * A chunk body that stalls for longer than this after its headers lets the failed sample send its next reads after the
 * discard is recorded, into the sample run again. That sample's count then differs from its expected count by those
 * reads, so the stage records `expectedMissed` and the figures refuse the run: the cost is a lost run, never a wrong
 * figure.
 */
const QUIET_MS = 1_000;
/** How often the wait looks. */
const POLL_MS = 10;

/** The library's own brand for a transient fault, the one its retry layer keys on; `Symbol.for`, so any copy has it. */
const TRANSIENT_BRAND = Symbol.for('cloudbitmaps.error.transient');

/**
 * Whether `err` is a transient fault: the library's `TransientError`, which a driver raises for a fault it classifies
 * as retryable, or anything the SDK itself would have retried (`sdk`, from `sdkFaultClasses`) — anywhere in its
 * causes. That takes in every 5xx, 501 included, and a 403 refusing a skewed clock that the SDK has corrected, both of
 * which the SDK retries itself; not another 403, a 404, a wrong answer or an integrity failure. Never the gate refusing
 * a send because the run is stopping: that is an interrupt, not a fault.
 */
function transientFault(err, sdk) {
  if (isInterruption(err)) return false;
  return chainOf(err).some(
    (e) =>
      e[TRANSIENT_BRAND] === true ||
      sdk.isThrottlingError(e) ||
      sdk.isTransientError(e) ||
      sdk.isServerError(e),
  );
}

/**
 * Wait until nothing is in flight and nothing new has been sent for `quietMs`. True once that holds; false if `maxMs`
 * pass first, so a request that never answers cannot hold the run. `activity()` returns the requests in flight and the
 * requests sent so far: a request that starts and answers between two looks still moves the second.
 */
async function quiesce({
  activity,
  quietMs = QUIET_MS,
  maxMs,
  pollMs = POLL_MS,
  now = () => Number(process.hrtime.bigint()) / 1e6,
  sleep = sleepFor,
}) {
  const start = now();
  let last = activity();
  let quietSince = last.inFlight === 0 ? start : null;
  for (;;) {
    const t = now();
    if (quietSince !== null && t - quietSince >= quietMs) return true;
    if (t - start >= maxMs) return false;
    await sleep(pollMs);
    const seen = activity();
    const at = now();
    if (seen.inFlight > 0 || seen.sent !== last.sent) quietSince = null;
    else quietSince ??= at;
    last = seen;
  }
}

const zeroReads = () => ({
  whole: { n: 0, bytes: 0 },
  suffix: { n: 0, bytes: 0 },
  range: { n: 0, bytes: 0 },
});
const zeroRequests = () => ({
  put: 0,
  get: 0,
  bytesUp: 0,
  bytesDown: 0,
  parts: 0,
  reads: zeroReads(),
});

/** `a` plus `sign` times `b`, in the shape a stage records its requests in. */
function combine(a, b, sign) {
  const out = zeroRequests();
  for (const k of ['put', 'get', 'bytesUp', 'bytesDown', 'parts']) {
    out[k] = (a[k] ?? 0) + sign * (b[k] ?? 0);
  }
  for (const shape of ['whole', 'suffix', 'range']) {
    for (const k of ['n', 'bytes']) {
      out.reads[shape][k] = (a.reads?.[shape]?.[k] ?? 0) + sign * (b.reads?.[shape]?.[k] ?? 0);
    }
  }
  return out;
}

/** What a stage's discarded samples requested, together. A stage that records none, as before discards, made none. */
function discardedRequests(discarded = []) {
  return discarded.reduce((acc, d) => combine(acc, d.requests, 1), zeroRequests());
}

/**
 * A stage's requests without its discarded samples': what the samples it kept made, which is what its expected count
 * and its figures are held to. The discarded ones stay in `requests`, and in the bill, because they were billed.
 */
function keptRequests(record) {
  return combine(record.requests, discardedRequests(record.discarded), -1);
}

/**
 * The run's discards: one ledger, opened for each stage, through which every timed sample runs.
 *
 *   snap / between   the meter's counters now, and what was sent between two snapshots (the harness's own)
 *   isTransient      which failures discard a sample ({@link transientFault})
 *   settle           waits for a failed sample's requests to finish ({@link quiesce}); false if they did not
 *   onDiscard        called after each discard is recorded: the harness logs it and checks its spend ceiling
 *
 * `sample(of, index, attempt)` runs `attempt(rerun)`, where `rerun` is 0 the first time, and returns what it returns.
 * An attempt starts from a state the failed one left nothing cached in: it builds a fresh store, or, for a point read on
 * a store it shares, is told by `rerun` to make that store forget what the failed attempt read.
 */
function discardLedger({
  perRun = DISCARDS_PER_RUN,
  perStage = DISCARDS_PER_STAGE,
  isTransient,
  snap,
  between,
  settle,
  onDiscard = () => {},
  now = () => Number(process.hrtime.bigint()) / 1e6,
}) {
  let count = 0;
  let open = null;
  return {
    perRun,
    perStage,
    /** Samples discarded so far, in every stage. */
    get count() {
      return count;
    },
    /** The stage a failure cut short, with what it had discarded, or null. */
    get unfinished() {
      return open;
    },
    /** Open `stage`; its discards are the list returned, filled as they happen. */
    begin(stage) {
      if (open !== null) throw new Error(`stage ${stage} began inside ${open.stage}`);
      open = { stage, discarded: [] };
      return open.discarded;
    },
    end() {
      open = null;
    },
    async sample(of, index, attempt) {
      if (open === null) throw new Error(`${of} ${index} is a sample outside any stage`);
      for (let rerun = 0; ; rerun += 1) {
        const before = snap();
        const t0 = now();
        try {
          return await attempt(rerun);
        } catch (err) {
          if (!isTransient(err)) throw err;
          const failedAfterMs = now() - t0;
          const fault = faultOf(err);
          if (count + 1 > perRun || open.discarded.length + 1 > perStage) {
            throw Object.assign(
              new Error(
                `${open.stage}: ${of} ${index} met a transient fault (${fault.message}) after the run had discarded ` +
                  `${count} sample${count === 1 ? '' : 's'} and this stage ${open.discarded.length}; a run discards ` +
                  `at most ${perRun} and a stage ${perStage}, so the run fails`,
                { cause: err },
              ),
              { name: 'DiscardBoundExceeded' },
            );
          }
          if (!(await settle())) {
            throw Object.assign(
              new Error(
                `${open.stage}: ${of} ${index} met a transient fault (${fault.message}), and a request it had sent ` +
                  'was still unanswered when the harness stopped waiting, so its requests cannot be told from the ' +
                  "next sample's",
                { cause: err },
              ),
              { name: 'DiscardUnsettled' },
            );
          }
          const record = {
            of,
            sample: index,
            ...fault,
            failedAfterMs,
            requests: between(before, snap()),
          };
          open.discarded.push(record);
          count += 1;
          onDiscard(record, { stage: open.stage, count, stageCount: open.discarded.length });
        }
      }
    },
  };
}

/**
 * The faults a rehearsal can inject, each shaped as the real one reaches the S3 driver.
 *
 *   reset   a socket reset: the SDK's HTTP handler names a request error with code `ECONNRESET` `TimeoutError` and
 *           keeps the code, so the driver raises a `TransientError` and the sample is discarded
 *   denied  a 403 `AccessDenied`, which the driver passes through and nothing classifies as transient, so the run fails
 */
const FAULTS = Object.freeze({
  reset: () =>
    Object.assign(new Error('socket hang up (injected by the rehearsal)'), {
      name: 'TimeoutError',
      code: 'ECONNRESET',
    }),
  denied: () =>
    Object.assign(new Error('Access Denied (injected by the rehearsal)'), {
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    }),
});

/**
 * Parse `CR_CALIBRATE_FAULT_GETS`, which only a rehearsal takes: the GetObject requests, counted from 1 on the
 * workload's client, that fail once each, each as a reset unless it names another fault (`1200,5000:denied`). Unset or
 * empty is none. A list it cannot read is refused, since a rehearsal that silently injected nothing would show nothing.
 */
function parseFaultGets(raw) {
  if (raw === undefined || String(raw).trim() === '') return [];
  const seen = new Set();
  return String(raw)
    .split(',')
    .map((entry) => {
      const m = /^\s*(\d+)(?::([a-z]+))?\s*$/.exec(entry);
      const n = m === null ? 0 : Number(m[1]);
      const as = m?.[2] ?? 'reset';
      if (!Number.isSafeInteger(n) || n < 1 || !Object.hasOwn(FAULTS, as)) {
        throw new Error(
          `CR_CALIBRATE_FAULT_GETS entry "${entry.trim()}" is not a GetObject request to fail: a positive integer, ` +
            `then :${Object.keys(FAULTS).join(' or :')} if not a reset, such as 1200,5000:denied`,
        );
      }
      if (seen.has(n)) throw new Error(`CR_CALIBRATE_FAULT_GETS names request ${n} twice`);
      seen.add(n);
      return { getObject: n, as };
    });
}

/**
 * For a rehearsal only: fail each listed GetObject once, with its fault ({@link FAULTS}). It throws inside the SDK's
 * retry step, which then attaches its `$metadata` as it would to the real error. The meter, outside that step, counts
 * the request as sent; none reaches the wire. The harness refuses `CR_CALIBRATE_FAULT_GETS` in every other mode.
 */
function injectFaults(client, faults) {
  const pending = new Map(faults.map((f) => [f.getObject, f.as]));
  let gets = 0;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === 'GetObjectCommand') {
        gets += 1;
        const as = pending.get(gets);
        if (as !== undefined) {
          pending.delete(gets);
          throw FAULTS[as]();
        }
      }
      return next(args);
    },
    { step: 'finalizeRequest', priority: 'low', name: 'cloudbitmapsRehearsalFault' },
  );
  return {
    /** The listed requests not yet reached. */
    get pending() {
      return [...pending.keys()];
    },
  };
}

module.exports = {
  DISCARDS_PER_RUN,
  DISCARDS_PER_STAGE,
  QUIET_MS,
  transientFault,
  quiesce,
  discardLedger,
  discardedRequests,
  keptRequests,
  parseFaultGets,
  injectFaults,
};
