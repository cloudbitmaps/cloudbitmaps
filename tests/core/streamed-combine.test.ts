/**
 * A combine reads each include operand, and each exclude read with it, as one stream of coalesced ranges. These cases
 * hold the engine's side of that to account against a source that records every stream it is asked to open: which
 * operands stream and which do not, what the budget does before anything opens, how the decoded-chunk cache is
 * used and keyed, what a stopped read leaves behind, and that every answer equals the per-key read's.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SegmentEngine, BoundedLru, CountingMetricsSink } from '@cloudbitmaps/core';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { BudgetExceededError, IntegrityError, ValidationError } from '@/core/errors';
import { chunkGenKey } from '@/core/keys';
import { roaringCodec } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

const clock = { now: () => 0 };
const ids = (chunks: readonly number[], per = 3): number[] =>
  chunks.flatMap((c) => Array.from({ length: per }, (_, i) => joinId(c, i + 1)));

function setup(
  segments: Record<string, number[]>,
  options: { cache?: boolean; budget?: number } = {},
) {
  const storage = new StreamChunkSource();
  for (const [name, set] of Object.entries(segments)) seedSegment(storage, name, set);
  const cache =
    options.cache === false
      ? undefined
      : new BoundedLru<string, CodecBitmap>({ maxEntries: 1_000, clock });
  const metrics = new CountingMetricsSink();
  const engine = new SegmentEngine({
    storage,
    codec: roaringCodec,
    ...(cache ? { cache } : {}),
    metrics,
    ...(options.budget === undefined ? {} : { budget: { maxRequests: options.budget } }),
  });
  return { storage, engine, cache, metrics };
}
const ref = (segment: string) => ({ segment });
const opened = (s: StreamChunkSource) => s.opened.map((o) => `${o.segment}:${o.keys.join(',')}`);

describe('which operands stream', () => {
  const A = ids([1, 2, 3, 4]);
  const B = ids([2, 3, 4, 9]);
  const S = ids([3, 4, 7]);

  it('an intersect streams each include, over the keys they share, with the combine ramp and concurrency', async () => {
    const { storage, engine } = setup({ a: A, b: B });
    await collect(engine.intersect([ref('a'), ref('b')], { concurrency: 16 }));
    expect(opened(storage).sort()).toEqual(['a:2,3,4', 'b:2,3,4']);
    expect(storage.opened[0]!.options).toMatchObject({ concurrency: 16, ramp: 4 });
    expect(storage.singles).toEqual([]);
  });

  it('a union streams each include over its own keys', async () => {
    const { storage, engine } = setup({ a: A, b: B });
    await collect(engine.union([ref('a'), ref('b')]));
    expect(opened(storage).sort()).toEqual(['a:1,2,3,4', 'b:2,3,4,9']);
  });

  it('an andNot streams its one include and the keys of each exclude it overlaps, in the same round', async () => {
    const { storage, engine } = setup({ a: A, s: S });
    await collect(engine.andNot(ref('a'), [ref('s')]));
    expect(opened(storage).sort()).toEqual(['a:1,2,3,4', 's:3,4']);
    expect(storage.singles).toEqual([]);
  });

  it('a union with an exclude streams the exclude too', async () => {
    const { storage, engine } = setup({ a: A, b: B, s: S });
    await collect(engine.union([ref('a'), ref('b')], { exclude: [ref('s')] }));
    expect(opened(storage).sort()).toEqual(['a:1,2,3,4', 'b:2,3,4,9', 's:3,4']);
  });

  it('an exclude that waits on an AND of two includes is read per key, only where the AND is not empty', async () => {
    const { storage, engine, metrics } = setup({
      a: ids([1, 2]),
      b: ids([2, 3, 1]),
      s: ids([1, 2]),
    });
    // `a` and `b` share keys 1 and 2; key 1's chunks are disjoint ids, so the AND is empty there.
    seedSegment(storage, 'a', [joinId(1, 10), ...ids([2])]);
    seedSegment(storage, 'b', [joinId(1, 11), ...ids([2, 3])]);
    await collect(engine.intersect([ref('a'), ref('b')], { exclude: [ref('s')] }));
    expect(opened(storage).sort()).toEqual(['a:1,2', 'b:1,2']);
    expect(storage.singles).toEqual(['s:2']); // key 1 emptied the AND: its exclude chunk was never read
    // Four chunks of the includes and the one exclude chunk looked up: no lookup for an exclude chunk that is never read.
    expect(metrics.snapshot().cache.misses).toBe(5);
  });

  it('a source with no getChunks is read chunk by chunk, as before', async () => {
    const plain = new MemoryStorageChunkSource();
    seedSegment(plain, 'a', A);
    seedSegment(plain, 'b', B);
    const engine = new SegmentEngine({ storage: plain, codec: roaringCodec });
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([2, 3, 4]));
  });

  it('a segment the source says has no generation is not streamed', async () => {
    const { storage, engine } = setup({ a: A });
    storage.version = null;
    expect(await collect(engine.union([ref('a')]))).toEqual([]);
    expect(storage.opened).toEqual([]);
  });

  it('a stream is not opened, and nothing is read, until the read is iterated', async () => {
    const { storage, engine } = setup({ a: A, b: B });
    const stream = engine.intersect([ref('a'), ref('b')]);
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.opened).toEqual([]);
    await stream.next();
    expect(storage.opened.length).toBeGreaterThan(0);
    await stream.return(undefined);
  });
});

describe('the budget is checked before any stream opens', () => {
  it('a refusal opens nothing and reads nothing, and the units are the chunk reads', async () => {
    const A = ids([1, 2, 3, 4]);
    const S = ids([3, 4]);
    const { storage, engine, metrics } = setup({ a: A, s: S }, { budget: 5 });
    await expect(collect(engine.andNot(ref('a'), [ref('s')]))).rejects.toThrow(BudgetExceededError);
    expect(storage.opened).toEqual([]);
    expect(storage.singles).toEqual([]);
    // Nor does it report work it never did: no `intersect` event, no cache lookup for a chunk it will not read.
    expect(metrics.snapshot().intersect.calls).toBe(0);
    expect(metrics.snapshot().cache).toEqual({ hits: 0, misses: 0 });
    // 4 chunks of the include and 2 of the exclude: six reads fit a budget of six, not five.
    const fits = setup({ a: A, s: S }, { budget: 6 });
    await collect(fits.engine.andNot(ref('a'), [ref('s')]));
  });
});

describe('the decoded-chunk cache', () => {
  const A = ids([1, 2, 3, 4]);
  const B = ids([1, 2, 3, 4]);

  it('serves a repeat read from the cache: no stream is opened for chunks it holds', async () => {
    const { storage, engine } = setup({ a: A, b: B });
    await collect(engine.intersect([ref('a'), ref('b')]));
    storage.opened.length = 0;
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([1, 2, 3, 4]));
    expect(storage.opened).toEqual([]);
  });

  it('asks only for the chunks it does not hold, and still answers in order', async () => {
    const { storage, engine } = setup({ a: A, b: B });
    await collect(
      engine.intersect([ref('a'), ref('b')], { after: joinId(2, 3), through: joinId(3, 3) }),
    );
    storage.opened.length = 0;
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([1, 2, 3, 4]));
    expect(storage.opened.map((o) => o.keys.join(',')).sort()).toEqual(['1,4', '1,4']);
  });

  it('caches a chunk under the version it was read from, not the version the read planned under', async () => {
    const { storage, engine, cache } = setup({ a: A });
    storage.readVersion = () => 'v2'; // the source answers a newer generation than `currentVersion` said
    await collect(engine.union([ref('a')]));
    const a = ref('a');
    expect(cache!.peek(chunkGenKey({ ...a, chunkKey: 1 }, 'v2'))).toBeDefined();
    expect(cache!.peek(chunkGenKey({ ...a, chunkKey: 1 }, 'v1'))).toBeUndefined();
  });

  it('does not cache what a stream delivers after the segment was invalidated', async () => {
    const { storage, engine, cache } = setup({ a: A });
    storage.beforeYield = (stream, key) => {
      if (key === 3) engine.invalidate(ref('a')); // a destructive verb lands mid-read
      void stream;
    };
    await collect(engine.union([ref('a')]));
    const a = ref('a');
    for (const key of [1, 2, 3, 4]) {
      // 1 and 2 were delivered before it and were dropped by the invalidation itself; 3 and 4 came after it.
      expect(cache!.peek(chunkGenKey({ ...a, chunkKey: key }, 'v1')), `key ${key}`).toBeUndefined();
    }
  });

  it('looks a chunk the cache held at open up again when it is asked for: an invalidation in between has it read afresh', async () => {
    const { storage, engine } = setup({ a: ids([1, 2, 3, 4, 5, 6]) });
    await collect(engine.union([ref('a')])); // every chunk is in the cache now
    storage.opened.length = 0;
    const seen: number[] = [];
    for await (const id of engine.iterate(ref('a'))) {
      seen.push(id);
      if (seen.length === 1) {
        // The segment changes under the store, and the store is told: its cached chunks are gone.
        seedSegment(
          storage,
          'a',
          [1, 2, 3, 4, 5, 6].flatMap((c) => [joinId(c, 10), joinId(c, 11)]),
        );
        engine.invalidate(ref('a'));
      }
    }
    // Chunk 1 was already in hand; chunks 2 to 6 were looked up when asked for, found gone, and read from the source,
    // as one stream over the chunks that were not there.
    expect(seen.slice(0, 3)).toEqual([joinId(1, 1), joinId(1, 2), joinId(1, 3)]);
    expect(seen.slice(3)).toEqual([2, 3, 4, 5, 6].flatMap((c) => [joinId(c, 10), joinId(c, 11)]));
    expect(opened(storage)).toEqual(['a:2,3,4,5,6']);
  });

  it('a chunk the LRU dropped between two cached chunks is read afresh, and the rest stay served from the cache', async () => {
    const { storage, engine, cache } = setup({ a: ids([1, 2, 3, 4, 5]) });
    await collect(engine.union([ref('a')]));
    storage.opened.length = 0;
    const seen: number[] = [];
    for await (const id of engine.iterate(ref('a'))) {
      seen.push(id);
      if (seen.length === 1) cache!.delete(chunkGenKey({ ...ref('a'), chunkKey: 3 }, 'v1'));
    }
    expect(seen).toEqual(ids([1, 2, 3, 4, 5]));
    // Chunk 3 was the first chunk the cache no longer held, so the stream opens there; chunks 4 and 5 were looked up again.
    expect(opened(storage)).toEqual(['a:3']);
  });

  it('a chunk that was cached when the stream opened and is gone when asked for is read on its own', async () => {
    const { storage, engine, cache } = setup({ a: ids([1, 2, 3, 4, 5]) });
    await collect(engine.union([ref('a')]));
    cache!.delete(chunkGenKey({ ...ref('a'), chunkKey: 2 }, 'v1')); // the stream opens at chunk 2
    storage.opened.length = 0;
    const seen: number[] = [];
    for await (const id of engine.iterate(ref('a'))) {
      seen.push(id);
      if (seen.length === 4) cache!.delete(chunkGenKey({ ...ref('a'), chunkKey: 4 }, 'v1'));
    }
    expect(seen).toEqual(ids([1, 2, 3, 4, 5]));
    expect(opened(storage)).toEqual(['a:2']);
    expect(storage.singles).toEqual(['a:4']);
  });

  describe('a warm read opens no stream', () => {
    const A = ids([1, 2, 3, 4]);
    const B = ids([2, 3, 4, 9]);
    const S = ids([3, 4, 7]);

    /** Counts every `getChunks` call (a stream, or the one-key stream of a read of one chunk). */
    function counted(storage: StreamChunkSource): { calls: number } {
      const count = { calls: 0 };
      const original = storage.getChunks.bind(storage);
      storage.getChunks = (...args: Parameters<typeof original>) => {
        count.calls += 1;
        return original(...args);
      };
      return count;
    }
    const reads: Record<string, (e: SegmentEngine) => AsyncIterable<unknown>> = {
      intersect: (e) => e.intersect([ref('a'), ref('b')]),
      union: (e) => e.union([ref('a'), ref('b')]),
      andNot: (e) => e.andNot(ref('a'), [ref('s')]),
      'intersect batches': (e) => e.intersectBatches([ref('a'), ref('b')]),
      'union with an exclude': (e) => e.union([ref('a'), ref('b')], { exclude: [ref('s')] }),
      iterate: (e) => e.iterate(ref('a')),
      'iterate batches': (e) => e.iterateBatches(ref('a')),
    };

    for (const [name, read] of Object.entries(reads)) {
      it(`${name}: every chunk cached, so getChunks is not called`, async () => {
        const { storage, engine, metrics } = setup({ a: A, b: B, s: S });
        const first = await collect(read(engine) as AsyncGenerator<number | Uint32Array>);
        const calls = counted(storage);
        const before = metrics.snapshot();
        const again = await collect(read(engine) as AsyncGenerator<number | Uint32Array>);
        expect(again).toEqual(first);
        expect(calls.calls).toBe(0);
        // Each chunk is one lookup and counted once, as a hit.
        const after = metrics.snapshot();
        expect(after.cache.misses).toBe(before.cache.misses);
        expect(after.cache.hits).toBeGreaterThan(before.cache.hits);
      });
    }

    it('counts one hit per chunk looked up', async () => {
      const { engine, metrics } = setup({ a: A, b: B });
      await collect(engine.intersect([ref('a'), ref('b')]));
      const before = metrics.snapshot().cache;
      await collect(engine.intersect([ref('a'), ref('b')]));
      const after = metrics.snapshot().cache;
      expect(after.hits - before.hits).toBe(6); // chunks 2, 3, 4 of each operand
      expect(after.misses).toBe(before.misses);
    });
  });

  describe('an operand that is partly cached streams only the chunks that are not', () => {
    const A = ids([1, 2, 3, 4, 5, 6]);

    it('the first chunks cached: the stream opens at the first miss', async () => {
      const { storage, engine } = setup({ a: A });
      await collect(engine.union([ref('a')], { after: joinId(0, 0), through: joinId(2, 3) }));
      storage.opened.length = 0;
      expect(await collect(engine.union([ref('a')]))).toEqual(A);
      expect(opened(storage)).toEqual(['a:3,4,5,6']);
    });

    it('the last chunks (4 to 6) cached: the stream carries the chunks before them only', async () => {
      const { storage, engine } = setup({ a: A });
      await collect(engine.union([ref('a')], { after: joinId(4, 3) }));
      storage.opened.length = 0;
      expect(await collect(engine.union([ref('a')]))).toEqual(A);
      expect(opened(storage)).toEqual(['a:1,2,3']);
    });

    it('chunks cached on either side of the misses are not asked of the source', async () => {
      const { storage, engine, cache } = setup({ a: A });
      await collect(engine.union([ref('a')]));
      for (const key of [2, 5]) cache!.delete(chunkGenKey({ ...ref('a'), chunkKey: key }, 'v1'));
      storage.opened.length = 0;
      expect(await collect(engine.iterate(ref('a')))).toEqual(A);
      expect(opened(storage)).toEqual(['a:2,5']);
    });

    it('an include and an exclude are each opened over their own misses', async () => {
      const { storage, engine, cache } = setup({ a: A, s: ids([2, 3]) });
      await collect(engine.andNot(ref('a'), [ref('s')]));
      cache!.delete(chunkGenKey({ ...ref('a'), chunkKey: 6 }, 'v1'));
      cache!.delete(chunkGenKey({ ...ref('s'), chunkKey: 3 }, 'v1'));
      storage.opened.length = 0;
      expect(await collect(engine.andNot(ref('a'), [ref('s')]))).toEqual(ids([1, 4, 5, 6]));
      expect(opened(storage).sort()).toEqual(['a:6', 's:3']);
    });
  });

  it('a cache that is smaller than the read still answers correctly', async () => {
    const storage = new StreamChunkSource();
    seedSegment(storage, 'a', ids([1, 2, 3, 4, 5, 6]));
    const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 2, clock });
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache });
    expect(await collect(engine.union([ref('a')]))).toEqual(ids([1, 2, 3, 4, 5, 6]));
    expect(await collect(engine.union([ref('a')]))).toEqual(ids([1, 2, 3, 4, 5, 6]));
  });

  it('works with no cache at all', async () => {
    const { engine } = setup({ a: A, b: B }, { cache: false });
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([1, 2, 3, 4]));
  });

  it('a source with no version keys the cache by segment and chunk alone', async () => {
    const { storage, engine, cache } = setup({ a: A });
    (storage as { currentVersion?: unknown }).currentVersion = undefined;
    storage.readVersion = () => 'ignored';
    await collect(engine.union([ref('a')]));
    expect(cache!.peek(`${'a'}\u0000${1}`)).toBeUndefined(); // not the versioned key
    storage.opened.length = 0;
    await collect(engine.union([ref('a')]));
    expect(storage.opened).toEqual([]); // but cached under the key a versionless source uses
  });
});

describe('metrics', () => {
  it('reports one storage.get per range request, with its bytes, and a cache event per lookup', async () => {
    const { storage, engine, metrics } = setup({ a: ids([1, 2, 3, 4, 5, 6]) });
    storage.perRequest = 3; // two requests for six chunks
    await collect(engine.union([ref('a')]));
    const snap = metrics.snapshot();
    expect(snap.storage.gets).toBe(2);
    expect(snap.cache.misses).toBe(6);
    expect(snap.cache.hits).toBe(0);
  });
});

describe('a read that stops', () => {
  it('does not cache a chunk whose source gave it no version', async () => {
    const { storage, engine, cache } = setup({ a: ids([1, 2, 3]) });
    storage.readVersion = () => null;
    expect(await collect(engine.union([ref('a')]))).toEqual(ids([1, 2, 3]));
    expect(cache!.size).toBe(0);
    await collect(engine.union([ref('a')]));
    expect(opened(storage)).toEqual(['a:1,2,3', 'a:1,2,3']); // read again, not served from the cache
  });

  it('stops an iterate stream that its consumer leaves early', async () => {
    const { storage, engine } = setup({ a: ids([1, 2, 3, 4, 5, 6]) });
    for await (const id of engine.iterate(ref('a'))) {
      void id;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.opened).toHaveLength(1);
    expect(storage.opened[0]!.closedEarly).toBe(true);
  });

  it('closes the streams it opened, early or on an error', async () => {
    const { storage, engine } = setup({ a: ids([1, 2, 3, 4, 5, 6]), b: ids([1, 2, 3, 4, 5, 6]) });
    for await (const id of engine.intersect([ref('a'), ref('b')])) {
      void id;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.opened.every((o) => o.closedEarly)).toBe(true);

    const failing = setup({ a: ids([1, 2, 3]) });
    failing.storage.beforeYield = (_, key) => {
      if (key === 2) throw new Error('boom');
    };
    await expect(collect(failing.engine.union([ref('a')]))).rejects.toThrow('boom');
  });

  it('surfaces a stream that answers the wrong key, or ends early, as IntegrityError', async () => {
    const wrong = setup({ a: ids([1, 2, 3]) });
    wrong.storage.misalign = (_, key) => (key === 2 ? 3 : key);
    await expect(collect(wrong.engine.union([ref('a')]))).rejects.toBeInstanceOf(IntegrityError);

    const short = setup({ a: ids([1, 2, 3]) });
    const original = short.storage.getChunks.bind(short.storage);
    short.storage.getChunks = (r, keys, o) => original(r, keys.slice(0, 2), o);
    await expect(collect(short.engine.union([ref('a')]))).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('single-flight', () => {
  it('is not applied across streams: two concurrent cold combines each read, while per-key reads still share', async () => {
    const { storage, engine } = setup({ a: ids([1, 2, 3]) });
    await Promise.all([collect(engine.union([ref('a')])), collect(engine.union([ref('a')]))]);
    expect(storage.opened).toHaveLength(2);

    const solo = setup({ a: ids([1]) });
    await Promise.all([engine_has(solo.engine), engine_has(solo.engine)]);
    expect(solo.storage.singles).toHaveLength(1);
  });
});
const engine_has = (engine: SegmentEngine): Promise<boolean> => engine.has(ref('a'), joinId(1, 1));

describe('a point read through a source with getChunks', () => {
  it('is a one-key stream with no window options, and is reported once, from the request the source sent', async () => {
    const { storage, engine, metrics } = setup({ a: ids([1, 2]) });
    expect(await engine_has(engine)).toBe(true);
    expect(storage.singles).toEqual(['a:1']);
    expect(storage.opened).toEqual([]);
    expect(metrics.snapshot().storage.gets).toBe(1);
  });

  it('reports nothing when the source sent no request for the chunk', async () => {
    const { storage, engine, metrics } = setup({ a: ids([1]) });
    storage.reportNone = true;
    expect(await engine_has(engine)).toBe(true);
    expect(metrics.snapshot().storage.gets).toBe(0);
  });

  it('caches the chunk under the version it was read from, not the one the read planned under', async () => {
    const { storage, engine, cache } = setup({ a: ids([1]) });
    storage.readVersion = () => 'v2';
    await engine_has(engine);
    expect(cache!.peek(chunkGenKey({ ...ref('a'), chunkKey: 1 }, 'v2'))).toBeDefined();
    expect(cache!.peek(chunkGenKey({ ...ref('a'), chunkKey: 1 }, 'v1'))).toBeUndefined();
  });

  it('does not cache a chunk whose source gave it no version, and reads it again', async () => {
    const { storage, engine, cache } = setup({ a: ids([1]) });
    storage.readVersion = () => null;
    expect(await engine_has(engine)).toBe(true);
    expect(cache!.size).toBe(0);
    await engine_has(engine);
    expect(storage.singles).toHaveLength(2);
  });

  it('surfaces the typed error the stream raises, and reads again after it', async () => {
    const { storage, engine } = setup({ a: ids([1]) });
    storage.beforeYield = () => {
      throw new IntegrityError('bad chunk');
    };
    await expect(engine_has(engine)).rejects.toBeInstanceOf(IntegrityError);
    storage.beforeYield = undefined;
    expect(await engine_has(engine)).toBe(true);
  });

  it('does not cache a read whose segment was invalidated while it ran', async () => {
    const { storage, engine, cache } = setup({ a: ids([1]) });
    storage.beforeYield = async () => {
      await Promise.resolve(); // the read has been registered by now, as a call made while it runs
      engine.invalidate(ref('a'));
    };
    await engine_has(engine);
    expect(cache!.size).toBe(0);
  });
});

describe('the streamed read equals the per-key read', () => {
  const key = fc.integer({ min: 0, max: 9 });
  const set = fc.uniqueArray(key, { maxLength: 8 });
  const ID = fc.integer({ min: 0, max: 10 * 65_536 - 1 });
  const range = fc.record(
    { after: fc.option(ID, { nil: undefined }), through: fc.option(ID, { nil: undefined }) },
    { requiredKeys: [] },
  );

  it('for random operands, excludes, ranges and concurrency, on intersect, union and andNot', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(set, set, set),
        range,
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 5 }),
        async ([a, b, s], r, concurrency, perRequest) => {
          const make = (streams: boolean) => {
            const storage = streams ? new StreamChunkSource() : new MemoryStorageChunkSource();
            if (streams) (storage as StreamChunkSource).perRequest = perRequest;
            for (const [n, c] of [
              ['a', a],
              ['b', b],
              ['s', s],
            ] as const)
              seedSegment(storage, n, ids(c, 2));
            return new SegmentEngine({ storage, codec: roaringCodec });
          };
          const options = { ...r, concurrency };
          const reads = (e: SegmentEngine) => [
            () => e.intersect([ref('a'), ref('b')], options),
            () => e.intersect([ref('a'), ref('b')], { ...options, exclude: [ref('s')] }),
            () => e.union([ref('a'), ref('b')], options),
            () => e.union([ref('a'), ref('b')], { ...options, exclude: [ref('s')] }),
            () => e.andNot(ref('a'), [ref('s')], options),
            () => e.andNot(ref('a'), [ref('s'), ref('b')], options),
          ];
          const streamed = reads(make(true));
          const perKey = reads(make(false));
          for (const [i, read] of streamed.entries()) {
            // A segment with no chunks is an absent operand: a refusal both ways, equally.
            const want = await collect(perKey[i]!()).catch((e: unknown) => (e as Error).name);
            const got = await collect(read()).catch((e: unknown) => (e as Error).name);
            expect(got).toEqual(want);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('refuses a bad concurrency as it always has', async () => {
    const { engine } = setup({ a: ids([1]) });
    await expect(collect(engine.union([ref('a')], { concurrency: 0 }))).rejects.toThrow(
      ValidationError,
    );
  });
});
