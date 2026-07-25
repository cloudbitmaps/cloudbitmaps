/**
 * Seeded pseudo-random generator for the deterministic simulator.
 *
 * Implements the `core/` {@link Rng} seam (a Phase-0 scaffold the engine does not yet consume — randomness
 * isn't on any current core path). Here it deterministically drives the *harness*: op generation, the
 * scheduler's gate picks, and fault injection. Every simulator run is a pure function of its `seed`: same
 * seed → byte-identical stream → byte-identical interleaving → replayable failures (finding V16).
 *
 * The algorithm is **mulberry32** — a tiny, well-distributed 32-bit generator. We don't need
 * cryptographic quality here, only determinism and a decent spread; mulberry32 is the standard choice for
 * exactly this (reproducible test/sim seeding) and needs no dependency.
 *
 * Test infrastructure — lives under `src/testing/`, never imported by the library entry point.
 */
import type { Rng } from '@cloudbitmaps/core';

const UINT32 = 0x1_0000_0000;

/** A seedable {@link Rng} plus the integer/choice helpers the scheduler and op-generator need. */
export class SeededRng implements Rng {
  private state: number;

  /** `seed` is coerced to a u32; the same seed always yields the same stream. */
  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new TypeError(`seed must be an integer; got ${seed}`);
    }
    // >>> 0 normalizes negatives/large ints into the u32 range deterministically.
    this.state = seed >>> 0;
  }

  /** A float in [0, 1) — the {@link Rng} contract. */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  }

  /** A non-negative integer in `[0, bound)`. `bound` must be a positive integer. */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new RangeError(`bound must be a positive integer; got ${bound}`);
    }
    return Math.floor(this.next() * bound);
  }

  /** `true` with probability `p`. `p <= 0` is never true; `p >= 1` is always true. */
  bool(p: number): boolean {
    return this.next() < p;
  }

  /** Pick one element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('cannot pick from an empty array');
    return items[this.nextInt(items.length)] as T;
  }
}
