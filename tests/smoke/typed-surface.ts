/*
 * The typed fixture `pnpm smoke` compiles against the built packages, under NodeNext, Bundler and Node10 resolution
 * with `skipLibCheck` off, beside every import the guides show.
 *
 * It names every type `@cloudbitmaps/roaring` exports, so a type the flavor stops exporting fails the build's smoke
 * run, and the run fails as well when the flavor exports a type this list does not name. It reads the typed fields of
 * a refusal, `BudgetExceededError`'s `option`, `limit` and `spent`, so a field that changes type fails it. And it
 * holds the derived forms the API reference gives for the driver ports to the ports `@cloudbitmaps/core/driver-kit`
 * exports, so the two spellings cannot drift apart.
 *
 * `pnpm typecheck` compiles it too, against the sources, because it sits under `tests/`. Nothing runs it.
 */
import { BudgetExceededError, CloudRoaring, MemoryStorage, errorKind } from '@cloudbitmaps/roaring';
import type {
  AuditEvent,
  Budget,
  BudgetOption,
  CacheOptions,
  Clock,
  CloudRoaringOptions,
  CombineOptions,
  ConsistencyErrorEntry,
  ConsistencyIssue,
  ConsistencyReport,
  DestroyResult,
  DropResult,
  EncryptionOptions,
  Entropy,
  EraseDeps,
  EraseSubjectResult,
  ErrorKind,
  ExportFailure,
  ExportFormat,
  ExportManifest,
  ExportOptions,
  ExportSink,
  ExportSkipped,
  ExportWriter,
  ExportedSegment,
  Expr,
  GenerationEntry,
  GenerationMetadata,
  IAuditSink,
  IMetricsSink,
  IdIterator,
  IdStream,
  InProcessKeystoreOptions,
  Lease,
  LoadGuard,
  LoadInput,
  LoadOptions,
  LoadRefusal,
  LoadResult,
  LocalFsStorageOptions,
  MaterializeDryRunResult,
  MaterializeManyDryRun,
  MaterializeManyDryRunOptions,
  MaterializeManyDryRunOutcome,
  MaterializeManyFeed,
  MaterializeManyFeedRecord,
  MaterializeManyOperandStats,
  MaterializeManyOptions,
  MaterializeManyOutcome,
  MaterializeManyOutput,
  MaterializeManyOutputStats,
  MaterializeManyRun,
  MaterializeManyStats,
  MaterializeRefusal,
  MaterializeResult,
  MemoryStorageOptions,
  MetricEvent,
  MetricOpName,
  MetricsSnapshot,
  PinAt,
  PinOptions,
  PinnedAt,
  PortableBitmap,
  RetentionPolicy,
  RetireEntry,
  RetireExpiredOptions,
  RetireExpiredResult,
  RetryOptions,
  RetryPolicy,
  Rng,
  RollbackResult,
  SeamOptions,
  SegmentInfo,
  SegmentOptions,
  SegmentRef,
  SegmentStat,
  SetRetentionResult,
  SubjectErasureEntry,
  SubjectReport,
  SubjectSegmentRef,
} from '@cloudbitmaps/roaring';
import type {
  IKeystore,
  IRegistryDriver,
  IStorageDriver,
  StorageBackend,
  StorageChunkSource,
} from '@cloudbitmaps/core/driver-kit';

/** Every type the flavor exports, by name. */
export type Named = [
  AuditEvent,
  Budget,
  BudgetOption,
  CacheOptions,
  Clock,
  CloudRoaringOptions,
  CombineOptions,
  ConsistencyErrorEntry,
  ConsistencyIssue,
  ConsistencyReport,
  DestroyResult,
  DropResult,
  EncryptionOptions,
  Entropy,
  EraseDeps,
  EraseSubjectResult,
  ErrorKind,
  ExportFailure,
  ExportFormat,
  ExportManifest,
  ExportOptions,
  ExportSink,
  ExportSkipped,
  ExportWriter,
  ExportedSegment,
  Expr,
  GenerationEntry,
  GenerationMetadata,
  IAuditSink,
  IMetricsSink,
  IdIterator,
  IdStream,
  InProcessKeystoreOptions,
  Lease,
  LoadGuard,
  LoadInput,
  LoadOptions,
  LoadRefusal,
  LoadResult,
  LocalFsStorageOptions,
  MaterializeDryRunResult,
  MaterializeManyDryRun,
  MaterializeManyDryRunOptions,
  MaterializeManyDryRunOutcome,
  MaterializeManyFeed,
  MaterializeManyFeedRecord,
  MaterializeManyOperandStats,
  MaterializeManyOptions,
  MaterializeManyOutcome,
  MaterializeManyOutput,
  MaterializeManyOutputStats,
  MaterializeManyRun,
  MaterializeManyStats,
  MaterializeRefusal,
  MaterializeResult,
  MemoryStorageOptions,
  MetricEvent,
  MetricOpName,
  MetricsSnapshot,
  PinAt,
  PinOptions,
  PinnedAt,
  PortableBitmap,
  RetentionPolicy,
  RetireEntry,
  RetireExpiredOptions,
  RetireExpiredResult,
  RetryOptions,
  RetryPolicy,
  Rng,
  RollbackResult,
  SeamOptions,
  SegmentInfo,
  SegmentOptions,
  SegmentRef,
  SegmentStat,
  SetRetentionResult,
  SubjectErasureEntry,
  SubjectReport,
  SubjectSegmentRef,
];

/** `true` when `A` and `B` are the same type, and `false` otherwise, including when one is a subtype of the other. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The derived forms of the driver ports, each the port driver-kit exports. */
export const derived: {
  readonly storage: Same<
    CloudRoaringOptions['storage'],
    StorageBackend | IStorageDriver | StorageChunkSource
  >;
  readonly storageDriver: Same<MemoryStorage['storage'], IStorageDriver>;
  readonly registryDriver: Same<MemoryStorage['registry'], IRegistryDriver>;
  readonly keystore: Same<NonNullable<EncryptionOptions['keystore']>, IKeystore>;
} = { storage: true, storageDriver: true, registryDriver: true, keystore: true };

/** What a refusal carries, typed: the option to raise, the bound in force and what the call reached. */
export interface Refusal {
  readonly kind: ErrorKind | undefined;
  readonly option: 'budget.maxRequests' | 'maxBufferedBytes' | 'maxScanSegments';
  readonly limit: number;
  readonly spent: number;
}

/** Reads a refusal's typed fields off an error a call threw. */
export function refusal(err: unknown): Refusal | undefined {
  if (!(err instanceof BudgetExceededError)) return undefined;
  const { option, limit, spent } = err;
  return { kind: errorKind(err), option, limit, spent };
}

/** An option type and a result type in use: a store built from its options, and a load's result read. */
export async function loadOne(ref: SegmentRef, ids: readonly number[]): Promise<LoadResult> {
  const options: CloudRoaringOptions = { storage: new MemoryStorage(), retry: { maxAttempts: 2 } };
  return new CloudRoaring(options).load(ref, ids);
}
