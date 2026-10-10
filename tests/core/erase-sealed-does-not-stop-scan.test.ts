import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

const REF: SegmentRef = { segment: 's' };
const X = 9;

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe('a sealed holder does not stop the search of the older generations below the pointer', () => {
  it('a sealed object newest below the pointer, many clean ones, and the id in the oldest', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { storage, registry, codec: roaringCodec, keystore };
    await loadSegment(REF, [1, X], deps, { keep: 9 });
    for (let i = 0; i < 6; i++) await loadSegment(REF, [1, 2], deps, { keep: 9 }); // 1..6; 6 current
    await storage.delete({ ...REF, generation: 5 });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 5 }, [X], {
      registry: new MemoryRegistryDriver(),
      keystore,
      publish: false,
    });
    const out = await eraseIdFromSegment(REF, X, deps);
    expect(out).toMatchObject({ erased: true });
    expect(await generations(storage)).toEqual([6]);
  });
});
