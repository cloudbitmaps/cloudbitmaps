/**
 * CloudRoaring — distributed, cloud-native Roaring Bitmaps, read from object storage.
 *
 * The `CloudRoaring` class is the read engine over **loaded** segments: write-once `.crbm` generations in an
 * object store, behind one registry pointer per segment. You wire storage **once**, as a single config object: a
 * Cold driver (`cold`) and optionally a `registry` (the authoritative generation pointer — needed to read
 * encrypted segments, to resolve generations without a cold `list`-scan, and for every lifecycle helper) and a
 * `keystore` (encryption-at-rest / crypto-shred). Pass a **raw** {@link IColdDriver} as `cold` (e.g.
 * `S3ColdDriver`, `LocalFsColdDriver`, `MemoryColdDriver`) and the store assembles the `.crbm` cold source
 * ({@link CrbmColdChunkSource}) for you — so each driver is named exactly once. Or pass an already-built
 * {@link ColdChunkSource} to control advanced reader options yourself.
 *
 * **Data gets in by loading a generation**, never by mutating one: `bulkLoadCrbmGeneration` streams a set of ids
 * into one immutable object and publishes it forward-only. Every other write in the library is a load in
 * disguise — `intersectInto`/`unionInto`/`andNotInto` write a new generation of their destination, and
 * `eraseSubject` rewrites a generation without one id. Reads (`has`/`count`/`iterate`/`intersect`/`union`/`andNot`)
 * see whole, checksum-verified generations and nothing else.
 *
 * In-process lifecycle helpers — `eraseSubject`, `subjectReport`, `dropSegment`, `retireExpired`,
 * `checkConsistency`, `exportSegments` — reuse the store's own drivers, so you never re-pass them (they need the
 * store built with a raw cold driver + registry). See the README and the getting-started guide.
 */

import {
  BoundedLru,
  CrbmColdChunkSource,
  DEFAULT_BUDGET,
  NOOP_METRICS,
  RetryingColdChunkSource,
  SegmentEngine,
  UnsupportedError,
  ValidationError,
  WriteConflictError,
  MIN_EXPIRES_AT_MS,
  collectWithinBudget,
  excludingReservedRows,
  dropSegment,
  estimateCost,
  groundedReport,
  mapWithConcurrency,
  nextGeneration,
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
  validateSegmentRef,
} from '@cloudbitmaps/core';
import type {
  Budget,
  BudgetOption,
  BulkLoadResult,
  Clock,
  CodecBitmap,
  CodecInterface,
  ColdChunkSource,
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
  Workload,
} from '@cloudbitmaps/core';
import { bulkLoadCrbmGeneration, eraseIdFromSegment } from './codec-bound';
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
 * Tenancy guard for the global-scope admin scans (`subjectReport`/`eraseSubject`). Ids live in ONE global
 * `[0, 2³²)` space shared across namespaces, so a namespace-less scan reaches into *every* tenant's segments.
 * Require an explicit `namespace`, or a deliberate `{ allNamespaces: true }` ack, so a fleet-wide sweep is never
 * the accidental default on a shared store.
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
 * Wiring for a {@link CloudRoaring} store. **Only `cold` is required** — the minimal call is
 * `new CloudRoaring({ cold })`, which reads cleartext segments by list-scanning the bucket for the latest
 * generation. Add a `registry` to resolve generations with one strong read, to read encrypted segments, and to
 * unlock every lifecycle helper (recommended for anything beyond a quick look). Everything else is **optional
 * tuning with sensible defaults** — resilience/retries are already on, the hot cache is bounded, metrics are a
 * no-op — so reach for them only when you need to.
 */
export interface CloudRoaringOptions {
  /**
   * Cold tier. Pass a **raw** {@link IColdDriver} (`S3ColdDriver`, `LocalFsColdDriver`, `MemoryColdDriver`, …)
   * and the store wraps it in a {@link CrbmColdChunkSource} using `registry`/`keystore` below — the common case,
   * so you wire each driver **once**. Or pass an already-built {@link ColdChunkSource} (`MemoryColdChunkSource`,
   * or a `CrbmColdChunkSource` you configured with advanced reader options) to use as-is.
   */
  readonly cold: IColdDriver | ColdChunkSource;
  /**
   * Authoritative registry — the per-segment `currentGen` pointer + wrapped-DEK holder. Applies when `cold` is a
   * **raw driver**: it (a) resolves the current generation with one strong read instead of a cold `list`-scan,
   * (b) lets the store read **encrypted** segments (that's where wrapped DEKs live), and (c) is what the
   * lifecycle helpers and the `*Into` verbs publish through. Optional — a registry-less store reads the highest
   * generation by list-scanning Cold (cleartext only, read-only). When you pass a pre-built `ColdChunkSource`,
   * that source resolves its own generations, so a top-level `registry` is inert there and rejected as a wiring
   * mistake — configure it on the source instead.
   */
  readonly registry?: IRegistryDriver;
  /**
   * Keystore for encryption-at-rest / crypto-shred. Required to read encrypted segments; needs a `registry`
   * (that's where wrapped DEKs are stored). Applied only when `cold` is a raw driver — when you pass a pre-built
   * {@link ColdChunkSource}, configure the keystore on that source instead.
   */
  readonly keystore?: IKeystore;
  /**
   * Refuse to touch a **cleartext** segment — a guard against silently reading, or writing, data that should be
   * encrypted. Needs a `registry`; applied only when `cold` is a raw driver. Off by default (encryption is opt-in).
   *
   * It refuses **writes** as well as reads, which is easy to miss: the `*Into` verbs and `eraseSubject` both carry
   * it into their write path, so on a cleartext segment a materialisation throws and an erasure records
   * `note: 'error: requireEncryption: …'` in its ledger rather than erasing. And since a segment's encryption is
   * decided at its **first** generation, this cannot be switched on for a segment that already has one — load
   * into a new encrypted segment and drop the old one.
   */
  readonly requireEncryption?: boolean;
  /** Injected for deterministic tests; defaults to a system clock. */
  readonly clock?: Clock;
  /** Injected for deterministic tests; defaults to `Math.random`-backed. Drives transient-retry jitter. */
  readonly rng?: Rng;
  /** HOT cache ceiling (decoded Cold chunks). */
  readonly cacheMaxChunks?: number;
  /** Optional TTL on cached chunks (ms). */
  readonly cacheTtlMs?: number;
  /**
   * How long (ms) the store trusts a segment's resolved `currentGen` before re-resolving it on the next read
   * (default 2000) — the bound on read staleness after a load publishes a new generation. Applies only when
   * `cold` is a raw driver **and** a `registry` is wired (the cheap `currentGen` read the refresh needs; a
   * registry-less store pins per source lifetime). Lazy — no timer; ≤ one registry read per segment per window,
   * opening a new reader only when the generation actually advanced.
   */
  readonly coldGenTtlMs?: number;
  /**
   * Ceiling on how many segments' `.crbm` readers (each holding a parsed index) the store keeps open at once
   * (default 1024) — the steady-state memory bound for a long-running server that reads across many segments.
   * Past it the least-recently-used segment's reader is evicted; re-opening it later is one cheap tail GET.
   * Applies only when `cold` is a raw driver (a pre-built `ColdChunkSource` manages its own reader cache).
   */
  readonly coldReaderCacheMax?: number;
  /**
   * Aggregate byte ceiling on the parsed `.crbm` indices the open readers hold (default 64 MiB) — the byte half
   * of the memory bound, complementing the `coldReaderCacheMax` *count* bound. A wide/dense segment's parsed
   * index can be several MB, so a count-only bound could let the open readers pin ~GBs and blow a small heap
   * (e.g. a 128 MB Lambda); this evicts the least-recently-used reader once the summed index footprint would
   * exceed the ceiling — whichever of the count/byte bounds binds first. Lower it for memory-tight deployments
   * that read across wide segments. Applies only when `cold` is a raw driver.
   */
  readonly coldReaderCacheMaxBytes?: number;
  /**
   * Resilience: by default every cold read retries **transient** faults (throttling, 5xx, dropped connections)
   * with bounded, jittered exponential backoff (see {@link DEFAULT_RETRY_POLICY}). Pass a {@link RetryPolicy} to
   * tune it, or `false` to disable the transient-retry wrapper entirely (e.g. if your injected client already
   * retries). Deterministic errors (`ValidationError`/`IntegrityError`/`WriteConflictError`/…) are never retried
   * by this layer.
   */
  readonly retry?: RetryPolicy | false;
  /** Observability: called before each transient-retry backoff wait. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
  /**
   * Observability sink: receives typed metric events (cold GET/bytes, cache hit/miss, retries, intersection
   * efficiency, op latency). Defaults to a no-op — emission is skipped entirely when unused (near-zero
   * overhead). Any exception the sink throws is swallowed — metrics can never break a read.
   */
  readonly metrics?: IMetricsSink;
  /**
   * Per-op **denial-of-wallet** budget: the max backend requests a single
   * `count`/`iterate`/`intersect`/`union`/`andNot`/`subjectReport`/`eraseSubject` may fan out into before it's
   * refused with {@link BudgetExceededError} — so one runaway op can't drive unbounded GET cost on a shared
   * backend. **On by default, generous** ({@link DEFAULT_BUDGET}: 1,000,000 requests — a normal op never hits it).
   * Tune with `{ maxRequests }`, override per op (on the combines / `subjectReport` / `eraseSubject`), or set
   * `false` to disable. The check is O(1) (before fan-out), so the hot path is untouched; per-request bytes are
   * separately size-capped, so bounding requests transitively bounds bytes.
   */
  readonly budget?: BudgetOption;
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
   * True iff the id **was** a member and a generation without it is now current — and the generation that held
   * the bit has been deleted from the bucket. The physical half is inherent: an erasure is a rewrite, and the
   * rewrite's predecessor is collected before this entry is returned (see {@link CloudRoaring.eraseSubject}).
   */
  readonly erased: boolean;
  /** The generation the id was found in (present whenever the segment was read). */
  readonly fromGeneration?: number;
  /** The generation written without the id (present whenever one was written). */
  readonly generation?: number;
  /**
   * Why the id was NOT erased from this segment, when `erased` is false. `'superseded'` — a newer generation
   * was published while the rewrite was in flight, by a load or by another erasure, so **this call** did not
   * erase the id; re-run against the new generation, which erases it if it is still there and reports nothing
   * for the segment if the racing writer already removed it. `` `error: <message>` `` — an isolated per-segment
   * fault (per-segment faults are recorded so one segment can't discard the whole ledger); re-run after fixing
   * the fault. Segments the id is not in are not listed at all.
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

/** What an `*Into` verb wrote: the new generation of the destination and what it holds. */
export interface MaterializeResult {
  /** The destination's new current generation. */
  readonly generation: number;
  /** Ids in the generation. */
  readonly cardinality: number;
  /** Non-empty chunks in the generation. */
  readonly chunkCount: number;
  /** Bytes of the written object. */
  readonly size: number;
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
 * the store keeps the raw driver so its lifecycle helpers and the `*Into` verbs can write generations without
 * you re-passing drivers. `driver` is `undefined` for a pre-built source (there's no underlying `IColdDriver` to
 * write through — those callers use the free functions).
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

/** The deps every write-side helper on the store shares: raw cold + registry + the store's codec/crypto/clock. */
interface LifecycleDeps {
  readonly cold: IColdDriver;
  readonly registry: IRegistryDriver;
  readonly codec: CodecInterface;
  readonly clock: Clock;
  readonly keystore?: IKeystore;
  readonly requireEncryption?: boolean;
}

export class CloudRoaring {
  private readonly engine: SegmentEngine;
  private readonly clock: Clock;
  private readonly metrics: IMetricsSink;
  // The store's own drivers, kept so the lifecycle helpers and the `*Into` verbs reuse them instead of making
  // you re-pass deps. `coldDriver` is set only when `cold` was a raw IColdDriver (a pre-built ColdChunkSource has
  // no underlying driver to write through).
  private readonly coldDriver: IColdDriver | undefined;
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
    // Resilience on by default: wrap the source so transient faults retry with jittered backoff. `false` opts
    // out (e.g. the injected client already retries); a RetryPolicy tunes it.
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
      cold = new RetryingColdChunkSource(cold, retryOpts);
    }
    // Resolve the denial-of-wallet budget once (validates; `false` ⇒ null = disabled) and share it between the
    // engine (count/iterate/combines) and the facade's admin scans (subjectReport/eraseSubject).
    this.budget = resolveBudget(options.budget, DEFAULT_BUDGET);
    const deps: EngineDeps = {
      cold,
      cache,
      codec: roaringCodec, // the facade injects the flagship codec; core stays codec-agnostic
      clock,
      metrics,
      budget: this.budget,
    };
    this.engine = new SegmentEngine(deps);
    this.clock = clock;
    this.metrics = metrics;
    // Keep the raw drivers for the lifecycle helpers (see the fields above). They use the raw drivers directly —
    // a one-shot admin op surfaces a transient fault to the caller rather than retrying under the hood.
    this.coldDriver = resolved.driver;
    this.registry = options.registry;
    this.keystore = options.keystore;
    this.requireEncryption = options.requireEncryption ?? false;
  }

  /**
   * The write-side deps, from the store's own drivers, for the lifecycle helpers and the `*Into` verbs. Requires
   * the store to have been constructed with a **raw cold driver** (a pre-built `ColdChunkSource` has no
   * underlying `IColdDriver` to write through) and a `registry` (the pointer every write publishes through).
   * Out-of-process callers use the free functions with explicit deps.
   */
  private lifecycleDeps(op: string): LifecycleDeps {
    if (this.coldDriver === undefined) {
      throw new UnsupportedError(
        `${op} needs the store built with a raw cold driver (IColdDriver), not a pre-built ColdChunkSource — ` +
          'or call the equivalent free function with explicit deps',
      );
    }
    if (this.registry === undefined) {
      throw new UnsupportedError(`${op} needs a \`registry\` in the store config`);
    }
    return {
      cold: this.coldDriver,
      registry: this.registry,
      clock: this.clock,
      codec: roaringCodec, // facade injects the flagship codec
      keystore: this.keystore,
      requireEncryption: this.requireEncryption,
    };
  }

  /** Get a handle to a segment. Validates the name/namespace grammar. */
  segment(name: string, options?: SegmentOptions): Segment {
    const ref: SegmentRef = { segment: name, namespace: options?.namespace };
    validateSegmentRef(ref);
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
    return new Segment(
      this.engine,
      ref,
      this.clock,
      this.metrics,
      (dest, ids, op, audit) => this.materialize(dest, ids, op, audit),
      expiresAt,
    );
  }

  /**
   * Write `ids` as a **new generation of `dest`** and publish it forward-only — the shared body of the `*Into`
   * verbs. A load in disguise: `bulkLoadCrbmGeneration` over the store's own drivers, at the generation number
   * after the highest the registry or the bucket knows. The destination's previous generation stays readable
   * until the publish lands (readers re-resolve within `coldGenTtlMs`) and is collected by the next
   * `gcOrphanGenerations`/retention sweep — this call deletes nothing.
   */
  private async materialize(
    dest: SegmentRef,
    ids: AsyncIterable<number>,
    op: string,
    audit?: IAuditSink,
  ): Promise<MaterializeResult> {
    const deps = this.lifecycleDeps(op);
    const generation = await nextGeneration(dest, deps);
    const result: BulkLoadResult = await bulkLoadCrbmGeneration(
      deps.cold,
      { ...dest, generation },
      ids,
      {
        registry: deps.registry,
        keystore: deps.keystore,
        requireEncryption: deps.requireEncryption,
        clock: deps.clock,
        audit,
      },
    );
    if (result.becameCurrent === false) {
      // The object is durable, but a concurrent writer published a higher generation of `dest` between our
      // numbering and our publish, so ours is an orphan no reader will resolve. Returning the result here would
      // name `generation` as "the destination's new current generation" — which is what `MaterializeResult`
      // documents it to be, and it would be false. The destination holds someone else's content.
      //
      // A throw rather than a flag on the result: every other write path in the library reports a lost race
      // loudly (`WriteConflictError` on a write-once collision) or as a typed refusal (`'superseded'` from the
      // erasure rewrite), and a materialisation that silently did not take effect is the one outcome a caller
      // cannot detect on its own. The orphan is collected by the next `gcOrphanGenerations`/retention sweep.
      throw new WriteConflictError(
        `${op}: generation ${generation} of "${dest.segment}" was written but a newer generation was published ` +
          `first, so it never became current — nothing was materialised. Re-run against the new generation.`,
      );
    }
    return {
      generation,
      cardinality: result.cardinality,
      chunkCount: result.chunkCount,
      size: result.size,
    };
  }

  /**
   * **Subject access (GDPR Art. 15 / CCPA right-to-know): which segments is this id a member of?**
   *
   * Enumerates the **registered** segments (via the store's own `registry`) and does a `has(id)` on each — no
   * drivers to re-pass. Complete only over registered segments (every loaded segment has a row, so register the
   * registry the loads used). There is deliberately **no `id → segments` reverse index** — that would tax every
   * load for a rare request; this admin scan is `O(registered segments)` and touches no hot path. Requires a
   * `registry` in the store config (throws {@link UnsupportedError} otherwise).
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
      // A subject cannot be in a coordination row, and charging this request's budget for them would refuse a
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
   * generation it was derived from**, and
   * collects the generation that held the bit. The returned per-segment record is your **erasure ledger** —
   * persist it / route it to your audit sink as the proof of deletion (a `segment.rewrite` audit event is also
   * emitted per rewrite when you pass `audit`).
   *
   * Uses the store's **own** drivers (raw cold + registry), so the membership check and the rewrite provably run
   * over the same generation. Requires the store built with a **raw cold driver + registry** (throws
   * {@link UnsupportedError} otherwise; a pre-built `ColdChunkSource` store has no `IColdDriver` to write
   * through — use the `eraseIdFromSegment` free function there).
   *
   * **One contract remains** (an integrator obligation the library cannot check): **do not load the segment
   * while erasing from it.** A load that lands after the rewrite carries whatever its source held, and the
   * library cannot know that source was meant to exclude the id. Quiesce loads of the affected segments for the
   * duration, or fix the source first and load after. A writer that lands *during* the rewrite is caught: the
   * rewrite's publish is refused **by the fence** — `publishGeneration`'s `expectFrom`, which lands the CAS only
   * while the pointer is still on the generation the rewrite streamed — and the entry says `note: 'superseded'`,
   * so re-run. Forward-only alone would NOT refuse it: `nextGeneration` numbers above everything in the bucket,
   * so the rewrite would out-rank the newer generation and then collect it.
   *
   * A racing **erasure** is caught before that, and reported the same way. It collects with `keep: 0`, taking
   * every generation below its new pointer — the one this rewrite is streaming, and the object this rewrite
   * just wrote — so the loser can find its own inputs deleted mid-flight. That surfaces as a reason rather than
   * an error, read off the row: a moved pointer is `'superseded'`, a concurrent `dropSegment` `'destroyed'`,
   * a retention sweep that purged the row `'absent'`. Re-running is the fix in every case.
   *
   * **Read `note` on any `erased: false` entry — the two reasons mean different things.** `'superseded'` means
   * another writer (a load, or another erasure) moved the pointer mid-rewrite, so **this call** did not erase
   * the id. Re-run: it erases the id if it is still there, and lists nothing for the segment if a racing
   * erasure of the same id already removed it. Do not read `'superseded'` as "the id is still present" —
   * read it as "not done by this call, and the re-run settles it".
   * `` `error: …` `` is a per-segment fault (caught so one segment can't discard the whole ledger) and it can land
   * on either side of the publish: if the rewrite had not published, the id is still there and a re-run erases
   * it; if the publish succeeded and only the **collection** of the old generation failed, the id is already
   * absent from every read and what remains is an object in the bucket that still contains the bit. A re-run
   * then reports nothing for that segment (the id is not in the current generation), so **that residual is
   * collected by `gcOrphanGenerations(ref, deps, { keep: 0 })` or the next retention sweep**, not by another
   * `eraseSubject`. Re-running is otherwise safe and idempotent: a segment the id is no longer in is not listed. Admin-only path;
   * `O(registered segments)`, no hot-path cost. Per-subject crypto-shred is infeasible (a subject's bit is
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
          // engine's cached view, which may lag a load by up to `coldGenTtlMs`. An Art. 17 erasure must never
          // skip a segment because a read cache hasn't caught up yet.
          const result = await eraseIdFromSegment(ref, id, deps, { audit: options.audit });
          // Whatever the outcome, this process's own view of the segment is now suspect: a landed rewrite
          // deleted the generation our caches were built on, and a refused one means somebody else's did.
          // Without this the erasing store keeps answering `true` for the id it just reported erased — out of
          // RAM, with no storage read for any control to intercept.
          this.engine.invalidate(ref);
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
        }
      },
    );
    const erasedFrom = entries.filter((e): e is SubjectErasureEntry => e !== null);
    return { id, erasedFrom, scannedSegments: recs.length };
  }

  /**
   * **Dispose of a segment — tombstone it, then delete its Cold objects.** Irreversible.
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
   * **Inspect `generationsRemaining`.** Empty is the normal outcome; non-empty means the storage was NOT fully
   * reclaimed and the drop should be re-run. A load that was already writing when the tombstone landed still
   * finishes its object, so a single sweep can miss it — this call re-sweeps and then reports whatever it still
   * could not remove rather than returning a result that looks like a clean drop.
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
    const deps = this.lifecycleDeps('dropSegment');
    try {
      return await dropSegment(ref, { registry: deps.registry, cold: deps.cold }, options);
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
   * result) with **no Cold generation**, so the policy is recorded ahead of the data and the segment is already
   * enumerable by the sweep; the first load then publishes onto that row.
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
   * the job that runs your loads). A library that started a timer would behave differently in a Lambda, an edge
   * isolate and a long-lived server, which is worse than not having one.
   *
   * Each retirement goes through `dropSegment`, so the registry → Cold ordering, the re-sweep for an object a
   * load was still writing, and the `generationsRemaining` report all come from one implementation rather than
   * two.
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
   * successes, which is what makes it a real bound: `dropSegment` writes the tombstone before sweeping Cold, so a
   * fault in the Cold phase is a segment that is already retired. Retirements are sequential, so `limit` is a
   * wall-clock knob too, and `retired` counts deletions only — a dry run reports `wouldRetire` instead, so a
   * dashboard summing `retired` can never show a phantom deletion.
   *
   * It also **deletes the tombstone rows its own past retirements left**, after `tombstoneGraceMs` (default 24 h)
   * and only once that segment's Cold generations are provably gone — collecting a straggler generation itself
   * first, since nothing else ever would for a tombstoned segment. Attribution is a **positive marker the sweep
   * stamps on its own retirements**, not an inference from "destroyed + an expired policy": a crypto-shred leaves
   * `retention` untouched, so setting a policy and then honouring a right-to-erasure request mid-window produces
   * exactly that row, and deleting it would destroy the Art. 17 attestation and un-fence the name. Pass
   * `purgeTombstones: false` to keep every tombstone.
   *
   * Needs the store built with a **raw cold driver + a registry** (throws {@link UnsupportedError} otherwise),
   * because retiring a segment deletes its Cold objects. `now` defaults to the store's clock.
   */
  async retireExpired(
    options: Omit<RetireExpiredOptions, 'now'> & { now?: number } = {},
  ): Promise<RetireExpiredResult> {
    const deps = this.lifecycleDeps('retireExpired');
    const result = await retireExpired(
      { registry: deps.registry, cold: deps.cold },
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
   * The verbs on this class handle themselves — `eraseSubject`, `dropSegment` and `retireExpired` invalidate
   * what they touch. This method is for the cases they cannot see:
   *
   * - **`destroySegment` / `eraseNamespace`**, which are free functions over raw drivers rather than methods
   *   here, so a crypto-shred performed beside this store leaves it holding an open reader and an unwrapped
   *   DEK. Until it is told, it keeps decrypting — including chunks it had never fetched before the shred.
   * - **Another process.** Erasing on one box invalidates nothing on the others; each store bounds its own
   *   staleness by `coldGenTtlMs`, and a store built with no clock or `coldGenTtlMs: 0` ("pin forever") never
   *   converges at all. If a compliance deadline depends on every reader converging, you need to signal them —
   *   this is the call to make when your own fan-out delivers.
   *
   * Synchronous, best-effort, and safe to call for a segment this store has never read.
   *
   * ```ts
   * await destroySegment(ref, { cold, registry, keystore }, { confirmSegment: ref.segment });
   * store.invalidate(ref);                       // this process
   * await bus.publish('cloudbitmaps.invalidate', ref); // and every other one
   * ```
   */
  invalidate(ref: SegmentRef): void {
    validateSegmentRef(ref);
    this.engine.invalidate(ref);
  }

  /** The store's registry, or a typed error naming the operation that needs one. */
  private requireRegistry(op: string): IRegistryDriver {
    if (this.registry === undefined) {
      throw new UnsupportedError(`${op} needs a \`registry\` in the store config`);
    }
    return this.registry;
  }

  /**
   * **Cross-tier DR consistency check.** After a restore/failover, verify every registered segment's `currentGen`
   * actually has its `.crbm` present in Cold — catching a **torn restore** where the registry (`currentGen`) came
   * back ahead of the object store, so a pointer references a generation that isn't there (reads would then
   * throw). Read-only, bounded fan-out; run it at startup after a restore. Returns `{ checked, inconsistent }` —
   * `inconsistent` empty ⇒ coherent; otherwise it names the segments to recover (restore the object store, or
   * roll the registry back to a coherent point). Needs the store built with a **raw cold driver + a registry**
   * (throws {@link UnsupportedError} otherwise). `destroyed` (crypto-shredded) segments are skipped. Pair it with
   * the DR runbook (docs/guide/disaster-recovery.md).
   */
  async checkConsistency(
    options: { namespace?: string; concurrency?: number } = {},
  ): Promise<ConsistencyReport> {
    const deps = this.lifecycleDeps('checkConsistency');
    return runConsistencyCheck({ cold: deps.cold, registry: deps.registry }, options);
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

/** Options common to every chunk-aligned combine (`intersect` / `union` / `andNot`). */
export interface BaseCombineOptions {
  /** Max chunk keys resolved concurrently — bounds the Cold footprint. A positive integer. */
  readonly concurrency?: number;
  /** Override the store's per-op denial-of-wallet budget for this call (`false` lifts it). */
  readonly budget?: BudgetOption;
  /**
   * Audit sink for the **`*Into` verbs only** — they publish a generation, and a publish is an auditable event
   * (`segment.publish`, exactly as a load emits). Ignored by the streaming verbs, which write nothing.
   *
   * It is here rather than on the store because that is where every other auditable operation takes it
   * (`eraseSubject`, `dropSegment`, `retireExpired`): the caller who performs the act decides where the record
   * goes. Without it a `*Into` was the one write path in the library that could make a generation current and
   * leave no trace in the compliance trail.
   */
  readonly audit?: IAuditSink;
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

/** The empty id stream every expired read path returns — allocated once, so an expired read costs nothing. */
const EMPTY_IDS: AsyncIterable<number> = {
  async *[Symbol.asyncIterator]() {
    // deliberately yields nothing
  },
};

/** How a `Segment` hands a result stream back to its store to become a new generation of `dest`. */
type Materialize = (
  dest: SegmentRef,
  ids: AsyncIterable<number>,
  op: string,
  audit?: IAuditSink,
) => Promise<MaterializeResult>;

/**
 * A handle bound to one segment — the read verbs, plus the three `*Into` verbs that write a **new generation**
 * of another segment.
 *
 * **IDs must be integers in `[0, 2^32)`** (dense 32-bit). A non-integer / negative / out-of-range id
 * throws {@link ValidationError}.
 *
 * There is no `add`/`remove` on a handle: data enters a segment as a whole generation (`bulkLoadCrbmGeneration`,
 * or one of the `*Into` verbs), and leaves it the same way (`eraseSubject`, `dropSegment`).
 */
export class Segment {
  private readonly metricsOn: boolean;

  constructor(
    private readonly engine: SegmentEngine,
    private readonly ref: SegmentRef,
    private readonly clock: Clock,
    private readonly metrics: IMetricsSink,
    private readonly materialize: Materialize,
    /** Absolute epoch-ms deadline from {@link SegmentOptions.expiresAt}; `undefined` ⇒ this handle never expires. */
    readonly expiresAt?: number,
  ) {
    this.metricsOn = metrics !== NOOP_METRICS;
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
   * quietly passed publishes an **empty generation over `dest`** — a wipe, reported as a successful write, with
   * the cause (a deadline on a handle somewhere) nowhere in the result. Reads degrade to empty; writes must not.
   *
   * So every handle in the call is checked, `dest` included: an expired `dest` does not change the bytes written,
   * but a caller who put a deadline on the thing they are writing into has said something contradictory and is
   * better told than guessed at. Open a handle without `expiresAt` to write, or drop the deadline.
   *
   * (The broader guard — refusing to publish an empty generation over a non-empty one, with an `allowEmpty`
   * override — belongs to `load()` and covers these verbs too when it lands. This is the narrow case that is
   * unambiguously a mistake and costs one comparison to catch.)
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

  /** Membership: one chunk — the hot cache, else one ranged GET. Throws {@link ValidationError} on a bad id. */
  has(id: number): Promise<boolean> {
    if (this.expired()) return Promise.resolve(false);
    return this.timed('has', () => this.engine.has(this.ref, id));
  }
  /** Cardinality — summed from the `.crbm` index with **zero payload reads** on a loaded segment. */
  count(): Promise<number> {
    if (this.expired()) return Promise.resolve(0);
    return this.timed('count', () => this.engine.count(this.ref));
  }
  /** Every id, ascending, streamed one chunk at a time. */
  iterate(): AsyncIterable<number> {
    if (this.expired()) return EMPTY_IDS;
    return this.engine.iterate(this.ref);
  }

  /**
   * Map the facade's `Segment` handles in `exclude` down to the plain refs `core` takes. A method rather than
   * a module function because `ref` is class-private — the encapsulation is worth more than the free function.
   */
  private refsIn(
    options?: CombineOptions,
  ): (BaseCombineOptions & { exclude?: SegmentRef[] }) | undefined {
    if (options === undefined) return undefined;
    const { exclude, ...rest } = options;
    return exclude === undefined ? rest : { ...rest, exclude: exclude.map((o) => o.ref) };
  }

  /**
   * Chunk-skipping intersection: stream the ids in **this** segment AND every segment in `others`, ascending.
   * Fetches only the Cold chunks present in *all* operands (a key absent from any operand contributes nothing
   * and is never downloaded), streaming under a bounded in-flight window — so the Cold footprint stays small
   * (Lambda-friendly) regardless of segment size. Pass `concurrency` to tune that window (a positive integer).
   * AND is commutative, so `a.intersect([b])` and `b.intersect([a])` yield the same ids. Pass `budget` to
   * override the store's per-op denial-of-wallet budget for this call (or `false` to lift it).
   */
  intersect(others: Segment[], options?: CombineOptions): AsyncIterable<number> {
    // An expired operand is empty, and anything ANDed with the empty set is empty. Guarding here rather than
    // only in `count()` is what keeps the surface coherent: a segment whose `count()` is 0 must not still
    // contribute members to an intersection.
    if (this.expired() || others.some((o) => o.expired())) return EMPTY_IDS;
    return this.engine.intersect([this.ref, ...others.map((o) => o.ref)], this.refsIn(options));
  }

  /**
   * Materialize `this ∩ others…` (minus `exclude`) as a **new generation of `dest`** — `dest`'s previous contents
   * are superseded, not added to. Streaming + bounded-memory; the result is one immutable object published
   * forward-only, so readers of `dest` see either the old generation or the new one, never a partial. Needs the
   * store built with a raw cold driver + registry (throws {@link UnsupportedError} otherwise).
   *
   * **An empty result publishes an empty generation** — deliberate for now (the guard that refuses empty over
   * non-empty arrives with `load()`), with one exception: a call involving an **expired handle** is refused
   * rather than silently wiping `dest`. See {@link refuseIfExpired}.
   */
  async intersectInto(
    dest: Segment,
    others: Segment[],
    options?: CombineOptions,
  ): Promise<MaterializeResult> {
    this.refuseIfExpired('intersectInto', dest, [...others, ...(options?.exclude ?? [])]);
    return this.timed('intersectInto', () =>
      this.materialize(dest.ref, this.intersect(others, options), 'intersectInto', options?.audit),
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
  union(others: Segment[], options?: CombineOptions): AsyncIterable<number> {
    // OR: drop the expired operands and union what is left. All expired ⇒ empty.
    const live = others.filter((o) => !o.expired());
    if (this.expired()) {
      if (live.length === 0) return EMPTY_IDS;
      return (live[0] as Segment).union(live.slice(1), options);
    }
    if (live.length === 0 && others.length > 0) {
      // Every operand expired ⇒ just us. But `exclude` is not an operand of the union, it is a subtraction
      // applied to the result, so it still applies: `(this ∪ nothing) \ exclude` is `this \ exclude`. Returning
      // a bare `iterate()` here dropped it silently — an opt-out list that does not apply, on a library whose
      // headline is composable suppression, and reachable from nothing more exotic than a segment handle aging
      // out. `andNot` reads each exclude only where it overlaps, so this is also the cheap spelling.
      const exclude = options?.exclude ?? [];
      return exclude.length > 0 ? this.andNot([...exclude], options) : this.iterate();
    }
    if (live.length !== others.length) return this.union(live, options);
    return this.engine.union([this.ref, ...others.map((o) => o.ref)], this.refsIn(options));
  }

  /** Materialize `this ∪ others…` (minus `exclude`) as a **new generation of `dest`** — see {@link intersectInto}. */
  async unionInto(
    dest: Segment,
    others: Segment[],
    options?: CombineOptions,
  ): Promise<MaterializeResult> {
    this.refuseIfExpired('unionInto', dest, [...others, ...(options?.exclude ?? [])]);
    return this.timed('unionInto', () =>
      this.materialize(dest.ref, this.union(others, options), 'unionInto', options?.audit),
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
    // MINUS: an expired base is empty; an expired exclusion excludes nothing.
    if (this.expired()) return EMPTY_IDS;
    const liveExcludes = excludes.filter((e) => !e.expired());
    // Every exclusion expired ⇒ nothing to subtract. Recursing with an empty list would throw, since `andNot`
    // requires at least one operand — a caller whose suppression list happened to age out must not get an error.
    if (liveExcludes.length === 0 && excludes.length > 0) return this.iterate();
    if (liveExcludes.length !== excludes.length) return this.andNot(liveExcludes, options);
    return this.engine.andNot(
      this.ref,
      excludes.map((o) => o.ref),
      options,
    );
  }

  /** Materialize `this \ (excludes…)` as a **new generation of `dest`** — see {@link intersectInto}. */
  async andNotInto(
    dest: Segment,
    excludes: Segment[],
    options?: BaseCombineOptions,
  ): Promise<MaterializeResult> {
    this.refuseIfExpired('andNotInto', dest, excludes);
    return this.timed('andNotInto', () =>
      this.materialize(dest.ref, this.andNot(excludes, options), 'andNotInto', options?.audit),
    );
  }

  /**
   * Grounded cost report for this segment: storage cost from its **real** `.crbm` size (exact, no payload
   * reads); request cost from the supplied `workload` rates. A segment with no Cold generation reports zero
   * storage. See {@link CostReport} — it always includes a verdict (incl. the lose-zone).
   */
  async costReport(options?: {
    pricing?: PricingProfile;
    workload?: Workload;
  }): Promise<CostReport> {
    const canMeasure = this.engine.supportsColdSize;
    const size = canMeasure ? await this.engine.segmentSize(this.ref) : null;
    return groundedReport({
      coldBytes: size?.sizeBytes ?? 0,
      grounded: canMeasure,
      workload: options?.workload,
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

// ...with the codec-bound overrides layered on top. These three core entry points need a bitmap codec, which
// core cannot default (it is codec-agnostic). Re-exporting them EXPLICITLY here shadows the same names from the
// `export *` above, so every signature stays exactly as it was before the family split — e.g.
// `bulkLoadCrbmGeneration(driver, key, ids)` still works with no options at all.
export { bulkLoadCrbmGeneration, eraseIdFromSegment, runExport } from './codec-bound';

// The roaring codec itself. `SafeBitmap` is public surface (`writeCrbmGeneration` takes them — the seed /
// bulk-load path); `roaringCodec` is the `CodecInterface` this facade injects, exported so an advanced caller
// can construct a `SegmentEngine` by hand.
export { SafeBitmap, roaringCodec } from './roaring-codec';

/** Package version marker. Kept in sync with package.json at release. */
export const VERSION = '0.9.0';
