/**
 * The one bounded drain of `registry.list()`.
 *
 * Three call sites wanted this — `runConsistencyCheck`, `retireExpired`, and (still unbounded) `eraseNamespace` —
 * and before this module there were two verbatim copies of the loop, two exported ceiling constants with the same
 * value and the same meaning, and two copies of the option validation. A fleet-wide enumeration is exactly the
 * place where "it drifted between callers" costs memory rather than tidiness, so it lives once.
 *
 * **Why drain at all rather than stream.** Every caller mutates rows as it goes (a CAS, a delete), and iterating a
 * live listing while doing so is driver-dependent — a DynamoDB `Scan` may or may not observe its own writes. A
 * snapshot also makes per-cycle counters and limits mean something. The cost is resident memory proportional to
 * the fleet, which is why the ceiling is not optional: at the default of 250,000 rows the snapshot is tens of MB,
 * comfortably more than the 128–256 MB Lambda the guide suggests starting with, so it fails loudly instead.
 */
import { BudgetExceededError, ValidationError } from './errors';
import { LEASE_NAMESPACE } from './lease';
import type { IRegistryDriver, RegistryRecord } from './ports';

/**
 * Ceiling on registry records one fleet-wide scan holds resident. Raise it via the caller's `maxScanSegments` when
 * the fleet really is that large *and* the memory is there; narrow the scan with a `namespace` otherwise.
 */
export const DEFAULT_MAX_SCAN_SEGMENTS = 250_000;

/** Fail fast on a bad ceiling BEFORE the (possibly huge) scan, not after. */
export function validateMaxScanSegments(value: number, op: string): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new ValidationError(`${op}: maxScanSegments must be a finite number >= 1; got ${value}`);
  }
}

/**
 * Drain every registry record (optionally one namespace) into an array, refusing past `maxScanSegments`.
 *
 * The bound is checked **before** each push, so the array never exceeds the ceiling the caller agreed to — the
 * earlier form pushed first and then threw, which meant the very row that broke the budget was already resident,
 * and a caller sizing a container against `maxScanSegments` was off by one row at the worst possible moment.
 */
export async function drainRegistry(
  registry: IRegistryDriver,
  options: { namespace?: string; maxScanSegments: number; op: string },
): Promise<RegistryRecord[]> {
  const { maxScanSegments, op } = options;
  validateMaxScanSegments(maxScanSegments, op);
  const rows: RegistryRecord[] = [];
  for await (const rec of registry.list(options.namespace)) {
    // A partition lease is not a segment. It lives in a reserved namespace with `currentGen: null`, so an
    // unscoped fleet scan would otherwise hand it to `checkConsistency` (which would report a missing Cold
    // generation), to a retention sweep, and to every fleet-wide count. Dropping it here rather than at each
    // call site is deliberate: this is the ONE drain, and a filter that has to be remembered per caller is a
    // check that cannot fire. A caller that explicitly scopes to the lease namespace still sees them.
    if (options.namespace === undefined && rec.namespace === LEASE_NAMESPACE) continue;
    if (rows.length >= maxScanSegments) {
      throw new BudgetExceededError(
        `${op} would enumerate more than ${maxScanSegments} segments — the scan was abandoned there rather than ` +
          `completed. Narrow it with \`namespace\`, or raise \`maxScanSegments\` if the fleet really is that large ` +
          `and the memory is available (a record is a few hundred bytes resident).`,
      );
    }
    rows.push(rec);
  }
  return rows;
}
