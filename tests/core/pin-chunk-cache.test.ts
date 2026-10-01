import { gcOrphanGenerations } from '@/core/generation-gc';
import {
  MemoryStorage,
  CloudRoaring,
  CrbmStorageChunkSource,
  InProcessKeystore,
  IntegrityError,
  NotFoundError,
  TransientError,
  ValidationError,
} from '@/index';
import type { CacheOptions, Clock, IMetricsSink, Segment, SegmentRef } from '@/index';
import { SegmentEngine } from '@/core/engine';
import { destroySegment } from '@/core/erasure';
import { segmentKey } from '@/core/keys';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import type { PinnedAt } from '@/core/pinned-storage-source';
import { BoundedLru } from '@/core/lru';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { setSegmentRetention } from '@cloudbitmaps/core';
import { brandAsBackend } from '@/core/ports';

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

/** `target`, recording each call made on it in `calls` as `<name>.<method>`. */
function counted<T extends object>(target: T, name: string, calls: string[]): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(`${name}.${String(prop)}`);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/** The whole object stored as generation 0 of `s`. */
async function wholeOf(storage: MemoryStorage['storage']): Promise<Uint8Array> {
  return (await storage.getTail({ ...REF, generation: 0 }, 1 << 30)).bytes;
}

/** `bytes` put where generation 0 of `s` is kept, from outside any store, whatever was there: the row is untouched. */
async function putObject(storage: MemoryStorage['storage'], bytes: Uint8Array): Promise<void> {
  const key = { ...REF, generation: 0 };
  for await (const k of storage.list(REF)) if (k.generation === 0) await storage.delete(key);
  await storage.putImmutable(key, async (sink) => {
    await sink.write(bytes);
  });
}

/** The bytes a load of `ids` stores as generation 0 of `s`, made in a bucket of their own. */
async function objectOf(ids: number[]): Promise<Uint8Array> {
  const scratch = new MemoryStorage();
  await bulkLoadCrbmGeneration(scratch.storage, { ...REF, generation: 0 }, ids, {
    registry: scratch.registry,
  });
  return wholeOf(scratch.storage);
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
  ])('reads through a pin built by hand %s, which checks no object', async (_how, extra) => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, GEN0, { registry });
    const crbm = new CrbmStorageChunkSource(storage, { registry });
    // Typed without a `fingerprint`: if the field became required, this file would stop compiling.
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
    // Nor does the second pin take the first's place: that one still answers from the object it opened.
    expect([await first.count(), await first.has(C + 1)]).toEqual([OLD.length, true]);
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
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, GEN0, {
      registry: backend.registry,
    });
    const clock = manualClock();
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(backend.storage, 'storage', calls),
        registry: counted(backend.registry, 'registry', calls),
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

describe('what a pin says when its object changes under it, and what pinning costs', () => {
  // One size, one layout: only the object's checksum tells the two apart.
  const OLD = [1, 2, C + 1, C + 2, 2 * C + 1];
  const NEW = [1, 2, C + 3, C + 4, 2 * C + 3];

  it.each([
    ['with a registry', true],
    ['with no registry', false],
  ])(
    'fails with NotFoundError when its object is replaced by a smaller one, %s',
    async (_how, withRegistry) => {
      const backend = new MemoryStorage();
      const { storage, registry } = backend;
      const deps = withRegistry ? { registry } : undefined;
      const SPREAD = Array.from({ length: 12 }, (_, k) => k * C + 1); // one id in each of 12 chunks
      await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, SPREAD, deps);
      const store = new CloudRoaring({ storage: withRegistry ? backend : storage });
      const snap = await store.segment('s').pin();
      expect(await snap.has(1)).toBe(true);
      for await (const key of storage.list(REF)) await storage.delete(key);
      if (withRegistry) await registry.delete(REF);
      await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1], deps);
      // The pin's reader still holds the old index, whose last chunk lies past the new object's end: the driver
      // refuses that range as out of bounds, and the reopen says why.
      await expect(snap.has(11 * C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    },
  );

  it("reads a driver's range error by its brand, as one from another copy of core would be thrown", async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const SPREAD = Array.from({ length: 12 }, (_, k) => k * C + 1);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, SPREAD, { registry });
    const store = new CloudRoaring({ storage: backend });
    const snap = await store.segment('s').pin();
    for await (const key of storage.list(REF)) await storage.delete(key);
    await registry.delete(REF);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1], { registry });
    // What a driver package with its own copy of core throws: the brand and the name, not this copy's class.
    const range = storage.getRange.bind(storage);
    storage.getRange = (key, offset, length) =>
      range(key, offset, length).catch((err: Error) => {
        throw Object.assign(new Error(err.message), {
          name: 'ValidationError',
          [Symbol.for('cloudbitmaps.error')]: true,
        });
      });
    await expect(snap.has(11 * C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
  });

  it('reports a replaced object as replaced when the footer read that finds it first meets a transient fault', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend, seams: { clock: manualClock() } });
    const snap = await store.segment('s').pin();
    await w.reload(NEW);
    let faults = 1;
    const tail = w.backend.storage.getTail.bind(w.backend.storage);
    w.backend.storage.getTail = (key, maxBytes) => {
      if (faults === 0) return tail(key, maxBytes);
      faults -= 1;
      return Promise.reject(new TransientError('tail blip'));
    };
    // The fault is the check's, and is retried as a store's read is. Reported as the chunk's checksum error, it
    // would be taken for damage and never retried.
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    expect(faults).toBe(0);
  });
  it('says a replaced object is replaced when it is gone by the time the pin reopens it', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend });
    const snap = await store.segment('s').pin();
    await w.reload(NEW);
    let misses = 1;
    const tail = w.backend.storage.getTail.bind(w.backend.storage);
    w.backend.storage.getTail = (key, maxBytes) => {
      if (misses === 0) return tail(key, maxBytes);
      misses -= 1;
      return Promise.reject(new NotFoundError('no such generation'));
    };
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    expect(misses).toBe(0);
  });

  it('keeps damage to the object it pinned an IntegrityError', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    let damaged = false;
    const range = backend.storage.getRange.bind(backend.storage);
    backend.storage.getRange = async (key, offset, length) => {
      const bytes = await range(key, offset, length);
      if (!damaged) return bytes;
      const flipped = Uint8Array.from(bytes);
      flipped[0]! ^= 0xff;
      return flipped;
    };
    const store = new CloudRoaring({ storage: backend });
    const snap = await store.segment('s').pin();
    damaged = true;
    // The reopen finds the same object, so the checksum's verdict stands: damage, not a replacement.
    await expect(snap.has(1)).rejects.toThrow(IntegrityError);
    await expect(snap.has(1)).rejects.toThrow(/payload CRC mismatch/);
  });

  it("keeps the chunk's own error when the footer read fails for a reason other than a transient fault", async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    let damaged = false;
    const range = backend.storage.getRange.bind(backend.storage);
    backend.storage.getRange = async (key, offset, length) => {
      const bytes = await range(key, offset, length);
      if (!damaged) return bytes;
      const flipped = Uint8Array.from(bytes);
      flipped[0]! ^= 0xff;
      return flipped;
    };
    const tail = backend.storage.getTail.bind(backend.storage);
    backend.storage.getTail = async (key, maxBytes) => {
      const got = await tail(key, maxBytes);
      if (!damaged) return got;
      const bytes = Uint8Array.from(got.bytes);
      bytes[bytes.length - 50]! ^= 0xff; // inside what the footer's CRC covers
      return { ...got, bytes };
    };
    const store = new CloudRoaring({ storage: backend });
    const snap = await store.segment('s').pin();
    damaged = true;
    // A footer that fails its own check says nothing about which object is there, so the chunk's error stands.
    await expect(snap.has(1)).rejects.toThrow(/payload CRC mismatch/);
  });

  it('pins nothing, and reads empty, when it joins a reopen of its version that finds the row gone', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    const store = new CloudRoaring({ storage: backend });
    const first = await store.segment('s').pin();
    store.invalidate(REF); // so the first pin's next read opens its version again
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gets = 0;
    const get = registry.get.bind(registry);
    registry.get = async (ref) => {
      gets += 1;
      if (gets === 1) await gate; // the first pin's reopen reads the row after the row is gone
      return get(ref);
    };
    const settle = async (n: number): Promise<void> => {
      for (let i = 0; i < 50 && gets < n; i += 1) await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    };
    const read = first.has(1);
    await settle(1);
    const second = store.segment('s').pin(); // reads the row while it is live, then waits on the reopen
    await settle(2);
    await registry.delete(REF);
    release();
    await expect(read).rejects.toThrow(NotFoundError);
    expect(await (await second).count()).toBe(0);
  });

  it('reads nothing, and throws nothing, for a generation read with no pin held once its row is gone', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    const crbm = new CrbmStorageChunkSource(storage, { registry });
    const version = await crbm.currentVersion(REF);
    expect(version).not.toBeNull();
    await registry.delete(REF);
    // A bare read of a generation is a lookup, and one with no row reads empty. A pin's read of it fails, since a
    // pin that went empty part-way through a call would have torn it.
    expect(await crbm.getChunkAt({ ...REF, chunkKey: 0 }, 0)).toBeNull();
    expect(await crbm.listChunkKeysAt(REF, 0)).toEqual([]);
    await expect(
      crbm.getChunkAt({ ...REF, chunkKey: 0 }, 0, { version: version! }),
    ).rejects.toThrow(NotFoundError);
  });

  it('shares one reader among pins of one generation with a registry, and opens the object for each pin without one', async () => {
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
      keystore,
    });
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(backend.storage, 'storage', calls),
        registry: backend.registry,
      }),
      encryption: { keystore: counted(keystore, 'keystore', calls) },
    });
    const pins: Segment[] = [];
    for (let i = 0; i < 5; i += 1) pins.push(await store.segment('s').pin());
    // One tail read and one key unwrap between five pins: each after the first shares the reader it opened.
    expect(calls.filter((c) => c === 'storage.getTail')).toHaveLength(1);
    expect(calls.filter((c) => c === 'keystore.openDek')).toHaveLength(1);
    for (const snap of pins) expect(await collect(snap.iterate())).toEqual(OLD);

    const bare = new MemoryStorage().storage;
    await bulkLoadCrbmGeneration(bare, { ...REF, generation: 0 }, OLD);
    const bareCalls: string[] = [];
    const registryless = new CloudRoaring({ storage: counted(bare, 'storage', bareCalls) });
    for (let i = 0; i < 3; i += 1) await registryless.segment('s').pin();
    // Without a registry only the object can tell two incarnations of a name apart, so each pin reads it.
    expect(bareCalls.filter((c) => c === 'storage.getTail')).toHaveLength(3);
  });

  it('coalesces pins taken at the same moment onto one open, with a registry', async () => {
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
      keystore,
    });
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(backend.storage, 'storage', calls),
        registry: backend.registry,
      }),
      encryption: { keystore: counted(keystore, 'keystore', calls) },
    });
    const pins = await Promise.all(Array.from({ length: 20 }, () => store.segment('s').pin()));
    expect(calls.filter((c) => c === 'storage.getTail')).toHaveLength(1);
    expect(calls.filter((c) => c === 'keystore.openDek')).toHaveLength(1);
    for (const snap of pins) expect(await snap.count()).toBe(OLD.length);
  });

  it('remembers that its object was replaced, so a later chunk read fails with no request', async () => {
    const w = await purgeable(OLD);
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(w.backend.storage, 'storage', calls),
        registry: counted(w.backend.registry, 'registry', calls),
      }),
    });
    const snap = await store.segment('s').pin();
    await w.reload(NEW); // through the raw backend: nothing counted
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    calls.length = 0;
    await expect(snap.has(2 * C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    expect(calls).toEqual([]);
    // Its index still answers, as the instant it pinned.
    expect(await snap.count()).toBe(OLD.length);
  });

  it('tells an object written under a key this store lacks from its own by the footer alone, and remembers it', async () => {
    const mine = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const theirs = new InProcessKeystore({
      keys: { k2: new Uint8Array(32).fill(9) },
      activeKeyId: 'k2',
    });
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, {
      registry,
      keystore: mine,
    });
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(storage, 'storage', calls),
        registry: counted(registry, 'registry', calls),
      }),
      encryption: { keystore: counted(mine, 'keystore', calls) },
    });
    const snap = await store.segment('s').pin();
    for await (const key of storage.list(REF)) await storage.delete(key);
    await registry.delete(REF);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, NEW, {
      registry,
      keystore: theirs,
    });
    calls.length = 0;
    // One footer read decides it, with no row read and no key: the footer is stored in the clear.
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    expect(calls).toEqual(['storage.getRange', 'storage.getTail']);
    calls.length = 0;
    await expect(snap.has(2 * C + 1)).rejects.toThrow(NotFoundError);
    expect(calls).toEqual([]);
  });

  it("says so too once the pin's reader is gone, and opens the object no more", async () => {
    const mine = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const theirs = new InProcessKeystore({
      keys: { k2: new Uint8Array(32).fill(9) },
      activeKeyId: 'k2',
    });
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, {
      registry,
      keystore: mine,
    });
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(storage, 'storage', calls),
        registry: counted(registry, 'registry', calls),
      }),
      encryption: { keystore: counted(mine, 'keystore', calls) },
    });
    const snap = await store.segment('s').pin();
    for await (const key of storage.list(REF)) await storage.delete(key);
    await registry.delete(REF);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, NEW, {
      registry,
      keystore: theirs,
    });
    store.invalidate(REF); // as the store's own load, rollback or eraseSubject would: the pin's reader is dropped
    // The reopen cannot unwrap the new object's key, which says nothing about which object it is; its footer does.
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    calls.length = 0;
    await expect(snap.has(2 * C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    await expect(snap.count()).rejects.toThrow(/no longer the object this handle pinned/);
    expect(calls).toEqual([]);
  });

  it('says a cleartext object where the store requires encryption is not the pinned one, once its reader is gone', async () => {
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry, keystore });
    const store = new CloudRoaring({ storage: backend, encryption: { keystore, required: true } });
    const snap = await store.segment('s').pin();
    for await (const key of storage.list(REF)) await storage.delete(key);
    await registry.delete(REF);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, NEW, { registry });
    store.invalidate(REF);
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
  });

  it('fails a generation gone from its key on the reopen alone, keeps nothing, and reads it again once restored', async () => {
    const w = await purgeable(OLD);
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(w.backend.storage, 'storage', calls),
        registry: counted(w.backend.registry, 'registry', calls),
      }),
    });
    const snap = await store.segment('s').pin();
    await bulkLoadCrbmGeneration(w.backend.storage, { ...REF, generation: 1 }, NEW, {
      registry: w.backend.registry,
    });
    const mine = await wholeOf(w.backend.storage);
    await w.backend.storage.delete({ ...REF, generation: 0 });
    store.invalidate(REF);
    // The reopen's own NotFoundError says it is gone, with no footer read to say it again. Nor is it kept: a 404
    // can pass, and an object can be restored.
    for (const id of [C + 1, 2 * C + 1]) {
      calls.length = 0;
      await expect(snap.has(id)).rejects.toThrow(NotFoundError);
      expect(calls).toEqual(['registry.get', 'storage.getTail']);
    }
    await putObject(w.backend.storage, mine);
    expect(await collect(snap.iterate())).toEqual(OLD);
  });

  it('pays for no footer read when its reopen meets a transient fault, which is retried', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend, seams: { clock: manualClock() } });
    const snap = await store.segment('s').pin();
    store.invalidate(REF);
    let blips = 1;
    const get = w.backend.registry.get.bind(w.backend.registry);
    w.backend.registry.get = (ref) => {
      if (blips === 0) return get(ref);
      blips -= 1;
      return Promise.reject(new TransientError('row blip'));
    };
    let tails = 0;
    const tail = w.backend.storage.getTail.bind(w.backend.storage);
    w.backend.storage.getTail = (key, maxBytes) => {
      tails += 1;
      return tail(key, maxBytes);
    };
    expect(await snap.has(1)).toBe(true);
    expect([blips, tails]).toEqual([0, 1]); // the reopen's own tail read, and no footer check
  });

  it('remembers a replacement its reopen found, and keeps no reader of the new object under the pin', async () => {
    const w = await purgeable(OLD);
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(w.backend.storage, 'storage', calls),
        registry: counted(w.backend.registry, 'registry', calls),
      }),
      cache: { readerMax: 2 },
      seams: { clock: manualClock() },
    });
    const snap = await store.segment('s').pin();
    await w.reload(NEW);
    store.invalidate(REF);
    expect(await store.segment('s').has(C + 3)).toBe(true); // the live reader of the new object
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    calls.length = 0;
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
    expect(calls).toEqual([]); // the next reopen is never made
    // The reopen's reader is not kept, so opening a second segment leaves the live reader in the cache's two places.
    expect(await store.segment('other').has(7)).toBe(true);
    calls.length = 0;
    expect(await store.segment('s').has(2 * C + 3)).toBe(true);
    expect(calls).toEqual(['storage.getRange']);
  });

  it('asks the footer once, even for a read whose chunk fails after the check has ended', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend });
    const snap = await store.segment('s').pin();
    await w.reload(NEW);
    let tails = 0;
    const tail = w.backend.storage.getTail.bind(w.backend.storage);
    w.backend.storage.getTail = (key, maxBytes) => {
      tails += 1;
      return tail(key, maxBytes);
    };
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ranges = 0;
    const range = w.backend.storage.getRange.bind(w.backend.storage);
    w.backend.storage.getRange = async (key, offset, length) => {
      ranges += 1;
      if (ranges > 1) await late; // the second read's chunk comes back after the first read's check has ended
      return range(key, offset, length);
    };
    const first = snap.has(C + 1);
    const second = snap.has(2 * C + 1);
    await expect(first).rejects.toThrow(/no longer the object this handle pinned/);
    release();
    await expect(second).rejects.toThrow(/no longer the object this handle pinned/);
    expect(tails).toBe(1);
  });

  it.each([
    ['a NotFoundError, which says the object is gone', 'NotFoundError', false],
    ['a TransientError, which is retried', 'TransientError', true],
  ])(
    "reads the footer read's own %s by its brand, as another copy of core would throw it",
    async (_what, name, transient) => {
      const w = await purgeable(OLD);
      const store = new CloudRoaring({ storage: w.backend, seams: { clock: manualClock() } });
      const snap = await store.segment('s').pin();
      await w.reload(NEW);
      let faults = 1;
      const tail = w.backend.storage.getTail.bind(w.backend.storage);
      w.backend.storage.getTail = (key, maxBytes) => {
        if (faults === 0) return tail(key, maxBytes);
        faults -= 1;
        const err = Object.assign(new Error(`${name} from another copy`), {
          name,
          [Symbol.for('cloudbitmaps.error')]: true,
          ...(transient ? { [Symbol.for('cloudbitmaps.error.transient')]: true } : {}),
        });
        return Promise.reject(err);
      };
      await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
      expect(faults).toBe(0);
    },
  );

  it('retries a transient fault during the footer read, and still reports damage as damage', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    let damaged = false;
    const range = backend.storage.getRange.bind(backend.storage);
    backend.storage.getRange = async (key, offset, length) => {
      const bytes = await range(key, offset, length);
      if (!damaged) return bytes;
      const flipped = Uint8Array.from(bytes);
      flipped[0]! ^= 0xff;
      return flipped;
    };
    const store = new CloudRoaring({ storage: backend, seams: { clock: manualClock() } });
    const snap = await store.segment('s').pin();
    damaged = true;
    let faults = 1;
    let tails = 0;
    const tail = backend.storage.getTail.bind(backend.storage);
    backend.storage.getTail = (key, maxBytes) => {
      tails += 1;
      if (faults === 0) return tail(key, maxBytes);
      faults -= 1;
      return Promise.reject(new TransientError('tail blip'));
    };
    // The faulted footer read is retried, finds the object it pinned, and the checksum's verdict stands.
    await expect(snap.has(1)).rejects.toThrow(/payload CRC mismatch/);
    expect([faults, tails]).toEqual([0, 2]);
  });
  it('pays for the footer read only on a checksum or range error, not on a transient one', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend, seams: { clock: manualClock() } });
    const snap = await store.segment('s').pin();
    const { storage, registry } = w.backend;
    const calls: string[] = [];
    let faults = 1;
    const range = storage.getRange.bind(storage);
    storage.getRange = (key, offset, length) => {
      calls.push('getRange');
      if (faults === 0) return range(key, offset, length);
      faults -= 1;
      return Promise.reject(new TransientError('range blip'));
    };
    const tail = storage.getTail.bind(storage);
    storage.getTail = (key, maxBytes) => {
      calls.push('getTail');
      return tail(key, maxBytes);
    };
    const get = registry.get.bind(registry);
    registry.get = (ref) => {
      calls.push('registry.get');
      return get(ref);
    };
    // The fault is retried as it stands; nothing reopens the object to ask whether it is still the pinned one.
    expect(await snap.has(C + 1)).toBe(true);
    expect(calls).toEqual(['getRange', 'getRange']);
  });

  it('never hands a pin a reader a bare read memoised, on a store with no registry', async () => {
    const storage = new MemoryStorage().storage;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD);
    const crbm = new CrbmStorageChunkSource(storage);
    expect(await crbm.getChunkAt({ ...REF, chunkKey: 0 }, 0)).not.toBeNull(); // memoises the old object
    for await (const key of storage.list(REF)) await storage.delete(key);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, C + 1]);
    const pin = await crbm.pinGeneration(REF);
    expect(pin).not.toBeNull();
    expect(await crbm.listChunkKeysAt(REF, 0, pin!)).toEqual([0, 1]);
  });

  it('reads a checksum error by its brand, as one from another copy of core would be thrown', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend });
    const snap = await store.segment('s').pin();
    await w.reload(NEW);
    w.backend.storage.getRange = () =>
      Promise.reject(
        Object.assign(new Error('checksum mismatch'), {
          name: 'IntegrityError',
          [Symbol.for('cloudbitmaps.error')]: true,
        }),
      );
    await expect(snap.has(C + 1)).rejects.toThrow(/no longer the object this handle pinned/);
  });

  it('shares one footer read among the chunk reads that find the same stale reader at once', async () => {
    const w = await purgeable(OLD);
    const store = new CloudRoaring({ storage: w.backend });
    const snap = await store.segment('s').pin();
    await w.reload(NEW);
    let tails = 0;
    const tail = w.backend.storage.getTail.bind(w.backend.storage);
    w.backend.storage.getTail = (key, maxBytes) => {
      tails += 1;
      return tail(key, maxBytes);
    };
    const reads = await Promise.allSettled([snap.has(C + 1), snap.has(C + 2), snap.has(2 * C + 1)]);
    expect(reads.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(tails).toBe(1);
  });

  it('keeps reading its own object through a short read after a shred beside it, its open reader holding the key', async () => {
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry, keystore });
    const store = new CloudRoaring({ storage: backend, encryption: { keystore } });
    const snap = await store.segment('s').pin();
    await destroySegment(REF, { registry }, { confirmSegment: 's' });
    let shorts = 1;
    const range = storage.getRange.bind(storage);
    storage.getRange = (key, offset, length) => {
      if (shorts === 0) return range(key, offset, length);
      shorts -= 1;
      return Promise.reject(new ValidationError('short read'));
    };
    // The footer is still the pinned object's, so the short read is only a short read: the next read answers.
    await expect(snap.has(C + 1)).rejects.toThrow(/short read/);
    expect(await snap.has(C + 1)).toBe(true);
  });

  it("cannot tell a replacement without a fingerprint, so a pin built by hand without one keeps the chunk's error", async () => {
    const w = await purgeable(OLD);
    const crbm = new CrbmStorageChunkSource(w.backend.storage, { registry: w.backend.registry });
    const version = await crbm.currentVersion(REF);
    const pin: PinnedAt = { generation: 0, version: version! };
    const engine = new SegmentEngine({
      storage: new PinnedStorageChunkSource(crbm, new Map([[segmentKey(REF), pin]])),
      codec: roaringCodec,
    });
    expect(await engine.has(REF, 1)).toBe(true); // opens the old object, under the pin's version
    await w.reload(NEW);
    await expect(engine.has(REF, C + 1)).rejects.toThrow(IntegrityError);
  });

  it('reads with the reader pin() opened, with no second tail read, on a store with no registry', async () => {
    const storage = new MemoryStorage().storage;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD);
    const calls: string[] = [];
    const store = new CloudRoaring({ storage: counted(storage, 'storage', calls) });
    const snap = await store.segment('s').pin();
    calls.length = 0;
    expect(await snap.count()).toBe(OLD.length);
    expect(calls.filter((c) => c === 'storage.getTail')).toEqual([]);
  });

  it('reads its own materialisation even when the call throws after its publish landed', async () => {
    const w = await world({ cache: { genTtlMs: 0 } });
    await bulkLoadCrbmGeneration(w.storage, { segment: 'other', generation: 0 }, [1, 2, C + 10], {
      registry: w.registry,
    });
    await bulkLoadCrbmGeneration(w.storage, { segment: 'dest', generation: 0 }, [5, 6, 7, 8], {
      registry: w.registry,
    });
    const dest = w.store.segment('dest');
    expect(await dest.count()).toBe(4); // read, so this store holds dest's reader
    // Every registry read after the publish fails, so the collection pass that follows it throws.
    let published = false;
    const cas = w.registry.compareAndSwap.bind(w.registry);
    w.registry.compareAndSwap = async (ref, expected, patch) => {
      const r = await cas(ref, expected, patch);
      published = true;
      return r;
    };
    const get = w.registry.get.bind(w.registry);
    w.registry.get = (ref) =>
      published ? Promise.reject(new TransientError('registry down')) : get(ref);
    await expect(
      w.store.segment('s').intersectInto(dest, [w.store.segment('other')], { keep: 0 }),
    ).rejects.toThrow();
    w.registry.get = get;
    expect((await w.registry.get({ segment: 'dest' }))?.currentGen).toBe(1); // it did publish
    expect(await collect(dest.iterate())).toEqual([1, 2, C + 10]);
  });
});

describe('what a pin found out about its object, and how it forgets', () => {
  // One size, one layout: only the object's checksum tells the two apart.
  const OLD = [1, 2, C + 1, C + 2, 2 * C + 1];
  const NEW = [1, 2, C + 3, C + 4, 2 * C + 3];
  const NOT_PINNED = /no longer the object this handle pinned/;

  /** A backend holding OLD as generation 0 of `s`, and a store on it: with its registry, or on its bare storage. */
  async function stored(withRegistry: boolean) {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(
      storage,
      { ...REF, generation: 0 },
      OLD,
      withRegistry ? { registry } : undefined,
    );
    const store = new CloudRoaring({ storage: withRegistry ? backend : storage });
    return { storage, store, mine: await wholeOf(storage) };
  }

  const EITHER = [
    ['with a registry', true],
    ['with no registry', false],
  ] as const;

  it.each(EITHER)(
    'reads again once a spell of 404s passes, and so does a pin taken after, %s',
    async (_how, withRegistry) => {
      const { storage, store } = await stored(withRegistry);
      let outage = false;
      const tail = storage.getTail.bind(storage);
      const range = storage.getRange.bind(storage);
      const missing = (): Promise<never> => Promise.reject(new NotFoundError('no such bucket'));
      storage.getTail = (key, maxBytes) => (outage ? missing() : tail(key, maxBytes));
      storage.getRange = (key, offset, length) => (outage ? missing() : range(key, offset, length));
      const snap = await store.segment('s').pin();
      outage = true; // a bucket's 404, or a replica that has not caught up
      store.invalidate(REF);
      await expect(snap.has(C + 1)).rejects.toThrow(NotFoundError);
      outage = false;
      expect(await snap.has(C + 1)).toBe(true);
      expect(await collect((await store.segment('s').pin()).iterate())).toEqual(OLD);
    },
  );

  it.each(EITHER)(
    'reads its object again once it is restored and the store invalidated, %s',
    async (_how, withRegistry) => {
      const { storage, store, mine } = await stored(withRegistry);
      const snap = await store.segment('s').pin();
      await putObject(storage, await objectOf(NEW));
      await expect(snap.has(C + 1)).rejects.toThrow(NOT_PINNED);
      await putObject(storage, mine); // a restore puts the pinned object back
      await expect(snap.has(C + 1)).rejects.toThrow(NOT_PINNED); // what the store found still stands…
      store.invalidate(REF); // …until it is told otherwise, as the disaster-recovery runbook says to
      expect(await collect(snap.iterate())).toEqual(OLD);
    },
  );

  it.each(EITHER)(
    'forgets what it found once a pin is taken of the object restored under its key, %s',
    async (_how, withRegistry) => {
      const { storage, store, mine } = await stored(withRegistry);
      const snap = await store.segment('s').pin();
      await putObject(storage, await objectOf(NEW));
      await expect(snap.has(C + 1)).rejects.toThrow(NOT_PINNED);
      await putObject(storage, mine);
      const later = await store.segment('s').pin(); // of the object as it is now: the pinned one, restored
      expect(await collect(later.iterate())).toEqual(OLD);
      expect(await snap.has(C + 1)).toBe(true);
    },
  );

  it.each(EITHER)(
    'says a short object that is no .crbm at all is not its own, %s, by its size alone',
    async (_how, withRegistry) => {
      for (const reopened of [false, true]) {
        const { storage, store } = await stored(withRegistry);
        const snap = await store.segment('s').pin();
        await putObject(storage, new Uint8Array(50));
        // Through the reader it holds, a chunk past the new end is a range error; reopened, the open says it is
        // too small. Either way it is a replacement, and the size says so before any footer is read.
        if (reopened) store.invalidate(REF);
        await expect(snap.has(2 * C + 1)).rejects.toThrow(NOT_PINNED);
      }
    },
  );

  it('keeps what it found against one pin of a version from failing another that holds another object', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    const crbm = new CrbmStorageChunkSource(backend.storage, { registry: backend.registry });
    const good = await crbm.pinGeneration(REF);
    const byHand = { version: good!.version, fingerprint: 'another object' };
    await expect(crbm.getChunkAt({ ...REF, chunkKey: 0 }, 0, byHand)).rejects.toThrow(NOT_PINNED);
    expect(await crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, good!)).not.toBeNull();
    expect(await crbm.getChunkAt({ ...REF, chunkKey: 2 }, 0, good!)).not.toBeNull();
  });

  it('reads the object now under its key through a pin taken once the store is invalidated, the row as it was', async () => {
    const { storage, store } = await stored(true);
    const first = await store.segment('s').pin();
    expect(await first.has(1)).toBe(true);
    await putObject(storage, await objectOf(NEW)); // replaced from outside any store
    await expect(first.has(C + 3)).rejects.toThrow(NOT_PINNED);
    store.invalidate(REF);
    const second = await store.segment('s').pin();
    expect([await second.count(), await collect(second.iterate())]).toEqual([NEW.length, NEW]);
  });

  it('applies nothing it found to a pin built by hand with no fingerprint, which reads what is under its key', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    const crbm = new CrbmStorageChunkSource(backend.storage, { registry: backend.registry });
    const pinned = await crbm.pinGeneration(REF);
    await putObject(backend.storage, await objectOf(NEW));
    crbm.invalidate(REF);
    await expect(crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, pinned!)).rejects.toThrow(NOT_PINNED);
    const byHand = { version: pinned!.version };
    expect(await crbm.cardinalitiesAt(REF, 0, byHand)).toEqual(
      new Map([
        [0, 2],
        [1, 2],
        [2, 1],
      ]),
    );
    expect(await crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, byHand)).not.toBeNull();
  });

  it.each([
    ['a NotFoundError', () => new NotFoundError('no such object')],
    ['an error no copy of core branded', () => new Error('socket hang up')],
  ])(
    'pays for no footer read on a chunk error that says nothing of which object is there: %s',
    async (_what, make) => {
      const w = await purgeable(OLD);
      const store = new CloudRoaring({ storage: w.backend, seams: { clock: manualClock() } });
      const snap = await store.segment('s').pin();
      const { storage } = w.backend;
      const error = make();
      storage.getRange = () => Promise.reject(error);
      let tails = 0;
      const tail = storage.getTail.bind(storage);
      storage.getTail = (key, maxBytes) => {
        tails += 1;
        return tail(key, maxBytes);
      };
      await expect(snap.has(C + 1)).rejects.toThrow(error.message);
      expect(tails).toBe(0);
    },
  );

  it('fails the pin of a replaced object with no registry, and never the pin of the object that replaced it', async () => {
    const storage = new MemoryStorage().storage;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD);
    const store = new CloudRoaring({ storage });
    const first = await store.segment('s').pin();
    for await (const key of storage.list(REF)) await storage.delete(key);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, NEW);
    const second = await store.segment('s').pin();
    await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
    expect(await second.has(C + 3)).toBe(true);
  });

  it('keeps what it found about as many pins as the store keeps readers, and no more', async () => {
    const backend = new MemoryStorage();
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(backend.storage, 'storage', calls),
        registry: counted(backend.registry, 'registry', calls),
      }),
      cache: { readerMax: 4 },
      seams: { clock: manualClock() },
    });
    const pins: Segment[] = [];
    for (let i = 0; i < 10; i += 1) {
      const ref = { segment: `seg${i}` };
      const deps = { registry: backend.registry };
      await bulkLoadCrbmGeneration(backend.storage, { ...ref, generation: 0 }, [1, C + 1], deps);
      pins.push(await store.segment(ref.segment).pin());
      for await (const key of backend.storage.list(ref)) await backend.storage.delete(key);
      await backend.registry.delete(ref);
      await bulkLoadCrbmGeneration(backend.storage, { ...ref, generation: 0 }, [2, C + 2], deps);
    }
    for (const snap of pins) await expect(snap.has(C + 1)).rejects.toThrow(NOT_PINNED);
    calls.length = 0;
    // The last four it found are kept, so their pins fail with no request…
    for (const snap of pins.slice(6).reverse()) {
      await expect(snap.has(C + 1)).rejects.toThrow(NOT_PINNED);
    }
    expect(calls).toEqual([]);
    // …and the first was let go, so its pin finds out again.
    await expect(pins[0]!.has(C + 1)).rejects.toThrow(NOT_PINNED);
    expect(calls).not.toEqual([]);
  });

  /**
   * A read of `storage`'s tails that reads now and answers only once `release()` is called, and a promise that
   * resolves once one read is held.
   */
  function heldTails(storage: MemoryStorage['storage']) {
    const tail = storage.getTail.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    storage.getTail = async (key, maxBytes) => {
      storage.getTail = tail; // only this one read is held
      const got = await tail(key, maxBytes); // read now…
      reached();
      await gate; // …and answered later
      return got;
    };
    return { held, release };
  }

  it.each([
    ['a footer read', false],
    ['a reopen', true],
  ])(
    'keeps nothing %s under way finds once the store is invalidated, as it is after a restore',
    async (_what, reopening) => {
      const w = await purgeable(OLD);
      const { storage } = w.backend;
      const mine = await wholeOf(storage);
      const store = new CloudRoaring({ storage: w.backend });
      const snap = await store.segment('s').pin();
      await w.reload(NEW);
      if (reopening) store.invalidate(REF); // so the read opens its generation again, rather than check its footer
      const { held, release } = heldTails(storage);
      const read = snap.has(C + 1);
      await held; // what it read is the replacement…
      await putObject(storage, mine); // …which a restore then undoes
      store.invalidate(REF);
      release();
      await expect(read).rejects.toThrow(NOT_PINNED);
      expect(await snap.has(C + 1)).toBe(true);
    },
  );

  it('keeps nothing a footer read under way finds once a pin is taken of the object restored, with no registry', async () => {
    const storage = new MemoryStorage().storage;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD);
    const mine = await wholeOf(storage);
    const store = new CloudRoaring({ storage });
    const snap = await store.segment('s').pin();
    await putObject(storage, await objectOf(NEW));
    const { held, release } = heldTails(storage);
    const read = snap.has(C + 1);
    await held;
    await putObject(storage, mine);
    const later = await store.segment('s').pin(); // the same version and the same object as the first
    release();
    await expect(read).rejects.toThrow(NOT_PINNED);
    expect([await snap.has(C + 1), await later.has(C + 1)]).toEqual([true, true]);
  });

  it('keeps nothing when the footer read finds no object there, since a 404 can pass', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    const store = new CloudRoaring({ storage: backend });
    const snap = await store.segment('s').pin();
    let faults = 1;
    const range = storage.getRange.bind(storage);
    storage.getRange = async (key, offset, length) => {
      const bytes = await range(key, offset, length);
      if (faults === 0) return bytes;
      faults -= 1;
      return Uint8Array.from(bytes, (b, i) => (i === 0 ? b ^ 0xff : b)); // one bad read of the chunk…
    };
    const tail = storage.getTail.bind(storage);
    storage.getTail = () => {
      storage.getTail = tail;
      return Promise.reject(new NotFoundError('no such bucket')); // …and one 404 for the footer read it asks
    };
    await expect(snap.has(C + 1)).rejects.toThrow(NotFoundError);
    expect(await snap.has(C + 1)).toBe(true);
  });
  /** A backend holding OLD as generation 0 of `s` with its registry, and a store over it whose calls are recorded. */
  async function recorded(cache?: CacheOptions) {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    await bulkLoadCrbmGeneration(backend.storage, { segment: 'other', generation: 0 }, [7], {
      registry: backend.registry,
    });
    const calls: string[] = [];
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counted(backend.storage, 'storage', calls),
        registry: counted(backend.registry, 'registry', calls),
      }),
      ...(cache === undefined ? {} : { cache }),
    });
    return { backend, calls, store };
  }

  /** A promise and the function that settles it. */
  function latch(): { open: () => void; opened: Promise<void> } {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  }

  /** Holds the next tail read of `storage`, once it has read, until `release` is called. */
  function holdNextTail(storage: MemoryStorage['storage']) {
    const tail = storage.getTail.bind(storage);
    const reached = latch();
    const released = latch();
    storage.getTail = async (key, maxBytes) => {
      storage.getTail = tail;
      const got = await tail(key, maxBytes);
      reached.open();
      await released.opened;
      return got;
    };
    return { reached: reached.opened, release: released.open };
  }

  it('keeps what it found against a pin through the pin taken next, which holds the object under the key', async () => {
    const { backend, calls, store } = await recorded();
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
    // A pin taken now, with no invalidation, holds what is under the key now, not the reader found replaced…
    const next = await store.segment('s').pin();
    expect(await collect(next.iterate())).toEqual(NEW);
    // …and taking it forgot nothing the store found against the first: its reads still cost no request.
    calls.length = 0;
    await expect(first.has(2 * C + 1)).rejects.toThrow(NOT_PINNED);
    expect(calls).toEqual([]);
  });

  it('lets a check of a reader finish when a pin that joins that reader is taken meanwhile', async () => {
    const { backend, calls, store } = await recorded();
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    const { reached, release } = holdNextTail(backend.storage);
    const read = first.has(C + 1).then(
      () => 'read',
      (err: Error) => err.message,
    );
    await reached; // a chunk read failed on the replacing object's bytes, and its footer check has read
    await store.segment('s').pin(); // joins the reader under check, having read nothing of its own
    release();
    expect(await read).toMatch(NOT_PINNED);
    calls.length = 0;
    await expect(first.has(2 * C + 1)).rejects.toThrow(NOT_PINNED);
    expect(calls).toEqual([]); // what the check found was kept
  });

  it("keeps the reader a pin shares with a replaced pin's reopen, so its first read is a chunk read alone", async () => {
    const { backend, calls, store } = await recorded();
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    store.invalidate(REF);
    const { reached, release } = holdNextTail(backend.storage);
    const read = first.has(C + 1).then(
      () => 'read',
      (err: Error) => err.message,
    );
    await reached; // the replaced pin's reopen has installed its reader, of the object that replaced the pinned one
    const joining = store.segment('s').pin(); // with a registry, the pins of one version share that open
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const [outcome, next] = await Promise.all([read, joining]);
    expect(outcome).toMatch(NOT_PINNED);
    calls.length = 0;
    expect(await next.has(C + 3)).toBe(true);
    expect(calls).toEqual(['storage.getRange']);
  });

  it('remembers a replacement its reopen finds though the reader cache evicts the reopen meanwhile', async () => {
    const { backend, calls, store } = await recorded({ readerMax: 1 });
    const snap = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    store.invalidate(REF);
    const { reached, release } = holdNextTail(backend.storage);
    const read = snap.has(C + 1).then(
      () => 'read',
      (err: Error) => err.message,
    );
    await reached;
    expect(await store.segment('other').has(7)).toBe(true); // a live read, which evicts the reopen's reader
    release();
    expect(await read).toMatch(NOT_PINNED);
    calls.length = 0;
    await expect(snap.has(C + 1)).rejects.toThrow(NOT_PINNED);
    expect(calls).toEqual([]);
  });

  it("leaves another pin's reader of its version in place when a replaced pin reads through it", async () => {
    const { backend, calls, store } = await recorded();
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    store.invalidate(REF);
    await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
    const second = await store.segment('s').pin(); // of the object now under the key
    expect(await second.has(C + 3)).toBe(true);
    store.invalidate(REF); // forgets what was found against the first, and drops the second's reader
    const third = await store.segment('s').pin(); // opens the same object again, and keeps its reader
    expect(third.pinnedAt?.fingerprint).toBe(second.pinnedAt?.fingerprint);
    // The first pin now reads through the third's reader, which it did not open, and must leave it to the third.
    await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
    calls.length = 0;
    expect(await third.has(2 * C + 3)).toBe(true);
    expect(calls).toEqual(['storage.getRange']);
  });

  it('lets a check an invalidation forgot neither end the check asked for since, nor keep what it found', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    const mine = await wholeOf(storage);
    const crbm = new CrbmStorageChunkSource(storage, { registry });
    const pin = await crbm.pinGeneration(REF);
    if (pin === null) throw new Error('the fixture pins generation 0');
    await putObject(storage, await objectOf(NEW));
    // Tail reads in order: the first check's footer read, the reopen after the invalidation, and the second check's
    // footer read. The two checks are held once they have read.
    const tail = storage.getTail.bind(storage);
    const first = { reached: latch(), released: latch() };
    const second = { reached: latch(), released: latch() };
    let n = 0;
    storage.getTail = async (key, maxBytes) => {
      const which = n++;
      const got = await tail(key, maxBytes);
      const check = which === 0 ? first : which === 2 ? second : undefined;
      if (check !== undefined) {
        check.reached.open();
        await check.released.opened;
      }
      return got;
    };
    // The pinned reader reads chunk 1 of the object that replaced its own, and its check reads that one's footer.
    const a = crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, pin).then(
      () => 'read',
      (err: Error) => err.message,
    );
    await first.reached.opened;
    await putObject(storage, mine); // a restore, and the store told of it: the first check is forgotten
    crbm.invalidate(REF);
    const range = storage.getRange.bind(storage);
    let damaged = 1;
    storage.getRange = async (key, offset, length) => {
      const bytes = await range(key, offset, length);
      if (damaged-- <= 0) return bytes;
      return Uint8Array.from(bytes, (b, i) => (i === 0 ? b ^ 0xff : b));
    };
    // The reopen reads the restored object; one damaged chunk read then asks a second check.
    const b = crbm.getChunkAt({ ...REF, chunkKey: 2 }, 0, pin).then(
      () => 'read',
      (err: Error) => err.name,
    );
    await second.reached.opened;
    first.released.open(); // the forgotten check ends while the second is the one asked for
    expect(await a).toMatch(NOT_PINNED);
    second.released.open();
    expect(await b).toBe('IntegrityError'); // the same object, read damaged
    // Nothing the forgotten check found may stand: the object under the key is the pinned one again.
    expect(await crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, pin)).not.toBeNull();
  });

  it('ends a check that finds the same object, so a replacement found later is remembered', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
    });
    const store = new CloudRoaring({ storage: backend, retry: false });
    const snap = await store.segment('s').pin();
    const range = backend.storage.getRange.bind(backend.storage);
    let damaged = 1;
    backend.storage.getRange = async (key, offset, length) => {
      const bytes = await range(key, offset, length);
      if (damaged-- <= 0) return bytes;
      return Uint8Array.from(bytes, (b, i) => (i === 0 ? b ^ 0xff : b));
    };
    await expect(snap.has(C + 1)).rejects.toThrow(IntegrityError); // damage: the footer names the pinned object
    await putObject(backend.storage, await objectOf(NEW));
    await expect(snap.has(2 * C + 1)).rejects.toThrow(NOT_PINNED);
  });

  it('pays for no footer read for a pin built with no fingerprint, on a chunk read or on a reopen', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    const crbm = new CrbmStorageChunkSource(storage, { registry });
    const pinned = await crbm.pinGeneration(REF);
    const byHand = { version: pinned?.version ?? '' };
    let tails = 0;
    const tail = storage.getTail.bind(storage);
    storage.getTail = (key, maxBytes) => {
      tails += 1;
      return tail(key, maxBytes);
    };
    storage.getRange = () => Promise.reject(new IntegrityError('bad bytes'));
    await expect(crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, byHand)).rejects.toThrow('bad bytes');
    expect(tails).toBe(0);
    crbm.invalidate(REF);
    tails = 0;
    let damaged = 1;
    storage.getTail = async (key, maxBytes) => {
      tails += 1;
      const got = await tail(key, maxBytes);
      if (damaged-- <= 0) return got;
      const bytes = Uint8Array.from(got.bytes);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff; // the reopen reads a damaged footer
      return { bytes, size: got.size };
    };
    await expect(crbm.getChunkAt({ ...REF, chunkKey: 1 }, 0, byHand)).rejects.toThrow(
      IntegrityError,
    );
    expect(tails).toBe(1); // the reopen's own tail read, and no check after it
  });

  it.each(['NotFoundError', 'TransientError'] as const)(
    "makes no footer read when a reopen fails with another copy of core's %s",
    async (name) => {
      const backend = new MemoryStorage();
      await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
        registry: backend.registry,
      });
      const store = new CloudRoaring({ storage: backend, retry: false });
      const snap = await store.segment('s').pin();
      store.invalidate(REF);
      // Branded as core brands its errors, by `Symbol.for`, and no instance of this copy's classes.
      const foreign = Object.assign(Object.create(Error.prototype) as Error, {
        name,
        message: `foreign ${name}`,
        [Symbol.for('cloudbitmaps.error')]: true,
        ...(name === 'TransientError'
          ? { [Symbol.for('cloudbitmaps.error.transient')]: true }
          : {}),
      });
      let tails = 0;
      let failing = 1;
      const tail = backend.storage.getTail.bind(backend.storage);
      backend.storage.getTail = (key, maxBytes) => {
        tails += 1;
        return failing-- > 0 ? Promise.reject(foreign) : tail(key, maxBytes);
      };
      await expect(snap.has(C + 1)).rejects.toThrow(`foreign ${name}`);
      expect(tails).toBe(1); // the reopen's own tail read, and no footer check
    },
  );
  it('shares one fresh open among the pins taken together after a replacement was found', async () => {
    const { backend, calls, store } = await recorded();
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
    calls.length = 0;
    const pins = await Promise.all(Array.from({ length: 20 }, () => store.segment('s').pin()));
    expect(calls.filter((c) => c === 'storage.getTail')).toHaveLength(1);
    for (const pin of pins) expect(await pin.has(C + 3)).toBe(true);
  });

  it("ends a replaced pin's index answers once a later pin opens the object now under its key", async () => {
    const { backend, store } = await recorded();
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
    expect(await first.count()).toBe(OLD.length); // its reader, of the object it pinned, is still held
    await store.segment('s').pin(); // takes the key, for the object under it now
    await expect(first.count()).rejects.toThrow(NOT_PINNED);
  });

  it('keeps no reader that decrypts for pins in flight across a crypto-shred and its invalidation', async () => {
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, OLD, {
      registry: backend.registry,
      keystore,
    });
    const store = new CloudRoaring({ storage: backend, encryption: { keystore }, retry: false });
    const { reached, release } = holdNextTail(backend.storage);
    const first = store.segment('s').pin();
    await reached;
    const second = store.segment('s').pin(); // joins the open in flight
    await new Promise((resolve) => setTimeout(resolve, 5));
    await destroySegment(REF, { registry: backend.registry }, { confirmSegment: 's' });
    store.invalidate(REF);
    release();
    const [a, b] = await Promise.all([first, second]);
    await expect(a.has(C + 1)).rejects.toThrow(NotFoundError);
    await expect(b.has(2 * C + 1)).rejects.toThrow(NotFoundError);
  });

  it('pins the object under the key when the reader cache evicts the replaced one while the pin resumes', async () => {
    // Every interleaving of the pin with an unrelated read that evicts it, one microtask apart.
    const failing: string[] = [];
    for (let hops = 0; hops < 40; hops += 1) {
      const { backend, store } = await recorded({ readerMax: 1 });
      const first = await store.segment('s').pin();
      await putObject(backend.storage, await objectOf(NEW));
      await expect(first.has(C + 1)).rejects.toThrow(NOT_PINNED);
      const evicting = async (): Promise<boolean> => {
        for (let i = 0; i < hops; i += 1) await null;
        return store.segment('other').has(7);
      };
      const [pin] = await Promise.all([store.segment('s').pin(), evicting()]);
      const read = await pin.has(C + 3).then(String, (err: Error) => err.name);
      if (read !== 'true') failing.push(`${hops}: ${read}`);
    }
    expect(failing).toEqual([]);
  });

  it('opens afresh when the reader another pin put back under the key is the replaced one', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    const source = new CrbmStorageChunkSource(storage, { registry });
    const held = await source.pinGeneration(REF);
    if (held === null) throw new Error('no pin');
    await putObject(storage, await objectOf(NEW));
    await expect(source.getChunkAt({ ...REF, chunkKey: 1 }, 0, held)).rejects.toThrow(NOT_PINNED);
    // As a pin that resumed before the replacement was found would: the replaced reader, put back in a new entry
    // while the next pin waits on the old one.
    type Memo = {
      get(key: string): unknown;
      peek(key: string): unknown;
      delete(key: string): void;
    };
    const inner = source as unknown as {
      snapshots: Memo;
      install(key: string, reader: Promise<unknown>): unknown;
    };
    const key = `${segmentKey(REF)}@${held.version}`;
    const get = inner.snapshots.get.bind(inner.snapshots);
    inner.snapshots.get = (k: string) => {
      const entry = get(k) as { reader: Promise<unknown> } | undefined;
      if (k === key && entry !== undefined) {
        inner.snapshots.get = get;
        queueMicrotask(() => {
          inner.snapshots.delete(key);
          inner.install(key, entry.reader);
        });
      }
      return entry;
    };
    const next = await source.pinGeneration(REF);
    expect(next?.fingerprint).not.toBe(held.fingerprint);
    await expect(
      source.getChunkAt({ ...REF, chunkKey: 1 }, 0, next ?? undefined),
    ).resolves.toBeDefined();
  });

  it("drops a replaced reopen's reader when another segment's invalidation lands while it runs", async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, OLD, { registry });
    await bulkLoadCrbmGeneration(storage, { segment: 'other', generation: 0 }, [7], { registry });
    const source = new CrbmStorageChunkSource(storage, { registry });
    const held = await source.pinGeneration(REF);
    if (held === null) throw new Error('no pin');
    await putObject(storage, await objectOf(NEW));
    source.invalidate(REF); // so the next pinned read reopens, and finds the object replaced
    const { reached, release } = holdNextTail(storage);
    const read = source.getChunkAt({ ...REF, chunkKey: 1 }, 0, held).then(
      () => 'read',
      (err: Error) => err.message,
    );
    await reached;
    source.invalidate({ segment: 'other' });
    release();
    expect(await read).toMatch(NOT_PINNED);
    // The reader it opened is of the object under the key now, not the pin's: kept, it would hold a place in the
    // reader cache for reads that can only fail.
    const memo = (source as unknown as { snapshots: { peek(key: string): unknown } }).snapshots;
    expect(memo.peek(`${segmentKey(REF)}@${held.version}`)).toBeUndefined();
  });

  it('keeps the fresh reader a pin installs while an evicted reopen is still under way', async () => {
    const { backend, calls, store } = await recorded({ readerMax: 1 });
    const first = await store.segment('s').pin();
    await putObject(backend.storage, await objectOf(NEW));
    store.invalidate(REF);
    const { reached, release } = holdNextTail(backend.storage);
    const read = first.has(C + 1).then(
      () => 'read',
      (err: Error) => err.name,
    );
    await reached;
    expect(await store.segment('other').has(7)).toBe(true); // evicts the reopen
    const next = await store.segment('s').pin(); // opens the object under the key now, and keeps it
    release();
    expect(await read).toBe('NotFoundError');
    calls.length = 0;
    expect(await next.has(C + 3)).toBe(true);
    expect(calls).toEqual(['storage.getRange']);
  });
});
