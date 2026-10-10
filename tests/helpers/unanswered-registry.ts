/**
 * A registry whose compare-and-swaps end without an answer, for the tests of a writer that settles such a write by
 * reading the row: the write may have landed (`'land-then-throw'`) or not (`'throw'`), and either way the writer is
 * told only `TransientError`, as a lost response or a timeout tells it.
 */
import type { Clock, Rng } from '@/core/determinism';
import { TransientError } from '@/core/errors';
import type { IRegistryDriver, RegistryPatch } from '@/core/ports';

/** What one write the plan covers does: go through, land and then fail, or fail without landing. */
export type Unanswered = 'land-then-throw' | 'throw' | 'pass';

/**
 * `registry`, answering each compare-and-swap whose patch `covers` by `plan`, in order (`'pass'` past its end), and
 * running `between` after such a write fails and before it throws. `sends` counts the writes the plan covered.
 */
export function unansweredRegistry(
  registry: IRegistryDriver,
  plan: readonly Unanswered[],
  options: {
    covers?: (patch: RegistryPatch) => boolean;
    between?: (nth: number) => Promise<void>;
  } = {},
): IRegistryDriver & { sends: number } {
  const covers = options.covers ?? ((patch: RegistryPatch) => 'currentGen' in patch);
  const out = Object.create(registry) as IRegistryDriver & { sends: number };
  out.sends = 0;
  out.compareAndSwap = async (ref, expected, patch, opts) => {
    if (!covers(patch)) return registry.compareAndSwap(ref, expected, patch, opts);
    const nth = out.sends++;
    const step = plan[nth] ?? 'pass';
    if (step === 'pass') return registry.compareAndSwap(ref, expected, patch, opts);
    if (step === 'land-then-throw') await registry.compareAndSwap(ref, expected, patch, opts);
    await options.between?.(nth);
    throw new TransientError('the registry write timed out');
  };
  return out;
}

/** A clock whose waits return at once and are recorded, and an rng that waits half of each bound. */
export function recordedWaits(): { sleeps: number[]; clock: Clock; rng: Rng } {
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => 1_700_000_000_000,
    sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()),
  };
  return { sleeps, clock, rng: { next: () => 0.5 } };
}
