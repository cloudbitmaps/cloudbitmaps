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
 * A container keeps its cardinality; nothing recounts it per call. A container is a RUN because it was decoded from
 * one, because {@link optimize} chose it, because a write into a run container edited its run list, or because a
 * combine of two runs left a run, in each case while the run form is the smaller one (see {@link optimize}); removing
 * an id turns it back into an array or a bitset. A run container's storage is never written in place: a write builds a
 * new list.
 *
 * STORAGE. An ARRAY or RUN container reads its values from `data[off, off + len)` (`len` values, or `len` run pairs
 * at `off + 2 * i`), so the small containers of one decoded bitmap can sit side by side in a single `Uint16Array` (a
 * slab) instead of each holding a typed array of its own, which for a run of a few bytes costs many times its payload.
 * A BITSET always owns its 2,048 words. A container whose storage another holder can see (a slab neighbour, or a
 * snapshot taken for `encodeChunks`, or a `clone`) has `shared` set, and a write copies it first; nothing writes to
 * shared storage. A write that may go in place returns a new container object over the same storage with `shared`
 * clear; that is safe because a clone or snapshot flags the container its bitmap holds at that moment, so a flagged
 * object never sits beside an unflagged one over the same storage.
 *
 * COMBINES, by the kinds of the pair (the result kind of a pair is a written rule: an array up to 4,096 values or a
 * bitset above, except that a run with an array stays a run while the run form is smaller, and two run containers keep
 * a run result while its body, `2 + 4 * runs` bytes, is strictly smaller than that array or bitset, so a combine of
 * two runs of a few long intervals does not expand them to 8 KB of words and every later operation on the result stays
 * a walk of the intervals; every run a combine writes is maximal, its runs ascending with at least one value between
 * them, as the decoder requires; a container that has no partner in the other bitmap is not combined, and `TsBitmap`
 * keeps it by reference, so a result bitmap can hold a run; `optimize` picks runs before anything is stored, so
 * stored bytes depend on the set alone):
 *
 *            and                       or                         andNot
 *   A  A     merge, or gallop when     merge while the union      scratch bitset from 32 values,
 *            one side is 16x longer    fits an array, else bits   gallop when the second side is
 *            (scratch bitset from 32)                             16x longer, else merge
 *   A  B     probe each value          copy the bitset, set bits  keep values whose bit is clear
 *   B  B     word loop                 word loop                  word loop
 *   R  R     interval intersection     interval union             interval difference
 *   A  R     probe / range copy        merge into the run list    through bitset words
 *   B  R     probe / range copy        through bitset words       through bitset words
 *
 * XOR is one pass per pair, not the union less the intersection: two arrays merge once, two bitsets are one word loop and
 * one count, two run lists are one walk over their boundaries, and any pair with a bitset flips the other side's bits in
 * the bitset's words (`containerXor`).
 *
 * A combine takes `inPlace` when its first operand is a bitset nothing else can see: the words are written, not copied.
 *
 * COUNTS. `containerAndCard` says how many values a pair shares, `containersIntersect` whether it shares any (stopping
 * at the first) and `containersSubset` whether every value of one is in the other (stopping at the first that is not), each
 * by the kinds of the pair and each building nothing: the answers the bitmap's counting operations are made from. The
 * last two never count.
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

/** How many times longer one array must be than the other for the shorter to gallop over it instead of a linear merge (a larger factor gallops less often, which suits similar sizes better and skewed ones worse). */
const GALLOP_SKEW = 16;

/** Whether this machine stores a typed array's elements little-endian, as the wire does (so a body is a plain copy). */
export const LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

/**
 * One container. `data` is a `Uint16Array` for an array or a run container and a `Uint32Array` of {@link WORDS} words
 * for a bitset. An array's values are `data[off, off + len)` (`len` is its cardinality), a run container's pairs are
 * `data[off, off + 2 * len)` (`len` is the number of runs), and `card` is the number of values in every kind. `shared`
 * says another holder can see `data`: it is set once and a write copies instead.
 */
export class Container {
  constructor(
    readonly kind: Kind,
    readonly data: Uint16Array | Uint32Array,
    readonly off: number,
    readonly len: number,
    readonly card: number,
    public shared: boolean,
  ) {}
}

/** The 16-bit storage of an array or run container. */
function lows16(c: Container): Uint16Array {
  return c.data as Uint16Array;
}

/** The words of a bitset container. */
function words32(c: Container): Uint32Array {
  return c.data as Uint32Array;
}

export function arrayContainer(values: Uint16Array, card: number): Container {
  return new Container(ARRAY, values, 0, card, card, false);
}

export function bitsetContainer(words: Uint32Array, card: number): Container {
  return new Container(BITSET, words, 0, 0, card, false);
}

function runContainer(pairs: Uint16Array, runs: number, card: number): Container {
  return new Container(RUN, pairs, 0, runs, card, false);
}

// Scratch for results whose size is known only after they are built: a combine writes into it and copies out exactly
// what it wrote. Single-threaded and never held across a call that could run other code, so one of each is enough.
let valueScratch = new Uint16Array(8_192);
let pairScratch = new Uint16Array(8_192);
// The most a scratch keeps for the life of the process: one container's worth of 16-bit values. A request above it
// gets a fresh array that is not kept.
const SCRATCH_KEEP = 65_536;

function values16(n: number): Uint16Array {
  if (valueScratch.length >= n) return valueScratch;
  if (n > SCRATCH_KEEP) return new Uint16Array(n);
  valueScratch = new Uint16Array(Math.max(n, Math.min(2 * valueScratch.length, SCRATCH_KEEP)));
  return valueScratch;
}

function pairs16(n: number): Uint16Array {
  if (pairScratch.length >= n) return pairScratch;
  if (n > SCRATCH_KEEP) return new Uint16Array(n);
  pairScratch = new Uint16Array(Math.max(n, Math.min(2 * pairScratch.length, SCRATCH_KEEP)));
  return pairScratch;
}

/** An array container of the first `n` values of `scratch` (copied out), or `null` when there are none. */
function arrayOfScratch(scratch: Uint16Array, n: number): Container | null {
  return n === 0 ? null : arrayContainer(scratch.slice(0, n), n);
}

/** Set bits in one 32-bit word. */
function popcount32(word: number): number {
  let w = word - ((word >>> 1) & 0x5555_5555);
  w = (w & 0x3333_3333) + ((w >>> 2) & 0x3333_3333);
  return Math.imul((w + (w >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
}

/**
 * Set bits in the {@link WORDS} words of a bitset: Harley-Seal, which adds sixteen words through a tree of carry-save
 * adders and counts the bits of one word in sixteen instead of every word. Plain 32-bit integer arithmetic, no `BigInt`.
 */
function popcountWords(d: Uint32Array): number {
  let total = 0;
  let ones = 0;
  let twos = 0;
  let fours = 0;
  let eights = 0;
  for (let i = 0; i < WORDS; i += 16) {
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

/**
 * Set bits in the AND of two bitsets, counted as the words are read: {@link popcountWords}'s tree with each word taken
 * as `d[i] & e[i]`, so the AND is never written to memory and read back.
 */
function popcountAnd(d: Uint32Array, e: Uint32Array): number {
  let total = 0;
  let ones = 0;
  let twos = 0;
  let fours = 0;
  let eights = 0;
  for (let i = 0; i < WORDS; i += 16) {
    let u: number;
    let twosA: number;
    let twosB: number;
    let foursA: number;
    let foursB: number;
    let x = (d[i] as number) & (e[i] as number);
    let y = (d[i + 1] as number) & (e[i + 1] as number);
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = (d[i + 2] as number) & (e[i + 2] as number);
    y = (d[i + 3] as number) & (e[i + 3] as number);
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursA = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    x = (d[i + 4] as number) & (e[i + 4] as number);
    y = (d[i + 5] as number) & (e[i + 5] as number);
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = (d[i + 6] as number) & (e[i + 6] as number);
    y = (d[i + 7] as number) & (e[i + 7] as number);
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursB = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    u = fours ^ foursA;
    const eightsA = (fours & foursA) | (u & foursB);
    fours = u ^ foursB;
    x = (d[i + 8] as number) & (e[i + 8] as number);
    y = (d[i + 9] as number) & (e[i + 9] as number);
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = (d[i + 10] as number) & (e[i + 10] as number);
    y = (d[i + 11] as number) & (e[i + 11] as number);
    u = ones ^ x;
    twosB = (ones & x) | (u & y);
    ones = u ^ y;
    u = twos ^ twosA;
    foursA = (twos & twosA) | (u & twosB);
    twos = u ^ twosB;
    x = (d[i + 12] as number) & (e[i + 12] as number);
    y = (d[i + 13] as number) & (e[i + 13] as number);
    u = ones ^ x;
    twosA = (ones & x) | (u & y);
    ones = u ^ y;
    x = (d[i + 14] as number) & (e[i + 14] as number);
    y = (d[i + 15] as number) & (e[i + 15] as number);
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

/** Clear the bits `start` to `end`, both inclusive, in `words`. */
function clearRange(words: Uint32Array, start: number, end: number): void {
  const first = start >>> 5;
  const last = end >>> 5;
  const head = (0xffff_ffff << (start & 31)) >>> 0;
  const tail = 0xffff_ffff >>> (31 - (end & 31));
  if (first === last) {
    words[first] = (words[first] as number) & ~(head & tail);
    return;
  }
  words[first] = (words[first] as number) & ~head;
  for (let i = first + 1; i < last; i++) words[i] = 0;
  words[last] = (words[last] as number) & ~tail;
}

/** Flip the bits `start` to `end`, both inclusive, in `words`. */
function flipRange(words: Uint32Array, start: number, end: number): void {
  const first = start >>> 5;
  const last = end >>> 5;
  const head = (0xffff_ffff << (start & 31)) >>> 0;
  const tail = 0xffff_ffff >>> (31 - (end & 31));
  if (first === last) {
    words[first] = (words[first] as number) ^ (head & tail);
    return;
  }
  words[first] = (words[first] as number) ^ head;
  for (let i = first + 1; i < last; i++) words[i] = ~(words[i] as number);
  words[last] = (words[last] as number) ^ tail;
}

/**
 * The container holding the ascending ids `ids[from, to)`, all of one key (only the low 16 bits are kept), duplicates
 * allowed: an array up to 4,096 distinct values and a bitset above.
 */
export function fromSortedIds(ids: Uint32Array, from: number, to: number): Container {
  const n = to - from;
  if (n <= ARRAY_MAX_CARDINALITY) {
    const lows = new Uint16Array(n);
    let count = 0;
    let previous = -1;
    for (let i = from; i < to; i++) {
      const low = (ids[i] as number) & 0xffff;
      if (low !== previous) lows[count++] = low;
      previous = low;
    }
    return arrayContainer(count === n ? lows : lows.slice(0, count), count);
  }
  const words = new Uint32Array(WORDS);
  for (let i = from; i < to; i++) {
    const v = (ids[i] as number) & 0xffff;
    words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
  }
  return fromWordsCard(words, popcountWords(words)) as Container;
}

/** The container holding `words` (kept as the bitset's storage when it becomes one) given its cardinality, or `null` when it is 0. */
function fromWordsCard(words: Uint32Array, card: number): Container | null {
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
    const base = i * 32 + 31;
    while (w !== 0) {
      const lowest = w & -w;
      out[k++] = base - Math.clz32(lowest);
      w ^= lowest;
    }
  }
  return k;
}

/** Write the container's remainders, ascending, to `out` (which holds at least `card` of them). */
function writeLows(c: Container, out: Uint16Array): void {
  if (c.kind === ARRAY) {
    out.set(lows16(c).subarray(c.off, c.off + c.len));
  } else if (c.kind === BITSET) {
    wordsToLows(words32(c), out);
  } else {
    const u16 = lows16(c);
    let k = 0;
    for (let r = 0; r < c.len; r++) {
      const start = u16[c.off + 2 * r] as number;
      const end = start + (u16[c.off + 2 * r + 1] as number);
      for (let v = start; v <= end; v++) out[k++] = v;
    }
  }
}

/** An array with fewer values than this is written out by a loop, not by a view and a copy. */
const SMALL_IDS = 32;

/**
 * Write the container's ids, each plus `base`, ascending, to `out` from index `at`; returns the index after the last.
 * The one step a `toUint32Array` takes per container.
 */
export function appendIds(c: Container, out: Uint32Array, at: number, base: number): number {
  if (c.kind === ARRAY) {
    const u16 = lows16(c);
    const end = c.off + c.len;
    if (base === 0 && c.len >= SMALL_IDS) {
      // One widening copy (a short array is counted out instead: a view over it costs more than its ids).
      out.set(u16.subarray(c.off, end), at);
      return at + c.len;
    }
    for (let i = c.off; i < end; i++) out[at++] = base + (u16[i] as number);
    return at;
  }
  if (c.kind === BITSET) {
    const words = words32(c);
    for (let i = 0; i < WORDS; i++) {
      let w = words[i] as number;
      const top = base + i * 32 + 31;
      while (w !== 0) {
        const lowest = w & -w;
        out[at++] = top - Math.clz32(lowest);
        w ^= lowest;
      }
    }
    return at;
  }
  // Runs: a short run is counted out, each id written once with `base` added as it goes; a long one is one widening copy.
  const u16 = lows16(c);
  for (let r = 0; r < c.len; r++) {
    const start = u16[c.off + 2 * r] as number;
    const length = u16[c.off + 2 * r + 1] as number;
    if (length < LONG_RUN) {
      const last = base + start + length;
      for (let v = base + start; v <= last; v++) out[at++] = v;
      continue;
    }
    // `start..start + length` out of a table of 0..65,535, then `base` added where it is not 0.
    const from = at;
    out.set(iota().subarray(start, start + length + 1), at);
    at += length + 1;
    if (base !== 0) for (let i = from; i < at; i++) out[i] = (out[i] as number) + base;
  }
  return at;
}

/** A run of at least this many values (less one) is copied out of {@link iota} rather than counted out. */
const LONG_RUN = 48;

let iotaTable: Uint16Array | undefined;

/** The numbers 0 to 65,535 as `u16`s, built when the first long run is expanded and kept. */
function iota(): Uint16Array {
  if (iotaTable === undefined) {
    iotaTable = new Uint16Array(65_536);
    for (let i = 0; i < 65_536; i++) iotaTable[i] = i;
  }
  return iotaTable;
}

/**
 * The container's bits as words. A bitset's own words are returned, not a copy: a caller reads them and never writes.
 * Any other kind is expanded into a new array.
 */
function toWords(c: Container): Uint32Array {
  if (c.kind === BITSET) return words32(c);
  const words = new Uint32Array(WORDS);
  const u16 = lows16(c);
  if (c.kind === ARRAY) {
    for (let i = c.off; i < c.off + c.len; i++) {
      const v = u16[i] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
  } else {
    for (let r = 0; r < c.len; r++) {
      const start = u16[c.off + 2 * r] as number;
      setRange(words, start, start + (u16[c.off + 2 * r + 1] as number));
    }
  }
  return words;
}

/** An array or a bitset (by cardinality) with a run container's values; any other container as it is. */
function demote(c: Container): Container {
  if (c.kind !== RUN) return c;
  if (c.card > ARRAY_MAX_CARDINALITY) return bitsetContainer(toWords(c), c.card);
  const out = new Uint16Array(c.card);
  writeLows(c, out);
  return arrayContainer(out, c.card);
}

/** A copy that shares nothing with `c`. */
export function cloneContainer(c: Container): Container {
  if (c.kind === BITSET) return bitsetContainer(words32(c).slice(), c.card);
  const copy = lows16(c).slice(c.off, c.off + (c.kind === ARRAY ? c.len : 2 * c.len));
  return new Container(c.kind, copy, 0, c.len, c.card, false);
}

/** The words `c` may write to: its own, or a copy when another holder can see them. */
function writableWords(c: Container): Uint32Array {
  return c.shared ? words32(c).slice() : words32(c);
}

/** The index of the first of the `len` values at `data[off + i * stride]` that is `>= low`. */
function lowerBound(
  data: Uint16Array,
  off: number,
  len: number,
  low: number,
  stride: number,
): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((data[off + mid * stride] as number) < low) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The index in `[from, end)` of the first of `data[off + i]` that is `>= target`, by doubling steps then a binary search; `end` if none. */
function gallop(data: Uint16Array, off: number, from: number, end: number, target: number): number {
  let step = 1;
  let lo = from;
  let hi = from;
  while (hi < end && (data[off + hi] as number) < target) {
    lo = hi + 1;
    hi += step;
    step *= 2;
  }
  if (hi > end) hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((data[off + mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function containerHas(c: Container, low: number): boolean {
  if (c.kind === BITSET)
    return ((((c.data as Uint32Array)[low >>> 5] as number) >>> (low & 31)) & 1) === 1;
  const u16 = c.data as Uint16Array;
  if (c.kind === ARRAY) {
    const at = lowerBound(u16, c.off, c.len, low, 1);
    return at < c.len && u16[c.off + at] === low;
  }
  // The last run starting at or before `low`.
  const after = lowerBound(u16, c.off, c.len, low + 1, 2);
  if (after === 0) return false;
  const r = c.off + 2 * (after - 1);
  return low <= (u16[r] as number) + (u16[r + 1] as number);
}

/** The index of the first of the `len` runs at `data[off + 2 * i]`, from index `from`, that starts after `value`; `len` if none. */
function runsAfter(
  data: Uint16Array,
  off: number,
  from: number,
  len: number,
  value: number,
): number {
  let step = 1;
  let lo = from;
  let hi = from;
  while (hi < len && (data[off + 2 * hi] as number) <= value) {
    lo = hi + 1;
    hi += step;
    step *= 2;
  }
  if (hi > len) hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((data[off + 2 * mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The container for the first `runs` pairs of `pairs`, whose values number `card`: a run container (over a copy when
 * `copy`, else over `pairs` itself) while its body is strictly smaller than the plain one, the rule {@link optimize}
 * applies, and an array or a bitset otherwise.
 */
function runsOrPlain(pairs: Uint16Array, runs: number, card: number, copy: boolean): Container {
  const plain = card <= ARRAY_MAX_CARDINALITY ? 2 * card : BITSET_BYTES;
  if (2 + 4 * runs < plain) {
    return runContainer(copy ? pairs.slice(0, 2 * runs) : pairs, runs, card);
  }
  return fromRunPairs(pairs, runs, card) as Container;
}

/** The run container `c` with the value `low` (which it lacks) added: the run list edited, never expanded to words. */
function addToRuns(c: Container, low: number): Container {
  const u16 = lows16(c);
  // `next` is the first run that starts after `low`; the run before it, if any, ends before `low`.
  const next = runsAfter(u16, c.off, 0, c.len, low);
  const prev = next - 1;
  const joinPrev =
    prev >= 0 &&
    (u16[c.off + 2 * prev] as number) + (u16[c.off + 2 * prev + 1] as number) + 1 === low;
  const joinNext = next < c.len && (u16[c.off + 2 * next] as number) === low + 1;
  const runs = c.len + 1 - (joinPrev ? 1 : 0) - (joinNext ? 1 : 0);
  const out = new Uint16Array(2 * runs);
  const head = joinPrev ? prev : next;
  out.set(u16.subarray(c.off, c.off + 2 * head));
  let at = 2 * head;
  if (joinPrev && joinNext) {
    out[at++] = u16[c.off + 2 * prev] as number;
    out[at++] =
      (u16[c.off + 2 * next] as number) +
      (u16[c.off + 2 * next + 1] as number) -
      (u16[c.off + 2 * prev] as number);
  } else if (joinPrev) {
    out[at++] = u16[c.off + 2 * prev] as number;
    out[at++] = (u16[c.off + 2 * prev + 1] as number) + 1;
  } else if (joinNext) {
    out[at++] = low;
    out[at++] = (u16[c.off + 2 * next + 1] as number) + 1;
  } else {
    out[at++] = low;
    out[at++] = 0;
  }
  const rest = joinNext ? next + 1 : next;
  out.set(u16.subarray(c.off + 2 * rest, c.off + 2 * c.len), at);
  return runsOrPlain(out, runs, c.card + 1, false);
}

/**
 * Add `low`; returns the container that now holds it, which is `c` itself unless the kind changed or the storage had to
 * be copied. `c.card` of the result is the new cardinality either way.
 */
export function containerAdd(c: Container, low: number): Container {
  if (containerHas(c, low)) return c;
  if (c.kind === RUN) return addToRuns(c, low);
  if (c.kind === BITSET) {
    const words = writableWords(c);
    words[low >>> 5] = (words[low >>> 5] as number) | (1 << (low & 31));
    return bitsetContainer(words, c.card + 1);
  }
  if (c.card === ARRAY_MAX_CARDINALITY) {
    const words = toWords(c);
    words[low >>> 5] = (words[low >>> 5] as number) | (1 << (low & 31));
    return bitsetContainer(words, c.card + 1);
  }
  const old = lows16(c);
  const at = lowerBound(old, c.off, c.len, low, 1);
  let u16 = old;
  if (!c.shared && c.off === 0 && old.length > c.len) {
    u16.copyWithin(at + 1, at, c.len);
  } else {
    u16 = new Uint16Array(Math.min(ARRAY_MAX_CARDINALITY, Math.max(8, c.len * 2)));
    u16.set(old.subarray(c.off, c.off + at));
    u16.set(old.subarray(c.off + at, c.off + c.len), at + 1);
  }
  u16[at] = low;
  return arrayContainer(u16, c.card + 1);
}

/**
 * A run container with the ids `ids[from, to)` (ascending, all of one key, duplicates allowed, only the low 16 bits
 * kept) added, for a group of a few: each id is found in the run list by a gallop search and written into one working
 * copy of the list (the tail moved by a block copy), so the cost is a few searches and moves, not a walk of every run.
 * The result is the same container {@link orRunArrayWalk} gives for the same values: a run container while that is the
 * smaller form, and `c` itself when no id adds anything.
 */
function addFewToRuns(c: Container, ids: Uint32Array, from: number, to: number): Container {
  const x = lows16(c);
  let data = x;
  let base = c.off;
  let out: Uint16Array | null = null;
  let n = c.len;
  let added = 0;
  for (let k = from; k < to; k++) {
    const low = (ids[k] as number) & 0xffff;
    const next = runsAfter(data, base, 0, n, low);
    const prev = next - 1;
    const prevEnd =
      prev >= 0 ? (data[base + 2 * prev] as number) + (data[base + 2 * prev + 1] as number) : -2;
    if (prevEnd >= low) continue;
    if (out === null) {
      out = new Uint16Array(2 * (c.len + to - from));
      out.set(x.subarray(c.off, c.off + 2 * c.len));
      data = out;
      base = 0;
    }
    const joinPrev = prevEnd + 1 === low;
    const joinNext = next < n && (out[2 * next] as number) === low + 1;
    if (joinPrev && joinNext) {
      out[2 * prev + 1] =
        (out[2 * next] as number) + (out[2 * next + 1] as number) - (out[2 * prev] as number);
      out.copyWithin(2 * next, 2 * next + 2, 2 * n);
      n--;
    } else if (joinPrev) {
      out[2 * prev + 1] = (out[2 * prev + 1] as number) + 1;
    } else if (joinNext) {
      out[2 * next] = low;
      out[2 * next + 1] = (out[2 * next + 1] as number) + 1;
    } else {
      out.copyWithin(2 * next + 2, 2 * next, 2 * n);
      out[2 * next] = low;
      out[2 * next + 1] = 0;
      n++;
    }
    added++;
  }
  if (out === null) return c;
  return runsOrPlain(out, n, c.card + added, true);
}

/**
 * The ids `ids[from, to)` (ascending, all of one key, duplicates allowed, only the low 16 bits kept) added to `c`; the
 * container that holds them, `c` itself when they add nothing. For a group of a few, where building a container for the
 * group and merging two containers costs more than putting each id in: a run container is edited by one search per id,
 * a bitset has its bits set (in place unless `c` is shared), an array has each id inserted. `c.card` of the result is the
 * new cardinality.
 */
export function containerAddSorted(
  c: Container,
  ids: Uint32Array,
  from: number,
  to: number,
): Container {
  if (c.kind === RUN) return addFewToRuns(c, ids, from, to);
  let cur = c;
  for (let k = from; k < to; k++) cur = containerAdd(cur, (ids[k] as number) & 0xffff);
  return cur;
}

/**
 * Remove `low`; returns the container that now holds the rest, `c` itself unless the kind changed or the storage had
 * to be copied, or `null` when nothing is left.
 */
export function containerRemove(c: Container, low: number): Container | null {
  if (!containerHas(c, low)) return c;
  if (c.card === 1) return null;
  const plain = demote(c);
  if (plain.kind === BITSET) {
    const words = writableWords(plain);
    words[low >>> 5] = (words[low >>> 5] as number) & ~(1 << (low & 31));
    return fromWordsCard(words, plain.card - 1);
  }
  const old = lows16(plain);
  const at = lowerBound(old, plain.off, plain.len, low, 1);
  if (!plain.shared && plain.off === 0) {
    old.copyWithin(at, at + 1, plain.len);
    return arrayContainer(old, plain.card - 1);
  }
  const u16 = new Uint16Array(plain.len - 1);
  u16.set(old.subarray(plain.off, plain.off + at));
  u16.set(old.subarray(plain.off + at + 1, plain.off + plain.len), at);
  return arrayContainer(u16, plain.card - 1);
}

/** The smallest remainder in the container. */
export function containerMin(c: Container): number {
  if (c.kind === ARRAY || c.kind === RUN) return (c.data as Uint16Array)[c.off] as number;
  const words = words32(c);
  for (let i = 0; i < WORDS; i++) {
    const w = words[i] as number;
    if (w !== 0) return i * 32 + 31 - Math.clz32(w & -w);
  }
  throw new RangeError('a bitset container holds no bits');
}

/** The largest remainder in the container. */
export function containerMax(c: Container): number {
  if (c.kind === ARRAY) return (c.data as Uint16Array)[c.off + c.len - 1] as number;
  if (c.kind === RUN) {
    const u16 = c.data as Uint16Array;
    return (u16[c.off + 2 * c.len - 2] as number) + (u16[c.off + 2 * c.len - 1] as number);
  }
  const words = words32(c);
  for (let i = WORDS - 1; i >= 0; i--) {
    const w = words[i] as number;
    if (w !== 0) return i * 32 + 31 - Math.clz32(w);
  }
  throw new RangeError('a bitset container holds no bits');
}

/**
 * The number of maximal runs of consecutive values the container's values form, or any count at or above `stop` when
 * it has that many (the caller only needs to know whether runs are few enough to be worth storing).
 */
function runCount(c: Container, stop: number): number {
  if (c.kind === RUN) return c.len;
  let runs = 0;
  if (c.kind === ARRAY) {
    const u16 = lows16(c);
    let previous = -2;
    for (let i = c.off; i < c.off + c.len; i++) {
      const v = u16[i] as number;
      if (v !== previous + 1 && ++runs >= stop) return runs;
      previous = v;
    }
    return runs;
  }
  // A run starts at each set bit whose lower neighbour (the previous word's top bit, for bit 0) is clear.
  const words = words32(c);
  let carry = 0;
  for (let i = 0; i < WORDS; i++) {
    const w = words[i] as number;
    const starts = w & ~((w << 1) | carry);
    // Words of all ones or none, most of a run-shaped set's, have no start: no count to take.
    if (starts !== 0) {
      runs += popcount32(starts >>> 0);
      if (runs >= stop) return runs;
    }
    carry = w >>> 31;
  }
  return runs;
}

/** `c` as a run container: the pairs of its maximal runs, `runs` of them. */
function toRun(c: Container, runs: number): Container {
  const pairs = new Uint16Array(2 * runs);
  let r = 0;
  if (c.kind === ARRAY) {
    const u16 = lows16(c);
    const end = c.off + c.len;
    let i = c.off;
    while (i < end) {
      let j = i;
      while (j + 1 < end && (u16[j + 1] as number) === (u16[j] as number) + 1) j++;
      pairs[2 * r] = u16[i] as number;
      pairs[2 * r + 1] = j - i;
      r++;
      i = j + 1;
    }
    return runContainer(pairs, runs, c.card);
  }
  // A start is a set bit with a clear lower neighbour and an end a set bit with a clear upper one; read in order, the
  // two alternate across words, and a run of one value is both at once.
  const words = words32(c);
  let start = 0;
  let carry = 0;
  for (let i = 0; i < WORDS; i++) {
    const w = words[i] as number;
    const next = i + 1 < WORDS ? (words[i + 1] as number) : 0;
    let starts = (w & ~((w << 1) | carry)) >>> 0;
    let ends = (w & ~((w >>> 1) | (next << 31))) >>> 0;
    carry = w >>> 31;
    let both = starts | ends;
    while (both !== 0) {
      const bit = both & -both;
      both ^= bit;
      const at = i * 32 + 31 - Math.clz32(bit);
      if ((starts & bit) !== 0) {
        starts ^= bit;
        start = at;
      }
      if ((ends & bit) !== 0) {
        ends ^= bit;
        pairs[2 * r] = start;
        pairs[2 * r + 1] = at - start;
        r++;
      }
    }
  }
  return runContainer(pairs, runs, c.card);
}

/**
 * The canonical container for these values: a run container only when its body (`2 + 4 * runs` bytes) is strictly
 * smaller than the plain one (`2 * card` bytes for an array, 8,192 for a bitset), so a tie is an array (or bitset),
 * whatever kind the container had. It depends on the values alone, which is what makes stored bytes a function of the set.
 */
export function optimize(c: Container): Container {
  const plain = c.card <= ARRAY_MAX_CARDINALITY ? 2 * c.card : BITSET_BYTES;
  // Smaller than the plain body needs `2 + 4 * runs < plain`, so a count at `stop` already settles it.
  const runs = runCount(c, (plain - 2) / 4);
  if (2 + 4 * runs < plain) return c.kind === RUN ? c : toRun(c, runs);
  return demote(c);
}

// ---------------------------------------------------------------------------------------------------------------
// Combines
// ---------------------------------------------------------------------------------------------------------------

/** Whether an array of `longer` values is at least {@link GALLOP_SKEW} times as long as one of `shorter`. */
function skewed(shorter: number, longer: number): boolean {
  return longer >= GALLOP_SKEW * shorter;
}

// Arrays shorter than this are merged; from here a similar-sized pair is intersected through a scratch bitset, which
// reads both arrays once, in order, with no unpredictable branch. A lower value pays the bitset's set-and-clear for
// pairs the merge finishes sooner; a higher one leaves mid-sized pairs on the slower merge.
const PROBE_MIN = 32;

// How many merge steps `intersectsArrays` takes before it falls back to the scratch bitset: two random sets of a thousand values
// in a chunk share a value within a few dozen steps, so the common overlapping pair never sets a bit.
const MERGE_FIRST = 64;

// Scratch bitset for the array probe: all zero between calls (each call clears what it set).
const probeWords = new Uint32Array(WORDS);

/** Values both arrays hold. */
function andArrays(a: Container, b: Container): Container | null {
  const small = a.len <= b.len ? a : b;
  const big = small === a ? b : a;
  const s = lows16(small);
  const l = lows16(big);
  const out = values16(small.len);
  let n = 0;
  if (small.len >= PROBE_MIN && !skewed(small.len, big.len)) {
    const se = small.off + small.len;
    const first = s[small.off] as number;
    const last = s[se - 1] as number;
    // Only the span of `big` between the shorter array's ends can hold a match.
    const le = big.off + big.len;
    if (last < (l[big.off] as number) || first > (l[le - 1] as number)) return null;
    const from = gallop(l, 0, big.off, le, first);
    const to = gallop(l, 0, from, le, last + 1);
    const words = probeWords;
    for (let i = small.off; i < se; i++) {
      const v = s[i] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
    for (let j = from; j < to; j++) {
      const v = l[j] as number;
      // The slot is written whether or not `v` is in the set; only a hit moves `n` past it.
      out[n] = v;
      n += ((words[v >>> 5] as number) >>> (v & 31)) & 1;
    }
    for (let i = small.off; i < se; i++) words[(s[i] as number) >>> 5] = 0;
    return arrayOfScratch(out, n);
  }
  if (skewed(small.len, big.len)) {
    let at = 0;
    const end = big.off + big.len;
    for (let i = small.off; i < small.off + small.len; i++) {
      const v = s[i] as number;
      at = gallop(l, 0, Math.max(at, big.off), end, v);
      if (at === end) break;
      if (l[at] === v) out[n++] = v;
    }
    return arrayOfScratch(out, n);
  }
  let i = small.off;
  let j = big.off;
  const ie = small.off + small.len;
  const je = big.off + big.len;
  while (i < ie && j < je) {
    const x = s[i] as number;
    const y = l[j] as number;
    // No branch on the comparison: it is unpredictable on random data, and a misprediction costs more than the
    // three adds. The slot is written whether or not the values match; only a match moves `n` past it.
    out[n] = x;
    n += x === y ? 1 : 0;
    i += x <= y ? 1 : 0;
    j += x >= y ? 1 : 0;
  }
  return arrayOfScratch(out, n);
}

/** The values of array `a` whose membership in `b` (a bitset) is `keep`. */
function filterByBits(a: Container, b: Container, keep: boolean): Container | null {
  const u16 = lows16(a);
  const words = words32(b);
  const out = values16(a.len);
  const flip = keep ? 0 : 1;
  let n = 0;
  for (let i = a.off; i < a.off + a.len; i++) {
    const v = u16[i] as number;
    // Written whether or not `v` is kept; only a kept value moves `n` past its slot (no unpredictable branch).
    out[n] = v;
    n += (((words[v >>> 5] as number) >>> (v & 31)) & 1) ^ flip;
  }
  return arrayOfScratch(out, n);
}

/** The values of array `a` whose membership in the runs of `b` is `keep`. */
function filterByRuns(a: Container, b: Container, keep: boolean): Container | null {
  const u16 = lows16(a);
  const pairs = lows16(b);
  const out = values16(a.len);
  let n = 0;
  // Walking the runs costs one step per run and per value, so it wins once values are at least as many as runs; with
  // fewer values the per-value walk skips the runs it does not need to visit.
  if (keep && a.len >= b.len) {
    // At least as many values as runs: walk the runs, skipping the values below each and copying those inside it.
    const ae = a.off + a.len;
    let i = a.off;
    for (let r = 0; r < b.len && i < ae; r++) {
      const start = pairs[b.off + 2 * r] as number;
      const end = start + (pairs[b.off + 2 * r + 1] as number);
      while (i < ae && (u16[i] as number) < start) i++;
      while (i < ae && (u16[i] as number) <= end) out[n++] = u16[i++] as number;
    }
    return arrayOfScratch(out, n);
  }
  let r = 0;
  for (let i = a.off; i < a.off + a.len; i++) {
    const v = u16[i] as number;
    // The first run that ends at or after `v`.
    while (
      r < b.len &&
      (pairs[b.off + 2 * r] as number) + (pairs[b.off + 2 * r + 1] as number) < v
    ) {
      r++;
    }
    const inside = r < b.len && (pairs[b.off + 2 * r] as number) <= v;
    if (inside === keep) out[n++] = v;
  }
  return arrayOfScratch(out, n);
}

/** The values of `a` that `b` lacks, both arrays. */
function andNotArrays(a: Container, b: Container): Container | null {
  const x = lows16(a);
  const y = lows16(b);
  const out = values16(a.len);
  let n = 0;
  const je = b.off + b.len;
  if (skewed(a.len, b.len)) {
    let at = b.off;
    for (let i = a.off; i < a.off + a.len; i++) {
      const v = x[i] as number;
      at = gallop(y, 0, at, je, v);
      if (at === je || y[at] !== v) out[n++] = v;
    }
    return arrayOfScratch(out, n);
  }
  if (b.len >= PROBE_MIN) {
    // Similar sizes: mark the part of `b` inside `a`'s span in the scratch bitset, then keep each value of `a` whose bit
    // is clear. Both arrays are read once, in order, with no unpredictable branch.
    const ae = a.off + a.len;
    const first = x[a.off] as number;
    const last = x[ae - 1] as number;
    const from = gallop(y, 0, b.off, je, first);
    const to = gallop(y, 0, from, je, last + 1);
    const words = probeWords;
    for (let j = from; j < to; j++) {
      const v = y[j] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
    for (let i = a.off; i < ae; i++) {
      const v = x[i] as number;
      // Written whether or not `v` is kept; only a kept value moves `n` past its slot.
      out[n] = v;
      n += (((words[v >>> 5] as number) >>> (v & 31)) & 1) ^ 1;
    }
    for (let j = from; j < to; j++) words[(y[j] as number) >>> 5] = 0;
    return arrayOfScratch(out, n);
  }
  let i = a.off;
  let j = b.off;
  const ie = a.off + a.len;
  while (i < ie && j < je) {
    const p = x[i] as number;
    const q = y[j] as number;
    out[n] = p;
    n += p < q ? 1 : 0;
    i += p <= q ? 1 : 0;
    j += p >= q ? 1 : 0;
  }
  while (i < ie) out[n++] = x[i++] as number;
  return arrayOfScratch(out, n);
}

/** The values either array holds. */
function orArrays(a: Container, b: Container): Container {
  const x = lows16(a);
  const y = lows16(b);
  const ie = a.off + a.len;
  const je = b.off + b.len;
  if (a.len + b.len > ARRAY_MAX_CARDINALITY) {
    const words = new Uint32Array(WORDS);
    for (let i = a.off; i < ie; i++) {
      const v = x[i] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
    for (let j = b.off; j < je; j++) {
      const v = y[j] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
    return fromWordsCard(words, popcountWords(words)) as Container;
  }
  const out = values16(a.len + b.len);
  let n = 0;
  let i = a.off;
  let j = b.off;
  while (i < ie && j < je) {
    const p = x[i] as number;
    const q = y[j] as number;
    out[n++] = p < q ? p : q;
    i += p <= q ? 1 : 0;
    j += p >= q ? 1 : 0;
  }
  while (i < ie) out[n++] = x[i++] as number;
  while (j < je) out[n++] = y[j++] as number;
  return arrayOfScratch(out, n) as Container;
}

/** `dest` (a bitset) or `other`, into words: `dest`'s own words when `inPlace`, else a copy. */
function orIntoBitset(dest: Container, other: Container, inPlace: boolean): Container {
  const words = inPlace ? words32(dest) : words32(dest).slice();
  if (other.kind === ARRAY) {
    const u16 = lows16(other);
    let card = dest.card;
    for (let i = other.off; i < other.off + other.len; i++) {
      const v = u16[i] as number;
      const w = words[v >>> 5] as number;
      const bit = 1 << (v & 31);
      if ((w & bit) === 0) {
        words[v >>> 5] = w | bit;
        card++;
      }
    }
    return bitsetContainer(words, card);
  }
  if (other.kind === BITSET) {
    const o = words32(other);
    for (let i = 0; i < WORDS; i++) words[i] = (words[i] as number) | (o[i] as number);
  } else {
    const pairs = lows16(other);
    for (let r = 0; r < other.len; r++) {
      const start = pairs[other.off + 2 * r] as number;
      setRange(words, start, start + (pairs[other.off + 2 * r + 1] as number));
    }
  }
  return bitsetContainer(words, popcountWords(words));
}

/**
 * A new accumulator holding the OR of the bitset containers of `list` (all zero when there is none), four sources a
 * step: each word is loaded from the accumulator once per four sources, not once per source, and the first group writes
 * the accumulator, so no source is copied. Fewer than four sources, and the tail of any more, go one at a time.
 */
function orBitsetWords(list: readonly Container[]): Uint32Array {
  const bits: Uint32Array[] = [];
  for (const c of list) if (c.kind === BITSET) bits.push(words32(c));
  const n = bits.length;
  if (n === 0) return new Uint32Array(WORDS);
  let k: number;
  let words: Uint32Array;
  if (n >= 4) {
    const a = bits[0] as Uint32Array;
    const b = bits[1] as Uint32Array;
    const c = bits[2] as Uint32Array;
    const d = bits[3] as Uint32Array;
    words = new Uint32Array(WORDS);
    for (let i = 0; i < WORDS; i++)
      words[i] = (a[i] as number) | (b[i] as number) | (c[i] as number) | (d[i] as number);
    k = 4;
  } else {
    words = (bits[0] as Uint32Array).slice();
    k = 1;
  }
  for (; k + 4 <= n; k += 4) {
    const a = bits[k] as Uint32Array;
    const b = bits[k + 1] as Uint32Array;
    const c = bits[k + 2] as Uint32Array;
    const d = bits[k + 3] as Uint32Array;
    for (let i = 0; i < WORDS; i++) {
      words[i] =
        (words[i] as number) |
        (a[i] as number) |
        (b[i] as number) |
        (c[i] as number) |
        (d[i] as number);
    }
  }
  for (; k < n; k++) {
    const o = bits[k] as Uint32Array;
    for (let i = 0; i < WORDS; i++) words[i] = (words[i] as number) | (o[i] as number);
  }
  return words;
}

/**
 * The values of every container of `list` (two or more, all of one key), as a container of its own: an array up to
 * 4,096 values, a bitset above, never a run. No input is written and none is kept. Arrays whose total fits an array are
 * sorted together; anything else is OR-ed into one accumulator of words (a bitset's words, an array's values set
 * bit by bit, a run's range filled) whose bits are counted once at the end, where a pairwise fold would count the
 * whole accumulator after every input.
 */
export function orManyContainers(list: readonly Container[]): Container {
  let total = 0;
  let allArrays = true;
  for (const c of list) {
    total += c.card;
    if (c.kind !== ARRAY) allArrays = false;
  }
  if (allArrays && total <= ARRAY_MAX_CARDINALITY) {
    const out = values16(total);
    let n = 0;
    for (const c of list) {
      out.set(lows16(c).subarray(c.off, c.off + c.len), n);
      n += c.len;
    }
    const sorted = out.subarray(0, n).sort();
    let distinct = 0;
    for (let i = 0; i < n; i++) {
      const v = sorted[i] as number;
      if (i === 0 || v !== (sorted[distinct - 1] as number)) sorted[distinct++] = v;
    }
    return arrayContainer(sorted.slice(0, distinct), distinct);
  }
  const words = orBitsetWords(list);
  for (const c of list) {
    if (c.kind === ARRAY) {
      const u16 = lows16(c);
      for (let i = c.off; i < c.off + c.len; i++) {
        const v = u16[i] as number;
        words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
      }
    } else if (c.kind === RUN) {
      const pairs = lows16(c);
      for (let r = 0; r < c.len; r++) {
        const start = pairs[c.off + 2 * r] as number;
        setRange(words, start, start + (pairs[c.off + 2 * r + 1] as number));
      }
    }
  }
  return fromWordsCard(words, popcountWords(words)) as Container;
}

/** A result built from the first `runs` pairs of `pairs`, whose values number `card`: an array up to 4,096 values, else a bitset. */
function fromRunPairs(pairs: Uint16Array, runs: number, card: number): Container | null {
  if (card === 0) return null;
  if (card <= ARRAY_MAX_CARDINALITY) {
    const out = new Uint16Array(card);
    let k = 0;
    for (let r = 0; r < runs; r++) {
      const start = pairs[2 * r] as number;
      const end = start + (pairs[2 * r + 1] as number);
      for (let v = start; v <= end; v++) out[k++] = v;
    }
    return arrayContainer(out, card);
  }
  const words = new Uint32Array(WORDS);
  for (let r = 0; r < runs; r++) {
    const start = pairs[2 * r] as number;
    setRange(words, start, start + (pairs[2 * r + 1] as number));
  }
  return bitsetContainer(words, card);
}

/** The values both run containers hold. */
function andRuns(a: Container, b: Container): Container | null {
  const x = lows16(a);
  const y = lows16(b);
  const out = pairs16(2 * (a.len + b.len));
  let runs = 0;
  let card = 0;
  let i = 0;
  let j = 0;
  while (i < a.len && j < b.len) {
    const as = x[a.off + 2 * i] as number;
    const ae = as + (x[a.off + 2 * i + 1] as number);
    const bs = y[b.off + 2 * j] as number;
    const be = bs + (y[b.off + 2 * j + 1] as number);
    const lo = as > bs ? as : bs;
    const hi = ae < be ? ae : be;
    if (lo <= hi) {
      out[2 * runs] = lo;
      out[2 * runs + 1] = hi - lo;
      runs++;
      card += hi - lo + 1;
    }
    if (ae < be) i++;
    else j++;
  }
  return card === 0 ? null : runsOrPlain(out, runs, card, true);
}

/** The values either run container holds. */
function orRuns(a: Container, b: Container): Container {
  const x = lows16(a);
  const y = lows16(b);
  const out = pairs16(2 * (a.len + b.len));
  let runs = 0;
  let card = 0;
  let i = 0;
  let j = 0;
  let start = -1;
  let end = -1;
  const flush = (): void => {
    if (start < 0) return;
    out[2 * runs] = start;
    out[2 * runs + 1] = end - start;
    runs++;
    card += end - start + 1;
  };
  while (i < a.len || j < b.len) {
    let s: number;
    let e: number;
    if (j >= b.len || (i < a.len && (x[a.off + 2 * i] as number) <= (y[b.off + 2 * j] as number))) {
      s = x[a.off + 2 * i] as number;
      e = s + (x[a.off + 2 * i + 1] as number);
      i++;
    } else {
      s = y[b.off + 2 * j] as number;
      e = s + (y[b.off + 2 * j + 1] as number);
      j++;
    }
    if (start >= 0 && s <= end + 1) {
      if (e > end) end = e;
    } else {
      flush();
      start = s;
      end = e;
    }
  }
  flush();
  return runsOrPlain(out, runs, card, true);
}

/** The values of `a` that `b` lacks, both run containers. */
function andNotRuns(a: Container, b: Container): Container | null {
  const x = lows16(a);
  const y = lows16(b);
  const out = pairs16(2 * (a.len + b.len + 1));
  let runs = 0;
  let card = 0;
  let j = 0;
  for (let i = 0; i < a.len; i++) {
    let s = x[a.off + 2 * i] as number;
    const e = s + (x[a.off + 2 * i + 1] as number);
    while (j < b.len && (y[b.off + 2 * j] as number) + (y[b.off + 2 * j + 1] as number) < s) j++;
    let k = j;
    while (s <= e) {
      if (k >= b.len || (y[b.off + 2 * k] as number) > e) {
        out[2 * runs] = s;
        out[2 * runs + 1] = e - s;
        runs++;
        card += e - s + 1;
        break;
      }
      const bs = y[b.off + 2 * k] as number;
      const be = bs + (y[b.off + 2 * k + 1] as number);
      if (bs > s) {
        out[2 * runs] = s;
        out[2 * runs + 1] = bs - 1 - s;
        runs++;
        card += bs - s;
      }
      s = be + 1;
      k++;
    }
  }
  return card === 0 ? null : runsOrPlain(out, runs, card, true);
}

/**
 * The values of bitset `a` inside the runs of `b`. Only the words a run covers are read, each masked to the run's ends.
 * A run container of at most 4,096 values cannot produce more than an array holds, so its result is written straight to
 * an array (no 8 KiB bitset, no popcount); a larger one is built as words and counted once, with Harley-Seal, which
 * beats counting each covered word when the runs cover many of them.
 */
function bitsetInRuns(a: Container, b: Container): Container | null {
  const words = words32(a);
  const pairs = lows16(b);
  if (b.card <= ARRAY_MAX_CARDINALITY) {
    const out = values16(b.card);
    let n = 0;
    for (let r = 0; r < b.len; r++) {
      const start = pairs[b.off + 2 * r] as number;
      const end = start + (pairs[b.off + 2 * r + 1] as number);
      const first = start >>> 5;
      const last = end >>> 5;
      const head = (0xffff_ffff << (start & 31)) >>> 0;
      const tail = 0xffff_ffff >>> (31 - (end & 31));
      for (let i = first; i <= last; i++) {
        let w = words[i] as number;
        if (i === first) w &= head;
        if (i === last) w &= tail;
        const top = i * 32 + 31;
        while (w !== 0) {
          const lowest = w & -w;
          out[n++] = top - Math.clz32(lowest);
          w ^= lowest;
        }
      }
    }
    return arrayOfScratch(out, n);
  }
  const out = new Uint32Array(WORDS);
  for (let r = 0; r < b.len; r++) {
    const start = pairs[b.off + 2 * r] as number;
    const end = start + (pairs[b.off + 2 * r + 1] as number);
    const first = start >>> 5;
    const last = end >>> 5;
    const head = (0xffff_ffff << (start & 31)) >>> 0;
    const tail = 0xffff_ffff >>> (31 - (end & 31));
    if (first === last) {
      out[first] = (out[first] as number) | ((words[first] as number) & head & tail);
    } else {
      out[first] = (out[first] as number) | ((words[first] as number) & head);
      for (let i = first + 1; i < last; i++) out[i] = words[i] as number;
      out[last] = (out[last] as number) | ((words[last] as number) & tail);
    }
  }
  return fromWordsCard(out, popcountWords(out));
}

/** The values both hold, or `null` when there are none. Neither operand is changed unless `inPlace` and `a` is a bitset (see the module comment). */
export function containerAnd(a: Container, b: Container, inPlace = false): Container | null {
  if (a.kind === BITSET && b.kind === BITSET) {
    const x = words32(a);
    const y = words32(b);
    const out = inPlace ? x : new Uint32Array(WORDS);
    for (let i = 0; i < WORDS; i++) out[i] = (x[i] as number) & (y[i] as number);
    return fromWordsCard(out, popcountWords(out));
  }
  // Commutative: put the lower kind first (array, bitset, run).
  if (a.kind > b.kind) return containerAnd(b, a);
  if (a.kind === ARRAY) {
    if (b.kind === ARRAY) return andArrays(a, b);
    return b.kind === BITSET ? filterByBits(a, b, true) : filterByRuns(a, b, true);
  }
  return b.kind === RUN && a.kind === RUN ? andRuns(a, b) : bitsetInRuns(a, b);
}

/** The values either holds. */
export function containerOr(a: Container, b: Container, inPlace = false): Container {
  if (a.kind === BITSET) return orIntoBitset(a, b, inPlace);
  if (b.kind === BITSET) return orIntoBitset(b, a, false);
  if (a.kind === ARRAY && b.kind === ARRAY) return orArrays(a, b);
  if (a.kind === RUN && b.kind === RUN) return orRuns(a, b);
  return a.kind === RUN ? orRunArray(a, b, inPlace) : orRunArray(b, a, false);
}

/**
 * How many steps of the merge walk (the runs plus the values) a run container and an array take before expanding the run
 * container to words is the cheaper way to write the array into it: the walk costs a few nanoseconds a step, the
 * expansion a fixed 8 KB of words (zeroed, one range set per run, one pass to count the runs of the result).
 */
export const EXPAND_MIN_STEPS = 1024;

/**
 * Whether {@link orRunArray} writes the array into the run container through words instead of the merge walk: from
 * {@link EXPAND_MIN_STEPS} steps up, and when the result is unlikely to be a run container. The result has at most
 * `runs.len + array.len` runs, so when that many runs already fail the size rule against the plain body of the largest
 * result, the walk would build a run list only to expand it again. A pure function of the two containers' lengths and
 * cardinalities, so it costs one comparison on the hot path; either choice returns the same container.
 */
export function expandsRunArray(runs: Container, array: Container): boolean {
  const steps = runs.len + array.len;
  if (steps < EXPAND_MIN_STEPS) return false;
  const cardMax = runs.card + array.len;
  const plainMax = cardMax <= ARRAY_MAX_CARDINALITY ? 2 * cardMax : BITSET_BYTES;
  return 2 + 4 * steps >= plainMax;
}

/**
 * A run container with an array's values written through words: the runs are set in a new bitset, then each value, and
 * the container of the result is the canonical one for its values (a run container only when its body is the smaller
 * one: {@link optimize}). When the array adds nothing and `keep` allows, the run container itself is the result.
 */
export function orRunArrayExpand(runs: Container, array: Container, keep: boolean): Container {
  const words = toWords(runs);
  const v = lows16(array);
  let added = 0;
  for (let i = array.off; i < array.off + array.len; i++) {
    const value = v[i] as number;
    const word = words[value >>> 5] as number;
    const bit = 1 << (value & 31);
    if ((word & bit) === 0) {
      words[value >>> 5] = word | bit;
      added++;
    }
  }
  if (added === 0 && keep) return runs;
  return optimize(fromWordsCard(words, runs.card + added) as Container);
}

/** A run container with an array's values: by the merge walk, or through words when that is cheaper (see {@link expandsRunArray}). */
function orRunArray(runs: Container, array: Container, keep: boolean): Container {
  return expandsRunArray(runs, array)
    ? orRunArrayExpand(runs, array, keep)
    : orRunArrayWalk(runs, array, keep);
}

/**
 * A run container with an array's values, merged in one walk over both lists: each step takes whichever of the next run
 * and the next value starts first and appends it to the result, joining it to the pair being built when they touch or
 * overlap. Cost is the runs plus the values, with no search or view per value, and no expansion to 8 KB of words. The
 * result is a run container while that is the smaller form (see {@link runsOrPlain}). When the array adds nothing and
 * `keep` allows, the run container itself is the result: runs are never written in place, so aliasing it is safe.
 */
export function orRunArrayWalk(runs: Container, array: Container, keep: boolean): Container {
  const x = lows16(runs);
  const v = lows16(array);
  const out = pairs16(2 * (runs.len + array.len));
  const runEnd = runs.off + 2 * runs.len;
  const valueEnd = array.off + array.len;
  let r = runs.off;
  let vi = array.off;
  let at = 0;
  // The pair being built, `[from, to]`; `to` is -2 before there is one, so nothing is next to it.
  let from = 0;
  let to = -2;
  let added = 0;
  while (vi < valueEnd) {
    const value = v[vi++] as number;
    // Every run that starts at or before the value comes first; one that reaches it holds it.
    while (r < runEnd && (x[r] as number) <= value) {
      const start = x[r] as number;
      const end = start + (x[r + 1] as number);
      r += 2;
      if (start <= to + 1) {
        if (end > to) to = end;
      } else {
        if (to >= 0) {
          out[at++] = from;
          out[at++] = to - from;
        }
        from = start;
        to = end;
      }
    }
    if (value <= to) continue;
    added++;
    if (value === to + 1) {
      to = value;
    } else {
      if (to >= 0) {
        out[at++] = from;
        out[at++] = to - from;
      }
      from = value;
      to = value;
    }
  }
  while (r < runEnd) {
    const start = x[r] as number;
    const end = start + (x[r + 1] as number);
    r += 2;
    if (start <= to + 1) {
      if (end > to) to = end;
    } else {
      if (to >= 0) {
        out[at++] = from;
        out[at++] = to - from;
      }
      from = start;
      to = end;
    }
  }
  out[at++] = from;
  out[at++] = to - from;
  if (added === 0 && keep) return runs;
  return runsOrPlain(out, at >>> 1, runs.card + added, true);
}

/** The values of `a` that `b` lacks, or `null` when there are none. */
export function containerAndNot(a: Container, b: Container, inPlace = false): Container | null {
  if (a.kind === ARRAY) {
    if (b.kind === ARRAY) return andNotArrays(a, b);
    return b.kind === BITSET ? filterByBits(a, b, false) : filterByRuns(a, b, false);
  }
  if (a.kind === RUN && b.kind === RUN) return andNotRuns(a, b);
  // A bitset, or a run container expanded to words (which it owns).
  const words = a.kind === BITSET ? (inPlace ? words32(a) : words32(a).slice()) : toWords(a);
  if (b.kind === ARRAY) {
    const u16 = lows16(b);
    for (let i = b.off; i < b.off + b.len; i++) {
      const v = u16[i] as number;
      words[v >>> 5] = (words[v >>> 5] as number) & ~(1 << (v & 31));
    }
  } else if (b.kind === BITSET) {
    const y = words32(b);
    for (let i = 0; i < WORDS; i++) words[i] = (words[i] as number) & ~(y[i] as number);
  } else {
    const pairs = lows16(b);
    for (let r = 0; r < b.len; r++) {
      const start = pairs[b.off + 2 * r] as number;
      clearRange(words, start, start + (pairs[b.off + 2 * r + 1] as number));
    }
  }
  return fromWordsCard(words, popcountWords(words));
}

/** The values exactly one array holds: one merge that drops a value both hold. */
function xorArrays(a: Container, b: Container): Container | null {
  const x = lows16(a);
  const y = lows16(b);
  const ie = a.off + a.len;
  const je = b.off + b.len;
  const out = values16(a.len + b.len);
  let n = 0;
  let i = a.off;
  let j = b.off;
  while (i < ie && j < je) {
    const p = x[i] as number;
    const q = y[j] as number;
    out[n] = p < q ? p : q;
    // A value both hold is written over by the next one.
    n += p === q ? 0 : 1;
    i += p <= q ? 1 : 0;
    j += p >= q ? 1 : 0;
  }
  while (i < ie) out[n++] = x[i++] as number;
  while (j < je) out[n++] = y[j++] as number;
  if (n <= ARRAY_MAX_CARDINALITY) return arrayOfScratch(out, n);
  const words = new Uint32Array(WORDS);
  for (let k = 0; k < n; k++) {
    const v = out[k] as number;
    words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
  }
  return bitsetContainer(words, n);
}

/**
 * The values exactly one run container holds, as one walk over the run boundaries of both. A run `(start, length - 1)`
 * opens at `start` and closes at `start + length`; the boundaries of one list ascend strictly (its runs neither touch
 * nor overlap), and a boundary both lists have cancels, so what is left alternates open, close and any two pieces that
 * touch have already joined.
 */
function xorRuns(a: Container, b: Container): Container | null {
  const x = lows16(a);
  const y = lows16(b);
  const na = 2 * a.len;
  const nb = 2 * b.len;
  const out = pairs16(2 * (a.len + b.len));
  const NONE = 0x7fff_ffff;
  let i = 0;
  let j = 0;
  let pa = na > 0 ? boundary(x, a.off, 0) : NONE;
  let pb = nb > 0 ? boundary(y, b.off, 0) : NONE;
  let open = -1;
  let runs = 0;
  let card = 0;
  while (i < na || j < nb) {
    let p: number;
    if (pa === pb) {
      // The boundary is in both lists: it cancels.
      i++;
      j++;
      pa = i < na ? boundary(x, a.off, i) : NONE;
      pb = j < nb ? boundary(y, b.off, j) : NONE;
      continue;
    }
    if (pa < pb) {
      p = pa;
      i++;
      pa = i < na ? boundary(x, a.off, i) : NONE;
    } else {
      p = pb;
      j++;
      pb = j < nb ? boundary(y, b.off, j) : NONE;
    }
    if (open < 0) {
      open = p;
    } else {
      out[2 * runs] = open;
      out[2 * runs + 1] = p - 1 - open;
      runs++;
      card += p - open;
      open = -1;
    }
  }
  return card === 0 ? null : runsOrPlain(out, runs, card, true);
}

/** Boundary `k` of a run list at `off`: pair `k >> 1`'s start when `k` is even and one past its last value when odd. */
function boundary(u16: Uint16Array, off: number, k: number): number {
  const at = off + (k & ~1);
  return (u16[at] as number) + ((k & 1) === 0 ? 0 : (u16[at + 1] as number) + 1);
}

/**
 * The values exactly one of the two holds, or `null` when there are none, built in one pass over the pair by their
 * kinds: one word loop and one count for two bitsets, one merge for two arrays, one walk for two run containers, and
 * for any pair with a bitset the bitset's words (a copy, or its own when `inPlace` and `a` is the bitset) with the
 * other side's values flipped in. Array against run goes through words. Neither operand is changed unless `inPlace`
 * and `a` is a bitset (see the module comment).
 */
export function containerXor(a: Container, b: Container, inPlace = false): Container | null {
  if (a.kind === BITSET || b.kind === BITSET) {
    const base = a.kind === BITSET ? a : b;
    const other = base === a ? b : a;
    if (other.kind === BITSET) {
      const x = words32(a);
      const y = words32(b);
      const out = inPlace ? x : new Uint32Array(WORDS);
      for (let i = 0; i < WORDS; i++) out[i] = (x[i] as number) ^ (y[i] as number);
      return fromWordsCard(out, popcountWords(out));
    }
    const words = inPlace && base === a ? words32(base) : words32(base).slice();
    if (other.kind === ARRAY) {
      return fromWordsCard(words, flipValues(words, other, base.card));
    }
    const pairs = lows16(other);
    for (let r = 0; r < other.len; r++) {
      const start = pairs[other.off + 2 * r] as number;
      flipRange(words, start, start + (pairs[other.off + 2 * r + 1] as number));
    }
    return fromWordsCard(words, popcountWords(words));
  }
  if (a.kind === ARRAY && b.kind === ARRAY) return xorArrays(a, b);
  if (a.kind === RUN && b.kind === RUN) return xorRuns(a, b);
  const runs = a.kind === RUN ? a : b;
  const array = runs === a ? b : a;
  const words = toWords(runs);
  return fromWordsCard(words, flipValues(words, array, runs.card));
}

/** Flip the bits of `array`'s values in `words`, which hold `card` set bits; returns the count after. */
function flipValues(words: Uint32Array, array: Container, card: number): number {
  const u16 = lows16(array);
  let n = card;
  for (let i = array.off; i < array.off + array.len; i++) {
    const v = u16[i] as number;
    const w = words[v >>> 5] as number;
    words[v >>> 5] = w ^ (1 << (v & 31));
    n += 1 - 2 * ((w >>> (v & 31)) & 1);
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Counting a combine without building it
// ---------------------------------------------------------------------------------------------------------------

/** Set bits of `words` from bit `start` to bit `end`, both inclusive. */
function bitsInRange(words: Uint32Array, start: number, end: number): number {
  const first = start >>> 5;
  const last = end >>> 5;
  const head = (0xffff_ffff << (start & 31)) >>> 0;
  const tail = 0xffff_ffff >>> (31 - (end & 31));
  if (first === last) return popcount32((words[first] as number) & head & tail);
  let n = popcount32((words[first] as number) & head) + popcount32((words[last] as number) & tail);
  for (let i = first + 1; i < last; i++) n += popcount32(words[i] as number);
  return n;
}

/** Values both arrays hold: a merge that writes nothing, or a gallop of the shorter over the longer when one is much longer. */
function andCountArrays(a: Container, b: Container): number {
  const small = a.len <= b.len ? a : b;
  const big = small === a ? b : a;
  const s = lows16(small);
  const l = lows16(big);
  const se = small.off + small.len;
  const le = big.off + big.len;
  let n = 0;
  if (skewed(small.len, big.len)) {
    let at = big.off;
    for (let i = small.off; i < se; i++) {
      const v = s[i] as number;
      at = gallop(l, 0, at, le, v);
      if (at === le) break;
      if (l[at] === v) n++;
    }
    return n;
  }
  if (small.len >= PROBE_MIN) {
    // As the building intersection does: the shorter array as bits, the longer one tested against them in order, only
    // the span of the longer between the shorter's ends. Nothing is written but the scratch bits, cleared again.
    const first = s[small.off] as number;
    const last = s[se - 1] as number;
    if (last < (l[big.off] as number) || first > (l[le - 1] as number)) return 0;
    const from = gallop(l, 0, big.off, le, first);
    const to = gallop(l, 0, from, le, last + 1);
    const words = probeWords;
    for (let i = small.off; i < se; i++) {
      const v = s[i] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
    for (let j = from; j < to; j++) {
      const v = l[j] as number;
      n += ((words[v >>> 5] as number) >>> (v & 31)) & 1;
    }
    for (let i = small.off; i < se; i++) words[(s[i] as number) >>> 5] = 0;
    return n;
  }
  let i = small.off;
  let j = big.off;
  while (i < se && j < le) {
    const x = s[i] as number;
    const y = l[j] as number;
    // No branch on the comparison, as in the building merge.
    n += x === y ? 1 : 0;
    i += x <= y ? 1 : 0;
    j += x >= y ? 1 : 0;
  }
  return n;
}

/** Values of array `a` that bitset `b` holds. */
function andCountArrayBitset(a: Container, b: Container): number {
  const u16 = lows16(a);
  const words = words32(b);
  let n = 0;
  for (let i = a.off; i < a.off + a.len; i++) {
    const v = u16[i] as number;
    n += ((words[v >>> 5] as number) >>> (v & 31)) & 1;
  }
  return n;
}

/** Values of array `a` that the runs of `b` cover: a walk of both, or a search of the runs per value when the runs are far more. */
function andCountArrayRuns(a: Container, b: Container): number {
  const u16 = lows16(a);
  const pairs = lows16(b);
  const ae = a.off + a.len;
  let n = 0;
  if (skewed(a.len, b.len)) {
    for (let i = a.off; i < ae; i++) {
      const v = u16[i] as number;
      // The last run starting at or before `v`.
      const after = lowerBound(pairs, b.off, b.len, v + 1, 2);
      if (after === 0) continue;
      const r = b.off + 2 * (after - 1);
      if (v <= (pairs[r] as number) + (pairs[r + 1] as number)) n++;
    }
    return n;
  }
  let i = a.off;
  for (let r = 0; r < b.len && i < ae; r++) {
    const start = pairs[b.off + 2 * r] as number;
    const end = start + (pairs[b.off + 2 * r + 1] as number);
    while (i < ae && (u16[i] as number) < start) i++;
    while (i < ae && (u16[i] as number) <= end) {
      n++;
      i++;
    }
  }
  return n;
}

/** Values bitset `a` holds inside the runs of `b`. */
function andCountBitsetRuns(a: Container, b: Container): number {
  const words = words32(a);
  const pairs = lows16(b);
  let n = 0;
  for (let r = 0; r < b.len; r++) {
    const start = pairs[b.off + 2 * r] as number;
    n += bitsInRange(words, start, start + (pairs[b.off + 2 * r + 1] as number));
  }
  return n;
}

/** Values both run containers hold: the summed overlap of the runs. */
function andCountRuns(a: Container, b: Container): number {
  const x = lows16(a);
  const y = lows16(b);
  let n = 0;
  let i = 0;
  let j = 0;
  while (i < a.len && j < b.len) {
    const as = x[a.off + 2 * i] as number;
    const ae = as + (x[a.off + 2 * i + 1] as number);
    const bs = y[b.off + 2 * j] as number;
    const be = bs + (y[b.off + 2 * j + 1] as number);
    const lo = as > bs ? as : bs;
    const hi = ae < be ? ae : be;
    if (lo <= hi) n += hi - lo + 1;
    if (ae < be) i++;
    else j++;
  }
  return n;
}

/** How many values both containers hold; builds nothing and changes neither operand. */
export function containerAndCard(a: Container, b: Container): number {
  if (a.kind === BITSET && b.kind === BITSET) {
    return popcountAnd(words32(a), words32(b));
  }
  // Commutative: put the lower kind first (array, bitset, run).
  if (a.kind > b.kind) return containerAndCard(b, a);
  if (a.kind === ARRAY) {
    if (b.kind === ARRAY) return andCountArrays(a, b);
    return b.kind === BITSET ? andCountArrayBitset(a, b) : andCountArrayRuns(a, b);
  }
  return b.kind === RUN && a.kind === RUN ? andCountRuns(a, b) : andCountBitsetRuns(a, b);
}

/** Whether any bit from `start` to `end`, both inclusive, is set in `words`; stops at the first word that has one. */
function anyBitInRange(words: Uint32Array, start: number, end: number): boolean {
  const first = start >>> 5;
  const last = end >>> 5;
  const head = (0xffff_ffff << (start & 31)) >>> 0;
  const tail = 0xffff_ffff >>> (31 - (end & 31));
  if (first === last) return ((words[first] as number) & head & tail) !== 0;
  if (((words[first] as number) & head) !== 0 || ((words[last] as number) & tail) !== 0)
    return true;
  for (let i = first + 1; i < last; i++) if (words[i] !== 0) return true;
  return false;
}

/** Whether every bit from `start` to `end`, both inclusive, is set in `words`; stops at the first word that lacks one. */
function allBitsInRange(words: Uint32Array, start: number, end: number): boolean {
  const first = start >>> 5;
  const last = end >>> 5;
  const head = (0xffff_ffff << (start & 31)) >>> 0;
  const tail = 0xffff_ffff >>> (31 - (end & 31));
  if (first === last) return (~(words[first] as number) & head & tail) === 0;
  if ((~(words[first] as number) & head) !== 0 || (~(words[last] as number) & tail) !== 0)
    return false;
  for (let i = first + 1; i < last; i++) if (words[i] !== 0xffff_ffff) return false;
  return true;
}

/** Whether every value of array `a` is in array `b`: a merge or a gallop that stops at the first value `b` lacks. */
function subsetArrays(a: Container, b: Container): boolean {
  const x = lows16(a);
  const y = lows16(b);
  const ie = a.off + a.len;
  const je = b.off + b.len;
  let j = b.off;
  if (skewed(a.len, b.len)) {
    for (let i = a.off; i < ie; i++) {
      const v = x[i] as number;
      j = gallop(y, 0, j, je, v);
      if (j === je || y[j] !== v) return false;
    }
    return true;
  }
  let i = a.off;
  while (i < ie && j < je) {
    const p = x[i] as number;
    const q = y[j] as number;
    if (p < q) return false;
    i += p === q ? 1 : 0;
    j++;
  }
  return i === ie;
}

/** Whether every value of array `a` is covered by a run of `b`: one walk of the runs, stopping at the first value outside them. */
function subsetArrayRuns(a: Container, b: Container): boolean {
  const u16 = lows16(a);
  const pairs = lows16(b);
  let r = 0;
  for (let i = a.off; i < a.off + a.len; i++) {
    const v = u16[i] as number;
    while (r < b.len && (pairs[b.off + 2 * r] as number) + (pairs[b.off + 2 * r + 1] as number) < v)
      r++;
    if (r === b.len || (pairs[b.off + 2 * r] as number) > v) return false;
  }
  return true;
}

/** Whether every value of the runs of `a` is in the array `b`: each run is `length` consecutive entries of `b`, since both ascend without repeats. */
function subsetRunsArray(a: Container, b: Container): boolean {
  const pairs = lows16(a);
  const y = lows16(b);
  const je = b.off + b.len;
  let j = b.off;
  for (let r = 0; r < a.len; r++) {
    const start = pairs[a.off + 2 * r] as number;
    const last = start + (pairs[a.off + 2 * r + 1] as number);
    j = gallop(y, 0, j, je, start);
    const end = j + (last - start);
    if (end >= je || y[j] !== start || y[end] !== last) return false;
    j = end + 1;
  }
  return true;
}

/** Whether every value of the run containers `a` lies inside a run of `b` (whose runs are maximal, so inside one run). */
function subsetRuns(a: Container, b: Container): boolean {
  const x = lows16(a);
  const y = lows16(b);
  let j = 0;
  for (let i = 0; i < a.len; i++) {
    const start = x[a.off + 2 * i] as number;
    const last = start + (x[a.off + 2 * i + 1] as number);
    while (j < b.len && (y[b.off + 2 * j] as number) + (y[b.off + 2 * j + 1] as number) < start)
      j++;
    if (j === b.len || (y[b.off + 2 * j] as number) > start) return false;
    if ((y[b.off + 2 * j] as number) + (y[b.off + 2 * j + 1] as number) < last) return false;
  }
  return true;
}

/** Whether every set bit of the bitset `a` lies in a run of `b`: no set bit before the first run, between two, or after the last. */
function subsetBitsetRuns(a: Container, b: Container): boolean {
  const words = words32(a);
  const pairs = lows16(b);
  let from = 0;
  for (let r = 0; r < b.len; r++) {
    const start = pairs[b.off + 2 * r] as number;
    if (start > from && anyBitInRange(words, from, start - 1)) return false;
    from = start + (pairs[b.off + 2 * r + 1] as number) + 1;
  }
  return from > 65_535 || !anyBitInRange(words, from, 65_535);
}

/**
 * Whether every value of `a` is in `b`, by the kinds of the pair, stopping at the first value that is not and counting
 * nothing: no scratch and no popcount, where `containerAndCard(a, b) === a.card` reads both operands whole. A bitset in
 * an array is the one pair that falls back to that count (it only arises for a bitset of 4,096 values or fewer, which
 * the codec's own results never are).
 */
export function containersSubset(a: Container, b: Container): boolean {
  if (a.card > b.card) return false;
  if (a.kind === ARRAY) {
    if (b.kind === ARRAY) return subsetArrays(a, b);
    if (b.kind === RUN) return subsetArrayRuns(a, b);
    const u16 = lows16(a);
    const words = words32(b);
    for (let i = a.off; i < a.off + a.len; i++) {
      const v = u16[i] as number;
      if ((((words[v >>> 5] as number) >>> (v & 31)) & 1) === 0) return false;
    }
    return true;
  }
  if (a.kind === BITSET) {
    if (b.kind === BITSET) {
      const x = words32(a);
      const y = words32(b);
      for (let i = 0; i < WORDS; i += 8) {
        const lack =
          ((x[i] as number) & ~(y[i] as number)) |
          ((x[i + 1] as number) & ~(y[i + 1] as number)) |
          ((x[i + 2] as number) & ~(y[i + 2] as number)) |
          ((x[i + 3] as number) & ~(y[i + 3] as number)) |
          ((x[i + 4] as number) & ~(y[i + 4] as number)) |
          ((x[i + 5] as number) & ~(y[i + 5] as number)) |
          ((x[i + 6] as number) & ~(y[i + 6] as number)) |
          ((x[i + 7] as number) & ~(y[i + 7] as number));
        if (lack !== 0) return false;
      }
      return true;
    }
    if (b.kind === RUN) return subsetBitsetRuns(a, b);
    return containerAndCard(a, b) === a.card;
  }
  if (b.kind === ARRAY) return subsetRunsArray(a, b);
  if (b.kind === RUN) return subsetRuns(a, b);
  const words = words32(b);
  const pairs = lows16(a);
  for (let r = 0; r < a.len; r++) {
    const start = pairs[a.off + 2 * r] as number;
    if (!allBitsInRange(words, start, start + (pairs[a.off + 2 * r + 1] as number))) return false;
  }
  return true;
}

/**
 * Whether two containers hold the same values. Two containers of one kind compare their storage and stop at the first
 * difference: bitset words, array values, run pairs. That is exact for runs because every run container is canonical:
 * the decoder refuses runs that touch or overlap, and every writer of a run container ({@link optimize}, a write into
 * a run, the union of a run with an array, the run results of `and`, `or`, `andNot` and `xor`) leaves the runs
 * maximal and the container in its smallest kind, so one set has one list of pairs. Containers of different kinds can hold the same set (a run against an array), so they fall back to the
 * count of the values they share.
 */
export function containersEqual(a: Container, b: Container): boolean {
  if (a.card !== b.card) return false;
  if (a.kind !== b.kind) return containerAndCard(a, b) === a.card;
  if (a.kind === BITSET) return equalWords(words32(a), 0, words32(b), 0, WORDS);
  if (a.len !== b.len) return false;
  const x = lows16(a);
  const y = lows16(b);
  const n = a.kind === ARRAY ? a.len : 2 * a.len;
  if (n >= EQUAL_VIEW_MIN) {
    // Two values a step through a 32-bit view over the same bytes, when both starts fall on a 4-byte boundary.
    const xb = x.byteOffset + 2 * a.off;
    const yb = y.byteOffset + 2 * b.off;
    if ((xb & 3) === 0 && (yb & 3) === 0) {
      const m = n >>> 1;
      if (!equalWords(new Uint32Array(x.buffer, xb, m), 0, new Uint32Array(y.buffer, yb, m), 0, m))
        return false;
      return (n & 1) === 0 || x[a.off + n - 1] === y[b.off + n - 1];
    }
  }
  return equalU16(x, a.off, y, b.off, n);
}

/** The fewest 16-bit values (an array's values, twice a run container's pairs) from which a compare goes through a 32-bit view: a view costs about as much as a few hundred compares. */
export const EQUAL_VIEW_MIN = 512;

/** Whether `n` words of `x` from `xo` equal those of `y` from `yo`: eight a step, the differences OR-ed and tested once per group. */
function equalWords(x: Uint32Array, xo: number, y: Uint32Array, yo: number, n: number): boolean {
  let i = 0;
  for (const end = n - 7; i < end; i += 8) {
    const d =
      ((x[xo + i] as number) ^ (y[yo + i] as number)) |
      ((x[xo + i + 1] as number) ^ (y[yo + i + 1] as number)) |
      ((x[xo + i + 2] as number) ^ (y[yo + i + 2] as number)) |
      ((x[xo + i + 3] as number) ^ (y[yo + i + 3] as number)) |
      ((x[xo + i + 4] as number) ^ (y[yo + i + 4] as number)) |
      ((x[xo + i + 5] as number) ^ (y[yo + i + 5] as number)) |
      ((x[xo + i + 6] as number) ^ (y[yo + i + 6] as number)) |
      ((x[xo + i + 7] as number) ^ (y[yo + i + 7] as number));
    if (d !== 0) return false;
  }
  for (; i < n; i++) if (x[xo + i] !== y[yo + i]) return false;
  return true;
}

/** {@link equalWords} over 16-bit values. */
function equalU16(x: Uint16Array, xo: number, y: Uint16Array, yo: number, n: number): boolean {
  let i = 0;
  for (const end = n - 7; i < end; i += 8) {
    const d =
      ((x[xo + i] as number) ^ (y[yo + i] as number)) |
      ((x[xo + i + 1] as number) ^ (y[yo + i + 1] as number)) |
      ((x[xo + i + 2] as number) ^ (y[yo + i + 2] as number)) |
      ((x[xo + i + 3] as number) ^ (y[yo + i + 3] as number)) |
      ((x[xo + i + 4] as number) ^ (y[yo + i + 4] as number)) |
      ((x[xo + i + 5] as number) ^ (y[yo + i + 5] as number)) |
      ((x[xo + i + 6] as number) ^ (y[yo + i + 6] as number)) |
      ((x[xo + i + 7] as number) ^ (y[yo + i + 7] as number));
    if (d !== 0) return false;
  }
  for (; i < n; i++) if (x[xo + i] !== y[yo + i]) return false;
  return true;
}

/** Whether two arrays share a value; stops at the first. */
function intersectsArrays(a: Container, b: Container): boolean {
  const small = a.len <= b.len ? a : b;
  const big = small === a ? b : a;
  const s = lows16(small);
  const l = lows16(big);
  const se = small.off + small.len;
  const le = big.off + big.len;
  // Disjoint ranges answer at once.
  if (
    (s[se - 1] as number) < (l[big.off] as number) ||
    (s[small.off] as number) > (l[le - 1] as number)
  ) {
    return false;
  }
  if (skewed(small.len, big.len)) {
    let at = big.off;
    for (let i = small.off; i < se; i++) {
      const v = s[i] as number;
      at = gallop(l, 0, at, le, v);
      if (at === le) return false;
      if (l[at] === v) return true;
    }
    return false;
  }
  let i = small.off;
  let j = big.off;
  if (small.len >= PROBE_MIN) {
    // Two sets of this size usually share a value early, and a merge finds it without setting any bits: take a bounded
    // number of merge steps first and set up the scratch bits only for a pair that shares nothing that soon.
    for (let step = 0; step < MERGE_FIRST && i < se && j < le; step++) {
      const x = s[i] as number;
      const y = l[j] as number;
      if (x === y) return true;
      if (x < y) i++;
      else j++;
    }
    if (i === se || j === le) return false;
    // As the counting kernel does: the shorter array as bits and the span of the longer between its ends tested against
    // them, but stopping at the first hit. The scratch bits are cleared on both exits.
    const left = i;
    const from = gallop(l, 0, j, le, s[left] as number);
    const to = gallop(l, 0, from, le, (s[se - 1] as number) + 1);
    const words = probeWords;
    for (let k = left; k < se; k++) {
      const v = s[k] as number;
      words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    }
    let hit = false;
    for (let k = from; k < to; k++) {
      const v = l[k] as number;
      if ((((words[v >>> 5] as number) >>> (v & 31)) & 1) === 1) {
        hit = true;
        break;
      }
    }
    for (let k = left; k < se; k++) words[(s[k] as number) >>> 5] = 0;
    return hit;
  }
  while (i < se && j < le) {
    const x = s[i] as number;
    const y = l[j] as number;
    if (x === y) return true;
    if (x < y) i++;
    else j++;
  }
  return false;
}

/** Whether the array `a` has a value the runs of `b` cover; stops at the first. */
function intersectsArrayRuns(a: Container, b: Container): boolean {
  const u16 = lows16(a);
  const pairs = lows16(b);
  let r = 0;
  for (let i = a.off; i < a.off + a.len; i++) {
    const v = u16[i] as number;
    // The first run that ends at or after `v`.
    while (
      r < b.len &&
      (pairs[b.off + 2 * r] as number) + (pairs[b.off + 2 * r + 1] as number) < v
    ) {
      r++;
    }
    if (r === b.len) return false;
    if ((pairs[b.off + 2 * r] as number) <= v) return true;
  }
  return false;
}

/** Whether the two containers share a value; stops at the first one it finds. */
export function containersIntersect(a: Container, b: Container): boolean {
  if (a.kind > b.kind) return containersIntersect(b, a);
  if (a.kind === ARRAY) {
    if (b.kind === ARRAY) return intersectsArrays(a, b);
    if (b.kind === RUN) return intersectsArrayRuns(a, b);
    const u16 = lows16(a);
    const words = words32(b);
    for (let i = a.off; i < a.off + a.len; i++) {
      const v = u16[i] as number;
      if ((((words[v >>> 5] as number) >>> (v & 31)) & 1) === 1) return true;
    }
    return false;
  }
  if (a.kind === BITSET) {
    const x = words32(a);
    if (b.kind === BITSET) {
      const y = words32(b);
      for (let i = 0; i < WORDS; i += 8) {
        const both =
          ((x[i] as number) & (y[i] as number)) |
          ((x[i + 1] as number) & (y[i + 1] as number)) |
          ((x[i + 2] as number) & (y[i + 2] as number)) |
          ((x[i + 3] as number) & (y[i + 3] as number)) |
          ((x[i + 4] as number) & (y[i + 4] as number)) |
          ((x[i + 5] as number) & (y[i + 5] as number)) |
          ((x[i + 6] as number) & (y[i + 6] as number)) |
          ((x[i + 7] as number) & (y[i + 7] as number));
        if (both !== 0) return true;
      }
      return false;
    }
    const pairs = lows16(b);
    for (let r = 0; r < b.len; r++) {
      const start = pairs[b.off + 2 * r] as number;
      if (anyBitInRange(x, start, start + (pairs[b.off + 2 * r + 1] as number))) return true;
    }
    return false;
  }
  // Two run containers share a value when any two runs overlap.
  const x = lows16(a);
  const y = lows16(b);
  let i = 0;
  let j = 0;
  while (i < a.len && j < b.len) {
    const as = x[a.off + 2 * i] as number;
    const ae = as + (x[a.off + 2 * i + 1] as number);
    const bs = y[b.off + 2 * j] as number;
    const be = bs + (y[b.off + 2 * j + 1] as number);
    if ((as > bs ? as : bs) <= (ae < be ? ae : be)) return true;
    if (ae < be) i++;
    else j++;
  }
  return false;
}
