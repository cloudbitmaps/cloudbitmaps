import {
  CloudRoaring,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
} from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { openGenerationReader } from '@/core/crbm-cold-source';
import { roaringCodec } from '@/roaring-codec';
import type { IColdDriver, SegmentRef } from '@/index';

/**
 * "The bit is physically gone from the bucket when the call returns" held for *current members* and quietly
 * did not for **ex-members** — the one population most likely to be asking.
 *
 * The lifecycle that produces it is the documented one, with no race: a re-seed stops including someone, and
 * `gcOrphanGenerations`' default `keep: 1` retains exactly the generation they were dropped from as the reader
 * grace window. The rewrite checked `currentGen` only, said `'not-member'`, and `eraseSubject` filtered the
 * segment out of the ledger — a clean receipt over bytes still in the bucket.
 */
const REF: SegmentRef = { namespace: 'audiences', segment: 'active-30d' };

async function heldIn(cold: MemoryColdDriver, generation: number, id: number): Promise<boolean> {
  const reader = await openGenerationReader(cold, { ...REF, generation }, undefined);
  const bytes = await reader.getChunk(0);
  return bytes === null ? false : roaringCodec.safeDeserialize(bytes, 1 << 20).has(id);
}

async function generations(cold: MemoryColdDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of cold.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe('erasure reaches an ex-member in a retained generation', () => {
  it('the ordinary re-seed lifecycle: dropped from the audience, then asks for erasure', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [5, 6, 7], { registry }); // day 1
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 1 }, [5, 6], { registry }); // day 2, 7 dropped
    await gcOrphanGenerations(REF, { cold, registry }); // the documented post-load call, default keep: 1
    expect(await generations(cold)).toEqual([0, 1]); // gen 0 retained as the grace window
    expect(await heldIn(cold, 0, 7)).toBe(true); // …and it still holds the ex-member

    const res = await eraseIdFromSegment(REF, 7, { cold, registry, codec: roaringCodec });
    expect(res.erased).toBe(true);
    expect(res.fromGeneration).toBe(0); // found in the retained generation, not the current one
    expect(res.generation).toBeUndefined(); // nothing was rewritten — there was nothing to rewrite
    expect(res.collected).toEqual([0]);
    expect(await generations(cold)).toEqual([1]); // physically gone
  });

  it('the ledger now lists the segment instead of filtering it out', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [5, 6, 7], { registry });
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 1 }, [5, 6], { registry });
    await gcOrphanGenerations(REF, { cold, registry });

    const store = new CloudRoaring({ cold, registry });
    const ledger = await store.eraseSubject(7, { namespace: 'audiences' });
    expect(ledger.erasedFrom).toHaveLength(1);
    expect(ledger.erasedFrom[0]).toMatchObject({ segment: 'active-30d', erased: true });
  });

  it('an id that was never in the segment is still `not-member`, and collects nothing', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [5, 6, 7], { registry });
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 1 }, [5, 6], { registry });
    await gcOrphanGenerations(REF, { cold, registry });

    const res = await eraseIdFromSegment(REF, 999, { cold, registry, codec: roaringCodec });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' });
    expect(res.collected).toEqual([]);
    expect(await generations(cold)).toEqual([0, 1]); // the grace window is NOT collapsed
  });

  it('a current member is unaffected — it still rewrites', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [5, 6, 7], { registry });

    const res = await eraseIdFromSegment(REF, 6, { cold, registry, codec: roaringCodec });
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect(res.collected).toEqual([0]);
  });

  it('the cheap filter: a segment with no superseded generations reads nothing extra', async () => {
    // This is what keeps a fleet-wide subject scan from doubling its reads on segments that never held the id.
    const real = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 0 }, [5, 6], { registry });

    let opens = 0;
    const cold: IColdDriver = {
      capabilities: () => real.capabilities(),
      getRange: (k, o, l) => real.getRange(k, o, l),
      delete: (k) => real.delete(k),
      list: (r) => real.list(r),
      putImmutable: (k, fn) => real.putImmutable(k, fn),
      getTail: (k, m) => {
        opens += 1;
        return real.getTail(k, m);
      },
    };

    const res = await eraseIdFromSegment(REF, 999, { cold, registry, codec: roaringCodec });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' });
    expect(opens).toBe(1); // the current generation only — no superseded generation to look in
  });

  it('a superseded generation swept mid-scan is the outcome we wanted, not a failure', async () => {
    const real = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 0 }, [5, 6, 7], { registry });
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 1 }, [5, 6], { registry });

    let fired = false;
    const cold: IColdDriver = {
      capabilities: () => real.capabilities(),
      getRange: (k, o, l) => real.getRange(k, o, l),
      delete: (k) => real.delete(k),
      list: (r) => real.list(r),
      putImmutable: (k, fn) => real.putImmutable(k, fn),
      getTail: async (k, m) => {
        if (k.generation === 0 && !fired) {
          fired = true;
          await real.delete({ ...REF, generation: 0 }); // a concurrent collector got there first
        }
        return real.getTail(k, m);
      },
    };

    const res = await eraseIdFromSegment(REF, 7, { cold, registry, codec: roaringCodec });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' }); // nothing left holding it
    expect(await generations(real)).toEqual([1]);
  });

  it('a real fault while scanning is NOT swallowed into a clean receipt', async () => {
    const real = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 0 }, [5, 6, 7], { registry });
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 1 }, [5, 6], { registry });

    const cold: IColdDriver = {
      capabilities: () => real.capabilities(),
      getRange: (k, o, l) => real.getRange(k, o, l),
      delete: (k) => real.delete(k),
      list: (r) => real.list(r),
      putImmutable: (k, fn) => real.putImmutable(k, fn),
      getTail: (k, m) =>
        k.generation === 0
          ? Promise.reject(new Error('cold storage unavailable'))
          : real.getTail(k, m),
    };

    await expect(
      eraseIdFromSegment(REF, 7, { cold, registry, codec: roaringCodec }),
    ).rejects.toThrow('cold storage unavailable');
  });
});
