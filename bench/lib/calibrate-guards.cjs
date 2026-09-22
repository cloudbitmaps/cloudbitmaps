'use strict';
/*
 * The guards that stand between `pnpm calibrate:aws` and someone's cloud bill.
 *
 * These are pure functions with no I/O, for one reason: every one of them was a BUG in the harness this
 * replaces, and the only way to keep a guard honest is to be able to plant its defect in a test and watch it
 * fail. The harness that ran the July 2026 calibration was deleted with the warm tier, and its regression
 * suite went with it — so these are rebuilt from the recorded post-mortem rather than from memory.
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
 * AND ONE MORE, found by the first real run: it counted a single operand per read. An intersect has two, and
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
  // A load: the generation PUT, then the pointer advance — a GET to read the row and a conditional PUT to move
  // it, each attempt of which can lose the compare-and-swap and go round again.
  const putPerLoad = 1 + retryBound;
  const getPerLoad = retryBound;
  // A multipart load: create + parts + complete for the object, then the same pointer advance.
  const putPerLargeLoad = 2 + partsPerLargeLoad + retryBound;
  // A read, per operand: resolve the pointer, read the footer and the index, then one GET per chunk fetched.
  // Three fixed GETs is the generous reading of "open a generation"; the end-of-run check keeps it honest.
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
 * chunks. The first real run showed it: 107 GETs across 40 intersects. The headline claim this measurement is
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
};
