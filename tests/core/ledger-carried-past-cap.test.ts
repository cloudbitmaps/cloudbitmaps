import { windowOf } from '@/core/known-generations';
import { loadSegment } from '@/core/load';
import type { RegistryRecord, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';

/**
 * A ledger carried through many publishes whose `keep` is above what a row records (what `*Into` and `materializeMany`
 * publish with) names up to 128 generations by recency. A load with a small `keep` after it must not read those names as
 * the whole window: it would delete only them, and leave the older generations until a periodic listing. So a ledger
 * naming more than 64 generations below the pointer is a window that is not known, and the load seeds and collects by
 * count. A release before ledgers recorded no list after a `keep` above 64, so that load collects
 * everything beyond its keep: after 200 such publishes and one `keep: 1` load, two objects remain.
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
      // Two listings (the seed's and the collection's) where a release before ledgers made one; the bucket is the same.
      expect(calls.list).toBe(2);
      // And the ledger it wrote is the window it kept.
      expect(windowOf((await registry.get(SEG))!)).toEqual([n - 1]);
    });
  },
);

describe('windowOf over a ledger with many names below the pointer', () => {
  const row = (below: number): RegistryRecord => {
    const known = Array.from({ length: below + 1 }, (_, g) => ({ generation: g, footerCrc: 1 }));
    return { currentGen: below, status: 'active', knownGens: known } as unknown as RegistryRecord;
  };
  it('names 64 and not 65', () => {
    expect(windowOf(row(64))).toHaveLength(64);
    expect(windowOf(row(65))).toBeUndefined();
  });
});
