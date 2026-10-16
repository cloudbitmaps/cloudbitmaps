import { loadSegment } from '@/core/load';
import type { LoadOptions } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { testEntropy } from '../helpers/entropy';

/**
 * The window a load keeps is the most recently current generations below its own, and it is the same from every load
 * after a rollback on, not only the first. The ledger survives a rollback, so a publish draws its window from the order
 * generations were made current: the generation it superseded (after a rollback, the one the operator restored) comes
 * first, then the ones made current before it. What a rollback left numbered above the generation a load takes (a load
 * numbers under them when the number is free) stays known and takes no slot of `keep`, and is never collected.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return {
    storage,
    registry,
    deps: { storage, registry, entropy: testEntropy, codec: roaringCodec },
  };
}
type World = ReturnType<typeof world>;

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** One load of a growing list of ids: it publishes the next free number, and returns it. */
async function load(
  w: World,
  options: LoadOptions,
  deps: Partial<World['deps']> = {},
): Promise<number> {
  const have = (await w.registry.get(SEG))?.currentGen ?? -1;
  const ids = Array.from({ length: Math.max(have, 0) + 2 }, (_, i) => i);
  const r = await loadSegment(SEG, ids, { ...w.deps, ...deps }, options);
  expect(r.published).toBe(true);
  return r.generation;
}

async function ledger(w: World): Promise<number[]> {
  return ((await w.registry.get(SEG))?.knownGens ?? []).map((e) => e.generation);
}

/** `registry` counting its compare-and-swap writes into `count`, and every create. */
function countingWrites(registry: IRegistryDriver, count: { writes: number }): IRegistryDriver {
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'compareAndSwap' && p !== 'create') return (...a: unknown[]) => fn.apply(t, a);
      return (...a: unknown[]) => {
        count.writes += 1;
        return fn.apply(t, a);
      };
    },
  }) as IRegistryDriver;
}

describe('the first load after a rollback keeps the restored generation, by recency', () => {
  it.each([
    { keep: 1, bucket: [1, 4], ledger: [1, 4], collected: [3, 2, 0] },
    { keep: 2, bucket: [1, 3, 4], ledger: [3, 1, 4], collected: [2, 0] },
  ])(
    'generations 0 to 3, rollback(1), a load at keep $keep: the bucket is $bucket and the ledger $ledger, with one registry write',
    async ({ keep, bucket, ledger: expected, collected }) => {
      const w = world();
      for (let i = 0; i < 4; i++) await load(w, { keep: 9 });
      await rollbackSegment(SEG, 1, w.deps);
      expect(await ledger(w)).toEqual([0, 2, 3, 1]);
      const count = { writes: 0 };
      const r = await loadSegment(
        SEG,
        [7],
        { ...w.deps, registry: countingWrites(w.registry, count) },
        { keep },
      );
      // 2 is taken, so the load numbers above everything.
      expect(r).toMatchObject({ generation: 4, published: true });
      expect(await generations(w.storage)).toEqual(bucket);
      expect(await ledger(w)).toEqual(expected);
      expect(r.collected).toEqual(collected);
      // The publish is the only write: no reconcile write follows the listing.
      expect(count.writes).toBe(1);
    },
  );
});

describe('the second load after a rollback (recency, not number)', () => {
  it('generations 0 to 3, rollback(1), loads 4 and 5 at keep 2: the bucket after load 5 holds 1, 4 and 5, and a rollback of two steps lands on 1', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) await load(w, { keep: 9 });
    await rollbackSegment(SEG, 1, w.deps);
    expect(await load(w, { keep: 2 })).toBe(4);
    expect(await generations(w.storage)).toEqual([1, 3, 4]);
    expect(await ledger(w)).toEqual([3, 1, 4]);
    const second = await loadSegment(SEG, [7, 8], w.deps, { keep: 2 });
    expect(second).toMatchObject({ generation: 5, published: true, collected: [3] });
    // A window by number would keep 3 and 4 and delete the restored 1.
    expect(await generations(w.storage)).toEqual([1, 4, 5]);
    expect(await ledger(w)).toEqual([1, 4, 5]);
    // Two steps back in the order generations were made current is 1: the generation the operator restored.
    const row = (await w.registry.get(SEG))!;
    const target = row.knownGens![row.knownGens!.length - 1 - 2]!.generation;
    expect(target).toBe(1);
    await rollbackSegment(SEG, target, w.deps);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });
});

describe('a load numbered under what a rollback left', () => {
  // The bucket and ledger are [1, 4, 5]; rollback(1) leaves 4 and 5 above the pointer; the next load takes the free 2.
  async function underneath(keep: number) {
    const w = world();
    // Generations 1, 4 and 5, in the order they were made current, with 0, 2 and 3 collected long ago.
    const keeps = [{ keep: 9 }, { keep: 9 }, { keep: 9 }, { keep: 9 }, { keep: 9 }, { keep: 9 }];
    for (const k of keeps) await load(w, k);
    for (const g of [0, 2, 3]) await w.storage.delete({ ...SEG, generation: g });
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, {
      knownGens: row.knownGens!.filter((e) => [1, 4, 5].includes(e.generation)),
    });
    expect(await ledger(w)).toEqual([1, 4, 5]);
    await rollbackSegment(SEG, 1, w.deps);
    expect(await ledger(w)).toEqual([4, 5, 1]);
    const r = await loadSegment(SEG, [7, 8], w.deps, { keep });
    expect(r.generation).toBe(2);
    return w;
  }

  it.each([
    { keep: 0, ledger: [4, 5, 2], bucket: [2, 4, 5] },
    { keep: 1, ledger: [4, 5, 1, 2], bucket: [1, 2, 4, 5] },
    { keep: 2, ledger: [4, 5, 1, 2], bucket: [1, 2, 4, 5] },
  ])(
    'at keep $keep: the ledger is $ledger and the bucket $bucket; 4 and 5 stay known and in the bucket, and keep 0 still deletes 1',
    async ({ keep, ledger: expected, bucket }) => {
      const w = await underneath(keep);
      expect(await ledger(w)).toEqual(expected);
      expect(await generations(w.storage)).toEqual(bucket);
    },
  );

  it('at keep 1 the next load takes 3 and keeps [4, 5, 2, 3]; the one that numbers 6 above everything evicts 4 and 5 with the window', async () => {
    const w = await underneath(1);
    expect(await load(w, { keep: 1 })).toBe(3);
    expect(await ledger(w)).toEqual([4, 5, 2, 3]);
    expect(await generations(w.storage)).toEqual([2, 3, 4, 5]);
    expect(await load(w, { keep: 1 })).toBe(6);
    expect(await ledger(w)).toEqual([3, 6]);
    expect(await generations(w.storage)).toEqual([3, 6]);
  });

  it('never stalls a delete by name on a generation at or above the pointer: keep 0 deletes the superseded 1 although 4 and 5 are known', async () => {
    const w = await underneath(0);
    expect(await generations(w.storage)).not.toContain(1);
  });
});
