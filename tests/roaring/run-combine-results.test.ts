import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { RoaringBitmap } from '@/index';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  RUN,
  containerAnd,
  containerAndNot,
  containerOr,
  containerXor,
} from '@/ts-roaring/containers';
import type { Container } from '@/ts-roaring/containers';
import {
  containerOf,
  intervalsOf,
  range,
  ruleKind,
  sortedUnique,
  valuesOf,
} from '../helpers/container-kinds';

/**
 * A combine of two run containers keeps a run result while that is the smaller form: the result is a run container when
 * its body (`2 + 4 * runs` bytes) is strictly smaller than the array or bitset body, and an array or a bitset when not.
 * Every run result is canonical (ascending, no two runs touching or overlapping, cardinality exact), which the decoder
 * requires of stored bytes.
 */
const CAP = 1 << 27;
const CONTAINER_OPS: Array<
  [
    string,
    (a: Container, b: Container, inPlace?: boolean) => Container | null,
    (a: number[], b: number[]) => number[],
  ]
> = [
  [
    'and',
    containerAnd,
    (a, b) => {
      const inB = new Set(b);
      return a.filter((v) => inB.has(v));
    },
  ],
  ['or', containerOr, (a, b) => sortedUnique([...a, ...b])],
  [
    'andNot',
    containerAndNot,
    (a, b) => {
      const inB = new Set(b);
      return a.filter((v) => !inB.has(v));
    },
  ],
  [
    'xor',
    containerXor,
    (a, b) => {
      const sa = new Set(a);
      const sb = new Set(b);
      return sortedUnique([...a.filter((v) => !sb.has(v)), ...b.filter((v) => !sa.has(v))]);
    },
  ],
];

function expectCanonical(c: Container | null, want: readonly number[], label: string): void {
  if (want.length === 0) {
    expect(c, `${label}: empty`).toBeNull();
    return;
  }
  const got = c as Container;
  expect(valuesOf(got), `${label}: values`).toEqual(want);
  expect(got.card, `${label}: card`).toBe(want.length);
  expect(got.kind, `${label}: kind by the smallest-body rule`).toBe(ruleKind(want));
  if (got.kind === RUN) {
    const iv = intervalsOf(got);
    for (let r = 1; r < iv.length; r++) {
      expect(
        (iv[r] as [number, number])[0],
        `${label}: run ${r} touches or overlaps the one before`,
      ).toBeGreaterThan((iv[r - 1] as [number, number])[1] + 1);
    }
    expect(
      (got.data as Uint16Array).length - got.off,
      `${label}: storage holds exactly the pairs`,
    ).toBe(2 * got.len);
  }
}

const runShaped = fc
  .oneof(
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: 65_535 }), fc.integer({ min: 1, max: 40 })), {
        minLength: 1,
        maxLength: 60,
      })
      .map((rs) => rs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))),
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: 65_000 }), fc.integer({ min: 100, max: 3_000 })), {
        minLength: 1,
        maxLength: 30,
      })
      .map((rs) => rs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))),
    fc.constantFrom([0], [65_535], [0, 1, 2], range(0, 65_536), range(1, 65_536), range(0, 65_535)),
  )
  .map((v) => sortedUnique(v));

describe('a combine of two run containers', () => {
  for (const [name, op, model] of CONTAINER_OPS) {
    it(`${name}: the values are exact and the result is canonical and in its smallest kind`, () => {
      fc.assert(
        fc.property(runShaped, runShaped, fc.integer({ min: 0, max: 4 }), (a, b, pad) => {
          const want = model(a, b);
          expectCanonical(
            op(containerOf(RUN, a, pad), containerOf(RUN, b, pad + 1), false),
            want,
            name,
          );
          // The operands are not written.
          const ca = containerOf(RUN, a);
          const cb = containerOf(RUN, b);
          op(ca, cb, false);
          expect(valuesOf(ca)).toEqual(a);
          expect(valuesOf(cb)).toEqual(b);
        }),
        { numRuns: 200 },
      );
    }, 60_000);
  }

  it('few long runs give a run container, many short ones an array or a bitset', () => {
    const wide = [...range(100, 20_000), ...range(30_000, 50_000)];
    const other = [...range(10_000, 40_000)];
    for (const [name, op, model] of CONTAINER_OPS) {
      const got = op(containerOf(RUN, wide), containerOf(RUN, other), false);
      expect(got?.kind, name).toBe(RUN);
      expectCanonical(got, model(wide, other), name);
    }
    const dots = range(0, 100).map((v) => v * 3);
    const dots2 = range(0, 100).map((v) => v * 3 + 1);
    const orDots = containerOr(containerOf(RUN, dots), containerOf(RUN, dots2), false);
    expect(orDots?.kind).toBe(ARRAY);
  });

  it('touching and overlapping operands join or split into maximal runs, with the chunk ends', () => {
    const cases: Array<[number[], number[]]> = [
      [range(0, 100), range(100, 200)],
      [range(0, 101), range(100, 200)],
      [range(10, 90), range(0, 100)],
      [
        [...range(0, 10), ...range(20, 30)],
        [...range(5, 25), ...range(40, 50)],
      ],
      [range(0, 65_536), range(0, 65_536)],
      [range(0, 65_536), range(1, 65_535)],
      [range(65_000, 65_536), range(65_500, 65_536)],
      [[0, ...range(2, 65_536)], [1]],
    ];
    for (const [a, b] of cases) {
      for (const [name, op, model] of CONTAINER_OPS) {
        expectCanonical(op(containerOf(RUN, a), containerOf(RUN, b), false), model(a, b), name);
      }
    }
  });
});

describe('bitmaps of run containers', () => {
  const runs = (shift: number, step: number, n: number) =>
    range(0, n).flatMap((i) => range(shift + i * step, shift + i * step + step / 2));
  const left = [
    ...runs(0, 400, 150),
    ...runs(2 * 65_536, 300, 200),
    ...runs(5 * 65_536, 1_000, 60),
  ];
  const right = [
    ...runs(150, 400, 150),
    ...runs(2 * 65_536, 300, 200).map((v) => v + 5),
    ...runs(7 * 65_536, 90, 300),
  ];

  for (const [name, op] of [
    ['and', (a: RoaringBitmap, b: RoaringBitmap) => RoaringBitmap.and(a, b)],
    ['or', (a: RoaringBitmap, b: RoaringBitmap) => RoaringBitmap.or(a, b)],
    ['andNot', (a: RoaringBitmap, b: RoaringBitmap) => RoaringBitmap.andNot(a, b)],
    ['xor', (a: RoaringBitmap, b: RoaringBitmap) => RoaringBitmap.xor(a, b)],
  ] as const) {
    it(`${name} returning, and the in-place form, agree with CRoaring and survive serialize and decode`, () => {
      const nativeA = new RoaringBitmap32(left);
      const nativeB = new RoaringBitmap32(right);
      const want = {
        and: RoaringBitmap32.and(nativeA, nativeB),
        or: RoaringBitmap32.or(nativeA, nativeB),
        andNot: RoaringBitmap32.andNot(nativeA, nativeB),
        xor: RoaringBitmap32.xor(nativeA, nativeB),
      }[name];
      const a = new RoaringBitmap(left);
      const b = new RoaringBitmap(right);
      a.runOptimize();
      b.runOptimize();
      const out = op(a, b);
      expect(out.toArray()).toEqual(want.toArray());
      const bytes = out.serialize();
      // The decoder refuses runs that touch or overlap: every run a combine kept must pass it.
      expect(RoaringBitmap.deserialize(bytes).toArray()).toEqual(want.toArray());
      const inPlace = a.clone();
      const method = {
        and: 'andInPlace',
        or: 'orInPlace',
        andNot: 'andNotInPlace',
        xor: 'xorInPlace',
      }[name] as 'andInPlace' | 'orInPlace' | 'andNotInPlace' | 'xorInPlace';
      inPlace[method](b);
      expect(inPlace.toArray()).toEqual(want.toArray());
      // After the canonical re-encode the bytes are CRoaring's.
      out.runOptimize();
      want.runOptimize();
      expect(Buffer.from(out.serialize()).equals(Buffer.from(want.serialize(true)))).toBe(true);
    });
  }

  it('a result that stayed a run is a run in the bitmap, and a later write to it is a correct write', () => {
    const a = TsBitmap.fromValues(left);
    const b = TsBitmap.fromValues(right);
    a.optimize();
    b.optimize();
    const both = TsBitmap.or(a, b);
    expect(both.hasRunContainer()).toBe(true);
    const copy = both.clone();
    both.addMany([1, 3, 65_537, 2 * 65_536 + 7]);
    const model = new Set([...left, ...right, 1, 3, 65_537, 2 * 65_536 + 7]);
    expect([...both]).toEqual([...model].sort((x, y) => x - y));
    expect([...copy]).toEqual(sortedUnique([...left, ...right]));
    expect(Array.from(TsBitmap.safeDeserialize(both.serialize(), CAP).toUint32Array())).toEqual([
      ...both,
    ]);
  });
});
