import {
  RetryingColdChunkSource,
  RetryingColdDriver,
  RetryingRegistryDriver,
} from '@/drivers/retry/retrying-drivers';
import type { RetryingOptions } from '@/drivers/retry/retrying-drivers';
import { TransientError, WriteConflictError } from '@/core/errors';
import type {
  ChunkRef,
  ColdChunkSource,
  GenKey,
  IColdDriver,
  IRegistryDriver,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import type { Clock, Rng } from '@/core/determinism';

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
// 5 attempts so a couple of transient failures are comfortably ridden out; no real waiting (instant clock).
const opts = (clock: Clock): RetryingOptions => ({
  clock,
  rng: zeroRng,
  policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4, backoffFactor: 2, jitter: 'none' },
});

const ref: ChunkRef = { segment: 's', chunkKey: 1 };
const seg: SegmentRef = { segment: 's' };

/** Returns a function that rejects `fails` times with `err`, then resolves to `value`. */
function flaky<T>(fails: number, err: unknown, value: T): () => Promise<T> {
  let n = 0;
  return () => (++n <= fails ? Promise.reject(err) : Promise.resolve(value));
}

describe('RetryingColdChunkSource', () => {
  it('retries a transient getChunk', async () => {
    const clock = recordingClock();
    const bytes = Uint8Array.of(9);
    const getChunk = flaky(1, new TransientError('blip'), bytes);
    const inner = { getChunk: () => getChunk() } as unknown as ColdChunkSource;
    const d = new RetryingColdChunkSource(inner, opts(clock));
    expect(await d.getChunk(ref)).toBe(bytes);
    expect(clock.sleeps).toHaveLength(1);
  });

  it('does not retry a successful absent (null) chunk', async () => {
    const clock = recordingClock();
    let calls = 0;
    const inner = {
      getChunk: () => {
        calls++;
        return Promise.resolve(null);
      },
    } as unknown as ColdChunkSource;
    const d = new RetryingColdChunkSource(inner, opts(clock));
    expect(await d.getChunk(ref)).toBeNull();
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries a transient listChunkKeys', async () => {
    const clock = recordingClock();
    const keys = flaky(1, new TransientError('blip'), [1, 2, 3]);
    const inner = { listChunkKeys: () => keys() } as unknown as ColdChunkSource;
    const d = new RetryingColdChunkSource(inner, opts(clock));
    expect(await d.listChunkKeys(seg)).toEqual([1, 2, 3]);
    expect(clock.sleeps).toHaveLength(1);
  });
});

describe('RetryingColdDriver', () => {
  it('retries a transient getRange and leaves capabilities() un-wrapped', async () => {
    const clock = recordingClock();
    const bytes = Uint8Array.of(1, 2, 3);
    const getRange = flaky(2, new TransientError('blip'), bytes);
    const caps = { rangeRead: true as const, maxObjectBytes: 10 };
    const inner = {
      capabilities: () => caps,
      getRange: () => getRange(),
    } as unknown as IColdDriver;
    const d = new RetryingColdDriver(inner, opts(clock));
    expect(d.capabilities()).toBe(caps);
    const key: GenKey = { segment: 's', generation: 0 };
    expect(await d.getRange(key, 0, 3)).toBe(bytes);
    expect(clock.sleeps).toHaveLength(2);
  });

  it('does NOT retry a WriteConflictError from putImmutable (write-once collision)', async () => {
    const clock = recordingClock();
    let calls = 0;
    const inner = {
      putImmutable: () => {
        calls++;
        return Promise.reject(new WriteConflictError('exists'));
      },
    } as unknown as IColdDriver;
    const d = new RetryingColdDriver(inner, opts(clock));
    const key: GenKey = { segment: 's', generation: 0 };
    await expect(d.putImmutable(key, async () => {})).rejects.toBeInstanceOf(WriteConflictError);
    expect(calls).toBe(1);
  });

  it('re-enumerates list() from the start on a transient fault (buffered, no duplicates)', async () => {
    const clock = recordingClock();
    let attempts = 0;
    const gens: GenKey[] = [
      { segment: 's', generation: 0 },
      { segment: 's', generation: 1 },
    ];
    const inner: Pick<IColdDriver, 'list'> = {
      async *list() {
        attempts++;
        if (attempts === 1) {
          yield gens[0]!; // yields one item INTERNALLY, then faults — must not leak to the consumer
          throw new TransientError('mid-list blip');
        }
        yield* gens;
      },
    };
    const d = new RetryingColdDriver(inner as IColdDriver, opts(clock));
    const out: number[] = [];
    for await (const g of d.list(seg)) out.push(g.generation);
    expect(out).toEqual([0, 1]); // no duplicate gen-0 despite the first attempt yielding it before faulting
    expect(attempts).toBe(2);
  });
});

describe('RetryingRegistryDriver', () => {
  const record: RegistryRecord = {
    segment: 's',
    currentGen: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    token: 't',
  };

  it('retries a transient get and returns the eventual value, on the exact backoff schedule', async () => {
    const clock = recordingClock();
    const inner: Pick<IRegistryDriver, 'get'> = {
      get: flaky(2, new TransientError('blip'), record),
    };
    const d = new RetryingRegistryDriver(inner as IRegistryDriver, opts(clock));
    await expect(d.get(seg)).resolves.toBe(record);
    expect(clock.sleeps).toEqual([1, 2]); // base, base×factor — capped at maxDelayMs, no jitter
  });

  it('does NOT retry a WriteConflictError from compareAndSwap — the publish loop owns that', async () => {
    // The conflict IS the answer: it means the pointer moved, and a blind replay would re-apply the patch
    // against a token that is already stale. `publishGeneration` re-reads and retries at its own level, where
    // the decision (advance, no-op, or refuse) can actually be made.
    const clock = recordingClock();
    let calls = 0;
    const inner: Pick<IRegistryDriver, 'compareAndSwap'> = {
      compareAndSwap: () => {
        calls += 1;
        return Promise.reject(new WriteConflictError('token moved'));
      },
    };
    const d = new RetryingRegistryDriver(inner as IRegistryDriver, opts(clock));
    await expect(d.compareAndSwap(seg, 't', { currentGen: 1 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('re-enumerates list() from the start on a transient fault (buffered, no duplicates)', async () => {
    const clock = recordingClock();
    let attempts = 0;
    const inner: Pick<IRegistryDriver, 'list'> = {
      async *list() {
        attempts += 1;
        if (attempts === 1) {
          yield record; // yielded INTERNALLY, then faults — must not reach the consumer twice
          throw new TransientError('mid-scan blip');
        }
        yield record;
        yield { ...record, segment: 'other' };
      },
    };
    const d = new RetryingRegistryDriver(inner as IRegistryDriver, opts(clock));
    const seen: string[] = [];
    for await (const r of d.list()) seen.push(r.segment);
    expect(seen).toEqual(['s', 'other']);
    expect(attempts).toBe(2);
  });
});
