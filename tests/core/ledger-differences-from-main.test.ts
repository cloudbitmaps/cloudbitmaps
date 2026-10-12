import { footerCrcUnder } from '@/core/crbm-open';
import { WriteConflictError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { rollbackSegment } from '@/core/rollback';
import type { IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Three histories where the ledger collects differently from a release before ledgers, found by running the same random
 * histories against both. Each is a difference in when a generation outside the window a load asked for goes, or in
 * what a restored row's ledger says; each test pins this release's bucket and says in a comment what that release left.
 * A generation a window of the load's own `keep` names is never one of them.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}
type W = ReturnType<typeof world>;

async function gens(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}
let ids = 0;
const load = async (w: W, keep: number, deps: object = {}): Promise<number> =>
  (await loadSegment(SEG, [ids++, 1000 + ids], { ...w.deps, ...deps }, { keep })).generation;
const plant = async (w: W, g: number): Promise<void> => {
  await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [5000 + g]);
};

/** The row restored from `snapshot`: its pointer, and its ledger as it was. */
async function restore(w: W, snapshot: RegistryRecord): Promise<void> {
  await w.registry.delete(SEG);
  await w.registry.create(SEG, {
    currentGen: snapshot.currentGen,
    ...(snapshot.knownGens === undefined ? {} : { knownGens: snapshot.knownGens }),
  });
}

describe('a count whose delete failed, then a load with a larger keep', () => {
  // Generations 0 to 13 are in the bucket with the pointer on 13 and no ledger. A keep-5 load seeds the window it keeps
  // (9 to 13) and collects by count; the first delete of that count fails. A release before ledgers recorded no window
  // after an incomplete pass, so the next load, with keep 12 and generation 16 (a crashed object at 15 took the number
  // before it), counted again and left 4 to 16. Here the seed was written with the publish, so that load's listing pass
  // keeps what the row names (9 to 14) and collects 4 to 8 and the crashed object, which a count of 12 would have kept.
  it('collects what the earlier load asked to keep out of its window, at the next load that lists', async () => {
    const w = world();
    for (let g = 0; g <= 13; g++) await plant(w, g);
    await w.registry.create(SEG, { currentGen: 13 });
    let failed = false;
    const storage = new Proxy(w.storage as IStorageDriver, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        if (p !== 'delete') return value.bind(t);
        return (...args: unknown[]) => {
          if (!failed) {
            failed = true;
            return Promise.reject(new WriteConflictError('the first delete fails'));
          }
          return (value as (...a: unknown[]) => Promise<void>).apply(t, args);
        };
      },
    });
    await load(w, 5, { storage }).catch(() => undefined);
    expect(await gens(w.storage)).toContain(0);
    await plant(w, 15); // a crashed load's object: the next load's number is taken, so it lists
    await load(w, 12);
    expect(await gens(w.storage)).toEqual([9, 10, 11, 12, 13, 14, 16]);
  });
});

describe('a row restored with a ledger older than the bucket', () => {
  // The row is restored to the snapshot taken when generation 15 was current, whose ledger names 14. Generations 10 to 13
  // are below its pointer and in the bucket, and the ledger does not name them. A release before ledgers restored a
  // snapshot with no list, and the load at generation 16 counted: it left 11 to 16. A snapshot restored with a list
  // naming 14 was collected by name, as it is here: 14, 15 and 16. The load that lists keeps what the ledger names.
  it('collects what the restored ledger does not name, at the load that lists', async () => {
    const w = world();
    for (let g = 10; g <= 15; g++) await plant(w, g);
    const crc = await footerCrcUnder(w.storage, { ...SEG, generation: 14 });
    const now = await footerCrcUnder(w.storage, { ...SEG, generation: 15 });
    await restore(w, {
      currentGen: 15,
      knownGens: [
        { generation: 14, footerCrc: crc },
        { generation: 15, footerCrc: now },
      ],
    } as unknown as RegistryRecord);
    expect(await load(w, 5)).toBe(16);
    expect(await gens(w.storage)).toEqual([14, 15, 16]);
  });
});

describe('strays above a restored pointer', () => {
  // Crashed loads left 0 and 2, loads publish 3 and 4 at keep 12, a snapshot is taken, loads publish 5 and 6 at keep 5, a
  // rollback goes to 0, and the row is restored to the snapshot with its ledger. A release before ledgers had recorded
  // no list for the loads over the orphans' row, so the load after the restore counted: it left 2, 3, 4, 5, 6 and 7,
  // keeping 5 and 6 inside its keep by number until later loads slid the window past them, and 0 went. Here neither 5
  // nor 6 is in the restored ledger, so the load that numbers past them collects them. The crashed loads' objects at 0
  // and 2 are named by no ledger either, so they go too: 3, 4 and 7.
  it('collects them at the load that numbers past them', async () => {
    const w = world();
    for (const g of [0, 2]) await plant(w, g);
    expect([await load(w, 12), await load(w, 12)]).toEqual([3, 4]);
    const snapshot = (await w.registry.get(SEG))!;
    expect([await load(w, 5), await load(w, 5)]).toEqual([5, 6]);
    await rollbackSegment(SEG, 0, w.deps, {});
    await restore(w, snapshot);
    expect(await load(w, 5)).toBe(7);
    // Main seeded the first publish over the crashed loads' objects at 0 and 2, so it left [0, 2, 3, 4, 7]; those objects
    // are no load's, the ledger no longer names them, and they go at the load that lists.
    expect(await gens(w.storage)).toEqual([3, 4, 7]);
  });
});

/** `registry`, with `after` awaited once, after the first compare-and-swap it answers. */
function afterFirstWrite(registry: MemoryRegistryDriver, after: () => Promise<void>) {
  let fired = false;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => Promise<unknown>;
      if (p !== 'compareAndSwap') return fn.bind(t);
      return async (...a: unknown[]) => {
        const out = await fn.apply(t, a);
        if (!fired) {
          fired = true;
          await after();
        }
        return out;
      };
    },
  });
}

describe('a keep-2 load raced by a load with a keep above 64', () => {
  // Generations 0 to 5 are loaded at keep 2, and a keep-2 load (6) is followed, after its first conditional write, by a
  // load with keep 1000 (7). A release before ledgers recorded no list for the keep-1000 load, so the keep-2 load's later
  // eviction was stopped by the changed row and left 3: 3, 4, 5, 6 and 7. The keep-1000 load here carries the ledger
  // with 3 still named, so the keep-2 load's eviction of 3 goes through: 4, 5, 6 and 7.
  it('lets the earlier load’s eviction through', async () => {
    const w = world();
    for (let i = 0; i < 6; i++) await load(w, 2);
    const registry = afterFirstWrite(w.registry, async () => {
      await load(w, 1000);
    });
    await load(w, 2, { registry });
    expect(await gens(w.storage)).toEqual([4, 5, 6, 7]);
  });
});

describe('the current object found gone only after the publish', () => {
  // Generations 0 to 5 are loaded with the default keep (4 and 5 are left), 5 is removed from outside, and the repair
  // publishes 6 and lists, keeping 4: 4 and 6, here and before ledgers. A release before ledgers recorded, with that
  // listing, a window of [4], and the next load (7) collected 4 as it moved past the window: 6 and 7. The repair's
  // ledger here names the gone 5 and 6, the listing kept 4 outside it, and the next load collects by name, which names
  // neither 4 nor 5 as pushed out: 4, 6 and 7. The bucket holds 4 longer, until a load that lists.
  it('keeps the generation the repair’s listing kept until a load that lists', async () => {
    const w = world();
    for (let i = 0; i < 6; i++) await loadSegment(SEG, [i, 100 + i, 200], w.deps);
    await w.storage.delete({ ...SEG, generation: 5 });
    await loadSegment(SEG, [1, 2, 3], w.deps);
    expect(await gens(w.storage)).toEqual([4, 6]);
    await loadSegment(SEG, [4, 5, 6], w.deps);
    expect(await gens(w.storage)).toEqual([4, 6, 7]);
  });
});

describe('generations an erasure deleted above the pointer', () => {
  // Generations 0 to 7 are loaded at keep 12, 2, 5, 6 and 7 holding one id, a crashed object is left at 10, the row is
  // rolled back to 1, a load publishes 11, the row is rolled back to 0, and a subject erasure of the id deletes 2, 5, 6
  // and 7 above the pointer. Loads then publish 11 and 12 again, a stray is left at 5, and three more loads publish, the last at 16 (a number the stray at 5 and the others made it skip to). A release before ledgers had dropped its list at the rollback, so each load counted over what was there and the
  // bucket after 16 was 0, 1, 3, 4, 10 and 11 to 16. Here the ledger still names the deleted 2, 5, 6 and 7 until a load
  // drops them, and the names take places in the window; the rollbacks carried the ledger, which names 0 and 1 as well. 10,
  // which the ledger does not name, goes at the load that lists (generation 16), leaving 0, 1, 3, 4, 5 and 11 to 16.
  it('take places in the window, so the load that lists collects what a count would have kept', async () => {
    const w = world();
    for (let g = 0; g <= 7; g++) {
      const held = [2, 5, 6, 7].includes(g) ? [7777] : [];
      await loadSegment(SEG, [g, 100 + g, ...held], w.deps, { keep: 12 });
    }
    await plant(w, 10);
    await rollbackSegment(SEG, 1, w.deps, {});
    await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 12 });
    await rollbackSegment(SEG, 0, w.deps, {});
    await eraseIdFromSegment(SEG, 7777, w.deps);
    await load(w, 12);
    await load(w, 12);
    await plant(w, 5);
    await load(w, 12);
    await load(w, 12);
    await load(w, 12);
    expect(await gens(w.storage)).toEqual([0, 1, 3, 4, 5, 11, 12, 13, 14, 15, 16]);
  });
});
