/**
 * CloudRoaring — distributed, cloud-native Roaring Bitmaps.
 *
 * The `CloudRoaring` class is the read/write engine over the tiered seams. You wire storage **once**, as a
 * single config object: a Cold driver (`cold`), a Warm driver (`warm`), and optionally a `registry` (the
 * authoritative generation pointer — needed to read encrypted segments and to resolve generations without a
 * cold `list`-scan) and a `keystore` (encryption-at-rest / crypto-shred). Pass a **raw** {@link IColdDriver}
 * as `cold` (e.g. `S3ColdDriver`, `LocalFsColdDriver`, `MemoryColdDriver`) and the store assembles the `.crbm`
 * cold source ({@link CrbmColdChunkSource}) for you — so each driver is named exactly once. Or pass an
 * already-built {@link ColdChunkSource} to control advanced reader options yourself.
 *
 * In-process lifecycle helpers — `compact`, `eraseSubject`, `subjectReport` — reuse the store's own drivers, so
 * you never re-pass them (they need the store built with a raw cold driver + registry). Out-of-process cold
 * writers (the compaction daemon, the seed/bulk-load CLI, `destroySegment`/`eraseNamespace`) wire their own deps
 * against the same drivers — they run in separate processes.
 *
 * **You do not need any of them to start.** Construct a store and call `add`/`addMany`/`has`/`remove` — a segment
 * with no Cold generation at all is fully functional, because a read merges `(cold ∪ warm.adds) \ warm.removes`
 * and an absent Cold tier just makes that merge trivial. `bulkLoadCrbmGeneration` is an **import** path for data
 * you already have elsewhere, not an initialization step, and compaction is a **cost** optimization, never a
 * correctness requirement. See the README and the getting-started guide.
 */

import {
  BoundedLru,
  CrbmColdChunkSource,
  DEFAULT_BUDGET,
  NOOP_METRICS,
  RetryingColdChunkSource,
  RetryingWarmDriver,
  SegmentEngine,
  UnsupportedError,
  ValidationError,
  collectWithinBudget,
  compactSegment,
  gcOrphanGenerations,
  dropSegment,
  estimateCost,
  groundedReport,
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
  validateCompactionOptions,
  validateSegmentRef,
} from '@cloudbitmaps/core';
import type {
  Budget,
  BudgetOption,
  Clock,
  CodecBitmap,
  ColdChunkSource,
  CompactionDeps,
  CompactionOptions,
  CompactionResult,
  ConsistencyReport,
  CostReport,
  EngineDeps,
  DropResult,
  EstimateInput,
  ExportManifest,
  ExportOptions,
  ExportSink,
  IAuditSink,
  IColdDriver,
  IKeystore,
  IMetricsSink,
  IRegistryDriver,
  IWarmDriver,
  MetricOpName,
  PricingProfile,
  RetentionPolicy,
  RetireExpiredOptions,
  RetireExpiredResult,
  RetryPolicy,
  RetryingOptions,
  Rng,
  SetRetentionResult,
  SegmentRef,
  Topology,
  Workload,
} from '@cloudbitmaps/core';
// This package's reason to exist: the roaring codec the facade injects into the codec-agnostic engine.
import { roaringCodec } from './roaring-codec';
import { SystemClock } from './system-clock';

/** Default randomness for backoff jitter — lives outside `core/`, so `Math.random()` is allowed here. */
class SystemRng implements Rng {
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
 * Tenancy guard for the global-scope admin scans (`subjectReport`/`eraseSubject`, Phase F). Ids live in ONE
 * global `[0, 2³²)` space shared across namespaces, so a namespace-less scan reaches into *every* tenant's
 * segments. Require an explicit `namespace`, or a deliberate `{ allNamespaces: true }` ack, so a fleet-wide
 * sweep is never the accidental default on a shared store.
 */
function requireScope(options: { namespace?: string; allNamespaces?: boolean }, op: string): void {
  if (options.namespace === undefined && options.allNamespaces !== true) {
    throw new ValidationError(
      `${op} scans the global id space across all namespaces — pass an explicit \`namespace\`, ` +
        `or \`{ allNamespaces: true }\` to intentionally sweep the whole fleet`,
    );
  }
}

/**
 * Wiring for a {@link CloudRoaring} store. **Only `cold` and `warm` are required** — the minimal call is
 * `new CloudRoaring({ cold, warm })`. Add a `registry` to unlock eject / compaction / encryption and to skip the
 * cold list-scan (recommended for anything beyond a quick look). Everything else is **optional tuning with
 * sensible defaults** — resilience/retries are already on, the hot cache is bounded, metrics are a no-op — so
 * reach for them only when you need to.
 */
export interface CloudRoaringOptions {
  /**
   * Cold tier. Pass a **raw** {@link IColdDriver} (`S3ColdDriver`, `LocalFsColdDriver`, `MemoryColdDriver`, …)
   * and the store wraps it in a {@link CrbmColdChunkSource} using `registry`/`keystore` below — the common case,
   * so you wire each driver **once**. Or pass an already-built {@link ColdChunkSource} (`MemoryColdChunkSource`,
   * or a `CrbmColdChunkSource` you configured with advanced reader options) to use as-is.
   */
  readonly cold: IColdDriver | ColdChunkSource;
  /** Warm tier: the per-chunk delta store under OCC (`DynamoDbWarmDriver`, `LocalFsWarmDriver`, `MemoryWarmDriver`). */
  readonly warm: IWarmDriver;
  /**
   * Authoritative registry — the per-segment `currentGen` pointer + wrapped-DEK holder. Applies when `cold` is a
   * **raw driver**: it (a) resolves the current generation with one strong read instead of a cold `list`-scan,
   * and (b) lets the store read **encrypted** segments (that's where wrapped DEKs live). Optional — a
   * registry-less store reads the highest generation by list-scanning Cold (cleartext only). When you pass a
   * pre-built `ColdChunkSource`, that source resolves its own generations, so a top-level `registry` is inert
   * there and rejected as a wiring mistake — configure it on the source instead.
   */
  readonly registry?: IRegistryDriver;
  /**
   * Keystore for encryption-at-rest / crypto-shred (Phase 4e). Required to read encrypted segments; needs a
   * `registry` (that's where wrapped DEKs are stored). Applied only when `cold` is a raw driver — when you pass a
   * pre-built {@link ColdChunkSource}, configure the keystore on that source instead.
   */
  readonly keystore?: IKeystore;
  /**
   * Refuse to read a **cleartext** segment — a guard against silently reading data that should be encrypted.
   * Needs a `registry`; applied only when `cold` is a raw driver. Off by default (encryption is opt-in).
   */
  readonly requireEncryption?: boolean;
  /** Injected for deterministic tests; defaults to a system clock. */
  readonly clock?: Clock;
  /** Injected for deterministic tests; defaults to `Math.random`-backed. Drives backoff jitter. */
  readonly rng?: Rng;
  /** HOT cache ceiling (decoded Cold chunks). */
  readonly cacheMaxChunks?: number;
  /** Optional TTL on cached chunks (ms). */
  readonly cacheTtlMs?: number;
  /**
   * How long (ms) the store trusts a segment's resolved `currentGen` before re-resolving it on the next read
   * (default 2000) — the bound on read staleness after a compaction commits a new generation (gap #4). Applies
   * only when `cold` is a raw driver **and** a `registry` is wired (the cheap `currentGen` read the refresh
   * needs; a registry-less store pins per source lifetime). Lazy — no timer; ≤ one registry read per segment per
   * window, opening a new reader only when the generation actually advanced.
   */
  readonly coldGenTtlMs?: number;
  /**
   * Ceiling on how many segments' `.crbm` readers (each holding a parsed index) the store keeps open at once
   * (default 1024) — the steady-state memory bound for a long-running server that reads across many segments
   * (gap #1). Past it the least-recently-used segment's reader is evicted; re-opening it later is one cheap tail
   * GET. Applies only when `cold` is a raw driver (a pre-built `ColdChunkSource` manages its own reader cache).
   */
  readonly coldReaderCacheMax?: number;
  /**
   * Aggregate byte ceiling on the parsed `.crbm` indices the open readers hold (default 64 MiB) — the byte
   * half of the gap #1 memory bound, complementing the `coldReaderCacheMax` *count* bound. A wide/dense
   * segment's parsed index can be several MB, so a count-only bound could let the open readers pin ~GBs and
   * blow a small heap (e.g. a 128 MB Lambda); this evicts the least-recently-used reader once the summed index
   * footprint would exceed the ceiling — whichever of the count/byte bounds binds first. Lower it for
   * memory-tight deployments that read across wide segments. Applies only when `cold` is a raw driver.
   */
  readonly coldReaderCacheMaxBytes?: number;
  /**
   * Resilience: by default every warm/cold call retries **transient** faults (throttling, 5xx, dropped
   * connections) with bounded, jittered exponential backoff (see {@link DEFAULT_RETRY_POLICY}), and OCC
   * conflicts back off between retries. Pass a {@link RetryPolicy} to tune it, or `false` to disable the
   * transient-retry wrappers entirely (e.g. if your injected client already retries). Deterministic errors
   * (`ValidationError`/`IntegrityError`/`WriteConflictError`/…) are never retried by this layer.
   */
  readonly retry?: RetryPolicy | false;
  /** Backoff schedule between OCC conflict retries; defaults to a small, tight one. */
  readonly occBackoff?: RetryPolicy;
  /** Observability: called before each transient-retry backoff wait. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
  /**
   * Observability sink (Phase 5a): receives typed metric events (cold GET/bytes, warm read/write, cache
   * hit/miss, retries, intersection efficiency, op latency). Defaults to a no-op — emission is skipped
   * entirely when unused (near-zero overhead). Any exception the sink throws is swallowed — metrics can
   * never break a read/write.
   */
  readonly metrics?: IMetricsSink;
  /**
   * Warm read consistency for the READ paths (`has`/`count`/`iterate`/`intersect`). Default `'strong'`
   * (read-your-writes). `'eventual'` trades read-after-write for **~½ the DynamoDB read cost** (a strong read
   * bills 2× RCU) — a good fit for read-heavy, staleness-tolerant workloads (mirrors the cold tier's bounded
   * eventual reads). The compaction/OCC write path is always strongly consistent regardless. No effect on the
   * in-memory/LocalFs drivers (always strong). (Audit gap #9.)
   */
  readonly warmReadConsistency?: 'strong' | 'eventual';
  /**
   * Max Warm chunk writes in flight per `addMany`/`removeMany` (the bounded flusher). Default **4**
   * (`DEFAULT_WRITE_CONCURRENCY`); set it to `1` for strictly serial writes.
   *
   * Distinct chunks are independent OCC rows, so fanning them out cannot make them conflict with each other.
   * The bound exists for the *backend*: a provisioned-capacity store answers a burst by throttling, and 4 stays
   * comfortably inside what the transient-retry path absorbs (measured 8x below the first observed failure).
   * Raise it if your backend is provisioned for the fan-out — on-demand DynamoDB, or a connection pool sized to
   * match. A pool *smaller* than this needs no action: `pg` and `mysql2` both queue rather than reject, so the
   * flusher simply degrades toward serial.
   *
   * As before, a mid-flush failure can leave a **partial result**; `addMany`/`removeMany` are not atomic. What
   * concurrency changes is only how much of the batch may already have landed when the first error surfaces.
   */
  readonly writeConcurrency?: number;
  /**
   * Hard ceiling on the warm-delta bytes one segment scan may hold resident. Default **64 MiB**.
   *
   * **A memory bound, deliberately separate from `budget`, and still enforced when `budget: false`.** The
   * budget limits *cost* (billable requests); this limits *memory*. They are different axes, and treating the
   * budget as a memory control is what allowed a segment with thousands of warm chunks to materialise ~12 MB
   * before a `maxRequests: 2` budget could refuse it. It is also the only bound available to `intersect`,
   * whose budget is `common keys × operands` — a product a single wide operand can legitimately exceed in row
   * count while remaining entirely within contract.
   *
   * Raise it for genuinely large segments; it exists to keep a modest container alive, not to second-guess you.
   */
  readonly maxWarmScanBytes?: number;
  /**
   * Per-op **denial-of-wallet** budget (Decision #3 / invariant T3): the max backend requests a
   * single `count`/`iterate`/`intersect`/`subjectReport`/`eraseSubject` may fan out into before it's refused
   * with {@link BudgetExceededError} — so one runaway op can't drive unbounded RCU/GET cost on a shared backend.
   * **On by default, generous** ({@link DEFAULT_BUDGET}: 1,000,000 requests — a normal op never hits it). Tune
   * with `{ maxRequests }`, override per op (on `intersect`/`subjectReport`/`eraseSubject`), or set `false` to
   * disable. The check is O(1) (before fan-out), so the hot path is untouched; per-request bytes are separately
   * size-capped, so bounding requests transitively bounds bytes.
   */
  readonly budget?: BudgetOption;
}

export interface SegmentOptions {
  readonly namespace?: string;
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
  /** The id was present and a logical `remove` tombstone was written. */
  readonly removed: boolean;
  /**
   * True iff *this call* committed a new generation with the segment's tombstones applied — the bit is
   * physically gone from Cold (assuming no concurrent re-add of the id; see {@link CloudRoaring.eraseSubject}).
   * `false` is **conservative**: the purge may have been deferred (`note:'leased-by-other'`) or already done by
   * a concurrent daemon (`note:'clean'`); the logical removal holds regardless.
   */
  readonly physicallyPurged: boolean;
  /** The generation that retired the bit (present when `physicallyPurged`). */
  readonly toGen?: number;
  /** Why physical purge wasn't committed by this call (compaction's `reason`, e.g. `'leased-by-other'`, `'clean'`). */
  readonly note?: string;
}

/**
 * The erasure ledger returned by {@link CloudRoaring.eraseSubject} — your proof-of-deletion artifact. It is a
 * return value only (no library-side persistence): persist it / route it to your audit sink as you see fit.
 */
export interface EraseSubjectResult {
  readonly id: number;
  /** Per-segment records for the segments the id was erased from (absent segments are not listed). */
  readonly erasedFrom: SubjectErasureEntry[];
  /** How many registered segments were scanned. */
  readonly scannedSegments: number;
}

/**
 * Resolve the `cold` option to a {@link ColdChunkSource} at construction (wiring-time only — no hot-path cost).
 *
 * `cold` is discriminated **structurally, without a brand**: a raw {@link IColdDriver} exposes `putImmutable`
 * (the byte-mover seam); a pre-built {@link ColdChunkSource} exposes `getChunk` (the engine's read seam). The
 * two interfaces are deliberately **disjoint** on these methods (an invariant the driver SDK maintains, pinned
 * by a test) — an object exposing *both* is ambiguous and rejected, as is one exposing *neither* (incl. a
 * nullish/non-object value from a JS caller): fail fast with a typed error rather than crash on a probe.
 *
 * A raw driver is wrapped into a {@link CrbmColdChunkSource} using the config's `registry`/`keystore`/
 * `requireEncryption`; a pre-built source is used as-is. Those three options are meaningful **only** on the
 * raw-driver path (a pre-built source carries its own registry/keystore) — pairing any of them with a source is
 * a wiring mistake, so reject it rather than silently ignore it. The `CrbmColdChunkSource` constructor enforces
 * the rest (a keystore / `requireEncryption` needs a registry; the driver needs range reads).
 *
 * Returns the resolved `source` (what the engine reads through) **and** the raw `driver` when one was passed —
 * the store keeps the raw driver so its in-process lifecycle helpers (`compact`/`eraseSubject`) can build
 * {@link CompactionDeps} without you re-passing drivers. `driver` is `undefined` for a pre-built source (there's
 * no underlying `IColdDriver` to compact through — those callers use the free functions).
 */
function resolveColdSource(
  options: CloudRoaringOptions,
  clock: Pick<Clock, 'now'>,
): {
  source: ColdChunkSource;
  driver: IColdDriver | undefined;
} {
  const cold: unknown = options.cold;
  if (cold === null || typeof cold !== 'object') {
    throw new ValidationError('`cold` must be an IColdDriver or a ColdChunkSource');
  }
  const hasGetChunk = typeof (cold as Partial<ColdChunkSource>).getChunk === 'function';
  const hasPutImmutable = typeof (cold as Partial<IColdDriver>).putImmutable === 'function';
  if (hasGetChunk && hasPutImmutable) {
    throw new ValidationError(
      '`cold` exposes both `getChunk` and `putImmutable` — ambiguous; pass an IColdDriver or a ColdChunkSource, not a hybrid',
    );
  }
  if (!hasGetChunk && !hasPutImmutable) {
    throw new ValidationError('`cold` must be an IColdDriver or a ColdChunkSource');
  }
  if (hasGetChunk) {
    // Already a ColdChunkSource — used as-is. registry/keystore/requireEncryption only apply when the store
    // builds the source from a raw driver; with a pre-built source they're inert, so reject them rather than
    // mislead (configure them on the source you passed instead).
    if (
      options.registry !== undefined ||
      options.keystore !== undefined ||
      options.requireEncryption === true
    ) {
      throw new ValidationError(
        'registry/keystore/requireEncryption apply only when `cold` is a raw IColdDriver; configure them on ' +
          'the ColdChunkSource you passed instead',
      );
    }
    return { source: cold as ColdChunkSource, driver: undefined };
  }
  // A raw IColdDriver → assemble the `.crbm` cold source with the store's registry/keystore; keep the raw
  // driver for the store's lifecycle helpers.
  const driver = cold as IColdDriver;
  return {
    source: new CrbmColdChunkSource(driver, {
      registry: options.registry,
      keystore: options.keystore,
      requireEncryption: options.requireEncryption,
      clock,
      currentGenTtlMs: options.coldGenTtlMs,
      maxOpenSegments: options.coldReaderCacheMax,
      maxOpenIndexBytes: options.coldReaderCacheMaxBytes,
    }),
    driver,
  };
}

export class CloudRoaring {
  private readonly engine: SegmentEngine;
  private readonly clock: Clock;
  private readonly metrics: IMetricsSink;
  // The store's own drivers, kept so the in-process lifecycle helpers (`compact`/`eraseSubject`/`subjectReport`)
  // reuse them instead of making you re-pass a CompactionDeps. `coldDriver` is set only when `cold` was a raw
  // IColdDriver (a pre-built ColdChunkSource has no underlying driver to compact through).
  private readonly coldDriver: IColdDriver | undefined;
  private readonly warmDriver: IWarmDriver;
  private readonly registry: IRegistryDriver | undefined;
  private readonly keystore: IKeystore | undefined;
  private readonly requireEncryption: boolean;
  /** Resolved store-level per-op budget (null = disabled); the admin scans use it, with a per-op override. */
  private readonly budget: Budget | null;

  constructor(options: CloudRoaringOptions) {
    const clock = options.clock ?? new SystemClock();
    const rng = options.rng ?? new SystemRng();
    // Wrap the user sink so a throwing/buggy sink can never break I/O (observability is best-effort).
    const metrics = safeMetrics(options.metrics ?? NOOP_METRICS);
    const cache = new BoundedLru<string, CodecBitmap>({
      maxEntries: options.cacheMaxChunks ?? DEFAULT_CACHE_MAX_CHUNKS,
      ttlMs: options.cacheTtlMs,
      clock,
    });
    // Resolve the Cold seam to a ColdChunkSource: a raw IColdDriver is wrapped into the `.crbm` cold source
    // here (with the store's registry/keystore) so drivers are wired once; a pre-built source is used as-is.
    const resolved = resolveColdSource(options, clock);
    let cold: ColdChunkSource = resolved.source;
    // Resilience on by default: wrap the drivers so transient faults retry with jittered backoff. `false`
    // opts out (e.g. the injected client already retries); a RetryPolicy tunes it. OCC backoff is wired
    // separately into the engine (it owns the conflict-retry loop).
    let warm = options.warm;
    if (options.retry !== false) {
      const retryOpts: RetryingOptions = {
        clock,
        rng,
        policy: options.retry,
        // Bridge transient-fault retries into the metrics stream, then call the user's own hook.
        onRetry: (info) => {
          metrics.onEvent({
            kind: 'retry',
            reason: 'transient',
            attempt: info.attempt,
            delayMs: info.delayMs,
          });
          options.onRetry?.(info);
        },
      };
      warm = new RetryingWarmDriver(options.warm, retryOpts);
      cold = new RetryingColdChunkSource(cold, retryOpts);
    }
    if (
      options.writeConcurrency !== undefined &&
      (!Number.isInteger(options.writeConcurrency) || options.writeConcurrency < 1)
    ) {
      throw new ValidationError(
        `writeConcurrency must be a positive integer; got ${options.writeConcurrency}`,
      );
    }
    // Resolve the denial-of-wallet budget once (validates; `false` ⇒ null = disabled) and share it between the
    // engine (count/iterate/intersect) and the facade's admin scans (subjectReport/eraseSubject).
    this.budget = resolveBudget(options.budget, DEFAULT_BUDGET);
    const deps: EngineDeps = {
      warm,
      cold,
      cache,
      codec: roaringCodec, // the facade injects the flagship codec; core stays codec-agnostic
      clock,
      rng,
      occBackoff: options.occBackoff,
      metrics,
      warmReadConsistency: options.warmReadConsistency,
      writeConcurrency: options.writeConcurrency,
      maxWarmScanBytes: options.maxWarmScanBytes,
      budget: this.budget,
    };
    this.engine = new SegmentEngine(deps);
    this.clock = clock;
    this.metrics = metrics;
    // Keep the raw drivers for the lifecycle helpers (see the fields above). Compaction/erasure use raw drivers
    // exactly like the out-of-process daemon (`bin/compact-segments`) — a one-shot admin op surfaces a transient
    // fault to the caller rather than retrying under the hood; the daemon re-runs the cycle.
    this.coldDriver = resolved.driver;
    this.warmDriver = options.warm;
    this.registry = options.registry;
    this.keystore = options.keystore;
    this.requireEncryption = options.requireEncryption ?? false;
  }

  /**
   * Build {@link CompactionDeps} from the store's own drivers, for the in-process lifecycle helpers
   * ({@link compact} / {@link eraseSubject}). Requires the store to have been constructed with a **raw cold
   * driver** (a pre-built `ColdChunkSource` has no underlying `IColdDriver` to compact through) and a `registry`
   * (the authoritative `currentGen` pointer compaction swaps). Out-of-process callers use the `compactSegment`
   * free function with explicit deps.
   */
  private compactionDeps(): CompactionDeps {
    if (this.coldDriver === undefined) {
      throw new UnsupportedError(
        'compact/dropSegment/retireExpired/eraseSubject/checkConsistency need the store built with a raw cold driver (IColdDriver), not ' +
          'a pre-built ColdChunkSource — or call the compactSegment/runConsistencyCheck free functions with ' +
          'explicit deps',
      );
    }
    if (this.registry === undefined) {
      throw new UnsupportedError(
        'compact/dropSegment/retireExpired/eraseSubject/checkConsistency need a `registry` in the store config',
      );
    }
    return {
      cold: this.coldDriver,
      warm: this.warmDriver,
      registry: this.registry,
      clock: this.clock,
      codec: roaringCodec, // facade injects the flagship codec
      keystore: this.keystore,
      requireEncryption: this.requireEncryption,
      metrics: this.metrics, // safe-wrapped sink → store.compact/eraseSubject emit `compaction` events (gap #2)
    };
  }

  /** Get a handle to a segment. Validates the name/namespace grammar (finding S2). */
  segment(name: string, options?: SegmentOptions): Segment {
    const ref: SegmentRef = { segment: name, namespace: options?.namespace };
    validateSegmentRef(ref);
    return new Segment(this.engine, ref, this.clock, this.metrics);
  }

  /**
   * **Subject access (GDPR Art. 15 / CCPA right-to-know): which segments is this id a member of?** (Phase 6b.)
   *
   * Enumerates the **registered** segments (via the store's own `registry`) and does a tier-merging `has(id)` on
   * each — no drivers to re-pass. Complete only over registered segments (register your segments if you claim
   * SAR support). There is deliberately **no `id → segments` reverse index** — that would tax every write for a
   * rare request; this admin scan is `O(registered segments)` and touches no hot path.
   * Requires a `registry` in the store config
   * (throws {@link UnsupportedError} otherwise).
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
    // Bounded INCREMENTALLY: the previous spelling drained the whole registry and only then checked the
    // budget, so a tight budget refused the work after paying for the list — measured at 20,000 records
    // buffered under `maxRequests: 2`. This is a GDPR Art. 15 entry point plausibly wired to end-user
    // traffic, so resident memory must be O(budget), not O(fleet size).
    const recs = await collectWithinBudget(
      registry.list(options.namespace),
      budget,
      'subjectReport',
    );
    // Bounded fan-out of the tier-merging has() across registered segments (was serial — one read per segment
    // awaited in-loop). Order-preserving ⇒ deterministic result. Membership is read **strongly** regardless of
    // the store's `warmReadConsistency` — a legal SAR must be read-your-writes, never miss a just-written add.
    // A has() fault propagates (a report that can't read a segment must fail loud, not silently under-report).
    const membership = await mapWithConcurrency(
      recs,
      options.concurrency ?? DEFAULT_ADMIN_CONCURRENCY,
      async (rec): Promise<SubjectSegmentRef | null> => {
        if (rec.status === 'destroyed') return null; // already unreadable — never a member
        const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
        return (await this.engine.has(ref, id, { consistent: true }))
          ? { segment: rec.segment, namespace: rec.namespace }
          : null;
      },
    );
    const segments = membership.filter((m): m is SubjectSegmentRef => m !== null);
    return { id, segments, scannedSegments: recs.length };
  }

  /**
   * **Subject erasure (GDPR Art. 17): remove an id from every segment it's in, with a physical-deletion
   * guarantee.** (Phase 6b.)
   *
   * For each **registered** segment the id is a member of: writes a logical `remove` tombstone (immediate) and
   * then **force-compacts that segment now** — folding the tombstone into a fresh immutable generation so the
   * bit is *physically* gone from Cold on return, even for an otherwise-idle/archival segment that organic
   * compaction would never touch (the P13 fix). The returned per-segment record is your **erasure ledger** —
   * persist it / route it to your audit sink as the proof of deletion; the physical-purge proof is
   * compaction's own VERIFY step (a re-`has()` here would be unsound — a pinned cold source can still read the
   * old generation; take a fresh generation view after erasing, exactly as with the compaction daemon).
   *
   * Uses the store's **own** drivers (raw cold + warm + registry), so the old integrator obligation to wire a
   * matching `CompactionDeps` is gone — the `remove()` and the force-compaction provably run over the same tiers.
   * Requires the store built with a **raw cold driver + registry** (throws {@link UnsupportedError} otherwise;
   * a pre-built `ColdChunkSource` store has no `IColdDriver` to compact through — use the `compactSegment` free
   * function there). **One contract remains** (an integrator obligation the library cannot check): **do not
   * concurrently re-add the same id while erasing it.** A normal `add(id)` landing between the `remove` and the
   * compaction clears the tombstone and folds the id back into the new generation
   * (`effective = (cold ∪ adds) \ removes`); `physicallyPurged` attests only that compaction committed a
   * generation with the tombstones applied at pin time — quiesce writes for the subject during erasure.
   *
   * **A `physicallyPurged:false` entry means the logical removal holds but the physical purge didn't run this
   * call** — either a daemon held a live lease (`note:'leased-by-other'`; the daemon finishes it), or the
   * force-compaction hit an isolated fault (`note:'error: …'`; per-segment faults are caught so one segment
   * can't discard the whole ledger). `physicallyPurged:false` is **conservative** (a concurrent daemon may
   * already have purged the bit — `'clean'`). **Recovery:** follow up any `physicallyPurged:false` entry with
   * `store.compact(ref)` (or let the daemon do it) — **re-running `eraseSubject` will NOT re-purge it**, because
   * `has()` now reads false (the tombstone) so the segment is skipped as a non-member. The physical-purge proof
   * is compaction's own VERIFY step (a re-`has()` here would be unsound: a pinned cold source can still read the
   * old generation — take a fresh generation view after erasing, as with the daemon). Admin-only path;
   * `O(registered segments)`, no hot-path cost. Per-subject crypto-shred is infeasible (a subject's bit is
   * co-mingled in a shared container), so this is the single-subject erasure route; whole-segment/tenant erasure
   * is the `destroySegment`/`eraseNamespace` free functions.
   */
  async eraseSubject(
    id: number,
    options: {
      owner: string;
      namespace?: string;
      allNamespaces?: boolean;
      audit?: IAuditSink;
      concurrency?: number;
      budget?: BudgetOption;
    },
  ): Promise<EraseSubjectResult> {
    const compaction = this.compactionDeps();
    // Validate the owner BEFORE the fan-out — a bad owner must fail fast, not after a `remove` tombstone is
    // already written for the first segment (which would strand it: `has()` then reads false, so a retry skips it).
    validateCompactionOptions({ owner: options.owner });
    requireScope(options, 'eraseSubject'); // tenancy: explicit namespace, or an { allNamespaces: true } ack
    validateConcurrency(options.concurrency); // fail fast before the (possibly huge) registry scan
    const budget = resolvePerOpBudget(options.budget, this.budget); // partial override inherits the store's tightening
    splitId(id); // fail fast on a non-u32 id even when nothing is registered
    // Bounded incrementally — see subjectReport above. Art. 17 erasure is likewise reachable from ordinary
    // "delete my account" traffic, so the enumeration itself has to respect the budget.
    const recs = await collectWithinBudget(
      compaction.registry.list(options.namespace),
      budget,
      'eraseSubject',
    );
    // Bounded fan-out (was serial). Each segment is an independent lease + generation, so force-compacting
    // distinct segments concurrently is exactly what the sharded daemon does. Per-segment faults stay isolated
    // INSIDE each task — one failure never aborts the ledger (mirrors runCompactionCycle) — and the pool
    // preserves input order, so the ledger stays deterministic.
    const entries = await mapWithConcurrency(
      recs,
      options.concurrency ?? DEFAULT_ADMIN_CONCURRENCY,
      async (rec): Promise<SubjectErasureEntry | null> => {
        if (rec.status === 'destroyed') return null; // already crypto-shredded — nothing to erase
        const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
        let removed = false;
        try {
          // Membership check INSIDE the isolation: a has() fault (corrupt segment) must become a recorded
          // ledger entry, not abort the whole erasure. Read **strong** regardless of `warmReadConsistency` —
          // an Art.17 erasure must never skip a segment because an eventual read hasn't caught up yet.
          if (!(await this.engine.has(ref, id, { consistent: true }))) return null; // not a member — no tombstone
          await this.engine.remove(ref, id); // logical erasure, immediate
          removed = true;
          // Physical erasure now: fold the tombstone into a fresh generation (fires regardless of the organic
          // compaction trigger, so an idle/archival segment is still purged this call).
          const result = await compactSegment(ref, compaction, {
            owner: options.owner,
            audit: options.audit,
          });
          return {
            segment: rec.segment,
            namespace: rec.namespace,
            removed: true,
            physicallyPurged: result.compacted,
            toGen: result.toGen,
            note: result.compacted ? undefined : result.reason,
          };
        } catch (err) {
          // A thrown fault after the tombstone can't be recovered by re-running eraseSubject (has() now reads
          // false → skipped). Record it as removed-but-not-purged; the caller recovers with `store.compact(ref)`.
          return {
            segment: rec.segment,
            namespace: rec.namespace,
            removed,
            physicallyPurged: false,
            note: `error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    );
    const erasedFrom = entries.filter((e): e is SubjectErasureEntry => e !== null);
    return { id, erasedFrom, scannedSegments: recs.length };
  }

  /**
   * **Compact one segment now**, in-process, using the store's own drivers — a convenience over the
   * {@link compactSegment} free function. Merges `(cold ∪ adds) \ removes` into a fresh immutable generation,
   * swaps `currentGen`, then version-fenced-purges the archived Warm rows. A no-op (`compacted:false`) when the
   * segment has no dirty rows or a daemon holds a live lease — never throws on the normal contention/lease paths.
   * Requires the store built with a **raw cold driver + registry** (throws {@link UnsupportedError} otherwise);
   * like the daemon, it uses the raw drivers directly (a transient fault surfaces to you rather than retrying
   * under the hood). **Not for the request/hot path** — it reads and rewrites a whole Cold generation (streaming,
   * constant-memory, but full-segment I/O). Use the `compact-segments` daemon (`runCompactionCycle`) for routine
   * background compaction; reach for `store.compact()` for occasional/manual one-shots — a maintenance endpoint,
   * a small daemon-less deployment, or right after a targeted `remove`.
   */
  async compact(ref: SegmentRef, options: CompactionOptions): Promise<CompactionResult> {
    validateSegmentRef(ref);
    const deps = this.compactionDeps();
    const result = await compactSegment(ref, deps, options);
    // Collect the generation this compaction just superseded — best-effort, and only on a successful commit.
    //
    // Cold generations are immutable and generation-keyed, so **every** compaction leaves its predecessor on
    // disk. `runCompactionCycle` (the daemon) has always called `gcOrphanGenerations` for exactly this reason;
    // `compactSegment` never did, so a deployment that compacted in-process without running the daemon grew its
    // Cold footprint without bound, forever, silently. Reads stayed correct — `currentGen` always pointed at a
    // real object — so nothing ever surfaced it.
    //
    // Fixed here, in the facade, rather than in `compactSegment`: the free function stays a single-responsibility
    // primitive for callers who want to schedule GC themselves, while the batteries-included surface stops
    // leaking money by default. `gcOrphanGenerations` keeps its default grace window (`keep: 1`), so a reader
    // pinned to the just-superseded generation is unaffected.
    //
    // Swallowed on failure on purpose: GC is housekeeping, and a compaction that committed must not be reported
    // as failed because cleanup could not run. The next cycle collects what this one missed.
    if (result.compacted) {
      await gcOrphanGenerations(ref, { cold: deps.cold, registry: deps.registry }).catch(
        () => undefined,
      );
    }
    return result;
  }

  /**
   * **Dispose of a segment — tombstone it, delete its Warm rows, delete its Cold objects.** Irreversible.
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
   *   // A colon is NOT legal in a name — the family goes in the namespace, the date in the segment.
   *   const ref = { namespace: 'active-daily', segment: day };
   *   await store.dropSegment(ref, { confirmSegment: ref.segment });
   * }
   * ```
   *
   * **Omitting the namespace addresses a different segment and is a silent no-op** — you get
   * `{ dropped: false, reason: 'absent' }`, not a throw, so a retention loop with that mistake deletes nothing
   * forever and quietly. Branch on `dropped`, and treat `reason: 'absent'` as the alert.
   *
   * **Works on an accumulator too.** A segment you created by writing to it — never bulk-loaded, never compacted,
   * so it has no registry row and no Cold objects — is retired by deleting its Warm rows alone. That reports
   * `{ dropped: true, reason: 'warm-only' }`: there is no tombstone to write, and deliberately none is written,
   * because a `destroyed` row per retired daily bucket would be registry litter. The data really is gone.
   *
   * **Inspect `generationsRemaining`.** Empty is the normal outcome; non-empty means the storage was NOT fully
   * reclaimed and the drop should be re-run. A compaction that was already in flight when the tombstone landed
   * still finishes staging one more object, so a single sweep can miss it — this call re-sweeps and then reports
   * whatever it still could not remove rather than returning a result that looks like a clean drop.
   *
   * Reads become empty within `coldGenTtlMs` (default 2 s), not instantly: a store that had already read this
   * segment may answer from its cached generation + hot chunks until that window lapses. A reader that never
   * touched it sees empty at once. **That bound needs a clock and `coldGenTtlMs > 0`** — a store built without a
   * clock, or with `coldGenTtlMs: 0` ("pin forever"), holds its resolved snapshot for its own lifetime and can
   * keep answering `true` for a dropped segment indefinitely; restart it.
   *
   * Needs the store built with a **raw cold driver + a registry** (throws {@link UnsupportedError} otherwise),
   * because it has to enumerate and delete generations — a pre-built `ColdChunkSource` only reads.
   */
  async dropSegment(
    ref: SegmentRef,
    options: { confirmSegment: string; dryRun?: boolean; audit?: IAuditSink },
  ): Promise<DropResult> {
    validateSegmentRef(ref);
    const deps = this.compactionDeps(); // same wiring; reuses its UnsupportedError messaging for a bad build
    return dropSegment(ref, { registry: deps.registry, warm: deps.warm, cold: deps.cold }, options);
  }

  /**
   * **Record when this segment becomes eligible for retirement.** One registry write; nothing is deleted here,
   * and nothing starts running. `retireExpired` is what acts on the policy, and **you** decide when that runs —
   * an EventBridge rule, a CronJob, a queue consumer, whatever your deployment already has. This library starts
   * no background thread (it has to work identically in a Lambda, an edge isolate and a long-lived server).
   *
   * `expiresAt` is an **absolute epoch-ms you compute**, not a duration the library derives. A relative TTL would
   * have to be anchored to something the library knows — `updatedAt`, or the current generation — and compaction
   * rewrites both, so "expire 30 days after the last write" would keep a busy daily bucket alive forever
   * precisely because the daemon is working.
   *
   * ```ts
   * const DAY = 86_400_000;
   * const ref = { namespace: 'active-daily', segment: '2026-08-05' };
   * await store.setRetention(ref, { expiresAt: Date.now() + 30 * DAY });
   * ```
   *
   * **Works on an accumulator**, which is the whole point: a segment you created by writing to it has no
   * registry row, so it is invisible to `registry.list()` and therefore to every fleet-wide operation, including
   * the sweep. This call mints the row (`createdRow: true` in the result) with **no Cold generation**, so it
   * becomes enumerable while every read still resolves exactly as before.
   *
   * A value in the past is legal and means "eligible on the next sweep" — backfilling a policy onto existing
   * buckets is normal. A value below `MIN_EXPIRES_AT_MS` (2001-09-09) is rejected: it is almost certainly epoch
   * **seconds**, which would read as long-expired and retire the segment on the next pass. Needs a `registry`
   * in the store config (throws {@link UnsupportedError} otherwise), and refuses a crypto-shredded segment.
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
   * your compaction worker's loop). A library that started a timer would behave differently in a Lambda, an edge
   * isolate and a long-lived server, which is worse than not having one.
   *
   * Each retirement goes through `dropSegment`, so the Warm → registry → Cold ordering, the re-sweep for a
   * generation staged by an in-flight compaction, and the `generationsRemaining` report all come from one
   * implementation rather than two.
   *
   * ```ts
   * // In your scheduled handler. Start with a preview in a new deployment.
   * const preview = await store.retireExpired({ namespace: 'active-daily', dryRun: true });
   * console.log(`would retire ${preview.retired} of ${preview.scanned} (limited: ${preview.limited})`);
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
   * successes, which is what makes it a real bound: `dropSegment` deletes Warm and writes the tombstone before
   * sweeping Cold, so a fault in the Cold phase is a segment that is already retired. Retirements are sequential
   * (~8 round trips each), so `limit` is a wall-clock knob too, and `retired` counts deletions only — a dry run
   * reports `wouldRetire` instead, so a dashboard summing `retired` can never show a phantom deletion.
   *
   * It also **deletes the tombstone rows its own past retirements left**, after `tombstoneGraceMs` (default 24 h)
   * and only once that segment's Warm rows and Cold generations are provably gone — collecting a straggler
   * generation itself first, since nothing else ever would for a tombstoned segment. Attribution is a **positive
   * marker the sweep stamps on its own retirements**, not an inference from "destroyed + an expired policy": a
   * crypto-shred leaves `retention` untouched, so setting a policy and then honouring a right-to-erasure request
   * mid-window produces exactly that row, and deleting it would destroy the Art. 17 attestation and un-fence the
   * name. Pass `purgeTombstones: false` to keep every tombstone.
   *
   * Needs the store built with a **raw cold driver + a registry** (throws {@link UnsupportedError} otherwise),
   * because retiring a segment deletes its Cold objects. `now` defaults to the store's clock.
   */
  async retireExpired(
    options: Omit<RetireExpiredOptions, 'now'> & { now?: number } = {},
  ): Promise<RetireExpiredResult> {
    const deps = this.compactionDeps(); // guards raw cold + registry, with the same messaging as compact/drop
    return retireExpired(
      { registry: deps.registry, warm: deps.warm, cold: deps.cold },
      { ...options, now: options.now ?? this.clock.now() },
    );
  }

  /** The store's registry, or a typed error naming the operation that needs one. */
  private requireRegistry(op: string): IRegistryDriver {
    if (this.registry === undefined) {
      throw new UnsupportedError(`${op} needs a \`registry\` in the store config`);
    }
    return this.registry;
  }

  /**
   * **Cross-tier DR consistency check (audit gap #11).** After a restore/failover, verify every registered
   * segment's `currentGen` actually has its `.crbm` present in Cold — catching a **torn restore** where the
   * registry (`currentGen`) came back ahead of the object store, so a pointer references a generation that
   * isn't there (reads would then throw). Read-only, bounded fan-out; run it at startup after a restore.
   * Returns `{ checked, inconsistent }` — `inconsistent` empty ⇒ coherent; otherwise it names the segments to
   * recover (restore the object store, or roll the registry back to a coherent point). Needs the store built
   * with a **raw cold driver + a registry** (throws {@link UnsupportedError} otherwise). `destroyed`
   * (crypto-shredded) segments are skipped. Pair it with the DR runbook (docs/guide/disaster-recovery.md).
   */
  async checkConsistency(
    options: { namespace?: string; concurrency?: number } = {},
  ): Promise<ConsistencyReport> {
    const deps = this.compactionDeps(); // guards raw cold + registry; reuses the store's own drivers
    return runConsistencyCheck({ cold: deps.cold, registry: deps.registry }, options);
  }

  /**
   * **Export ("eject") every registered segment's current effective set** through the injected `sink`, using
   * only public read APIs — so your data is readable **without CloudRoaring** (the exit path; see the README's
   * "Your data stays yours"). `format: 'roaring'` (default) writes one **portable RoaringBitmap32** per segment
   * (loadable by any roaring library); `'ndjson'` writes newline-delimited ids (zero-dependency, streaming).
   * Enumerates via the store's **own** registry (needs one — throws {@link UnsupportedError} otherwise) so the
   * enumeration and the read path provably share one registry; an all-warm segment not yet in the registry can be
   * named via `options.candidates`. Encrypted segments are decrypted transparently **iff** this store was wired
   * with their keystore — the export is therefore **cleartext**; protect it. Crypto-shredded segments are skipped.
   * A segment that can't be read is isolated into the manifest's `failed[]` (the run continues), so "a manifest
   * exists" means the run finished — check `failed`. The `export-segments` CLI wraps this with a filesystem sink.
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
   * Planning cost estimate (Phase 5b) — pure, no instance/data needed: sizing, sales, what-if. For a real,
   * grounded report from live segment sizes, use `store.segment(name).costReport()`. See {@link CostReport}.
   */
  static estimateCost(input: EstimateInput): CostReport {
    return estimateCost(input);
  }
}

/**
 * A handle bound to one segment — the read/write ops.
 *
 * **IDs must be integers in `[0, 2^32)`** (dense 32-bit). A non-integer / negative / out-of-range id
 * throws {@link ValidationError}.
 *
 * **`addMany`/`removeMany`/`intersectInto`/`unionInto`/`andNotInto` are not atomic across chunks**: ids are grouped by chunk and
 * applied one chunk at a time, so if a later chunk fails (e.g. {@link WriteConflictError} after retries)
 * earlier chunks are already applied. Within a single chunk the update is atomic.
 */
/** Options common to every chunk-aligned combine (`intersect` / `union` / `andNot`). */
export interface BaseCombineOptions {
  /** Max chunk keys resolved concurrently — bounds the Cold footprint. A positive integer. */
  readonly concurrency?: number;
  /** Override the store's per-op denial-of-wallet budget for this call (`false` lifts it). */
  readonly budget?: BudgetOption;
}

/**
 * A combine that can also subtract.
 *
 * `exclude` is why suppression does not need an intermediate segment: applied here it folds into the same
 * chunk-aligned pass, and each exclude is read **only at the keys that survived** — so a large global opt-out
 * list costs reads proportional to the audience, not to itself.
 */
export interface CombineOptions extends BaseCombineOptions {
  /** Segments whose ids are subtracted from the result. */
  readonly exclude?: Segment[];
}

/** {@link CombineOptions} plus the write batching used by the `*Into` variants. */
export interface CombineIntoOptions extends CombineOptions {
  /** Ids buffered per `addMany` while materializing into `dest`. */
  readonly batchSize?: number;
}

export class Segment {
  private readonly metricsOn: boolean;

  constructor(
    private readonly engine: SegmentEngine,
    private readonly ref: SegmentRef,
    private readonly clock: Clock,
    private readonly metrics: IMetricsSink,
  ) {
    this.metricsOn = metrics !== NOOP_METRICS;
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

  /** Add an id (integer in `[0, 2^32)`). Throws {@link ValidationError} on a bad id. */
  add(id: number): Promise<void> {
    return this.timed('add', () => this.engine.add(this.ref, id));
  }
  /**
   * Add many ids, from a **sync or async** iterable. Not atomic across chunks — see the class note.
   *
   * An async source means a database cursor streams straight in — `addMany(athenaCursor())` rather than
   * hand-batching `page → addMany(page)`. Ids are grouped by chunk and each chunk is written **exactly once**,
   * however long the stream: pending ids are held compressed, not buffered-and-flushed, so a long stream costs
   * no more backend writes than a short one. Peak memory is the roaring representation of the ids you pass.
   *
   * **For a very large set, reach for `bulkLoadCrbmGeneration` instead.** `addMany` expresses a *delta* and
   * writes one warm row per touched chunk — around 61,000 of them for a set spread across the whole id space.
   * Bulk-load *replaces* the segment with one immutable Cold object. See the guide's cost comparison; picking
   * the wrong one of these is the most expensive mistake available in this library.
   */
  addMany(ids: Iterable<number> | AsyncIterable<number>): Promise<void> {
    return this.timed('addMany', () => this.engine.addMany(this.ref, ids));
  }
  /** Remove an id (integer in `[0, 2^32)`). Throws {@link ValidationError} on a bad id. */
  remove(id: number): Promise<void> {
    return this.timed('remove', () => this.engine.remove(this.ref, id));
  }
  /** Remove many ids, from a **sync or async** iterable. Not atomic across chunks — see {@link addMany}. */
  removeMany(ids: Iterable<number> | AsyncIterable<number>): Promise<void> {
    return this.timed('removeMany', () => this.engine.removeMany(this.ref, ids));
  }
  /**
   * **Claim ids atomically — add them, and get back only the ones that were not already there.**
   *
   * The durable analogue of Redis `SETBIT` returning the prior bit, which is what an exactly-once *"have I
   * already sent to / already processed this id?"* check needs. `has()` then `add()` cannot give you this: two
   * workers can both read absent and both proceed.
   *
   * ```ts
   * const sent = store.segment(day, { namespace: 'sent-daily' });
   * const toSend = await sent.claimMany(candidateIds);   // only the ids this worker won
   * for (const id of toSend) enqueue(id);                // ...so nobody else will send them
   * ```
   *
   * **Pass a batch, not one id.** A Warm write rewrites a whole 64K-id chunk bitmap, so claiming ids one at a
   * time is the single most expensive way to use this library — measured at ~5,000 writes and ~23 MB for 5,000
   * ids, against 1 write and ~8 KB for the same ids in one call. This method does one OCC read-modify-write per
   * distinct chunk, giving you Redis's *semantics* without Redis's per-id *cost shape*.
   *
   * **Exactly-once holds per id**, which is the guarantee that matters: each id lives in one chunk, a chunk is
   * one OCC row, so exactly one concurrent claimer sees any given id as new. Like `addMany` it is **not** atomic
   * across chunks — a mid-flight failure can leave some chunks claimed — but re-running is safe, because
   * already-claimed ids simply come back as not-new.
   *
   * Order of the returned ids is unspecified.
   */
  claimMany(ids: Iterable<number>): Promise<number[]> {
    return this.timed('claimMany', () => this.engine.claimMany(this.ref, ids));
  }
  has(id: number): Promise<boolean> {
    return this.timed('has', () => this.engine.has(this.ref, id));
  }
  count(): Promise<number> {
    return this.timed('count', () => this.engine.count(this.ref));
  }
  iterate(): AsyncIterable<number> {
    return this.engine.iterate(this.ref);
  }

  /**
   * Chunk-skipping intersection: stream the ids in **this** segment AND every segment in `others`, ascending.
   * Fetches only the Cold chunks present in *all* operands (a key absent from any operand contributes nothing
   * and is never downloaded), streaming under a bounded in-flight window — so the Cold footprint stays small
   * (Lambda-friendly) regardless of segment size. Pass `concurrency` to tune that window (a positive integer).
   * AND is commutative, so `a.intersect([b])` and `b.intersect([a])` yield the same ids. (Warm state is read
   * up front, so total memory also carries each operand's Warm size — negligible under Topology-A.) Pass
   * `budget` to override the store's per-op denial-of-wallet budget for this call (or `false` to lift it).
   */
  /**
   * Map the facade's `Segment` handles in `exclude` down to the plain refs `core` takes. A method rather than
   * a module function because `ref` is class-private — the encapsulation is worth more than the free function.
   */
  private refsIn(
    options?: CombineIntoOptions,
  ): (BaseCombineOptions & { batchSize?: number; exclude?: SegmentRef[] }) | undefined {
    if (options === undefined) return undefined;
    const { exclude, ...rest } = options;
    return exclude === undefined ? rest : { ...rest, exclude: exclude.map((o) => o.ref) };
  }

  intersect(others: Segment[], options?: CombineOptions): AsyncIterable<number> {
    return this.engine.intersect([this.ref, ...others.map((o) => o.ref)], this.refsIn(options));
  }

  /**
   * Materialize `this ∩ others…` (minus `exclude`) **into** `dest` (added, not replaced). Streaming +
   * bounded-memory, but **not atomic** across chunks — see {@link addMany}.
   */
  intersectInto(dest: Segment, others: Segment[], options?: CombineIntoOptions): Promise<void> {
    return this.timed('intersectInto', () =>
      this.engine.intersectInto(
        dest.ref,
        [this.ref, ...others.map((o) => o.ref)],
        this.refsIn(options),
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
   * segment once (`unionInto`, or a bulk-load rebuild) is the cheaper shape.
   */
  union(others: Segment[], options?: CombineOptions): AsyncIterable<number> {
    return this.engine.union([this.ref, ...others.map((o) => o.ref)], this.refsIn(options));
  }

  /** Materialize `this ∪ others…` (minus `exclude`) **into** `dest`. **Not atomic** — see {@link addMany}. */
  unionInto(dest: Segment, others: Segment[], options?: CombineIntoOptions): Promise<void> {
    return this.timed('unionInto', () =>
      this.engine.unionInto(
        dest.ref,
        [this.ref, ...others.map((o) => o.ref)],
        this.refsIn(options),
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
   * To filter the *result of an intersection*, do not chain — pass `exclude` to {@link intersect} instead, so
   * the suppression folds into the same pass rather than materializing an intermediate segment first.
   */
  andNot(excludes: Segment[], options?: BaseCombineOptions): AsyncIterable<number> {
    return this.engine.andNot(
      this.ref,
      excludes.map((o) => o.ref),
      options,
    );
  }

  /** Materialize `this \ (excludes…)` **into** `dest`. **Not atomic** — see {@link addMany}. */
  andNotInto(
    dest: Segment,
    excludes: Segment[],
    options?: BaseCombineOptions & { batchSize?: number },
  ): Promise<void> {
    return this.timed('andNotInto', () =>
      this.engine.andNotInto(
        dest.ref,
        this.ref,
        excludes.map((o) => o.ref),
        options,
      ),
    );
  }

  /**
   * Grounded cost report for this segment (Phase 5b): storage cost from its **real** `.crbm` size (exact,
   * no payload reads); request cost from the supplied `workload` rates. A segment with no Cold generation
   * reports zero storage. See {@link CostReport} — it always includes a verdict (incl. the lose-zone).
   */
  async costReport(options?: {
    pricing?: PricingProfile;
    workload?: Workload;
    topology?: Topology;
  }): Promise<CostReport> {
    const canMeasure = this.engine.supportsColdSize;
    const size = canMeasure ? await this.engine.segmentSize(this.ref) : null;
    return groundedReport({
      coldBytes: size?.sizeBytes ?? 0,
      grounded: canMeasure,
      workload: options?.workload,
      topology: options?.topology,
      pricing: options?.pricing,
      extraNotes: canMeasure
        ? undefined
        : ['cold source has no sizeOf() — storage not measured, reported as $0.'],
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// Re-export the whole codec-agnostic core so `@cloudbitmaps/roaring` stays the one name to know: every driver,
// error, port, and helper an application needs is reachable from here exactly as it was before the family
// split. (`@cloudbitmaps/core` arrives transitively — users never install it directly.)
// ---------------------------------------------------------------------------------------------------
export * from '@cloudbitmaps/core';

// ...with the codec-bound overrides layered on top. These four core entry points need a bitmap codec, which
// core cannot default (it is codec-agnostic). Re-exporting them EXPLICITLY here shadows the same names from the
// `export *` above, so every signature stays exactly as it was before the family split — e.g.
// `bulkLoadCrbmGeneration(driver, key, ids)` still works with no options at all.
export {
  bulkLoadCrbmGeneration,
  compactSegment,
  runCompactionCycle,
  runExport,
} from './codec-bound';

// The roaring codec itself. `SafeBitmap` is public surface (`writeCrbmGeneration` takes them — the seed /
// bulk-load path); `roaringCodec` is the `CodecInterface` this facade injects, exported so an advanced caller
// can construct a `SegmentEngine` by hand.
export { SafeBitmap, roaringCodec } from './roaring-codec';

/** Package version marker. Kept in sync with package.json at release. */
export const VERSION = '0.8.2';
