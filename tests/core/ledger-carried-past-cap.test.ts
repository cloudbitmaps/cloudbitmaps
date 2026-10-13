import { carriesWindow, windowOf } from '@/core/known-generations';
import { loadSegment } from '@/core/load';
import type { RegistryRecord, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';

/**
 * A ledger carried through many publishes whose `keep` is above what a row records (what `*Into` and `materializeMany`
 * publish with) names up to 128 generations by recency. A load with a small `keep` after it must not read those names
 * as the whole window: it would delete only them, and leave the older generations until a periodic listing. So a ledger
 * naming more than 64 generations below the pointer is not collected from by name: the load writes the window it draws
 * from the ledger's order, the leased entries and the entries a rollback left above its number, and collects by
 * listing, counting the ledger's names first. A release before ledgers recorded no list after a `keep` above 64, so
 * that load collects everything beyond its keep: after 200 such publishes and one `keep: 1` load, two objects remain.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

describe.each([129, 200])(
  'after %i publishes with a keep above 64, then one load with keep 1',
  (n) => {
    it('collects by count and leaves the superseded generation and the new one, as a release before ledgers did', async () => {
      const memory = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      const calls: Record<string, number> = {};
      const storage = counting(memory, calls);
      const deps = { storage, registry, codec: roaringCodec };
      for (let i = 0; i < n; i++) {
        await loadSegment(SEG, [i], deps, { keep: Number.MAX_SAFE_INTEGER });
      }
      for (const k of Object.keys(calls)) delete calls[k];
      const r = await loadSegment(SEG, [n], deps, { keep: 1 });
      expect(r.generation).toBe(n);
      const left: number[] = [];
      for await (const k of memory.list(SEG)) left.push(k.generation);
      expect(left.sort((a, b) => a - b)).toEqual([n - 1, n]);
      // One listing, the collection's, as a release before ledgers made: the ledger is not seeded again (a seed would add a
      // second listing, as the earlier build made); the bucket is the same.
      expect(calls.list).toBe(1);
      // And the ledger it wrote is the window it kept.
      expect(windowOf((await registry.get(SEG))!)).toEqual([n - 1]);
    });
  },
);

describe('a ledger with many names below the pointer', () => {
  const row = (below: number): RegistryRecord => {
    const known = Array.from({ length: below + 1 }, (_, g) => ({ generation: g, footerCrc: 1 }));
    return { currentGen: below, status: 'active', knownGens: known } as unknown as RegistryRecord;
  };
  it('is a window at 64 names and not at 65', () => {
    // Main: windowOf(row(65)) was undefined. The more-than-64 rule moved to carriesWindow, which counts names no lease holds.
    expect(windowOf(row(64))).toHaveLength(64);
    expect(carriesWindow(row(64), new Set())).toBe(true);
    expect(carriesWindow(row(65), new Set())).toBe(false);
  });
});
