import {
  CloudRoaring,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { SegmentRef } from '@/index';

/**
 * A generation number is not an identity. `nextGeneration` returns `max(currentGen, highest object) + 1`, so it
 * **restarts at 0** once the registry row is purged and the bucket emptied — the same fact that refuted two
 * `minAgeMs` designs. A retired, re-created name then serves different data at the same `currentGen`, and a
 * long-lived store could not tell the two apart at either layer it caches:
 *
 *   - the resolved snapshot compared generation NUMBERS, so it was never refreshed; and
 *   - the decoded-chunk cache keyed on `(segment, chunk, generation)`, so it collided.
 *
 * Both had to be fixed: refreshing the reader alone left the chunk cache serving the dead incarnation. Note
 * this is also why putting the incarnation in the *object key* would not have been enough — the new incarnation
 * still starts at generation 0, so the cache key collides either way.
 *
 * The workflow is one the guide teaches: dated or rotating segment names under a retention policy, swept and
 * re-loaded each cycle.
 */
const REF: SegmentRef = { segment: 's' };

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/** Retire the segment completely (objects deleted, row purged) and re-load the same name. */
async function reincarnate(
  cold: MemoryColdDriver,
  registry: MemoryRegistryDriver,
  ids: readonly number[],
): Promise<void> {
  for await (const k of cold.list(REF)) await cold.delete(k);
  await registry.delete(REF);
  await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, ids, { registry });
}

describe('a re-created name is a different segment, not the same one', () => {
  it('a warm store stops serving the previous incarnation', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({ cold, registry, clock, coldGenTtlMs: 10 });
    expect(await store.segment('s').has(1)).toBe(true); // warms the snapshot AND chunk 0

    await reincarnate(cold, registry, [9]);
    t += 100; // past the TTL

    expect(await store.segment('s').has(1)).toBe(false); // the deleted incarnation's id
    expect(await store.segment('s').has(9)).toBe(true); // the live one's
    expect(await store.segment('s').count()).toBe(1);
    expect(await collect(store.segment('s').iterate())).toEqual([9]);
  });

  it('the index-only path (count) sees it too — it reads the reader, not a chunk', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({ cold, registry, clock, coldGenTtlMs: 10 });
    expect(await store.segment('s').count()).toBe(3);

    await reincarnate(cold, registry, [9]);
    t += 100;
    expect(await store.segment('s').count()).toBe(1);
  });

  it('an ordinary publish still refreshes — the common case is unchanged', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({ cold, registry, clock, coldGenTtlMs: 10 });
    expect(await store.segment('s').count()).toBe(3);

    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 1 }, [1, 2, 3, 4], { registry });
    t += 100;
    expect(await store.segment('s').count()).toBe(4);
  });

  it('a fresh store was always right — this was purely stale state', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await reincarnate(cold, registry, [9]);

    const fresh = new CloudRoaring({ cold, registry });
    expect(await fresh.segment('s').count()).toBe(1);
    expect(await fresh.segment('s').has(1)).toBe(false);
  });

  it('the version string separates incarnations at the same generation number', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const { CrbmColdChunkSource } = await import('@/index');
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const source = new CrbmColdChunkSource(cold, { registry });
    const before = await source.currentVersion(REF);
    expect(await source.currentGeneration(REF)).toBe(0);

    await reincarnate(cold, registry, [9]);
    const after = await new CrbmColdChunkSource(cold, { registry }).currentVersion(REF);
    expect(await source.currentGeneration(REF)).toBe(0); // the NUMBER is identical…
    expect(after).not.toBe(before); // …the version is not
  });

  it('a registry-less source has no incarnation to confuse, and says so', async () => {
    const cold = new MemoryColdDriver();
    const { CrbmColdChunkSource } = await import('@/index');
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], {});

    const source = new CrbmColdChunkSource(cold, {});
    expect(await source.currentVersion(REF)).toBe('0'); // the generation alone
  });

  it('a segment with no generation has no version', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const { CrbmColdChunkSource } = await import('@/index');
    expect(await new CrbmColdChunkSource(cold, { registry }).currentVersion(REF)).toBeNull();
  });
});
