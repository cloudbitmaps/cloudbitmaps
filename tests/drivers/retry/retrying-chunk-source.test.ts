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
// 5 attempts, so one transient failure is ridden out with room to spare; no real waiting (instant clock).
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

  // The optional reads, each present only when the inner source has it. The engine reads them in the middle of a
  // segment read — `count()` reads `cardinalities` or `summary`, `stat()` reads `stat`, and a combine checks an empty
  // operand with `exists` — so an unretried one fails a read the store says it retries.
  const OPTIONAL = [
    { member: 'sizeOf', value: { bytes: 10, chunks: 1 } },
    { member: 'cardinalities', value: new Map([[0, 3]]) },
    { member: 'summary', value: { generation: 4, cardinality: 3 } },
    { member: 'stat', value: { generation: 4, cardinality: 3, sizeBytes: 10 } },
    { member: 'currentGeneration', value: 4 },
    { member: 'exists', value: true },
    { member: 'currentVersion', value: 'v1' },
  ] as const;

  it.each(OPTIONAL)('retries a transient $member', async ({ member, value }) => {
    const clock = recordingClock();
    const read = flaky(1, new TransientError('blip'), value);
    const inner = { [member]: () => read() } as unknown as StorageChunkSource;
    const d = new RetryingStorageChunkSource(inner, opts(clock));
    const call = d[member] as ((r: SegmentRef) => Promise<unknown>) | undefined;
    expect(call).toBeTypeOf('function');
    expect(await call?.(seg)).toBe(value);
    expect(clock.sleeps).toHaveLength(1);
  });

  it.each(OPTIONAL)('leaves $member absent when the inner source has none', ({ member }) => {
    const inner = { getChunk: () => Promise.resolve(null) } as unknown as StorageChunkSource;
    const d = new RetryingStorageChunkSource(inner, opts(recordingClock()));
    expect(d[member]).toBeUndefined();
  });

  it('retries what a caller-supplied isRetryable accepts, and nothing it refuses', async () => {
    const clock = recordingClock();
    const mine = new Error('mine');
    const inner = { getChunk: flaky(1, mine, Uint8Array.of(1)) } as unknown as StorageChunkSource;
    const d = new RetryingStorageChunkSource(inner, {
      ...opts(clock),
      isRetryable: (err) => err === mine,
    });
    expect(await d.getChunk(ref)).toEqual(Uint8Array.of(1));
    expect(clock.sleeps).toHaveLength(1);

    const refusing = new RetryingStorageChunkSource(
      { getChunk: flaky(1, new TransientError('blip'), null) } as unknown as StorageChunkSource,
      { ...opts(clock), isRetryable: () => false },
    );
    await expect(refusing.getChunk(ref)).rejects.toBeInstanceOf(TransientError);
    expect(clock.sleeps).toHaveLength(1);
  });
});
