import { gcOrphanGenerations, nextGeneration } from '@/core/generation-gc';
import { MemoryColdDriver, MemoryRegistryDriver, bulkLoadCrbmGeneration } from '@/index';
import type { GenKey, IColdDriver, SegmentRef } from '@/index';

/**
 * A tombstone read before the listing, acted on after it.
 *
 * `gcOrphanGenerations` treats a `destroyed` segment as entirely garbage and deletes every generation it
 * enumerates, `currentGen` included — correct, because a tombstoned segment resolves no generation, so no
 * reader is or can become pinned to one.
 *
 * The status comes from a row read *before* `cold.list()`, and the deletes happen *after* it. That window is
 * seconds wide on S3, where the listing is paginated. Every step of the sequence below is an ordinary in-repo
 * path: the retention sweep purges tombstone rows, and nothing stops a loader re-creating a segment by that
 * name afterwards. The result is the forbidden `missing-cold-generation` state — an `active` row pointing at a
 * generation whose object GC has just deleted — and neither `keep` nor `minAgeMs` applies, because the
 * destroyed branch is exempt from both.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

async function generations(cold: IColdDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const key of cold.list(SEG)) out.push(key.generation);
  return out.sort((a, b) => a - b);
}

/** A cold driver whose `list()` runs `during` after yielding its first key — the window under test. */
function coldWithRaceDuringList(inner: MemoryColdDriver, during: () => Promise<void>): IColdDriver {
  return new Proxy(inner, {
    get(target, prop, rx) {
      if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
      return async function* (ref: SegmentRef): AsyncIterable<GenKey> {
        let fired = false;
        for await (const key of inner.list(ref)) {
          yield key;
          if (!fired) {
            fired = true;
            await during();
          }
        }
      };
    },
  }) as IColdDriver;
}

describe('gcOrphanGenerations — a segment resurrected while GC is listing', () => {
  it('does not delete the new generation of a segment recreated mid-pass', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };

    await load([1]); // gen 0
    await load([1, 2]); // gen 1
    const tomb = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, tomb.token, { status: 'destroyed' });

    // The resurrection, fired after GC has read the tombstone and started listing: the sweep purges the row,
    // then a loader re-creates the segment and publishes a new generation.
    const resurrect = async (): Promise<void> => {
      const row = await registry.get(SEG);
      if (row !== null) await registry.delete(SEG);
      await load([7, 8, 9]);
    };

    const deleted = await gcOrphanGenerations(SEG, {
      cold: coldWithRaceDuringList(cold, resurrect),
      registry,
    });

    const row = await registry.get(SEG);
    expect(row?.status).toBe('active');
    const live = row!.currentGen!;
    // The object the live pointer names must still exist. Without the fence GC deletes every generation it
    // enumerated — including the one published during the listing — leaving `missing-cold-generation`.
    expect(await generations(cold)).toContain(live);
    expect(deleted).not.toContain(live);
  });

  it('refuses when the tombstone row is purged mid-pass, even before anything is recreated', async () => {
    // The sweep purges tombstone rows on its own schedule, so "row gone" is reachable without a
    // resurrection. Purged-and-idle is indistinguishable from purged-and-about-to-be-recreated, and the top
    // of `gcOrphanGenerations` already declines to act without an authoritative row — so this must refuse
    // rather than treat a missing row as permission.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]);
    await load([1, 2]);
    const rec = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });

    const purge = async (): Promise<void> => {
      const row = await registry.get(SEG);
      if (row !== null) await registry.delete(SEG);
    };

    const deleted = await gcOrphanGenerations(SEG, {
      cold: coldWithRaceDuringList(cold, purge),
      registry,
    });
    expect(deleted).toEqual([]);
    expect(await generations(cold)).toEqual([0, 1]);
  });

  it('an ORDINARY pass still collects when a publish lands mid-listing', async () => {
    // The fence is scoped to the destroyed branch on purpose. The ordinary branch needs no re-read — it
    // deletes strictly below the pointer it read, and the pointer only moves forward — and applying one there
    // would make routine GC refuse whenever a load happens to land during a listing, which on a busy segment
    // is most of the time. This is the test that says so.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]); // gen 0
    await load([1, 2]); // gen 1
    await load([1, 2, 3]); // gen 2 — current

    const publishDuring = async (): Promise<void> => {
      await load([4]); // gen 3 lands while GC is listing
    };

    const deleted = await gcOrphanGenerations(
      SEG,
      { cold: coldWithRaceDuringList(cold, publishDuring), registry },
      { keep: 0 },
    );
    // Generations below the pointer GC read (2) are collected; the one published mid-pass is untouched.
    expect([...deleted].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await generations(cold)).toEqual([2, 3]);
  });

  it('still collects everything on a tombstone that stays a tombstone', async () => {
    // The control. The fence must not cost the destroyed branch its whole purpose, which is that these
    // objects are billed forever and nothing else in the library would ever collect them.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]);
    await load([1, 2]);
    const rec = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });

    expect([...(await gcOrphanGenerations(SEG, { cold, registry }))].sort()).toEqual([0, 1]);
    expect(await generations(cold)).toEqual([]);
  });
});
