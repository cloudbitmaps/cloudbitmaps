import { RetryingStorageChunkSource } from '@/drivers/retry/retrying-chunk-source';
import type { RetryingOptions } from '@/drivers/retry/retrying-chunk-source';
import { TransientError } from '@/core/errors';
import type { ChunkRef, StorageChunkSource, SegmentRef } from '@/core/ports';
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

describe('RetryingStorageChunkSource', () => {
  it('retries a transient getChunk', async () => {
    const clock = recordingClock();
    const bytes = Uint8Array.of(9);
    const getChunk = flaky(1, new TransientError('blip'), bytes);
    const inner = { getChunk: () => getChunk() } as unknown as StorageChunkSource;
    const d = new RetryingStorageChunkSource(inner, opts(clock));
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
    } as unknown as StorageChunkSource;
    const d = new RetryingStorageChunkSource(inner, opts(clock));
    expect(await d.getChunk(ref)).toBeNull();
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries a transient listChunkKeys', async () => {
    const clock = recordingClock();
    const keys = flaky(1, new TransientError('blip'), [1, 2, 3]);
    const inner = { listChunkKeys: () => keys() } as unknown as StorageChunkSource;
    const d = new RetryingStorageChunkSource(inner, opts(clock));
    expect(await d.listChunkKeys(seg)).toEqual([1, 2, 3]);
    expect(clock.sleeps).toHaveLength(1);
  });
});
