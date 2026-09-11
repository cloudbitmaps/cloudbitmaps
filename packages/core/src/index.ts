/**
 * `@cloudbitmaps/core` — the codec-agnostic cloud engine behind the @cloudbitmaps family.
 *
 * Everything here is **independent of any bitmap codec**: the read engine, every storage driver, the `.crbm`
 * format, the loaded store's write path (bulk load + forward-only publish), encryption/crypto-shred, the registry,
 * the budget/consistency/eject machinery. Bitmaps are only ever constructed and combined through the
 * {@link CodecInterface} seam, so a *flavor* package (`@cloudbitmaps/roaring` today) supplies the codec and a
 * facade on top.
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
export type { EngineDeps, CombineOptions as EngineCombineOptions } from './core/engine';
export { BoundedLru } from './core/lru';
export { safeMetrics } from './core/metrics';
export { groundedReport } from './core/cost';
export { runExport } from './export';
export { splitId, joinId } from './core/bit-route';
export { mapWithConcurrency } from './core/concurrency';
export { resolveBudget, resolvePerOpBudget, checkBudget, collectWithinBudget } from './core/budget';
export { validateSegmentRef } from './core/validate';
// Driver-kit: the token shape a registry driver needs, and the key helpers the conformance fakes use.
export type { Token } from './core/ports';
export { chunkRefKey, segmentKey } from './core/keys';

// ---------------------------------------------------------------------------------------------------
// The public surface (an application reaches these through its flavor package, which re-exports them).
// ---------------------------------------------------------------------------------------------------
export { MemoryColdChunkSource, MemoryColdDriver, MemoryRegistryDriver } from './drivers/memory';
export type { MemoryRegistryDriverOptions } from './drivers/memory';
export { LocalFsColdDriver } from './drivers/localfs/cold';
export { LocalFsRegistryDriver } from './drivers/localfs/registry';
export type { LocalFsRegistryDriverOptions } from './drivers/localfs/registry';
// The loaded store's write path: build one immutable generation from ids (bulk-load), or from pre-grouped
// bitmaps, then make it current (publish). Every write in the library is one of these.
export {
  CrbmColdChunkSource,
  writeCrbmGeneration,
  bulkLoadCrbmGeneration,
  publishGeneration,
} from './core/crbm-cold-source';
export type { BulkLoadResult, CrbmColdChunkSourceOptions } from './core/crbm-cold-source';
// Generation bookkeeping: the next generation number for a segment, and collection of superseded generations.
// Nothing here schedules itself — the retention sweep and the erasure rewrite call `gcOrphanGenerations`; a
// caller writing generations by hand collects on its own cadence.
export { gcOrphanGenerations, nextGeneration } from './core/generation-gc';
export type { GenerationDeps } from './core/generation-gc';
// Subject erasure on a loaded segment: rewrite the current generation without one id, publish fenced on it,
// collect the superseded generation. `store.eraseSubject` runs it over every registered segment.
export { eraseIdFromSegment } from './core/erase-id';
export type { EraseIdDeps, EraseIdResult } from './core/erase-id';
// The bitmap-codec seam — the engine is codec-agnostic behind these; roaring is the flagship.
export type { CodecInterface, CodecBitmap } from './core/codec';
export type { Clock, Rng } from './core/determinism';
export type {
  ColdChunkSource,
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

// Encryption-at-rest: the injected crypto seams (`core/`, crypto-free) + the default in-process AES-256-GCM
// implementation (`node:crypto`, outside core). KMS/Vault adapters are future optional packages against
// `IKeystore`. See the getting-started "Encryption" section for key-management guidance.
export type { Aead, AeadSealed, IKeystore, WrappedDek, CrbmCrypto } from './core/crypto';
export { aadFor } from './core/crypto';
export { NodeAead, InProcessKeystore } from './drivers/crypto';
export type { InProcessKeystoreOptions } from './drivers/crypto';

// Crypto-shred erasure: delete a segment's key → its encrypted Cold bytes are unrecoverable. `dropSegment` is
// the operational sibling: it deletes the objects, so it works on cleartext and actually reclaims the storage —
// where crypto-shred makes bytes unreadable but leaves them billed.
export { destroySegment, dropSegment, eraseNamespace } from './core/erasure';
export type { DropDeps, DropResult, EraseDeps, DestroyResult } from './core/erasure';

// Retention policy: record WHEN a segment becomes eligible for retirement. Writer-set absolute epoch-ms — a
// duration the library derived would be anchored to `updatedAt`/`currentGen`, which every load republishes, so a
// busy segment would never expire. Nothing here runs on a timer; the sweep is a separate call the operator
// schedules (see the getting-started "Retention" section for where to run it).
// `readRetentionPolicy` is exported because a caller running their own `list()` sweep needs to parse a policy out
// of a row they already hold. `validateRetentionPolicy` deliberately is NOT: `setRetention` validates on the way
// in, so nothing outside needs the raw validator, and public surface is the hardest kind of decision to reverse.
export {
  setSegmentRetention,
  clearSegmentRetention,
  getSegmentRetention,
  readRetentionPolicy,
  MIN_EXPIRES_AT_MS,
} from './core/retention';
export type { RetentionPolicy, RetentionDeps, SetRetentionResult } from './core/retention';

// The retention sweep: retire every segment whose policy expired, by delegating to `dropSegment` (the registry →
// Cold ordering is load-bearing and lives there). A call, never a daemon — the operator owns the heartbeat that
// runs it.
export {
  retireExpired,
  DEFAULT_RETIRE_LIMIT,
  DEFAULT_TOMBSTONE_GRACE_MS,
  DEFAULT_LOOKBACK_BUCKETS,
} from './core/retention-sweep';
// The one bounded drain of `registry.list()`, shared by the consistency scan and the retention sweep — exported
// because a caller writing their own fleet-wide admin pass needs the same ceiling rather than a third copy.
export {
  drainRegistry,
  validateMaxScanSegments,
  isReservedRow,
  excludingReservedRows,
} from './core/registry-scan';

// The due index — a time-bucketed set of the segments that carry an expiry, so a retention cycle costs what is
// EXPIRING rather than what the fleet HOLDS. Built out of registry rows (no driver change); a fast path only,
// with the full scan demoted to a periodic repair pass, so a stale or missing pointer can never lose data.
export {
  dueBucket,
  dueBucketsAt,
  dueNamespace,
  dueIndexRef,
  encodeDueName,
  decodeDueName,
  canIndex,
  isDueIndexRow,
  DUE_NAMESPACE_PREFIX,
  DUE_BUCKET_MS,
  MAX_NAME_LENGTH,
} from './core/due-index';
export type {
  RetireExpiredOptions,
  RetireExpiredResult,
  RetireEntry,
} from './core/retention-sweep';

// Denial-of-wallet budget: per-op request ceiling → `BudgetExceededError`.
export { DEFAULT_BUDGET } from './core/budget';
export type { Budget, BudgetOption } from './core/budget';

// Cross-tier DR consistency check: `store.checkConsistency()` (or the free function over your own cold +
// registry drivers) detects a torn restore where `currentGen` points at a `.crbm` that isn't present.
export { runConsistencyCheck } from './core/consistency';
export { DEFAULT_MAX_SCAN_SEGMENTS } from './core/consistency';
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

// Resilience: the retry primitive + decorators + policy. `CloudRoaring` wires these by default; they're exported
// so driver authors / advanced callers can wrap their own drivers or tune the policy.
export { withRetry, isTransient, DEFAULT_RETRY_POLICY } from './core/retry';
export type { RetryPolicy, RetryDeps } from './core/retry';
export {
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

// Observability: the injected metrics seam + a no-op default + a counting sink. Emit typed events
// (cold/cache/retry/intersect/op) to your stack; see the getting-started "Observability" section.
export { NOOP_METRICS, CountingMetricsSink } from './core/metrics';
export type { IMetricsSink, MetricEvent, MetricOpName, MetricsSnapshot } from './core/metrics';

// Cost model & estimator: pure `estimateCost` planning + grounded `segment.costReport()`; the pluggable pricing
// profile + the honest `CostReport` verdict (never hides the lose-zone).
export { estimateCost, DEFAULT_PRICING, AWS_US_EAST_1_ONDEMAND } from './core/cost';
export type {
  PricingProfile,
  CostReport,
  Workload,
  SegmentSizing,
  EstimateInput,
} from './core/cost';

// Audit trail: a separate injected seam for security/compliance state changes (publish/rewrite/erase/dispose) —
// distinct from metrics. Pass `audit` to the bulk-load/erasure APIs; see the dashboards guide. Exception-safe; the
// default records nothing.
export { NOOP_AUDIT, RecordingAuditSink } from './core/audit';
export type { IAuditSink, AuditEvent, AuditEventKind } from './core/audit';
