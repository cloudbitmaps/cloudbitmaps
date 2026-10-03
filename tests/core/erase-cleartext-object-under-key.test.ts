import { randomBytes } from 'node:crypto';
import { aadFor } from '@/core/crypto';
import { IntegrityError } from '@/core/errors';
import { NodeAead } from '@/drivers/crypto';
import { writeCrbm } from '../helpers/crbm-extension';
import { eraseIdFromSegment } from '@/core/erase-id';
import type { EraseIdDeps } from '@/core/erase-id';
import { nextGeneration } from '@/core/generation-gc';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import type { SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A cleartext object can sit under an encrypted segment's name without ever having been one of its generations: a
 * write from a store with no keystore that never published (a crash between the write and the publish), before the
 * segment's first keyed load. No read believes it, but an erasure must still look in it, since it may hold the
 * subject in the clear: the erasure reads it without the key to find the id, and deletes it when it holds it.
 */
const SEG: SegmentRef = { segment: 's' };

async function world(orphanAt: 'below' | 'above') {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  const deps: EraseIdDeps = { storage, registry, keystore, codec: roaringCodec };
  const keyedLoad = async (ids: number[]): Promise<number> => {
    const generation = await nextGeneration(SEG, { storage, registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, ids, { registry, keystore });
    return generation;
  };
  // A cleartext write of ids 1 and 2, never published: no registry, so nothing points at it.
  const orphan = async (generation: number): Promise<void> => {
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [1, 2], {});
  };
  let orphanGen: number;
  let current: number;
  if (orphanAt === 'below') {
    await orphan(0);
    orphanGen = 0;
    current = await keyedLoad([7, 8]); // numbers above it: 1
  } else {
    current = await keyedLoad([7, 8]); // 0
    orphanGen = 3;
    await orphan(orphanGen);
  }
  const present = async (): Promise<number[]> => {
    const out: number[] = [];
    for await (const key of storage.list(SEG)) out.push(key.generation);
    return out.sort((a, b) => a - b);
  };
  return { deps, orphanGen, current, present };
}

describe.each(['below', 'above'] as const)(
  'erasure with a cleartext write that never published %s an encrypted pointer',
  (orphanAt) => {
    it('an id in no generation is not a member, and the write stays', async () => {
      const { deps, orphanGen, present } = await world(orphanAt);
      const result = await eraseIdFromSegment(SEG, 99, deps);
      expect(result.erased).toBe(false);
      expect(result.reason).toBe('not-member');
      expect(await present()).toContain(orphanGen);
    });

    it('an id only in that write is erased, by deleting it', async () => {
      const { deps, orphanGen, present } = await world(orphanAt);
      const result = await eraseIdFromSegment(SEG, 1, deps);
      expect(result.erased).toBe(true);
      expect(result.fromGeneration).toBe(orphanGen);
      expect(await present()).not.toContain(orphanGen);
    });

    it('an id in the current generation is erased as ever', async () => {
      const { deps, current } = await world(orphanAt);
      const result = await eraseIdFromSegment(SEG, 7, deps);
      expect(result.erased).toBe(true);
      expect(result.fromGeneration).toBe(current);
    });
  },
);

describe('erasure with an encrypted object the segment key does not open', () => {
  it('still refuses with the integrity error, and does not read it as cleartext', async () => {
    // Sealed under a key no row holds, below an encrypted pointer: only the footer says it is encrypted, so the
    // erasure must not take its refusal for a cleartext object's.
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const sealed = await writeCrbm([{ chunkKey: 0, payload: Uint8Array.of(1), cardinality: 1 }], {
      generation: 0,
      crypto: { aead: new NodeAead(randomBytes(32)), aadFor: (scope) => aadFor(SEG, 0, scope) },
    });
    await storage.putImmutable({ ...SEG, generation: 0 }, async (out) => out.write(sealed));
    const generation = await nextGeneration(SEG, { storage, registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [7, 8], { registry, keystore });
    await expect(
      eraseIdFromSegment(SEG, 99, { storage, registry, keystore, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});
