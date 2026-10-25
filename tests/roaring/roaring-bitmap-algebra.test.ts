import fc from 'fast-check';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { RoaringBitmap32 } from 'roaring';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';
import {
  buildSet,
  crOf,
  describeDifference,
  firstDifference,
  relatedTo,
  setSpec,
} from '../helpers/roaring-oracle';

vi.setConfig({ testTimeout: 120_000 });

/**
 * The combines that return a new bitmap (`and`, `or`, `xor`, `andNot`, `orMany`) and `xorInPlace`, held to CRoaring
 * through the `roaring` package's public API on every data shape the class's other oracle tests use, ids at 2^31 and at
 * 0xFFFFFFFF included; then the laws they obey, what copy-on-write keeps apart, what a result retains, and what is refused.
 */
const TOP = 0xffff_ffff;
const HALF = 2 ** 31;
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

const STATICS = ['and', 'or', 'xor', 'andNot'] as const;
type Static = (typeof STATICS)[number];

function expectSame(label: string, got: ArrayLike<number>, want: ArrayLike<number>): void {
  expect(firstDifference(got, want), describeDifference(label, got, want)).toBe(-1);
}

/** What CRoaring answers for `op` on two id lists, as the operation's own in-place form on a copy. */
function oracleOf(op: Static, a: readonly number[], b: readonly number[]): RoaringBitmap32 {
  const out = crOf(a);
  const that = crOf(b);
  if (op === 'and') out.andInPlace(that);
  else if (op === 'or') out.orInPlace(that);
  else if (op === 'xor') out.xorInPlace(that);
  else out.andNotInPlace(that);
  return out;
}

function expectHolds(label: string, bitmap: RoaringBitmap, oracle: RoaringBitmap32): void {
  expectSame(`${label}: contents`, bitmap.toUint32Array(), oracle.toUint32Array());
  expect(bitmap.size, `${label}: size`).toBe(oracle.size);
  expect(bitmap.isEmpty, `${label}: isEmpty`).toBe(oracle.isEmpty);
}

describe('the returning combines against CRoaring', () => {
  const pairs = CORPUS.flatMap(([an, a]) =>
    CORPUS.map(([bn, b]) => [`${an} against ${bn}`, a, b] as const),
  );

  it.each(pairs)('%s', (_n, a, b) => {
    for (const op of STATICS) {
      const left = new RoaringBitmap(a);
      const right = new RoaringBitmap(b);
      const out = RoaringBitmap[op](left, right);
      expect(out, `${op} returns a new bitmap`).not.toBe(left);
      expect(out, `${op} returns a new bitmap`).not.toBe(right);
      expectHolds(op, out, oracleOf(op, a, b));
      expectSame(`${op}: first operand`, left.toUint32Array(), crOf(a).toUint32Array());
      expectSame(`${op}: second operand`, right.toUint32Array(), crOf(b).toUint32Array());
    }
  });

  it.each(pairs)('xorInPlace, %s', (_n, a, b) => {
    const left = new RoaringBitmap(a);
    const right = new RoaringBitmap(b);
    expect(left.xorInPlace(right)).toBe(left);
    expectHolds('xorInPlace', left, oracleOf('xor', a, b));
    expectSame('xorInPlace: operand', right.toUint32Array(), crOf(b).toUint32Array());
  });

  it('a bitmap against itself', () => {
    const a = new RoaringBitmap([1, 2, 70_000, TOP]);
    expect(RoaringBitmap.and(a, a).toArray()).toEqual([1, 2, 70_000, TOP]);
    expect(RoaringBitmap.or(a, a).toArray()).toEqual([1, 2, 70_000, TOP]);
    expect(RoaringBitmap.xor(a, a).isEmpty).toBe(true);
    expect(RoaringBitmap.andNot(a, a).isEmpty).toBe(true);
    expect(a.xorInPlace(a).isEmpty).toBe(true);
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
          for (const op of STATICS) {
            expectHolds(
              `${op} (${mode})`,
              RoaringBitmap[op](new RoaringBitmap(a), new RoaringBitmap(b)),
              oracleOf(op, a, b),
            );
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('orMany of 0, 1, 2 and 9 bitmaps, with repeats, equals the union CRoaring makes', () => {
    const lists = CORPUS.map(([, ids]) => ids);
    for (const count of [0, 1, 2, 9]) {
      const picked = Array.from(
        { length: count },
        (_, i) => lists[(i * 3) % lists.length] as number[],
      );
      const out = RoaringBitmap.orMany(picked.map((ids) => new RoaringBitmap(ids)));
      expectHolds(
        `orMany of ${count}`,
        out,
        RoaringBitmap32.orMany(picked.map((ids) => crOf(ids))),
      );
    }
    const same = new RoaringBitmap([5, HALF]);
    expect(RoaringBitmap.orMany([same, same, same]).toArray()).toEqual([5, HALF]);
    expect(RoaringBitmap.orMany(new Set([same])).toArray()).toEqual([5, HALF]);
  });
});

const RUNS = { numRuns: 20 };
const mode = fc.constantFrom('subset', 'superset', 'shift', 'copy', 'stranger');
const salt = fc.integer({ min: 0, max: 0x7fffffff });
const triple = fc
  .tuple(setSpec(3), mode, salt, setSpec(2), mode, salt)
  .map(([spec, m1, s1, other, m2, s2]) => {
    const a = buildSet(spec);
    const stranger = buildSet(other);
    return { a, b: relatedTo(a, m1, s1, stranger), c: relatedTo(a, m2, s2, stranger) };
  });

function same(x: RoaringBitmap, y: RoaringBitmap | ArrayLike<number>): void {
  const want = y instanceof RoaringBitmap ? y.toUint32Array() : y;
  expectSame('contents', x.toUint32Array(), want);
}

const { and, or, xor, andNot } = RoaringBitmap;

describe('the returning combines: laws', () => {
  it('and, or and xor are commutative and associative', () => {
    fc.assert(
      fc.property(triple, ({ a, b, c }) => {
        const [A, B, C] = [new RoaringBitmap(a), new RoaringBitmap(b), new RoaringBitmap(c)];
        same(and(A, B), and(B, A));
        same(or(A, B), or(B, A));
        same(xor(A, B), xor(B, A));
        same(and(and(A, B), C), and(A, and(B, C)));
        same(or(or(A, B), C), or(A, or(B, C)));
        same(xor(xor(A, B), C), xor(A, xor(B, C)));
      }),
      RUNS,
    );
  });

  it('a xor a is empty, a xor empty is a, and xor is (a or b) andNot (a and b)', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
        expect(xor(A, A).isEmpty).toBe(true);
        same(xor(A, new RoaringBitmap()), A);
        same(xor(A, B), andNot(or(A, B), and(A, B)));
        expect(xor(A, B).size).toBe(A.size + B.size - 2 * and(A, B).size);
      }),
      RUNS,
    );
  });

  it('andNot is and with the complement, inside the universe of the test', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
        const universe = or(A, B);
        same(andNot(A, B), and(A, andNot(universe, B)));
        expect(andNot(A, A).isEmpty).toBe(true);
        same(andNot(A, new RoaringBitmap()), A);
        same(andNot(new RoaringBitmap(), A), []);
      }),
      RUNS,
    );
  });

  it('orMany equals the fold of or, in any order', () => {
    fc.assert(
      fc.property(triple, fc.integer({ min: 0, max: 4 }), ({ a, b, c }, extra) => {
        const parts = [a, b, c, a.slice(0, extra), b.slice(extra)].map(
          (ids) => new RoaringBitmap(ids),
        );
        const folded = parts.reduce((acc, p) => or(acc, p), new RoaringBitmap());
        same(RoaringBitmap.orMany(parts), folded);
        same(RoaringBitmap.orMany([...parts].reverse()), folded);
      }),
      RUNS,
    );
  });

  it('xorInPlace equals xor, and returns this', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
        const want = xor(A, B);
        expect(A.xorInPlace(B)).toBe(A);
        same(A, want);
        same(B, b);
      }),
      RUNS,
    );
  });
});

describe('the returning combines: copy-on-write', () => {
  const mutators: ReadonlyArray<
    readonly [string, (b: RoaringBitmap, other: RoaringBitmap) => void]
  > = [
    ['add', (b) => void b.add(1_234_567)],
    ['addMany', (b) => void b.addMany([3, 70_000, HALF, TOP])],
    ['remove', (b) => void b.remove(b.minimum() ?? 0)],
    ['removeMany', (b) => void b.removeMany(b.toArray().slice(0, 500))],
    ['clear', (b) => b.clear()],
    ['andInPlace', (b, o) => void b.andInPlace(o)],
    ['orInPlace', (b, o) => void b.orInPlace(o)],
    ['andNotInPlace', (b, o) => void b.andNotInPlace(o)],
    ['xorInPlace', (b, o) => void b.xorInPlace(o)],
    ['runOptimize', (b) => void b.runOptimize()],
  ];

  it('a result never changes when an operand later does, and an operand never changes when the result does', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        for (const op of [...STATICS, 'orMany'] as const) {
          for (const [name, mutate] of mutators) {
            const make = (): [RoaringBitmap, RoaringBitmap, RoaringBitmap] => {
              const [x, y] = [new RoaringBitmap(a), new RoaringBitmap(b)];
              return [
                x,
                y,
                op === 'orMany' ? RoaringBitmap.orMany([x, y]) : RoaringBitmap[op](x, y),
              ];
            };
            const [x0, y0, r0] = make();
            const before = r0.toUint32Array();
            mutate(x0, y0);
            mutate(y0, x0);
            expectSame(`${op} result after ${name} on the operands`, r0.toUint32Array(), before);

            const [x1, y1, r1] = make();
            const [xs, ys] = [x1.toUint32Array(), y1.toUint32Array()];
            mutate(r1, new RoaringBitmap([7, 70_001]));
            expectSame(`${op} first operand after ${name} on the result`, x1.toUint32Array(), xs);
            expectSame(`${op} second operand after ${name} on the result`, y1.toUint32Array(), ys);
          }
        }
      }),
      { numRuns: 8 },
    );
  });

  it('several generations of results and clones stay independent', () => {
    const a = new RoaringBitmap(Array.from({ length: 9_000 }, (_, i) => i * 7));
    const b = new RoaringBitmap([1, 70_000, HALF]);
    const r1 = or(a, b);
    const r2 = andNot(r1, b);
    const c = r2.clone();
    const [sa, s1, s2] = [a.toArray(), r1.toArray(), r2.toArray()];
    c.addMany([9, 10, 11]);
    r2.remove(0);
    a.clear();
    expect(r1.toArray()).toEqual(s1);
    expect(c.toArray()).toEqual([...s2, 9, 10, 11].sort((x, y) => x - y));
    expect(r2.toArray()).toEqual(s2.slice(1));
    expect(sa.length).toBe(9_000);
  });
});

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
function externalBytes(): number {
  for (let i = 0; i < 4; i++) gc();
  return process.memoryUsage().arrayBuffers;
}
const MB = 1024 * 1024;

describe('a result holds its own storage', () => {
  /** A bitmap of 1,500 bitsets (about 12 MB), decoded, reduced by `reduce` to one container, with the input dropped. */
  function reduced(
    reduce: (all: RoaringBitmap, filter: RoaringBitmap) => RoaringBitmap,
  ): RoaringBitmap {
    const ids = new Uint32Array(1_500 * 6_000);
    for (let k = 0; k < 1_500; k++)
      for (let i = 0; i < 6_000; i++) ids[k * 6_000 + i] = k * 65_536 + i * 7;
    const filter = new RoaringBitmap(ids.subarray(5 * 6_000, 6 * 6_000));
    return reduce(RoaringBitmap.deserialize(new RoaringBitmap(ids).serialize()), filter);
  }

  it.each([
    ['and', (all: RoaringBitmap, f: RoaringBitmap) => and(all, f)],
    ['andNot of the others', (all: RoaringBitmap, f: RoaringBitmap) => andNot(all, andNot(all, f))],
    ['xor with the others', (all: RoaringBitmap, f: RoaringBitmap) => xor(all, andNot(all, f))],
    [
      'orMany of one',
      (all: RoaringBitmap, f: RoaringBitmap) => and(RoaringBitmap.orMany([all]), f),
    ],
  ])('%s: keeping the result keeps neither the decoded operand nor its input', (_n, reduce) => {
    const base = externalBytes();
    const kept = reduced(reduce);
    expect(kept.size).toBe(6_000);
    const retained = externalBytes() - base;
    expect(retained, `retained ${retained} bytes`).toBeLessThan(MB);
  });
});

describe('the returning combines: refusals', () => {
  const duck = Object.assign(Object.create(null) as object, {
    size: 1,
    has: () => true,
    [Symbol.iterator]: function* () {
      yield 1;
    },
  }) as unknown as RoaringBitmap;
  const strangers: unknown[] = [
    duck,
    crOf([1]),
    { size: 1 },
    null,
    undefined,
    5,
    [1],
    new Set([1]),
  ];

  it.each(STATICS)(
    '%s refuses a non-bitmap in either place, with a value-free ValidationError',
    (op) => {
      const mine = new RoaringBitmap([1]);
      for (const other of strangers) {
        for (const args of [
          [mine, other],
          [other, mine],
          [other, other],
        ]) {
          const call = () => (RoaringBitmap[op] as (...a: unknown[]) => unknown)(...args);
          expect(call).toThrow(ValidationError);
          expect(call).toThrow(/another RoaringBitmap of this copy/);
        }
      }
      expect(mine.toArray()).toEqual([1]);
    },
  );

  it('xorInPlace refuses a non-bitmap and leaves the bitmap as it was', () => {
    const mine = new RoaringBitmap([1, 70_000]);
    for (const other of strangers) {
      expect(() => mine.xorInPlace(other as RoaringBitmap)).toThrow(
        /another RoaringBitmap of this copy/,
      );
    }
    expect(mine.toArray()).toEqual([1, 70_000]);
  });

  it('orMany refuses a non-iterable and a list holding a non-bitmap, and combines nothing', () => {
    const good = new RoaringBitmap([1]);
    for (const list of [null, undefined, 5, 'ab', { length: 1, 0: good }]) {
      expect(() => RoaringBitmap.orMany(list as unknown as RoaringBitmap[])).toThrow(
        ValidationError,
      );
    }
    for (const bad of strangers) {
      expect(() => RoaringBitmap.orMany([good, bad as RoaringBitmap, good])).toThrow(
        /another RoaringBitmap of this copy/,
      );
    }
    expect(good.toArray()).toEqual([1]);
  });
});
