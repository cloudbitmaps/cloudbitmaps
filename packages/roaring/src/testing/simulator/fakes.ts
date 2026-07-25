/**
 * Fault-injecting fake drivers for the simulator.
 *
 * These wrap the real in-memory drivers and add four faults, all driven by the seeded {@link Scheduler} /
 * {@link SeededRng}:
 *
 * 1. **Completion-order control** — every operation `await`s a {@link Scheduler.point} before doing its
 *    in-memory work, so the scheduler interleaves concurrent ops in a seeded, replayable order. This is the
 *    primary fault: reordering of concurrent operations.
 * 2. **Spurious write conflicts** — `putConditional` may (seeded) reject a write with `WriteConflictError`
 *    *even though the token was current*, modelling a throttle / transient the engine must treat as a
 *    conflict and retry. The store is left untouched, so the engine's OCC retry loop re-reads and converges
 *    — and the oracle proves no write was lost. Injection is **bounded per chunk key** so the (real
 *    contention + spurious) retry count stays comfortably under the engine's retry ceiling: a deterministic
 *    fault, never a flaky retry-exhaustion.
 * 3. **Transient faults** — `warm.get`/`warm.put` and cold **reads** (`getTail`/`getRange`) may (seeded) throw
 *    a {@link TransientError} (throttle / 5xx / dropped connection). Unlike a spurious conflict (ridden out by
 *    the engine's OCC re-read loop), a transient is ridden out by the **retry decorator** the store wraps its
 *    drivers in — so the oracle proves a transient blip never loses or corrupts a write. Bounded per key so a
 *    call always rides out inside the decorator's attempt ceiling, never a flaky retry-exhaustion.
 * 4. **Process crash mid-compaction** — see {@link CrashInjector} / {@link SimCrash}: a compaction is aborted
 *    right after a durable partial 2-phase-commit step, so the oracle proves crash-safe recovery.
 *
 * What is **not** injected here (honest scope): per-call latency, and dropped/duplicated *durable* writes (a
 * backend that silently loses an acknowledged write — out of scope for these in-memory fakes, whose backing
 * maps are the source of truth). One asymmetry worth naming: a cold-read transient is ridden out only on the
 * engine's **retried** read path — a *compaction* reads cold with the raw driver (no retry, by design, so a
 * one-shot admin op surfaces the fault), so an injected transient there is a clean pre-commit abort the
 * compaction actor tolerates (nothing durable was written, so no data is lost — see `simulate.ts`).
 *
 * Test infrastructure — lives under `src/testing/`, never imported by the library entry point.
 */
import { TransientError, WriteConflictError } from '@cloudbitmaps/core';
import { chunkRefKey } from '@cloudbitmaps/core';
import { MemoryColdDriver, MemoryRegistryDriver, MemoryWarmDriver } from '@cloudbitmaps/core';
import type { BlobSink } from '@cloudbitmaps/core';
import type {
  ChunkRef,
  ColdCaps,
  GenKey,
  IColdDriver,
  IRegistryDriver,
  IWarmDriver,
  NewRegistryRecord,
  NoRow,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  Token,
  WarmReadOptions,
  WarmRow,
} from '@cloudbitmaps/core';
import type { SeededRng } from './rng';
import type { Scheduler } from './scheduler';

export interface FaultOptions {
  /** Probability a given `putConditional` is hit by a spurious conflict (0 disables injection). */
  readonly conflictRate: number;
  /**
   * Hard cap on spurious conflicts injected per chunk key *per batch* (see {@link
   * ScheduledWarmDriver.resetFaultBudget}). Keeps the retry count bounded and deterministic: the worst-case
   * attempts on one row ≈ (concurrent writers − 1) + this cap, which must stay under the engine's retry
   * ceiling (17 attempts). The defaults keep `opsPerBatch + maxConflictsPerKey` well under that; a caller
   * pushing `opsPerBatch` toward the ceiling on a single chunk can exhaust retries (a real, replayable
   * failure, not flakiness).
   */
  readonly maxConflictsPerKey: number;
  /**
   * Probability a given warm/cold call is hit by a {@link TransientError} (throttle/5xx/dropped connection),
   * 0 disables. Unlike a spurious conflict (which the engine's OCC loop re-reads through), a transient is
   * ridden out by the **retry decorator** — so a non-zero rate exercises the Phase-4b resilience path and the
   * oracle proves no write was lost.
   */
  readonly transientRate: number;
  /**
   * Hard cap on transient faults injected per chunk key *per call site, per batch*. This is bounded by the
   * **decorator's** ceiling — `maxAttempts − 1` (= 3 under `DEFAULT_RETRY_POLICY`) — NOT the engine's OCC
   * ceiling (17) that bounds {@link maxConflictsPerKey}: the two budgets feed different loops (transients →
   * `withRetry` inside one call; conflicts → the engine's re-read loop). Keep it ≤ 3 or a call deterministically
   * exhausts its retries (a real, replayable failure, not flakiness).
   */
  readonly maxTransientPerKey: number;
}

/**
 * A simulated process crash injected mid-compaction. It is thrown **after** the durable effect of a
 * compaction-only driver op, modelling a crash right after a partial 2PC step — deliberately at *any* durable
 * step, not just the commit, so recovery is proven crash-safe end to end (the "crash at any step" property):
 *
 *  - `cold.putImmutable` — a generation is staged (orphan until the swap).
 *  - `registry.compareAndSwap` — fired after **every** durable registry mutation compaction makes, which is
 *    three distinct points: (a) LEASE acquire (a stale same-owner lease the next attempt simply re-takes),
 *    (b) the `currentGen` SWAP (committed-but-unpurged — the new generation already folded the warm rows, so
 *    the effective set is correct and the idempotent purge resumes next cycle), and (c) lease RELEASE on a
 *    no-op/superseded path (nothing was staged). Each is a genuine, independently-recoverable crash site.
 *
 * These ops are called *only* by compaction in the sim (the engine's reads/writes never touch them mid-batch,
 * and seeding runs before the injector is armed), so the crash lands on the compaction actor with no per-caller
 * bookkeeping. The actor treats it as an expected abort; the oracle then proves the tier state stayed
 * consistent and a later compaction still makes progress.
 */
export class SimCrash extends Error {
  constructor(op: string) {
    super(`injected compaction crash after ${op}`);
    this.name = 'SimCrash';
  }
}

/**
 * Seeded, per-batch-bounded trigger for {@link SimCrash}. One instance is shared across the cold + registry
 * fakes so a single budget bounds the crashes per batch across the whole 2PC (a crash aborts the compaction,
 * so one per batch is the meaningful unit). Starts empty — only fires after {@link reset}, so the pre-batch
 * bulk-load seeding (which also calls `putImmutable`) is never crashed.
 */
export class CrashInjector {
  private left = 0;
  private injectedCount = 0;

  constructor(
    private readonly rng: SeededRng,
    private readonly rate: number,
    private readonly maxPerBatch: number,
  ) {}

  /** Count of crashes actually injected so far — surfaced in the sim result for visibility. */
  get injected(): number {
    return this.injectedCount;
  }

  /** Arm the per-batch budget (call at the start of each batch). */
  reset(): void {
    this.left = this.maxPerBatch;
  }

  /**
   * Seeded decision: should this compaction-only op crash now? Bounded by the per-batch budget. Consumes NO
   * rng when disabled (`rate <= 0`) or the budget is spent, so a crash-free run never perturbs another seed's
   * replay — the `rate <= 0` short-circuit is what keeps every `crashRate: 0` run byte-identical.
   */
  fire(): boolean {
    if (this.rate <= 0 || this.left <= 0) return false;
    if (!this.rng.bool(this.rate)) return false;
    this.left -= 1;
    this.injectedCount += 1;
    return true;
  }
}

/**
 * Wraps {@link MemoryWarmDriver}: gates every op on the scheduler and injects bounded spurious conflicts.
 * Delegates all real semantics (OCC, ABA tokens, tombstones, validation) to the wrapped driver, so it
 * stays a faithful `IWarmDriver` — the fault is *on top of* correct behavior, not a reimplementation.
 */
export class ScheduledWarmDriver implements IWarmDriver {
  // Typed as the interface (not the concrete class) so the decorator can forward the WarmReadOptions the engine
  // passes; the backing MemoryWarmDriver ignores the flag (always strong), which is exactly right for the fake.
  private readonly inner: IWarmDriver = new MemoryWarmDriver();
  private readonly conflictsLeft = new Map<string, number>();
  private readonly transientsLeft = new Map<string, number>();
  private injected = 0;
  private injectedTransient = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly rng: SeededRng,
    private readonly faults: FaultOptions,
  ) {}

  /** Count of spurious conflicts actually injected so far — surfaced in the sim result for visibility. */
  get injectedConflicts(): number {
    return this.injected;
  }

  /** Count of transient faults actually injected so far (the retry-decorator path). */
  get injectedTransients(): number {
    return this.injectedTransient;
  }

  /** Refresh the per-key fault budgets (call between batches so the fault paths stay alive). */
  resetFaultBudget(): void {
    this.conflictsLeft.clear();
    this.transientsLeft.clear();
  }

  async get(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null> {
    await this.scheduler.point(`warm.get#${refLabel(ref)}`);
    if (this.shouldInjectTransient(ref)) {
      throw new TransientError(`injected transient warm.get fault for chunk ${ref.chunkKey}`);
    }
    return this.inner.get(ref, opts);
  }

  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    await this.scheduler.point(`warm.put#${refLabel(ref)}`);
    // A transient is checked before the spurious conflict: the decorator rides out the former, the engine's
    // OCC loop the latter — both must converge, and the oracle proves no acknowledged write was lost.
    if (this.shouldInjectTransient(ref)) {
      throw new TransientError(`injected transient warm.put fault for chunk ${ref.chunkKey}`);
    }
    if (this.shouldInjectConflict(ref)) {
      throw new WriteConflictError(`injected spurious conflict for chunk ${ref.chunkKey}`);
    }
    return this.inner.putConditional(ref, bytes, expected);
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    await this.scheduler.point(`warm.del#${refLabel(ref)}`);
    return this.inner.deleteConditional(ref, expected);
  }

  async *listChunks(
    ref: SegmentRef,
    opts?: WarmReadOptions,
  ): AsyncIterable<{ chunkKey: number } & WarmRow> {
    await this.scheduler.point(`warm.list#${ref.namespace ?? '/'} ${ref.segment}`);
    yield* this.inner.listChunks(ref, opts);
  }

  private shouldInjectConflict(ref: ChunkRef): boolean {
    return this.tryInject(
      ref,
      this.faults.conflictRate,
      this.faults.maxConflictsPerKey,
      this.conflictsLeft,
      () => {
        this.injected += 1;
      },
    );
  }

  private shouldInjectTransient(ref: ChunkRef): boolean {
    return this.tryInject(
      ref,
      this.faults.transientRate,
      this.faults.maxTransientPerKey,
      this.transientsLeft,
      () => {
        this.injectedTransient += 1;
      },
    );
  }

  /** Seeded, per-key-budgeted fault gate shared by the conflict + transient injectors. */
  private tryInject(
    ref: ChunkRef,
    rate: number,
    maxPerKey: number,
    budget: Map<string, number>,
    onInject: () => void,
  ): boolean {
    const hit = budgetedInject(this.rng, rate, maxPerKey, budget, chunkRefKey(ref));
    if (hit) onInject();
    return hit;
  }
}

/**
 * Wraps {@link MemoryColdDriver} (the real write-once `.crbm` object store): gates every op on the scheduler so
 * a compaction's generation writes/reads interleave with concurrent engine reads, and injects bounded transient
 * faults on the **read** path (`getTail`/`getRange`). Immutable + write-once semantics are the wrapped driver's;
 * the fake only adds completion-order control + faults. Used by the compaction cluster (2PC / fenced-purge /
 * torn-read), where the engine and the compaction actor share one instance.
 *
 * Cold-read transients: ridden out by the engine's retry decorator (the store wraps its cold source in one), so
 * the oracle proves a transient blip never corrupts a read. A *compaction* reads cold with the raw driver (no
 * retry, by design), so an injected transient there aborts that compaction cleanly *before* any commit — the
 * sim's `runCompaction` tolerates it (nothing durable written ⇒ no data lost). Bounded per generation so a
 * single retried read always rides out inside the decorator's ceiling; consumes no rng when `transientRate <= 0`.
 */
export class ScheduledColdDriver implements IColdDriver {
  private readonly inner = new MemoryColdDriver();
  private readonly transientsLeft = new Map<string, number>();
  private injectedTransient = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly rng: SeededRng,
    private readonly faults: FaultOptions,
    private readonly crash?: CrashInjector,
  ) {}

  /** Count of transient faults injected on the cold read path so far (the retry-decorator path). */
  get injectedTransients(): number {
    return this.injectedTransient;
  }

  /** Refresh the per-generation transient budget (call between batches so the fault path stays alive). */
  resetFaultBudget(): void {
    this.transientsLeft.clear();
  }

  capabilities(): ColdCaps {
    return this.inner.capabilities();
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    await this.scheduler.point(`cold.put#${genLabel(key)}`);
    // Stage the generation durably, THEN maybe crash — models a crash right after the new `.crbm` lands but
    // before the `currentGen` swap (an orphan generation; `currentGen` unchanged ⇒ the effective set is
    // untouched, orphan-GC cleans up later). Compaction-only op, so this never hits an engine read/write.
    const result = await this.inner.putImmutable(key, write);
    if (this.crash?.fire()) throw new SimCrash(`cold.putImmutable ${genLabel(key)}`);
    return result;
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    await this.scheduler.point(`cold.range#${genLabel(key)}`);
    if (this.shouldInjectTransient(key)) {
      throw new TransientError(`injected transient cold.getRange fault for ${genLabel(key)}`);
    }
    return this.inner.getRange(key, offset, length);
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    await this.scheduler.point(`cold.tail#${genLabel(key)}`);
    if (this.shouldInjectTransient(key)) {
      throw new TransientError(`injected transient cold.getTail fault for ${genLabel(key)}`);
    }
    return this.inner.getTail(key, maxBytes);
  }

  async delete(key: GenKey): Promise<void> {
    await this.scheduler.point(`cold.del#${genLabel(key)}`);
    return this.inner.delete(key);
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    await this.scheduler.point(`cold.list#${ref.namespace ?? '/'} ${ref.segment}`);
    yield* this.inner.list(ref);
  }

  /** Seeded, per-generation-budgeted transient gate for the cold read path (bounded by the decorator ceiling). */
  private shouldInjectTransient(key: GenKey): boolean {
    const hit = budgetedInject(
      this.rng,
      this.faults.transientRate,
      this.faults.maxTransientPerKey,
      this.transientsLeft,
      genLabel(key),
    );
    if (hit) this.injectedTransient += 1;
    return hit;
  }
}

/**
 * Wraps {@link MemoryRegistryDriver} (the authoritative `currentGen` pointer under OCC): gates every op on
 * the scheduler. Because compaction's atomic generation swap (a `compareAndSwap` on `currentGen`) and the
 * engine's generation resolution (a `get`) both flow through here, gating them is what lets the scheduler
 * land a read *before* vs *after* a swap — the torn-read / generation-pinning race (determinism check 3).
 */
export class ScheduledRegistryDriver implements IRegistryDriver {
  private readonly inner: IRegistryDriver;

  constructor(
    private readonly scheduler: Scheduler,
    now: () => number,
    private readonly crash?: CrashInjector,
  ) {
    this.inner = new MemoryRegistryDriver({ now });
  }

  capabilities(): RegCaps {
    return this.inner.capabilities();
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    await this.scheduler.point(`reg.get#${ref.segment}`);
    return this.inner.get(ref);
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    await this.scheduler.point(`reg.create#${ref.segment}`);
    return this.inner.create(ref, record);
  }

  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    await this.scheduler.point(`reg.cas#${ref.segment}`);
    // Apply the swap durably, THEN maybe crash — models a crash right after `currentGen` advances but before
    // the version-fenced warm purge completes (committed-but-unpurged: the effective set is still correct
    // because the new generation already folded those warm rows — the purge is idempotent cleanup).
    const result = await this.inner.compareAndSwap(ref, expected, patch);
    if (this.crash?.fire()) throw new SimCrash(`registry.compareAndSwap ${ref.segment}`);
    return result;
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    await this.scheduler.point(`reg.list#${namespace ?? '/'}`);
    yield* this.inner.list(namespace);
  }

  async delete(ref: SegmentRef): Promise<void> {
    await this.scheduler.point(`reg.del#${ref.segment}`);
    return this.inner.delete(ref);
  }
}

/**
 * Seeded, per-key-budgeted fault gate — the shared core of every injected fault (spurious conflicts + warm/cold
 * transients). Returns true (decrementing the key's budget) at most `maxPerKey` times per key across the given
 * `budget` map. Consumes **no** rng when `rate <= 0`, so a disabled fault never advances the fault stream — that
 * short-circuit is what keeps a run with a fault turned off byte-for-byte identical to before it existed (the
 * replay-stability guarantee the regression corpus relies on). `rng.bool` is called *before* the budget check,
 * so an over-budget key still consumes rng exactly as an injected one would — order-stable either way.
 */
function budgetedInject(
  rng: SeededRng,
  rate: number,
  maxPerKey: number,
  budget: Map<string, number>,
  key: string,
): boolean {
  if (rate <= 0 || maxPerKey <= 0) return false;
  if (!rng.bool(rate)) return false;
  const left = budget.get(key) ?? maxPerKey;
  if (left <= 0) return false;
  budget.set(key, left - 1);
  return true;
}

function refLabel(ref: ChunkRef): string {
  return `${ref.namespace ?? '/'} ${ref.segment} ${ref.chunkKey}`;
}

function genLabel(key: GenKey): string {
  return `${key.namespace ?? '/'} ${key.segment} g${key.generation}`;
}
