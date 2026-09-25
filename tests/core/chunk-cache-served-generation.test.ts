import {
  MemoryStorage,
  CloudRoaring,
  SafeBitmap,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
} from '@/index';
import type {
  CacheOptions,
  Clock,
  IMetricsSink,
  Segment,
  SegmentRef,
  StorageChunkSource,
} from '@/index';
import { SegmentEngine } from '@/core/engine';
import { BoundedLru } from '@/core/lru';
import { roaringCodec } from '@/roaring-codec';

/**
 * A decoded chunk must be cached under the version of the generation that SERVED its bytes.
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
 * it is handed the newer generation's chunk. The one handle that exists to describe a single instant then
 * returns a torn read: some chunks from the generation it pinned and some from the next, while its `count()`,
 * served from the pinned generation's index rather than from the cache, still reports the pinned total.
 *
 * Every case below ends with the same check: dropping the store's derived state (`invalidate`) makes the pin
 * read correctly again, because the bytes in the bucket were never wrong — only the cache entry was.
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

describe('the decoded-chunk cache is keyed by the generation that served the bytes', () => {
  it('iterate: a live read straddling a publish and cache.genTtlMs hands the pin generation 1 chunks', async () => {
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

  it('iterate: a reader-cache eviction does the same with no TTL at all (cache.genTtlMs: 0)', async () => {
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

  it('intersect: a live combine straddling a publish and the TTL poisons the pin the same way', async () => {
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

  it('has: a one-chunk read does it when the TTL boundary falls between its resolve and its fetch', async () => {
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

  it('a generation swept mid-call heals the live read forward, and the pin answers instead of failing', async () => {
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
    // because silently serving a different generation is the one thing a pin exists to prevent.
    const settle = (p: Promise<unknown>): Promise<unknown> =>
      p.then(
        (v) => v,
        () => 'threw',
      );
    expect({
      count: await settle(snap.count()),
      hasGen0Id: await settle(snap.has(2 * C + 30)),
      hasGen1Id: await settle(snap.has(2 * C + 40)),
    }).toEqual({ count: 'threw', hasGen0Id: 'threw', hasGen1Id: 'threw' });
  });
});

describe('the check that admits a chunk to the cache', () => {
  /**
   * A source that serves one chunk and reports version `v1`, except that its answer to the engine's check after
   * each fetch — every second call — fails, as re-resolving an evicted segment can.
   */
  function flakySource(failChecks: number) {
    const bytes = SafeBitmap.fromValues([1, 2, 3]).serialize();
    let versionCalls = 0;
    const counts = { gets: 0 };
    const source: StorageChunkSource = {
      getChunk: async () => {
        counts.gets += 1;
        return bytes;
      },
      listChunkKeys: async () => [0],
      currentVersion: async () => {
        versionCalls += 1;
        // Odd calls resolve the op; even calls are the check after a fetch.
        if (versionCalls % 2 === 0 && versionCalls / 2 <= failChecks)
          throw new Error('re-resolve failed');
        return 'v1';
      },
    };
    return { source, counts };
  }

  it('returns the chunk it fetched when the check cannot answer, and does not cache it', async () => {
    const { source, counts } = flakySource(1);
    const engine = new SegmentEngine({
      storage: source,
      codec: roaringCodec,
      cache: new BoundedLru({ maxEntries: 8, clock: { now: () => 0 } }),
    });
    expect(await engine.has(REF, 2)).toBe(true); // fetched; the check failed, so not cached
    expect(counts.gets).toBe(1);
    expect(await engine.has(REF, 2)).toBe(true); // fetched again; the check passed, so cached now
    expect(counts.gets).toBe(2);
    expect(await engine.has(REF, 3)).toBe(true); // a hit
    expect(counts.gets).toBe(2);
  });
});
