vi.mock('@/core/keys', async (original) => {
  const keys = await original<typeof import('@/core/keys')>();
  // Counted pass-throughs: how often the engine and the source encode a segment's names.
  return { ...keys, segmentKey: vi.fn(keys.segmentKey), segmentPrefix: vi.fn(keys.segmentPrefix) };
});

import { CrbmStorageChunkSource, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { SegmentEngine } from '@/core/engine';
import {
  KEPT_SEGMENT_KEYS,
  KeptSegmentKeys,
  chunkGenKey,
  chunkKeyUnder,
  chunkRefKey,
  segmentKey,
  segmentPrefix,
} from '@/core/keys';
import { BoundedLru } from '@/core/lru';
import type { CodecBitmap } from '@/core/codec';
import type { ChunkRef } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { RoaringBitmap32, SerializationFormat } from 'roaring';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect } from '../helpers/loaded';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';

/**
 * The engine and the `.crbm` source keep each segment's encoded key, rather than encode a segment's names again for
 * every chunk, which cost about a third of a warm `has()`. What they keep is the names' encoding and nothing else, so
 * a kept key is the one an encoding would give now. These hold that every chunk is still keyed exactly as the key
 * helpers key it, across many segments in several namespaces and under names that would collide unencoded; that no
 * number of segments read in turn makes every lookup encode again; that the kept keys are bounded; that an
 * invalidation still finds a segment's chunks by its prefix; and the key format itself, literally.
 */

const HI = 65_536;
const encodedPrefixes = vi.mocked(segmentPrefix);
const encodedKeys = vi.mocked(segmentKey);

/** Twelve segments in four namespaces, some named to look alike. */
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

/** Sixteen segments: four namespaces that share four segment names. */
const SHARED: SegmentRef[] = Array.from({ length: 16 }, (_, i) => ({
  namespace: `tenant-${i % 4}`,
  segment: `seg-${Math.floor(i / 4)}`,
}));

/** Segment `i` holds one id of its own in chunk 0 and one in chunk 1, so every segment shares both chunk keys. */
const idsOf = (i: number): number[] => [i + 1, HI + i + 1];

async function world(refs: readonly SegmentRef[] = REFS) {
  const backend = new MemoryStorage();
  for (const [i, ref] of refs.entries()) {
    await bulkLoadCrbmGeneration(backend.storage, { ...ref, generation: 0 }, idsOf(i), {
      registry: backend.registry,
    });
  }
  const source = new CrbmStorageChunkSource(backend.storage, {
    registry: backend.registry,
    clock: { now: () => 0 },
    maxOpenSegments: 64,
  });
  const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 4096, clock: { now: () => 0 } });
  const engine = new SegmentEngine({ storage: source, codec: roaringCodec, cache });
  /** The cached chunk of segment `i` at `chunkKey`, looked up by the key `chunkGenKey` builds. */
  const cached = async (i: number, chunkKey: number) =>
    cache.peek(chunkGenKey({ ...refs[i]!, chunkKey }, (await source.currentVersion(refs[i]!))!));
  return { engine, source, cache, cached };
}

const allOf = (refs: readonly SegmentRef[]): number[] =>
  refs.flatMap((_, i) => idsOf(i)).sort((a, b) => a - b);

describe('KeptSegmentKeys', () => {
  it('encodes a segment once, and keeps segments of one name in several namespaces apart', () => {
    const encode = vi.fn((ref: SegmentRef) => segmentKey(ref));
    const kept = new KeptSegmentKeys(encode);
    for (let round = 0; round < 3; round++) {
      for (const ref of [...REFS, ...SHARED]) expect(kept.of(ref)).toBe(segmentKey(ref));
    }
    expect(encode).toHaveBeenCalledTimes(REFS.length + SHARED.length);
    expect(kept.size).toBe(REFS.length + SHARED.length);
  });

  it('is bounded: at its bound it empties and fills again, and still answers each segment’s own key', () => {
    const encode = vi.fn((ref: SegmentRef) => segmentPrefix(ref));
    const kept = new KeptSegmentKeys(encode, 4);
    for (const ref of SHARED) {
      expect(kept.of(ref)).toBe(segmentPrefix(ref));
      expect(kept.size).toBeLessThanOrEqual(4);
    }
    expect(KEPT_SEGMENT_KEYS).toBe(1024);
  });
});

describe('the engine and the source keep segments’ keys', () => {
  beforeEach(() => {
    encodedPrefixes.mockClear();
    encodedKeys.mockClear();
  });

  it('a union of twelve operands in four namespaces reads and caches each segment’s own chunks, cold and warm', async () => {
    const { engine, cached } = await world();
    expect(await collect(engine.union(REFS))).toEqual(allOf(REFS));
    for (const [i] of REFS.entries()) {
      for (const chunkKey of [0, 1]) {
        const chunk = await cached(i, chunkKey);
        expect(chunk, `segment ${i} chunk ${chunkKey}`).toBeDefined();
        expect([...chunk!]).toEqual([idsOf(i)[chunkKey]! - chunkKey * HI]);
      }
    }
    // Warm, and the reverse order.
    expect(await collect(engine.union([...REFS].reverse()))).toEqual(allOf(REFS));
    for (const order of [REFS.keys(), [...REFS.keys()].reverse()]) {
      for (const i of order) {
        expect(await engine.has(REFS[i]!, idsOf(i)[0]!)).toBe(true);
        expect(await engine.has(REFS[i]!, idsOf((i + 1) % REFS.length)[1]!)).toBe(false);
      }
    }
  });

  it.each([8, 9, 12, 16])(
    'a warm combine of %i operands, namespaces sharing names, encodes no segment again',
    async (k) => {
      const refs = SHARED.slice(0, k);
      const { engine } = await world(refs);
      expect(await collect(engine.union(refs))).toEqual(allOf(refs));
      expect(encodedPrefixes.mock.calls.length).toBeLessThanOrEqual(k);
      encodedPrefixes.mockClear();
      for (let pass = 0; pass < 3; pass++) {
        expect(await collect(engine.union(refs))).toEqual(allOf(refs));
        expect(await collect(engine.intersect(refs))).toEqual([]);
      }
      expect(encodedPrefixes).not.toHaveBeenCalled();
    },
  );

  it('warm has() over twelve segments in turn encodes no segment again, in the engine or the source', async () => {
    const { engine } = await world();
    for (const [i, ref] of REFS.entries()) expect(await engine.has(ref, idsOf(i)[0]!)).toBe(true);
    encodedPrefixes.mockClear();
    encodedKeys.mockClear();
    for (let round = 0; round < 10; round++) {
      for (const [i, ref] of REFS.entries()) expect(await engine.has(ref, idsOf(i)[0]!)).toBe(true);
    }
    expect(encodedPrefixes).not.toHaveBeenCalled();
    expect(encodedKeys).not.toHaveBeenCalled();
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

describe('the chunk-key format', () => {
  it('is the encoded names, the chunk key and the version, space-separated', () => {
    expect(segmentKey({ segment: 's' })).toBe('/ s');
    expect(segmentKey({ namespace: 'n', segment: 's' })).toBe('n s');
    expect(segmentPrefix({ segment: 's' })).toBe('/ s ');
    expect(chunkRefKey({ segment: 's', chunkKey: 1 })).toBe('/ s 1');
    expect(chunkGenKey({ segment: 's', chunkKey: 1 }, '23')).toBe('/ s 1 23');
    expect(chunkGenKey({ segment: 's', chunkKey: 1 }, 23)).toBe('/ s 1 23');
    expect(chunkKeyUnder('/ s ', 1, '23')).toBe('/ s 1 23');
    expect(chunkKeyUnder('/ s ', 1)).toBe('/ s 1');
  });

  it('keeps a chunk key and a version apart: chunk 1 at 23 and chunk 12 at 3 are two keys', () => {
    expect(chunkGenKey({ segment: 's', chunkKey: 1 }, 23)).not.toBe(
      chunkGenKey({ segment: 's', chunkKey: 12 }, 3),
    );
    expect(chunkKeyUnder('/ s ', 1, '23')).not.toBe(chunkKeyUnder('/ s ', 12, '3'));
  });

  it('through the engine, on a source that names generations by number: chunk 12 at 3 is not chunk 1 at 23', async () => {
    /** Generation-numbered: the engine keys its cache by `currentGeneration`. */
    class Numbered extends MemoryStorageChunkSource {
      generation = 23;
      currentGeneration(): Promise<number | null> {
        return Promise.resolve(this.generation);
      }
    }
    const source = new Numbered();
    const chunk = (remainder: number): Uint8Array =>
      new RoaringBitmap32([remainder]).serialize(SerializationFormat.portable);
    const at = (chunkKey: number): ChunkRef => ({ segment: 's', chunkKey });
    source.seed(at(1), chunk(5));
    source.seed(at(12), chunk(7));
    const cache = new BoundedLru<string, CodecBitmap>({ maxEntries: 64, clock: { now: () => 0 } });
    const engine = new SegmentEngine({ storage: source, codec: roaringCodec, cache });
    expect(await engine.has({ segment: 's' }, HI + 5)).toBe(true); // chunk 1, cached at generation 23
    source.generation = 3;
    expect(await engine.has({ segment: 's' }, 12 * HI + 7)).toBe(true);
    expect(await engine.has({ segment: 's' }, 12 * HI + 5)).toBe(false);
  });
});
