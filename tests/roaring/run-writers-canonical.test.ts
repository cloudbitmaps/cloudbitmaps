import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  BITSET,
  RUN,
  containerAdd,
  containerAnd,
  containerAndNot,
  containerOr,
  containerXor,
  containersEqual,
  optimize,
} from '@/ts-roaring/containers';
import type { Container } from '@/ts-roaring/containers';
import {
  KINDS,
  KIND_NAME,
  containerOf,
  intervalsOf,
  range,
  ruleKind,
  sortedUnique,
  valuesOf,
} from '../helpers/container-kinds';

/**
 * Every writer of a run container leaves the runs maximal (no two touch or overlap, ascending, inside 0..65,535) and
 * the container in its smallest kind. Same-kind `isEqual` compares run pairs directly and the decoder refuses a run
 * list that is not maximal, so a writer that left two touching runs would make equal sets compare unequal. The writers
 * are `optimize` (a bitset or an array turned into runs), a write into a run (`containerAdd`), the union of a run with
 * an array, and the run results of `and`, `or`, `andNot` and `xor`. Each is driven from arrays, bitsets and runs, at the
 * edges 0 and 65,535, and each result is held to the same set built another way.
 */
const CAP = 1 << 27;

/** Sets that are made of intervals, so run containers are the smaller form, with joints and the chunk's two ends. */
const intervalSet = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 65_535 }), fc.integer({ min: 1, max: 300 })), {
    minLength: 1,
    maxLength: 14,
  })
  .map((runs) => sortedUnique(runs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))));
const edgeSet = fc.constantFrom(
  [0, 1, 2],
  [3, 4, 5],
  [65_533, 65_534, 65_535],
  [65_530, 65_531, 65_532],
  [0, 65_535],
  [0, 1, 2, 3, 4, 5, 65_530, 65_531, 65_532, 65_533, 65_534, 65_535],
  [0],
  [65_535],
  range(0, 65_536),
);
const inside = (xs: readonly number[]) => {
  const have = new Set(xs);
  return (v: number) => have.has(v);
};
const outside = (xs: readonly number[]) => {
  const have = new Set(xs);
  return (v: number) => !have.has(v);
};
const anySet = fc.oneof(intervalSet, intervalSet, edgeSet);

/**
 * The result is the set, with maximal runs when it is a run container, and it equals the set built another way. A run
 * container is only ever written when it is the smaller form; where the writer chooses between run, array and bitset
 * (`strict`), the kind is the one the size rule gives, whichever way it goes.
 */
function expectCanonical(
  c: Container | null,
  set: readonly number[],
  label: string,
  strict = true,
  unchanged = false,
): void {
  if (set.length === 0) {
    expect(c === null || c.card === 0, `${label}: empty`).toBe(true);
    return;
  }
  const got = c as Container;
  expect(valuesOf(got), `${label}: values`).toEqual(set);
  expect(got.card, `${label}: card`).toBe(set.length);
  if (strict) expect(got.kind, `${label}: kind ${KIND_NAME[got.kind]}`).toBe(ruleKind(set));
  if (got.kind === RUN) {
    // (a run container handed back unchanged is whatever it was, a decoded tie included)
    if (!unchanged) {
      expect(ruleKind(set), `${label}: a run only where it is the smaller form`).toBe(RUN);
    }
    const iv = intervalsOf(got);
    expect(iv.length, `${label}: run count`).toBe(got.len);
    for (let r = 0; r < iv.length; r++) {
      expect((iv[r] as [number, number])[1], `${label}: run ${r} ends in the chunk`).toBeLessThan(
        65_536,
      );
      if (r > 0) {
        expect(
          (iv[r] as [number, number])[0],
          `${label}: run ${r} touches or overlaps the one before`,
        ).toBeGreaterThan((iv[r - 1] as [number, number])[1] + 1);
      }
    }
  }
  // against the same set built another way: a run list from the values, and the container the size rule gives
  for (const other of [containerOf(RUN, set), containerOf(ruleKind(set), set)]) {
    expect(containersEqual(got, other), `${label}: equals a rebuilt ${KIND_NAME[other.kind]}`).toBe(
      true,
    );
    expect(
      containersEqual(other, got),
      `${label}: a rebuilt ${KIND_NAME[other.kind]} equals it`,
    ).toBe(true);
  }
}

const models: Array<
  [
    string,
    (a: Container, b: Container) => Container | null,
    (a: readonly number[], b: readonly number[]) => number[],
  ]
> = [
  ['and', (a, b) => containerAnd(a, b), (a, b) => b.filter(inside(a))],
  ['or', (a, b) => containerOr(a, b), (a, b) => sortedUnique([...a, ...b])],
  ['andNot', (a, b) => containerAndNot(a, b), (a, b) => a.filter(outside(b))],
  [
    'xor',
    (a, b) => containerXor(a, b),
    (a, b) => sortedUnique([...a.filter(outside(b)), ...b.filter(outside(a))]),
  ],
];

describe('every writer of a run container leaves maximal runs and the smallest kind', () => {
  it('optimize, from an array, a bitset and a run', () => {
    fc.assert(
      fc.property(anySet, (set) => {
        // an array or a bitset in its own size range, and a run container
        const plain = set.length <= 4_096 ? ARRAY : BITSET;
        for (const kind of [plain, RUN]) {
          expectCanonical(
            optimize(containerOf(kind, set)),
            set,
            `optimize from ${KIND_NAME[kind]}`,
          );
        }
      }),
      { numRuns: 60 },
    );
  });

  it('containerAdd into a run, one id at a time, joining on either side and at 0 and 65,535', () => {
    fc.assert(
      fc.property(anySet, anySet, (base, ids) => {
        let c = containerOf(RUN, base);
        const have = new Set(base);
        for (const v of ids.slice(0, 8)) {
          const present = have.has(v);
          const wasRun = c.kind === RUN && !present;
          c = containerAdd(c, v);
          have.add(v);
          // a write into a run is the writer that picks the kind; once it is an array a write is an array's
          expectCanonical(c, sortedUnique([...have]), 'containerAdd', wasRun, present);
        }
      }),
      { numRuns: 60 },
    );
  });

  for (const [name, op, model] of models) {
    for (const ka of KINDS) {
      for (const kb of KINDS) {
        it(`${name} of ${KIND_NAME[ka]} with ${KIND_NAME[kb]}`, () => {
          fc.assert(
            fc.property(anySet, anySet, (a, b) => {
              const first = containerOf(ka, a);
              const second = containerOf(kb, b);
              // the kind is chosen by the size rule where a run meets a run, and for the union of a run with an array
              const strict =
                (ka === RUN && kb === RUN) ||
                (name === 'or' && ((ka === RUN && kb === ARRAY) || (ka === ARRAY && kb === RUN)));
              expectCanonical(op(first, second), model(a, b), `${name}`, strict);
              // neither operand is written
              expect(valuesOf(first)).toEqual(a);
              expect(valuesOf(second)).toEqual(b);
            }),
            { numRuns: 60 },
          );
        });
      }
    }
  }

  it('touching sets at both ends of the chunk join into one run through every writer', () => {
    const pairs: Array<[number[], number[]]> = [
      [
        [0, 1, 2],
        [3, 4, 5],
      ],
      [
        [65_530, 65_531, 65_532],
        [65_533, 65_534, 65_535],
      ],
      [[0], [1]],
      [[65_534], [65_535]],
    ];
    for (const [a, b] of pairs) {
      const set = sortedUnique([...a, ...b]);
      expect(containerOf(RUN, set).len).toBe(1);
      const union = containerOr(containerOf(RUN, a), containerOf(RUN, b));
      expectCanonical(union, set, 'or of two runs');
      const withArray = containerOr(containerOf(RUN, a), containerOf(ARRAY, b));
      expectCanonical(withArray, set, 'or of a run and an array');
      let written = containerOf(RUN, a);
      for (const v of b) written = containerAdd(written, v);
      expectCanonical(written, set, 'containerAdd');
      expectCanonical(
        containerXor(containerOf(RUN, a), containerOf(RUN, b)),
        set,
        'xor of two runs',
      );
    }
  });
});

describe('the size rule at its tie', () => {
  it('five values in two runs (a body of 10 bytes against 10) is an array; six in two is a run', () => {
    const five = [10, 11, 12, 20, 21];
    const six = [10, 11, 12, 20, 21, 22];
    expectCanonical(optimize(containerOf(ARRAY, five)), five, 'optimize five');
    expect(optimize(containerOf(ARRAY, five)).kind).toBe(ARRAY);
    expect(optimize(containerOf(ARRAY, six)).kind).toBe(RUN);
    // the same tie reached by a write, a union with an array and a union of two runs
    const grown = containerAdd(containerOf(RUN, [10, 11, 12, 20]), 21);
    expect(grown.kind).toBe(ARRAY);
    expectCanonical(grown, five, 'containerAdd to the tie');
    expect(containerAdd(containerOf(RUN, five.slice(0, 5)), 22).kind).toBe(RUN);
    const united = containerOr(containerOf(RUN, [10, 11, 12]), containerOf(ARRAY, [20, 21]));
    expect(united.kind).toBe(ARRAY);
    expectCanonical(united, five, 'containerOr with an array to the tie');
    const twoRuns = containerOr(containerOf(RUN, [10, 11, 12]), containerOf(RUN, [20, 21]));
    expect(twoRuns.kind).toBe(ARRAY);
    expectCanonical(twoRuns, five, 'containerOr of two runs to the tie');
    const above = containerOr(containerOf(RUN, [10, 11, 12]), containerOf(ARRAY, [20, 21, 22]));
    expect(above.kind).toBe(RUN);
    expectCanonical(above, six, 'containerOr above the tie');
  });

  it('4,096 and 4,097 values in 2,047 runs are runs; one more run (4,098 values in 2,048) is a bitset', () => {
    // 2,047 runs: 2,045 of two values and two of three, 4,096 values, a run body of 8,190 bytes against 8,192
    const base = range(0, 2_047).flatMap((i) =>
      i < 2 ? [i * 5, i * 5 + 1, i * 5 + 2] : [i * 5, i * 5 + 1],
    );
    expect(base.length).toBe(4_096);
    const start = containerOf(RUN, base);
    expect(start.len).toBe(2_047);
    expect(ruleKind(base)).toBe(RUN);
    // a value that extends a run keeps 2,047 runs: 4,097 values, still a run
    const extended = containerAdd(start, 10_232);
    expect(extended.card).toBe(4_097);
    expect(extended.kind).toBe(RUN);
    expectCanonical(extended, sortedUnique([...base, 10_232]), 'containerAdd to 4,097');
    // a value that touches nothing makes a 2,048th run: 8,194 bytes against 8,192, a bitset
    const wide = containerAdd(start, 20_000);
    expect(wide.card).toBe(4_097);
    expect(wide.kind).toBe(BITSET);
    expectCanonical(wide, sortedUnique([...base, 20_000]), 'containerAdd to 4,097 in 2,048 runs');
    // the same through a union with an array
    const viaOr = containerOr(start, containerOf(ARRAY, [10_232]));
    expect(viaOr.kind).toBe(RUN);
    expectCanonical(viaOr, sortedUnique([...base, 10_232]), 'containerOr to 4,097');
    const viaOrWide = containerOr(start, containerOf(ARRAY, [10_232, 20_000]));
    expect(viaOrWide.kind).toBe(BITSET);
    expectCanonical(viaOrWide, sortedUnique([...base, 10_232, 20_000]), 'containerOr to 4,098');
  });
});

describe('isEqual on bitmaps whose run containers came from a write', () => {
  const stored = (ids: number[]) => {
    const m = TsBitmap.fromValues(ids);
    m.optimize();
    return TsBitmap.safeDeserialize(m.serialize(), CAP);
  };

  it('a decoded run joined by addMany or orInPlace equals the same ids built fresh and optimized', () => {
    // two runs in key 0 and two in key 2 with a one-id gap between them; the write fills the gap
    const left = [...range(100, 400), ...range(401, 900)];
    const ids = [...left, ...left.map((v) => v + 2 * 65_536)];
    const gaps = [400, 400 + 2 * 65_536];
    const all = sortedUnique([...ids, ...gaps]);
    for (const how of ['addMany', 'orInPlace'] as const) {
      const m = stored(ids);
      expect(m.hasRunContainer()).toBe(true);
      if (how === 'addMany') m.addMany(gaps);
      else m.orInPlace(TsBitmap.fromValues(gaps));
      const fresh = TsBitmap.fromValues(all);
      fresh.optimize();
      const plain = TsBitmap.fromValues(all);
      expect(m.isEqual(fresh), `${how}: against an optimized build`).toBe(true);
      expect(fresh.isEqual(m), `${how}: an optimized build against it`).toBe(true);
      expect(m.isEqual(plain), `${how}: against an unoptimized build`).toBe(true);
      expect(m.isEqual(TsBitmap.safeDeserialize(fresh.serialize(), CAP))).toBe(true);
      // one id apart is not equal
      const apart = TsBitmap.fromValues(all);
      apart.remove(all[all.length - 1] as number);
      expect(m.isEqual(apart)).toBe(false);
    }
  });

  it('runs written at the edges 0 and 65,535 by add compare equal to the same set decoded', () => {
    const ids = [...range(1, 200), ...range(65_300, 65_535)];
    const m = stored(ids);
    m.add(0);
    m.add(65_535);
    const want = sortedUnique([...ids, 0, 65_535]);
    const fresh = TsBitmap.fromValues(want);
    fresh.optimize();
    expect(m.isEqual(fresh)).toBe(true);
    expect(fresh.isEqual(m)).toBe(true);
    expect(m.isEqual(TsBitmap.safeDeserialize(fresh.serialize(), CAP))).toBe(true);
  });
});
