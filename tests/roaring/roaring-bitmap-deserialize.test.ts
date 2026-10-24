import roaring from 'roaring';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage, RoaringBitmap, ValidationError } from '@/index';
import type { LoadInput } from '@/index';
import { MAX_SERIALIZED_LOAD_BYTES, decodeSerialized } from '@/core/load-input';
import type { CodecInterface } from '@/core/codec';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import { craftPortable } from '../helpers/portable-bytes';
import { zeroEntropy } from '../helpers/entropy';

/**
 * `RoaringBitmap.deserialize` decodes bytes a caller holds through the check a `{ serialized }` load makes first, so
 * the two accept and refuse the same bytes, except the empty buffer, which a store load reads as "nothing stored" and
 * the public door refuses.
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

describe('RoaringBitmap.deserialize: bytes that are one well-formed bitmap', () => {
  it('give the ids RoaringBitmap32.deserialize gives, as written and run-optimized', () => {
    const optimized = sample();
    optimized.runOptimize();
    for (const b of [sample(), optimized, new RoaringBitmap32()]) {
      const bytes = b.serialize('portable');
      const decoded = RoaringBitmap.deserialize(bytes);
      expect([...decoded]).toEqual(RoaringBitmap32.deserialize(bytes, 'portable').toArray());
      expect(decoded.size).toBe(b.size);
      expect(Buffer.from(decoded.serialize('portable'))).toEqual(Buffer.from(bytes));
      expect(Buffer.from(decoded.serialize())).toEqual(Buffer.from(bytes));
    }
  });

  it('is not a RoaringBitmap32 at run time', () => {
    expect(RoaringBitmap.deserialize(sample().serialize('portable'))).not.toBeInstanceOf(
      RoaringBitmap32,
    );
  });

  it('answers has for members, non-members, 2^32 - 1, and at the edges of a bitset and a run chunk', () => {
    const optimized = sample();
    optimized.runOptimize();
    for (const b of [sample(), optimized]) {
      const decoded = RoaringBitmap.deserialize(b.serialize('portable'));
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
    const ids = [...RoaringBitmap.deserialize(sample().serialize('portable'))];
    expect(ids.length).toBeGreaterThan(40_000);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('are read from a Buffer and from a view at an offset into a larger buffer', () => {
    const bytes = sample().serialize('portable');
    expect(RoaringBitmap.deserialize(Buffer.from(bytes)).size).toBe(sample().size);
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 3);
    expect(RoaringBitmap.deserialize(padded.subarray(3, 3 + bytes.length)).size).toBe(
      sample().size,
    );
  });

  it('are read from a SharedArrayBuffer as a copy, which a later write to the shared bytes does not reach', () => {
    const bytes = sample().serialize('portable');
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
    shared.set(bytes);
    const decoded = RoaringBitmap.deserialize(shared);
    expect(decoded.size).toBe(sample().size);
    shared.fill(0xff);
    expect(decoded.toArray()).toEqual(RoaringBitmap32.deserialize(bytes, 'portable').toArray());
  });

  it('are accepted by a load too; an empty buffer is the one input they differ on', async () => {
    expect(await loadRefuses(sample().serialize('portable'))).toBe(false);
    expect(await loadRefuses(new Uint8Array(0))).toBe(false);
    expect(() => RoaringBitmap.deserialize(new Uint8Array(0))).toThrow(ValidationError);
    expect(() => RoaringBitmap.deserialize(new Uint8Array(0))).toThrow(
      /empty buffer is not a bitmap/,
    );
  });

  it('an empty bitmap has bytes of its own, which decode to the empty bitmap', () => {
    const bytes = new RoaringBitmap().serialize();
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(RoaringBitmap.deserialize(bytes).isEmpty).toBe(true);
  });

  it('a detached buffer is refused as an empty one is', () => {
    const buffer = new ArrayBuffer(16);
    const view = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    expect(view.byteLength).toBe(0);
    expect(() => RoaringBitmap.deserialize(view)).toThrow(ValidationError);
  });
});

describe('RoaringBitmap.deserialize: bytes it refuses, as a load refuses them', () => {
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
    const bytes = make();
    expect(() => RoaringBitmap.deserialize(bytes as Uint8Array)).toThrow(ValidationError);
    expect(await loadRefuses(bytes)).toBe(true);
  });

  it('accepts the good bytes the cases above are made from (a control for them)', () => {
    expect(RoaringBitmap.deserialize(good()).size).toBe(sample().size);
  });

  it('every prefix of a bitmap shorter than the bitmap, the empty one included, is refused', () => {
    const bytes = good();
    for (let n = 0; n < bytes.length; n++) {
      expect(() => RoaringBitmap.deserialize(bytes.subarray(0, n))).toThrow(ValidationError);
    }
  });

  it.each(['croaring', 'unsafe_frozen_croaring'] as const)(
    'a %s serialization is not portable bytes',
    (format) => {
      expect(() => RoaringBitmap.deserialize(sample().serialize(format))).toThrow(ValidationError);
    },
  );

  it('the over-cap refusal says to runOptimize()', () => {
    expect(() => RoaringBitmap.deserialize(new Uint8Array(MAX_SERIALIZED_LOAD_BYTES + 1))).toThrow(
      /runOptimize/,
    );
  });
});

describe('decodeSerialized: the size cap, at its boundary, in front of the codec', () => {
  /** A codec that records what reaches it and decodes nothing. */
  function recording(): { codec: CodecInterface; lengths: number[] } {
    const lengths: number[] = [];
    const codec: CodecInterface = {
      ...tsRoaringCodec,
      safeDeserialize: (bytes) => {
        lengths.push(bytes.byteLength);
        return tsRoaringCodec.empty();
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
    expect(() => decodeSerialized(new Uint8Array(1), tsRoaringCodec)).toThrow(
      /^the buffer is not a valid bitmap: /,
    );
    expect(() => decodeSerialized('x', codec, '{ serialized }')).toThrow(
      /^\{ serialized \} must be/,
    );
  });
});

describe('RoaringBitmap.deserialize: one checked read of the input', () => {
  const good = (): Uint8Array => new RoaringBitmap([1, 2, 3]).serialize();

  it('refuses an object that only claims the tag, with a ValidationError and not a TypeError', () => {
    const forged = { [Symbol.toStringTag]: 'Uint8Array' } as unknown as Uint8Array;
    expect(() => RoaringBitmap.deserialize(forged)).toThrow(ValidationError);
    expect(() => RoaringBitmap.deserialize(forged, { maxBytes: 100 })).toThrow(ValidationError);
  });

  it('reads the bytes a subclass holds, whatever its byteLength getter says', () => {
    class Liar extends Uint8Array {
      override get byteLength(): number {
        return 0;
      }
    }
    const bytes = good();
    const liar = new Liar(bytes);
    expect(RoaringBitmap.deserialize(liar).toArray()).toEqual([1, 2, 3]);
    expect(() => RoaringBitmap.deserialize(liar, { maxBytes: bytes.length - 1 })).toThrow(
      /maxBytes/,
    );
  });

  it('holds maxBytes to the bytes that are decoded, from one read of the length', () => {
    const bytes = good();
    let reads = 0;
    const counted = new Proxy(bytes, {
      get(target, key) {
        if (key === 'byteLength') reads += 1;
        return Reflect.get(target, key, target) as unknown;
      },
    });
    expect(() => RoaringBitmap.deserialize(counted, { maxBytes: bytes.length - 1 })).toThrow(
      ValidationError,
    );
    expect(reads).toBe(0);
  });

  it('reads a length-tracking view of a resizable buffer as the bytes it holds now', () => {
    const bytes = good();
    type Resizable = ArrayBuffer & { resize(length: number): void };
    const Resizable = ArrayBuffer as unknown as new (
      length: number,
      options: { maxByteLength: number },
    ) => Resizable;
    const buffer = new Resizable(bytes.length, { maxByteLength: bytes.length + 64 });
    const view = new Uint8Array(buffer);
    view.set(bytes);
    expect(RoaringBitmap.deserialize(view).toArray()).toEqual([1, 2, 3]);
    buffer.resize(bytes.length + 1);
    expect(() => RoaringBitmap.deserialize(view)).toThrow(ValidationError);
    expect(() => RoaringBitmap.deserialize(view, { maxBytes: bytes.length })).toThrow(/maxBytes/);
    buffer.resize(0);
    expect(() => RoaringBitmap.deserialize(view)).toThrow(/empty or detached/);
  });
});

describe('decodeSerialized: maxBytes and refuseEmpty', () => {
  it('refuses an empty buffer only when asked, and lowers the cap only when given', () => {
    expect(decodeSerialized(new Uint8Array(0), tsRoaringCodec).isEmpty).toBe(true);
    expect(() =>
      decodeSerialized(new Uint8Array(0), tsRoaringCodec, 'the buffer', { refuseEmpty: true }),
    ).toThrow(/empty or detached/);
    const bytes = new RoaringBitmap([7]).serialize();
    expect(decodeSerialized(bytes, tsRoaringCodec, 'x', { maxBytes: bytes.length }).size).toBe(1);
    expect(() =>
      decodeSerialized(bytes, tsRoaringCodec, 'x', { maxBytes: bytes.length - 1 }),
    ).toThrow(/^x is \d+ bytes, more than the \d+ this call allows/);
  });
});

describe('a decoded RoaringBitmap, loaded', () => {
  const SEG = { segment: 'decoded' };
  type Load = (decoded: RoaringBitmap) => LoadInput;
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
    expect(Buffer.from(await written(make(RoaringBitmap.deserialize(bytes))))).toEqual(
      Buffer.from(expected),
    );
  });

  it.each(loads)('%s is serialized once and never iterated', async (_name, make) => {
    const decoded = RoaringBitmap.deserialize(sample().serialize('portable'));
    const serialize = vi.spyOn(decoded, 'serialize');
    const iterate = vi.spyOn(decoded, Symbol.iterator);
    await written(make(decoded));
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(iterate).not.toHaveBeenCalled();
  });

  it('bare, with sorted: true, is refused as a bitmap is', async () => {
    const decoded = RoaringBitmap.deserialize(sample().serialize('portable'));
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await expect(store.load(SEG, decoded, { sorted: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('RoaringBitmap.deserialize: its second argument', () => {
  const bytes = (): Uint8Array => sample().serialize('portable');
  const call = (second: unknown): unknown =>
    (RoaringBitmap.deserialize as (a: Uint8Array, b: unknown) => unknown)(bytes(), second);

  it('takes { maxBytes } and nothing, and the cap lowers', () => {
    expect(RoaringBitmap.deserialize(bytes(), undefined).size).toBe(sample().size);
    expect(RoaringBitmap.deserialize(bytes(), {}).size).toBe(sample().size);
    expect(RoaringBitmap.deserialize(bytes(), { maxBytes: bytes().length }).size).toBe(
      sample().size,
    );
    expect(RoaringBitmap.deserialize(bytes(), { maxBytes: MAX_SERIALIZED_LOAD_BYTES }).size).toBe(
      sample().size,
    );
    expect(() => RoaringBitmap.deserialize(bytes(), { maxBytes: bytes().length - 1 })).toThrow(
      ValidationError,
    );
  });

  it('refuses a maxBytes over the cap, a fraction, a negative, NaN and a string', () => {
    for (const maxBytes of [MAX_SERIALIZED_LOAD_BYTES + 1, 1.5, -1, Number.NaN, '10']) {
      expect(() => call({ maxBytes })).toThrow(ValidationError);
    }
  });

  it('refuses a maxBytes lower than the input before a byte is read', () => {
    const read = vi.spyOn(tsRoaringCodec, 'safeDeserialize');
    expect(() => RoaringBitmap.deserialize(bytes(), { maxBytes: 8 })).toThrow(/maxBytes/);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([['portable'], [true], [1], [null], [[]]])(
    'refuses %j, a format argument as a migrated call passes',
    (second) => {
      expect(() => call(second)).toThrow(ValidationError);
    },
  );

  it('says there is no format argument for a string or boolean second argument', () => {
    expect(() => call('portable')).toThrow(/no format argument/);
    expect(() => call(true)).toThrow(/no format argument/);
  });

  it('refuses any other key', () => {
    expect(() => call({ maxByte: 5 })).toThrow(/unknown option/);
  });
});
