import { afterEach, describe, expect, it, vi } from 'vitest';
import * as containers from '@/ts-roaring/containers';
import { TsBitmap } from '@/ts-roaring/bitmap';

vi.mock('@/ts-roaring/containers', async (original) => {
  const real = await original<typeof import('@/ts-roaring/containers')>();
  return { ...real, containerAddSorted: vi.fn(real.containerAddSorted) };
});

/**
 * Which way `addMany` puts a key's group into a container the bitmap already holds: a group of up to four ids goes in
 * id by id, five or more are built into a container and merged. The result is the same either way, so the way taken
 * is read from a count of the one-by-one writes.
 */
const added = vi.mocked(containers.containerAddSorted);
afterEach(() => added.mockClear());

/** A bitmap holding key 0 as an array, and `ids` more low halves added to it in one call. */
function addGroup(kind: 'array' | 'bitset' | 'run', ids: number): TsBitmap {
  const held =
    kind === 'array'
      ? Array.from({ length: 100 }, (_, i) => 3 * i)
      : kind === 'bitset'
        ? Array.from({ length: 6000 }, (_, i) => 2 * i)
        : Array.from({ length: 40 }, (_, i) => 100 + i);
  const b = TsBitmap.empty();
  b.addMany(held);
  if (kind === 'run') b.optimize();
  added.mockClear();
  b.addMany(Array.from({ length: ids }, (_, i) => 20_001 + 2 * i));
  return b;
}

describe('the size of a group that goes in id by id', () => {
  for (const kind of ['array', 'bitset', 'run'] as const) {
    for (const [ids, oneByOne] of [
      [1, true],
      [2, true],
      [4, true],
      [5, false],
      [6, false],
      [40, false],
    ] as const) {
      it(`${ids} ids into a ${kind}: ${oneByOne ? 'one by one' : 'built and merged'}`, () => {
        const b = addGroup(kind, ids);
        expect(added).toHaveBeenCalledTimes(oneByOne ? 1 : 0);
        expect(b.has(20_001 + 2 * (ids - 1))).toBe(true);
      });
    }
  }

  it('a group of four counts its duplicates, and a group in a key not yet held is never one by one', () => {
    const b = TsBitmap.empty();
    b.addMany([1, 2]);
    added.mockClear();
    b.addMany([5, 5, 5, 5]);
    expect(added).toHaveBeenCalledTimes(1);
    b.addMany([65_536 + 1]);
    expect(added).toHaveBeenCalledTimes(1);
  });
});
