import { brandAsBackend } from '@/core/ports';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import type { GenKey, IRegistryDriver, IStorageDriver, RegistryPatch } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { collect } from '../helpers/loaded';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * A refused rewrite discards its own object when the winner's pointer stopped below it, where no collection looks. The
 * number can be taken again before that discard reaches the storage:
 *
 *   a first load     writes 1, holds its publish ──────────────▶ publishes 1 │
 *   the erasure      reads 0, writes its rewrite at 2, refused by that publish, discards 2 ── stalls ──────▶ deletes 2
 *   another erasure  (of an id 2 holds)  finds 2 above the pointer, deletes it │
 *   a second load                        takes 2 afresh (the pointer is 1, and 2 is free), writes, publishes │
 *
 * Without a condition the discard removes the second load's generation, and the row names an object that is not in the
 * bucket. With one, the discard first proves the object under 2 is the one the rewrite wrote, by its footer, and deletes
 * it under the version that read reported: an object put there since is not its own, or is refused by a driver that
 * reports `conditionalDelete`, and stays.
 */

/** The second id: the rewrite of generation 0 still holds it, and the first load's generation does not. */
const Y = 77;

const isRewritePublish = (patch: RegistryPatch): boolean =>
  'currentGen' in patch && patch.currentGen === 2;

/**
 * Where the first erasure is refused: at its publish, or at its re-read of the row before it verifies what it wrote.
 * And where its discard stalls, after the refusal: before its first read or delete of the rewrite's object, after
 * that first read has answered (before a delete, when the delete comes first), or before its delete.
 */
type Refused = 'at publish' | 'before verify';
type Stall = 'before its first touch' | 'after its first read' | 'before its delete';

async function race(refusedAt: Refused, stallAt: Stall) {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  const deps = { storage, registry, codec: roaringCodec, clock };
  await loadSegment(REF, [1, 2, X, Y], deps); // generation 0

  // The first load writes generation 1 and holds its publish.
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

  // The first load publishes where the first erasure is refused.
  let refused = false;
  const publishFirstLoad = async (): Promise<void> => {
    l1AtPublish.open();
    expect(await l1).toMatchObject({ generation: 1, published: true });
    refused = true;
  };
  const firstRegistry = Object.create(registry) as IRegistryDriver;
  firstRegistry.compareAndSwap = async (ref, expected, patch, options) => {
    if (refusedAt === 'at publish' && !refused && isRewritePublish(patch)) await publishFirstLoad();
    return registry.compareAndSwap(ref, expected, patch, options);
  };

  // The first erasure's discard stalls at its touch of generation 2 after the refusal that `stallAt` names.
  const atDiscard = gate();
  let stalled = false;
  const stall = async (key: GenKey, call: 'read' | 'answered' | 'delete'): Promise<void> => {
    if (!refused || stalled || key.generation !== 2) return;
    if (stallAt === 'before its delete' && call !== 'delete') return;
    if (stallAt === 'before its first touch' && call === 'answered') return;
    if (stallAt === 'after its first read' && call === 'read') return;
    stalled = true;
    atDiscard.reach();
    await atDiscard.opened;
  };
  const firstStorage = Object.create(storage) as IStorageDriver;
  firstStorage.putImmutable = async (key, write) => {
    const out = await storage.putImmutable(key, write);
    if (refusedAt === 'before verify' && key.generation === 2) await publishFirstLoad();
    return out;
  };
  firstStorage.getTail = async (key, maxBytes) => {
    await stall(key, 'read');
    const tail = await storage.getTail(key, maxBytes);
    await stall(key, 'answered');
    return tail;
  };
  firstStorage.getRange = async (key, offset, length) => {
    await stall(key, 'read');
    const bytes = await storage.getRange(key, offset, length);
    await stall(key, 'answered');
    return bytes;
  };
  firstStorage.delete = async (key, options) => {
    await stall(key, 'delete');
    return storage.delete(key, options);
  };

  const first = eraseIdFromSegment(REF, X, {
    ...deps,
    storage: firstStorage,
    registry: firstRegistry,
  });
  await atDiscard.reached;
  expect(await generations(storage)).toContain(2);

  // Another erasure, of an id the rewrite holds and the first load's generation does not, deletes it above the pointer.
  const second = await eraseIdFromSegment(REF, Y, deps);
  expect(second).toMatchObject({ erased: true });
  expect(await generations(storage)).not.toContain(2);

  // The second load takes 2 afresh and publishes it.
  expect(await loadSegment(REF, [7, 8, 9], deps)).toMatchObject({
    generation: 2,
    published: true,
  });

  atDiscard.open();
  return { first: await first, storage, registry };
}

describe('a refused rewrite whose discard meets another object under its number', () => {
  it.each<[Refused, Stall]>([
    ['at publish', 'before its first touch'],
    ['at publish', 'after its first read'],
    ['at publish', 'before its delete'],
    ['before verify', 'before its first touch'],
    ['before verify', 'after its first read'],
    ['before verify', 'before its delete'],
  ])(
    'refused %s, its discard stalled %s: the load keeps its generation',
    async (refusedAt, stallAt) => {
      const { first, storage, registry } = await race(refusedAt, stallAt);

      expect(first).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
      // The row names generation 2, the second load's, which is in the bucket and reads as the second load wrote it.
      expect((await registry.get(REF))?.currentGen).toBe(2);
      expect(await generations(storage)).toContain(2);
      const store = new CloudRoaring({
        storage: brandAsBackend({ storage, registry }),
        retry: false,
      });
      expect(await collect(store.segment(REF.segment).iterate())).toEqual([7, 8, 9]);
    },
  );
});

describe('a refused rewrite whose object is still its own', () => {
  it.each<Refused>(['at publish', 'before verify'])(
    "refused %s: the discard deletes it, above the winner's pointer",
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

      const result = await eraseIdFromSegment(REF, X, {
        ...deps,
        storage: firstStorage,
        registry: firstRegistry,
      });

      expect(result).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
      expect((await registry.get(REF))?.currentGen).toBe(1);
      expect(await generations(storage)).toEqual([0, 1]);
    },
  );
});
