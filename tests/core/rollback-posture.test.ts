import { randomBytes } from 'node:crypto';
import { rollbackSegment } from '@/core/rollback';
import { aadFor } from '@/core/crypto';
import { IntegrityError } from '@/core/errors';
import { nextGeneration } from '@/core/generation-gc';
import { InProcessKeystore, NodeAead } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IKeystore, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { writeCrbm } from '../helpers/crbm-v1_1';

/**
 * A rollback refuses a target that is not what the row says the segment is, from one read of the target's footer:
 * a cleartext object under a row with keys (a write that never published, from before the segment's key was made),
 * or an encrypted object under a row with none. Either would leave every read of the segment refusing.
 */
const SEG: SegmentRef = { segment: 's' };

function world(keystore?: IKeystore) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const load = async (ids: number[]): Promise<number> => {
    const generation = await nextGeneration(SEG, { storage, registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, ids, { registry, keystore });
    return generation;
  };
  return { storage, registry, load };
}

describe('rollback checks its target against the row', () => {
  it('refuses a cleartext target under a row with keys, and leaves the pointer', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const { storage, registry, load } = world(keystore);
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], {}); // never published
    const current = await load([7, 8]);
    await expect(rollbackSegment(SEG, 0, { storage, registry })).rejects.toThrow(IntegrityError);
    await expect(rollbackSegment(SEG, 0, { storage, registry })).rejects.toThrow(
      /generation 0 of "s" is cleartext, but the segment is encrypted/,
    );
    expect((await registry.get(SEG))?.currentGen).toBe(current);
  });

  it('refuses an encrypted target under a row with no keys, and leaves the pointer', async () => {
    const { storage, registry, load } = world();
    // An object sealed under a key no row holds, below a cleartext segment's pointer.
    const sealed = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
      generation: 0,
      crypto: { aead: new NodeAead(randomBytes(32)), aadFor: (scope) => aadFor(SEG, 0, scope) },
    });
    await storage.putImmutable({ ...SEG, generation: 0 }, async (out) => out.write(sealed));
    const current = await load([7, 8]);
    await expect(rollbackSegment(SEG, 0, { storage, registry })).rejects.toThrow(
      /generation 0 of "s" is encrypted, but the segment is cleartext/,
    );
    expect((await registry.get(SEG))?.currentGen).toBe(current);
  });

  it('still rolls onto a target that matches, either way', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    for (const ks of [undefined, keystore]) {
      const { storage, registry, load } = world(ks);
      const first = await load([1]);
      await load([2]);
      expect((await rollbackSegment(SEG, first, { storage, registry })).generation).toBe(first);
    }
  });
});
