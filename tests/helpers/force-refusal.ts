import { vi } from 'vitest';
import { BudgetExceededError } from '@/core/errors';
import { ResidentLedger } from '@/core/combine-ledger';

/** What the ledger held, and what the refused charge asked for, at the moment a charge was made to fail. */
export interface Forced {
  readonly used: number;
  readonly asked: number;
}

/**
 * Make the `n`th charge to a resident ledger (counting every `reserve` and every `tryCharge` a caller makes, not the
 * ones `reserve` makes itself) fail, as a ledger with no room would. Returns
 * what the ledger held and the charge asked for at each refused call, so a test can hold a refusal's `spent` to `held + asked` exactly. Restore with
 * `vi.restoreAllMocks()`.
 */
/** Fill a ledger to one byte under its limit, as one with no room is (any real charge is past it), and report what it holds. */
function fill(ledger: ResidentLedger): number {
  (ledger as unknown as { held: number }).held = ledger.limit - 1;
  return ledger.used;
}

export function failNthCharge(n: number): { forced: () => Forced[]; refused: () => Forced[] } {
  let calls = 0;
  let inside = false;
  const forced: Forced[] = [];
  // Every charge that failed, the forced one and the real ones after it, as the ledger stood when each failed.
  const refused: Forced[] = [];
  const fails = (): boolean => ++calls === n;
  const reserve = ResidentLedger.prototype.reserve;
  const tryCharge = ResidentLedger.prototype.tryCharge;
  vi.spyOn(ResidentLedger.prototype, 'reserve').mockImplementation(function (
    this: ResidentLedger,
    bytes: number,
    makeRoom: (needed: number) => boolean,
  ) {
    if (bytes > 0 && fails()) {
      forced.push({ used: fill(this), asked: bytes });
      refused.push(forced[forced.length - 1]!);
      return false;
    }
    inside = true;
    try {
      const ok = reserve.call(this, bytes, makeRoom);
      if (!ok) refused.push({ used: this.used, asked: bytes });
      return ok;
    } finally {
      inside = false;
    }
  });
  vi.spyOn(ResidentLedger.prototype, 'tryCharge').mockImplementation(function (
    this: ResidentLedger,
    bytes: number,
  ) {
    if (!inside && bytes > 0 && fails()) {
      forced.push({ used: fill(this), asked: bytes });
      refused.push(forced[forced.length - 1]!);
      return false;
    }
    const ok = tryCharge.call(this, bytes);
    if (!ok && !inside) refused.push({ used: this.used, asked: bytes });
    return ok;
  });
  return { forced: () => forced, refused: () => refused };
}

/** The refusals a run produced: the outputs' errors, or the error it threw. */
export function refusalsOf(outcome: { outputs: unknown[] } | unknown): BudgetExceededError[] {
  const outputs = (outcome as { outputs?: unknown[] }).outputs;
  const errors = Array.isArray(outputs)
    ? outputs.map((o) => (o as { error?: unknown }).error)
    : [outcome];
  return errors.filter((e): e is BudgetExceededError => e instanceof BudgetExceededError);
}

/**
 * Fail each charge of a run in turn, and return the refusal matching `site` that the *last* such charge produced,
 * with what the ledger held and was asked for. A charge before the site's own fills the ledger and the site refuses
 * later, on a charge it did not fail; a charge after it never reaches the site; so the last charge that still reaches
 * the site is the site's own. `run` builds and runs a fresh call each time. Fails if no charge reaches the site.
 */
export async function reachSite(
  site: RegExp,
  run: () => Promise<unknown>,
  maxCharges = 400,
): Promise<{ error: BudgetExceededError; forced: Forced[]; refused: Forced[] }> {
  let found: { error: BudgetExceededError; forced: Forced[]; refused: Forced[] } | undefined;
  for (let n = 1; n <= maxCharges; n++) {
    const hook = failNthCharge(n);
    let outcome: unknown;
    try {
      outcome = await run();
    } catch (error) {
      outcome = error;
    } finally {
      vi.restoreAllMocks();
    }
    const forced = hook.forced();
    if (forced.length === 0) break; // fewer charges than n: every one has been tried
    const error = refusalsOf(outcome).find((e) => site.test(e.message));
    if (error !== undefined) found = { error, forced, refused: hook.refused() };
  }
  if (found === undefined) {
    throw new Error(`no failed charge reached a refusal matching ${String(site)}`);
  }
  return found;
}
