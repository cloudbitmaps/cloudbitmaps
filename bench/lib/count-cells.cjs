/*
 * The cells of the counting-kernels bench (`bench/count-kernels.cjs`): the operand pairs, each counting operation of the
 * codec's bitmap beside the building path it replaces, and the rule that decides whether a count is kept. The codec is
 * a parameter: a cell never names a package, only the codec seam (`fromValues`, `safeDeserialize`) and the bitmap's own
 * methods. Pure but for the codec it is handed.
 *
 * THE OPERAND PAIRS (a group is two bitmaps, `a` and `b`, as the store holds them: optimized, then decoded)
 *
 *   dense, sparse, runs, mixed, spread8k    segments 0 and 1 of the data set of that name in `bench/lib/codec-data.cjs`: the
 *                                           same chunk keys, different ids. Dense is bitset against bitset, sparse array
 *                                           against array (1,000 values), runs run against run, mixed bitset/array,
 *                                           array/run and run/bitset in turn, and spread8k 16 values a chunk over many
 *                                           chunks (array against array below the probe's start, so the plain merge).
 *   tiny/runs                               8 values against one chunk of 150 runs: the per-value run search
 *                                           (150 runs are at least 16 times 8 values).
 *   disjoint 1000 interleaved               evens against odds over 1,000 values each in one chunk: arrays of the same
 *                                           size that share nothing, so an intersect test scans everything.
 *   disjoint sparse                         1,000 values each in every one of 256 chunks, drawn from one random set of
 *                                           2,000 and dealt out alternately: the same, over many chunks.
 *
 * THE OPERATIONS. Each has a `count` (the codec's counting operation) and a `build` (the work it replaces: build the
 * combination with the in-place operations and take its size, or answer from that size).
 *
 *   andCardinality        |A and B|     against   clone, andInPlace, size
 *   orCardinality         |A or B|      against   clone, orInPlace, size
 *   andNotCardinality     |A not B|     against   clone, andNotInPlace, size
 *   xorCardinality        |A xor B|     against   the union less the intersection, built (the codec has no in-place xor, so
 *                                       the baseline is composed of the three in-place operations it has: a native xor
 *                                       build would cost less, so this baseline favours the count)
 *   intersects            whether they share an id    against   clone, andInPlace, size above zero
 *   isSubsetTrue          A within (A or B): true     against   clone, andInPlace, size equal to A's size; a full walk
 *   isSubsetFalse         the smaller of A and B within the larger: false on these pairs, never answered by the size check
 *                                                     against   the same build
 *   isEqual               A against a second decode of A: true, a full walk     against   clone, andInPlace, both sizes
 *                                                                                   equal to the intersection's
 *
 * THE STOP RULE, fixed before any measurement: a count operation is kept only if it beats building the combination and
 * taking its size on every group it is timed on, which the paired rule (`bench/lib/paired-verdict.cjs`, head = count,
 * base = build, control = build again, bar 2%) calls `faster than the bar`. A cell that is `within the bar` or `slower` is
 * not kept for that group, an `inconclusive` one is taken again, and `decisionsOf` names the cells that stop an operation.
 */
'use strict';

const { idsOf, prng, randomLows, runLows } = require('./codec-data.cjs');
const { FASTER, cellName, kindOf } = require('./paired-verdict.cjs');

/** The hard size cap every decode passes, as the store does. */
const CAP = 1 << 26;

/** The number of chunks of each data set a group of the same name has: the scale of the engine bench's read cells. */
const CHUNK_SCALE = { dense: 32, sparse: 256, runs: 128, mixed: 128, spread8k: 8192 };
/** A tiny scale for the pipeline check. */
const SMALL_SCALE = { dense: 2, sparse: 4, runs: 2, mixed: 3, spread8k: 100 };

const ALL_OPS = [
  'andCardinality',
  'orCardinality',
  'andNotCardinality',
  'xorCardinality',
  'intersects',
  'isSubsetTrue',
  'isSubsetFalse',
  'isEqual',
];
const DISJOINT_OPS = ['andCardinality', 'intersects'];
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];

/** The ids of `chunks` chunks (keys 0 to `chunks - 1`): in each, the even-indexed (`which` 0) or odd-indexed (1) values of 2,000 random ones. */
function dealt(chunks, which, seedOf) {
  const out = [];
  for (let k = 0; k < chunks; k++) {
    const all = randomLows(prng(seedOf(k)), 2000);
    for (let i = which; i < all.length; i += 2) out.push(k * 65536 + all[i]);
  }
  return out;
}

/** The groups, as `{ name, ops, ids(small) -> [a, b] }`. `small` is a pipeline check at a tiny scale. */
function groups() {
  const list = DATASETS.map((dataset) => ({
    name: dataset,
    ops: ALL_OPS,
    ids: (small) => {
      const scale = small ? SMALL_SCALE : CHUNK_SCALE;
      return [idsOf(dataset, 0, scale), idsOf(dataset, 1, scale)];
    },
  }));
  list.push({
    name: 'tiny/runs',
    ops: ALL_OPS,
    ids: () => [randomLows(prng(31), 8), runLows(prng(32))],
  });
  list.push({
    name: 'disjoint 1000 interleaved',
    ops: DISJOINT_OPS,
    ids: () => [
      Array.from({ length: 1000 }, (_, i) => 2 * i),
      Array.from({ length: 1000 }, (_, i) => 2 * i + 1),
    ],
  });
  list.push({
    name: 'disjoint sparse',
    ops: DISJOINT_OPS,
    ids: (small) => {
      const chunks = small ? 4 : 256;
      return [dealt(chunks, 0, (k) => k + 1), dealt(chunks, 1, (k) => k + 1)];
    },
  });
  return list;
}

/** A stored bitmap of `ids` (optimized, so runs are runs), decoded: what a store reads. */
function stored(codec, ids) {
  const b = codec.fromValues(ids);
  b.optimize();
  return codec.safeDeserialize(b.serialize(), CAP);
}

/** `x` with `other` combined in by `method`: a fresh bitmap, `x` untouched. */
function combined(x, method, other) {
  const out = x.clone();
  out[method](other);
  return out;
}

/**
 * Every operation of a group as `{ count, build }`, two calls with the same answer, over bitmaps of the group's ids in
 * the given codec. The inputs are built once; a call times the operation alone.
 */
function operationsOf(codec, ids) {
  const [aIds, bIds] = ids;
  const a = stored(codec, aIds);
  const b = stored(codec, bIds);
  const copyOfA = stored(codec, aIds);
  const union = combined(a, 'orInPlace', b);
  const [lo, hi] = a.size <= b.size ? [a, b] : [b, a];
  return {
    andCardinality: {
      count: () => a.andCardinality(b),
      build: () => combined(a, 'andInPlace', b).size,
    },
    orCardinality: {
      count: () => a.orCardinality(b),
      build: () => combined(a, 'orInPlace', b).size,
    },
    andNotCardinality: {
      count: () => a.andNotCardinality(b),
      build: () => combined(a, 'andNotInPlace', b).size,
    },
    xorCardinality: {
      count: () => a.xorCardinality(b),
      build: () => {
        const both = combined(a, 'orInPlace', b);
        both.andNotInPlace(combined(a, 'andInPlace', b));
        return both.size;
      },
    },
    intersects: {
      count: () => a.intersects(b),
      build: () => combined(a, 'andInPlace', b).size > 0,
    },
    isSubsetTrue: {
      count: () => a.isSubset(union),
      build: () => combined(a, 'andInPlace', union).size === a.size,
    },
    isSubsetFalse: {
      count: () => lo.isSubset(hi),
      build: () => combined(lo, 'andInPlace', hi).size === lo.size,
    },
    isEqual: {
      count: () => a.isEqual(copyOfA),
      build: () => {
        const both = combined(a, 'andInPlace', copyOfA);
        return both.size === a.size && copyOfA.size === both.size;
      },
    },
  };
}

/** The cell names of every group and operation, in order: `<group> <operation>`. */
function cellNames() {
  return groups().flatMap((g) => g.ops.map((op) => cellName({ dataset: g.name, op })));
}

/**
 * The stop rule applied to a list of passes (the last pass decides): per operation, whether it is kept (`faster than the
 * bar` on every group it was timed on) and the cells that stop it, each with its verdict. An operation timed in no cell
 * of the last pass is absent.
 */
function decisionsOf(passes) {
  const last = passes[passes.length - 1];
  const byOp = new Map();
  for (const cell of last?.ops ?? []) {
    const entry = byOp.get(cell.op) ?? { op: cell.op, kept: true, stoppedBy: [] };
    if (kindOf(cell.verdict) !== 'faster') {
      entry.kept = false;
      entry.stoppedBy.push({ cell: cellName(cell), verdict: cell.verdict });
    }
    byOp.set(cell.op, entry);
  }
  return [...byOp.values()];
}

module.exports = {
  CAP,
  CHUNK_SCALE,
  SMALL_SCALE,
  ALL_OPS,
  DISJOINT_OPS,
  DATASETS,
  FASTER,
  groups,
  stored,
  operationsOf,
  cellNames,
  decisionsOf,
};
