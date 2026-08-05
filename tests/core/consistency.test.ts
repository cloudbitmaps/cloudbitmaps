import {
  CloudRoaring,
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  runConsistencyCheck,
  UnsupportedError,
} from '@/index';
import type { SegmentRef } from '@/index';

/** Advance the registry's currentGen WITHOUT writing the matching Cold generation — a torn cross-tier restore. */
async function tearRestore(registry: MemoryRegistryDriver, ref: SegmentRef): Promise<void> {
  const rec = (await registry.get(ref))!;
  expect(rec.currentGen).not.toBeNull(); // fixtures bulk-load a real gen 0; a null pointer means a broken setup
  await registry.compareAndSwap(ref, rec.token, { currentGen: rec.currentGen! + 1 });
}

describe('runConsistencyCheck (gap #11 — torn cross-tier restore)', () => {
  it('reports a coherent store as fully consistent', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    for (const s of ['a', 'b']) {
      await bulkLoadCrbmGeneration(cold, { segment: s, generation: 0 }, [1, 2], { registry });
    }
    const report = await runConsistencyCheck({ cold, registry });
    expect(report).toEqual({ checked: 2, inconsistent: [], errored: [] });
  });

  it('detects a segment whose currentGen `.crbm` is missing (registry recovered ahead of Cold)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'ok', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 'torn', generation: 0 }, [1], { registry });
    await tearRestore(registry, { segment: 'torn' }); // currentGen → 1, but Cold only has gen 0

    const report = await runConsistencyCheck({ cold, registry });
    expect(report.checked).toBe(2);
    expect(report.inconsistent).toEqual([
      { segment: 'torn', namespace: undefined, currentGen: 1, issue: 'missing-cold-generation' },
    ]);
  });

  it('skips a destroyed (crypto-shredded) segment — its Cold is intentionally gone', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'dead', generation: 0 }, [1], { registry });
    const rec = (await registry.get({ segment: 'dead' }))!;
    await registry.compareAndSwap({ segment: 'dead' }, rec.token, {
      currentGen: rec.currentGen! + 1, // would be "missing" — but status makes it moot
      status: 'destroyed',
    });
    const report = await runConsistencyCheck({ cold, registry });
    expect(report.checked).toBe(1); // a destroyed segment still counts as scanned, just never an issue
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([]);
  });

  it('scopes the scan to one namespace', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'x', namespace: 'a', generation: 0 }, [1], {
      registry,
    });
    await bulkLoadCrbmGeneration(cold, { segment: 'y', namespace: 'b', generation: 0 }, [1], {
      registry,
    });
    await tearRestore(registry, { segment: 'x', namespace: 'a' }); // torn, but in namespace 'a'
    // Scanning only 'b' must neither see nor report the torn segment in 'a'.
    const report = await runConsistencyCheck({ cold, registry }, { namespace: 'b' });
    expect(report.checked).toBe(1);
    expect(report.inconsistent).toEqual([]);
  });

  it('isolates a per-segment read fault into errored[] (never aborts the scan)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 'ok', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 'bad', generation: 0 }, [1], { registry });
    const realList = cold.list.bind(cold);
    vi.spyOn(cold, 'list').mockImplementation((ref) =>
      // A real cold.list fails during iteration (the underlying GET), not at call time — model that.
      (async function* () {
        if (ref.segment === 'bad') throw new Error('cold unavailable');
        yield* realList(ref);
      })(),
    );
    const report = await runConsistencyCheck({ cold, registry });
    expect(report.checked).toBe(2);
    expect(report.inconsistent).toEqual([]); // 'ok' is coherent; the fault didn't abort the scan
    expect(report.errored.map((e) => e.segment)).toEqual(['bad']);
    expect(report.errored[0]!.error).toMatch(/unavailable/);
  });

  it('checks the LIVE pointer, not the enumeration snapshot (no false torn on a stale/lagging list)', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 1 }, [1], { registry }); // compaction
    await cold.delete({ segment: 's', generation: 0 }); // GC reclaims the old gen — live is now gen 1 only
    // Make registry.list() yield a STALE currentGen 0 (an eventually-consistent enumeration lagging the live
    // pointer), while the strong registry.get() reflects the live gen 1 and Cold has only gen 1. A check that
    // trusted the list snapshot would cry torn on gen 0; reading the live pointer per segment must not.
    const realList = registry.list.bind(registry);
    vi.spyOn(registry, 'list').mockImplementation(async function* (ns?: string) {
      for await (const rec of realList(ns)) yield { ...rec, currentGen: 0 };
    });
    const report = await runConsistencyCheck({ cold, registry });
    expect(report.checked).toBe(1);
    expect(report.inconsistent).toEqual([]); // checked against the live pointer (gen 1, present) — coherent
    expect(report.errored).toEqual([]);
  });

  it('rejects a bad concurrency before scanning', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await expect(runConsistencyCheck({ cold, registry }, { concurrency: 0 })).rejects.toThrow(
      /concurrency/,
    );
  });
});

describe('store.checkConsistency (facade)', () => {
  it('surfaces a torn restore through the store method', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1], { registry });
    await tearRestore(registry, { segment: 's' });
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, registry, retry: false });
    const report = await store.checkConsistency();
    expect(report.inconsistent.map((i) => i.segment)).toEqual(['s']);
  });

  it('needs a raw cold driver + registry (throws with a pre-built ColdChunkSource)', async () => {
    const registry = new MemoryRegistryDriver();
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      // A pre-built source resolves generations itself — the store has no raw IColdDriver to scan.
      cold: new CrbmColdChunkSource(new MemoryColdDriver(), { registry }),
      retry: false,
    });
    await expect(store.checkConsistency()).rejects.toThrow(UnsupportedError);
  });
});
