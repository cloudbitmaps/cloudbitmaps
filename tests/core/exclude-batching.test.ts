/**
 * An `exclude` of an intersect of two or more includes is read in batches of the keys whose AND is not empty: the
 * keys that ask for their exclude chunk in one drain of the microtask queue are read as coalesced ranges over those keys
 * alone, rather than one request each. These cases hold that to account:
 *
 *  - against the real engine, `.crbm` reader and in-memory backend, the storage requests each shape of a probe makes
 *    (segments of 1,000 chunks, 250 ids a chunk), and a property test that a combine never makes more requests for an
 *    exclude than there are survivors whose chunk it holds and the cache does not (what reading each key on its own
 *    cost), and that its answer is the set arithmetic's;
 *  - against a source that records every stream the engine opens, what a batch holds: only keys whose AND is not empty,
 *    no chunk the cache holds, a chunk cached under the version it was read from, one failed batch raising from the key
 *    that needed it, and a stopped combine sending no more.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedLru, CountingMetricsSink, SegmentEngine } from '@cloudbitmaps/core';
import type { CodecBitmap, StorageChunkSource } from '@cloudbitmaps/core';
import { CloudRoaring, MemoryStorage } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { BudgetExceededError } from '@/core/errors';
import { joinId } from '@/core/bit-route';
import { chunkKeyUnder, segmentPrefix } from '@/core/keys';
import { roaringCodec } from '@/roaring-codec';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import type { OpenedStream } from '../helpers/stream-chunk-source';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

// Each case loads thousands of chunks: under a second alone, several times that under the load of the whole suite.
vi.setConfig({ testTimeout: 60_000 });

const CHUNK = 65_536;
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);
/** Turns of the event loop (not of the microtask queue): what a macrotask-deferred flush would still be waiting out. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------------------------------
// The real engine over the in-memory backend
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The ids of a segment holding the chunks `keys`, `per` ids each. `offset` 1 or 2 picks one of two disjoint id
 * families (both strides are above 1), so two segments given different offsets share a chunk without sharing an id.
 */
function idsOf(keys: Iterable<number>, per = 250, offset = 1, thin = false): number[] {
  const stride = per > 1_000 ? 3 : 7;
  return [...keys].flatMap((k) =>
    Array.from({ length: per }, (_, i) => i)
      // `thin`: every (1 + k mod 3)th id, so what a chunk holds depends on its key and a chunk handed to another key shows.
      .filter((i) => !thin || i % (1 + (k % 3)) === 0)
      .map((i) => k * CHUNK + i * stride + offset),
  );
}

interface Counted {
  /** Range requests the storage was asked for, by segment name. */
  readonly ranges: Record<string, number>;
  /** The most range requests in flight at once, over all segments, since the last `reset`. */
  maxInFlight: number;
  reset(): void;
  /** A store that has read nothing, over the counted storage. */
  cold(): CloudRoaring;
  load(name: string, ids: number[]): Promise<void>;
}

/** An in-memory backend whose range requests are counted by segment, with how many are in flight at once. */
function counted(delayMs = 0): Counted {
  const backend = new MemoryStorage();
  const ranges: Record<string, number> = {};
  let inFlight = 0;
  const storage = new Proxy(backend.storage, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop !== 'getRange') return (value as (...a: unknown[]) => unknown).apply(target, args);
        return countedRange(value as (...a: unknown[]) => Promise<unknown>, target, args);
      };
    },
  });
  const countedRange = async (
    value: (...a: unknown[]) => Promise<unknown>,
    target: object,
    args: unknown[],
  ): Promise<unknown> => {
    const name = (args[0] as { segment: string }).segment;
    ranges[name] = (ranges[name] ?? 0) + 1;
    inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, inFlight);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await value.apply(target, args);
    } finally {
      inFlight -= 1;
    }
  };
  const loader = new CloudRoaring({ storage: backend });
  const state: Counted = {
    ranges,
    maxInFlight: 0,
    reset() {
      for (const k of Object.keys(ranges)) delete ranges[k];
      state.maxInFlight = 0;
    },
    cold: () =>
      new CloudRoaring({ storage: brandAsBackend({ storage, registry: backend.registry }) }),
    async load(name, ids) {
      await loader.load({ segment: name }, ids);
    },
  };
  return state;
}

describe('the requests an intersect of two or more includes makes for its exclude (probe shapes)', () => {
  const every = range(0, 1_000);
  /** `a` holds 1,000 chunks of 250 ids; `b` and `x` hold the survivors; `y`, if asked for, the first 334 of them. */
  async function probe(survivors: number[], withY = false): Promise<Counted> {
    const w = counted();
    await w.load('a', idsOf(range(0, 1_000)));
    await w.load('b', idsOf(survivors));
    await w.load('x', idsOf(survivors, 250, 1, true));
    if (withY) await w.load('y', idsOf(survivors.slice(0, 334), 250, 1, true));
    return w;
  }

  it('a ∩ b minus x, every key surviving: about one request for half a window of keys, not one a key', async () => {
    const w = await probe(every);
    const store = w.cold();
    w.reset();
    const got = await collect(
      store.segment('a').intersect([store.segment('b')], { exclude: [store.segment('x')] }),
    );
    const x = new Set(idsOf(every, 250, 1, true));
    expect(got).toEqual(idsOf(every).filter((id) => !x.has(id)));
    expect(w.ranges.a).toBe(1);
    expect(w.ranges.b).toBe(1);
    // A consumer that takes one id at a time sends a request for each half window (16 keys) of the 1,000 survivors; one
    // that takes chunks does better (the intersectInto case below). Each key was a request before.
    expect(w.ranges.x).toBeGreaterThanOrEqual(1);
    expect(w.ranges.x).toBeLessThanOrEqual(70);
  });

  it('a ∩ b minus x and y: each exclude is batched on its own', async () => {
    const w = await probe(every, true);
    const store = w.cold();
    w.reset();
    await collect(
      store.segment('a').intersect([store.segment('b')], {
        exclude: [store.segment('x'), store.segment('y')],
      }),
    );
    expect(w.ranges.x).toBeLessThanOrEqual(70);
    // y holds 334 of the 1,000 keys: a request each before.
    expect(w.ranges.y).toBeLessThanOrEqual(30);
  });

  it('20 spread survivors, x holding them: a few requests, where there were 20', async () => {
    const survivors = range(0, 20).map((j) => j * 50);
    const w = counted();
    await w.load('a', idsOf(every));
    await w.load('b', idsOf(survivors));
    await w.load('x', idsOf(every)); // larger than a tail read: its chunks are requested, not kept with it
    const store = w.cold();
    w.reset();
    await collect(
      store.segment('a').intersect([store.segment('b')], { exclude: [store.segment('x')] }),
    );
    expect(w.ranges.x).toBeLessThanOrEqual(6);
  });

  it('intersectInto with an exclude batches it too', async () => {
    const w = await probe(every);
    const store = w.cold();
    w.reset();
    await store.segment('a').intersectInto(store.segment('d'), [store.segment('b')], {
      exclude: [store.segment('x')],
      allowEmpty: true,
    });
    expect(w.ranges.x).toBeLessThanOrEqual(40);
  });

  it('andNot, whose exclude is read with its one include, is unchanged', async () => {
    const w = await probe(every);
    const store = w.cold();
    w.reset();
    await collect(store.segment('a').andNot([store.segment('x')]));
    expect(w.ranges).toEqual({ a: 1, x: 1 });
  });

  it('survivors far apart in a large exclude: no more requests than survivors', async () => {
    // x holds 600 chunks of 4,096 ids (each about 8 KiB), so survivors 60 chunks apart are over 256 KiB apart in it and
    // are not merged: each is its own request, as each was before.
    const survivors = range(0, 10).map((j) => j * 60);
    const w = counted();
    await w.load('a', idsOf(survivors));
    await w.load('b', idsOf(survivors));
    await w.load('x', idsOf(range(0, 600), 4_096));
    const store = w.cold();
    w.reset();
    await collect(
      store.segment('a').intersect([store.segment('b')], { exclude: [store.segment('x')] }),
    );
    expect(w.ranges.x).toBeGreaterThanOrEqual(1);
    expect(w.ranges.x).toBeLessThanOrEqual(survivors.length);
  });

  it('keeps the requests in flight to the combine concurrency, as reading each key on its own did', async () => {
    const survivors = range(0, 200);
    const w = counted(1);
    for (const name of ['a', 'b', 'x', 'y']) await w.load(name, idsOf(survivors));
    const store = w.cold();
    w.reset();
    await collect(
      store.segment('a').intersect([store.segment('b')], {
        exclude: [store.segment('x'), store.segment('y')],
        concurrency: 8,
      }),
    );
    // Each exclude holds at most `concurrency` keys in flight, and an include is one range here.
    expect(w.maxInFlight).toBeLessThanOrEqual(2 * 8 + 2);
  });
});

describe('an intersect with an exclude over random operands', () => {
  /** What each of 60 chunk keys holds: most keys are in both includes, so many survive; some ANDs are empty. */
  const layout = fc.array(
    fc.record({
      a: fc.integer({ min: 0, max: 5 }).map((n) => n > 0),
      b: fc.integer({ min: 0, max: 5 }).map((n) => n > 0),
      x: fc.boolean(),
      emptyAnd: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
      cached: fc.integer({ min: 0, max: 2 }).map((n) => n === 0),
    }),
    { minLength: 60, maxLength: 60 },
  );

  it('equals the set arithmetic, and never makes more requests for the exclude than reading each key did', async () => {
    let batched = 0;
    await fc.assert(
      fc.asyncProperty(
        layout,
        fc.constantFrom(1, 250, 3_000),
        fc.constantFrom(1, 250, 3_000),
        fc.constantFrom(1, 2, 4, 8, 32),
        async (keys, per, perX, concurrency) => {
          const w = counted();
          const at = (pick: (k: (typeof keys)[number]) => boolean): number[] =>
            range(0, 60).filter((i) => pick(keys[i]!));
          const aIds = idsOf(
            at((k) => k.a),
            per,
          );
          // `b` shares a chunk with `a` without an id at the keys whose AND is to be empty.
          const bIds = [
            ...idsOf(
              at((k) => k.b && !k.emptyAnd),
              per,
            ),
            ...idsOf(
              at((k) => k.b && k.emptyAnd),
              per,
              2,
            ),
          ];
          const xKeys = at((k) => k.x);
          const xIds = idsOf(xKeys, perX, 1, true);
          await w.load('a', aIds);
          await w.load('b', bIds);
          await w.load('x', xIds);
          const store = w.cold();
          // The exclude chunks the cache holds when the combine starts: read on their own first.
          const warm = at((k) => k.x && k.cached);
          for (const k of warm) await store.segment('x').has(k * CHUNK + 1);
          w.reset();

          const got = await collect(
            store.segment('a').intersect([store.segment('b')], {
              exclude: [store.segment('x')],
              concurrency,
            }),
          );

          const b = new Set(bIds);
          const x = new Set(xIds);
          const survivors = new Set<number>();
          const expected: number[] = [];
          for (const id of aIds) {
            if (!b.has(id)) continue;
            survivors.add(Math.floor(id / CHUNK));
            if (!x.has(id)) expected.push(id);
          }
          expect(got).toEqual(expected.sort((p, q) => p - q));

          // What reading each survivor's exclude chunk on its own cost: a request for each such chunk the cache lacked.
          const xSet = new Set(xKeys);
          const warmSet = new Set(warm);
          const today = [...survivors].filter((k) => xSet.has(k) && !warmSet.has(k)).length;
          expect(w.ranges.x ?? 0).toBeLessThanOrEqual(today);
          if (today >= 4 && (w.ranges.x ?? 0) < today) batched += 1;
        },
      ),
      { numRuns: 40 },
    );
    // The generator reaches the batcher: in some runs the requests were fewer than the keys.
    expect(batched).toBeGreaterThan(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// A source that records the streams the engine opens
// ---------------------------------------------------------------------------------------------------------------------

const clock = { now: () => 0 };
const ids = (chunks: readonly number[], per = 3): number[] =>
  chunks.flatMap((c) => Array.from({ length: per }, (_, i) => joinId(c, i + 1)));
/** What an exclude holds at `chunks` when it holds `1 .. 1 + c mod 3` of a chunk `c`'s three ids: it differs by key. */
const partial = (chunks: readonly number[]): number[] =>
  chunks.flatMap((c) => Array.from({ length: (c % 3) + 1 }, (_, i) => joinId(c, i + 1)));
/** What `ids(chunks)` leaves once `partial(chunks)` is taken from it. */
const minusPartial = (chunks: readonly number[]): number[] =>
  chunks.flatMap((c) => Array.from({ length: 2 - (c % 3) }, (_, i) => joinId(c, (c % 3) + 2 + i)));
/** Ids at `chunks` that are not those of `ids`, so a chunk is shared without an id being. */
const otherIds = (chunks: readonly number[]): number[] =>
  chunks.flatMap((c) => [joinId(c, 100), joinId(c, 101)]);

function setup(
  segments: Record<string, number[]>,
  options: { cache?: boolean; budget?: number } = {},
) {
  const storage = new StreamChunkSource();
  for (const [name, set] of Object.entries(segments)) seedSegment(storage, name, set);
  const cache =
    options.cache === false
      ? undefined
      : new BoundedLru<string, CodecBitmap>({ maxEntries: 10_000, clock });
  const metrics = new CountingMetricsSink();
  const engine = new SegmentEngine({
    storage,
    codec: roaringCodec,
    ...(cache ? { cache } : {}),
    metrics,
    ...(options.budget === undefined ? {} : { budget: { maxRequests: options.budget } }),
  });
  return { storage, engine, cache, metrics };
}
const ref = (segment: string) => ({ segment });
const KEYS = range(0, 40);
const isX = (o: OpenedStream) => o.segment === 'x';
/** The requests made for `x`: a stream is one request here, and so is each chunk read on its own. */
const xRequests = (s: StreamChunkSource): number =>
  s.opened.filter(isX).length + s.singles.filter((k) => k.startsWith('x:')).length;
/** The chunk keys asked of `x`, by any route. */
const xKeysAsked = (s: StreamChunkSource): number[] =>
  [
    ...s.opened.filter(isX).flatMap((o) => [...o.keys]),
    ...s.singles.filter((k) => k.startsWith('x:')).map((k) => Number(k.slice(2))),
  ].sort((p, q) => p - q);
const WITH_X = { exclude: [ref('x')], concurrency: 8 };

describe('which keys an exclude batch holds', () => {
  it('reads 40 surviving keys in about a window of keys a request, and answers each from its own chunk', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    expect(await collect(engine.intersect([ref('a'), ref('b')], WITH_X))).toEqual(
      minusPartial(KEYS),
    );
    expect(xKeysAsked(storage)).toEqual(KEYS);
    expect(xRequests(storage)).toBeLessThanOrEqual(KEYS.length / 8 + 1);
    expect(storage.singles.filter((k) => k.startsWith('x:'))).toEqual([]);
  });

  it('never holds a key whose AND is empty', async () => {
    const odd = KEYS.filter((k) => k % 2 === 1);
    const even = KEYS.filter((k) => k % 2 === 0);
    const { storage, engine } = setup({
      a: [...ids(even), ...ids(odd)],
      b: [...ids(even), ...otherIds(odd)],
      x: partial(KEYS),
    });
    expect(await collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('x')] }))).toEqual(
      minusPartial(even),
    );
    expect(xKeysAsked(storage)).toEqual(even);
  });

  it('leaves out a chunk the cache holds, and counts each chunk a hit or a miss once', async () => {
    const { storage, engine, metrics } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    const answer = await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    expect(answer).toEqual(minusPartial(KEYS));
    const first = xRequests(storage);
    expect(first).toBeGreaterThan(0);
    const before = metrics.snapshot().cache;
    expect(await collect(engine.intersect([ref('a'), ref('b')], WITH_X))).toEqual(answer);
    // Everything is cached: no stream, and a hit for each of the 120 chunks (a, b and x), no miss.
    expect(xRequests(storage)).toBe(first);
    const after = metrics.snapshot().cache;
    expect(after.misses).toBe(before.misses);
    expect(after.hits - before.hits).toBe(KEYS.length * 3);
  });

  it('reads only the chunks the cache lacks when it holds some', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    for (const k of KEYS.filter((k) => k % 3 === 0)) await engine.has(ref('x'), joinId(k, 1));
    storage.opened.length = 0;
    storage.singles.length = 0;
    expect(await collect(engine.intersect([ref('a'), ref('b')], WITH_X))).toEqual(
      minusPartial(KEYS),
    );
    expect(xKeysAsked(storage)).toEqual(KEYS.filter((k) => k % 3 !== 0));
  });

  it('counts a cache miss for each chunk of each operand once, as reading each on its own did', async () => {
    const { engine, metrics } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    expect(metrics.snapshot().cache.misses).toBe(KEYS.length * 3);
    expect(metrics.snapshot().cache.hits).toBe(0);
  });

  it('reports one storage.get for each request a batch sends', async () => {
    const storage = new StreamChunkSource();
    for (const name of ['a', 'b', 'x']) seedSegment(storage, name, ids(KEYS));
    const gets: string[] = [];
    const engine = new SegmentEngine({
      storage,
      codec: roaringCodec,
      metrics: {
        onEvent: (e) => {
          if (e.kind === 'storage.get') gets.push(e.segment);
        },
      },
    });
    await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    expect(gets.filter((s) => s === 'x')).toHaveLength(xRequests(storage));
  });

  it('is unchanged for a source that reads chunk by chunk', async () => {
    const plain = new MemoryStorageChunkSource();
    seedSegment(plain, 'a', ids(KEYS));
    seedSegment(plain, 'b', ids([3, 4, 5, 90]));
    seedSegment(plain, 'x', ids([4]));
    const engine = new SegmentEngine({ storage: plain, codec: roaringCodec });
    expect(await collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('x')] }))).toEqual(
      ids([3, 5]),
    );
  });
});

describe('the cost of a combine is charged as before', () => {
  it('charges each surviving key its exclude chunk: a ceiling at the reads it would make passes, one below refuses', async () => {
    const run = (budget: number) => {
      const { storage, engine } = setup(
        { a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) },
        { budget },
      );
      return {
        storage,
        result: collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('x')] })),
      };
    };
    const refused = run(KEYS.length * 3 - 1);
    await expect(refused.result).rejects.toBeInstanceOf(BudgetExceededError);
    expect(refused.storage.opened).toEqual([]);
    await expect(run(KEYS.length * 3).result).resolves.toEqual(minusPartial(KEYS));
  });
});

describe('a batch and the version its chunks are read under', () => {
  it('caches an exclude chunk under the version it was read from, not the one the read planned under', async () => {
    const { storage, cache, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    storage.readVersion = (segment) => (segment === 'x' ? 'v2' : 'v1');
    await collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('x')] }));
    const prefix = segmentPrefix(ref('x'));
    for (const k of KEYS) {
      expect(cache!.get(chunkKeyUnder(prefix, k, 'v2'))).toBeDefined();
      expect(cache!.get(chunkKeyUnder(prefix, k, 'v1'))).toBeUndefined();
    }
  });

  it('caches nothing a batch reads once its segment was invalidated while it ran', async () => {
    const { storage, cache, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    let invalidated = false;
    storage.beforeYield = (stream) => {
      if (isX(stream) && !invalidated) {
        invalidated = true;
        engine.invalidate(ref('x'));
      }
    };
    await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    const prefix = segmentPrefix(ref('x'));
    const first = storage.opened.find(isX)!;
    expect(first.keys.length).toBeGreaterThan(0);
    for (const k of first.keys) expect(cache!.get(chunkKeyUnder(prefix, k, 'v1'))).toBeUndefined();
  });

  it('plans again when the exclude moves mid-batch, and subtracts what the version it moved to holds', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: ids([2, 3]) });
    // Once the exclude's first chunk is read, it moves: version 2 also holds chunk 30, which no listing of version 1 names.
    let moved = false;
    storage.beforeYield = (stream) => {
      if (isX(stream) && !moved) {
        moved = true;
        storage.version = 'v2';
        seedSegment(storage, 'x', ids([2, 3, 30]));
      }
    };
    const out = await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    expect(out).toEqual(ids(KEYS.filter((k) => ![2, 3, 30].includes(k))));
  });
});

describe('a batch that fails', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => void process.off('unhandledRejection', onUnhandled));

  it('raises from the first key that needed it, after the ids of the keys before it, and leaves no unhandled rejection', async () => {
    const even = KEYS.filter((k) => k % 2 === 0);
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: ids(even) });
    const boom = new Error('x range failed');
    storage.beforeYield = (stream, key) => {
      if (isX(stream) && key === 20) throw boom;
    };
    const got: number[] = [];
    const run = async (): Promise<void> => {
      for await (const id of engine.intersect([ref('a'), ref('b')], WITH_X)) got.push(id);
    };
    await expect(run()).rejects.toBe(boom);
    // Even keys are subtracted whole, odd keys survive; the read stops at key 20, the first the failed stream owed.
    expect(got).toEqual(ids(KEYS.filter((k) => k % 2 === 1 && k < 20)));
    await turns(10);
    expect(unhandled).toEqual([]);
  });

  it('raises when the failed batch is a later one, after the ids of every key before it', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: ids([39]) });
    storage.beforeYield = (stream, key) => {
      if (isX(stream) && key === 39) throw new Error('last key');
    };
    await expect(collect(engine.intersect([ref('a'), ref('b')], WITH_X))).rejects.toThrow(
      'last key',
    );
    await turns(10);
    expect(unhandled).toEqual([]);
  });

  it('raises no error for a key whose AND is empty, whose exclude chunk would have failed', async () => {
    const { storage, engine } = setup({
      a: ids([1, 2]),
      b: [...otherIds([1]), ...ids([2])],
      x: ids([1, 2]),
    });
    storage.beforeYield = (stream, key) => {
      if (isX(stream) && key === 1) throw new Error('never read');
    };
    expect(await collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('x')] }))).toEqual(
      [],
    );
  });
});

describe('a combine that stops', () => {
  it('sends nothing more for an exclude once the caller stops, though keys that were still working on their AND finish', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
      // Chunks 0 and 1 of `a` land at once; the rest wait, as an include range that lands later would.
      let open: () => void = () => {};
      const held = new Promise<void>((resolve) => (open = resolve));
      storage.beforeYield = async (stream, key) => {
        if (stream.segment === 'a' && key >= 2) await held;
      };
      for await (const id of engine.intersect([ref('a'), ref('b')], WITH_X)) {
        void id;
        break;
      }
      // The keys that had landed were read together, before the stop.
      const before = xRequests(storage);
      expect(before).toBe(1);
      open();
      await turns(20);
      // Keys 2 to 7 were already working on their AND: they must not start a read of the exclude now.
      expect(xRequests(storage)).toBe(before);
      expect(xKeysAsked(storage)).toEqual([0, 1]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('ends the streams it opened when the caller stops', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    for await (const id of engine.intersect([ref('a'), ref('b')], WITH_X)) {
      void id;
      break;
    }
    // A closed stream ends once what it had in flight settles.
    await turns(20);
    const xs = storage.opened.filter(isX);
    expect(xs.length).toBeGreaterThan(0);
    for (const s of xs) expect(s.finished || s.closedEarly).toBe(true);
  });

  it('closes a batch whose requests are still in flight when the caller stops', async () => {
    const inner = new StreamChunkSource();
    for (const [name, set] of Object.entries({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) })) {
      seedSegment(inner, name, set);
    }
    // A source whose stream stops at once when closed, as one that cancels its requests does (an async generator only
    // stops after what it was asked for), recording the streams that were closed.
    const closed: string[] = [];
    const opened: string[] = [];
    const storage: StorageChunkSource = {
      getChunk: (r) => inner.getChunk(r),
      listChunkKeys: (r) => inner.listChunkKeys(r),
      currentVersion: () => inner.currentVersion(),
      getChunks: (r, keys, options) => {
        opened.push(r.segment);
        const source = inner.getChunks(r, keys, options);
        return {
          [Symbol.asyncIterator]() {
            const iterator = source[Symbol.asyncIterator]();
            return {
              next: () => iterator.next(),
              return: () => {
                closed.push(r.segment);
                return Promise.resolve({ done: true as const, value: undefined });
              },
            };
          },
        };
      },
    };
    const engine = new SegmentEngine({ storage, codec: roaringCodec });
    let openA: () => void = () => {};
    const heldA = new Promise<void>((resolve) => (openA = resolve));
    let openX: () => void = () => {};
    const heldX = new Promise<void>((resolve) => (openX = resolve));
    inner.beforeYield = async (stream, key) => {
      if (stream.segment === 'a' && key >= 2) await heldA;
      if (isX(stream) && key >= 2) await heldX;
    };
    try {
      for await (const id of engine.intersect([ref('a'), ref('b')], WITH_X)) {
        void id;
        // Keys 2 to 7 land, and their batch is sent; its range is still in flight when the caller stops.
        openA();
        await turns(3);
        expect(opened.filter((s) => s === 'x')).toHaveLength(2);
        break;
      }
      await turns(3);
      // Both batches of the exclude were closed, the first when its keys were all answered and the second by the stop.
      expect(closed.filter((s) => s === 'x')).toHaveLength(2);
    } finally {
      openX();
    }
  });

  it('reads the keys that ask together in one batch, and the keys that land later in another', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    storage.beforeYield = async (stream, key) => {
      if (stream.segment === 'a' && key >= 4) await held;
    };
    const run = collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    await turns(3);
    // Chunks 0 to 3 landed together and were read before the later ones were let go: a flush that waited for the rest
    // (a timer, or the window filling) would not have sent them yet.
    expect(storage.opened.filter(isX).map((o) => [...o.keys])).toEqual([[0, 1, 2, 3]]);
    open();
    await run;
    expect(xKeysAsked(storage)).toEqual(KEYS);
    expect(storage.opened.filter(isX).length).toBeGreaterThan(1);
  });
});

describe('what a batch does not change', () => {
  it('answers a combine with two excludes, one of which holds no survivor, as the set arithmetic does', async () => {
    const { storage, engine } = setup({
      a: ids(KEYS),
      b: ids(range(0, 30)),
      x: ids([1, 5, 9]),
      y: ids([35, 36]),
    });
    expect(
      await collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('x'), ref('y')] })),
    ).toEqual(ids(range(0, 30).filter((k) => ![1, 5, 9].includes(k))));
    expect(storage.opened.filter((o) => o.segment === 'y')).toEqual([]);
    expect(storage.singles.filter((k) => k.startsWith('y:'))).toEqual([]);
  });

  it('answers the same through the batch and chunk forms', async () => {
    const { engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: ids([3, 4]) });
    const expected = ids(KEYS.filter((k) => k !== 3 && k !== 4));
    const options = { exclude: [ref('x')] };
    expect(await collect(engine.intersect([ref('a'), ref('b')], options))).toEqual(expected);
    const batches: number[] = [];
    for await (const batch of engine.intersectBatches([ref('a'), ref('b')], options)) {
      batches.push(...batch);
    }
    expect(batches).toEqual(expected);
    const chunks: number[] = [];
    for await (const c of engine.intersectChunks([ref('a'), ref('b')], options)) {
      chunks.push(...Array.from(c.bitmap, (r) => joinId(c.chunkKey, r)));
    }
    expect(chunks).toEqual(expected);
  });
});
