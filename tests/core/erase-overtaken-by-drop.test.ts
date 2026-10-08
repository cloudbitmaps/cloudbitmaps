import { eraseIdFromSegment } from '@/core/erase-id';
import { dropSegment } from '@/core/erasure';
import { roaringCodec } from '@/roaring-codec';
import type { GenKey, IStorageDriver, SegmentRef } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

/**
 * A `dropSegment` that lands while an erasure rewrite streams usually finishes first: its sweep takes seconds, a
 * rewrite of a large segment minutes. The rewrite's object then commits under a tombstone, after the drop's sweep
 * listed the bucket. It is a full copy of the dropped segment less one id, cleartext on a cleartext segment, and every
 * generation under a tombstone is garbage, so the rewrite deletes it, as a refused load deletes its own. The erasure
 * reports what the row says, `'destroyed'`, not `'superseded'`, whose documented action (re-run) finds nothing.
 */
const REF: SegmentRef = { segment: 's' };

async function generations(storage: MemoryStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** A storage driver that runs `during` once, when the rewrite's object is about to be written or has been written. */
function dropAt(
  real: MemoryStorageDriver,
  when: 'before-commit' | 'after-commit',
  during: () => Promise<unknown>,
): IStorageDriver {
  let fired = false;
  return {
    capabilities: () => real.capabilities(),
    getTail: (k, m) => real.getTail(k, m),
    getRange: (k, o, l) => real.getRange(k, o, l),
    delete: (k) => real.delete(k),
    list: (r) => real.list(r),
    putImmutable: async (k: GenKey, write) => {
      if (!fired && when === 'before-commit') {
        fired = true;
        await during();
      }
      const out = await real.putImmutable(k, write);
      if (!fired && when === 'after-commit') {
        fired = true;
        await during();
      }
      return out;
    },
  };
}

describe('an erasure rewrite a drop overtakes deletes its own object', () => {
  for (const when of ['before-commit', 'after-commit'] as const) {
    it(`a drop ${when === 'before-commit' ? 'whose sweep ends while the rewrite is still writing' : 'once the rewrite is written and not yet published'}`, async () => {
      const storage = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3, 9], { registry });
      let drop: { dropped: boolean } | undefined;
      const wrapped = dropAt(storage, when, async () => {
        drop = await dropSegment(REF, { storage, registry }, { confirmSegment: 's' });
      });

      const res = await eraseIdFromSegment(REF, 9, {
        storage: wrapped,
        registry,
        codec: roaringCodec,
      });

      expect(drop?.dropped).toBe(true);
      expect(res).toMatchObject({ erased: false, reason: 'destroyed' });
      // Nothing of the dropped segment is left in the bucket: not gen 0, which the drop took, nor the rewrite.
      expect(await generations(storage)).toEqual([]);
      expect((await registry.get(REF))?.status).toBe('destroyed');
    });
  }
});

describe('a rewrite whose publish a drop refuses reports the row, not a race', () => {
  it("a drop just before the publish's compare-and-swap is 'destroyed', and the rewrite is deleted", async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3, 9], { registry });
    let fired = false;
    const racing = Object.create(registry) as MemoryRegistryDriver;
    racing.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!fired) {
        fired = true;
        await dropSegment(REF, { storage, registry }, { confirmSegment: 's' });
      }
      return registry.compareAndSwap(ref, expected, patch);
    };

    const res = await eraseIdFromSegment(REF, 9, {
      storage,
      registry: racing,
      codec: roaringCodec,
    });

    expect(fired).toBe(true);
    expect(res).toMatchObject({ erased: false, reason: 'destroyed' });
    expect(await generations(storage)).toEqual([]);
  });
});

describe('a segment tombstoned while its rewrite runs is searched as a fresh call searches one', () => {
  it('a drop whose sweep left a cleartext generation holding the id: the erasure deletes it', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3, 9], { registry });
    // The drop's own deletes fail, so its tombstone lands and generation 0 stays in the bucket, readable.
    const denied: IStorageDriver = {
      capabilities: () => storage.capabilities(),
      getTail: (k, m) => storage.getTail(k, m),
      getRange: (k, o, l) => storage.getRange(k, o, l),
      list: (r) => storage.list(r),
      putImmutable: (k, w) => storage.putImmutable(k, w),
      delete: () => Promise.reject(new Error('AccessDenied')),
    };
    const wrapped = dropAt(storage, 'after-commit', async () => {
      await dropSegment(REF, { storage: denied, registry }, { confirmSegment: 's' }).catch(
        () => undefined,
      );
    });

    const res = await eraseIdFromSegment(REF, 9, {
      storage: wrapped,
      registry,
      codec: roaringCodec,
    });

    expect((await registry.get(REF))?.status).toBe('destroyed');
    expect(res).toMatchObject({ erased: true });
    expect(await generations(storage)).toEqual([]);
  });
});
