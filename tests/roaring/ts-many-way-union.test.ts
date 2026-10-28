import fc from 'fast-check';
import { RoaringBitmap32 } from 'roaring';
import { describe, expect, it } from 'vitest';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  BITSET,
  Container,
  RUN,
  WORDS,
  appendIds,
  bitsetContainer,
  orManyContainers,
} from '@/ts-roaring/containers';

/**
 * The many-way union: every container of one key OR-ed into one accumulator, counted once, the result in storage of its
 * own. Held to a plain `Set` for each mix of container kinds, and, for whole bitmaps, to CRoaring through `roaring`.
 */
const CAP = 1 << 27;
const KINDS = [ARRAY, BITSET, RUN] as const;

/** `lows` (ascending, distinct, each below 65,536) as a container of the given kind, stored at an offset for the 16-bit kinds. */
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
    while (j + 1 < card && lows[j + 1] === (lows[j] as number) + 1) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pad + pairs.length);
  data.set(pairs, pad);
  return new Container(RUN, data, pad, pairs.length / 2, card, false);
}

const sortedUnique = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

function lowsOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  expect(appendIds(c, out, 0, 0)).toBe(c.card);
  return [...out];
}

/** Whether `c` keeps any typed array of `inputs` (a view of the same buffer counts). */
function sharesStorage(c: Container, inputs: readonly Container[]): boolean {
  return inputs.some((i) => i.data.buffer === c.data.buffer);
}

const lowsSet = fc
  .oneof(
    fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 40 }),
    fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 3_000 }),
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

const member = fc.record({
  kind: fc.constantFrom(...KINDS),
  lows: lowsSet,
  pad: fc.integer({ min: 0, max: 3 }),
});

describe('orManyContainers', () => {
  it('holds the union of any mix of kinds, with the exact cardinality and storage of its own', () => {
    fc.assert(
      fc.property(fc.array(member, { minLength: 2, maxLength: 9 }), (members) => {
        const inputs = members.map((m) => container(m.kind, m.lows, m.pad));
        const before = inputs.map((c) => lowsOf(c));
        const want = sortedUnique(members.flatMap((m) => m.lows));
        const out = orManyContainers(inputs);
        expect(out.card).toBe(want.length);
        expect(lowsOf(out)).toEqual(want);
        expect(out.kind).toBe(want.length > 4_096 ? BITSET : ARRAY);
        expect(out.shared).toBe(false);
        expect(sharesStorage(out, inputs)).toBe(false);
        inputs.forEach((c, i) => {
          expect(lowsOf(c)).toEqual(before[i]);
          expect(c.shared).toBe(false);
        });
      }),
      { numRuns: 150 },
    );
  }, 60_000);

  it('holds the same on the boundaries: a union of exactly 4,096 and 4,097 values, a full key, one value apiece', () => {
    const cases: number[][][] = [
      [range(0, 2_048), range(2_048, 4_096)],
      [range(0, 2_048), range(2_048, 4_097)],
      [range(0, 4_096), range(0, 4_096), range(0, 4_096)],
      [range(0, 32_768), range(32_768, 65_536)],
      [[0], [65_535], [31], [32], [0]],
      Array.from({ length: 5_000 }, (_, i) => [i]),
    ];
    for (const sets of cases) {
      for (const kind of KINDS) {
        const out = orManyContainers(sets.map((s) => container(kind, s)));
        const want = sortedUnique(sets.flat());
        expect(lowsOf(out)).toEqual(want);
        expect(out.card).toBe(want.length);
        expect(out.kind).toBe(want.length > 4_096 ? BITSET : ARRAY);
      }
    }
  });
});

const ids = fc
  .array(
    fc.oneof(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 0, max: 400_000 }),
      fc.constantFrom(0, 65_535, 65_536, 2 ** 31, 0xffff_ffff),
    ),
    { maxLength: 300 },
  )
  .chain((base) =>
    fc.oneof(
      fc.constant(base),
      // a dense stretch inside one key, so a bitset or a run takes part
      fc
        .tuple(fc.integer({ min: 0, max: 1_000 }), fc.integer({ min: 100, max: 9_000 }))
        .map(([key, n]) => [...base, ...range(key * 65_536, key * 65_536 + n)]),
    ),
  );

describe('TsBitmap.orMany', () => {
  it('equals CRoaring on any list of bitmaps, leaves each as it was, and owns its containers', () => {
    fc.assert(
      fc.property(fc.array(ids, { maxLength: 7 }), fc.boolean(), (lists, optimizeFirst) => {
        const parts = lists.map((l) => TsBitmap.fromValues(l));
        if (optimizeFirst) for (const p of parts) p.optimize();
        const snapshots = parts.map((p) => p.toUint32Array());
        const out = TsBitmap.orMany(parts);
        const want = RoaringBitmap32.orMany(lists.map((l) => RoaringBitmap32.from(l)));
        expect(out.size).toBe(want.size);
        expect([...out.toUint32Array()]).toEqual([...want.toUint32Array()]);
        parts.forEach((p, i) => expect(p.toUint32Array()).toEqual(snapshots[i]));
        // A write to the result never reaches an operand, and the result's bytes round-trip.
        const bytes = out.serialize();
        expect(TsBitmap.safeDeserialize(bytes, CAP).toUint32Array()).toEqual(out.toUint32Array());
        out.addMany([5, 70_000, 2 ** 31]);
        out.removeMany(snapshots.flatMap((s) => [...s]).slice(0, 50));
        parts.forEach((p, i) => expect(p.toUint32Array()).toEqual(snapshots[i]));
      }),
      { numRuns: 60 },
    );
  }, 60_000);

  it('gives the empty set for an empty list and a copy for one bitmap or the same bitmap twice', () => {
    expect(TsBitmap.orMany([]).size).toBe(0);
    const a = TsBitmap.fromValues([1, 70_000, 2 ** 31]);
    a.optimize();
    for (const list of [[a], [a, a, a]]) {
      const out = TsBitmap.orMany(list);
      expect([...out.toUint32Array()]).toEqual([1, 70_000, 2 ** 31]);
      out.add(2);
      expect(a.has(2)).toBe(false);
    }
  });

  it('merges keys that sit in different places of each input', () => {
    const a = TsBitmap.fromValues([9 * 65_536, 3 * 65_536 + 1, 70_000]);
    const b = TsBitmap.fromValues([3 * 65_536 + 2, 100]);
    const c = TsBitmap.fromValues([0xffff_ffff, 100, 9 * 65_536 + 1]);
    expect([...TsBitmap.orMany([a, b, c]).toUint32Array()]).toEqual(
      [...new Set([...a, ...b, ...c])].sort((x, y) => x - y),
    );
  });
});
