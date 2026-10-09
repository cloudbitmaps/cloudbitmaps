import { CrbmStorageChunkSource, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { SegmentEngine } from '@/core/engine';
import { chunkGenKey, segmentPrefix } from '@/core/keys';
import { BoundedLru } from '@/core/lru';
import type { CodecBitmap } from '@/core/codec';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect } from '../helpers/loaded';

/**
 * The engine keeps the cache-key prefixes of the last few segments it looked chunks up for, rather than encode a
 * segment's names again for every chunk. A prefix is the segment's encoded names and nothing else, so a kept one is
 * the one an encoding would give now. These hold that every chunk is still keyed exactly as `chunkGenKey` keys it,
 * across more segments than are kept, in several namespaces and under names that would collide if they were not
 * encoded, and that an invalidation still finds a segment's chunks by its prefix.
 */

const HI = 65_536;

/** Twelve segments: more than the engine keeps prefixes for, in four namespaces, some named to look alike. */
const REFS: SegmentRef[] = [
  { segment: 's' },
  { namespace: '/', segment: 's' },
  { namespace: 'a', segment: 'b c' },
  { namespace: 'a b', segment: 'c' },
  { namespace: 'a', segment: 'b' },
  { namespace: 'tenant-1', segment: 'seg' },
  { namespace: 'tenant-2', segment: 'seg' },
  { namespace: 'tenant-1', segment: 'seg ' },
  { segment: 'a b c' },
  { namespace: 'a', segment: 'b%20c' },
  { namespace: 'tenant-2', segment: 'other' },
  { segment: '_default' },
];

/** Segment `i` holds one id of its own in chunk 0 and one in chunk 1, so every segment shares both chunk keys. */
const idsOf = (i: number): number[] => [i + 1, HI + i + 1];

async function world() {
  const backend = new MemoryStorage();
  for (const [i, ref] of REFS.entries()) {
    await bulkLoadCrbmGeneration(backend.storage, { ...ref, generation: 0 }, idsOf(i), {
      registry: backend.registry,
    });
  }
  const source = new CrbmStorageChunkSource(backend.storage, { registry: backend.registry });
  const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 1024, clock: { now: () => 0 } });
  const engine = new SegmentEngine({ storage: source, codec: roaringCodec, cache });
  /** The cached chunk of segment `i` at `chunkKey`, looked up by the key `chunkGenKey` builds. */
  const cached = async (i: number, chunkKey: number) =>
    cache.peek(chunkGenKey({ ...REFS[i]!, chunkKey }, (await source.currentVersion(REFS[i]!))!));
  return { engine, cache, cached };
}

const ALL = REFS.flatMap((_, i) => idsOf(i)).sort((a, b) => a - b);

describe('the engine keeps segments’ cache-key prefixes', () => {
  it('a union of twelve operands in four namespaces reads and caches each segment’s own chunks, cold and warm', async () => {
    const { engine, cached } = await world();
    expect(await collect(engine.union(REFS))).toEqual(ALL);
    for (const [i] of REFS.entries()) {
      for (const chunkKey of [0, 1]) {
        const chunk = await cached(i, chunkKey);
        expect(chunk, `segment ${i} chunk ${chunkKey}`).toBeDefined();
        expect([...chunk!]).toEqual([idsOf(i)[chunkKey]! - chunkKey * HI]);
      }
    }
    // Warm, and the reverse order, which turns the kept prefixes over.
    expect(await collect(engine.union([...REFS].reverse()))).toEqual(ALL);
    for (const order of [REFS.keys(), [...REFS.keys()].reverse()]) {
      for (const i of order) {
        expect(await engine.has(REFS[i]!, idsOf(i)[0]!)).toBe(true);
        expect(await engine.has(REFS[i]!, idsOf((i + 1) % REFS.length)[1]!)).toBe(false);
      }
    }
  });

  it('keeps no more than a few prefixes, however many segments it reads', async () => {
    const { engine } = await world();
    await collect(engine.union(REFS));
    const kept = (engine as unknown as { recentPrefixes: Array<{ prefix: string }> })
      .recentPrefixes;
    expect(kept.length).toBeLessThanOrEqual(8);
    for (const k of kept) expect(REFS.map(segmentPrefix)).toContain(k.prefix);
  });

  it('an invalidation drops one segment’s chunks, found by its prefix, and no other’s', async () => {
    const { engine, cached } = await world();
    await collect(engine.union(REFS));
    engine.invalidate(REFS[3]!);
    for (const [i] of REFS.entries()) {
      expect(await cached(i, 0), `segment ${i}`)[i === 3 ? 'toBeUndefined' : 'toBeDefined']();
    }
    expect(await collect(engine.iterate(REFS[3]!))).toEqual(idsOf(3));
  });
});
