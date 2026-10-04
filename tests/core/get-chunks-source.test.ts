/**
 * `getChunks` on the storage chunk source: several chunks of one generation, in as few requests as the planner makes
 * them, with the generation they came from. Each case counts the range requests the driver saw, and reads the
 * bytes back, since a count says nothing about which generation answered.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CrbmStorageChunkSource, NotFoundError, TransientError } from '@/index';
import { RetryingStorageChunkSource } from '@/drivers/retry/retrying-chunk-source';
import type { Clock, GenKey, SegmentRef } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import type { PinnedAt } from '@/core/pinned-storage-source';
import { segmentKey } from '@/core/keys';
import { SafeBitmap } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Two byte arrays are equal, compared natively: the framework's deep equality walks a 100 KiB buffer element by
 * element, which takes seconds over a test's worth of chunks.
 */
function expectSameBytes(
  got: Uint8Array | null | undefined,
  want: Uint8Array | null | undefined,
): void {
  expect(got, 'a chunk is missing').toBeTruthy();
  expect(want, 'the expected chunk is missing').toBeTruthy();
  const a = Buffer.from(got!.buffer, got!.byteOffset, got!.byteLength);
  const b = Buffer.from(want!.buffer, want!.byteOffset, want!.byteLength);
  expect(a.length, 'chunk length').toBe(b.length);
  expect(a.equals(b), 'chunk bytes').toBe(true);
}

const REF: SegmentRef = { segment: 's' };
const K = 65_536;
const TTL = 10;
/** Chunks 0 to 44, each 8 KiB: keys 0 and 44 are 344 KiB apart, past the 256 KiB a read may carry. */
const CHUNKS = 45;

/** Every even remainder of each chunk, or every odd one: the two generations differ in every chunk. */
const idsOf = (parity: 0 | 1): number[] =>
  Array.from(
    { length: CHUNKS * (K / 2) },
    (_, i) => Math.floor(i / (K / 2)) * K + 2 * (i % (K / 2)) + parity,
  );

const remaindersOf = (bytes: Uint8Array): number[] =>
  SafeBitmap.safeDeserialize(bytes, 1 << 20).toArray();
const parityOf = (bytes: Uint8Array | null): number => remaindersOf(bytes!)[0]! % 2;

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

/** A storage driver that counts the range reads it serves, and can run a hook before each. */
class CountingStorage extends MemoryStorageDriver {
  ranges: { generation: number; offset: number; length: number }[] = [];
  beforeRange: ((n: number) => Promise<void>) | undefined;
  /** Runs before each tail read, which is how an object's footer is read. */
  beforeTail: (() => Promise<void>) | undefined;
  override async getTail(key: GenKey, maxBytes: number) {
    await this.beforeTail?.();
    return super.getTail(key, maxBytes);
  }
  override async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    this.ranges.push({ generation: key.generation, offset, length });
    await this.beforeRange?.(this.ranges.length);
    return super.getRange(key, offset, length);
  }
}

async function world(options: { keystore?: InProcessKeystore } = {}) {
  const storage = new CountingStorage();
  const registry = new MemoryRegistryDriver();
  const clock = manualClock();
  const { keystore } = options;
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, idsOf(0), {
    registry,
    keystore,
  });
  const source = new CrbmStorageChunkSource(storage, {
    registry,
    clock,
    currentGenTtlMs: TTL,
    keystore,
  });
  const publishGen1 = async (): Promise<void> => {
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, idsOf(1), {
      registry,
      keystore,
    });
  };
  // Resolve and open the segment, so the requests counted afterwards are chunk reads.
  await source.currentVersion(REF);
  storage.ranges = [];
  return { storage, registry, clock, source, publishGen1 };
}

describe('CrbmStorageChunkSource.getChunks', () => {
  it('returns the chunks with the version of the generation, in the requests the planner makes', async () => {
    const { source, storage } = await world();
    const got = await source.getChunks(REF, [0, 1, 2, 44]);
    expect(storage.ranges).toHaveLength(2);
    expect(got.version).toBe(await source.currentVersion(REF));
    for (const [i, key] of [0, 1, 2, 44].entries()) {
      const alone = await source.getChunk({ ...REF, chunkKey: key });
      expectSameBytes(got.chunks[i]!, alone!);
    }
  });

  it('reads an encrypted segment, each chunk under its own associated data', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const { source } = await world({ keystore });
    const got = await source.getChunks(REF, [3, 40]);
    expect(remaindersOf(got.chunks[0]!)[0]).toBe(0);
    expectSameBytes(got.chunks[1]!, (await source.getChunk({ ...REF, chunkKey: 40 }))!);
  });

  it('answers null for an absent key and for a segment with no generation', async () => {
    const { source } = await world();
    expect((await source.getChunks(REF, [0, 500])).chunks[1]).toBeNull();
    expect(await source.getChunks({ segment: 'nobody' }, [0, 1])).toEqual({
      version: null,
      chunks: [null, null],
    });
  });

  it('refuses a key that is not a chunk key', async () => {
    const { source } = await world();
    await expect(source.getChunks(REF, [0, 65_536])).rejects.toThrow(/chunkKey/);
    await expect(source.getChunks(REF, [-1])).rejects.toThrow(/chunkKey/);
  });

  it('reads one generation for the whole call, though a publish lands and the pointer refreshes between its requests', async () => {
    const { source, storage, clock, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      await publishGen1();
      clock.advance(TTL + 1);
    };
    const first = await source.getChunks(REF, [0, 44]);
    expect(storage.ranges).toHaveLength(2);
    expect(storage.ranges.every((r) => r.generation === 0)).toBe(true);
    expect(first.chunks.map(parityOf)).toEqual([0, 0]);
    expect(first.version).toMatch(/^0:/);
    // The next call resolves the pointer afresh, and reads, and reports, the new generation.
    const next = await source.getChunks(REF, [0, 44]);
    expect(next.chunks.map(parityOf)).toEqual([1, 1]);
    expect(next.version).toMatch(/^1:/);
  });

  it('retries a request that fails transiently on its own, not the ones that landed', async () => {
    const { source, storage } = await world();
    const clock = manualClock();
    const retrying = new RetryingStorageChunkSource(source, {
      clock,
      rng: { next: () => 0.5 },
    });
    let failed = false;
    storage.beforeRange = async (n) => {
      if (n === 2 && !failed) {
        failed = true;
        throw new TransientError('throttled');
      }
    };
    const got = await retrying.getChunks!(REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([0, 0]);
    // Two merged reads and one repeat of the second: three requests, not four.
    expect(storage.ranges).toHaveLength(3);
    expect(storage.ranges[1]).toEqual(storage.ranges[2]);
  });

  it('retries the resolution of a segment that is not yet open, so a fault there does not fail the call', async () => {
    const { storage, registry } = await world();
    let failures = 1;
    const flaky = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
        return (ref: SegmentRef) =>
          failures-- > 0 ? Promise.reject(new TransientError('throttled')) : target.get(ref);
      },
    });
    const cold = new CrbmStorageChunkSource(storage, { registry: flaky, clock: manualClock() });
    const retrying = new RetryingStorageChunkSource(cold, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
    });
    const got = await retrying.getChunks!(REF, [0, 1]);
    expect(got.chunks.map(parityOf)).toEqual([0, 0]);
    expect(failures).toBeLessThan(0);
  });

  it('gives up after the policy attempts on one request, as a single chunk read does', async () => {
    const { source, storage } = await world();
    const retrying = new RetryingStorageChunkSource(source, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 4, backoffFactor: 2, jitter: 'none' },
    });
    storage.beforeRange = () => Promise.reject(new TransientError('down'));
    await expect(retrying.getChunks!(REF, [0, 44])).rejects.toBeInstanceOf(TransientError);
    expect(storage.ranges).toHaveLength(4); // two requests, two attempts each
  });
});

/** The object under generation 0 swapped for another with the same number: what a purge and a reload leaves. */
async function replaceGen0(storage: CountingStorage): Promise<void> {
  await storage.delete({ ...REF, generation: 0 });
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, idsOf(1), {});
}

describe('CrbmStorageChunkSource.getChunks: the call stays on one generation through each way a segment moves', () => {
  it('a sweep of the generation mid-call heals to the generation now current, whole', async () => {
    const { source, storage, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      await publishGen1();
      await storage.delete({ ...REF, generation: 0 });
    };
    const got = await source.getChunks(REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([1, 1]);
    expect(got.version).toMatch(/^1:/);
  });

  it('an object replaced under the same number mid-call heals to one generation', async () => {
    const { source, storage } = await world();
    const swapped = replaceGen0(storage);
    storage.beforeRange = () => swapped; // every request waits for the swap, as one that lands after it would
    const got = await source.getChunks(REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([1, 1]);
  });

  it('an invalidation mid-call leaves the call on the reader it opened, whole and verified', async () => {
    const { source, storage, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      await publishGen1();
      source.invalidate(REF);
    };
    const got = await source.getChunks(REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([0, 0]);
    expect(got.version).toMatch(/^0:/);
    expect((await source.getChunks(REF, [0])).version).toMatch(/^1:/);
  });

  it('retries a transient fault in the check that the object was replaced', async () => {
    const { source, storage } = await world();
    const retrying = new RetryingStorageChunkSource(source, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
    });
    let failures = 0;
    const swapped = replaceGen0(storage);
    storage.beforeRange = async (n) => {
      await swapped;
      if (n !== 1) return;
      storage.beforeTail = async () => {
        storage.beforeTail = undefined;
        failures++;
        throw new TransientError('throttled');
      };
    };
    const got = await retrying.getChunks!(REF, [0, 44]);
    expect(failures).toBe(1);
    expect(got.chunks.map(parityOf)).toEqual([1, 1]);
  });

  it('runs each request through the runner of a caller that wraps another retrying source', async () => {
    const { source } = await world();
    const inner = new RetryingStorageChunkSource(source, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
    });
    let outer = 0;
    await inner.getChunks!(REF, [0, 44], {
      retry: (request) => {
        outer++;
        return request();
      },
    });
    expect(outer).toBeGreaterThanOrEqual(2); // the resolution and each range
  });
});

describe('PinnedStorageChunkSource.getChunks', () => {
  async function pinned() {
    const w = await world();
    const pin = await w.source.pinGeneration(REF);
    const at: PinnedAt = pin!;
    const wrapper = new PinnedStorageChunkSource(w.source, new Map([[segmentKey(REF), at]]));
    return { ...w, wrapper, at };
  }

  it('reads the pinned generation after the live one has moved, under the version a pinned read keys by', async () => {
    const { wrapper, source, storage, clock, publishGen1 } = await pinned();
    await publishGen1();
    clock.advance(TTL + 1);
    expect((await source.getChunks(REF, [0])).chunks.map(parityOf)).toEqual([1]);
    storage.ranges = [];
    const got = await wrapper.getChunks(REF, [0, 1, 44]);
    expect(got.chunks.map(parityOf)).toEqual([0, 0, 0]);
    expect(storage.ranges.every((r) => r.generation === 0)).toBe(true);
    expect(got.version).toBe(await wrapper.currentVersion(REF));
    expect(got.version).toMatch(/^pin /);
  });

  it('refuses a pin whose object was replaced, whether the reader was open before or not', async () => {
    const warm = await pinned();
    await warm.wrapper.getChunks(REF, [0]); // the pin's reader is open and remembered
    await replaceGen0(warm.storage);
    await expect(warm.wrapper.getChunks(REF, [0, 44])).rejects.toBeInstanceOf(NotFoundError);

    const cold = await pinned();
    await replaceGen0(cold.storage);
    await expect(cold.wrapper.getChunks(REF, [0, 44])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes an unpinned segment to the live source, with the live version', async () => {
    const { wrapper, source, storage, registry } = await pinned();
    await bulkLoadCrbmGeneration(storage, { segment: 'other', generation: 0 }, idsOf(1), {
      registry,
    });
    const got = await wrapper.getChunks({ segment: 'other' }, [0]);
    expect(got.chunks.map(parityOf)).toEqual([1]);
    expect(got.version).toBe(await source.currentVersion({ segment: 'other' }));
  });

  it('reads empty from a pin of a segment that had no generation', async () => {
    const { source } = await world();
    const wrapper = new PinnedStorageChunkSource(
      source,
      new Map([[segmentKey(REF), { generation: null, version: null }]]),
    );
    expect(await wrapper.getChunks(REF, [0, 1])).toEqual({ version: null, chunks: [null, null] });
  });
});
