/**
 * The one bounded drain of `registry.list()`.
 *
 * `runConsistencyCheck`, `retireExpired` and `eraseNamespace` drain through it.
 * One copy of the loop, the ceiling constant and the option validation keeps them from drifting apart, and a
 * fleet-wide enumeration is exactly the place where drift between callers costs memory rather than tidiness.
 *
 * **Why drain at all rather than stream.** Every caller mutates rows as it goes (a CAS, a delete), and iterating a
 * live listing while doing so is driver-dependent — a paged LIST may or may not observe its own writes. A
 * snapshot also makes per-cycle counters and limits mean something. The cost is resident memory proportional to
 * the fleet, which is why the ceiling is not optional: at the default of 250,000 rows the snapshot is tens of MB,
 * comfortably more than the 128–256 MB Lambda the guide suggests starting with, so it fails loudly instead.
 */
import { BudgetExceededError, ValidationError } from './errors';
import { isDueIndexRow } from './due-index';
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
 * The bound is checked **before** each push, so the array never exceeds the ceiling the caller agreed to. Pushing
 * first and then throwing would leave the very row that broke the budget resident, and a caller sizing a container
 * against `maxScanSegments` off by one row at the worst possible moment.
 */
export async function drainRegistry(
  registry: IRegistryDriver,
  options: {
    namespace?: string;
    maxScanSegments: number;
    op: string;
    /**
     * How a caller of `op` raises the ceiling, completing "Narrow it with `namespace`, or …" in the refusal.
     * Defaults to raising `maxScanSegments`, which is right wherever `op` takes that option itself.
     */
    raise?: string;
    /**
     * Whether the caller could scope the scan down to a `namespace`. Defaults to true; `eraseNamespace` is already
     * one namespace, so it passes false and the refusal does not tell it to narrow what it cannot.
     */
    narrowable?: boolean;
    /**
     * Told of each bookkeeping row an unscoped scan skips, which the listing has already paid to read. Only the
     * retention sweep uses it, to find the due-index pointers whose segment has no row. It is not counted against
     * `maxScanSegments`, and a caller that holds the rows it is given bounds them itself.
     */
    onReserved?: (record: RegistryRecord) => void;
  },
): Promise<RegistryRecord[]> {
  const { maxScanSegments, op } = options;
  validateMaxScanSegments(maxScanSegments, op);
  const raise = options.raise ?? 'raise `maxScanSegments`';
  const advice =
    options.narrowable === false
      ? `${raise[0]!.toUpperCase()}${raise.slice(1)} if the namespace really is that large and the memory is `
      : `Narrow it with \`namespace\`, or ${raise} if the fleet really is that large and the memory is `;
  const rows: RegistryRecord[] = [];
  for await (const rec of registry.list(options.namespace)) {
    // A due-index pointer is bookkeeping, not a segment. It lives in a reserved namespace, so an unscoped fleet
    // scan would otherwise pay a strong `get` per pointer row in `checkConsistency`, hand it to a retention
    // sweep, and inflate every fleet-wide count. A scope that names the reserved namespace never gets here: the
    // callers refuse it before they scan.
    if (options.namespace === undefined && isReservedRow(rec)) {
      options.onReserved?.(rec);
      continue;
    }
    if (rows.length >= maxScanSegments) {
      throw new BudgetExceededError(
        `${op} would enumerate more than ${maxScanSegments} segments — the scan was abandoned there rather than ` +
          `completed. ${advice}available (a record is a few hundred bytes resident).`,
      );
    }
    rows.push(rec);
  }
  return rows;
}

/**
 * Is this record **bookkeeping** rather than a segment? Covers every reserved family — today the due-index
 * pointers. **Every unscoped fleet-wide enumeration must skip these**: the bounded drain,
 * the export/eject scan, and the all-namespaces GDPR paths.
 *
 * This is the ONE place a reserved family is declared, and a new one belongs here rather than at the call
 * sites. A comparison inlined per site is easy to miss at one of them — at `subjectReport`, the rows would consume
 * an Art. 15 request's per-op budget. A filter you have to remember at each site is a check that cannot fire.
 */
export function isReservedRow(record: Pick<RegistryRecord, 'namespace'>): boolean {
  return isDueIndexRow(record);
}

/**
 * Filter bookkeeping rows out of a registry listing **before** anything downstream pays for them. Needed where
 * the enumeration is consumed inside a budgeted collector rather than a plain loop: charging a GDPR Art. 15
 * request's per-op budget for pointer rows can refuse a subject report for a reason that has nothing to do with
 * the subject.
 */
export async function* excludingReservedRows(
  source: AsyncIterable<RegistryRecord>,
): AsyncIterable<RegistryRecord> {
  for await (const record of source) {
    if (!isReservedRow(record)) yield record;
  }
}
