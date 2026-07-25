import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  LocalFsColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  gcOrphanGenerations,
  runCompactionCycle,
  writeCrbmGeneration,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import type { BlobSink, CompactionDeps, IWarmDriver, SegmentRef } from '@/index';
import type {
  ChunkRef,
  GenKey,
  IColdDriver,
  IRegistryDriver,
  RegistryPatch,
  Token,
} from '@/core/ports';

/** Wrap a Cold driver, overriding `putImmutable` to interpose a side effect (e.g. steal the lease mid-stage). */
function wrapCold(base: IColdDriver, override: Partial<IColdDriver>): IColdDriver {
  return {
    capabilities: () => base.capabilities(),
    putImmutable: (k: GenKey, w: (s: BlobSink) => Promise<void>) =>
      (override.putImmutable ?? base.putImmutable.bind(base))(k, w),
    getRange: (k, o, l) => base.getRange(k, o, l),
    getTail: (k, m) => base.getTail(k, m),
    delete: (k) => base.delete(k),
    list: (r) => base.list(r),
  };
}

async function coldGenerations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const k of cold.list(ref)) gens.push(k.generation);
  return gens.sort((a, b) => a - b);
}

async function warmRowCount(warm: IWarmDriver, ref: SegmentRef): Promise<number> {
  let n = 0;
  for await (const row of warm.listChunks(ref)) {
    void row;
    n += 1;
  }
  return n;
}

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'worker-1';

let root: string;
let n = 0;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-compact-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A controllable clock shared by the registry + compaction (for deterministic lease expiry). */
function clockAt(start = 1_000): {
  now: () => number;
  sleep: () => Promise<void>;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

function makeWorld(clock = clockAt()) {
  const cold = new LocalFsColdDriver(join(root, `d${n++}`));
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver({ now: clock.now });
  const deps: CompactionDeps = { cold, warm, registry, clock };
  // A fresh store each call: CrbmColdChunkSource pins currentGen per lifetime, so post-compaction reads use a new one.
  const read = (): CloudRoaring =>
    new CloudRoaring({ warm, cold: new CrbmColdChunkSource(cold, { registry }), retry: false });
  return { cold, warm, registry, deps, clock, read };
}

async function members(store: CloudRoaring, seg = 's'): Promise<number[]> {
  const out: number[] = [];
  for await (const id of store.segment(seg).iterate()) out.push(id);
  return out;
}

describe('compactSegment — 2-phase commit', () => {
  it('bootstraps an all-warm segment (no registry row) into generation 0 and purges Warm', async () => {
    const w = makeWorld();
    const store = w.read();
    await store.segment('s').addMany([1, 2, 3, 100_000]);

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    // 4 ids span 2 chunks (1/2/3 in chunk 0; 100_000 in chunk 1) → 2 Warm rows purged.
    expect(res).toMatchObject({ compacted: true, fromGen: null, toGen: 0, purged: 2 });
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);

    // Warm is now empty; the data lives in cold gen 0. A fresh read reflects the same set.
    let warmRows = 0;
    for await (const row of w.warm.listChunks(SEG)) {
      void row;
      warmRows += 1;
    }
    expect(warmRows).toBe(0);
    expect(await members(w.read())).toEqual([1, 2, 3, 100_000]);
  });

  it('preserves the effective set across compaction — adds AND removes (I3)', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3, 100_000], {
      registry: w.registry,
    });
    // Mutate via warm: add 4, remove 2 (a real tombstone over cold).
    const store = w.read();
    await store.segment('s').add(4);
    await store.segment('s').remove(2);

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
    // The merged cold generation == the old effective set; the removed id is really gone.
    expect(await members(w.read())).toEqual([1, 3, 4, 100_000]);
  });

  it('is a no-op on a clean segment', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: false, reason: 'clean', fromGen: 0 });
  });

  it('is a no-op on an untouched segment with no registry row (bootstrap-clean path)', async () => {
    const w = makeWorld();
    // No registry row AND no Warm rows: the bootstrap branch returns clean without minting generation 0.
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: false, reason: 'clean', fromGen: null });
    expect(await w.registry.get(SEG)).toBeNull(); // nothing was written
  });

  it('clears the lease + status back to active on success', async () => {
    const w = makeWorld();
    const store = w.read();
    await store.segment('s').add(1);
    await compactSegment(SEG, w.deps, { owner: OWNER });
    const rec = (await w.registry.get(SEG))!;
    expect(rec.status).toBe('active');
    expect(rec.leaseOwner).toBeUndefined();
    expect(rec.leaseExpiresAt).toBeUndefined();
    expect(rec.dirtyChunkCount).toBe(0);
  });
});

describe('compactSegment — version-fenced purge (I4: no lost writes)', () => {
  it('a Warm write that lands after the scan survives the purge', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });
    await w.read().segment('s').add(4); // chunk 0 now dirty (adds {4})

    // Interpose a concurrent write to chunk 0 *between* the scan and the purge, simulating a post-scan write.
    let injected = false;
    const fenced: IWarmDriver = {
      get: (r) => w.warm.get(r),
      putConditional: (r, b, e) => w.warm.putConditional(r, b, e),
      listChunks: (r) => w.warm.listChunks(r),
      async deleteConditional(r: ChunkRef, token: Token) {
        if (!injected && r.chunkKey === 0) {
          injected = true;
          // A live writer adds id 5 to the same chunk → bumps the row's token past what compaction archived.
          await w.read().segment('s').add(5);
        }
        return w.warm.deleteConditional(r, token); // now fails the version fence → row survives
      },
    };

    const res = await compactSegment(SEG, { ...w.deps, warm: fenced }, { owner: OWNER });
    expect(res.compacted).toBe(true);
    expect(res.survived).toBe(1); // chunk 0's purge was fenced off
    // No lost write: gen 1 holds {1,2,3,4}; the surviving Warm row still carries the post-scan add(5).
    expect(await members(w.read())).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('compactSegment — lease', () => {
  it('refuses a segment held by another live lease', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    await w.read().segment('s').add(2);
    const rec = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, rec.token, {
      status: 'compacting',
      leaseOwner: 'other',
      leaseExpiresAt: w.clock.now() + 30_000, // live
    });
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: false, reason: 'leased-by-other' });
  });

  it('steals an expired lease', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    await w.read().segment('s').add(2);
    const rec = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, rec.token, {
      status: 'compacting',
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: w.clock.now() + 10, // about to expire
    });
    w.clock.advance(1_000); // lease now expired
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res.compacted).toBe(true); // stole it
    expect(await members(w.read())).toEqual([1, 2]);
  });
});

describe('compactSegment — lease lost mid-flight (commit fails safe, I4/I5)', () => {
  it('aborts without purging when the lease is stolen between stage and commit', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    await w.read().segment('s').add(3); // chunk 0 dirty

    // Steal the lease during STAGE (the cold putImmutable that writes gen 1), i.e. before the commit CAS.
    let stolen = false;
    const cold = wrapCold(w.cold, {
      async putImmutable(key, write) {
        const out = await w.cold.putImmutable(key, write);
        if (!stolen) {
          stolen = true;
          const rec = (await w.registry.get(SEG))!; // our lease (status=compacting, owner=worker-1)
          await w.registry.compareAndSwap(SEG, rec.token, {
            leaseOwner: 'thief',
            leaseExpiresAt: w.clock.now() + 60_000,
          });
        }
        return out;
      },
    });

    const res = await compactSegment(SEG, { ...w.deps, cold }, { owner: OWNER });
    expect(res).toMatchObject({ compacted: false, reason: 'lease-lost', purged: 0 });
    // The staged gen 1 is an orphan (we wrote it), but currentGen is still 0 and not one Warm row was deleted.
    expect(await coldGenerations(w.cold, SEG)).toEqual([0, 1]);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await warmRowCount(w.warm, SEG)).toBe(1); // chunk 0 survives
    expect(await members(w.read())).toEqual([1, 2, 3]); // read unchanged + correct — no torn read, no loss
  });
});

describe('compactSegment — concurrent bootstrap is no-loss (I4)', () => {
  it('an adopter never purges Warm rows against a gen 0 it did not write', async () => {
    const w = makeWorld();
    // Simulate another worker that already wrote gen 0 — but from a STALE view missing our add(3). No registry
    // row yet (it crashed before publishing, or we just lost the race to create it).
    await writeCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2]) },
    ]);
    await w.read().segment('s').addMany([1, 2, 3]); // our Warm view has the extra id 3

    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    // We hit the write-once conflict, adopt gen 0, publish the pointer, but DON'T purge — id 3 isn't in gen 0.
    expect(res).toMatchObject({
      compacted: false,
      reason: 'bootstrap-raced',
      purged: 0,
      survived: 1,
    });
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await warmRowCount(w.warm, SEG)).toBe(1); // our Warm row is intact
    expect(await members(w.read())).toEqual([1, 2, 3]); // cold{1,2} ∪ warm{1,2,3} — id 3 not lost

    // The next (now normal) compaction folds the surviving Warm rows over the committed gen 0 → no loss.
    const res2 = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res2).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
    expect(await members(w.read())).toEqual([1, 2, 3]);
  });
});

describe('compactSegment — crash recovery', () => {
  it('reconciles an orphan generation left by a crashed prior stage', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    await w.read().segment('s').add(3);
    // Simulate a crash AFTER staging gen 1 but BEFORE the commit: gen 1 exists on cold, currentGen still 0.
    await writeCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3, 999]) }, // deliberately wrong content
    ]);
    // The next compaction must delete that orphan and re-stage gen 1 from the true Cold∪Warm.
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    expect(res).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
    expect(await members(w.read())).toEqual([1, 2, 3]); // the bogus 999 from the orphan is gone
  });
});

/** Wrap a registry to fire a hook right after a `compareAndSwap` (e.g. to inject a concurrent publish). */
function wrapRegistry(
  base: IRegistryDriver,
  hooks: { afterCas?: (patch: RegistryPatch) => Promise<void> },
): IRegistryDriver {
  return {
    capabilities: () => base.capabilities(),
    get: (ref) => base.get(ref),
    create: (ref, rec) => base.create(ref, rec),
    compareAndSwap: async (ref, expected, patch) => {
      const res = await base.compareAndSwap(ref, expected, patch);
      if (hooks.afterCas) await hooks.afterCas(patch);
      return res;
    },
    list: (ns) => base.list(ns),
    delete: (ref) => base.delete(ref),
  };
}

describe('compactSegment — RECONCILE fence vs a concurrent publish (gap #5)', () => {
  it('aborts (superseded) when a publish advances currentGen under the lease — never deletes the published gen', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });
    await w.read().segment('s').add(4); // a dirty warm row, so compaction would otherwise commit gen 1

    // The instant compaction grabs its lease (status→compacting), a concurrent bulk-load publishes a fresh
    // generation 5 and advances currentGen to 5 — exactly the window the fence must catch. Publishing on the
    // RAW registry (not the wrapper) so the hook fires once and doesn't recurse.
    let published = false;
    const racingRegistry = wrapRegistry(w.registry, {
      afterCas: async (patch) => {
        if (patch.status === 'compacting' && !published) {
          published = true;
          await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 5 }, [7, 8, 9], {
            registry: w.registry,
          });
        }
      },
    });

    const res = await compactSegment(
      SEG,
      { ...w.deps, registry: racingRegistry },
      { owner: OWNER },
    );
    expect(res).toMatchObject({ compacted: false, reason: 'superseded', fromGen: 0 });
    // RECONCILE never ran: the concurrently-published generation 5 survives and currentGen still points at it
    // (the silent whole-generation lost update the old `deleteGenerationsAbove(staleG)` would have caused).
    expect(await coldGenerations(w.cold, SEG)).toContain(5);
    expect((await w.registry.get(SEG))!.currentGen).toBe(5);
  });

  it('still reconciles a genuine crashed-stage orphan when currentGen has NOT moved', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    await w.read().segment('s').add(3);
    // A crashed prior stage left gen 1 with bogus content; no concurrent publish, so currentGen is still 0.
    await writeCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3, 999]) },
    ]);
    const res = await compactSegment(SEG, w.deps, { owner: OWNER });
    // The fence does NOT fire (currentGen unchanged) — RECONCILE proceeds and the orphan is replaced.
    expect(res).toMatchObject({ compacted: true, fromGen: 0, toGen: 1 });
    expect(await members(w.read())).toEqual([1, 2, 3]);
  });
});

describe('gcOrphanGenerations', () => {
  it('deletes superseded generations below currentGen, keeping a grace window', async () => {
    const w = makeWorld();
    // Three committed generations: 0 → 1 → 2 (each compaction bumps currentGen).
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1], { registry: w.registry });
    for (const id of [2, 3]) {
      await w.read().segment('s').add(id);
      await compactSegment(SEG, w.deps, { owner: OWNER });
    }
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
    const present = async (): Promise<number[]> => {
      const gens: number[] = [];
      for await (const k of w.cold.list(SEG)) gens.push(k.generation);
      return gens.sort((a, b) => a - b);
    };
    expect(await present()).toEqual([0, 1, 2]);
    const deleted = await gcOrphanGenerations(SEG, w.deps, { keep: 1 });
    expect(deleted).toEqual([0]); // keep gen 1 (grace) + current gen 2; drop gen 0
    expect(await present()).toEqual([1, 2]);
    expect(await members(w.read())).toEqual([1, 2, 3]); // reads still correct
  });
});

describe('runCompactionCycle', () => {
  it('discovers and compacts every dirty segment, then GCs', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { segment: 'a', generation: 0 }, [1], {
      registry: w.registry,
    });
    await bulkLoadCrbmGeneration(w.cold, { segment: 'b', generation: 0 }, [2], {
      registry: w.registry,
    });
    await w.read().segment('a').add(10);
    await w.read().segment('b').add(20);

    const { candidates, results } = await runCompactionCycle(w.deps, { owner: OWNER, keep: 1 });
    expect(candidates).toBe(2);
    expect(results.every((r) => r.compacted)).toBe(true);
    expect(await members(w.read(), 'a')).toEqual([1, 10]);
    expect(await members(w.read(), 'b')).toEqual([2, 20]);
  });

  it('isolates a per-segment fault — one poison-pill segment never aborts the cycle', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { segment: 'a', generation: 0 }, [1], {
      registry: w.registry,
    });
    await bulkLoadCrbmGeneration(w.cold, { segment: 'b', generation: 0 }, [2], {
      registry: w.registry,
    });
    await w.read().segment('a').add(10);
    await w.read().segment('b').add(20);

    // Segment 'b' faults on its cold stage (a non-WriteConflict I/O error); 'a' must still compact.
    const cold = wrapCold(w.cold, {
      async putImmutable(key, write) {
        if (key.segment === 'b') throw new Error('disk on fire');
        return w.cold.putImmutable(key, write);
      },
    });

    const { candidates, results } = await runCompactionCycle(
      { ...w.deps, cold },
      { owner: OWNER, keep: 1 },
    );
    expect(candidates).toBe(2);
    const a = results.find((r) => r.segment === 'a')!;
    const b = results.find((r) => r.segment === 'b')!;
    expect(a.compacted).toBe(true);
    expect(b).toMatchObject({ compacted: false, reason: 'error' });
    expect(b.error).toContain('disk on fire');
    expect(await members(w.read(), 'a')).toEqual([1, 10]); // healthy segment compacted
    expect(await members(w.read(), 'b')).toEqual([2, 20]); // faulted segment still correct (warm intact)
    // 'b' released its lease despite the fault, so it's not stuck `compacting`.
    expect((await w.registry.get({ segment: 'b' }))!.status).toBe('active');
  });
});
