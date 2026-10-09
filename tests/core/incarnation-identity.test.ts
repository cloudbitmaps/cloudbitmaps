import { MemoryStorage, CloudRoaring } from '@/index';
import type { SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { MemoryStorageDriver } from '@/drivers/memory';
import { brandAsBackend, type IRegistryDriver, type IStorageDriver } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { CountingObjectStore } from '../helpers/counting';

/**
 * A generation number is not an identity. `nextGeneration` returns `max(currentGen, highest object) + 1`, so it
 * **restarts at 0** once the registry row is purged and the bucket emptied. A retired, re-created name then
 * serves different data at the same `currentGen`, and a long-lived store that goes by the number cannot tell
 * the two apart at either layer it caches:
 *
 *   - a resolved snapshot compared by generation NUMBER is never refreshed; and
 *   - a decoded-chunk cache keyed on `(segment, chunk, generation)` collides.
 *
 * Both layers need the incarnation: refreshing the reader alone leaves the chunk cache serving the dead
 * incarnation. Note this is also why putting the incarnation in the *object key* would not be enough — the new
 * incarnation still starts at generation 0, so the cache key collides either way.
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
  storage: IStorageDriver,
  registry: IRegistryDriver,
  ids: readonly number[],
): Promise<void> {
  for await (const k of storage.list(REF)) await storage.delete(k);
  await registry.delete(REF);
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, ids, { registry });
}

describe('a re-created name is a different segment, not the same one', () => {
  it('a warm store stops serving the previous incarnation', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({
      storage: backend,
      cache: { genTtlMs: 10 },
      seams: { clock },
    });
    expect(await store.segment('s').has(1)).toBe(true); // warms the snapshot AND chunk 0

    await reincarnate(storage, registry, [9]);
    t += 100; // past the TTL

    expect(await store.segment('s').has(1)).toBe(false); // the deleted incarnation's id
    expect(await store.segment('s').has(9)).toBe(true); // the live one's
    expect(await store.segment('s').count()).toBe(1);
    expect(await collect(store.segment('s').iterate())).toEqual([9]);
  });

  it('the index-only path (count) sees it too — it reads the reader, not a chunk', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({
      storage: backend,
      cache: { genTtlMs: 10 },
      seams: { clock },
    });
    expect(await store.segment('s').count()).toBe(3);

    await reincarnate(storage, registry, [9]);
    t += 100;
    expect(await store.segment('s').count()).toBe(1);
  });

  it('an ordinary publish refreshes too — the common case', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const store = new CloudRoaring({
      storage: backend,
      cache: { genTtlMs: 10 },
      seams: { clock },
    });
    expect(await store.segment('s').count()).toBe(3);

    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, [1, 2, 3, 4], { registry });
    t += 100;
    expect(await store.segment('s').count()).toBe(4);
  });

  it('a fresh store reads the new incarnation — the hazard is purely stale state', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    await reincarnate(storage, registry, [9]);

    const fresh = new CloudRoaring({ storage: backend });
    expect(await fresh.segment('s').count()).toBe(1);
    expect(await fresh.segment('s').has(1)).toBe(false);
  });

  it('the version string separates incarnations at the same generation number', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const { CrbmStorageChunkSource } = await import('@/index');
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const source = new CrbmStorageChunkSource(storage, { registry });
    const before = await source.currentVersion(REF);
    expect(await source.currentGeneration(REF)).toBe(0);

    await reincarnate(storage, registry, [9]);
    const after = await new CrbmStorageChunkSource(storage, { registry }).currentVersion(REF);
    expect(await source.currentGeneration(REF)).toBe(0); // the NUMBER is identical…
    expect(after).not.toBe(before); // …the version is not
  });

  it('a registry-less source has no row token, so its version is the generation and the object', async () => {
    const storage = new MemoryStorageDriver();
    const { CrbmStorageChunkSource } = await import('@/index');
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], {});

    const source = new CrbmStorageChunkSource(storage, {});
    const version = await source.currentVersion(REF);
    expect(version).toMatch(/^0#\d+:\d+$/); // the generation, then the object's size and footer checksum

    // The same name purged and loaded again out of band starts again at 0: another object, another version.
    await storage.delete({ ...REF, generation: 0 });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [9], {});
    const after = await new CrbmStorageChunkSource(storage, {}).currentVersion(REF);
    expect(after).toMatch(/^0#/);
    expect(after).not.toBe(version);
  });

  it('a segment with no generation has no version', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    const { CrbmStorageChunkSource } = await import('@/index');
    expect(await new CrbmStorageChunkSource(storage, { registry }).currentVersion(REF)).toBeNull();
  });
});

/**
 * The same hazard once nothing of the earlier row is left: its object removed outright, as a hard purge or a
 * lifecycle rule removes it, rather than tombstoned. With no tombstone there is no counter to continue, and a
 * counter-only token restarted where the first incarnation's had, so a warm reader at the same generation took the
 * new row for the old one and kept serving the deleted ids. The incarnation id drawn at create is what tells them
 * apart now.
 */
describe('a re-created name whose earlier row is gone entirely', () => {
  it('a warm store stops serving the previous incarnation', async () => {
    const store = new CountingObjectStore(0);
    const registry = new ObjectStoreRegistry(store, undefined, () => 1);
    const storage = new MemoryStorageDriver();
    const backend = brandAsBackend({ storage, registry });
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const roaring = new CloudRoaring({
      storage: backend,
      cache: { genTtlMs: 10 },
      seams: { clock },
    });
    expect(await roaring.segment('s').has(1)).toBe(true); // warms the snapshot AND chunk 0

    for await (const k of storage.list(REF)) await storage.delete(k);
    store.remove(registryObjectKey(undefined, REF)); // no tombstone left behind
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [9], { registry });
    t += 100; // past the TTL

    expect(await roaring.segment('s').has(1)).toBe(false);
    expect(await roaring.segment('s').has(9)).toBe(true);
    expect(await collect(roaring.segment('s').iterate())).toEqual([9]);
  });
});

/**
 * A registry restored from a backup is back at an older row, and its counter with it. The bucket restored beside it
 * has lost the generation written after the backup, so the next load writes that number again, with other ids. A
 * counter alone gave that publish the token the lost one had, and a warm store kept serving the lost generation's
 * ids from its cache, keyed `<generation>:<token>`. Every write now draws its own part of the token.
 */
describe('a registry restored from a backup', () => {
  it('a warm store does not serve the generation the restore took away', async () => {
    const store = new CountingObjectStore(0);
    const registry = new ObjectStoreRegistry(store, undefined, () => 1);
    const storage = new MemoryStorageDriver();
    const backend = brandAsBackend({ storage, registry });
    const rowKey = registryObjectKey(undefined, REF);
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    const backup = store.text(rowKey)!;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, [4, 5], { registry });

    const roaring = new CloudRoaring({
      storage: backend,
      cache: { genTtlMs: 10 },
      seams: { clock },
    });
    expect(await roaring.segment('s').has(4)).toBe(true); // warms generation 1 and its chunk 0

    // The disaster: the bucket and the registry come back as they were at the backup.
    await storage.delete({ ...REF, generation: 1 });
    store.plant(rowKey, backup);
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 1 }, [7], { registry });
    t += 100; // past the TTL

    expect(await roaring.segment('s').has(4)).toBe(false);
    expect(await roaring.segment('s').has(7)).toBe(true);
    expect(await collect(roaring.segment('s').iterate())).toEqual([7]);
  });
});
