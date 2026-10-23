import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryStorage,
  TransientError,
  ValidationError,
} from '@/index';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import type { IMetricsSink } from '@/index';
import type { Clock, Rng, SegmentRef } from '@/index';
import type { ChunkRef, StorageChunkSource } from '@cloudbitmaps/core/driver-kit';
import { storeCodec } from '../helpers/store-codec';
import { SegmentEngine } from '@/core/engine';
import { BoundedLru } from '@cloudbitmaps/core';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { brandAsBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { withoutRangedReads } from '../helpers/no-ranged-reads';
import { joinId } from '@/core/bit-route';
import { collect, loadedStore, seedSegment, seededStore } from '../helpers/loaded';

// Deterministic + instant backoff for the retry tests (no real setTimeout waits).
const instantClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
const zeroRng: Rng = { next: () => 0 };

/** A storage source that delegates to an in-memory one but fails its first `transientOnGet` payload reads. */
class FaultyStorage implements StorageChunkSource {
  private gets = 0;
  constructor(
    private readonly inner: MemoryStorageChunkSource,
    private readonly transientOnGet: number,
  ) {}
  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.gets += 1;
    if (this.gets <= this.transientOnGet) throw new TransientError('injected transient');
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
}

describe('metrics emission (via CloudRoaring)', () => {
  it('works with no metrics sink wired (no-op default)', async () => {
    const { store } = seededStore({ users: [5] });
    expect(await store.segment('users').has(5)).toBe(true);
  });

  it('has() emits cache miss + storage.get + op:has on the first read, a cache hit on the second', async () => {
    const counter = new CountingMetricsSink();
    const { store } = seededStore({ users: [5] }, { metrics: counter });
    const s = store.segment('users');

    expect(await s.has(5)).toBe(true);
    let snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 0, misses: 1 });
    expect(snap.storage.gets).toBe(1);
    expect(snap.storage.bytes).toBeGreaterThan(0);
    expect(snap.ops.has.count).toBe(1);

    expect(await s.has(5)).toBe(true);
    snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 1, misses: 1 });
    expect(snap.storage.gets).toBe(1); // served from cache — no new storage read
    expect(snap.ops.has.count).toBe(2);
  });

  it('count() emits op:count — index-only on a loaded segment (0 GETs), one GET per chunk on the fallback', async () => {
    const counter = new CountingMetricsSink();
    const { store } = await loadedStore({ s: [1, 70_000, 140_000] }, { metrics: counter });
    expect(await store.segment('s').count()).toBe(3);
    let snap = counter.snapshot();
    expect(snap.ops.count.count).toBe(1);
    expect(snap.storage.gets).toBe(0); // summed from the .crbm index

    const fallback = new CountingMetricsSink();
    const seeded = seededStore({ s: [1, 70_000, 140_000] }, { metrics: fallback });
    expect(await seeded.store.segment('s').count()).toBe(3);
    snap = fallback.snapshot();
    expect(snap.ops.count.count).toBe(1);
    expect(snap.storage.gets).toBe(3); // no index on the in-memory source → one fetch per chunk
  });

  it('intersect emits fetched vs skipped chunk counts (the chunk-skipping saving)', async () => {
    const counter = new CountingMetricsSink();
    const { store, storage } = seededStore({}, { metrics: counter });
    // segment a: chunk keys {0, 1, 2}; segment b: {1, 3}. Shared: {1}. Distinct across both: {0,1,2,3}.
    seedSegment(storage, 'a', [joinId(0, 1), joinId(1, 7), joinId(2, 1)]);
    seedSegment(storage, 'b', [joinId(1, 7), joinId(3, 1)]);

    const out = await collect(store.segment('a').intersect([store.segment('b')]));

    const snap = counter.snapshot();
    expect(snap.intersect.calls).toBe(1);
    expect(snap.intersect.fetchedChunks).toBe(1); // shared key {1}
    expect(snap.intersect.skippedChunks).toBe(3); // {0,1,2,3} minus the 1 shared
    expect(out).toEqual([65_543]); // chunk 1, remainder 7 → 65536 + 7
  });

  it('emits a transient retry when a storage read throws TransientError, then serves the read', async () => {
    const counter = new CountingMetricsSink();
    const inner = new MemoryStorageChunkSource();
    seedSegment(inner, 'users', [5]);
    const store = new CloudRoaring({
      storage: new FaultyStorage(inner, 1),
      metrics: counter,
      seams: { clock: instantClock, rng: zeroRng },
    });
    expect(await store.segment('users').has(5)).toBe(true);
    const snap = counter.snapshot();
    expect(snap.retries.transient).toBe(1);
    expect(snap.storage.gets).toBe(1); // the retry happens inside the one GET the engine observes
  });

  it('a throwing metrics sink never breaks a read', async () => {
    const { store } = seededStore(
      { users: [5] },
      {
        metrics: {
          onEvent() {
            throw new Error('sink boom');
          },
        },
      },
    );
    const s = store.segment('users');
    expect(await s.has(5)).toBe(true);
    expect(await s.count()).toBe(1);
  });

  it('emits op even when the op throws (finally-timed)', async () => {
    const counter = new CountingMetricsSink();
    const { store } = seededStore({}, { metrics: counter });
    await expect(store.segment('users').has(-1)).rejects.toThrow(ValidationError); // bad id → throws before any read
    expect(counter.snapshot().ops.has.count).toBe(1); // op still recorded on the throw path
  });

  it('the *Into verbs emit their own op events (timed at the facade)', async () => {
    const counter = new CountingMetricsSink();
    const { store } = await loadedStore({ a: [1, 2, 3], b: [2, 3, 4] }, { metrics: counter });
    const a = store.segment('a');
    const b = store.segment('b');
    await a.intersectInto(store.segment('i'), [b]);
    await a.unionInto(store.segment('u'), [b]);
    await a.andNotInto(store.segment('d'), [b]);
    const { ops } = counter.snapshot();
    expect(ops.intersectInto.count).toBe(1);
    expect(ops.unionInto.count).toBe(1);
    expect(ops.andNotInto.count).toBe(1);
    expect(ops.has.count).toBe(0);
  });

  it('no cache configured → storage.get still emitted, no cache events (direct engine)', async () => {
    const counter = new CountingMetricsSink();
    const storage = new MemoryStorageChunkSource();
    seedSegment(storage, 'users', [5]);
    // No `cache` in EngineDeps → the cache branch is skipped entirely.
    const engine = new SegmentEngine({ codec: storeCodec, storage, metrics: counter });
    expect(await engine.has({ segment: 'users' }, 5)).toBe(true);
    const snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 0, misses: 0 }); // no spurious cache events without a cache
    expect(snap.storage.gets).toBe(1);
  });
});

const TTL = 10;
function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

describe('each chunk lookup of the engine costs and reports what its kind of read says', () => {
  const perKey = withoutRangedReads();
  const id = (chunk: number, low: number): number => chunk * 65_536 + low;
  beforeEach(perKey.off);
  afterEach(perKey.restore);

  function tally() {
    const t = { hits: 0, misses: 0, gets: 0 };
    const sink: IMetricsSink = {
      onEvent: (e) => {
        if (e.kind === 'cache') t[e.hit ? 'hits' : 'misses']++;
        if (e.kind === 'storage.get') t.gets++;
      },
    };
    return { t, sink };
  }

  it('a chunk the engine fetched from storage is reported as one cache miss, whichever read fetched it', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const at = (generation: number) => ({ namespace: 'ns', segment: 's', generation });
    // Chunk 0 holds ids 1..1000, so a range that starts inside it reads that chunk to know how many ids it cuts.
    await bulkLoadCrbmGeneration(
      storage,
      at(0),
      Array.from({ length: 1000 }, (_, i) => i + 1),
      { registry },
    );
    const { t, sink } = tally();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: TTL },
      seams: { clock: manualClock() },
      metrics: sink,
    });
    const seg = await store.segment('s', { namespace: 'ns' }).pin();
    await collect(seg.everyNth(100, { after: 500 }));
    expect(t.gets).toBeGreaterThan(0);
    expect(t.misses).toBe(t.gets);
  });

  it('a chunk that was cached when a read opened and has expired by the time it is taken is not counted a second time', async () => {
    perKey.restore(); // a stream of ranges: its chunks are counted as it opens
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const CHUNKS = 12;
    const ids = Array.from({ length: CHUNKS }, (_, k) => id(k, 1));
    await bulkLoadCrbmGeneration(storage, { namespace: 'ns', segment: 's', generation: 0 }, ids, {
      registry,
    });
    const { t, sink } = tally();
    const clock = manualClock();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: 1_000_000, ttlMs: 50 },
      seams: { clock },
      metrics: sink,
    });
    const seg = store.segment('s', { namespace: 'ns' });
    await seg.has(id(2, 1)); // chunk 2 is cached
    t.hits = t.misses = 0;
    const out: number[] = [];
    for await (const got of seg.iterate()) {
      out.push(got);
      if (out.length === 1) clock.advance(100); // the cached chunk expires before the read takes it
    }
    expect(out).toEqual(ids);
    expect(t.hits + t.misses).toBe(CHUNKS); // one lookup per chunk of the read, counted once
  });

  it('a cached chunk that is no longer the segment version is replaced by a read that is counted as a miss', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const at = (generation: number) => ({ namespace: 'ns', segment: 's', generation });
    await bulkLoadCrbmGeneration(storage, at(0), [id(0, 1), id(1, 1)], { registry });
    const { t, sink } = tally();
    const clock = manualClock();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: TTL },
      seams: { clock },
      metrics: sink,
    });
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.has(id(0, 1))).toBe(true); // chunk 0 is cached under generation 0
    await bulkLoadCrbmGeneration(storage, at(1), [id(0, 2)], { registry }); // another store's publish
    clock.advance(TTL + 1);
    // The cached chunk is no longer the segment's: the read that replaces it is a miss, and the only chunk it reads.
    expect(await seg.has(id(0, 2))).toBe(true);
    expect(t.misses).toBe(t.gets);
    expect(t.gets).toBe(2);
  });

  it('a combine that finds an exclude chunk it cached is no longer the exclude version counts the read that replaces it', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const at = (segment: string, generation: number) => ({ namespace: 'ns', segment, generation });
    const included = Array.from({ length: 60 }, (_, k) => id(k, 1));
    await bulkLoadCrbmGeneration(storage, at('a', 0), included, { registry });
    await bulkLoadCrbmGeneration(storage, at('b', 0), included, { registry });
    await bulkLoadCrbmGeneration(storage, at('c', 0), [id(0, 9), id(33, 9)], { registry });
    const { t, sink } = tally();
    const clock = manualClock();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: TTL },
      seams: { clock },
      metrics: sink,
    });
    const combine = () =>
      store.segment('a', { namespace: 'ns' }).intersect([store.segment('b', { namespace: 'ns' })], {
        exclude: [store.segment('c', { namespace: 'ns' })],
      });
    await collect(combine());
    let n = 0;
    for await (const got of combine()) {
      n += got >= 0 ? 1 : 0;
      if (n === 1) {
        await bulkLoadCrbmGeneration(storage, at('c', 1), [id(0, 9), id(33, 9), id(34, 9)], {
          registry,
        });
        clock.advance(TTL + 1);
      }
    }
    expect(n).toBeGreaterThan(1);
    // Chunk by chunk, so each chunk fetched from storage is one event, and each is reported as a miss.
    expect(t.misses).toBe(t.gets);
  });

  it('a point read of a cached chunk asks for the segment version once, not again to check the chunk it has just looked up', async () => {
    perKey.restore();
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 0 }, [1, 2, 3], { registry });
    const source = new CrbmStorageChunkSource(storage, { registry, clock: manualClock() });
    const engine = new SegmentEngine({
      storage: source,
      codec: storeCodec,
      cache: new BoundedLru<string, CodecBitmap>({ maxEntries: 100, clock: { now: () => 0 } }),
    });
    expect(await engine.has({ segment: 's' }, 2)).toBe(true); // the chunk is cached
    let asked = 0;
    const real = source.currentVersion.bind(source);
    source.currentVersion = (ref) => {
      asked++;
      return real(ref);
    };
    expect(await engine.has({ segment: 's' }, 2)).toBe(true);
    expect(asked).toBe(1);
  });
});
