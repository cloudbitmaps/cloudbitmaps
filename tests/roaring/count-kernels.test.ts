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
  bitsetContainer,
  containerAndCard,
  containersIntersect,
} from '@/ts-roaring/containers';

/**
 * The counting kernels of the codec: how many ids two bitmaps share, and the answers derived from that, without building
 * the combination. Every container-pair kind (array, bitset and run on both sides) is held to a plain `Set`; whole bitmaps,
 * with ids at 2^31 and at 0xFFFFFFFF, are held to CRoaring through `roaring` and to the identities between the counts.
 */
const CAP = 1 << 27;
const KINDS = [ARRAY, BITSET, RUN] as const;
const KIND_NAME = ['array', 'bitset', 'run'];

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

/** Non-empty sets of remainders of the shapes that pick different branches: few, many, runs, edges, skewed. */
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

function overlap(a: readonly number[], b: readonly number[]): number {
  const inB = new Set(b);
  return a.filter((v) => inB.has(v)).length;
}

describe('the container counting kernels, every pair kind', () => {
  for (const ka of KINDS) {
    for (const kb of KINDS) {
      it(`${KIND_NAME[ka]} against ${KIND_NAME[kb]}: the count and the early-exit test match a set`, () => {
        fc.assert(
          fc.property(lowsSet, lowsSet, fc.integer({ min: 0, max: 5 }), (a, b, pad) => {
            const want = overlap(a, b);
            const x = container(ka, a, pad);
            const y = container(kb, b, pad + 1);
            expect(containerAndCard(x, y)).toBe(want);
            expect(containersIntersect(x, y)).toBe(want > 0);
          }),
          { numRuns: 120 },
        );
      });
    }
  }

  it('edges: disjoint, equal, nested, one value apart, the chunk ends', () => {
    const cases: Array<[number[], number[]]> = [
      [range(0, 100), range(100, 200)],
      [range(0, 100), range(0, 100)],
      [range(10, 20), range(0, 100)],
      [
        [0, 2, 4],
        [1, 3, 5],
      ],
      [[65_535], [65_535]],
      [[0], [65_535]],
      [range(0, 65_536), [0, 32_767, 65_535]],
      [range(4_000, 9_000), range(8_999, 9_001)],
      [range(0, 5_000).filter((v) => v % 2 === 0), range(1, 5_001).filter((v) => v % 2 === 1)],
      // One side far longer than the other, so the gallop and the per-value run search run.
      [[7, 40_000], range(0, 3_000).map((v) => v * 20)],
    ];
    for (const [a, b] of cases) {
      for (const ka of KINDS) {
        for (const kb of KINDS) {
          const x = container(ka, a);
          const y = container(kb, b);
          expect(containerAndCard(x, y), `${KIND_NAME[ka]}/${KIND_NAME[kb]}`).toBe(overlap(a, b));
          expect(containersIntersect(x, y)).toBe(overlap(a, b) > 0);
        }
      }
    }
  });

  it('a kernel changes neither operand', () => {
    const a = range(0, 6_000).map((v) => v * 10 + 1);
    const b = range(0, 6_000)
      .map((v) => v * 10 + 1)
      .filter((v) => v % 3 === 0);
    for (const ka of KINDS) {
      for (const kb of KINDS) {
        const x = container(ka, a);
        const y = container(kb, b);
        const before = [Array.from(x.data), Array.from(y.data)];
        containerAndCard(x, y);
        containersIntersect(x, y);
        expect([Array.from(x.data), Array.from(y.data)]).toEqual(before);
      }
    }
  });
});

// --- whole bitmaps ----------------------------------------------------------------------------------------------

const KEYS = [0, 1, 2, 7, 255, 256, 32_767, 32_768, 65_534, 65_535];

/** Ids over a few keys, including 2^31 (key 32,768) and 0xFFFFFFFF (key 65,535), each key a sparse, dense or run shape. */
const idsSet = fc
  .array(
    fc.tuple(
      fc.constantFrom(...KEYS),
      fc.constantFrom('sparse', 'dense', 'runs', 'edge'),
      fc.integer({ min: 1, max: 1_000_000 }),
    ),
    { minLength: 0, maxLength: 6 },
  )
  .map((parts) => {
    const out: number[] = [];
    for (const [key, shape, seed] of parts) {
      let x = seed;
      const next = () => (x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0);
      const lows: number[] = [];
      if (shape === 'sparse') for (let i = 0; i < 1 + (seed % 60); i++) lows.push(next() & 0xffff);
      else if (shape === 'dense')
        for (let i = 0; i < 4_200 + (seed % 3_000); i++) lows.push(next() & 0xffff);
      else if (shape === 'runs')
        for (let i = 0; i < 1 + (seed % 12); i++) {
          const s = next() & 0xffff;
          lows.push(...range(s, Math.min(65_536, s + 20 + (next() % 900))));
        }
      else lows.push(0, 65_535, 32_768, 4_095, 4_096);
      for (const l of lows) out.push(key * 65_536 + l);
    }
    return sortedUnique(out);
  });

/** A bitmap of `ids` as the codec builds one, or after a stored-form round trip that turns runs back into run containers. */
function ts(ids: readonly number[], asStored: boolean): TsBitmap {
  const bitmap = TsBitmap.fromValues(ids);
  if (!asStored) return bitmap;
  bitmap.optimize();
  return TsBitmap.safeDeserialize(bitmap.serialize(), CAP);
}

describe('the bitmap counting operations against CRoaring', () => {
  it('every count, intersects, isSubset and isEqual answer what CRoaring and a set answer', () => {
    fc.assert(
      fc.property(idsSet, idsSet, fc.boolean(), fc.boolean(), (a, b, storedA, storedB) => {
        const x = ts(a, storedA);
        const y = ts(b, storedB);
        const cx = new RoaringBitmap32(a);
        const cy = new RoaringBitmap32(b);
        const both = overlap(a, b);
        expect(x.andCardinality(y)).toBe(both);
        expect(x.andCardinality(y)).toBe(cx.andCardinality(cy));
        expect(x.orCardinality(y)).toBe(cx.orCardinality(cy));
        expect(x.xorCardinality(y)).toBe(cx.xorCardinality(cy));
        expect(x.andNotCardinality(y)).toBe(cx.andNotCardinality(cy));
        expect(x.intersects(y)).toBe(cx.intersects(cy));
        expect(x.intersects(y)).toBe(both > 0);
        expect(x.isSubset(y)).toBe(cx.isSubset(cy));
        expect(x.isSubset(y)).toBe(both === a.length);
        expect(x.isEqual(y)).toBe(cx.isEqual(cy));
        expect(x.isEqual(y)).toBe(a.length === b.length && both === a.length);
      }),
      { numRuns: 150 },
    );
  });

  it('the ids 2^31 and 0xFFFFFFFF count, and a bitmap differing only there is not equal', () => {
    const base = [0, 2 ** 31 - 1];
    const x = ts([...base, 2 ** 31, 0xffff_ffff], false);
    const y = ts([...base, 2 ** 31], true);
    const z = ts([...base, 2 ** 31, 0xffff_fffe], true);
    expect(x.andCardinality(y)).toBe(3);
    expect(x.andCardinality(z)).toBe(3);
    expect(x.isEqual(y)).toBe(false);
    expect(y.isSubset(x)).toBe(true);
    expect(x.isSubset(y)).toBe(false);
    expect(x.intersects(ts([0xffff_ffff], true))).toBe(true);
    expect(y.intersects(ts([0xffff_ffff], true))).toBe(false);
  });

  it('the same low bits under different keys are neither equal nor a subset', () => {
    const x = ts([5, 70_000], false);
    const y = ts([65_536 + 5, 70_000], false);
    const z = ts([5, 70_000 + 65_536], false);
    for (const other of [y, z]) {
      expect(x.isEqual(other)).toBe(false);
      expect(x.isSubset(other)).toBe(false);
      expect(other.isSubset(x)).toBe(false);
    }
    // A key past every key of the other side.
    expect(ts([2 ** 31], false).isSubset(ts([1, 2, 3], false))).toBe(false);
    expect(ts([1, 2, 3, 9], false).isSubset(ts([1, 2, 4, 5, 6], false))).toBe(false);
  });

  it('empty bitmaps: nothing shared, the empty set is a subset of all and equal to itself', () => {
    const empty = TsBitmap.empty();
    const x = ts([1, 70_000, 2 ** 31], false);
    expect(empty.andCardinality(x)).toBe(0);
    expect(x.andCardinality(empty)).toBe(0);
    expect(empty.orCardinality(x)).toBe(3);
    expect(x.xorCardinality(empty)).toBe(3);
    expect(x.andNotCardinality(empty)).toBe(3);
    expect(empty.andNotCardinality(x)).toBe(0);
    expect(empty.intersects(x)).toBe(false);
    expect(empty.isSubset(x)).toBe(true);
    expect(x.isSubset(empty)).toBe(false);
    expect(empty.isEqual(TsBitmap.empty())).toBe(true);
    expect(empty.isEqual(x)).toBe(false);
  });

  it('a bitmap that is not a TypeScript bitmap is refused', () => {
    const x = ts([1], false);
    const alien = {} as never;
    for (const call of [
      () => x.andCardinality(alien),
      () => x.orCardinality(alien),
      () => x.xorCardinality(alien),
      () => x.andNotCardinality(alien),
      () => x.intersects(alien),
      () => x.isSubset(alien),
      () => x.isEqual(alien),
    ]) {
      expect(call).toThrow(/TypeScript roaring bitmap/);
    }
  });
});

describe('laws the counts keep', () => {
  it('|A or B| = |A| + |B| - |A and B|, symmetry, the built result agrees, subset of the union, equal after a round trip', () => {
    fc.assert(
      fc.property(idsSet, idsSet, fc.boolean(), (a, b, stored) => {
        const x = ts(a, stored);
        const y = ts(b, !stored);
        const union = x.clone();
        union.orInPlace(y);
        const inter = x.clone();
        inter.andInPlace(y);
        const diff = x.clone();
        diff.andNotInPlace(y);
        expect(x.orCardinality(y)).toBe(x.size + y.size - x.andCardinality(y));
        expect(x.orCardinality(y)).toBe(union.size);
        expect(x.andCardinality(y)).toBe(inter.size);
        expect(x.andNotCardinality(y)).toBe(diff.size);
        expect(x.xorCardinality(y)).toBe(union.size - inter.size);
        expect(y.andCardinality(x)).toBe(x.andCardinality(y));
        expect(y.orCardinality(x)).toBe(x.orCardinality(y));
        expect(y.xorCardinality(x)).toBe(x.xorCardinality(y));
        expect(y.intersects(x)).toBe(x.intersects(y));
        expect(x.isSubset(union)).toBe(true);
        expect(y.isSubset(union)).toBe(true);
        expect(x.isSubset(x)).toBe(true);
        expect(x.isEqual(x.clone())).toBe(true);
        expect(inter.isSubset(x)).toBe(true);
        for (const optimized of [false, true]) {
          const copy = x.clone();
          if (optimized) copy.optimize();
          expect(x.isEqual(TsBitmap.safeDeserialize(copy.serialize(), CAP))).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('isEqual sees a single id added or removed', () => {
    fc.assert(
      fc.property(
        idsSet.filter((v) => v.length > 0),
        fc.nat(),
        (a, pick) => {
          const x = ts(a, true);
          const gone = a[pick % a.length] as number;
          const fewer = ts(
            a.filter((v) => v !== gone),
            true,
          );
          expect(x.isEqual(fewer)).toBe(false);
          expect(fewer.isEqual(x)).toBe(false);
          expect(fewer.isSubset(x)).toBe(true);
          expect(x.isSubset(fewer)).toBe(false);
          const more = ts(
            [...a, a.includes(7) ? 8 : 7].sort((p, q) => p - q),
            true,
          );
          expect(more.isEqual(x)).toBe(a.includes(7) && a.includes(8));
        },
      ),
      { numRuns: 80 },
    );
  });
});
