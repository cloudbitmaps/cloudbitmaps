'use strict';
/*
 * The batch suite's workload, and what the engine does with it, counted over the in-memory backend.
 *
 * The workload is built by the generator `bench/materialize-many-counts.cjs` uses (the same seeds, the same draws, so the
 * same operands and the same outputs), without the native Roaring binding that file builds its operands with: a harness run
 * from CloudShell has only the published packages. An operand is the sorted distinct ids that file would add to its bitmap.
 *
 * The count follows `large-counts.cjs`: nothing restates the engine's rules; the operands are loaded, one
 * `materializeMany` call is run on a store that has read nothing, and what the storage driver and the registry were
 * asked is counted. The destinations are names nothing has written, as a sample's are on S3, so a publish is a first
 * load of its destination.
 */
const { countedBackend } = require('./large-counts.cjs');
const { PART_BYTES } = require('./calibrate-large-stages.cjs');
const { BATCH_SHAPES } = require('./calibrate-batch-stages.cjs');

/** A seeded generator, so a draw is the same on every machine. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
}

/** The ids of operand kind `kind` (`i % 4`): random ids, one range, or 200 ranges, as a sorted array of distinct ids. */
function operandIds(rnd, kind, ids) {
  if (kind === 0 || kind === 1) {
    const raw = new Uint32Array(ids);
    for (let i = 0; i < ids; i++) raw[i] = Math.floor(rnd() * 2 ** 27);
    raw.sort();
    let n = 0;
    for (let i = 0; i < raw.length; i++) if (i === 0 || raw[i] !== raw[i - 1]) raw[n++] = raw[i];
    return raw.slice(0, n);
  }
  if (kind === 2) {
    const lo = Math.floor(rnd() * 2 ** 26);
    return Uint32Array.from({ length: ids }, (_, i) => lo + i);
  }
  // 200 ranges of `ids / 200`, which may overlap: the union of them, sorted.
  const starts = [];
  for (let r = 0; r < 200; r++) starts.push(Math.floor(rnd() * 2 ** 27));
  const width = ids / 200;
  const raw = new Uint32Array(200 * width);
  let at = 0;
  for (const lo of starts.sort((a, b) => a - b)) for (let k = 0; k < width; k++) raw[at++] = lo + k;
  raw.sort();
  let n = 0;
  for (let i = 0; i < raw.length; i++) if (i === 0 || raw[i] !== raw[i - 1]) raw[n++] = raw[i];
  return raw.slice(0, n);
}

/** The operands of a shape in order: `{ index, ids }`, one at a time, so no more than one is held. */
function* batchOperands(shape) {
  const s = BATCH_SHAPES[shape];
  const rnd = lcg(777);
  for (let i = 0; i < s.operands; i++)
    yield { index: i, ids: operandIds(rnd, i % 4, s.idsPerOperand) };
}

/** A tree of one or two levels of `and` / `or` / `andNot` over random operands, named `op<i>`. */
function makeTree(rnd, operands, depth) {
  const leaf = () => `op${Math.floor(rnd() * operands)}`;
  if (depth === 0 || rnd() < 0.25) return leaf();
  const kids = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () =>
    makeTree(rnd, operands, depth - 1),
  );
  const r = rnd();
  return r < 0.4 ? { and: kids } : r < 0.75 ? { or: kids } : { andNot: kids };
}

/** The outputs of a shape: `{ expr, exclude }`, the opt-out operand `op0` excluded from every one. */
function batchSpecs(shape) {
  const s = BATCH_SHAPES[shape];
  const rnd = lcg(99);
  const specs = [];
  for (let i = 0; i < s.outputs; i++) {
    specs.push({ expr: makeTree(rnd, s.operands, 1 + Math.floor(rnd() * 2)), exclude: ['op0'] });
  }
  return specs;
}

/**
 * What one outcome of `materializeMany` comes to, for comparison: published with its size, or refused with its reason.
 * An outcome that carries an error is not something to count, so it throws.
 */
function outcomeOf(o, i) {
  if (o.error !== undefined) throw new Error(`output ${i} failed in memory: ${o.error.message}`);
  return o.published
    ? { published: true, cardinality: o.cardinality }
    : { published: false, reason: o.reason };
}

/**
 * Count the batch of `shape`: the objects' sizes, and one `materializeMany` call's requests by kind, its groups and what
 * each output came to. `engine` is the library's module (required, as for `countSize`).
 *
 * Returns `{ operandBytes, batch }`, `batch` being `{ put, get, pointer, tail, range, rangeBytes, groups, published,
 * refused, outputs }`: PUT-class is the objects written, the registry's creates and swaps and the listings, GET-class the
 * pointer reads, tails and ranges the engine's storage and registry were asked.
 */
async function countBatch({ shape, engine }) {
  const s = BATCH_SHAPES[shape];
  const { loader, cold, calls, zero } = await countedBackend(engine);
  const operandBytes = [];
  for (const { index, ids } of batchOperands(shape)) {
    zero();
    await loader.load({ segment: `op${index}` }, ids);
    operandBytes.push(calls.putBytes);
  }
  const store = cold();
  const operands = Object.fromEntries(
    Array.from({ length: s.operands }, (_, i) => [`op${i}`, store.segment(`op${i}`)]),
  );
  const run = await store.materializeMany({
    operands,
    outputs: batchSpecs(shape).map((spec, i) => ({ dest: store.segment(`d${i}`), ...spec })),
    keep: 12,
    budget: false,
  });
  if (calls.putMax >= PART_BYTES) {
    throw new Error(
      `an output of ${calls.putMax} bytes would be a multipart upload on S3; the batch suite counts single-part writes`,
    );
  }
  const outputs = run.outputs.map(outcomeOf);
  const published = outputs.filter((o) => o.published).length;
  return {
    operandBytes,
    batch: {
      put: calls.put + calls.create + calls.swap + calls.list,
      get: calls.pointer + calls.tail + calls.range,
      pointer: calls.pointer,
      tail: calls.tail,
      range: calls.range,
      rangeBytes: calls.rangeBytes,
      groups: run.stats.groups,
      published,
      refused: outputs.length - published,
      outputs,
    },
  };
}

module.exports = { lcg, operandIds, batchOperands, makeTree, batchSpecs, outcomeOf, countBatch };
