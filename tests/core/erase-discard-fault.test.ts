import { eraseIdFromSegment } from '@/core/erase-id';
import { TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IRegistryDriver, IStorageDriver, RegistryPatch } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';

const isRewritePublish = (patch: RegistryPatch): boolean =>
  'currentGen' in patch && patch.currentGen === 2;

type Refused = 'at publish' | 'before verify';

describe('a refused rewrite whose discard faults', () => {
  it.each<Refused>(['at publish', 'before verify'])(
    'refused %s: a fault of the discard other than a refused condition is thrown, and the object stays',
    async (refusedAt) => {
      const storage = new MemoryStorageDriver();
      const registry: IRegistryDriver = new MemoryRegistryDriver();
      const deps = { storage, registry, codec: roaringCodec, clock };
      await loadSegment(REF, [1, 2, X], deps);
      const l1AtPublish = gate();
      const l1Registry = Object.create(registry) as IRegistryDriver;
      l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
        if ('currentGen' in patch && patch.currentGen === 1) {
          l1AtPublish.reach();
          await l1AtPublish.opened;
        }
        return registry.compareAndSwap(ref, expected, patch, options);
      };
      const l1 = loadSegment(REF, [5, 6], { ...deps, registry: l1Registry });
      await l1AtPublish.reached;
      let released = false;
      const publishFirstLoad = async (): Promise<void> => {
        released = true;
        l1AtPublish.open();
        await l1;
      };
      const firstRegistry = Object.create(registry) as IRegistryDriver;
      firstRegistry.compareAndSwap = async (ref, expected, patch, options) => {
        if (refusedAt === 'at publish' && !released && isRewritePublish(patch))
          await publishFirstLoad();
        return registry.compareAndSwap(ref, expected, patch, options);
      };
      const firstStorage = Object.create(storage) as IStorageDriver;
      firstStorage.putImmutable = async (key, write) => {
        const out = await storage.putImmutable(key, write);
        if (refusedAt === 'before verify' && key.generation === 2) await publishFirstLoad();
        return out;
      };
      const asked: number[] = [];
      firstStorage.delete = async (key, options) => {
        asked.push(key.generation);
        if (key.generation === 2) throw new TransientError('the delete timed out');
        return storage.delete(key, options);
      };

      await expect(
        eraseIdFromSegment(REF, X, { ...deps, storage: firstStorage, registry: firstRegistry }),
      ).rejects.toBeInstanceOf(TransientError);
      expect(asked).toEqual([2]);
      expect((await registry.get(REF))?.currentGen).toBe(1);
      expect(await generations(storage)).toEqual([0, 1, 2]);
    },
  );
});
