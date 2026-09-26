import {
  MemoryStorage,
  CloudRoaring,
  createBackend,
  CrbmStorageChunkSource,
  NotFoundError,
  TransientError,
  ValidationError,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
  setSegmentRetention,
} from '@/index';
import type { CacheOptions, Clock, IMetricsSink, Segment, SegmentRef } from '@/index';
import { SegmentEngine } from '@/core/engine';
import { segmentKey } from '@/core/keys';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import type { PinnedAt } from '@/core/pinned-storage-source';
import { BoundedLru } from '@/core/lru';
import { roaringCodec } from '@/roaring-codec';

/**
 * A pinned handle must only ever be handed chunks of the generation it pinned.
 *
 * `SegmentEngine` resolves a segment's version once per op (`cacheVersion`) and caches every chunk the op
 * fetches under that version. `CrbmStorageChunkSource.getChunk` does not serve "that version", though: it reads
 * through the live snapshot memo, which can move to a newer generation after the op resolved — when
 * `cache.genTtlMs` lapses after a publish, when the reader cache evicts the segment and the next read resolves it
 * afresh, or when the generation the op was reading is swept and the read heals forward. Invariant 3 accepts that
 * the live call itself may then describe two instants. What it does not allow is the consequence one layer down:
 * the newer generation's chunk lands in the cache under the OLDER generation's key.
 *
 * A pinned handle held at that older generation reads the same cache under the same key — a pin reports the
 * version it captured, and a live snapshot of the same generation of the same row reports the same string — so
 * it is handed the newer generation's chunk. The one handle that exists to describe a single instant then mixes
 * two: some chunks from the generation it pinned and some from the next, while its `count()`, served from the
 * pinned generation's index rather than from the cache, still reports the pinned total.
 *
 * So a pin keys its chunks in a space of its own (`PinnedStorageChunkSource.currentVersion`), which no live read
 * writes, and fills it only from its own generation. The live entry may still hold the newer chunk under the
 * older version, which is harmless: later live reads resolve the newer version and never look it up. Nothing on
 * the live path checks anything after a fetch, so a live read makes no call for the pin's safety. The pin's entries
 * do share the cache's bound with the live ones, so under a small `cache.maxChunks` each can evict the other.
 *
 * Every case but the sweep ends with the same check: dropping the store's derived state (`invalidate`) leaves the
 * pin reading correctly, since the bytes in the bucket were never wrong — only the cache entry was.
 */
const REF: SegmentRef = { segment: 's' };
const TTL = 10;
const C = 65_536; // ids per chunk: `C + r` lives in chunk 1, `2 * C + r` in chunk 2

// The two generations differ in EVERY chunk, so a chunk read from the wrong one cannot hide.
const GEN0 = [1, 2, 3, C + 10, C + 11, 2 * C + 30, 2 * C + 31];
const GEN1 = [1, 2, 3, 4, C + 20, C + 21, C + 22, 2 * C + 40, 2 * C + 41, 2 * C + 42];

/** What a handle pinned at generation 0 must report, however the rest of the store has moved. */
const PINNED_AT_GEN0 = { count: GEN0.length, ids: GEN0, hasGen0Id: true, hasGen1Id: false };

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** Everything a pinned handle says about its segment. Both probes sit in chunk 2, which every case poisons. */
async function observe(snap: Segment): Promise<typeof PINNED_AT_GEN0> {
  return {
    count: await snap.count(),
    ids: await collect(snap.iterate()),
    hasGen0Id: await snap.has(2 * C + 30), // only generation 0 holds it
    hasGen1Id: await snap.has(2 * C + 40), // only generation 1 holds it
  };
}

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return {
    now: () => t,
    sleep: async () => {},
    advance: (ms) => {
      t += ms;
    },
  };
}

async function world(options: { cache?: CacheOptions; metrics?: IMetricsSink } = {}) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, GEN0, { registry });
  const clock = manualClock();
  const store = new CloudRoaring({
    storage: backend,
    cache: options.cache,
    metrics: options.metrics,
    seams: { clock },
  });
  /** Another process publishes generation 1 into the shared bucket. Nothing on `store` is told. */
  const publishGen1 = async (): Promise<void> => {
    const r = await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, GEN1, { registry });
    expect(r.becameCurrent).toBe(true);
  };
  return { storage, registry, clock, store, publishGen1 };
}

/** The pinned handle's view, before and after the store drops its derived state for the segment. */
async function pinnedViews(
  store: CloudRoaring,
  snap: Segment,
): Promise<{ pinned: typeof PINNED_AT_GEN0; afterInvalidate: typeof PINNED_AT_GEN0 }> {
  const pinned = await observe(snap);
  store.invalidate(REF); // drops decoded chunks and readers; the bucket is untouched
  const afterInvalidate = await observe(snap);
  return { pinned, afterInvalidate };
}

/** A backend holding `s` at generation 0, and a way to purge the name and load it again from outside the store. */
async function purgeable(ids: number[]) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, ids, { registry });
  await bulkLoadCrbmGeneration(storage, { segment: 'other', generation: 0 }, [7], { registry });
  const reload = async (next: number[]): Promise<void> => {
    for await (const key of storage.list(REF)) await storage.delete(key);
    await registry.delete(REF);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, next, { registry });
  };
  return { backend, reload };
}

describe('a pin is never handed a chunk a live read fetched across a change of generation', () => {
  it('iterate: a live read straddling a publish and cache.genTtlMs does not hand the pin generation 1 chunks', async () => {
    const w = await world({ cache: { genTtlMs: TTL } });
    const snap = await w.store.segment('s').pin(); // generation 0: the instant this handle must describe

    // A long live read on the same store. After its first id, another process publishes generation 1 and the
    // TTL lapses, so the read's later chunks come from generation 1 — the accepted edge of invariant 3.
    const live: number[] = [];
    for await (const id of w.store.segment('s').iterate()) {
      live.push(id);
      if (live.length === 1) {
        await w.publishGen1();
        w.clock.advance(TTL);
      }
    }
    expect(live).toEqual([1, 2, 3, C + 20, C + 21, C + 22, 2 * C + 40, 2 * C + 41, 2 * C + 42]);

    expect(await pinnedViews(w.store, snap)).toEqual({
      pinned: PINNED_AT_GEN0,
      afterInvalidate: PINNED_AT_GEN0,
    });
  });

  it('iterate: nor does a reader-cache eviction, with no TTL at all (cache.genTtlMs: 0)', async () => {
    const w = await world({ cache: { genTtlMs: 0, readerMax: 1 } });
    await bulkLoadCrbmGeneration(w.storage, { segment: 'other', generation: 0 }, [7], {
      registry: w.registry,
    });
    const snap = await w.store.segment('s').pin();

    const live: number[] = [];
    for await (const id of w.store.segment('s').iterate()) {
      live.push(id);
      if (live.length === 1) {
        await w.publishGen1();
        // Reading any other segment opens a second reader, and `readerMax: 1` evicts this one. The next chunk
        // re-opens the segment from a fresh resolve — generation 1 — though this call resolved generation 0.
        expect(await w.store.segment('other').has(7)).toBe(true);
      }
    }
    expect(live).toEqual([1, 2, 3, C + 20, C + 21, C + 22, 2 * C + 40, 2 * C + 41, 2 * C + 42]);

    expect(await pinnedViews(w.store, snap)).toEqual({
      pinned: PINNED_AT_GEN0,
      afterInvalidate: PINNED_AT_GEN0,
    });
  });

  it("iterate: nor does the store's own load, whose invalidation re-resolves the read (cache.genTtlMs: 0)", async () => {
    const w = await world({ cache: { genTtlMs: 0 } });
    const snap = await w.store.segment('s').pin();

    const live: number[] = [];
    for await (const id of w.store.segment('s').iterate()) {
      live.push(id);
      if (live.length === 1) {
        // A load on this same store publishes generation 1 and invalidates the segment, so the read's next chunk
        // re-resolves — with no TTL and no eviction — to a generation this call did not begin on.
        await w.store.load(REF, GEN1);
      }
    }
    expect(live).toEqual([1, 2, 3, C + 20, C + 21, C + 22, 2 * C + 40, 2 * C + 41, 2 * C + 42]);

    expect(await pinnedViews(w.store, snap)).toEqual({
      pinned: PINNED_AT_GEN0,
      afterInvalidate: PINNED_AT_GEN0,
    });
  });

  it('intersect: nor does a live combine straddling a publish and the TTL', async () => {
    const w = await world({ cache: { genTtlMs: TTL } });
    // A superset of both generations, so the intersection is exactly whatever `s` was served.
    const everyId = [...GEN0, ...GEN1];
    await bulkLoadCrbmGeneration(w.storage, { segment: 'other', generation: 0 }, everyId, {
      registry: w.registry,
    });
    const snap = await w.store.segment('s').pin();

    // `concurrency: 1` for a readable schedule: the combine starts the NEXT key's fetch before it yields the
    // current key's ids, so the first fetch to start after the boundary is chunk 2. With the default window of
    // 8 the mechanism is the same; the first poisoned key is just further along.
    const live: number[] = [];
    const other = w.store.segment('other');
    for await (const id of w.store.segment('s').intersect([other], { concurrency: 1 })) {
      live.push(id);
      if (live.length === 1) {
        await w.publishGen1();
        w.clock.advance(TTL);
      }
    }
    expect(live).toEqual([1, 2, 3, C + 10, C + 11, 2 * C + 40, 2 * C + 41, 2 * C + 42]);

    expect(await pinnedViews(w.store, snap)).toEqual({
      pinned: PINNED_AT_GEN0,
      afterInvalidate: PINNED_AT_GEN0,
    });
  });

  it('has: nor a one-chunk read whose TTL boundary falls between its resolve and its fetch', async () => {
    let atMiss: (() => void) | undefined;
    const metrics: IMetricsSink = {
      onEvent(event) {
        // The engine reports a cache miss after resolving the op's version and immediately before the fetch:
        // the one point between the two where a test can let time pass. In production, time passes on its own.
        if (event.kind === 'cache' && !event.hit && atMiss !== undefined) {
          const fire = atMiss;
          atMiss = undefined;
          fire();
        }
      },
    };
    const w = await world({ cache: { genTtlMs: TTL }, metrics });
    const snap = await w.store.segment('s').pin();
    expect(await w.store.segment('s').has(1)).toBe(true); // opens the live snapshot at generation 0
    await w.publishGen1(); // inside the TTL, so the store still (correctly) resolves generation 0

    atMiss = () => w.clock.advance(TTL);
    // Resolves generation 0's version; the boundary passes; the one fetch is then served by generation 1.
    expect(await w.store.segment('s').has(2 * C + 40)).toBe(true);

    expect(await pinnedViews(w.store, snap)).toEqual({
      pinned: PINNED_AT_GEN0,
      afterInvalidate: PINNED_AT_GEN0,
    });
  });

  it('a generation swept mid-call heals the live read forward, and the pin fails rather than answer from the next', async () => {
    const w = await world({ cache: { genTtlMs: 0 } }); // no TTL involved
    const snap = await w.store.segment('s').pin();

    const live: number[] = [];
    for await (const id of w.store.segment('s').iterate()) {
      live.push(id);
      if (live.length === 1) {
        await w.publishGen1();
        // `keep: 0`, as every id erasure passes: generation 0 is physically gone, so the live read's next fetch
        // misses and the storage source heals forward to generation 1 — the documented re-read.
        const swept = await gcOrphanGenerations(
          REF,
          { storage: w.storage, registry: w.registry },
          { keep: 0 },
        );
        expect(swept).toEqual([0]);
      }
    }
    expect(live).toEqual([1, 2, 3, C + 20, C + 21, C + 22, 2 * C + 40, 2 * C + 41, 2 * C + 42]);

    // A pin whose generation has been swept must FAIL: it is a hold, not a lease, and it never heals forward,
    // because silently serving a different generation is the one thing a pin exists to prevent. Its count still
    // answers, from the index `pin()` read, and it is the pinned generation's own total; every chunk read fails.
    const settle = (p: Promise<unknown>): Promise<unknown> =>
      p.then(
        (v) => v,
        (e: unknown) => (e instanceof NotFoundError ? 'NotFoundError' : String(e)),
      );
    // Every chunk the live read fetched after the sweep is probed, chunk 1 as well as chunk 2.
    expect({
      count: await settle(snap.count()),
      chunk1Gen0Id: await settle(snap.has(C + 10)),
      chunk1Gen1Id: await settle(snap.has(C + 20)),
      hasGen0Id: await settle(snap.has(2 * C + 30)),
      hasGen1Id: await settle(snap.has(2 * C + 40)),
    }).toEqual({
      count: GEN0.length,
      chunk1Gen0Id: 'NotFoundError',
      chunk1Gen1Id: 'NotFoundError',
      hasGen0Id: 'NotFoundError',
      hasGen1Id: 'NotFoundError',
    });
  });
});

describe('a pin keeps entries of its own, and no other read pays for them', () => {
  /** A source that records the name of every method the engine calls on it, in order. */
  function recording(inner: CrbmStorageChunkSource): {
    source: CrbmStorageChunkSource;
    calls: string[];
  } {
    const calls: string[] = [];
    const source = new Proxy(inner, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { source, calls };
  }

  /** A cold read of every id in `s`, on a fresh source over one bucket, with or without a chunk cache. */
  async function coldReadCalls(withCache: boolean): Promise<string[]> {
    const { storage, registry } = new MemoryStorage();
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, GEN0, { registry });
    const { source, calls } = recording(new CrbmStorageChunkSource(storage, { registry }));
    const engine = new SegmentEngine({
      storage: source,
      codec: roaringCodec,
      ...(withCache
        ? { cache: new BoundedLru<string, never>({ maxEntries: 64, clock: { now: () => 0 } }) }
        : {}),
    });
    const ids: number[] = [];
    for await (const id of engine.iterate(REF)) ids.push(id);
    expect(ids).toEqual(GEN0);
    return calls;
  }

  it('a live read makes the same calls on its source with a chunk cache as without one', async () => {
    // Deciding whether to cache a fetched chunk costs no call at all — in particular no re-resolve, which, for a
    // segment the reader cache evicted mid-read, would be a registry read and a reopen.
    // Spelled out, so a call added after a fetch fails here whether or not it depends on the cache: the shape,
    // the version the op keys by, then one fetch for each chunk.
    const withCache = await coldReadCalls(true);
    expect(withCache).toEqual([
      'listChunkKeys',
      'currentVersion',
      'getChunk',
      'getChunk',
      'getChunk',
    ]);
    expect(await coldReadCalls(false)).toEqual(withCache);
  });

  it("costs a pin one GET for a chunk a live read of its version cached, and hands it the pin's own bytes", async () => {
    const w = await world({ cache: { genTtlMs: TTL } });
    const live = w.store.segment('s');
    const snap = await live.pin();
    // Both readers open first, the pin's by its own index read, so what is counted below is chunk reads alone.
    expect(await live.count()).toBe(GEN0.length);
    expect(await snap.count()).toBe(GEN0.length);
    let reads = 0;
    const [range, tail] = [w.storage.getRange.bind(w.storage), w.storage.getTail.bind(w.storage)];
    w.storage.getRange = (key, offset, length) => {
      reads += 1;
      return range(key, offset, length);
    };
    w.storage.getTail = (key, max) => {
      reads += 1;
      return tail(key, max);
    };

    expect(await live.has(2 * C + 30)).toBe(true); // the live read caches chunk 2 at generation 0's version
    const afterLive = reads;
    expect(await snap.has(2 * C + 30)).toBe(true); // the pin's own entry: one GET for the chunk
    expect(reads).toBe(afterLive + 1);
    expect(await snap.has(2 * C + 31)).toBe(true); // and a hit after that
    expect(await live.has(2 * C + 31)).toBe(true); // as the live read's entry still is
    expect(reads).toBe(afterLive + 1);
  });
});

describe('a pin across incarnations, a segment held twice, and a transient fault', () => {
  it('two pins of generation 0 in two incarnations of a name never share a cached chunk', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await bulkLoadCrbmGeneration(storage, { segment: 'other', generation: 0 }, [7], { registry });
    const store = new CloudRoaring({ storage: backend, cache: { readerMax: 1 } });
    expect(await (await store.segment('s').pin()).has(1)).toBe(true); // caches chunk 0 under the first pin
    // The name is purged and loaded again, starting again at generation 0, beside the store.
    for await (const key of storage.list(REF)) await storage.delete(key);
    await registry.delete(REF);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [9], { registry });
    expect(await store.segment('other').has(7)).toBe(true); // evicts the first pin's reader
    const second = await store.segment('s').pin();
    expect([await second.has(1), await second.has(9)]).toEqual([false, true]);
  });

  it('refuses a combine that holds one segment at two generations, rather than answer for one of them', async () => {
    const w = await world({ cache: { genTtlMs: TTL } });
    const live = w.store.segment('s');
    const snap0 = await live.pin();
    await w.publishGen1();
    w.clock.advance(TTL);
    const snap1 = await live.pin();
    // Refused when the combine is read, as its other errors are; each call here reads it, so each rejects.
    for (const call of [
      async () => collect(snap0.andNot([snap1])),
      async () => collect(snap0.intersect([snap1])),
      async () => collect(live.andNot([snap0])),
    ]) {
      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow(/in this combine twice/);
    }
    // The same pin twice is one generation, and fine.
    expect(await collect(snap0.intersect([snap0]))).toEqual(GEN0);
  });

  it("retries a pinned read's transient fault, as it would a live one's", async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(GEN0.length); // the pinned reader is open
    let faults = 1;
    const range = w.storage.getRange.bind(w.storage);
    w.storage.getRange = (key, offset, length) => {
      if (faults > 0) {
        faults -= 1;
        return Promise.reject(new TransientError('storage blip'));
      }
      return range(key, offset, length);
    };
    expect(await snap.has(2 * C + 30)).toBe(true);
    expect(faults).toBe(0);
  });

  it('pins, and opens the pinned generation, on one read of the registry row', async () => {
    const w = await world({ cache: { readerMax: 1 } });
    await bulkLoadCrbmGeneration(w.storage, { segment: 'other', generation: 0 }, [7], {
      registry: w.registry,
    });
    let gets = 0;
    const get = w.registry.get.bind(w.registry);
    w.registry.get = (ref) => {
      gets += 1;
      return get(ref);
    };
    const snap = await w.store.segment('s').pin(); // resolves the row, and opens the generation from it
    expect(await snap.count()).toBe(GEN0.length); // served by the reader pin() opened
    expect(gets).toBe(1);
    expect(await w.store.segment('other').has(7)).toBe(true); // evicts the pin's reader
    gets = 0;
    expect(await snap.count()).toBe(GEN0.length); // a reopen: one read of the row
    expect(gets).toBe(1);
  });

  it('a pin whose segment was purged and loaded again fails, rather than read the new one beside the old', async () => {
    const OLD = [1, 2, C + 1, C + 2, 2 * C + 1];
    const NEW = [1, 2, 3, C + 5, C + 6, C + 7, 2 * C + 5];
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend, cache: { readerMax: 1 } });
    const snap = await store.segment('s').pin();
    expect(await snap.has(1)).toBe(true); // caches chunk 0 of the old segment under the pin
    await w.reload(NEW);
    expect(await store.segment('other').has(7)).toBe(true); // evicts the pin's reader
    // Its reopen finds another object at generation 0, and says so, for the shape and for every uncached chunk.
    await expect(snap.count()).rejects.toThrow(NotFoundError);
    await expect(collect(snap.iterate())).rejects.toThrow(
      /no longer the object this handle pinned/,
    );
    await expect(snap.has(C + 1)).rejects.toThrow(NotFoundError);
    // A new pin holds the new segment, and reads it whole.
    expect(await collect((await store.segment('s').pin()).iterate())).toEqual(NEW);
  });

  it('two pins of one generation in two incarnations never share a reader, even with no eviction between', async () => {
    const w = await purgeable([1, 2, 3]);
    const store = new CloudRoaring({ storage: w.backend });
    const first = await store.segment('s').pin();
    expect(await first.count()).toBe(3);
    await w.reload([9]);
    const second = await store.segment('s').pin();
    expect([await second.count(), await second.has(9), await second.has(1)]).toEqual([
      1,
      true,
      false,
    ]);
  });

  it('combines two pins of one object taken either side of a write that moved the row, and refuses two incarnations', async () => {
    const w = await purgeable([1, 2, 3]);
    const store = new CloudRoaring({ storage: w.backend });
    const before = await store.segment('s').pin();
    await setSegmentRetention(
      REF,
      { registry: w.backend.registry },
      { expiresAt: Date.now() + 86_400_000 },
    );
    const after = await store.segment('s').pin(); // the same generation and object, under a new row token
    expect(await collect(before.intersect([after]))).toEqual([1, 2, 3]);
    await w.reload([9]);
    const other = await store.segment('s').pin();
    await expect(collect(before.union([other]))).rejects.toThrow(
      /pinned twice at generation 0, as two different objects/,
    );
  });

  it('refuses when the combine is read, not when it is made, as its other arguments are', async () => {
    const w = await world({ cache: { genTtlMs: TTL } });
    const snap0 = await w.store.segment('s').pin();
    await w.publishGen1();
    w.clock.advance(TTL);
    const snap1 = await w.store.segment('s').pin();
    const refused = snap0.andNot([snap1]); // no throw here
    await expect(collect(refused)).rejects.toThrow(ValidationError);
    const intersected = snap0.intersect([snap1]); // nor here
    await expect(collect(intersected)).rejects.toThrow(ValidationError);
    // Nothing is written by a materialisation whose combine is refused.
    const dest = w.store.segment('dest');
    await expect(snap0.intersectInto(dest, [snap1])).rejects.toThrow(ValidationError);
    expect(await dest.count()).toBe(0);
  });

  it.each([
    ['without a fingerprint', {}],
    ['with a null one', { fingerprint: null }],
  ])('reads through a pin built by hand %s, checked by version alone', async (_how, extra) => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, GEN0, { registry });
    const crbm = new CrbmStorageChunkSource(storage, { registry });
    // Typed without a `fingerprint`: if the field became required again, this file would stop compiling.
    const pin: PinnedAt = { generation: 0, version: await crbm.currentVersion(REF), ...extra };
    const engine = new SegmentEngine({
      storage: new PinnedStorageChunkSource(crbm, new Map([[segmentKey(REF), pin]])),
      codec: roaringCodec,
    });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, GEN1, { registry });

    expect(await engine.count(REF)).toBe(GEN0.length);
    expect(await collect(engine.iterate(REF))).toEqual(GEN0);
  });

  it("retries pin()'s own read of the row, as the store's reads are retried", async () => {
    const w = await world();
    let faults = 1;
    const get = w.registry.get.bind(w.registry);
    w.registry.get = (ref) => {
      if (faults > 0) {
        faults -= 1;
        return Promise.reject(new TransientError('registry blip'));
      }
      return get(ref);
    };
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(GEN0.length);
    expect(faults).toBe(0);
  });
});

describe('a pin knows its object on any store, and fails rather than tear', () => {
  it('holds each incarnation apart on a store with no registry, where the version is the bare number', async () => {
    const storage = new MemoryStorage().storage;
    const OLD = [1, 2, C + 1, C + 2];
    const NEW = [7, 8, C + 7, C + 8];
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD);
    const store = new CloudRoaring({ storage });
    const first = await store.segment('s').pin();
    expect(await collect(first.iterate())).toEqual(OLD);
    for await (const key of storage.list(REF)) await storage.delete(key);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, NEW);
    // A new pin is of the object there now: not the first pin's reader, nor its cached chunks.
    const second = await store.segment('s').pin();
    expect(await collect(second.iterate())).toEqual(NEW);
    store.invalidate(REF);
    await expect(collect(first.iterate())).rejects.toThrow(
      /no longer the object this handle pinned/,
    );
    expect(await collect(second.iterate())).toEqual(NEW);
  });

  it('answers from what it holds after its object is replaced, and fails with NotFoundError for the rest', async () => {
    // One size, one layout: only the fingerprint's checksum tells the two objects apart.
    const OLD = [1, 2, C + 1, C + 2, 2 * C + 1];
    const NEW = [1, 2, C + 3, C + 4, 2 * C + 3];
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend });
    const snap = await store.segment('s').pin();
    expect(await snap.has(1)).toBe(true); // chunk 0, cached under the pin
    await w.reload(NEW);
    // The pinned instant's own index and chunks still answer; a chunk it never fetched is not there to fetch.
    expect(await snap.count()).toBe(OLD.length);
    expect(await snap.has(2)).toBe(true);
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    await expect(snap.has(C + 1)).rejects.toThrow(NotFoundError);
  });

  it('fails a read torn by dropSegment on its own store, rather than return the part it read', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    const seen: number[] = [];
    const read = async (): Promise<void> => {
      for await (const id of snap.iterate()) {
        seen.push(id);
        if (seen.length === 2) await w.store.dropSegment(REF, { confirmSegment: 's' });
      }
    };
    await expect(read()).rejects.toThrow(/which this handle pinned, can no longer be read/);
    expect(seen.length).toBeLessThan(GEN0.length);
    await expect(snap.count()).rejects.toThrow(NotFoundError);
  });

  it('refuses a materialisation that holds a segment twice before it reads anything, destination included', async () => {
    const calls: string[] = [];
    const counted = <T extends object>(target: T, name: string): T =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const v = Reflect.get(t, prop, receiver) as unknown;
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            calls.push(`${name}.${String(prop)}`);
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, GEN0, {
      registry: backend.registry,
    });
    const clock = manualClock();
    const store = new CloudRoaring({
      storage: createBackend({
        storage: counted(backend.storage, 'storage'),
        registry: counted(backend.registry, 'registry'),
      }),
      cache: { genTtlMs: TTL },
      seams: { clock },
    });
    const snap0 = await store.segment('s').pin();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 1 }, GEN1, {
      registry: backend.registry,
    });
    clock.advance(TTL);
    const snap1 = await store.segment('s').pin();
    calls.length = 0;
    for (const into of [
      () => snap0.intersectInto(store.segment('dest'), [snap1]),
      () => snap0.unionInto(store.segment('dest'), [snap1]),
      () => snap0.andNotInto(store.segment('dest'), [snap1]),
    ]) {
      await expect(into()).rejects.toThrow(ValidationError);
    }
    expect(calls).toEqual([]);
  });

  it('reads its own materialisation at once, as it does its own load, with no timed refresh', async () => {
    const w = await world({ cache: { genTtlMs: 0 } });
    await bulkLoadCrbmGeneration(w.storage, { segment: 'other', generation: 0 }, [1, 2, C + 10], {
      registry: w.registry,
    });
    await bulkLoadCrbmGeneration(w.storage, { segment: 'dest', generation: 0 }, [5, 6, 7, 8], {
      registry: w.registry,
    });
    const dest = w.store.segment('dest');
    expect(await dest.count()).toBe(4); // read, so this store holds dest's reader
    const r = await w.store.segment('s').intersectInto(dest, [w.store.segment('other')]);
    expect(r.cardinality).toBe(3);
    expect(await dest.count()).toBe(3);
    expect(await collect(dest.iterate())).toEqual([1, 2, C + 10]);
  });
});
