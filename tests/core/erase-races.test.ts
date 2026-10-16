import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError, TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type {
  GenKey,
  IAuditSink,
  KnownGeneration,
  IRegistryDriver,
  IStorageDriver,
  RegistryRecord,
  SegmentRef,
} from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Interleavings of an erasure with another writer that no other test pins. Each case holds the erasure at one exact
 * call of the registry or the storage, lets the other writer act, and checks what the erasure then reports and
 * deletes.
 */
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const X = 42;

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return {
    storage,
    registry,
    deps: { storage, registry, codec: roaringCodec },
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
    });
    expect([...(res as { collected: number[] }).collected].sort()).toEqual([0, 1, 2]);
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

  it('stands on the rewrite when it got no answer and a load took its number with the same bytes', async () => {
    const w = world();
    await idInCurrentOfThree(w.deps, w.registry);
    const { audit, kinds } = recordingAudit();
    const registry = rewriteLostToLoad(w, [1, 2, 3]);
    const res = await eraseIdFromSegment(SEG, X, { ...w.deps, registry }, { audit });
    expect(res).toMatchObject({ erased: true, generation: 3 });
    expect(await generationsOf(w.storage)).toEqual([3]);
    expect(kinds).toContain('segment.rewrite');
  });
});
