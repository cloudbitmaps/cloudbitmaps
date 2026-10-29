import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ARRAY, MERGE_FIRST, containersIntersect } from '@/ts-roaring/containers';
import { containerOf, sortedUnique } from '../helpers/container-kinds';

/**
 * Whether two arrays of the same size share a value: the merge steps taken before the scratch bitset is set up, at the
 * boundary of that count, the bitset path, the span reject, and random overlapping arrays against a plain set.
 */
const shares = (a: readonly number[], b: readonly number[]): boolean => {
  const inB = new Set(b);
  return a.some((v) => inB.has(v));
};
const intersects = (a: readonly number[], b: readonly number[], pad = 0): boolean =>
  containersIntersect(containerOf(ARRAY, a, pad), containerOf(ARRAY, b, pad + 1));

/**
 * Two arrays of `n` values whose merge meets its one shared value after exactly `steps` merge steps: `a` holds the
 * evens and `b` the odds, one of them shifted so the parity of the step count can be chosen, plus the shared value.
 */
function metAfter(steps: number, n: number): [number[], number[]] {
  const m = steps >> 1;
  if (steps % 2 === 0) {
    const a = Array.from({ length: n }, (_, k) => 2 * k);
    const b = sortedUnique([...Array.from({ length: n - 1 }, (_, k) => 2 * k + 1), 2 * m]);
    return [a, b];
  }
  const a = Array.from({ length: n }, (_, k) => 2 * k + 1);
  const b = sortedUnique([...Array.from({ length: n - 1 }, (_, k) => 2 * k), 2 * m + 1]);
  return [a, b];
}

describe('intersects of two arrays, around the merge-first step count', () => {
  it('takes 64 merge steps before the bitset path (the boundary cases below are written from it)', () => {
    expect(MERGE_FIRST).toBe(64);
  });

  const n = MERGE_FIRST + 40;
  const around = [
    0,
    1,
    2,
    31,
    MERGE_FIRST - 2,
    MERGE_FIRST - 1,
    MERGE_FIRST,
    MERGE_FIRST + 1,
    MERGE_FIRST + 2,
    n,
  ];
  for (const steps of around) {
    it(`the one shared value met at merge step ${steps} is found, and its absence is not`, () => {
      const [a, b] = metAfter(steps, n);
      expect(shares(a, b)).toBe(true);
      expect(intersects(a, b)).toBe(true);
      expect(intersects(b, a)).toBe(true);
      expect(intersects(a, b, 3)).toBe(true);
      // The same arrays without the shared value: the walk goes past every step and the answer is no.
      const shared = a.filter((v) => b.includes(v));
      expect(shared).toHaveLength(1);
      const apart = a.filter((v) => !shared.includes(v));
      expect(intersects(apart, b)).toBe(false);
    });
  }

  it('answers an overlapping span with no shared value at any size, through the bitset path and the merge', () => {
    for (const size of [32, 33, 100, MERGE_FIRST - 1, MERGE_FIRST, MERGE_FIRST + 1, 1_000, 3_000]) {
      const a = Array.from({ length: size }, (_, k) => 2 * k);
      const b = Array.from({ length: size }, (_, k) => 2 * k + 1);
      expect(intersects(a, b)).toBe(false);
      expect(intersects(b, a)).toBe(false);
    }
  });

  it('leaves the scratch bits clear: a call that set bits cannot make a later call answer yes', () => {
    const a = Array.from({ length: 1_000 }, (_, k) => 2 * k);
    const odd = Array.from({ length: 1_000 }, (_, k) => 2 * k + 1);
    // No shared value, so the bitset path runs to the end (a hit would leave bits only if the clear were skipped).
    expect(intersects(a, odd)).toBe(false);
    // Same size, same span, the other way round: the smaller array is now the odd one and the longer holds the even
    // values, which are exactly the bits the first call set. Had they been left set, a test of the evens would hit.
    expect(intersects(odd, a)).toBe(false);
    expect(intersects(a, odd)).toBe(false);
    // A pair that hits late (after the merge-first steps) leaves the scratch clear too.
    const [x, y] = metAfter(MERGE_FIRST + 7, 1_000);
    expect(intersects(x, y)).toBe(true);
    expect(intersects(a, odd)).toBe(false);
  });

  it('ends at once when the shorter array runs out inside the merge-first steps', () => {
    const sizes: [number, number][] = [
      [32, 40],
      [32, 33],
      [40, 50],
      [100, 120],
      [MERGE_FIRST - 1, MERGE_FIRST + 5],
    ];
    for (const [short, long] of sizes) {
      const a = Array.from({ length: short }, (_, k) => 3 * k + 1);
      const b = Array.from({ length: long }, (_, k) => 3 * k + 2);
      expect(intersects(a, b)).toBe(false);
      expect(intersects(b, a)).toBe(false);
    }
  });

  it('rejects arrays whose spans do not meet, and accepts spans that touch at one value', () => {
    const low = Array.from({ length: 500 }, (_, k) => k);
    const high = Array.from({ length: 500 }, (_, k) => 1_000 + k);
    expect(intersects(low, high)).toBe(false);
    expect(intersects(high, low)).toBe(false);
    const touch = Array.from({ length: 500 }, (_, k) => 499 + k);
    expect(intersects(low, touch)).toBe(true);
    expect(intersects(touch, low)).toBe(true);
  });
});

describe('intersects of two arrays against a plain set', () => {
  const sizeArb = fc.integer({ min: 32, max: 1_500 });
  const sample = (size: number, seed: number, span: number): number[] => {
    let s = seed >>> 0;
    const out = new Set<number>();
    while (out.size < size) {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out.add(((t ^ (t >>> 14)) >>> 0) % span);
    }
    return [...out].sort((x, y) => x - y);
  };

  it('agrees with the set for random arrays that overlap in span, in either order', () => {
    fc.assert(
      fc.property(
        sizeArb,
        sizeArb,
        fc.integer(),
        fc.integer(),
        fc.constantFrom(4_000, 20_000, 65_536),
        fc.integer({ min: 0, max: 4 }),
        (na, nb, sa, sb, span, pad) => {
          const a = sample(Math.min(na, span >> 1), sa, span);
          const b = sample(Math.min(nb, span >> 1), sb, span);
          const want = shares(a, b);
          expect(intersects(a, b, pad)).toBe(want);
          expect(intersects(b, a, pad)).toBe(want);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('agrees with the set for two thousand-value arrays over the chunk, the pair the bench times', () => {
    let yes = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const a = sample(1_000, seed, 65_536);
      const b = sample(1_000, seed * 7919 + 13, 65_536);
      const want = shares(a, b);
      if (want) yes++;
      expect(intersects(a, b)).toBe(want);
    }
    expect(yes).toBeGreaterThan(100);
  });
});
