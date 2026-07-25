import {
  CloudRoaring,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  BudgetExceededError,
  DEFAULT_BUDGET,
} from '@/index';
import { resolveBudget, resolvePerOpBudget, checkBudget } from '@/core/budget';
import { ValidationError } from '@/core/errors';

const collect = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
};

// Three ids in three distinct 16-bit chunks (id >> 16 = 0, 1, 2) → a 3-request fan-out for count/iterate.
const THREE_CHUNKS = [1, 70_000, 140_000];
// Five ids in five distinct 16-bit chunks (id >> 16 = 0..4) → five clean chunks for the cheap-count path.
const FIVE_CHUNKS = [1, 70_000, 140_000, 210_000, 280_000];

describe('budget helper (core/budget)', () => {
  it('DEFAULT_BUDGET is on and generous', () => {
    expect(DEFAULT_BUDGET.maxRequests).toBeGreaterThanOrEqual(1_000_000);
  });

  it('resolveBudget: default fallback, partial override, and false ⇒ disabled', () => {
    expect(resolveBudget(undefined, DEFAULT_BUDGET)).toEqual(DEFAULT_BUDGET);
    expect(resolveBudget({ maxRequests: 5 }, DEFAULT_BUDGET)).toEqual({ maxRequests: 5 });
    expect(resolveBudget(false, DEFAULT_BUDGET)).toBeNull();
  });

  it('resolveBudget rejects a non-positive / non-integer limit', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => resolveBudget({ maxRequests: bad }, DEFAULT_BUDGET)).toThrow(ValidationError);
    }
  });

  it('checkBudget throws over the limit, is a no-op under it or when disabled', () => {
    expect(() => checkBudget({ maxRequests: 3 }, 4, 'op')).toThrow(BudgetExceededError);
    expect(() => checkBudget({ maxRequests: 3 }, 3, 'op')).not.toThrow(); // boundary: equal is allowed
    expect(() => checkBudget(null, 1_000_000, 'op')).not.toThrow(); // disabled
  });

  it('resolvePerOpBudget: a partial override inherits the store tightening (never resets to the default)', () => {
    const store = { maxRequests: 5 };
    expect(resolvePerOpBudget(undefined, store)).toEqual(store); // inherit store as-is
    expect(resolvePerOpBudget(undefined, null)).toBeNull(); // inherit a disabled store
    expect(resolvePerOpBudget({ maxRequests: 2 }, store)).toEqual({ maxRequests: 2 }); // replace
    expect(resolvePerOpBudget(false, store)).toBeNull(); // disable
    // The security fix: an empty/partial override must NOT silently lift the tight store ceiling to DEFAULT.
    expect(resolvePerOpBudget({}, store)).toEqual({ maxRequests: 5 });
    // Only when the store itself has no ceiling does a partial override fall back to the generous default.
    expect(resolvePerOpBudget({}, null)).toEqual(DEFAULT_BUDGET);
  });
});

describe('per-op budget enforced by the store (gap #8)', () => {
  const tinyBudgetStore = (): CloudRoaring =>
    new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      budget: { maxRequests: 2 },
      retry: false,
    });

  it('iterate refuses a fan-out over the budget (before yielding)', async () => {
    const cr = tinyBudgetStore();
    await cr.segment('s').addMany(THREE_CHUNKS); // 3 dirty chunks; writes are never budgeted
    await expect(collect(cr.segment('s').iterate())).rejects.toThrow(BudgetExceededError);
  });

  it('count refuses a fan-out over the budget', async () => {
    const cr = tinyBudgetStore();
    await cr.segment('s').addMany(THREE_CHUNKS);
    await expect(cr.segment('s').count()).rejects.toThrow(BudgetExceededError);
  });

  it('intersect refuses when common-keys × operands exceeds the budget', async () => {
    const cr = tinyBudgetStore();
    await cr.segment('a').addMany(THREE_CHUNKS);
    await cr.segment('b').addMany(THREE_CHUNKS);
    await expect(collect(cr.segment('a').intersect([cr.segment('b')]))).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('the generous default never trips a normal op', async () => {
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      retry: false,
    }); // no budget option ⇒ DEFAULT_BUDGET
    await cr.segment('s').addMany(THREE_CHUNKS);
    expect(await cr.segment('s').count()).toBe(3);
    expect((await collect(cr.segment('s').iterate())).length).toBe(3);
  });

  it('a per-op override lifts (or tightens) the store budget on intersect', async () => {
    const cr = tinyBudgetStore(); // store budget maxRequests: 2
    await cr.segment('a').addMany(THREE_CHUNKS);
    await cr.segment('b').addMany(THREE_CHUNKS);
    // budget: false lifts it for this call; a generous override also works.
    expect(
      (await collect(cr.segment('a').intersect([cr.segment('b')], { budget: false }))).length,
    ).toBe(3);
    await expect(
      collect(cr.segment('a').intersect([cr.segment('b')], { budget: { maxRequests: 2 } })),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('a PARTIAL per-op override on intersect inherits the tight store ceiling (not the default)', async () => {
    const cr = tinyBudgetStore(); // store budget maxRequests: 2
    await cr.segment('a').addMany(THREE_CHUNKS);
    await cr.segment('b').addMany(THREE_CHUNKS);
    // `{}` carries no maxRequests: it must inherit the store's 2 (fan-out 3 > 2 ⇒ refuse), NOT jump to DEFAULT.
    await expect(
      collect(cr.segment('a').intersect([cr.segment('b')], { budget: {} })),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('subjectReport refuses a scan over the budget', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    for (const s of ['a', 'b', 'c']) {
      await bulkLoadCrbmGeneration(cold, { segment: s, generation: 0 }, [1], { registry });
    }
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold,
      registry,
      budget: { maxRequests: 2 },
      retry: false,
    });
    await expect(cr.subjectReport(1, { allNamespaces: true })).rejects.toThrow(BudgetExceededError);
  });

  it('refuses BEFORE any cold fetch (the check is before fan-out, so the runaway never spends)', async () => {
    const cold = new MemoryColdChunkSource();
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold,
      budget: { maxRequests: 2 },
      retry: false,
    });
    await cr.segment('s').addMany(THREE_CHUNKS); // 3 dirty chunks (fallback count path fans out 3)
    const spy = vi.spyOn(cold, 'getChunk');
    await expect(cr.segment('s').count()).rejects.toThrow(BudgetExceededError);
    expect(spy).not.toHaveBeenCalled(); // proves the refusal happened before the fetch loop
  });

  // Production stores wrap a raw IColdDriver in a CrbmColdChunkSource, which serves per-chunk cardinalities —
  // so count() takes the *cheap* path (budgets warmRows.size, not total keys). The MemoryColdChunkSource above
  // has no cardinalities and only exercises the fallback path; these two cover the real path.
  const rawColdStore = (
    cold: MemoryColdDriver,
    registry: MemoryRegistryDriver,
    budget: { maxRequests: number },
  ): CloudRoaring =>
    new CloudRoaring({ warm: new MemoryWarmDriver(), cold, registry, budget, retry: false });

  it('count cheap path budgets only the DIRTY chunks — clean chunks are free', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    // Five clean chunks in Cold, zero warm deltas: the cheap path counts them from the index with 0 reads,
    // so a budget of 2 must NOT trip (the fallback path would have projected 5 and refused).
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, FIVE_CHUNKS, { registry });
    expect(await rawColdStore(cold, registry, { maxRequests: 2 }).segment('s').count()).toBe(5);
  });

  it('count cheap path DOES refuse when the dirty-chunk fan-out exceeds the budget', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { segment: 's', generation: 0 }, [1], { registry });
    const cr = rawColdStore(cold, registry, { maxRequests: 2 });
    await cr.segment('s').addMany(THREE_CHUNKS); // 3 dirty chunks ⇒ 3 cold fetches on the cheap path
    await expect(cr.segment('s').count()).rejects.toThrow(BudgetExceededError);
  });

  const threeSegmentAdmin = async (
    budget: { maxRequests: number } | undefined,
  ): Promise<CloudRoaring> => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    for (const s of ['a', 'b', 'c']) {
      await bulkLoadCrbmGeneration(cold, { segment: s, generation: 0 }, [1], { registry });
    }
    return new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold,
      registry,
      ...(budget ? { budget } : {}),
      retry: false,
    });
  };

  it('eraseSubject refuses a scan over the budget before writing any tombstone', async () => {
    const cr = await threeSegmentAdmin({ maxRequests: 2 }); // 3 registered segments > 2
    await expect(cr.eraseSubject(1, { owner: 'w', allNamespaces: true })).rejects.toThrow(
      BudgetExceededError,
    );
    // Before-fan-out: nothing was removed — the id is still present in every segment.
    expect(await cr.segment('a').has(1)).toBe(true);
  });

  it('a per-op budget override tightens or lifts the store default on the admin scans', async () => {
    const generous = await threeSegmentAdmin(undefined); // DEFAULT_BUDGET
    // tighten below the fan-out ⇒ refuse
    await expect(
      generous.subjectReport(1, { allNamespaces: true, budget: { maxRequests: 1 } }),
    ).rejects.toThrow(BudgetExceededError);
    // false lifts it ⇒ succeeds
    expect(
      (await generous.subjectReport(1, { allNamespaces: true, budget: false })).segments,
    ).toHaveLength(3);
  });

  it('a PARTIAL per-op override inherits a tight store ceiling (does not reset it to the default)', async () => {
    const tight = await threeSegmentAdmin({ maxRequests: 2 });
    // `{}` carries no maxRequests: it must inherit the store's 2 (3 segments > 2 ⇒ refuse), NOT jump to DEFAULT.
    await expect(tight.subjectReport(1, { allNamespaces: true, budget: {} })).rejects.toThrow(
      BudgetExceededError,
    );
  });
});
