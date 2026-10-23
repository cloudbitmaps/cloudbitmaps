import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import type { SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { storeCodec } from '../helpers/store-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { CountingObjectStore, counting } from '../helpers/counting';
import { testEntropy } from '../helpers/entropy';

/**
 * What an erasure on a segment with no generation yet costs at the store a registry is over, the way a request is
 * billed: the registry requests it makes, counted at an object-store registry. With no object to delete it reads the
 * row once and writes nothing. With objects to delete it adds the read its renewal is made against, the renewal's
 * conditional write and the read the registry makes for that write's version, one read of the row before each delete,
 * and one after the last. A second run, with nothing left, is back to the one read. Objects it found clean beside them
 * cost no registry read: each is opened again after its last listing of the bucket, since on a row with no pointer
 * there is neither a generation it found current nor a rewrite of its own, the only two it can skip.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 's' };
const X = 9;

function world() {
  const storage = new MemoryStorageDriver();
  const store = new CountingObjectStore(0, { conditionalDelete: true });
  let t = 1_000;
  const registry = new ObjectStoreRegistry(store, 'p', () => (t += 1));
  const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
  const deps = { storage, registry, entropy: testEntropy, codec: storeCodec, keystore };
  const counted = async (run: () => Promise<unknown>) => {
    const reads = store.reads;
    const writes = store.writes;
    await run();
    return { reads: store.reads - reads, writes: store.writes - writes };
  };
  /** A first load's object that crashed before its publish, sealed under a key it made and never stored. */
  const crashed = (generation: number) =>
    bulkLoadCrbmGeneration(storage, { ...REF, generation }, [X], {
      registry: new MemoryRegistryDriver(),
      keystore,
      publish: false,
    });
  return { storage, registry, deps, counted, crashed };
}

describe("an erasure's registry requests on a segment with no generation yet", () => {
  it('with no object to delete: one read, no write', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    expect(await w.counted(() => eraseIdFromSegment(REF, X, w.deps))).toEqual({
      reads: 1,
      writes: 0,
    });
  });

  it.each([1, 3])(
    'with %i objects to delete: the renewal, a read before each delete and one after the last, and nothing on the next run',
    async (n) => {
      const w = world();
      await w.registry.create(REF, { currentGen: null });
      for (let g = 0; g < n; g++) await w.crashed(g);
      expect(await w.counted(() => eraseIdFromSegment(REF, X, w.deps))).toEqual({
        reads: 4 + n,
        writes: 1,
      });
      expect(await w.counted(() => eraseIdFromSegment(REF, X, w.deps))).toEqual({
        reads: 1,
        writes: 0,
      });
    },
  );

  it('with an object it found clean beside one to delete: no registry read more, and that object opened again', async () => {
    const w = world();
    await w.registry.create(REF, { currentGen: null });
    await w.crashed(0);
    // A first load's cleartext object without the id, which the call searches and finds clean.
    await bulkLoadCrbmGeneration(w.storage, { ...REF, generation: 1 }, [1, 2], {
      registry: new MemoryRegistryDriver(),
      publish: false,
    });
    const calls: Record<string, number> = {};
    const deps = { ...w.deps, storage: counting(w.storage, calls) };
    // The renewal, a read before the one delete and one after it: the receipt reads no row, since nothing it could skip
    // is listed.
    expect(await w.counted(() => eraseIdFromSegment(REF, X, deps))).toEqual({
      reads: 4 + 1,
      writes: 1,
    });
    // The search reads the sealed object's tail twice (its open, then its footer alone) and the clean one's once; the
    // receipt reads the clean one's again.
    expect(calls.getTail).toBe(4);
  });
});
