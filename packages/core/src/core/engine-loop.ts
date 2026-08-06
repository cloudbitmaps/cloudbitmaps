/**
 * The **engine loop** — `runLifecycleCycle` repeated forever, with the operational behaviour a background job
 * needs to be trusted: a stop that cannot deadlock, an interval that backs off when the world is broken, jitter
 * so a fleet of replicas does not move in lockstep, and a status an operator can alarm on.
 *
 * It lives in `core/` and sleeps on the injected {@link Clock}, so **every one of those properties is testable
 * by advancing a fake clock** rather than by waiting. The package on top adds signal handlers, a real clock, and
 * an entrypoint — things that need `process`, and that are not where the risk is.
 *
 * ## The one thing this loop cannot do
 *
 * **It cannot cancel a cycle.** Nothing in this library takes an `AbortSignal`: a driver call that never settles
 * never settles, deliberately (a homegrown timeout would abandon in-flight requests mid-write). For a loop that
 * has a specific consequence, and pretending otherwise would be the dangerous choice:
 *
 * - `stop()` **races** the in-flight cycle against its timeout instead of awaiting it, and reports
 *   {@link StopResult.drained} so the caller knows whether work was abandoned. An unconditional `await` here
 *   would be a deadlock, not a graceful shutdown.
 * - A hung cycle therefore leaves the loop stopped while the process stays alive — the worst failure mode a
 *   background job has, so {@link EngineStatus.healthy} is defined to go false on it, and the operator alarms on
 *   that.
 * - **The real fix is a request timeout on the caller's SDK client**, which is the first line of the engine's
 *   deployment docs. Without one, nothing here can bound a cycle.
 */
import type { Clock, Rng } from './determinism';
import { ValidationError } from './errors';
import {
  emptyLifecycleState,
  runLifecycleCycle,
  type LifecycleCycleResult,
  type LifecycleDeps,
  type LifecycleOptions,
  type LifecycleState,
} from './lifecycle';
import { releaseAll } from './lease';

/** Default gap between cycles. */
export const DEFAULT_INTERVAL_MS = 60_000;
/** Ceiling the backoff climbs to when cycles keep failing. */
export const DEFAULT_MAX_INTERVAL_MS = 15 * 60_000;
/** Default proportion of the interval to jitter by, so N replicas do not stay in phase. */
export const DEFAULT_JITTER = 0.1;
/** Default grace for `stop()` before it abandons an in-flight cycle. */
export const DEFAULT_STOP_TIMEOUT_MS = 30_000;

export interface EngineLoopOptions extends LifecycleOptions {
  /** Gap between cycles when things are healthy (default {@link DEFAULT_INTERVAL_MS}). */
  readonly intervalMs?: number;
  /**
   * Ceiling for the backed-off interval (default {@link DEFAULT_MAX_INTERVAL_MS}). A cycle that returns errors
   * doubles the wait, up to this; a clean cycle resets it. Without that, a dead backend is retried at full
   * cadence forever — and each cycle already burns the driver retry layer's attempts underneath, so the
   * amplification is cycles × segments × attempts, all billed, all deepening the outage.
   */
  readonly maxIntervalMs?: number;
  /**
   * Fraction of the interval to jitter, `0` to disable (default {@link DEFAULT_JITTER}). **The first sleep is
   * fully jittered**, because replicas rolled out together would otherwise run cycle 1 simultaneously — and
   * cycle 1 is the complete fleet repair scan.
   */
  readonly jitter?: number;
  /**
   * How stale the last completed cycle may be before {@link EngineStatus.healthy} goes false. Defaults to
   * three intervals plus a margin, so one slow cycle is not an alarm and a stopped loop is.
   *
   * **It is a floor, not a fixed window** — it widens with the backoff. See
   * {@link EngineStatus.staleAfterMs}.
   */
  readonly staleAfterMs?: number;
}

export interface EngineStatus {
  readonly running: boolean;
  readonly cyclesCompleted: number;
  /** Consecutive cycles that returned errors or threw. Drives the backoff; resets on a clean cycle. */
  readonly consecutiveFailedCycles: number;
  readonly lastCycleStartedAt?: number;
  readonly lastCycleCompletedAt?: number;
  readonly lastCycleMs?: number;
  /** This worker's slice as of the last cycle. **Empty is normal** — another worker owns it. */
  readonly partitionsHeld: readonly number[];
  readonly lastScan?: 'index' | 'fleet';
  /** Errors from the last cycle, for logging. Bounded to that cycle — never an accumulating list. */
  readonly lastErrors: readonly { phase: string; error: unknown }[];
  /** Elapsed since the previous cycle. **Greater than the lease TTL means the loop is polling too slowly.** */
  readonly sinceLastCycleMs?: number;
  /**
   * **Liveness, and it is not "doing work".** A worker holding zero partitions is healthy — that is what every
   * worker beyond the first does. Healthy means *a cycle attempted and settled recently*, which is exactly the
   * condition a hung driver call breaks while the process stays alive.
   */
  readonly healthy: boolean;
  /**
   * The window `healthy` actually applied — **the effective one, not the configured one.** It widens with the
   * backoff, and that is load-bearing rather than a nicety: a backed-off loop sleeps for up to `maxIntervalMs`
   * (15× the interval by default), so a fixed four-interval window would report a perfectly alive worker as
   * unhealthy from its *second* consecutive failure onward — one brief throttle. Wired to a liveness probe that
   * flap restarts the pod during an outage, which is exactly the thrash the backoff exists to prevent, and the
   * restart also loses the accumulated backoff. So the window tracks what the loop is currently promising.
   *
   * A **hung** cycle is unaffected: it never settles, so nothing widens, and it surfaces on the configured
   * floor as designed.
   */
  readonly staleAfterMs: number;
}

export interface StopResult {
  /** True iff the in-flight cycle finished before the timeout. False ⇒ work was abandoned, and it is unbounded. */
  readonly drained: boolean;
  /**
   * Partitions released, so another worker takes them on its next cycle instead of waiting out the TTL.
   *
   * **May be a subset of what was held**, and that is not a bug to chase: an abandoned cycle keeps running and
   * can move a lease row's token under the release, whose CAS then loses. Those partitions fall back to the
   * ordinary TTL expiry the protocol is built on. Reported rather than assumed, so it is visible.
   */
  readonly released: readonly number[];
}

/**
 * A loop is **single-use**: once {@link EngineLoop.stop} has been called it cannot be restarted, and `start` /
 * `runOnce` throw. Constructing one is free and side-effect free, so a caller who genuinely wants to run again
 * builds a new one — which is also the only way to get a clean {@link LifecycleState} rather than a half-released
 * lease view. The alternative was worse than a restriction: with the stop memoised for idempotence, a restarted
 * loop's second `stop()` returned the *first* stop's result and the loop kept running — holding leases, sweeping,
 * reporting stopped.
 */
export interface EngineLoop {
  /** Loop until {@link stop}. Rejects only for a wiring error; a cycle fault is absorbed and backed off. */
  start(): Promise<void>;
  /**
   * One cycle, then resolve. The shape for a scheduler — no timer, so nothing can silently fail to fire.
   *
   * **Refuses to overlap.** Two cycles on one loop share {@link LifecycleState}, so the later one's lease view
   * and repair-cadence counter overwrite the earlier's. The data is safe regardless (every mutation underneath
   * is a conditional write), but the loop's own bookkeeping is not, and the condition — a schedule firing faster
   * than a cycle takes — is worth a thrown error rather than a silently confused counter.
   */
  runOnce(): Promise<LifecycleCycleResult>;
  /** Wake the sleep, race the in-flight cycle against `timeoutMs`, release leases. Idempotent. */
  stop(options?: { timeoutMs?: number }): Promise<StopResult>;
  status(): EngineStatus;
}

function validateLoop(options: EngineLoopOptions): void {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < 1) {
    throw new ValidationError(`engine: intervalMs must be a finite number >= 1; got ${interval}`);
  }
  const max = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  if (!Number.isFinite(max) || max < interval) {
    throw new ValidationError(
      `engine: maxIntervalMs must be >= intervalMs (${interval}); got ${max}`,
    );
  }
  const jitter = options.jitter ?? DEFAULT_JITTER;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new ValidationError(`engine: jitter must be between 0 and 1; got ${jitter}`);
  }
}

/**
 * Build the loop. Nothing runs until {@link EngineLoop.start} or {@link EngineLoop.runOnce} is called, so
 * constructing one is side-effect free and safe at module scope.
 */
export function createEngineLoop(
  deps: LifecycleDeps & { readonly rng?: Rng },
  options: EngineLoopOptions,
): EngineLoop {
  validateLoop(options);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const jitterFraction = options.jitter ?? DEFAULT_JITTER;
  const staleAfterMs = options.staleAfterMs ?? intervalMs * 3 + intervalMs;
  const clock: Clock = deps.clock;

  let state: LifecycleState = emptyLifecycleState();
  let running = false;
  let stopping = false;
  let cyclesCompleted = 0;
  let consecutiveFailedCycles = 0;
  let lastCycleStartedAt: number | undefined;
  let lastCycleCompletedAt: number | undefined;
  let lastCycleMs: number | undefined;
  let lastResult: LifecycleCycleResult | undefined;
  let inFlight: Promise<unknown> | null = null;
  /** Resolved by `stop()` to cut a sleep short — otherwise a SIGTERM waits out most of an interval. */
  let wake: (() => void) | null = null;
  let stopped: Promise<StopResult> | null = null;

  /** The interval the loop is currently promising: the plain one when clean, the backed-off one when not. */
  function currentIntervalMs(): number {
    if (consecutiveFailedCycles === 0) return intervalMs;
    return Math.min(intervalMs * 2 ** consecutiveFailedCycles, maxIntervalMs);
  }

  /**
   * The staleness window `healthy` applies — the configured floor, widened to twice whatever the loop is
   * currently promising. Twice, not once, so a cycle that takes a while on top of a backed-off sleep is not an
   * alarm; see {@link EngineStatus.staleAfterMs} for why a fixed window is wrong.
   */
  function effectiveStaleAfterMs(): number {
    return Math.max(staleAfterMs, currentIntervalMs() * 2);
  }

  /** Random in `[1 - f, 1 + f)`, or exactly 1 with no `rng` — core may not read ambient randomness. */
  function jitterFactor(fraction: number): number {
    if (fraction === 0 || deps.rng === undefined) return 1;
    return 1 - fraction + deps.rng.next() * fraction * 2;
  }

  /** Sleep, but wake early on `stop()`. Returns whether it was cut short. */
  async function interruptibleSleep(ms: number): Promise<void> {
    if (ms <= 0 || stopping) return;
    await new Promise<void>((resolve) => {
      wake = resolve;
      // A rejection counts as elapsed. `clock` is injected, so a caller's implementation can reject — and an
      // unhandled one would leave this promise pending forever: the loop silently dead while the process lives,
      // the exact failure this module is built to prevent.
      void clock.sleep(ms).then(
        () => resolve(),
        () => resolve(),
      );
    });
    wake = null;
  }

  /** Guard both entry points. `start`'s own loop is sequential, so only its *first* cycle passes through here. */
  function refuseIfUnusable(verb: string): void {
    if (stopped !== null) {
      throw new ValidationError(
        `engine: ${verb} after stop() — a loop is single-use; build another with createEngineLoop`,
      );
    }
    if (inFlight !== null) {
      throw new ValidationError(
        `engine: ${verb} while a cycle is already running — two cycles on one loop share state; your schedule ` +
          'is firing faster than a cycle takes',
      );
    }
  }

  async function cycle(): Promise<LifecycleCycleResult> {
    lastCycleStartedAt = clock.now();
    const promise = runLifecycleCycle(state, deps, options);
    inFlight = promise;
    try {
      const result = await promise;
      state = result.state;
      lastResult = result;
      cyclesCompleted += 1;
      consecutiveFailedCycles = result.errors.length > 0 ? consecutiveFailedCycles + 1 : 0;
      return result;
    } finally {
      // Recorded even when the cycle threw: `healthy` asks whether a cycle SETTLED recently, not whether it
      // succeeded. A loop that fails fast is unhealthy for a different reason, visible in the failure counter.
      lastCycleCompletedAt = clock.now();
      lastCycleMs = lastCycleCompletedAt - (lastCycleStartedAt ?? lastCycleCompletedAt);
      inFlight = null;
    }
  }

  return {
    async start(): Promise<void> {
      if (running) throw new ValidationError('engine: already started');
      refuseIfUnusable('start()');
      running = true;
      stopping = false;
      // Fully jitter the FIRST sleep: replicas deployed together would otherwise run cycle 1 in lockstep, and
      // cycle 1 is always the complete fleet repair scan.
      let first = true;
      while (!stopping) {
        try {
          await cycle();
        } catch {
          // A wiring error would have thrown from the first cycle; anything reaching here is operational, and a
          // loop that exits on it stops doing everything. It is counted, backed off, and surfaced in status().
          consecutiveFailedCycles += 1;
          cyclesCompleted += 1;
        }
        if (stopping) break;
        // Back off while the world is broken, and subtract the work already done so a slow cycle does not
        // compound into an ever-later schedule.
        const base = currentIntervalMs();
        // The first sleep is jittered FULLY (the whole interval), not by the configured fraction: replicas
        // deployed together must not run cycle 1 in lockstep, and cycle 1 is always the complete fleet repair
        // scan. `jitter: 0` still means none at all — an operator asking for determinism gets it.
        const target = base * jitterFactor(first && jitterFraction > 0 ? 1 : jitterFraction);
        first = false;
        await interruptibleSleep(Math.max(0, target - (lastCycleMs ?? 0)));
      }
      running = false;
    },

    runOnce(): Promise<LifecycleCycleResult> {
      // `running` too, not only `inFlight`: `start()` between cycles has an empty `inFlight` and would still
      // have its state overwritten underneath it.
      if (running) {
        throw new ValidationError(
          'engine: runOnce() while start() is looping — pick one, they share state',
        );
      }
      refuseIfUnusable('runOnce()');
      return cycle();
    },

    async stop(stopOptions?: { timeoutMs?: number }): Promise<StopResult> {
      // Idempotent and re-entrant: a second SIGTERM must not start a second shutdown.
      if (stopped !== null) return stopped;
      const timeoutMs = stopOptions?.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
      stopping = true;
      wake?.();
      stopped = (async (): Promise<StopResult> => {
        let drained = true;
        const pending = inFlight;
        if (pending !== null) {
          // RACE, never await. Nothing here is cancellable, so an unconditional await on a hung driver call is
          // a deadlock dressed as a graceful shutdown.
          const timedOut = Symbol('timeout');
          // Both arms swallow rejection. A `stop()` that rejects is worse than one that reports
          // `drained: false` — `stopped` memoises it, so every later stop rejects too and the leases are never
          // released.
          const outcome = await Promise.race([
            pending.then(
              () => undefined,
              () => undefined,
            ),
            clock.sleep(timeoutMs).then(
              () => timedOut,
              () => timedOut,
            ),
          ]);
          drained = outcome !== timedOut;
        }
        // Releasing needs its own deadline: it talks to the same registry that may be the thing hanging.
        let released: number[] = [];
        const releaseTimedOut = Symbol('release-timeout');
        const outcome = await Promise.race([
          releaseAll(state.lease, deps).then((r) => r.released),
          clock.sleep(timeoutMs).then(
            () => releaseTimedOut,
            () => releaseTimedOut,
          ),
        ]).catch(() => [] as number[]);
        if (outcome !== releaseTimedOut) released = outcome as number[];
        state = { ...state, lease: emptyLifecycleState().lease };
        running = false;
        return { drained, released };
      })();
      return stopped;
    },

    status(): EngineStatus {
      const now = clock.now();
      const window = effectiveStaleAfterMs();
      return {
        running,
        cyclesCompleted,
        consecutiveFailedCycles,
        ...(lastCycleStartedAt === undefined ? {} : { lastCycleStartedAt }),
        ...(lastCycleCompletedAt === undefined ? {} : { lastCycleCompletedAt }),
        ...(lastCycleMs === undefined ? {} : { lastCycleMs }),
        partitionsHeld: lastResult?.partitionsHeld ?? [],
        ...(lastResult?.scan === undefined ? {} : { lastScan: lastResult.scan }),
        lastErrors: (lastResult?.errors ?? []).map((e) => ({ phase: e.phase, error: e.error })),
        ...(lastCycleCompletedAt === undefined
          ? {}
          : { sinceLastCycleMs: now - lastCycleCompletedAt }),
        // Never started ⇒ not healthy: a process that has not completed a cycle has not proved it can.
        healthy: lastCycleCompletedAt !== undefined && now - lastCycleCompletedAt < window,
        staleAfterMs: window,
      };
    },
  };
}
