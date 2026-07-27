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
  /**
   * Hand the event loop back once, without asking for any elapsed time.
   *
   * This is **not** `sleep(0)`, and the difference is the reason the member exists. `sleep(0)` resolves on a
   * microtask, and microtasks drain before the loop advances a phase — so awaiting it inside a CPU-bound loop
   * yields to nothing at all, and a co-resident server stays blocked for the loop's full duration. A real yield
   * needs a macrotask. `sleep(1)` is one, but it buys the relief at ~1 ms of dead wall-clock per yield.
   *
   * **Optional**, so every `Clock` written before this member still satisfies the interface. Callers must
   * therefore degrade rather than assume: `clock.yieldNow?.() ?? clock.sleep(1)` — correct on any clock, cheap
   * on one that implements this. `core/` cannot supply it itself (it is timer-free, lint-enforced); production
   * wiring backs it with `setImmediate`, and a simulator can make it a no-op so virtual time is not perturbed
   * by what is purely a scheduling courtesy.
   */
  yieldNow?(): Promise<void>;
}

/** Injected randomness. `core/` must never call `Math.random()` directly. Seedable for simulation. */
export interface Rng {
  /** A float in the half-open interval [0, 1). */
  next(): number;
}
