/**
 * Per-op denial-of-wallet budget (Decision #3 / invariant T3). A read/admin op is refused
 * **before it fans out** if its projected fan-out would exceed `maxRequests` — so one runaway
 * `count`/`iterate`/`intersect`/`subjectReport`/`eraseSubject` can't drive unbounded RCU/GET cost on a shared
 * backend. The check is O(1) (a single comparison against the already-known fan-out size), so the hot path is
 * untouched. Each request's payload is separately size-capped (the safe-deserialize ceiling), so bounding the
 * fan-out count transitively bounds bytes — the budget is intentionally count-based, not a second byte
 * accumulator that would add per-chunk work.
 *
 * **What the count is.** For the read ops it is the number of Cold **chunk fetches** (`count`/`iterate`: one per
 * effective chunk; `intersect`: surviving keys × operands). For the admin scans it is the number of **segments
 * fanned out to** (`subjectReport`: one tier-merged `has()` each; `eraseSubject`: one force-compaction each) —
 * i.e. it bounds the *breadth* of the fan-out, not the request total of each segment's own compaction. That's
 * the right lever for a runaway (a million-segment sweep); it is not a byte/request meter.
 */

import { BudgetExceededError, ValidationError } from './errors';

export interface Budget {
  /** Max units of fan-out (Cold chunk fetches, or segments scanned) one op may issue before it is refused. */
  readonly maxRequests: number;
}

/**
 * Default: **on but generous** — even a full single-segment scan (≤ 65 536 chunks) or a large single-namespace
 * admin scan stays well under it; it exists to catch a true runaway (a million-segment scan, a pathological
 * intersection). Tune it down for tighter multi-tenant control, or set `budget: false` to disable.
 */
export const DEFAULT_BUDGET: Budget = { maxRequests: 1_000_000 };

/** A store/per-op budget option: partial overrides, or `false` to disable entirely. */
export type BudgetOption = Partial<Budget> | false;

/** Resolve a budget option against a fallback to a concrete `Budget`, or `null` when disabled. Validates. */
export function resolveBudget(opt: BudgetOption | undefined, fallback: Budget): Budget | null {
  if (opt === false) return null; // explicitly disabled
  const maxRequests = opt?.maxRequests ?? fallback.maxRequests;
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new ValidationError(`budget.maxRequests must be a positive integer; got ${maxRequests}`);
  }
  return { maxRequests };
}

/**
 * Resolve a **per-op** budget override against the store's own resolved budget (never the raw global default):
 * `undefined` inherits the store budget as-is (including a disabled `null`); a partial `{}` / omitted
 * `maxRequests` inherits the store's *tightening* (so a per-op passthrough of an absent config value can't
 * silently lift a tight tenant ceiling back to the generous default); `{ maxRequests }` replaces it; `false`
 * disables. Falls back to {@link DEFAULT_BUDGET} only when the store itself has no budget (disabled).
 */
export function resolvePerOpBudget(
  opt: BudgetOption | undefined,
  storeBudget: Budget | null,
): Budget | null {
  if (opt === undefined) return storeBudget;
  return resolveBudget(opt, storeBudget ?? DEFAULT_BUDGET);
}

/**
 * Refuse an op whose projected fan-out exceeds the budget. **Call before fan-out**, with the exact fan-out size
 * the op is about to issue (Cold chunk fetches, or segments to scan). O(1). No-op when `budget` is `null`
 * (disabled).
 */
export function checkBudget(budget: Budget | null, projectedRequests: number, op: string): void {
  if (budget !== null && projectedRequests > budget.maxRequests) {
    throw new BudgetExceededError(
      `${op} would fan out to ${projectedRequests} units, over the per-op budget of ` +
        `${budget.maxRequests} — raise \`budget.maxRequests\`, override it per-op, or set \`budget: false\``,
    );
  }
}
