import roaring from 'roaring';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError, deserializePortable } from '@/index';
import { MAX_SERIALIZED_LOAD_BYTES } from '@/core/load-input';
import { craftPortable } from '../helpers/portable-bytes';

/**
 * `deserializePortable` decodes bytes a caller holds through the check a `{ serialized }` load makes first, so the
 * two accept and refuse the same bytes, and a refusal is made before the native decoder sees them.
 */
const { RoaringBitmap32 } = roaring;
type Bitmap = InstanceType<typeof RoaringBitmap32>;
const CHUNK = 65_536;

afterEach(() => vi.restoreAllMocks());

function sample(): Bitmap {
  const b = new RoaringBitmap32([1, 5, 70_000, 2 ** 32 - 1]);
  b.addRange(3 * CHUNK + 10, 3 * CHUNK + 9_000); // a bitset
  b.addRange(5 * CHUNK, 5 * CHUNK + 40_000); // a run once optimized
  return b;
}

/** Whether a load of `bytes` as `{ serialized }` is refused with `ValidationError`, on a store of its own. */
async function loadRefuses(bytes: unknown): Promise<boolean> {
  const store = new CloudRoaring({ storage: new MemoryStorage() });
  try {
    await store.load({ segment: 's' }, { serialized: bytes as Uint8Array }, { allowEmpty: true });
    return false;
  } catch (err) {
    return err instanceof ValidationError;
  }
}

describe('deserializePortable: bytes that are one well-formed bitmap', () => {
  it('give the bitmap RoaringBitmap32.deserialize gives, as written and run-optimized', () => {
    const optimized = sample();
    optimized.runOptimize();
    for (const b of [sample(), optimized, new RoaringBitmap32()]) {
      const bytes = b.serialize('portable');
      const decoded = deserializePortable(bytes);
      expect(decoded).toBeInstanceOf(RoaringBitmap32);
      expect(decoded.toArray()).toEqual(RoaringBitmap32.deserialize(bytes, 'portable').toArray());
      expect(decoded.size).toBe(b.size);
      expect(decoded.serialize('portable')).toEqual(bytes);
    }
  });

  it('are read from a Buffer and from a view at an offset into a larger buffer', () => {
    const bytes = sample().serialize('portable');
    expect(deserializePortable(Buffer.from(bytes)).size).toBe(sample().size);
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 3);
    expect(deserializePortable(padded.subarray(3, 3 + bytes.length)).size).toBe(sample().size);
  });

  it('are accepted by a load too, and an empty buffer is the empty bitmap in both', async () => {
    expect(deserializePortable(new Uint8Array(0)).size).toBe(0);
    expect(await loadRefuses(sample().serialize('portable'))).toBe(false);
    expect(await loadRefuses(new Uint8Array(0))).toBe(false);
  });
});

describe('deserializePortable: bytes it refuses, as a load refuses them, before the native decoder', () => {
  const bits = new Uint8Array(8_192);
  bits[0] = 0b111;
  const good = (): Uint8Array => sample().serialize('portable');
  const cases: Array<[string, () => unknown]> = [
    [
      'a header cardinality that disagrees with the bits',
      () => craftPortable([{ key: 0, kind: 'bitset', bits, cardinality: 5 }]),
    ],
    ['two serializations in one buffer', () => new Uint8Array([...good(), ...good()])],
    ['a buffer cut short', () => good().subarray(0, good().length - 1)],
    ['a buffer cut inside its header', () => good().subarray(0, 6)],
    ['bytes that are not a bitmap', () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
    ['one byte over the cap', () => new Uint8Array(MAX_SERIALIZED_LOAD_BYTES + 1)],
    ['an array of numbers', () => [1, 2, 3]],
    ['a string', () => 'portable'],
    ['a Uint16Array', () => new Uint16Array(4)],
    ['null', () => null],
    ['undefined', () => undefined],
  ];

  it.each(cases)('%s', async (_name, make) => {
    const native = vi.spyOn(RoaringBitmap32, 'deserialize');
    const bytes = make();
    expect(() => deserializePortable(bytes as Uint8Array)).toThrow(ValidationError);
    expect(native).not.toHaveBeenCalled();
    expect(await loadRefuses(bytes)).toBe(true);
  });

  it('every prefix of a bitmap shorter than the bitmap, except the empty one, is refused', () => {
    const bytes = good();
    for (let n = 1; n < bytes.length; n++) {
      expect(() => deserializePortable(bytes.subarray(0, n))).toThrow(ValidationError);
    }
  });

  it.each(['croaring', 'unsafe_frozen_croaring'] as const)(
    'a %s serialization is not portable bytes',
    (format) => {
      expect(() => deserializePortable(sample().serialize(format))).toThrow(ValidationError);
    },
  );

  it('the over-cap refusal says to runOptimize()', () => {
    expect(() => deserializePortable(new Uint8Array(MAX_SERIALIZED_LOAD_BYTES + 1))).toThrow(
      /runOptimize/,
    );
  });
});
