import { RoaringBitmap32, SerializationFormat } from 'roaring';
import {
  assertChunkCardinalityInRange,
  assertChunkKeyInRange,
  assertChunkPayloadInRange,
  checkedChunkKeys,
  decodeChunkBytes,
} from '@/core/chunk-checks';
import type { CodecBitmap } from '@/core/codec';
import { SegmentEngine } from '@/core/engine';
import { IntegrityError } from '@/core/errors';
import type { StorageChunkSource } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { collect } from '../helpers/loaded';

// The checks on untrusted tier data, in one module: each refusal, its message, and the look-alikes that must pass.

const withMax = (max: number | undefined): CodecBitmap =>
  ({ maximum: max === undefined ? undefined : () => max }) as unknown as CodecBitmap;

describe('assertChunkKeyInRange', () => {
  it.each([0, 1, 65_535])('accepts key %i', (k) => {
    expect(() => assertChunkKeyInRange(k)).not.toThrow();
  });

  it.each([-1, 65_536, 70_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses key %s with the out-of-range message',
    (k) => {
      expect(() => assertChunkKeyInRange(k)).toThrow(IntegrityError);
      expect(() => assertChunkKeyInRange(k)).toThrow(`chunk key from a tier is out of range: ${k}`);
    },
  );
});

describe('assertChunkCardinalityInRange', () => {
  it.each([1, 2, 65_535, 65_536])('accepts cardinality %i', (c) => {
    expect(() => assertChunkCardinalityInRange(c)).not.toThrow();
  });

  it.each([0, -1, 65_537, 2.5, Number.NaN])(
    'refuses cardinality %s with the out-of-range message',
    (c) => {
      expect(() => assertChunkCardinalityInRange(c)).toThrow(IntegrityError);
      expect(() => assertChunkCardinalityInRange(c)).toThrow(
        `chunk cardinality from a tier is out of range: ${c}`,
      );
    },
  );
});

describe('checkedChunkKeys', () => {
  it('sorts ascending, returns a new array and accepts any iterable', () => {
    const listed = [5, 0, 65_535, 3];
    expect(checkedChunkKeys(listed)).toEqual([0, 3, 5, 65_535]);
    expect(listed).toEqual([5, 0, 65_535, 3]);
    expect(checkedChunkKeys(new Set([9, 2]))).toEqual([2, 9]);
    expect(checkedChunkKeys([])).toEqual([]);
  });

  it('refuses an out-of-range key', () => {
    expect(() => checkedChunkKeys([1, 65_536])).toThrow(
      'chunk key from a tier is out of range: 65536',
    );
    expect(() => checkedChunkKeys([-1])).toThrow(IntegrityError);
  });

  it('refuses a key listed twice, and says which', () => {
    expect(() => checkedChunkKeys([4, 7, 4])).toThrow(IntegrityError);
    expect(() => checkedChunkKeys([4, 7, 4])).toThrow('chunk key from a tier is listed twice: 4');
  });
});

describe('assertChunkPayloadInRange', () => {
  it('accepts a maximum of exactly 65,535, and a codec that cannot answer', () => {
    expect(() => assertChunkPayloadInRange(withMax(65_535), 3)).not.toThrow();
    expect(() => assertChunkPayloadInRange(withMax(0), 3)).not.toThrow();
    expect(() => assertChunkPayloadInRange(withMax(undefined), 3)).not.toThrow();
  });

  it('refuses a maximum of 65,536 and names the chunk and the value', () => {
    expect(() => assertChunkPayloadInRange(withMax(65_536), 9)).toThrow(IntegrityError);
    expect(() => assertChunkPayloadInRange(withMax(65_536), 9)).toThrow(
      'chunk 9 payload holds value 65536, outside the 16-bit remainder range [0, 65535] — ' +
        'the stored object is corrupt or was not written by this codec',
    );
  });
});

describe('decodeChunkBytes', () => {
  const bytes = (values: number[]): Uint8Array =>
    new RoaringBitmap32(values).serialize(SerializationFormat.portable);

  it('decodes a payload whose maximum is exactly 65,535', () => {
    const bitmap = decodeChunkBytes(roaringCodec, bytes([0, 65_535]), 1, 1 << 20);
    expect(bitmap.maximum?.()).toBe(65_535);
  });

  it('refuses a payload above 65,535', () => {
    expect(() => decodeChunkBytes(roaringCodec, bytes([65_536]), 2, 1 << 20)).toThrow(
      /chunk 2 payload holds value 65536/,
    );
  });

  it('applies the size cap before decoding', () => {
    expect(() => decodeChunkBytes(roaringCodec, bytes([1, 2, 3]), 0, 4)).toThrow();
  });
});

describe('the engine reaches each check', () => {
  const never = (): Promise<Uint8Array | null> => Promise.resolve(null);

  it('count refuses an out-of-range key in a source that reports per-chunk counts', async () => {
    const storage: StorageChunkSource = {
      getChunk: never,
      listChunkKeys: () => Promise.resolve([]),
      cardinalities: () => Promise.resolve(new Map([[65_536, 1]])),
    };
    const engine = new SegmentEngine({ storage, codec: roaringCodec });
    await expect(engine.count({ segment: 's' })).rejects.toThrow(
      'chunk key from a tier is out of range: 65536',
    );
  });

  it('iterate refuses a key listed twice and an out-of-range key', async () => {
    const dup: StorageChunkSource = {
      getChunk: never,
      listChunkKeys: () => Promise.resolve([2, 2]),
    };
    await expect(
      collect(new SegmentEngine({ storage: dup, codec: roaringCodec }).iterate({ segment: 's' })),
    ).rejects.toThrow('chunk key from a tier is listed twice: 2');
    const wide: StorageChunkSource = {
      getChunk: never,
      listChunkKeys: () => Promise.resolve([-3]),
    };
    await expect(
      collect(new SegmentEngine({ storage: wide, codec: roaringCodec }).iterate({ segment: 's' })),
    ).rejects.toThrow('chunk key from a tier is out of range: -3');
  });

  it('everyNth refuses an out-of-range chunk cardinality', async () => {
    for (const c of [0, 65_537]) {
      const storage: StorageChunkSource = {
        getChunk: never,
        listChunkKeys: () => Promise.resolve([0]),
        cardinalities: () => Promise.resolve(new Map([[0, c]])),
      };
      const engine = new SegmentEngine({ storage, codec: roaringCodec });
      await expect(collect(engine.everyNth({ segment: 's' }, 2))).rejects.toThrow(
        `chunk cardinality from a tier is out of range: ${c}`,
      );
    }
  });

  it('a read refuses a payload above 65,535 and serves one at exactly 65,535', async () => {
    const bad = new MemoryStorageChunkSource();
    bad.seed(
      { segment: 's', chunkKey: 0 },
      new RoaringBitmap32([65_536]).serialize(SerializationFormat.portable),
    );
    await expect(
      collect(new SegmentEngine({ storage: bad, codec: roaringCodec }).iterate({ segment: 's' })),
    ).rejects.toThrow(/outside the 16-bit remainder range/);

    const ok = new MemoryStorageChunkSource();
    ok.seed(
      { segment: 's', chunkKey: 1 },
      new RoaringBitmap32([65_535]).serialize(SerializationFormat.portable),
    );
    const engine = new SegmentEngine({ storage: ok, codec: roaringCodec });
    expect(await collect(engine.iterate({ segment: 's' }))).toEqual([131_071]);
  });
});
