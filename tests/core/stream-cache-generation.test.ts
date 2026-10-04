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

function setup() {
  const inner = new StreamChunkSource();
  seedSegment(inner, 'a', ids([1, 2, 3]));
  seedSegment(inner, 'b', ids([2, 3, 4]));
  const storage: StorageChunkSource = {
    getChunk: (r) => inner.getChunk(r),
    listChunkKeys: (r) => inner.listChunkKeys(r),
    getChunks: (r, keys, options) => inner.getChunks(r, keys, options),
    currentGeneration: () => Promise.resolve(7),
  };
  const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 1_000, clock });
  return { inner, engine: new SegmentEngine({ storage, codec: roaringCodec, cache }) };
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
});
