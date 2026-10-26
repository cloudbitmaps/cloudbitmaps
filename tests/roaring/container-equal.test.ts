import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  BITSET,
  Container,
  RUN,
  WORDS,
  bitsetContainer,
  containersEqual,
} from '@/ts-roaring/containers';

/**
 * Equality of two containers by comparing their storage: every pair of kinds against a plain set, the words, values
 * and pairs that decide it at their first and last element, and whole bitmaps (a clone, a decoded copy, one id apart).
 */
const CAP = 1 << 27;
const KINDS = [ARRAY, BITSET, RUN] as const;
const KIND_NAME = ['array', 'bitset', 'run'];
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const sortedUnique = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);

function container(kind: number, lows: readonly number[], pad = 0): Container {
  const card = lows.length;
  if (kind === BITSET) {
    const words = new Uint32Array(WORDS);
    for (const v of lows) words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
    return bitsetContainer(words, card);
  }
  if (kind === ARRAY) {
    const data = new Uint16Array(pad + card);
    data.set(lows, pad);
    return new Container(ARRAY, data, pad, card, card, false);
  }
  const pairs: number[] = [];
  for (let i = 0; i < card;) {
    let j = i;
    while (j + 1 < card && lows[j + 1] === (lows[i] as number) + (j + 1 - i)) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pad + pairs.length);
  data.set(pairs, pad);
  return new Container(RUN, data, pad, pairs.length / 2, card, false);
}

const lowsSet = fc
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

describe('containersEqual, every pair of kinds', () => {
  for (const ka of KINDS) {
    for (const kb of KINDS) {
      it(`${KIND_NAME[ka]} against ${KIND_NAME[kb]}: equal sets are equal, any other pair is not`, () => {
        fc.assert(
          fc.property(
            lowsSet,
            lowsSet,
            fc.nat(),
            fc.integer({ min: 0, max: 5 }),
            (a, b, pick, pad) => {
              const same = container(ka, a, pad);
              const other = container(kb, a, pad + 1);
              expect(containersEqual(same, other)).toBe(true);
              expect(containersEqual(other, same)).toBe(true);
              // One value more, one fewer, one moved: never equal.
              const moved = a.slice();
              const at = pick % a.length;
              const to = ((moved[at] as number) + 1) % 65_536;
              if (!a.includes(to)) {
                moved[at] = to;
                expect(containersEqual(same, container(kb, sortedUnique(moved)))).toBe(false);
              }
              const want = a.length === b.length && a.every((v, i) => v === b[i]);
              expect(containersEqual(container(ka, a), container(kb, b, pad))).toBe(want);
            },
          ),
          { numRuns: 120 },
        );
      });
    }
  }

  it('a difference in the first or the last word, value or pair of one kind is seen', () => {
    const base = range(0, 6_000).map((v) => v * 10);
    for (const kind of [ARRAY, BITSET] as const) {
      const lows = kind === ARRAY ? base.slice(0, 3_000) : base.slice(0, 6_000);
      for (const at of [0, lows.length - 1]) {
        const moved = lows.slice();
        moved[at] = (moved[at] as number) + 1;
        expect(containersEqual(container(kind, lows), container(kind, sortedUnique(moved)))).toBe(
          false,
        );
      }
    }
    const runs = range(0, 300).flatMap((i) => range(i * 200, i * 200 + 50));
    for (const at of [0, runs.length - 1]) {
      const edited = runs.filter((_, i) => i !== at);
      // Same count after a replacement keeps the run count, changing one run's end or start.
      const swapped = sortedUnique([...edited, at === 0 ? 100 : 65_000]);
      expect(containersEqual(container(RUN, runs), container(RUN, swapped))).toBe(false);
    }
    // Same cardinality, same number of runs, different lengths.
    expect(
      containersEqual(container(RUN, [...range(0, 10), 20]), container(RUN, [0, ...range(10, 20)])),
    ).toBe(false);
  });

  it('equal storage held at different offsets, and storage shared by both, is compared by value', () => {
    const lows = range(0, 500).map((v) => v * 3);
    const a = container(ARRAY, lows, 0);
    const b = container(ARRAY, lows, 7);
    expect(containersEqual(a, b)).toBe(true);
    expect(containersEqual(a, new Container(ARRAY, a.data, 0, a.len, a.card, true))).toBe(true);
    // Two containers of one slab: the same buffer, different stretches of it.
    const slab = Uint16Array.from([1, 2, 3, 4, 5, 6]);
    const left = new Container(ARRAY, slab, 0, 3, 3, true);
    const right = new Container(ARRAY, slab, 3, 3, 3, true);
    expect(containersEqual(left, right)).toBe(false);
    expect(containersEqual(left, new Container(ARRAY, slab, 0, 3, 3, true))).toBe(true);
    const longer = container(ARRAY, [...lows, 5_000]);
    expect(containersEqual(a, longer)).toBe(false);
  });
});

describe('isEqual on whole bitmaps', () => {
  const kinds: Record<string, number[]> = {
    array: range(0, 1_000).map((v) => v * 7),
    bitset: range(0, 20_000).map((v) => v * 3),
    run: range(0, 40).flatMap((i) => range(i * 1_000, i * 1_000 + 300)),
  };
  const spread = (lows: number[]) =>
    [0, 1, 70_000]
      .flatMap((key) => lows.map((v) => key * 65_536 + v))
      .filter((v) => v <= 0xffff_ffff);

  for (const [name, lows] of Object.entries(kinds)) {
    it(`${name} containers: a clone, a decoded copy and an optimized copy are equal; one id apart is not`, () => {
      const ids = spread(lows);
      const x = TsBitmap.fromValues(ids);
      const y = TsBitmap.fromValues(ids);
      expect(x.isEqual(y)).toBe(true);
      expect(x.isEqual(x.clone())).toBe(true);
      const optimized = x.clone();
      optimized.optimize();
      expect(x.isEqual(optimized)).toBe(true);
      expect(optimized.isEqual(x)).toBe(true);
      expect(x.isEqual(TsBitmap.safeDeserialize(optimized.serialize(), CAP))).toBe(true);
      expect(optimized.isEqual(TsBitmap.safeDeserialize(optimized.serialize(), CAP))).toBe(true);
      for (const id of [ids[0] as number, ids[ids.length - 1] as number]) {
        const fewer = y.clone();
        fewer.remove(id);
        expect(x.isEqual(fewer)).toBe(false);
        const moved = y.clone();
        moved.remove(id);
        moved.add(5 * 65_536 + 3);
        expect(x.isEqual(moved)).toBe(false);
      }
    });
  }
});
