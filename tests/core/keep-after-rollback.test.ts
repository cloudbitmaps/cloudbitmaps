import type { Clock } from '@/core/determinism';
import { takeLease } from '@/core/leases';
import { loadSegment } from '@/core/load';
import type { LoadOptions } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * Which generations a load keeps when its row records no window: the first load after a rollback, which drops the
 * row's list, and every load of a row that records none (a `keep` above 64, or a row a writer that records none made).
 *
 * The load lists the segment's objects and keeps `keep` of those below its new pointer: the generation its publish
 * superseded first, then the newest of the rest by number. After a rollback the superseded generation is the one the
 * operator restored, which is the one a pin or a lease taken since holds and the one to fall back to if the new load
 * is bad too; the generations the rollback moved away from are above it by number, so a window by number alone would
 * keep those and delete it.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}
type World = ReturnType<typeof world>;

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** Loads of `[1]`, `[2]`, … one generation each: the loading guide's worked example. */
async function loadEach(w: World, count: number, options: LoadOptions): Promise<void> {
  const have = (await w.registry.get(SEG))?.currentGen ?? -1;
  for (let g = have + 1; g < have + 1 + count; g++) {
    const r = await loadSegment(SEG, [g + 1], w.deps, options);
    expect(r).toMatchObject({ generation: g, published: true });
  }
}

/** `registry`, with `after` awaited once, the first time a compare-and-swap resolves: right after a load's publish. */
function afterFirstSwap(registry: IRegistryDriver, after: () => Promise<void>): IRegistryDriver {
  let fired = false;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'compareAndSwap') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const out = await fn.apply(t, a);
        if (!fired) {
          fired = true;
          await after();
        }
        return out;
      };
    },
  }) as IRegistryDriver;
}

/**
 * `storage`, with `during` awaited once, inside the second listing of the segment, before it yields: the listing a
 * load's collection makes, after the one that numbered the load.
 */
function duringSecondListing(storage: IStorageDriver, during: () => Promise<void>): IStorageDriver {
  let listings = 0;
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'list') return (...a: unknown[]) => fn.apply(t, a);
      return (...a: unknown[]) => {
        listings += 1;
        const inner = fn.apply(t, a) as AsyncIterable<unknown>;
        if (listings !== 2) return inner;
        return (async function* () {
          await during();
          yield* inner;
        })();
      };
    },
  }) as IStorageDriver;
}

const ascending = (list: readonly number[]): number[] => [...list].sort((a, b) => a - b);

describe('the first load after a rollback keeps the generation it superseded', () => {
  it.each([
    { keep: 1, bucket: [1, 4], kept: [1], next: { collected: [1], bucket: [4, 5] } },
    { keep: 2, bucket: [1, 3, 4], kept: [1, 3], next: { collected: [1], bucket: [3, 4, 5] } },
  ])(
    'with keep $keep, a rollback onto a kept generation: the restored one stays, then the newest by number',
    async ({ keep, bucket, kept, next }) => {
      const w = world();
      await loadEach(w, 4, { keep: 9 }); // generations 0 to 3, all kept
      await rollbackSegment(SEG, 1, w.deps);
      const r = await loadSegment(SEG, [7], w.deps, { keep });
      // 2 is taken, so the load lists and numbers above everything.
      expect(r).toMatchObject({ generation: 4, published: true });
      expect(await generations(w.storage)).toEqual(bucket);
      expect(ascending(r.collected)).toEqual([0, 1, 2, 3].filter((g) => !bucket.includes(g)));
      // The window is recorded, so the next load collects by name from it.
      expect((await w.registry.get(SEG))!.keptGens).toEqual(kept);
      const after = await loadSegment(SEG, [7, 8], w.deps, { keep });
      expect(after).toMatchObject({ generation: 5, published: true, collected: next.collected });
      expect(await generations(w.storage)).toEqual(next.bucket);
    },
  );

  it('a rollback onto the generation the current one superseded keeps that one, not the one rolled away from', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 2, w.deps);
    const r = await loadSegment(SEG, [7], w.deps, { keep: 1 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(await generations(w.storage)).toEqual([2, 4]);
    // Newest first, the order a listing pass has always deleted in.
    expect(r.collected).toEqual([3, 1, 0]);
  });

  it('a rollback onto the oldest generation keeps it, and the newest keep - 1 of the rest', async () => {
    const w = world();
    await loadEach(w, 5, { keep: 9 }); // generations 0 to 4
    await rollbackSegment(SEG, 0, w.deps);
    const r = await loadSegment(SEG, [7], w.deps, { keep: 2 });
    expect(r).toMatchObject({ generation: 5, published: true });
    expect(await generations(w.storage)).toEqual([0, 4, 5]);
    expect((await w.registry.get(SEG))!.keptGens).toEqual([0, 4]);
  });

  it('a rollback forward onto a generation above the pointer keeps that one', async () => {
    const w = world();
    await loadEach(w, 5, { keep: 9 }); // generations 0 to 4
    await rollbackSegment(SEG, 1, w.deps);
    await rollbackSegment(SEG, 3, w.deps, { allowForward: true });
    const r = await loadSegment(SEG, [7], w.deps, { keep: 1 });
    // 4 is taken, so the load numbers above everything.
    expect(r).toMatchObject({ generation: 5, published: true });
    expect(await generations(w.storage)).toEqual([3, 5]);
  });

  it('keep 0 after a rollback deletes every generation below the new one, and never the current one', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    const r = await loadSegment(SEG, [7], w.deps, { keep: 0 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(await generations(w.storage)).toEqual([4]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(4);
  });
});

describe('a row that records no window keeps the generation a load superseded', () => {
  it("over a crashed load's object above the pointer, keeps the generation that was current, not the object", async () => {
    const w = world();
    // A `keep` above 64 records no list, so every one of these loads collects by listing.
    await loadEach(w, 3, { keep: 65 }); // generations 0 to 2
    expect((await w.registry.get(SEG))!.keptGens).toBeUndefined();
    // A load that wrote 3 and died before its publish.
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [7]);
    const r = await loadSegment(SEG, [7, 8, 9], w.deps, { keep: 1 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(await generations(w.storage)).toEqual([2, 4]);
  });

  it('keeps the newest keep present when the superseded generation is gone from the bucket', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    // A lifecycle rule took the object the pointer names: the window holds what is there, by number.
    await w.storage.delete({ ...SEG, generation: 1 });
    const r = await loadSegment(SEG, [7], w.deps, { keep: 2 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(await generations(w.storage)).toEqual([2, 3, 4]);
  });

  it('keeps the generation the pointer superseded when another publish lands before the collection', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    // Right after this load publishes 4 over 1, a second load publishes 5 over 4 and keeps all it finds; then this
    // load's collection runs, against a pointer it did not move. The generation that pointer superseded is 4.
    const registry = afterFirstSwap(w.registry, async () => {
      const other = await loadSegment(SEG, [7, 8], w.deps, { keep: 5 });
      expect(other).toMatchObject({ generation: 5, published: true, collected: [] });
    });
    const r = await loadSegment(SEG, [7], { ...w.deps, registry }, { keep: 1 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(await generations(w.storage)).toEqual([4, 5]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(5);
  });

  it('keeps the newest below the pointer a rollback set while the collection listed', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    // The load publishes 4 over 1; while its collection lists, an operator rolls back to 3. The pass now works below 3,
    // a pointer that superseded nothing this load knows of, so its window is the newest there by number.
    const storage = duringSecondListing(w.storage, async () => {
      await rollbackSegment(SEG, 3, w.deps);
    });
    const r = await loadSegment(SEG, [7], { ...w.deps, storage }, { keep: 1 });
    expect(r).toMatchObject({ generation: 4, published: true });
    expect(await generations(w.storage)).toEqual([2, 3, 4]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
  });

  it('keeps the generation the load superseded when the row loses its window while the collection lists', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 }); // generations 0 to 3, the row keeping [0, 1, 2]
    // A crashed load's object at 4, so the load's check finds its number taken and it lists, numbering 5.
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 4 }, [7]);
    // While its collection lists, an operator rolls back to 3 and forward again to 5: the pointer is the load's, and the
    // row no longer records a window, so the pass keeps one by count.
    const storage = duringSecondListing(w.storage, async () => {
      await rollbackSegment(SEG, 3, w.deps);
      await rollbackSegment(SEG, 5, w.deps, { allowForward: true });
    });
    const r = await loadSegment(SEG, [7, 8, 9, 10, 11], { ...w.deps, storage }, { keep: 1 });
    expect(r).toMatchObject({ generation: 5, published: true });
    expect((await w.registry.get(SEG))!.currentGen).toBe(5);
    // 3, which the load superseded, stays; the crashed load's 4 is not the window.
    expect(await generations(w.storage)).toEqual([3, 5]);
  });
});

describe('the guard on the superseded generation, at a window wider than one', () => {
  it('keeps the newest two below a pointer another publish moved before the collection, at keep 2', async () => {
    const w = world();
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    const registry = afterFirstSwap(w.registry, async () => {
      const other = await loadSegment(SEG, [7, 8], w.deps, { keep: 5 });
      expect(other).toMatchObject({ generation: 5, published: true, collected: [] });
    });
    const r = await loadSegment(SEG, [7], { ...w.deps, registry }, { keep: 2 });
    expect(r).toMatchObject({ generation: 4, published: true });
    // The pointer is 5, which superseded 4: the window is 4 and 3, not the load's superseded 1.
    expect(await generations(w.storage)).toEqual([3, 4, 5]);
  });

  it('keeps the newest two below the pointer a rollback set while the collection listed, at keep 2', async () => {
    const w = world();
    await loadEach(w, 5, { keep: 9 }); // generations 0 to 4
    await rollbackSegment(SEG, 0, w.deps);
    // The load publishes 5 over 0; while its collection lists, an operator rolls back to 4. The window is the newest two
    // below 4, not 0, which the load superseded.
    const storage = duringSecondListing(w.storage, async () => {
      await rollbackSegment(SEG, 4, w.deps);
    });
    const r = await loadSegment(SEG, [7], { ...w.deps, storage }, { keep: 2 });
    expect(r).toMatchObject({ generation: 5, published: true });
    expect((await w.registry.get(SEG))!.currentGen).toBe(4);
    expect(await generations(w.storage)).toEqual([2, 3, 4, 5]);
  });
});

describe('a lease on the restored generation', () => {
  /** A clock the test reads; waits return at once. */
  const clockAt = (t: number): Clock => ({ now: () => t, sleep: () => Promise.resolve() });

  it('holds the first place of the window: the first load keeps it alone at keep 1, and the next spares it by its lease', async () => {
    const clock = clockAt(MIN_EXPIRES_AT_MS * 2);
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver({ now: () => clock.now() });
    const w = { storage, registry, deps: { storage, registry, codec: roaringCodec, clock } };
    await loadEach(w, 4, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    const row = (await registry.get(SEG))!;
    const taken = await takeLease(
      SEG,
      { registry, clock },
      {
        holder: '00000000000000a1',
        generation: 1,
        until: clock.now() + 60_000,
        row,
        current: true,
      },
    );
    expect(taken).not.toBe('moved');

    // The leased generation is the one the load superseded, so it is the window, and 3 is not.
    const first = await loadSegment(SEG, [7], w.deps, { keep: 1 });
    expect(first).toMatchObject({ generation: 4, published: true, collected: [3, 2, 0] });
    expect(await generations(storage)).toEqual([1, 4]);
    expect((await registry.get(SEG))!.keptGens).toEqual([1]);

    // The next load pushes 1 out of the window by name, and its live lease spares it.
    const next = await loadSegment(SEG, [7, 8], w.deps, { keep: 1 });
    expect(next).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await generations(storage)).toEqual([1, 4, 5]);
    expect((await registry.get(SEG))!.keptGens).toEqual([4]);
  });
});
