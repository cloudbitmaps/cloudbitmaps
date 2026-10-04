/**
 * `@cloudbitmaps/core` — the codec-agnostic cloud engine behind the @cloudbitmaps family.
 *
 * Everything here is **independent of any bitmap codec**: the read engine, the SDK-free storage backends, the `.crbm`
 * format, the loaded store's write path (`loadSegment`: write, guard, publish, collect), encryption/crypto-shred, the registry,
 * the budget/consistency/eject machinery. Bitmaps are only ever constructed and combined through the
 * {@link CodecInterface} seam, so a *flavor* package (`@cloudbitmaps/roaring` today) supplies the codec and a
 * facade on top.
 *
 * **You normally install a flavor, not this package** — `pnpm add @cloudbitmaps/roaring` pulls this in
 * transitively and re-exports, by name, what an application uses, so `@cloudbitmaps/roaring` is the one name to
 * know. The engine, the standalone forms of the store's methods and the retry and budget internals stay here:
 * depend on `core` directly only when authoring a new flavor or a driver.
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
export type { EngineDeps, CombineOptions as EngineCombineOptions, IdRange } from './core/engine';
export { BoundedLru } from './core/lru';
export { safeMetrics } from './core/metrics';
export { groundedReport } from './core/cost';
export { runExport } from './export';
// `splitId` only: the flavor uses it to fail fast on a non-u32 id. `joinId` is the inverse and has no
// caller outside core, so it stays internal rather than shipping as half-documented public API.
export { splitId } from './core/bit-route';
export { mapWithConcurrency } from './core/concurrency';
export { resolveBudget, resolvePerOpBudget, checkBudget, collectWithinBudget } from './core/budget';
export { segmentExists, listSegments } from './core/discover';
export type { SegmentInfo } from './core/discover';
// Driver-kit: the token shape a registry driver needs, and the key helpers the conformance fakes use.
export type { Token } from './core/ports';
export { segmentKey } from './core/keys';

// ---------------------------------------------------------------------------------------------------
// The public surface. An application reaches most of these through its flavor package, which re-exports the ones it
// needs by name; the rest of this entry is the flavor-author kit above and the standalone forms of the store's methods.
// `isStorageBackend` tests the brand a backend class carries.
export { isStorageBackend } from './core/ports';
// ---------------------------------------------------------------------------------------------------
// The two SDK-free backends: each states its location once, so the objects and the pointer cannot be
// mismatched. Their cloud siblings ship in their own packages, where the SDK does.
export { LocalFsStorage, MemoryStorage } from './drivers/backends';
export type { LocalFsStorageOptions, MemoryStorageOptions } from './drivers/backends';
// A storage source over the `.crbm` generations in an `IStorageDriver`.
export { CrbmStorageChunkSource } from './core/crbm-storage-source';
export type { CrbmStorageChunkSourceOptions, PinnedObject } from './core/crbm-storage-source';
// A pinned view of one segment at one generation — everything else passes through to the live source.
export { PinnedStorageChunkSource } from './core/pinned-storage-source';
export type { PinnedAt } from './core/pinned-storage-source';
// Subject erasure on a loaded segment: rewrite the current generation without one id, publish fenced on it,
// collect the superseded generation. `store.eraseSubject` runs it over every registered segment.
// The loaded store's primary write path: replace a segment's contents with one immutable generation, guarded.
// Composes next-generation → write → guard → publish → collect, which is the sequence every load performs and
// the one whose last step gets left out when it is composed by hand.
export { loadSegment } from './core/load';
export type { LoadDeps, LoadOptions, LoadGuard, LoadResult, LoadRefusal } from './core/load';
export type { LoadInput, PortableBitmap } from './core/load-input';
// See what a segment has been, and put it back. `rollbackSegment` is the one pointer move that goes backwards,
// and the one no automatic path performs — forward-only is right for a writer and wrong for an operator.
export { listGenerations, rollbackSegment } from './core/rollback';
export type { GenerationListDeps, GenerationEntry, RollbackResult } from './core/rollback';
export { eraseIdFromSegment } from './core/erase-id';
export type { EraseIdDeps, EraseIdResult } from './core/erase-id';
// The bitmap-codec seam — the engine is codec-agnostic behind these; roaring is the flagship.
export type { CodecInterface, CodecBitmap, EncodedChunk } from './core/codec';
export type { Clock, Entropy, Rng } from './core/determinism';
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
  RegistrySummary,
  ClearRegistrySummary,
  SealedRegistrySummary,
  GenerationMetadata,
  GenerationSummary,
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
// `IKeystore`. See the encryption guide for key-management guidance.
export type { Aead, AeadSealed, IKeystore, WrappedDek, CrbmCrypto } from './core/crypto';
// The AAD builder. NOT for an `Aead` implementor — they are handed the associated data. This is for the
// other seam: `CrbmCrypto` requires an `aadFor` member, and `CrbmReader.open` takes one, so tooling that reads an
// ENCRYPTED archive has to construct it. Without this the only way to do that is to re-derive an undocumented
// byte layout, where a mistake is an `IntegrityError` indistinguishable from real corruption.
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
// schedules (see the retention guide for where to run it).
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
// its ceiling validator stay internal. `listSegments` is the supported enumeration but is NOT a drop-in for
// the drain: it streams (so the bound is yours) and yields `SegmentInfo`, which carries no retention.
export { excludingReservedRows } from './core/registry-scan';

// The due index — a time-bucketed set of the segments that carry an expiry, so a retention cycle costs what is
// EXPIRING rather than what the fleet HOLDS. Built out of registry rows (no driver change); a fast path only,
// with the full scan as the periodic repair pass, so a stale or missing pointer can never lose data.
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

// Cross-tier DR consistency check: `store.checkConsistency()` (or this function over your own storage +
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

// Resilience: the retry primitive, the policy and its defaults, and the read-source wrapper `CloudRoaring` builds
// around the source it reads segment data through, a caller's pre-built one included. Exported for a source read
// outside a store (wrapping one that is then handed to the store multiplies each read's attempts), and so a caller
// can retry a call of its own with `withRetry`. No write goes through it: a conditional write replayed blindly after
// it landed reports that write as a conflict, so a write is retried only where its replay can be told apart, and
// otherwise its caller re-runs the call or checks what landed.
export { withRetry, DEFAULT_RETRY_POLICY } from './core/retry';
export type { RetryPolicy, RetryDeps } from './core/retry';
export { RetryingStorageChunkSource } from './drivers/retry/retrying-chunk-source';
export type { RetryingOptions } from './drivers/retry/retrying-chunk-source';

// `.crbm` archive format — the on-disk Storage layout. Exposed for driver authors and tooling.
// The READER only. Tooling inspects a `.crbm`; building one is this library's job, and `CrbmWriter` has no
// caller outside core — an offline archive builder would be a deliberate, documented export, not a leak.
export { CrbmReader } from './core/crbm/reader';
export type { CrbmReaderOptions } from './core/crbm/reader';
export { BufferReader } from './core/blob';
export type { BlobReader, BlobSink } from './core/blob';

// Observability: the injected metrics seam + a no-op default + a counting sink. Emit typed events
// (storage/cache/retry/intersect/op) to your stack; see the observability guide.
export { NOOP_METRICS, CountingMetricsSink } from './core/metrics';
export type { IMetricsSink, MetricEvent, MetricOpName, MetricsSnapshot } from './core/metrics';

// Cost model & estimator: pure `estimateCost` planning + grounded `segment.costReport()`; the pluggable pricing
// profile + the honest `CostReport` verdict (never hides the lose-zone).
export {
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
  ONE_REDIS_HA_CLUSTER,
} from './core/cost';
export type {
  PricingProfile,
  RedisNodeType,
  RedisSizing,
  CostReport,
  Workload,
  SegmentSizing,
  EstimateInput,
} from './core/cost';

// Audit trail: a separate injected seam for security/compliance state changes (publish/rewrite/erase/dispose) —
// distinct from metrics. Pass `audit` to the load and erasure APIs; see the dashboards guide. Exception-safe; the
// default records nothing.
export { RecordingAuditSink } from './core/audit';
export type { IAuditSink, AuditEvent } from './core/audit';
