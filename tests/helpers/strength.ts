/**
 * How hard the heavy tests work: the one place that decides.
 *
 * A handful of tests cost seconds each because they draw many property cases, drive a very large registry or
 * measure thousands of native bitmaps. On a pull request that cost is paid on every push, so by default each of them
 * runs a smaller size that still trips the failure it exists to catch. A scheduled run on `main` sets
 * `CB_TEST_STRENGTH=full`, and every one of them then runs the size it always had.
 *
 *   unset (or empty)         the reduced size: what a pull request runs
 *   CB_TEST_STRENGTH=full    the full size: what the nightly lane runs; run it locally before touching one of these
 *
 * Any other value throws, so a misspelt `full` cannot quietly leave a run at the reduced size.
 *
 * This file is the only reader of the variable. A test asks `heavy('name')` for its size and never looks at the
 * environment itself. Adding an entry means giving both sizes here, and `tests/ci/test-strength.test.ts` holds the
 * full sizes to the literals the tests carried before this switch existed.
 */

/** The full size is what the test used before there was a switch; the reduced size is what a pull request runs. */
export const HEAVY_SIZES = {
  /** `tests/bench/calibrate-large.test.ts`: random selective layouts the range-cap property is tried on. */
  calibrateLargeRandomLayouts: { full: 40, reduced: 10 },
  /** `tests/core/combine-many.property.test.ts`: cases for the one-group property. */
  combineManyOneGroupRuns: { full: 30, reduced: 8 },
  /** `tests/core/combine-many.property.test.ts`: cases for the many-groups-and-range property. */
  combineManyRangeRuns: { full: 20, reduced: 6 },
  /** `tests/core/combine-many.feed.property.test.ts`: cases for the fed-operands property. */
  combineManyFeedRuns: { full: 60, reduced: 15 },
  /** `tests/core/combine-many.feed.property.test.ts`: cases for the fed-operands-under-a-range property. */
  combineManyFeedRangeRuns: { full: 30, reduced: 8 },
  /** `tests/core/retention-hard-purge.test.ts`: segments created, retired and purged by the done-when sweep. */
  retentionPurgeSegments: { full: 10_000, reduced: 1_000 },
  /** `tests/core/erase-namespace-bounded.test.ts`: rows a namespace listing is held to (the shared default ceiling). */
  eraseNamespaceScanRows: { full: 250_000, reduced: 25_000 },
  /** `tests/core/combine-ledger.test.ts`: native bitmaps measured per chunk cardinality, in a fresh process each. */
  combineLedgerSamples: { full: 8_000, reduced: 4_000 },
} as const;

export type HeavyName = keyof typeof HEAVY_SIZES;

/** Whether this run is the full-strength one. Read once, here, at import. */
export const FULL_STRENGTH: boolean = (() => {
  const raw = process.env.CB_TEST_STRENGTH;
  if (raw === undefined || raw === '') return false;
  if (raw === 'full') return true;
  throw new Error(`CB_TEST_STRENGTH must be unset or "full"; got ${JSON.stringify(raw)}`);
})();

/** The size a heavy test runs at in this run. */
export function heavy(name: HeavyName): number {
  const size = HEAVY_SIZES[name];
  return FULL_STRENGTH ? size.full : size.reduced;
}
