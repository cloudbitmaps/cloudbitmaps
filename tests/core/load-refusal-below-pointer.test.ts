import { windowOf } from '@/core/known-generations';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { collect } from '../helpers/loaded';
import { REF, clock, gate, generations } from '../helpers/retaken-number-race';
import { testEntropy } from '../helpers/entropy';

/**
 * A refused load whose row another write changed deletes nothing under its number, below the pointer included. What is
 * under the number by then can be another load's generation: an object's footer names its bytes, not the load that wrote
 * them, and two loads of the same ids write the same bytes. Two ways that generation is live below the pointer:
 *
 *   - It was published and superseded, and the row records no kept list (a `keep` above 64, after a rollback), so the
 *     window that keeps it is one the refusal cannot see.
 *   - A rollback moved the pointer below the number, a load of the same ids took the number again, and publishes it
 *     after the refusal has read the row.
 *
 * Gated promises hold each writer where the race needs it, and the clock never waits, so a run is the same every time.
 */

const IDS = [4, 8];

/**
 * `registry` for one load: its write that would make `gen` current waits for `atPublish`, and, when `afterPublish` is
 * given, its next read of the row after that write was sent waits for `afterPublish`.
 */
function heldLoadRegistry(
  registry: IRegistryDriver,
  gen: number,
  atPublish: ReturnType<typeof gate>,
  afterPublish?: ReturnType<typeof gate>,
): IRegistryDriver {
  const held = Object.create(registry) as IRegistryDriver;
  let attempted = false;
  let heldRead = false;
  held.get = async (ref) => {
    if (afterPublish !== undefined && attempted && !heldRead) {
      heldRead = true;
      afterPublish.reach();
      await afterPublish.opened;
    }
    return registry.get(ref);
  };
  held.compareAndSwap = async (ref, expected, patch, options) => {
    if (!attempted && 'currentGen' in patch && patch.currentGen === gen) {
      atPublish.reach();
      await atPublish.opened;
      attempted = true;
    }
    return registry.compareAndSwap(ref, expected, patch, options);
  };
  return held;
}

/** `storage` for one load: once it has written `gen`, its next footer read of `gen` waits for `at`. */
function proofHeldStorage(
  storage: IStorageDriver,
  gen: number,
  at: ReturnType<typeof gate>,
): IStorageDriver {
  const out = Object.create(storage) as IStorageDriver;
  let wrote = false;
  let proved = false;
  out.putImmutable = async (key, write) => {
    const put = await storage.putImmutable(key, write);
    if (key.generation === gen) wrote = true;
    return put;
  };
  out.getTail = async (key, maxBytes) => {
    if (wrote && !proved && key.generation === gen && maxBytes > 0) {
      proved = true;
      at.reach();
      await at.opened;
    }
    return storage.getTail(key, maxBytes);
  };
  return out;
}

async function reads(storage: IStorageDriver, registry: IRegistryDriver): Promise<number[]> {
  const store = new CloudRoaring({ storage: brandAsBackend({ storage, registry }), retry: false });
  return collect(store.segment(REF.segment).iterate());
}

describe('a refused load under a row another write changed deletes nothing below the pointer', () => {
  it.each([100, 2])(
    'keep %d: a generation another load published with the same bytes, and a later load superseded, stays',
    async (keep) => {
      const storage = new MemoryStorageDriver();
      const registry = new MemoryRegistryDriver();
      const deps = { storage, registry, entropy: testEntropy, codec: roaringCodec, clock };
      expect(await loadSegment(REF, [9], deps, { keep })).toMatchObject({
        generation: 0,
        published: true,
      });

      // L writes 1 and holds its publish; an erasure of 8 deletes it above the pointer and renews the row.
      const lAtPublish = gate();
      const lAfter = gate();
      const l = loadSegment(
        REF,
        IDS,
        { ...deps, registry: heldLoadRegistry(registry, 1, lAtPublish, lAfter) },
        { keep, allowEmpty: true },
      );
      await lAtPublish.reached;
      await eraseIdFromSegment(REF, 8, deps);
      expect(await generations(storage)).toEqual([0]);
      lAtPublish.open();
      await lAfter.reached; // L's publish was refused; its next read of the row waits

      // A loads the same ids, takes 1 again and publishes it; Z publishes 2 over it, and the window keeps 1.
      expect(await loadSegment(REF, IDS, deps, { keep, allowEmpty: true })).toMatchObject({
        generation: 1,
        published: true,
      });
      expect(await loadSegment(REF, [5], deps, { keep, allowEmpty: true })).toMatchObject({
        generation: 2,
        published: true,
      });
      // A `keep` above 64 records no window, and the ledger carries every generation made current, so either way the row
      // names 0 and 1 below its pointer.
      expect(windowOf(await registry.get(REF))).toEqual([0, 1]);

      lAfter.open();
      expect(await l).toMatchObject({ generation: 1, published: false, reason: 'superseded' });

      // A's generation 1 is still in the bucket, inside the window Z kept, and a rollback onto it reads what A loaded.
      expect(await generations(storage)).toEqual([0, 1, 2]);
      expect(await rollbackSegment(REF, 1, deps)).toMatchObject({ generation: 1 });
      expect(await reads(storage, registry)).toEqual(IDS);
    },
  );

  it('a number a rollback below it freed for a load of the same bytes stays that load’s', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, entropy: testEntropy, codec: roaringCodec, clock };
    await loadSegment(REF, [9], deps); // 0
    await loadSegment(REF, [10], deps); // 1, keeps 0

    // L writes 2 and holds its publish. M finds 2 taken, numbers 3 by a listing, publishes 3, and that listing deletes
    // L's object at 2, below the pointer and named by no list.
    const lAtPublish = gate();
    const lAtProof = gate();
    const l = loadSegment(
      REF,
      IDS,
      {
        ...deps,
        registry: heldLoadRegistry(registry, 2, lAtPublish),
        storage: proofHeldStorage(storage, 2, lAtProof),
      },
      { allowEmpty: true },
    );
    await lAtPublish.reached;
    expect(await loadSegment(REF, [11], deps)).toMatchObject({ generation: 3, published: true });
    expect(await generations(storage)).toEqual([1, 3]);

    // L's publish is refused, and its refusal reads the row: the pointer is 3, above its number. A reclaim that went on
    // to read the footer under 2 stops there.
    lAtPublish.open();
    let lDone = false;
    const lSettled = l.then(
      () => (lDone = true),
      () => (lDone = true),
    );
    await Promise.race([lAtProof.reached, lSettled]);

    // An operator rolls back to 1; Y loads the same ids, takes 2 afresh (it is free), writes the same bytes, and holds
    // its publish.
    expect(await rollbackSegment(REF, 1, deps)).toMatchObject({ generation: 1 });
    const yAtPublish = gate();
    const y = loadSegment(
      REF,
      IDS,
      { ...deps, registry: heldLoadRegistry(registry, 2, yAtPublish) },
      { allowEmpty: true },
    );
    await yAtPublish.reached;
    expect(await generations(storage)).toEqual([1, 2, 3]);

    // L finishes, then Y publishes 2.
    lAtProof.open();
    await lSettled;
    expect(lDone).toBe(true);
    expect(await l).toMatchObject({ generation: 2, published: false, reason: 'superseded' });
    yAtPublish.open();
    expect(await y).toMatchObject({ generation: 2, published: true });

    // The row names Y's generation, its object is in the bucket, and the segment reads what Y loaded.
    expect((await registry.get(REF))?.currentGen).toBe(2);
    expect(await generations(storage)).toEqual([1, 2, 3]);
    expect(await reads(storage, registry)).toEqual(IDS);
  });
});
