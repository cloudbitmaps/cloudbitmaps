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
export function failNthCharge(n: number): { forced: () => Forced[] } {
  let calls = 0;
  let inside = false;
  const forced: Forced[] = [];
  const fails = (): boolean => ++calls === n;
  const reserve = ResidentLedger.prototype.reserve;
  const tryCharge = ResidentLedger.prototype.tryCharge;
  vi.spyOn(ResidentLedger.prototype, 'reserve').mockImplementation(function (
    this: ResidentLedger,
    bytes: number,
    makeRoom: (needed: number) => boolean,
  ) {
    if (fails()) {
      forced.push({ used: this.used, asked: bytes });
      return false;
    }
    inside = true;
    try {
      return reserve.call(this, bytes, makeRoom);
    } finally {
      inside = false;
    }
  });
  vi.spyOn(ResidentLedger.prototype, 'tryCharge').mockImplementation(function (
    this: ResidentLedger,
    bytes: number,
  ) {
    if (!inside && fails()) {
      forced.push({ used: this.used, asked: bytes });
      return false;
    }
    return tryCharge.call(this, bytes);
  });
  return { forced: () => forced };
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
 * Fail each charge of a run in turn until one produces a refusal whose message matches `site`, and return it with what
 * the ledger held and was asked for. `run` builds and runs a fresh call each time. Fails if no charge reaches the site.
 */
export async function reachSite(
  site: RegExp,
  run: () => Promise<unknown>,
  maxCharges = 400,
): Promise<{ error: BudgetExceededError; forced: Forced[] }> {
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
    if (error !== undefined) return { error, forced };
  }
  throw new Error(`no failed charge reached a refusal matching ${String(site)}`);
}
