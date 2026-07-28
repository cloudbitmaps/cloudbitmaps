/**
 * Cooperative yielding for the long CPU-bound loops.
 *
 * Everything this library does on the hot read path is small. Bulk-load is the exception: it is the one place
 * where a single call legitimately occupies the CPU for hundreds of milliseconds, and Node has exactly one thread
 * to occupy. Measured on a 1M-id load, 62,455 chunks: **442 ms wall, and 450 ms during which the event loop did
 * not turn at all**. Wire that to a request handler and every other in-flight request on the instance — health
 * checks included — waits out the whole load.
 *
 * The fix is not to make the work asynchronous. That was measured too, and it is a 7x *regression*: handing each
 * chunk's insert to the threadpool costs ~9 µs of dispatch against ~1.5 µs of actual work once ids are spread
 * across ~62,000 chunks (636 ms versus 92 ms). The work is genuinely CPU-bound and genuinely small per chunk;
 * the only thing wrong with it is that it never stops to let anyone else go. So the fix is to keep the work
 * synchronous and periodically hand the loop back.
 *
 * TWO TRAPS, both of which make a plausible implementation measure as no change at all:
 *
 * 1. **`await Promise.resolve()` — and equally `Clock.sleep(0)` — do nothing.** Both resolve on a microtask, and
 *    the microtask queue drains to empty before the event loop advances a single phase. A loop awaiting them
 *    yields to other *microtasks* and to nothing else; no pending I/O callback runs. Measured: 555 ms of
 *    starvation against a 568 ms unyielded baseline. The yield must be a **macrotask** — hence
 *    {@link Clock.yieldNow}, backed by `setImmediate` in production wiring.
 * 2. **Yielding per unit of work costs more than the work.** The yield has to be periodic, and `everyN` has to be
 *    large enough that its cost disappears into the batch it interrupts.
 *
 * At `everyN = 1024` over that same workload the trade is close to free: 569 ms wall against a 568 ms baseline,
 * with the worst event-loop gap down from 568 ms to 13.8 ms.
 */
import type { Clock } from './determinism';

/**
 * How many units of work pass between yields. Sized so the yield is unmeasurable against the batch it interrupts
 * (~60 yields across a 1M-id load) while still capping any single blocking stretch in the low tens of ms.
 */
export const YIELD_EVERY = 1024;

/**
 * Build a periodic yield.
 *
 * Call the returned function **once per unit of work**. It returns `null` on the vast majority of calls — nothing
 * to await, nothing allocated — and a promise only on the `everyN`th, so the caller pays for a yield only when
 * one actually happens:
 *
 * ```ts
 * const tick = yieldEvery(clock);
 * for (const item of millions) {
 *   work(item);
 *   const pause = tick();
 *   if (pause !== null) await pause;
 * }
 * ```
 *
 * The two-line shape is deliberate. `await tick()` would read better and would force a microtask turn on every
 * single iteration — an unconditional cost on the very loop this exists to keep fast.
 *
 * With no `clock` the result always returns `null`: the loop runs exactly as it did before this existed, so
 * adding a yield point to a code path can never change behaviour for a caller who did not opt in. `core/` cannot
 * supply a clock itself — it is timer-free by lint, which is the whole reason scheduling goes through the seam —
 * so `@cloudbitmaps/roaring` pre-binds a real one and flavor users get this with no wiring at all.
 */
export function yieldEvery(
  clock: Clock | undefined,
  everyN: number = YIELD_EVERY,
): () => Promise<void> | null {
  if (clock === undefined) return () => null;
  // A clock predating `yieldNow` still yields correctly, just at ~1 ms of dead wall-clock apiece (measured:
  // +10% on the load above). Resolved once here rather than re-tested every yield.
  const pause =
    clock.yieldNow !== undefined
      ? (): Promise<void> => clock.yieldNow!()
      : (): Promise<void> => clock.sleep(1);
  let n = 0;
  return () => {
    if (++n < everyN) return null;
    n = 0;
    return pause();
  };
}
