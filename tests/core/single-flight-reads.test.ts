/**
 * Concurrent reads of one chunk share one storage request.
 *
 * The source parks every read on a timer, so callers that arrive while a read is open really do overlap. Each case
 * counts the requests the source saw, which is the number the change is about.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SegmentEngine } from '@/core/engine';
import { BoundedLru } from '@/core/lru';
import { CountingMetricsSink } from '@/index';
import type { CodecBitmap } from '@/core/codec';
import type { ChunkRef } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { seedSegment } from '../helpers/loaded';

const K = 65_536;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A source whose reads take `delayMs` and are counted; `version` is what `currentVersion` reports. */
class ParkedSource extends MemoryStorageChunkSource {
  requests: number[] = [];
  version: string | undefined = 'v1';
  failNext: Error | undefined;
  /** Bytes served per version, when a test wants each generation to hold different data. */
  readonly byVersion = new Map<string, MemoryStorageChunkSource>();
  constructor(private readonly delayMs = 15) {
    super();
  }

  currentVersion(): Promise<string | null> {
    return Promise.resolve(this.version ?? null);
  }

  override async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.requests.push(ref.chunkKey);
    const served = this.byVersion.get(this.version ?? '') ?? this;
    const error = this.failNext;
    await sleep(this.delayMs);
    if (error) {
      this.failNext = undefined;
      throw error;
    }
    return served === this ? super.getChunk(ref) : served.getChunk(ref);
  }
}

const lru = (): BoundedLru<string, CodecBitmap> =>
  new BoundedLru<string, CodecBitmap>({ maxEntries: 1000, clock: { now: () => 0 } });

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

const drain = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
};

describe('concurrent cold reads of one chunk share one request', () => {
  for (const cached of [true, false]) {
    it(`50 concurrent has() of one chunk make one read (cache ${cached ? 'on' : 'off'})`, async () => {
      const storage = new ParkedSource();
      seedSegment(storage, 'a', [5, 9]);
      const engine = new SegmentEngine({
        storage,
        codec: roaringCodec,
        cache: cached ? lru() : undefined,
      });
      const answers = await Promise.all(
        Array.from({ length: 50 }, (_, i) => engine.has({ segment: 'a' }, i % 2 === 0 ? 5 : 6)),
      );
      expect(answers).toEqual(Array.from({ length: 50 }, (_, i) => i % 2 === 0));
      expect(storage.requests).toEqual([0]);
      expect(unhandled).toEqual([]);
    });
  }

  it('an absent chunk is shared too', async () => {
    const storage = new ParkedSource();
    seedSegment(storage, 'a', [5]);
    const engine = new SegmentEngine({ storage, codec: roaringCodec });
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => engine.has({ segment: 'a' }, 3 * K + 1)),
    );
    expect(answers.every((a) => !a)).toBe(true);
    expect(storage.requests).toEqual([3]);
  });

  it('a read after the first has settled hits the cache; with no cache it reads again', async () => {
    for (const cached of [true, false]) {
      const storage = new ParkedSource();
      seedSegment(storage, 'a', [5]);
      const engine = new SegmentEngine({
        storage,
        codec: roaringCodec,
        cache: cached ? lru() : undefined,
      });
      await engine.has({ segment: 'a' }, 5);
      await engine.has({ segment: 'a' }, 5);
      expect(storage.requests.length).toBe(cached ? 1 : 2);
    }
  });

  it('andNot(a, [a]) over N chunks reads each chunk once and is empty', async () => {
    const storage = new ParkedSource();
    const n = 6;
    seedSegment(
      storage,
      'a',
      Array.from({ length: n }, (_, k) => k * K + 7),
    );
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache: lru() });
    const out = await drain(engine.andNot({ segment: 'a' }, [{ segment: 'a' }]));
    expect(out).toEqual([]);
    expect([...storage.requests].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('does not share across generations: each caller gets the chunk of its own generation', async () => {
    const storage = new ParkedSource();
    const v1 = new MemoryStorageChunkSource();
    const v2 = new MemoryStorageChunkSource();
    seedSegment(v1, 'a', [1]);
    seedSegment(v2, 'a', [2]);
    storage.byVersion.set('v1', v1);
    storage.byVersion.set('v2', v2);
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache: lru() });

    storage.version = 'v1';
    const first = engine.has({ segment: 'a' }, 1);
    await sleep(2); // the first call has resolved its version and its read is open
    storage.version = 'v2';
    const second = engine.has({ segment: 'a' }, 2);
    const secondOnV1Id = engine.has({ segment: 'a' }, 1);
    expect(await Promise.all([first, second, secondOnV1Id])).toEqual([true, true, false]);
    expect(storage.requests).toEqual([0, 0]); // two reads of chunk 0, one per version
  });

  it('a failed shared read rejects every joiner, leaves nothing unhandled, and the next call reads again', async () => {
    const storage = new ParkedSource();
    seedSegment(storage, 'a', [5]);
    storage.failNext = new Error('boom');
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache: lru() });
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => engine.has({ segment: 'a' }, 5)),
    );
    expect(settled.every((s) => s.status === 'rejected' && String(s.reason).includes('boom'))).toBe(
      true,
    );
    expect(storage.requests).toEqual([0]);
    await sleep(5);
    expect(unhandled).toEqual([]);
    expect(await engine.has({ segment: 'a' }, 5)).toBe(true);
    expect(storage.requests).toEqual([0, 0]);
  });

  it('a read that began before invalidate() is not joined by a call made after it', async () => {
    const storage = new ParkedSource();
    seedSegment(storage, 'a', [5]);
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache: lru() });
    const before = engine.has({ segment: 'a' }, 5);
    await sleep(2);
    engine.invalidate({ segment: 'a' });
    const after = engine.has({ segment: 'a' }, 5);
    await Promise.all([before, after]);
    expect(storage.requests).toEqual([0, 0]);
  });
});

describe('an invalidated read settling', () => {
  it('leaves the read that replaced it open for later callers to join', async () => {
    const storage = new ParkedSource(40);
    seedSegment(storage, 'a', [5]);
    const engine = new SegmentEngine({ storage, codec: roaringCodec });
    const first = engine.has({ segment: 'a' }, 5);
    await sleep(10);
    engine.invalidate({ segment: 'a' });
    const second = engine.has({ segment: 'a' }, 5); // a new read, opened 10 ms after the first
    await first; // the first settles while the second is still open
    const third = engine.has({ segment: 'a' }, 5);
    await Promise.all([second, third]);
    expect(storage.requests).toEqual([0, 0]);
  });
});

describe('metrics under sharing', () => {
  it('emits one storage.get per request; every caller that found no cached chunk counts a miss', async () => {
    const storage = new ParkedSource();
    seedSegment(storage, 'a', [5]);
    const metrics = new CountingMetricsSink();
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache: lru(), metrics });
    await Promise.all(Array.from({ length: 8 }, () => engine.has({ segment: 'a' }, 5)));
    let snap = metrics.snapshot();
    expect(snap.storage.gets).toBe(1);
    expect(snap.cache).toEqual({ hits: 0, misses: 8 });
    await engine.has({ segment: 'a' }, 5);
    snap = metrics.snapshot();
    expect(snap.storage.gets).toBe(1);
    expect(snap.cache).toEqual({ hits: 1, misses: 8 });
  });

  it('with no cache configured, joiners emit no cache event and there is still one storage.get', async () => {
    const storage = new ParkedSource();
    seedSegment(storage, 'a', [5]);
    const metrics = new CountingMetricsSink();
    const engine = new SegmentEngine({ storage, codec: roaringCodec, metrics });
    await Promise.all(Array.from({ length: 8 }, () => engine.has({ segment: 'a' }, 5)));
    const snap = metrics.snapshot();
    expect(snap.storage.gets).toBe(1);
    expect(snap.cache).toEqual({ hits: 0, misses: 0 });
  });
});
