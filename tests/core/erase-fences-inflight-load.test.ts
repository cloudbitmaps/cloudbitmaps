import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { roaringCodec } from '@/roaring-codec';
import type { SegmentRef } from '@/index';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { WriteConflictError } from '@/core/errors';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * An erasure that finds the id only in a generation above the pointer deletes that generation. A load that wrote it
 * and has not yet published holds a publish fenced on the row it read, so the erasure writes the row first: a change
 * the load's fence counts as another writer's. Without that write the load published after the delete, and the row
 * named a generation that is not in the bucket.
 */
const REF: SegmentRef = { segment: 's' };

async function generations(storage: MemoryStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

describe('an erasure fences a load in flight before deleting its object', () => {
  it('the load is refused, and the row names only what is in the bucket', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);

    // Hold the load at its publish, with its object already in the bucket.
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    const gated = Object.create(registry) as MemoryRegistryDriver;
    gated.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!held && 'currentGen' in patch) {
        held = true;
        reach();
        await gate;
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const load = loadSegment(REF, [1, 2, 3, 9], { ...deps, registry: gated });
    await reached;
    expect(await generations(storage)).toEqual([0, 1]);

    const erased = await eraseIdFromSegment(REF, 9, deps);
    open();
    const loaded = await load;

    expect(erased).toMatchObject({ erased: true });
    expect(loaded.published).toBe(false);
    const row = (await registry.get(REF))!;
    expect(row.currentGen).toBe(0);
    expect(await generations(storage)).toEqual([0]);
  });

  it('the erasure that loses to the publish reports it, and a re-run erases from the new generation', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);
    // The load lands first: the erasure finds 9 in the current generation and rewrites it.
    await loadSegment(REF, [1, 2, 3, 9], deps);
    const erased = await eraseIdFromSegment(REF, 9, deps);
    expect(erased).toMatchObject({ erased: true, fromGeneration: 1 });
    const row = (await registry.get(REF))!;
    expect(await generations(storage)).toEqual([row.currentGen!]);
  });
});

describe('a row with no pointer, over an object a first load wrote and never published', () => {
  // A row minted by `setRetention` before the first load names no generation, and the first load's object is in the
  // bucket until that load publishes. No row field can fence that publish, so an erasure cannot delete the object
  // safely; it refuses, rather than report the segment as holding nothing.
  async function world() {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await registry.create(REF, { currentGen: null });
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, 3], {
      registry,
      publish: false,
    });
    return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
  }

  it('an id the unpublished object holds is refused, and the object is kept', async () => {
    const w = await world();
    await expect(eraseIdFromSegment(REF, 2, w.deps)).rejects.toBeInstanceOf(WriteConflictError);
    await expect(eraseIdFromSegment(REF, 2, w.deps)).rejects.toThrow(/never published/);
    expect(await generations(w.storage)).toEqual([0]);
  });

  it("an id it does not hold is 'no-generation', as with an empty bucket", async () => {
    const w = await world();
    expect(await eraseIdFromSegment(REF, 7, w.deps)).toMatchObject({
      erased: false,
      reason: 'no-generation',
    });
  });
});
