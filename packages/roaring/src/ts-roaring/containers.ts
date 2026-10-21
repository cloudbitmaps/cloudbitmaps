/**
 * The three Roaring containers on typed arrays, and the operations on one container or a pair of them.
 *
 * A Roaring bitmap splits a 32-bit id into a 16-bit key and a 16-bit remainder and keeps the remainders of one key in a
 * container, whose kind is chosen for its content (Chambi, Lemire, Kaser and Godin, 2016; Lemire et al., 2016 and 2018,
 * the papers credited in the package README):
 *
 *   - ARRAY:  the sorted remainders, a `Uint16Array`, for up to 4,096 values;
 *   - BITSET: 65,536 bits, a `Uint32Array` of 2,048 words, for more than 4,096 values;
 *   - RUN:    `(start, length - 1)` pairs of maximal runs of consecutive remainders, a `Uint16Array`.
 *
 * A container keeps its cardinality; nothing recounts it per call. A container is a RUN only because it was decoded
 * from one or because {@link optimize} chose it: the first change to a run container turns it back into an array or a
 * bitset, so a mutating path never has to edit runs. This module is the simple form: a combine of two containers goes
 * through bitset words and picks the kind by cardinality. Speed work lands on top of it, not in it.
 */
import { ARRAY_MAX_CARDINALITY } from '../portable/layout';

/** A container of sorted `u16` values. */
export const ARRAY = 0;
/** A container of 65,536 bits. */
export const BITSET = 1;
/** A container of `(start, length - 1)` pairs. */
export const RUN = 2;
type Kind = typeof ARRAY | typeof BITSET | typeof RUN;

/** 32-bit words in a bitset container. */
export const WORDS = 2_048;
/** Bytes of a bitset container's body. */
export const BITSET_BYTES = 8_192;

const NO_U16 = new Uint16Array(0);
const NO_WORDS = new Uint32Array(0);

/**
 * One container. Which of `u16` and `words` is in use follows `kind`: an array's values are `u16[0, len)` (`len` is
 * the cardinality, and `u16` may be longer), a bitset's bits are `words`, a run container's pairs are `u16[0, 2 * len)`
 * (`len` is the number of runs). `card` is the number of values in every kind.
 */
export class Container {
  constructor(
    readonly kind: Kind,
    readonly u16: Uint16Array,
    readonly words: Uint32Array,
    readonly len: number,
    readonly card: number,
  ) {}
}

export function arrayContainer(values: Uint16Array, card: number): Container {
  return new Container(ARRAY, values, NO_WORDS, card, card);
}

export function bitsetContainer(words: Uint32Array, card: number): Container {
  return new Container(BITSET, NO_U16, words, 0, card);
}

export function runContainer(pairs: Uint16Array, runs: number, card: number): Container {
  return new Container(RUN, pairs, NO_WORDS, runs, card);
}

/** Set bits in one 32-bit word. */
function popcount32(word: number): number {
  let w = word - ((word >>> 1) & 0x5555_5555);
  w = (w & 0x3333_3333) + ((w >>> 2) & 0x3333_3333);
  return Math.imul((w + (w >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
}

/** Set the bits `start` to `end`, both inclusive, in `words`. */
function setRange(words: Uint32Array, start: number, end: number): void {
  const first = start >>> 5;
  const last = end >>> 5;
  const head = (0xffff_ffff << (start & 31)) >>> 0;
  const tail = 0xffff_ffff >>> (31 - (end & 31));
  if (first === last) {
    words[first] = (words[first] as number) | (head & tail);
    return;
  }
  words[first] = (words[first] as number) | head;
  for (let i = first + 1; i < last; i++) words[i] = 0xffff_ffff;
  words[last] = (words[last] as number) | tail;
}

/**
 * The container holding the ascending distinct remainders `lows[0, count)`: an array up to 4,096 values and a bitset
 * above. `lows` is kept as the array's storage when it becomes one.
 */
export function fromSortedLows(lows: Uint16Array, count: number): Container {
  if (count <= ARRAY_MAX_CARDINALITY) return arrayContainer(lows, count);
  const words = new Uint32Array(WORDS);
  for (let i = 0; i < count; i++) {
    const v = lows[i] as number;
    words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
  }
  return bitsetContainer(words, count);
}

/** The container holding the bits of `words` (kept as the bitset's storage when it becomes one), or `null` if none is set. */
function fromWords(words: Uint32Array): Container | null {
  let card = 0;
  for (let i = 0; i < WORDS; i++) card += popcount32(words[i] as number);
  if (card === 0) return null;
  if (card > ARRAY_MAX_CARDINALITY) return bitsetContainer(words, card);
  const out = new Uint16Array(card);
  wordsToLows(words, out);
  return arrayContainer(out, card);
}

/** Write the positions of the set bits of `words`, ascending, to `out`; returns how many. */
function wordsToLows(words: Uint32Array, out: Uint16Array): number {
  let k = 0;
  for (let i = 0; i < WORDS; i++) {
    let w = words[i] as number;
    while (w !== 0) {
      const lowest = w & -w;
      out[k++] = i * 32 + 31 - Math.clz32(lowest);
      w ^= lowest;
    }
  }
  return k;
}

/** Write the container's remainders, ascending, to `out` (which holds at least `card` of them); returns how many. */
export function toLows(c: Container, out: Uint16Array): number {
  if (c.kind === ARRAY) {
    out.set(c.u16.subarray(0, c.len));
    return c.len;
  }
  if (c.kind === BITSET) return wordsToLows(c.words, out);
  let k = 0;
  for (let r = 0; r < c.len; r++) {
    const start = c.u16[2 * r] as number;
    const end = start + (c.u16[2 * r + 1] as number);
    for (let v = start; v <= end; v++) out[k++] = v;
  }
  return k;
}

/**
 * The container's bits as words. A bitset's own words are returned, not a copy: a caller reads them and never writes.
 * Any other kind is expanded into a new array.
 */
function toWords(c: Container): Uint32Array {
  if (c.kind === BITSET) return c.words;
  const words = new Uint32Array(WORDS);
  if (c.kind === ARRAY) {
    for (let i = 0; i < c.len; i++) {
      const v = c.u16[i] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
  } else {
    for (let r = 0; r < c.len; r++) {
      const start = c.u16[2 * r] as number;
      setRange(words, start, start + (c.u16[2 * r + 1] as number));
    }
  }
  return words;
}

/** An array or a bitset (by cardinality) with a run container's values; any other container as it is. */
function demote(c: Container): Container {
  if (c.kind !== RUN) return c;
  if (c.card > ARRAY_MAX_CARDINALITY) return bitsetContainer(toWords(c), c.card);
  const out = new Uint16Array(c.card);
  toLows(c, out);
  return arrayContainer(out, c.card);
}

/** A copy that shares nothing with `c`. */
export function cloneContainer(c: Container): Container {
  if (c.kind === ARRAY) return arrayContainer(c.u16.slice(0, c.len), c.card);
  if (c.kind === BITSET) return bitsetContainer(c.words.slice(), c.card);
  return runContainer(c.u16.slice(0, 2 * c.len), c.len, c.card);
}

/** The index of the first of `u16[0, len)` that is `>= low` (a run container's start is every second one: `stride` 2). */
function lowerBound(u16: Uint16Array, len: number, low: number, stride: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((u16[mid * stride] as number) < low) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function containerHas(c: Container, low: number): boolean {
  if (c.kind === BITSET) return (((c.words[low >>> 5] as number) >>> (low & 31)) & 1) === 1;
  if (c.kind === ARRAY) {
    const at = lowerBound(c.u16, c.len, low, 1);
    return at < c.len && c.u16[at] === low;
  }
  // The last run starting at or before `low`.
  const after = lowerBound(c.u16, c.len, low + 1, 2);
  if (after === 0) return false;
  const r = after - 1;
  return low <= (c.u16[2 * r] as number) + (c.u16[2 * r + 1] as number);
}

/**
 * Add `low`; returns the container that now holds it, which is `c` itself unless the kind changed. `c.card` is the
 * new cardinality either way.
 */
export function containerAdd(c: Container, low: number): Container {
  if (containerHas(c, low)) return c;
  const plain = demote(c);
  if (plain.kind === BITSET) {
    const words = plain.words;
    words[low >>> 5] = (words[low >>> 5] as number) | (1 << (low & 31));
    return bitsetContainer(words, plain.card + 1);
  }
  if (plain.card === ARRAY_MAX_CARDINALITY) {
    const words = toWords(plain);
    words[low >>> 5] = (words[low >>> 5] as number) | (1 << (low & 31));
    return bitsetContainer(words, plain.card + 1);
  }
  const at = lowerBound(plain.u16, plain.len, low, 1);
  let u16 = plain.u16;
  if (u16.length > plain.len) {
    u16.copyWithin(at + 1, at, plain.len);
  } else {
    u16 = new Uint16Array(Math.min(ARRAY_MAX_CARDINALITY, Math.max(8, plain.len * 2)));
    u16.set(plain.u16.subarray(0, at));
    u16.set(plain.u16.subarray(at, plain.len), at + 1);
  }
  u16[at] = low;
  return arrayContainer(u16, plain.card + 1);
}

/**
 * Remove `low`; returns the container that now holds the rest, `c` itself unless the kind changed, or `null` when
 * nothing is left.
 */
export function containerRemove(c: Container, low: number): Container | null {
  if (!containerHas(c, low)) return c;
  if (c.card === 1) return null;
  const plain = demote(c);
  if (plain.kind === BITSET) {
    const words = plain.words;
    words[low >>> 5] = (words[low >>> 5] as number) & ~(1 << (low & 31));
    const card = plain.card - 1;
    if (card > ARRAY_MAX_CARDINALITY) return bitsetContainer(words, card);
    const out = new Uint16Array(card);
    wordsToLows(words, out);
    return arrayContainer(out, card);
  }
  const at = lowerBound(plain.u16, plain.len, low, 1);
  plain.u16.copyWithin(at, at + 1, plain.len);
  return arrayContainer(plain.u16, plain.card - 1);
}

/** The largest remainder in the container. */
export function containerMax(c: Container): number {
  if (c.kind === ARRAY) return c.u16[c.len - 1] as number;
  if (c.kind === RUN) return (c.u16[2 * c.len - 2] as number) + (c.u16[2 * c.len - 1] as number);
  for (let i = WORDS - 1; i >= 0; i--) {
    const w = c.words[i] as number;
    if (w !== 0) return i * 32 + 31 - Math.clz32(w);
  }
  throw new RangeError('a bitset container holds no bits');
}

/** The number of maximal runs of consecutive values the container's values form. */
function runCount(c: Container): number {
  if (c.kind === RUN) return c.len;
  if (c.kind === ARRAY) {
    let runs = 0;
    let previous = -2;
    for (let i = 0; i < c.len; i++) {
      const v = c.u16[i] as number;
      if (v !== previous + 1) runs++;
      previous = v;
    }
    return runs;
  }
  // A run starts at each set bit whose lower neighbour (the previous word's top bit, for bit 0) is clear.
  let runs = 0;
  let carry = 0;
  for (let i = 0; i < WORDS; i++) {
    const w = c.words[i] as number;
    runs += popcount32((w & ~((w << 1) | carry)) >>> 0);
    carry = w >>> 31;
  }
  return runs;
}

/** `c` as a run container: the pairs of its maximal runs, `runs` of them. */
function toRun(c: Container, runs: number): Container {
  const pairs = new Uint16Array(2 * runs);
  let r = 0;
  if (c.kind === ARRAY) {
    let i = 0;
    while (i < c.len) {
      let j = i;
      while (j + 1 < c.len && (c.u16[j + 1] as number) === (c.u16[j] as number) + 1) j++;
      pairs[2 * r] = c.u16[i] as number;
      pairs[2 * r + 1] = j - i;
      r++;
      i = j + 1;
    }
    return runContainer(pairs, runs, c.card);
  }
  let start = -1;
  const close = (end: number): void => {
    pairs[2 * r] = start;
    pairs[2 * r + 1] = end - start;
    r++;
    start = -1;
  };
  for (let i = 0; i < WORDS; i++) {
    const w = c.words[i] as number;
    if (w === 0) {
      if (start >= 0) close(i * 32 - 1);
    } else if (w === 0xffff_ffff) {
      if (start < 0) start = i * 32;
    } else {
      for (let b = 0; b < 32; b++) {
        const set = ((w >>> b) & 1) === 1;
        if (set && start < 0) start = i * 32 + b;
        else if (!set && start >= 0) close(i * 32 + b - 1);
      }
    }
  }
  if (start >= 0) close(65_535);
  return runContainer(pairs, runs, c.card);
}

/**
 * The canonical container for these values: a run container only when its body (`2 + 4 * runs` bytes) is strictly
 * smaller than the plain one (`2 * card` bytes for an array, 8,192 for a bitset), so a tie is an array (or bitset),
 * whatever kind the container had. It depends on the values alone, which is what makes stored bytes a function of the set.
 */
export function optimize(c: Container): Container {
  const runs = runCount(c);
  const plain = c.card <= ARRAY_MAX_CARDINALITY ? 2 * c.card : BITSET_BYTES;
  if (2 + 4 * runs < plain) return c.kind === RUN ? c : toRun(c, runs);
  return demote(c);
}

/** `a` and `b` combined bit by bit; `null` when nothing is left. The result shares nothing with either. */
function viaWords(
  a: Container,
  b: Container,
  op: (x: number, y: number) => number,
): Container | null {
  const wa = toWords(a);
  const wb = toWords(b);
  const out = new Uint32Array(WORDS);
  for (let i = 0; i < WORDS; i++) out[i] = op(wa[i] as number, wb[i] as number);
  return fromWords(out);
}

/** `a` and `b` together; neither is changed. */
export function containerOr(a: Container, b: Container): Container {
  return viaWords(a, b, (x, y) => x | y) as Container;
}

/** The values both hold, or `null` when there are none. */
export function containerAnd(a: Container, b: Container): Container | null {
  return viaWords(a, b, (x, y) => x & y);
}

/** The values of `a` that `b` lacks, or `null` when there are none. */
export function containerAndNot(a: Container, b: Container): Container | null {
  return viaWords(a, b, (x, y) => x & ~y);
}
