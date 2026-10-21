import { randomBytes } from 'node:crypto';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, ValidationError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { SegmentRef } from '@/index';
import type { GenKey, IRegistryDriver, IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { storeCodec } from '../helpers/store-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';

/**
 * Behaviour of single steps of an erasure that no other test pins: each case below fails when exactly one line of the
 * phase it names is changed, and is otherwise the ordinary erasure of one id.
 */
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return {
    storage,
    registry,
    deps: { storage, registry, codec: storeCodec, entropy: testEntropy },
  };
}

/** A storage whose calls are routed through `over`, and the rest to `storage`. */
function over(storage: IStorageDriver, patch: Partial<IStorageDriver>): IStorageDriver {
  return Object.assign(Object.create(storage) as IStorageDriver, patch);
}

describe('the steps of an erasure', () => {
  it('a tombstone is reported as destroyed even when the call requires encryption', async () => {
    const w = world();
    await w.registry.create(SEG, { currentGen: 0, status: 'destroyed' });
    const res = await eraseIdFromSegment(SEG, 1, { ...w.deps, requireEncryption: true });
    expect(res).toMatchObject({ erased: false, reason: 'destroyed' });
  });

  it('a generation listed but gone when the bucket is read at the end is not a holder', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const phantom: GenKey = { ...SEG, generation: 99 };
    const storage = over(w.storage, {
      async *list(ref: SegmentRef) {
        yield* w.storage.list(ref);
        yield phantom;
      },
    });
    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, storage });
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, collected: [99, 0] });
  });

  it('names the newest generation it could not remove', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2], w.deps);
    await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 5 });
    const storage = over(w.storage, { delete: () => Promise.resolve() });
    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, storage })).rejects.toThrow(
      /could not remove generation 1,/,
    );
  });

  it('refuses a reserved namespace and an audit sink with no onEvent, before any read', async () => {
    const w = world();
    let reads = 0;
    const registry = Object.assign(Object.create(w.registry) as IRegistryDriver, {
      get: (ref: SegmentRef) => {
        reads += 1;
        return w.registry.get(ref);
      },
    });
    const deps = { ...w.deps, registry };
    await expect(
      eraseIdFromSegment({ namespace: 'cbm.due.x', segment: 's' }, 1, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(eraseIdFromSegment(SEG, 1, deps, { audit: {} as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(reads).toBe(0);
  });

  it('decodes a chunk under the cap the caller set', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const call = eraseIdFromSegment(SEG, 2, { ...w.deps, maxBitmapBytes: 1 });
    await expect(call).rejects.toBeInstanceOf(IntegrityError);
    await expect(call).rejects.toThrow(/exceeds cap 1B/);
  });

  it('lists the bucket once for an id no generation holds, however many it keeps', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    let lists = 0;
    const storage = over(w.storage, {
      list: (ref: SegmentRef) => {
        lists += 1;
        return w.storage.list(ref);
      },
    });
    const res = await eraseIdFromSegment(SEG, 9, { ...w.deps, storage });
    expect(res).toMatchObject({ erased: false, reason: 'not-member' });
    expect(lists).toBe(1);
  });

  it('keeps the premise of a fence that wrote nothing, so a later write to a non-lease field does not stop the delete', async () => {
    const storage = new MemoryStorageDriver();
    const inner = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const at = (generation: number) => ({ ...SEG, generation });
    const fresh = () => ({ registry: new MemoryRegistryDriver(), publish: false });
    // Generation 0 holds the id below the pointer, 1 is current, 2 is sealed above it under a key the row does not hold.
    await bulkLoadCrbmGeneration(storage, at(0), [1, 7], fresh());
    await bulkLoadCrbmGeneration(storage, at(1), [1], fresh());
    await bulkLoadCrbmGeneration(storage, at(2), [1, 5], { ...fresh(), keystore });
    // A row with a pointer and no ledger, so the collection fences a second time.
    await inner.create(SEG, { currentGen: 1 });
    let cas = 0;
    const registry = Object.assign(Object.create(inner) as IRegistryDriver, {
      compareAndSwap: async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
        const out = await inner.compareAndSwap(...args);
        cas += 1;
        // Another writer's retention policy lands right after the fence's first write.
        if (cas === 1)
          await inner.compareAndSwap(SEG, out.token, { retention: { expiresAt: 4102444800000 } });
        return out;
      },
    });
    const res = await eraseIdFromSegment(SEG, 7, {
      storage,
      registry,
      codec: storeCodec,
      entropy: testEntropy,
    });
    expect(cas).toBe(1);
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, collected: [0, 2] });
  });

  it('rewrites and collects an ordinary segment', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    const res = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(res).toMatchObject({ erased: true, collected: [0] });
  });
});
