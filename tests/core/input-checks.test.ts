import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';
import { estimateCost } from '@cloudbitmaps/tools';
import type { ExportSink } from '@/index';
import { InProcessKeystore, NodeAead } from '@/drivers/crypto';
import { RetryingStorageChunkSource } from '@/drivers/retry/retrying-chunk-source';

/**
 * Inputs that plain JavaScript lets through and that would change what a call does without a word: an erasure scope
 * that scanned nothing and read as a clean erasure, a key given as text, a retry delay of `NaN` that made backoff a hot
 * loop, a shard numbering that left a shard unswept for good, an export that never flushed, a hit rate given as a
 * percentage. Each is now a `ValidationError` naming what is wrong, before anything is read or written.
 */

const store = (): CloudRoaring => new CloudRoaring({ storage: new MemoryStorage() });

describe('an erasure scope names a namespace', () => {
  it("refuses namespace '' and a namespace that is not a string, where they scanned nothing", async () => {
    for (const namespace of ['', 5, null]) {
      const scope = { namespace } as never;
      await expect(store().eraseSubject(1, scope)).rejects.toBeInstanceOf(ValidationError);
      await expect(store().subjectReport(1, scope)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('a key is bytes', () => {
  it('refuses a key given as a string, which would encrypt under its text with no key derivation', () => {
    const text = 'a'.repeat(32);
    expect(() => new InProcessKeystore({ keys: { k1: text as never }, activeKeyId: 'k1' })).toThrow(
      ValidationError,
    );
    expect(() => new NodeAead(text as never)).toThrow(ValidationError);
    expect(
      () => new InProcessKeystore({ keys: { k1: new Uint8Array(32).fill(7) }, activeKeyId: 'k1' }),
    ).not.toThrow();
  });
});

describe('a retry policy is numbers, a jitter mode and a callback', () => {
  it('refuses a delay, a factor, a jitter or a hook of the wrong kind when the store is built', () => {
    for (const retry of [
      { baseDelayMs: Number.NaN },
      { baseDelayMs: -1 },
      { maxDelayMs: Number.NaN },
      { backoffFactor: Number.NaN },
      { backoffFactor: 0.5 },
      { jitter: 'x' },
      { onRetry: 5 },
    ]) {
      expect(
        () => new CloudRoaring({ storage: new MemoryStorage(), retry: retry as never }),
        JSON.stringify(retry),
      ).toThrow(ValidationError);
    }
    expect(
      () =>
        new RetryingStorageChunkSource({} as never, {
          clock: { now: () => 0, sleep: async () => {} },
          rng: { next: () => 0.5 },
          policy: {
            maxAttempts: 3,
            baseDelayMs: Number.NaN,
            maxDelayMs: 10,
            backoffFactor: 2,
            jitter: 'full',
          },
        }),
    ).toThrow(ValidationError);
    expect(
      () =>
        new CloudRoaring({
          storage: new MemoryStorage(),
          retry: { baseDelayMs: 10, jitter: 'none' },
        }),
    ).not.toThrow();
  });
});

describe('a sweep shard is numbered from 0, below totalShards', () => {
  it('refuses shards without totalShards, and a shard outside [0, totalShards)', async () => {
    for (const options of [
      { shards: [1] },
      { shards: [1, 2, 3], totalShards: 3 },
      { shards: [-1], totalShards: 2 },
      { shards: [0.5], totalShards: 2 },
      { shards: [0], totalShards: 0 },
    ]) {
      await expect(
        store().retireExpired(options as never),
        JSON.stringify(options),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(store().retireExpired({ shards: [0, 1], totalShards: 2 })).resolves.toBeDefined();
  });
});

describe('an export batch size and format', () => {
  it('refuses an ndjsonBatchBytes that would never flush or flush per id, and a format it does not write', async () => {
    const sink = {} as ExportSink;
    for (const options of [
      { ndjsonBatchBytes: Number.NaN },
      { ndjsonBatchBytes: Number.POSITIVE_INFINITY },
      { ndjsonBatchBytes: 0 },
      { format: 'csv' },
    ]) {
      await expect(
        store().exportSegments(sink, options as never),
        JSON.stringify(options),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('a cache-hit rate is a fraction', () => {
  it('refuses one above 1, as one below 0 is refused, rather than read 95 as 1', () => {
    expect(() =>
      estimateCost({ segments: [{ sizeBytes: 1e6 }], workload: { cacheHitRate: 95 } }),
    ).toThrow(ValidationError);
    expect(() =>
      estimateCost({ segments: [{ sizeBytes: 1e6 }], workload: { cacheHitRate: 0.95 } }),
    ).not.toThrow();
  });
});
