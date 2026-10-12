import { RecordingAuditSink } from '@/core/audit';
import { footerCrcUnder } from '@/core/crbm-open';
import { eraseIdFromSegment } from '@/core/erase-id';
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

describe('a same-bytes publish misattributed to another load', () => {
  // Load B writes generation 1, and its publish is held. An erasure of an id B's object holds deletes it and renews the
  // row, so the number is free: load A writes the same ids, so the same bytes, under 1 and publishes it. B's publish then
  // meets a changed row, asks whether the generation the row names is its own, and the same footer says yes. This is
  // a known defect (a footer names bytes, not the writer): the load reports `published: true` and audits a publish it
  // did not make. What the ledger adds is the collection's side of it: B's `keep: 0` collection, decided from the row it
  // wrote against, would delete generation 0, which the row's ledger now names.
  const IDS = [4, 8];

  it('keep 0: the false report stands, and the collection spares the generation the ledger names', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
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
    // The report is false and stays so: B did not publish 1, A did.
    expect(result).toMatchObject({ generation: 1, published: true });
    expect(bAudit.snapshot()).toEqual([
      expect.objectContaining({ kind: 'segment.publish', generation: 1 }),
    ]);
    // B's keep 0 would delete 0, but the row's ledger names it, and B's pass spares what the row knows.
    expect(await generations(storage)).toEqual([0, 1]);
    expect((await registry.get(REF))!.knownGens!.map((e) => e.generation)).toEqual([0, 1]);
  });
});
