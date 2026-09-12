import {
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
} from '@/index';
import { openGenerationReader } from '@/core/crbm-cold-source';
import { setSegmentRetention } from '@/core/retention';
import { retireExpired } from '@/core/retention-sweep';
import type { IColdDriver, SegmentRef } from '@/index';

/**
 * `dropSegment` reports two different facts: what its sweep deleted, and what is still there. The sweep loop
 * stops once a pass deletes nothing, so **`generationsDeleted: []` is produced both by a segment that held
 * nothing and by one whose every `cold.delete` threw** — and only the second leaves data behind.
 *
 * Reading the first as "the segment was empty" and purging the row is unrecoverable: with no row,
 * `gcOrphanGenerations` has nothing to compare against and returns `[]`, the next sweep cannot enumerate a name
 * that has no row, and `dropSegment` takes its `'absent'` path. Expired data stays readable and billed, and
 * every path that could reclaim it is closed.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 's' };
const PAST = Date.parse('2020-01-01T00:00:00Z');

async function generations(cold: MemoryColdDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of cold.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A cold driver whose deletes always fail — a 403, a bucket policy, a throttle. */
function undeletable(real: MemoryColdDriver): IColdDriver {
  return {
    capabilities: () => real.capabilities(),
    getTail: (k, m) => real.getTail(k, m),
    getRange: (k, o, l) => real.getRange(k, o, l),
    list: (r) => real.list(r),
    putImmutable: (k, fn) => real.putImmutable(k, fn),
    delete: () => Promise.reject(new Error('AccessDenied')),
  };
}

describe('retireExpired distinguishes "deleted nothing" from "there was nothing"', () => {
  it('keeps the row when the objects survive, so the data stays reclaimable', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });

    const res = await retireExpired({ cold: undeletable(cold), registry }, { now: PAST + 1 });
    expect(res.retired).toBe(1);
    expect(res.entries[0]).toMatchObject({ action: 'retired' });
    // The residual is reported rather than hidden.
    expect(res.entries[0]!.result!.generationsRemaining).toEqual([0]);

    // The row SURVIVES — it is the tombstone, and it is what keeps the data reachable.
    const row = await registry.get(REF);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('destroyed');

    // And a later sweep can finish the job, because the row is still there to enumerate. The tombstone-purge
    // pass waits out its grace window first, so this is the sweep a day later, not the next one.
    const second = await retireExpired({ cold, registry }, { now: PAST + 48 * 3_600_000 });
    expect(second.tombstonesPurged).toBe(1);
    expect(await generations(cold)).toEqual([]);
    expect(await registry.get(REF)).toBeNull();
  });

  it('still purges the row for a name that genuinely held nothing', async () => {
    // The case the branch exists for: `setRetention` mints a row for any name, including a typo'd one, and
    // leaving a tombstone there would fence the name against every writer forever.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });

    const res = await retireExpired({ cold, registry }, { now: PAST + 1 });
    expect(res.entries[0]!.result!.generationsDeleted).toEqual([]);
    expect(res.entries[0]!.result!.generationsRemaining).toEqual([]);
    expect(await registry.get(REF)).toBeNull(); // the name is free again
  });

  it('an ordinary retirement is unaffected', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });

    const res = await retireExpired({ cold, registry }, { now: PAST + 1 });
    expect(res.retired).toBe(1);
    expect(res.entries[0]!.result!.generationsDeleted).toEqual([0]);
    expect(await generations(cold)).toEqual([]);
    expect((await registry.get(REF))!.status).toBe('destroyed'); // stamped, purged by a later pass
  });

  it('the data is NOT stranded: everything that could reclaim it still can', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });
    await retireExpired({ cold: undeletable(cold), registry }, { now: PAST + 1 });

    // A tombstoned row means EVERY generation is collectable — the row is what makes that true.
    expect(await gcOrphanGenerations(REF, { cold, registry })).toEqual([0]);
    expect(await generations(cold)).toEqual([]);
  });

  it('the expired object is genuinely still readable while it survives — this is the harm', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });
    await retireExpired({ cold: undeletable(cold), registry }, { now: PAST + 1 });

    const reader = await openGenerationReader(cold, { ...REF, generation: 0 }, undefined);
    expect(reader.totalCardinality).toBe(3); // still there, still billed — hence "reclaimable" matters
  });
});
