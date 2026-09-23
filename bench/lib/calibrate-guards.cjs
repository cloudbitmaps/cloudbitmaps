'use strict';
/*
 * The guards that stand between `pnpm calibrate:aws` and someone's cloud bill.
 *
 * These are pure functions with no I/O, for one reason: every one of them was a BUG in the harness this
 * replaces, and the only way to keep a guard honest is to be able to plant its defect in a test and watch it
 * fail. The harness that ran the July 2026 calibration was deleted with the warm tier, and its regression
 * suite went with it — so each is rebuilt from what went wrong, which its comment below records.
 *
 * Read `RELEASING.md` for the release pipeline's guards; this file is the money-spending equivalent.
 */

/** The typed phrase `--run` demands. Long and unguessable on purpose: a typo must not spend money. */
const CONFIRM_PHRASE = 'yes-spend-money';

/**
 * Attempts `publishGeneration` makes to advance a segment pointer, from the loop in
 * `packages/core/src/core/crbm-storage-source.ts`.
 *
 * This was `4`, with a comment calling it "1 attempt + DEFAULT_MAX_RETRIES". No such constant exists; the loop
 * runs FIVE attempts. So every load was projected one attempt short — the exact "a projection the run can
 * exceed is not a ceiling" bug `projectOps` is documented to prevent, sitting in its own input, under a comment
 * asserting a derivation nobody had made. `tests/bench/calibrate-guards.test.ts` now reads the bound out of the
 * source and fails if the two ever disagree again.
 */
const RETRY_BOUND = 5;

/**
 * Parse the spend ceiling.
 *
 * THE BUG THIS EXISTS FOR: the ceiling used to be `Number(process.env.CR_CALIBRATE_MAX_USD)` compared with
 * `total > max`. `Number('abc')` is `NaN`, and **every comparison against NaN is false** — so a malformed
 * ceiling did not fail loudly, it silently deleted the bound on a script whose whole job is spending money.
 * Zero and negative are rejected too: both are almost certainly a mistake, and "spend nothing" is what the
 * default dry run is for.
 */
function parseCeiling(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('CR_CALIBRATE_MAX_USD is required for --run: set a spend ceiling in dollars');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `CR_CALIBRATE_MAX_USD is "${raw}", which is not a finite number. Refusing to run: a NaN ceiling ` +
        'compares false against every total and would silently remove the bound.',
    );
  }
  if (n <= 0) {
    throw new Error(`CR_CALIBRATE_MAX_USD is ${n}; a ceiling must be greater than zero`);
  }
  return n;
}

/**
 * Resolve a workload size from the environment.
 *
 * THE BUG THIS EXISTS FOR: the old helper mapped a falsy value to the default, so `CR_CALIBRATE_WRITES=0` —
 * what someone shrinking a run to almost nothing would set — handed back the FULL default instead of zero.
 * Explicit zero must mean zero.
 */
function resolveSize(raw, fallback, label) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} is "${raw}"; expected a non-negative integer`);
  }
  return n;
}

/**
 * Decide whether a probe result means "this resource does not exist".
 *
 * THE BUG THIS EXISTS FOR, and it is the most dangerous one in the file. `HeadBucket` answers **403, not
 * 404**, for a bucket you own but cannot `ListBucket`. Reading 403 as "absent" would be catastrophic in
 * `us-east-1`, where `CreateBucket` on a bucket you ALREADY OWN returns **200 OK** rather than an error: the
 * run would proceed into a real bucket of yours and then **delete it on teardown**.
 *
 * So only a genuine not-found counts as absent. Anything else — 403, a throttle, a timeout, a network error —
 * is "cannot prove it is absent", which must abort rather than create.
 */
function probeMeansAbsent(err) {
  if (err === undefined || err === null) return false; // the call succeeded: it exists
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? err?.Code ?? '';
  if (status === 404) return true;
  if (name === 'NotFound' || name === 'NoSuchBucket') return true;
  return false;
}

/**
 * Project the worst-case op count for a run, as a real upper bound.
 *
 * THE BUG THIS EXISTS FOR: two earlier projections were not bounds. One multiplied writes by 2, leaving the
 * measured count within a single request of the projection; the other gave READS a smaller multiplier than
 * writes, so the read slot always breached first — and it was triggered by setting concurrency above the
 * segment count, which is exactly what someone does to make a run *cheaper*.
 *
 * AND ONE MORE, found by this harness's first real run: it counted a single operand per read. An intersect has two, and
 * each resolves its own pointer, reads its own index and fetches its own chunks — so the read term was half of
 * what the workload issues. `operandsPerRead` is now explicit, and the harness checks the measured counts
 * against this projection at the end of every run, so "it is an upper bound" is a checked property rather than
 * a claim.
 *
 * Reads are projected at least as high as writes because every write path in this engine reads before it
 * writes.
 */
function projectOps({
  loads,
  reads,
  chunksPerRead,
  retryBound,
  operandsPerRead = 1,
  largeLoads = 0,
  partsPerLargeLoad = 0,
  fixedPuts = 0,
  fixedGets = 0,
}) {
  if (!Number.isInteger(retryBound) || retryBound < 1) {
    throw new Error(`retryBound must be a positive integer, got ${retryBound}`);
  }
  if (!Number.isInteger(operandsPerRead) || operandsPerRead < 1) {
    throw new Error(`operandsPerRead must be a positive integer, got ${operandsPerRead}`);
  }
  // A load: the generation PUT, then the pointer advance — a conditional PUT, each attempt of which can lose the
  // compare-and-swap and go round again. Its reads are more than one per attempt, and this once said one: the
  // loader reads the row before it writes, each attempt reads it again and the registry reads it once more before
  // its conditional write, and a publish that loses every attempt reads it a last time. So a load of a new segment
  // makes three GETs even with nothing racing it — run 2026-09-23-94416 measured 36 across 12 loads — and twelve
  // at worst. The harness is the only writer, so its loads never race; the bound still has to hold if one did.
  const putPerLoad = 1 + retryBound;
  const getPerLoad = 2 + 2 * retryBound;
  // A multipart load: create + parts + complete for the object, then the same pointer advance.
  const putPerLargeLoad = 2 + partsPerLargeLoad + retryBound;
  // A read, per operand: resolve the pointer, read the footer and the index, then one GET per chunk fetched.
  // Three fixed GETs is the generous reading of "open a generation": the pointer, the tail read, and a second read
  // for an index longer than the tail. The pointer is read once only because the timed store pins it
  // (`TIMED_STORE`) — on the default 2 s refresh, an intersect slower than that reads it again, and the median
  // intersect of run 2026-09-23-94416, from a laptop, used exactly this allowance. The end-of-run check keeps it
  // honest.
  const getPerOperand = 3 + chunksPerRead;
  const put = loads * putPerLoad + largeLoads * putPerLargeLoad + fixedPuts;
  const getForLoads = (loads + largeLoads) * getPerLoad;
  const getForReads = reads * operandsPerRead * getPerOperand;
  const get = Math.max(getForLoads + getForReads + fixedGets, put);
  return { put, get };
}

/**
 * Did the run issue more than its projection?
 *
 * A projection is only a ceiling if the run cannot exceed it. Checking that after the fact is cheap and turns
 * the property from documentation into evidence: a run that breaks it is flagged in its own results, so an
 * under-projecting change is caught by the next rehearsal rather than by an invoice.
 */
function exceedsProjection(measured, projected) {
  const over = [];
  if (measured.put > projected.put)
    over.push(`PUT-class ${measured.put} > projected ${projected.put}`);
  if (measured.get > projected.get)
    over.push(`GET-class ${measured.get} > projected ${projected.get}`);
  return over;
}

/**
 * Has the run breached its ceiling?
 *
 * Called at phase boundaries AND inside the unbounded phase, because a phase-boundary-only check leaves the
 * one phase whose op count is not known in advance completely unchecked — which is the phase that can run
 * away.
 */
function breached(spentUSD, ceilingUSD) {
  // Written as `>=` rather than `>`: landing exactly on the ceiling is already the ceiling.
  return spentUSD >= ceilingUSD;
}

/**
 * The harness's workload shape, here rather than in the harness so a test can pin it.
 *
 * The stride-7 bug was the HARNESS choosing a bad value, not `planLayout` computing one wrongly — so a test
 * that passes its own stride to `planLayout` proves nothing about what a run actually does. At these values a
 * 500,000-id segment spans ~2,000 chunks with 100 shared, the shape behind the published figure.
 */
const DEFAULT_LAYOUT = Object.freeze({ overlap: 0.05, stride: 262 });

/** One roaring chunk: the top 16 bits of a 32-bit id choose it, so it spans 65,536 consecutive ids. */
const CHUNK_SPAN = 65_536;
/** How many chunks a 32-bit id space holds. */
const ID_SPACE_CHUNKS = 65_536;

/**
 * Plan the intersect workload's id layout — and refuse one that cannot be what it claims to be.
 *
 * THE BUG THIS EXISTS FOR, twice over.
 *
 * The first layout gave each segment its own id range, so adjacent segments shared NOTHING and the intersect
 * phase timed the empty intersection: chunk-skipping's best case, fetching no payload at all. It would have
 * published a confident p50 over zero work.
 *
 * The second shared a 5% core but packed it at a stride of 7, so 25,000 shared ids fitted in about THREE
 * chunks. This harness's first real run showed it: 107 GETs across 40 intersects. The headline claim this measurement is
 * meant to back is "100 of 2,000 chunks fetched", and a three-chunk workload is not evidence about it.
 *
 * So the layout is now derived from the shape it must reproduce. Every segment is `sharedChunks` chunks of a
 * common core plus a private band of its own; bands are separated by an empty chunk so no two can touch; and
 * the expected intersection of ANY pair — its count and its sum — is known exactly, which lets the harness
 * assert that a read against a real object store returned precisely the right ids, not merely some.
 */
function planLayout({ segments, idsPerSegment, overlap, stride }) {
  for (const [k, v] of Object.entries({ segments, idsPerSegment, stride })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer, got ${v}`);
  }
  if (!(overlap > 0 && overlap < 1)) throw new Error(`overlap must be in (0, 1), got ${overlap}`);
  if (stride >= CHUNK_SPAN) {
    throw new Error(
      `stride ${stride} puts every id in its own chunk — nothing would share a chunk`,
    );
  }
  const shared = Math.floor(idsPerSegment * overlap);
  if (shared === 0) throw new Error(`overlap ${overlap} of ${idsPerSegment} ids shares nothing`);
  const priv = idsPerSegment - shared;
  const chunksFor = (n) => (n === 0 ? 0 : Math.floor(((n - 1) * stride) / CHUNK_SPAN) + 1);
  const sharedChunks = chunksFor(shared);
  const privateChunks = chunksFor(priv);
  const bandChunks = privateChunks + 1; // the +1 is the empty chunk that keeps adjacent bands apart
  const firstBandChunk = sharedChunks + 1;
  const totalChunks = firstBandChunk + segments * bandChunks;
  if (totalChunks > ID_SPACE_CHUNKS) {
    throw new Error(
      `layout needs ${totalChunks} chunks but a 32-bit id space holds ${ID_SPACE_CHUNKS} — ` +
        'shrink the workload rather than let ids wrap',
    );
  }
  const sum = (stride * shared * (shared - 1)) / 2;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(
      'the expected intersection sum exceeds 2^53 — the exact-content check would be unsound',
    );
  }
  const bases = Array.from(
    { length: segments },
    (_, i) => (firstBandChunk + i * bandChunks) * CHUNK_SPAN,
  );
  return {
    shared,
    stride,
    sharedChunks,
    privateChunks,
    chunksPerSegment: sharedChunks + privateChunks,
    bases,
    expected: { count: shared, sum },
  };
}

/** The ids of segment `i` under `layout`, ascending. A generator, so no workload is ever materialised twice. */
function* layoutIds(layout, i, idsPerSegment) {
  for (let k = 0; k < layout.shared; k += 1) yield k * layout.stride;
  const base = layout.bases[i];
  for (let k = 0; k < idsPerSegment - layout.shared; k += 1) yield base + k * layout.stride;
}

/**
 * The last four digits of an account id, and nothing more.
 *
 * Enough to eyeball that this is the intended account; not enough to be worth pasting anywhere. The earlier
 * in-region script did exactly this, and this harness printed the whole id — which then sits in a terminal
 * scrollback, a CI log, or a message asking for help.
 */
function maskAccount(account) {
  const s = String(account ?? '');
  return /^\d{12}$/.test(s) ? `••••••••${s.slice(-4)}` : '(unverified)';
}

/**
 * How many attempts each of the harness's two S3 clients makes per request.
 *
 * The WORKLOAD's client makes one. The projection has no term for its retries, and a retry's backoff would sit
 * inside a latency sample unseen — so a transient failure there fails the run instead. TEARDOWN's keeps the SDK's
 * usual three: the one-attempt pin once reached it too, and a single 503 on `ListObjectVersions` then left the
 * bucket, and everything in it, behind. The projection allows for every one of teardown's attempts.
 */
const WORK_ATTEMPTS = 1;
const ADMIN_ATTEMPTS = 3;

/**
 * Does a teardown error mean "the bucket is already gone"?
 *
 * Narrower than `probeMeansAbsent`, on purpose. Teardown once used that, which reads ANY 404 as absent — and
 * `AbortMultipartUpload` answers 404 `NoSuchUpload` for an upload already aborted or completed, which is exactly
 * what a retried abort gets back when its first attempt landed but the answer was lost. Read as "the bucket is
 * gone", it skipped deleting the objects and the bucket, and reported nothing. Only S3's own `NoSuchBucket`
 * means the bucket is gone.
 */
function bucketIsGone(err) {
  return (err?.name ?? err?.Code) === 'NoSuchBucket';
}

/** An abort that finds its upload already gone — completed, or aborted by an earlier attempt — has nothing to do. */
function uploadIsGone(err) {
  return (err?.name ?? err?.Code) === 'NoSuchUpload';
}

/**
 * The most delete passes teardown makes before it reports what is left instead of trying again.
 *
 * `DeleteObjects` reports a key it could not delete INSIDE a 200, where the SDK's retries never see it, and each
 * listing starts again from the first page — so a key that can never be deleted (a policy that forbids it) kept
 * the loop listing, and billing, for as long as it ran: 794 listings in five seconds, under no ceiling and in no
 * projection. Now bounded, and projected.
 */
const TEARDOWN_PASSES = 3;

/**
 * Teardown's PUT-class requests at most: one `ListMultipartUploads`, a `ListObjectVersions` per pass and the one
 * that finds the bucket empty — each at every attempt its retrying client may make. Its deletes are free.
 */
const TEARDOWN_PUTS = ADMIN_ATTEMPTS * (1 + TEARDOWN_PASSES + 1);

/** The two clients' configurations, from the one a run resolved. `maxAttempts` last, so nothing in `base` wins. */
function clientConfigs(base) {
  return {
    work: { ...base, maxAttempts: WORK_ATTEMPTS },
    admin: { ...base, maxAttempts: ADMIN_ATTEMPTS },
  };
}

/**
 * How every timed intersect's store is built.
 *
 * `retry: false` — the store has a transient-read retry of its own, above the client, and it would re-run a
 * failed read INSIDE the timed window: a second retry layer the client's one-attempt pin does not reach.
 *
 * `cache.genTtlMs: 0` — "pin for the store's lifetime". A store re-reads a segment's pointer once `genTtlMs`
 * (2 s by default) has passed since it last read it, in the middle of an intersect too. Run 2026-09-23-94416 was
 * 83 ms from the region, its cold intersects took about 3 s, and the median one read both pointers twice: 206
 * GETs where the same intersect inside the region makes 204. A request count that moves with the network describes the network,
 * and the projection had no term for it. Every timed intersect has a store of its own, so pinning costs nothing
 * in coldness: each pointer is still read, exactly once. What the default refresh costs a long-lived reader is a
 * separate figure — at most one pointer read per segment per `genTtlMs` while it is read — and the run report
 * states it rather than this harness measuring it by accident.
 */
const TIMED_STORE = Object.freeze({ retry: false, cache: Object.freeze({ genTtlMs: 0 }) });

/**
 * Where real runs' evidence lives: one file per run, named by its id.
 *
 * One per run, not one file for "the latest run", because a figure is published from a particular run and cited
 * by its id — a second run under the same name would replace the evidence behind numbers already on the page.
 */
const EVIDENCE_DIR = 'bench/calibration';

/**
 * A run id names the run's bucket, `cloudbitmaps-calib-<id>`, and its evidence file, so it has to be valid as both,
 * and it has to sort into run order. So it is a UTC date, then a label of lowercase letters, digits and hyphens that
 * starts and ends with a letter or digit: 44 characters at most, which is what the 19-character prefix leaves of a
 * bucket name's 63. A bucket name may also hold dots; an id does not, because it is a file name too. Nothing
 * outside that set can reach a path, and the date prefix rules out every name Windows reserves.
 *
 * S3 also reserves some suffixes for its own bucket types, and refuses them at `CreateBucket` — after the abort
 * window, when nothing has been created but the run has already been waited for. They are refused here first.
 */
const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9](?:[a-z0-9-]{0,31}[a-z0-9])?$/;
const RESERVED_SUFFIX = /(?:-s3alias|--ol-s3|--x-s3)$/;

function checkRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || RESERVED_SUFFIX.test(runId)) {
    throw new Error(
      `run id "${String(runId)}" is not usable: it names the bucket and the evidence file and must sort into run ` +
        'order, so it is a date and a label, YYYY-MM-DD-<label>, 44 characters at most, where the label is ' +
        'lowercase letters, digits and hyphens beginning and ending with a letter or digit',
    );
  }
  return runId;
}

/**
 * The id `--cleanup` accepts: anything that makes a legal bucket name, because it writes no file.
 *
 * Narrower rules would strand buckets. Harnesses before the date prefix accepted any `CR_CALIBRATE_RUN_ID` and
 * printed `--cleanup <id>` for their leftovers, and S3 allowed dots and a hyphen straight after the prefix, so an
 * id like `v0.10.0-inregion` made a real bucket that `checkRunId` would now refuse to remove.
 */
const CLEANUP_ID = /^[a-z0-9.-]{0,43}[a-z0-9]$/;

function checkCleanupId(runId) {
  if (typeof runId !== 'string' || !CLEANUP_ID.test(runId) || runId.includes('..')) {
    throw new Error(
      `"${String(runId)}" cannot name a calibration bucket: 1 to 44 lowercase letters, digits, dots and hyphens, ` +
        'ending with a letter or digit, and no two dots together',
    );
  }
  return runId;
}

/**
 * Where a run's results are written, relative to the repository root.
 *
 * A real run that finished writes its evidence under {@link EVIDENCE_DIR}. One that did not — interrupted, failed
 * part-way — writes `<id>.partial.json` beside it, which git ignores and the figures gates skip: it once went to the
 * evidence name, where a single aborted run made both gates fail until someone deleted it. A rehearsal gets a file
 * of its own, which git also ignores: it writes the same shape as a real run, and under the real run's name it sat
 * one `git add` away from being committed as the evidence behind a published figure.
 */
function resultsFile(rehearse, runId, { partial = false } = {}) {
  if (rehearse) return 'bench/calibrate-aws-rehearsal.json';
  return `${EVIDENCE_DIR}/${checkRunId(runId)}${partial ? '.partial' : ''}.json`;
}

/**
 * Whether a run would replace evidence that already exists, and what to say if so; `null` when it would not.
 *
 * Evidence is write-once, like the generations it measures. A figure published from a run is checked against the
 * file under that run's id, and `CR_CALIBRATE_RUN_ID` exists so a run can be named — so a second run under a
 * published run's id would replace the file its figures are checked against. A partial file does not count: it is
 * not evidence, and a run that failed part-way can be retried under its own id.
 */
function evidenceConflict({ rehearse, file, exists }) {
  if (rehearse || !exists(file)) return null;
  return (
    `${file} already exists — that run's evidence is committed. Choose another CR_CALIBRATE_RUN_ID, or leave ` +
    'it unset for a fresh one.'
  );
}

/**
 * Refuse a workload that cannot measure what it claims to.
 *
 * Every intersect pairs segment i with segment i + 1, wrapping round. With one segment that is a segment with
 * itself: every chunk is shared, so a run shrunk to one segment — what someone does to make it cheaper — fetched
 * all 1,999 chunks an intersect, failed its exactness check and overspent its projection before the ceiling
 * check could see it.
 */
function checkWorkload({ segments, reads }) {
  if (reads > 0 && segments < 2) {
    throw new Error(
      `${segments} segment(s) cannot make an intersect of two different segments; set CR_CALIBRATE_SEGMENTS to ` +
        'at least 2, or CR_CALIBRATE_READS to 0',
    );
  }
}

module.exports = {
  CONFIRM_PHRASE,
  RETRY_BOUND,
  CHUNK_SPAN,
  DEFAULT_LAYOUT,
  parseCeiling,
  resolveSize,
  probeMeansAbsent,
  projectOps,
  exceedsProjection,
  breached,
  planLayout,
  layoutIds,
  maskAccount,
  resultsFile,
  checkRunId,
  checkCleanupId,
  evidenceConflict,
  checkWorkload,
  EVIDENCE_DIR,
  TIMED_STORE,
  ADMIN_ATTEMPTS,
  clientConfigs,
  bucketIsGone,
  uploadIsGone,
  TEARDOWN_PASSES,
  TEARDOWN_PUTS,
};
