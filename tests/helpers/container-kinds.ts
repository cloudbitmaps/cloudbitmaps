import fc from 'fast-check';
import {
  ARRAY,
  BITSET,
  Container,
  RUN,
  WORDS,
  appendIds,
  bitsetContainer,
} from '@/ts-roaring/containers';

/** Builders and generators for container-level tests: a container of each kind from a list of values. */
export const KINDS = [ARRAY, BITSET, RUN] as const;
export const KIND_NAME = ['array', 'bitset', 'run'];
export const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a }, (_, i) => a + i);
export const sortedUnique = (values: number[]): number[] =>
  [...new Set(values)].sort((x, y) => x - y);

/**
 * A container of the ascending, distinct `lows` in the given kind (whatever their count, so a "bitset" of three values
 * is allowed), its array or run storage held at index `pad` of a larger array as a slab neighbour is.
 */
export function containerOf(kind: number, lows: readonly number[], pad = 0): Container {
  const card = lows.length;
  if (kind === BITSET) {
    const words = new Uint32Array(WORDS);
    for (const v of lows) words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    return bitsetContainer(words, card);
  }
  if (kind === ARRAY) {
    const data = new Uint16Array(pad + card + pad);
    data.set(lows, pad);
    return new Container(ARRAY, data, pad, card, card, false);
  }
  const pairs: number[] = [];
  for (let i = 0; i < card;) {
    let j = i;
    while (j + 1 < card && lows[j + 1] === (lows[j] as number) + 1) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pad + pairs.length + pad);
  data.set(pairs, pad);
  return new Container(RUN, data, pad, pairs.length / 2, card, false);
}

/** The values of a container, ascending. */
export function valuesOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  appendIds(c, out, 0, 0);
  return Array.from(out);
}

/** Sets of remainders of every shape a container takes: a few, thousands, many runs, and the chunk's edges. */
export const lowsSet = fc
  .oneof(
    fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 40 }),
    fc.uniqueArray(fc.integer({ min: 0, max: 8_000 }), { minLength: 1, maxLength: 7_000 }),
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: 65_535 }), fc.integer({ min: 1, max: 700 })), {
        minLength: 1,
        maxLength: 25,
      })
      .map((runs) => runs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))),
    fc.constantFrom([0], [65_535], [0, 65_535], range(0, 65_536), range(65_000, 65_536)),
  )
  .map((v) => sortedUnique(v));
