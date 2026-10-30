import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { RoaringBitmap } from '@/index';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { ARRAY, BITSET, RUN, WORDS, containerXor } from '@/ts-roaring/containers';
import {
  KINDS,
  KIND_NAME,
  containerOf,
  lowsSet,
  range,
  ruleKind,
  sortedUnique,
  valuesOf,
} from '../helpers/container-kinds';

/**
 * The symmetric difference of two containers in one pass, for every pair of kinds, held to a plain set; and the
 * returning `xor` and `xorInPlace` of whole bitmaps held to CRoaring.
 */
const xorOf = (a: readonly number[], b: readonly number[]): number[] => {
  const inB = new Set(b);
  const inA = new Set(a);
  return sortedUnique([...a.filter((v) => !inB.has(v)), ...b.filter((v) => !inA.has(v))]);
};

describe('containerXor, every pair of kinds', () => {
  for (const ka of KINDS) {
    for (const kb of KINDS) {
      // Budget 6 s on each pair (the default is 5 s): the slowest measured time was 1.9 s, on a Node 24 CI runner. Rule:
      // that time times three, rounded up to the next whole second.
      it(
        `${KIND_NAME[ka]} with ${KIND_NAME[kb]}: the values in one and not the other, kind by cardinality`,
        { timeout: 6000 },
        () => {
          fc.assert(
            fc.property(lowsSet, lowsSet, fc.integer({ min: 0, max: 5 }), (a, b, pad) => {
              const want = xorOf(a, b);
              const ca = containerOf(ka, a, pad);
              const cb = containerOf(kb, b, pad + 1);
              const got = containerXor(ca, cb, false);
              if (want.length === 0) {
                expect(got).toBeNull();
              } else {
                expect(got).not.toBeNull();
                expect(valuesOf(got!)).toEqual(want);
                expect(got!.card).toBe(want.length);
                // An array up to 4,096 values and a bitset above; two run containers keep a run while that is smaller.
                expect(got!.kind).toBe(
                  ka === RUN && kb === RUN ? ruleKind(want) : want.length <= 4_096 ? ARRAY : BITSET,
                );
                expect(got!.shared).toBe(false);
              }
              // Neither operand is written, and the swap gives the same set.
              expect(valuesOf(ca)).toEqual(a);
              expect(valuesOf(cb)).toEqual(b);
              const swapped = containerXor(cb, ca, false);
              expect(swapped === null ? [] : valuesOf(swapped)).toEqual(want);
            }),
            { numRuns: 120 },
          );
        },
      );
    }
  }

  // Budget 15 s (the default is 5 s) for the 80-run property over every kind of container; the file's other properties
  // take under 1 s and keep the default. Measured: 0.9 s on a developer machine; the release job's runner cut it at 4.2
  // s after 70 of its 80 runs, which is 4.8 s for a full run (derived: 4.2 s / 70 x 80). Rule: the slowest measured
  // time (release runner or developer machine) times three, rounded up to the next whole second.
  it('in place on a bitset the caller owns writes its words; any other first operand is not written', () => {
    fc.assert(
      fc.property(lowsSet, lowsSet, (a, b) => {
        const want = xorOf(a, b);
        for (const kb of KINDS) {
          const owned = containerOf(BITSET, a);
          const second = containerOf(kb, b);
          const got = containerXor(owned, second, true);
          expect(got === null ? [] : valuesOf(got)).toEqual(want);
          // the second operand is read, never written
          expect(valuesOf(second)).toEqual(b);
        }
        for (const ka of [ARRAY, RUN] as const) {
          const first = containerOf(ka, a);
          const second = containerOf(BITSET, b);
          const got = containerXor(first, second, true);
          expect(got === null ? [] : valuesOf(got)).toEqual(want);
          expect(valuesOf(first)).toEqual(a);
          // a bitset second operand holds the words an in-place write would reuse: they stay as they were
          expect(valuesOf(second)).toEqual(b);
          expect(got === second).toBe(false);
        }
      }),
      { numRuns: 80 },
    );
  }, 15_000);

  it('a container with itself is empty, in place or not', () => {
    for (const kind of KINDS) {
      const lows = range(0, 5_000).map((v) => v * 13);
      expect(containerXor(containerOf(kind, lows), containerOf(kind, lows), false)).toBeNull();
      expect(containerXor(containerOf(kind, lows), containerOf(kind, lows), true)).toBeNull();
      const same = containerOf(kind, lows);
      expect(containerXor(same, same, kind === BITSET)).toBeNull();
    }
  });

  it('values at the ends of the chunk, a full chunk, and touching or overlapping run lists', () => {
    const full = range(0, 65_536);
    const cases: Array<[string, number[], number[]]> = [
      ['full with nothing but one', full, [0]],
      ['full with full', full, full],
      ['full with its last value', full, [65_535]],
      ['both ends', [0, 65_535], [0, 65_535]],
      ['both ends against one', [0, 65_535], [65_535]],
      ['touching runs join', range(0, 100), range(100, 200)],
      ['one run inside another', range(10, 90), range(0, 100)],
      ['overlapping runs', range(0, 100), range(50, 150)],
      ['runs that share an end value', range(0, 101), range(100, 200)],
      ['runs that share a start value', range(100, 200), range(0, 101)],
      [
        'interleaved runs',
        [...range(0, 10), ...range(20, 30)],
        [...range(5, 25), ...range(40, 50)],
      ],
      ['runs ending at 65,535', range(65_000, 65_536), range(65_500, 65_536)],
      ['a run and the value before it', range(10, 20), [9]],
      ['a run and the value after it', range(10, 20), [20]],
    ];
    for (const [label, a, b] of cases) {
      const want = xorOf(a, b);
      for (const ka of KINDS) {
        for (const kb of KINDS) {
          const got = containerXor(containerOf(ka, a), containerOf(kb, b), false);
          expect(
            got === null ? [] : valuesOf(got),
            `${label}: ${KIND_NAME[ka]}/${KIND_NAME[kb]}`,
          ).toEqual(want);
        }
      }
    }
  });

  it('two arrays whose union is over 4,096 values but whose difference is under it stay an array', () => {
    const a = range(0, 3_000);
    const b = range(100, 3_100);
    const got = containerXor(containerOf(ARRAY, a), containerOf(ARRAY, b), false)!;
    expect(got.kind).toBe(ARRAY);
    expect(got.card).toBe(200);
    // And two arrays whose difference is over it become a bitset.
    const c = range(0, 4_096).map((v) => v * 2);
    const d = range(0, 4_096).map((v) => v * 2 + 1);
    const wide = containerXor(containerOf(ARRAY, c), containerOf(ARRAY, d), false)!;
    expect(wide.kind).toBe(BITSET);
    expect(wide.card).toBe(8_192);
    expect(wide.data).toHaveLength(WORDS);
  });
});

describe('xor and xorInPlace on whole bitmaps', () => {
  const kinds: Record<string, number[]> = {
    array: range(0, 1_000).map((v) => v * 7),
    bitset: range(0, 20_000).map((v) => v * 3),
    runs: range(0, 150).flatMap((i) => range(i * 400, i * 400 + 100)),
  };
  const lay = (ids: number[], shift: number) => ids.map((v) => v + shift * 65_536);
  const sets: Array<[string, number[]]> = [
    ['array', kinds.array as number[]],
    ['bitset', kinds.bitset as number[]],
    ['runs', kinds.runs as number[]],
  ];

  for (const [na, a] of sets) {
    for (const [nb, b] of sets) {
      it(`${na} against ${nb}, same chunks and chunks one side lacks, agrees with CRoaring`, () => {
        const left = [...lay(a, 0), ...lay(b, 2), ...lay(a, 5)];
        const right = [...lay(b, 0), ...lay(a, 3), ...lay(a, 5)];
        const nativeA = new RoaringBitmap32(left);
        const nativeB = new RoaringBitmap32(right);
        const want = RoaringBitmap32.xor(nativeA, nativeB).toArray();
        const mine = new RoaringBitmap(left);
        const other = new RoaringBitmap(right);
        // Run containers decoded from stored bytes take the run/run walk.
        mine.runOptimize();
        other.runOptimize();
        expect(RoaringBitmap.xor(mine, other).toArray()).toEqual(want);
        const inPlace = new RoaringBitmap(left);
        inPlace.runOptimize();
        expect(inPlace.xorInPlace(other)).toBe(inPlace);
        expect(inPlace.toArray()).toEqual(want);
        expect(inPlace.size).toBe(want.length);
        // The operand is untouched.
        expect(other.toArray()).toEqual(nativeB.toArray());
      });
    }
  }

  it('xorInPlace with itself empties the bitmap, and with an empty one changes nothing', () => {
    const ids = [...range(0, 9_000), ...range(70_000, 71_000)];
    const m = new RoaringBitmap(ids);
    m.xorInPlace(m);
    expect(m.size).toBe(0);
    const n = new RoaringBitmap(ids);
    n.xorInPlace(new RoaringBitmap());
    expect(n.toArray()).toEqual(ids);
  });

  it('xorInPlace writes only its own containers: a clone made before it keeps its ids', () => {
    const ids = range(0, 30_000);
    const m = new RoaringBitmap(ids);
    const before = m.clone();
    m.xorInPlace(new RoaringBitmap(range(10_000, 40_000)));
    expect(before.toArray()).toEqual(ids);
    expect(m.toArray()).toEqual([...range(0, 10_000), ...range(30_000, 40_000)]);
    const ts = TsBitmap.fromValues(ids);
    const shared = ts.clone();
    ts.xorInPlace(TsBitmap.fromValues(range(0, 100)));
    expect([...shared]).toEqual(ids);
  });

  it('agrees with the plain set on random bitmaps, returning and in place', () => {
    const idSet = fc.uniqueArray(fc.integer({ min: 0, max: 400_000 }), { maxLength: 6_000 });
    fc.assert(
      fc.property(idSet, idSet, (a, b) => {
        const want = xorOf(a, b);
        const x = new RoaringBitmap(a);
        const y = new RoaringBitmap(b);
        expect(RoaringBitmap.xor(x, y).toArray()).toEqual(want);
        x.xorInPlace(y);
        expect(x.toArray()).toEqual(want);
      }),
      { numRuns: 60 },
    );
  });
});
