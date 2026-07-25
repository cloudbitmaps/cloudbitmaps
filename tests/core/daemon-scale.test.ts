import {
  CloudRoaring,
  CountingMetricsSink,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
  findCompactable,
  runCompactionCycle,
} from '@/index';
import type { CompactionDeps, IColdDriver, IWarmDriver, SegmentRef } from '@/index';
import { ValidationError } from '@/core/errors';

/**
 * Phase D — compaction daemon at scale (gaps #2 + #3): poison-segment quarantine +
 * dead-man's-switch + a compaction metric (observability/safety), and shard/totalShards + per-cycle budget +
 * urgency ordering (discovery scale).
 */

const OWNER = 'worker-1';
const COOLDOWN = 5 * 60_000;

function clockAt(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function makeWorld(clock = clockAt()) {
  const cold = new MemoryColdDriver();
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver({ now: clock.now });
  const deps: CompactionDeps = { cold, warm, registry, clock };
  const store = (): CloudRoaring =>
    new CloudRoaring({ warm, cold: new CrbmColdChunkSource(cold, { registry }), retry: false });
  return { cold, warm, registry, deps, clock, store };
}

/** Wrap a Cold driver so reads of one segment's generations reject — a "poison pill" isolated to compaction. */
function poisonReadsOf(
  base: IColdDriver,
  segment: string,
): { cold: IColdDriver; heal: () => void } {
  let poisoned = true;
  const cold: IColdDriver = {
    capabilities: () => base.capabilities(),
    putImmutable: (k, w) => base.putImmutable(k, w),
    getRange: (k, o, l) => base.getRange(k, o, l),
    getTail: (k, m) =>
      poisoned && k.segment === segment
        ? Promise.reject(new Error('poison cold read'))
        : base.getTail(k, m),
    delete: (k) => base.delete(k),
    list: (r) => base.list(r),
  };
  return { cold, heal: () => (poisoned = false) };
}

/** Wrap a Warm driver so the fenced delete (the post-commit purge) rejects — reads/writes still work. */
function poisonPurgeOf(base: IWarmDriver): IWarmDriver {
  return {
    get: (r) => base.get(r),
    putConditional: (r, b, e) => base.putConditional(r, b, e),
    deleteConditional: () => Promise.reject(new Error('poison warm purge')),
    listChunks: (r) => base.listChunks(r),
  };
}

describe('Phase D — poison-segment quarantine + dead-man’s-switch (gap #2)', () => {
  it('quarantines a poison segment after N failures, skips it, retries after cooldown, resets on success', async () => {
    const clock = clockAt();
    const cold0 = new MemoryColdDriver();
    const { cold, heal } = poisonReadsOf(cold0, 's');
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const deps: CompactionDeps = { cold, warm, registry, clock };
    const seg: SegmentRef = { segment: 's' };

    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1, 2, 3], { registry });
    await new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    })
      .segment('s')
      .add(4); // dirty → a compaction reads gen 0 (poisoned) and fails

    // Five failing cycles push consecutiveFailures to the threshold; each is isolated (reason 'error').
    for (let i = 0; i < 5; i++) {
      const cycle = await runCompactionCycle(deps, { owner: OWNER, quarantineThreshold: 5 });
      expect(cycle.results[0]?.reason).toBe('error');
    }
    expect((await registry.get(seg))!.consecutiveFailures).toBe(5);

    // Now quarantined: discovery skips it entirely (no candidate, no wasted drain/attempt).
    expect(
      (await runCompactionCycle(deps, { owner: OWNER, quarantineThreshold: 5 })).candidates,
    ).toBe(0);

    // After the cooldown it's retried once — still poisoned, so it fails and re-quarantines.
    clock.advance(COOLDOWN + 1);
    const retried = await runCompactionCycle(deps, { owner: OWNER, quarantineThreshold: 5 });
    expect(retried.candidates).toBe(1);
    expect(retried.results[0]?.reason).toBe('error');

    // Heal the fault; after the cooldown the retry succeeds and clears the streak.
    heal();
    clock.advance(COOLDOWN + 1);
    const healed = await runCompactionCycle(deps, { owner: OWNER, quarantineThreshold: 5 });
    expect(healed.compacted).toBe(1);
    expect((await registry.get(seg))!.consecutiveFailures).toBe(0);
  });

  it('sets lastCompactedAt on a successful commit (dead-man’s-switch)', async () => {
    const clock = clockAt(50_000);
    const w = makeWorld(clock);
    await bulkLoadCrbmGeneration(w.cold, { segment: 's', generation: 0 }, [1], {
      registry: w.registry,
    });
    await w.store().segment('s').add(2);

    expect((await w.registry.get({ segment: 's' }))!.lastCompactedAt).toBeUndefined();
    await compactSegment({ segment: 's' }, w.deps, { owner: OWNER });
    expect((await w.registry.get({ segment: 's' }))!.lastCompactedAt).toBe(50_000);
  });

  it('emits a compaction metric per attempt (a commit and a no-op)', async () => {
    const w = makeWorld();
    const sink = new CountingMetricsSink();
    await bulkLoadCrbmGeneration(w.cold, { segment: 's', generation: 0 }, [1], {
      registry: w.registry,
    });
    await w.store().segment('s').add(2);

    await compactSegment({ segment: 's' }, { ...w.deps, metrics: sink }, { owner: OWNER }); // commits
    await compactSegment({ segment: 's' }, { ...w.deps, metrics: sink }, { owner: OWNER }); // clean no-op

    const snap = sink.snapshot();
    expect(snap.compaction.attempts).toBe(2);
    expect(snap.compaction.committed).toBe(1);
    expect(snap.compaction.dirtyChunks).toBe(1); // the commit folded 1 dirty chunk; the no-op added 0
    expect(snap.compaction.purged).toBe(1);
  });

  it('does NOT stamp lastCompactedAt on a clean no-op or a failed attempt (only-on-success)', async () => {
    const clock = clockAt(70_000);
    const cold0 = new MemoryColdDriver();
    const { cold } = poisonReadsOf(cold0, 'p');
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const deps: CompactionDeps = { cold, warm, registry, clock };
    const store = new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    });

    // (a) Clean no-op: a committed generation with no dirty rows → reason 'clean', never stamped.
    await bulkLoadCrbmGeneration(cold, { segment: 'clean', generation: 0 }, [1], { registry });
    const noop = await compactSegment({ segment: 'clean' }, deps, { owner: OWNER });
    expect(noop).toMatchObject({ compacted: false, reason: 'clean' });
    expect((await registry.get({ segment: 'clean' }))!.lastCompactedAt).toBeUndefined();

    // (b) Failed attempt: a dirty poison segment (gen-0 read rejects) throws → still never stamped.
    await bulkLoadCrbmGeneration(cold, { segment: 'p', generation: 0 }, [1], { registry });
    await store.segment('p').add(2);
    await expect(compactSegment({ segment: 'p' }, deps, { owner: OWNER })).rejects.toThrow();
    expect((await registry.get({ segment: 'p' }))!.lastCompactedAt).toBeUndefined();
  });

  it('counts a failed attempt in the compaction metric (attempts up, committed unchanged)', async () => {
    const clock = clockAt();
    const cold0 = new MemoryColdDriver();
    const { cold } = poisonReadsOf(cold0, 's');
    const warm = new MemoryWarmDriver();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const sink = new CountingMetricsSink();
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1], { registry });
    await new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    })
      .segment('s')
      .add(2);
    await expect(
      compactSegment(
        { segment: 's' },
        { cold, warm, registry, clock, metrics: sink },
        { owner: OWNER },
      ),
    ).rejects.toThrow();
    const snap = sink.snapshot();
    expect(snap.compaction.attempts).toBe(1);
    expect(snap.compaction.committed).toBe(0);
  });

  it('reports a commit (not a failure) when the post-commit Warm purge faults, and keeps the streak clear', async () => {
    // A transient Warm fault DURING the post-commit purge must not be attributed to compaction: the generation
    // is already durably committed. The un-purged rows re-fold (unchanged) next cycle (I4). Regression guard for
    // the "post-commit fault wrongly bumps consecutiveFailures / logs a phantom error" bug.
    const clock = clockAt(80_000);
    const cold = new MemoryColdDriver();
    const warm = poisonPurgeOf(new MemoryWarmDriver());
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const deps: CompactionDeps = { cold, warm, registry, clock };
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1], { registry });
    await new CloudRoaring({
      warm,
      cold: new CrbmColdChunkSource(cold, { registry }),
      retry: false,
    })
      .segment('s')
      .add(2);

    const result = await compactSegment({ segment: 's' }, deps, { owner: OWNER });
    expect(result).toMatchObject({ compacted: true, toGen: 1, purged: 0 });
    const rec = (await registry.get({ segment: 's' }))!;
    expect(rec.currentGen).toBe(1); // durably committed
    expect(rec.consecutiveFailures).toBe(0); // NOT bumped — the commit succeeded
    expect(rec.lastCompactedAt).toBe(80_000); // dead-man's-switch stamped on the commit
  });
});

describe('Phase D — discovery scale: sharding + budget + urgency (gap #3)', () => {
  it('shards discovery into a disjoint partition whose union covers the whole fleet', async () => {
    const w = makeWorld();
    const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    for (const s of segs) {
      await bulkLoadCrbmGeneration(w.cold, { segment: s, generation: 0 }, [1], {
        registry: w.registry,
      });
      await w.store().segment(s).add(2); // dirty
    }
    const names = (c: { ref: SegmentRef }[]): string[] => c.map((x) => x.ref.segment).sort();
    const s0 = names(await findCompactable(w.deps, { shard: 0, totalShards: 2 }));
    const s1 = names(await findCompactable(w.deps, { shard: 1, totalShards: 2 }));
    const all = names(await findCompactable(w.deps, {}));

    expect(all).toEqual(segs); // all 8 discovered without sharding
    expect(s0.filter((x) => s1.includes(x))).toEqual([]); // shards are disjoint
    expect([...s0, ...s1].sort()).toEqual(all); // and cover everything
    expect(s0.length).toBeGreaterThan(0); // (sanity: the split isn't degenerate for this fixture)
    expect(s1.length).toBeGreaterThan(0);
  });

  it('caps segments per cycle (maxSegments), processing most-dirty first and deferring the rest', async () => {
    const w = makeWorld();
    for (const s of ['low', 'high', 'mid']) {
      await bulkLoadCrbmGeneration(w.cold, { segment: s, generation: 0 }, [1], {
        registry: w.registry,
      });
    }
    // ids in distinct chunks (id >> 16) → distinct dirty Warm rows: low=1, mid=2, high=3.
    await w.store().segment('low').addMany([2]);
    await w.store().segment('mid').addMany([2, 70_000]);
    await w.store().segment('high').addMany([2, 70_000, 140_000]);

    const cycle = await runCompactionCycle(w.deps, { owner: OWNER, maxSegments: 2 });
    expect(cycle).toMatchObject({ candidates: 3, compacted: 2, deferred: 1 });
    // Urgency: the two most-dirty (high=3, mid=2) are compacted; low (1) is deferred to the next cycle.
    const compacted = cycle.results
      .filter((r) => r.compacted)
      .map((r) => r.segment)
      .sort();
    expect(compacted).toEqual(['high', 'mid']);
  });

  it('rejects an invalid shard / totalShards', async () => {
    const w = makeWorld();
    await expect(findCompactable(w.deps, { shard: 2, totalShards: 2 })).rejects.toThrow(
      ValidationError,
    );
    await expect(findCompactable(w.deps, { shard: -1, totalShards: 2 })).rejects.toThrow(
      ValidationError,
    );
    await expect(findCompactable(w.deps, { shard: 0, totalShards: 0 })).rejects.toThrow(
      ValidationError,
    );
    await expect(findCompactable(w.deps, { shard: 1.5, totalShards: 3 })).rejects.toThrow(
      ValidationError,
    );
  });

  it('breaks an equal-dirtiness tie by oldest lastCompactedAt (older compacted first)', async () => {
    const clock = clockAt(1_000);
    const w = makeWorld(clock);
    for (const s of ['old', 'fresh']) {
      await bulkLoadCrbmGeneration(w.cold, { segment: s, generation: 0 }, [1], {
        registry: w.registry,
      });
    }
    await w.store().segment('old').add(2);
    await compactSegment({ segment: 'old' }, w.deps, { owner: OWNER }); // lastCompactedAt = 1_000
    clock.advance(10_000);
    await w.store().segment('fresh').add(2);
    await compactSegment({ segment: 'fresh' }, w.deps, { owner: OWNER }); // lastCompactedAt = 11_000
    // Re-dirty both by exactly one chunk → equal dirtiness, so only the lastCompactedAt tiebreak can decide.
    await w.store().segment('old').add(3);
    await w.store().segment('fresh').add(3);
    const cycle = await runCompactionCycle(w.deps, { owner: OWNER, maxSegments: 1 });
    expect(cycle).toMatchObject({ candidates: 2, compacted: 1, deferred: 1 });
    expect(cycle.results.filter((r) => r.compacted).map((r) => r.segment)).toEqual(['old']);
  });

  it('change-guarded CAS: rewrites the dirty hint only when it actually moved', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { segment: 's', generation: 0 }, [1], {
      registry: w.registry,
    });
    await w.store().segment('s').add(2); // 1 dirty chunk; the registry hint is still 0
    await findCompactable(w.deps, {}); // hint moved 0 → 1: one CAS
    const after1 = (await w.registry.get({ segment: 's' }))!;
    expect(after1.dirtyChunkCount).toBe(1);
    await findCompactable(w.deps, {}); // hint unchanged (1 === 1): no CAS, no needless write
    const after2 = (await w.registry.get({ segment: 's' }))!;
    expect(after2.token).toBe(after1.token); // same OCC token ⇒ no write happened
  });

  it('rejects a non-positive or non-integer maxSegments', async () => {
    const w = makeWorld();
    await expect(runCompactionCycle(w.deps, { owner: OWNER, maxSegments: 0 })).rejects.toThrow(
      ValidationError,
    );
    await expect(runCompactionCycle(w.deps, { owner: OWNER, maxSegments: -1 })).rejects.toThrow(
      ValidationError,
    );
    await expect(runCompactionCycle(w.deps, { owner: OWNER, maxSegments: 1.5 })).rejects.toThrow(
      ValidationError,
    );
  });
});
