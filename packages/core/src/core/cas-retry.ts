import type { WriteConflictError } from './errors';
import { isWriteConflictError } from './errors';
import { type ChurnDeps, leaseChurn } from './leases';
import type { IRegistryDriver, RegistryRecord, SegmentRef } from './ports';

/** What `casRetry` needs: the registry, and the clock and rng that spread a wait out. */
type CasRetryDeps = ChurnDeps & { readonly registry: IRegistryDriver };

/** How many attempts a caller gets, and the error it throws once they are spent. */
interface CasRetryPlan {
  /** Attempts that count; a wait out of lease churn does not use one. */
  readonly attempts: number;
  /** The error thrown when every attempt lost. */
  readonly contention: () => WriteConflictError;
}

/**
 * Read a segment's row, run `step` on it, and run it again on a fresh read when `step` throws a write conflict.
 *
 * Every lost race uses one of `plan.attempts`, except one lost by a run that followed a wait. When the row read after a
 * lost race differs from the one `step` was given only in its leases, the loop waits the churn out (up to the churn
 * bound), reads the row again and runs `step` against that without using an attempt. A race lost on the last attempt
 * is not waited out. `step` returns the caller's result, or throws: a write conflict retries, anything else leaves
 * `casRetry` untouched.
 *
 * Exhausting `attempts` throws `plan.contention()`.
 */
export async function casRetry<T>(
  deps: CasRetryDeps,
  ref: SegmentRef,
  plan: CasRetryPlan,
  step: (row: RegistryRecord | null) => Promise<T>,
): Promise<T> {
  const churn = leaseChurn(deps);
  let lost: RegistryRecord | undefined;
  let spent = 0;
  while (spent < plan.attempts) {
    let row = await deps.registry.get(ref);
    let counted = true;
    if (lost !== undefined) {
      // Waited out first, then read again: the write is made against a row one round trip old, not one wait old.
      const settled = await churn.settle(lost, row, () => deps.registry.get(ref));
      if (settled !== undefined) {
        row = settled.row;
        counted = false;
      }
    }
    try {
      return await step(row);
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      lost = row ?? undefined;
    }
    if (counted) spent += 1;
  }
  throw plan.contention();
}
