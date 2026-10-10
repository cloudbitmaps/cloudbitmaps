import { eraseIdFromSegment } from '@/core/erase-id';
import { WriteConflictError } from '@/core/errors';
import { destroySegment } from '@/core/erasure';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

const REF: SegmentRef = { segment: 's' };

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}
async function tombstone(ids: number[][]) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  for (const [g, set] of ids.entries()) {
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: g }, set, { registry });
  }
  await destroySegment(REF, { registry }, { confirmSegment: 's', allowCleartext: true });
  return { storage, registry };
}

describe('an erasure under a tombstone, with several objects', () => {
  it('every generation under the tombstone holding the id goes, the newest included', async () => {
    const w = await tombstone([
      [1, 2],
      [1, 2],
      [2, 3],
    ]);
    const out = await eraseIdFromSegment(REF, 2, { ...w, codec: roaringCodec });
    expect(out).toMatchObject({ erased: true, fromGeneration: 2, collected: [0, 1, 2] });
    expect(await generations(w.storage)).toEqual([]);
  });

  it('a holder the collection could not remove is a WriteConflictError, not erased: true', async () => {
    const w = await tombstone([[1, 2]]);
    const st = Object.create(w.storage) as IStorageDriver;
    st.delete = async () => undefined;
    await expect(
      eraseIdFromSegment(REF, 2, { storage: st, registry: w.registry, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });
});
