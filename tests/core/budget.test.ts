import { BudgetExceededError, DEFAULT_BUDGET } from '@/index';
import { resolveBudget, resolvePerOpBudget, checkBudget } from '@/core/budget';
import { ValidationError } from '@/core/errors';
import { collect, loadedStore, seededStore } from '../helpers/loaded';

/**
 * The denial-of-wallet budget, in the units the loaded store actually bills: **cold chunk fetches**. `count` /
 * `iterate` charge one per chunk they must read; the combines charge one per surviving key per operand that
 * holds it; the admin scans (`subjectReport` / `eraseSubject`) charge one per segment enumerated. Every check
 * happens BEFORE the fan-out, so a runaway is refused rather than billed.
 */

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

describe('per-op budget enforced by the store', () => {
  /** A store whose ceiling (2 requests) sits below a three-chunk fan-out. */
  const tinyBudgetStore = (segments: Record<string, number[]>) =>
    seededStore(segments, { budget: { maxRequests: 2 }, retry: false });

  it('iterate refuses a fan-out over the budget (before yielding)', async () => {
    const { store } = tinyBudgetStore({ s: THREE_CHUNKS }); // 3 chunks ⇒ 3 cold fetches
    await expect(collect(store.segment('s').iterate())).rejects.toThrow(BudgetExceededError);
  });

  it('count refuses a fan-out over the budget', async () => {
    // This cold source carries no index, so `count` falls back to fetching every chunk — 3 > 2.
    const { store } = tinyBudgetStore({ s: THREE_CHUNKS });
    await expect(store.segment('s').count()).rejects.toThrow(BudgetExceededError);
  });

  it('intersect refuses when common-keys × operands exceeds the budget', async () => {
    const { store } = tinyBudgetStore({ a: THREE_CHUNKS, b: THREE_CHUNKS });
    // 3 surviving keys × 2 operands = 6 cold fetches > 2.
    await expect(collect(store.segment('a').intersect([store.segment('b')]))).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('an exclude operand is charged only where it holds a surviving key', async () => {
    // `a ∩ b` survives at 3 keys (6 fetches); the exclude holds exactly one of them ⇒ 7 units, not 9.
    const { store } = seededStore(
      { a: THREE_CHUNKS, b: THREE_CHUNKS, sup: [70_000] },
      { retry: false },
    );
    const a = store.segment('a');
    const opts = { exclude: [store.segment('sup')] };
    await expect(
      collect(a.intersect([store.segment('b')], { ...opts, budget: { maxRequests: 6 } })),
    ).rejects.toThrow(BudgetExceededError);
    expect(
      (await collect(a.intersect([store.segment('b')], { ...opts, budget: { maxRequests: 7 } })))
        .length,
    ).toBe(2); // the suppressed id is gone; the other two survive
  });

  it('the generous default never trips a normal op', async () => {
    const { store } = seededStore({ s: THREE_CHUNKS }, { retry: false }); // no budget ⇒ DEFAULT_BUDGET
    expect(await store.segment('s').count()).toBe(3);
    expect((await collect(store.segment('s').iterate())).length).toBe(3);
  });

  it('a per-op override lifts (or tightens) the store budget on intersect', async () => {
    const { store } = tinyBudgetStore({ a: THREE_CHUNKS, b: THREE_CHUNKS }); // store budget 2
    const a = store.segment('a');
    // budget: false lifts it for this call; a tight override refuses again.
    expect((await collect(a.intersect([store.segment('b')], { budget: false }))).length).toBe(3);
    await expect(
      collect(a.intersect([store.segment('b')], { budget: { maxRequests: 2 } })),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('a PARTIAL per-op override on intersect inherits the tight store ceiling (not the default)', async () => {
    const { store } = tinyBudgetStore({ a: THREE_CHUNKS, b: THREE_CHUNKS }); // store budget 2
    // `{}` carries no maxRequests: it must inherit the store's 2 (fan-out 6 > 2 ⇒ refuse), NOT jump to DEFAULT.
    await expect(
      collect(store.segment('a').intersect([store.segment('b')], { budget: {} })),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('refuses BEFORE any cold fetch (the check is before fan-out, so the runaway never spends)', async () => {
    const { store, cold } = tinyBudgetStore({ s: THREE_CHUNKS });
    const spy = vi.spyOn(cold, 'getChunk');
    await expect(store.segment('s').count()).rejects.toThrow(BudgetExceededError);
    expect(spy).not.toHaveBeenCalled(); // proves the refusal happened before the fetch loop
  });

  // Production stores wrap a raw IColdDriver in a CrbmColdChunkSource, which serves per-chunk cardinalities
  // straight from the `.crbm` index — so `count` reads no payload at all and there is nothing to budget. The
  // seeded MemoryColdChunkSource above only exercises the fallback path; these two cover the real path.
  it('count on a loaded generation charges nothing — the index answers, so no chunk is fetched', async () => {
    const { store } = await loadedStore(
      { s: FIVE_CHUNKS },
      { budget: { maxRequests: 1 }, retry: false },
    );
    // Five chunks under a ceiling of one: the fallback path would have projected 5 and refused.
    expect(await store.segment('s').count()).toBe(5);
  });

  it('iterate over a loaded generation still charges one cold fetch per chunk', async () => {
    const { store } = await loadedStore(
      { s: FIVE_CHUNKS },
      { budget: { maxRequests: 2 }, retry: false },
    );
    // Iteration has to read the payloads (the index only carries cardinality) ⇒ 5 > 2.
    await expect(collect(store.segment('s').iterate())).rejects.toThrow(BudgetExceededError);
  });

  /** Three registered segments — the fan-out the admin scans charge one unit each for. */
  const threeSegmentAdmin = (budget?: { maxRequests: number }) =>
    loadedStore({ a: [1], b: [1], c: [1] }, { ...(budget ? { budget } : {}), retry: false });

  it('subjectReport refuses a scan over the budget', async () => {
    const { store } = await threeSegmentAdmin({ maxRequests: 2 }); // 3 registered segments > 2
    await expect(store.subjectReport(1, { allNamespaces: true })).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('eraseSubject refuses a scan over the budget before rewriting any generation', async () => {
    const { store } = await threeSegmentAdmin({ maxRequests: 2 }); // 3 registered segments > 2
    await expect(store.eraseSubject(1, { allNamespaces: true })).rejects.toThrow(
      BudgetExceededError,
    );
    // Before-fan-out: nothing was rewritten — the id is still present in every segment.
    expect(await store.segment('a').has(1)).toBe(true);
  });

  it('a per-op budget override tightens or lifts the store default on the admin scans', async () => {
    const { store } = await threeSegmentAdmin(); // DEFAULT_BUDGET
    // tighten below the fan-out ⇒ refuse
    await expect(
      store.subjectReport(1, { allNamespaces: true, budget: { maxRequests: 1 } }),
    ).rejects.toThrow(BudgetExceededError);
    // false lifts it ⇒ succeeds
    expect(
      (await store.subjectReport(1, { allNamespaces: true, budget: false })).segments,
    ).toHaveLength(3);
  });

  it('a PARTIAL per-op override inherits a tight store ceiling (does not reset it to the default)', async () => {
    const { store } = await threeSegmentAdmin({ maxRequests: 2 });
    // `{}` carries no maxRequests: it must inherit the store's 2 (3 segments > 2 ⇒ refuse), NOT jump to DEFAULT.
    await expect(store.subjectReport(1, { allNamespaces: true, budget: {} })).rejects.toThrow(
      BudgetExceededError,
    );
  });
});
