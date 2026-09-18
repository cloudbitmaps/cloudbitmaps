import {
  CloudRoaring,
  MemoryStorageChunkSource,
  TransientError,
  type ChunkRef,
  type Clock,
  type StorageChunkSource,
  type Rng,
  type SegmentRef,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { loadedStore, seedSegment } from '../helpers/loaded';

function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

/** A clock that records every requested sleep (and resolves instantly) — to assert the backoff schedule. */
function recordingClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => 0,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    sleeps,
  };
}
const zeroRng: Rng = { next: () => 0 };

/** Storage source that counts physical reads, to prove the cache is wired. */
class CountingStorage implements StorageChunkSource {
  getChunkCalls = 0;
  constructor(private readonly inner: MemoryStorageChunkSource) {}
  getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.getChunkCalls += 1;
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
}

describe('the bounded cache — wired through the engine', () => {
  it('serves a cache hit, re-reads after TTL, and evicts past the ceiling', async () => {
    const inner = new MemoryStorageChunkSource();
    inner.seed({ segment: 's', chunkKey: 0 }, SafeBitmap.fromValues([1]).serialize());
    inner.seed({ segment: 's', chunkKey: 1 }, SafeBitmap.fromValues([0]).serialize()); // id 65536
    const storage = new CountingStorage(inner);
    const clock = fakeClock();
    const s = new CloudRoaring({
      storage,
      cache: { ttlMs: 100, maxChunks: 1 },
      seams: { clock },
    }).segment('s');

    await s.has(1);
    expect(storage.getChunkCalls).toBe(1);
    await s.has(1); // cache hit → no new read
    expect(storage.getChunkCalls).toBe(1);

    clock.advance(101); // TTL expiry
    await s.has(1);
    expect(storage.getChunkCalls).toBe(2);

    await s.has(65536); // chunk 1 → evicts chunk 0 (maxChunks=1)
    await s.has(1); // chunk 0 was evicted → physical re-read
    expect(storage.getChunkCalls).toBe(4);
  });

  it('is keyed by generation: a reload misses the cache instead of serving a stale decoded chunk', async () => {
    // The hazard: id 1 is decoded and cached from generation 0; a reload publishes generation 1 without it. A
    // cache keyed by chunk alone would keep answering `true` — the id would "resurrect" from a superseded
    // chunk, which is exactly what an erasure must never allow.
    const clock = fakeClock();
    const { store, load } = await loadedStore(
      { s: [1, 2] },
      {
        cache: { genTtlMs: 1 },
        seams: { clock },
      },
    );
    const s = store.segment('s');
    expect(await s.has(1)).toBe(true); // chunk 0 @ generation 0 is now cached

    await load('s', [2]); // generation 1: the same chunk key, id 1 gone
    clock.advance(1);
    expect(await s.has(1)).toBe(false);
    expect(await s.has(2)).toBe(true);
  });
});

/** A storage source that fails its first `failTimes` payload reads with a transient fault, then behaves. */
class FlakyStorage implements StorageChunkSource {
  private fails = 0;
  constructor(
    private readonly inner: MemoryStorageChunkSource,
    private readonly failTimes: number,
  ) {}
  getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    if (this.fails < this.failTimes) {
      this.fails += 1;
      return Promise.reject(new TransientError('injected blip'));
    }
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
}

describe('transient-retry resilience (wired by default)', () => {
  it('backs off on the policy schedule between transient retries, then serves the read', async () => {
    const clock = recordingClock();
    const inner = new MemoryStorageChunkSource();
    seedSegment(inner, 's', [42]);
    const attempts: number[] = [];
    const s = new CloudRoaring({
      storage: new FlakyStorage(inner, 2),
      retry: {
        maxAttempts: 4,
        baseDelayMs: 5,
        maxDelayMs: 200,
        backoffFactor: 2,
        jitter: 'none',
        onRetry: (info) => attempts.push(info.attempt),
      },
      seams: { clock, rng: zeroRng },
    }).segment('s');

    expect(await s.has(42)).toBe(true);
    // One backoff sleep before each of the two retries, on the exact exponential schedule (5, 10) — a
    // mutation that dropped the sleep, or mis-indexed the attempt, would fail here.
    expect(clock.sleeps).toEqual([5, 10]);
    expect(attempts).toEqual([1, 2]);
  });

  it('surfaces the transient fault once the attempts are exhausted', async () => {
    const clock = recordingClock();
    const inner = new MemoryStorageChunkSource();
    seedSegment(inner, 's', [42]);
    const s = new CloudRoaring({
      storage: new FlakyStorage(inner, 99),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, backoffFactor: 2, jitter: 'none' },
      seams: { clock, rng: zeroRng },
    }).segment('s');
    await expect(s.has(42)).rejects.toBeInstanceOf(TransientError);
    expect(clock.sleeps).toEqual([1, 2]); // two backoffs for three attempts
  });

  it('`retry: false` disables the wrapper — the first fault surfaces unretried', async () => {
    const clock = recordingClock();
    const inner = new MemoryStorageChunkSource();
    seedSegment(inner, 's', [42]);
    const s = new CloudRoaring({
      storage: new FlakyStorage(inner, 1),
      retry: false,
      seams: { clock },
    }).segment('s');
    await expect(s.has(42)).rejects.toBeInstanceOf(TransientError);
    expect(clock.sleeps).toEqual([]);
  });
});
