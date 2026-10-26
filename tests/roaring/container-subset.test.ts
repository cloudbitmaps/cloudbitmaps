import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { RoaringBitmap } from '@/index';
import { ARRAY, BITSET, RUN, containersIntersect, containersSubset } from '@/ts-roaring/containers';
import {
  KINDS,
  KIND_NAME,
  containerOf,
  lowsSet,
  range,
  sortedUnique,
} from '../helpers/container-kinds';

/**
 * Whether one container's values are all in another's, and whether two containers share a value, answered without
 * counting: every pair of kinds against a plain set, the cases that decide at the first and the last element, and
 * whole bitmaps against CRoaring.
 */
const isSubsetOf = (a: readonly number[], b: readonly number[]): boolean => {
  const inB = new Set(b);
  return a.every((v) => inB.has(v));
};
const shares = (a: readonly number[], b: readonly number[]): boolean => {
  const inB = new Set(b);
  return a.some((v) => inB.has(v));
};

describe('containersSubset, every pair of kinds', () => {
  for (const ka of KINDS) {
    for (const kb of KINDS) {
      it(`${KIND_NAME[ka]} in ${KIND_NAME[kb]}: true exactly when every value is held`, () => {
        fc.assert(
          fc.property(
            lowsSet,
            lowsSet,
            lowsSet,
            fc.nat(),
            fc.integer({ min: 0, max: 5 }),
            (a, b, extra, pick, pad) => {
              // Unrelated sets, a set against a superset of itself, and against itself with one value missing.
              expect(containersSubset(containerOf(ka, a, pad), containerOf(kb, b, pad + 1))).toBe(
                isSubsetOf(a, b),
              );
              const big = sortedUnique([...a, ...extra]);
              expect(containersSubset(containerOf(ka, a, pad), containerOf(kb, big))).toBe(true);
              const gone = a[pick % a.length] as number;
              const hole = a.filter((v) => v !== gone);
              if (hole.length > 0) {
                expect(containersSubset(containerOf(ka, a), containerOf(kb, hole))).toBe(false);
                expect(containersSubset(containerOf(ka, hole), containerOf(kb, a))).toBe(true);
              }
            },
          ),
          { numRuns: 120 },
        );
      });
    }
  }

  it('a container is a subset of itself, and a full chunk holds every container', () => {
    const full = range(0, 65_536);
    for (const ka of KINDS) {
      const lows = range(0, 3_000).map((v) => v * 21);
      expect(containersSubset(containerOf(ka, lows), containerOf(ka, lows))).toBe(true);
      for (const kb of KINDS) {
        expect(containersSubset(containerOf(ka, lows), containerOf(kb, full))).toBe(true);
        expect(containersSubset(containerOf(kb, full), containerOf(ka, lows))).toBe(false);
      }
    }
  });

  it('a value missing at the first or the last place decides it, in every pair of kinds', () => {
    const base = [...range(100, 900), ...range(5_000, 5_400), ...range(65_000, 65_536)];
    const first = base.filter((v) => v !== 100);
    const last = base.filter((v) => v !== 65_535);
    const middle = base.filter((v) => v !== 5_200);
    const before = sortedUnique([0, ...base]);
    const after = sortedUnique([...base, 65_535]);
    const gapEdge = base.filter((v) => v !== 899);
    for (const ka of KINDS) {
      for (const kb of KINDS) {
        const label = `${KIND_NAME[ka]} in ${KIND_NAME[kb]}`;
        expect(containersSubset(containerOf(ka, base), containerOf(kb, base)), label).toBe(true);
        for (const smaller of [first, last, middle, gapEdge]) {
          expect(containersSubset(containerOf(ka, base), containerOf(kb, smaller)), label).toBe(
            false,
          );
          expect(containersSubset(containerOf(ka, smaller), containerOf(kb, base)), label).toBe(
            true,
          );
        }
        expect(containersSubset(containerOf(ka, before), containerOf(kb, base)), label).toBe(false);
        expect(containersSubset(containerOf(ka, base), containerOf(kb, after)), label).toBe(true);
      }
    }
  });

  it('runs that sit across a run of the other side, inside it, and just outside it', () => {
    const outer = [...range(10, 60), ...range(100, 160)];
    const cases: Array<[string, number[], boolean]> = [
      ['inside one run', range(20, 40), true],
      ['exactly one run', range(10, 60), true],
      ['across the gap', range(50, 110), false],
      ['one past the end', range(10, 61), false],
      ['one before the start', range(9, 60), false],
      ['two runs inside two runs', [...range(10, 20), ...range(150, 160)], true],
      ['a value in the gap', [30, 70], false],
    ];
    for (const [label, a, want] of cases) {
      for (const ka of KINDS) {
        for (const kb of KINDS) {
          expect(
            containersSubset(containerOf(ka, a), containerOf(kb, outer)),
            `${label}: ${KIND_NAME[ka]} in ${KIND_NAME[kb]}`,
          ).toBe(want);
        }
      }
    }
  });

  it('answers without writing either operand or the shared scratch the counts use', () => {
    const a = containerOf(BITSET, range(0, 9_000));
    const b = containerOf(BITSET, range(0, 12_000));
    const before = Uint32Array.from(a.data as Uint32Array);
    expect(containersSubset(a, b)).toBe(true);
    expect(containersSubset(b, a)).toBe(false);
    expect(Array.from(a.data as Uint32Array)).toEqual(Array.from(before));
  });
});

describe('containersIntersect, every pair of kinds', () => {
  for (const ka of KINDS) {
    for (const kb of KINDS) {
      it(`${KIND_NAME[ka]} with ${KIND_NAME[kb]}: true exactly when a value is shared`, () => {
        fc.assert(
          fc.property(lowsSet, lowsSet, fc.integer({ min: 0, max: 5 }), (a, b, pad) => {
            expect(containersIntersect(containerOf(ka, a, pad), containerOf(kb, b, pad + 1))).toBe(
              shares(a, b),
            );
            expect(containersIntersect(containerOf(kb, b, pad), containerOf(ka, a, pad + 1))).toBe(
              shares(a, b),
            );
          }),
          { numRuns: 120 },
        );
      });
    }
  }

  it('two arrays that share one value, wherever it falls in a long pair, and arrays that share none', () => {
    // Long enough for the probe path (32 values or more), similar in size, so not galloped.
    const evens = range(0, 2_000).map((v) => v * 4);
    const odds = range(0, 2_000).map((v) => v * 4 + 1);
    expect(containersIntersect(containerOf(ARRAY, evens), containerOf(ARRAY, odds))).toBe(false);
    for (const at of [0, 1, 31, 32, 33, 63, 64, 65, 66, 127, 1_000, 1_999]) {
      const withOne = sortedUnique([...odds, evens[at] as number]);
      expect(
        containersIntersect(containerOf(ARRAY, evens), containerOf(ARRAY, withOne)),
        `shared value at ${at}`,
      ).toBe(true);
      expect(
        containersIntersect(containerOf(ARRAY, withOne), containerOf(ARRAY, evens)),
        `shared value at ${at}, swapped`,
      ).toBe(true);
    }
    // Overlapping ranges with nothing shared, and ranges that only touch at an end.
    expect(
      containersIntersect(
        containerOf(
          ARRAY,
          range(0, 100).map((v) => v * 2),
        ),
        containerOf(
          ARRAY,
          range(0, 100).map((v) => v * 2 + 1),
        ),
      ),
    ).toBe(false);
    expect(
      containersIntersect(containerOf(ARRAY, range(0, 64)), containerOf(ARRAY, range(63, 127))),
    ).toBe(true);
    expect(
      containersIntersect(containerOf(ARRAY, range(0, 64)), containerOf(ARRAY, range(64, 127))),
    ).toBe(false);
  });

  it('a bitset against runs: a shared value in the first, a middle or the last word, and none', () => {
    const runs = [...range(100, 140), ...range(3_000, 3_100), ...range(65_500, 65_536)];
    const inGaps = sortedUnique([0, 99, 140, 2_999, 3_100, 65_499]);
    const bits = (lows: number[]) => containerOf(BITSET, lows);
    expect(containersIntersect(bits(inGaps), containerOf(RUN, runs))).toBe(false);
    expect(containersIntersect(containerOf(RUN, runs), bits(inGaps))).toBe(false);
    for (const v of [100, 139, 3_000, 3_099, 65_500, 65_535, 3_050]) {
      expect(
        containersIntersect(bits([...inGaps, v].sort((x, y) => x - y)), containerOf(RUN, runs)),
      ).toBe(true);
    }
    // A dense bitset with a hole exactly where the run is, and a run that is one value wider than the hole.
    const holes = range(0, 65_536).filter((v) => v < 1_000 || v >= 1_100);
    expect(containersIntersect(bits(holes), containerOf(RUN, range(1_000, 1_100)))).toBe(false);
    expect(containersIntersect(bits(holes), containerOf(RUN, range(1_000, 1_101)))).toBe(true);
    expect(containersIntersect(bits(holes), containerOf(RUN, range(999, 1_100)))).toBe(true);
  });

  it('two bitsets that share only their last word, or only their first', () => {
    const a = range(0, 4_000).map((v) => v * 16 + 1);
    const lastOnly = [65_535];
    expect(containersIntersect(containerOf(BITSET, a), containerOf(BITSET, [2]))).toBe(false);
    expect(
      containersIntersect(containerOf(BITSET, [...a, 65_535]), containerOf(BITSET, lastOnly)),
    ).toBe(true);
    expect(containersIntersect(containerOf(BITSET, a), containerOf(BITSET, [1]))).toBe(true);
  });
});

describe('isSubset and intersects on whole bitmaps', () => {
  const kinds: Record<string, number[]> = {
    array: range(0, 1_000).map((v) => v * 7),
    bitset: range(0, 20_000).map((v) => v * 3),
    runs: range(0, 150).flatMap((i) => range(i * 400, i * 400 + 100)),
  };
  const lay = (ids: number[], shift: number) => ids.map((v) => v + shift * 65_536);

  for (const [na, a] of Object.entries(kinds)) {
    for (const [nb, b] of Object.entries(kinds)) {
      it(`${na} against ${nb} agree with CRoaring: a subset, a superset, a near miss, an overlap`, () => {
        const small = [...lay(a, 1), ...lay(b, 4)];
        const big = [...small, ...lay(b, 2), ...lay(a, 9)];
        const miss = big.filter((v) => v !== small[small.length - 1]);
        const other = [...lay(b, 1), ...lay(a, 6)];
        for (const [x, y] of [
          [small, big],
          [big, small],
          [small, miss],
          [small, other],
          [other, small],
          [small, small],
        ] as const) {
          const mine = new RoaringBitmap(x);
          const theirs = new RoaringBitmap(y);
          mine.runOptimize();
          theirs.runOptimize();
          const nativeX = new RoaringBitmap32(x);
          const nativeY = new RoaringBitmap32(y);
          expect(mine.isSubset(theirs)).toBe(nativeX.isSubset(nativeY));
          expect(mine.intersects(theirs)).toBe(nativeX.intersects(nativeY));
        }
      });
    }
  }

  it('agrees with the plain set on random bitmaps', () => {
    const idSet = fc.uniqueArray(fc.integer({ min: 0, max: 300_000 }), { maxLength: 5_000 });
    fc.assert(
      fc.property(idSet, idSet, (a, b) => {
        const x = new RoaringBitmap(a);
        const y = new RoaringBitmap(b);
        expect(x.isSubset(y)).toBe(isSubsetOf(a, b));
        expect(x.intersects(y)).toBe(shares(a, b));
        const both = new RoaringBitmap([...a, ...b]);
        expect(x.isSubset(both)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
