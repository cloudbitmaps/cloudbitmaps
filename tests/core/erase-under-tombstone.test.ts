import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { destroySegment } from '@/core/erasure';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A tombstone is not proof that nothing readable is left. A crypto-shred leaves objects no key opens, but a cleartext
 * destroy, a drop whose sweep left something, or a write that landed after it leaves objects anyone can read. An
 * erasure searches the cleartext objects under a tombstone, and when one holds the id the collection's tombstone pass
 * deletes them all: every generation under a tombstone is garbage.
 */
const REF: SegmentRef = { segment: 's' };

async function generations(storage: MemoryStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

async function cleartextTombstone() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], { registry });
  await destroySegment(REF, { registry }, { confirmSegment: 's', allowCleartext: true });
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}

describe('an erasure looks under a tombstone', () => {
  it('a cleartext object that holds the id is deleted, and the erasure says so', async () => {
    const w = await cleartextTombstone();
    expect((await w.registry.get(REF))?.status).toBe('destroyed');
    expect(await generations(w.storage)).toEqual([0]);

    expect(await eraseIdFromSegment(REF, 2, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 0,
      collected: [0],
    });
    expect(await generations(w.storage)).toEqual([]);
  });

  it("an id no object holds is 'destroyed' as before, and the objects are left", async () => {
    const w = await cleartextTombstone();
    expect(await eraseIdFromSegment(REF, 7, w.deps)).toMatchObject({
      erased: false,
      reason: 'destroyed',
    });
    expect(await generations(w.storage)).toEqual([0]);
  });

  it("an object sealed under a shredded key holds nothing readable: 'destroyed', no error", async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], {
      registry,
      keystore,
    });
    await destroySegment(REF, { registry }, { confirmSegment: 's' });
    expect(
      await eraseIdFromSegment(REF, 2, { storage, registry, keystore, codec: roaringCodec }),
    ).toMatchObject({ erased: false, reason: 'destroyed' });
  });

  it("eraseSubject's ledger shows the segment it erased under a tombstone", async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...REF, generation: 0 }, [1, 2, 3], {
      registry: backend.registry,
    });
    await destroySegment(
      REF,
      { registry: backend.registry },
      { confirmSegment: 's', allowCleartext: true },
    );
    const store = new CloudRoaring({ storage: backend });
    const ledger = await store.eraseSubject(2, { allNamespaces: true });
    expect(ledger.erasedFrom).toEqual([expect.objectContaining({ segment: 's', erased: true })]);
  });
});
