import { describe, expect, it } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';

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
      for (const list of [[3, bad as number], new Set([3, bad as number])]) {
        const b = fresh();
        expect(() => b.addMany(list)).toThrow(ValidationError);
        expect(() => b.removeMany(list)).toThrow(ValidationError);
        expect(b.toArray(), 'a refused call changes nothing, 3 and 1 included').toEqual([
          1,
          2,
          70_000,
          TOP,
        ]);
      }
    },
  );

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
    for (const op of ['andInPlace', 'orInPlace', 'andNotInPlace'] as const) {
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
