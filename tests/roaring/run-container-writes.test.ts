import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { parsePortableLayout } from '@/portable/layout';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  BITSET,
  Container,
  RUN,
  WORDS,
  appendIds,
  bitsetContainer,
  containerAdd,
  containerOr,
} from '@/ts-roaring/containers';

/**
 * A write into a run container stays a run write: the ids merge into the run list (extending, joining neighbours,
 * inserting), the cardinality is exact, and the container is a run while that is the smaller form (a body of
 * `2 + 4 * runs` bytes strictly under the plain one) and an array or a bitset when it is not. Held to a plain set at
 * the container level and to CRoaring on whole bitmaps.
 */
const CAP = 1 << 27;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const sortedUnique = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);

/** A run container of `lows` (ascending, distinct), held at `pad` in a larger array as a slab neighbour is. */
function runs(lows: readonly number[], pad = 0): Container {
  const pairs: number[] = [];
  for (let i = 0; i < lows.length;) {
    let j = i;
    while (j + 1 < lows.length && lows[j + 1] === (lows[j] as number) + 1) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pad + pairs.length + pad);
  data.set(pairs, pad);
  return new Container(RUN, data, pad, pairs.length / 2, lows.length, true);
}

function arrayOf(lows: readonly number[], pad = 0): Container {
  const data = new Uint16Array(pad + lows.length);
  data.set(lows, pad);
  return new Container(ARRAY, data, pad, lows.length, lows.length, false);
}

function valuesOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  expect(appendIds(c, out, 0, 0)).toBe(c.card);
  return Array.from(out);
}

/** What the kind rule says a container of these values is: a run only when strictly smaller than the plain body. */
function ruleKind(lows: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < lows.length; i++) if (i === 0 || lows[i] !== (lows[i - 1] as number) + 1) n++;
  const plain = lows.length <= 4_096 ? 2 * lows.length : 8_192;
  return 2 + 4 * n < plain ? RUN : lows.length <= 4_096 ? ARRAY : BITSET;
}

/** The run pairs of a run container, as [start, end] intervals. */
function intervals(c: Container): Array<[number, number]> {
  const u16 = c.data as Uint16Array;
  return range(0, c.len).map((r) => {
    const s = u16[c.off + 2 * r] as number;
    return [s, s + (u16[c.off + 2 * r + 1] as number)];
  });
}

/** The container is exactly what its values say: card, kind by rule, and, for a run, maximal ascending runs. */
function expectCanonical(c: Container, want: readonly number[], label: string): void {
  expect(valuesOf(c), `${label}: values`).toEqual(want);
  expect(c.card, `${label}: card`).toBe(want.length);
  expect(c.kind, `${label}: kind`).toBe(ruleKind(want));
  if (c.kind === RUN) {
    const iv = intervals(c);
    for (let r = 1; r < iv.length; r++) {
      expect(
        (iv[r] as [number, number])[0],
        `${label}: run ${r} touches the one before`,
      ).toBeGreaterThan((iv[r - 1] as [number, number])[1] + 1);
    }
    expect((c.data as Uint16Array).length - c.off, `${label}: storage`).toBeGreaterThanOrEqual(
      2 * c.len,
    );
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
    // Wide runs, so the run form stays smaller than a large plain one.
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: 65_000 }), fc.integer({ min: 100, max: 3_000 })), {
        minLength: 1,
        maxLength: 12,
      })
      .map((rs) => rs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))),
    // Gaps of one, so every value added fills a gap and joins two runs.
    fc.constantFrom(
      range(0, 200).map((v) => v * 2),
      range(0, 200).map((v) => v * 2 + 1),
      [0, 1, 2, 65_533, 65_534, 65_535],
    ),
  )
  .map((v) => sortedUnique([...v]));

const arrayShaped = fc
  .oneof(
    fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 12 }),
    fc.uniqueArray(fc.integer({ min: 0, max: 3_000 }), { minLength: 1, maxLength: 600 }),
    fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 4_096 }),
    fc.constantFrom([0], [65_535], [0, 65_535], [1, 3, 5, 7, 9]),
  )
  .map((v) => sortedUnique([...v]));

describe('a run container written with an array', () => {
  // Budget 6 s (the default is 5 s): the slowest measured time was 2.0 s, on a Node 24 CI runner. Rule: that time times
  // three, rounded up to the next whole second.
  it(
    'holds the union, its exact cardinality, the kind the size rule gives and canonical runs, either operand order',
    { timeout: 6000 },
    () => {
      fc.assert(
        fc.property(
          runShaped,
          arrayShaped,
          fc.integer({ min: 0, max: 4 }),
          fc.boolean(),
          (r, a, pad, inPlace) => {
            const want = sortedUnique([...r, ...a]);
            const run = runs(r, pad);
            const arr = arrayOf(a, pad + 1);
            const before = [
              Array.from(run.data as Uint16Array),
              Array.from(arr.data as Uint16Array),
            ];
            expectCanonical(containerOr(run, arr, false), want, 'run | array');
            // A caller that lets the result be the run container itself gets it only when nothing was added.
            const kept = containerOr(run, arr, inPlace);
            expect(kept === run, 'kept').toBe(inPlace && want.length === r.length);
            if (kept !== run) expectCanonical(kept, want, 'run | array, may keep');
            expectCanonical(containerOr(arr, run, false), want, 'array | run');
            // Neither operand's storage is written.
            expect([
              Array.from(run.data as Uint16Array),
              Array.from(arr.data as Uint16Array),
            ]).toEqual(before);
          },
        ),
        { numRuns: 400 },
      );
    },
  );

  it('a run against a bitset still gives the bitset union', () => {
    fc.assert(
      fc.property(runShaped, arrayShaped, (r, a) => {
        const words = new Uint32Array(WORDS);
        for (const v of a) words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
        const bits = bitsetContainer(words, a.length);
        const want = sortedUnique([...r, ...a]);
        expect(valuesOf(containerOr(runs(r), bits, false))).toEqual(want);
        expect(valuesOf(containerOr(bits, runs(r), false))).toEqual(want);
      }),
      { numRuns: 60 },
    );
  });

  it('ids that touch, join, extend, insert, or sit inside runs, and at both ends of the chunk', () => {
    const base = [...range(10, 20), ...range(30, 40), ...range(65_526, 65_536)];
    const cases: Array<[string, number[]]> = [
      ['inside a run', [15]],
      ['already everything', [10, 19, 30, 39, 65_526, 65_535]],
      ['extends a run at its end', [20]],
      ['extends a run at its start', [9]],
      ['joins two runs', range(20, 30)],
      ['joins two runs with one id each side', [20, 29]],
      ['fills the gap one by one', [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]],
      ['a new run before the first', [3]],
      ['next to nothing, between runs', [25]],
      ['value 0', [0]],
      ['value 0 next to a run starting at 1', [0]],
      ['value 65,535 extends the last run up', [65_535 - 11, 65_525]],
      ['a new run after the last', [65_520]],
      ['several runs at once', [1, 5, 25, 45, 65_000]],
    ];
    for (const [label, add] of cases) {
      const want = sortedUnique([...base, ...add]);
      expectCanonical(
        containerOr(runs(base, 2), arrayOf(sortedUnique(add), 3), false),
        want,
        label,
      );
      for (const v of add) {
        expectCanonical(
          containerAdd(runs(base, 2), v),
          sortedUnique([...base, v]),
          `add ${v}: ${label}`,
        );
      }
    }
    expectCanonical(
      containerOr(runs([1, 2, 3]), arrayOf([0]), false),
      [0, 1, 2, 3],
      'value 0 beside 1',
    );
    expectCanonical(containerAdd(runs([1, 2, 3]), 0), [0, 1, 2, 3], 'add 0 beside 1');
  });

  it('a result over 4,096 values leaves the run form when runs are no longer smaller, and stays when they are', () => {
    // 2,046 runs of 3 values: 8,186 bytes as runs against 8,192 as a bitset, so a run.
    const dense = range(0, 2_046).flatMap((i) => [i * 10, i * 10 + 1, i * 10 + 2]);
    expect(ruleKind(dense)).toBe(RUN);
    // One isolated value more is the 2,047th run (8,190 bytes): still a run.
    const one = sortedUnique([...dense, 30_000]);
    expect(ruleKind(one)).toBe(RUN);
    expectCanonical(containerOr(runs(dense), arrayOf([30_000]), false), one, 'stays a run');
    expectCanonical(containerAdd(runs(dense), 30_000), one, 'add stays a run');
    // Two are the 2,048th (8,194 bytes against 8,192): a bitset.
    const two = sortedUnique([...one, 30_010]);
    expect(ruleKind(two)).toBe(BITSET);
    expectCanonical(containerOr(runs(dense), arrayOf([30_000, 30_010]), false), two, 'leaves');
    expectCanonical(containerAdd(runs(one), 30_010), two, 'add leaves');
    // A run container that a write makes an array: few values in many runs.
    const sparse = range(0, 100).map((i) => i * 5);
    expect(ruleKind(sparse)).toBe(ARRAY);
    expectCanonical(
      containerOr(runs(sparse), arrayOf([7]), false),
      sortedUnique([...sparse, 7]),
      'to an array',
    );
    expectCanonical(containerAdd(runs(sparse), 7), sortedUnique([...sparse, 7]), 'add to an array');
  });

  it('the run list is edited: a one-id write into 150 runs gives a run container of 150 or 151 pairs', () => {
    const base = range(0, 150).flatMap((i) => range(i * 400, i * 400 + 100 + (i % 7)));
    const run = runs(base);
    const apart = containerOr(run, arrayOf([i400(3) + 250]), false);
    expect(apart.kind).toBe(RUN);
    expect(apart.len).toBe(151);
    expect((apart.data as Uint16Array).length).toBe(2 * 151);
    const next = containerAdd(run, i400(3) + 250);
    expect(next.kind).toBe(RUN);
    expect(next.len).toBe(151);
  });

  it('ids that add nothing: the run container itself when the caller allows it, an equal copy when not', () => {
    const base = range(0, 150).flatMap((i) => range(i * 400, i * 400 + 100));
    const run = runs(base);
    const present = arrayOf([5, 400, 450, 59_603]);
    expect(containerOr(run, present, true)).toBe(run);
    const copy = containerOr(run, present, false);
    expect(copy).not.toBe(run);
    expect(valuesOf(copy)).toEqual(base);
    expect(containerAdd(run, 5)).toBe(run);
  });
});

function i400(i: number): number {
  return i * 400;
}

describe('a bitmap holding run containers, written to', () => {
  const kindsOf = (m: TsBitmap) => parsePortableLayout(m.serialize()).map((c) => c.kind);
  const stored = (ids: number[]) => {
    const m = TsBitmap.fromValues(ids);
    m.optimize();
    return TsBitmap.safeDeserialize(m.serialize(), CAP);
  };
  const wide = range(0, 200).flatMap((i) => range(i * 300, i * 300 + 120));

  it('addMany and orInPlace with an array leave run containers runs, and agree with CRoaring', () => {
    const extra = [1_000_000 + 5, 125, 421, 540, 69_000];
    const ids = [...wide, ...wide.map((v) => v + 3 * 65_536), 7 * 65_536 + 2];
    for (const how of ['addMany', 'orInPlace'] as const) {
      const m = stored(ids);
      expect(kindsOf(m).filter((k) => k === 2).length).toBeGreaterThan(0);
      const runsBefore = kindsOf(m).filter((k) => k === 2).length;
      if (how === 'addMany') m.addMany(extra);
      else m.orInPlace(TsBitmap.fromValues(extra));
      expect(kindsOf(m).filter((k) => k === 2).length, how).toBeGreaterThanOrEqual(runsBefore);
      const native = new RoaringBitmap32(ids);
      native.addMany(extra);
      expect([...m], how).toEqual(native.toArray());
      expect(m.size).toBe(native.size);
      m.optimize();
      native.runOptimize();
      expect(
        Buffer.from(m.serialize()).equals(Buffer.from(native.serialize(true))),
        `${how}: bytes`,
      ).toBe(true);
    }
  });

  it('addMany of ids already present changes nothing, size included, and keeps the bytes', () => {
    const m = stored(wide);
    const before = Buffer.from(m.serialize());
    m.addMany(wide.filter((_, i) => i % 7 === 0));
    expect(m.size).toBe(wide.length);
    expect(Buffer.from(m.serialize()).equals(before)).toBe(true);
  });

  it('a written bitmap and a clone of it change apart', () => {
    const m = stored(wide);
    const c = m.clone();
    m.addMany([125, 20_000]);
    expect(c.has(125)).toBe(false);
    expect(c.has(20_000)).toBe(false);
    expect(c.size).toBe(wide.length);
    c.add(130);
    expect(m.has(130)).toBe(false);
  });
});

describe('a run container written with an array, either side of the 2,047 runs where a run body stops being smaller than a bitset', () => {
  // Runs of three values six apart, so an id lands inside a run (offset 1), joins one on its right (3) or left (5), or
  // stands alone between two (4).
  const OFFSETS = [1, 3, 4, 5];
  const runsOfCount = (n: number) =>
    sortedUnique(range(0, n).flatMap((k) => range(10 + 6 * k, 13 + 6 * k)));
  const idsOfCount = (runCount: number, m: number) =>
    sortedUnique(
      range(0, m).map(
        (j) => 10 + 6 * (j % runCount) + (OFFSETS[Math.floor(j / runCount) % 4] as number),
      ),
    );

  // (runs, ids) pairs whose lengths sum to 2,046, 2,047, 2,048 and 2,049: the last sum whose result can still be a run body under a bitset's 8,192 bytes, and the first that cannot.
  const splits: Array<[number, number]> = [];
  for (const sum of [2_046, 2_047, 2_048, 2_049]) {
    for (const r of [1, 100, 1_000, 2_000, 2_040]) splits.push([r, sum - r]);
  }

  for (const [r, m] of splits) {
    it(`${r} runs with ${m} ids (${r + m} pairs) is canonical, adds the exact count and agrees with a plain set`, () => {
      const base = runsOfCount(r);
      const add = idsOfCount(r, m);
      const want = sortedUnique([...base, ...add]);
      const run = runs(base);
      expect(run.len).toBe(r);
      expectCanonical(containerOr(run, arrayOf(add), false), want, 'run | array');
      expectCanonical(containerOr(arrayOf(add), run, false), want, 'array | run');
      // Ids that add something are never the run container itself, even when the caller allows it.
      const kept = containerOr(run, arrayOf(add), true);
      expect(kept === run).toBe(want.length === base.length);
      expectCanonical(kept, want, 'run | array, may keep');
      // Nothing added: the run container itself when the caller allows it.
      const again = arrayOf(add.filter((v) => base.includes(v)));
      if (again.card > 0) {
        expect(containerOr(run, again, true) === run).toBe(true);
        expect(containerOr(run, again, false) === run).toBe(false);
      }
    });
  }

  it('a result of 2,047 runs and 6,141 values is a run container, and 2,048 runs of the same width is a bitset', () => {
    const near = runs(runsOfCount(2_046));
    // One alone id between two runs: 2,047 runs, a body of 8,190 bytes.
    const a = containerOr(near, arrayOf([10 + 6 * 2_046]), false);
    expect(a.kind).toBe(RUN);
    expect(a.len).toBe(2_047);
    // A second one: 2,048 runs is a body of 8,194 bytes, over the 8,192 of a bitset.
    const b = containerOr(near, arrayOf([10 + 6 * 2_046, 10 + 6 * 2_047]), false);
    expect(b.kind).toBe(BITSET);
    expect(valuesOf(b)).toEqual(
      sortedUnique([...runsOfCount(2_046), 10 + 6 * 2_046, 10 + 6 * 2_047]),
    );
  });
});
