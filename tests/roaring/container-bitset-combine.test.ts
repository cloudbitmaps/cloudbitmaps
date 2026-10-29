import { describe, expect, it } from 'vitest';
import {
  Container,
  WORDS,
  appendIds,
  bitsetContainer,
  containerAnd,
  containerAndNot,
  containerOr,
  containerXor,
} from '@/ts-roaring/containers';

/**
 * The combines of two bitset containers go four words a step. Each is checked against a plain word-by-word result: on
 * random words, with a single word different at every position (so each lane of the step is the only difference
 * somewhere), in place and not, and with an operand combined with itself.
 */
const popcount = (w: number): number => {
  let n = 0;
  for (let v = w >>> 0; v !== 0; v &= v - 1) n++;
  return n;
};

function randomWords(seed: number): Uint32Array {
  const words = new Uint32Array(WORDS);
  let s = seed >>> 0;
  for (let i = 0; i < WORDS; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    words[i] = s;
  }
  return words;
}

const cardOf = (words: Uint32Array) => words.reduce((n, w) => n + popcount(w), 0);
const bitset = (words: Uint32Array) => bitsetContainer(words, cardOf(words));

function idsOf(c: Container | null): number[] {
  if (c === null) return [];
  const out = new Uint32Array(c.card);
  appendIds(c, out, 0, 0);
  return [...out];
}

function idsOfWords(words: Uint32Array): number[] {
  const ids: number[] = [];
  for (let i = 0; i < WORDS; i++) {
    for (let b = 0; b < 32; b++) if (((words[i] as number) >>> b) & 1) ids.push(i * 32 + b);
  }
  return ids;
}

const OPS = [
  { name: 'and', run: containerAnd, word: (a: number, b: number) => a & b },
  { name: 'or', run: containerOr, word: (a: number, b: number) => a | b },
  { name: 'xor', run: containerXor, word: (a: number, b: number) => a ^ b },
  { name: 'andNot', run: containerAndNot, word: (a: number, b: number) => a & ~b },
];

function expected(x: Uint32Array, y: Uint32Array, word: (a: number, b: number) => number) {
  const out = new Uint32Array(WORDS);
  for (let i = 0; i < WORDS; i++) out[i] = word(x[i] as number, y[i] as number);
  return idsOfWords(out);
}

describe.each(OPS)('the four-words-a-step $name of two bitsets', ({ run, word }) => {
  it('matches the word-by-word result on random words, in place or not, and leaves the other operand alone', () => {
    for (const seed of [1, 2, 3]) {
      const xw = randomWords(seed);
      const yw = randomWords(seed + 100);
      const want = expected(xw, yw, word);
      const yCopy = yw.slice();
      expect(idsOf(run(bitset(xw.slice()), bitset(yw)))).toEqual(want);
      const target = bitset(xw.slice());
      expect(idsOf(run(target, bitset(yw), true))).toEqual(want);
      expect([...yw]).toEqual([...yCopy]);
    }
  });

  it('sees a single word that differs at each lane of the first, a middle and the last groups of four', () => {
    const base = randomWords(7);
    // A difference confined to one word: and/andNot against `base` gain or lose bits only there, xor shows exactly it.
    const positions = [
      ...Array(8).keys(),
      ...[1020, 1021, 1022, 1023, 1024, 1025],
      2040,
      2041,
      2042,
      2043,
      2044,
      2045,
      2046,
      2047,
    ];
    for (const p of positions) {
      const other = base.slice();
      other[p] = (other[p] as number) ^ 0x80000001;
      expect(idsOf(run(bitset(base.slice()), bitset(other)))).toEqual(expected(base, other, word));
    }
  });

  it('combines a bitset with itself', () => {
    const xw = randomWords(11);
    const want = expected(xw, xw, word);
    expect(idsOf(run(bitset(xw.slice()), bitset(xw.slice())))).toEqual(want);
    const same = bitset(xw.slice());
    expect(idsOf(run(same, same, true))).toEqual(want);
  });
});
