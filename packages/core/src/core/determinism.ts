/**
 * The determinism seam.
 *
 * `core/` is a pure function of its inputs + injected dependencies — it never reaches for
 * ambient time or randomness. Production wiring supplies real implementations; the deterministic
 * simulator supplies controlled, seeded ones, so any run can be replayed exactly from a seed.
 *
 * These are interfaces only (Phase 0 scaffold) — no feature code yet.
 */

/** Injected time source. `core/` must never call `Date.now()` directly. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /**
   * Resolve after at least `ms` have elapsed. The retry/backoff path's only way to wait — `core/` must
   * never reach for `setTimeout` directly (it's timer-free, lint-enforced). Production wiring supplies a
   * `setTimeout`-backed implementation; the simulator supplies a virtual-time one so a backoff schedule is
   * replayable. `ms <= 0` resolves on a microtask without scheduling a timer.
   */
  sleep(ms: number): Promise<void>;
}

/** Injected randomness. `core/` must never call `Math.random()` directly. Seedable for simulation. */
export interface Rng {
  /** A float in the half-open interval [0, 1). */
  next(): number;
}
