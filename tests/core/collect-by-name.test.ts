import fc from 'fast-check';
import { loadSegment, type LoadOptions } from '@/core/load';
import { LIST_COLLECTION_CADENCE, collectByName, gcOrphanGenerations } from '@/core/generation-gc';
import { ValidationError, WriteConflictError } from '@/core/errors';
import { eraseIdFromSegment } from '@/core/erase-id';
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

  it.each([2, 3, 9])('lists once for keep %i, as before', async (keep) => {
    const w = world();
    await loadMany(w, 4, { keep });
    w.reset();
    await loadSegment(SEG, [1, 2, 3, 4, 5, 6], w.deps, { keep });
    expect(w.storageCalls.list).toBe(1);
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
  it('lists on generations 16 and 32 and on no other', async () => {
    const w = world();
    const listed: number[] = [];
    for (let g = 0; g < 34; g++) {
      w.reset();
      await loadSegment(
        SEG,
        Array.from({ length: g + 1 }, (_, i) => i),
        w.deps,
      );
      if (w.storageCalls.list !== undefined) listed.push(g);
    }
    expect(LIST_COLLECTION_CADENCE).toBe(16);
    expect(listed).toEqual([16, 32]);
  });

  it('collects what an earlier keep left behind on the next listing, and not before', async () => {
    const w = world();
    await loadMany(w, 6, { keep: 9 }); // 0 to 5, all kept
    await loadMany(w, 9); // 6 to 14 by name: each takes the generation two below it
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3, 13, 14]);
    await loadMany(w, 1); // 15: by name
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3, 14, 15]);
    const r = await loadSegment(
      SEG,
      Array.from({ length: 17 }, (_, i) => i),
      w.deps,
    ); // 16: listed
    expect(r).toMatchObject({ generation: 16, published: true });
    expect(await generations(w.memory)).toEqual([15, 16]);
    expect([...r.collected].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 14]);
  });
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

  it('refuses with WriteConflictError, and deletes nothing, when the row is gone at the delete', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', () => w.registry.delete(SEG));
    await expect(loadSegment(SEG, ids, { ...w.deps, registry })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
  });

  it('refuses, and deletes nothing, when a rollback lands between the publish and the delete', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await rollbackSegment(SEG, 4, { storage: w.memory, registry: w.registry });
    });
    await expect(loadSegment(SEG, ids, { ...w.deps, registry })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
    expect((await w.registry.get(SEG))?.currentGen).toBe(4);
  });

  it('refuses when the name was purged and re-created with a pointer below the published generation', async () => {
    const w = await atFour();
    const registry = hookAfter(w.deps.registry, 'compareAndSwap', async () => {
      await w.registry.delete(SEG);
      await w.registry.create(SEG, { currentGen: 0 });
    });
    await expect(loadSegment(SEG, ids, { ...w.deps, registry })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(await generations(w.memory)).toEqual([3, 4, 5]);
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

  it('refuses a pointer that has fallen below the generation it was told it published', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 9 });
    await expect(collectByName(SEG, w.deps, { generation: 6, keep: 1 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
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

/**
 * What a listing pass would have deleted, at the instant the load's publish landed, against what the load deleted.
 * Whatever the history (loads that were refused, a crashed load's orphan above the pointer, a stray below it, a
 * rollback, a retirement, `keep` changing between loads), the load deletes a subset: collecting by name may leave
 * a generation for the next listing, and never takes one the window would have kept.
 */
describe('collecting by name never deletes what a listing would keep (property)', () => {
  type Op =
    | { kind: 'load'; size: number; keep: number }
    | { kind: 'refused'; keep: number }
    | { kind: 'crash'; above: number }
    | { kind: 'stray'; pick: number }
    | { kind: 'rollback'; back: number }
    | { kind: 'retire' };
  const keeps = fc.constantFrom(0, 1, 1, 1, 2, 9);
  const op: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 8,
      arbitrary: fc.record({
        kind: fc.constant('load' as const),
        size: fc.integer({ min: 1, max: 6 }),
        keep: keeps,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('refused' as const), keep: keeps }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('crash' as const),
        above: fc.integer({ min: 1, max: 3 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('stray' as const), pick: fc.nat(20) }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('rollback' as const),
        back: fc.integer({ min: 1, max: 3 }),
      }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: 'retire' as const }) },
  );

  /** A bucket holding exactly `present`, and a row pointing at `pointer`: the state a pass would have started from. */
  async function forked(present: number[], pointer: number) {
    const storage = new MemoryStorageDriver();
    for (const generation of present) {
      await storage.putImmutable({ ...SEG, generation }, (sink) => sink.write(new Uint8Array([1])));
    }
    const registry = new MemoryRegistryDriver();
    await registry.create(SEG, { currentGen: pointer });
    return { storage, registry };
  }

  it('deletes a subset of what a listing pass deletes from the same state, and never the pointer', async () => {
    let byName = 0;
    let compared = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        const w = world();
        // The state at the instant the publish landed, taken as the row write returns, before collection starts.
        type Landed = { present: number[]; pointer: number };
        const at: { landed: Landed | undefined } = { landed: undefined };
        const snapshot = async (): Promise<void> => {
          const row = await w.registry.get(SEG);
          at.landed = { present: await generations(w.memory), pointer: row?.currentGen ?? -1 };
        };
        const landedNow = (): Landed | undefined => at.landed;
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
        let listsAfterLanding = 0;
        const storage = new Proxy(w.memory, {
          get(t, p, rx) {
            const value: unknown = Reflect.get(t, p, rx);
            if (typeof value !== 'function') return value;
            const fn = value as (...a: unknown[]) => unknown;
            if (p === 'list' && at.landed !== undefined) listsAfterLanding += 1;
            return (...a: unknown[]) => fn.apply(t, a);
          },
        }) as IStorageDriver;
        const deps = { storage, registry, codec: roaringCodec };

        for (const o of ops) {
          const row = await w.registry.get(SEG);
          const current = row?.currentGen ?? -1;
          const present = await generations(w.memory);
          if (o.kind === 'load' || o.kind === 'refused') {
            at.landed = undefined;
            listsAfterLanding = 0;
            const ids = o.kind === 'load' ? Array.from({ length: o.size }, (_, i) => i) : [];
            const r = await loadSegment(SEG, ids, deps, { keep: o.keep });
            const landed = landedNow();
            if (r.published && landed !== undefined) {
              const after = await generations(w.memory);
              const deleted = landed.present.filter((g) => !after.includes(g));
              const listing = await forked(landed.present, landed.pointer);
              const listed = await gcOrphanGenerations(SEG, listing, { keep: o.keep });
              for (const g of deleted) expect(listed, `deleted ${g}`).toContain(g);
              expect(after).toContain(landed.pointer);
              if (listsAfterLanding === 0 && o.keep <= 1) byName += 1;
              compared += 1;
            }
          } else if (o.kind === 'crash') {
            await orphan(w.memory, Math.max(current, ...present) + o.above);
          } else if (o.kind === 'stray') {
            const free = Array.from({ length: Math.max(current, 0) }, (_, g) => g).filter(
              (g) => !present.includes(g),
            );
            const free0 = free[o.pick % Math.max(free.length, 1)];
            if (free0 !== undefined) await orphan(w.memory, free0);
          } else if (o.kind === 'rollback') {
            const target = present.filter((g) => g < current).at(-o.back);
            if (target !== undefined) {
              await rollbackSegment(SEG, target, { storage: w.memory, registry: w.registry });
            }
          } else {
            for (const g of present) await w.memory.delete({ ...SEG, generation: g });
            if (row !== null) await w.registry.delete(SEG);
          }
        }
      }),
      { numRuns: 200 },
    );
    // Not vacuous: the histories did collect by name, and often.
    expect(compared).toBeGreaterThan(300);
    expect(byName).toBeGreaterThan(150);
  });
});
