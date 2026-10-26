import { describe, expect, it } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';

/** Every counting method refuses a bitmap of another installed copy of the package, from either side. */
const ALL = [
  'andCardinality',
  'orCardinality',
  'xorCardinality',
  'andNotCardinality',
  'intersects',
  'isSubset',
  'isEqual',
] as const;

describe('the counting methods and a bitmap of another installed copy', () => {
  it.each(ALL)('%s refuses a bitmap of another installed copy of the package', async (method) => {
    // The query makes the module loader evaluate the source again: a second copy, as a second install would be.
    const specifier = '../../packages/roaring/src/bitmap.ts?another-copy-of-counts';
    const other = (await import(
      /* @vite-ignore */ specifier
    )) as typeof import('../../packages/roaring/src/bitmap');
    expect(other.RoaringBitmap).not.toBe(RoaringBitmap);
    const mine = new RoaringBitmap([1, 2]);
    const theirs = new other.RoaringBitmap([1, 2]);
    expect(() => (mine[method] as (o: unknown) => unknown)(theirs)).toThrow(ValidationError);
    expect(() => (theirs[method] as (o: unknown) => unknown)(mine)).toThrow(ValidationError);
    expect(mine.toArray()).toEqual([1, 2]);
    expect(theirs.toArray()).toEqual([1, 2]);
  });
});
