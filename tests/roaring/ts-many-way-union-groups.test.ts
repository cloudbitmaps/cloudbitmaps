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
 * The many-way union ORs bitset sources four a step into an accumulator the first group builds without copying a source.
 * Held to a plain set for 1, 3, 4, 5, 8 and 9 bitsets in a key (alone, and beside arrays and runs), with each source
 * differing from the others in every word, and to CRoaring for whole bitmaps with that many bitsets per key.
 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** A bitset container of `density` (1 to 32) random bits per word on average, and the values it holds. */
function bitset(seed: number, density: number): { c: Container; lows: number[] } {
  const rnd = seeded(seed);
  const words = new Uint32Array(WORDS);
  const lows: number[] = [];
  for (let w = 0; w < WORDS; w++) {
    let word = 0;
    for (let k = 0; k < density; k++) word |= 1 << (rnd() >>> 27);
    words[w] = word >>> 0;
    for (let b = 0; b < 32; b++) if ((word >>> b) & 1) lows.push(w * 32 + b);
  }
  return { c: bitsetContainer(words, lows.length), lows };
}

function arrayOf(values: number[]): Container {
  return new Container(ARRAY, Uint16Array.from(values), 0, values.length, values.length, false);
}

function runOf(start: number, length: number): { c: Container; lows: number[] } {
  const lows = Array.from({ length }, (_, i) => start + i);
  return { c: new Container(RUN, Uint16Array.of(start, length - 1), 0, 1, length, false), lows };
}

function lowsOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  expect(appendIds(c, out, 0, 0)).toBe(c.card);
  return [...out];
}

const union = (sets: number[][]) => [...new Set(sets.flat())].sort((x, y) => x - y);

describe('orManyContainers with 1, 3, 4, 5, 8 and 9 bitsets in a key', () => {
  for (const n of [1, 3, 4, 5, 8, 9]) {
    for (const density of [1, 12]) {
      it(`${n} bitsets of density ${density}, alone and beside an array and a run`, () => {
        const sources = Array.from({ length: n }, (_, i) => bitset(1000 * n + i, density));
        const arr = [3, 4, 5, 64_000, 65_535];
        const run = runOf(40_000, 700);
        const mixes: { inputs: Container[]; sets: number[][] }[] = [
          { inputs: sources.map((s) => s.c), sets: sources.map((s) => s.lows) },
          {
            inputs: [arrayOf(arr), ...sources.map((s) => s.c), run.c],
            sets: [arr, ...sources.map((s) => s.lows), run.lows],
          },
          {
            inputs: [run.c, ...sources.map((s) => s.c)].reverse(),
            sets: [run.lows, ...sources.map((s) => s.lows)],
          },
        ];
        for (const { inputs, sets } of mixes) {
          if (inputs.length < 2) continue;
          const before = inputs.map((c) =>
            c.kind === BITSET ? (c.data as Uint32Array).slice() : null,
          );
          const want = union(sets);
          const out = orManyContainers(inputs);
          expect(out.card).toBe(want.length);
          expect(lowsOf(out)).toEqual(want);
          expect(out.kind).toBe(want.length > 4_096 ? BITSET : ARRAY);
          expect(out.shared).toBe(false);
          // No input is the result's storage, and none was written.
          for (const [i, c] of inputs.entries()) {
            expect(out.data.buffer).not.toBe(c.data.buffer);
            if (c.kind === BITSET) expect(c.data).toEqual(before[i]);
          }
        }
      });
    }
  }

  it('one bitset beside arrays and runs only: the bitset is copied, not written', () => {
    const one = bitset(7, 6);
    const run = runOf(100, 50);
    const arr = arrayOf([1, 2, 3]);
    const keep = (one.c.data as Uint32Array).slice();
    const out = orManyContainers([arr, one.c, run.c]);
    expect(lowsOf(out)).toEqual(union([one.lows, run.lows, [1, 2, 3]]));
    expect(one.c.data).toEqual(keep);
    expect(out.data).not.toBe(one.c.data);
  });
});

describe('TsBitmap.orMany with that many bitsets per key', () => {
  it('equals CRoaring for 1, 3, 4, 5, 8 and 9 bitmaps whose keys hold bitsets', () => {
    for (const n of [1, 3, 4, 5, 8, 9]) {
      const lists: number[][] = [];
      for (let i = 0; i < n; i++) {
        const rnd = seeded(77 + i + 100 * n);
        const ids: number[] = [];
        // Key 0 and key 3 are dense in every input; key 5 is dense in every other input.
        for (let k = 0; k < 9_000; k++) ids.push(rnd() % 65_536, 3 * 65_536 + (rnd() % 65_536));
        if (i % 2 === 0) for (let k = 0; k < 9_000; k++) ids.push(5 * 65_536 + (rnd() % 65_536));
        ids.push(9 * 65_536 + i);
        lists.push(ids);
      }
      const parts = lists.map((l) => TsBitmap.fromValues(l));
      const snapshots = parts.map((p) => p.toUint32Array());
      const out = TsBitmap.orMany(parts);
      const want = RoaringBitmap32.orMany(lists.map((l) => RoaringBitmap32.from(l)));
      expect(out.size).toBe(want.size);
      expect([...out.toUint32Array()]).toEqual([...want.toUint32Array()]);
      parts.forEach((p, i) => expect(p.toUint32Array()).toEqual(snapshots[i]));
    }
  });
});
