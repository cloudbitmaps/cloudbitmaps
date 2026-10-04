'use strict';
/*
 * What the engine's reads cost in storage requests, counted by running the real engine over the in-memory backend.
 *
 * A combine reads each operand's chunks as coalesced ranges, so the requests a cold read makes depend on where the
 * chunks it needs sit in each object, and on how large they are: how many ranges the planner makes of them. That is
 * the planner's business, and restating its rules here would be a second copy that drifts. So nothing here knows them.
 * A count is taken by building the layout, running the read through the built library on `MemoryStorage`, and counting
 * what the storage driver and the registry were asked.
 *
 * Used by `bench/range-counts.cjs`, which writes the table the cost model reads (`bench/range-counts.json`), and by the
 * calibration harness, which counts the layout it is about to load before it spends anything, so what it expects of a
 * real run is what the engine on the same layout does.
 */

/** The ids of a segment that holds exactly the chunks `keys`, `idsPerChunk` each (so a chunk of about 2 B an id). */
function* idsOfChunks(keys, idsPerChunk) {
  for (const k of keys) {
    for (let i = 0; i < idsPerChunk; i += 1) yield k * 65_536 + i * 7 + 1;
  }
}

/**
 * A backend over `MemoryStorage` whose storage reads and pointer reads are counted. `cold()` is a store that has read
 * nothing, with the counts reset.
 */
async function countedBackend() {
  const { CloudRoaring, MemoryStorage } = await import('@cloudbitmaps/roaring');
  const backend = new MemoryStorage();
  const calls = { getRange: 0, getTail: 0, pointer: 0, rangeBytes: 0 };
  // The backend's own drivers, counted in place: the library is installed alone where the calibration harness runs, so
  // nothing here may import a package of its own.
  const count = (target, name, onCall) => {
    const original = target[name].bind(target);
    target[name] = (...args) => {
      onCall(args);
      return original(...args);
    };
  };
  count(backend.storage, 'getTail', () => {
    calls.getTail += 1;
  });
  count(backend.storage, 'getRange', (args) => {
    calls.getRange += 1;
    calls.rangeBytes += args[2];
  });
  count(backend.registry, 'get', () => {
    calls.pointer += 1;
  });
  const loader = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  /** A store that has read nothing, with the counts reset. */
  const cold = () => {
    calls.getRange = calls.getTail = calls.pointer = calls.rangeBytes = 0;
    return new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  };
  return { loader, cold, calls };
}

/** The requests of one cold read: `read(store)` returns the stream to drain. */
async function coldRead(loads, read) {
  const { loader, cold, calls } = await countedBackend();
  for (const [segment, ids] of loads) await loader.load({ segment }, ids);
  const store = cold();
  let n = 0;
  for await (const id of read(store)) {
    void id;
    n += 1;
  }
  return { ...calls, ids: n };
}

/**
 * A cold intersect of two segments that hold the chunks `keysA` and `keysB` (`idsPerChunk` ids each): what its
 * requests were. `rangesPerOperand` is the chunk range requests it made of each operand.
 */
async function coldIntersect(keysA, keysB, idsPerChunk) {
  const r = await coldRead(
    [
      ['a', [...idsOfChunks(keysA, idsPerChunk)]],
      ['b', [...idsOfChunks(keysB, idsPerChunk)]],
    ],
    (store) => store.segment('a').intersect([store.segment('b')]),
  );
  return { ...r, rangesPerOperand: r.getRange / 2 };
}

/**
 * A cold andNot of the segment holding `include` against one segment per entry of `excludes`: what its requests were.
 */
async function coldAndNot(include, excludes, idsPerChunk) {
  const loads = [['a', [...idsOfChunks(include, idsPerChunk)]]];
  excludes.forEach((keys, i) => loads.push([`s${i}`, [...idsOfChunks(keys, idsPerChunk)]]));
  return coldRead(loads, (store) =>
    store.segment('a').andNot(excludes.map((_, i) => store.segment(`s${i}`))),
  );
}

/**
 * A cold intersect of the segments holding `idsA` and `idsB`: what its requests were, as `coldIntersect` reports them.
 */
async function coldIntersectIds(idsA, idsB) {
  const r = await coldRead(
    [
      ['a', [...idsA]],
      ['b', [...idsB]],
    ],
    (store) => store.segment('a').intersect([store.segment('b')]),
  );
  return { ...r, rangesPerOperand: r.getRange / 2 };
}

/** A cold andNot of the segment holding `includeIds` against one holding each list of `excludeIds`. */
async function coldAndNotIds(includeIds, excludeIds) {
  const loads = [['a', [...includeIds]]];
  excludeIds.forEach((ids, i) => loads.push([`s${i}`, [...ids]]));
  return coldRead(loads, (store) =>
    store.segment('a').andNot(excludeIds.map((_, i) => store.segment(`s${i}`))),
  );
}

/** `n` consecutive integers from `from`. */
const run = (from, n) => Array.from({ length: n }, (_, i) => from + i);

/**
 * The keys of two segments of `chunks` chunks each that share `k` of them, laid out either way.
 *   packed  the shared chunks come first in both objects, as in the calibration layout.
 *   spread  the shared chunks are spread evenly over both objects, each segment's own chunks between them.
 */
function sharedLayout(chunks, k, layout) {
  const own = chunks - k;
  if (layout === 'packed') {
    return {
      keysA: [...run(0, k), ...run(2_000, own)],
      keysB: [...run(0, k), ...run(10_000, own)],
    };
  }
  // The shared chunk m is key m * stride; the keys between it and the next hold the segments' own chunks, A's in the
  // first half of the gap and B's in the second, so neither segment's key collides with the other's.
  const stride = Math.floor(60_000 / Math.max(k, 1));
  const keysA = [];
  const keysB = [];
  let ownA = 0;
  for (let m = 0; m < k; m += 1) {
    keysA.push(m * stride);
    keysB.push(m * stride);
    const upTo = Math.floor(((m + 1) * own) / k); // the own chunks placed after this many shared ones
    for (; ownA < upTo; ownA += 1) {
      const slot = ownA - Math.floor((m * own) / k);
      keysA.push(m * stride + 1 + slot);
      keysB.push(m * stride + Math.floor(stride / 2) + 1 + slot);
    }
  }
  return { keysA, keysB };
}

module.exports = {
  idsOfChunks,
  coldIntersect,
  coldAndNot,
  coldIntersectIds,
  coldAndNotIds,
  sharedLayout,
  run,
};
