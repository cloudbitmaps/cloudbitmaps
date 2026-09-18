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
// `splitId` only: the flavor uses it to fail fast on a non-u32 id. `joinId` is the inverse and has no
// caller outside core, so it stays internal rather than shipping as half-documented public API.
export { splitId } from './core/bit-route';
export { mapWithConcurrency } from './core/concurrency';
export { resolveBudget, resolvePerOpBudget, checkBudget, collectWithinBudget } from './core/budget';
// Also in `driver-kit` (a driver validates at its own boundary); here because the flavor calls it on every
// ref an application hands in.
export { validateSegmentRef } from './core/validate';
export { segmentExists, listSegments } from './core/discover';
export type { SegmentInfo } from './core/discover';
// The PATH half only — `export-segments` builds filesystem paths with it. The KEY half
// (`encodeNameForKey`, `namespaceKeyPart`) is a driver concern and lives in `@cloudbitmaps/core/driver-kit`;
// the two decoders have no caller in or out of this repo.
export { encodeNameForPath } from './core/name-codec';
export { namespacePathPart } from './drivers/_shared/keys';
// Driver-kit: the token shape a registry driver needs, and the key helpers the conformance fakes use.
export type { Token } from './core/ports';
export { segmentKey } from './core/keys';

// ---------------------------------------------------------------------------------------------------
// The public surface (an application reaches these through its flavor package, which re-exports them).
// `createBackend` is how a caller supplies a half of its own; `isStorageBackend` tests the brand.
export { createBackend, isStorageBackend } from './core/ports';
// ---------------------------------------------------------------------------------------------------
export {
  MemoryStorageChunkSource,
  MemoryStorageDriver,
  MemoryRegistryDriver,
} from './drivers/memory';
export type { MemoryRegistryDriverOptions } from './drivers/memory';
export { LocalFsStorageDriver } from './drivers/localfs/storage';
export { LocalFsRegistryDriver } from './drivers/localfs/registry';
// The two SDK-free backends: each states its location once, so the objects and the pointer cannot be
// mismatched. Their cloud siblings ship in their own packages, where the SDK does.
export { LocalFsStorage, MemoryStorage } from './drivers/backends';
export type { LocalFsStorageOptions, MemoryStorageOptions } from './drivers/backends';
export type { LocalFsRegistryDriverOptions } from './drivers/localfs/registry';
// The loaded store's write path: build one immutable generation from ids (bulk-load), or from pre-grouped
// bitmaps, then make it current (publish). Every write in the library is one of these.
export {
  CrbmStorageChunkSource,
  writeCrbmGeneration,
  bulkLoadCrbmGeneration,
  publishGeneration,
} from './core/crbm-storage-source';
export type { BulkLoadResult, CrbmStorageChunkSourceOptions } from './core/crbm-storage-source';
// A pinned view of one segment at one generation — everything else passes through to the live source.
export { PinnedStorageChunkSource } from './core/pinned-storage-source';
export type { PinnedAt } from './core/pinned-storage-source';
// Generation bookkeeping: the next generation number for a segment, and collection of superseded generations.
// Nothing here schedules itself — the retention sweep and the erasure rewrite call `gcOrphanGenerations`; a
// caller writing generations by hand collects on its own cadence.
export { gcOrphanGenerations, nextGeneration } from './core/generation-gc';
export type { GenerationDeps } from './core/generation-gc';
// Subject erasure on a loaded segment: rewrite the current generation without one id, publish fenced on it,
// collect the superseded generation. `store.eraseSubject` runs it over every registered segment.
// The loaded store's primary write path: replace a segment's contents with one immutable generation, guarded.
// Composes next-generation → write → guard → publish → collect, which is the sequence every load performs and
// the one whose last step gets left out when it is composed by hand.
export { loadSegment } from './core/load';
export type { LoadDeps, LoadOptions, LoadGuard, LoadResult, LoadRefusal } from './core/load';
// See what a segment has been, and put it back. `rollbackSegment` is the one pointer move that goes backwards,
// and the one no automatic path performs — forward-only is right for a writer and wrong for an operator.
export { listGenerations, rollbackSegment } from './core/rollback';
export type { GenerationListDeps, GenerationEntry, RollbackResult } from './core/rollback';
export { eraseIdFromSegment } from './core/erase-id';
export type { EraseIdDeps, EraseIdResult } from './core/erase-id';
// The bitmap-codec seam — the engine is codec-agnostic behind these; roaring is the flagship.
export type { CodecInterface, CodecBitmap } from './core/codec';
export type { Clock, Rng } from './core/determinism';
export type {
  StorageChunkSource,
  IStorageDriver,
  StorageCaps,
  ChunkRef,
  SegmentRef,
  GenKey,
  IRegistryDriver,
  StorageBackend,
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
  // Copy-safe predicates. On an ordinary install `instanceof` holds everywhere — every package in the family
  // is published with `@cloudbitmaps/core` left external, so one copy of these classes is shared and you can
  // catch them however you normally would. Prefer these where that stops being true and nothing here can
  // control it: a consumer's bundler inlining core into two outputs, two majors resolved side by side, or an
  // error crossing a worker or vm realm. Each matches a `Symbol.for` brand, which is the same symbol in every
  // copy and every realm where a class object is not. The `instanceof` failure is silent — it simply stops
  // matching — which is why library code that cannot see how it will be bundled should reach for these.
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
// The AAD builder. NOT for an `Aead` implementor — they are handed the associated data. This is for the
// other seam: `CrbmCrypto` requires an `aadFor` member, and `CrbmReader.open` and `writeCrbmGeneration`
// both take one, so tooling that reads or writes an ENCRYPTED archive has to construct it. Without this
// the only way to do that is to re-derive an undocumented byte layout, where a mistake on the read side
// is an `IntegrityError` indistinguishable from real corruption, and on the write side is an archive this
// library can never read back.
export { aadFor } from './core/crypto';
export { NodeAead, InProcessKeystore } from './drivers/crypto';
export type { InProcessKeystoreOptions } from './drivers/crypto';

// Crypto-shred erasure: delete a segment's key → its encrypted Storage bytes are unrecoverable. `dropSegment` is
// the operational sibling: it deletes the objects, so it works on cleartext and actually reclaims the storage —
// where crypto-shred makes bytes unreadable but leaves them billed.
export { destroySegment, dropSegment, eraseNamespace } from './core/erasure';
export type { DropDeps, DropResult, EraseDeps, DestroyResult } from './core/erasure';

// Retention policy: record WHEN a segment becomes eligible for retirement. Writer-set absolute epoch-ms — a
// duration the library derived would be anchored to `updatedAt`/`currentGen`, which every load republishes, so a
// busy segment would never expire. Nothing here runs on a timer; the sweep is a separate call the operator
// schedules (see the getting-started "Retention" section for where to run it).
// `getSegmentRetention(ref)` reads ONE segment's policy and costs a registry read. `readRetentionPolicy(meta)`
// is the pure parser for a caller who already holds rows — a fleet-wide sweep over `registry.list()`, where
// per-segment reads would turn one listing into N+1 round trips. It stays exported because `RegistryRecord`
// and its `retention: GovernanceMeta` field are both public, so without it a caller can reach the metadata and
// has nothing supported to parse it with; hand-rolling that parse is how a single malformed row takes down a
// whole sweep, which is the case its three-way `null | 'invalid' | policy` answer exists to prevent.
// `validateRetentionPolicy` deliberately is NOT exported: `setSegmentRetention` validates on the way in.
export {
  setSegmentRetention,
  clearSegmentRetention,
  getSegmentRetention,
  readRetentionPolicy,
  MIN_EXPIRES_AT_MS,
} from './core/retention';
export type { RetentionPolicy, RetentionDeps, SetRetentionResult } from './core/retention';

// The retention sweep: retire every segment whose policy expired, by delegating to `dropSegment` (the registry →
// Storage ordering is load-bearing and lives there). A call, never a daemon — the operator owns the heartbeat that
// runs it.
export { retireExpired } from './core/retention-sweep';
// `excludingReservedRows` is the filter a fleet-wide pass must apply — the due index stores its state AS
// registry rows, so an unscoped `registry.list()` returns bookkeeping rows alongside real segments and a
// caller that forgets to skip them reports phantom segments. The bounded drain itself (`drainRegistry`) and
// its ceiling validator stay internal; `listSegments` is the supported way to enumerate.
export { excludingReservedRows } from './core/registry-scan';

// The due index — a time-bucketed set of the segments that carry an expiry, so a retention cycle costs what is
// EXPIRING rather than what the fleet HOLDS. Built out of registry rows (no driver change); a fast path only,
// with the full scan demoted to a periodic repair pass, so a stale or missing pointer can never lose data.
// Nothing here is exported: a caller never builds a bucket name or a synthetic row, and `retireExpired`
// consults it for them when asked for it (`retireExpired({ scan: 'index' })`; the default `'fleet'` scan
// drains the registry instead). `excludingReservedRows` above is the one piece an outside caller needs.
export type {
  RetireExpiredOptions,
  RetireExpiredResult,
  RetireEntry,
} from './core/retention-sweep';

// Denial-of-wallet budget: per-op request ceiling → `BudgetExceededError`.
export { DEFAULT_BUDGET } from './core/budget';
export type { Budget, BudgetOption } from './core/budget';

// Cross-tier DR consistency check: `store.checkConsistency()` (or the free function over your own storage +
// registry drivers) detects a torn restore where `currentGen` points at a `.crbm` that isn't present.
export { runConsistencyCheck } from './core/consistency';
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
export { withRetry, DEFAULT_RETRY_POLICY } from './core/retry';
export type { RetryPolicy, RetryDeps } from './core/retry';
export {
  RetryingStorageChunkSource,
  RetryingStorageDriver,
  RetryingRegistryDriver,
} from './drivers/retry/retrying-drivers';
export type { RetryingOptions } from './drivers/retry/retrying-drivers';

// `.crbm` archive format — the on-disk Storage layout. Exposed for driver authors and tooling.
// The READER only. Tooling inspects a `.crbm`; building one is this library's job, and `CrbmWriter` has no
// caller outside core — an offline archive builder would be a deliberate, documented export, not a leak.
export { CrbmReader } from './core/crbm/reader';
export type { CrbmReaderOptions } from './core/crbm/reader';
export { BufferReader } from './core/blob';
export type { BlobReader, BlobSink } from './core/blob';

// Observability: the injected metrics seam + a no-op default + a counting sink. Emit typed events
// (storage/cache/retry/intersect/op) to your stack; see the getting-started "Observability" section.
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
export { RecordingAuditSink } from './core/audit';
export type { IAuditSink, AuditEvent, AuditEventKind } from './core/audit';
