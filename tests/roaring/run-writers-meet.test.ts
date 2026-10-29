import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  RUN,
  containerAdd,
  containerAnd,
  containerAndNot,
  containerOr,
  containerXor,
  containersEqual,
  containersSubset,
  orManyContainers,
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
 * Where the writers of a run container meet. A run container comes from a decode, from `optimize`, from a write into a
 * run (`containerAdd`, `containerOr` of a run with an array) and from a combine of two runs (`and`, `or`, `andNot`,
 * `xor`). Each must hand the others a canonical run list (ascending, no two runs touching or overlapping, cardinality
 * exact), because the equality compare, the subset test, the xor and the many-way union read a run list as it stands.
 * Each case here feeds the output of one writer to another, against a plain set.
 */
const intervals = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 65_535 }), fc.integer({ min: 1, max: 900 })), {
    minLength: 1,
    maxLength: 12,
  })
  .map((runs) => sortedUnique(runs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))));
const few = fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 30 });

/** The run list of a container is canonical, and its values and cardinality are the set's. */
function expectSet(c: Container | null, set: number[], kindByRule = true): void {
  if (set.length === 0) {
    expect(c === null || c.card === 0).toBe(true);
    return;
  }
  expect(c).not.toBeNull();
  const got = c as Container;
  expect(valuesOf(got)).toEqual(set);
  expect(got.card).toBe(set.length);
  if (kindByRule) expect(got.kind === RUN).toBe(ruleKind(set) === RUN);
  if (got.kind === RUN) {
    const iv = intervalsOf(got);
    for (let i = 1; i < iv.length; i++) expect(iv[i]![0]).toBeGreaterThan(iv[i - 1]![1] + 1);
  }
}

const combines: Array<
  [
    string,
    (a: Container, b: Container) => Container | null,
    (a: Set<number>, b: number[]) => number[],
  ]
> = [
  ['and', (a, b) => containerAnd(a, b), (a, b) => b.filter((v) => a.has(v))],
  ['or', (a, b) => containerOr(a, b), (a, b) => sortedUnique([...a, ...b])],
  ['andNot', (a, b) => containerAndNot(a, b), (a, b) => [...a].filter((v) => !b.includes(v))],
  [
    'xor',
    (a, b) => containerXor(a, b),
    (a, b) => sortedUnique([...a].filter((v) => !b.includes(v)).concat(b.filter((v) => !a.has(v)))),
  ],
];

describe('a run result of a combine, then a write into it', () => {
  for (const [name, op, model] of combines) {
    it(`${name}, then containerAdd and containerOr with an array`, () => {
      fc.assert(
        fc.property(intervals, intervals, few, (x, y, extra) => {
          const result = op(containerOf(RUN, x), containerOf(RUN, y));
          const set = model(new Set(x), y);
          expectSet(result, set);
          if (result === null) return;
          const added = containerAdd(result, extra[0] as number);
          expectSet(added, sortedUnique([...set, extra[0] as number]));
          const ored = containerOr(result, containerOf(0, sortedUnique(extra)));
          expectSet(ored, sortedUnique([...set, ...extra]));
        }),
        { numRuns: 60 },
      );
    });
  }
});

describe('a run list written by a write, then read by a combine, a compare and a union', () => {
  it('is equal to the same set from another writer, and one id apart is not', () => {
    fc.assert(
      fc.property(intervals, few, (x, extra) => {
        const set = sortedUnique([...x, ...extra]);
        let written = containerOf(RUN, x);
        for (const v of extra) written = containerAdd(written, v);
        const merged = containerOr(containerOf(RUN, x), containerOf(0, sortedUnique(extra)));
        const direct = containerOf(RUN, set);
        for (const other of [direct, merged, containerOf(ruleKind(set), set)]) {
          expect(containersEqual(written, other)).toBe(true);
          expect(containersEqual(other, written)).toBe(true);
        }
        const missing = set.length > 1 ? set.slice(1) : [];
        if (missing.length > 0) {
          expect(containersEqual(written, containerOf(RUN, missing))).toBe(false);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('is compared equal to the result of a combine that makes the same set', () => {
    fc.assert(
      fc.property(intervals, intervals, (x, y) => {
        const union = containerOr(containerOf(RUN, x), containerOf(RUN, y));
        const set = sortedUnique([...x, ...y]);
        // the same set reached by a write into a run, one id at a time
        let written = containerOf(RUN, x);
        for (const v of y) written = containerAdd(written, v);
        expect(containersEqual(union, written)).toBe(true);
        expect(containersEqual(union, containerOf(ruleKind(set), set))).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('is a subset of its union and a superset of its intersection, with no count', () => {
    fc.assert(
      fc.property(intervals, intervals, (x, y) => {
        const a = containerOf(RUN, x);
        const b = containerOf(RUN, y);
        const union = containerOr(a, b);
        const both = containerAnd(a, b);
        expect(containersSubset(a, union)).toBe(true);
        expect(containersSubset(union, a)).toBe(sortedUnique([...x, ...y]).length === x.length);
        if (both !== null) {
          expect(containersSubset(both, a)).toBe(true);
          expect(containersSubset(both, b)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('feeds xor and the many-way union the same sets a plain walk gives', () => {
    fc.assert(
      fc.property(intervals, intervals, intervals, few, (x, y, z, extra) => {
        const union = containerOr(containerOf(RUN, x), containerOf(RUN, y));
        const written = containerAdd(containerOf(RUN, z), extra[0] as number);
        const set = sortedUnique([...x, ...y]);
        const wset = sortedUnique([...z, extra[0] as number]);
        const inW = new Set(wset);
        const inU = new Set(set);
        expectSet(
          containerXor(union, written),
          sortedUnique([...set.filter((v) => !inW.has(v)), ...wset.filter((v) => !inU.has(v))]),
          false,
        );
        const many = orManyContainers([union, written, containerOf(0, sortedUnique(extra))]);
        // the many-way union picks array or bitset by count and never a run: values and count only
        const all = sortedUnique([...set, ...wset, ...extra]);
        expect(valuesOf(many)).toEqual(all);
        expect(many.card).toBe(all.length);
        expect(many.kind).not.toBe(RUN);
      }),
      { numRuns: 60 },
    );
  });
});
