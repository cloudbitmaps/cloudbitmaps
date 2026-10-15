import { eraseIdFromSegment } from '@/core/erase-id';
import { ValidationError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';

/**
 * Behaviour of single steps of an erasure that no other test pins: each case below fails when exactly one line of the
 * phase it names is changed, and is otherwise the ordinary erasure of one id.
 */
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
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
    expect(res).toMatchObject({ erased: true, fromGeneration: 0 });
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
    await expect(eraseIdFromSegment(SEG, 2, { ...w.deps, maxBitmapBytes: 1 })).rejects.toThrow();
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

  it('writes the row once to rewrite and collect an ordinary segment', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps);
    let writes = 0;
    const registry = Object.assign(Object.create(w.registry) as IRegistryDriver, {
      compareAndSwap: (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
        writes += 1;
        return w.registry.compareAndSwap(...args);
      },
    });
    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, registry });
    expect(res).toMatchObject({ erased: true, collected: [0] });
    expect(writes).toBe(1);
  });
});
