/**
 * `withRetry` — the one retry/backoff primitive.
 *
 * A pure, storage-agnostic helper: it knows nothing about HTTP, AWS, or any SDK. It retries an operation
 * while the operation keeps failing with a **retryable** error (by default {@link TransientError}), waiting
 * a bounded, jittered, exponentially-growing delay between attempts. Time and randomness are **injected**
 * (the determinism seam) — production wires a `setTimeout`-backed clock + a real RNG; the
 * simulator wires virtual ones — so a backoff schedule is replayable from a seed and unit tests run with no
 * real sleeping.
 *
 * It deliberately does **not** retry deterministic failures ({@link WriteConflictError},
 * {@link ValidationError}, {@link IntegrityError}, {@link NotFoundError}, …): retrying those either can't
 * help or would be incorrect. OCC conflicts are retried by a *separate* loop (the engine's read-modify-write)
 * because each retry must re-read and re-apply, not blindly replay the same call.
 */
import type { Clock, Rng } from './determinism';
import { isTransientError } from './errors';

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
 * into a long hang. Override per store/driver if your latency budget differs.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 50,
  maxDelayMs: 2_000,
  backoffFactor: 2,
  jitter: 'full',
};

/** Backoff for the engine's OCC conflict loop — local contention resolves fast, so smaller + tighter. */
export const DEFAULT_OCC_BACKOFF: RetryPolicy = {
  maxAttempts: 1, // attempts are owned by the engine's loop; this policy only supplies the delay schedule
  baseDelayMs: 5,
  maxDelayMs: 200,
  backoffFactor: 2,
  jitter: 'full',
};

export interface RetryDeps {
  readonly clock: Clock;
  readonly rng: Rng;
  /** Override which errors are retryable. Default: any {@link TransientError} (incl. `TimeoutError`). */
  readonly isRetryable?: (err: unknown) => boolean;
  /** Optional hook (observability) fired before each backoff wait. `attempt` is 1-based (the one that failed). */
  readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

/** Default classifier: retry transient infrastructure faults only. */
export function isTransient(err: unknown): boolean {
  return isTransientError(err);
}

/**
 * Backoff delay (ms) for the retry that follows a given 1-based attempt, before jitter is applied. Exposed
 * for tests and the engine's OCC loop. `attempt` 1 ⇒ `baseDelayMs`, 2 ⇒ `base·factor`, … capped at `maxDelayMs`.
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
  const retryable = deps.isRetryable ?? isTransient;
  const attempts = Math.max(1, policy.maxAttempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !retryable(err)) throw err;
      const delayMs = applyJitter(policy, backoffDelayMs(policy, attempt), deps.rng);
      deps.onRetry?.({ attempt, delayMs, err });
      await deps.clock.sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns or throws. Satisfies the type checker.
  throw lastErr;
}
