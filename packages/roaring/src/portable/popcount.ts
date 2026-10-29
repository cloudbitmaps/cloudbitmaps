/**
 * Bit counting over 32-bit words, shared by the layout check (which counts a stored bitset before it is decoded) and by
 * the containers (which count a bitset they have just built), so both count one way.
 */

/** The 32-bit words of a bitset container: 65,536 bits. */
export const BITSET_WORDS = 2_048;

/** Set bits in one 32-bit word. */
export function popcount32(word: number): number {
  let w = word - ((word >>> 1) & 0x5555_5555);
  w = (w & 0x3333_3333) + ((w >>> 2) & 0x3333_3333);
  return Math.imul((w + (w >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
}

/**
 * Set bits in the {@link BITSET_WORDS} words of a bitset: Harley-Seal, which adds sixteen words through a tree of carry-save
 * adders and counts the bits of one word in sixteen instead of every word. Plain 32-bit integer arithmetic, no `BigInt`.
 */
export function popcountWords(d: Uint32Array): number {
  let total = 0;
  let ones = 0;
  let twos = 0;
  let fours = 0;
  let eights = 0;
  for (let i = 0; i < BITSET_WORDS; i += 16) {
    let u: number;
    let twosA: number;
    let twosB: number;
    let foursA: number;
    let foursB: number;
    let x = d[i] as number;
    let y = d[i + 1] as number;
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = d[i + 2] as number;
    y = d[i + 3] as number;
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursA = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    x = d[i + 4] as number;
    y = d[i + 5] as number;
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = d[i + 6] as number;
    y = d[i + 7] as number;
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursB = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    u = fours ^ foursA;
    const eightsA = (fours & foursA) | (u & foursB);
    fours = u ^ foursB;
    x = d[i + 8] as number;
    y = d[i + 9] as number;
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = d[i + 10] as number;
    y = d[i + 11] as number;
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursA = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    x = d[i + 12] as number;
    y = d[i + 13] as number;
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = d[i + 14] as number;
    y = d[i + 15] as number;
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursB = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    u = fours ^ foursA;
    const eightsB = (fours & foursA) | (u & foursB);
    fours = u ^ foursB;
    u = eights ^ eightsA;
    const sixteens = (eights & eightsA) | (u & eightsB);
    eights = u ^ eightsB;
    total += popcount32(sixteens);
  }
  return (
    16 * total +
    8 * popcount32(eights) +
    4 * popcount32(fours) +
    2 * popcount32(twos) +
    popcount32(ones)
  );
}
