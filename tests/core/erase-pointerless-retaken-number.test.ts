import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandAsBackend } from '@/core/ports';
import { eraseIdFromSegment, type EraseIdResult } from '@/core/erase-id';
import { loadSegment } from '@/core/load';
import { InProcessKeystore } from '@/drivers/crypto';
import { LocalFsStorageDriver } from '@/drivers/localfs/storage';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import type { IRegistryDriver, IStorageDriver } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect } from '../helpers/loaded';
import {
  REF,
  X,
  clock,
  gate,
  generations,
  stallingAfterFence,
} from '../helpers/retaken-number-race';

/**
 * Two erasures of one id, and a load that takes a number the second one freed, on the holders an erasure deletes one by
 * one under its renewal of the row: every holder on a row with no pointer, and an object above the pointer it cannot
 * search.
 *
 *   first erasure    lists, finds the holder at 0, renews the row, re-reads it ── stalls ──────────────▶ deletes 0
 *   second erasure   (the same id)  finds 0, renews the row, deletes 0 │
 *   a load                          reads the row, numbers 0 afresh (the bucket is empty), writes, publishes │
 *
 * The load read the row after both renewals, so nothing refuses its publish. Without a condition on the first erasure's
 * delete, it removes the object the load published, and the row names an object that is not in the bucket. With one,
 * the delete names the object the first erasure found, by the version the driver reported on the read that found it,
 * and a driver that reports `conditionalDelete` refuses it for the load's: the deletes stop, the answer comes from the
 * row, and the pointer keeps its object. The version is the one read that found the holder: the open of an object it
 * searched, the footer read that found an object sealed under a key no row holds, or the open whose index failed its
 * authentication under the row's key.
 *
 * A driver that reports no `conditionalDelete` ignores the version, and there the race still ends with the row naming
 * a missing object.
 */

const keystore = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });

interface Race {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly keystore?: InProcessKeystore;
  /** The generation the erasures meet the holder at, and the load takes again. */
  readonly at: number;
}

/**
 * The race over a bucket and row the caller set up: the first erasure stalls between its re-read of the row and its
 * delete, the second erases the id to the end, and a load of `[7, 8, 9]` takes the number the second one freed.
 * Returns what each erasure reported.
 */
async function race(r: Race): Promise<{ first: EraseIdResult; second: EraseIdResult }> {
  const deps = {
    storage: r.storage,
    registry: r.registry,
    codec: roaringCodec,
    clock,
    ...(r.keystore === undefined ? {} : { keystore: r.keystore }),
  };
  const atDelete = gate();
  const first = eraseIdFromSegment(REF, X, {
    ...deps,
    registry: stallingAfterFence(r.registry, atDelete),
  });
  await atDelete.reached;

  const second = await eraseIdFromSegment(REF, X, deps);
  expect(await generations(r.storage)).not.toContain(r.at);

  const loaded = await loadSegment(REF, [7, 8, 9], deps);
  expect(loaded).toMatchObject({ generation: r.at, published: true });

  atDelete.open();
  return { first: await first, second };
}

/** The row names `at`, its object is in the bucket and reads as the load wrote it, and nothing holds the id. */
async function pointerKeepsItsObject(r: Race): Promise<void> {
  expect((await r.registry.get(REF))?.currentGen).toBe(r.at);
  expect(await generations(r.storage)).toContain(r.at);
  const store = new CloudRoaring({
    storage: brandAsBackend({ storage: r.storage, registry: r.registry }),
    retry: false,
    ...(r.keystore === undefined ? {} : { encryption: { keystore: r.keystore } }),
  });
  expect(await collect(store.segment(REF.segment).iterate())).toEqual([7, 8, 9]);
  expect(await store.segment(REF.segment).has(X)).toBe(false);
}

/** A row with no pointer, as `setRetention` makes one, and a first load's object at 0 that never published. */
async function pointerless(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  ks?: InProcessKeystore,
) {
  await registry.create(REF, { currentGen: null });
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, 2, X], {
    registry: new MemoryRegistryDriver(),
    publish: false,
    ...(ks === undefined ? {} : { keystore: ks }),
  });
}

describe('two erasures of one id, and a load that takes the number the second one freed', () => {
  it("on a row with no pointer, a holder it searched: the stale delete is refused for the load's object", async () => {
    const r: Race = {
      storage: new MemoryStorageDriver(),
      registry: new MemoryRegistryDriver(),
      at: 0,
    };
    await pointerless(r.storage, r.registry);

    const { first, second } = await race(r);

    expect(second).toMatchObject({ erased: true, fromGeneration: 0, collected: [0] });
    // The first erasure's delete was refused, so it deleted nothing; nothing left in the bucket holds the id.
    expect(first).toMatchObject({ erased: true, fromGeneration: 0, collected: [] });
    await pointerKeepsItsObject(r);
  });

  it("on a row with no pointer and no key, an object sealed under a key no row holds: the version is the footer read's", async () => {
    const ks = keystore();
    const r: Race = {
      storage: new MemoryStorageDriver(),
      registry: new MemoryRegistryDriver(),
      keystore: ks,
      at: 0,
    };
    await pointerless(r.storage, r.registry, ks);

    const { first, second } = await race(r);

    expect(second).toMatchObject({ erased: false, reason: 'no-generation', collected: [0] });
    // The load's object is sealed under a key the row the first erasure read did not hold: it is a holder there, and
    // the row moved, so the first erasure reports the move.
    expect(first).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    await pointerKeepsItsObject(r);
  });

  it("above the pointer, an object whose index fails its authentication under the row's key: the version is that open's", async () => {
    const ks = keystore();
    const r: Race = {
      storage: new MemoryStorageDriver(),
      registry: new MemoryRegistryDriver(),
      keystore: ks,
      at: 1,
    };
    await loadSegment(REF, [1, 2, 3], {
      storage: r.storage,
      registry: r.registry,
      codec: roaringCodec,
      keystore: ks,
    });
    // A first load's under a key it made and never stored, above the pointer: no read of the segment opens it.
    await bulkLoadCrbmGeneration(r.storage, { ...REF, generation: 1 }, [1, 2, X], {
      registry: new MemoryRegistryDriver(),
      keystore: ks,
      publish: false,
    });

    const { first, second } = await race(r);

    expect(second).toMatchObject({
      erased: false,
      reason: 'not-member',
      fromGeneration: 0,
      collected: [1],
    });
    // The first erasure's delete was refused, and the load's object under the number opens under the row's key and
    // does not hold the id: nothing holds it, and nothing the first erasure deleted was searched.
    expect(first).toMatchObject({
      erased: false,
      reason: 'not-member',
      fromGeneration: 0,
      collected: [],
    });
    await pointerKeepsItsObject(r);
  });
});

describe('the same race over a storage driver that reports no conditionalDelete', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'erase-retaken-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the local filesystem ignores the version: the stale delete removes the load's object, and the row names it still", async () => {
    const storage = new LocalFsStorageDriver(root);
    expect(storage.capabilities().conditionalDelete).toBe(false);
    const r: Race = { storage, registry: new MemoryRegistryDriver(), at: 0 };
    await pointerless(r.storage, r.registry);

    const { second } = await race(r);

    expect(second).toMatchObject({ erased: true, collected: [0] });
    // The residual: the row names generation 0, the load's, and the first erasure's delete took it.
    expect((await r.registry.get(REF))?.currentGen).toBe(0);
    expect(await generations(r.storage)).toEqual([]);
  });
});
