/**
 * `getChunks` on the storage chunk source: a stream of several chunks of one generation, in as few requests as the
 * planner makes them, each with the generation it came from. Each case counts the range requests the driver saw, and reads the
 * bytes back, since a count says nothing about which generation answered.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CrbmStorageChunkSource, NotFoundError, TransientError, ValidationError } from '@/index';
import { RetryingStorageChunkSource } from '@/drivers/retry/retrying-chunk-source';
import type { Clock, GenKey, SegmentRef } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import type { Aead } from '@/core/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import type { PinnedAt } from '@/core/pinned-storage-source';
import { segmentKey } from '@/core/keys';
import { SafeBitmap } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect, expectSameBytes } from '../helpers/chunk-stream';
import { Gate, Watched, tick, worstWhileWaiting } from '../helpers/live-buffers';
import type { ChunkRead, ReadChunksOptions, StorageChunkSource } from '@/core/ports';

/** What a stream yields, gathered: the chunks lined up with the keys, and the version each one was read from. */
async function read(
  source: StorageChunkSource,
  ref: SegmentRef,
  keys: readonly number[],
  options?: ReadChunksOptions,
): Promise<{ version: string | null; chunks: (Uint8Array | null)[]; items: ChunkRead[] }> {
  const items = await collect(source.getChunks!(ref, keys, options));
  const versions = new Set(items.map((i) => i.version));
  expect(versions.size, 'one stream, one generation').toBeLessThanOrEqual(1);
  return { version: items[0]?.version ?? null, chunks: items.map((i) => i.bytes), items };
}

// Building a 400-chunk object takes seconds under the load of the whole suite, before a case starts.
vi.setConfig({ testTimeout: 30_000 });

const REF: SegmentRef = { segment: 's' };
const K = 65_536;
const TTL = 10;
/** Chunks 0 to 44, each 8 KiB: keys 0 and 44 are 344 KiB apart, past the 256 KiB a read may carry. */
const CHUNKS = 45;

/** Every even remainder of each chunk, or every odd one: the two generations differ in every chunk. */
const idsOf = (parity: 0 | 1, chunks = CHUNKS): number[] =>
  Array.from(
    { length: chunks * (K / 2) },
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
  tails = 0;
  override async getTail(key: GenKey, maxBytes: number) {
    this.tails++;
    await this.beforeTail?.();
    return super.getTail(key, maxBytes);
  }
  inFlight = 0;
  peak = 0;
  /** When set, each range read answers a buffer of its own, registered here, and waits on the gate once it has it. */
  watch: { ranges: Watched; gate: Gate } | undefined;
  override async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    this.ranges.push({ generation: key.generation, offset, length });
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await this.beforeRange?.(this.ranges.length);
      const bytes = await super.getRange(key, offset, length);
      if (this.watch === undefined) return bytes;
      const copy = this.watch.ranges.track(new Uint8Array(bytes));
      await this.watch.gate.wait();
      return copy;
    } finally {
      this.inFlight--;
    }
  }
}

/** A keystore whose every opened chunk is a buffer of its own, registered. */
class WatchingKeystore extends InProcessKeystore {
  readonly plains = new Watched(true);
  override async openDek(wrapped: Parameters<InProcessKeystore['openDek']>[0]): Promise<Aead> {
    const aead = await super.openDek(wrapped);
    return {
      seal: (plain, aad) => aead.seal(plain, aad),
      open: (sealed, aad) => this.plains.track(aead.open(sealed, aad)),
    };
  }
}

async function world(options: { keystore?: InProcessKeystore; chunks?: number } = {}) {
  const chunks = options.chunks ?? CHUNKS;
  const storage = new CountingStorage();
  const registry = new MemoryRegistryDriver();
  const clock = manualClock();
  const { keystore } = options;
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, idsOf(0, chunks), {
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
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, idsOf(1, chunks), {
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
    const got = await read(source, REF, [0, 1, 2, 44]);
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
    const got = await read(source, REF, [3, 40]);
    expect(remaindersOf(got.chunks[0]!)[0]).toBe(0);
    expectSameBytes(got.chunks[1]!, (await source.getChunk({ ...REF, chunkKey: 40 }))!);
  });

  it('answers null for an absent key and for a segment with no generation', async () => {
    const { source } = await world();
    expect((await read(source, REF, [0, 500])).chunks[1]).toBeNull();
    const none = await read(source, { segment: 'nobody' }, [0, 1]);
    expect(none.items).toEqual([
      { key: 0, bytes: null, version: null },
      { key: 1, bytes: null, version: null },
    ]);
  });

  it('refuses a key that is not a chunk key', async () => {
    const { source } = await world();
    await expect(read(source, REF, [0, 65_536])).rejects.toThrow(/chunkKey/);
    await expect(read(source, REF, [-1])).rejects.toThrow(/chunkKey/);
  });

  it('serves nothing of a generation a publish and a pointer refresh have moved on from, even in ranges already requested', async () => {
    const { source, storage, clock, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      await publishGen1();
      clock.advance(TTL + 1);
    };
    const first = await read(source, REF, [0, 44]);
    // Both ranges were requested from generation 0, before the publish was seen; the stream resolves again before it
    // serves a chunk, finds generation 1, drops them, and reads both afresh.
    expect(storage.ranges.filter((r) => r.generation === 0)).toHaveLength(2);
    expect(storage.ranges.filter((r) => r.generation === 1)).toHaveLength(2);
    expect(first.chunks.map(parityOf)).toEqual([1, 1]);
    expect(first.version).toMatch(/^1:/);
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
    const got = await read(retrying, REF, [0, 44]);
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
    const got = await read(retrying, REF, [0, 1]);
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
    await expect(read(retrying, REF, [0, 44])).rejects.toBeInstanceOf(TransientError);
    expect(storage.ranges).toHaveLength(4); // two requests, two attempts each
  });
});

/** The object under generation 0 swapped for another with the same number: what a purge and a reload leaves. */
async function replaceGen0(storage: CountingStorage): Promise<void> {
  await storage.delete({ ...REF, generation: 0 });
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, idsOf(1), {});
}

describe('CrbmStorageChunkSource.getChunks: the call re-resolves the segment through each way it moves', () => {
  it('a sweep of the generation mid-call heals to the generation now current, whole', async () => {
    const { source, storage, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      await publishGen1();
      await storage.delete({ ...REF, generation: 0 });
    };
    const got = await read(source, REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([1, 1]);
    expect(got.version).toMatch(/^1:/);
  });

  it('an object replaced under the same number mid-call heals to one generation', async () => {
    const { source, storage } = await world();
    const swapped = replaceGen0(storage);
    storage.beforeRange = () => swapped; // every request waits for the swap, as one that lands after it would
    const got = await read(source, REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([1, 1]);
  });

  it('an invalidation mid-call re-resolves the segment before the next chunk is served, as a read of it alone would', async () => {
    const { source, storage, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      await publishGen1();
      source.invalidate(REF);
    };
    const got = await read(source, REF, [0, 44]);
    expect(got.chunks.map(parityOf)).toEqual([1, 1]);
    expect(got.version).toMatch(/^1:/);
  });

  it('an invalidation that finds the generation unchanged leaves the call on its stream: no range is read again', async () => {
    const { source, storage } = await world();
    const it = source.getChunks!(REF, [0, 44], { concurrency: 1 })[Symbol.asyncIterator]();
    const first = await it.next();
    source.invalidate(REF);
    const second = await it.next();
    expect([first.value, second.value].map((c: ChunkRead) => parityOf(c.bytes))).toEqual([0, 0]);
    expect(storage.ranges).toHaveLength(2);
    expect(first.value.version).toBe(second.value.version);
  });

  it('a pointer refresh that finds the generation unchanged leaves the call on its stream too', async () => {
    const { source, storage, clock } = await world();
    const it = source.getChunks!(REF, [0, 44], { concurrency: 1 })[Symbol.asyncIterator]();
    await it.next();
    clock.advance(TTL + 1);
    const second = await it.next();
    expect(parityOf(second.value.bytes)).toBe(0);
    expect(storage.ranges).toHaveLength(2);
  });

  it('a segment the reader cache let go of is resolved again, from its row alone, and a stream whose generation is the same goes on', async () => {
    const { source, storage, clock, publishGen1 } = await world();
    const it = source.getChunks!(REF, [0, 22, 44], { concurrency: 1 })[Symbol.asyncIterator]();
    await it.next();
    const tails = storage.tails;
    // The reader cache's own eviction, as `invalidate` is the one way to reach it from outside.
    const cache = (
      source as unknown as { snapshots: { deleteWhere(p: (k: string) => boolean): void } }
    ).snapshots;
    cache.deleteWhere((k) => k.endsWith('s'));
    const second = await it.next();
    expect(parityOf(second.value.bytes)).toBe(0);
    expect(storage.tails).toBe(tails); // resolved again, and nothing opened to learn its version
    // The TTL moves it on too: a publish, a lapse, and the next chunk is the generation now current.
    await publishGen1();
    clock.advance(TTL + 1);
    const third = await it.next();
    expect(parityOf(third.value.bytes)).toBe(1);
    await it.return!(undefined);
  });

  it('a read over more segments than the reader cache keeps opens no object per chunk to check them', async () => {
    const storage = new CountingStorage();
    const registry = new MemoryRegistryDriver();
    const segments = ['a', 'b', 'c'].map((segment) => ({ segment }));
    for (const ref of segments) {
      await bulkLoadCrbmGeneration(storage, { ...ref, generation: 0 }, idsOf(0), { registry });
    }
    let gets = 0;
    const counting = new Proxy(registry, {
      get(target, p, rx) {
        const value: unknown = Reflect.get(target, p, rx);
        if (p !== 'get') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: Parameters<MemoryRegistryDriver['get']>) => {
          gets++;
          return target.get(...args);
        };
      },
    });
    const source = new CrbmStorageChunkSource(storage, {
      registry: counting,
      clock: manualClock(),
      currentGenTtlMs: TTL,
      maxOpenSegments: 2,
    });
    const keys = Array.from({ length: CHUNKS }, (_, i) => i);
    const streams = segments.map((ref) =>
      source.getChunks!(ref, keys, { concurrency: 1 })[Symbol.asyncIterator](),
    );
    // Interleaved, so each stream's segment is let go of by the reader cache between two of its chunks.
    for (let i = 0; i < CHUNKS; i++)
      for (const s of streams) expect((await s.next()).done).toBe(false);
    for (const s of streams) await s.return!(undefined);
    // With a timed refresh the TTL bounds what a stream serves, so the cache letting a segment go is not a move: no
    // chunk reads the row again, and none opens an object (a tail read and an index parse).
    expect(storage.tails).toBeLessThanOrEqual(segments.length);
    expect(gets).toBeLessThanOrEqual(segments.length);
  });

  it("retries a transient fault in opening the generation it moves to mid-stream, through the caller's retry", async () => {
    const { source, storage, clock, publishGen1 } = await world();
    const retrying = new RetryingStorageChunkSource(source, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
    });
    let failures = 0;
    storage.beforeRange = async (n) => {
      if (n !== 1) return;
      storage.beforeRange = undefined;
      await publishGen1();
      clock.advance(TTL + 1);
      // The next tail read is the open of generation 1, where the stream moves.
      storage.beforeTail = async () => {
        storage.beforeTail = undefined;
        failures++;
        throw new TransientError('throttled');
      };
    };
    const got = await read(
      retrying,
      REF,
      Array.from({ length: CHUNKS }, (_, i) => i),
    );
    expect(failures).toBe(1);
    expect(got.chunks.map(parityOf)).toContain(1);
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
    const got = await read(retrying, REF, [0, 44]);
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
    await read(inner, REF, [0, 44], {
      retry: (request) => {
        outer++;
        return request();
      },
    });
    expect(outer).toBeGreaterThanOrEqual(2); // the resolution and each range
  });
});

describe('CrbmStorageChunkSource.getChunks: a stream across waves', () => {
  it('reads nothing, and resolves nothing, until the first chunk is asked for', async () => {
    const { source, storage } = await world();
    const stream = source.getChunks!(REF, [0, 44]);
    await new Promise((r) => setTimeout(r, 20));
    expect(storage.ranges).toHaveLength(0);
    const it = stream[Symbol.asyncIterator]();
    await it.next();
    expect(storage.ranges.length).toBeGreaterThan(0);
    await it.return!(undefined);
  });

  it('moves to the generation now current when a publish and a TTL lapse land between its ranges', async () => {
    const { source, storage, clock, publishGen1 } = await world();
    const it = source.getChunks!(REF, [0, 44], { concurrency: 1 })[Symbol.asyncIterator]();
    const first = await it.next();
    await publishGen1();
    clock.advance(TTL + 1); // the pointer is stale now, and a fresh resolution sees generation 1
    const second = await it.next();
    expect([first.value, second.value].map((c: ChunkRead) => parityOf(c.bytes))).toEqual([0, 1]);
    expect(first.value.version).toMatch(/^0:/);
    expect(second.value.version).toMatch(/^1:/);
    expect(storage.ranges.filter((r) => r.generation === 1)).toHaveLength(1);
  });

  it('heals forward between ranges: chunks already yielded stay, the rest come from the generation now current', async () => {
    const { source, storage, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 2) return;
      await publishGen1();
      await storage.delete({ ...REF, generation: 0 });
    };
    // Not `read`, which holds a stream to one generation: this is the case where a stream describes two.
    const items = await collect(source.getChunks!(REF, [0, 44], { concurrency: 1 }));
    expect(items.map((i) => i.key)).toEqual([0, 44]);
    expect(items.map((i) => parityOf(i.bytes))).toEqual([0, 1]);
    expect(items[0]!.version).toMatch(/^0:/);
    expect(items[1]!.version).toMatch(/^1:/);
  });

  it('counts positions, not keys, when it heals: a repeated key is not read or yielded twice over', async () => {
    const { source, storage, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n !== 2) return;
      await publishGen1();
      await storage.delete({ ...REF, generation: 0 });
    };
    const items = await collect(source.getChunks!(REF, [0, 0, 44], { concurrency: 1 }));
    expect(items.map((i) => i.key)).toEqual([0, 0, 44]);
    expect(items.map((i) => parityOf(i.bytes))).toEqual([0, 0, 1]);
  });

  it('heals again once it has made progress since the last heal', async () => {
    const { source, storage, registry, publishGen1 } = await world();
    storage.beforeRange = async (n) => {
      if (n === 1) {
        await publishGen1();
        await storage.delete({ ...REF, generation: 0 });
      }
      if (n === 3) {
        // The first range of the healed read has landed and been yielded; now the generation it read is swept too.
        await bulkLoadCrbmGeneration(storage, { ...REF, generation: 2 }, idsOf(0), { registry });
        await storage.delete({ ...REF, generation: 1 });
      }
    };
    const items = await collect(source.getChunks!(REF, [0, 44], { concurrency: 1 }));
    expect(items.map((i) => i.key)).toEqual([0, 44]);
    expect(items.map((i) => i.version)).toEqual([
      expect.stringMatching(/^1:/),
      expect.stringMatching(/^2:/),
    ]);
  });

  it('gives up on a second failure with no chunk yielded in between', async () => {
    const { source, storage } = await world();
    storage.beforeRange = (n) =>
      // A runaway heal loop ends in a different error, rather than spinning for ever.
      Promise.reject(n > 20 ? new Error('runaway heal loop') : new NotFoundError('gone'));
    await expect(read(source, REF, [0, 44])).rejects.toBeInstanceOf(NotFoundError);
    // The first try and one heal: each issues its two ranges, and nothing goes on after.
    expect(storage.ranges.length).toBeLessThanOrEqual(4);
  });

  it('bounds the requests in flight by `concurrency`, through the retrying wrapper too', async () => {
    const { source, storage } = await world();
    const retrying = new RetryingStorageChunkSource(source, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
    });
    storage.beforeRange = () => new Promise((r) => setTimeout(r, 5));
    // Chunks 0, 6, 12, … are a gap past 256 KiB apart: each is its own range.
    const keys = [0, 36, 40, 44];
    await collect(retrying.getChunks!(REF, keys, { concurrency: 1 }));
    expect(storage.peak).toBe(1);
    storage.peak = 0;
    await collect(source.getChunks!(REF, [0, 44], { concurrency: 2 }));
    expect(storage.peak).toBe(2);
  });

  it('times each range request with the source clock, and says how many bytes it moved', async () => {
    const { source, storage, clock } = await world();
    storage.beforeRange = async () => {
      clock.advance(7);
    };
    const requests: { bytes: number; ms: number }[] = [];
    await collect(source.getChunks!(REF, [0, 44], { onRequest: (r) => requests.push(r) }));
    expect(requests).toHaveLength(storage.ranges.length);
    expect(requests.map((r) => r.bytes).sort()).toEqual(storage.ranges.map((r) => r.length).sort());
    for (const r of requests) expect(r.ms).toBeGreaterThanOrEqual(7);
  });

  it('reports every range request it sent to onRequest, those a consumer that stopped left in flight included, through the retrying wrapper too', async () => {
    const { source, storage } = await world();
    const retrying = new RetryingStorageChunkSource(source, {
      clock: manualClock(),
      rng: { next: () => 0.5 },
    });
    storage.beforeRange = () => new Promise((r) => setTimeout(r, 5));
    for (const reading of [source, retrying]) {
      storage.ranges.length = 0;
      const requests: { bytes: number }[] = [];
      const stream = reading.getChunks!(REF, [0, 36, 40, 44], {
        concurrency: 4,
        onRequest: (r) => requests.push(r),
      })[Symbol.asyncIterator]();
      await stream.next();
      await stream.return?.();
      await new Promise((r) => setTimeout(r, 40));
      expect(storage.ranges.length).toBeGreaterThan(1);
      expect(requests).toHaveLength(storage.ranges.length);
    }
  });

  it('a stream that stops early leaves no unhandled failure behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { source, storage } = await world();
      storage.beforeRange = async (n) => {
        if (n > 1) throw new TransientError('down');
      };
      for await (const chunk of source.getChunks!(REF, [0, 40, 44])) {
        expect(chunk.key).toBe(0);
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

/** Twelve ranges of their own: every 34th of 400 chunks is asked for, each 33 chunks (past 256 KiB) from the next. */
const SPREAD = Array.from({ length: 12 }, (_, i) => i * 34);

describe('CrbmStorageChunkSource.getChunks: what a stream bounds, and what it refuses before it reads', () => {
  it.each([4, 8])(
    'never has more than `concurrency` (%i) requests in flight, across a heal either',
    async (width) => {
      const { source, storage, publishGen1 } = await world({ chunks: 400 });
      let swept: Promise<void> = Promise.resolve();
      storage.beforeRange = async (n) => {
        const generation = storage.ranges[n - 1]!.generation;
        if (generation === 0 && n === 4) {
          // The fourth range finds the object swept...
          swept = (async () => {
            await publishGen1();
            await storage.delete({ ...REF, generation: 0 });
          })();
          await swept;
        } else if (generation === 0 && n > 4) {
          // ...and the ones after it are slow: still in flight when the stream heals.
          await new Promise((r) => setTimeout(r, 5));
          await swept;
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      const items = await collect(source.getChunks!(REF, SPREAD, { concurrency: width }));
      expect(items.map((i) => i.key)).toEqual(SPREAD);
      expect(items[11]!.version).toMatch(/^1:/);
      expect(storage.peak).toBeLessThanOrEqual(width);
    },
  );

  it('refuses keys out of order before it resolves or reads anything, at the source, the pin and the pinned read', async () => {
    const { source, storage, registry, clock } = await world();
    const bad = [5, 3];
    const pin = (await source.pinGeneration(REF))!;
    // A source that has opened nothing: a refusal that came after resolving or opening would show as a request.
    const cold = new CrbmStorageChunkSource(storage, { registry, clock, currentGenTtlMs: TTL });
    storage.ranges = [];
    storage.tails = 0;
    await expect(read(cold, REF, bad)).rejects.toBeInstanceOf(ValidationError);
    await expect(collect(cold.getChunksAt(REF, 0, bad, pin))).rejects.toBeInstanceOf(
      ValidationError,
    );
    const wrapper = new PinnedStorageChunkSource(cold, new Map([[segmentKey(REF), pin]]));
    await expect(read(wrapper, REF, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(storage.ranges).toHaveLength(0);
    expect(storage.tails).toBe(0);
    // A repeated key is fine.
    expect((await read(source, REF, [3, 3, 5])).chunks).toHaveLength(3);
  });

  it('stops retrying the ranges of a stream that was abandoned: nothing is sent after the break but what was in flight', async () => {
    const { source, storage } = await world({ chunks: 400 });
    const retrying = new RetryingStorageChunkSource(source, {
      clock: { ...manualClock(), sleep: () => new Promise((r) => setTimeout(r, 15)) },
      rng: { next: () => 0.5 },
    });
    storage.beforeRange = async (n) => {
      if (n > 1) throw new TransientError('down');
    };
    for await (const chunk of retrying.getChunks!(REF, SPREAD, { concurrency: 4 })) {
      expect(chunk.key).toBe(0);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(storage.ranges).toHaveLength(4); // the four the window opened with, each tried once
  });
});

describe('CrbmStorageChunkSource.getChunks: a consumer that waits holds at most `concurrency` ranges and no chunk', () => {
  /** Sixteen ranges of their own, each a chunk of 8 KiB (every 34th of 560 chunks). */
  const KEYS = Array.from({ length: 16 }, (_, i) => i * 34);
  const modes = ['getChunks', 'getChunksAt', 'the pinned wrapper', 'the retrying wrapper'] as const;

  describe.each([
    { name: 'plain', encrypted: false },
    { name: 'encrypted', encrypted: true },
  ])('$name', ({ encrypted }) => {
    const keystore = encrypted
      ? new WatchingKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
      : undefined;
    let shared!: Awaited<ReturnType<typeof world>>;
    beforeAll(async () => {
      shared = await world({ chunks: 560, keystore });
    }, 60_000);

    it.each(modes.flatMap((mode) => [1, 4].map((width) => ({ mode, width }))))(
      '$mode at width $width',
      async ({ mode, width }) => {
        const { source, storage, clock } = shared;
        const ranges = new Watched();
        const gate = new Gate();
        const pin = (await source.pinGeneration(REF))!;
        const options = { concurrency: width };
        let stream: AsyncIterable<unknown>;
        if (mode === 'getChunks') stream = source.getChunks(REF, KEYS, options);
        else if (mode === 'getChunksAt') stream = source.getChunksAt(REF, 0, KEYS, pin, options);
        else if (mode === 'the pinned wrapper') {
          const wrapper = new PinnedStorageChunkSource(source, new Map([[segmentKey(REF), pin]]));
          stream = wrapper.getChunks!(REF, KEYS, options);
        } else {
          const retrying = new RetryingStorageChunkSource(source, {
            clock,
            rng: { next: () => 0.5 },
          });
          stream = retrying.getChunks!(REF, KEYS, options);
        }
        const it = stream[Symbol.asyncIterator]();
        await it.next().then(() => undefined); // resolves and opens; the reads from here on are watched
        storage.watch = { ranges, gate };
        ranges.reset();
        keystore?.plains.reset();
        const { worst, waits } = await worstWhileWaiting(
          () => it.next(),
          gate,
          async () => [await ranges.live(), (await keystore?.plains.live()) ?? 0],
          3,
        );
        await it.return!(undefined);
        expect(waits, 'the stream was caught waiting').toBeGreaterThanOrEqual(2);
        expect(worst[0]!, 'range buffers held').toBeLessThanOrEqual(width);
        expect(worst[1]!, 'decrypted chunks held').toBe(0);
      },
      60_000,
    );
  });
});

describe('CrbmStorageChunkSource.getChunks: a consumer that stops sends nothing more, on every path', () => {
  it.each(['getChunks', 'getChunksAt', 'the pinned wrapper'] as const)(
    'through %s, the requests in flight finish and are not tried again',
    async (mode) => {
      const { source, storage } = await world({ chunks: 400 });
      const pin = (await source.pinGeneration(REF))!;
      // A caller's runner that sends a request again after a transient fault, as a retrying caller would.
      const retry = async <T>(request: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await request();
          } catch (err) {
            if (!(err instanceof TransientError) || attempt >= 20) throw err;
            await tick(3);
          }
        }
      };
      storage.beforeRange = async (n) => {
        if (n > 1) throw new TransientError('down');
      };
      const options = { concurrency: 4, retry };
      let stream: AsyncIterable<{ key: number }>;
      if (mode === 'getChunks') stream = source.getChunks!(REF, SPREAD, options);
      else if (mode === 'getChunksAt') stream = source.getChunksAt(REF, 0, SPREAD, pin, options);
      else {
        const wrapper = new PinnedStorageChunkSource(source, new Map([[segmentKey(REF), pin]]));
        stream = wrapper.getChunks!(REF, SPREAD, options);
      }
      for await (const chunk of stream) {
        expect(chunk.key).toBe(0);
        break;
      }
      await tick(250);
      expect(storage.ranges).toHaveLength(4); // the four the window opened with, each tried once
      expect(storage.inFlight).toBe(0);
    },
  );
});

describe('CrbmStorageChunkSource.getChunks: a stream that fails', () => {
  it('raises at once when the failure is not one it heals, though a later read never answers', async () => {
    const { source, storage } = await world({ chunks: 400 });
    storage.beforeRange = async (n) => {
      if (n === 2) throw new Error('boom2');
      if (n === 3) await new Promise(() => {}); // a read that never answers
    };
    const outcome = (async () => {
      try {
        await collect(source.getChunks!(REF, SPREAD, { concurrency: 4 }));
        return 'finished';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    // Counted in turns of the event loop, not in time: a stream that waited for read 3 would still be pending.
    let turns = 0;
    let result: string | undefined;
    void outcome.then((r) => (result = r));
    while (result === undefined && turns < 50) {
      await new Promise((r) => setImmediate(r));
      turns++;
    }
    expect(result).toBe('boom2');
    expect(turns).toBeLessThan(50);
  });

  it('sends nothing more once it has failed, and the reads it left in flight never raise', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { source, storage } = await world({ chunks: 400 });
      const retrying = new RetryingStorageChunkSource(source, {
        clock: { ...manualClock(), sleep: () => new Promise((r) => setTimeout(r, 10)) },
        rng: { next: () => 0.5 },
      });
      storage.beforeRange = async (n) => {
        if (n === 1) throw new Error('not transient');
        await tick(20); // the others are slow, and then fail in a way that would be retried
        throw new TransientError('down');
      };
      await expect(collect(retrying.getChunks!(REF, SPREAD, { concurrency: 4 }))).rejects.toThrow(
        'not transient',
      );
      const sent = storage.ranges.length;
      expect(sent).toBe(4); // the window the stream opened with, each tried once
      await tick(300);
      expect(storage.ranges.length, 'no attempt after the failure').toBe(sent);
      expect(storage.inFlight).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
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
    expect((await read(source, REF, [0])).chunks.map(parityOf)).toEqual([1]);
    storage.ranges = [];
    const got = await read(wrapper, REF, [0, 1, 44]);
    expect(got.chunks.map(parityOf)).toEqual([0, 0, 0]);
    expect(storage.ranges.every((r) => r.generation === 0)).toBe(true);
    expect(got.version).toBe(await wrapper.currentVersion(REF));
    expect(got.version).toMatch(/^pin /);
  });

  it('refuses a pin whose object was replaced, whether the reader was open before or not', async () => {
    const warm = await pinned();
    await read(warm.wrapper, REF, [0]); // the pin's reader is open and remembered
    await replaceGen0(warm.storage);
    await expect(read(warm.wrapper, REF, [0, 44])).rejects.toBeInstanceOf(NotFoundError);

    const cold = await pinned();
    await replaceGen0(cold.storage);
    await expect(read(cold.wrapper, REF, [0, 44])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never moves to another generation: a pinned generation that was swept fails', async () => {
    const { wrapper, storage, publishGen1 } = await pinned();
    await publishGen1();
    storage.beforeRange = async (n) => {
      if (n === 1) await storage.delete({ ...REF, generation: 0 });
    };
    await expect(read(wrapper, REF, [0, 44])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes an unpinned segment to the live source, with the live version', async () => {
    const { wrapper, source, storage, registry } = await pinned();
    await bulkLoadCrbmGeneration(storage, { segment: 'other', generation: 0 }, idsOf(1), {
      registry,
    });
    const got = await read(wrapper, { segment: 'other' }, [0]);
    expect(got.chunks.map(parityOf)).toEqual([1]);
    expect(got.version).toBe(await source.currentVersion({ segment: 'other' }));
  });

  it('reads empty from a pin of a segment that had no generation', async () => {
    const { source } = await world();
    const wrapper = new PinnedStorageChunkSource(
      source,
      new Map([[segmentKey(REF), { generation: null, version: null }]]),
    );
    const none = await read(wrapper, REF, [0, 1]);
    expect(none.items).toEqual([
      { key: 0, bytes: null, version: null },
      { key: 1, bytes: null, version: null },
    ]);
  });
});
