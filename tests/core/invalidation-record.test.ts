/**
 * The record of invalidations an engine's scope keeps, held to what it must and must not do: every invalidation of a
 * segment is recorded, the oldest is the one forgotten, the floor goes on rising, each read takes its epoch before it
 * resolves its generation, and only a `SegmentEngine` over the same cache can be shared with.
 *
 * Forgetting too much costs only cache entries, so the cases that must not cache are the ones that guard against a
 * stale chunk, and the cases that must cache guard against a record that stops every stream caching.
 */
import { describe, expect, it } from 'vitest';
import { BoundedLru, SegmentEngine, ValidationError } from '@cloudbitmaps/core';
import type { CodecBitmap, SegmentRef } from '@cloudbitmaps/core';
import type { StorageChunkSource } from '@cloudbitmaps/core/driver-kit';
import { storeCodec } from '../helpers/store-codec';
import { joinId } from '@/core/bit-route';
import { REMEMBERED_INVALIDATIONS } from '@/core/invalidation-scope';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

const clock = { now: () => 0 };
const CHUNKS = 200;
const s: SegmentRef = { segment: 's' };

function setup() {
  const source = new StreamChunkSource();
  seedSegment(
    source,
    's',
    Array.from({ length: CHUNKS }, (_, c) => joinId(c, 1)),
  );
  const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 10_000, clock });
  const engine = new SegmentEngine({ storage: source, codec: storeCodec, cache });
  return { source, cache, engine };
}

/** Whether the last chunk is read again after `it` is drained: false means the stream cached it. */
async function lastChunkReadAgain(
  source: StreamChunkSource,
  engine: SegmentEngine,
  it: AsyncIterator<number>,
): Promise<boolean> {
  for (let r = await it.next(); r.done !== true; r = await it.next());
  const before = source.singles.length;
  expect(await engine.has(s, joinId(CHUNKS - 1, 1))).toBe(true);
  return source.singles.length === before + 1;
}

describe('the record of invalidations', () => {
  // A second invalidation of a segment is recorded too, not left at the first one's epoch.
  it('a stream opened between two invalidations of its segment does not cache after the second', async () => {
    const { source, engine } = setup();
    engine.invalidate(s); // first
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    await it.next(); // opens after the first, before the second
    engine.invalidate(s); // second, while the stream is open
    expect(await lastChunkReadAgain(source, engine, it)).toBe(true);
  });

  // The floor goes on rising past its first eviction: the segment's own entry is evicted after the floor has risen
  // once, so only a floor that has kept rising still covers it.
  it('a segment evicted from the record after the floor has already risen once still counts as invalidated', async () => {
    const { source, engine } = setup();
    for (let i = 0; i < REMEMBERED_INVALIDATIONS; i++) engine.invalidate({ segment: `o${i}` });
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    await it.next();
    engine.invalidate(s);
    // Enough others to push s's own entry out, each one raising the floor past s's epoch in turn.
    for (let i = 0; i < REMEMBERED_INVALIDATIONS; i++) engine.invalidate({ segment: `p${i}` });
    expect(await lastChunkReadAgain(source, engine, it)).toBe(true);
  });

  // The oldest entry is the one forgotten, so the floor rises only to its epoch: a stream that opened after every
  // forgotten invalidation keeps caching a segment the record never held.
  it('forgetting the oldest invalidation does not stop a later stream caching an unrelated segment', async () => {
    const { source, engine } = setup();
    for (let i = 0; i < REMEMBERED_INVALIDATIONS; i++) engine.invalidate({ segment: `o${i}` });
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    await it.next();
    engine.invalidate({ segment: 'x' }); // the record is full: the oldest, o0, goes
    expect(await lastChunkReadAgain(source, engine, it)).toBe(false);
  });

  // A segment invalidated again moves to the newest end of the record. Left in its old place, it would be forgotten
  // first, raising the floor to its new, high epoch.
  it('a re-invalidated segment moves to the newest end of the record', async () => {
    const { source, engine } = setup();
    for (let i = 0; i < REMEMBERED_INVALIDATIONS; i++) engine.invalidate({ segment: `o${i}` });
    const it = engine.iterate(s)[Symbol.asyncIterator]();
    await it.next();
    engine.invalidate({ segment: 'o0' }); // again: now the newest
    engine.invalidate({ segment: 'x' }); // forgets the oldest, which is o1, not o0
    expect(await lastChunkReadAgain(source, engine, it)).toBe(false);
  });
});

describe('an invalidation while a read resolves its generation, on a source with no currentVersion', () => {
  // The same fixture as stream-cache-generation.test.ts, with per-chunk counts for everyNth.
  function setupResolving(onResolve: (engine: SegmentEngine) => void) {
    const inner = new StreamChunkSource();
    seedSegment(
      inner,
      'a',
      [1, 2, 3].map((c) => joinId(c, 1)),
    );
    seedSegment(
      inner,
      'b',
      [1, 2, 3].map((c) => joinId(c, 1)),
    );
    const listed: string[] = [];
    const storage: StorageChunkSource = {
      getChunk: (r) => inner.getChunk(r),
      listChunkKeys: (r) => {
        listed.push(r.segment);
        return inner.listChunkKeys(r);
      },
      getChunks: (r, keys, options) => inner.getChunks(r, keys, options),
      cardinalities: () =>
        Promise.resolve(
          new Map([
            [1, 1],
            [2, 1],
            [3, 1],
          ]),
        ),
      currentGeneration: () => {
        onResolve(engine);
        return Promise.resolve(7);
      },
    };
    const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 1_000, clock });
    const engine = new SegmentEngine({ storage, codec: storeCodec, cache });
    return { cache, engine, listed };
  }
  const fireOnce = () => {
    let fired = false;
    return (engine: SegmentEngine) => {
      if (fired) return;
      fired = true;
      engine.invalidate({ segment: 'a' });
    };
  };

  // Each read takes the epoch current when it begins, not a constant: an invalidation of another segment long before
  // the read does not stop it caching.
  it.each([
    [
      'iterate over a range',
      (e: SegmentEngine) => collect(e.iterate({ segment: 'a' }, { through: joinId(3, 5) })),
    ],
    [
      'iterateBatches',
      async (e: SegmentEngine) => {
        for await (const batch of e.iterateBatches({ segment: 'a' })) void batch;
      },
    ],
    ['intersect', (e: SegmentEngine) => collect(e.intersect([{ segment: 'a' }, { segment: 'b' }]))],
  ])('%s still caches after an earlier invalidation of another segment', async (_name, read) => {
    const { cache, engine } = setupResolving(() => undefined);
    engine.invalidate({ segment: 'unrelated' });
    await read(engine);
    expect(cache.size).toBeGreaterThan(0);
  });

  // iterateBatches takes its epoch before its generation resolves, so an invalidation while it resolves is seen: it
  // lists its keys again and resolves the generation after the invalidation, and caches what it then reads under it.
  it('iterateBatches lists its keys again, and caches only what it read after the invalidation', async () => {
    const { cache, engine, listed } = setupResolving(fireOnce());
    for await (const batch of engine.iterateBatches({ segment: 'a' })) void batch;
    expect(listed).toEqual(['a', 'a']);
    expect(cache.size).toBe(3);
  });

  // everyNth takes its epoch before its generation resolves too.
  it('everyNth caches nothing it reads', async () => {
    const { cache, engine } = setupResolving(fireOnce());
    expect(await collect(engine.everyNth({ segment: 'a' }, 1))).toHaveLength(3);
    expect(cache.size).toBe(0);
  });
});

describe('sharesInvalidationsWith validation', () => {
  // An object that merely holds the same `cache` is not an engine to share with: taken, it would share nothing, and
  // the engine built on it would keep a record of its own.
  it('refuses an object that is not a SegmentEngine even when it holds the same cache', () => {
    const { source, cache } = setup();
    expect(
      () =>
        new SegmentEngine({
          storage: source,
          codec: storeCodec,
          cache,
          sharesInvalidationsWith: { cache } as unknown as SegmentEngine,
        }),
    ).toThrow(ValidationError);
  });
});
