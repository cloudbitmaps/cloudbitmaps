/**
 * CloudRoaring — distributed, cloud-native Roaring Bitmaps, read from object storage.
 *
 * The `CloudRoaring` class is the read engine over **loaded** segments: write-once `.crbm` generations in an
 * object store, behind one registry pointer per segment. You wire storage **once**, as a single config object:
 * pass a **backend** as `storage` — `S3Storage`, `GcsStorage`, `AzureBlobStorage`, `LocalFsStorage` or
 * `MemoryStorage` — and it carries both halves, the generations and the pointer, from one bucket and one
 * prefix. Add `encryption: { keystore }` for encryption-at-rest / crypto-shred.
 *
 * Two narrower shapes are also accepted for `storage`: a bare {@link IStorageDriver}, which has no pointer and
 * so resolves generations by list-scanning storage (**cleartext and read-only**), and an already-built
 * {@link StorageChunkSource} for advanced reader options you configure yourself.
 *
 * **Data gets in by loading a generation**, never by mutating one: `store.load()` streams a set of ids into one
 * immutable object and advances the segment's pointer to it. The pointer only moves forward, so a load out-raced by
 * a newer generation reports `superseded` instead of landing, and so does one that read the row when the row has
 * changed since. Every other write in the library is a load in
 * disguise — `intersectInto`/`unionInto`/`andNotInto` write a new generation of their destination, and
 * `eraseSubject` rewrites a generation without one id. Reads (`has`/`count`/`iterate`/`intersect`/`union`/`andNot`)
 * see whole, checksum-verified generations and nothing else.
 *
 * In-process lifecycle helpers — `eraseSubject`, `subjectReport`, `dropSegment`, `retireExpired`,
 * `checkConsistency`, `exportSegments` — reuse the store's own drivers, so you never re-pass them (they need the
 * store built with a backend). See the README and the getting-started guide.
 */

import {
  BoundedLru,
  PinnedStorageChunkSource,
  segmentKey,
  CrbmStorageChunkSource,
  DEFAULT_BUDGET,
  DEFAULT_RETRY_POLICY,
  withRetry,
  isStorageBackend,
  NOOP_METRICS,
  RetryingStorageChunkSource,
  SegmentEngine,
  UnsupportedError,
  ValidationError,
  WriteConflictError,
  MIN_EXPIRES_AT_MS,
  checkBudget,
  collectWithinBudget,
  excludingReservedRows,
  dropSegment,
  eraseIdFromSegment,
  estimateCost,
  groundedReport,
  loadSegment,
  loadSegmentChunks,
  mapWithConcurrency,
  resolveBudget,
  resolvePerOpBudget,
  retireExpired,
  runConsistencyCheck,
  runExport,
  setSegmentRetention,
  clearSegmentRetention,
  getSegmentRetention,
  safeMetrics,
  splitId,
} from '@cloudbitmaps/core';
import { validateSegmentRef } from '@cloudbitmaps/core/driver-kit';
import type {
  Budget,
  BudgetOption,
  GenerationEntry,
  GenerationMetadata,
  LoadGuard,
  LoadInput,
  LoadOptions,
  LoadRefusal,
  LoadResult,
  RollbackResult,
  Clock,
  CodecBitmap,
  CodecInterface,
  StorageChunkSource,
  ConsistencyReport,
  CostReport,
  EngineDeps,
  DropResult,
  EstimateInput,
  ExportManifest,
  ExportOptions,
  ExportSink,
  IAuditSink,
  IStorageDriver,
  IKeystore,
  IMetricsSink,
  IRegistryDriver,
  StorageBackend,
  MetricOpName,
  PricingProfile,
  RetentionPolicy,
  RetireExpiredOptions,
  RetireExpiredResult,
  RetryPolicy,
  RetryingOptions,
  Rng,
  SetRetentionResult,
  PinnedAt,
  IdRange,
  SegmentRef,
  Workload,
} from '@cloudbitmaps/core';
import { OpenChargingStorage } from './open-charging-storage';
// This package's reason to exist: the roaring codec the facade injects into the codec-agnostic engine.
import { listGenerations, rollbackSegment } from '@cloudbitmaps/core';
import { listSegments, segmentExists } from '@cloudbitmaps/core';
import type { SegmentInfo } from '@cloudbitmaps/core';
import { refuseReservedNamespace } from './reserved-namespace';
import { bitmapAsLoadInput, deserializePortable, roaringCodec } from './roaring-codec';
import { SystemClock } from './system-clock';
import { OPTION_KEYS, type OptionGroup } from './option-keys';

/** Default randomness for backoff jitter — lives outside `core/`, so `Math.random()` is allowed here. */
class SystemRng implements Rng {
  /** A float in `[0, 1)`. Jitter only — never key material, never anything a caller can observe. */
  next(): number {
    return Math.random();
  }
}

const DEFAULT_CACHE_MAX_CHUNKS = 1024;
/** Default in-flight fan-out for the admin scans (`subjectReport`/`eraseSubject`) — bounded, no thundering herd. */
const DEFAULT_ADMIN_CONCURRENCY = 8;
/** Fail fast on a bad admin `concurrency` BEFORE the (potentially huge) registry scan, not after. */
function validateConcurrency(concurrency: number | undefined): void {
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new ValidationError(`concurrency must be a positive integer; got ${concurrency}`);
  }
}

/**
 * Tenancy guard for the global-scope admin scans (`subjectReport`/`eraseSubject`). Ids live in ONE global
 * `[0, 2³²)` space shared across namespaces, so a namespace-less scan reaches into *every* tenant's segments.
 * Require an explicit `namespace`, or a deliberate `{ allNamespaces: true }` ack, so a fleet-wide sweep is never
 * the accidental default on a shared store.
 */
function requireScope(options: { namespace?: string; allNamespaces?: boolean }, op: string): void {
  // A scope names a namespace like a ref does, and these two scans read the registry themselves rather than
  // through a core function that refuses it.
  refuseReservedNamespace(options.namespace);
  if (options.namespace === undefined && options.allNamespaces !== true) {
    throw new ValidationError(
      `${op} scans the global id space across all namespaces — pass an explicit \`namespace\`, ` +
        `or \`{ allNamespaces: true }\` to intentionally sweep the whole fleet`,
    );
  }
}

/**
 * Wiring for a {@link CloudRoaring} store. **Only `storage` is required** — the minimal call is
 * `new CloudRoaring({ storage: backend })`. A backend resolves generations with one strong read, reads
 * encrypted segments, and unlocks every lifecycle helper; the narrower shapes `storage` also accepts are
 * described on the option itself. Everything else is **optional
 * tuning with sensible defaults** — resilience/retries are already on, the cache is bounded, metrics are a
 * no-op — so reach for them only when you need to.
 */
export interface CloudRoaringOptions {
  /**
   * Where the store keeps everything. **The only required option.**
   *
   * Pass a {@link StorageBackend} — `S3Storage`, `GcsStorage`, `AzureBlobStorage`, `LocalFsStorage`,
   * `MemoryStorage` — and you are done: it carries both halves, the generations and the `currentGen` pointer,
   * configured from one bucket and one prefix. That is the whole wiring, and it is the shape to reach for.
   *
   * **Pass the backend itself, not `backend.storage`.** They differ by one property access and the mistake is
   * silent: `storage: backend` is the store, while `storage: backend.storage` hands over the *driver half*
   * alone, which constructs without complaint and gives you a cleartext, read-only store that fails later on
   * the first write or lifecycle call. `destroySegment` and `eraseNamespace` take `backend.registry`; the store takes `backend`.
   *
   * Two lower-level shapes stay accepted for wiring the facade does not cover:
   *
   * - a **raw {@link IStorageDriver}**, which the store wraps in a {@link CrbmStorageChunkSource}. There is no
   *   registry in this shape, so the store resolves generations by list-scanning storage: **cleartext and
   *   read-only**. Encrypted segments, the `*Into` verbs and every lifecycle helper need a backend.
   * - an already-built {@link StorageChunkSource}, used as-is, for advanced reader options.
   */
  readonly storage: StorageBackend | IStorageDriver | StorageChunkSource;

  /**
   * Memory and staleness bounds for the read path. Every key is optional and every default is already sane;
   * reach for these when a deployment's shape differs from "a long-running server with room to breathe".
   */
  readonly cache?: CacheOptions;

  /**
   * Encryption at rest. Omit it entirely for a cleartext store — encryption is opt-in, and a segment's
   * encryption is decided at its **first** generation.
   */
  readonly encryption?: EncryptionOptions;

  /**
   * Resilience: by default every read that answers a query retries **transient** faults (throttling, 5xx, dropped
   * connections) with bounded, jittered exponential backoff (see {@link DEFAULT_RETRY_POLICY}): `has`, `count`,
   * `iterate` and the combines, the `*Into` verbs' reads of their operands included, a pinned handle's reads and
   * `pin()` itself, and the reads a write makes along the way: a load's guard read of the current generation, and an
   * erasure's reads of the generation it rewrites, of the one it wrote and of any other that may still hold the id.
   * This option does not govern writes, nor the calls that read the registry or list the bucket directly (`exists`,
   * `segments`, `generations`, `getRetention`, and the registry scan `subjectReport`, `exportSegments` and
   * `checkConsistency` start from): they report a transient fault to their caller, because a conditional write that
   * lands and then loses its response would, replayed blindly, report its own write as a conflict. A write is
   * retried only where that is safe: a load's registry write that gets no answer is settled by reading the row,
   * and a throttled write-once object is sent again by the S3 and GCS drivers. Pass a partial policy to tune it — anything you leave out keeps its
   * default — or `false` to turn the read retry off (e.g. if your injected client already retries). A GCS download is retried by
   * the GCS driver whatever this says.
   * Deterministic errors (`ValidationError`/`IntegrityError`/`WriteConflictError`/…) are never retried by this
   * layer.
   */
  readonly retry?: RetryOptions | false;

  /**
   * Observability sink: receives typed metric events (storage GET/bytes, cache hit/miss, retries, intersection
   * efficiency, op latency). Defaults to a no-op — emission is skipped entirely when unused (near-zero
   * overhead). Any exception the sink throws is swallowed — metrics can never break a read.
   */
  readonly metrics?: IMetricsSink;

  /**
   * Per-op **denial-of-wallet** budget: the max backend requests a single
   * `count`/`iterate`/`intersect`/`union`/`andNot`/`subjectReport`/`eraseSubject` may fan out into before it's
   * refused with {@link BudgetExceededError} (`eraseSubject` reports an over-budget segment in its ledger instead,
   * see {@link CloudRoaring.eraseSubject}) — so one runaway op can't drive unbounded GET cost on a shared
   * backend. **On by default, generous** ({@link DEFAULT_BUDGET}: 1,000,000 requests — a normal op never hits it).
   * Tune with `{ maxRequests }`, override per op (on the combines / `subjectReport` / `eraseSubject`), or set
   * `false` to disable. The check is O(1) (before fan-out), so the hot path is untouched; per-request bytes are
   * separately size-capped, so bounding requests transitively bounds bytes.
   */
  readonly budget?: BudgetOption;

  /**
   * Determinism seams, for tests and replayable jobs. Production stores leave this out and get a system clock
   * and a `Math.random`-backed source.
   */
  readonly seams?: SeamOptions;
}

/** {@link CloudRoaringOptions.cache} — the memory and staleness bounds. */
export interface CacheOptions {
  /** Ceiling on decoded Storage chunks held in RAM (default 1024). */
  readonly maxChunks?: number;
  /** Optional TTL on cached chunks (ms). Omit to keep a chunk until it is evicted by the count bound. */
  readonly ttlMs?: number;
  /**
   * How long (ms) the store trusts a segment's resolved `currentGen` before re-resolving it on the next read
   * (default 2000) — the bound on read staleness after a load publishes a new generation. Applies when
   * `storage` is a **backend**, whose registry supplies the cheap `currentGen` read the refresh needs. Lazy — no
   * timer; ≤ one registry read per segment per window, opening a new reader only when the generation actually
   * advanced.
   *
   * **While the registry cannot be read, the bound stretches.** A refresh that fails with a
   * {@link TransientError} keeps serving the generation the reader holds, and the key it unwrapped, and is tried
   * again 500 ms later (or after this TTL, if shorter), so the store converges within one retry of the registry
   * answering. A refresh that fails with anything else, an access denial or a row that will not parse, is not
   * ridden out: the read that meets it throws that error, and the reader is dropped.
   *
   * `0` turns this timed refresh off, and so does wiring a bare `IStorageDriver`, which has no registry. That is
   * all it does. The store still moves a segment on to whatever generation is current when its reader cache
   * evicts the segment, when a read has to fetch from a generation a sweep deleted, and when it is invalidated,
   * as its own `load`, `rollback`, `eraseSubject` and `*Into` writes do and {@link CloudRoaring.invalidate} does.
   * A read its caches can answer touches no storage, so a sweep alone moves nothing. What `0` gives up is the bound:
   * the store notices another process's publish, erasure or drop only through one of those, whenever that happens. To read
   * one generation for as long as you need it, take a {@link Segment.pin}.
   */
  readonly genTtlMs?: number;
  /**
   * Ceiling on how many segments' `.crbm` readers (each holding a parsed index) the store keeps open at once
   * (default 1024) — the steady-state memory bound for a long-running server that reads across many segments.
   * Past it the least-recently-used segment's reader is evicted; re-opening it later is one cheap tail GET. A reader of a small generation, one whose whole object came with its tail read,
   * also holds its chunk bytes, so a read of it makes no chunk request until the reader is evicted or the pointer refresh
   * moves it on; a store with no timed refresh (`genTtlMs: 0`, or no registry) keeps none.
   * Applies whenever the store builds its own read path — a backend or a bare `IStorageDriver`. A pre-built
   * `StorageChunkSource` manages its own reader cache.
   */
  readonly readerMax?: number;
  /**
   * Aggregate byte ceiling on what the open readers hold, their parsed `.crbm` indices, the metadata a
   * generation carries, and the chunk bytes a reader keeps when its tail read returned a whole object whose chunks
   * total at most this ceiling divided by {@link CacheOptions.readerMax} (default 64 MiB) — the byte half
   * of the memory bound, complementing the {@link CacheOptions.readerMax} *count* bound. A wide/dense segment's
   * parsed index can reach about 1.3 MB, so a count-only bound could let the open readers pin over a GB and blow a small
   * heap (e.g. a 128 MB Lambda); this evicts the least-recently-used reader once the summed index footprint
   * would exceed the ceiling — whichever of the count/byte bounds binds first. Lower it for memory-tight
   * deployments that read across wide segments. Applies whenever the store builds its own read path.
   */
  readonly readerMaxBytes?: number;
}

/** {@link CloudRoaringOptions.encryption} — encryption at rest and crypto-shred. */
export interface EncryptionOptions {
  /**
   * The keystore that mints and unwraps per-segment DEKs. Needs a **backend**: the wrapped DEK lives in the
   * registry, so there is nowhere to put it on a store wired with a bare driver, and that is refused at
   * construction rather than at the first read.
   */
  readonly keystore?: IKeystore;
  /**
   * Refuse to touch a **cleartext** segment — a guard against silently reading, or writing, data that should be
   * encrypted. Needs a backend, for the same reason as {@link EncryptionOptions.keystore}. Off by default.
   *
   * It refuses **writes** as well as reads, which is easy to miss: the `*Into` verbs and `eraseSubject` both
   * carry it into their write path, so on a cleartext segment a materialisation throws and an erasure records
   * `note: 'error: requireEncryption: …'` in its ledger rather than erasing. And since a segment's encryption is
   * decided at its **first** generation, this cannot be switched on for a segment that already has one — load
   * into a new encrypted segment and drop the old one.
   */
  readonly required?: boolean;
}

/**
 * {@link CloudRoaringOptions.retry} — a partial {@link RetryPolicy} plus the retry callback.
 *
 * Partial on purpose, so tuning one field does not mean restating all five. Anything omitted here keeps its
 * {@link DEFAULT_RETRY_POLICY} value.
 */
export interface RetryOptions extends Partial<RetryPolicy> {
  /**
   * Observability: called before each transient-retry backoff wait. Best-effort: an error it throws is
   * swallowed, so it can neither stop the retry nor change the error a read fails with.
   */
  readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

/** {@link CloudRoaringOptions.seams} — injected for deterministic tests and replayable jobs. */
export interface SeamOptions {
  /** Defaults to a system clock. */
  readonly clock?: Clock;
  /** Defaults to `Math.random`-backed. Drives transient-retry jitter. */
  readonly rng?: Rng;
}

export interface SegmentOptions {
  readonly namespace?: string;
  /**
   * **When this segment stops being readable** — an absolute epoch-ms instant, declared where the segment is
   * named instead of in a separate `setRetention` call.
   *
   * Every read through this handle checks it first: past the deadline, `has` is `false`, `count` is `0`, and
   * `iterate` yields nothing — **one integer compare against the injected clock, no I/O, on every backend**.
   * That is Redis's lazy expiry, and it is what makes an expiry *correct* rather than *eventually correct*: a
   * deployment whose sweep is late — or which has no sweep at all, like a Lambda-only reader — still stops
   * serving the data on time.
   *
   * **Two things this does NOT do, both deliberate:**
   *
   * - It does not reclaim the bytes. That is {@link CloudRoaring.retireExpired}, and until it runs the data is
   *   still stored and still billed. `count()` reporting 0 while objects exist is the expected state in that
   *   window, not a bug.
   * - It does not apply to *other* handles. The deadline lives on this handle; a second handle opened without
   *   the option reads the segment normally. Record the policy with {@link CloudRoaring.setRetention} to make
   *   it durable, fleet-visible, and reclaimable.
   *
   * Must be **milliseconds** since the epoch and at or after {@link MIN_EXPIRES_AT_MS} — a seconds value would
   * land in 1970 and make the segment permanently unreadable, so it is refused rather than honoured.
   */
  readonly expiresAt?: number;
}

/** A segment reference in a subject report / erasure ledger. */
export interface SubjectSegmentRef {
  readonly segment: string;
  readonly namespace?: string;
}

/** Result of {@link CloudRoaring.subjectReport} — the segments an id is a member of (over registered segments). */
export interface SubjectReport {
  readonly id: number;
  /** The registered segments the id is currently a member of. */
  readonly segments: SubjectSegmentRef[];
  /** How many registered segments were scanned (the completeness denominator). */
  readonly scannedSegments: number;
}

/** One segment's entry in an erasure ledger (see {@link EraseSubjectResult}). */
export interface SubjectErasureEntry {
  readonly segment: string;
  readonly namespace?: string;
  /**
   * True iff the id **was** in the segment and **no generation of it holds the id now** — not the current one, not
   * one below the pointer, and not one above it, where a rollback leaves the generations it rolled back from. The
   * current generation is one without it, every generation that held it has been deleted from the bucket, and the
   * call listed the bucket and read what was left before this entry was returned (see
   * {@link CloudRoaring.eraseSubject}).
   */
  readonly erased: boolean;
  /**
   * The generation the id was found in (present whenever the segment was read) — the newest of them, when the
   * current generation did not hold it and several others did.
   */
  readonly fromGeneration?: number;
  /** The generation written without the id (present whenever one was written). */
  readonly generation?: number;
  /**
   * Why the id was NOT erased from this segment, when `erased` is false. `'superseded'` — the pointer moved while
   * the call was in flight, by a load, another erasure or a rollback, so **this call** did not erase the id;
   * re-run against the new generation, which erases it if it is still there and reports nothing for the segment
   * if the racing writer already removed it. `` `error: <message>` `` — an isolated per-segment fault
   * (per-segment faults are recorded so one segment can't discard the whole ledger); re-run after fixing the
   * fault. A budget refusal is one of these: the segment's generations did not fit `budget`, so it was not finished;
   * re-run with a higher `budget`. A fault that landed once part of the work was already done — a Storage `delete` fault, a collect that
   * could not prove the segment was still the same one, or a generation still holding the id when the bucket was
   * listed at the end, whether or not a rewrite was published first — also re-runs, but **read what the re-run
   * says**: it usually reports `erased: true` against the generation it found the id in, it reports
   * nothing at all if a racing collector took that generation first (the bit is gone, but no run holds a
   * receipt for it), and if the segment's row has since been purged it is no longer scanned at all — anything
   * left in its bucket is an orphan, which `store.generations(ref)` lists and `store.dropSegment(ref, {
   * confirmSegment })` deletes; `checkConsistency` and the collection a load runs read rows, so neither reaches it.
   * **Segments the id is not in
   * are not listed, and neither are segments that no longer have a registry row** — an empty ledger is not by
   * itself proof the id is gone.
   */
  readonly note?: string;
}

/**
 * The erasure ledger returned by {@link CloudRoaring.eraseSubject} — your proof-of-deletion artifact. It is a
 * return value only (no library-side persistence): persist it / route it to your audit sink as you see fit.
 */
export interface EraseSubjectResult {
  readonly id: number;
  /** Per-segment records for the segments the id was found in (absent segments are not listed). */
  readonly erasedFrom: SubjectErasureEntry[];
  /** How many registered segments were scanned. */
  readonly scannedSegments: number;
}

/**
 * Why a materialisation did not become current.
 *
 * {@link LoadRefusal} minus `'superseded'`: that one is a lost race, and the `*Into` verbs throw
 * {@link WriteConflictError} for it rather than reporting it. Narrowing the type rather than saying so only
 * in prose means the compiler enforces it, and a caller's exhaustive `switch` has no dead branch.
 */
export type MaterializeRefusal = Exclude<LoadRefusal, 'superseded'>;

/** What an `*Into` verb wrote: the new generation of the destination, and whether it became current. */
export interface MaterializeResult {
  /**
   * The generation written. Present even when refused: the refusal deleted that object, unless the destination's
   * row changed while it was writing, which leaves it in the bucket.
   */
  readonly generation: number;
  /**
   * Whether this generation is now the destination's current one.
   *
   * `false` when the guard refused the result: an empty one over a non-empty destination, or one outside
   * `guard`'s bounds. Branch on it: a refusal is reported, not thrown, so a caller that ignores it sees a
   * successful-looking result for a write that deliberately did not happen.
   */
  readonly published: boolean;
  /** Set only when `published` is false. A lost race throws {@link WriteConflictError} rather than appearing here. */
  readonly reason?: MaterializeRefusal;
  /** Ids in the generation. */
  readonly cardinality: number;
  /**
   * What the destination held when the guard judged it — `null` when it had no current generation, **or when
   * no bound needed it**. It is taken only when a bound will use it: `allowEmpty: true` with no
   * `guard.minRetained` skips it, and this is `null` even though `dest` was non-empty. When the destination's row
   * carries a summary of its current generation the count comes from the row and the object is not read; a row
   * written before rows carried a summary costs one object-header fetch.
   */
  readonly cardinalityBefore: number | null;
  /** Non-empty chunks in the generation. */
  readonly chunkCount: number;
  /** Bytes of the written object. */
  readonly size: number;
  /**
   * The superseded generations collected after publishing. Empty when nothing was published — and **also
   * empty on a successful publish** unless you passed `keep`, because a materialisation collects nothing by
   * default. See {@link MaterializeOptions.keep}.
   */
  readonly collected: readonly number[];
}

/**
 * Resolve the `storage` option to a {@link StorageChunkSource} at construction (wiring-time only — no hot-path cost).
 *
 * `storage` is discriminated by a **brand** for the backend arm and structurally for the other two: a raw {@link IStorageDriver} exposes `putImmutable`
 * (the byte-mover seam); a pre-built {@link StorageChunkSource} exposes `getChunk` (the engine's read seam). The
 * two interfaces are deliberately **disjoint** on these methods (an invariant the driver SDK maintains, pinned
 * by a test) — an object exposing *both* is ambiguous and rejected, as is one exposing *neither* (incl. a
 * nullish/non-object value from a JS caller): fail fast with a typed error rather than crash on a probe.
 *
 * A backend is wrapped into a {@link CrbmStorageChunkSource} over its storage half, pinned to its registry,
 * with the config's `encryption` group; a bare driver is wrapped the same way but without a
 * registry; a pre-built source is used as-is. `keystore`/`requireEncryption` are meaningful **only** where the
 * store builds the source itself — pairing either with a pre-built source is a wiring mistake, so reject it
 * rather than silently ignore it. The `CrbmStorageChunkSource` constructor enforces the rest (a keystore /
 * `requireEncryption` needs a registry, so they need a backend; the driver needs range reads).
 *
 * Returns the resolved `source` (what the engine reads through) **and** the raw `driver` when one was passed —
 * the store keeps the raw driver so its lifecycle helpers and the `*Into` verbs can write generations without
 * you re-passing drivers. `driver` is `undefined` for a pre-built source (there's no underlying `IStorageDriver` to
 * write through, so its writes throw {@link UnsupportedError}).
 */
/**
 * Work out what the caller handed us, and build the read path from it.
 *
 * Three accepted shapes. A backend is identified by its brand, the other two structurally — never by `instanceof`, so a backend or driver from a
 * different copy of the package still works (the same reason the error predicates are brand-based).
 */
function resolveStorageSource(
  options: CloudRoaringOptions,
  clock: Pick<Clock, 'now'>,
): {
  source: StorageChunkSource;
  driver: IStorageDriver | undefined;
  registry: IRegistryDriver | undefined;
} {
  const storage: unknown = options.storage;
  if (storage === null || typeof storage !== 'object') {
    throw new ValidationError(
      '`storage` must be a StorageBackend, an IStorageDriver, or a StorageChunkSource',
    );
  }
  const asBackend = storage as Partial<StorageBackend>;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object';
  const hasGetChunk = typeof (storage as Partial<StorageChunkSource>).getChunk === 'function';
  const hasPutImmutable = typeof (storage as Partial<IStorageDriver>).putImmutable === 'function';

  // The BRAND decides, not the shape. `{ storage, registry }` is also the shape of core's free-function deps
  // object, so before the brand any literal satisfied it — including one holding halves from two unrelated
  // stores, which the store accepted and then answered empty for a segment that holds data.
  const isBackend = isStorageBackend(storage);

  // A branded backend that ALSO quacks like a driver or a source is genuinely ambiguous. Unreachable for the
  // five classes, kept because the alternative to refusing is guessing.
  if (isBackend && (hasGetChunk || hasPutImmutable)) {
    throw new ValidationError(
      '`storage` is a StorageBackend that also exposes ' +
        `${hasGetChunk ? '`getChunk`' : '`putImmutable`'} — ambiguous. A backend must not also be a driver ` +
        'or a source; pass whichever one you mean.',
    );
  }

  // Unbranded, but carrying both halves. Three sub-cases, and they want different things said.
  const hasStorageHalf = isObject(asBackend.storage);
  const hasRegistryHalf = isObject(asBackend.registry);

  // (a) A DRIVER that also carries a registry — the audit/metrics/tenant-scoping wrapper. Without this it
  // falls through to the bare-driver path, where there is no pointer at all: generations resolve by
  // list-scan, so the store answers from the HIGHEST object in the bucket rather than the published one, and
  // a load that wrote an object but never published it is served as if it had been. Silently, and with the
  // wrapper's registry sitting right there unused.
  if (!isBackend && hasPutImmutable && hasRegistryHalf) {
    throw new ValidationError(
      '`storage` looks like a driver that also carries a `registry`. Passed as a bare driver it would have ' +
        'no pointer at all — generations would resolve by list-scan, so reads could serve a generation that ' +
        'was written but never published. If you meant a backend, use a backend class — S3Storage, GcsStorage, ' +
        'AzureBlobStorage, LocalFsStorage or MemoryStorage — or, to pair a driver of your own with a registry, ' +
        'brand the pair with `brandAsBackend` from `@cloudbitmaps/core/driver-kit`.',
    );
  }

  // (b) Both halves, neither of them a driver or a source: the hand-assembled literal, or a spread of a real
  // backend with one half swapped. Name the classes AND the door — the five classes cannot express an
  // instrumented half or a foreign registry, which is exactly the case that lands here.
  if (!isBackend && !hasGetChunk && !hasPutImmutable && hasStorageHalf && hasRegistryHalf) {
    const storageOk =
      typeof (asBackend.storage as Partial<IStorageDriver>).putImmutable === 'function';
    const registryOk =
      typeof (asBackend.registry as Partial<IRegistryDriver>).compareAndSwap === 'function';
    // (c) …and if a half is not actually a driver, say THAT rather than lecturing about buckets.
    if (!storageOk || !registryOk) {
      const bad = !storageOk
        ? '`storage` half is not an IStorageDriver (no `putImmutable`)'
        : '`registry` half is not an IRegistryDriver (no `compareAndSwap`)';
      throw new ValidationError(
        '`storage` looks like a backend but its ' +
          bad +
          ' — use a backend class, or brand a pair of drivers with `brandAsBackend` from ' +
          '`@cloudbitmaps/core/driver-kit`.',
      );
    }
    throw new ValidationError(
      '`storage` must be a backend — S3Storage, GcsStorage, AzureBlobStorage, LocalFsStorage or ' +
        'MemoryStorage. An object with `.storage` and `.registry` is not one: a backend builds both halves ' +
        'from a single bucket and prefix, so they cannot disagree, and hand-assembling them re-opens exactly ' +
        'that mismatch — a store whose pointer and generations live in different places reads as empty ' +
        'rather than failing. A driver author who genuinely wants halves of their own — an instrumented driver, ' +
        'a registry in a database you already run — brands the pair with `brandAsBackend` from ' +
        '`@cloudbitmaps/core/driver-kit`, which is taking on that they agree.',
    );
  }

  if (isBackend) {
    const backend = storage as StorageBackend;
    return {
      source: new CrbmStorageChunkSource(backend.storage, {
        registry: backend.registry,
        keystore: options.encryption?.keystore,
        requireEncryption: options.encryption?.required,
        clock,
        currentGenTtlMs: options.cache?.genTtlMs,
        maxOpenSegments: options.cache?.readerMax,
        maxOpenIndexBytes: options.cache?.readerMaxBytes,
      }),
      driver: backend.storage,
      registry: backend.registry,
    };
  }

  if (hasGetChunk && hasPutImmutable) {
    throw new ValidationError(
      '`storage` exposes both `getChunk` and `putImmutable` — ambiguous; pass a StorageBackend, an IStorageDriver, or a StorageChunkSource, not a hybrid',
    );
  }
  if (!hasGetChunk && !hasPutImmutable) {
    throw new ValidationError(
      '`storage` must be a StorageBackend, an IStorageDriver, or a StorageChunkSource',
    );
  }
  if (hasGetChunk) {
    // Already a StorageChunkSource — used as-is. `keystore`/`requireEncryption` only apply when the store
    // builds the source itself; with a pre-built source they are inert, so reject them rather than mislead.
    if (options.encryption?.keystore !== undefined || options.encryption?.required === true) {
      throw new ValidationError(
        'keystore/requireEncryption apply only when the store builds its own read path; configure them on ' +
          'the StorageChunkSource you passed instead',
      );
    }
    return { source: storage as StorageChunkSource, driver: undefined, registry: undefined };
  }
  // A bare IStorageDriver: no pointer, so generations resolve by list-scan. Cleartext, read-only.
  const driver = storage as IStorageDriver;
  return {
    source: new CrbmStorageChunkSource(driver, {
      keystore: options.encryption?.keystore,
      requireEncryption: options.encryption?.required,
      clock,
      currentGenTtlMs: options.cache?.genTtlMs,
      maxOpenSegments: options.cache?.readerMax,
      maxOpenIndexBytes: options.cache?.readerMaxBytes,
    }),
    driver,
    registry: undefined,
  };
}

/**
 * The deps every write-side helper on the store shares: raw storage + registry + the store's codec/crypto/clock, and
 * the store's read retry for the reads a write makes along the way (undefined when the store's retry is off).
 */
interface LifecycleDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly codec: CodecInterface;
  readonly clock: Clock;
  /** The store's random source, which spreads a publish's waits between fresh writes whether or not reads retry. */
  readonly rng: Rng;
  readonly keystore?: IKeystore;
  readonly requireEncryption?: boolean;
  readonly readRetry?: RetryingOptions;
}

/** How the store names a group value that is an object to `typeof` but configures nothing, by its built-in tag. */
const NOT_A_GROUP: Readonly<Record<string, string>> = {
  Null: 'null',
  Array: 'an array',
  Map: 'a Map',
  Set: 'a Set',
  Boolean: 'a boxed boolean',
  Number: 'a boxed number',
  String: 'a boxed string',
};

export class CloudRoaring {
  private readonly engine: SegmentEngine;
  private readonly cache: BoundedLru<string, CodecBitmap>;
  /** The store's retry options, for a pinned engine to read through as the store's own does; undefined when off. */
  private readonly retryOptions: RetryingOptions | undefined;
  private readonly crbmSource: CrbmStorageChunkSource | undefined;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly metrics: IMetricsSink;
  // The store's own drivers, kept so the lifecycle helpers and the `*Into` verbs reuse them instead of making
  // you re-pass deps. `storageDriver` is set only when `storage` was a raw IStorageDriver (a pre-built StorageChunkSource has
  // no underlying driver to write through).
  private readonly storageDriver: IStorageDriver | undefined;
  private readonly registry: IRegistryDriver | undefined;
  private readonly keystore: IKeystore | undefined;
  private readonly requireEncryption: boolean;
  /** Resolved store-level per-op budget (null = disabled); the admin scans use it, with a per-op override. */
  private readonly budget: Budget | null;

  /**
   * Refuse any option key the store does not take, at the top level or inside a group, naming each one.
   *
   * An option the store ignored would do nothing and look as if it had — a typo'd `cache.maxChunk`, a key from
   * another library's config spread into this one — so every key is checked against {@link OPTION_KEYS}.
   */
  private static rejectUnknownOptions(options: CloudRoaringOptions): void {
    // A nullish or non-object bag never reaches `resolveStorageSource` — the constructor reads
    // `options.seams?.clock` first and would throw a raw TypeError. Report it here, typed, instead.
    if (options === null || options === undefined || typeof options !== 'object') {
      throw new ValidationError(
        'CloudRoaring needs an options object with a `storage` key — got ' +
          (options === null ? 'null' : typeof options),
      );
    }
    const bag = options as unknown as Record<string, unknown>;
    const unknown: Array<{ group: OptionGroup | null; key: string }> = [];
    for (const key of Object.keys(bag)) {
      if (!(OPTION_KEYS.top as readonly string[]).includes(key)) unknown.push({ group: null, key });
    }
    const groups = Object.keys(OPTION_KEYS).filter((g): g is OptionGroup => g !== 'top');
    for (const group of groups) {
      const value = bag[group];
      if (value === undefined) continue;
      const offOk = group === 'retry' || group === 'budget';
      if (value === false && offOk) continue;
      // A group that is not an object configures nothing: `encryption: true` would build a cleartext store. The
      // built-in tag, not `instanceof`, so a boxed `new Boolean(true)` and a Map from another realm are caught.
      const tag = Object.prototype.toString.call(value).slice(8, -1);
      if (typeof value !== 'object' || value === null || NOT_A_GROUP[tag] !== undefined) {
        const got = typeof value !== 'object' ? typeof value : NOT_A_GROUP[tag];
        throw new ValidationError(
          `CloudRoaring's \`${group}\` must be an object${offOk ? ' or `false`' : ''} — got ${got}`,
        );
      }
      const known = OPTION_KEYS[group] as readonly string[];
      for (const key of Object.keys(value)) if (!known.includes(key)) unknown.push({ group, key });
    }
    if (unknown.length === 0) return;
    const takes = (keys: readonly string[]): string => keys.map((k) => `\`${k}\``).join(', ');
    const named = [...new Set(unknown.map((u) => u.group))];
    throw new ValidationError(
      `CloudRoaring does not take ${takes(unknown.map((u) => (u.group === null ? u.key : `${u.group}.${u.key}`)))}. ` +
        named
          .map((g) =>
            g === null
              ? `The store takes ${takes(OPTION_KEYS.top)}.`
              : `\`${g}\` takes ${takes(OPTION_KEYS[g])}.`,
          )
          .join(' ') +
        ' https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/api-reference.md#build-a-store--new-cloudroaringoptions',
    );
  }

  constructor(options: CloudRoaringOptions) {
    CloudRoaring.rejectUnknownOptions(options);
    const clock = options.seams?.clock ?? new SystemClock();
    const rng = options.seams?.rng ?? new SystemRng();
    // Wrap the user sink so a throwing/buggy sink can never break I/O (observability is best-effort).
    const metrics = safeMetrics(options.metrics ?? NOOP_METRICS);
    const cache = new BoundedLru<string, CodecBitmap>({
      maxEntries: options.cache?.maxChunks ?? DEFAULT_CACHE_MAX_CHUNKS,
      ttlMs: options.cache?.ttlMs,
      clock,
    });
    // Resolve the Storage seam to a StorageChunkSource: a raw IStorageDriver is wrapped into the `.crbm` storage source
    // here (with the store's registry/keystore) so drivers are wired once; a pre-built source is used as-is.
    const resolved = resolveStorageSource(options, clock);
    let storage: StorageChunkSource = resolved.source;
    // Resilience on by default: wrap the source so transient faults retry with jittered backoff. `false` opts
    // out (e.g. the injected client already retries); a RetryPolicy tunes it.
    if (options.retry !== false) {
      // The policy is a partial, and the rest is filled from the default — so tuning one field does not mean
      // restating all five, and `{ onRetry }` alone is a legal, useful value.
      //
      // Field by field with `??`, NOT `{ ...DEFAULT, ...overrides }`. A spread lets a key that is *present with
      // value `undefined`* overwrite the default instead of falling back to it, and `exactOptionalPropertyTypes`
      // is off, so `retry: { baseDelayMs: cfg.baseDelayMs }` typechecks clean when `cfg.baseDelayMs` is absent —
      // the ordinary shape for a value read from env or JSON. The result was `NaN` delays; `SystemClock.sleep`
      // takes the `setTimeout(resolve, NaN)` path, which Node coerces to 1 ms, so bounded jittered backoff
      // silently became a ~1 ms hot retry loop with the read still succeeding and the retry metric still
      // emitting. That is the thundering-herd and denial-of-wallet protection gone with nothing to see.
      // A `Partial` policy is what puts this in reach: were a whole `RetryPolicy` required, each would be a compile
      // error.
      const { onRetry: userOnRetry, ...ov } = options.retry ?? {};
      const policy: RetryPolicy = {
        maxAttempts: ov.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        baseDelayMs: ov.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
        maxDelayMs: ov.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
        backoffFactor: ov.backoffFactor ?? DEFAULT_RETRY_POLICY.backoffFactor,
        jitter: ov.jitter ?? DEFAULT_RETRY_POLICY.jitter,
      };
      const retryOpts: RetryingOptions = {
        clock,
        rng,
        policy,
        // Bridge transient-fault retries into the metrics stream, then call the user's own hook.
        onRetry: (info) => {
          metrics.onEvent({
            kind: 'retry',
            reason: 'transient',
            attempt: info.attempt,
            delayMs: info.delayMs,
          });
          userOnRetry?.(info);
        },
      };
      storage = new RetryingStorageChunkSource(storage, retryOpts);
      this.retryOptions = retryOpts;
    }
    // Resolve the denial-of-wallet budget once (validates; `false` ⇒ null = disabled) and share it between the
    // engine (count/iterate/combines) and the facade's admin scans (subjectReport/eraseSubject).
    this.budget = resolveBudget(options.budget, DEFAULT_BUDGET);
    const deps: EngineDeps = {
      storage,
      cache,
      codec: roaringCodec, // the facade injects the flagship codec; core stays codec-agnostic
      clock,
      metrics,
      budget: this.budget,
    };
    this.engine = new SegmentEngine(deps);
    this.cache = cache;
    // The UNWRAPPED `.crbm` source, kept for `pin()` — the only reader that resolves a specific generation.
    // `undefined` when the caller supplied a pre-built source, which has nothing to pin.
    this.crbmSource =
      resolved.source instanceof CrbmStorageChunkSource ? resolved.source : undefined;
    this.clock = clock;
    this.rng = rng;
    this.metrics = metrics;
    // Keep the raw drivers for the lifecycle helpers (see the fields above). They use the raw drivers directly —
    // a one-shot admin op surfaces a transient fault to the caller rather than retrying under the hood — except for
    // the reads a load's guard and an erasure make along the way, which take the store's read retry (`readRetry`),
    // since a read is safe to repeat and one fault there would otherwise fail the whole write.
    this.storageDriver = resolved.driver;
    this.registry = resolved.registry;
    this.keystore = options.encryption?.keystore;
    this.requireEncryption = options.encryption?.required ?? false;
  }

  /**
   * The write-side deps, from the store's own drivers, for the lifecycle helpers and the `*Into` verbs. Requires
   * the store to have been constructed with a **backend**, which supplies both halves: an `IStorageDriver` to
   * write generations through (a pre-built `StorageChunkSource` has none) and the registry holding the pointer
   * every write publishes.
   */
  private lifecycleDeps(op: string): LifecycleDeps {
    if (this.storageDriver === undefined) {
      throw new UnsupportedError(
        `${op} needs the store built with a storage backend — S3Storage, GcsStorage, AzureBlobStorage, ` +
          `LocalFsStorage or MemoryStorage. A pre-built StorageChunkSource is read-only: it has no ` +
          `IStorageDriver underneath to write generations through. Build the store on one of those backend ` +
          `classes to write.`,
      );
    }
    if (this.registry === undefined) {
      throw new UnsupportedError(
        `${op} needs a storage backend — S3Storage, GcsStorage, AzureBlobStorage, LocalFsStorage or ` +
          `MemoryStorage. A bare IStorageDriver has no generation pointer to publish through, and there is ` +
          `no separate \`registry\` option: a backend carries it.`,
      );
    }
    return {
      storage: this.storageDriver,
      registry: this.registry,
      clock: this.clock,
      rng: this.rng,
      codec: roaringCodec, // facade injects the flagship codec
      keystore: this.keystore,
      requireEncryption: this.requireEncryption,
      readRetry: this.retryOptions,
    };
  }

  /** Get a handle to a segment. Validates the name (non-empty, well-formed, within the encoded-length cap). */
  segment(name: string, options?: SegmentOptions): Segment {
    const ref: SegmentRef = { segment: name, namespace: options?.namespace };
    validateSegmentRef(ref);
    refuseReservedNamespace(ref.namespace);
    const expiresAt = options?.expiresAt;
    if (expiresAt !== undefined) {
      // Fail at the handle, not at the first read that silently returns nothing. The floor is the same one
      // `setRetention` enforces: a seconds-based value would land in 1970 and make the segment permanently
      // and invisibly empty.
      if (
        !Number.isFinite(expiresAt) ||
        !Number.isInteger(expiresAt) ||
        expiresAt < MIN_EXPIRES_AT_MS
      ) {
        throw new ValidationError(
          `segment: expiresAt must be an integer epoch-MILLISECONDS >= ${MIN_EXPIRES_AT_MS}; got ${expiresAt}` +
            ` (a value in seconds lands in 1970 and would make the segment read as permanently empty)`,
        );
      }
    }
    return makeSegment({
      engine: this.engine,
      ref,
      clock: this.clock,
      metrics: this.metrics,
      materialize: (dest, ids, op, options) => this.materialize(dest, ids, op, options),
      pinned: (r, e) => this.pinSegment(r, e),
      combineEngine: (handles) => this.engineForCombine(handles),
      expiresAt,
    });
  }

  /**
   * Write `ids` as a **new generation of `dest`** and publish it — the shared body of the `*Into` verbs. An `*Into`
   * materialisation is a load, and publishes the same way (hard invariant 1): every load that finds a row fences its
   * publish on the row's token; a guarded load (the default, since the empty refusal needs the size of the current generation)
   * also fences on the pointer it judged (`expectFrom`), and one that found no row fences on that absence instead.
   * Only an unguarded load (`allowEmpty: true` and no `guard.minRetained`) onto a segment with no row publishes bare
   * forward-only. The destination's previous generation stays readable until the publish lands (readers re-resolve
   * within `cache.genTtlMs`).
   *
   * This routes through `loadSegment` rather than writing the generation itself, and that is the whole point
   * of it. A materialisation is a load whose ids happen to come from a combine instead of from upstream, so
   * everything `load()` learned the hard way applies unchanged: the generation is written UNPUBLISHED, the
   * guard runs while the old generation is still authoritative, the publish is fenced as above, and a refused
   * object is reclaimed only when a re-read finds the row unchanged (the same token) or gone (hard invariant 1:
   * deleting it after a purge-and-recreate would put a live row over a missing generation).
   *
   * That last check narrows the window rather than closing it: the row read and the delete are two round
   * trips, and `IStorageDriver` has no conditional delete to make them one. the collection a load runs carries
   * the same residual. The failure it leaves is an orphan object, which costs storage until
   * something collects it — deliberately the cheaper side of the trade.
   *
   * Written and published in one step, with no guard, an empty combine — a typo'd operand, an `exclude` that
   * swallowed everything, an operand that had not loaded yet — would silently replace `dest` with an empty
   * generation: the same failure `load()`'s guard exists to prevent, on the same data, reachable without passing
   * any option at all.
   *
   * **A lost race throws.** `loadSegment` reports one as `reason: 'superseded'`; the `*Into` verbs throw
   * {@link WriteConflictError} for it, so a caller can `catch (WriteConflictError)`. That one refusal is
   * translated into the throw, and `MaterializeResult.reason` never carries it.
   *
   * **A `WriteConflictError` does not by itself mean nothing was published**, and that is worth knowing
   * before you write the retry. `'superseded'` covers five different causes — the write-once PUT collided,
   * the pointer moved, a row appeared where the load found none, the row's token changed, the row was purged —
   * and only the first three are the "somebody beat us" the name suggests. A token can also change on a write
   * that is not a supersession at all, such as a `setRetention` on the destination. On top of that, the collection pass that runs AFTER a
   * successful publish can raise the same error. So: treat it as "re-read the destination and decide",
   * never as "the write did not happen".
   *
   * **And by default it collects nothing**, unlike `load()`. See the `keep` default below.
   */
  private async materialize(
    dest: SegmentRef,
    ids: LoadInput | CombineChunks,
    op: string,
    options?: MaterializeOptions,
  ): Promise<MaterializeResult> {
    // A materialisation's `keep` collects every generation below the new one beyond it, which a destination that
    // earlier materialisations kept in full needs a listing for.
    const deps = { ...this.lifecycleDeps(op), collectByListing: true };
    // Read once, here: a getter or a proxy answering twice would otherwise be checked as one value and stored as another.
    const metadata = options?.metadata;
    let result: Awaited<ReturnType<typeof loadSegment>>;
    try {
      const loadOptions = {
        ...(options?.allowEmpty === undefined ? {} : { allowEmpty: options.allowEmpty }),
        ...(options?.guard === undefined ? {} : { guard: options.guard }),
        ...(metadata === undefined ? {} : { metadata }),
        // COLLECT NOTHING by default, which `loadSegment` does not — it keeps a grace window of 1 and deletes
        // the rest. By default a materialisation collects nothing: the guide states "**It deletes nothing**,
        // unlike `load()`. The destination's previous generations stay in the bucket until you collect them", and
        // the ownership table
        // puts that call on the operator. Inheriting `load()`'s collection would silently delete the
        // generations an operator's recovery story depends on — `rollbackSegment` refuses a collected target —
        // as a side effect of adding a guard whose entire purpose is preventing data loss. Opt in with `keep`.
        keep: options?.keep ?? KEEP_EVERY_GENERATION,
        ...(options?.audit === undefined ? {} : { audit: options.audit }),
      };
      result =
        ids instanceof CombineChunks
          ? await loadSegmentChunks(dest, ids.chunks, deps, loadOptions)
          : await loadSegment(dest, ids, deps, loadOptions);
    } finally {
      // As `load()` does: this store's view of `dest` is behind whatever just happened, and a throw can still have
      // published first. Left alone, the store read its own write's predecessor: indefinitely, with no timed refresh.
      this.engine.invalidate(dest);
    }
    // Checked on `reason` alone, not `published && reason`: the compiler narrows a const through an equality
    // test, so after this throw `reason` is provably a `MaterializeRefusal` and the return below type-checks
    // without an assertion. `'superseded'` only ever accompanies `published: false` anyway.
    const reason = result.reason;
    if (reason === 'superseded') {
      // The object is durable, but a concurrent writer published a higher generation of `dest` between our
      // numbering and our publish, so ours is an orphan no reader will resolve. Returning it here would name
      // `generation` as "the destination's new current generation" — which is what `MaterializeResult`
      // documents it to be, and it would be false. The destination holds someone else's content.
      //
      // A throw rather than a flag: every other write path in the library reports a lost race loudly, and a
      // materialisation that silently did not take effect is the one outcome a caller cannot detect on its
      // own.
      // `size > 0` distinguishes the two ways a materialisation loses the race, and the operator needs them
      // apart: the object either exists as an orphan (collected by the first load that collects once a generation
      // above it is current, or deleted by the refusal itself when the destination was dropped meanwhile) or was
      // never written at all, because the write-once PUT itself collided. Telling someone to look for an
      // orphan that does not exist is a wasted investigation.
      // Deliberately does NOT assert which of the four causes it was. "A newer generation was published first"
      // is wrong for two of them: a `setRetention` on the
      // destination bumps the row's token without publishing anything, and a purge leaves no row at all.
      // Telling an operator to go looking for a newer generation that does not exist costs a real
      // investigation. `size > 0` is the one thing this path can state as fact.
      const wrote =
        result.size > 0
          ? `generation ${result.generation} was written and is not current`
          : `nothing was written — another writer took generation ${result.generation} first`;
      throw new WriteConflictError(
        `${op}: the destination "${dest.segment}" changed while this materialisation was in flight, so its ` +
          `result is not the destination's current generation: ${wrote}. The pointer may have moved, the row may have been rewritten ` +
          `(a retention policy does this), dropped or purged. Re-read the destination and re-run.`,
      );
    }
    return {
      generation: result.generation,
      published: result.published,
      ...(reason === undefined ? {} : { reason }),
      cardinality: result.cardinality,
      cardinalityBefore: result.cardinalityBefore,
      chunkCount: result.chunkCount,
      size: result.size,
      collected: result.collected,
    };
  }

  /**
   * **Subject access (GDPR Art. 15 / CCPA right-to-know): which segments is this id a member of?**
   *
   * Enumerates the **registered** segments (via the store's own `registry`) and does a `has(id)` on each — no
   * drivers to re-pass. Complete only over registered segments (every loaded segment has a row, so build the
   * store on the backend the loads used). There is deliberately **no `id → segments` reverse index** — that would
   * tax every load for a rare request; this admin scan is `O(registered segments)` and touches no hot path. Needs
   * a storage backend (throws {@link UnsupportedError} otherwise).
   *
   * **Current as of the registry row, not as of the reader's cache.** Each segment's resolved generation is
   * compared with the row the scan listed, and a segment whose cached generation differs is re-resolved before the
   * read, so a load or an erasure from another process shows at once — whatever `cache.genTtlMs` is, `0` included.
   * The comparison is on the generation **and** the row's token, so a segment retired, purged and loaded again from
   * generation 0 while this store held its old generation 0 is told apart too.
   */
  async subjectReport(
    id: number,
    options: {
      namespace?: string;
      allNamespaces?: boolean;
      concurrency?: number;
      budget?: BudgetOption;
    } = {},
  ): Promise<SubjectReport> {
    const registry = this.requireRegistry('subjectReport');
    requireScope(options, 'subjectReport'); // tenancy: explicit namespace, or an { allNamespaces: true } ack
    validateConcurrency(options.concurrency); // fail fast before the (possibly huge) registry scan
    const budget = resolvePerOpBudget(options.budget, this.budget); // partial override inherits the store's tightening
    splitId(id); // fail fast on a non-u32 id even when no segments are registered
    // Bounded INCREMENTALLY: draining the whole registry and only then checking the budget would refuse the
    // work after paying for the list — measured at 20,000 records buffered under `maxRequests: 2`. This is a
    // GDPR Art. 15 entry point plausibly wired to end-user traffic, so resident memory must be O(budget), not
    // O(fleet size).
    const recs = await collectWithinBudget(
      // A subject cannot be in a due-index row, and charging this request's budget for them would refuse a
      // GDPR Art. 15 report for a reason unrelated to the subject.
      excludingReservedRows(registry.list(options.namespace)),
      budget,
      'subjectReport',
    );
    // Bounded fan-out of `has()` across registered segments. Order-preserving ⇒ deterministic result. A has()
    // fault propagates (a report that can't read a segment must fail loud, not silently under-report).
    const membership = await mapWithConcurrency(
      recs,
      options.concurrency ?? DEFAULT_ADMIN_CONCURRENCY,
      async (rec): Promise<SubjectSegmentRef | null> => {
        if (rec.status === 'destroyed') return null; // already unreadable — never a member
        const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
        // The row this scan just listed is authoritative; the reader's snapshot may be up to `cache.genTtlMs` behind
        // it, or have no timed refresh (`genTtlMs: 0`). An access report must not lag another process's load or
        // erasure, so a segment whose snapshot is not the listed row's is forgotten before the read. The snapshot's
        // version is `<generation>:<row token>` (invariant 1: the row's OCC token is the identity, the number
        // restarts at 0 once a row is purged), so a retired name loaded again is told apart too. Only a segment
        // that differs is re-resolved: one whose row has not moved keeps its snapshot and costs no extra read.
        if (this.crbmSource !== undefined) {
          const held = await this.crbmSource.currentVersion(ref);
          const listed = rec.currentGen === null ? null : `${rec.currentGen}:${String(rec.token)}`;
          if (held !== listed) this.engine.invalidate(ref);
        }
        return (await this.engine.has(ref, id))
          ? { segment: rec.segment, namespace: rec.namespace }
          : null;
      },
    );
    const segments = membership.filter((m): m is SubjectSegmentRef => m !== null);
    return { id, segments, scannedSegments: recs.length };
  }

  /**
   * **Subject erasure (GDPR Art. 17): remove an id from every segment it's in, with the bit physically gone
   * from the bucket on return.**
   *
   * For each **registered** segment the id is a member of, `eraseIdFromSegment` rewrites the current generation
   * without the id — every chunk streamed through, one bit cleared — publishes the rewrite **fenced on the
   * generation it was derived from**, and collects the generation that held the bit. A segment whose current
   * generation does not hold the id is searched anyway, every generation in its bucket: a retained superseded one
   * can still hold it, and so can one above the pointer after a {@link CloudRoaring.rollback}, which the rollback
   * could make current again. Each holder is deleted — below the pointer by a `keep: 0` collection, above it one
   * by one, re-proved against the row first — and the generations above the pointer that never held the id stay
   * as rollback targets. An entry says `erased: true` only once the call has listed the bucket and read what is
   * left: **no generation of the segment holds the id**. The returned per-segment record is your **erasure ledger** —
   * persist it / route it to your audit sink as the proof of deletion (a `segment.rewrite` audit event is also
   * emitted per rewrite when you pass `audit`).
   *
   * Uses the backend's **own** two halves, so the membership check and the rewrite provably run
   * over the same generation. Requires the store built with a **backend** (throws
   * {@link UnsupportedError} otherwise; a pre-built `StorageChunkSource` store has no `IStorageDriver` to write
   * through; build the store on a backend instead).
   *
   * **One contract remains** (an integrator obligation the library cannot check): **do not load the segment
   * while erasing from it.** A load that lands after the rewrite carries whatever its source held, and the
   * library cannot know that source was meant to exclude the id. Quiesce loads of the affected segments for the
   * duration, or fix the source first and load after. A writer that lands *during* the rewrite is caught: the
   * rewrite's publish is refused **by the fence** — the publish lands its compare-and-swap only
   * while the pointer is still on the generation the rewrite streamed — and the entry says `note: 'superseded'`,
   * so re-run. Forward-only alone would NOT refuse it: the rewrite's number goes above everything in the bucket,
   * so the rewrite would out-rank the newer generation and then collect it.
   *
   * A racing **erasure** is caught before that, and reported the same way. It collects with `keep: 0`, taking
   * every generation below its new pointer — the one this rewrite is streaming, and the object this rewrite
   * just wrote — so the loser can find its own inputs deleted mid-flight. That surfaces as an outcome rather than
   * an error, read off the row: a moved pointer is a `'superseded'` entry, which a re-run settles, and a segment
   * that a concurrent `dropSegment` tombstoned or a retention sweep purged is left out of the ledger, as a fresh
   * call would leave it out.
   *
   * **Read `note` on any `erased: false` entry — the two reasons mean different things.** `'superseded'` means
   * another writer (a load, another erasure, or a rollback) moved the pointer mid-call, so **this call** did not
   * erase the id. Re-run: it erases the id if it is still there, and lists nothing for the segment if a racing
   * erasure of the same id already removed it. Do not read `'superseded'` as "the id is still present" —
   * read it as "not done by this call, and the re-run settles it".
   * `` `error: …` `` is a per-segment fault (caught so one segment can't discard the whole ledger) and it can land
   * on either side of the publish: if the rewrite had not published, the id is still there and a re-run erases
   * it; if the publish succeeded and only the **collection** of the old generation failed, the id is already
   * absent from every read and what remains is an object in the bucket that still contains the bit. The same
   * note, after a publish, can mean a rollback moved the pointer back onto a generation that still holds the id
   * while the collection ran — then the id is served again, and the entry says so rather than `erased: true`. A
   * re-run searches every generation in the bucket, so it rewrites or collects what is left and usually reports
   * `erased: true`; {@link SubjectErasureEntry.note} says what else a re-run can report. Re-running is otherwise safe
   * and idempotent: a segment the id is no longer in is not listed. Admin-only path;
   * `O(registered segments + superseded generations)`, no hot-path cost: a segment whose current generation lacks
   * the id is searched generation by generation, one open for each other generation in its bucket, and with the
   * keep-everything default of the `*Into` verbs that is one per generation the segment ever had. The per-op
   * `budget` is charged one unit for each segment and one for each generation opened beyond the one its row names,
   * so a fleet with long histories can exhaust it where the segment count alone would not. A segment that does is
   * reported `erased: false` with an `error:` note, before it deletes anything (the one refusal that can come after a
   * rewrite is the last check for a generation a concurrent writer left behind), and the
   * rest of the scan continues: the call itself does not throw for it. Per-subject crypto-shred is infeasible (a subject's bit is
   * co-mingled in a shared container), so this is the single-subject erasure route; whole-segment/tenant erasure
   * is `dropSegment` / the `destroySegment`/`eraseNamespace` free functions.
   */
  async eraseSubject(
    id: number,
    options: {
      namespace?: string;
      allNamespaces?: boolean;
      audit?: IAuditSink;
      concurrency?: number;
      budget?: BudgetOption;
    } = {},
  ): Promise<EraseSubjectResult> {
    const deps = this.lifecycleDeps('eraseSubject');
    requireScope(options, 'eraseSubject'); // tenancy: explicit namespace, or an { allNamespaces: true } ack
    validateConcurrency(options.concurrency); // fail fast before the (possibly huge) registry scan
    const budget = resolvePerOpBudget(options.budget, this.budget); // partial override inherits the store's tightening
    splitId(id); // fail fast on a non-u32 id even when nothing is registered
    // Bounded incrementally — see subjectReport above. Art. 17 erasure is likewise reachable from ordinary
    // "delete my account" traffic, so the enumeration itself has to respect the budget.
    const recs = await collectWithinBudget(
      excludingReservedRows(deps.registry.list(options.namespace)),
      budget,
      'eraseSubject',
    );
    // The scan charged one unit a segment. A segment whose current generation lacks the id is searched generation by
    // generation, and each open past the current one is charged too, to the same call-wide count. With no budget
    // there is nothing to charge and the drivers are used as they are.
    let opens = 0;
    const charge = (): void => {
      opens += 1;
      checkBudget(budget, recs.length + opens, 'eraseSubject');
    };
    // Bounded fan-out. Each segment is an independent generation, so rewriting distinct segments concurrently is
    // safe. Per-segment faults stay isolated INSIDE each task — one failure never aborts the ledger — and the
    // pool preserves input order, so the ledger stays deterministic.
    const entries = await mapWithConcurrency(
      recs,
      options.concurrency ?? DEFAULT_ADMIN_CONCURRENCY,
      async (rec): Promise<SubjectErasureEntry | null> => {
        if (rec.status === 'destroyed') return null; // already crypto-shredded — nothing to erase
        const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
        try {
          // The rewrite does its own membership check against the CURRENT registry generation — not the
          // engine's cached view, which may lag a load by up to `cache.genTtlMs`. An Art. 17 erasure must never
          // skip a segment because a read cache hasn't caught up yet.
          const result = await eraseIdFromSegment(
            ref,
            id,
            budget === null
              ? deps
              : { ...deps, storage: new OpenChargingStorage(deps.storage, rec.currentGen, charge) },
            { audit: options.audit },
          );
          if (result.reason === 'not-member' || result.reason === 'absent') return null;
          if (result.reason === 'no-generation') return null; // a row with no data yet holds no id
          if (result.reason === 'destroyed') return null;
          return {
            segment: rec.segment,
            namespace: rec.namespace,
            erased: result.erased,
            fromGeneration: result.fromGeneration,
            generation: result.generation,
            note: result.erased ? undefined : result.reason,
          };
        } catch (err) {
          return {
            segment: rec.segment,
            namespace: rec.namespace,
            erased: false,
            note: `error: ${err instanceof Error ? err.message : String(err)}`,
          };
        } finally {
          // Whatever the outcome, this process's own view of the segment is now suspect: a landed rewrite
          // deleted the generation our caches were built on, and a refused one means somebody else's did.
          // Without this the erasing store keeps answering `true` for the id it just reported erased — out of
          // RAM, with no storage read for any control to intercept. `finally`, not the happy path: a rewrite
          // that published and then THREW on its collect is precisely the case where this view is stale, and
          // it is reachable from an ordinary retirement landing mid-call.
          //
          // Swallowed, because a `finally` that throws replaces the outcome above it: it would escape the
          // per-segment catch, abort the whole ledger, and discard the error it was masking — breaking the
          // isolation this fan-out promises. Dropping cache entries cannot fail today; this keeps that from
          // becoming a whole-run failure if it ever can.
          try {
            this.engine.invalidate(ref);
          } catch {
            /* best-effort: never let cache bookkeeping discard a segment's result */
          }
        }
      },
    );
    const erasedFrom = entries.filter((e): e is SubjectErasureEntry => e !== null);
    return { id, erasedFrom, scannedSegments: recs.length };
  }

  /**
   * Every generation still in the bucket for this segment, ascending, with the current one marked.
   *
   * What the bucket holds, not what the segment has ever been — collection deletes superseded objects, so this is
   * the grace window plus whatever has not been collected yet. It is the set {@link CloudRoaring.rollback} can
   * choose from, which is the reason to look at it. One registry read and one listing; it does not open the objects.
   *
   * Needs a backend.
   */
  async generations(ref: SegmentRef): Promise<GenerationEntry[]> {
    validateSegmentRef(ref);
    return listGenerations(ref, this.lifecycleDeps('generations'));
  }

  /**
   * Whether a read of this segment would find anything — the "do I already have this?" question, as one
   * registry point read.
   *
   * There is no `create` in this library: {@link CloudRoaring.segment} is a validated address and does no I/O,
   * so naming a segment can never collide with an existing one. A segment starts existing when something is
   * first loaded into it, and this is how you ask whether that has happened.
   *
   * **Not the same as `count() > 0`.** A segment loaded with no ids exists and counts zero. Distinguishing
   * "never loaded" from "loaded, and genuinely empty" is the thing `count()` cannot do and the reason this
   * exists. It is `false` for a segment whose row was minted ahead of its first load (by `setRetention`) and
   * for a `destroyed` tombstone, because a read answers empty in both cases.
   *
   * Two states answer `true` where a read still gives you nothing: a torn restore (a live pointer whose object
   * was deleted) makes reads of the object *throw* rather than answer empty, while a cold `count()` answers the number
   * its row records — `checkConsistency` is the call for that — and
   * a handle carrying an expired `expiresAt` reads empty by a rule that lives on the handle, not the row.
   *
   * Not a lock: the answer can change the moment it returns. If it has to hold, use the fence built for that —
   * `load`'s `guard`, or `expectFrom`/`expectToken` on a publish. Needs a storage backend.
   *
   * ```ts
   * if (!(await store.exists({ segment: 'users' }))) {
   *   await store.load({ segment: 'users' }, idsFromUpstream);
   * }
   * ```
   */
  async exists(ref: SegmentRef): Promise<boolean> {
    validateSegmentRef(ref);
    return segmentExists(ref, this.requireRegistry('exists'));
  }

  /**
   * Every segment the registry knows about, streamed — optionally scoped to one namespace.
   *
   * The registry is already the list of your segments, which is why you should not keep a second one beside it:
   * a hand-maintained list is a source of truth that drifts from this one the first time a load fails halfway.
   *
   * **An admin/discovery call, not a request-path one.** This is the registry's own enumeration — a paged
   * LIST over the `registry/` prefix — so its cost grows with the size of the fleet rather than with what you
   * are looking for.
   *
   * Scoping to a namespace narrows the LIST prefix, so it really is the difference between reading one tenant
   * and reading all of them.
   *
   * It streams, and stopping the iteration stops the scan. It reads the registry directly and is not retried: a
   * transient fault part-way through ends the loop with that error, and calling `segments()` again scans from the
   * start.
   *
   * Yields `destroyed` tombstones and rows with `currentGen: null`, because a filtered enumeration that looks
   * complete is worse than an honest one — filter on `status`/`currentGen` yourself, or ask
   * {@link CloudRoaring.exists} the narrower question. Needs a storage backend.
   *
   * ```ts
   * for await (const s of store.segments({ namespace: 'active-daily' })) {
   *   console.log(s.segment, s.currentGen, s.status);
   * }
   * ```
   */
  segments(options: { namespace?: string } = {}): AsyncIterable<SegmentInfo> {
    if (options.namespace !== undefined) {
      // Synchronously, at the call, where `listSegments` (an async generator, which refuses the reserved
      // namespace too for a direct caller) would only throw at the first iteration.
      validateSegmentRef({ segment: 'x', namespace: options.namespace });
      refuseReservedNamespace(options.namespace);
    }
    return listSegments(this.requireRegistry('segments'), options);
  }

  /**
   * Move this segment's pointer **back** to a generation still in the bucket — the one write in the library that
   * is not forward-only.
   *
   * Forward-only is right for a writer: a load whose ids came from upstream loses nothing by being out-raced, and
   * letting it regress would let a slow loader silently undo a fast one. It is wrong for an operator who has
   * looked at the segment, decided the current generation is wrong, and knows which one they want. So this is
   * reachable only by asking for it by name — no sweep, retry or reconciliation calls it — and it is audited
   * (`segment.rollback`), because every other pointer move can be reconstructed from "a load happened" and this
   * one cannot.
   *
   * It refuses rather than guesses: a generation not in the bucket (collected, or never written) throws
   * `NotFoundError` naming what *is* available, a crypto-shredded segment throws
   * {@link ValidationError} because every generation of it is unreadable, and a target that is cleartext under an
   * encrypted segment, or encrypted under a cleartext one, throws {@link IntegrityError} from one tail read of it,
   * because every read would refuse it. Rolling to the generation already current is a no-op that reports itself.
   *
   * The same tail read (and a range read when the target's index is longer than it) gives the target's id count and
   * metadata, which the rollback writes into the row with the pointer, so a reader that sees the target as current sees
   * what describes it. The store's keystore opens an encrypted target for this; without it, or when it cannot open the
   * key for any reason, the segment still rolls back and the row carries no summary of the target.
   *
   * It deletes nothing. The generations above the new pointer stay put — which is what makes this reversible —
   * and are then *above* `currentGen`, where collection never looks. They remain until loads pass them (the first
   * load whose number one of them holds numbers above them all, and collection then keeps the newest `keep` of what is
   * below its pointer), {@link CloudRoaring.dropSegment}
   * deletes them, or {@link CloudRoaring.eraseSubject} does: all of those present when it rewrites, and only those holding
   * the id when the current generation does not. An operator who has just undone a bad load should not have the
   * evidence collected out from under them, while a rollback target that still holds erased data would make the
   * erasure undoable.
   *
   * A target **above** the pointer needs `{ allowForward: true }`, and is refused with {@link ValidationError}
   * without it: that is also where objects live that were never published, such as a load that wrote its object
   * and died before the publish. Undoing an earlier rollback is what the opt-in is for.
   *
   * Needs a backend.
   */
  async rollback(
    ref: SegmentRef,
    toGeneration: number,
    options: { audit?: IAuditSink; allowForward?: boolean } = {},
  ): Promise<RollbackResult> {
    validateSegmentRef(ref);
    const deps = this.lifecycleDeps('rollback');
    try {
      return await rollbackSegment(ref, toGeneration, deps, options);
    } finally {
      // The pointer moved under this store's cached view — and unlike a load, it moved to content the caches may
      // still be holding from before. Drop it either way.
      this.engine.invalidate(ref);
    }
  }

  /**
   * **Replace this segment's contents** with `input`, as one new immutable generation, and make it current.
   *
   * `input` is ids (any sync or async iterable of integers in `[0, 2^32)`), or a whole bitmap: `{ bitmap }`, anything
   * with `serialize('portable')` such as `roaring`'s `RoaringBitmap32`, or `{ serialized }`, portable Roaring bytes.
   * A bitmap is checked (size cap, structure, safe deserializer) before the first request, written from its own
   * containers with no per-id work, and gives the generation byte for byte the one its ids would. A bare
   * `RoaringBitmap32` passed as ids loads as `{ bitmap }`. A `Uint8Array` or `Buffer` passed as ids is refused with
   * `ValidationError`, since each byte would load as an id: pass bytes as `{ serialized }`.
   *
   * The whole write path in one call: take the next generation number, write the object, check the result is
   * plausible, move the pointer, collect what the move superseded. Composed by hand those are four functions and
   * the one that gets left out is the last, so segments quietly accumulate superseded generations nobody pays
   * attention to and everybody pays for.
   *
   * ```ts
   * const r = await store.load({ segment: 'audience:active' }, idsFromWarehouse, {
   *   guard: { minRetained: 0.5 }, // refuse a load that would drop more than half the segment
   * });
   * if (!r.published) console.warn(`load refused: ${r.reason}`);
   * ```
   *
   * `metadata` attaches a small record of your own to the generation: a flat object of string keys and string or finite
   * number values, at most 1,024 bytes as canonical JSON and no key over 128 bytes. A record that breaks a rule throws
   * `ValidationError` before the load makes a request. It is copied when you call, stored in the generation's object,
   * and written to the segment's row with the generation's id count by the write that moves the pointer, so a reader
   * that sees the generation as current sees its metadata. It never changes after that, a rollback puts the target's own
   * back, and an erasure carries it over without scanning it, so keep a subject's id out of it. It is sealed under the
   * segment's key on an encrypted segment.
   *
   * **A load REPLACES.** Whatever the stream contains is what the segment contains afterwards, so an upstream
   * query that returns fewer rows than usual is a shrink nobody asked for and an empty one is a wipe — both
   * reported as a successful write, because at the storage layer they are one. That is what `guard` and the
   * default empty refusal are for, and why they run **between** the write and the publish: the only moment where
   * the new content is known and the old one is still authoritative.
   *
   * **Branch on `published`.** A refusal is a normal outcome, not an exception — `published: false` with a
   * `reason`, in the same shape as a success — so a discarded result is a load that silently did nothing, and
   * with the empty guard on by default this verb refuses more readily than any other. Note the sibling `*Into`
   * verbs *throw* on the same superseded condition rather than reporting it; this one follows
   * `eraseIdFromSegment` instead, because three of its four refusals are expected guard outcomes rather than
   * faults.
   *
   * `'superseded'` means another writer got there first: another load took the same generation number, so this
   * one wrote nothing (`size: 0`), or the segment's registry row changed while the load was writing — another load
   * published, a retention change, a rollback or an erasure wrote the row, or the row was deleted.
   *
   * A refused load deletes the object it wrote before returning — it sits above `currentGen`, where generation
   * collection deliberately never looks — but only while the segment's registry row is unchanged or gone. Once
   * another write has changed the row, the generation number it holds may name another incarnation's live object,
   * so it leaves the orphan rather than risk deleting live data. No row's list names it, so it takes no place in a
   * window, and a listing deletes it once a later generation is current above it.
   *
   * **Collection is by name at any `keep` up to 64.** The segment's row records the generations a load keeps, so a load
   * that found nothing above the pointer deletes the generations its publish pushed out of the window and lists
   * nothing. It lists the segment's objects on every sixteenth generation, and on any load that met an object above the
   * pointer or whose check found the current generation's object gone, to take what the name-only passes leave, such as
   * an object a crashed load left below the pointer. A `keep` above 64 records no list and lists on every load, and so
   * does the first load of a row that records none, which then records it. {@link LoadResult.collected} then names
   * what the pass deleted by name, and one name may have been gone already.
   *
   * What it **throws** for is a fault rather than an outcome: invalid options or ids, and a crypto-shredded
   * segment (`ValidationError`); a key the keystore cannot provide (`KeyUnavailableError`); a current generation
   * that will not open when a guard has to read its size, which it does only when the row has no usable summary of it
   * (`IntegrityError`); a driver failure; and a fault in the collection's own reads, listing or deletes, or in the write
   * that records the window (anything but a lost race). A collection fault can be raised **after** the publish already
   * landed, so a throw does not by itself mean the load did not take effect — re-read the pointer rather than assuming.
   * A collection, by name or by listing, that finds another writer has moved the row since the publish (a load, a
   * rollback, a purge) stops and returns what it deleted in `collected`: a load that took effect does not throw for a
   * race it won.
   *
   * **A `TransientError` from the registry write can leave the publish unsettled, and deletes nothing.** The
   * generation's object is sent again after a throttle where the backend allows it (a write id tells a first send
   * that landed from another writer's object), and a driver sends each registry write once. When that write ends
   * without an answer, the load reads the row: its own landed write is `published: true`, a row that has moved on is
   * `superseded`, and a row still as the write found it gets a fresh compare-and-swap from the version just read, at
   * most three times, after a wait on the store's clock. Still unanswered, the load throws the registry's `TransientError` and keeps its object, which
   * a write may still point the row at. Re-run the load: it numbers past that object, and collection removes it once a
   * generation above it is current. A `'superseded'` refusal that follows an unanswered write sets `unanswered: true`
   * on its audit event: that write may have landed, and the generation been current for a while, first.
   *
   * Needs a backend (throws {@link UnsupportedError} otherwise).
   */
  async load(ref: SegmentRef, input: LoadInput, options: LoadOptions = {}): Promise<LoadResult> {
    validateSegmentRef(ref);
    const deps = this.lifecycleDeps('load');
    try {
      return await loadSegment(ref, bitmapAsLoadInput(input), deps, options);
    } finally {
      // This store's view of the segment is now behind whatever just happened — a published load superseded the
      // generation the caches were built on, and a throw can still have published before failing its collect.
      // `finally`, so the one path where the view is most likely stale is not the one path that skips the drop.
      this.engine.invalidate(ref);
    }
  }

  /**
   * **Dispose of a segment — tombstone it, then delete its storage objects.** Irreversible.
   *
   * The operation a rolling window needs: `destroySegment` crypto-shreds (bytes unreadable everywhere including
   * backups, but still sitting in your bucket and still billed, and it requires encryption), while this one
   * removes the storage and works on a cleartext segment. On an encrypted segment it does both.
   *
   * Pass `{ dryRun: true }` first — it reports the generations it *would* delete and changes nothing. That
   * matters more than the `confirmSegment` guard for anything automated, because in a loop the guard is the same
   * variable twice.
   *
   * ```ts
   * for (const day of expiredDays) {
   *   // The family in the namespace, the date in the segment — `registry.list(namespace)` then enumerates
   *   // exactly this family's buckets, which a flat `active:2026-08-01` name cannot do without string-matching.
   *   const ref = { namespace: 'active-daily', segment: day };
   *   await store.dropSegment(ref, { confirmSegment: ref.segment });
   * }
   * ```
   *
   * **Omitting the namespace addresses a different segment and is a silent no-op** — you get
   * `{ dropped: false, reason: 'absent' }`, not a throw, so a retention loop with that mistake deletes nothing
   * forever and quietly. Branch on `dropped`, and treat `reason: 'absent'` as the alert.
   *
   * **Inspect `generationsRemaining`.** Empty is the normal outcome; non-empty means the storage was NOT fully
   * reclaimed and the drop should be re-run. A load that had read the segment before the tombstone landed, whether it
   * was writing or still consuming its ids, can still write its object, so a single sweep can miss it — this call
   * re-sweeps and then reports whatever it still could not remove rather than returning a result that looks like a
   * clean drop. A load that writes after the last sweep deletes its own object once its publish is refused; only one
   * whose process stops in between, or whose publish fails without a definite answer (a lost response, a timeout),
   * leaves it, for a re-run of the drop.
   *
   * Reads become empty within `cache.genTtlMs` (default 2 s), not instantly: a store that had already read this
   * segment may answer from its cached generation + cached chunks until that window lapses, or, while the registry
   * cannot be read because of a transient fault, until a retry 500 ms apart reaches it again. A reader that never
   * touched it sees empty at once. **That bound needs a registry and `cache.genTtlMs > 0`.** A store with no registry
   * (a bare `IStorageDriver`), with `cache.genTtlMs: 0`, or on a storage source built with no clock, has no timed
   * refresh. It notices the drop only when a read has to fetch
   * from a deleted generation or its reader cache evicts the segment, and until then a chunk it has cached
   * answers without reaching storage, so it can keep answering `true` for a dropped segment indefinitely. Tell
   * it with {@link invalidate}, or restart it.
   *
   * Needs the store built with a **backend** (throws {@link UnsupportedError} otherwise),
   * because it has to enumerate and delete generations — a pre-built `StorageChunkSource` only reads.
   */
  async dropSegment(
    ref: SegmentRef,
    options: { confirmSegment: string; dryRun?: boolean; audit?: IAuditSink },
  ): Promise<DropResult> {
    validateSegmentRef(ref);
    const deps = this.lifecycleDeps('dropSegment');
    try {
      return await dropSegment(ref, { registry: deps.registry, storage: deps.storage }, options);
    } finally {
      if (options.dryRun !== true) this.engine.invalidate(ref);
    }
  }

  /**
   * **Record when this segment becomes eligible for retirement.** One registry write; nothing is deleted here,
   * and nothing starts running. `retireExpired` is what acts on the policy, and **you** decide when that runs —
   * an EventBridge rule, a CronJob, a queue consumer, whatever your deployment already has. This library starts
   * no background thread (it has to work identically in a Lambda, an edge isolate and a long-lived server).
   *
   * `expiresAt` is an **absolute epoch-ms you compute**, not a duration the library derives. A relative TTL would
   * have to be anchored to something the library knows — `updatedAt`, or the current generation — and every load
   * rewrites both, so "expire 30 days after the last write" would keep a busy daily bucket alive forever
   * precisely because it is being reloaded.
   *
   * ```ts
   * const DAY = 86_400_000;
   * const ref = { namespace: 'active-daily', segment: '2026-08-05' };
   * await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY });
   * ```
   *
   * **Works before the first load**: a segment with no registry row yet gets one (`createdRow: true` in the
   * result) with **no Storage generation**, so the policy is recorded ahead of the data and the segment is already
   * enumerable by the sweep; the first load then publishes onto that row.
   *
   * A value in the past is legal and means "eligible on the next sweep" — backfilling a policy onto existing
   * buckets is normal. A value below `MIN_EXPIRES_AT_MS` (2001-09-09) is rejected: it is almost certainly epoch
   * **seconds**, which would read as long-expired and retire the segment on the next pass. Needs a storage
   * backend (throws {@link UnsupportedError} otherwise), and refuses a crypto-shredded segment.
   */
  async setRetention(ref: SegmentRef, policy: RetentionPolicy): Promise<SetRetentionResult> {
    validateSegmentRef(ref);
    return setSegmentRetention(ref, { registry: this.requireRegistry('setRetention') }, policy);
  }

  /**
   * **The stored retention policy**, or `null` if the segment has none (or has no registry row, or is a
   * tombstone). Returns the string `'invalid'` for a row whose `expiresAt` is present but unusable — a
   * hand-edited row, or one from a restore — so a malformed policy is visible rather than silently reading as
   * "never expires" on a segment someone believes is expiring.
   */
  async getRetention(ref: SegmentRef): Promise<RetentionPolicy | null | 'invalid'> {
    validateSegmentRef(ref);
    return getSegmentRetention(ref, { registry: this.requireRegistry('getRetention') });
  }

  /**
   * **Cancel a segment's expiry** so no sweep retires it. Returns whether a policy was actually removed (`false`
   * when there was none). A separate verb from `setRetention` on purpose: "never expire" as a magic value passed
   * to the setter is how a typo becomes a deletion.
   */
  async clearRetention(ref: SegmentRef): Promise<boolean> {
    validateSegmentRef(ref);
    return clearSegmentRetention(ref, { registry: this.requireRegistry('clearRetention') });
  }

  /**
   * **Run the retention sweep: retire every segment whose `expiresAt` has passed.** This is the call that acts on
   * the policies `setRetention` records — and it is a **call, not a daemon**. Nothing schedules it; you run it from
   * whatever heartbeat your deployment already has (an EventBridge rule, a Kubernetes CronJob, a queue consumer,
   * the job that runs your loads). A library that started a timer would behave differently in a Lambda, an edge
   * isolate and a long-lived server, which is worse than not having one.
   *
   * Each retirement goes through `dropSegment`, so the registry → Storage ordering, the re-sweep for an object a
   * load was still writing, and the `generationsRemaining` report all come from one implementation rather than
   * two.
   *
   * ```ts
   * // In your scheduled handler. Start with a preview in a new deployment.
   * const preview = await store.retireExpired({ namespace: 'active-daily', dryRun: true });
   * console.log(`would retire ${preview.wouldRetire} of ${preview.scanned} (limited: ${preview.limited})`);
   *
   * const swept = await store.retireExpired({ namespace: 'active-daily' });
   * for (const e of swept.entries) {
   *   if (e.action === 'skipped') console.warn(`${e.segment}: ${e.reason}`); // invalid-policy / limit / failed: …
   *   if (e.action === 'retired' && e.result.generationsRemaining.length > 0) {
   *     console.warn(`${e.segment}: storage not fully reclaimed — re-run`);
   *   }
   * }
   * if (swept.limited) scheduleAnotherPassSoon(); // more are still eligible
   * ```
   *
   * **Read the ledger.** A per-segment *fault* is an entry, not an exception — a throw from the middle of a fleet
   * sweep would leave the caller unable to say which segments were retired, having already retired some. (A bad
   * argument does throw, and so does a fleet larger than `maxScanSegments`.) `limited: true` means the per-cycle
   * `limit` (default 100) cut the pass short and more are eligible. That cap is charged on **attempts**, not
   * successes, which is what makes it a real bound: `dropSegment` writes the tombstone before sweeping Storage, so a
   * fault in the Storage phase is a segment that is already retired. Retirements are sequential, so `limit` is a
   * wall-clock knob too, and `retired` counts deletions only — a dry run reports `wouldRetire` instead, so a
   * dashboard summing `retired` can never show a phantom deletion.
   *
   * **Check `purgeFaults`.** A delete the registry refuses for a reason other than a lost race (a policy that denies
   * delete, an Azure blob with a snapshot, a raw provider error), whether of a tombstone or of a due-index pointer, is
   * counted there, with the first one's reason in `firstPurgeFault`. A refused purge is `skipped` in the ledger, is not
   * charged to `limit`, so it never holds the retirements behind it, and purging stops for the rest of the call after
   * three refused purges in a row (a purge that succeeds starts the count again).
   *
   * It also **deletes the tombstone rows its own past retirements left**, after `tombstoneGraceMs` (default 24 h)
   * and only once that segment's Storage generations are provably gone — collecting a straggler generation itself
   * first, since nothing else ever would for a tombstoned segment. Attribution is a **positive marker the sweep
   * stamps on its own retirements**, not an inference from "destroyed + an expired policy": a crypto-shred leaves
   * `retention` untouched, so setting a policy and then honouring a right-to-erasure request mid-window produces
   * exactly that row, and deleting it would destroy the Art. 17 attestation and un-fence the name. By default a
   * segment that held nothing has its row deleted in the pass that retires it, since that row would only fence the name.
   * Pass `purgeTombstones: false` to keep every tombstone, that row included. On a backend whose registry reports
   * `conditionalDelete` (AWS S3, Azure Blob, the local filesystem and memory, by default; GCS when you set `conditionalDelete: true`)
   * the purge removes the row from the bucket for good, by a delete the store applies only to the version it judged,
   * so a full sweep reads what is live or inside its grace rather than every name a namespace ever held; elsewhere,
   * and for a row a release before 0.12 wrote, it leaves a tombstone. Each retirement files a pointer in the due index
   * under the day its tombstone's grace ends, so `scan: 'index'` purges as well as retires.
   *
   * Needs the store built with a **backend** (throws {@link UnsupportedError} otherwise),
   * because retiring a segment deletes its storage objects. `now` defaults to the store's clock.
   */
  async retireExpired(
    options: Omit<RetireExpiredOptions, 'now'> & { now?: number } = {},
  ): Promise<RetireExpiredResult> {
    const deps = this.lifecycleDeps('retireExpired');
    const result = await retireExpired(
      { registry: deps.registry, storage: deps.storage },
      { ...options, now: options.now ?? this.clock.now() },
    );
    // A retirement tombstones and reclaims segments this store may already have resolved. `dryRun` changes
    // nothing, so it invalidates nothing.
    if (options.dryRun !== true) {
      for (const entry of result.entries) {
        this.engine.invalidate({ segment: entry.segment, namespace: entry.namespace });
      }
    }
    return result;
  }

  /**
   * **Forget everything this store has cached about a segment.** Use it after destroying or retiring a segment
   * through a path this store did not perform itself.
   *
   * A store keeps two layers of derived state — a resolved snapshot per segment (an open `.crbm` reader, plus
   * the DEK it unwrapped) and decoded chunks keyed by generation. Both are built for one event: **a publish
   * that advances `currentGen`**, which the snapshot TTL notices and the generation-keyed cache misses on.
   * Neither notices an event that *destroys* what they were derived from.
   *
   * The store's own writes handle themselves: `load`, `rollback`, `eraseSubject`, `dropSegment` and `retireExpired`
   * here, and a segment's `*Into` verbs, invalidate what they touch. This method is for the cases they cannot see:
   *
   * - **`destroySegment` / `eraseNamespace`**, which are free functions over raw drivers rather than methods
   *   here, so a crypto-shred performed beside this store invalidates nothing in it. It keeps its open reader and
   *   the unwrapped DEK, and decrypts with them, chunks it had never fetched before the shred included, until its
   *   snapshot re-resolves: within `cache.genTtlMs` when the store has a registry and a `genTtlMs` above 0, and
   *   otherwise only when its caches let the segment go or a read has to fetch from a generation a sweep collected.
   *   A pin answers with no timed bound, until it is told or both caches let it go.
   * - **Another process.** Erasing on one box invalidates nothing on the others; each store bounds its own
   *   staleness by `cache.genTtlMs`, and a store with no registry (a bare `IStorageDriver`), with
   *   `cache.genTtlMs: 0`, or on a storage source built with no clock has no bound at all: it converges only when a read happens to miss its caches. If a compliance deadline depends on every
   *   reader converging, you need to signal them — this is the call to make when your own fan-out delivers.
   *
   * It also forgets any replacement this store found of a pin's object, so once it is called after a restore puts that
   * object back, the pin reads it again.
   *
   * Synchronous, best-effort, and safe to call for a segment this store has never read.
   *
   * ```ts
   * await destroySegment(ref, { registry: backend.registry }, { confirmSegment: ref.segment });
   * store.invalidate(ref);                       // this process
   * await bus.publish('cloudbitmaps.invalidate', ref); // and every other one
   * ```
   */
  invalidate(ref: SegmentRef): void {
    validateSegmentRef(ref);
    refuseReservedNamespace(ref.namespace);
    this.engine.invalidate(ref);
  }

  /**
   * Build a handle held at the generation `ref` resolves to right now. See {@link Segment.pin}.
   *
   * The pinned handle gets its own engine but **shares the store's chunk cache**, under keys of its own: the
   * pinned view reports the version captured at pin time, marked as a pin's, so its decoded chunks are never
   * those of a live read that fetched across a publish (see {@link PinnedStorageChunkSource.currentVersion}).
   */
  private async pinSegment(ref: SegmentRef, expiresAt?: number): Promise<Segment> {
    const crbm = this.crbmSource;
    if (crbm === undefined) {
      throw new UnsupportedError(
        'pin() needs the `.crbm` storage source — pass a backend or a raw IStorageDriver as `storage` (a pre-built StorageChunkSource ' +
          'that cannot resolve a generation has nothing to pin)',
      );
    }
    // Under the store's retries, as its reads are: a transient fault resolving the pin must not fail pin().
    const at = await this.withRetries(() => crbm.pinGeneration(ref));
    const pinnedAt: PinnedAt = {
      generation: at?.generation ?? null,
      version: at?.version ?? null,
      fingerprint: at?.fingerprint ?? null,
    };
    const pins = new Map([[segmentKey(ref), pinnedAt]]);
    return makeSegment({
      engine: this.engineWithPins(pins),
      ref,
      clock: this.clock,
      metrics: this.metrics,
      materialize: (dest, ids, op, options) => this.materialize(dest, ids, op, options),
      pinned: (r, e) => this.pinSegment(r, e),
      combineEngine: (handles) => this.engineForCombine(handles),
      expiresAt,
      pinnedAt,
    });
  }

  /**
   * An engine reading every segment in `pins` at its pinned generation and everything else live, with the store's
   * retries, so a transient fault on a pinned read is retried as it would be on a live one.
   *
   * It **shares the store's chunk cache and its memory bound**, under keys of its own for each pinned segment.
   */
  private engineWithPins(pins: ReadonlyMap<string, PinnedAt>): SegmentEngine {
    const crbm = this.crbmSource;
    if (crbm === undefined) {
      throw new UnsupportedError(
        'pin() needs the `.crbm` storage source — pass a backend or a raw IStorageDriver as `storage` (a pre-built StorageChunkSource ' +
          'that cannot resolve a generation has nothing to pin)',
      );
    }
    const pinned = new PinnedStorageChunkSource(crbm, pins);
    return new SegmentEngine({
      storage:
        this.retryOptions === undefined
          ? pinned
          : new RetryingStorageChunkSource(pinned, this.retryOptions),
      cache: this.cache,
      codec: roaringCodec,
      clock: this.clock,
      metrics: this.metrics,
      budget: this.budget,
    });
  }

  /**
   * The engine a combine should run on, given the handles involved.
   *
   * A pinned handle passed as an **operand** must still be read at its pin. Routing by "which handle the call
   * was made on" reads it live instead — `snap.intersect([other])` honours the pin while
   * `other.intersect([snap])` silently does not, and the two are the same question. So the combine collects
   * every pin in play and runs on an engine that honours all of them. With no pins anywhere this is the
   * store's own engine and costs nothing.
   *
   * One engine reads a segment at one generation, so a combine that holds the same segment at two — two pins of
   * it, or a pin and a live handle — is refused. Keeping one of them would answer the question for the wrong
   * instant, and say nothing: diffing two snapshots of a segment returned no ids at all.
   */
  private engineForCombine(handles: readonly Segment[]): SegmentEngine | undefined {
    // A combine that pins nothing — nearly every one — cannot hold a segment twice at two generations, so it pays
    // one pass over its handles and nothing more.
    if (!handles.some((h) => h.pinnedAt !== undefined)) return undefined;
    const pins = new Map<string, PinnedAt>();
    const held = new Map<string, PinnedAt | undefined>();
    for (const h of handles) {
      const key = h.key();
      const at = h.pinnedAt;
      if (held.has(key)) {
        const before = held.get(key);
        if (!samePin(before, at)) {
          throw new ValidationError(
            `the same segment is in this combine twice, ${twoPins(before, at)}: one call reads a segment at one ` +
              'generation, so materialise one of them into a segment of its own first, with ' +
              '`intersectInto(dest, [])`',
          );
        }
      } else {
        held.set(key, at);
      }
      if (at !== undefined) pins.set(key, at);
    }
    return this.engineWithPins(pins);
  }

  /** `op` under the store's retries, as the store's own reads run; bare when the store has retries off. */
  private withRetries<T>(op: () => Promise<T>): Promise<T> {
    const r = this.retryOptions;
    return r === undefined ? op() : withRetry(op, r.policy ?? DEFAULT_RETRY_POLICY, r);
  }

  /** The store's registry, or a typed error naming the operation that needs one. */
  private requireRegistry(op: string): IRegistryDriver {
    if (this.registry === undefined) {
      throw new UnsupportedError(
        `${op} needs a storage backend — S3Storage, GcsStorage, AzureBlobStorage, LocalFsStorage or ` +
          `MemoryStorage. A bare IStorageDriver has no generation pointer to publish through, and there is ` +
          `no separate \`registry\` option: a backend carries it.`,
      );
    }
    return this.registry;
  }

  /**
   * **Cross-tier DR consistency check.** After a restore/failover, verify every registered segment's `currentGen`
   * actually has its `.crbm` present in Storage — catching a **torn restore** where the registry (`currentGen`) came
   * back ahead of the object store, so a pointer references a generation that isn't there (reads would then
   * throw). Read-only, bounded fan-out; run it at startup after a restore. Returns `{ checked, inconsistent,
   * errored }` — `inconsistent` empty ⇒ coherent; otherwise it names the segments to recover (restore the object
   * store, or roll the registry back to a coherent point). Needs the store built with a **backend**
   * (throws {@link UnsupportedError} otherwise). `destroyed` (crypto-shredded) segments are skipped. Pair it with
   * the DR runbook (docs/guide/disaster-recovery.md).
   *
   * A segment whose pointer names a missing object is the torn restore this reports; a cold `count()` of it still
   * answers the number its row records, while a read of the object throws, so the count alone never shows it. With
   * `summaries: true` it also opens each segment's current object (one tail read each) and reports a segment whose
   * row's summary says another id count or metadata than the object holds as `summary-mismatch`, which is what a
   * restore of the registry from another point than the bucket leaves a count to answer. A sealed summary is held
   * against its object when this store has the key, and counted in `summariesUnchecked` when it does not.
   *
   * It holds the registry rows it enumerates resident, at most 250,000 of them, and throws
   * `BudgetExceededError` past that rather than report a partial scan as a whole one. This method takes no
   * ceiling of its own: narrow the scan with `namespace`, or call `runConsistencyCheck` over the backend's
   * `storage` and `registry` with a higher `maxScanSegments`.
   */
  async checkConsistency(
    options: { namespace?: string; concurrency?: number; summaries?: boolean } = {},
  ): Promise<ConsistencyReport> {
    const deps = this.lifecycleDeps('checkConsistency');
    return runConsistencyCheck(
      { storage: deps.storage, registry: deps.registry, keystore: deps.keystore },
      options,
    );
  }

  /**
   * **Export ("eject") every registered segment's current generation** through the injected `sink`, using only
   * public read APIs — so your data is readable **without CloudRoaring** (the exit path; see the README's "Your
   * data stays yours"). `format: 'roaring'` (default) writes one **portable RoaringBitmap32** per segment
   * (loadable by any roaring library); `'ndjson'` writes newline-delimited ids (zero-dependency, streaming).
   * Enumerates via the store's **own** registry (needs one — throws {@link UnsupportedError} otherwise) so the
   * enumeration and the read path provably share one registry. Encrypted segments are decrypted transparently
   * **iff** this store was wired with their keystore — the export is therefore **cleartext**; protect it.
   * Crypto-shredded segments are skipped. A segment that can't be read is isolated into the manifest's `failed[]`
   * (the run continues), so "a manifest exists" means the run finished — check `failed`. The `export-segments`
   * CLI wraps this with a filesystem sink.
   */
  async exportSegments(sink: ExportSink, options: ExportOptions = {}): Promise<ExportManifest> {
    const registry = this.requireRegistry('exportSegments');
    // Pass the codec: core's `runExport` is codec-agnostic and needs one for the `'roaring'` format.
    return runExport(this, registry, sink, {
      ...options,
      codec: options.codec ?? roaringCodec,
    });
  }

  /**
   * Planning cost estimate — pure, no instance/data needed: sizing, sales, what-if. For a real, grounded report
   * from live segment sizes, use `store.segment(name).costReport()`. See {@link CostReport}.
   */
  static estimateCost(input: EstimateInput): CostReport {
    return estimateCost(input);
  }
}

/**
 * Options common to every chunk-aligned combine (`intersect` / `union` / `andNot`), and the `*Into` verbs.
 *
 * The range, `after` and `through`, applies to every operand and every `exclude`: the combine yields only the ids
 * in `(after, through]` and fetches only the chunks the range overlaps, as {@link Segment.iterate} does.
 */
export interface BaseCombineOptions extends IdRange {
  /**
   * How far ahead each operand is read: a positive integer, default 32. The library's own stores read each operand as
   * one stream of coalesced ranges (chunks that sit near each other are one request), and `concurrency` is how many
   * range requests a stream holds ahead of the read, in flight or landed and not yet used. So about
   * `concurrency × operands` requests are in flight at most, and, since a range is at most 1 MiB (one chunk, when a chunk
   * is larger), about `concurrency × operands` MiB are held, whatever the segment's size. The stream opens 4 ranges wide
   * (or `concurrency`, if lower) and widens as ranges are taken, so a read that stops early has asked for little past
   * where it stopped, and a read that fits one range makes one request however many chunks it needs. A source that
   * reads chunk by chunk (a custom one) is read as before: `concurrency` chunk keys at once, opening 8 wide. A running
   * stream holds its operand's reader outside the reader cache's bounds until it ends or the segment moves on.
   */
  readonly concurrency?: number;
  /** Override the store's per-op denial-of-wallet budget for this call (`false` lifts it). */
  readonly budget?: BudgetOption;
  /**
   * Allow an operand naming a segment that does not exist. Default `false`: a combine **refuses** one, because
   * a misspelled or mis-namespaced operand is indistinguishable from a correct one in the result.
   *
   * Reading a segment that does not exist answers empty, and that is right — but passing one as an operand is
   * different. A suppression list with nobody on it correctly suppresses nothing; one whose `namespace` you
   * omitted *silently* suppresses nothing, and the result is not obviously-empty, it is the full audience and
   * plausibly right. The failure mode is mailing the people who opted out.
   *
   * ```ts
   * // `global-opt-out` lives in the `suppression` namespace. This addresses a DIFFERENT segment:
   * audience.andNot([store.segment('global-opt-out')]);          // throws ValidationError
   * audience.andNot([store.segment('global-opt-out', { namespace: 'suppression' })]); // correct
   * ```
   *
   * Set `true` when you genuinely intend to combine against a name that may not exist yet. Checked only for an
   * operand that resolved to no chunks at all, so a normal combine pays nothing for it.
   */
  readonly allowAbsentOperands?: boolean;
}

/**
 * A combine that can also subtract.
 *
 * `exclude` is why suppression does not need an intermediate segment: applied here it folds into the same
 * chunk-aligned pass, and each exclude is read **only at the keys that survived** — so a large global opt-out
 * list costs reads proportional to the audience, not to itself.
 */
export interface CombineOptions extends BaseCombineOptions {
  /**
   * Segments whose ids are subtracted from the result. An **expired** handle here excludes nothing, in every
   * combine — it is skipped without being read, exactly as in {@link Segment.andNot}.
   */
  readonly exclude?: Segment[];
}

/**
 * A combine that WRITES its result — the extra options `intersect`/`union`/`andNot` have no use for.
 *
 * Separate from {@link CombineOptions} on purpose: `allowEmpty` and `guard` decide whether a generation is
 * published, and a read verb publishes nothing. Offering them on `intersect()` would be offering a parameter
 * that cannot do anything.
 */
export interface MaterializeOptions extends CombineOptions {
  /**
   * Audit sink. A materialisation publishes a generation, and a publish is an auditable event
   * (`segment.publish`, exactly as a load emits) — as is a refusal (`segment.load-refused`).
   *
   * It is on the call rather than on the store because that is where every other auditable operation takes it
   * (`eraseSubject`, `dropSegment`, `retireExpired`): the caller who performs the act decides where the record
   * goes. Without it a `*Into` would be the one write path in the library that could make a generation current
   * and leave no trace in the compliance trail.
   *
   * It sits HERE rather than on {@link BaseCombineOptions} for the reason this type exists: the streaming verbs
   * write nothing, so an audit sink on `intersect()` would be a parameter that could not do anything.
   */
  readonly audit?: IAuditSink;
  /**
   * Publish an empty result over a non-empty destination. Off by default, exactly as on {@link CloudRoaring.load}:
   * an empty combine is far more often a mistake upstream — a typo'd operand, a segment that has not loaded
   * yet, an `exclude` that swallowed everything — than an intent, and once it lands it is indistinguishable
   * from a correct run.
   */
  readonly allowEmpty?: boolean;
  /** Refuse an implausible result rather than publish it. Same bounds, and same meaning, as on `load()`. */
  readonly guard?: LoadGuard;
  /**
   * Metadata for the generation this call publishes, under the rules and with the meaning of
   * {@link LoadOptions.metadata}: small, immutable, published with the pointer, never a subject's id. A value that
   * breaks a rule throws {@link ValidationError} before any request is made.
   */
  readonly metadata?: GenerationMetadata;
  /**
   * Generations to keep below the new pointer — see {@link LoadOptions.keep}. A value that is not a non-negative
   * integer throws `ValidationError`.
   *
   * **Defaults to keeping everything**, unlike `load()`, which keeps 1 and collects what it supersedes. An operator's
   * recovery story can depend on a materialisation collecting nothing: `rollbackSegment` refuses a target that
   * has been collected. Pass a number to collect on the way through; `0` keeps only the
   * generation this call publishes. It collects by listing the destination, so it clears every generation below the
   * new one beyond `keep`, however many earlier calls kept, where a `load()` deletes by name the generations its
   * publish pushes out of the window.
   */
  readonly keep?: number;
}

/**
 * What a streaming read returns: the ids, ascending, one at a time under `for await`, or one chunk at a time from
 * {@link IdStream.batches}.
 *
 * It is an `AsyncIterable<number>`, so every consumer of an id stream takes it as it always did. A live read is the
 * engine's async generator itself, with `batches` attached: `for await` it, or drive it with `next()`, `return()` and
 * `throw()`, exactly as before, and it is single-use (a second `for await` over it yields nothing). `batches()` is a
 * separate, new read: it starts when called, fetches its chunks afresh and charges the per-op budget again, whether or
 * not the per-id stream was read, and reading both is two reads (invariant 3 applies to each separately). Nothing is
 * fetched until a read is first pulled.
 */
export interface IdStream extends AsyncIterable<number> {
  /**
   * The same ids as the per-id stream, in the same order, one `Uint32Array` per chunk: each array ascending, holding
   * every id of one chunk the read yields (a range trimmed at its edges exactly as the per-id stream trims it), and
   * no array is empty. Chunks arrive in ascending order, so the concatenation is the per-id stream.
   *
   * One `await` per chunk instead of one per id: measured locally, an in-memory read goes several times faster, and
   * a large scan stops being bound by the event loop. The reads, the budget and the read-ahead window are the per-id
   * stream's, and so is stopping early: leaving a `for await` over it (`break`, `return`, a throw) ends the read.
   *
   * **Memory:** one array per chunk, at most 65,536 ids (256 KiB), allocated for that chunk alone and yours to
   * keep, change or hand on; the read holds no reference to it after yielding it.
   *
   * ```ts
   * for await (const ids of seg.andNot([optOut]).batches()) await send(ids);
   * ```
   */
  batches(): AsyncIterable<Uint32Array>;
}

/** A generator the engine just made, with the batch read that goes with it attached. Adds nothing per id. */
const withBatches = (
  gen: AsyncGenerator<number>,
  batches: () => AsyncIterable<Uint32Array>,
): IdStream => Object.assign(gen, { batches });

/**
 * A stream that fails when it is first read, either way. A combine refuses its arguments this way, as the engine's
 * own checks do, so a caller's try/catch around the iteration catches it.
 */
const failing = (err: unknown): IdStream => {
  const rejecting = (): AsyncIterator<never> => ({ next: () => Promise.reject(err) });
  return {
    [Symbol.asyncIterator]: rejecting,
    batches: () => ({ [Symbol.asyncIterator]: rejecting }),
  };
};

/** Whether two handles of one segment read it at one generation: both live, or both pinned to one object. */
const samePin = (a: PinnedAt | undefined, b: PinnedAt | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.generation === b.generation && a.fingerprint === b.fingerprint;

/** How a refusal names two handles of one segment that read it at two generations. */
const twoPins = (a: PinnedAt | undefined, b: PinnedAt | undefined): string => {
  const one = (p: PinnedAt | undefined): string =>
    p === undefined ? 'live' : `pinned at generation ${p.generation ?? 'none'}`;
  return a !== undefined && b !== undefined && a.generation === b.generation
    ? `pinned twice at generation ${a.generation ?? 'none'}, as two different objects`
    : `${one(a)} and ${one(b)}`;
};

/** Every key of `T`, each possibly `undefined`: a copy typed this way fails to compile until it names every field. */
type EveryField<T> = { [K in keyof Required<T>]: T[K] | undefined };

/** A read's range, read once, now, from whatever object holds it: a getter or an inherited bound included. */
const rangeOf = (options: IdRange): EveryField<IdRange> => ({
  after: options.after,
  through: options.through,
});

/**
 * A combine's options, read once, now, field by field, for the same reason as {@link rangeOf}. Typed to name every
 * field, so an option added to {@link BaseCombineOptions} and not listed here fails to compile instead of being
 * dropped.
 */
const readOptions = (options: BaseCombineOptions): EveryField<BaseCombineOptions> => ({
  ...rangeOf(options),
  concurrency: options.concurrency,
  budget: options.budget,
  allowAbsentOperands: options.allowAbsentOperands,
});

const NO_SEGMENTS: readonly Segment[] = [];

/** The empty id stream every expired read path returns — allocated once, so an expired read costs nothing. */
const EMPTY_IDS: IdStream = {
  async *[Symbol.asyncIterator]() {
    // deliberately yields nothing
  },
  async *batches() {
    // deliberately yields nothing
  },
};

type EngineCombine = Parameters<SegmentEngine['intersect']>[1];
type EngineAndNot = Parameters<SegmentEngine['andNot']>[2];

/**
 * What a combine is read as: the ids a caller streams, or the chunks an `*Into` writes. The three verbs make the
 * same decisions about expired operands, `exclude`, the engine and the options whichever it is, so each is written
 * once over this, and only the last step differs.
 */
interface CombineOutput<T> {
  /** What a combine over expired operands is: nothing. */
  readonly none: T;
  /** A combine that fails when first read, as the engine's own refusals do. */
  readonly failing: (err: unknown) => T;
  readonly intersect: (engine: SegmentEngine, refs: SegmentRef[], opts: EngineCombine) => T;
  readonly union: (engine: SegmentEngine, refs: SegmentRef[], opts: EngineCombine) => T;
  readonly andNot: (
    engine: SegmentEngine,
    base: SegmentRef,
    refs: SegmentRef[],
    opts: EngineAndNot,
  ) => T;
}

/** Combines read as ids: what `intersect`, `union` and `andNot` return. */
const AS_IDS: CombineOutput<IdStream> = {
  none: EMPTY_IDS,
  failing,
  intersect: (engine, refs, opts) =>
    withBatches(engine.intersect(refs, opts), () => engine.intersectBatches(refs, opts)),
  union: (engine, refs, opts) =>
    withBatches(engine.union(refs, opts), () => engine.unionBatches(refs, opts)),
  andNot: (engine, base, refs, opts) =>
    withBatches(engine.andNot(base, refs, opts), () => engine.andNotBatches(base, refs, opts)),
};

/** A combine's result as the chunks it is made of. */
type ChunkStream = AsyncIterable<{ chunkKey: number; bitmap: CodecBitmap }>;

const NO_CHUNKS: ChunkStream = {
  async *[Symbol.asyncIterator]() {
    // deliberately yields nothing
  },
};

/** A combine's chunks on their way to a load, which writes them as they are. */
class CombineChunks {
  constructor(readonly chunks: ChunkStream) {}
}

/** Combines read as chunks: what the `*Into` verbs write into the new generation, with no id built on the way. */
const AS_CHUNKS: CombineOutput<ChunkStream> = {
  none: NO_CHUNKS,
  failing: (err) => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
  }),
  intersect: (engine, refs, opts) => engine.intersectChunks(refs, opts),
  union: (engine, refs, opts) => engine.unionChunks(refs, opts),
  andNot: (engine, base, refs, opts) => engine.andNotChunks(base, refs, opts),
};

/**
 * What `andNotInto` takes: the write options without `exclude`, because its `excludes` argument IS the
 * subtraction — a second one in the options would be two spellings of one thing.
 *
 * Named rather than left as an inline `Omit` so it can be imported and annotated. The read sibling `andNot`
 * solves the same problem the same way, by taking {@link BaseCombineOptions}.
 */
export type AndNotIntoOptions = Omit<MaterializeOptions, 'exclude'>;

/**
 * The `keep` a materialisation passes when the caller does not: a grace window wide enough to collect nothing.
 *
 * The collection keeps the newest `keep` generations below the pointer and deletes the rest, so an
 * integer at the top of the range keeps all of them. It has to be an integer — `loadSegment` validates that,
 * and `Infinity` is rejected — which is why this is `MAX_SAFE_INTEGER` and not the value that reads more
 * naturally.
 */
const KEEP_EVERY_GENERATION = Number.MAX_SAFE_INTEGER;

/** How a `Segment` hands a result stream back to its store to become a new generation of `dest`. */
/** Build a pinned twin of a handle — injected into `Segment` so it stays free of store wiring. */
type Pin = (ref: SegmentRef, expiresAt?: number) => Promise<Segment>;

/**
 * The engine a combine should run on, given every handle involved — `undefined` when none is pinned and the
 * store's own engine will do. Injected so `Segment` stays free of store wiring.
 */
type CombineEngine = (handles: readonly Segment[]) => SegmentEngine | undefined;

type Materialize = (
  dest: SegmentRef,
  ids: LoadInput | CombineChunks,
  op: string,
  options?: MaterializeOptions,
) => Promise<MaterializeResult>;

/** What a {@link Segment} is built from: the store's own wiring, which is why a handle is not constructible. */
interface SegmentParts {
  engine: SegmentEngine;
  ref: SegmentRef;
  clock: Clock;
  metrics: IMetricsSink;
  materialize: Materialize;
  /** Build a pinned twin of this handle — injected so `Segment` stays free of store wiring. */
  pinned: Pin;
  combineEngine: CombineEngine;
  expiresAt?: number;
  pinnedAt?: PinnedAt;
}

/** What {@link Segment.stat} answers: the generation a handle reads, its id count and its metadata. */
export interface SegmentStat {
  /** The generation read, or `null` when the segment has none. */
  readonly generation: number | null;
  readonly cardinality: number;
  /** The metadata the generation was loaded with; absent when it has none. */
  readonly metadata?: GenerationMetadata;
}

/** The store's one way to mint a {@link Segment}, bound by the class's static block. */
let makeSegment: (parts: SegmentParts) => Segment;
/** True only while {@link makeSegment} is constructing, so a `new Segment(...)` from plain JS is refused. */
let minting = false;

/**
 * A handle bound to one segment — the read verbs, plus the three `*Into` verbs that write a **new generation**
 * of another segment.
 *
 * **IDs must be integers in `[0, 2^32)`** (dense 32-bit). A non-integer / negative / out-of-range id
 * throws {@link ValidationError}.
 *
 * A handle has no per-id write: data enters a segment as a whole generation (`store.load()`, or one of the
 * `*Into` verbs), and leaves it the same way (`eraseSubject`, `dropSegment`).
 */
export class Segment {
  private readonly metricsOn: boolean;
  private readonly engine: SegmentEngine;
  private readonly ref: SegmentRef;
  private readonly clock: Clock;
  private readonly metrics: IMetricsSink;
  private readonly materialize: Materialize;
  private readonly pinned: Pin;
  private readonly combineEngine: CombineEngine;
  /** Absolute epoch-ms deadline from {@link SegmentOptions.expiresAt}; `undefined` ⇒ this handle never expires. */
  readonly expiresAt?: number;
  /**
   * The generation this handle is held at, when it came from {@link Segment.pin}. Read by the store so a
   * pinned handle passed as an **operand** is still read at its pin rather than live.
   */
  readonly pinnedAt?: PinnedAt;

  static {
    makeSegment = (parts) => {
      minting = true;
      try {
        return new Segment(parts);
      } finally {
        minting = false;
      }
    };
  }

  /**
   * Not constructible: a handle comes from {@link CloudRoaring.segment}, which wires it to the store's engine,
   * caches and write path. The constructor takes those internals, so it is not part of the surface.
   */
  private constructor(parts: SegmentParts) {
    if (!minting) {
      throw new ValidationError(
        'a Segment is not constructed directly; call `store.segment(name)`',
      );
    }
    this.engine = parts.engine;
    this.ref = parts.ref;
    this.clock = parts.clock;
    this.metrics = parts.metrics;
    this.materialize = parts.materialize;
    this.pinned = parts.pinned;
    this.combineEngine = parts.combineEngine;
    this.expiresAt = parts.expiresAt;
    this.pinnedAt = parts.pinnedAt;
    this.metricsOn = parts.metrics !== NOOP_METRICS;
  }

  /**
   * **Hold this segment at the generation that is current right now**, for as long as you keep the handle.
   *
   * An ordinary handle re-resolves on `cache.genTtlMs`, so a publish part-way through a long job means its second
   * half describes a different instant than its first — every chunk whole and verified, but the answer covering
   * two moments, with nothing in the result saying so. That is fine for a dashboard and wrong for an export, a
   * reconciliation, or a send that has to match the count you reported. A pin is how you get one instant.
   *
   * ```ts
   * const snap = await store.segment('active-30d').pin();
   * const total = await snap.count();            // the number you report
   * for await (const id of snap.iterate()) { … } // …and the ids it counted, however long this takes
   * ```
   *
   * **Only this segment is pinned.** `snap.intersect([other])` reads `snap` at its pinned generation and
   * `other` at whatever is current — pin each segment if you want the whole query held. And a pinned handle
   * used as an *operand* is still read at its pin, never live.
   *
   * **One call reads a segment at one generation**, so a combine that holds this segment at two —
   * `snap0.andNot([snap1])`, or `live.intersect([snap])` — throws {@link ValidationError} when it is read, and an
   * `*Into` of one throws before it reads anything. Materialise one side first, with `intersectInto(dest, [])`.
   *
   * **A pin knows its object, not only its number.** A name purged and loaded again starts again at generation
   * 0, so a pin of the old segment never reads the new one: what it has already read still answers, as the
   * instant it pinned, and anything it would have to fetch fails with `NotFoundError`, as a swept pin's does.
   *
   * **It is a hold, not a lease.** Nothing here stops a collection deleting the generation underneath
   * you: a pinned read deliberately does **not** heal forward, because silently serving a different generation
   * is the one thing a pin exists to prevent, so it fails instead. Size `keep` to cover your longest pinned
   * job — see [Generations and `keep`](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/docs/guide/loading.md#generations-and-keep) — or take the pin on a segment
   * you are not collecting.
   *
   * A segment with no current generation pins nothing and reads empty, exactly as it would unpinned. A pinned
   * segment whose row is later dropped or destroyed fails once it must open its object again, rather than go empty
   * part-way through a call. **A pin
   * keeps the key its reader unwrapped for as long as that reader stays open, and answers from the chunks it
   * decoded for as long as they stay cached.** This store invalidates a pin:
   *
   * - a `load`, a `rollback` or an `*Into` invalidates a pin of the segment it writes;
   * - `dropSegment` invalidates a pin of the segment it drops, and `retireExpired` a pin of each segment its ledger
   *   lists, retired or not, neither on a dry run;
   * - `eraseSubject` invalidates a pin of each segment it scans that is not already destroyed.
   *
   * An invalidated pin opens its object again, and fails if that object is gone or replaced, or its row is gone or
   * destroyed.
   * Anything else leaves the pin as it is: after a `destroySegment` beside this store, or an erasure, a drop or a
   * retirement through another store, in this process or another, the pin answers from what it holds until this
   * store's reader cache evicts the pin's reader and its chunk cache evicts the chunks the pin decoded, or
   * {@link CloudRoaring.invalidate} is called on this store. Where the
   * object the pin reads has been deleted, by an erasure, a drop or a sweep, a chunk the pin has not cached fails at
   * once. No timed refresh bounds any of that, as none bounds anything else a pin holds.
   *
   * A replacement a pin has found is remembered, so its later chunk reads fail with no request, until the store
   * forgets it: an invalidation of the segment does, as does a later `pin()` of the same version that opens the object
   * again, and the store remembers at most `cache.readerMax` of them. So once a restore puts the pinned object back,
   * call {@link CloudRoaring.invalidate} on this store: the pin then reads the object again.
   *
   * `pin()` reads the registry row and opens the generation at once, so the pin knows its object before its first
   * read. With a registry, pins of one generation taken while its row is unchanged share one reader while the store
   * keeps it open, pins taken at the same moment included: the first costs a tail read, and a key unwrap for an
   * encrypted segment, whether or not it is read, and the rest cost the row read alone. Without a registry every
   * `pin()` lists the segment's objects and makes the tail read, since only the object can tell two incarnations of
   * a name apart there. It retries a
   * transient fault as the store's reads do, and heals a generation swept between the two, but it fails where the
   * generation cannot be opened: `NotFoundError` for a pointer at a missing object, `IntegrityError` for a damaged
   * or misfiled one.
   *
   * Needs a store built on the `.crbm` storage source (the default when you pass a backend or a raw driver). Throws
   * {@link UnsupportedError} on a store wired with a pre-built source that cannot pin.
   */
  async pin(): Promise<Segment> {
    return this.pinned(this.ref, this.expiresAt);
  }

  /**
   * An opaque string that names this handle's segment, namespace included: two handles of one segment have the
   * same key, a live handle and its pins among them. Use it as a `Map` key or a log field when you track handles
   * and have not kept the name you made them with. The format is not specified and is not a storage key, so
   * compare keys, never parse one.
   */
  key(): string {
    return segmentKey(this.ref);
  }

  /**
   * Has this handle's deadline passed? **The lazy half of expiry** — the whole check is one comparison against
   * the injected clock, so it costs nothing on a handle with no deadline and no I/O on one that has expired.
   *
   * Deliberately evaluated per call rather than cached: a long-lived handle created before its deadline must
   * start reading empty the moment the deadline passes, without the caller re-creating it.
   */
  private expired(): boolean {
    return this.expiresAt !== undefined && this.clock.now() >= this.expiresAt;
  }

  /**
   * Refuse a materialisation that involves an **expired** handle. Called by the three `*Into` verbs only.
   *
   * On the read verbs an expired handle answers empty, which is the point of lazy expiry. On a *write* the same
   * rule would be destructive in a way nobody asks for: `a.intersectInto(dest, [b])` where `b`'s deadline has
   * quietly passed would, unrefused, replace `dest` with an **empty generation** — a wipe, reported as a successful
   * write, with the cause (a deadline on a handle somewhere) nowhere in the result. Reads degrade to empty; writes must not.
   *
   * So every handle in the call is checked, `dest` included: an expired `dest` does not change the bytes written,
   * but a caller who put a deadline on the thing they are writing into has said something contradictory and is
   * better told than guessed at. Open a handle without `expiresAt` to write, or drop the deadline.
   *
   * (The broader guard — refusing to publish an empty or implausible generation over a non-empty one, with an
   * `allowEmpty` override — covers these verbs too: they route through the same guarded write path as
   * {@link CloudRoaring.load}. The two stay separate because they differ in kind. That one is a REPORTED
   * refusal a caller may legitimately override; an expired handle is a wiring mistake, so it THROWS, before
   * any object is written — and `allowEmpty: true` does not reach it.)
   *
   * The verbs are `async` so this surfaces as a **rejected promise**, like every other validation in the facade —
   * a synchronous throw out of a promise-returning method escapes a caller who attached `.catch()` instead of
   * awaiting.
   */
  private refuseIfExpired(op: string, dest: Segment, operands: readonly Segment[]): void {
    const stale: string[] = [];
    for (const seg of [this, dest, ...operands]) {
      if (seg.expired())
        stale.push(seg.ref.namespace ? `${seg.ref.namespace}/${seg.ref.segment}` : seg.ref.segment);
    }
    if (stale.length > 0) {
      throw new ValidationError(
        `${op}: refusing to publish a generation while these handles have expired — ${[...new Set(stale)].join(', ')}. ` +
          `An expired handle reads as empty, so this would write an empty (or short) generation over "${dest.ref.segment}". ` +
          `Open the handles without \`expiresAt\` if you meant to materialise, or drop the deadline.`,
      );
    }
  }

  /**
   * Time an op with the injected clock and emit an `op` metric on completion (success or throw). Skipped
   * entirely when no sink is wired, so the default path pays nothing.
   */
  private async timed<T>(name: MetricOpName, fn: () => Promise<T>): Promise<T> {
    if (!this.metricsOn) return fn();
    const startedAt = this.clock.now();
    try {
      return await fn();
    } finally {
      this.metrics.onEvent({ kind: 'op', name, ms: Math.max(0, this.clock.now() - startedAt) });
    }
  }

  /** Membership: one chunk — the cache, else one ranged GET. Throws {@link ValidationError} on a bad id. */
  has(id: number): Promise<boolean> {
    if (this.expired()) return Promise.resolve(false);
    return this.timed('has', () => this.engine.has(this.ref, id));
  }
  /**
   * Cardinality of the generation this handle reads: **one registry read when cold, none when warm, and no read of the
   * object**, with **zero payload reads**. The registry row records the id count of the generation it names, written
   * by the write that made it current, and a count answers from that. A row with no summary it can use (one written
   * before rows carried it, one that names another generation, a sealed one that does not open) sends the count to the
   * `.crbm` index, summed with a tail read of the object. A segment whose pointer names a missing object (a torn
   * restore) still counts the row's number, while a read of the object throws; `checkConsistency` is what finds it.
   *
   * What this trusts: the row's summary, or the index's sum, and no payload is decoded to confirm it. The summary is
   * used only for the generation it names, on an active row, and a sealed one only if it opens under the segment's
   * key; it is held against the object whenever the object is opened anyway (a `has`, an `iterate`, a combine, a
   * `pin()`), at no extra request, and a disagreement stops this store using it, and fails nothing. It is not
   * confirmed on the cold path, so a party who can write the registry row can make a count wrong. The index is checked for internal consistency when the object is opened (each key in
   * range and ascending, each cardinality in `1..65536`, each payload inside the payload region, and, on an
   * unencrypted object, the footer's chunk count and total agreeing with the index), and a corrupt index that is
   * still internally consistent yields a wrong count. `iterate()` and the combines decode the payloads, whose
   * structure is checked.
   */
  count(): Promise<number> {
    if (this.expired()) return Promise.resolve(0);
    return this.timed('count', () => this.engine.count(this.ref));
  }
  /**
   * What the generation this handle reads is, from one resolution: its number, its id count and the metadata it
   * was loaded with (absent when it has none). It is what answers {@link Segment.count}, so the three describe one
   * generation and cannot straddle a publish. One registry read when cold, none while warm, and none on a pinned
   * handle, which answers for the generation it pinned. A segment with no generation, and an expired handle,
   * answer `{ generation: null, cardinality: 0 }`.
   *
   * Trust is as for `count()`: the registry row's word, not confirmed against the object until the object is
   * opened, when a disagreement makes this process stop using that row's summary.
   *
   * ```ts
   * const { generation, cardinality, metadata } = await store.segment('active-30d').stat();
   * ```
   */
  async stat(): Promise<SegmentStat> {
    if (this.expired()) return { generation: null, cardinality: 0 };
    return this.engine.stat(this.ref);
  }
  /**
   * Every id, ascending, streamed one chunk at a time. Pass a range to read part of the segment: the ids in
   * `(after, through]`, fetching only the chunks the range overlaps. The per-op budget is charged for every chunk in
   * the range, so give a page `through` as well as `after`. On a pinned handle it reads the pinned generation, as a
   * full read does.
   *
   * ```ts
   * // Keyset paging: each page resumes where the one before ended, and stops at its window's end.
   * for await (const id of seg.iterate({ after: previousEnd, through: windowEnd })) await send(id);
   * ```
   *
   * Each bound is optional and an integer in `0..4294967295`; a bad one throws {@link ValidationError} when the
   * stream is first read. `after >= through` is an empty range, which reads nothing. An expired handle reads empty
   * without checking its options, as every read of one does.
   */
  iterate(options?: IdRange): IdStream {
    if (this.expired()) return EMPTY_IDS;
    // Neither bound set is no range at all, which the engine reads on its full-read path.
    const range = options == null ? undefined : rangeOf(options);
    const none = range === undefined || (range.after === undefined && range.through === undefined);
    const { engine, ref } = this;
    const bounds = none ? undefined : range;
    return withBatches(engine.iterate(ref, bounds), () => engine.iterateBatches(ref, bounds));
  }

  /**
   * The options a combine hands the engine, read once, when it is called ({@link readOptions}), with the `exclude`
   * it was given, already reduced to its live handles ({@link liveExcludes}) and mapped down to the plain refs
   * `core` takes. A method rather than a module function because `ref` is class-private — the encapsulation is
   * worth more than the free function.
   *
   * Each field is named rather than copied with a rest spread: a rest copy takes only own enumerable properties, so
   * a bound held in a getter or inherited from a prototype was dropped, and the read silently widened to the whole
   * segment.
   */
  private refsIn(
    options: CombineOptions | null | undefined,
    exclude: readonly Segment[],
  ): (BaseCombineOptions & { exclude?: SegmentRef[] }) | undefined {
    if (options == null) return undefined;
    return {
      ...readOptions(options),
      exclude: exclude.length > 0 ? exclude.map((o) => o.ref) : undefined,
    };
  }

  /**
   * The handles in `options.exclude` that have not expired. **An expired exclusion excludes nothing**, in every
   * combine, so it is dropped here, before the engine is asked for anything: it is never fetched, never
   * checked for absence, and never counted in the pin-consistency check. `exclude` is read once, so a getter sees
   * one call.
   *
   * With no `exclude` this is one property read and a shared empty list, and with none expired it returns the
   * caller's own array, so the common case allocates nothing.
   */
  private liveExcludes(options: CombineOptions | null | undefined): readonly Segment[] {
    const exclude = options?.exclude;
    if (exclude == null || exclude.length === 0) return NO_SEGMENTS;
    return exclude.some((e) => e.expired()) ? exclude.filter((e) => !e.expired()) : exclude;
  }

  /**
   * Chunk-skipping intersection: stream the ids in **this** segment AND every segment in `others`, ascending.
   * Fetches only the Storage chunks present in *all* operands (a key absent from any operand contributes nothing
   * and is never downloaded), reading each operand's as coalesced ranges under a bounded in-flight window — so the Storage
   * footprint stays small (Lambda-friendly) regardless of segment size. Pass `concurrency` to tune that window (the range
   * requests held ahead per operand: a positive integer, 32 by default).
   * AND is commutative, so `a.intersect([b])` and `b.intersect([a])` yield the same ids. Pass `budget` to
   * override the store's per-op denial-of-wallet budget for this call (or `false` to lift it).
   */
  intersect(others: Segment[], options?: CombineOptions): IdStream {
    return this.intersectAs(AS_IDS, others, options);
  }

  private intersectAs<T>(out: CombineOutput<T>, others: Segment[], options?: CombineOptions): T {
    // An expired operand is empty, and anything ANDed with the empty set is empty. Guarding here rather than
    // only in `count()` is what keeps the surface coherent: a segment whose `count()` is 0 must not still
    // contribute members to an intersection.
    if (this.expired() || others.some((o) => o.expired())) return out.none;
    const exclude = this.liveExcludes(options);
    let engine: SegmentEngine;
    try {
      engine = this.combineEngine([this, ...others, ...exclude]) ?? this.engine;
    } catch (err) {
      return out.failing(err);
    }
    const refs = [this.ref, ...others.map((o) => o.ref)];
    const opts = this.refsIn(options, exclude);
    return out.intersect(engine, refs, opts);
  }

  /**
   * Materialize `this ∩ others…` (minus `exclude`) as a **new generation of `dest`** — `dest`'s previous contents
   * are superseded, not added to. Streaming + bounded-memory; the result is one immutable object published
   * as a load is (the pointer advances to it, fenced on the row), so readers of `dest` see either the old generation
   * or the new one, never a partial. Needs the
   * store built with a backend (throws {@link UnsupportedError} otherwise).
   *
   * **An empty result does NOT overwrite a non-empty destination.** A combine that comes out empty is far more
   * often a mistake upstream — a typo'd operand, an `exclude` that swallowed everything, an operand that has
   * not loaded yet — than an intent, and once it publishes it is indistinguishable from a correct run. So the
   * write is **refused and reported**: `published: false`, `reason: 'empty'`, and `dest` keeps what it had.
   * Pass `allowEmpty: true` when emptying the destination is the point.
   *
   * `guard` adds the same plausibility bounds `load()` takes — `minCardinality` and `minRetained` — judged
   * against what `dest` held before. A refusal is **reported, not thrown**, exactly as on `load()`; branch on
   * `published`. A lost race is the one outcome that still throws ({@link WriteConflictError}), because a
   * materialisation that silently did not take effect is the one thing a caller cannot detect on its own.
   *
   * A call involving an **expired handle** is refused before any of this. See {@link refuseIfExpired}.
   */
  async intersectInto(
    dest: Segment,
    others: Segment[],
    options?: MaterializeOptions,
  ): Promise<MaterializeResult> {
    this.refuseIfExpired('intersectInto', dest, [...others, ...(options?.exclude ?? [])]);
    // Refused here, before `materialize` reads anything of `dest`, rather than when the load reads the combine: a
    // broken destination would otherwise answer first, and hide the refusal behind its own error.
    this.combineEngine([this, ...others, ...(options?.exclude ?? [])]);
    return this.timed('intersectInto', () =>
      this.materialize(
        dest.ref,
        new CombineChunks(this.intersectAs(AS_CHUNKS, others, options)),
        'intersectInto',
        options,
      ),
    );
  }

  /**
   * `this ∪ others…`, minus `options.exclude` — streamed ascending.
   *
   * **The one composite read with no chunk-skipping,** and that is inherent to union rather than a limitation
   * here: an id in *any* operand belongs to the result, so every chunk of every operand must be read.
   * `intersect` prunes any key missing from any operand; union has nothing to prune. It is charged against the
   * same per-op budget, so a wide union is refused rather than quietly billed — pass `budget` to raise it
   * deliberately. If you find yourself unioning the same segments on every read, materializing the combined
   * segment once (`unionInto`, or a load) is the cheaper shape.
   */
  union(others: Segment[], options?: CombineOptions): IdStream {
    return this.unionAs(AS_IDS, others, options);
  }

  private unionAs<T>(out: CombineOutput<T>, others: Segment[], options?: CombineOptions): T {
    // OR: drop the expired operands and union what is left. All expired ⇒ empty.
    const live = others.filter((o) => !o.expired());
    if (this.expired()) {
      if (live.length === 0) return out.none;
      return (live[0] as Segment).unionAs(out, live.slice(1), options);
    }
    if (live.length === 0 && others.length > 0) {
      // Every operand expired ⇒ just us. But `exclude` is not an operand of the union, it is a subtraction
      // applied to the result, so it still applies: `(this ∪ nothing) \ exclude` is `this \ exclude`. Returning
      // a bare `iterate()` here dropped it silently — an opt-out list that does not apply, on a library whose
      // headline is composable suppression, and reachable from nothing more exotic than a segment handle aging
      // out. `andNot` reads each exclude only where it overlaps, so this is also the cheap spelling.
      // With no exclude it is this segment alone, read as a one-operand union rather than as `iterate()`, so the
      // call's own `budget`, `concurrency` and range apply exactly as they would have to the union.
      const exclude = this.liveExcludes(options);
      return exclude.length > 0
        ? this.andNotAs(out, [...exclude], options)
        : this.unionAs(out, [], options);
    }
    if (live.length !== others.length) return this.unionAs(out, live, options);
    const exclude = this.liveExcludes(options);
    let engine: SegmentEngine;
    try {
      engine = this.combineEngine([this, ...others, ...exclude]) ?? this.engine;
    } catch (err) {
      return out.failing(err);
    }
    const refs = [this.ref, ...others.map((o) => o.ref)];
    const opts = this.refsIn(options, exclude);
    return out.union(engine, refs, opts);
  }

  /** Materialize `this ∪ others…` (minus `exclude`) as a **new generation of `dest`** — see {@link intersectInto}. */
  async unionInto(
    dest: Segment,
    others: Segment[],
    options?: MaterializeOptions,
  ): Promise<MaterializeResult> {
    this.refuseIfExpired('unionInto', dest, [...others, ...(options?.exclude ?? [])]);
    this.combineEngine([this, ...others, ...(options?.exclude ?? [])]); // as intersectInto: before any read
    return this.timed('unionInto', () =>
      this.materialize(
        dest.ref,
        new CombineChunks(this.unionAs(AS_CHUNKS, others, options)),
        'unionInto',
        options,
      ),
    );
  }

  /**
   * `this \ (excludes…)` — streamed ascending. Suppression on its own.
   *
   * Reads every chunk of `this` (any of them may survive the subtraction) but each exclude **only where it
   * overlaps this segment**, so the cost tracks the segment being filtered rather than the size of the
   * suppression list: at most one read per surviving key of `this`, so subtracting a 61,000-chunk global
   * opt-out list from a 40-chunk audience costs at most 40 reads, not 61,000.
   *
   * An expired handle in `excludes` excludes nothing, and is skipped without being read; if every one has
   * expired the result is `this` whole. An expired `this` is empty. `exclude` on `intersect` and `union` follows
   * the same rule.
   *
   * To filter the *result of an intersection*, do not chain — pass `exclude` to {@link intersect} instead, so
   * the suppression folds into the same pass rather than materializing an intermediate segment first.
   */
  andNot(excludes: Segment[], options?: BaseCombineOptions): IdStream {
    return this.andNotAs(AS_IDS, excludes, options);
  }

  private andNotAs<T>(out: CombineOutput<T>, excludes: Segment[], options?: BaseCombineOptions): T {
    // MINUS: an expired base is empty; an expired exclusion excludes nothing.
    if (this.expired()) return out.none;
    const liveExcludes = excludes.filter((e) => !e.expired());
    // Every exclusion expired ⇒ nothing to subtract. Recursing with an empty list would throw, since `andNot`
    // requires at least one operand — a caller whose suppression list happened to age out must not get an error.
    // It is read as a one-operand union rather than as `iterate()`, so the call's own `budget`, `concurrency` and range
    // still apply.
    // Only the call's own options go on, not an `exclude` a caller routed here with it: the excludes that expired are
    // the ones this branch exists to drop, and an expired exclusion excludes nothing.
    if (liveExcludes.length === 0 && excludes.length > 0) {
      return this.unionAs(out, [], options == null ? undefined : readOptions(options));
    }
    if (liveExcludes.length !== excludes.length) return this.andNotAs(out, liveExcludes, options);
    let engine: SegmentEngine;
    try {
      engine = this.combineEngine([this, ...excludes]) ?? this.engine;
    } catch (err) {
      return out.failing(err);
    }
    const base = this.ref;
    const refs = excludes.map((o) => o.ref);
    const opts = options == null ? undefined : readOptions(options);
    return out.andNot(engine, base, refs, opts);
  }

  /** Materialize `this \ (excludes…)` as a **new generation of `dest`** — see {@link intersectInto}. */
  async andNotInto(
    dest: Segment,
    excludes: Segment[],
    options?: AndNotIntoOptions,
  ): Promise<MaterializeResult> {
    this.refuseIfExpired('andNotInto', dest, excludes);
    this.combineEngine([this, ...excludes]); // as intersectInto: before any read
    return this.timed('andNotInto', () =>
      this.materialize(
        dest.ref,
        new CombineChunks(this.andNotAs(AS_CHUNKS, excludes, options)),
        'andNotInto',
        options,
      ),
    );
  }

  /**
   * Grounded cost report for this segment: storage cost from its **real** `.crbm` size (exact, no payload
   * reads); request cost from the supplied `workload` rates. A segment with no Storage generation reports zero
   * storage. The pointer refresh is priced at the store's own `cache.genTtlMs`, or at none when the store never
   * refreshes, unless the workload sets `genTtlMs`. See {@link CostReport} — it always includes a verdict (incl.
   * the lose-zone).
   */
  async costReport(options?: {
    pricing?: PricingProfile;
    workload?: Workload;
  }): Promise<CostReport> {
    const canMeasure = this.engine.supportsStorageSize;
    const size = canMeasure ? await this.engine.segmentSize(this.ref) : null;
    const refreshMs = this.engine.pointerRefreshMs;
    const workload =
      refreshMs === undefined || options?.workload?.genTtlMs !== undefined
        ? options?.workload
        : { ...options?.workload, genTtlMs: refreshMs };
    return groundedReport({
      storageBytes: size?.sizeBytes ?? 0,
      grounded: canMeasure,
      workload,
      pricing: options?.pricing,
      extraNotes: canMeasure
        ? undefined
        : ['storage source has no sizeOf() — storage not measured, reported as $0.'],
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// What `@cloudbitmaps/roaring` re-exports from `@cloudbitmaps/core`, by name: the store's verbs' types, the errors,
// the types its signatures name, the backends' shared types, and the constants and helpers an application calls.
// An application installs this package and imports from it alone. Flavor and driver authors import everything
// else (the engine, the free-function forms of the store's methods, the retry and budget internals) from
// `@cloudbitmaps/core` and `@cloudbitmaps/core/driver-kit`. A name added here is a public name of this package, so
// add one on purpose: `tests/docs/api-reference-sync.test.ts` fails until the API reference lists it.
// ---------------------------------------------------------------------------------------------------
// Decode portable bytes you hold, through the check a `{ serialized }` load makes.
export { deserializePortable };
export {
  // Backends
  MemoryStorage,
  LocalFsStorage,
  CrbmStorageChunkSource,
  // Crypto-shred and the retention policy helpers
  destroySegment,
  eraseNamespace,
  excludingReservedRows,
  readRetentionPolicy,
  MIN_EXPIRES_AT_MS,
  // Encryption
  InProcessKeystore,
  NodeAead,
  aadFor,
  // Errors and their copy-safe predicates
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
  isCloudRoaringError,
  isWriteConflictError,
  isTransientError,
  isNotFoundError,
  isIntegrityError,
  isValidationError,
  // The `.crbm` reader and its blob source
  CrbmReader,
  BufferReader,
  // Metrics, audit and pricing
  CountingMetricsSink,
  RecordingAuditSink,
  DEFAULT_RETRY_POLICY,
  AWS_US_EAST_1_ONDEMAND,
  ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
  ONE_REDIS_HA_CLUSTER,
} from '@cloudbitmaps/core';
export type {
  Aead,
  AeadSealed,
  AuditEvent,
  BlobReader,
  BlobSink,
  Budget,
  BudgetOption,
  ChunkRef,
  Clock,
  CodecBitmap,
  CodecInterface,
  ConsistencyErrorEntry,
  ConsistencyIssue,
  ConsistencyReport,
  CostReport,
  CrbmCrypto,
  CrbmReaderOptions,
  CrbmStorageChunkSourceOptions,
  DestroyResult,
  ClearRegistrySummary,
  DropResult,
  EncodedChunk,
  EraseDeps,
  EstimateInput,
  ExportFailure,
  ExportFormat,
  ExportManifest,
  ExportOptions,
  ExportSink,
  ExportWriter,
  ExportedSegment,
  GenKey,
  GenerationEntry,
  GenerationMetadata,
  GovernanceMeta,
  IAuditSink,
  IKeystore,
  IMetricsSink,
  IRegistryDriver,
  IStorageDriver,
  IdRange,
  InProcessKeystoreOptions,
  LoadGuard,
  LoadInput,
  LoadOptions,
  LoadRefusal,
  LoadResult,
  LocalFsStorageOptions,
  MemoryStorageOptions,
  MetricEvent,
  MetricOpName,
  MetricsSnapshot,
  NewRegistryRecord,
  PinnedAt,
  PinnedObject,
  PortableBitmap,
  PricingProfile,
  RedisNodeType,
  RedisSizing,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  RegistryStatus,
  RegistrySummary,
  RegistryWriteOptions,
  RetentionPolicy,
  RetireEntry,
  RetireExpiredOptions,
  RetireExpiredResult,
  RetryPolicy,
  Rng,
  RollbackResult,
  SealedRegistrySummary,
  SegmentInfo,
  SegmentRef,
  SegmentSize,
  SegmentSizing,
  SetRetentionResult,
  StorageBackend,
  StorageCaps,
  StorageChunkSource,
  Token,
  Workload,
  WrappedDek,
} from '@cloudbitmaps/core';
