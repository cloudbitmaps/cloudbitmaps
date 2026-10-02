import fc from 'fast-check';
import { loadSegment, type LoadOptions } from '@/core/load';
import { LIST_COLLECTION_CADENCE, collectByName, gcOrphanGenerations } from '@/core/generation-gc';
import { TransientError, ValidationError } from '@/core/errors';
import { eraseIdFromSegment } from '@/core/erase-id';
import { dropSegment } from '@/core/erasure';
import { rollbackSegment } from '@/core/rollback';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * Collecting what a load supersedes, by name instead of by listing.
 *
 * A load that numbered its generation with one existence check (the number was free: nothing above the pointer)
 * and keeps at most one generation knows exactly which generation its publish pushed out of the grace window:
 * `generation - keep - 1`. It deletes that name, re-proving the row first, and lists nothing. A listing still runs
 * for `keep` of 2 or more, whenever the check met an object, and every sixteenth generation, which is what bounds
 * what the name-only pass leaves behind. These pin each of those, the safety of the delete, and that the name-only
 * pass never deletes what a listing would have kept.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const storageCalls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(memory, storageCalls);
  const counted = counting<IRegistryDriver>(registry, registryCalls);
  const reset = (): void => {
    for (const c of [storageCalls, registryCalls]) for (const k of Object.keys(c)) delete c[k];
  };
  return {
    memory,
    registry,
    storage,
    storageCalls,
    registryCalls,
    reset,
    deps: { storage, registry: counted, codec: roaringCodec },
  };
}
type World = ReturnType<typeof world>;

/** `target`, with `after` awaited once, the first time `method` resolves: an interleaving at a chosen step. */
function hookAfter<T extends object>(target: T, method: string, after: () => Promise<void>): T {
  let fired = false;
  return new Proxy(target, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== method) return (...a: unknown[]) => fn.apply(t, a);
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

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** Load `count` generations, each a larger id set than the last, so no load is refused as a shrink. */
async function loadMany(w: World, count: number, options: LoadOptions = {}): Promise<void> {
  const have = (await w.registry.get(SEG))?.currentGen ?? -1;
  for (let g = have + 1; g < have + 1 + count; g++) {
    const r = await loadSegment(
      SEG,
      Array.from({ length: g + 1 }, (_, i) => i),
      w.deps,
      options,
    );
    expect(r).toMatchObject({ generation: g, published: true });
  }
}

/** An object written and never published: what a crashed load leaves. */
async function orphan(storage: IStorageDriver, generation: number): Promise<void> {
  await bulkLoadCrbmGeneration(storage, { ...SEG, generation }, [7]);
}

describe('a load collects by name when its number was checked and keep is at most 1', () => {
  it('deletes the generation the window pushed out, with one pointer read and no listing', async () => {
    const w = world();
    await loadMany(w, 3);
    expect(await generations(w.memory)).toEqual([1, 2]);
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ generation: 3, published: true, collected: [1] });
    expect(w.storageCalls.list).toBeUndefined();
    expect(w.storageCalls.delete).toBe(1);
    // The row once before the publish, and again before the delete: that is the whole pass.
    expect(w.registryCalls.get).toBe(2);
    expect(await generations(w.memory)).toEqual([2, 3]);
  });

  it('with keep 0, deletes the generation it superseded', async () => {
    const w = world();
    await loadMany(w, 3, { keep: 0 });
    expect(await generations(w.memory)).toEqual([2]);
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 0 });
    expect(r).toMatchObject({ generation: 3, published: true, collected: [2] });
    expect(w.storageCalls.list).toBeUndefined();
    expect(await generations(w.memory)).toEqual([3]);
  });

  it('makes no request after the publish when nothing is yet outside the window', async () => {
    const w = world();
    // A first load reads the row twice (it found none, so it reads again after its ids) and nothing more.
    const first = await loadSegment(SEG, [1], w.deps);
    expect(first).toMatchObject({ generation: 0, collected: [] });
    expect(w.registryCalls.get).toBe(2);
    expect(w.storageCalls.list).toBeUndefined();
    expect(w.storageCalls.delete).toBeUndefined();
    // The second keeps both generations: its row read, and the re-proof it does not need.
    w.reset();
    const second = await loadSegment(SEG, [1, 2], w.deps);
    expect(second).toMatchObject({ generation: 1, collected: [] });
    expect(w.registryCalls.get).toBe(1);
    expect(w.storageCalls.list).toBeUndefined();
    expect(w.storageCalls.delete).toBeUndefined();
    // With keep 0 the second load already supersedes generation 0, and takes it by name.
    const w0 = world();
    await loadMany(w0, 1, { keep: 0 });
    const r = await loadSegment(SEG, [1, 2], w0.deps, { keep: 0 });
    expect(r).toMatchObject({ generation: 1, collected: [0] });
    expect(w0.storageCalls.list).toBeUndefined();
  });

  it('names a generation that was already gone without failing, and reports it collected', async () => {
    const w = world();
    await loadMany(w, 3);
    await w.memory.delete({ ...SEG, generation: 1 }); // gone already: an erasure took it, or a lifecycle rule
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ published: true, collected: [1] });
    expect(await generations(w.memory)).toEqual([2, 3]);
  });

  it('leaves a generation a pin holds inside the window, and takes it a load later', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    const ref = { segment: 'pinned' };
    // Two chunks, so the two checks below each read one the pin has not read before.
    const idsOf = (n: number): number[] => [...Array.from({ length: n }, (_, i) => i + 1), 70_000];
    for (const n of [1, 2, 3]) await store.load(ref, idsOf(n));
    const pin = await store.segment('pinned').pin();
    expect(await pin.count()).toBe(4);
    await store.load(ref, idsOf(4)); // takes the generation below the pinned one, not the pinned one
    expect(await pin.has(1)).toBe(true);
    await store.load(ref, idsOf(5)); // the pinned generation is now the one pushed out
    await expect(pin.has(70_000)).rejects.toThrow();
  });
});

describe('keep of 2 or more, and a number the check could not prove free, still list', () => {
  it('lists for keep 2, and a generation inside its window survives a refused neighbour', async () => {
    const w = world();
    await loadMany(w, 6, { keep: 2 }); // current 5, with 4 and 3 below it
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
    // A load wrote 6 and was refused later; another load meets 6, lists, and numbers 7, then 6 is deleted before
    // 7 publishes: 7 sits above a gap.
    await orphan(w.memory, 6);
    const racing = new Proxy(w.memory, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p !== 'putImmutable') return (...a: unknown[]) => fn.apply(t, a);
        return async (...a: Parameters<IStorageDriver['putImmutable']>) => {
          const out = await t.putImmutable(...a);
          if (a[0].generation === 7) await t.delete({ ...SEG, generation: 6 });
          return out;
        };
      },
    }) as IStorageDriver;
    const l2 = await loadSegment(
      SEG,
      [1, 2, 3, 4, 5, 6, 7, 8],
      { ...w.deps, storage: racing },
      { keep: 2 },
    );
    expect(l2).toMatchObject({ generation: 7, published: true });
    expect(await generations(w.memory)).toEqual([4, 5, 7]);
    // The next load numbers 8 with its check, a clean path. Collecting by name would take 8 - 2 - 1 = 5, which a
    // keep of 2 promised: the two newest below 8 are 7 and 5.
    w.reset();
    const l3 = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8, 9], w.deps, { keep: 2 });
    expect(l3).toMatchObject({ generation: 8, published: true });
    expect(w.storageCalls.list).toBe(1);
    expect(await generations(w.memory)).toEqual([5, 7, 8]);
    expect(l3.collected).toEqual([4]);
  });

  it('lists when the caller asks for a listing, whatever keep is', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 9 }); // 0 to 3 kept in full
    w.reset();
    const r = await loadSegment(
      SEG,
      [1, 2, 3, 4, 5],
      { ...w.deps, collectByListing: true },
      { keep: 0 },
    );
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(w.storageCalls.list).toBe(1);
    expect([...r.collected].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(await generations(w.memory)).toEqual([4]);
  });

  it('an *Into with keep clears every generation below the new one beyond the window, by listing', async () => {
    const memory = new MemoryStorage();
    const calls: Record<string, number> = {};
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting<IStorageDriver>(memory.storage, calls),
        registry: memory.registry,
      }),
    });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    await store.load({ segment: 'b' }, [2, 3]);
    const dest = store.segment('dest');
    // Fed by an *Into with no keep, which collects nothing: every generation stays.
    for (let i = 0; i < 4; i++) await store.segment('a').intersectInto(dest, [store.segment('b')]);
    const held = async (): Promise<number[]> => {
      const out: number[] = [];
      for await (const k of memory.storage.list({ segment: 'dest' })) out.push(k.generation);
      return out.sort((x, y) => x - y);
    };
    expect(await held()).toEqual([0, 1, 2, 3]);
    for (const k of Object.keys(calls)) delete calls[k];
    const res = await store.segment('a').intersectInto(dest, [store.segment('b')], { keep: 1 });
    expect(res).toMatchObject({ generation: 4, published: true });
    // A name-only pass would have taken 2 and left 0 and 1: the listing takes all but the newest below 4.
    expect(await held()).toEqual([3, 4]);
    expect(calls.list).toBe(1);
  });

  it('an erasure rewrite still lists, and collects every generation below its own', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 9 }); // generations 0 to 3 held in full, and 2 and 3 hold the id
    w.reset();
    const res = await eraseIdFromSegment(SEG, 2, w.deps);
    expect(res).toMatchObject({ erased: true, generation: 4 });
    // A name-only pass would have taken the one generation below the rewrite.
    expect(w.storageCalls.list).toBeGreaterThanOrEqual(1);
    expect([...res.collected].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(await generations(w.memory)).toEqual([4]);
  });

  it.each([2, 3, 4])('lists once for keep %i, as before', async (keep) => {
    const w = world();
    await loadMany(w, 5, { keep });
    w.reset();
    await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps, { keep });
    expect(w.storageCalls.list).toBe(1);
  });

  it('makes no request to collect when keep is at least its own generation: nothing can be outside the window', async () => {
    const w = world();
    await loadMany(w, 3, { keep: 9 });
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 3 }); // generation 3, window of 3
    expect(r).toMatchObject({ generation: 3, published: true, collected: [] });
    expect(w.storageCalls.list).toBeUndefined();
    expect(w.storageCalls.delete).toBeUndefined();
    expect(w.registryCalls.get).toBe(1); // the row before the publish, and nothing to collect
    // One generation later the window is outside it, so the pass lists.
    w.reset();
    await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps, { keep: 3 }); // generation 4
    expect(w.storageCalls.list).toBe(1);
  });

  it('a default *Into, which keeps everything, collects nothing and asks the bucket for nothing', async () => {
    const memory = new MemoryStorage();
    const calls: Record<string, number> = {};
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting<IStorageDriver>(memory.storage, calls),
        registry: memory.registry,
      }),
    });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    await store.load({ segment: 'b' }, [2, 3]);
    const dest = store.segment('dest');
    for (let i = 0; i < 3; i++) {
      for (const k of Object.keys(calls)) delete calls[k];
      const res = await store.segment('a').intersectInto(dest, [store.segment('b')]);
      expect(res).toMatchObject({ generation: i, published: true, collected: [] });
      expect(calls.list).toBeUndefined();
      expect(calls.delete).toBeUndefined();
    }
  });

  it('lists when the existence check fails to answer, and proves nothing about the number', async () => {
    const w = world();
    await loadMany(w, 4);
    let failed = false;
    const storage = new Proxy(w.deps.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p === 'getTail') {
          return (...a: unknown[]) => {
            if (a[1] === 0 && !failed) {
              failed = true;
              return Promise.reject(new TransientError('the check timed out'));
            }
            return fn.apply(t, a);
          };
        }
        return (...a: unknown[]) => fn.apply(t, a);
      },
    }) as IStorageDriver;
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5], { ...w.deps, storage });
    expect(failed).toBe(true);
    expect(r).toMatchObject({ generation: 4, published: true });
    // One listing to number it and one to collect: a check that errors does not make the pass by name.
    expect(w.storageCalls.list).toBe(2);
    expect(await generations(w.memory)).toEqual([3, 4]);
  });

  it("lists when the check meets a crashed load's object, and numbers past it", async () => {
    const w = world();
    await loadMany(w, 3);
    await orphan(w.memory, 3);
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ generation: 4, published: true });
    // One listing to number past the orphan and one to collect.
    expect(w.storageCalls.list).toBe(2);
    // The window keeps the newest below 4, the orphan at 3; the listing collects what is under it.
    expect(await generations(w.memory)).toEqual([3, 4]);
  });

  it('lists when a rollback left generations above the pointer', async () => {
    const w = world();
    await loadMany(w, 5, { keep: 9 });
    await rollbackSegment(SEG, 2, { storage: w.memory, registry: w.registry });
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ generation: 5, published: true });
    expect(w.storageCalls.list).toBe(2);
  });
});

describe('every sixteenth generation lists, which bounds what the name-only pass leaves', () => {
  it.each([0, 1])('lists on generations 16 and 32 and on no other, with keep %i', async (keep) => {
    const w = world();
    const listed: number[] = [];
    for (let g = 0; g < 34; g++) {
      w.reset();
      await loadSegment(
        SEG,
        Array.from({ length: g + 1 }, (_, i) => i),
        w.deps,
        { keep },
      );
      if (w.storageCalls.list !== undefined) listed.push(g);
    }
    expect(LIST_COLLECTION_CADENCE).toBe(16);
    expect(listed).toEqual([16, 32]);
  });

  // What the by-name loads leave of generations 0 to 5, kept in full by an earlier keep, and what the listing takes.
  it.each([
    {
      keep: 1,
      beforeThe16th: [0, 1, 2, 3, 14, 15], // each load took the generation two below it
      after: [15, 16],
      collected: [0, 1, 2, 3, 14],
    },
    {
      keep: 0,
      beforeThe16th: [0, 1, 2, 3, 4, 15], // each load took the generation just below it
      after: [16],
      collected: [0, 1, 2, 3, 4, 15],
    },
  ])(
    'collects what an earlier keep left behind on the next listing, and not before, with keep $keep',
    async ({ keep, beforeThe16th, after, collected }) => {
      const w = world();
      await loadMany(w, 6, { keep: 9 }); // 0 to 5, all kept
      await loadMany(w, 10, { keep }); // 6 to 15 by name
      expect(await generations(w.memory)).toEqual(beforeThe16th);
      const r = await loadSegment(
        SEG,
        Array.from({ length: 17 }, (_, i) => i),
        w.deps,
        { keep },
      ); // 16: listed
      expect(r).toMatchObject({ generation: 16, published: true });
      expect(await generations(w.memory)).toEqual(after);
      expect([...r.collected].sort((a, b) => a - b)).toEqual(collected);
    },
  );
});

describe("a name-only delete keeps invariant 4's re-proof", () => {
  /** A world at generation 4 (present 3 and 4), whose next load publishes 5 and so supersedes 3 by name. */
  async function atFour(): Promise<World> {
    const w = world();
    await loadMany(w, 5);
    expect(await generations(w.memory)).toEqual([3, 4]);
    return w;
  }
  const ids = [1, 2, 3, 4, 5, 6];

  it('collects nothing, and deletes nothing, when the row is gone at the delete: the publish stands', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', () => w.registry.delete(SEG));
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
  });

  it('collects nothing, and deletes nothing, when a rollback lands between the publish and the delete', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await rollbackSegment(SEG, 4, { storage: w.memory, registry: w.registry });
    });
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    // The load published, and the operator's rollback came after: the result says so, and the pointer is theirs.
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
    expect((await w.registry.get(SEG))?.currentGen).toBe(4);
  });

  it('collects nothing when the name was purged and re-created with a pointer below the published generation', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await w.registry.delete(SEG);
      await w.registry.create(SEG, { currentGen: 0 });
    });
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
  });

  /** `registry`, with `fault` thrown by its first read after the publish landed: the by-name pass's re-proof. */
  function failingAfterPublish(w: World, fault: Error): IRegistryDriver {
    let landed = false;
    return new Proxy(w.deps.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p === 'compareAndSwap') {
          return async (...a: unknown[]) => {
            const out = await fn.apply(t, a);
            landed = true;
            return out;
          };
        }
        if (p === 'get' && landed) return () => Promise.reject(fault);
        return (...a: unknown[]) => fn.apply(t, a);
      },
    }) as IRegistryDriver;
  }

  it('lets a fault in the re-proof through: the load rejects, its publish landed, nothing else was deleted', async () => {
    const w = await atFour();
    const fault = new TransientError('registry read failed');
    const registry = failingAfterPublish(w, fault);
    await expect(loadSegment(SEG, ids, { ...w.deps, registry })).rejects.toBe(fault);
    expect((await w.registry.get(SEG))?.currentGen).toBe(5);
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
  });

  it('lets a fault in the delete through: the load rejects, its publish landed, and the pointer is at it', async () => {
    const w = await atFour();
    const fault = new TransientError('delete failed');
    const storage = new Proxy(w.deps.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p === 'delete') return () => Promise.reject(fault);
        return typeof value === 'function' ? (value as () => unknown).bind(t) : value;
      },
    }) as IStorageDriver;
    await expect(loadSegment(SEG, ids, { ...w.deps, storage })).rejects.toBe(fault);
    expect((await w.registry.get(SEG))?.currentGen).toBe(5);
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
  });

  it('a drop that lands after the publish leaves the pass nothing to take, and the load still returns', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await dropSegment(SEG, { storage: w.memory, registry: w.registry }, { confirmSegment: 's' });
    });
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    // The drop's own sweep took every generation, the published one included; the name the pass asked for was gone.
    expect(r).toMatchObject({ generation: 5, published: true });
    expect(await generations(w.memory)).toEqual([]);
    expect((await w.registry.get(SEG))?.status).toBe('destroyed');
  });

  it('proceeds when another load published above it meanwhile: a changed token alone does not stop it', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      const next = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps); // 6, which takes 4 by name
      expect(next).toMatchObject({ generation: 6, published: true, collected: [4] });
    });
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [3] });
    expect(await generations(w.memory)).toEqual([5, 6]);
    expect((await w.registry.get(SEG))?.currentGen).toBe(6);
  });

  it('is not an error when a listing pass has already taken the generation', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await gcOrphanGenerations(SEG, w.deps, { keep: 0 }); // another collector, taking everything below 5
    });
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [3] });
    expect(await generations(w.memory)).toEqual([5]);
  });

  it('never deletes the generation it published', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 0 });
    expect(await generations(w.memory)).toEqual([3]);
    // Called directly: the name it deletes is below the generation named, whatever keep says.
    await expect(collectByName(SEG, w.deps, { generation: 3, keep: 0 })).resolves.toEqual([2]);
    expect(await generations(w.memory)).toEqual([3]);
  });

  it('returns nothing for a pointer that has fallen below the generation it was told it published, and for no row', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 9 });
    await expect(collectByName(SEG, w.deps, { generation: 6, keep: 1 })).resolves.toEqual([]);
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
    await w.registry.delete(SEG);
    await expect(collectByName(SEG, w.deps, { generation: 3, keep: 1 })).resolves.toEqual([]);
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
  });

  it.each([2, 3, -1, 1.5, Number.NaN])(
    'refuses a keep of %s: a name cannot serve a wider window',
    async (keep) => {
      const w = world();
      await loadMany(w, 4, { keep: 9 });
      w.reset();
      await expect(collectByName(SEG, w.deps, { generation: 3, keep })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(w.storageCalls).toEqual({});
      expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
    },
  );

  it('requests nothing for a generation with no name below its window', async () => {
    const w = world();
    await loadMany(w, 2);
    w.reset();
    await expect(collectByName(SEG, w.deps, { generation: 1, keep: 1 })).resolves.toEqual([]);
    await expect(collectByName(SEG, w.deps, { generation: 0, keep: 0 })).resolves.toEqual([]);
    expect(w.storageCalls).toEqual({});
    expect(w.registryCalls).toEqual({});
  });
});

describe('a load that repairs a segment whose current object is gone lists, and keeps what a listing keeps', () => {
  /** Generations 0 to 5 loaded by name, so 4 and 5 are in the bucket and the pointer is at 5. */
  async function atFive(): Promise<World> {
    const w = world();
    await loadMany(w, 6);
    expect(await generations(w.memory)).toEqual([4, 5]);
    return w;
  }

  it('after the current object was removed from outside: the repair publishes 6 and keeps 4', async () => {
    const w = await atFive();
    await w.memory.delete({ ...SEG, generation: 5 }); // a lifecycle rule, or a partial restore
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps);
    expect(r).toMatchObject({ generation: 6, published: true, cardinalityBefore: null });
    // Collecting by name would take 4, the one generation left from before the tear, and the rollback target
    // an operator would reach for. The guard's read already found the current object gone, so the pass lists.
    expect(w.storageCalls.list).toBe(1);
    expect(r.collected).toEqual([]);
    expect(await generations(w.memory)).toEqual([4, 6]);
  });

  it("after a subject erasure deleted an in-flight load's object above the pointer: the repair keeps 5", async () => {
    const w = await atFive();
    // A load writes generation 6 holding id 99, and before its publish an erasure of 99, which the current
    // generation does not hold, deletes the object it finds above the pointer. The load's publish then lands on a
    // missing object.
    const racing = hookAfter(w.deps.storage, 'putImmutable', async () => {
      const erased = await eraseIdFromSegment(SEG, 99, {
        storage: w.memory,
        registry: w.registry,
        codec: roaringCodec,
      });
      expect(erased).toMatchObject({ erased: true });
    });
    const racer = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 99], { ...w.deps, storage: racing });
    expect(racer).toMatchObject({ generation: 6, published: true });
    expect((await w.registry.get(SEG))?.currentGen).toBe(6);
    expect(await generations(w.memory)).toEqual([5]); // 6 is gone: the pointer names a missing object
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps);
    expect(r).toMatchObject({ generation: 7, published: true, cardinalityBefore: null });
    expect(w.storageCalls.list).toBe(1);
    expect(await generations(w.memory)).toEqual([5, 7]);
  });

  it('a load with no guard reads no tail, cannot tell, and collects by name: the documented limit', async () => {
    const w = await atFive();
    await w.memory.delete({ ...SEG, generation: 5 });
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps, { allowEmpty: true });
    expect(r).toMatchObject({ generation: 6, published: true, cardinalityBefore: null });
    expect(w.storageCalls.list).toBeUndefined();
    expect(await generations(w.memory)).toEqual([6]);
  });

  it('a segment whose current object is present collects by name even when the guard reads it', async () => {
    const w = await atFive();
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps);
    expect(r).toMatchObject({ generation: 6, published: true, cardinalityBefore: 6 });
    expect(w.storageCalls.list).toBeUndefined();
    expect(await generations(w.memory)).toEqual([5, 6]);
  });
});

/** A state of a segment as a collection pass would have started from it: what was in the bucket, and the pointer. */
type Landed = { present: number[]; pointer: number };

/**
 * `w`'s drivers, instrumented to see the instant a publish landed: the state as the row write returns, before any
 * collection starts, and the listings made after it (the collection's, not the numbering's).
 */
function landing(w: World) {
  const at: { landed: Landed | undefined; lists: number } = { landed: undefined, lists: 0 };
  const snapshot = async (): Promise<void> => {
    const row = await w.registry.get(SEG);
    at.landed = { present: await generations(w.memory), pointer: row?.currentGen ?? -1 };
  };
  let registry: IRegistryDriver = w.registry;
  for (const method of ['create', 'compareAndSwap']) {
    const inner = registry;
    registry = new Proxy(inner, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p !== method) return (...a: unknown[]) => fn.apply(t, a);
        return async (...a: unknown[]) => {
          const out = await fn.apply(t, a);
          await snapshot();
          return out;
        };
      },
    });
  }
  const storage = new Proxy(w.memory, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p === 'list' && at.landed !== undefined) at.lists += 1;
      return (...a: unknown[]) => fn.apply(t, a);
    },
  }) as IStorageDriver;
  return {
    deps: { storage, registry, codec: roaringCodec },
    /** Forget the last publish, before a load. */
    reset: (): void => {
      at.landed = undefined;
      at.lists = 0;
    },
    landed: (): Landed | undefined => at.landed,
    /** The listings made since the publish landed. */
    listsSinceLanding: (): number => at.lists,
  };
}

/** One step of a history: a load, a refusal, or something that happens to the bucket or the row between loads. */
type Op =
  | { kind: 'load'; size: number; keep: number }
  | { kind: 'refused'; keep: number }
  | { kind: 'crash'; above: number }
  | { kind: 'stray'; pick: number }
  | { kind: 'rollback'; pick: number }
  | { kind: 'retire' };

/** The steps a history is drawn from. `rollbacks` is the weight of a rollback onto any generation below the pointer. */
function ops(rollbacks: number): fc.Arbitrary<Op> {
  const keeps = fc.constantFrom(0, 1, 1, 1, 2, 9);
  return fc.oneof(
    {
      weight: 8,
      arbitrary: fc.record({
        kind: fc.constant('load' as const),
        size: fc.integer({ min: 1, max: 6 }),
        keep: keeps,
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('refused' as const), keep: keeps }) },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant('crash' as const),
        above: fc.integer({ min: 1, max: 3 }),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(20) }),
    },
    ...(rollbacks === 0
      ? []
      : [
          {
            weight: rollbacks,
            arbitrary: fc.record({ kind: fc.constant('rollback' as const), pick: fc.nat(20) }),
          },
        ]),
    { weight: 1, arbitrary: fc.constant({ kind: 'retire' as const }) },
  );
}

/** Apply a step that is not a load to `w`'s bucket and row. Returns whether a rollback took effect. */
async function disturb(w: World, o: Exclude<Op, { kind: 'load' | 'refused' }>): Promise<boolean> {
  const row = await w.registry.get(SEG);
  const current = row?.currentGen ?? -1;
  const present = await generations(w.memory);
  if (o.kind === 'crash') {
    await orphan(w.memory, Math.max(current, ...present) + o.above);
  } else if (o.kind === 'stray') {
    const free = Array.from({ length: Math.max(current, 0) }, (_, g) => g).filter(
      (g) => !present.includes(g),
    );
    const at = free[o.pick % Math.max(free.length, 1)];
    if (at !== undefined) await orphan(w.memory, at);
  } else if (o.kind === 'rollback') {
    const below = present.filter((g) => g < current);
    const target = below[o.pick % Math.max(below.length, 1)];
    if (target === undefined) return false;
    await rollbackSegment(SEG, target, { storage: w.memory, registry: w.registry });
    return true;
  } else {
    for (const g of present) await w.memory.delete({ ...SEG, generation: g });
    if (row !== null) await w.registry.delete(SEG);
  }
  return false;
}

/**
 * What a listing pass would have deleted, at the instant the load's publish landed, against what the load deleted.
 * Whatever the history (loads that were refused, a crashed load's orphan above the pointer, a stray below it, a
 * rollback, a retirement, `keep` changing between loads), the load deletes a subset: collecting by name may leave
 * a generation for the next listing, and never takes one the window would have kept. The histories are those the
 * library's own operations reach, in which the object the row names is always in the bucket; a segment whose current
 * object was removed from outside is the one case where a name takes what a listing would keep.
 */
describe('collecting by name never deletes what a listing would keep (property)', () => {
  /** A bucket holding exactly `present`, and a row pointing at `pointer`: the state a pass would have started from. */
  async function forked(landed: Landed) {
    const storage = new MemoryStorageDriver();
    for (const generation of landed.present) {
      await storage.putImmutable({ ...SEG, generation }, (sink) => sink.write(new Uint8Array([1])));
    }
    const registry = new MemoryRegistryDriver();
    await registry.create(SEG, { currentGen: landed.pointer });
    return { storage, registry };
  }

  it('deletes a subset of what a listing pass deletes from the same state, and never the pointer', async () => {
    let byName = 0;
    let compared = 0;
    let rolled = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(ops(3), { maxLength: 40 }), async (history) => {
        const w = world();
        const seen = landing(w);
        for (const o of history) {
          if (o.kind !== 'load' && o.kind !== 'refused') {
            if (await disturb(w, o)) rolled += 1;
            continue;
          }
          seen.reset();
          const ids = o.kind === 'load' ? Array.from({ length: o.size }, (_, i) => i) : [];
          const r = await loadSegment(SEG, ids, seen.deps, { keep: o.keep });
          const landed = seen.landed();
          if (r.published && landed !== undefined) {
            const after = await generations(w.memory);
            const deleted = landed.present.filter((g) => !after.includes(g));
            const listed = await gcOrphanGenerations(SEG, await forked(landed), { keep: o.keep });
            for (const g of deleted) expect(listed, `deleted ${g}`).toContain(g);
            expect(after).toContain(landed.pointer);
            if (seen.listsSinceLanding() === 0 && o.keep <= 1) byName += 1;
            compared += 1;
          }
        }
      }),
      { numRuns: 200 },
    );
    // Not vacuous: the histories did collect by name, often, and rollbacks took effect.
    expect(compared).toBeGreaterThan(300);
    expect(byName).toBeGreaterThan(150);
    expect(rolled).toBeGreaterThan(15);
  });
});

/**
 * How long a segment can go without a listing. Every generation divisible by the cadence lists, so a segment that
 * loads cleanly lists at least once in that many published loads, however its keep changes and whatever crashed loads
 * and refused neighbours leave behind. A rollback is left out: it moves the pointer down, and the loads that then
 * take the numbers above it count from there.
 */
describe('a listing comes at least every sixteenth published load, without rollbacks (property)', () => {
  it('never lets more published loads than the cadence pass without one', async () => {
    let worst = 0;
    await fc.assert(
      // A run of clean loads first, so the histories include long stretches that nothing interrupts.
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40 }),
        fc.array(ops(0), { maxLength: 40 }),
        async (clean, rest) => {
          const w = world();
          const seen = landing(w);
          let since = 0; // published loads since the last listing
          const history: Op[] = [
            ...Array.from({ length: clean }, (): Op => ({ kind: 'load', size: 1, keep: 1 })),
            ...rest,
          ];
          for (const o of history) {
            if (o.kind !== 'load' && o.kind !== 'refused') {
              await disturb(w, o);
              if (o.kind === 'retire') since = 0; // the name starts over at generation 0
              continue;
            }
            seen.reset();
            const ids = o.kind === 'load' ? Array.from({ length: o.size }, (_, i) => i) : [];
            const r = await loadSegment(SEG, ids, seen.deps, { keep: Math.min(o.keep, 1) });
            if (!r.published) continue;
            since = seen.listsSinceLanding() > 0 ? 0 : since + 1;
            worst = Math.max(worst, since);
            expect(since).toBeLessThanOrEqual(LIST_COLLECTION_CADENCE);
          }
        },
      ),
      { numRuns: 100 },
    );
    expect(worst).toBeGreaterThanOrEqual(LIST_COLLECTION_CADENCE - 1); // runs as long as the bound allows were drawn
  });
});
