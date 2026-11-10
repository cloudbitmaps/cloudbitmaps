'use strict';
/*
 * The multi suite: an `intersect` over three to ten operands, and what each stage is allowed to cost.
 *
 * It is a suite of its own (`--suite multi`), with its own stages, bound, expected counts and evidence directory, so the
 * default, large and batch suites' projections and evidence are untouched. It keeps their design, the BOUND and the
 * EXPECTED kept apart (`calibrate-stages.cjs` says what each is):
 *
 *   the EXPECTED  the exact requests the engine makes when nothing races it, counted by running the same reads over the
 *                 in-memory backend on the same operands (`multi-counts.cjs`). The operands' loads are a first load's
 *                 requests on S3's shape.
 *   the BOUND     the most a read can make, from the object's size: per operand a pointer, a tail, one more for an index
 *                 longer than the tail, and a range request for each chunk range the engine can make over the common
 *                 chunks (`readBounds` of the large suite explains the cap). It is checked against the ceiling before
 *                 anything is created and held to a counted read by a test.
 *
 * What a k-way intersect reads: the engine takes the chunk keys held by every operand, and reads each operand at those
 * keys only. So per operand it makes a pointer read and a tail read, then range requests over the common chunks; the
 * ranges coalesce (a gap up to 256 KiB, a read up to 1 MiB), so on operands this small the requests barely grow with the
 * common core. What chunk-skipping shows is BYTES: the bytes read against the bytes of the k objects, and, in the near
 * miss group, a chunk held by every operand but one, which a pairwise fold would read and the k-way plan does not.
 *
 * Operands are laid out with the large suite's stride (about 1,500 chunks an operand at 1,000,000 ids), as a common core
 * of `shared` ids at the same keys in every operand and a private band for each, one empty chunk apart, so any subset's
 * intersection is the core: its count and its sum are known exactly.
 */
const { layoutFromCounts, layoutIds, chunksFor, CHUNK_SPAN } = require('./calibrate-guards.cjs');
const { firstLoadRequests } = require('./calibrate-stages.cjs');
const {
  largeStride,
  loadBound,
  operandBound,
  partsOf,
  rangeCap,
} = require('./calibrate-large-stages.cjs');

/** Every stage of the multi suite, in the order the harness runs them. */
const MULTI_STAGES = Object.freeze(['multiLoad', 'multiIntersect', 'multiCount']);

/** The default number of uncached reads of each verb per shape: 20 of each, 280 reads over the seven shapes. */
const DEFAULT_MULTI_READS = 20;

/**
 * The operand sets the suite loads, each a layout: `ids` ids an operand (for the near miss, the ids of its core, see
 * {@link planNearMissLayout}), `operands` of them, `overlap` the share that is the common core. `a` is read by three shapes
 * (the first 3, 5 and 10 operands), so k changes and the objects do not.
 */
const MULTI_POOLS = Object.freeze({
  a: Object.freeze({ kind: 'core', ids: 1_000_000, operands: 10, overlap: 0.2 }),
  b: Object.freeze({ kind: 'core', ids: 5_000_000, operands: 5, overlap: 0.2 }),
  c5: Object.freeze({ kind: 'core', ids: 1_000_000, operands: 5, overlap: 0.05 }),
  c50: Object.freeze({ kind: 'core', ids: 1_000_000, operands: 5, overlap: 0.5 }),
  d: Object.freeze({ kind: 'nearMiss', ids: 1_000_000, operands: 5, overlap: 0.2, bandChunks: 50 }),
});

/** The shapes a run measures, in order: the group (see the README), the pool it reads and how many of its operands. */
const MULTI_SHAPES = Object.freeze([
  Object.freeze({ name: 'k3', group: 'A', pool: 'a', k: 3 }),
  Object.freeze({ name: 'k5', group: 'A', pool: 'a', k: 5 }),
  Object.freeze({ name: 'k10', group: 'A', pool: 'a', k: 10 }),
  Object.freeze({ name: 'k5-5M', group: 'B', pool: 'b', k: 5 }),
  Object.freeze({ name: 'k5-core5', group: 'C', pool: 'c5', k: 5 }),
  Object.freeze({ name: 'k5-core50', group: 'C', pool: 'c50', k: 5 }),
  Object.freeze({ name: 'k5-nearmiss', group: 'D', pool: 'd', k: 5 }),
]);

/** The segment an operand of a pool is stored as. */
const operandSegment = (pool, i) => `multi-${pool}-${i}`;

/**
 * The near-miss layout: `operands` operands that hold a core of `shared` ids in common and, besides, `operands` bands of
 * `bandChunks` chunks each, band `j` held by every operand but `j`. Every chunk of a band is then in `operands - 1` of the
 * operands' key sets, so a pairwise fold would read it and a k-way plan reads none of them: the intersection of all is
 * still the core, its count `shared` and its sum `stride * shared * (shared - 1) / 2`.
 *
 * Bands are separated from the core and from each other by an empty chunk. Returns the layout, with `idsOf(i)` the ids of
 * operand `i`, ascending, as a generator.
 */
function planNearMissLayout({ operands, shared, bandChunks, stride }) {
  for (const [k, v] of Object.entries({ operands, shared, bandChunks, stride })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer, got ${v}`);
  }
  if (operands < 3) throw new Error(`a near miss needs at least 3 operands, got ${operands}`);
  if (stride >= CHUNK_SPAN) throw new Error(`stride ${stride} puts every id in its own chunk`);
  const sharedChunks = chunksFor(shared, stride);
  // The fewest ids that fill `bandChunks` chunks, so the band is as long as asked and not the nearest the stride allows.
  const bandIds = Math.ceil(((bandChunks - 1) * CHUNK_SPAN) / stride) + 1;
  if (chunksFor(bandIds, stride) !== bandChunks) {
    throw new Error(`${bandIds} ids ${stride} apart do not fill ${bandChunks} chunks`);
  }
  const firstBandChunk = sharedChunks + 1;
  const bandBases = Array.from(
    { length: operands },
    (_, j) => (firstBandChunk + j * (bandChunks + 1)) * CHUNK_SPAN,
  );
  const totalChunks = firstBandChunk + operands * (bandChunks + 1);
  if (totalChunks > 65_536) {
    throw new Error(`layout needs ${totalChunks} chunks but a 32-bit id space holds 65536`);
  }
  const sum = (stride * shared * (shared - 1)) / 2;
  if (!Number.isSafeInteger(sum)) {
    throw new Error('the expected intersection sum exceeds 2^53 — the exact-content check would be unsound');
  }
  function* idsOf(i) {
    for (let k = 0; k < shared; k += 1) yield k * stride;
    for (let j = 0; j < operands; j += 1) {
      if (j === i) continue;
      for (let t = 0; t < bandIds; t += 1) yield bandBases[j] + t * stride;
    }
  }
  return {
    shared,
    stride,
    sharedChunks,
    bandChunks,
    bandIds,
    bandBases,
    idsPerOperand: shared + (operands - 1) * bandIds,
    chunksPerOperand: sharedChunks + (operands - 1) * bandChunks,
    expected: { count: shared, sum },
    idsOf,
  };
}

/**
 * The layout of a pool: `{ name, operands, idsPerOperand, sharedChunks, chunksPerOperand, stride, expected, idsOf(i) }`.
 * `expected` is the intersection of any subset of the pool's operands, exact; `idsOf(i)` is operand `i`'s ids, ascending.
 */
function planMultiPool(name) {
  const pool = MULTI_POOLS[name];
  if (pool === undefined) throw new Error(`"${name}" is not a pool of the multi suite`);
  const stride = largeStride(pool.ids);
  const shared = Math.floor(pool.ids * pool.overlap);
  if (pool.kind === 'nearMiss') {
    const near = planNearMissLayout({
      operands: pool.operands,
      shared,
      bandChunks: pool.bandChunks,
      stride,
    });
    return { name, kind: pool.kind, operands: pool.operands, ...near };
  }
  const layout = layoutFromCounts({
    segments: pool.operands,
    shared,
    priv: pool.ids - shared,
    stride,
  });
  return {
    name,
    kind: pool.kind,
    operands: pool.operands,
    shared,
    stride,
    sharedChunks: layout.sharedChunks,
    idsPerOperand: pool.ids,
    chunksPerOperand: layout.chunksPerSegment,
    expected: layout.expected,
    idsOf: (i) => layoutIds(layout, i),
  };
}

/** The most requests one cold read of `shape` makes, from the sizes of the operands it reads (`operandBytes`, all of them). */
function multiReadBound(shape, pool, operandBytes) {
  const bytes = Math.max(...operandBytes.slice(0, shape.k));
  return shape.k * operandBound(pool.sharedChunks, rangeCap(bytes));
}

/** The most a stage can request, from the workload `w`, and the total with the run's fixed requests.
 *
 *   w.reads         cold reads of each verb per shape
 *   w.pools         [{ operandBytes }] in pool order
 *   w.shapes        [{ bound }]: the most GET-class a read of each makes
 *   w.discards      { perRun }: the samples a run may discard, each at the costliest sample's bound
 *   w.retryBound, w.fixedPuts, w.fixedGets
 */
function projectMulti(w) {
  const add = (a, b) => ({ put: a.put + b.put, get: a.get + b.get });
  const stages = Object.fromEntries(MULTI_STAGES.map((n) => [n, { put: 0, get: 0 }]));
  for (const pool of w.pools) {
    for (const bytes of pool.operandBytes) {
      stages.multiLoad = add(stages.multiLoad, loadBound(bytes, w.retryBound));
    }
  }
  const perPass = w.shapes.reduce((n, s) => n + s.bound, 0);
  const costliest = w.reads > 0 ? Math.max(0, ...w.shapes.map((s) => s.bound)) : 0;
  if (w.reads > 0) {
    // A count reads no more of an operand than the stream of the same combine does: the same bound, held by a test.
    stages.multiIntersect = { put: 0, get: w.reads * perPass };
    stages.multiCount = { put: 0, get: w.reads * perPass };
  }
  const perRun = w.discards?.perRun;
  if (!Number.isInteger(perRun) || perRun < 0) {
    throw new Error(`discards.perRun must be a non-negative integer, got ${perRun}`);
  }
  const discards = { put: 0, get: perRun * costliest };
  const put = Object.values(stages).reduce((n, s) => n + s.put, 0) + w.fixedPuts;
  const getSum =
    Object.values(stages).reduce((n, s) => n + s.get, 0) + w.fixedGets + discards.get;
  return { stages, discards, costliestSample: costliest, total: { put, get: Math.max(getSum, put) } };
}

/**
 * The exact requests each stage makes when nothing races it, from the counts the engine made on the same layouts:
 * `w.pools[i].operandBytes` and `w.shapes[i].counts` are `countMulti`'s answer.
 */
function expectedMulti(w) {
  const stages = Object.fromEntries(MULTI_STAGES.map((n) => [n, { put: 0, get: 0 }]));
  for (const pool of w.pools) {
    for (const bytes of pool.operandBytes) {
      const r = firstLoadRequests(partsOf(bytes));
      stages.multiLoad.put += r.put;
      stages.multiLoad.get += r.get;
    }
  }
  for (const s of w.shapes) {
    stages.multiIntersect.get += w.reads * s.counts.intersect.gets;
    stages.multiCount.get += w.reads * s.counts.count.gets;
  }
  return stages;
}

/** The knob only the multi suite reads: a run of another suite that sets it is refused, since it would ignore it. */
const MULTI_SUITE_KNOBS = Object.freeze(['CR_CALIBRATE_MULTI_READS']);

/** Parse `CR_CALIBRATE_MULTI_READS` (cold reads of each verb per shape, a non-negative integer); unset or empty is the default. */
function resolveMultiKnobs(env) {
  const raw = env.CR_CALIBRATE_MULTI_READS;
  if (raw === undefined || String(raw).trim() === '') return { reads: DEFAULT_MULTI_READS };
  const reads = Number(raw);
  if (!Number.isInteger(reads) || reads < 0) {
    throw new Error(`CR_CALIBRATE_MULTI_READS is "${raw}"; expected a non-negative integer`);
  }
  return { reads };
}

/** Refuse a multi-suite setting made for a run of another suite. */
function refuseMultiKnobs(env, suite) {
  const set = MULTI_SUITE_KNOBS.filter((k) => env[k] !== undefined && String(env[k]).trim() !== '');
  if (set.length > 0) {
    throw new Error(
      `${set.join(', ')} sizes the multi suite, which --suite ${suite} does not read; unset it, or run --suite multi`,
    );
  }
}

/** Refuse a setting of another suite under `--suite multi`, each one by name. `others` lists those settings. */
function refuseOtherKnobsUnderMulti(env, others) {
  const set = others.filter((k) => env[k] !== undefined && String(env[k]).trim() !== '');
  if (set.length > 0) {
    throw new Error(
      `${set.join(', ')} size another suite, which --suite multi does not read; unset ` +
        `${set.length === 1 ? 'it' : 'them'}, or set the multi suite's own knob (${MULTI_SUITE_KNOBS.join(', ')})`,
    );
  }
}

module.exports = {
  MULTI_STAGES,
  DEFAULT_MULTI_READS,
  MULTI_POOLS,
  MULTI_SHAPES,
  operandSegment,
  planNearMissLayout,
  planMultiPool,
  multiReadBound,
  projectMulti,
  expectedMulti,
  MULTI_SUITE_KNOBS,
  resolveMultiKnobs,
  refuseMultiKnobs,
  refuseOtherKnobsUnderMulti,
};
