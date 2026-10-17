/**
 * How hard the heavy tests work: the one place that decides.
 *
 * A handful of tests cost seconds each because they draw many property cases, drive a very large listing or
 * measure thousands of native bitmaps. On a pull request that cost is paid on every push, so by default each of them
 * runs a smaller size. A scheduled run on `main` sets `CB_TEST_STRENGTH=full`, and every one of them then runs the
 * size it always had.
 *
 *   unset                    the reduced size: what a pull request runs
 *   CB_TEST_STRENGTH=full    the full size: what the nightly lane runs; run it locally before touching one of these
 *
 * Any other value throws, the empty string and a misspelling such as `Full` included, so a variable that was meant
 * to be set but expanded to nothing cannot quietly leave a run at the reduced size.
 *
 * This file is the only reader of the variable. A test asks `heavy('name')` for its size and never looks at the
 * environment itself. Adding an entry means giving both sizes and the test file here, and a row in
 * `tests/ci/test-strength.test.ts`, which holds the full sizes to the literals the tests carried before they were
 * reduced and checks that each named file asks for its size.
 *
 * What a reduced size keeps: each was chosen so that the failure its test exists to catch still fails at it, for the
 * failures tried. For the property run counts that is not a promise about a bug that only the deepest or widest
 * shapes show; those shapes are pinned as examples that run at every strength.
 */

/**
 * The full size is what the test used before there was a switch; the reduced size is what a pull request runs; `file`
 * is the test (under `tests/`) that must ask for it with `heavy('<name>')`.
 */
export const HEAVY_SIZES = {
  /** Random selective layouts the range-cap property is tried on (a covering subset runs when reduced). */
  calibrateLargeRandomLayouts: { full: 40, reduced: 10, file: 'bench/calibrate-large.test.ts' },
  /** Cases for the one-group property. */
  combineManyOneGroupRuns: { full: 30, reduced: 8, file: 'core/combine-many.property.test.ts' },
  /** Cases for the many-groups-and-range property. */
  combineManyRangeRuns: { full: 20, reduced: 6, file: 'core/combine-many.property.test.ts' },
  /** Cases for the fed-operands property. */
  combineManyFeedRuns: { full: 60, reduced: 15, file: 'core/combine-many.feed.property.test.ts' },
  /** Cases for the fed-operands-under-a-range property. */
  combineManyFeedRangeRuns: {
    full: 30,
    reduced: 8,
    file: 'core/combine-many.feed.property.test.ts',
  },
  /** Segments created, retired and purged by the done-when sweep. */
  retentionPurgeSegments: {
    full: 10_000,
    reduced: 1_000,
    file: 'core/retention-hard-purge.test.ts',
  },
  /**
   * Rows in the listing the erase test admits exactly at the ceiling and destroys one by one. Full is the shared
   * default ceiling, with no ceiling passed. The refusal one row over that default is not sized: it runs at the
   * real default on every run.
   */
  eraseNamespaceScanRows: {
    full: 250_000,
    reduced: 25_000,
    file: 'core/erase-namespace-bounded.test.ts',
  },
  /** Native bitmaps measured per chunk cardinality, one fresh process each; only the 3,000 and 20,000 cases use it. */
  combineLedgerSamples: { full: 8_000, reduced: 4_000, file: 'core/combine-ledger.test.ts' },
  /** Ids in the largest of the sorted load's three heap tiers (the other two are a tenth and a hundredth of it). */
  sortedLoadHeapIds: {
    full: 10_000_000,
    reduced: 1_000_000,
    file: 'core/load-sorted-heap.test.ts',
  },
} as const;

export type HeavyName = keyof typeof HEAVY_SIZES;

/** Whether this run is the full-strength one. Read once, here, at import. */
export const FULL_STRENGTH: boolean = (() => {
  const raw = process.env.CB_TEST_STRENGTH;
  if (raw === undefined) return false;
  if (raw === 'full') return true;
  throw new Error(`CB_TEST_STRENGTH must be unset or "full"; got ${JSON.stringify(raw)}`);
})();

/** The size a heavy test runs at in this run. */
export function heavy(name: HeavyName): number {
  const size = HEAVY_SIZES[name];
  return FULL_STRENGTH ? size.full : size.reduced;
}
