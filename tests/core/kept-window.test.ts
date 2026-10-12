import fc from 'fast-check';
import { keptWindow, nextKnown } from '@/core/known-generations';
import type { RegistryRecord } from '@/core/ports';

/**
 * The one rule for which generations below a new pointer a load keeps: the generation its publish superseded first,
 * when it is among them, then the newest of the rest by number, `keep` in all. The by-name window (`nextKnown`) and the
 * listing pass both take it from here.
 */

describe('keptWindow', () => {
  it.each([
    // The loading guide's worked example: 0 to 3 below the new pointer, 1 the generation a rollback restored.
    { below: [0, 1, 2, 3], superseded: 1, keep: 1, kept: [1], evict: [0, 2, 3] },
    { below: [0, 1, 2, 3], superseded: 1, keep: 2, kept: [1, 3], evict: [0, 2] },
    { below: [0, 1, 2, 3], superseded: 1, keep: 3, kept: [1, 2, 3], evict: [0] },
    { below: [0, 1, 2, 3], superseded: 0, keep: 2, kept: [0, 3], evict: [1, 2] },
    // The superseded generation is the newest: the window is the newest `keep`, as it always was.
    { below: [0, 1, 2, 3], superseded: 3, keep: 2, kept: [2, 3], evict: [0, 1] },
    // Not among them (its object is gone, or no generation was superseded): the newest `keep`.
    { below: [0, 2, 3], superseded: 1, keep: 2, kept: [2, 3], evict: [0] },
    { below: [0, 2, 3], superseded: undefined, keep: 2, kept: [2, 3], evict: [0] },
    // `keep: 0` keeps nothing, the superseded generation included.
    { below: [0, 1, 2, 3], superseded: 1, keep: 0, kept: [], evict: [0, 1, 2, 3] },
    // A `keep` at least as wide as what is there keeps all of it.
    { below: [0, 1, 2], superseded: 1, keep: 3, kept: [0, 1, 2], evict: [] },
    { below: [0, 1, 2], superseded: 1, keep: Number.MAX_SAFE_INTEGER, kept: [0, 1, 2], evict: [] },
    { below: [], superseded: 1, keep: 1, kept: [], evict: [] },
  ])(
    'below $below, superseded $superseded, keep $keep: keeps $kept',
    ({ below, superseded, keep, kept, evict }) => {
      expect(keptWindow(below, superseded, keep)).toEqual({ kept, evict });
    },
  );

  it('answers ascending whatever order it is given, and does not touch its input', () => {
    const below = Object.freeze([3, 0, 2, 1]);
    expect(keptWindow(below, 1, 2)).toEqual({ kept: [1, 3], evict: [0, 2] });
    expect(below).toEqual([3, 0, 2, 1]);
  });

  it('splits what it is given in two: `keep` kept, the superseded one among them, and the rest evicted (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat(200), { maxLength: 40 }),
        fc.option(fc.nat(200), { nil: undefined }),
        fc.nat(45),
        (below, superseded, keep) => {
          const { kept, evict } = keptWindow(below, superseded, keep);
          const asc = [...below].sort((a, b) => a - b);
          // A partition of what it was given, both halves ascending.
          expect([...kept, ...evict].sort((a, b) => a - b)).toEqual(asc);
          expect(kept).toEqual([...kept].sort((a, b) => a - b));
          expect(evict).toEqual([...evict].sort((a, b) => a - b));
          expect(kept).toHaveLength(Math.min(keep, below.length));
          const there = superseded !== undefined && below.includes(superseded);
          if (keep >= 1 && there) expect(kept).toContain(superseded);
          // Every other generation kept is newer than every one evicted, the superseded one aside.
          const others = kept.filter((g) => !there || g !== superseded);
          for (const g of others) for (const e of evict) expect(g).toBeGreaterThan(e);
        },
      ),
    );
  });
});

describe('nextKnown takes its window from the same rule', () => {
  /** A row at `currentGen` whose ledger holds `known` (numbers, oldest first) and then the current generation. */
  const row = (currentGen: number, known: number[]): RegistryRecord =>
    ({
      currentGen,
      knownGens: [...known, currentGen].map((generation) => ({
        generation,
        footerCrc: generation,
      })),
      token: 't',
      status: 'active',
    }) as unknown as RegistryRecord;

  it.each([
    { keep: 1, list: [4], evict: [1, 3] },
    { keep: 2, list: [3, 4], evict: [1] },
    { keep: 3, list: [1, 3, 4], evict: [] },
    { keep: 0, list: [], evict: [1, 3, 4] },
  ])('over a row at 4 that keeps [1, 3], keep $keep writes $list', ({ keep, list, evict }) => {
    const after = nextKnown(row(4, [1, 3]), 5, 5, keep);
    expect({ list: after.list, evict: after.evict }).toEqual({ list, evict });
    // The ledger is the window's entries, in the order they were made current, and the new generation last.
    expect(after.known.map((e) => e.generation)).toEqual([...list, 5]);
  });
});
