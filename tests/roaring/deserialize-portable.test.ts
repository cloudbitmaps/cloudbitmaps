import roaring from 'roaring';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError, deserializePortable } from '@/index';
import { SafeBitmap } from '@/native-codec';
import type { LoadInput, PortableBitmap, ReadonlyBitmap } from '@/index';
import { MAX_SERIALIZED_LOAD_BYTES, decodeSerialized } from '@/core/load-input';
import type { CodecInterface } from '@/core/codec';
import { roaringCodec } from '@/native-codec';
import { craftPortable } from '../helpers/portable-bytes';
import { zeroEntropy } from '../helpers/entropy';
import { withNativeCodec } from '../helpers/codec-leg';

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
  // The TypeScript codec's `serialize` returns a plain `Uint8Array`, where this compares with a native `Buffer`: the native codec goes behind the store.
  it(
    'give the ids RoaringBitmap32.deserialize gives, as written and run-optimized',
    withNativeCodec(() => {
      const optimized = sample();
      optimized.runOptimize();
      for (const b of [sample(), optimized, new RoaringBitmap32()]) {
        const bytes = b.serialize('portable');
        const decoded = deserializePortable(bytes);
        expect([...decoded]).toEqual(RoaringBitmap32.deserialize(bytes, 'portable').toArray());
        expect(decoded.size).toBe(b.size);
        expect(decoded.serialize('portable')).toEqual(bytes);
      }
    }),
  );

  it('is not a RoaringBitmap32 at run time', () => {
    expect(deserializePortable(sample().serialize('portable'))).not.toBeInstanceOf(RoaringBitmap32);
  });

  it('answers has for members, non-members, 2^32 - 1, and at the edges of a bitset and a run chunk', () => {
    const optimized = sample();
    optimized.runOptimize();
    for (const b of [sample(), optimized]) {
      const decoded = deserializePortable(b.serialize('portable'));
      const members = [
        1,
        5,
        70_000,
        2 ** 32 - 1,
        3 * CHUNK + 10,
        3 * CHUNK + 8_999,
        5 * CHUNK,
        5 * CHUNK + 39_999,
      ];
      const others = [
        0,
        2,
        69_999,
        70_001,
        2 ** 32 - 2,
        3 * CHUNK + 9,
        3 * CHUNK + 9_000,
        5 * CHUNK - 1,
        5 * CHUNK + 40_000,
      ];
      for (const id of members) expect(decoded.has(id)).toBe(true);
      for (const id of others) expect(decoded.has(id)).toBe(false);
      for (const id of [...members, ...others]) expect(decoded.has(id)).toBe(b.has(id));
    }
  });

  it('iterates ascending', () => {
    const ids = [...deserializePortable(sample().serialize('portable'))];
    expect(ids.length).toBeGreaterThan(40_000);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('are read from a Buffer and from a view at an offset into a larger buffer', () => {
    const bytes = sample().serialize('portable');
    expect(deserializePortable(Buffer.from(bytes)).size).toBe(sample().size);
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 3);
    expect(deserializePortable(padded.subarray(3, 3 + bytes.length)).size).toBe(sample().size);
  });

  // Spies on the native decoder, which the TypeScript leg does not call.
  it(
    'are read from a SharedArrayBuffer as a copy no other thread can change',
    withNativeCodec(() => {
      const bytes = sample().serialize('portable');
      const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
      shared.set(bytes);
      const native = vi.spyOn(RoaringBitmap32, 'deserialize');
      expect(deserializePortable(shared).size).toBe(sample().size);
      expect(native).toHaveBeenCalledTimes(1);
      const handed = native.mock.calls[0]?.[0] as Uint8Array;
      expect(handed.buffer instanceof SharedArrayBuffer).toBe(false);
      expect(Buffer.from(handed)).toEqual(Buffer.from(bytes));
    }),
  );

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

  // Spies on the native decoder, which the TypeScript leg does not call.
  it(
    'the spy sees the native decoder when the bytes are good (a control for the cases above)',
    withNativeCodec(() => {
      const native = vi.spyOn(RoaringBitmap32, 'deserialize');
      deserializePortable(good());
      expect(native).toHaveBeenCalledTimes(1);
    }),
  );

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

describe('decodeSerialized: the size cap, at its boundary, in front of the codec', () => {
  /** A codec that records what reaches it and decodes nothing. */
  function recording(): { codec: CodecInterface; lengths: number[] } {
    const lengths: number[] = [];
    const codec: CodecInterface = {
      ...roaringCodec,
      safeDeserialize: (bytes) => {
        lengths.push(bytes.byteLength);
        return roaringCodec.empty();
      },
    };
    return { codec, lengths };
  }

  it('one byte over the cap is a ValidationError and the codec is not called', () => {
    const { codec, lengths } = recording();
    const over = new Uint8Array(new ArrayBuffer(MAX_SERIALIZED_LOAD_BYTES + 1));
    expect(() => decodeSerialized(over, codec)).toThrow(ValidationError);
    expect(lengths).toEqual([]);
  });

  it('exactly the cap reaches the codec', () => {
    const { codec, lengths } = recording();
    decodeSerialized(new Uint8Array(new ArrayBuffer(MAX_SERIALIZED_LOAD_BYTES)), codec);
    expect(lengths).toEqual([MAX_SERIALIZED_LOAD_BYTES]);
  });

  it('names the input in its refusals, in a sentence that reads right by default', () => {
    const { codec } = recording();
    expect(() => decodeSerialized('x', codec)).toThrow(
      'the buffer must be a Uint8Array of portable Roaring bytes',
    );
    expect(() => decodeSerialized(new Uint8Array(1), roaringCodec)).toThrow(
      /^the buffer is not a valid bitmap: /,
    );
    expect(() => decodeSerialized('x', codec, '{ serialized }')).toThrow(
      /^\{ serialized \} must be/,
    );
  });
});

describe('ReadonlyBitmap: the type', () => {
  type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  it('is what deserializePortable returns, and a PortableBitmap a load takes', () => {
    expectTypeOf(deserializePortable).returns.toEqualTypeOf<ReadonlyBitmap>();
    expectTypeOf<ReadonlyBitmap>().toExtend<PortableBitmap>();
    expectTypeOf<ReadonlyBitmap>().toExtend<LoadInput>();
    expectTypeOf<{ bitmap: ReadonlyBitmap }>().toExtend<LoadInput>();
    expectTypeOf<ReadonlyBitmap>().toExtend<Iterable<number>>();
  });

  it("is satisfied by roaring's RoaringBitmap32, which it does not extend", () => {
    expectTypeOf<Bitmap>().toExtend<ReadonlyBitmap>();
    expectTypeOf<ReadonlyBitmap>().not.toExtend<Bitmap>();
  });

  it('has exactly its members, and no mutator or set operation', () => {
    const members: SameKeys<
      keyof ReadonlyBitmap,
      'size' | 'has' | 'serialize' | 'getSerializationSizeInBytes' | typeof Symbol.iterator
    > = true;
    expect(members).toBe(true);
    const decoded = deserializePortable(new Uint8Array(0));
    // @ts-expect-error a ReadonlyBitmap has no orInPlace
    void decoded.orInPlace;
    // @ts-expect-error a ReadonlyBitmap has no toArray
    void decoded.toArray;
  });
});

describe('a decoded bitmap, loaded', () => {
  const SEG = { segment: 'decoded' };
  type Load = (decoded: ReadonlyBitmap) => LoadInput;
  const loads: Array<[string, Load]> = [
    ['{ bitmap: decoded }', (decoded) => ({ bitmap: decoded })],
    ['bare decoded, where ids go', (decoded) => decoded],
  ];

  async function written(input: LoadInput): Promise<Uint8Array> {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, seams: { entropy: zeroEntropy } });
    const result = await store.load(SEG, input);
    const tail = await backend.storage.getTail({ ...SEG, generation: result.generation }, 1 << 30);
    return tail.bytes;
  }

  it.each(loads)('%s writes the object { serialized } writes', async (_name, make) => {
    const bytes = sample().serialize('portable');
    const expected = await written({ serialized: bytes });
    expect(Buffer.from(await written(make(deserializePortable(bytes))))).toEqual(
      Buffer.from(expected),
    );
  });

  it.each(loads)('%s is serialized once and never iterated', async (_name, make) => {
    const decoded = deserializePortable(sample().serialize('portable'));
    const serialize = vi.spyOn(decoded, 'serialize');
    const iterate = vi.spyOn(decoded, Symbol.iterator);
    await written(make(decoded));
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(iterate).not.toHaveBeenCalled();
  });

  it('bare, with sorted: true, is refused as a bitmap is', async () => {
    const decoded = deserializePortable(sample().serialize('portable'));
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await expect(store.load(SEG, decoded, { sorted: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('a decoded bitmap is a read-only view', () => {
  const decode = (): ReadonlyBitmap => deserializePortable(sample().serialize('portable'));
  type Loose = Record<string, (...args: unknown[]) => unknown>;
  const stale = [
    'add',
    'addMany',
    'remove',
    'removeMany',
    'orInPlace',
    'andInPlace',
    'andNotInPlace',
    'xorInPlace',
    'clone',
    'toArray',
    'toUint32Array',
    'isEmpty',
    'minimum',
    'maximum',
    'rank',
    'select',
    'contentToString',
    'runOptimize',
    'getSerializationSizeInBytes',
  ];

  it.each(stale)('a call to %s written for a RoaringBitmap32 throws TypeError', (name) => {
    const decoded = decode() as unknown as Loose;
    const before = [...(decoded as unknown as ReadonlyBitmap)];
    expect(() =>
      (decoded[name] as (...args: unknown[]) => unknown)(new RoaringBitmap32([1])),
    ).toThrow(TypeError);
    expect([...(decoded as unknown as ReadonlyBitmap)]).toEqual(before);
  });

  it.each([
    ['croaring', ['croaring']],
    ['uint32_array', ['uint32_array']],
    ['false', [false]],
    ['no argument', []],
    ['an output buffer as a second argument', ['portable', new Uint8Array(8)]],
  ] as const)('serialize refuses %s with a ValidationError', (_name, args) => {
    const decoded = decode() as unknown as { serialize(...a: unknown[]): unknown };
    expect(() => decoded.serialize(...args)).toThrow(ValidationError);
  });

  it('serialize names what it got', () => {
    const decoded = decode() as unknown as { serialize(...a: unknown[]): unknown };
    expect(() => decoded.serialize('uint32_array')).toThrow(/'uint32_array'/);
  });

  it('is not a SafeBitmap, and its prototype chain names the four members and nothing else', () => {
    const decoded = decode();
    expect(decoded).not.toBeInstanceOf(SafeBitmap);
    const names: Array<string | symbol> = [];
    for (let o = Object.getPrototypeOf(decoded); o !== null && o !== Object.prototype;) {
      names.push(...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o));
      o = Object.getPrototypeOf(o);
    }
    expect(Object.getOwnPropertyNames(decoded)).toEqual([]);
    expect(
      names
        .filter((n) => n !== 'constructor')
        .map(String)
        .sort(),
    ).toEqual(['Symbol(Symbol.iterator)', 'has', 'serialize', 'size'].sort());
  });
});

describe('the parts recipe: a check, then a native decode of the checked bytes', () => {
  it('gives the bitmap a native decode of the same bytes gives', () => {
    const optimized = sample();
    optimized.runOptimize();
    for (const b of [sample(), optimized]) {
      const bytes = b.serialize('portable');
      const checked = deserializePortable(bytes);
      const native = RoaringBitmap32.deserialize(checked.serialize('portable'), 'portable');
      expect(native.toArray()).toEqual(RoaringBitmap32.deserialize(bytes, 'portable').toArray());
      expect(native.serialize('portable')).toEqual(bytes);
    }
  });
});
