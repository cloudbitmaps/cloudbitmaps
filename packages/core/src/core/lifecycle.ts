/**
 * One **lifecycle cycle** — the unit of background work the engine repeats: claim a slice of the fleet, retire
 * what has expired, compact what has grown dirty, collect superseded generations.
 *
 * This is the mechanism half of `@cloudbitmaps/engine`. It lives in `core/` on purpose: the loop is driven by
 * the injected {@link Clock} rather than a timer, so it is pure under this project's architecture rules, it
 * runs where no `node:` builtin exists, and — the part that matters most for a background job nobody watches —
 * **a whole multi-worker interleaving can be driven deterministically in a test** by advancing a fake clock.
 * The package on top adds configuration, defaults, `start`/`stop`, and an entrypoint.
 *
 * ## A cycle never throws for a per-phase fault
 *
 * A retention failure must not stop compaction, and neither must stop the next cycle: a background loop that
 * dies on one bad segment stops doing *everything*, which is strictly worse than doing most of it. Faults are
 * collected into {@link LifecycleCycleResult.errors} and reported, never swallowed and never rethrown. A bad
 * *argument*, by contrast, throws immediately — that is a programming error, not an operational one.
 *
 * ## Fast most cycles, complete sometimes
 *
 * Retention runs `scan: 'index'` — cost tracks what is expiring, not what the fleet holds — but that path
 * cannot see a policy with no due-index pointer (written before the index existed, or whose pointer write
 * failed). So every {@link LifecycleRetentionOptions.repairEvery}-th cycle runs `scan: 'fleet'` instead. The
 * pair is the whole design: neither half is a retention strategy alone.
 */
import { runCompactionCycle } from './compaction';
import type { CompactionCycleResult, CompactionDeps } from './compaction';
import type { Clock } from './determinism';
import { ValidationError } from './errors';
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PARTITIONS,
  emptyLeaseState,
  runLeaseCycle,
  type LeaseState,
} from './lease';
import { retireExpired } from './retention-sweep';
import type { RetireExpiredResult } from './retention-sweep';
import type { DropDeps } from './erasure';

/** One day — the target *time* between repair passes, matching the due index's one-day bucket granularity. */
export const REPAIR_TARGET_MS = 86_400_000;

/**
 * Fallback repair cadence, in **cycles**, when the caller has not said how often it runs
 * ({@link LifecycleOptions.cycleIntervalMs}).
 *
 * **This number cannot be right without knowing the cadence**, which is the correction: it previously carried a
 * justification — *"at the engine's default cadence this is roughly daily, which matches the granularity of the
 * index buckets"* — that was wrong by a factor of 60. At the engine's 60 s default, 24 cycles is **24 minutes**,
 * so the complete fleet scan the due index exists to avoid was running 60 times a day, forever. Daily at that
 * cadence is 1440 cycles, and the point of a *cycles* unit is that it does not know that. Pass
 * `cycleIntervalMs` and {@link repairEveryFor} computes it; this constant is only what is left when nobody has.
 */
export const DEFAULT_REPAIR_EVERY = 24;

/**
 * Cycles between repair passes for a caller running every `cycleIntervalMs` — enough to land near
 * {@link REPAIR_TARGET_MS}. At least 1, so a caller whose interval already exceeds a day repairs every cycle.
 *
 * The trade is real in both directions: too rare and a policy with no due-index pointer lingers past its expiry;
 * too frequent and you are paying the fleet scan the index was built to remove. One bucket-width is the natural
 * answer — a segment can then be at most one bucket stale before a repair pass sees it.
 */
export function repairEveryFor(cycleIntervalMs: number): number {
  return Math.max(1, Math.ceil(REPAIR_TARGET_MS / cycleIntervalMs));
}

export interface LifecycleRetentionOptions {
  /** Default true. */
  readonly enabled?: boolean;
  /** Per-cycle cap on retirement attempts, passed through to `retireExpired`. */
  readonly limit?: number;
  /** Past due-buckets a fast scan also reads. */
  readonly lookbackBuckets?: number;
  /**
   * Ceiling on rows a retention scan will hold before refusing (default `DEFAULT_MAX_SCAN_SEGMENTS`, 250k).
   *
   * **Exposed because the error told you to raise something you could not reach.** Past the default, retention
   * threw a `BudgetExceededError` every cycle — caught into {@link LifecycleCycleResult.errors}, so retention
   * silently never ran again — and its message said *"raise `maxScanSegments`"*, which no engine option allowed.
   */
  readonly maxScanSegments?: number;
  /**
   * Run the complete `'fleet'` scan every Nth cycle. `1` = always. Defaults to
   * {@link repairEveryFor}`(cycleIntervalMs)` when the cadence is known, else {@link DEFAULT_REPAIR_EVERY}.
   *
   * The unit is **cycles, not time** — which is exactly why {@link LifecycleOptions.cycleIntervalMs} exists.
   */
  readonly repairEvery?: number;
}

export interface LifecycleCompactionOptions {
  /** Default true. */
  readonly enabled?: boolean;
  /** Per-cycle cap on segments compacted. */
  readonly maxSegments?: number;
  /** Minimum dirty warm rows for a segment to be a candidate. */
  readonly threshold?: number;
  /** Superseded generations to keep as a grace window for in-flight readers. */
  readonly keep?: number;
  /**
   * Ceiling on rows discovery will hold before refusing (default `DEFAULT_MAX_SCAN_SEGMENTS`, 250k). Set it on
   * **both** phases: they scan the same registry in the same cycle, so a ceiling on one is not a ceiling on the
   * cycle.
   */
  readonly maxScanSegments?: number;
}

export interface LifecycleOptions {
  /** This worker's identity — stable per **process**, and distinct between live processes. */
  readonly owner: string;
  /** How many ways to split the fleet (default 1). */
  readonly partitions?: number;
  /**
   * Partition-lease TTL.
   *
   * **It must be several times longer than the gap between your cycles**, because that gap *is* the gap between
   * renewals: a holder that renews less than twice per TTL has its own live leases judged dead and stolen, which
   * is permanent fleet churn rather than an error. `createEngineLoop` derives this from its interval and refuses
   * an explicit value that cannot work; a caller driving cycles from its own scheduler owns the arithmetic and
   * should use `derivedLeaseTtlMs(yourIntervalMs, 0)`.
   */
  readonly leaseTtlMs?: number;
  /**
   * How often the caller runs a cycle. **Not used to schedule anything** — this function never sleeps. It is the
   * one input that lets cadence-dependent defaults be derived rather than guessed, and today that means
   * {@link LifecycleRetentionOptions.repairEvery}, whose unit is cycles.
   *
   * `createEngineLoop` always supplies it. A caller driving cycles from a cron should too, or it gets a repair
   * cadence tuned for nothing in particular.
   */
  readonly cycleIntervalMs?: number;
  readonly retention?: LifecycleRetentionOptions;
  readonly compaction?: LifecycleCompactionOptions;
  /** Scope every phase to one namespace. Absent ⇒ the whole fleet. */
  readonly namespace?: string;
}

/** Consecutive failures per phase. A phase that ran clean is back to `0`; one that did not run is unchanged. */
export type PhaseFailures = Readonly<Record<LifecyclePhase, number>>;

export interface LifecycleState {
  readonly lease: LeaseState;
  /** Cycles completed. Drives the repair cadence; carried so a restart does not reset it to "repair now". */
  readonly cycle: number;
  /**
   * How many cycles in a row each phase has failed.
   *
   * **This is the difference between "something went wrong once" and "this has not worked since Tuesday",** and
   * only the second is worth waking someone for. A single `errors` entry is transient by nature — a throttle, a
   * retried write. The same entry on every cycle for an hour is a broken deployment, and until this counter
   * existed the two were indistinguishable from the outside: a fleet past `maxScanSegments` threw from retention
   * on *every* cycle, forever, and nothing but an unread `lastErrors` array said so.
   */
  readonly phaseFailures: PhaseFailures;
}

export function emptyLifecycleState(): LifecycleState {
  return {
    lease: emptyLeaseState(),
    cycle: 0,
    phaseFailures: { lease: 0, retention: 0, compaction: 0 },
  };
}

/** The three phases of a cycle, in the order they run. */
export type LifecyclePhase = 'lease' | 'retention' | 'compaction';

/** A phase that failed. The cycle continues; the caller decides whether one of these is worth alarming on. */
export interface LifecyclePhaseError {
  readonly phase: LifecyclePhase;
  readonly error: unknown;
}

/**
 * What the lease phase reported, forwarded rather than discarded.
 *
 * **The lease protocol delegates an alarm to its caller, and the caller was throwing it away.**
 * `runLeaseCycle` returns `sinceLastCycleMs` with the note *"greater than `ttlMs` means you are polling too
 * slowly and your own leases are being judged dead — alarm on it"*, because the lease layer cannot see the
 * caller's interval and so cannot raise it itself. This function kept `state` and `held` and dropped the rest,
 * which made that alarm unreachable: the one signal designed to surface a cadence misconfiguration in production
 * could not reach an operator. A check that cannot fire.
 */
export interface LeaseTelemetry {
  /** Distinct live owners observed, including us — the denominator of the fair share. */
  readonly workers: number;
  /** `ceil(partitions / workers)`: the most this worker may hold. Not a promise that it holds that many. */
  readonly target: number;
  readonly claimed: readonly number[];
  /** Held at the start of the cycle and gone by the end. **Steady-state churn here is a problem.** */
  readonly lost: readonly number[];
  readonly stolen: readonly number[];
  /** Gap between this cycle's lease phase and the previous one, by this worker's own clock. */
  readonly sinceLastCycleMs?: number;
  /**
   * That gap exceeded the lease TTL, so this worker's own live leases are being judged dead and stolen every
   * cycle — permanent fleet churn from a cadence mistake, not an error anything would throw. Derived here
   * because this is the layer that knows both numbers.
   */
  readonly pollingTooSlowly: boolean;
}

export interface LifecycleCycleResult {
  readonly state: LifecycleState;
  /** Partitions this worker holds after the lease phase — its slice of the fleet. */
  readonly partitionsHeld: readonly number[];
  /** What the lease phase reported. Absent only if the lease phase threw. */
  readonly lease?: LeaseTelemetry;
  /** Which scan retention used this cycle. `'fleet'` is the periodic repair pass. */
  readonly scan: 'index' | 'fleet';
  readonly retention?: RetireExpiredResult;
  readonly compaction?: CompactionCycleResult;
  /** Per-phase faults. **Empty is the healthy state**; a cycle never throws for one of these. */
  readonly errors: readonly LifecyclePhaseError[];
}

/**
 * Everything a cycle needs. The `clock` is narrowed to a full {@link Clock} rather than compaction's
 * `Pick<Clock, 'now'>`: the lease protocol measures elapsed time between cycles, and the engine's loop sleeps
 * on it, so a bare `{ now }` would type-check and then behave differently in the one place it matters.
 */
export type LifecycleDeps = DropDeps & CompactionDeps & { readonly clock: Clock };

/**
 * The repair cadence actually in force: explicit, else derived from the caller's cadence, else the cadence-blind
 * fallback. One function so `validate` and the cycle cannot disagree about which number applies.
 */
function resolveRepairEvery(options: LifecycleOptions): number {
  if (options.retention?.repairEvery !== undefined) return options.retention.repairEvery;
  if (options.cycleIntervalMs !== undefined && options.cycleIntervalMs > 0) {
    return repairEveryFor(options.cycleIntervalMs);
  }
  return DEFAULT_REPAIR_EVERY;
}

function validate(deps: LifecycleDeps, options: LifecycleOptions): void {
  // Fail loudly at the first cycle rather than skipping a loop that the operator believes is running. Every
  // phase here needs a registry, so its absence is a wiring error, not a reason to quietly do less.
  if (deps.registry === undefined || typeof deps.registry.list !== 'function') {
    throw new ValidationError(
      'lifecycle: a registry driver is required — retention, compaction and generation GC all enumerate it',
    );
  }
  if (typeof deps.clock?.now !== 'function') {
    throw new ValidationError(
      'lifecycle: an injected clock is required — core never reads ambient time',
    );
  }
  if (typeof options.owner !== 'string' || options.owner.length === 0) {
    throw new ValidationError(
      'lifecycle: `owner` must be a non-empty string, distinct between live processes',
    );
  }
  const repairEvery = resolveRepairEvery(options);
  if (!Number.isSafeInteger(repairEvery) || repairEvery < 1) {
    throw new ValidationError(
      `lifecycle: \`repairEvery\` must be an integer >= 1; got ${repairEvery}`,
    );
  }
}

/**
 * Fold a cycle's outcome into the carried per-phase counters. A phase that **ran** either resets to 0 or
 * increments; a phase that **did not run** — disabled, or skipped because this worker holds no partitions — keeps
 * whatever it had, because "we did not look" is not evidence either way.
 */
function foldPhaseFailures(
  previous: PhaseFailures,
  ran: readonly LifecyclePhase[],
  errors: readonly LifecyclePhaseError[],
): PhaseFailures {
  const failed = new Set(errors.map((e) => e.phase));
  const next = { ...previous };
  for (const phase of ran) next[phase] = failed.has(phase) ? previous[phase] + 1 : 0;
  return next;
}

/**
 * Run one cycle. Idempotent and safe to call concurrently from every process: the partition lease decides who
 * acts on what, and every mutation underneath is a conditional write, so a duplicated effort cannot corrupt
 * anything — it can only waste a request.
 */
export async function runLifecycleCycle(
  state: LifecycleState,
  deps: LifecycleDeps,
  options: LifecycleOptions,
): Promise<LifecycleCycleResult> {
  validate(deps, options);
  const errors: LifecyclePhaseError[] = [];
  const cycle = state.cycle + 1;
  const repairEvery = resolveRepairEvery(options);
  const partitions = options.partitions ?? DEFAULT_PARTITIONS;
  // The FIRST cycle repairs. A process that has just started knows nothing about what previous ones swept, and
  // the complete scan is the only thing that can tell it — so a fresh deployment converges immediately instead
  // of waiting out a whole repair interval with an index it did not populate.
  const scan: 'index' | 'fleet' = cycle === 1 || cycle % repairEvery === 0 ? 'fleet' : 'index';

  const ran: LifecyclePhase[] = ['lease'];
  const ttlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  let lease = state.lease;
  let partitionsHeld: readonly number[] = [];
  let telemetry: LeaseTelemetry | undefined;
  try {
    const result = await runLeaseCycle(lease, deps, { owner: options.owner, partitions, ttlMs });
    lease = result.state;
    partitionsHeld = result.held;
    telemetry = {
      workers: result.workers,
      target: result.target,
      claimed: result.claimed,
      lost: result.lost,
      stolen: result.stolen,
      ...(result.sinceLastCycleMs === undefined
        ? {}
        : { sinceLastCycleMs: result.sinceLastCycleMs }),
      // `>=`, not `>`: the staleness test upstream is `now - previous.at >= ttlMs`, so a gap of exactly the TTL
      // is already enough for an observer to conclude this holder is dead. Reporting the boundary as fine would
      // put the alarm one millisecond to the wrong side of the thing it is warning about.
      pollingTooSlowly: (result.sinceLastCycleMs ?? 0) >= ttlMs,
    };
  } catch (error) {
    errors.push({ phase: 'lease', error });
  }

  // Holding nothing is not a failure — it is what every worker beyond the first does when partitions are
  // scarce. It does mean this cycle has no work, and doing it anyway would duplicate another worker's.
  if (partitionsHeld.length === 0) {
    return {
      state: { lease, cycle, phaseFailures: foldPhaseFailures(state.phaseFailures, ran, errors) },
      partitionsHeld,
      ...(telemetry === undefined ? {} : { lease: telemetry }),
      scan,
      errors,
    };
  }

  let retention: RetireExpiredResult | undefined;
  if (options.retention?.enabled !== false) {
    ran.push('retention');
    try {
      retention = await retireExpired(deps, {
        now: deps.clock.now(),
        scan,
        namespace: options.namespace,
        ...(options.retention?.limit === undefined ? {} : { limit: options.retention.limit }),
        ...(options.retention?.lookbackBuckets === undefined
          ? {}
          : { lookbackBuckets: options.retention.lookbackBuckets }),
        ...(options.retention?.maxScanSegments === undefined
          ? {}
          : { maxScanSegments: options.retention.maxScanSegments }),
        // Retire the SAME slice this worker compacts. Without this every replica sweeps the whole fleet and
        // contends — the hazard the compaction CLI documents, which a multi-process engine would otherwise
        // reintroduce silently.
        ...(partitions <= 1 ? {} : { shards: partitionsHeld, totalShards: partitions }),
      });
    } catch (error) {
      errors.push({ phase: 'retention', error });
    }
  }

  let compaction: CompactionCycleResult | undefined;
  if (options.compaction?.enabled !== false) {
    ran.push('compaction');
    try {
      compaction = await runCompactionCycle(deps, {
        owner: options.owner,
        namespace: options.namespace,
        // Compaction shards by the same stable hash the partitions use, so a worker compacts exactly the slice
        // its leases entitle it to — the leases replace the hand-configured shard index the daemon needed.
        // EVERY partition this worker holds, not just the first. Passing `partitionsHeld[0]` compacted a
        // quarter of a four-partition worker's own slice and left the rest to grow — silently, since nothing
        // errors and disjointness tests still pass. Coverage is the property; disjointness is not enough.
        ...(partitions <= 1 ? {} : { shards: partitionsHeld, totalShards: partitions }),
        ...(options.compaction?.maxSegments === undefined
          ? {}
          : { maxSegments: options.compaction.maxSegments }),
        ...(options.compaction?.threshold === undefined
          ? {}
          : { threshold: options.compaction.threshold }),
        ...(options.compaction?.keep === undefined ? {} : { keep: options.compaction.keep }),
        ...(options.compaction?.maxScanSegments === undefined
          ? {}
          : { maxScanSegments: options.compaction.maxScanSegments }),
      });
    } catch (error) {
      errors.push({ phase: 'compaction', error });
    }
  }

  return {
    state: { lease, cycle, phaseFailures: foldPhaseFailures(state.phaseFailures, ran, errors) },
    partitionsHeld,
    ...(telemetry === undefined ? {} : { lease: telemetry }),
    scan,
    ...(retention === undefined ? {} : { retention }),
    ...(compaction === undefined ? {} : { compaction }),
    errors,
  };
}
