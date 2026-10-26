import { describe, expect, it } from 'vitest';
import { RUN, Container, appendIds } from '@/ts-roaring/containers';

/**
 * A run container's ids are written ascending, each plus the chunk's base: a short run counted out, a long one copied
 * as a block. The boundary between the two is a run of 49 values (48 past its start), and every length either side
 * of it, at either end of the chunk and at a nonzero base, must give the same ids.
 */
function runContainer(pairs: ReadonlyArray<readonly [number, number]>, pad: number): Container {
  const data = new Uint16Array(pad + 2 * pairs.length + pad);
  pairs.forEach(([start, length], r) => {
    data[pad + 2 * r] = start;
    data[pad + 2 * r + 1] = length;
  });
  const card = pairs.reduce((n, [, length]) => n + length + 1, 0);
  return new Container(RUN, data, pad, pairs.length, card, true);
}

function expected(pairs: ReadonlyArray<readonly [number, number]>, base: number): number[] {
  const out: number[] = [];
  for (const [start, length] of pairs)
    for (let v = start; v <= start + length; v++) out.push(base + v);
  return out;
}

function written(c: Container, base: number, at: number): { out: number[]; end: number } {
  const out = new Uint32Array(at + c.card + 3).fill(0xdead_beef);
  const end = appendIds(c, out, at, base);
  return { out: Array.from(out), end };
}

describe('the ids of a run container', () => {
  const bases = [0, 65_536, 7 * 65_536];
  for (const length of [0, 1, 46, 47, 48, 49, 50, 300]) {
    for (const base of bases) {
      it(`a run of ${length + 1} values at base ${base}, after other runs, at an offset`, () => {
        const pairs = [
          [3, 2],
          [100, length],
          [1_000, 47],
          [2_000, 48],
          [3_000, 49],
          [65_535 - length, length],
        ] as const;
        const want = expected(pairs, base);
        for (const pad of [0, 3]) {
          const c = runContainer(pairs, pad);
          const { out, end } = written(c, base, 5);
          expect(end).toBe(5 + want.length);
          expect(out.slice(5, end)).toEqual(want);
          // Nothing is written before `at` or after the last id.
          expect(out.slice(0, 5)).toEqual(Array(5).fill(0xdead_beef));
          expect(out.slice(end)).toEqual(Array(3).fill(0xdead_beef));
        }
      });
    }
  }

  it('a chunk that is one run from 0 to 65,535 is written whole', () => {
    const c = runContainer([[0, 65_535]], 0);
    const { out, end } = written(c, 2 * 65_536, 0);
    expect(end).toBe(65_536);
    for (let i = 0; i < 65_536; i++) if (out[i] !== 2 * 65_536 + i) throw new Error(`at ${i}`);
  });
});
