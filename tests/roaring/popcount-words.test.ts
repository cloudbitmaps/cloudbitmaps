import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BITSET_WORDS, popcount32, popcountWords } from '@/portable/popcount';

/** The bit counts the layout check and the containers share, against a count one bit at a time. */
const naive = (word: number): number => {
  let n = 0;
  for (let w = word >>> 0; w !== 0; w &= w - 1) n++;
  return n;
};

describe('popcount32 and popcountWords', () => {
  it('count a word and a whole bitset as a one-bit-at-a-time count does', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (w) => {
        expect(popcount32(w)).toBe(naive(w));
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.uint32Array({ minLength: BITSET_WORDS, maxLength: BITSET_WORDS }), (words) => {
        expect(popcountWords(words)).toBe(words.reduce((n, w) => n + naive(w), 0));
      }),
      { numRuns: 100 },
    );
  });

  it('count a lone bit in every word, the fullest bitset and the empty one', () => {
    const words = new Uint32Array(BITSET_WORDS);
    expect(popcountWords(words)).toBe(0);
    for (let i = 0; i < BITSET_WORDS; i++) {
      words[i] = 0x8000_0000;
      expect(popcountWords(words)).toBe(1);
      words[i] = 0;
    }
    words.fill(0xffff_ffff);
    expect(popcountWords(words)).toBe(65_536);
  });
});
