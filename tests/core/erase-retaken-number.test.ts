import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IRegistryDriver, IStorageDriver } from '@/index';
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
