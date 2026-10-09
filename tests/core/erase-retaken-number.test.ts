import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IRegistryDriver, IStorageDriver, StorageDeleteOptions } from '@/index';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import {
  REF,
  X,
  byFreeFunction,
  clock,
  raceStaleHolderDelete,
  type StalledErasure,
} from '../helpers/retaken-number-race';

/**
 * An erasure that decided to delete a holder above the pointer, and stalled, must not delete another object stored
 * under that number since: the race and its diagram are in `helpers/retaken-number-race.ts`. Run here over the
 * in-memory drivers, whose delete applies the version, through each way an erasure is run.
 */

/** `store.eraseSubject` over these drivers: one ledger entry, erased, with no note. */
async function throughStore(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  options: { budget?: { maxRequests: number } },
): Promise<() => void> {
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage, registry }),
    retry: false,
    seams: { clock },
  });
  const ledger = await store.eraseSubject(X, { allNamespaces: true, ...options });
  return () =>
    expect(ledger.erasedFrom).toEqual([{ segment: 's', erased: true, fromGeneration: 1 }]);
}

const runs: [string, StalledErasure][] = [
  ['eraseIdFromSegment', byFreeFunction],
  // The store charges the erasure's opens to its budget by wrapping the storage: the condition must pass through it.
  ['store.eraseSubject', (storage, registry) => throughStore(storage, registry, {})],
  [
    'store.eraseSubject with a budget',
    (storage, registry) => throughStore(storage, registry, { budget: { maxRequests: 1_000 } }),
  ],
];

describe('an erasure whose holder above the pointer is deleted and its number taken again before its own delete', () => {
  it.each(runs)(
    '%s: the stale delete does not take the generation the pointer now names',
    async (_, stalled) => {
      await raceStaleHolderDelete(new MemoryStorageDriver(), new MemoryRegistryDriver(), stalled);
    },
  );

  it('the delete it sends names the object it searched', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [1, 2, 3], deps);
    await loadSegment(REF, [1, 2, 3, X], deps);
    await rollbackSegment(REF, 0, deps);
    const searched = (await storage.getTail({ ...REF, generation: 1 }, 0)).version;
    expect(searched).toBeDefined();

    const sent: { key: GenKey; ifVersion: string | undefined }[] = [];
    const watched = Object.create(storage) as MemoryStorageDriver;
    watched.delete = async (key, options) => {
      sent.push({ key, ifVersion: options?.ifVersion });
      return storage.delete(key, options);
    };
    const erased = await eraseIdFromSegment(REF, X, { ...deps, storage: watched });
    expect(erased).toMatchObject({ erased: true, collected: [1] });
    expect(sent).toEqual([{ key: { ...REF, generation: 1 }, ifVersion: searched }]);
  });
});

/**
 * A storage driver that, before the `n`th delete it is asked for, deletes the object under that key and puts another
 * there holding `ids`: the number taken again between the erasure's search of a holder and its delete of it.
 */
function replacingBeforeDelete(storage: MemoryStorageDriver, n: number, ids: number[]) {
  const sent: number[] = [];
  const driver = Object.create(storage) as MemoryStorageDriver;
  driver.delete = async (key, options) => {
    sent.push(key.generation);
    if (sent.length === n) {
      await storage.delete(key);
      await bulkLoadCrbmGeneration(storage, key, ids, { codec: roaringCodec });
    }
    return storage.delete(key, options);
  };
  return { driver, sent };
}

describe('an erasure whose delete of a holder is refused for another object under the number', () => {
  it('with the row unchanged and the object now there still holding the id: superseded, not a failed delete', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [1, 2, 3], deps);
    await loadSegment(REF, [1, 2, 3, X], deps);
    await rollbackSegment(REF, 0, deps); // generation 1, above the pointer, holds X
    const before = await registry.get(REF);

    const { driver, sent } = replacingBeforeDelete(storage, 1, [X, 9]);
    const result = await eraseIdFromSegment(REF, X, { ...deps, storage: driver });

    expect(result).toMatchObject({
      erased: false,
      reason: 'superseded',
      fromGeneration: 1,
      collected: [],
    });
    expect(sent).toEqual([1]);
    // The row moved only by this call's own fence, and the object put under the number since is in the bucket.
    expect((await registry.get(REF))?.currentGen).toBe(before?.currentGen);
    expect(await idsAt(storage, 1)).toEqual([9, X]);
  });

  it('with several holders: the deletes stop at the first refused one, and what was deleted before it is reported', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [1, 2, 3], deps, { keep: 9 });
    await loadSegment(REF, [1, 2, 3, X], deps, { keep: 9 }); // 1
    await loadSegment(REF, [1, 2, 3, X, 4], deps, { keep: 9 }); // 2
    await loadSegment(REF, [1, 2, 3, X, 5], deps, { keep: 9 }); // 3
    await rollbackSegment(REF, 0, deps); // 1, 2 and 3 above the pointer, each holding X

    // Newest first: 3 is deleted, 2 is replaced before its delete, and 1 is never asked for.
    const { driver, sent } = replacingBeforeDelete(storage, 2, [X, 6]);
    const result = await eraseIdFromSegment(REF, X, { ...deps, storage: driver });

    expect(result).toMatchObject({ erased: false, reason: 'superseded', collected: [3] });
    expect(sent).toEqual([3, 2]);
    expect(await generationsOf(storage)).toEqual([0, 1, 2]);
    expect(await idsAt(storage, 2)).toEqual([6, X]);
    expect(await idsAt(storage, 1)).toEqual([1, 2, 3, X]);
  });
});

describe('an erasure over a storage driver that reports no version', () => {
  /** The in-memory driver with its versions withheld: what a driver that has none answers. */
  function versionless(storage: MemoryStorageDriver) {
    const sent: { generation: number; options: StorageDeleteOptions | undefined }[] = [];
    const driver = Object.create(storage) as MemoryStorageDriver;
    driver.getTail = async (key, maxBytes) => {
      const { bytes, size } = await storage.getTail(key, maxBytes);
      return { bytes, size };
    };
    driver.delete = async (key, options) => {
      sent.push({ generation: key.generation, options });
      return storage.delete(key, options);
    };
    return { driver, sent };
  }

  it('sends its delete with no version, and the delete removes the holder', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [1, 2, 3], deps);
    await loadSegment(REF, [1, 2, 3, X], deps);
    await rollbackSegment(REF, 0, deps);

    const { driver, sent } = versionless(storage);
    const result = await eraseIdFromSegment(REF, X, { ...deps, storage: driver });
    expect(result).toMatchObject({ erased: true, collected: [1] });
    expect(sent).toEqual([{ generation: 1, options: { ifVersion: undefined } }]);
    expect(await generationsOf(storage)).toEqual([0]);
  });

  it('through store.eraseSubject with no budget, which hands the erasure the driver itself', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [1, 2, 3], deps);
    await loadSegment(REF, [1, 2, 3, X], deps);
    await rollbackSegment(REF, 0, deps);

    const { driver, sent } = versionless(storage);
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: driver, registry }),
      retry: false,
      seams: { clock },
    });
    const ledger = await store.eraseSubject(X, { allNamespaces: true, budget: false });
    expect(ledger.erasedFrom).toEqual([{ segment: 's', erased: true, fromGeneration: 1 }]);
    expect(sent).toEqual([{ generation: 1, options: { ifVersion: undefined } }]);
    expect(await generationsOf(storage)).toEqual([0]);
  });
});

async function generationsOf(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

async function idsAt(storage: IStorageDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(storage, { ...REF, generation }, undefined);
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray()) {
      out.push(chunkKey * 65_536 + r);
    }
  }
  return out.sort((a, b) => a - b);
}
