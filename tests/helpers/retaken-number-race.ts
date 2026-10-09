import { expect } from 'vitest';
import { eraseIdFromSegment } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { rollbackSegment } from '@/core/rollback';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { Clock, IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { collect } from './loaded';

/**
 * The race a delete conditioned on the object's identity closes. A number can be taken again once its object is
 * deleted (invariant 2), so an erasure that decided to delete the object under a number, and then stalled, can meet
 * another object under that number when it resumes. Above the pointer:
 *
 *   E1 searches generation 1, finds the id, fences the row, re-reads it ── stalls ──────────────────▶ deletes 1
 *   E2 (the same id)        searches 1, fences, deletes 1 │
 *   a load                                   numbers 1 afresh (it is free), writes it, publishes │
 *
 * Without the condition E1's delete removes the generation the pointer now names, and the row names an object that is
 * not in the bucket (invariant 1). With it, the delete names the object E1 searched, the store refuses it for the one
 * put since, and the pointer keeps its object. Gated promises hold E1 between its re-read of the row and its delete, and
 * the clock never waits, so a run is the same every time.
 */

export const REF: SegmentRef = { segment: 's' };
/** The id both erasures erase. */
export const X = 42;

/** A clock that never waits. */
export const clock: Clock = {
  now: () => 1_800_000_000_000,
  sleep: () => Promise.resolve(),
};

/** A point a call stops at until the test opens it, and a promise that says it got there. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, opened, reach, reached };
}

export async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/**
 * A registry that holds the first read of the row made after this caller's own first write of it: the erasure's
 * re-read before its delete above the pointer, the write before it being its fence. The read is made and its answer
 * held back, so the caller acts on a row that was true when it was read.
 */
export function stallingAfterFence(
  registry: IRegistryDriver,
  at: ReturnType<typeof gate>,
): IRegistryDriver {
  let wrote = false;
  let held = false;
  const gated = Object.create(registry) as IRegistryDriver;
  gated.compareAndSwap = async (ref, expected, patch, options) => {
    const written = await registry.compareAndSwap(ref, expected, patch, options);
    wrote = true;
    return written;
  };
  gated.get = async (ref) => {
    const row = await registry.get(ref);
    if (wrote && !held) {
      held = true;
      at.reach();
      await at.opened;
    }
    return row;
  };
  return gated;
}

/**
 * Runs the erasure that stalls, over the storage and the gated registry it is given, and returns the check of what it
 * reported, made once the race has run.
 */
export type StalledErasure = (
  storage: IStorageDriver,
  registry: IRegistryDriver,
) => Promise<() => void>;

/** `eraseIdFromSegment` as the stalled erasure: it reports `erased: true` and that it deleted nothing. */
export const byFreeFunction: StalledErasure = async (storage, registry) => {
  const result = await eraseIdFromSegment(REF, X, {
    storage,
    registry,
    codec: roaringCodec,
    clock,
  });
  return () => expect(result).toMatchObject({ erased: true, fromGeneration: 1, collected: [] });
};

/** Run the race over `storage` and `registry`, which start empty, and check the pointer keeps its object. */
export async function raceStaleHolderDelete(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  stalled: StalledErasure,
): Promise<void> {
  const deps = { storage, registry, codec: roaringCodec, clock };
  await loadSegment(REF, [1, 2, 3], deps); // generation 0
  await loadSegment(REF, [1, 2, 3, X], deps); // generation 1 holds X; `keep: 1` keeps 0
  await rollbackSegment(REF, 0, deps); // 1 is above the pointer now, and holds X
  expect(await generations(storage)).toEqual([0, 1]);

  // E1 searches generation 1, fences the row, re-reads it, and stops there.
  const atDelete = gate();
  const e1 = stalled(storage, stallingAfterFence(registry, atDelete));
  await atDelete.reached;

  // E2 erases the same id to the end: it deletes generation 1.
  const e2 = await eraseIdFromSegment(REF, X, deps);
  expect(e2).toMatchObject({ erased: true, collected: [1] });
  expect(await generations(storage)).toEqual([0]);

  // A load takes number 1 afresh, since it is free, and publishes it.
  const loaded = await loadSegment(REF, [7, 8, 9], deps);
  expect(loaded).toMatchObject({ generation: 1, published: true });

  atDelete.open();
  const reported = await e1;

  // The pointer names generation 1, the load's, and it is in the bucket and reads as the load wrote it.
  const row = await registry.get(REF);
  expect(row?.currentGen).toBe(1);
  expect(await generations(storage)).toEqual([0, 1]);
  const store = new CloudRoaring({ storage: brandAsBackend({ storage, registry }), retry: false });
  expect(await collect(store.segment(REF.segment).iterate())).toEqual([7, 8, 9]);
  // And no generation holds X: E2 erased it, and nothing put it back.
  expect(await store.segment(REF.segment).has(X)).toBe(false);
  reported();
}
