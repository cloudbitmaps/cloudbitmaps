import { describe, expect, it } from 'vitest';
import {
  ARRAY,
  Container,
  EQUAL_VIEW_MIN,
  RUN,
  WORDS,
  bitsetContainer,
  containersEqual,
} from '@/ts-roaring/containers';

/**
 * The wide compare of two containers of one kind: eight elements a step, and a 32-bit view over the same bytes from
 * `EQUAL_VIEW_MIN` values up. Each case is checked against a plain element-by-element compare, with a difference at the
 * first, last, middle and group-edge elements, at every pairing of start offsets (aligned to four bytes or not) and at
 * lengths on both sides of the group size and of the view threshold.
 */
function arrayOf(values: readonly number[], pad = 0, byteShift = 0): Container {
  const buffer = new ArrayBuffer(byteShift + 2 * (pad + values.length));
  const data = new Uint16Array(buffer, byteShift, pad + values.length);
  data.set(values, pad);
  return new Container(ARRAY, data, pad, values.length, values.length, false);
}

function runsOf(pairs: readonly number[], pad = 0, byteShift = 0): Container {
  const buffer = new ArrayBuffer(byteShift + 2 * (pad + pairs.length));
  const data = new Uint16Array(buffer, byteShift, pad + pairs.length);
  data.set(pairs, pad);
  let card = 0;
  for (let i = 1; i < pairs.length; i += 2) card += (pairs[i] as number) + 1;
  return new Container(RUN, data, pad, pairs.length / 2, card, false);
}

const arrayValues = (n: number) => Array.from({ length: n }, (_, i) => 3 * i);
const runPairs = (r: number) =>
  Array.from({ length: 2 * r }, (_, i) => (i % 2 === 0 ? 10 * (i / 2) : 3));

/** Positions worth a difference in a list of `n`: both ends, the middle and the edges of every group of eight. */
function positions(n: number): number[] {
  const set = new Set<number>([0, 1, n - 2, n - 1, n >> 1]);
  for (let g = 8; g < n; g += 8) {
    set.add(g - 1);
    set.add(g);
  }
  return [...set].filter((p) => p >= 0 && p < n);
}

const LENGTHS = [
  1, 2, 3, 7, 8, 9, 15, 16, 17, 255, 256, 257, 510, 511, 512, 513, 514, 515, 1000, 1001, 4096,
];
const PLACEMENTS = [
  { pad: 0, shift: 0 },
  { pad: 1, shift: 0 },
  { pad: 2, shift: 0 },
  { pad: 3, shift: 0 },
  { pad: 0, shift: 2 },
  { pad: 1, shift: 2 },
];

describe('the wide compare of arrays', () => {
  it('has the view threshold the docs of the compare state', () => {
    expect(EQUAL_VIEW_MIN).toBe(512);
  });

  for (const n of LENGTHS) {
    it(`${n} values: equal at every pair of placements, any single difference seen`, () => {
      const values = arrayValues(n);
      for (const left of PLACEMENTS) {
        for (const right of PLACEMENTS) {
          const a = arrayOf(values, left.pad, left.shift);
          expect(containersEqual(a, arrayOf(values, right.pad, right.shift))).toBe(true);
          for (const p of positions(n)) {
            const moved = values.slice();
            moved[p] = (moved[p] as number) + 1;
            expect(containersEqual(a, arrayOf(moved, right.pad, right.shift))).toBe(false);
            expect(containersEqual(arrayOf(moved, right.pad, right.shift), a)).toBe(false);
          }
        }
      }
    });
  }

  it('a difference in the values just past the group size and past the view threshold', () => {
    for (const n of [8, 9, 512, 513]) {
      const values = arrayValues(n);
      const moved = values.slice();
      moved[n - 1] = (moved[n - 1] as number) + 7;
      expect(containersEqual(arrayOf(values), arrayOf(moved))).toBe(false);
    }
  });
});

describe('the wide compare of runs', () => {
  for (const r of [1, 3, 4, 5, 8, 9, 127, 128, 255, 256, 257, 300, 1200]) {
    it(`${r} runs: equal at every pair of placements, a start or a length that differs is seen`, () => {
      const pairs = runPairs(r);
      for (const left of PLACEMENTS) {
        for (const right of PLACEMENTS) {
          const a = runsOf(pairs, left.pad, left.shift);
          expect(containersEqual(a, runsOf(pairs, right.pad, right.shift))).toBe(true);
          for (const p of positions(2 * r)) {
            const moved = pairs.slice();
            // Shorten a run (its length is odd-indexed) or move a start; either way the set differs, and so does the pair list.
            moved[p] = p % 2 === 0 ? (moved[p] as number) + 1 : (moved[p] as number) - 1;
            const b = runsOf(moved, right.pad, right.shift);
            b.card = a.card;
            expect(containersEqual(a, b)).toBe(false);
            expect(containersEqual(b, a)).toBe(false);
          }
        }
      }
    });
  }
});

describe('the wide compare of bitsets', () => {
  it('a bit that differs in any word is seen, the first, the last and every group edge included', () => {
    const base = new Uint32Array(WORDS);
    for (let i = 0; i < WORDS; i++) base[i] = (i * 2654435761) >>> 0;
    const card = 1;
    const a = bitsetContainer(base, card);
    expect(containersEqual(a, bitsetContainer(base.slice(), card))).toBe(true);
    for (const p of positions(WORDS)) {
      const moved = base.slice();
      moved[p] = (moved[p] as number) ^ 0x80000000;
      expect(containersEqual(a, bitsetContainer(moved, card))).toBe(false);
    }
  });
});
