/**
 * The default real-time {@link Clock} — the production half of the determinism seam.
 *
 * It lives outside `core/`, so `Date.now()`, `setTimeout` and `setImmediate` are allowed here; that separation is
 * the whole point of the seam, and it is lint-enforced on the other side.
 *
 * It sits in its own module rather than in `index.ts` because two places need it — the facade, and
 * `codec-bound.ts`, which pre-binds it into `bulkLoadCrbmGeneration`. Importing it from `index.ts` would put a
 * cycle between the barrel and a module the barrel re-exports.
 */
import type { Clock } from '@cloudbitmaps/core';

/** Default real-time clock — lives outside `core/`, so `Date.now()` + timers are allowed here. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    // A *ref'd* timer, deliberately. Every `sleep` on this clock backs a caller-awaited, bounded retry — the
    // engine's OCC read-modify-write backoff and the driver transient-retry loop (`withRetry`). A pending
    // backoff therefore always means unfinished awaited work, so the timer MUST keep the event loop alive until
    // it resolves. Unref-ing it (the pre-fix behaviour) let a short-lived process — CLI, Lambda, a bare script —
    // whose only remaining handle was the backoff timer exit 0 mid-retry, silently dropping the awaited write
    // with neither an applied result nor a thrown error (surfaced by the T4 hot-row contention stress).
    // Retries are bounded (`maxAttempts`/`maxRetries` + `maxDelayMs`), so a ref'd timer can only
    // extend a process by the small remaining backoff budget of work that is genuinely still in flight.
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * `setImmediate`, and it has to be — this is the one place where the choice of primitive is the whole feature.
   *
   * A long CPU-bound loop in `core/` (bulk-load is the one that matters) periodically hands the loop back so a
   * co-resident HTTP server keeps answering. Measured over a 61,035-chunk load, yielding every 1,024 chunks:
   *
   * ```text
   *   no yield         568 ms wall   568.0 ms worst event-loop gap
   *   sleep(0)         555 ms wall   555.2 ms   ← a microtask. Yields NOTHING.
   *   setImmediate     569 ms wall    13.8 ms   ← free, and 41x less starvation
   *   setTimeout(1)    625 ms wall    15.0 ms   ← +10% wall for no extra relief
   * ```
   *
   * `sleep(0)` resolving on a microtask is correct for its own contract and useless for this: microtasks drain
   * before the loop ever advances a phase, so `await sleep(0)` in a tight loop never lets a single pending I/O
   * callback run. `setImmediate` fires in the check phase *after* pending I/O, which is exactly the ordering a
   * server wants — inbound requests are serviced before the loop resumes chewing.
   *
   * A timer is not ref'd here (unlike {@link sleep}): a yield expresses "someone else may go first", never
   * "there is outstanding work" — and `setImmediate` cannot outlive the turn that scheduled it anyway.
   */
  yieldNow(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}
