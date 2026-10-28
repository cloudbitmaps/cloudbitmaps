import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';
import { TsBitmap } from '@/ts-roaring/bitmap';

/**
 * Every refusal of the public class: what is refused, that it is a `ValidationError` (never a `TypeError`, whatever
 * the argument's type), and that the bitmap is as it was afterwards.
 */
const TOP = 0xffff_ffff;

/** Values that are not ids, of every type a caller can pass, and the ones at the edges that are. */
const NOT_IDS: ReadonlyArray<readonly [string, unknown]> = [
  ['a negative number', -1],
  ['a fraction', 1.5],
  ['one past the top id', TOP + 1],
  ['NaN', Number.NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a numeric string', '5'],
  ['a string', 'x'],
  ['null', null],
  ['undefined', undefined],
  ['a boolean', true],
  ['a BigInt', 5n],
  ['a Symbol', Symbol('id')],
  ['an object with a valueOf', { valueOf: () => 5 }],
  ['an array', [5]],
  ['a function', () => 5],
  ['an object with no prototype', Object.create(null)],
  ['an object whose valueOf gives a BigInt', { valueOf: () => 1n }],
  ['an object whose toPrimitive gives a Symbol', { [Symbol.toPrimitive]: () => Symbol('id') }],
  [
    'an object whose valueOf throws',
    {
      valueOf: () => {
        throw new RangeError('the caller own error');
      },
    },
  ],
];

const IDS_AT_THE_EDGES = [0, 1, 2 ** 31, TOP];

function fresh(): RoaringBitmap {
  return new RoaringBitmap([1, 2, 70_000, TOP]);
}

describe('an id argument that is not an id', () => {
  it.each(NOT_IDS)(
    '%s is refused by has, add and remove, and the bitmap is unchanged',
    (_n, bad) => {
      for (const call of [
        (b: RoaringBitmap) => b.has(bad as number),
        (b: RoaringBitmap) => b.add(bad as number),
        (b: RoaringBitmap) => b.remove(bad as number),
      ]) {
        const b = fresh();
        expect(() => call(b)).toThrow(ValidationError);
        expect(b.toArray()).toEqual([1, 2, 70_000, TOP]);
      }
    },
  );

  it.each(NOT_IDS)(
    '%s is refused inside addMany, removeMany and the constructor, before anything changes',
    (_n, bad) => {
      for (const make of [
        () => new RoaringBitmap([3, bad as number]),
        () => new RoaringBitmap(new Set([3, bad as number])),
        () =>
          new RoaringBitmap(
            (function* () {
              yield 3;
              yield bad as number;
            })(),
          ),
      ]) {
        expect(make).toThrow(ValidationError);
      }
      // Each list puts a value that would change the bitmap before the bad one: 3 is absent (an add that applies as it
      // goes inserts it) and 2 is held (a remove that applies as it goes deletes it).
      const lists = (good: number): Array<Iterable<number>> => [
        [good, bad as number],
        new Set([good, bad as number]),
      ];
      for (const list of lists(3)) {
        const b = fresh();
        expect(() => b.addMany(list)).toThrow(ValidationError);
        expect(b.toArray(), 'a refused addMany adds nothing, 3 included').toEqual([
          1,
          2,
          70_000,
          TOP,
        ]);
      }
      for (const list of lists(2)) {
        const b = fresh();
        expect(() => b.removeMany(list)).toThrow(ValidationError);
        expect(b.toArray(), 'a refused removeMany removes nothing, 2 included').toEqual([
          1,
          2,
          70_000,
          TOP,
        ]);
      }
    },
  );

  it('lets a failure on a number through as it is: only a value that is not a number is converted', () => {
    // The first read of each index throws and later reads answer, so the catch finds a number where the loop failed.
    const call = (run: (list: number[]) => unknown): unknown => {
      const seen = new Set<string>();
      const list = new Proxy([1, 2, 3], {
        get: (target, key, receiver) => {
          if (typeof key === 'string' && /^\d+$/.test(key) && !seen.has(key)) {
            seen.add(key);
            throw new TypeError('a getter of the caller fails');
          }
          return Reflect.get(target, key, receiver);
        },
      });
      try {
        run(list);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const run of [
      (list: number[]) => new RoaringBitmap(list),
      (list: number[]) => fresh().addMany(list),
      (list: number[]) => fresh().removeMany(list),
    ]) {
      const caught = call(run);
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught).not.toBeInstanceOf(ValidationError);
      expect((caught as Error).message).toBe('a getter of the caller fails');
    }
  });

  it.each(IDS_AT_THE_EDGES)('%i is an id for every method', (id) => {
    const b = new RoaringBitmap();
    expect(b.add(id).has(id)).toBe(true);
    expect(b.remove(id)).toBe(true);
    expect(b.addMany([id]).has(id)).toBe(true);
    expect(b.removeMany([id]).has(id)).toBe(false);
    expect(new RoaringBitmap([id]).has(id)).toBe(true);
  });
});

describe('add and remove take one id', () => {
  it('a second argument is a ValidationError that names addMany or removeMany, and nothing is added or removed', () => {
    const b = fresh();
    const add = b.add as (...a: unknown[]) => unknown;
    const remove = b.remove as (...a: unknown[]) => unknown;
    expect(() => add.call(b, 5, 6)).toThrow(/use addMany/);
    expect(() => remove.call(b, 1, 2)).toThrow(/use removeMany/);
    expect(() => add.call(b, 5, undefined)).toThrow(ValidationError);
    expect(() => remove.call(b, 1, undefined)).toThrow(ValidationError);
    expect(() => add.call(b)).toThrow(ValidationError);
    expect(() => remove.call(b)).toThrow(ValidationError);
    expect(b.toArray()).toEqual([1, 2, 70_000, TOP]);
  });

  it('is not tripped by Array.prototype.map passing an index and the array', () => {
    const b = new RoaringBitmap();
    expect(() => [1, 2].forEach((id) => b.add(id))).not.toThrow();
    expect(() => [1, 2].forEach(b.add, b)).toThrow(ValidationError);
    expect(b.toArray()).toEqual([1, 2]);
  });
});

describe('the constructor', () => {
  const NOT_ITERABLES: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['a number', 5],
    ['a string', '123'],
    ['an empty string', ''],
    ['a plain object', { 0: 1, length: 1 }],
    ['an ArrayBuffer', new ArrayBuffer(8)],
    ['a boolean', true],
    ['a function', () => 1],
  ];
  it.each(NOT_ITERABLES)('%s is refused as not an iterable of ids', (_n, value) => {
    expect(() => new RoaringBitmap(value as Iterable<number>)).toThrow(
      /values must be an iterable of ids/,
    );
    expect(() => fresh().addMany(value as Iterable<number>)).toThrow(ValidationError);
    expect(() => fresh().removeMany(value as Iterable<number>)).toThrow(ValidationError);
  });

  it.each([
    ['a Uint8Array', new Uint8Array([1, 2])],
    ['a Buffer', Buffer.from([1, 2])],
    ['a Uint8ClampedArray', new Uint8ClampedArray([1, 2])],
    ['an empty Uint8Array', new Uint8Array(0)],
  ])('%s is refused with a pointer to RoaringBitmap.deserialize', (_n, bytes) => {
    expect(() => new RoaringBitmap(bytes)).toThrow(/RoaringBitmap\.deserialize/);
    expect(() => fresh().addMany(bytes)).toThrow(/RoaringBitmap\.deserialize/);
    expect(() => fresh().removeMany(bytes)).toThrow(/RoaringBitmap\.deserialize/);
  });

  it('other typed arrays are iterables of numbers: read, and every element checked', () => {
    expect(new RoaringBitmap(new Uint16Array([3, 1, 2])).toArray()).toEqual([1, 2, 3]);
    expect(new RoaringBitmap(new Float64Array([1, 2])).toArray()).toEqual([1, 2]);
    expect(() => new RoaringBitmap(new Float64Array([1, 1.5]))).toThrow(ValidationError);
    expect(() => new RoaringBitmap(new Int32Array([1, -1]))).toThrow(ValidationError);
  });

  it('a Uint32Array is never changed, a shared one is read as a copy, and the bitmap keeps none of it', () => {
    const unsorted = Uint32Array.from([9, 3, 5, 3]);
    const b = new RoaringBitmap(unsorted);
    expect([...unsorted]).toEqual([9, 3, 5, 3]);
    unsorted.fill(0);
    expect(b.toArray()).toEqual([3, 5, 9]);
    const shared = new Uint32Array(new SharedArrayBuffer(16));
    shared.set([8, 6, 7, 6]);
    const c = new RoaringBitmap(shared);
    shared.fill(1);
    expect(c.toArray()).toEqual([6, 7, 8]);
    const d = fresh();
    const toRemove = Uint32Array.from([70_000, 1]);
    d.removeMany(toRemove);
    expect([...toRemove], 'removeMany leaves its argument as it was').toEqual([70_000, 1]);
    expect(d.toArray()).toEqual([2, TOP]);
  });

  /** Constructors that take a `maxByteLength`, which the compiled library's types do not yet declare. */
  const GrowableCtor = ArrayBuffer as unknown as new (
    n: number,
    o: { maxByteLength: number },
  ) => ArrayBuffer;
  const GrowableShared = SharedArrayBuffer as unknown as new (
    n: number,
    o: { maxByteLength: number },
  ) => SharedArrayBuffer;

  describe('which typed arrays are copied before the codec reads them', () => {
    afterEach(() => vi.restoreAllMocks());

    const forged = (b: ArrayBufferLike, tag: string): ArrayBufferLike => {
      Object.defineProperty(b, Symbol.toStringTag, { value: tag });
      return b;
    };
    const kinds: ReadonlyArray<readonly [string, () => Uint32Array, boolean]> = [
      ['an ArrayBuffer', () => new Uint32Array(new ArrayBuffer(16)), false],
      [
        'a resizable ArrayBuffer',
        () => new Uint32Array(new GrowableCtor(16, { maxByteLength: 32 })),
        false,
      ],
      [
        'an ArrayBuffer whose tag is forged to SharedArrayBuffer',
        () => new Uint32Array(forged(new ArrayBuffer(16), 'SharedArrayBuffer')),
        false,
      ],
      ['a SharedArrayBuffer', () => new Uint32Array(new SharedArrayBuffer(16)), true],
      [
        'a growable SharedArrayBuffer',
        () => new Uint32Array(new GrowableShared(16, { maxByteLength: 32 })),
        true,
      ],
      [
        'a SharedArrayBuffer whose tag is forged to ArrayBuffer',
        () => new Uint32Array(forged(new SharedArrayBuffer(16), 'ArrayBuffer')),
        true,
      ],
      [
        'a SharedArrayBuffer whose prototype is ArrayBuffer.prototype',
        () => {
          const b = new SharedArrayBuffer(16);
          Object.setPrototypeOf(b, ArrayBuffer.prototype);
          return new Uint32Array(b);
        },
        true,
      ],
      [
        'a SharedArrayBuffer made in another context',
        () => new Uint32Array(runInNewContext('new SharedArrayBuffer(16)') as SharedArrayBuffer),
        true,
      ],
      [
        'an ArrayBuffer made in another context',
        () => new Uint32Array(runInNewContext('new ArrayBuffer(16)') as ArrayBuffer),
        false,
      ],
      [
        'a Proxy over a Uint32Array, which is no buffer the brand can name',
        () =>
          new Proxy(new Uint32Array(4), {
            get: (target, key) => {
              const v: unknown = Reflect.get(target, key, target);
              return typeof v === 'function' ? (v as () => unknown).bind(target) : v;
            },
          }),
        true,
      ],
    ];

    it.each(kinds)('%s: addMany copies it', (_name, make, copied) => {
      const source = make();
      source.set([8, 6, 7, 6]);
      const spy = vi.spyOn(TsBitmap.prototype, 'addMany');
      const b = new RoaringBitmap();
      b.addMany(source);
      const seen = spy.mock.calls[0]![0] as Uint32Array;
      source.fill(1);
      expect(seen === source).toBe(!copied);
      expect([...seen]).toEqual(copied ? [8, 6, 7, 6] : [1, 1, 1, 1]);
      expect(b.toArray()).toEqual([6, 7, 8]);
    });

    it.each(kinds)('%s: the constructor copies it', (_name, make, copied) => {
      const source = make();
      source.set([8, 6, 7, 6]);
      const spy = vi.spyOn(TsBitmap.prototype, 'addMany');
      const b = new RoaringBitmap(source);
      const seen = spy.mock.calls[0]![0] as Uint32Array;
      source.fill(1);
      expect(seen === source).toBe(!copied);
      expect([...seen]).toEqual(copied ? [8, 6, 7, 6] : [1, 1, 1, 1]);
      expect(b.toArray()).toEqual([6, 7, 8]);
    });

    it.each(kinds)('%s: removeMany copies it', (_name, make, copied) => {
      const source = make();
      source.set([8, 6, 7, 6]);
      const spy = vi.spyOn(TsBitmap.prototype, 'removeMany');
      const b = new RoaringBitmap([5, 6, 7, 8]);
      b.removeMany(source);
      const seen = spy.mock.calls[0]![0] as Uint32Array;
      source.fill(1);
      expect(seen === source).toBe(!copied);
      expect(b.toArray()).toEqual([5]);
    });
  });

  it('a bitmap passed in is cloned: the two are independent', () => {
    const a = fresh();
    const b = new RoaringBitmap(a);
    b.add(9);
    a.remove(1);
    expect(a.toArray()).toEqual([2, 70_000, TOP]);
    expect(b.toArray()).toEqual([1, 2, 9, 70_000, TOP]);
  });
});

describe('an operand that is not a RoaringBitmap', () => {
  it('is a ValidationError that says what combines with what, even for a duck of the same shape', () => {
    const duck = Object.assign(Object.create(null) as object, {
      size: 1,
      has: () => true,
      [Symbol.iterator]: function* () {
        yield 1;
      },
    }) as unknown as RoaringBitmap;
    for (const op of ['andInPlace', 'orInPlace', 'andNotInPlace', 'xorInPlace'] as const) {
      expect(() => fresh()[op](duck)).toThrow(/another RoaringBitmap of this copy/);
    }
  });
});

describe('serialize', () => {
  it('takes nothing or "portable"', () => {
    const b = fresh();
    expect(b.serialize()).toEqual(b.serialize('portable'));
  });

  it.each([['croaring'], [''], [null], [5], [true], [{}], [[]]])('refuses %j', (format) => {
    expect(() => (fresh().serialize as (f: unknown) => unknown)(format)).toThrow(ValidationError);
  });
});

describe('deserialize arguments', () => {
  it.each([
    ['a string', 'x'],
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2]],
    ['a Uint16Array', new Uint16Array(8)],
    ['a number', 5],
    ['an object', {}],
  ])('%s is not bytes', (_n, value) => {
    expect(() => RoaringBitmap.deserialize(value as Uint8Array)).toThrow(ValidationError);
  });
});
