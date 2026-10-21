import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@cloudbitmaps/core';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { roaringCodec } from '@/roaring-codec';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import { crPlainBytes, prng } from '../helpers/roaring-oracle';

/**
 * What the codec oracle cannot see from outside: the TypeScript codec's own bookkeeping. The oracle holds its answers
 * and its stored bytes to CRoaring's; these hold the cardinality it keeps (never recounted per call), the ids it
 * refuses, and the operands it will not mix.
 */
const CAP = 1 << 24;
const ops = fc.array(
  fc.record({
    op: fc.constantFrom('add', 'remove', 'addMany', 'removeMany', 'or', 'and', 'andNot'),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
    count: fc.integer({ min: 0, max: 600 }),
    base: fc.constantFrom(0, 4_000, 65_000, 65_536, 2 ** 32 - 70_000),
  }),
  { minLength: 1, maxLength: 25 },
);

function ids(seed: number, count: number, base: number): number[] {
  const next = prng(seed);
  return Array.from({ length: count }, () => base + Math.floor(next() * 9_000));
}

describe('the TypeScript codec keeps its own books', () => {
  it('keeps size equal to the true cardinality through every kind change, from a run container and from ids', () => {
    const runs = Array.from({ length: 20_000 }, (_, i) => 100 + i);
    const starts: Array<() => CodecBitmap> = [
      () => tsRoaringCodec.empty(),
      () => tsRoaringCodec.fromValues(runs),
      () => tsRoaringCodec.safeDeserialize(crPlainBytes(runs, 'ranges'), CAP, { whole: true }),
    ];
    for (const start of starts) {
      fc.assert(
        fc.property(ops, (steps) => {
          const bitmap = start();
          const model = new Set<number>(bitmap);
          for (const { op, seed, count, base } of steps) {
            const given = ids(seed, count, base);
            const other = tsRoaringCodec.fromValues(ids(seed + 1, count, base));
            if (op === 'add') {
              for (const v of given) {
                bitmap.add(v);
                model.add(v);
              }
            } else if (op === 'remove') {
              for (const v of given) {
                bitmap.remove(v);
                model.delete(v);
              }
            } else if (op === 'addMany') {
              bitmap.addMany(given);
              for (const v of given) model.add(v);
            } else if (op === 'removeMany') {
              bitmap.removeMany(given);
              for (const v of given) model.delete(v);
            } else if (op === 'or') {
              bitmap.orInPlace(other);
              for (const v of other) model.add(v);
            } else if (op === 'and') {
              bitmap.andInPlace(other);
              const keep = new Set(other);
              for (const v of [...model]) if (!keep.has(v)) model.delete(v);
            } else {
              bitmap.andNotInPlace(other);
              for (const v of other) model.delete(v);
            }
            expect(bitmap.size).toBe(model.size);
            expect(bitmap.isEmpty).toBe(model.size === 0);
            expect(bitmap.toArray()).toEqual([...model].sort((a, b) => a - b));
            const last = [...model].sort((a, b) => a - b).at(-1);
            expect(bitmap.maximum?.()).toBe(last);
          }
        }),
        { numRuns: 60 },
      );
    }
  });

  it('refuses to write an id that is not an integer from 0 to 4,294,967,295, and reads one as absent', () => {
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN, Infinity]) {
      const bitmap = tsRoaringCodec.fromValues([1, 2]);
      expect(() => bitmap.add(bad)).toThrow(ValidationError);
      expect(() => bitmap.addMany([3, bad])).toThrow(ValidationError);
      expect(() => tsRoaringCodec.fromValues([bad])).toThrow(ValidationError);
      expect(bitmap.has(bad)).toBe(false);
      bitmap.remove(bad);
      expect(bitmap.toArray(), 'a refused write leaves the bitmap as it was').toEqual([1, 2]);
    }
  });

  it('owns its own bitmaps and nothing else, and combines with its own only', () => {
    const mine = tsRoaringCodec.fromValues([1]);
    const native = roaringCodec.fromValues([1]);
    expect(tsRoaringCodec.owns?.(mine)).toBe(true);
    expect(tsRoaringCodec.owns?.(native)).toBe(false);
    expect(tsRoaringCodec.owns?.({})).toBe(false);
    expect(roaringCodec.owns?.(mine)).toBe(false);
    for (const op of ['orInPlace', 'andInPlace', 'andNotInPlace'] as const) {
      expect(() => mine[op](native)).toThrow(ValidationError);
    }
    expect(mine.toArray()).toEqual([1]);
  });

  it('combines a bitmap with itself', () => {
    const a = tsRoaringCodec.fromValues([1, 2, 70_000]);
    a.orInPlace(a);
    a.andInPlace(a);
    expect(a.toArray()).toEqual([1, 2, 70_000]);
    a.andNotInPlace(a);
    expect(a.isEmpty).toBe(true);
    expect(a.maximum?.()).toBeUndefined();
  });

  it('hands out a toUint32Array the caller owns', () => {
    const bitmap = tsRoaringCodec.fromValues([5, 6, 7]);
    const first = bitmap.toUint32Array?.() as Uint32Array;
    first.fill(0);
    expect([...(bitmap.toUint32Array?.() as Uint32Array)]).toEqual([5, 6, 7]);
    expect(bitmap.toArray()).toEqual([5, 6, 7]);
  });
});
