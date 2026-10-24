import fc from 'fast-check';
import { RoaringBitmap32 } from 'roaring';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';
import { RoaringBitmap as FromSubpath } from '@/bitmap';
import {
  buildSet,
  crOf,
  crStoredBytes,
  describeDifference,
  firstDifference,
  relatedTo,
  setSpec,
} from '../helpers/roaring-oracle';

vi.setConfig({ testTimeout: 60_000 });

/**
 * The public class held to CRoaring, through the `roaring` package's public API, on every P1 method: the ids it holds,
 * its extremes, the boolean `remove` answers, the in-place combines, `runOptimize`'s bytes, and the bytes a decode
 * reads back. Sets reach 2^31 and 0xFFFFFFFF, which a uniform random set almost never hits.
 */
const TOP = 0xffff_ffff;
const HALF = 2 ** 31;

/** Contents compared without printing a multi-megabyte array when they differ. */
function expectSame(label: string, got: ArrayLike<number>, want: ArrayLike<number>): void {
  expect(firstDifference(got, want), describeDifference(label, got, want)).toBe(-1);
}

function expectHolds(label: string, bitmap: RoaringBitmap, oracle: RoaringBitmap32): void {
  expectSame(`${label}: contents`, bitmap.toUint32Array(), oracle.toUint32Array());
  expect(bitmap.size, `${label}: size`).toBe(oracle.size);
  expect(bitmap.isEmpty, `${label}: isEmpty`).toBe(oracle.isEmpty);
  expect(bitmap.minimum(), `${label}: minimum`).toBe(oracle.isEmpty ? undefined : oracle.minimum());
  expect(bitmap.maximum(), `${label}: maximum`).toBe(oracle.isEmpty ? undefined : oracle.maximum());
}

const EDGES = [0, 1, 4_095, 4_096, 65_535, 65_536, 65_537, HALF - 1, HALF, HALF + 1, TOP - 1, TOP];

const CORPUS: ReadonlyArray<readonly [string, number[]]> = [
  ['empty', []],
  ['one id at 0', [0]],
  ['one id at 2^31', [HALF]],
  ['one id at 0xFFFFFFFF', [TOP]],
  ['the edges', [...EDGES].sort((a, b) => a - b)],
  ['a full container', Array.from({ length: 65_536 }, (_, i) => i)],
  ['a full top container', Array.from({ length: 65_536 }, (_, i) => TOP - i).reverse()],
  [
    'runs across the 2^31 line',
    [...Array.from({ length: 3_000 }, (_, i) => HALF - 1_500 + i), TOP - 2, TOP - 1, TOP],
  ],
  ['a bitset at the boundary', Array.from({ length: 4_097 }, (_, i) => i * 3)],
  ['an array at the boundary', Array.from({ length: 4_096 }, (_, i) => i * 3)],
];

describe('RoaringBitmap against CRoaring: building', () => {
  it.each(CORPUS)(
    '%s: built from an array, a Uint32Array, a Set, another bitmap and a decode',
    (_n, ids) => {
      const oracle = crOf(ids);
      expectHolds('array', new RoaringBitmap(ids), oracle);
      expectHolds('Uint32Array', new RoaringBitmap(Uint32Array.from(ids)), oracle);
      expectHolds('Set', new RoaringBitmap(new Set(ids)), oracle);
      const reversed = Uint32Array.from([...ids].reverse());
      expectHolds('unsorted Uint32Array', new RoaringBitmap(reversed), oracle);
      expect(reversed[0], 'a typed array passed in is not sorted in place').toBe(
        ids.at(-1) ?? undefined,
      );
      const built = new RoaringBitmap(ids);
      expectHolds('clone', new RoaringBitmap(built), oracle);
      expectHolds('clone()', built.clone(), oracle);
      expectHolds('deserialize', RoaringBitmap.deserialize(built.serialize()), oracle);
      expectSame('iteration', [...built], oracle.toUint32Array());
      expectSame('toArray', built.toArray(), oracle.toUint32Array());
    },
  );

  it('repeated ids and unsorted ids give the set', () => {
    expect(new RoaringBitmap([5, 3, 5, 9, 3]).toArray()).toEqual([3, 5, 9]);
  });

  it('the main entry and the ./bitmap subpath give one class', () => {
    expect(FromSubpath).toBe(RoaringBitmap);
  });

  it('an iterable that is not an array is read once', () => {
    let reads = 0;
    function* ids(): Generator<number> {
      reads++;
      yield* [7, 1, 2 ** 32 - 1];
    }
    expect(new RoaringBitmap(ids()).toArray()).toEqual([1, 7, TOP]);
    expect(reads).toBe(1);
  });
});

describe('RoaringBitmap against CRoaring: has, add, remove, clear', () => {
  it.each(CORPUS)('%s: has agrees on members, on non-members and on the edges', (_n, ids) => {
    const bitmap = new RoaringBitmap(ids);
    const oracle = crOf(ids);
    const probes = [
      ...EDGES,
      ...ids.filter((_, i) => i % 97 === 0),
      ...ids.map((v) => v + 1).slice(0, 50),
    ];
    for (const id of probes) {
      if (id > TOP) continue;
      expect(bitmap.has(id), `has(${id})`).toBe(oracle.has(id));
    }
  });

  it('add returns this, remove answers whether the id was there, and both agree with a Set', () => {
    const bitmap = new RoaringBitmap();
    const model = new Set<number>();
    for (const id of [...EDGES, 5, 5, 70_000, HALF, TOP, 0, 0]) {
      expect(bitmap.add(id)).toBe(bitmap);
      model.add(id);
      expect(bitmap.size).toBe(model.size);
    }
    for (const id of [5, 5, 6, HALF, HALF, TOP, TOP, 0, 123_456_789]) {
      expect(bitmap.remove(id), `remove(${id})`).toBe(model.delete(id));
      expect(bitmap.has(id)).toBe(false);
      expect(bitmap.size).toBe(model.size);
    }
    expect(bitmap.toArray()).toEqual([...model].sort((a, b) => a - b));
  });

  it('removing the last id of a container drops the container and the extremes follow', () => {
    const bitmap = new RoaringBitmap([3, 70_000, TOP]);
    expect(bitmap.remove(TOP)).toBe(true);
    expect(bitmap.maximum()).toBe(70_000);
    expect(bitmap.remove(3)).toBe(true);
    expect(bitmap.minimum()).toBe(70_000);
    expect(bitmap.remove(70_000)).toBe(true);
    expect(bitmap.isEmpty).toBe(true);
    expect(bitmap.minimum()).toBeUndefined();
    expect(bitmap.maximum()).toBeUndefined();
  });

  it('minimum and maximum are undefined when empty, where roaring answers 0xFFFFFFFF and 0', () => {
    const oracle = new RoaringBitmap32();
    expect([oracle.minimum(), oracle.maximum()]).toEqual([TOP, 0]);
    expect([new RoaringBitmap().minimum(), new RoaringBitmap().maximum()]).toEqual([
      undefined,
      undefined,
    ]);
    expect(new RoaringBitmap([0]).maximum()).toBe(0);
    expect(new RoaringBitmap([TOP]).minimum()).toBe(TOP);
  });

  it('addMany, removeMany and clear agree with CRoaring, and chain', () => {
    const bitmap = new RoaringBitmap([1, 2, 3]);
    const oracle = crOf([1, 2, 3]);
    expect(bitmap.addMany([HALF, TOP, 70_000, 2])).toBe(bitmap);
    oracle.addMany([HALF, TOP, 70_000, 2]);
    expectHolds('addMany', bitmap, oracle);
    expect(bitmap.removeMany(new Uint32Array([2, 70_000, 99, TOP]))).toBe(bitmap);
    oracle.removeMany([2, 70_000, 99, TOP]);
    expectHolds('removeMany', bitmap, oracle);
    expect(bitmap.clear()).toBeUndefined();
    expectHolds('clear', bitmap, new RoaringBitmap32());
    bitmap.add(4);
    expect(bitmap.toArray()).toEqual([4]);
  });

  it('addMany and removeMany of a RoaringBitmap are the union and the difference', () => {
    const bitmap = new RoaringBitmap([1, 2, 3]);
    bitmap.addMany(new RoaringBitmap([3, 4]));
    expect(bitmap.toArray()).toEqual([1, 2, 3, 4]);
    bitmap.removeMany(new RoaringBitmap([2, 4, 9]));
    expect(bitmap.toArray()).toEqual([1, 3]);
  });
});

describe('RoaringBitmap against CRoaring: in-place combines', () => {
  const pairs = CORPUS.flatMap(([an, a]) =>
    CORPUS.map(([bn, b]) => [`${an} against ${bn}`, a, b] as const),
  );

  it.each(pairs)('%s', (_n, a, b) => {
    for (const [name, mine, theirs] of [
      ['and', 'andInPlace', 'andInPlace'],
      ['or', 'orInPlace', 'orInPlace'],
      ['andNot', 'andNotInPlace', 'andNotInPlace'],
    ] as const) {
      const left = new RoaringBitmap(a);
      const right = new RoaringBitmap(b);
      const oracle = crOf(a);
      expect(left[mine](right), `${name} returns this`).toBe(left);
      oracle[theirs](crOf(b));
      expectHolds(name, left, oracle);
      expectSame(
        `${name}: the operand is untouched`,
        right.toUint32Array(),
        crOf(b).toUint32Array(),
      );
    }
  });

  it('a bitmap combined with itself', () => {
    const a = new RoaringBitmap([1, 2, 70_000, TOP]);
    a.orInPlace(a).andInPlace(a);
    expect(a.toArray()).toEqual([1, 2, 70_000, TOP]);
    a.andNotInPlace(a);
    expect(a.isEmpty).toBe(true);
  });

  it('random sets of container shapes agree', () => {
    fc.assert(
      fc.property(
        setSpec(4),
        fc.constantFrom('subset', 'superset', 'shift', 'copy', 'stranger'),
        fc.integer({ min: 0, max: 0x7fffffff }),
        setSpec(3),
        (spec, mode, salt, other) => {
          const a = buildSet(spec);
          const b = relatedTo(a, mode, salt, buildSet(other));
          for (const op of ['andInPlace', 'orInPlace', 'andNotInPlace'] as const) {
            const mine = new RoaringBitmap(a);
            const oracle = crOf(a);
            mine[op](new RoaringBitmap(b));
            oracle[op](crOf(b));
            expectHolds(`${op} (${mode})`, mine, oracle);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('RoaringBitmap against CRoaring: bytes', () => {
  it.each(CORPUS)('%s: runOptimize then serialize is CRoaring’s stored bytes', (_n, ids) => {
    const bitmap = new RoaringBitmap(ids);
    const oracle = crOf(ids);
    oracle.removeRunCompression();
    const hadRuns = oracle.runOptimize();
    expect(bitmap.runOptimize(), 'true when a run container is held afterwards').toBe(hadRuns);
    const want = crStoredBytes(ids);
    expect(Buffer.from(bitmap.serialize()).equals(Buffer.from(want))).toBe(true);
    expect(Buffer.from(bitmap.serialize('portable')).equals(Buffer.from(want))).toBe(true);
    expectHolds('after runOptimize', bitmap, crOf(ids));
  });

  it('runOptimize answers a membership-neutral true or false that does not mean something changed', () => {
    const sparse = new RoaringBitmap([1, 5, 9]);
    expect(sparse.runOptimize()).toBe(false);
    expect(sparse.runOptimize()).toBe(false);
    const runs = new RoaringBitmap(Array.from({ length: 5_000 }, (_, i) => i));
    expect(runs.runOptimize()).toBe(true);
    expect(runs.runOptimize()).toBe(true);
  });

  it('serialize returns a new Uint8Array each call, and reads back as the same set', () => {
    const bitmap = new RoaringBitmap([1, 70_000, TOP]);
    const first = bitmap.serialize();
    expect(first).toBeInstanceOf(Uint8Array);
    first.fill(0);
    expect(RoaringBitmap.deserialize(bitmap.serialize()).toArray()).toEqual([1, 70_000, TOP]);
  });

  it('decodes what CRoaring wrote, run containers included, and keeps the runs', () => {
    const oracle = new RoaringBitmap32();
    oracle.addRange(10, 40_000);
    oracle.add(TOP);
    oracle.runOptimize();
    const bytes = oracle.serialize('portable' as never);
    const decoded = RoaringBitmap.deserialize(bytes);
    expectHolds('decoded', decoded, oracle);
    expect(Buffer.from(decoded.serialize()).equals(Buffer.from(bytes))).toBe(true);
  });

  it('toUint32Array hands out an array the caller owns', () => {
    const bitmap = new RoaringBitmap([5, 6, 7]);
    bitmap.toUint32Array().fill(0);
    expect(bitmap.toArray()).toEqual([5, 6, 7]);
  });
});

describe('RoaringBitmap: what is not part of it', () => {
  it('has no toJSON, so JSON.stringify of one is "{}" and the explicit forms hold the ids', () => {
    const bitmap = new RoaringBitmap([1, 2]);
    expect('toJSON' in bitmap).toBe(false);
    expect(JSON.stringify(bitmap)).toBe('{}');
    expect(JSON.stringify([...bitmap])).toBe('[1,2]');
    expect(JSON.stringify(bitmap.toArray())).toBe('[1,2]');
  });

  it('shows no member beyond the documented ones', () => {
    const names = new Set<string>();
    for (let o = RoaringBitmap.prototype as object; o !== Object.prototype;) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
      o = Object.getPrototypeOf(o) as object;
    }
    expect([...names].sort()).toEqual(
      [
        'add',
        'addMany',
        'andInPlace',
        'andNotInPlace',
        'clear',
        'clone',
        'constructor',
        'has',
        'isEmpty',
        'maximum',
        'minimum',
        'orInPlace',
        'remove',
        'removeMany',
        'runOptimize',
        'serialize',
        'size',
        'toArray',
        'toUint32Array',
      ].sort(),
    );
    expect(Object.getOwnPropertyNames(new RoaringBitmap([1]))).toEqual([]);
  });

  it('is refused by a ValidationError, not a TypeError, as an operand when it is not one of this package', () => {
    const mine = new RoaringBitmap([1]);
    for (const other of [crOf([1]), { size: 1 }, null, undefined, 5, [1]]) {
      for (const op of ['andInPlace', 'orInPlace', 'andNotInPlace'] as const) {
        expect(() => mine[op](other as unknown as RoaringBitmap)).toThrow(ValidationError);
      }
    }
    expect(mine.toArray()).toEqual([1]);
  });
});
