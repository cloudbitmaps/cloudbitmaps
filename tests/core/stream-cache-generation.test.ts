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

  describe('a read that moves while its stream is open caches nothing more the stream delivers', () => {
    const KEYS = Array.from({ length: 40 }, (_, i) => i);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** Generation 7 of `a` holds remainder 1 in each chunk and generation 8 remainder 2; `b` holds both. */
    function twoGenerations() {
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
      const state = { gen: 7, resolveMs: 0 };
      const live = () => (state.gen === 7 ? at7 : at8);
      const storage: StorageChunkSource = {
        getChunk: (r) => live().getChunk(r),
        listChunkKeys: (r) => live().listChunkKeys(r),
        getChunks: (r, keys, options) => live().getChunks(r, keys, options),
        currentGeneration: async () => {
          if (state.resolveMs > 0) await sleep(state.resolveMs);
          return state.gen;
        },
      };
      const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 1_000, clock });
      const engine = new SegmentEngine({ storage, codec: roaringCodec, cache });
      /** A later read of `a` at generation 8 must hold generation 8's ids alone. */
      const readAt8 = async (): Promise<number[]> => {
        const later = await collect(engine.iterate(ref('a')));
        expect(later).toHaveLength(KEYS.length);
        return later.filter((id) => id % 65_536 === 1);
      };
      return { at7, state, engine, readAt8 };
    }

    it("iterate: chunks the stream still delivers from generation 7 are not cached as 8's", async () => {
      const { state, engine, readAt8 } = twoGenerations();
      expect(await engine.has(ref('a'), joinId(2, 1))).toBe(true); // chunk 2 cached at 7
      let first = true;
      for await (const id of engine.iterate(ref('a'))) {
        void id;
        if (first) state.gen = 8; // chunk 2's check finds the move; chunks 3 to 39 still come from the open stream
        first = false;
      }
      expect(await readAt8()).toEqual([]);
    });

    it('intersect: neither are chunks in flight when the move is found', async () => {
      const { at7, state, engine, readAt8 } = twoGenerations();
      for (const c of KEYS)
        if (c % 2 === 0) expect(await engine.has(ref('a'), joinId(c, 1))).toBe(true);
      // The stream of `a` answers slowly and the move takes a moment to resolve, so ranges are in flight when it lands.
      at7.beforeYield = (stream) =>
        stream.segment === 'a' && stream.keys.length > 1 ? sleep(10) : undefined;
      let first = true;
      for await (const id of engine.intersect([ref('a'), ref('b')])) {
        void id;
        if (first) Object.assign(state, { gen: 8, resolveMs: 5 });
        first = false;
      }
      expect(await readAt8()).toEqual([]);
    });
  });
});
