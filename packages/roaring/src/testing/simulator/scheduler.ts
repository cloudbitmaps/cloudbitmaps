/**
 * Deterministic scheduler — the heart of the simulator.
 *
 * JavaScript gives us no control over microtask interleaving, but we don't need it: concurrency bugs
 * (lost updates, OCC races) surface at **driver-call boundaries**, not between arbitrary bytecodes. So the
 * fault-injecting fake drivers `await scheduler.point(label)` at the start of every operation, suspending
 * until the scheduler releases them. The scheduler then drives all suspended operations to completion in a
 * **seeded order**, producing one specific, fully reproducible interleaving per seed.
 *
 * ```text
 *   arm() ──▶ launch N concurrent ops (each suspends at its first point()) ──▶ gates registered
 *   drain(): settle microtasks → pick a gate (seeded) → release it ── repeat until none remain → disarm
 * ```
 *
 * The scheduler only gates while **armed** (between {@link arm} and the end of {@link drain}). Outside that
 * window — e.g. the sequential, contention-free oracle check after a batch — `point()` is a pass-through,
 * so the same fakes serve both phases. Arming must happen *before* the concurrent ops launch, otherwise
 * their first `point()` would slip through and the op would run to completion un-interleaved.
 *
 * Why `settle()` between releases: releasing a gate resolves a promise whose continuation (the rest of the
 * driver op + the engine logic up to its *next* driver call) runs as microtasks and may register new
 * gates. Draining all microtasks before the next seeded pick makes the set of pending gates — and thus the
 * pick — a deterministic function of the seed. The fakes do only synchronous in-memory work between gates,
 * so everything between two gates is microtasks (no stray macrotasks to miss).
 *
 * Test infrastructure — lives under `src/testing/`, never imported by the library entry point.
 */
import type { SeededRng } from './rng';

interface Gate {
  readonly label: string;
  readonly release: () => void;
}

/** Resolve after the microtask queue has fully drained (one macrotask tick). */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export class Scheduler {
  private readonly pending: Gate[] = [];
  private readonly rng: SeededRng;
  /** The release order — labels in the exact sequence the scheduler chose. The replayable trace. */
  private readonly trace: string[] = [];
  private armed = false;
  private maxPending = 0;

  constructor(rng: SeededRng) {
    this.rng = rng;
  }

  /** Begin gating. Call once *before* launching the concurrent ops of a batch. */
  arm(): void {
    if (this.armed) throw new Error('Scheduler is already armed');
    this.armed = true;
  }

  /**
   * A scheduling point a fake driver awaits at the start of an operation. While armed, it suspends until
   * the scheduler releases this gate during {@link drain}; outside a batch it is a pass-through.
   */
  point(label: string): Promise<void> {
    if (!this.armed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pending.push({ label, release: resolve });
    });
  }

  /**
   * Drive all launched (and transitively spawned) operations of the current batch to completion in seeded
   * order, then disarm. The caller launches the concurrent ops (without awaiting), calls `drain()`, then
   * awaits the ops — which are all already settled by then. Requires {@link arm} to have been called.
   */
  async drain(): Promise<void> {
    if (!this.armed) throw new Error('Scheduler.drain() requires arm() first');
    try {
      for (;;) {
        await settle(); // let all in-flight microtasks register their gates / finish
        if (this.pending.length === 0) return;
        // Track realized concurrency width: >1 means ops genuinely overlapped (a real scheduling choice).
        if (this.pending.length > this.maxPending) this.maxPending = this.pending.length;
        const index = this.rng.nextInt(this.pending.length);
        const [gate] = this.pending.splice(index, 1);
        // `gate` is always defined: index ∈ [0, length).
        this.trace.push(gate!.label);
        gate!.release();
      }
    } finally {
      this.armed = false;
    }
  }

  /** A copy of the release-order trace — identical across runs of the same seed (V16 reproducibility). */
  history(): string[] {
    return [...this.trace];
  }

  /** Number of scheduling points released so far. */
  get steps(): number {
    return this.trace.length;
  }

  /** The largest number of gates pending at once — the realized concurrency width (1 ⇒ never overlapped). */
  get maxConcurrency(): number {
    return this.maxPending;
  }
}
