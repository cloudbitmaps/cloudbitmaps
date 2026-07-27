/**
 * Logical clock for the deterministic simulator.
 *
 * Implements the `core/` {@link Clock} seam with a **manually-advanced** logical time — no wall-clock, so a
 * simulated run never depends on (or waits for) real time, yet the compaction cluster can model time passing.
 * The simulator advances it a fixed step between batches so the store's `coldGenTtlMs` `currentGen` cache
 * expires and re-resolves at the quiescent check — exercising the Phase-B #4 bounded-staleness re-resolve
 * (gap #4): after a compaction commits a new generation, a reader must re-resolve forward rather than serve
 * the old generation forever (which, with a frozen clock, would resurrect ids a `remove` had folded away).
 * Advances are a deterministic function of the batch count, so replay stays byte-identical.
 *
 * Test infrastructure — lives under `src/testing/`, never imported by the library entry point.
 */
import type { Clock } from '@cloudbitmaps/core';

export class SimClock implements Clock {
  private t = 0;

  /** Current logical time in ms (starts at 0; only changes via {@link advance}). */
  now(): number {
    return this.t;
  }

  /** Advance logical time by `ms` (the simulator steps this between batches — see the class doc). */
  advance(ms: number): void {
    this.t += ms;
  }

  /**
   * Virtual sleep: resolves on the next microtask without advancing wall-clock or scheduling a real timer,
   * so retry/backoff under the simulator is instantaneous yet still ordering-deterministic (the scheduler
   * gates at driver-call boundaries, not here). It deliberately does **not** advance {@link now} — backoff
   * latency is out of scope; only the between-batch {@link advance} moves logical time.
   */
  sleep(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * A no-op, and it must be implemented rather than left to the interface's default handling.
   *
   * `yieldNow` is optional on {@link Clock}, and a caller that finds it absent falls back to `sleep(1)` — a real
   * macrotask, which is the right thing under real wiring and the wrong thing here twice over: it would schedule
   * wall-clock timers inside a simulation that exists to have none, and it would interleave loop turns into a
   * run whose whole value is being byte-identical on replay. Yielding is a scheduling courtesy to *other* work,
   * and under the simulator there is no other work — the scheduler gates at driver-call boundaries.
   */
  yieldNow(): Promise<void> {
    return Promise.resolve();
  }
}
