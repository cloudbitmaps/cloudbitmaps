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
const { BATCH_SHAPES, passedOptions } = require('./calibrate-batch-stages.cjs');

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

/** The sorted distinct ids in both of two sorted distinct arrays. */
function intersectSorted(a, b) {
  const out = new Uint32Array(Math.min(a.length, b.length));
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) i++;
    else if (a[i] > b[j]) j++;
    else {
      out[n++] = a[i];
      i++;
      j++;
    }
  }
  return out.subarray(0, n);
}

/** The sorted distinct ids in either of two sorted distinct arrays. */
function unionSorted(a, b) {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) out[n++] = a[i++];
    else if (a[i] > b[j]) out[n++] = b[j++];
    else {
      out[n++] = a[i];
      i++;
      j++;
    }
  }
  while (i < a.length) out[n++] = a[i++];
  while (j < b.length) out[n++] = b[j++];
  return out.subarray(0, n);
}

/** The sorted distinct ids of `a` that are not in `b`. */
function minusSorted(a, b) {
  const out = new Uint32Array(a.length);
  let j = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    while (j < b.length && b[j] < a[i]) j++;
    if (j >= b.length || b[j] !== a[i]) out[n++] = a[i];
  }
  return out.subarray(0, n);
}

/** The ids an expression of {@link makeTree} stands for, over operand id lists named `op<i>`. */
function evaluate(expr, byName) {
  if (typeof expr === 'string') return byName[expr];
  if ('and' in expr) return expr.and.map((k) => evaluate(k, byName)).reduce(intersectSorted);
  if ('or' in expr) return expr.or.map((k) => evaluate(k, byName)).reduce(unionSorted);
  const [head, ...rest] = expr.andNot.map((k) => evaluate(k, byName));
  return rest.reduce(minusSorted, head);
}

/**
 * How many ids each output of `shape` must hold, by plain arithmetic over the sorted ids the generator makes: the
 * intersection, union and difference of sorted arrays, with each output's excluded operands taken away. No library code is
 * used, so the sizes do not come from the engine they check. Returns one number per output, in order (0 for an output
 * whose answer is no ids: the engine publishes such an output, empty).
 */
function expectedSizes(shape) {
  const byName = {};
  for (const { index, ids } of batchOperands(shape)) byName[`op${index}`] = ids;
  return batchSpecs(shape).map((spec) => {
    const keep = spec.exclude.reduce(
      (acc, name) => minusSorted(acc, byName[name]),
      evaluate(spec.expr, byName),
    );
    return keep.length;
  });
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

/** The most read-backs in flight at once: it sets how fast a run reads its outputs back, never how many requests. */
const READ_BACK_CONCURRENCY = 16;

/**
 * Read back what each published output holds: `count()` of its stored segment, on one store, a few at a time. `segmentOf(i)`
 * is output `i`'s destination. Returns each output's count, `null` for one that was not published.
 */
async function readBackCounts(outcomes, segmentOf) {
  const counts = outcomes.map(() => null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= outcomes.length) return;
      if (outcomes[i].published) counts[i] = await segmentOf(i).count();
    }
  };
  await Promise.all(Array.from({ length: READ_BACK_CONCURRENCY }, worker));
  return counts;
}

/**
 * Count the batch of `shape`: the objects' sizes, and one `materializeMany` call's requests by kind, its groups and what
 * each output came to, then the requests of reading each published output back with `count()` on a store of its own.
 * `engine` is the library's module (required, as for `countSize`). `call` is the run's call settings (`callSettings`): the
 * count is of the call the run makes, so it passes the same options (the grouping, and so the requests, depend on them).
 *
 * Each output's size is worked out twice before the stage may rest on it: by {@link expectedSizes}, plain arithmetic over
 * the generator's ids, and by the engine over the in-memory backend. A difference between the two throws, so the sizes a
 * run is held to are not the engine's word for itself.
 *
 * Returns `{ operandBytes, sizes, batch, readBack }`. `batch` is `{ put, get, pointer, tail, range, rangeBytes, groups,
 * published, refused, outputs }`: PUT-class is the objects written, the registry's creates and swaps and the listings,
 * GET-class the pointer reads, tails and ranges the engine's storage and registry were asked. `readBack` is `{ put, get,
 * pointer, tail, range }` for the read-backs of the published outputs, one cold store for all of them. `sizes` is each
 * output's expected size.
 */
async function countBatch({ shape, engine, call }) {
  const s = BATCH_SHAPES[shape];
  const sizes = expectedSizes(shape);
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
    ...passedOptions(call),
  });
  if (calls.putMax >= PART_BYTES) {
    throw new Error(
      `an output of ${calls.putMax} bytes would be a multipart upload on S3; the batch suite counts single-part writes`,
    );
  }
  const batch = {
    put: calls.put + calls.create + calls.swap + calls.list,
    get: calls.pointer + calls.tail + calls.range,
    pointer: calls.pointer,
    tail: calls.tail,
    range: calls.range,
    rangeBytes: calls.rangeBytes,
    groups: run.stats.groups,
  };
  const outputs = run.outputs.map(outcomeOf);
  for (let i = 0; i < outputs.length; i += 1) {
    const got = outputs[i];
    if (got.published && got.cardinality !== sizes[i]) {
      throw new Error(
        `output ${i}: the engine's in-memory count is ${got.cardinality}, and set arithmetic over the generator's ids gives ${sizes[i]}`,
      );
    }
  }
  const reader = cold();
  const readBackSizes = await readBackCounts(outputs, (i) => reader.segment(`d${i}`));
  for (let i = 0; i < outputs.length; i += 1) {
    if (readBackSizes[i] !== (outputs[i].published ? sizes[i] : null)) {
      throw new Error(
        `output ${i}: read back from the in-memory store it holds ${readBackSizes[i]} ids; set arithmetic gives ${sizes[i]}`,
      );
    }
  }
  const published = outputs.filter((o) => o.published).length;
  return {
    operandBytes,
    sizes,
    batch: { ...batch, published, refused: outputs.length - published, outputs },
    readBack: {
      put: calls.put + calls.create + calls.swap + calls.list,
      get: calls.pointer + calls.tail + calls.range,
      pointer: calls.pointer,
      tail: calls.tail,
      range: calls.range,
    },
  };
}

module.exports = {
  lcg,
  operandIds,
  batchOperands,
  makeTree,
  batchSpecs,
  outcomeOf,
  expectedSizes,
  readBackCounts,
  READ_BACK_CONCURRENCY,
  countBatch,
};
