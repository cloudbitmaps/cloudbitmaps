import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryWarmDriver,
  MemoryColdChunkSource,
  SafeBitmap,
  TransientError,
  ValidationError,
  WriteConflictError,
} from '@/index';
import type { Clock, Rng } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { SegmentEngine } from '@/core/engine';
import type { ChunkRef, IWarmDriver, NoRow, SegmentRef, Token, WarmRow } from '@/core/ports';

// Deterministic + instant backoff for the retry tests (no real setTimeout waits).
const instantClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
const zeroRng: Rng = { next: () => 0 };

/**
 * A Warm driver that delegates to an in-memory driver but injects a bounded number of faults, so the
 * OCC-retry and transient-retry metric paths can be exercised deterministically.
 */
class FaultyWarm implements IWarmDriver {
  private gets = 0;
  private puts = 0;
  constructor(
    private readonly inner: MemoryWarmDriver,
    private readonly plan: { transientOnGet?: number; conflictOnPut?: number } = {},
  ) {}
  async get(ref: ChunkRef): Promise<WarmRow | null> {
    this.gets += 1;
    if (this.plan.transientOnGet && this.gets <= this.plan.transientOnGet) {
      throw new TransientError('injected transient');
    }
    return this.inner.get(ref);
  }
  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    this.puts += 1;
    if (this.plan.conflictOnPut && this.puts <= this.plan.conflictOnPut) {
      throw new WriteConflictError('injected conflict');
    }
    return this.inner.putConditional(ref, bytes, expected);
  }
  deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    return this.inner.deleteConditional(ref, expected);
  }
  listChunks(ref: SegmentRef): AsyncIterable<{ chunkKey: number } & WarmRow> {
    return this.inner.listChunks(ref);
  }
}

describe('metrics emission (via CloudRoaring)', () => {
  it('works with no metrics sink wired (no-op default)', async () => {
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
    });
    const s = cr.segment('users');
    await s.add(5);
    expect(await s.has(5)).toBe(true);
  });

  it('add() emits warm.read + warm.write + op:add', async () => {
    const counter = new CountingMetricsSink();
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      metrics: counter,
    });
    await cr.segment('users').add(5);
    const snap = counter.snapshot();
    expect(snap.warm.reads).toBe(1); // the read-modify-write reads first
    expect(snap.warm.writes).toBe(1);
    expect(snap.warm.writeBytes).toBeGreaterThan(0);
    expect(snap.ops.add.count).toBe(1);
  });

  it('reads emit cache miss + cold.get first, cache hit on the second read', async () => {
    const counter = new CountingMetricsSink();
    const cold = new MemoryColdChunkSource();
    cold.seed({ segment: 'users', chunkKey: 0 }, SafeBitmap.fromValues([5]).serialize());
    const cr = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, metrics: counter });
    const s = cr.segment('users');

    expect(await s.has(5)).toBe(true);
    let snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 0, misses: 1 });
    expect(snap.cold.gets).toBe(1);
    expect(snap.warm.reads).toBe(1); // the warm.get before falling through to cold
    expect(snap.ops.has.count).toBe(1);

    expect(await s.has(5)).toBe(true);
    snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 1, misses: 1 });
    expect(snap.cold.gets).toBe(1); // served from cache — no new cold read
  });

  it('intersect emits fetched vs skipped chunk counts (the chunk-skipping saving)', async () => {
    const counter = new CountingMetricsSink();
    const cold = new MemoryColdChunkSource();
    // segment a: chunk keys {0, 1, 2}; segment b: {1, 3}. Shared: {1}. Distinct across both: {0,1,2,3}.
    cold.seed({ segment: 'a', chunkKey: 0 }, SafeBitmap.fromValues([1]).serialize());
    cold.seed({ segment: 'a', chunkKey: 1 }, SafeBitmap.fromValues([7]).serialize());
    cold.seed({ segment: 'a', chunkKey: 2 }, SafeBitmap.fromValues([1]).serialize());
    cold.seed({ segment: 'b', chunkKey: 1 }, SafeBitmap.fromValues([7]).serialize());
    cold.seed({ segment: 'b', chunkKey: 3 }, SafeBitmap.fromValues([1]).serialize());
    const cr = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, metrics: counter });

    const out: number[] = [];
    for await (const id of cr.segment('a').intersect([cr.segment('b')])) out.push(id);

    const snap = counter.snapshot();
    expect(snap.intersect.calls).toBe(1);
    expect(snap.intersect.fetchedChunks).toBe(1); // shared key {1}
    expect(snap.intersect.skippedChunks).toBe(3); // {0,1,2,3} minus the 1 shared
    expect(out).toEqual([65_543]); // chunk 1, remainder 7 → 65536 + 7
  });

  it('emits an occ retry when a conditional write conflicts, then succeeds', async () => {
    const counter = new CountingMetricsSink();
    const warm = new FaultyWarm(new MemoryWarmDriver(), { conflictOnPut: 1 });
    const cr = new CloudRoaring({
      warm,
      cold: new MemoryColdChunkSource(),
      metrics: counter,
      clock: instantClock,
      rng: zeroRng,
    });
    const s = cr.segment('users');
    await s.add(5);
    const snap = counter.snapshot();
    expect(snap.retries.occ).toBe(1);
    expect(snap.warm.writes).toBe(1); // emitted only on the successful (2nd) attempt, never on the conflict
    expect(await s.has(5)).toBe(true);
  });

  it('emits a transient retry when a driver call throws TransientError', async () => {
    const counter = new CountingMetricsSink();
    const warm = new FaultyWarm(new MemoryWarmDriver(), { transientOnGet: 1 });
    const cr = new CloudRoaring({
      warm,
      cold: new MemoryColdChunkSource(),
      metrics: counter,
      clock: instantClock,
      rng: zeroRng,
    });
    const s = cr.segment('users');
    await s.add(5);
    expect(counter.snapshot().retries.transient).toBe(1);
    expect(await s.has(5)).toBe(true);
  });

  it('a throwing metrics sink never breaks a read/write', async () => {
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      metrics: {
        onEvent() {
          throw new Error('sink boom');
        },
      },
    });
    const s = cr.segment('users');
    await expect(s.add(5)).resolves.toBeUndefined();
    expect(await s.has(5)).toBe(true);
  });

  it('emits op even when the op throws (finally-timed)', async () => {
    const counter = new CountingMetricsSink();
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      metrics: counter,
    });
    const s = cr.segment('users');
    await expect(s.add(-1)).rejects.toThrow(ValidationError); // bad id → throws before any write
    expect(counter.snapshot().ops.add.count).toBe(1); // op still recorded on the throw path
  });

  it('no cache configured → cold.get still emitted, no cache events (direct engine)', async () => {
    const counter = new CountingMetricsSink();
    const cold = new MemoryColdChunkSource();
    cold.seed({ segment: 'users', chunkKey: 0 }, SafeBitmap.fromValues([5]).serialize());
    // No `cache` in EngineDeps → the cache branch is skipped entirely.
    const engine = new SegmentEngine({
      codec: roaringCodec,
      warm: new MemoryWarmDriver(),
      cold,
      metrics: counter,
    });
    expect(await engine.has({ segment: 'users' }, 5)).toBe(true);
    const snap = counter.snapshot();
    expect(snap.cache).toEqual({ hits: 0, misses: 0 }); // no spurious cache events without a cache
    expect(snap.cold.gets).toBe(1);
  });
});
