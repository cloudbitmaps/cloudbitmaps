import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryColdChunkSource,
  TransientError,
  ValidationError,
} from '@/index';
import type { ChunkRef, Clock, ColdChunkSource, Rng, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { SegmentEngine } from '@/core/engine';
import { joinId } from '@/core/bit-route';
import { collect, loadedStore, seedSegment, seededStore } from '../helpers/loaded';

// Deterministic + instant backoff for the retry tests (no real setTimeout waits).
const instantClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
const zeroRng: Rng = { next: () => 0 };

/** A cold source that delegates to an in-memory one but fails its first `transientOnGet` payload reads. */
class FaultyCold implements ColdChunkSource {
  private gets = 0;
  constructor(
    private readonly inner: MemoryColdChunkSource,
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

  it('has() emits cache miss + cold.get + op:has on the first read, a cache hit on the second', async () => {
    const counter = new CountingMetricsSink();
    const { store } = seededStore({ users: [5] }, { metrics: counter });
    const s = store.segment('users');

    expect(await s.has(5)).toBe(true);
    let snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 0, misses: 1 });
    expect(snap.cold.gets).toBe(1);
    expect(snap.cold.bytes).toBeGreaterThan(0);
    expect(snap.ops.has.count).toBe(1);

    expect(await s.has(5)).toBe(true);
    snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 1, misses: 1 });
    expect(snap.cold.gets).toBe(1); // served from cache — no new cold read
    expect(snap.ops.has.count).toBe(2);
  });

  it('count() emits op:count — index-only on a loaded segment (0 GETs), one GET per chunk on the fallback', async () => {
    const counter = new CountingMetricsSink();
    const { store } = await loadedStore({ s: [1, 70_000, 140_000] }, { metrics: counter });
    expect(await store.segment('s').count()).toBe(3);
    let snap = counter.snapshot();
    expect(snap.ops.count.count).toBe(1);
    expect(snap.cold.gets).toBe(0); // summed from the .crbm index

    const fallback = new CountingMetricsSink();
    const seeded = seededStore({ s: [1, 70_000, 140_000] }, { metrics: fallback });
    expect(await seeded.store.segment('s').count()).toBe(3);
    snap = fallback.snapshot();
    expect(snap.ops.count.count).toBe(1);
    expect(snap.cold.gets).toBe(3); // no index on the in-memory source → one fetch per chunk
  });

  it('intersect emits fetched vs skipped chunk counts (the chunk-skipping saving)', async () => {
    const counter = new CountingMetricsSink();
    const { store, cold } = seededStore({}, { metrics: counter });
    // segment a: chunk keys {0, 1, 2}; segment b: {1, 3}. Shared: {1}. Distinct across both: {0,1,2,3}.
    seedSegment(cold, 'a', [joinId(0, 1), joinId(1, 7), joinId(2, 1)]);
    seedSegment(cold, 'b', [joinId(1, 7), joinId(3, 1)]);

    const out = await collect(store.segment('a').intersect([store.segment('b')]));

    const snap = counter.snapshot();
    expect(snap.intersect.calls).toBe(1);
    expect(snap.intersect.fetchedChunks).toBe(1); // shared key {1}
    expect(snap.intersect.skippedChunks).toBe(3); // {0,1,2,3} minus the 1 shared
    expect(out).toEqual([65_543]); // chunk 1, remainder 7 → 65536 + 7
  });

  it('emits a transient retry when a cold read throws TransientError, then serves the read', async () => {
    const counter = new CountingMetricsSink();
    const inner = new MemoryColdChunkSource();
    seedSegment(inner, 'users', [5]);
    const store = new CloudRoaring({
      cold: new FaultyCold(inner, 1),
      metrics: counter,
      clock: instantClock,
      rng: zeroRng,
    });
    expect(await store.segment('users').has(5)).toBe(true);
    const snap = counter.snapshot();
    expect(snap.retries.transient).toBe(1);
    expect(snap.cold.gets).toBe(1); // the retry happens inside the one GET the engine observes
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

  it('no cache configured → cold.get still emitted, no cache events (direct engine)', async () => {
    const counter = new CountingMetricsSink();
    const cold = new MemoryColdChunkSource();
    seedSegment(cold, 'users', [5]);
    // No `cache` in EngineDeps → the cache branch is skipped entirely.
    const engine = new SegmentEngine({ codec: roaringCodec, cold, metrics: counter });
    expect(await engine.has({ segment: 'users' }, 5)).toBe(true);
    const snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 0, misses: 0 }); // no spurious cache events without a cache
    expect(snap.cold.gets).toBe(1);
  });
});
