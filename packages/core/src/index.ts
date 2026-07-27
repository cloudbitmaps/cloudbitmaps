/**
 * `@cloudbitmaps/core` — the codec-agnostic cloud engine behind the @cloudbitmaps family.
 *
 * Everything here is **independent of any bitmap codec**: the tiered engine, every storage driver, the `.crbm`
 * format, crash-safe compaction, encryption/crypto-shred, the registry, the budget/consistency/eject machinery.
 * Bitmaps are only ever constructed and combined through the {@link CodecInterface} seam, so a *flavor* package
 * (`@cloudbitmaps/roaring` today; `@cloudbitmaps/bitmap` next) supplies the codec and a facade on top.
 *
 * **You normally install a flavor, not this package** — `npm i @cloudbitmaps/roaring` pulls this in
 * transitively and re-exports it, so `@cloudbitmaps/roaring` is the one name to know. Depend on `core`
 * directly only when authoring a new flavor or a driver.
 *
 * Nothing in here may import a flavor package — the dependency arrow is one-way (flavor → core), so core stays
 * publishable on its own and every codec reuses one driver set with zero duplication.
 */

// ---------------------------------------------------------------------------------------------------
// The flavor-author kit: the pieces a facade (codec + store wrapper) composes. These are *not* what an
// application calls — an app uses the flavor's `CloudRoaring` facade — but a flavor/driver author needs them,
// which is precisely core's audience.
// ---------------------------------------------------------------------------------------------------
export { SegmentEngine } from './core/engine';
export { DEFAULT_MAX_WARM_SCAN_BYTES } from './core/engine';
export type { EngineDeps } from './core/engine';
export { BoundedLru } from './core/lru';
export { safeMetrics } from './core/metrics';
export { groundedReport } from './core/cost';
export { validateCompactionOptions } from './core/compaction';
export { runExport } from './export';
export { splitId, joinId } from './core/bit-route';
export { mapWithConcurrency } from './core/concurrency';
export { resolveBudget, resolvePerOpBudget, checkBudget, collectWithinBudget } from './core/budget';
export { validateSegmentRef } from './core/validate';
// Driver-kit: the sentinel + row/token shapes you need to IMPLEMENT a warm driver (and the key helper the
// conformance/simulator fakes use). `NO_ROW` in particular is the create-if-absent sentinel every `IWarmDriver`
// must compare against — it is a `Symbol.for` registry symbol so it stays identical across bundles.
export { NO_ROW } from './core/ports';
export type { NoRow, Token, WarmRow, WarmReadOptions } from './core/ports';
export { chunkRefKey, segmentKey } from './core/keys';

// ---------------------------------------------------------------------------------------------------
// The public surface (an application reaches these through its flavor package, which re-exports them).
// ---------------------------------------------------------------------------------------------------
export {
  MemoryWarmDriver,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
} from './drivers/memory';
export type { MemoryRegistryDriverOptions } from './drivers/memory';
export { LocalFsColdDriver } from './drivers/localfs/cold';
export { LocalFsWarmDriver } from './drivers/localfs/warm';
export { LocalFsRegistryDriver } from './drivers/localfs/registry';
export type { LocalFsRegistryDriverOptions } from './drivers/localfs/registry';
export {
  CrbmColdChunkSource,
  writeCrbmGeneration,
  bulkLoadCrbmGeneration,
  publishGeneration,
} from './core/crbm-cold-source';
export type { BulkLoadResult, CrbmColdChunkSourceOptions } from './core/crbm-cold-source';

// Compaction (Phase 4d): the crash-safe 2-phase-commit daemon. Composes IColdDriver + IWarmDriver +
// IRegistryDriver; the `bin/compact-segments` CLI is a thin wrapper over these.
export {
  compactSegment,
  gcOrphanGenerations,
  findCompactable,
  runCompactionCycle,
} from './core/compaction';
export type {
  CompactionDeps,
  CompactionOptions,
  CompactionResult,
  CompactionCycleResult,
  DiscoveryOptions,
  CompactionCandidate,
} from './core/compaction';
// The bitmap-codec seam — the engine is codec-agnostic behind these; roaring is the flagship.
export type { CodecInterface, CodecBitmap } from './core/codec';
export type { Clock, Rng } from './core/determinism';
export type {
  ColdChunkSource,
  IWarmDriver,
  IColdDriver,
  ColdCaps,
  ChunkRef,
  SegmentRef,
  GenKey,
  IRegistryDriver,
  RegistryRecord,
  NewRegistryRecord,
  RegistryPatch,
  RegistryStatus,
  RegCaps,
  GovernanceMeta,
  SegmentSize,
} from './core/ports';
export {
  CloudRoaringError,
  ValidationError,
  WriteConflictError,
  IntegrityError,
  NotFoundError,
  UnsupportedError,
  CapabilityError,
  TransientError,
  TimeoutError,
  KeyUnavailableError,
  BudgetExceededError,
  // Bundle-safe predicates — prefer these over `instanceof` when catching errors that cross the core↔driver
  // (`./s3` / `./dynamodb`) boundary, where a per-bundle class copy makes `instanceof` unreliable in CJS.
  isCloudRoaringError,
  isWriteConflictError,
  isTransientError,
  isNotFoundError,
  isIntegrityError,
  isValidationError,
} from './core/errors';

// Encryption-at-rest (Phase 4e): the injected crypto seams (`core/`, crypto-free) + the default in-process
// AES-256-GCM implementation (`node:crypto`, outside core). KMS/Vault adapters are future optional packages
// against `IKeystore`. See the getting-started "Encryption" section for key-management guidance.
export type { Aead, AeadSealed, IKeystore, WrappedDek, CrbmCrypto } from './core/crypto';
export { aadFor } from './core/crypto';
export { NodeAead, InProcessKeystore } from './drivers/crypto';
export type { InProcessKeystoreOptions } from './drivers/crypto';

// Crypto-shred erasure (Phase 4e): delete a segment's key → its encrypted Cold bytes are unrecoverable.
export { destroySegment, eraseNamespace } from './core/erasure';
export type { EraseDeps, DestroyResult } from './core/erasure';

// Denial-of-wallet budget (Phase F, 07 Decision #3 / T3): per-op request ceiling → `BudgetExceededError`.
export { DEFAULT_BUDGET } from './core/budget';
export type { Budget, BudgetOption } from './core/budget';

// Cross-tier DR consistency check (Phase F, gap #11): `store.checkConsistency()` (or the free function over your
// own cold + registry drivers) detects a torn restore where `currentGen` points at a `.crbm` that isn't present.
export { runConsistencyCheck } from './core/consistency';
export { DEFAULT_MAX_CHECK_SEGMENTS } from './core/consistency';
export type {
  ConsistencyReport,
  ConsistencyIssue,
  ConsistencyErrorEntry,
} from './core/consistency';

// Segment export / "eject" (data portability): `store.exportSegments(sink, { format })` dumps every registered
// segment to a portable file (`roaring` = cross-language RoaringBitmap32 · `ndjson` = newline ids) via an
// injected sink, using only public read APIs — your data stays readable without CloudRoaring. The
// `export-segments` CLI wraps it with a filesystem sink. These types let you write a custom sink (S3, stdout, …).
export type {
  ExportFormat,
  ExportSink,
  ExportWriter,
  ExportOptions,
  ExportedSegment,
  ExportFailure,
  ExportManifest,
} from './export';

// Resilience (Phase 4b): the retry primitive + decorators + policy. `CloudRoaring` wires these by default;
// they're exported so driver authors / advanced callers can wrap their own drivers or tune the policy.
export { withRetry, isTransient, DEFAULT_RETRY_POLICY, DEFAULT_OCC_BACKOFF } from './core/retry';
export type { RetryPolicy, RetryDeps } from './core/retry';
export {
  RetryingWarmDriver,
  RetryingColdChunkSource,
  RetryingColdDriver,
  RetryingRegistryDriver,
} from './drivers/retry/retrying-drivers';
export type { RetryingOptions } from './drivers/retry/retrying-drivers';

// `.crbm` archive format — the on-disk Cold layout. Exposed for driver authors and tooling.
export { CrbmWriter } from './core/crbm/writer';
export type { CrbmWriterOptions } from './core/crbm/writer';
export { CrbmReader } from './core/crbm/reader';
export type { CrbmReaderOptions } from './core/crbm/reader';
export { BufferSink, BufferReader } from './core/blob';
export type { BlobReader, BlobSink } from './core/blob';

// Observability (Phase 5a): the injected metrics seam + a no-op default + a counting sink. Emit typed
// events (cold/warm/cache/retry/intersect/op) to your stack; see the getting-started "Observability" section.
export { NOOP_METRICS, CountingMetricsSink } from './core/metrics';
export type { IMetricsSink, MetricEvent, MetricOpName, MetricsSnapshot } from './core/metrics';

// Cost model & estimator (Phase 5b): pure `estimateCost` planning + grounded `segment.costReport()`; the
// pluggable pricing profile + the honest `CostReport` verdict (never hides the lose-zone).
export { estimateCost, DEFAULT_PRICING, AWS_US_EAST_1_ONDEMAND } from './core/cost';
export type {
  PricingProfile,
  CostReport,
  CostAdvisory,
  Workload,
  SegmentSizing,
  EstimateInput,
  Topology,
} from './core/cost';

// Audit trail (Phase 5d): a separate injected seam for security/compliance state changes (publish/compact/
// erase) — distinct from metrics. Pass `audit` to the compaction/bulk-load/erasure APIs; see the dashboards
// guide. Exception-safe; the default records nothing.
export { NOOP_AUDIT, RecordingAuditSink } from './core/audit';
export type { IAuditSink, AuditEvent, AuditEventKind } from './core/audit';
