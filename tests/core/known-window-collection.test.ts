import { RecordingAuditSink } from '@/core/audit';
import { footerCrcUnder } from '@/core/crbm-open';
import { eraseIdFromSegment } from '@/core/erase-id';
import { takeLease } from '@/core/leases';
import { rollbackSegment } from '@/core/rollback';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { REF, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * What a pass that keeps by a count does with the row's ledger. It counts the ledger's own most recently current names
 * first, so an object the ledger does not know (the orphan of a load that died after writing it) never takes the slot of
 * a name it does; and before each delete it re-reads the row and spares every name the row knows then, because a write
 * that landed since the pass chose its deletes can have made a name known.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}
type World = ReturnType<typeof world>;

async function gens(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

async function load(w: World, keep: number): Promise<number> {
  const have = (await w.registry.get(SEG))?.currentGen ?? -1;
  const ids = Array.from({ length: Math.max(have, 0) + 2 }, (_, i) => i);
  const r = await loadSegment(SEG, ids, w.deps, { keep });
  expect(r.published).toBe(true);
  return r.generation;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('a keep-72 load with orphans crowding the window', () => {
  it('spares the ledger’s names and deletes only the unknown ones', async () => {
    const w = world();
    for (let g = 0; g < 80; g++) await load(w, 72);
    expect(await gens(w.storage)).toEqual(range(7, 79));
    // Six loads that died after writing their objects: above the pointer, unknown to the ledger, and numbered higher than
    // every name the ledger holds.
    for (const g of range(80, 85)) {
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [7]);
    }
    const r = await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 72 });
    // 80 is taken, so the load lists and numbers above everything.
    expect(r.generation).toBe(86);
    // A count by number would have kept the orphans and deleted 8 to 13, names the ledger holds. The ledger's 72 fill the
    // window, so 7, which fell out of it, and the six orphans go, and nothing else.
    expect(await gens(w.storage)).toEqual([...range(8, 79), 86]);
    expect(r.collected.slice().sort((a, b) => a - b)).toEqual([7, ...range(80, 85)]);
  }, 60_000);
});

describe('a pass that keeps by count re-reads the row before each delete and spares every name it knows', () => {
  it('does not delete a generation another write made known after the pass chose it', async () => {
    const w = world();
    for (let g = 0; g < 80; g++) await load(w, 72);
    // The load publishes 80 at keep 72 and then, listing, decides to delete 7, the one name that fell out of its window.
    // Its first re-read before a delete finds a row that names 7: another writer's publish carried it.
    let afterPublish = 0;
    let fired = false;
    const registry = new Proxy(w.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p === 'compareAndSwap' || p === 'create') {
          return async (...a: unknown[]) => {
            const out = await fn.apply(t, a);
            afterPublish = 0;
            return out;
          };
        }
        if (p !== 'get') return (...a: unknown[]) => fn.apply(t, a);
        return async (...a: unknown[]) => {
          afterPublish += 1;
          // The pass reads the row, lists, reads it again, and then reads it before its first delete: the third read.
          if (afterPublish === 3 && !fired) {
            fired = true;
            const row = (await w.registry.get(SEG))!;
            const footerCrc = await footerCrcUnder(w.storage, { ...SEG, generation: 7 });
            await w.registry.compareAndSwap(SEG, row.token, {
              knownGens: [{ generation: 7, footerCrc }, ...row.knownGens!],
            });
          }
          return fn.apply(t, a);
        };
      },
    }) as IRegistryDriver;
    const r = await loadSegment(SEG, [1, 2, 3], { ...w.deps, registry }, { keep: 72 });
    expect(r.generation).toBe(80);
    expect(fired).toBe(true);
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)[0]).toBe(7);
    expect(r.collected).not.toContain(7);
    expect(await gens(w.storage)).toContain(7);
    expect(await gens(w.storage)).toEqual(range(7, 80));
  }, 60_000);
});

describe('a pass that keeps by count re-reads the row before EACH delete', () => {
  it('spares a name that became known between its first delete and its second', async () => {
    const w = world();
    for (let g = 0; g < 80; g++) await load(w, 72);
    // Two orphans above the pointer: the next load numbers past them (82), and its listing pass has three candidates,
    // newest first: 81 and 80 (unknown to the ledger) and 7 (fell out of the window).
    for (const g of [80, 81]) {
      await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: g }, [7]);
    }
    let afterPublish = 0;
    let fired = false;
    const registry = new Proxy(w.registry, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p === 'compareAndSwap' || p === 'create') {
          return async (...a: unknown[]) => {
            const out = await fn.apply(t, a);
            afterPublish = 0;
            return out;
          };
        }
        if (p !== 'get') return (...a: unknown[]) => fn.apply(t, a);
        return async (...a: unknown[]) => {
          afterPublish += 1;
          // The pass's reads: first, after its listing, before its first delete (81), before its second (80).
          if (afterPublish === 4 && !fired) {
            fired = true;
            const row = (await w.registry.get(SEG))!;
            const footerCrc = await footerCrcUnder(w.storage, { ...SEG, generation: 80 });
            await w.registry.compareAndSwap(SEG, row.token, {
              knownGens: [{ generation: 80, footerCrc }, ...row.knownGens!],
            });
          }
          return fn.apply(t, a);
        };
      },
    }) as IRegistryDriver;
    const r = await loadSegment(SEG, [1, 2, 3], { ...w.deps, registry }, { keep: 72 });
    expect(r.generation).toBe(82);
    expect(fired).toBe(true);
    expect(r.collected).toContain(81);
    expect(r.collected).not.toContain(80);
    expect(await gens(w.storage)).toContain(80);
  }, 60_000);
});

describe('a ledger too wide for a small keep to extend by name is never started again', () => {
  it('keeps the order generations were made current: 0 to 99 at keep 1000, rollback(50), a load, then keep 2 keeps 50 and 100, not 99', async () => {
    const w = world();
    for (let g = 0; g < 100; g++) await load(w, 1000);
    await rollbackSegment(SEG, 50, w.deps);
    expect(await load(w, 1000)).toBe(100);
    expect(await load(w, 2)).toBe(101);
    // Main started a wide ledger again from the bucket by number: ledger [99, 100, 101], 50 deleted.
    const row = (await w.registry.get(SEG))!;
    expect(row.knownGens!.map((e) => e.generation)).toEqual([50, 100, 101]);
    expect(await gens(w.storage)).toEqual([50, 100, 101]);
  }, 60_000);
});

describe('a ledger seeded at its birth names the leases the row holds when it is written', () => {
  const T0 = 1_800_000_000_000;
  const aWorld = () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const clock = { now: () => T0, sleep: () => Promise.resolve() };
    return { storage, registry, clock, deps: { storage, registry, codec: roaringCodec, clock } };
  };
  const lease = async (w: ReturnType<typeof aWorld>, generation: number): Promise<void> => {
    const row = (await w.registry.get(SEG))!;
    const taken = await takeLease(SEG, w.deps, {
      holder: generation.toString(16).padStart(16, '0'),
      generation,
      until: T0 + 3_600_000,
      row,
      current: row.currentGen === generation,
    });
    expect(taken).not.toBe('moved');
  };
  const loadN = async (w: ReturnType<typeof aWorld>, keep: number): Promise<number> => {
    const have = (await w.registry.get(SEG))?.currentGen ?? -1;
    const ids = Array.from({ length: Math.max(have, 0) + 2 }, (_, i) => i);
    return (await loadSegment(SEG, ids, w.deps, { keep })).generation;
  };

  it('a lease taken while the load writes its object is named: ledger [2, 5, 6], as when it is taken before', async () => {
    const w = aWorld();
    for (let g = 0; g < 6; g++) await loadN(w, 5);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { knownGens: undefined });
    let leased = false;
    const storage = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (p !== 'putImmutable') return (...a: unknown[]) => fn.apply(t, a);
        return async (...a: unknown[]) => {
          const out = await fn.apply(t, a);
          if (!leased) {
            leased = true;
            await lease(w, 2);
          }
          return out;
        };
      },
    }) as IStorageDriver;
    const r = await loadSegment(SEG, [1, 2, 3], { ...w.deps, storage }, { keep: 1 });
    expect(r.generation).toBe(6);
    expect(leased).toBe(true);
    // Main named no leased generation: [5, 6]. The seed read the leases from the row before the object was written and
    // missed this one, so it was spared in the bucket but not named.
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)).toEqual([2, 5, 6]);
    expect(await gens(w.storage)).toEqual([2, 5, 6]);
  });

  it('a leased generation numbered above the new generation is named too', async () => {
    const w = aWorld();
    for (let g = 0; g < 6; g++) await loadN(w, 9);
    await lease(w, 4);
    const row = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, row.token, { currentGen: 2 });
    await w.storage.delete({ ...SEG, generation: 3 });
    // The load takes the free 3; 4 sits above it.
    const r = await loadSegment(SEG, [1, 2, 3], w.deps, { keep: 1 });
    expect(r.generation).toBe(3);
    expect((await w.registry.get(SEG))!.knownGens!.map((e) => e.generation)).toEqual([4, 2, 3]);
    expect(await gens(w.storage)).toEqual([2, 3, 4, 5]);
  });
});

describe("a same-bytes publish by another load is not this load's", () => {
  // Load B writes generation 1, and its publish is held. An erasure of an id B's object holds deletes it and renews the
  // row, so the number is free: load A writes the same ids, so the same bytes, under 1 and publishes it. B's publish then
  // meets a changed row. The registry reports the token of each write it is sent, and the row's pointer is over A's
  // write, not B's, so B is superseded: it reports no publish, audits none, and its `keep: 0` collection deletes
  // nothing the row's ledger names.
  const IDS = [4, 8];

  it('keep 0: the load is superseded, and its collection spares the generation the ledger names', async () => {
    const storage = new MemoryStorageDriver();
    const registry: IRegistryDriver = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    expect(await loadSegment(REF, [9], deps)).toMatchObject({ generation: 0, published: true });

    const bAtPublish = gate();
    const held = Object.create(registry) as IRegistryDriver;
    let waited = false;
    const hold = async (gen: number | null | undefined): Promise<void> => {
      if (waited || gen !== 1) return;
      waited = true;
      bAtPublish.reach();
      await bAtPublish.opened;
    };
    held.compareAndSwap = async (ref, expected, patch, options) => {
      await hold('currentGen' in patch ? patch.currentGen : undefined);
      return registry.compareAndSwap(ref, expected, patch, options);
    };
    const bAudit = new RecordingAuditSink();
    const b = loadSegment(
      REF,
      IDS,
      { ...deps, registry: held },
      { allowEmpty: true, keep: 0, audit: bAudit },
    );
    await bAtPublish.reached;
    expect(await generations(storage)).toEqual([0, 1]);

    // The erasure deletes B's object above the pointer and renews the row; A takes the number again and publishes.
    await eraseIdFromSegment(REF, 8, deps);
    expect(await generations(storage)).toEqual([0]);
    expect(await loadSegment(REF, IDS, deps, { allowEmpty: true })).toMatchObject({
      generation: 1,
      published: true,
    });
    expect((await registry.get(REF))!.knownGens!.map((e) => e.generation)).toEqual([0, 1]);

    bAtPublish.open();
    const result = await b;
    // B did not publish 1, A did.
    expect(result).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    expect(bAudit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.load-refused', generation: 1 }),
    ]);
    // A keep 0 collection would delete 0, but B published nothing, so none runs; the row's ledger still names it.
    expect(await generations(storage)).toEqual([0, 1]);
    expect((await registry.get(REF))!.knownGens!.map((e) => e.generation)).toEqual([0, 1]);
  });
});
