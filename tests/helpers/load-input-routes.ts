/**
 * Which test files run a second time with their id loads handed to core's load as `{ serialized }`.
 *
 * `vitest.config.ts` builds its `serialized` project from {@link ROUTED}, and `tests/arch/load-input-coverage.test.ts`
 * holds both lists to the tree: every test file matching {@link LOAD_CALL} is on exactly one of them.
 */

/** What makes a test file a load test: it calls a store's or a fixture's load, core's load, or an `*Into` verb. */
export const LOAD_CALL = /\.load\(|\bloadSegment\(|\b(?:intersect|union|andNot)Into\(/;

/** The vitest project that routes id loads through `{ serialized }`. */
export const ROUTED_PROJECT = 'serialized';

/** The setup file that does the routing. */
export const ROUTING_SETUP = 'tests/setup-load-via-serialized.ts';

/** Run under ids and again under `{ serialized }`. */
export const ROUTED: readonly string[] = [
  'tests/bench/calibrate-guards.test.ts',
  'tests/bench/calibrate-samples.test.ts',
  'tests/bench/calibrate-stages.test.ts',
  'tests/core/cold-count-one-request.test.ts',
  'tests/core/row-summary-trust.test.ts',
  'tests/core/read-path-review.test.ts',
  'tests/core/read-path-sequences.property.test.ts',
  'tests/core/collect-by-name.test.ts',
  'tests/core/consistency-summary.test.ts',
  'tests/core/cost.test.ts',
  'tests/core/drop-segment.test.ts',
  'tests/core/due-index-fast-sweep.test.ts',
  'tests/core/encrypted-segment-cleartext-object.test.ts',
  'tests/core/encryption-lifecycle.test.ts',
  'tests/core/engine-metrics.test.ts',
  'tests/core/erase-carries-metadata.test.ts',
  'tests/core/erase-id.test.ts',
  'tests/core/erase-not-in-current-awaited.test.ts',
  'tests/core/erase-swept-generation.test.ts',
  'tests/core/expired-exclusion.test.ts',
  'tests/core/generation-gc.test.ts',
  'tests/core/generation-metadata-read.test.ts',
  'tests/core/generation-metadata-write.test.ts',
  'tests/core/intersect.test.ts',
  'tests/core/live-read-reused-number.test.ts',
  'tests/core/load-guard-summary.test.ts',
  'tests/core/load-routing.test.ts',
  'tests/core/load.test.ts',
  'tests/core/materialize-expiry-guard.test.ts',
  'tests/core/materialize-load-guard.test.ts',
  'tests/core/null-generation-row.test.ts',
  'tests/core/option-groups.test.ts',
  'tests/core/pin-at.test.ts',
  'tests/core/pin-chunk-cache.test.ts',
  'tests/core/publish-absence-fence.test.ts',
  'tests/core/publish-fences.test.ts',
  'tests/core/publish-reconcile.test.ts',
  'tests/core/range-read.test.ts',
  'tests/core/reserved-namespace.test.ts',
  'tests/core/retention-hard-purge.test.ts',
  'tests/core/retention-policy.test.ts',
  'tests/core/retention-sweep.test.ts',
  'tests/core/rollback-metadata.test.ts',
  'tests/core/rollback.test.ts',
  'tests/core/segment-discovery.test.ts',
  'tests/core/storage-source-heal-open.test.ts',
  'tests/core/subject-erasure.test.ts',
  'tests/core/summary-lifecycle.test.ts',
  'tests/core/summary-localfs.test.ts',
  'tests/core/kept-generations-legacy.test.ts',
  'tests/core/lease-churn.test.ts',
  'tests/core/leases.test.ts',
  'tests/core/pin-lease.property.test.ts',
  'tests/core/kept-generations.property.test.ts',
  'tests/core/summary-sequences.property.test.ts',
  'tests/core/subject-report-fresh.test.ts',
  'tests/core/union-andnot.test.ts',
  'tests/core/write-path-read-retry.test.ts',
  'tests/drivers/azure/read-timeout.test.ts',
  'tests/drivers/azure/throttled-write.test.ts',
  'tests/drivers/gcs/throttled-write.test.ts',
  'tests/drivers/s3/read-timeout.test.ts',
  'tests/drivers/s3/throttled-write.test.ts',
  'tests/engine.property.test.ts',
  'tests/flows.test.ts',
  'tests/roaring/id-stream-batches.test.ts',
  'tests/roaring/pin-lease.races.test.ts',
  'tests/roaring/pin-lease.test.ts',
  'tests/roaring/segment-handle.test.ts',
  'tests/roaring/store-load-binding.test.ts',
];

/** Run under ids only, each with the reason routing would change what the file tests. */
export const IDS_ONLY: Readonly<Record<string, string>> = {
  'tests/core/load-chunk-input.test.ts':
    "loads a combine's chunks, an input of its own that a serialized rerouting of ids does not reach; the ids it passes are " +
    'only the reference the chunk load is compared against, so a second run under the serialized input would exercise nothing new',
  'tests/roaring/into-chunk-route.test.ts':
    "compares the *Into verbs against the same call by the id route through the store's own materialisation, and builds its " +
    'operands from bitmaps; a second run under the serialized input would repeat the comparison and test no part of the load path',
  'tests/core/erase-coalesced-reads.test.ts':
    'its loads only seed fixtures for the erasure read path, whose range requests it counts; a second run under ' +
    'the serialized input would repeat those counts and exercise no part of the load path',
  'tests/core/stream-re-resolve.test.ts':
    'its loads build the segments a read starts from, and its one store.load is the trigger the read is held against, not ' +
    'the behaviour under test; a second run under the serialized input would repeat the reads and exercise no part of the ' +
    'load path',
  'tests/core/streamed-real-source.test.ts':
    'counts the range requests of reads over segments of chunks it lays out itself; the load only builds them, so a ' +
    'second run under the serialized input would repeat the counts and exercise no part of the load path',
  'tests/core/coalesced-request-counts.test.ts':
    'counts the storage requests of reads over segments of chunks it lays out itself; the load only builds them, so a ' +
    'second run under the serialized input would repeat the counts and exercise no part of the load path',
  'tests/drivers/gcs/read-timeout.test.ts':
    'a GCS driver test: its one load builds a fixture generation in a memory store for the stub server to serve, ' +
    'so a second run under the serialized input would exercise no part of the load path',
  'tests/drivers/_shared/registry-fleet.test.ts':
    "tests the registry drivers' tokens and stamps; its three loads only seed rows for those checks, so a second " +
    'run under the serialized input would repeat 72 registry tests and exercise no part of the load path',
  'tests/bench/calibration-figures-store-load.test.ts':
    'names store.load() only in the prose and strings it checks, and loads nothing, so there is nothing to route',
  'tests/docs/calibration-reports.test.ts':
    'names store.load() only in the prose and strings it checks, and loads nothing, so there is nothing to route',
  'tests/docs/retired-names.test.ts':
    'names store.load() only in the prose and strings it checks, and loads nothing, so there is nothing to route',
  'tests/docs/superseded-behaviour-claims.test.ts':
    'names store.load() only in the prose and strings it checks, and loads nothing, so there is nothing to route',
  'tests/core/bulk-load-cooperative.test.ts':
    'counts the yields of the id ingest and per-chunk flush loops, which a bitmap input never runs; the ' +
    "bitmap path's own yields, the writer's every 1,024 chunks, are tested in roaring/load-no-per-id.test.ts",
  'tests/core/load-row-reuse.test.ts':
    'injects its races from inside the id stream (a row write while the ids are read), which routing drains ' +
    'before the load reads the row, so the race would land before the load starts',
  'tests/core/load-overlap.test.ts':
    'observes the requests a load has sent when its ids are first pulled, and injects a race from inside the id ' +
    'stream, which routing drains before the load reads the row, so neither would be seen at the point it measures',
  'tests/core/load-held-version.test.ts':
    'injects its races from inside the id stream (another process writes the row while the ids are read), which ' +
    'routing drains before the load reads the row, so the race would land before the load starts',
  'tests/core/load-numbering.test.ts':
    'injects its race from inside the id stream (an object written while the ids are read), which routing ' +
    'drains before the load numbers its generation, so the race would land before the load starts',
  'tests/core/metadata-validation.test.ts':
    'asserts that a refused load makes no request at all, the combine of an *Into verb reading its operands included, ' +
    "and that metadata is copied as of the call while the load reads its ids; routing drains the ids, and so the operands' " +
    'reads, before the load validates anything, and before the object is written, so neither could hold. The bytes ' +
    'inputs are in the file already',
  'tests/core/load-input.test.ts':
    'tests the inputs themselves (the byte-array refusal, malformed bytes, the wrappers), so converting its ids ' +
    'would test the conversion instead',
  'tests/roaring/load-bitmap.test.ts':
    'compares ids, { bitmap }, { serialized } and a bare bitmap against the golden itself; routing its id loads ' +
    'would make the ids side of each comparison a bitmap load too',
  'tests/roaring/load-no-per-id.test.ts':
    'loads bitmaps on purpose and counts every per-id route while it does; a routed id load is a bitmap load, ' +
    'which would make its control count nothing',
  'tests/roaring/load-bitmap.property.test.ts':
    'compares the id load of each set with its bitmap loads; routing would compare the bitmap path with itself',
  'tests/roaring/deserialize-portable.test.ts':
    'tests the decoder against what a load of the same bytes refuses, with `{ serialized }` given on purpose; ' +
    'routing would convert nothing it loads',
  'tests/roaring/load-parts.property.test.ts':
    'compares the id load of each set with the loads of its parts as bitmaps, and counts their requests against a ' +
    'single id load; routing would compare the bitmap path with itself',
  'tests/export/export-pinned.test.ts':
    'its loads seed the generations an export reads and the loads that publish or collect meanwhile; the behaviour under ' +
    "test is the export's pin, so a second run under the serialized input would repeat it and exercise no part of the " +
    'load path',
};
