/**
 * A source that streams chunks (`getChunks`) and names its segments' generations (`currentGeneration`) but not their
 * versions: the engine looks its chunks up by generation number, so what it streams is cached under that number too,
 * or a chunk read again would miss the cache every time.
 */
import { describe, expect, it } from 'vitest';
import { BoundedLru, SegmentEngine } from '@cloudbitmaps/core';
import type { CodecBitmap, StorageChunkSource } from '@cloudbitmaps/core';
import { roaringCodec } from '@/roaring-codec';
import { joinId } from '@/core/bit-route';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { collect, seedSegment } from '../helpers/loaded';

const clock = { now: () => 0 };
const ref = (segment: string) => ({ segment });
const ids = (chunks: readonly number[]): number[] => chunks.map((c) => joinId(c, 1));

function setup(onResolve?: (engine: SegmentEngine) => void) {
  const inner = new StreamChunkSource();
  seedSegment(inner, 'a', ids([1, 2, 3]));
  seedSegment(inner, 'b', ids([2, 3, 4]));
  const storage: StorageChunkSource = {
    getChunk: (r) => inner.getChunk(r),
    listChunkKeys: (r) => inner.listChunkKeys(r),
    getChunks: (r, keys, options) => inner.getChunks(r, keys, options),
    currentGeneration: () => {
      onResolve?.(engine);
      return Promise.resolve(7);
    },
  };
  const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 1_000, clock });
  const engine = new SegmentEngine({ storage, codec: roaringCodec, cache });
  return { inner, cache, engine };
}

describe('a streaming source that names generations and not versions', () => {
  it('reads a chunk once over repeated point reads', async () => {
    const { inner, engine } = setup();
    for (let i = 0; i < 5; i++) expect(await engine.has(ref('a'), joinId(2, 1))).toBe(true);
    expect(inner.singles.filter((s) => s === 'a:2')).toHaveLength(1);
  });

  it('serves a second combine from the chunks the first one cached', async () => {
    const { inner, engine } = setup();
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([2, 3]));
    const streams = inner.opened.length;
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([2, 3]));
    expect(inner.opened.length).toBe(streams);
  });

  it('caches what a stream reads when no invalidation came after the read began', async () => {
    const { cache, engine } = setup();
    await collect(engine.iterate(ref('a')));
    expect(cache.size).toBe(3);
  });

  it('does not cache what a stream opened after an invalidation reads: it may be newer than the generation it planned under', async () => {
    let fired = false;
    const { cache, engine } = setup((engine) => {
      if (fired) return;
      fired = true;
      engine.invalidate(ref('a')); // lands while the read resolves its generation
    });
    expect(await collect(engine.iterate(ref('a')))).toEqual(ids([1, 2, 3]));
    expect(cache.size).toBe(0);
    expect(await collect(engine.iterate(ref('a')))).toEqual(ids([1, 2, 3])); // a later read caches again
    expect(cache.size).toBe(3);
  });

  it('a combine invalidated while the generations of its operands resolve caches nothing it reads', async () => {
    let fired = false;
    const { cache, engine } = setup((engine) => {
      if (fired) return;
      fired = true;
      engine.invalidate(ref('a'));
    });
    expect(await collect(engine.intersect([ref('a'), ref('b')]))).toEqual(ids([2, 3]));
    expect(cache.size).toBe(0);
  });

  it('an iterate over a range invalidated while its generation resolves caches nothing it reads', async () => {
    let fired = false;
    const { cache, engine } = setup((e) => {
      if (fired) return;
      fired = true;
      e.invalidate(ref('a'));
    });
    expect(await collect(engine.iterate(ref('a'), { through: joinId(3, 5) }))).toEqual(
      ids([1, 2, 3]),
    );
    expect(cache.size).toBe(0);
  });

  it('caches a chunk a stream delivers after the read moved under the generation it was asked for at', async () => {
    // Generation 7 of `a` holds remainder 1 in each chunk and generation 8 remainder 2. The read moves to 8 while range
    // reads of 7 are still in flight; what they deliver must not be cached as 8's, or a later read at 8 serves 7.
    const KEYS = Array.from({ length: 40 }, (_, i) => i);
    const at7 = new StreamChunkSource();
    const at8 = new StreamChunkSource();
    seedSegment(
      at7,
      'a',
      KEYS.map((c) => joinId(c, 1)),
    );
    seedSegment(
      at8,
      'a',
      KEYS.map((c) => joinId(c, 2)),
    );
    for (const source of [at7, at8]) {
      seedSegment(
        source,
        'b',
        KEYS.flatMap((c) => [joinId(c, 1), joinId(c, 2)]),
      );
    }
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    at7.beforeYield = () => sleep(10);
    let gen = 7;
    const live = () => (gen === 7 ? at7 : at8);
    const storage: StorageChunkSource = {
      getChunk: (r) => live().getChunk(r),
      listChunkKeys: (r) => live().listChunkKeys(r),
      getChunks: (r, keys, options) => live().getChunks(r, keys, options),
      currentGeneration: async () => {
        if (gen === 8) await sleep(5);
        return gen;
      },
    };
    const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 1_000, clock });
    const engine = new SegmentEngine({ storage, codec: roaringCodec, cache });
    for (const c of KEYS)
      if (c % 2 === 0) expect(await engine.has(ref('a'), joinId(c, 1))).toBe(true);
    let first = true;
    for await (const id of engine.intersect([ref('a'), ref('b')])) {
      void id;
      if (first) gen = 8;
      first = false;
    }
    const later = await collect(engine.iterate(ref('a')));
    expect(later.filter((id) => id % 65_536 === 1)).toEqual([]);
    expect(later).toHaveLength(KEYS.length);
  });
});
