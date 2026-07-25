import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  writeCrbmGeneration,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import type { CompactionDeps, GenKey, IColdDriver, IRegistryDriver, IWarmDriver } from '@/index';
import type { ChunkRef, RegistryPatch, SegmentRef, Token } from '@/core/ports';

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'worker-1';

/** Counter that throws a synthetic crash on its Nth call; otherwise a pass-through. `fired()` confirms the
 * crash actually triggered — so a sweep can prove every `crashAt` lands on a *real* mutation, not a no-op
 * beyond the op count (which would silently test nothing). */
function crashGate(crashAt: number): { gate: () => void; fired: () => boolean } {
  let n = 0;
  let didFire = false;
  return {
    gate: () => {
      n += 1;
      if (n === crashAt) {
        didFire = true;
        throw new Error(`injected crash at mutation ${crashAt}`);
      }
    },
    fired: () => didFire,
  };
}

/** Pass-through gate that just counts how many mutating ops a clean compaction performs. */
function countingGate(): { gate: () => void; count: () => number } {
  let n = 0;
  return { gate: () => void (n += 1), count: () => n };
}

/** Wrap the three drivers so that every *mutating* op (the 2PC's destructive/committing steps) can crash. */
function crashingDeps(base: CompactionDeps, gate: () => void): CompactionDeps {
  const cold: IColdDriver = {
    capabilities: () => base.cold.capabilities(),
    putImmutable: (k: GenKey, w) => (gate(), base.cold.putImmutable(k, w)),
    getRange: (k, o, l) => base.cold.getRange(k, o, l),
    getTail: (k, m) => base.cold.getTail(k, m),
    delete: (k: GenKey) => (gate(), base.cold.delete(k)),
    list: (r) => base.cold.list(r),
  };
  const warm: IWarmDriver = {
    get: (r) => base.warm.get(r),
    putConditional: (r, b, e) => base.warm.putConditional(r, b, e),
    deleteConditional: (r: ChunkRef, t: Token) => (gate(), base.warm.deleteConditional(r, t)),
    listChunks: (r) => base.warm.listChunks(r),
  };
  const registry: IRegistryDriver = {
    capabilities: () => base.registry.capabilities(),
    get: (r) => base.registry.get(r),
    create: (r, rec) => (gate(), base.registry.create(r, rec)),
    compareAndSwap: (r: SegmentRef, e: Token, p: RegistryPatch) => (
      gate(),
      base.registry.compareAndSwap(r, e, p)
    ),
    list: (ns) => base.registry.list(ns),
    delete: (r) => base.registry.delete(r),
  };
  return { ...base, cold, warm, registry };
}

function makeWorld() {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver();
  const deps: CompactionDeps = { cold, warm, registry, clock: { now: () => Date.now() } };
  const read = (): CloudRoaring =>
    new CloudRoaring({ warm, cold: new CrbmColdChunkSource(cold, { registry }), retry: false });
  return { cold, warm, registry, deps, read };
}
async function members(store: CloudRoaring): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment('s').iterate()) out.push(id);
  return out;
}

describe('compaction crash-injection — crash at every 2PC step, then recover (I3/I4/I5)', () => {
  const oracle = [1, 3, 4]; // (cold {1,2,3}) + add 4 + remove 2

  /** Seed a segment mid-life with a dirty delta AND a leftover orphan generation from a crashed prior stage,
   * so the RECONCILE delete is one of the mutating steps the sweep crashes at. */
  async function seed(w: ReturnType<typeof makeWorld>): Promise<void> {
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });
    await w.read().segment('s').add(4);
    await w.read().segment('s').remove(2);
    // Orphan gen 1 > currentGen 0 (bogus content): forces a RECONCILE delete before staging.
    await writeCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([9]) },
    ]);
  }

  // Sweep the crash point across every mutating operation of a compaction; after each crash, a clean retry
  // must recover to the exact oracle set — no lost write, no torn read, no stuck state.
  it('recovers to the oracle after a crash at any real mutation step', async () => {
    // Measure the exact number of mutating ops in a clean compaction, so the sweep covers every real step
    // (lease-acquire → reconcile-delete → stage → commit → purge) and nothing beyond it.
    const probe = makeWorld();
    await seed(probe);
    const counter = countingGate();
    await compactSegment(SEG, crashingDeps(probe.deps, counter.gate), { owner: OWNER });
    const opCount = counter.count();
    expect(opCount).toBeGreaterThanOrEqual(5); // acquire + reconcile-delete + stage + commit + ≥1 purge

    for (let crashAt = 1; crashAt <= opCount; crashAt++) {
      const w = makeWorld();
      await seed(w);

      // Attempt 1: crashes at mutation #crashAt — which must be a real op (asserted via fired()).
      const g = crashGate(crashAt);
      await compactSegment(SEG, crashingDeps(w.deps, g.gate), { owner: OWNER }).catch(
        () => undefined,
      );
      expect(g.fired()).toBe(true);
      // Reads must still be correct even after a mid-compaction crash (no torn read; I5).
      expect(await members(w.read())).toEqual(oracle);

      // Attempt 2 (recovery, same owner can resume its own lease): must converge.
      await compactSegment(SEG, w.deps, { owner: OWNER });
      expect(await members(w.read())).toEqual(oracle); // no lost write (I4), effective set preserved (I3)

      // A further compaction is a clean no-op (warm fully drained, state consistent).
      const settle = await compactSegment(SEG, w.deps, { owner: OWNER });
      expect(settle.compacted).toBe(false);
      expect(await members(w.read())).toEqual(oracle);
    }
  });

  it('a crash during bootstrap (no registry row) also recovers', async () => {
    const probe = makeWorld();
    await probe.read().segment('s').addMany([1, 2, 3]);
    const counter = countingGate();
    await compactSegment(SEG, crashingDeps(probe.deps, counter.gate), { owner: OWNER });
    const opCount = counter.count();
    expect(opCount).toBeGreaterThanOrEqual(3); // write gen 0 + registry.create + ≥1 purge

    for (let crashAt = 1; crashAt <= opCount; crashAt++) {
      const w = makeWorld();
      await w.read().segment('s').addMany([1, 2, 3]);
      const g = crashGate(crashAt);
      await compactSegment(SEG, crashingDeps(w.deps, g.gate), { owner: OWNER }).catch(
        () => undefined,
      );
      expect(g.fired()).toBe(true);
      expect(await members(w.read())).toEqual([1, 2, 3]); // never lost the warm-only data
      await compactSegment(SEG, w.deps, { owner: OWNER }); // recover
      expect(await members(w.read())).toEqual([1, 2, 3]);
    }
  });
});
