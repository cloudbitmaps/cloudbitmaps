import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { RUN, appendIds } from '@/ts-roaring/containers';
import { containerOf, range, sortedUnique } from '../helpers/container-kinds';

/**
 * The two loops over many small containers: `appendIds` of run containers (the ids of every run, each plus the chunk's
 * base) and the bytes `serialize` writes for small array and run bodies, held to a plain expansion and to CRoaring's bytes.
 */
const CAP = 1 << 27;

describe('appendIds of a run container', () => {
  it('writes every run, short and long, each id plus the base, from any start index', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 1, max: 200 })), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.constantFrom(0, 65_536, 3 * 65_536, 65_535 * 65_536),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 5 }),
        (steps, base, at, pad) => {
          // Runs of 1 to 200 values with gaps of 1 to 600 (so maximal, none touching), across the lengths around 48.
          let next = 0;
          const lows: number[] = [];
          for (const [gap, len] of steps) {
            const start = next + gap + 1;
            if (start + len > 65_535) break;
            lows.push(...range(start, start + len));
            next = start + len;
          }
          if (lows.length === 0) return;
          const c = containerOf(RUN, lows, pad);
          const out = new Uint32Array(at + lows.length + 3).fill(0xdead_beef);
          const end = appendIds(c, out, at, base);
          expect(end).toBe(at + lows.length);
          expect(Array.from(out.subarray(at, end))).toEqual(lows.map((v) => v + base));
          // Nothing before `at` or after the last id is touched.
          for (let i = 0; i < at; i++) expect(out[i]).toBe(0xdead_beef);
          for (let i = end; i < out.length; i++) expect(out[i]).toBe(0xdead_beef);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('runs of exactly 1, 47, 48, 49, 50 and 65,536 values, at the top of the chunk too', () => {
    for (const n of [1, 2, 47, 48, 49, 50, 300, 65_536]) {
      for (const start of [0, 65_536 - n]) {
        const lows = range(start, start + n);
        const out = new Uint32Array(n);
        expect(appendIds(containerOf(RUN, lows), out, 0, 7 * 65_536)).toBe(n);
        expect(Array.from(out)).toEqual(lows.map((v) => v + 7 * 65_536));
      }
    }
  });

  it('toUint32Array of a bitmap of many run containers is the ids in order', () => {
    const ids = range(0, 40).flatMap((k) =>
      range(0, 100).flatMap((r) =>
        range(k * 65_536 + r * 600, k * 65_536 + r * 600 + 30 + (r % 40)),
      ),
    );
    const m = TsBitmap.fromValues(ids);
    m.optimize();
    const decoded = TsBitmap.safeDeserialize(m.serialize(), CAP);
    expect(decoded.hasRunContainer()).toBe(true);
    expect(Array.from(decoded.toUint32Array())).toEqual(ids);
  });
});

describe('serialize of small bodies', () => {
  it('arrays and runs of 0 to 70 values, held at odd offsets, are CRoaring bytes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 70 }),
          { minLength: 1, maxLength: 40 },
        ),
        fc.boolean(),
        (chunks, optimize) => {
          const ids = chunks.flatMap((lows, k) => lows.map((v) => k * 65_536 + v));
          const mine = TsBitmap.fromValues(ids);
          const native = new RoaringBitmap32(ids);
          if (optimize) {
            mine.optimize();
            native.runOptimize();
          }
          expect(Buffer.from(mine.serialize()).equals(Buffer.from(native.serialize(true)))).toBe(
            true,
          );
          // And what a decode of those bytes holds, small containers in one slab, writes the same bytes again.
          const again = TsBitmap.safeDeserialize(mine.serialize(), CAP);
          expect(Buffer.from(again.serialize()).equals(Buffer.from(mine.serialize()))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('bodies of 63, 64 and 65 values and runs of 31, 32 and 33 pairs', () => {
    for (const n of [1, 63, 64, 65, 66]) {
      const spaced = sortedUnique(range(0, n).map((v) => v * 9 + 1));
      const m = TsBitmap.fromValues(spaced);
      expect(
        Buffer.from(m.serialize()).equals(Buffer.from(new RoaringBitmap32(spaced).serialize(true))),
      ).toBe(true);
    }
    for (const pairs of [31, 32, 33, 34]) {
      const ids = range(0, pairs).flatMap((r) => range(r * 100, r * 100 + 20));
      const m = TsBitmap.fromValues(ids);
      m.optimize();
      const native = new RoaringBitmap32(ids);
      native.runOptimize();
      expect(Buffer.from(m.serialize()).equals(Buffer.from(native.serialize(true)))).toBe(true);
    }
  });
});
