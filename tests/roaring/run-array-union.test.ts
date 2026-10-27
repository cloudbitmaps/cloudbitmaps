import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  BITSET,
  Container,
  EXPAND_MIN_STEPS,
  RUN,
  appendIds,
  containerOr,
  expandsRunArray,
  orRunArrayExpand,
  orRunArrayWalk,
} from '@/ts-roaring/containers';

/**
 * The union of a run container with an array is written by one of two ways, chosen from the two containers' lengths and
 * cardinalities alone: a merge walk over both lists, which suits a result that stays a run container, and an expansion
 * of the run container to words, which suits one that does not. Both give the same container (the canonical one for the
 * values: a run container only when its body is the smaller), so the choice is invisible; these tests hold the two to a
 * plain set and to each other, and pin the choice on each side of its boundaries.
 */
const CAP = 1 << 27;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const sortedUnique = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);

function runs(lows: readonly number[]): Container {
  const pairs: number[] = [];
  for (let i = 0; i < lows.length;) {
    let j = i;
    while (j + 1 < lows.length && lows[j + 1] === (lows[j] as number) + 1) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pairs);
  return new Container(RUN, data, 0, pairs.length / 2, lows.length, true);
}

function arrayOf(lows: readonly number[]): Container {
  return new Container(ARRAY, Uint16Array.from(lows), 0, lows.length, lows.length, false);
}

function valuesOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  expect(appendIds(c, out, 0, 0)).toBe(c.card);
  return Array.from(out);
}

function ruleKind(lows: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < lows.length; i++) if (i === 0 || lows[i] !== (lows[i - 1] as number) + 1) n++;
  const plain = lows.length <= 4_096 ? 2 * lows.length : 8_192;
  return 2 + 4 * n < plain ? RUN : lows.length <= 4_096 ? ARRAY : BITSET;
}

/** The container is exactly what its values say: the values, the cardinality, and the kind by the size rule. */
function expectCanonical(c: Container, want: readonly number[], label: string): void {
  expect(valuesOf(c), `${label}: values`).toEqual(want);
  expect(c.card, `${label}: card`).toBe(want.length);
  expect(c.kind, `${label}: kind`).toBe(ruleKind(want));
}

/** How far apart the runs of {@link runsOf} start: wide enough that a run of the lengths used never touches the next. */
const spacingOf = (count: number): number => Math.min(64, Math.floor(65_000 / count));

/** `count` runs, `card` values in all: each holds one value and the rest are spread evenly over them. */
function runsOf(count: number, card: number): number[] {
  const extra = card - count;
  const spacing = spacingOf(count);
  const lows: number[] = [];
  for (let k = 0; k < count; k++) {
    const more = Math.floor(extra / count) + (k < extra % count ? 1 : 0);
    expect(more, 'a run of this length fits its spacing').toBeLessThan(spacing - 4);
    for (let j = 0; j <= more; j++) lows.push(spacing * k + j);
  }
  return lows;
}

/** `count` ascending values that no run of {@link runsOf} with `runCount` runs holds. */
function outsideIds(count: number, runCount: number): number[] {
  const spacing = spacingOf(runCount);
  return range(0, count)
    .map((i) =>
      i < runCount
        ? spacing * i + spacing - 1
        : i < 2 * runCount
          ? spacing * (i - runCount) + spacing - 2
          : spacing * runCount + (i - 2 * runCount),
    )
    .sort((x, y) => x - y);
}

describe('a run container united with an array: the two ways agree', () => {
  const runShaped = fc
    .oneof(
      fc
        .array(fc.tuple(fc.integer({ min: 0, max: 65_000 }), fc.integer({ min: 1, max: 30 })), {
          minLength: 1,
          maxLength: 1_500,
        })
        .map((rs) => rs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))),
      fc.constantFrom(
        range(0, 1_200).map((v) => v * 2),
        range(0, 1_100).map((v) => v * 3),
        range(0, 3_000).map((v) => v * 2),
      ),
    )
    .map((v) => sortedUnique(v));
  const arrayShaped = fc
    .oneof(
      fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 4_096 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 3_000 }), { minLength: 1, maxLength: 1_500 }),
      fc.constantFrom(
        range(0, 1_200).map((v) => v * 2 + 1),
        range(0, 1_100).map((v) => v * 3 + 1),
        range(0, 4_096),
      ),
    )
    .map((v) => sortedUnique(v));

  it('walk, expansion and the union give one canonical container, either operand order, kept or not', () => {
    fc.assert(
      fc.property(runShaped, arrayShaped, fc.boolean(), (r, a, keep) => {
        const want = sortedUnique([...r, ...a]);
        const run = runs(r);
        const arr = arrayOf(a);
        const nothingAdded = want.length === r.length;
        for (const [label, got] of [
          ['walk', orRunArrayWalk(run, arr, keep)],
          ['expansion', orRunArrayExpand(run, arr, keep)],
          ['union', containerOr(run, arr, keep)],
        ] as const) {
          expect(got === run, `${label}: kept`).toBe(keep && nothingAdded);
          if (got !== run) expectCanonical(got, want, label);
        }
        expectCanonical(containerOr(arr, run, false), want, 'array | run');
        const walked = orRunArrayWalk(run, arr, false);
        const expanded = orRunArrayExpand(run, arr, false);
        expect(expanded.kind).toBe(walked.kind);
        if (walked.kind === RUN) expect(expanded.len).toBe(walked.len);
      }),
      { numRuns: 120 },
    );
  });

  it('the two ways agree on the shapes at the edges', () => {
    const cases: Array<[string, number[], number[]]> = [
      ['an array that adds nothing', runsOf(1_100, 3_000), runsOf(1_100, 3_000).slice(0, 1_500)],
      [
        'an array that bridges every gap, one run left',
        range(0, 1_200).map((v) => v * 2),
        range(0, 1_199).map((v) => v * 2 + 1),
      ],
      ['an array that adds a run each', runsOf(1_200, 1_200), outsideIds(1_300, 1_200)],
      ['an array of 4,096 values', runsOf(1_100, 3_300), range(5_000, 9_096)],
      ['a result of exactly 4,096 values', runsOf(1_100, 3_000), range(30_000, 31_096)],
      ['a result of 4,097 values', runsOf(1_100, 3_000), range(30_000, 31_097)],
      [
        'a full chunk',
        range(0, 65_536).filter((v) => v % 64 !== 0),
        range(0, 1_024).map((v) => v * 64),
      ],
    ];
    for (const [label, r, a] of cases) {
      const want = sortedUnique([...r, ...a]);
      for (const keep of [false, true]) {
        const run = runs(r);
        const arr = arrayOf(a);
        const walk = orRunArrayWalk(run, arr, keep);
        const expand = orRunArrayExpand(run, arr, keep);
        if (walk !== run) expectCanonical(walk, want, `${label}: walk`);
        if (expand !== run) expectCanonical(expand, want, `${label}: expansion`);
        expect(expand === run, `${label}: kept`).toBe(walk === run);
        expect(expand.kind, label).toBe(walk.kind);
      }
    }
  });
});

describe('which way a run container united with an array is written', () => {
  const choose = (r: number, card: number, g: number) =>
    expandsRunArray(runs(runsOf(r, card)), arrayOf(outsideIds(g, r)));

  it('the step count: one short of the minimum walks, the minimum and one over expand', () => {
    expect(EXPAND_MIN_STEPS).toBe(1_024);
    // One-value runs, so the size rule is far from the line and only the step count decides.
    expect(choose(1_000, 1_000, EXPAND_MIN_STEPS - 1 - 1_000)).toBe(false);
    expect(choose(1_000, 1_000, EXPAND_MIN_STEPS - 1_000)).toBe(true);
    expect(choose(1_000, 1_000, EXPAND_MIN_STEPS + 1 - 1_000)).toBe(true);
    // Few runs and a long array count the same.
    expect(choose(10, 10, EXPAND_MIN_STEPS - 11)).toBe(false);
    expect(choose(10, 10, EXPAND_MIN_STEPS - 10)).toBe(true);
  });

  it('the size rule below 4,096 values: expands while the most runs possible fail it, walks one value past', () => {
    // 1,000 runs and 24 values make 1,024 steps; the plain body of the largest result is 2 * cardMax bytes, and
    // 2 + 4 * 1,024 = 4,098 reaches it while cardMax is at most 2,049.
    expect(choose(1_000, 2_025, 24)).toBe(true);
    expect(choose(1_000, 2_026, 24)).toBe(false);
    expect(choose(1_000, 1_000, 24)).toBe(true);
  });

  it('the size rule above 4,096 values: the plain body is a bitset, 8,192 bytes, reached from 2,048 steps', () => {
    expect(choose(2_000, 6_000, 47)).toBe(false);
    expect(choose(2_000, 6_000, 48)).toBe(true);
    expect(choose(1_500, 6_000, 547)).toBe(false);
    expect(choose(1_500, 6_000, 548)).toBe(true);
    // At 4,096 and 4,097 values of the largest result the body is the same 8,192 bytes.
    expect(choose(1_100, 4_000, 96)).toBe(false);
    expect(choose(1_100, 4_000, 97)).toBe(false);
    // Both are above the size rule, so the two answers are the same: the 4,096 boundary is not a case the rule can get wrong.
    expect(choose(1_100, 3_000, 1_096)).toBe(true);
    expect(choose(1_100, 3_000, 1_097)).toBe(true);
  });

  it('a union that stays a run container walks, one that cannot be one expands, and both return the canonical container', () => {
    // 150 runs of about 100 values and 1,000 ids: 1,150 steps, but 2 + 4 * 1,150 is under the 8,192-byte bitset.
    const typical = runs(runsOf(150, 7_500));
    const ids = arrayOf(outsideIds(1_000, 150));
    expect(expandsRunArray(typical, ids)).toBe(false);
    expect(containerOr(typical, ids, false).kind).toBe(RUN);
    // 1,200 short runs and 1,500 ids: 2,700 steps, over the line, and a result with about two thousand runs or more.
    const many = runs(runsOf(1_200, 20_000));
    const more = arrayOf(outsideIds(1_500, 1_200));
    expect(expandsRunArray(many, more)).toBe(true);
    const want = sortedUnique([...runsOf(1_200, 20_000), ...outsideIds(1_500, 1_200)]);
    expectCanonical(containerOr(many, more, false), want, 'expanded');
    // The prediction can be wrong: an array that fills every gap leaves one run, and the expansion still says so.
    const evens = range(0, 1_200).map((v) => v * 2);
    const odds = range(0, 1_199).map((v) => v * 2 + 1);
    expect(expandsRunArray(runs(evens), arrayOf(odds))).toBe(true);
    const filled = containerOr(runs(evens), arrayOf(odds), false);
    expect(filled.kind).toBe(RUN);
    expect(filled.len).toBe(1);
    expect(valuesOf(filled)).toEqual(range(0, 2_399));
  });

  it('a run container that already holds the ids is the container itself on both sides of the boundary', () => {
    for (const g of [20, 24, 40]) {
      const base = runsOf(1_000, 2_000);
      const run = runs(base);
      const present = arrayOf(base.slice(0, g));
      expect(containerOr(run, present, true)).toBe(run);
      expect(containerOr(run, present, false)).not.toBe(run);
      expect(valuesOf(containerOr(run, present, false))).toEqual(base);
    }
  });
});

describe('a bitmap holding large run containers, written with large arrays, against CRoaring', () => {
  const stored = (ids: number[]) => {
    const m = TsBitmap.fromValues(ids);
    m.optimize();
    return TsBitmap.safeDeserialize(m.serialize(), CAP);
  };

  it('addMany and orInPlace of arrays of 1,000 to 4,096 ids into 800 to 1,500 runs agree byte for byte', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 800, max: 1_500 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1_000, max: 4_096 }),
        fc.integer({ min: 0, max: 2 ** 20 }),
        fc.constantFrom('addMany', 'orInPlace'),
        (runCount, width, g, seed, how) => {
          const base = range(0, runCount).flatMap((k) => range(40 * k, 40 * k + width));
          let x = seed + 1;
          const ids = sortedUnique(
            range(0, g).map(() => {
              x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
              return x % 60_000;
            }),
          );
          const m = stored(base);
          if (how === 'addMany') m.addMany(ids);
          else m.orInPlace(TsBitmap.fromValues(ids));
          const native = new RoaringBitmap32(base);
          native.addMany(ids);
          expect(m.size).toBe(native.size);
          m.optimize();
          native.runOptimize();
          expect(Buffer.from(m.serialize()).equals(Buffer.from(native.serialize(true)))).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });
});
