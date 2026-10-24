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
import type { CodecBitmap } from '@cloudbitmaps/core';
import type { ChunkRead, SegmentRef } from '@/core/ports';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { Clock } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { brandAsBackend } from '@/core/ports';
import { BudgetExceededError } from '@/core/errors';
import { joinId } from '@/core/bit-route';
import { chunkKeyUnder, segmentPrefix } from '@/core/keys';
import { storeCodec } from '../helpers/store-codec';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import type { OpenedStream } from '../helpers/stream-chunk-source';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

// Each case loads thousands of chunks: under a second alone, several times that under the load of the whole suite.
vi.setConfig({ testTimeout: 60_000 });

const CHUNK = 65_536;
/** The keys a batch holds before it is read: half the combine's concurrency, as the engine sizes it. */
const half = (concurrency: number): number => Math.max(1, Math.ceil(concurrency / 2));
/**
 * The requests `n` held keys cost at the default concurrency (32): a batch of half that, in one range. A read adds a few
 * to it, for the batches of its first keys, which are read as soon as the keys are near the caller, before a half window
 * is held.
 */
const batchedAt32 = (n: number): number => Math.ceil(n / half(32));
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
  /** Bytes the range requests asked for, by segment name. */
  readonly bytes: Record<string, number>;
  /** The most range requests in flight at once, over all segments, since the last `reset`. */
  maxInFlight: number;
  /** Runs as each range request is made, with the segment it reads. */
  hook: ((name: string) => void | Promise<void>) | undefined;
  reset(): void;
  /** A store that has read nothing, over the counted storage. */
  cold(): CloudRoaring;
  load(name: string, ids: number[]): Promise<void>;
}

/** An in-memory backend whose range requests are counted by segment, with how many are in flight at once. */
function counted(delayMs = 0): Counted {
  const backend = new MemoryStorage();
  const ranges: Record<string, number> = {};
  const bytes: Record<string, number> = {};
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
    bytes[name] = (bytes[name] ?? 0) + (args[2] as number);
    inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, inFlight);
    try {
      await state.hook?.(name);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await value.apply(target, args);
    } finally {
      inFlight -= 1;
    }
  };
  const loader = new CloudRoaring({ storage: backend });
  const state: Counted = {
    ranges,
    bytes,
    maxInFlight: 0,
    hook: undefined,
    reset() {
      for (const k of Object.keys(ranges)) delete ranges[k];
      for (const k of Object.keys(bytes)) delete bytes[k];
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

  it('a ∩ b minus x, every key surviving: one request for half a window of keys, not one a key', async () => {
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
    // A batch holds half the concurrency (16 keys of 32) and the keys sit together: one request each. Each key was a
    // request before, for a consumer that takes one id at a time as for one that takes chunks (the intersectInto case).
    expect(w.ranges.x).toBeGreaterThanOrEqual(1);
    expect(w.ranges.x).toBeLessThanOrEqual(batchedAt32(1_000) + 3);
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
    expect(w.ranges.x).toBeLessThanOrEqual(batchedAt32(1_000) + 3);
    // y holds 334 of the 1,000 keys: a request each before.
    expect(w.ranges.y).toBeLessThanOrEqual(batchedAt32(334) + 3);
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
    expect(w.ranges.x).toBeLessThanOrEqual(batchedAt32(20) + 1);
  });

  it('intersectInto with an exclude batches it too', async () => {
    const w = await probe(every);
    const store = w.cold();
    w.reset();
    await store.segment('a').intersectInto(store.segment('d'), [store.segment('b')], {
      exclude: [store.segment('x')],
      allowEmpty: true,
    });
    expect(w.ranges.x).toBeLessThanOrEqual(batchedAt32(1_000) + 3);
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

/**
 * Seeds of the random-operands property below that reach the batcher. A run is a function of its seed alone, so the
 * count of runs the batcher decided is a fact about the generator, not about a random draw. Over a scan of seeds 1 to
 * 500 (the `ids` project) that count averaged 11 with a lowest of 5, against a floor of more than 2, which a random
 * draw can miss; these are the three seeds that gave 5, 5 and 6 (256, 446 and 56). If the generator changes and one
 * stops reaching the batcher, the test below names it: pick new seeds the same way.
 */
const SEEDS: readonly number[] = [256, 446, 56];

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

  /**
   * The property, over 60 cases drawn from `seed` (a random seed when none is given), returning how many of them the
   * batcher decided.
   */
  async function explore(seed?: number): Promise<number> {
    let batched = 0;
    await fc.assert(
      fc.asyncProperty(
        layout,
        fc.constantFrom(1, 250, 3_000),
        fc.constantFrom(1, 250, 3_000, 6_000),
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
          // A run the batcher decides: many survivors, their chunks together in the object, and still at most a
          // batch's request for each half window of them (the per-key read made `today`).
          const requests = w.ranges.x ?? 0;
          if (
            concurrency >= 4 &&
            today >= 8 &&
            requests > 0 &&
            requests <= Math.ceil(today / half(concurrency)) + 3
          ) {
            batched += 1;
          }
        },
      ),
      { numRuns: 60, ...(seed === undefined ? {} : { seed }) },
    );
    return batched;
  }

  it('equals the set arithmetic, and never makes more requests for the exclude than reading each key did', async () => {
    // A random draw reaches the batcher only by chance, so this run asserts no floor on how often it did: the
    // committed seeds below hold the floor, and this run keeps only the exploration for counterexamples.
    await explore();
  }, 120_000);

  it('reaches the batcher: every committed seed has runs it decided', async () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(3);
    for (const seed of SEEDS) {
      // The generator reaches the batcher: in some runs the requests were fewer than the keys.
      expect(await explore(seed), `seed ${seed}: the generator changed`).toBeGreaterThan(2);
    }
  }, 360_000);
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
    codec: storeCodec,
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
    expect(xRequests(storage)).toBeLessThanOrEqual(Math.ceil(KEYS.length / half(8)) + 1);
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
      codec: storeCodec,
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
    const engine = new SegmentEngine({ storage: plain, codec: storeCodec });
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

  it('lets the batches in flight drain: they are read to their end, and each ends itself', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    storage.beforeYield = async (stream, key) => {
      if (stream.segment === 'a' && key >= 2) await held;
    };
    const first = engine.intersect([ref('a'), ref('b')], WITH_X)[Symbol.asyncIterator]();
    await first.next();
    await first.return?.(undefined);
    open();
    await turns(20);
    // The one batch that was read finished and ended; nothing more was started after the stop.
    const xs = storage.opened.filter(isX);
    expect(xs).toHaveLength(1);
    for (const s of xs) expect(s.finished || s.closedEarly).toBe(true);
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

// ---------------------------------------------------------------------------------------------------------------------
// What the combine notices of an exclude that moves, and what it asks of the storage when several reads share one
// ---------------------------------------------------------------------------------------------------------------------

describe('an exclude that gains an id in a chunk it did not hold, while a read of it runs', () => {
  const NS = 'ns';
  const TTL = 10;
  const KEYS_60 = range(0, 60);
  const id = (chunk: number, low: number): number => chunk * CHUNK + low;

  /**
   * Whether the read serves the id the exclude gained at chunk `gained`: the read takes its first id, another store
   * publishes a generation of the exclude that also holds `id(gained, 1)`, its TTL lapses, and the read is gathered.
   * The exclude held chunks 0, 33 and 45, and every chunk is cached when the read begins.
   */
  async function servesGained(gained: number): Promise<boolean> {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const at = (segment: string, generation: number) => ({ namespace: NS, segment, generation });
    const included = KEYS_60.map((k) => id(k, 1));
    await bulkLoadCrbmGeneration(storage, at('a', 0), included, { registry });
    await bulkLoadCrbmGeneration(storage, at('b', 0), included, { registry });
    await bulkLoadCrbmGeneration(storage, at('c', 0), [id(0, 9), id(33, 9), id(45, 9)], {
      registry,
    });
    let now = 0;
    const clock: Clock & { advance(ms: number): void } = {
      now: () => now,
      sleep: async () => {},
      advance: (ms) => void (now += ms),
    };
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: TTL },
      seams: { clock },
    });
    const seg = (name: string) => store.segment(name, { namespace: NS });
    const combine = () => seg('a').intersect([seg('b')], { exclude: [seg('c')] });
    await collect(combine());
    const out: number[] = [];
    for await (const got of combine()) {
      out.push(got);
      if (out.length === 1) {
        await bulkLoadCrbmGeneration(
          storage,
          at('c', 1),
          [id(0, 9), id(gained, 1), id(33, 9), id(45, 9)],
          { registry },
        );
        clock.advance(TTL + 1);
      }
    }
    return out.includes(id(gained, 1));
  }

  // Main serves it for a gained chunk up to 9 and subtracts it from 10 on: the read meets the move at the exclude
  // chunk it reads ahead of the consumer (chunk 33), and batching must not make it later.
  const STALE_THROUGH = 9;

  it('serves the gained id for exactly the chunks the per-key read did, and subtracts it from the rest', async () => {
    const positions = KEYS_60.filter((k) => k >= 1 && k !== 33 && k !== 45 && k < 50);
    const stale: number[] = [];
    for (const k of positions) if (await servesGained(k)) stale.push(k);
    expect(stale).toEqual(positions.filter((k) => k <= STALE_THROUGH));
  });
});

describe('reads of one exclude chunk are shared, as reads of it one at a time were', () => {
  /** 25 survivors 40 keys apart in an exclude of 1,000 chunks of 8 KiB: each survivor's chunk is its own range. */
  async function spread() {
    const survivors = range(0, 25).map((j) => j * 40);
    const w = counted();
    await w.load('a', idsOf(range(0, 1_000)));
    await w.load('b', idsOf(survivors));
    await w.load('x', idsOf(range(0, 1_000), 4_096));
    return { w, survivors };
  }

  it.each([1, 2, 4, 8])(
    '%i identical intersects at once send no more requests for the exclude than one',
    async (k) => {
      const { w } = await spread();
      const store = w.cold();
      w.reset();
      const outs = await Promise.all(
        Array.from({ length: k }, () =>
          collect(
            store.segment('a').intersect([store.segment('b')], { exclude: [store.segment('x')] }),
          ),
        ),
      );
      for (const out of outs) expect(out).toEqual(outs[0]);
      // 25 before, whatever k: the other combines join the reads of the first.
      expect(w.ranges.x).toBeLessThanOrEqual(25);
    },
  );

  it('point reads of the survivors while the batches are in flight send no request of their own', async () => {
    const { w, survivors } = await spread();
    const store = w.cold();
    const seen = new Set<number>();
    let reads: Array<Promise<boolean>> = [];
    w.reset();
    // As the exclude's first range is asked for, a point read of each survivor's id in it.
    w.hook = (name) => {
      if (name !== 'x' || seen.size > 0) return;
      seen.add(1);
      reads = survivors.map((k) => store.segment('x').has(k * CHUNK + 1));
    };
    const got = await collect(
      store.segment('a').intersect([store.segment('b')], { exclude: [store.segment('x')] }),
    );
    await Promise.all(reads);
    expect(got.length).toBeGreaterThan(0);
    expect(w.ranges.x).toBeLessThanOrEqual(25);
  });

  it('an exclude named twice costs what naming it once does', async () => {
    const survivors = range(0, 1_000);
    const w = counted();
    await w.load('a', idsOf(survivors));
    await w.load('b', idsOf(survivors));
    await w.load('x', idsOf(survivors, 250, 1, true));
    const run = async (names: number) => {
      const store = w.cold();
      w.reset();
      const x = store.segment('x');
      const got = await collect(
        store
          .segment('a')
          .intersect([store.segment('b')], { exclude: Array.from({ length: names }, () => x) }),
      );
      return { got, x: w.ranges.x ?? 0 };
    };
    const once = await run(1);
    const twice = await run(2);
    expect(twice.got).toEqual(once.got);
    expect(twice.x).toBe(once.x);
    expect(once.x).toBeLessThanOrEqual(batchedAt32(1_000) + 3);
  });
});

describe('a batch is an open read', () => {
  it('a point read of a chunk a batch has in flight joins it', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    storage.beforeYield = async (stream) => {
      if (isX(stream)) await held;
    };
    const run = collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    await turns(3);
    const first = storage.opened.find(isX)!;
    expect(first).toBeDefined();
    // The chunks of the batch in flight are read by someone else too: they join, and send nothing.
    const reads = [...first.keys].map((k) => engine.has(ref('x'), joinId(k, 100)));
    await turns(3);
    expect(storage.singles.filter((k) => k.startsWith('x:'))).toEqual([]);
    open();
    expect(await Promise.all(reads)).toEqual([...first.keys].map(() => true));
    await run;
    expect(storage.singles.filter((k) => k.startsWith('x:'))).toEqual([]);
  });

  it('a second combine at once reads the chunks the first one is reading, not its own', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    const alone = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    await collect(alone.engine.intersect([ref('a'), ref('b')], WITH_X));
    await Promise.all([
      collect(engine.intersect([ref('a'), ref('b')], WITH_X)),
      collect(engine.intersect([ref('a'), ref('b')], WITH_X)),
    ]);
    expect(xKeysAsked(storage)).toEqual(KEYS);
  });
});

describe('when a batch is read', () => {
  it('holds no more than half the concurrency in keys', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    const sizes = storage.opened.filter(isX).map((o) => o.keys.length);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(half(8));
    expect(sizes.reduce((p, q) => p + q, 0)).toBe(KEYS.length);
  });

  it('reads the keys held once every key has been started, though no one waits on them', async () => {
    // Six keys of a combine of window 8: all are started at once. The consumer takes one id and stops asking.
    const six = range(0, 6);
    const { storage, engine } = setup({ a: ids(six), b: ids(six), x: otherIds(six) });
    const it = engine.intersect([ref('a'), ref('b')], WITH_X)[Symbol.asyncIterator]();
    await it.next();
    await turns(5);
    expect(xKeysAsked(storage)).toEqual(six);
    await it.return?.(undefined);
  });

  it('reads a far key once every key has been started, though the caller is working and not near it', async () => {
    // 30 keys: after 5 slots are taken the window of 32 has started them all. Key 25 is 20 slots on from the caller,
    // further than half a window, and the caller is neither waiting nor near, but no key is left to ask.
    const thirty = range(0, 30);
    const { storage, engine } = setup({ a: ids(thirty), b: ids(thirty), x: otherIds([25]) });
    const batches = engine.intersectBatches([ref('a'), ref('b')], {
      exclude: [ref('x')],
      concurrency: 32,
    });
    const it = batches[Symbol.asyncIterator]();
    for (let i = 0; i < 5; i++) await it.next();
    await turns(10);
    expect(xKeysAsked(storage)).toEqual([25]);
    await it.return?.(undefined);
  });

  it('does not keep a caller waiting on a key it holds for keys that are not started', async () => {
    // The first two keys land; the window is not full of started keys and the keys held are under half a window.
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    storage.beforeYield = async (stream, key) => {
      if (stream.segment === 'a' && key >= 2) await held;
    };
    const combine = engine.intersect([ref('a'), ref('b')], {
      exclude: [ref('x')],
      concurrency: 32,
    });
    const it = combine[Symbol.asyncIterator]();
    const first = await it.next(); // would never settle if the batch waited for half of 32 keys
    expect(first.done).toBe(false);
    open();
    await it.return?.(undefined);
  });
});

describe('a batch that fails, in a later batch', () => {
  it('serves the ids of every key before the failed batch, and raises from the first key it owed', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    const boom = new Error('second batch');
    storage.beforeYield = (stream, key) => {
      if (isX(stream) && key === 20) throw boom;
    };
    const got: number[] = [];
    const run = async (): Promise<void> => {
      for await (const id of engine.intersect([ref('a'), ref('b')], {
        ...WITH_X,
        concurrency: 4,
      })) {
        got.push(id);
      }
    };
    await expect(run()).rejects.toBe(boom);
    // Chunks 0 to 19 were answered by earlier batches or by keys of the failing one before key 20.
    expect(got).toEqual(minusPartial(range(0, 20)));
    expect(storage.opened.filter(isX).length).toBeGreaterThan(2);
  });
});

/**
 * A source whose stream, when closed, drops the reads it has pending at once (each pending `next()` settles done, or
 * rejects with an abort), as one built on an abort controller does: the port allows it of a stream that is stopped. Reads
 * of a gated segment wait for `release()`.
 */
class CancellingSource extends MemoryStorageChunkSource {
  mode: 'done' | 'reject' = 'done';
  gated = new Set<string>();
  streams: Array<{ segment: string; keys: readonly number[]; dropped: number }> = [];
  private open: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));

  release(): void {
    this.open();
  }

  currentVersion(): Promise<string | null> {
    return Promise.resolve('v1');
  }

  getChunks(ref: SegmentRef, keys: readonly number[]): AsyncIterable<ChunkRead> {
    const rec = { segment: ref.segment, keys, dropped: 0 };
    this.streams.push(rec);
    let next = 0;
    let stopped = false;
    type Pending = {
      resolve: (r: IteratorResult<ChunkRead>) => void;
      reject: (e: unknown) => void;
    };
    const pending = new Set<Pending>();
    const read = async (key: number, entry: Pending): Promise<void> => {
      if (this.gated.has(ref.segment)) await this.gate;
      const bytes = await MemoryStorageChunkSource.prototype.getChunk.call(this, {
        ...ref,
        chunkKey: key,
      });
      if (pending.delete(entry))
        entry.resolve({ done: false, value: { key, bytes, version: 'v1' } });
    };
    const iterator: AsyncIterableIterator<ChunkRead> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => {
        if (stopped || next >= keys.length)
          return Promise.resolve({ done: true, value: undefined });
        const key = keys[next++]!;
        return new Promise<IteratorResult<ChunkRead>>((resolve, reject) => {
          const entry: Pending = { resolve, reject };
          pending.add(entry);
          void read(key, entry);
        });
      },
      return: () => {
        stopped = true;
        for (const entry of pending) {
          rec.dropped += 1;
          if (this.mode === 'done') entry.resolve({ done: true, value: undefined });
          else entry.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
        pending.clear();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return iterator;
  }
}

describe('a call that stops leaves the reads another call joined to finish', () => {
  async function joined(mode: 'done' | 'reject', joiner: 'combine' | 'has') {
    const storage = new CancellingSource();
    storage.mode = mode;
    for (const name of ['a', 'b']) seedSegment(storage, name, ids(KEYS));
    // Key 0 holds no exclude chunk, so the first call has its first id without one; the rest wait on x.
    seedSegment(
      storage,
      'x',
      range(1, 40).map((k) => joinId(k, 1)),
    );
    const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 10_000, clock });
    const engine = new SegmentEngine({ storage, codec: storeCodec, cache });
    storage.gated.add('x');
    const first = engine.intersect([ref('a'), ref('b')], WITH_X)[Symbol.asyncIterator]();
    await first.next();
    await turns(20);
    const streamsBefore = storage.streams.filter((s) => s.segment === 'x').length;
    const other =
      joiner === 'combine'
        ? collect(engine.intersect([ref('a'), ref('b')], WITH_X))
        : Promise.all([1, 2, 3, 4].map((k) => engine.has(ref('x'), joinId(k, 1))));
    await turns(20);
    await first.return?.(undefined);
    await turns(5);
    storage.release();
    const result = await other;
    const expected =
      joiner === 'combine'
        ? KEYS.flatMap((k) => (k === 0 ? [1, 2, 3] : [2, 3]).map((i) => joinId(k, i)))
        : [true, true, true, true];
    return { result, expected, storage, streamsBefore };
  }

  it.each([
    ['done', 'combine'],
    ['done', 'has'],
    ['reject', 'combine'],
    ['reject', 'has'],
  ] as const)(
    'a source that drops its pending reads when stopped (%s), joiner a %s: the joiner is answered',
    async (mode, joiner) => {
      const { result, expected, storage, streamsBefore } = await joined(mode, joiner);
      expect(result).toEqual(expected);
      // Nothing was dropped: the stopped call did not close the streams that were in flight, and sent nothing more
      // for the keys it was still working on (the joiner's own call has its own).
      expect(storage.streams.reduce((n, s) => n + s.dropped, 0)).toBe(0);
      if (joiner === 'has') {
        expect(storage.streams.filter((s) => s.segment === 'x')).toHaveLength(streamsBefore);
      }
    },
  );
});

describe('a read joined to a batch read does not fail with a failure that is not its own', () => {
  it('reads the chunk on its own when the batch fails before its key, one request for each such key', async () => {
    const { storage, engine, metrics } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds(KEYS) });
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    const boom = new Error('one range failed');
    let first = true;
    storage.beforeYield = async (stream, key) => {
      if (!isX(stream)) return;
      await held;
      if (key === 2 && first) {
        first = false;
        throw boom;
      }
    };
    const run = collect(engine.intersect([ref('a'), ref('b')], { ...WITH_X, concurrency: 16 }));
    run.catch(() => undefined);
    await turns(5);
    const batch = storage.opened.find(isX)!;
    const later = [...batch.keys].filter((k) => k > 2);
    expect(later.length).toBeGreaterThan(1);
    // Reads of the chunks after the failing one join the batch's reads.
    const reads = later.map((k) => engine.has(ref('x'), joinId(k, 100)));
    await turns(3);
    expect(storage.singles.filter((k) => k.startsWith('x:'))).toEqual([]);
    open();
    expect(await Promise.all(reads)).toEqual(later.map(() => true));
    await expect(run).rejects.toBe(boom);
    // Each chunk a stream asked for is one cache miss, and each joined read one more of its own; the reads the joiners
    // make on their own after the failure are the same chunks again, and count nothing.
    const asked = storage.opened.reduce((n, o) => n + o.keys.length, 0);
    expect(metrics.snapshot().cache.misses).toBe(asked + later.length);
    // One read of its own for each joined key whose take failed, and no more.
    expect(storage.singles.filter((k) => k.startsWith('x:')).length).toBeLessThanOrEqual(
      later.length,
    );
  });
});

describe('what a batch counts', () => {
  it('names no key twice in a stream when an exclude is named twice', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    const got = await collect(
      engine.intersect([ref('a'), ref('b')], { exclude: [ref('x'), ref('x')], concurrency: 8 }),
    );
    expect(got).toEqual(minusPartial(KEYS));
    for (const stream of storage.opened.filter(isX)) {
      expect(new Set(stream.keys).size).toBe(stream.keys.length);
    }
    expect(xKeysAsked(storage)).toEqual(KEYS);
  });

  it('reads only the chunks the cache lacks, a request at most for each', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    // Three chunks in four are cached; only the 10 left are asked for, and each costs at most one request.
    for (const k of KEYS.filter((k) => k % 4 !== 0)) await engine.has(ref('x'), joinId(k, 1));
    storage.opened.length = 0;
    storage.singles.length = 0;
    await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    const keys = xKeysAsked(storage);
    expect(keys).toEqual(KEYS.filter((k) => k % 4 === 0));
    expect(xRequests(storage)).toBeLessThanOrEqual(keys.length);
  });
});

describe('a key held for a batch is read ahead of the caller', () => {
  it.each([
    [5, true],
    [6, false],
  ])(
    'a key %i slots on from where a caller that is not waiting stands is read now: %s (half of a window of 8 is 4)',
    async (heldKey, asked) => {
      // x holds one chunk. The caller takes its first id (key 0) and stops; the include chunks of keys 5 and on land
      // after that, so the key asks while the caller is at slot 1 and is not waiting on anything.
      const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: otherIds([heldKey]) });
      let open: () => void = () => {};
      const held = new Promise<void>((resolve) => (open = resolve));
      storage.beforeYield = async (stream, key) => {
        if (stream.segment === 'a' && key >= 5) await held;
      };
      const it = engine.intersect([ref('a'), ref('b')], WITH_X)[Symbol.asyncIterator]();
      await it.next();
      open();
      await turns(10);
      expect(xKeysAsked(storage)).toEqual(asked ? [heldKey] : []);
      await it.return?.(undefined);
    },
  );

  it('reads a far key while the caller waits on a slot whose own read is in flight', async () => {
    // The caller has taken 5 slots (a window of 32 is open, so key 30 is started) and waits on slot 5, whose exclude
    // chunk is in flight; key 30 asks 25 slots on, which is further than half a window.
    const { storage, engine } = setup({
      a: ids(KEYS),
      b: ids(KEYS),
      x: otherIds([5, 30]),
    });
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => (open = resolve));
    storage.beforeYield = async (stream) => {
      if (isX(stream)) await held;
    };
    const batches = engine.intersectBatches([ref('a'), ref('b')], {
      exclude: [ref('x')],
      concurrency: 32,
    });
    const it = batches[Symbol.asyncIterator]();
    for (let i = 0; i < 5; i++) await it.next();
    const waiting = it.next();
    await turns(10);
    expect(storage.opened.filter(isX).map((o) => [...o.keys])).toEqual([[5], [30]]);
    open();
    await waiting;
    await it.return?.(undefined);
  });
});

describe('survivors spread thinly through a dense exclude: fewer requests, more bytes', () => {
  // The layout the docs state: an exclude of 1,000 chunks of 4,096 ids (8 KiB each) and a survivor every 31st key.
  it('reads a batch as parts of the same ranges, as the guide says: 8 to 10 requests, at least 20 times the bytes', async () => {
    const survivors = range(0, 32).map((j) => j * 31);
    const w = counted();
    await w.load('a', idsOf(survivors));
    await w.load('b', idsOf(survivors));
    await w.load('x', idsOf(range(0, 1_000), 4_096));

    // What reading each survivor's chunk on its own cost: a request for each, and the bytes of each chunk.
    const alone = w.cold();
    await alone.segment('x').has(15 * CHUNK + 1); // opens the object through a chunk that is no survivor's
    w.reset();
    for (const k of survivors) await alone.segment('x').has(k * CHUNK + 1);
    expect(w.ranges.x).toBe(survivors.length);
    const perKeyBytes = w.bytes.x!;
    expect(perKeyBytes).toBeGreaterThan(survivors.length * 8_000);

    const store = w.cold();
    w.reset();
    await collect(
      store.segment('a').intersect([store.segment('b')], { exclude: [store.segment('x')] }),
    );
    // The figures in docs/guide/cost.md and the changelog: 8 to 10 requests, about 5.7 to 6.2 MB, where it was 32 and 262,656.
    expect(w.ranges.x).toBeGreaterThanOrEqual(8);
    expect(w.ranges.x).toBeLessThanOrEqual(10);
    expect(w.bytes.x!).toBeGreaterThanOrEqual(20 * perKeyBytes);
    expect(w.bytes.x!).toBeGreaterThanOrEqual(5_600_000);
    expect(w.bytes.x!).toBeLessThanOrEqual(6_300_000);
    expect(perKeyBytes).toBe(262_656);
  });
});

describe('what a batch counts as held', () => {
  it('counts only the chunks that would be requested, not those the cache holds', async () => {
    const { storage, engine } = setup({ a: ids(KEYS), b: ids(KEYS), x: partial(KEYS) });
    // Every other chunk is cached: 20 are read, in batches of up to half the concurrency (4).
    for (const k of KEYS.filter((k) => k % 2 === 1)) await engine.has(ref('x'), joinId(k, 1));
    storage.opened.length = 0;
    storage.singles.length = 0;
    await collect(engine.intersect([ref('a'), ref('b')], WITH_X));
    const keys = xKeysAsked(storage);
    expect(keys).toEqual(KEYS.filter((k) => k % 2 === 0));
    // 20 keys at 4 a batch is 5 streams; hits counted toward a batch would make it read at 2 keys (10 streams).
    expect(storage.opened.filter(isX).length).toBeLessThanOrEqual(
      Math.ceil(keys.length / half(8)) + 1,
    );
  });
});
