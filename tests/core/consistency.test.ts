import {
  MemoryStorage,
  CloudRoaring,
  CrbmStorageChunkSource,
  MemoryStorageDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  runConsistencyCheck,
  UnsupportedError,
} from '@/index';
import type { SegmentRef } from '@/index';

/** Advance the registry's currentGen WITHOUT writing the matching Storage generation — a torn cross-tier restore. */
async function tearRestore(registry: MemoryRegistryDriver, ref: SegmentRef): Promise<void> {
  const rec = (await registry.get(ref))!;
  expect(rec.currentGen).not.toBeNull(); // fixtures bulk-load a real gen 0; a null pointer means a broken setup
  await registry.compareAndSwap(ref, rec.token, { currentGen: rec.currentGen! + 1 });
}

describe('runConsistencyCheck — a torn restore across the registry and the object store', () => {
  it('reports a coherent store as fully consistent', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    for (const s of ['a', 'b']) {
      await bulkLoadCrbmGeneration(storage, { segment: s, generation: 0 }, [1, 2], { registry });
    }
    const report = await runConsistencyCheck({ storage, registry });
    expect(report).toEqual({ checked: 2, inconsistent: [], errored: [] });
  });

  it('detects a segment whose currentGen `.crbm` is missing (registry recovered ahead of Storage)', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { segment: 'ok', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(storage, { segment: 'torn', generation: 0 }, [1], { registry });
    await tearRestore(registry, { segment: 'torn' }); // currentGen → 1, but Storage only has gen 0

    const report = await runConsistencyCheck({ storage, registry });
    expect(report.checked).toBe(2);
    expect(report.inconsistent).toEqual([
      { segment: 'torn', namespace: undefined, currentGen: 1, issue: 'missing-storage-generation' },
    ]);
  });

  it('skips a destroyed (crypto-shredded) segment — its Storage is intentionally gone', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { segment: 'dead', generation: 0 }, [1], { registry });
    const rec = (await registry.get({ segment: 'dead' }))!;
    await registry.compareAndSwap({ segment: 'dead' }, rec.token, {
      currentGen: rec.currentGen! + 1, // would be "missing" — but status makes it moot
      status: 'destroyed',
    });
    const report = await runConsistencyCheck({ storage, registry });
    expect(report.checked).toBe(1); // a destroyed segment still counts as scanned, just never an issue
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([]);
  });

  it('scopes the scan to one namespace', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { segment: 'x', namespace: 'a', generation: 0 }, [1], {
      registry,
    });
    await bulkLoadCrbmGeneration(storage, { segment: 'y', namespace: 'b', generation: 0 }, [1], {
      registry,
    });
    await tearRestore(registry, { segment: 'x', namespace: 'a' }); // torn, but in namespace 'a'
    // Scanning only 'b' must neither see nor report the torn segment in 'a'.
    const report = await runConsistencyCheck({ storage, registry }, { namespace: 'b' });
    expect(report.checked).toBe(1);
    expect(report.inconsistent).toEqual([]);
  });

  it('isolates a per-segment read fault into errored[] (never aborts the scan)', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { segment: 'ok', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(storage, { segment: 'bad', generation: 0 }, [1], { registry });
    const realList = storage.list.bind(storage);
    vi.spyOn(storage, 'list').mockImplementation((ref) =>
      // A real storage.list fails during iteration (the underlying GET), not at call time — model that.
      (async function* () {
        if (ref.segment === 'bad') throw new Error('storage unavailable');
        yield* realList(ref);
      })(),
    );
    const report = await runConsistencyCheck({ storage, registry });
    expect(report.checked).toBe(2);
    expect(report.inconsistent).toEqual([]); // 'ok' is coherent; the fault didn't abort the scan
    expect(report.errored.map((e) => e.segment)).toEqual(['bad']);
    expect(report.errored[0]!.error).toMatch(/unavailable/);
  });

  it('checks the LIVE pointer, not the enumeration snapshot (no false torn on a stale/lagging list)', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 0 }, [1], { registry });
    await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 1 }, [1], { registry }); // a second load
    await storage.delete({ segment: 's', generation: 0 }); // GC reclaims the superseded gen — live is gen 1 only
    // Make registry.list() yield a STALE currentGen 0 (an eventually-consistent enumeration lagging the live
    // pointer), while the strong registry.get() reflects the live gen 1 and Storage has only gen 1. A check that
    // trusted the list snapshot would cry torn on gen 0; reading the live pointer per segment must not.
    const realList = registry.list.bind(registry);
    vi.spyOn(registry, 'list').mockImplementation(async function* (ns?: string) {
      for await (const rec of realList(ns)) yield { ...rec, currentGen: 0 };
    });
    const report = await runConsistencyCheck({ storage, registry });
    expect(report.checked).toBe(1);
    expect(report.inconsistent).toEqual([]); // checked against the live pointer (gen 1, present) — coherent
    expect(report.errored).toEqual([]);
  });

  it('rejects a bad concurrency before scanning', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await expect(runConsistencyCheck({ storage, registry }, { concurrency: 0 })).rejects.toThrow(
      /concurrency/,
    );
  });
});

describe('store.checkConsistency (facade)', () => {
  it('surfaces a torn restore through the store method', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 0 }, [1], { registry });
    await tearRestore(registry, { segment: 's' });
    const store = new CloudRoaring({
      storage: backend,
      retry: false,
    });
    const report = await store.checkConsistency();
    expect(report.inconsistent.map((i) => i.segment)).toEqual(['s']);
  });

  it('needs a raw storage driver + registry (throws with a pre-built StorageChunkSource)', async () => {
    const registry = new MemoryRegistryDriver();
    const store = new CloudRoaring({
      // A pre-built source resolves generations itself — the store has no raw IStorageDriver to scan.
      storage: new CrbmStorageChunkSource(new MemoryStorageDriver(), { registry }),
      retry: false,
    });
    await expect(store.checkConsistency()).rejects.toThrow(UnsupportedError);
  });
});
