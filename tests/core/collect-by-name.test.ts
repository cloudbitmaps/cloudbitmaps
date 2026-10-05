import fc from 'fast-check';
import { loadSegment, type LoadOptions } from '@/core/load';
import {
  LIST_COLLECTION_CADENCE,
  collectAfterLoad,
  deleteEvicted,
  gcOrphanGenerations,
} from '@/core/generation-gc';
import { TransientError } from '@/core/errors';
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
 * The row records the generations a load keeps, so the load that published it knows which generations its publish
 * pushed out of the window: it deletes those names, re-proving the row first, and lists nothing, at any `keep` up to
 * the most a row records. A listing still runs for a row that records none, whenever the existence check met an
 * object, and every sixteenth generation, which is what bounds what the name-only pass leaves behind. These pin each of
 * those, and the safety of the delete.
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

describe('a load collects by name when its number was checked, whatever keep is', () => {
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

  it.each([2, 3, 12, 64])(
    'with keep %i, deletes the one generation the window pushed out',
    async (keep) => {
      const w = world();
      await loadMany(w, keep + 3, { keep });
      expect(await generations(w.memory)).toHaveLength(keep + 1);
      w.reset();
      const next = (await w.registry.get(SEG))!.currentGen! + 1;
      const r = await loadSegment(
        SEG,
        Array.from({ length: next + 1 }, (_, i) => i),
        w.deps,
        { keep },
      );
      expect(r).toMatchObject({ generation: next, published: true });
      expect(r.collected).toHaveLength(1);
      expect(w.storageCalls.list).toBeUndefined();
      expect(w.storageCalls.delete).toBe(1);
      expect(w.registryCalls.get).toBe(2);
      const held = await generations(w.memory);
      expect(held).toHaveLength(keep + 1);
      expect(held.slice(-keep - 1)).toEqual(
        Array.from({ length: keep + 1 }, (_, i) => next - keep + i),
      );
    },
  );

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

  it('a window of 2 counts the generations that were published: a refused neighbour is not a gap in it', async () => {
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
    expect((await w.registry.get(SEG))!.keptGens).toEqual([4, 5]);
    // The next load numbers 8 with its check, a clean path. The row names 4 and 5 as kept, so 4 is the name the
    // window pushes out, and no listing is needed to know that.
    w.reset();
    const l3 = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7, 8, 9], w.deps, { keep: 2 });
    expect(l3).toMatchObject({ generation: 8, published: true, collected: [4] });
    expect(w.storageCalls.list).toBeUndefined();
    expect(await generations(w.memory)).toEqual([5, 7, 8]);
  });
});

describe('a load lists when its row records no list, or its number or current object is in doubt', () => {
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
    expect(w.storageCalls.list).toBeGreaterThanOrEqual(1);
    expect([...res.collected].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(await generations(w.memory)).toEqual([4]);
    // The rewrite records that nothing below its pointer is kept.
    expect((await w.registry.get(SEG))!.keptGens).toEqual([]);
  });

  it('a keep above 64 records no list, and lists on every load once it is outside the window', async () => {
    const w = world();
    await loadMany(w, 3, { keep: 65 });
    expect((await w.registry.get(SEG))!.keptGens).toBeUndefined();
    w.reset();
    await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps, { keep: 2 });
    // Its row records none, so this one lists, collects, and records what it kept.
    expect(w.storageCalls.list).toBe(1);
    expect((await w.registry.get(SEG))!.keptGens).toEqual([1, 2]);
    w.reset();
    await loadSegment(SEG, [1, 2, 3, 4, 5, 6], w.deps, { keep: 2 });
    expect(w.storageCalls.list).toBeUndefined();
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

  it("lists when the check meets a crashed load's object, numbers past it, and collects it", async () => {
    const w = world();
    await loadMany(w, 3);
    await orphan(w.memory, 3);
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ generation: 4, published: true });
    // One listing to number past the orphan and one to collect.
    expect(w.storageCalls.list).toBe(2);
    // The row names 2 as the window, so the orphan below the pointer is garbage, not a slot in it.
    expect(await generations(w.memory)).toEqual([2, 4]);
  });

  it('lists when a rollback left generations above the pointer, and records the window afterwards', async () => {
    const w = world();
    await loadMany(w, 5, { keep: 9 });
    await rollbackSegment(SEG, 2, { storage: w.memory, registry: w.registry });
    expect((await w.registry.get(SEG))!.keptGens).toBeUndefined();
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4], w.deps);
    expect(r).toMatchObject({ generation: 5, published: true });
    expect(w.storageCalls.list).toBe(2);
    expect((await w.registry.get(SEG))!.keptGens).toEqual([4]);
  });
});

describe('every sixteenth generation lists, which bounds what the name-only pass leaves', () => {
  it.each([0, 1, 2, 12])(
    'lists on generations 16 and 32 and on no other, with keep %i',
    async (keep) => {
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
    },
  );

  it('a keep that shrinks takes the extras by name, at once', async () => {
    const w = world();
    await loadMany(w, 6, { keep: 9 }); // 0 to 5, all kept
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps, { keep: 1 });
    expect(r).toMatchObject({ generation: 6, published: true });
    expect([...r.collected]).toEqual([0, 1, 2, 3, 4]);
    expect(w.storageCalls.list).toBeUndefined();
    expect(await generations(w.memory)).toEqual([5, 6]);
  });

  it.each([1, 2])(
    'collects what no list names (an object a crashed load left below the pointer) on the next listing, and not before, with keep %i',
    async (keep) => {
      const w = world();
      await loadMany(w, 10, { keep });
      // Objects below the pointer that no publish named: a crashed load's, a stray.
      await orphan(w.memory, 3);
      await orphan(w.memory, 4);
      const strays = async (): Promise<number[]> =>
        (await generations(w.memory)).filter((g) => g === 3 || g === 4);
      for (let g = 10; g < 16; g++) {
        await loadSegment(
          SEG,
          Array.from({ length: g + 1 }, (_, i) => i),
          w.deps,
          { keep },
        );
      }
      // Clean loads by name never look at them.
      expect((await strays()).length).toBeGreaterThan(0);
      const r = await loadSegment(
        SEG,
        Array.from({ length: 17 }, (_, i) => i),
        w.deps,
        { keep },
      ); // 16: listed
      expect(r).toMatchObject({ generation: 16, published: true });
      expect(await strays()).toEqual([]);
      const row = await w.registry.get(SEG);
      expect(await generations(w.memory)).toEqual([...row!.keptGens!, 16]);
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

  it('collects nothing when a rollback and later loads put the name inside the row window', async () => {
    const w = await atFour(); // present 3 and 4, kept [3]; the next load publishes 5 and evicts 3
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      // An operator rolls back to 3; the next loads number above everything and keep a wide window, which names 3.
      await rollbackSegment(SEG, 3, { storage: w.memory, registry: w.registry });
      await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps, { keep: 3 });
      expect((await w.registry.get(SEG))!.keptGens).toContain(3);
    });
    const r = await loadSegment(SEG, ids, { ...w.deps, registry });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await generations(w.memory)).toContain(3);
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
    // The other collector took 4 as well, so the look for the current object finds it gone and the pass lists, which
    // finds nothing left below the pointer.
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await generations(w.memory)).toEqual([5]);
  });

  describe('deleteEvicted, called directly', () => {
    /** Generations 0 to 3 present, the pointer at 3, and the row naming `kept`. */
    async function pointedAt3(kept: number[] | undefined): Promise<World> {
      const w = world();
      await loadMany(w, 4, { keep: 9 });
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, { keptGens: kept });
      return w;
    }

    it('never deletes the generation at the pointer, or above it', async () => {
      const w = await pointedAt3([1, 2]);
      await expect(deleteEvicted(SEG, w.deps, { generation: 3, evict: [3, 4] })).resolves.toEqual(
        [],
      );
      expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
    });

    it('stops at a name the row still lists', async () => {
      const w = await pointedAt3([1, 2]);
      await expect(deleteEvicted(SEG, w.deps, { generation: 3, evict: [0, 1] })).resolves.toEqual([
        0,
      ]);
      expect(await generations(w.memory)).toEqual([1, 2, 3]);
    });

    it('deletes nothing when the row records no list, or one the pointer contradicts', async () => {
      const none = await pointedAt3(undefined);
      await expect(deleteEvicted(SEG, none.deps, { generation: 3, evict: [0] })).resolves.toEqual(
        [],
      );
      expect(await generations(none.memory)).toEqual([0, 1, 2, 3]);
    });

    it('returns nothing for a pointer that has fallen below the generation it was told it published, and for no row', async () => {
      const w = await pointedAt3([2]);
      await expect(deleteEvicted(SEG, w.deps, { generation: 6, evict: [0] })).resolves.toEqual([]);
      expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
      await w.registry.delete(SEG);
      await expect(deleteEvicted(SEG, w.deps, { generation: 3, evict: [0] })).resolves.toEqual([]);
      expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
    });

    it('requests nothing when nothing was evicted', async () => {
      const w = await pointedAt3([2]);
      w.reset();
      await expect(deleteEvicted(SEG, w.deps, { generation: 3, evict: [] })).resolves.toEqual([]);
      expect(w.storageCalls).toEqual({});
      expect(w.registryCalls).toEqual({});
    });
  });
});

/**
 * A load whose publish has landed took effect, so its collection does not fail because another writer moved the row
 * after it: it spares what the row names now, and stops where it cannot prove a delete, and never throws a lost race.
 */
describe('a load whose publish landed does not fail on a race its collection meets', () => {
  /** Sixteen loads at keep 1: generation 16 is the next, a periodic one, and 15 is current. */
  async function atFifteen(): Promise<World> {
    const w = world();
    await loadMany(w, 16);
    expect((await w.registry.get(SEG))!.currentGen).toBe(15);
    return w;
  }
  const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it('the pass for generation 16, run after another load published 17, deletes nothing that load keeps', async () => {
    const w = world();
    await loadMany(w, 18);
    expect(await generations(w.memory)).toEqual([16, 17]);
    expect((await w.registry.get(SEG))!.keptGens).toEqual([16]);
    // What loader A holds when loader B published 17 between A's publish of 16 and A's pass.
    await expect(
      collectAfterLoad(SEG, w.deps, {
        generation: 16,
        keep: 1,
        byName: true,
        kept: { list: [15], evict: [], token: undefined },
      }),
    ).resolves.toEqual([]);
    expect(await generations(w.memory)).toEqual([16, 17]);
  });

  it.each([false, true])(
    'another load publishing between a periodic publish and its pass: the first load returns, and the second keeps its window (collectByListing %s)',
    async (collectByListing) => {
      const w = await atFifteen();
      const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
        const b = await loadSegment(SEG, ids(18), w.deps); // B publishes 17 over A's 16
        expect(b).toMatchObject({ generation: 17, published: true });
      });
      const a = await loadSegment(SEG, ids(17), { ...w.deps, registry, collectByListing });
      expect(a).toMatchObject({ generation: 16, published: true });
      expect((await w.registry.get(SEG))!.currentGen).toBe(17);
      expect(await generations(w.memory)).toEqual([16, 17]);
    },
  );

  it('a writer that records no list publishing in that gap: the pass keeps the newest keep below the pointer', async () => {
    const w = await atFifteen();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await bulkLoadCrbmGeneration(w.memory, { ...SEG, generation: 17 }, [1, 2], {
        registry: w.registry,
      });
      expect((await w.registry.get(SEG))!.keptGens).toBeUndefined();
    });
    const a = await loadSegment(SEG, ids(17), { ...w.deps, registry });
    expect(a).toMatchObject({ generation: 16, published: true });
    expect(await generations(w.memory)).toEqual([16, 17]);
  });

  it('a rollback in that gap stops the pass, and the load still returns', async () => {
    const w = await atFifteen();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await rollbackSegment(SEG, 15, { storage: w.memory, registry: w.registry });
    });
    const a = await loadSegment(SEG, ids(17), { ...w.deps, registry });
    expect(a).toMatchObject({ generation: 16, published: true });
    expect((await w.registry.get(SEG))!.currentGen).toBe(15);
    expect(await generations(w.memory)).toContain(15);
  });

  it('a purge in that gap does not fail the load either', async () => {
    const w = await atFifteen();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await w.registry.delete(SEG);
    });
    const a = await loadSegment(SEG, ids(17), { ...w.deps, registry });
    expect(a).toMatchObject({ generation: 16, published: true });
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
    // The guard took the size from the row's summary, which still remembers the generation, and opened nothing.
    expect(r).toMatchObject({ generation: 6, published: true, cardinalityBefore: 6 });
    // Collecting by name would take 4, the one generation left from before the tear, and the rollback target
    // an operator would reach for. The pass looks for the current object before it takes a name, finds it gone, and lists.
    expect(w.storageCalls.list).toBe(1);
    expect(r.collected).toEqual([]);
    expect(await generations(w.memory)).toEqual([4, 6]);
    // And the row now names what is there.
    expect((await w.registry.get(SEG))!.keptGens).toEqual([4]);
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
    expect(r).toMatchObject({ generation: 7, published: true, cardinalityBefore: 7 });
    expect(w.storageCalls.list).toBe(1);
    expect(await generations(w.memory)).toEqual([5, 7]);
  });

  it('a load with no guard reads nothing of the current object, cannot tell, and collects by name: the documented limit', async () => {
    const w = await atFive();
    await w.memory.delete({ ...SEG, generation: 5 });
    w.reset();
    const r = await loadSegment(SEG, [1, 2, 3, 4, 5, 6, 7], w.deps, { allowEmpty: true });
    expect(r).toMatchObject({ generation: 6, published: true, cardinalityBefore: null });
    expect(w.storageCalls.list).toBeUndefined();
    expect(await generations(w.memory)).toEqual([6]);
  });

  it('a segment whose current object is present collects by name even when the guard has looked for it', async () => {
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
