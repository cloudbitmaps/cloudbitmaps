import {
  CloudRoaring,
  MemoryWarmDriver,
  MemoryColdChunkSource,
  IntegrityError,
  TransientError,
  WriteConflictError,
  type ColdChunkSource,
  type IWarmDriver,
  type ChunkRef,
  type SegmentRef,
  type Clock,
  type Rng,
  type Segment,
} from '@/index';
import type { NoRow, Token, WarmRow } from '@/core/ports';
import { SafeBitmap } from '@/roaring-codec';

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

async function members(seg: Segment): Promise<number[]> {
  const out: number[] = [];
  for await (const id of seg.iterate()) out.push(id);
  return out;
}

/** Cold source that counts physical reads, to prove the HOT cache is wired. */
class CountingCold implements ColdChunkSource {
  getChunkCalls = 0;
  constructor(private readonly inner: MemoryColdChunkSource) {}
  getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.getChunkCalls += 1;
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
}

describe('HOT cache (C6) — wired through the engine', () => {
  it('serves a cache hit, re-reads after TTL, and evicts past the ceiling', async () => {
    const inner = new MemoryColdChunkSource();
    inner.seed({ segment: 's', chunkKey: 0 }, SafeBitmap.fromValues([1]).serialize());
    inner.seed({ segment: 's', chunkKey: 1 }, SafeBitmap.fromValues([0]).serialize()); // id 65536
    const cold = new CountingCold(inner);
    const clock = fakeClock();
    const s = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold,
      clock,
      cacheTtlMs: 100,
      cacheMaxChunks: 1,
    }).segment('s');

    await s.has(1);
    expect(cold.getChunkCalls).toBe(1);
    await s.has(1); // cache hit → no new read
    expect(cold.getChunkCalls).toBe(1);

    clock.advance(101); // TTL expiry
    await s.has(1);
    expect(cold.getChunkCalls).toBe(2);

    await s.has(65536); // chunk 1 → evicts chunk 0 (maxChunks=1)
    await s.has(1); // chunk 0 was evicted → physical re-read
    expect(cold.getChunkCalls).toBe(4);
  });
});

/** Warm driver that injects `WriteConflictError` on the first `failTimes` writes. */
class ConflictingWarm implements IWarmDriver {
  private fails = 0;
  constructor(
    private readonly inner: MemoryWarmDriver,
    private readonly failTimes: number,
  ) {}
  get(ref: ChunkRef): Promise<WarmRow | null> {
    return this.inner.get(ref);
  }
  putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    if (this.fails < this.failTimes) {
      this.fails += 1;
      return Promise.reject(new WriteConflictError('injected conflict'));
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

describe('OCC retry (read-modify-write)', () => {
  it('retries past transient conflicts and succeeds', async () => {
    const warm = new ConflictingWarm(new MemoryWarmDriver(), 3);
    const s = new CloudRoaring({ warm, cold: new MemoryColdChunkSource() }).segment('s');
    await s.add(42); // 3 conflicts < 16 retries → succeeds
    expect(await s.has(42)).toBe(true);
  });

  it('throws WriteConflictError when retries are exhausted', async () => {
    const warm = new ConflictingWarm(new MemoryWarmDriver(), 999);
    const s = new CloudRoaring({ warm, cold: new MemoryColdChunkSource() }).segment('s');
    await expect(s.add(42)).rejects.toBeInstanceOf(WriteConflictError);
  });
});

describe('untrusted tier metadata', () => {
  it('rejects an out-of-range chunk key from the WARM tier (IntegrityError)', async () => {
    const badWarm: IWarmDriver = {
      get: () => Promise.resolve(null),
      putConditional: () => Promise.resolve({ token: '1' }),
      deleteConditional: () => Promise.resolve(),
      listChunks: async function* () {
        yield { chunkKey: 70_000, token: '1', bytes: new Uint8Array() };
      },
    };
    const s = new CloudRoaring({ warm: badWarm, cold: new MemoryColdChunkSource() }).segment('s');
    await expect(s.count()).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('cold-only and boundary ids', () => {
  it('reads a cold-only segment (no warm) correctly', async () => {
    const cold = new MemoryColdChunkSource();
    cold.seed({ segment: 's', chunkKey: 0 }, SafeBitmap.fromValues([1, 2, 3]).serialize());
    const s = new CloudRoaring({ warm: new MemoryWarmDriver(), cold }).segment('s');
    expect(await s.count()).toBe(3);
    expect(await members(s)).toEqual([1, 2, 3]);
    expect(await s.has(2)).toBe(true);
    expect(await s.has(9)).toBe(false);
  });

  it('round-trips boundary ids through the full op path', async () => {
    const s = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
    }).segment('s');
    await s.addMany([0, 0xffff, 0x1_0000, 0xffff_ffff]);
    expect(await s.count()).toBe(4);
    expect(await members(s)).toEqual([0, 0xffff, 0x1_0000, 0xffff_ffff]);
    expect(await s.has(0xffff_ffff)).toBe(true);
  });
});

describe('OCC backoff + resilience (Phase 4b)', () => {
  it('backs off on a jittered schedule between OCC conflict retries', async () => {
    const clock = recordingClock();
    const s = new CloudRoaring({
      warm: new ConflictingWarm(new MemoryWarmDriver(), 2), // two conflicts, then the write lands
      cold: new MemoryColdChunkSource(),
      clock,
      rng: zeroRng,
      retry: false, // isolate the engine's OCC backoff — don't also wrap the warm driver
      occBackoff: {
        maxAttempts: 1,
        baseDelayMs: 5,
        maxDelayMs: 200,
        backoffFactor: 2,
        jitter: 'none',
      },
    }).segment('s');

    await s.add(42);
    expect(await s.has(42)).toBe(true);
    // One backoff sleep before each of the two retries, on the exact exponential schedule (5, 10) — a
    // mutation that dropped the OCC backoff sleep, or mis-indexed the attempt, would fail here.
    expect(clock.sleeps).toEqual([5, 10]);
  });

  /** Commits the first write server-side, then throws a transient as if the response was lost. */
  class PhantomCommitWarm implements IWarmDriver {
    private readonly store = new MemoryWarmDriver();
    private phantomDone = false;
    get(ref: ChunkRef): Promise<WarmRow | null> {
      return this.store.get(ref);
    }
    async putConditional(
      ref: ChunkRef,
      bytes: Uint8Array,
      expected: Token | NoRow,
    ): Promise<{ token: Token }> {
      if (!this.phantomDone) {
        this.phantomDone = true;
        await this.store.putConditional(ref, bytes, expected); // the write DID commit…
        throw new TransientError('response lost after commit'); // …but the caller never heard back
      }
      return this.store.putConditional(ref, bytes, expected);
    }
    deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
      return this.store.deleteConditional(ref, expected);
    }
    listChunks(ref: SegmentRef): AsyncIterable<{ chunkKey: number } & WarmRow> {
      return this.store.listChunks(ref);
    }
  }

  it('a timed-out-but-committed write is recovered with no double-apply and no lost write', async () => {
    const clock = recordingClock();
    const s = new CloudRoaring({
      warm: new PhantomCommitWarm(), // first add: commits, then the response is "lost" (transient)
      cold: new MemoryColdChunkSource(),
      clock,
      rng: zeroRng,
    }).segment('s'); // retry ON by default → the decorator retries the transient put

    // add(10): phantom commit of {10} → transient → decorator retries put(NO_ROW) → row now exists →
    // WriteConflict (not retried by the decorator) → engine re-reads {10}, re-applies add(10), put(token) → ok.
    await s.add(10); // both ids share chunk 0, so they contend on the same warm row
    await s.add(20); // normal write on top of {10}

    // No write lost (10 survived the phantom path), no double-apply / corruption.
    expect(await members(s)).toEqual([10, 20]);
    expect(await s.count()).toBe(2);
  });
});
