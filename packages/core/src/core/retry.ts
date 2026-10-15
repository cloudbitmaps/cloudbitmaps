/**
 * `withRetry` — the one retry/backoff primitive.
 *
 * A pure, storage-agnostic helper: it knows nothing about HTTP, AWS, or any SDK. It retries an operation
 * while the operation keeps failing with a **retryable** error (by default {@link TransientError}), waiting
 * a bounded, jittered, exponentially-growing delay between attempts. Time and randomness are **injected**
 * (the determinism seam) — production wires a `setTimeout`-backed clock + a real RNG; the
 * tests wire virtual ones — so a backoff schedule is replayable from a seed and unit tests run with no
 * real sleeping.
 *
 * It deliberately does **not** retry deterministic failures ({@link WriteConflictError},
 * {@link ValidationError}, {@link IntegrityError}, {@link NotFoundError}, …): retrying those either can't
 * help or would be incorrect. A pointer conflict is retried by a *separate* loop inside
 * the publish, because each attempt must re-read the row and re-decide — a blind replay of the same
 * compare-and-swap would either fail again on a stale token or, worse, advance a pointer whose state has
 * changed underneath it. A write-once object collision is never replayed at all: the generation number is
 * taken, so the caller has to pick a new one.
 */
import { requireFiniteNumber, requireInteger } from './check';
import type { Clock, Rng } from './determinism';
import { isTransientError, ValidationError } from './errors';

/**
 * How the store retries a transient read: attempts, exponential backoff with a cap, and jitter.
 * {@link DEFAULT_RETRY_POLICY} is the default; the store's `retry` option overrides it a field at a time.
 */
export interface RetryPolicy {
  /** Total attempts including the first (so `maxAttempts: 4` = 1 try + 3 retries). Must be ≥ 1. */
  readonly maxAttempts: number;
  /** Delay before the first retry, in ms. Grows by `backoffFactor` each subsequent retry. */
  readonly baseDelayMs: number;
  /** Upper bound on a single (pre-jitter) delay, in ms — caps the exponential growth. */
  readonly maxDelayMs: number;
  /** Exponential growth factor between retries (e.g. 2 ⇒ base, 2·base, 4·base, …). */
  readonly backoffFactor: number;
  /**
   * `'full'` ⇒ the actual wait is uniform in `[0, computed]` (AWS-recommended full jitter: decorrelates
   * concurrent retriers so they don't reconverge into a thundering herd). `'none'` ⇒ wait exactly `computed`.
   */
  readonly jitter: 'full' | 'none';
}

/**
 * Conservative defaults: 4 attempts, 50ms → 100 → 200 (×2), capped at 2s, full jitter. Tuned for a cloud
 * backend's brief throttle/5xx blip — enough to ride out a transient fault without turning a hard outage
 * into a long hang. Override per store (`retry`) or per read source (`RetryingStorageChunkSource`) if your latency
 * budget differs.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 50,
  maxDelayMs: 2_000,
  backoffFactor: 2,
  jitter: 'full',
};

export interface RetryDeps {
  readonly clock: Clock;
  readonly rng: Rng;
  /** Override which errors are retryable. Default: any {@link TransientError}. */
  readonly isRetryable?: (err: unknown) => boolean;
  /**
   * Optional hook (observability) fired before each backoff wait. `attempt` is 1-based (the one that failed).
   * Best-effort: an error it throws is swallowed, so it can neither stop the retry nor change the error thrown.
   */
  readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

/**
 * Backoff delay (ms) for the retry that follows a given 1-based attempt, before jitter is applied. Exposed
 * for tests. `attempt` 1 ⇒ `baseDelayMs`, 2 ⇒ `base·factor`, … capped at `maxDelayMs`.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * policy.backoffFactor ** (attempt - 1);
  return Math.min(policy.maxDelayMs, raw);
}

/** Apply the policy's jitter to a computed delay using the injected RNG. */
export function applyJitter(policy: RetryPolicy, delayMs: number, rng: Rng): number {
  if (policy.jitter === 'none') return delayMs;
  return rng.next() * delayMs; // full jitter: uniform in [0, delayMs)
}

/** A clock that can wait: the one member {@link jitteredWait} uses. */
interface Sleeper {
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Wait a uniformly spread share of `boundMs`, whole milliseconds, by the clock's `sleep`. With no `rng` it waits the
 * whole bound; with no `sleep` it does not wait.
 */
export function jitteredWait(
  clock: Sleeper | undefined,
  rng: Rng | undefined,
  boundMs: number,
): Promise<void> {
  const sleep = clock?.sleep;
  return sleep === undefined
    ? Promise.resolve()
    : sleep.call(clock, Math.floor((rng?.next() ?? 1) * boundMs));
}

/**
 * The store's read retry, as a write path takes it for the reads it makes along the way: a policy (the default when
 * absent) and what {@link withRetry} needs to run it.
 */
export type ReadRetry = RetryDeps & { readonly policy?: RetryPolicy };

/**
 * Run a read under `retry`, or once when there is none. For the reads a write makes along the way (a load guard's
 * read of the current generation, an erasure's reads of the generations it rewrites and verifies): a read is safe
 * to repeat, so a transient fault on one is retried under the store's policy rather than failing the whole write.
 * The write itself is never passed here.
 */
export function retryRead<T>(op: () => Promise<T>, retry: ReadRetry | undefined): Promise<T> {
  return retry === undefined ? op() : withRetry(op, retry.policy ?? DEFAULT_RETRY_POLICY, retry);
}

/**
 * `policy`, checked when it is wired rather than at the first retry: a delay or factor that is not a finite number, a
 * negative delay, a factor below 1 or a jitter mode it does not know would make the backoff `NaN`, which a timer reads
 * as 1 ms, so bounded backoff silently became a hot retry loop. `maxAttempts` is a whole number, and `maxDelayMs` is not
 * below `baseDelayMs`, which it would otherwise cap every delay under.
 */
export function checkedRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const { maxAttempts, baseDelayMs, maxDelayMs, backoffFactor, jitter } = policy;
  requireInteger(maxAttempts, { min: 1, what: 'retry.maxAttempts' });
  requireFiniteNumber(baseDelayMs, { min: 0, what: 'retry.baseDelayMs' });
  requireFiniteNumber(maxDelayMs, {
    min: baseDelayMs,
    what: 'retry.maxDelayMs',
    note: 'retry.baseDelayMs',
  });
  requireFiniteNumber(backoffFactor, { min: 1, what: 'retry.backoffFactor' });
  if (jitter !== 'full' && jitter !== 'none') {
    throw new ValidationError(`retry.jitter must be 'full' or 'none'`);
  }
  return policy;
}

/**
 * Run `op`, retrying transient failures per `policy`. Resolves with `op`'s result, or rejects with the last
 * error once attempts are exhausted (or immediately for a non-retryable error). The thrown error is always
 * the *operation's* error — never a wrapper — so callers keep their typed-error branching.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
): Promise<T> {
  const retryable = deps.isRetryable ?? isTransientError;
  // A `NaN` count (`Number(process.env.X)` with the variable unset) would skip the loop, never call `op` and reject
  // with the literal `undefined`; a policy that bypassed `checkedRetryPolicy` is refused here instead.
  const attempts = requireInteger(policy.maxAttempts, { min: 1, what: 'retry.maxAttempts' });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !retryable(err)) throw err;
      const delayMs = applyJitter(policy, backoffDelayMs(policy, attempt), deps.rng);
      try {
        deps.onRetry?.({ attempt, delayMs, err });
      } catch {
        // Observability is best-effort, as for a metrics sink (`safeMetrics`): a throwing hook must neither abort
        // the retry nor replace the operation's error with its own. This module has no sink to report it to.
      }
      await deps.clock.sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns or throws. Satisfies the type checker.
  throw lastErr;
}
