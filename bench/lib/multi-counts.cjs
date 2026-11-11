'use strict';
/*
 * What the multi suite's reads cost in storage requests, counted by running the real engine over the in-memory backend on
 * the layouts the suite will load.
 *
 * Like `large-counts.cjs`, nothing here restates the engine's rules: each operand set is loaded into a backend of its own,
 * each shape's `intersect` and `intersectCount` run on a store that has read nothing, and what the storage driver and the
 * registry were asked is counted. The planner's range coalescing sits above the driver, so the same object bytes give the
 * same ranges on S3 and in memory; the objects are byte-identical (the same ids and the same codec: the installed
 * release's own engine is the one counted, which the harness passes in); a cold store with the pointer refresh off sends
 * each pointer once. An operand's load is counted by `firstLoadRequests`, not here, since a `store.load()` makes one request
 * more on S3 than the in-memory driver models.
 *
 * The content is held twice. Here, before anything is created, what the engine returned in memory (the ids' count and
 * their sum, and the count verb's answer) must equal the layout's arithmetic (`calibrate-multi-stages.cjs`); and in the
 * run, each real read must return exactly the same count and sum.
 */
const { countedBackend } = require('./large-counts.cjs');
const { drain } = require('./calibrate-reads.cjs');
const {
  MULTI_POOLS,
  MULTI_SHAPES,
  operandSegment,
  planMultiPool,
  multiReadBound,
} = require('./calibrate-multi-stages.cjs');

/** The requests the counted backend saw since its last reset, by kind. */
const readOf = (c) => ({
  pointer: c.pointer,
  tail: c.tail,
  range: c.range,
  rangeBytes: c.rangeBytes,
  gets: c.pointer + c.tail + c.range,
});

/**
 * Count the multi suite. `engine` is the library's module (`CloudRoaring`, `MemoryStorage`; required: the harness passes the
 * one its stores come from, so a count is never taken from another engine than the one under test).
 *
 * Returns `{ pools, shapes }`. A pool is its layout without the generator, plus `operandBytes`, the size of each stored
 * object. A shape is `{ name, group, pool, k, bound, objectBytes, counts: { intersect, count } }`: `bound` the most GET-class a
 * read of it can make, `objectBytes` the bytes of the k objects it reads, and each count's `pointer`, `tail`, `range`,
 * `rangeBytes` and `gets`, with the ids (`ids`, `sum`) the stream returned or the `result` the count verb returned.
 */
async function countMulti({ engine }) {
  const pools = [];
  const shapes = [];
  for (const name of Object.keys(MULTI_POOLS)) {
    const layout = planMultiPool(name);
    const { loader, cold, calls, zero } = await countedBackend(engine);
    const operandBytes = [];
    for (let i = 0; i < layout.operands; i += 1) {
      zero();
      await loader.load({ segment: operandSegment(name, i) }, layout.idsOf(i));
      operandBytes.push(calls.putBytes);
    }
    const { idsOf, ...plain } = layout;
    void idsOf;
    pools.push({ ...plain, operandBytes });
    for (const shape of MULTI_SHAPES.filter((s) => s.pool === name)) {
      const seg = (store, i) => store.segment(operandSegment(name, i));
      const others = (store) => Array.from({ length: shape.k - 1 }, (_, i) => seg(store, i + 1));
      const want = layout.expected;
      let store = cold();
      const got = await drain(seg(store, 0).intersect(others(store)));
      if (got.n !== want.count || got.sum !== want.sum) {
        throw new Error(
          `${shape.name}: the engine's intersect returned ${got.n} ids (sum ${got.sum}) in memory; the layout holds ${want.count} (sum ${want.sum})`,
        );
      }
      const intersect = { ...readOf(calls), ids: got.n, sum: got.sum };
      store = cold();
      const result = await seg(store, 0).intersectCount(others(store));
      if (result !== want.count) {
        throw new Error(
          `${shape.name}: the engine's intersectCount returned ${result} in memory; the layout holds ${want.count}`,
        );
      }
      const count = { ...readOf(calls), result };
      shapes.push({
        ...shape,
        bound: multiReadBound(shape, layout, operandBytes),
        objectBytes: operandBytes.slice(0, shape.k).reduce((a, b) => a + b, 0),
        counts: { intersect, count },
      });
    }
  }
  return { pools, shapes };
}

module.exports = { countMulti };
