import { footerCrcUnder } from '@/core/crbm-open';
import { NotFoundError, TransientError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A ledger's first window comes from the bucket. A row with no usable ledger (a registry repaired by hand, restored,
 * or whose writer dropped the field; a row a retention write made; a pointer moved down by hand) does not say which
 * generations below its pointer are kept, and a ledger that named only the generation a load published would be read as
 * a complete, empty window. So the load that publishes over such a row seeds the ledger with the window a count by
 * `keep` keeps, and the loads after it collect exactly what a load collects over a row that recorded that window. Each
 * case below is a sequence a release before ledgers collected one way; the bucket it left is pinned, with that release's
 * outcome in a comment where this one differs.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}
type W = ReturnType<typeof world>;

async function gens(w: W): Promise<number[]> {
  const out: number[] = [];
  for await (const k of w.storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}
let ids = 0;
async function load(w: W, keep: number, deps: object = {}): Promise<number> {
  const r = await loadSegment(SEG, [ids++, 1000 + ids], { ...w.deps, ...deps }, { keep });
  return r.generation;
}
async function plant(w: W, g: number): Promise<void> {
  await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [5000 + g]);
}
/** A row at `currentGen`, with the ledger that names `window` when one is given. */
async function createRow(w: W, currentGen: number, window?: number[]): Promise<void> {
  const knownGens =
    window === undefined
      ? undefined
      : await Promise.all(
          [...window, currentGen].map(async (generation) => ({
            generation,
            footerCrc: await footerCrcUnder(w.storage, { ...SEG, generation }),
          })),
        );
  await w.registry.create(SEG, { currentGen, ...(knownGens === undefined ? {} : { knownGens }) });
}
async function dropLedger(w: W): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
}
async function pointer(w: W): Promise<number> {
  return (await w.registry.get(SEG))!.currentGen!;
}

describe("the guide's restore: generations 0 and 1 from before the restore point, the row restored to 1, strays at 4 and 5", () => {
  // Re-runs publish 2 and 3 and the next numbers 6, past the strays. A restored row that records a window and one that
  // records none leave the same bucket. (A release before ledgers left, with no window: keep 3, 3 4 5 6; keep 5, 1 to 6.)
  it.each([
    { keep: 1, left: [3, 6] },
    { keep: 2, left: [2, 3, 6] },
    { keep: 3, left: [1, 2, 3, 6] },
    { keep: 5, left: [0, 1, 2, 3, 6] },
  ])('keep $keep leaves $left, with the window restored or not', async ({ keep, left }) => {
    for (const window of [[0], undefined]) {
      const w = world();
      for (const g of [0, 1, 4, 5]) await plant(w, g);
      await createRow(w, 1, window);
      const taken: number[] = [];
      while ((await pointer(w)) <= 5) taken.push(await load(w, keep));
      expect(taken, `window ${JSON.stringify(window)}`).toEqual([2, 3, 6]);
      expect(await gens(w), `window ${JSON.stringify(window)}`).toEqual(left);
    }
  });
});

describe('rows X and Y: one ledger over two histories', () => {
  it('row X, whose window is known to be empty, collects the orphan the load numbers past', async () => {
    const w = world();
    for (let i = 0; i < 3; i++) await load(w, 0);
    await plant(w, 3);
    expect(await load(w, 2)).toBe(4);
    expect(await gens(w)).toEqual([2, 4]);
  });

  it('row Y, restored with no window, keeps what the count keeps of 0, 1 and the orphan', async () => {
    const w = world();
    await plant(w, 0);
    await plant(w, 1);
    await createRow(w, 1);
    expect(await load(w, 2)).toBe(2);
    await plant(w, 3);
    expect(await load(w, 2)).toBe(4);
    // A release before ledgers kept 2, 3 and 4: the orphan 3, numbered under nothing, counted as the newest present. Here
    // the seed names 1 and 2 (the window at the first load), and the orphan above the pointer then was not in it.
    expect(await gens(w)).toEqual([1, 2, 4]);
  });
});

describe('a row a retention write made, and the object a refused load left under it', () => {
  it('keeps the newest below the pointer, and the next load pushes it out', async () => {
    const w = world();
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: MIN_EXPIRES_AT_MS * 2 });
    await plant(w, 0);
    const buckets: number[][] = [];
    for (let i = 0; i < 3; i++) {
      await load(w, 1);
      buckets.push(await gens(w));
    }
    expect(buckets).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });
});

describe('a pointer moved down by hand', () => {
  it('keeps what the count keeps below the pointer, then the loads that pass it collect the rest', async () => {
    const w = world();
    for (let g = 0; g <= 5; g++) await load(w, 3);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { currentGen: 3 });
    const buckets: number[][] = [];
    while ((await pointer(w)) <= 5) {
      await load(w, 3);
      buckets.push(await gens(w));
    }
    await load(w, 3);
    buckets.push(await gens(w));
    expect(buckets).toEqual([
      [3, 4, 5, 6],
      [4, 5, 6, 7],
    ]);
  });
});

describe('a rollback over a row with no ledger', () => {
  it('starts no ledger, and the loads after it collect as a row that recorded no window does', async () => {
    const w = world();
    for (let g = 0; g <= 4; g++) await load(w, 3);
    await dropLedger(w);
    await rollbackSegment(SEG, 2, { storage: w.storage, registry: w.registry });
    expect((await w.registry.get(SEG))!.knownGens).toBeUndefined();
    const buckets: number[][] = [];
    for (let i = 0; i < 3; i++) {
      await load(w, 3);
      buckets.push(await gens(w));
    }
    // A release before ledgers kept the same. A ledger of the target alone deleted 3 and 4 at once.
    expect(buckets).toEqual([
      [2, 3, 4, 5],
      [3, 4, 5, 6],
      [4, 5, 6, 7],
    ]);
  });
});

describe('a load numbered under what a rollback left, then one numbered past it', () => {
  it.each([
    { orphan: false, left: [4, 5, 7] },
    { orphan: true, left: [4, 5, 8] },
  ])('keeps the restored generation (orphan at 7: $orphan)', async ({ orphan, left }) => {
    const w = world();
    for (let g = 0; g <= 4; g++) await load(w, 2);
    await plant(w, 5);
    expect(await load(w, 2)).toBe(6);
    await rollbackSegment(SEG, 4, { storage: w.storage, registry: w.registry });
    expect(await load(w, 2)).toBe(5);
    if (orphan) await plant(w, 7);
    await load(w, 2);
    // A ledger that carried the entries above the pointer and counted by number deleted 4, the restored generation.
    expect(await gens(w)).toEqual(left);
  });
});

describe('the first load after a rollback, with a ledger', () => {
  it('keeps the restored generation, then the newest by number, and the second load keeps by name', async () => {
    const w = world();
    for (let g = 0; g <= 3; g++) await load(w, 9);
    await rollbackSegment(SEG, 1, { storage: w.storage, registry: w.registry });
    expect(await load(w, 2)).toBe(4);
    expect(await gens(w)).toEqual([1, 3, 4]);
    expect(await load(w, 2)).toBe(5);
    expect(await gens(w)).toEqual([3, 4, 5]);
  });
});

describe('a publish whose write landed and got no answer, over a row with no ledger', () => {
  it('seeds the window it listed, so the next load collects as a row that recorded it', async () => {
    const w = world();
    for (let g = 0; g <= 2; g++) await load(w, 2);
    await dropLedger(w);
    let armed = true;
    const flaky = new Proxy(w.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p !== 'compareAndSwap') return (...a: unknown[]) => fn.apply(t, a);
        return async (...a: unknown[]) => {
          const r = await fn.apply(t, a);
          if (armed) {
            armed = false;
            throw new TransientError('no answer');
          }
          return r;
        };
      },
    }) as IRegistryDriver;
    expect(await load(w, 2, { registry: flaky })).toBe(3);
    expect(await gens(w)).toEqual([1, 2, 3]);
    expect(await load(w, 2)).toBe(4);
    // A ledger of the load's generation alone left 1 in the bucket here: [1, 2, 3, 4].
    expect(await gens(w)).toEqual([2, 3, 4]);
  });
});

describe('what a seed reads from the bucket', () => {
  /** `storage`, whose 104-byte footer read of `generation` fails with `error`. */
  function failingFooter(storage: MemoryStorageDriver, generation: number, error: Error) {
    return new Proxy(storage as IStorageDriver, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        if (p !== 'getTail') return value.bind(t);
        return (key: GenKey, max: number) =>
          key.generation === generation && max === 104
            ? Promise.reject(error)
            : (value as IStorageDriver['getTail']).call(t, key, max);
      },
    });
  }

  it('leaves out a generation that is gone when its footer is read', async () => {
    const w = world();
    for (const g of [0, 1]) await plant(w, g);
    await createRow(w, 1);
    const storage = failingFooter(w.storage, 0, new NotFoundError('gone'));
    await loadSegment(SEG, [1, 2, 3], { ...w.deps, storage }, { keep: 3 });
    const ledger = (await w.registry.get(SEG))!.knownGens!.map((e) => e.generation);
    expect(ledger).toEqual([1, 2]);
  });

  it('fails the load before its publish on any other failed read', async () => {
    const w = world();
    for (const g of [0, 1]) await plant(w, g);
    await createRow(w, 1);
    const storage = failingFooter(w.storage, 0, new TransientError('503'));
    await expect(
      loadSegment(SEG, [1, 2, 3], { ...w.deps, storage }, { keep: 3 }),
    ).rejects.toBeInstanceOf(TransientError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(1);
  });

  it('names the superseded generation’s checksum from the row’s clear summary, with no footer read', async () => {
    const w = world();
    await load(w, 3);
    await load(w, 3);
    await dropLedger(w);
    // The row's summary describes generation 1; a failing footer read of 1 would fail the load if the seed made it.
    const storage = failingFooter(w.storage, 1, new TransientError('503'));
    expect(await loadSegment(SEG, [9, 10], { ...w.deps, storage }, { keep: 3 })).toMatchObject({
      generation: 2,
      published: true,
    });
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)).toEqual([0, 1, 2]);
  });
});
