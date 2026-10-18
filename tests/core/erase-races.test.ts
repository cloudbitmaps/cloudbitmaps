import { randomBytes } from 'node:crypto';
import { openGenerationReader } from '@/core/crbm-open';
import { type EraseIdResult, eraseIdFromSegment } from '@/core/erase-id';
import { dropSegment } from '@/core/erasure';
import { NotFoundError, TransientError, WriteConflictError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IAuditSink, SegmentRef } from '@/index';
import type {
  GenKey,
  KnownGeneration,
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
} from '@cloudbitmaps/core/driver-kit';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy, zeroEntropy } from '../helpers/entropy';
import { gate } from '../helpers/retaken-number-race';

/**
 * Interleavings of an erasure with another writer that no other test pins. Each case holds the erasure at one exact
 * call of the registry or the storage, lets the other writer act, and checks what the erasure then reports and
 * deletes.
 */
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const X = 42;
const Y = 43;

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return {
    storage,
    registry,
    deps: { storage, registry, codec: roaringCodec, entropy: testEntropy },
  };
}

type Deps = ReturnType<typeof world>['deps'];

/** A registry whose calls are routed through `patch`, and the rest to `registry`. */
function overRegistry(registry: IRegistryDriver, patch: Partial<IRegistryDriver>): IRegistryDriver {
  return Object.assign(Object.create(registry) as IRegistryDriver, patch);
}

/** A storage whose calls are routed through `patch`, and the rest to `storage`. */
function overStorage(storage: IStorageDriver, patch: Partial<IStorageDriver>): IStorageDriver {
  return Object.assign(Object.create(storage) as IStorageDriver, patch);
}

/** Generation 0 is current and clean; generation 1 holds `X` and sits above the pointer, after a rollback. */
async function holderAbovePointer(deps: Deps): Promise<void> {
  await loadSegment(SEG, [1, 2, 3], deps);
  await loadSegment(SEG, [1, 2, 3, X], deps);
  await rollbackSegment(SEG, 0, deps);
}

/** The generation numbers in the bucket, ascending. */
async function generationsOf(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/**
 * A storage whose delete of `generation` is preceded by an operator's rollback of the pointer onto it: the object is
 * still there when the rollback checks it, and gone when the pointer is next read. `then` runs right after the rollback.
 */
function rollbackBeforeDeleting(
  storage: IStorageDriver,
  deps: Deps,
  generation: number,
  then: () => Promise<void> = () => Promise.resolve(),
): IStorageDriver {
  let rolled = false;
  return overStorage(storage, {
    delete: async (key, options) => {
      if (key.generation === generation && !rolled) {
        rolled = true;
        await rollbackSegment(SEG, generation, deps, { allowUnknown: true });
        await then();
      }
      return storage.delete(key, options);
    },
  });
}

/**
 * A storage whose first delete is preceded by `during` and by the replacement of the object under that number with
 * another that holds `X`: the delete the erasure sends, conditioned on the object it searched, is then refused.
 */
function replacingBeforeFirstDelete(
  storage: IStorageDriver,
  during: () => Promise<void>,
): IStorageDriver {
  let first = true;
  return overStorage(storage, {
    delete: async (key, options) => {
      if (first) {
        first = false;
        await storage.delete(key);
        await bulkLoadCrbmGeneration(storage, key, [1, 2, 3, X, 5], {
          registry: new MemoryRegistryDriver(),
          publish: false,
        });
        await during();
      }
      return storage.delete(key, options);
    },
  });
}

/**
 * A registry that does not report its writes' tokens, whose write of the rewrite's pointer to generation 3 does not
 * land: the rewrite's object under 3 is freed meanwhile (a second erasure's collection, with an operator's rollback
 * refusing it before it reached generation 2, can do that), a load of `ids` takes the number 3 and publishes it, and the
 * write gets no answer. The publish settles it by the object under the number.
 */
function rewriteLostToLoad(w: ReturnType<typeof world>, ids: number[]): IRegistryDriver {
  const wrapped = overRegistry(w.registry, {
    compareAndSwap: async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
      if (args[2].currentGen !== 3) return w.registry.compareAndSwap(...args);
      await w.storage.delete({ ...SEG, generation: 3 });
      await loadSegment(SEG, ids, w.deps);
      throw new TransientError('the write got no answer');
    },
  });
  Object.defineProperty(wrapped, 'reportsWriteTokens', { value: false });
  return wrapped;
}

/**
 * A registry that runs `act` once, right after the first write of the row that succeeds: the erasure's own write, the
 * one that renews the row before it deletes anything.
 */
function afterFirstWrite(registry: IRegistryDriver, act: () => Promise<void>): IRegistryDriver {
  let acted = false;
  return overRegistry(registry, {
    compareAndSwap: async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
      const out = await registry.compareAndSwap(...args);
      if (!acted) {
        acted = true;
        await act();
      }
      return out;
    },
  });
}

/** What a call came to: its result, or the error it was rejected with, so one assertion reads either. */
async function settled<T>(call: Promise<T>): Promise<T | Error> {
  try {
    return await call;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** What the erasure's audit sink saw, in order. */
function recordingAudit(): { audit: IAuditSink; kinds: string[] } {
  const kinds: string[] = [];
  return { kinds, audit: { onEvent: (e) => void kinds.push(e.kind) } };
}

/** A storage that counts the deletes sent to it. */
function countingDeletes(storage: IStorageDriver): {
  storage: IStorageDriver;
  deletes: GenKey[];
} {
  const deletes: GenKey[] = [];
  return {
    deletes,
    storage: overStorage(storage, {
      delete: (key, options) => {
        deletes.push(key);
        return storage.delete(key, options);
      },
    }),
  };
}

/**
 * Runs `act` once, at the erasure's fence: after the storage was first listed (the search of the bucket) and before the
 * next read of the row. The read answers with what `act` returns, or with the row itself when it returns nothing.
 */
function atFence(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  act: () => Promise<RegistryRecord | void>,
): { storage: IStorageDriver; registry: IRegistryDriver } {
  let listed = false;
  let acted = false;
  return {
    storage: overStorage(storage, {
      list: (ref: SegmentRef) => {
        listed = true;
        return storage.list(ref);
      },
    }),
    registry: overRegistry(registry, {
      get: async (ref: SegmentRef) => {
        if (!listed || acted) return registry.get(ref);
        acted = true;
        return (await act()) ?? registry.get(ref);
      },
    }),
  };
}

/**
 * A segment of three generations, `keep` window wide, whose current generation 2 holds `X`: the erasure rewrites it as
 * generation 3 and deletes 0, 1 and 2. Returns the ledger entries the row holds for them, by generation.
 */
async function idInCurrentOfThree(
  deps: Deps,
  registry: IRegistryDriver,
): Promise<KnownGeneration[]> {
  const keep = { keep: 5 };
  await loadSegment(SEG, [1, 2, 3], deps, keep);
  await loadSegment(SEG, [1, 2, 3, 4], deps, keep);
  await loadSegment(SEG, [1, 2, 3, X], deps, keep);
  return [...(await registry.get(SEG))!.knownGens!];
}

/**
 * A rollback onto generations and back, as the row leaves it: its ledger names them again. It is written at the start
 * of each collection pass made once the pointer is `pointer`: pass `n` finds the generations `windows[n]` that it meant
 * to delete named by the row, and spares them. A pass past the last window finds the row as the erasure left it.
 */
function nameDoomedAgain(
  storage: IStorageDriver,
  registry: IRegistryDriver,
  windows: readonly (readonly KnownGeneration[])[],
  pointer: number,
): { storage: IStorageDriver; registry: IRegistryDriver } {
  let listed = false;
  let named = 0;
  return {
    storage: overStorage(storage, {
      list: (ref: SegmentRef) => {
        listed = true;
        return storage.list(ref);
      },
    }),
    registry: overRegistry(registry, {
      get: async (ref: SegmentRef) => {
        const row = await registry.get(ref);
        if (row?.currentGen !== pointer) listed = false;
        const window = windows[named];
        if (row === null || !listed || window === undefined) return row;
        listed = false;
        named += 1;
        const names = new Set(window.map((e) => e.generation));
        const others = row.knownGens!.filter((e) => !names.has(e.generation));
        await registry.compareAndSwap(ref, row.token, {
          knownGens: [...window, ...others],
        });
        return registry.get(ref);
      },
    }),
  };
}

describe('an erasure that races another writer', () => {
  it('answers superseded, and leaves the holder to a re-run that erases it, when its row is purged and created again without a pointer', async () => {
    const w = world();
    await holderAbovePointer(w.deps);
    const counted = countingDeletes(w.storage);
    // After the erasure's first write, an out-of-band purge of the row, and a retention policy that creates it again: a
    // row with no pointer over a bucket that still holds the id.
    const registry = afterFirstWrite(w.registry, async () => {
      await w.registry.delete(SEG);
      await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: Date.now() + 1e9 });
    });
    const res = await eraseIdFromSegment(SEG, X, {
      ...w.deps,
      storage: counted.storage,
      registry,
    });
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      collected: [],
    });
    expect(counted.deletes).toEqual([]);
    expect(await generationsOf(w.storage)).toEqual([0, 1]);
    // The re-run reads a row with no pointer, searches its bucket and finds the holder.
    const again = await eraseIdFromSegment(SEG, X, w.deps);
    expect(again).toMatchObject({ erased: true, collected: [1] });
    expect(await generationsOf(w.storage)).toEqual([0]);
  });

  it('answers superseded, not no-generation, when a hand-made write clears the pointer of its row before the fence', async () => {
    const w = world();
    await holderAbovePointer(w.deps);
    const counted = countingDeletes(w.storage);
    const seen = atFence(counted.storage, w.registry, async () => {
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, { currentGen: null });
    });
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, ...seen });
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      collected: [],
    });
    expect(counted.deletes).toEqual([]);
    expect(await generationsOf(w.storage)).toEqual([0, 1]);
  });

  it('answers no-generation when its first read finds a row with no generation and a bucket that holds nothing', async () => {
    const w = world();
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: Date.now() + 1e9 });
    expect((await w.registry.get(SEG))!.currentGen).toBeNull();
    const res = await eraseIdFromSegment(SEG, X, w.deps);
    expect(res).toMatchObject({
      erased: false,
      reason: 'no-generation',
      collected: [],
    });
  });

  it('refuses as superseded, and deletes nothing, when the row is re-created under another incarnation and dropped before the fence', async () => {
    const w = world();
    await holderAbovePointer(w.deps);
    const counted = countingDeletes(w.storage);
    // A purge, a load that creates the name again (generation 2), and the first write of a drop, which tombstones the
    // row before its sweep runs. The tombstone stays.
    const seen = atFence(counted.storage, w.registry, async () => {
      await w.registry.delete(SEG);
      await loadSegment(SEG, [100, 101], w.deps);
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, {
        status: 'destroyed',
        summary: undefined,
        knownGens: undefined,
        leases: undefined,
      });
    });
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, ...seen });
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      collected: [],
    });
    expect(counted.deletes).toEqual([]);
    expect(await generationsOf(w.storage)).toEqual([1, 2]);
  });

  it('refuses as superseded, and deletes nothing, when the pointer moves past only some of the holders before the fence', async () => {
    const w = world();
    const keep = { keep: 5 };
    await loadSegment(SEG, [1, 2, 3], w.deps, keep);
    await loadSegment(SEG, [1, 2, 3, X], w.deps, keep);
    await loadSegment(SEG, [1, 2, 3], w.deps, keep);
    await loadSegment(SEG, [1, 2, 3, X], w.deps, keep);
    await rollbackSegment(SEG, 0, w.deps);
    const counted = countingDeletes(w.storage);
    // Generations 1 and 3 hold the id above the pointer; a rollback then puts the pointer between them.
    const seen = atFence(counted.storage, w.registry, async () => {
      await rollbackSegment(SEG, 2, w.deps);
    });
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, ...seen });
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      collected: [],
    });
    expect(counted.deletes).toEqual([]);
    expect(await generationsOf(w.storage)).toEqual([0, 1, 2, 3]);
  });

  it('collects again after each collection that spared a generation the row named again after a rollback onto it and back, and reports every generation it deleted', async () => {
    const w = world();
    const entries = await idInCurrentOfThree(w.deps, w.registry);
    const two = entries.filter((e) => e.generation === 2);
    const seen = nameDoomedAgain(w.storage, w.registry, [two, two, two], 3);
    // A pass that stops early is a rejection, which an assertion on the result alone would report as a bare error.
    const res = await settled(eraseIdFromSegment(SEG, X, { ...w.deps, ...seen }));
    expect(res).not.toBeInstanceOf(Error);
    expect(res).toMatchObject({
      erased: true,
      fromGeneration: 2,
      generation: 3,
      collected: expect.arrayContaining([0, 1, 2]),
    });
    expect(res).toHaveProperty('collected.length', 3);
    expect(await generationsOf(w.storage)).toEqual([3]);
  });

  it('raises the rollback onto a generation it deleted, after the rewrite event, when the pass that met it spared nothing more', async () => {
    const w = world();
    const entries = await idInCurrentOfThree(w.deps, w.registry);
    const two = entries.filter((e) => e.generation === 2);
    const named = nameDoomedAgain(w.storage, w.registry, [two], 3);
    const storage = rollbackBeforeDeleting(named.storage, w.deps, 2);
    const { audit, kinds } = recordingAudit();
    const call = eraseIdFromSegment(SEG, X, { ...w.deps, ...named, storage }, { audit });
    const err = await settled(call);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/an erasure deleted generation 2/);
    expect(kinds).toContain('segment.rewrite');
  });

  it('stops collecting again at a rollback onto a generation it deleted, though the pass also spared another and the rollback undoes itself only after the call read the row twice', async () => {
    const w = world();
    const entries = await idInCurrentOfThree(w.deps, w.registry);
    const named = nameDoomedAgain(
      w.storage,
      w.registry,
      [
        entries.filter((e) => e.generation === 1 || e.generation === 2),
        entries.filter((e) => e.generation === 2),
      ],
      3,
    );
    // An operator's rollback onto generation 1 lands before the erasure's delete of it and, being slow, undoes itself
    // after the call's two reads of the row that look for the pointer on the deleted object: the pointer goes back to 3
    // and the ledger drops 1, as a rollback's undo writes them. The call raises for the operator to check, as it does
    // when every read it makes still names the missing object.
    let before: RegistryRecord | undefined;
    let reads = -1;
    const registry = overRegistry(named.registry, {
      get: async (ref: SegmentRef) => {
        if (reads >= 0) {
          reads += 1;
          if (reads === 3) {
            const row = (await w.registry.get(SEG))!;
            await w.registry.compareAndSwap(SEG, row.token, {
              currentGen: before!.currentGen,
              summary: before!.summary,
              knownGens: before!.knownGens!.filter((e) => e.generation !== 1),
            });
          }
        }
        return named.registry.get(ref);
      },
    });
    const storage = overStorage(named.storage, {
      delete: async (key, options) => {
        if (key.generation === 1 && before === undefined) {
          before = (await w.registry.get(SEG))!;
          await rollbackSegment(SEG, 1, w.deps, { allowUnknown: true });
          await named.storage.delete(key, options);
          reads = 0;
          return;
        }
        return named.storage.delete(key, options);
      },
    });
    const err = await settled(eraseIdFromSegment(SEG, X, { ...w.deps, registry, storage }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/an erasure deleted generation 1/);
  });

  it('searches the tombstone and erases when the object it meant to delete is replaced and the row is dropped meanwhile', async () => {
    const w = world();
    await holderAbovePointer(w.deps);
    const storage = replacingBeforeFirstDelete(w.storage, async () => {
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, {
        status: 'destroyed',
        summary: undefined,
        knownGens: undefined,
        leases: undefined,
      });
    });
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, storage });
    // A tombstone is searched as a fresh call searches one: the replacement holds the id, so every object under it goes.
    expect(res).toMatchObject({ erased: true, collected: [0, 1] });
    expect(await generationsOf(w.storage)).toEqual([]);
  });

  it('reports the row as absent, not superseded, when the object it meant to delete is replaced and the row is purged meanwhile', async () => {
    const w = world();
    await holderAbovePointer(w.deps);
    const storage = replacingBeforeFirstDelete(w.storage, () => w.registry.delete(SEG));
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, storage });
    expect(res).toMatchObject({ erased: false, reason: 'absent' });
    // The load's object stays: the call's delete was conditioned on the object it searched.
    expect(await generationsOf(w.storage)).toEqual([0, 1]);
  });

  it('reports none erased, and deletes nothing, when the rewrite got no answer and a load took its number with other bytes', async () => {
    const w = world();
    await idInCurrentOfThree(w.deps, w.registry);
    const { audit, kinds } = recordingAudit();
    const registry = rewriteLostToLoad(w, [7, 8, 9]);
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, registry }, { audit });
    expect(res).toMatchObject({
      erased: false,
      reason: 'superseded',
      collected: [],
    });
    // Generation 2 still holds the id, and 3 is the load's.
    expect(await generationsOf(w.storage)).toEqual([2, 3]);
    expect(kinds).not.toContain('segment.rewrite');
  });

  it('reports none erased, and deletes nothing, when the rewrite got no answer and a load of the same ids took its number', async () => {
    const w = world();
    await idInCurrentOfThree(w.deps, w.registry);
    const { audit, kinds } = recordingAudit();
    const registry = rewriteLostToLoad(w, [1, 2, 3]);
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, registry }, { audit });
    // The load wrote the same chunks under another write identity, so its footer is not the rewrite's.
    expect(res).toMatchObject({ erased: false, reason: 'superseded', collected: [] });
    expect(await generationsOf(w.storage)).toEqual([2, 3]);
    expect(kinds).not.toContain('segment.rewrite');
  });

  it('stands on the rewrite when it got no answer and a load took its number with the same ids and the same write identity', async () => {
    // Only a footer that is the rewrite's own can be taken for it: two writers drawing the same identity (here all
    // zero) write the same bytes.
    const w = world();
    const zero = { ...w, deps: { ...w.deps, entropy: zeroEntropy } };
    await idInCurrentOfThree(zero.deps, zero.registry);
    const { audit, kinds } = recordingAudit();
    const registry = rewriteLostToLoad(zero, [1, 2, 3]);
    const res = await eraseIdFromSegment(SEG, X, { ...zero.deps, registry }, { audit });
    expect(res).toMatchObject({ erased: true, generation: 3 });
    expect(await generationsOf(zero.storage)).toEqual([3]);
    expect(kinds).toContain('segment.rewrite');
  });
});

/**
 * The name dropped (its tombstone's sweep deletes every object), the tombstone purged, and a first load of `[1, 2, 3, X]`
 * that takes number 0: published, it creates the row again; unpublished, it writes onto a row a retention policy made,
 * which has no pointer.
 */
async function recreatedHolding(
  w: ReturnType<typeof world>,
  shape: 'published' | 'unpublished',
): Promise<void> {
  await dropSegment(SEG, { storage: w.storage, registry: w.registry }, { confirmSegment: 's' });
  await w.registry.delete(SEG);
  if (shape === 'published') {
    await loadSegment(SEG, [1, 2, 3, X], w.deps);
    return;
  }
  await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: Date.now() + 1e9 });
  await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [1, 2, 3, X], {
    registry: new MemoryRegistryDriver(),
    publish: false,
  });
}

/** Whether the object under `generation` holds `X`. */
async function holdsX(storage: IStorageDriver, generation: number): Promise<boolean> {
  const reader = await openGenerationReader(storage, { ...SEG, generation }, undefined);
  const bytes = await reader.getChunk(0);
  return bytes !== null && roaringCodec.safeDeserialize(bytes, 1 << 20).has(X);
}

/** A registry for one load, whose first write of the row (its publish, once its object is written) waits at `at`. */
function heldAtPublish(registry: IRegistryDriver, at: ReturnType<typeof gate>): IRegistryDriver {
  let held = false;
  return overRegistry(registry, {
    compareAndSwap: async (...args: Parameters<IRegistryDriver['compareAndSwap']>) => {
      if (!held) {
        held = true;
        at.reach();
        await at.opened;
      }
      return registry.compareAndSwap(...args);
    },
  });
}

/**
 * A storage that notes the generations whose tail it reads from the first listing after a delete on, which is the
 * receipt's: what the receipt opens. `listed` says whether that listing has been made.
 */
function openedByReceipt(storage: IStorageDriver): {
  storage: IStorageDriver;
  opened: number[];
  listed: () => boolean;
} {
  let deleted = false;
  let listed = false;
  const opened: number[] = [];
  return {
    opened,
    listed: () => listed,
    storage: overStorage(storage, {
      delete: async (key, options) => {
        await storage.delete(key, options);
        deleted = true;
      },
      list: (ref: SegmentRef) => {
        listed ||= deleted;
        return storage.list(ref);
      },
      getTail: (key, maxBytes) => {
        if (listed) opened.push(key.generation);
        return storage.getTail(key, maxBytes);
      },
    }),
  };
}

/** Loads with `keep: 5` make 0 `[1, 2, 3]`, 1 `[1, 2, 3, Y]` and 2 `[1, 2, 3, X]`, then a rollback onto 0. */
async function cleanAndHolderAbove(deps: Deps): Promise<void> {
  const keep = { keep: 5 };
  await loadSegment(SEG, [1, 2, 3], deps, keep);
  await loadSegment(SEG, [1, 2, 3, Y], deps, keep);
  await loadSegment(SEG, [1, 2, 3, X], deps, keep);
  await rollbackSegment(SEG, 0, deps);
}

describe('a generation the erasure found clean, whose number another object takes', () => {
  it.each(['published', 'unpublished'] as const)(
    'reads it again when the name is dropped, purged and created again and a first load of the id takes that number (%s)',
    async (shape) => {
      const w = world();
      await holderAbovePointer(w.deps);
      // Generation 0 is current and clean, 1 holds the id. After the fence's write, the object the call found clean
      // is swept with the name, and a first load of the id takes its number.
      const registry = afterFirstWrite(w.registry, () => recreatedHolding(w, shape));
      const res = await eraseIdFromSegment(SEG, X, { ...w.deps, registry });
      expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 1 });
      expect(await generationsOf(w.storage)).toEqual([0]);
      // The re-run finds the id in the object under 0, on the row as it now is.
      expect(await eraseIdFromSegment(SEG, X, w.deps)).toMatchObject({
        erased: true,
        collected: [0],
      });
    },
  );

  it('reads the row after its last listing, so a re-creation that lands inside that listing is read', async () => {
    const w = world();
    await holderAbovePointer(w.deps);
    // The call deletes generation 1, which holds the id, then lists the bucket for its receipt. The drop, the purge and
    // the first load land inside that listing: the row it read before the listing still names the clean object under 0.
    let deleted = false;
    let acted = false;
    const storage = overStorage(w.storage, {
      delete: async (key, options) => {
        await w.storage.delete(key, options);
        deleted = true;
      },
      list: (ref: SegmentRef) =>
        (async function* () {
          if (deleted && !acted) {
            acted = true;
            await recreatedHolding(w, 'published');
          }
          yield* w.storage.list(ref);
        })(),
    });
    await expect(eraseIdFromSegment(SEG, X, { ...w.deps, storage })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(acted).toBe(true);
    expect(await generationsOf(w.storage)).toEqual([0]);
  });

  it('reads it again when another erasure deletes it and a load takes its number, within one incarnation of the row', async () => {
    const w = world();
    const keep = { keep: 5 };
    await loadSegment(SEG, [1, 2, 3], w.deps, keep);
    await loadSegment(SEG, [1, 2, 3, Y], w.deps, keep);
    await loadSegment(SEG, [1, 2, 3, X], w.deps, keep);
    await rollbackSegment(SEG, 0, w.deps);
    // The erasure of X finds 0 and 1 clean and 2 holding it. Right after its delete of 2, an erasure of Y deletes 1,
    // and a load of X reads that row and numbers 1, which is free and one above the pointer, and publishes it.
    let other: EraseIdResult | undefined;
    const storage = overStorage(w.storage, {
      delete: async (key, options) => {
        await w.storage.delete(key, options);
        if (key.generation === 2 && other === undefined) {
          other = await eraseIdFromSegment(SEG, Y, w.deps);
          await loadSegment(SEG, [1, 2, 3, X], w.deps);
        }
      },
    });
    await expect(eraseIdFromSegment(SEG, X, { ...w.deps, storage })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(other).toMatchObject({ erased: true, collected: [1] });
    // The current generation holds the id, under a number the call found clean, and the re-run erases it there.
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    expect(await eraseIdFromSegment(SEG, X, w.deps)).toMatchObject({
      erased: true,
      fromGeneration: 1,
    });
  });

  it('names a holder it can search as one that still holds the id, when a load takes the number of an object it could not search', async () => {
    const w = world();
    await loadSegment(SEG, [1, 2, 3], w.deps); // 0, cleartext
    // A first load that minted a key and lost the race to the cleartext one: an object no read of the segment can open,
    // above the pointer, which the erasure counts as a holder and deletes.
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 1 }, [7], {
      registry: new MemoryRegistryDriver(),
      keystore,
      publish: false,
    });
    // Right after that delete, a load of X numbers 1, one above the pointer and free, and publishes it.
    let loaded = false;
    const storage = overStorage(w.storage, {
      delete: async (key, options) => {
        await w.storage.delete(key, options);
        if (key.generation === 1 && !loaded) {
          loaded = true;
          await loadSegment(SEG, [1, 2, 3, X], w.deps);
        }
      },
    });
    const err = await settled(eraseIdFromSegment(SEG, X, { ...w.deps, storage }));
    expect(loaded).toBe(true);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toMatch(/generation 1, which still holds the id and/);
  });

  it('reads it again when a load that seeds the ledger from the bucket names the object another erasure then deletes, and a load takes its number', async () => {
    const w = world();
    await cleanAndHolderAbove(w.deps);
    // A hand-made write that drops the row's ledger: the next publish seeds one from the bucket.
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    // The erasure of Y: just before its delete of 1, a load starts, numbers 2, seeds its ledger from the bucket (reading
    // the footer of 1, which holds Y) and waits at its publish.
    const seeding = gate();
    let seeded: ReturnType<typeof loadSegment> | undefined;
    const forY = overStorage(w.storage, {
      delete: async (key, options) => {
        if (key.generation === 1 && seeded === undefined) {
          seeded = loadSegment(
            SEG,
            [1, 2, 3],
            { ...w.deps, registry: heldAtPublish(w.registry, seeding) },
            {
              keep: 5,
            },
          );
          await seeding.reached;
        }
        return w.storage.delete(key, options);
      },
    });
    // The erasure of X finds 0 and 1 clean and 2 holding it. Right after its delete of 2, the erasure of Y deletes 1; a
    // load of X reads that row, numbers 1, which is free and one above the pointer, and waits at its publish; the seeding
    // load publishes a ledger that names 1 with the checksum of the object deleted; and the load of X is refused, which
    // leaves its object, since the row changed.
    let other: EraseIdResult | undefined;
    let ofX: Awaited<ReturnType<typeof loadSegment>> | undefined;
    const storage = overStorage(w.storage, {
      delete: async (key, options) => {
        await w.storage.delete(key, options);
        if (key.generation === 2 && other === undefined) {
          other = await eraseIdFromSegment(SEG, Y, { ...w.deps, storage: forY });
          const held = gate();
          const loading = loadSegment(SEG, [1, 2, 3, X], {
            ...w.deps,
            registry: heldAtPublish(w.registry, held),
          });
          await held.reached;
          seeding.open();
          await seeded;
          held.open();
          ofX = await loading;
        }
      },
    });
    await expect(eraseIdFromSegment(SEG, X, { ...w.deps, storage })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(other).toMatchObject({ erased: true, collected: [1] });
    expect(ofX).toMatchObject({ published: false });
    // The row names 1, and the object under it holds X.
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)).toContain(1);
    expect(await holdsX(w.storage, 1)).toBe(true);
  });

  it('reads it again when a lifecycle rule deletes it and a load of the id takes its number before the receipt', async () => {
    const w = world();
    await cleanAndHolderAbove(w.deps);
    // Right after the erasure's delete of 2, an object delete from outside the library (a lifecycle rule) removes 1,
    // which the row still names, and a load of X reads the row, numbers 1, writes it and waits at its publish.
    const held = gate();
    let loading: ReturnType<typeof loadSegment> | undefined;
    const storage = overStorage(w.storage, {
      delete: async (key, options) => {
        await w.storage.delete(key, options);
        if (key.generation === 2 && loading === undefined) {
          await w.storage.delete({ ...SEG, generation: 1 });
          loading = loadSegment(SEG, [1, 2, 3, X], {
            ...w.deps,
            registry: heldAtPublish(w.registry, held),
          });
          await held.reached;
        }
      },
    });
    await expect(eraseIdFromSegment(SEG, X, { ...w.deps, storage })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    held.open();
    expect(await loading).toMatchObject({ published: true, generation: 1 });
  });

  it.each(['collect', 'rewrite'] as const)(
    'keeps its answer and its event when its read of the row after the last listing fails (%s): it opens every generation listed',
    async (shape) => {
      const w = world();
      const first = shape === 'collect' ? [1, X] : [1];
      await loadSegment(SEG, first, w.deps, { keep: 1 });
      await loadSegment(SEG, shape === 'collect' ? [1] : [1, X], w.deps, { keep: 1 });
      // The first listing after a delete is the receipt's, and the first read of the row after it fails.
      const { storage, opened, listed } = openedByReceipt(w.storage);
      let failed = false;
      const registry = overRegistry(w.registry, {
        get: async (ref: SegmentRef) => {
          if (listed() && !failed) {
            failed = true;
            throw new TransientError('the registry is throttled');
          }
          return w.registry.get(ref);
        },
      });
      const { audit, kinds } = recordingAudit();
      const res = await eraseIdFromSegment(SEG, X, { ...w.deps, storage, registry }, { audit });
      expect(failed).toBe(true);
      expect(res).toMatchObject({ erased: true });
      expect(kinds).toEqual([shape === 'collect' ? 'segment.collect' : 'segment.rewrite']);
      // Nothing vouched for: the one generation left, the current one, is opened again.
      expect(opened).toEqual(await generationsOf(w.storage));
      expect(opened).toHaveLength(1);
    },
  );

  it('opens again the generation it found current when the row names it with its checksum in a ledger that does not end with it', async () => {
    const w = world();
    await loadSegment(SEG, [1, X], w.deps, { keep: 1 }); // 0 holds
    await loadSegment(SEG, [1], w.deps, { keep: 1 }); // 1, current and clean
    // A registry of your own that keeps the entries in another order: a ledger whose last entry is not the pointer is
    // read and not used, though it names 1 with its object's checksum.
    const registry = overRegistry(w.registry, {
      get: async (ref: SegmentRef) => {
        const got = await w.registry.get(ref);
        if (got?.knownGens === undefined) return got;
        return { ...got, knownGens: [...got.knownGens].reverse() };
      },
    });
    const { storage, opened } = openedByReceipt(w.storage);
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, storage, registry });
    expect(res).toMatchObject({ erased: true, collected: [0] });
    expect(opened).toEqual([1]);
  });
});
