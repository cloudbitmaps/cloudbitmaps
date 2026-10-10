import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import type { SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { CountingObjectStore } from '../helpers/counting';

/**
 * What an erasure on a segment with no generation yet costs at the store a registry is over, the way a request is
 * billed: the registry requests it makes, counted at an object-store registry. With no object to delete it reads the
 * row once and writes nothing. With objects to delete it adds the read its renewal is made against, the renewal's
 * conditional write and the read the registry makes for that write's version, and one read of the row before each
 * delete. A second run, with nothing left, is back to the one read.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 's' };
const X = 9;

function world() {
  const storage = new MemoryStorageDriver();
  const store = new CountingObjectStore(0, { conditionalDelete: true });
  let t = 1_000;
  const registry = new ObjectStoreRegistry(store, 'p', () => (t += 1));
  const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
  const deps = { storage, registry, codec: roaringCodec, keystore };
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
    'with %i objects to delete: the renewal, a read before each delete, and nothing on the next run',
    async (n) => {
      const w = world();
      await w.registry.create(REF, { currentGen: null });
      for (let g = 0; g < n; g++) await w.crashed(g);
      expect(await w.counted(() => eraseIdFromSegment(REF, X, w.deps))).toEqual({
        reads: 3 + n,
        writes: 1,
      });
      expect(await w.counted(() => eraseIdFromSegment(REF, X, w.deps))).toEqual({
        reads: 1,
        writes: 0,
      });
    },
  );
});
