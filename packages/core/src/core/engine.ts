/**
 * SegmentEngine — the in-memory core: routing + tombstone merge + the HOT cache, exposing the read/write
 * ops over the driver interfaces. Storage-agnostic and time/random-free
 * (the determinism seam): all I/O is via injected drivers; the cache carries its own `Clock`.
 */
import { splitId, joinId, CHUNK_COUNT, MAX_REMAINDER } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import {
  emptyDelta,
  applyAdd,
  applyRemove,
  applyAddAll,
  applyRemoveAll,
  effective,
  encodeDelta,
  decodeDelta,
} from './chunk';
import type { ChunkDelta } from './chunk';
import { checkBudget, DEFAULT_BUDGET, resolvePerOpBudget } from './budget';
import type { Budget, BudgetOption } from './budget';
import { mapWithConcurrency } from './concurrency';
import { yieldEvery } from './cooperative';
import type { Clock, Rng } from './determinism';
import {
  BudgetExceededError,
  IntegrityError,
  ValidationError,
  WriteConflictError,
  isWriteConflictError,
} from './errors';
import { chunkGenKey, chunkRefKey } from './keys';
import type { BoundedLru } from './lru';
import { NOOP_METRICS, safeMetrics } from './metrics';
import type { IMetricsSink } from './metrics';
import { NO_ROW } from './ports';
import type {
  ChunkRef,
  ColdChunkSource,
  IWarmDriver,
  SegmentRef,
  SegmentSize,
  WarmReadOptions,
  WarmRow,
} from './ports';
import { DEFAULT_OCC_BACKOFF, applyJitter, backoffDelayMs } from './retry';
import type { RetryPolicy } from './retry';

const DEFAULT_MAX_BITMAP_BYTES = 1 << 20; // 1 MiB per bitmap — generous; real chunks are far smaller
const DEFAULT_MAX_RETRIES = 16;
/** Max overlapping-chunk intersections in flight — bounds memory + concurrent reads (invariant 6). */
const DEFAULT_INTERSECT_CONCURRENCY = 8;
/**
 * Ids staged as uncompressed numbers before `mutateMany` folds them into per-chunk bitmaps.
 *
 * Caps the *transient* uncompressed overhead regardless of stream length — **measured ~28 MB** at this value
 * (1M ids spread across ~65,000 chunks; not the ~8 MB a naive 8-bytes-per-number estimate suggests, because the
 * cost is dominated by per-array and Map overhead across tens of thousands of small arrays). What persists
 * across the whole call is the compressed bitmaps this folds into, which for the same 5M ids measured **11 MB
 * against 212 MB** held as JS numbers. Matches bulk-load's `BULK_FLUSH_IDS`, which has the same shape.
 */
const MUTATE_STAGE_IDS = 1 << 20;
/** Ids between cooperative yields while ingesting — see `cooperative.ts` and bulk-load's matching constant. */
const YIELD_EVERY_IDS = 1 << 14;

/**
 * Pure no-wait clock / zero RNG used when the engine is constructed without a time source (e.g. unit tests
 * that don't exercise backoff). `sleep` resolves on a microtask (no timer — `core/` is timer-free) and the
 * RNG returns 0, so OCC backoff collapses to "retry immediately" — the pre-4b behaviour. Production wiring
 * (`CloudRoaring`) injects a real `setTimeout`-backed clock + RNG, enabling genuine jittered backoff.
 */
class InstantClock implements Clock {
  now(): number {
    return 0;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
  /**
   * An explicit no-op, so the intent is stated rather than inferred.
   *
   * Without it, `yieldEvery` would fall back to `sleep(1)` — and this clock's `sleep` ignores its argument and
   * resolves on a microtask, so the "yield" would silently do nothing while every doc comment claimed it did
   * something. This wiring has no real event loop to be courteous to (it is the clock used when nobody injects
   * one), so no-op is the right behaviour; it just has to be a decision rather than an accident.
   */
  yieldNow(): Promise<void> {
    return Promise.resolve();
  }
}
class ZeroRng implements Rng {
  next(): number {
    return 0;
  }
}

/**
 * Default ceiling on resident warm-delta bytes for a single segment scan: 64 MiB.
 *
 * Chosen to be generous enough that no realistic segment trips it — a maximally-wide segment of 65,536 chunks
 * would need ~1 KiB of warm delta per chunk to reach it — while still being small enough to keep a modest
 * container (a 512 MiB Lambda, say) alive rather than OOM-killed when a pathological segment or a hostile
 * caller shows up.
 */
export const DEFAULT_MAX_WARM_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Default number of Warm chunk writes in flight per `addMany`/`removeMany`: **4**.
 *
 * The flusher was serial by default, which meant a 100-chunk `addMany` against a backend with ~10 ms of
 * round-trip latency spent a full second doing nothing but waiting — one round-trip at a time, on work that has
 * no ordering requirement between chunks. Distinct chunks are independent OCC rows.
 *
 * **Why 4 and not more.** The number is chosen against the *backend's* tolerance, not the client's appetite. A
 * write here is a read-modify-write, so 4 in flight is up to 8 concurrent requests per `addMany` call — and a
 * server handling many concurrent calls multiplies that again. Provisioned-capacity backends answer a burst
 * with throttling, which is free only while retries can absorb it (4 attempts, exponential backoff, full
 * jitter). Swept against a **modelled** backend — an in-process fake that throttles on concurrent requests in
 * flight, not a real DynamoDB — 64 chunks, 5 trials each, counting a lost id or a surfaced error as a failure:
 *
 * ```text
 *   backend capacity:      1      2      4      8
 *   writeConcurrency  4:  0/5    0/5    0/5    0/5
 *   writeConcurrency  8:  0/5    0/5    0/5    0/5
 *   writeConcurrency 16:  0/5    0/5    0/5    0/5
 *   writeConcurrency 32:  3/5    0/5    0/5    0/5   ← retry budget exhausted
 * ```
 *
 * So the retry machinery holds far past 4; 4 is deliberately conservative, sitting 8x below the first observed
 * failure against the harshest backend modelled. The remaining headroom is spent on the multiplier this table
 * does not capture — many concurrent `addMany` calls sharing one backend — rather than on more throughput per
 * call. A caller who knows their capacity can raise it.
 *
 * Raise it if your backend is provisioned for it (on-demand DynamoDB, or a Postgres pool sized to match); set
 * it to `1` for the previous strictly-serial behaviour.
 */
export const DEFAULT_WRITE_CONCURRENCY = 4;

export interface EngineDeps {
  readonly warm: IWarmDriver;
  readonly cold: ColdChunkSource;
  /** Optional HOT cache of decoded (immutable) Cold chunks. */
  readonly cache?: BoundedLru<string, CodecBitmap>;
  readonly maxBitmapBytes?: number;
  /**
   * The bitmap codec — **required**. `core/` is
   * codec-agnostic: it can have no default, because the concrete codec lives in a *flavor* package that depends
   * on core (a default here would invert that arrow). A flavor's facade injects it — `@cloudbitmaps/roaring`
   * passes `roaringCodec` — so applications never see this.
   */
  readonly codec: CodecInterface;
  readonly maxRetries?: number;
  /** Injected for jittered OCC backoff + replayable tests; defaults to an instant clock / zero RNG. */
  readonly clock?: Clock;
  readonly rng?: Rng;
  /** Backoff schedule between OCC conflict retries; defaults to {@link DEFAULT_OCC_BACKOFF}. */
  readonly occBackoff?: RetryPolicy;
  /** Observability sink (Phase 5a); defaults to a no-op. Assumed exception-safe (the facade wraps it). */
  readonly metrics?: IMetricsSink;
  /**
   * Warm read consistency for the READ paths (`has`/`count`/`iterate`/`intersect`); default `'strong'`
   * (read-your-writes). `'eventual'` trades read-after-write for ~½ the DynamoDB RCU (gap #9). The OCC
   * read-modify-write path is always strong regardless (correctness).
   */
  readonly warmReadConsistency?: 'strong' | 'eventual';
  /**
   * Max Warm chunk writes in flight per `addMany`/`removeMany` (the bounded flusher).
   * Default {@link DEFAULT_WRITE_CONCURRENCY}.
   *
   * Each chunk is its own OCC row, so distinct chunks never conflict with each other and fanning them out is
   * safe. Raise it for more throughput against a backend with capacity to spare; set it to `1` for strictly
   * serial writes.
   *
   * As before, `addMany`/`removeMany` are **not atomic**: a mid-flush failure can leave a partial result. What
   * concurrency changes is only *how much* of the batch may already have landed when the first error surfaces —
   * the flusher stops scheduling on the first failure, but writes already in flight still settle.
   */
  readonly writeConcurrency?: number;
  /**
   * Hard ceiling on the bytes one warm scan may hold resident, in bytes. Default {@link DEFAULT_MAX_WARM_SCAN_BYTES}.
   *
   * **Separate from `budget`, and enforced even when `budget: false`.** The budget bounds *cost* — billable
   * requests — which is a different axis from memory, and conflating the two is what let a segment with
   * thousands of warm chunks materialise ~12 MB before a `maxRequests: 2` budget could refuse it. It is also
   * why `intersect` cannot use the budget as a memory bound: its budget is `common keys × operands`, a product
   * that one wide operand can legitimately exceed in row count while staying entirely legal.
   *
   * Always on, because a ceiling that `budget: false` switches off is missing at exactly the moment it is
   * needed. Configurable, because a ceiling you cannot raise is a landmine for a legitimately large segment.
   */
  readonly maxWarmScanBytes?: number;
  /**
   * Per-op denial-of-wallet budget (07 Decision #3 / T3), already resolved by the facade: a {@link Budget} to
   * enforce, or `null` to disable. Undefined ⇒ {@link DEFAULT_BUDGET} (a direct engine construction still gets
   * the generous default). Read ops refuse before fan-out if they'd exceed it.
   */
  readonly budget?: Budget | null;
}

type Mutator = (delta: ChunkDelta, ids: CodecBitmap) => void;

/** One resolved operand of a chunk-aligned combine: its key set + warm deltas + pinned generation. */
interface Operand {
  readonly seg: SegmentRef;
  readonly warmRows: Map<number, Uint8Array>;
  readonly keys: Set<number>;
  readonly gen: number | null | undefined;
}

export class SegmentEngine {
  private readonly warm: IWarmDriver;
  private readonly cold: ColdChunkSource;
  private readonly cache: BoundedLru<string, CodecBitmap> | undefined;
  private readonly codec: CodecInterface;
  private readonly maxBitmapBytes: number;
  private readonly maxRetries: number;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly occBackoff: RetryPolicy;
  private readonly metrics: IMetricsSink;
  private readonly metricsOn: boolean;
  /** Consistency for READ-path Warm fetches (precomputed; OCC RMW passes strong explicitly, see `warmGet`). */
  private readonly readOpts: WarmReadOptions;
  private readonly writeConcurrency: number;
  private readonly maxWarmScanBytes: number;
  /** Resolved per-op budget (null = disabled); undefined deps ⇒ the generous default. See {@link checkBudget}. */
  private readonly budget: Budget | null;

  constructor(deps: EngineDeps) {
    this.warm = deps.warm;
    this.cold = deps.cold;
    this.cache = deps.cache;
    this.codec = deps.codec;
    this.maxBitmapBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.clock = deps.clock ?? new InstantClock();
    this.rng = deps.rng ?? new ZeroRng();
    this.occBackoff = deps.occBackoff ?? DEFAULT_OCC_BACKOFF;
    this.readOpts = { consistent: (deps.warmReadConsistency ?? 'strong') !== 'eventual' };
    this.writeConcurrency = deps.writeConcurrency ?? DEFAULT_WRITE_CONCURRENCY;
    this.maxWarmScanBytes = deps.maxWarmScanBytes ?? DEFAULT_MAX_WARM_SCAN_BYTES;
    if (!Number.isFinite(this.maxWarmScanBytes) || this.maxWarmScanBytes < 1) {
      throw new ValidationError(
        `maxWarmScanBytes must be a finite number >= 1 (got ${String(deps.maxWarmScanBytes)})`,
      );
    }
    // undefined ⇒ the generous default; null ⇒ explicitly disabled (must not be re-defaulted by `??`).
    this.budget = deps.budget === undefined ? DEFAULT_BUDGET : deps.budget;
    // Wrap for defense-in-depth (idempotent for the no-op) so even a direct engine construction with a
    // throwing sink can't break the data path; `metricsOn` short-circuits all emission when unused.
    this.metrics = safeMetrics(deps.metrics ?? NOOP_METRICS);
    this.metricsOn = this.metrics !== NOOP_METRICS;
  }

  add(seg: SegmentRef, id: number): Promise<void> {
    const { chunkKey, remainder } = splitId(id);
    return this.readModifyWrite(seg, chunkKey, (d) => applyAdd(d, remainder));
  }

  remove(seg: SegmentRef, id: number): Promise<void> {
    const { chunkKey, remainder } = splitId(id);
    return this.readModifyWrite(seg, chunkKey, (d) => applyRemove(d, remainder));
  }

  addMany(seg: SegmentRef, ids: Iterable<number> | AsyncIterable<number>): Promise<void> {
    return this.mutateMany(seg, ids, applyAddAll);
  }

  removeMany(seg: SegmentRef, ids: Iterable<number> | AsyncIterable<number>): Promise<void> {
    return this.mutateMany(seg, ids, applyRemoveAll);
  }

  /**
   * **Atomically claim ids: add them, and return only the ones that were not already there.**
   *
   * The durable analogue of Redis `SETBIT` returning the prior bit — the primitive an exactly-once "have I
   * already processed / already sent to this id?" check needs. `has()` then `add()` cannot do this: two workers
   * can both read absent and both proceed.
   *
   * **Bulk on purpose.** The per-id shape is the one this library is worst at, because a Warm write rewrites a
   * whole 64K-id chunk bitmap: claiming 5,000 ids one at a time costs ~5,000 writes and ~23 MB, and claiming
   * them in one call costs 1 write and ~8 KB. So this takes a batch and does one OCC read-modify-write per
   * distinct chunk — Redis's semantics at this library's cost shape, rather than Redis's cost shape.
   *
   * **Atomicity is per id, which is the guarantee that matters here.** Each id lives in exactly one chunk, and a
   * chunk is one OCC row, so for any id exactly one concurrent claimer sees it as new. It is NOT atomic across
   * chunks (neither is `addMany`) — a mid-flight failure can leave some chunks claimed. Re-running is safe:
   * already-claimed ids simply come back as not-new.
   *
   * **The presence test consults Cold, not just the Warm delta.** Checking `adds` alone would report an id as
   * newly claimed when a compaction had already folded it into a Cold generation — silently breaking
   * exactly-once on any segment that has ever been compacted. The check is the full effective set,
   * `(cold ∪ adds) \ removes`.
   *
   * Returns the claimed ids grouped nowhere in particular — order is unspecified.
   */
  async claimMany(seg: SegmentRef, ids: Iterable<number>): Promise<number[]> {
    // Group by chunk first: the whole point is one write per chunk rather than one per id.
    const byChunk = new Map<number, number[]>();
    for (const id of ids) {
      const { chunkKey, remainder } = splitId(id);
      const bucket = byChunk.get(chunkKey);
      if (bucket) bucket.push(remainder);
      else byChunk.set(chunkKey, [remainder]);
    }
    const gen = await this.currentGen(seg);
    const perChunk = await mapWithConcurrency(
      [...byChunk],
      this.writeConcurrency,
      async ([chunkKey, remainders]) => {
        const cold = (await this.coldChunk({ ...seg, chunkKey }, gen)) ?? this.codec.empty();
        // `claimed` is assigned — never appended to — because `readModifyWrite` re-runs this callback on an OCC
        // conflict. Accumulating across attempts would report an id as newly claimed by us when the retry showed
        // it had been claimed by the winner of the race, which is exactly the guarantee being sold.
        let claimed: number[] = [];
        await this.readModifyWrite(seg, chunkKey, (delta) => {
          const present = effective(cold, delta);
          claimed = remainders.filter((r) => !present.has(r));
          for (const r of claimed) applyAdd(delta, r);
        });
        return claimed.map((r) => joinId(chunkKey, r));
      },
    );
    return perChunk.flat();
  }

  async has(seg: SegmentRef, id: number, opts?: WarmReadOptions): Promise<boolean> {
    const { chunkKey, remainder } = splitId(id);
    const ref: ChunkRef = { ...seg, chunkKey };
    // Default: honor the store's warmReadConsistency (gap #9). Callers that need read-your-writes regardless
    // (the GDPR subjectReport/eraseSubject membership check) pass `{ consistent: true }` to force strong.
    const row = await this.warmGet(ref, opts ?? this.readOpts);
    if (row) {
      const delta = decodeDelta(row.bytes, this.maxBitmapBytes, this.codec);
      if (delta.removes.has(remainder)) return false;
      if (delta.adds.has(remainder)) return true;
    }
    const cold = await this.coldChunk(ref, await this.currentGen(seg));
    return cold ? cold.has(remainder) : false;
  }

  async count(seg: SegmentRef): Promise<number> {
    const warmRows = await this.collectWarm(seg, 'count', this.budget?.maxRequests ?? null);
    // Cheap count (Phase 5c): when the Cold source can serve per-chunk cardinality from its `.crbm` index,
    // a warm-delta-free chunk is counted straight from the index — no payload fetch/decode — and only the
    // dirty chunks (those with a Warm delta) are merged. A source without that capability, or a segment with
    // no Cold generation, falls back to fetching + merging every effective chunk.
    //
    // Generation resolution ordering (gap #4): resolve `gen` **after** the shape read (`cardinalities` /
    // `chunkKeys`), matching `intersect`. A non-null shape read means the source resolved and cached a non-null
    // snapshot, so `gen` can't then come back null while cold data is present. Resolving `gen` *first* races a
    // segment's very first publish — `gen` reads null (no registry record yet), the shape read then sees the
    // freshly-published generation, and the stale null `gen` would make `coldChunk` skip cold for dirty chunks
    // (a silent undercount). `gen` and the shape read share the one snapshot, so within a call shorter than
    // `coldGenTtlMs` the count is generation-consistent — **absent cache-pressure eviction**: if the reader
    // cache (`maxOpenSegments`, gap #1) evicts this segment mid-call, the re-read re-resolves fresh (bypassing
    // the TTL), which can hop generations even sub-TTL. Likewise a *long* count that straddles a mid-call TTL
    // boundary during a compaction can mix generations — either way a bounded, transient skew that converges
    // next call (never a torn read: each chunk is still a whole, immutable generation). Full intra-op snapshot
    // isolation is deferred (gap #4).
    const cardinalities = this.cold.cardinalities ? await this.cold.cardinalities(seg) : null;
    if (!cardinalities) {
      const chunkKeys = await this.chunkKeys(seg, warmRows);
      checkBudget(this.budget, chunkKeys.length, 'count'); // one cold fetch per effective chunk (before fan-out)
      const gen = await this.currentGen(seg);
      let total = 0;
      for (const chunkKey of chunkKeys) {
        total += (await this.effectiveChunk(seg, chunkKey, warmRows, gen)).size;
      }
      return total;
    }
    // Cheap path: only the dirty (Warm) chunks are fetched; clean chunks are counted from the index (0 reads).
    checkBudget(this.budget, warmRows.size, 'count');
    const gen = await this.currentGen(seg);
    const keys = new Set<number>(warmRows.keys());
    for (const k of cardinalities.keys()) keys.add(k);
    let total = 0;
    for (const k of keys) {
      this.assertChunkKeyInRange(k);
      total += warmRows.has(k)
        ? (await this.effectiveChunk(seg, k, warmRows, gen)).size // dirty: merge (Cold ∪ adds) \ removes
        : (cardinalities.get(k) ?? 0); // clean: index cardinality, zero payload reads
    }
    return total;
  }

  /** Whether the Cold source can measure segment size (for grounded cost); false ⇒ storage isn't grounded. */
  get supportsColdSize(): boolean {
    return typeof this.cold.sizeOf === 'function';
  }

  /** Grounded Cold size of a segment's current generation (cost reporting), or null if it has no generation. */
  segmentSize(seg: SegmentRef): Promise<SegmentSize | null> {
    return this.cold.sizeOf ? this.cold.sizeOf(seg) : Promise.resolve(null);
  }

  async *iterate(seg: SegmentRef): AsyncGenerator<number> {
    const warmRows = await this.collectWarm(seg, 'iterate', this.budget?.maxRequests ?? null);
    const chunkKeys = await this.chunkKeys(seg, warmRows);
    checkBudget(this.budget, chunkKeys.length, 'iterate'); // one cold fetch per effective chunk (before fan-out)
    const gen = await this.currentGen(seg); // after the shape read (see `count`) — avoids a first-publish undercount
    for (const chunkKey of chunkKeys) {
      const eff = await this.effectiveChunk(seg, chunkKey, warmRows, gen);
      for (const remainder of eff) yield joinId(chunkKey, remainder);
    }
  }

  /**
   * `segs[0] ∩ segs[1] ∩ …`, minus every id in `options.exclude` — streamed ascending.
   *
   * The `exclude` operands are what make suppression **compose without materialising**. Applying suppression
   * afterwards (intersect into a temp segment, then remove) writes an intermediate segment that nobody wants;
   * applying it here folds it into the same chunk-aligned pass. It is also cheaper than it looks: an exclude
   * operand is read **only at the keys that survived the intersection** — the cost is bounded by the
   * audience's surviving key count and **never scales with the size of the suppression list**. Subtracting a
   * 61,000-chunk global opt-out list costs at most one read per surviving key, not 61,000.
   *
   * ---
   *
   * Chunk-skipping intersection. Computes
   * `seg[0] ∩ seg[1] ∩ …` and streams the result ids ascending. It aligns each segment's *effective*
   * chunk-key set (Warm ∪ Cold), keeps only keys present in **all** operands (a key missing from any
   * operand can't contribute → its **Cold chunks are never fetched** — the core saving), then for each
   * surviving key merges tiers per operand (operand fetches run in parallel) and hands the buffers to the
   * roaring engine for the AND, streaming results through a bounded in-flight window.
   *
   * **Memory:** the Cold payload footprint is bounded by the window (`concurrency × operands × chunk`), not
   * by segment size — that's the Lambda-friendly property. The **Warm** side, however, is snapshotted up
   * front (`collectWarm` per operand), so total memory also carries each operand's Warm size. Under
   * Topology-A (read-mostly; compaction keeps Warm small) that's negligible; a streaming Warm/Cold
   * merge-join for large Warm is Phase 4.
   *
   * Generation-consistent within the call (normal case): each operand's current generation is resolved **once**
   * up front (before the fan-out) and threaded into every chunk read, so a concurrent compaction can't corrupt
   * or tear the result — every chunk read is a whole, checksum-verified, immutable generation (finding C10).
   * The edge a *long* call can hit: if it straddles a mid-call `coldGenTtlMs` boundary and a compaction has
   * committed, an operand's not-yet-read chunks may re-resolve forward to the newer generation (a generation
   * hop within one long call) — the call never crashes or returns a torn object, but may mix generations. That
   * window is a single TTL (default 2 s), not the multi-cycle GC-sweep window it took pre-Phase-B. A shorter call
   * is unaffected **unless the reader cache evicts an operand mid-call** (`maxOpenSegments`, gap #1): the re-read
   * re-resolves fresh (bypassing the TTL), which can hop generations even sub-TTL — still whole/immutable per
   * read, never torn. Full intra-op snapshot isolation is deferred (gap #4).
   */
  intersect(
    segs: readonly SegmentRef[],
    options?: { concurrency?: number; budget?: BudgetOption; exclude?: readonly SegmentRef[] },
  ): AsyncGenerator<number> {
    return this.combine(segs, options?.exclude ?? [], 'all', 'intersect', options);
  }

  /**
   * `segs[0] ∪ segs[1] ∪ …`, minus every id in `options.exclude` — streamed ascending.
   *
   * **Union is the one composite read with no chunk-skipping**, and that is a property of the operation rather
   * than of this implementation: an id in *any* operand belongs to the result, so every chunk of every operand
   * has to be read. `intersect` can prune a key absent from any operand; union cannot prune anything. It is
   * budgeted exactly like `intersect` so a wide union is refused rather than quietly billed.
   */
  union(
    segs: readonly SegmentRef[],
    options?: { concurrency?: number; budget?: BudgetOption; exclude?: readonly SegmentRef[] },
  ): AsyncGenerator<number> {
    return this.combine(segs, options?.exclude ?? [], 'any', 'union', options);
  }

  /**
   * `seg \ (excludes[0] ∪ excludes[1] ∪ …)` — streamed ascending. Suppression on its own.
   *
   * Reads every chunk of `seg` (any of them may survive) but each exclude **only where it overlaps `seg`**, so
   * the cost scales with the segment being filtered rather than with the size of the suppression list.
   */
  andNot(
    seg: SegmentRef,
    excludes: readonly SegmentRef[],
    options?: { concurrency?: number; budget?: BudgetOption },
  ): AsyncGenerator<number> {
    return this.combine([seg], excludes, 'all', 'andNot', options);
  }

  private async *combine(
    segs: readonly SegmentRef[],
    excludeSegs: readonly SegmentRef[],
    mode: 'all' | 'any',
    op: 'intersect' | 'union' | 'andNot',
    options?: { concurrency?: number; budget?: BudgetOption },
  ): AsyncGenerator<number> {
    // Validated HERE rather than in the public wrappers, deliberately. `combine` is an async generator, so a
    // throw surfaces when the caller first iterates — which is the behaviour `intersect` has always had, and
    // `await expect(collect(engine.intersect([]))).rejects` in the suite depends on it. Guarding in the
    // wrappers would make them throw synchronously instead, a silent breaking change for anyone whose
    // try/catch sits around the iteration. Delegating through `yield*` would restore it at the cost of a
    // microtask per id on the hottest streaming path, which is not a trade worth making for an error case.
    if (segs.length === 0) {
      throw new ValidationError(`${op} requires at least one segment`);
    }
    if (op === 'andNot' && excludeSegs.length === 0) {
      throw new ValidationError('andNot requires at least one segment to subtract');
    }
    const limit = options?.concurrency ?? DEFAULT_INTERSECT_CONCURRENCY;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(
        `concurrency must be a positive integer; got ${options?.concurrency}`,
      );
    }
    // Per-op budget override (else the store budget); resolved before any I/O so a bad value fails fast. A
    // partial override inherits the store's tightening (not the generous default) — see resolvePerOpBudget.
    const budget = resolvePerOpBudget(options?.budget, this.budget);

    // ① Index-map extraction: each operand's effective key set (Warm ∪ Cold) + its current generation, resolved
    // ONCE here (not per chunk) so the fan-out below adds no per-chunk generation re-resolve. Only metadata so far.
    const extract = async (seg: SegmentRef) => {
      // see collectWarm: this budget is a product, not a row count;
      const warmRows = await this.collectWarm(seg, op, null);
      const keys = await this.chunkKeys(seg, warmRows);
      const gen = await this.currentGen(seg);
      return { seg, warmRows, keys: new Set(keys), gen };
    };
    const [operands, excludes] = await Promise.all([
      Promise.all(segs.map(extract)),
      Promise.all(excludeSegs.map(extract)),
    ]);

    // ② Key alignment. Candidate keys come from the INCLUDE operands only — an exclude can subtract ids from a
    // chunk but can never introduce one, so a key no include holds cannot appear in the result however large
    // the suppression list is. That asymmetry is what makes suppression cheap here.
    //
    //   'all' (intersect / andNot): keys present in EVERY include. Start from the smallest set to minimize the
    //                               scan — a key missing from any operand cannot survive the AND.
    //   'any' (union):              keys present in ANY include. No pruning is possible; see `union`'s note.
    const candidates: number[] = [];
    if (mode === 'all') {
      const pivot = operands.reduce((a, b) => (a.keys.size <= b.keys.size ? a : b));
      for (const k of pivot.keys) {
        if (operands.every((o) => o.keys.has(k))) candidates.push(k);
      }
    } else {
      const seen = new Set<number>();
      for (const o of operands) for (const k of o.keys) seen.add(k);
      for (const k of seen) candidates.push(k);
    }
    candidates.sort((a, b) => a - b); // defensive: `chunkKeys` already returns sorted; don't rely on it
    const common = candidates;

    // Denial-of-wallet budget (before the fan-out AND before we emit a "work done" metric): the heavy cost is
    // one cold fetch per surviving key per operand — refuse up front if that would exceed the budget (07
    // Decision #3 / T3). Placed above the metric so a refused intersect doesn't report chunks it never fetched.
    //
    // Units are the chunk reads this will actually issue, counted per key: every include present at that key
    // (all of them under 'all'), plus only those excludes that hold the key. Counting excludes as always-present
    // would refuse work that costs nothing — the whole point of the asymmetry above. For a plain `intersect`
    // with no excludes this reduces to `common.length * operands.length`, exactly as before.
    let units = 0;
    for (const key of common) {
      for (const o of operands) if (mode === 'all' || o.keys.has(key)) units += 1;
      for (const e of excludes) if (e.keys.has(key)) units += 1;
    }
    checkBudget(budget, units, op);

    // Emit the chunk-skipping efficiency: `fetched` = shared keys we'll read, `skipped` = distinct keys
    // pruned across all operands (never fetched — the core saving). Bounded metadata work, no extra I/O.
    if (this.metricsOn) {
      const distinctKeys = new Set<number>();
      for (const op of operands) {
        for (const k of op.keys) distinctKeys.add(k);
      }
      for (const e of excludes) for (const k of e.keys) distinctKeys.add(k);
      // `fetchedChunks` counts **distinct chunk keys**, not per-operand reads — its long-standing documented
      // unit, asserted by the bench anchors and the metrics tests. Deliberately NOT changed to match the
      // budget's request count: they measure different things on purpose (keys vs billable requests), and
      // silently redefining a published observability field in a patch release would break every dashboard
      // built on it. The relationship is documented on the event instead.
      this.metrics.onEvent({
        kind: 'intersect',
        op,
        operands: segs.length + excludes.length,
        fetchedChunks: common.length,
        // Never negative: under 'any' every candidate key came from some operand, so `distinctKeys` is a
        // superset of `common`; excludes only ever add keys here.
        skippedChunks: distinctKeys.size - common.length,
      });
    }

    // ③–⑤ Surgical streaming AND through a bounded, order-preserving window: fetch+intersect at most
    // `limit` keys concurrently, yield each key's ids before priming far ahead (bounded Cold footprint).
    // Each task resolves to a value (never rejects) so an error on one key can't leave the other in-flight
    // promises unhandled — we surface it, in key order, when its slot is drained.
    type Slot = { key: number; result: CodecBitmap | null; error?: unknown };
    const startAt = (key: number): Promise<Slot> =>
      this.combineChunk(operands, excludes, mode, key).then(
        (result) => ({ key, result }),
        (error: unknown) => ({ key, result: null, error }),
      );

    const inFlight: Array<Promise<Slot>> = [];
    let next = 0;
    while (next < common.length && inFlight.length < limit) inFlight.push(startAt(common[next++]!));
    while (inFlight.length > 0) {
      const slot = await inFlight.shift()!; // FIFO over ascending keys ⇒ ascending output
      if (next < common.length) inFlight.push(startAt(common[next++]!));
      if (slot.error !== undefined) throw slot.error;
      if (slot.result && !slot.result.isEmpty) {
        for (const remainder of slot.result) yield joinId(slot.key, remainder);
      }
    }
  }

  /**
   * The AND of one chunk key across all operands (tier-merged per operand), or `null` if empty. Operand
   * chunks are fetched **in parallel** (the spec's parallel byte-range reads). `acc` takes ownership of the
   * first operand's effective chunk and mutates it in place — safe because `effectiveChunk` always returns
   * a FRESH bitmap (never a cached/shared Cold instance), so this can't poison the HOT cache.
   */
  private async combineChunk(
    operands: ReadonlyArray<Operand>,
    excludes: ReadonlyArray<Operand>,
    mode: 'all' | 'any',
    chunkKey: number,
  ): Promise<CodecBitmap | null> {
    // Under 'any' an include may simply not hold this key; skip it rather than fetching a certainly-empty
    // chunk. Under 'all' every include holds every candidate key by construction, so the filter is a no-op.
    const present = mode === 'all' ? operands : operands.filter((o) => o.keys.has(chunkKey));
    if (present.length === 0) return null;
    const chunks = await Promise.all(
      present.map((op) => this.effectiveChunk(op.seg, chunkKey, op.warmRows, op.gen)),
    );
    const acc = chunks[0]!; // fresh, owned (see method note)
    for (let i = 1; i < chunks.length; i++) {
      if (mode === 'all') {
        acc.andInPlace(chunks[i]!);
        if (acc.isEmpty) return null; // once empty, the remaining operands can't revive it
      } else {
        acc.orInPlace(chunks[i]!);
      }
    }
    if (acc.isEmpty) return null;

    // Suppression, folded into the same pass. Only excludes that actually hold this key are fetched — this is
    // where a large global opt-out list stops being expensive. Fetched lazily rather than alongside the
    // includes above, because an AND that collapsed to empty means there is nothing left to suppress.
    const relevant = excludes.filter((e) => e.keys.has(chunkKey));
    if (relevant.length > 0) {
      const cuts = await Promise.all(
        relevant.map((e) => this.effectiveChunk(e.seg, chunkKey, e.warmRows, e.gen)),
      );
      for (const cut of cuts) {
        acc.andNotInPlace(cut);
        if (acc.isEmpty) return null;
      }
    }
    return acc;
  }

  /**
   * Materialize `seg[0] ∩ seg[1] ∩ …` into `dest` via batched `addMany` (streaming, bounded memory).
   * **Not atomic** — like `addMany`, ids land chunk-by-chunk; a failure mid-stream leaves a partial result.
   * `dest` is added to, not replaced.
   */
  async intersectInto(
    dest: SegmentRef,
    segs: readonly SegmentRef[],
    options?: {
      concurrency?: number;
      batchSize?: number;
      budget?: BudgetOption;
      exclude?: readonly SegmentRef[];
    },
  ): Promise<void> {
    await this.drainInto(dest, this.intersect(segs, options), options?.batchSize);
  }

  /**
   * Materialize `segs[0] ∪ segs[1] ∪ …` (minus `options.exclude`) into `dest`. **Not atomic**, like
   * {@link intersectInto}. See {@link union} for why this one cannot skip any chunk.
   */
  async unionInto(
    dest: SegmentRef,
    segs: readonly SegmentRef[],
    options?: {
      concurrency?: number;
      batchSize?: number;
      budget?: BudgetOption;
      exclude?: readonly SegmentRef[];
    },
  ): Promise<void> {
    await this.drainInto(dest, this.union(segs, options), options?.batchSize);
  }

  /** Materialize `seg \ (excludes…)` into `dest`. **Not atomic**, like {@link intersectInto}. */
  async andNotInto(
    dest: SegmentRef,
    seg: SegmentRef,
    excludes: readonly SegmentRef[],
    options?: { concurrency?: number; batchSize?: number; budget?: BudgetOption },
  ): Promise<void> {
    await this.drainInto(dest, this.andNot(seg, excludes, options), options?.batchSize);
  }

  /**
   * Stream a combine's results into `dest` in bounded batches.
   *
   * `dest` is **added to, not replaced**, and this is **not atomic** — ids land chunk-by-chunk, so a failure
   * mid-stream leaves a partial result, exactly as `addMany` does. Batching keeps memory bounded no matter how
   * large the result is.
   */
  private async drainInto(
    dest: SegmentRef,
    source: AsyncIterable<number>,
    batchSizeOption?: number,
  ): Promise<void> {
    const batchSize = Math.max(1, batchSizeOption ?? 4096);
    let batch: number[] = [];
    for await (const id of source) {
      batch.push(id);
      if (batch.length >= batchSize) {
        await this.addMany(dest, batch);
        batch = [];
      }
    }
    if (batch.length > 0) await this.addMany(dest, batch);
  }

  /**
   * Group ids by chunk, then apply each chunk's whole batch in a single OCC read-modify-write.
   *
   * Accepts a **sync or async** iterable, so an Athena/BigQuery cursor streams straight in without the caller
   * hand-batching `page → addMany(page)`.
   *
   * **The pending ids are held as BITMAPS, not as JS numbers, and that is the load-bearing choice.** Streaming
   * input is unbounded by definition, so something has to give. The obvious answer — buffer N ids, flush them to
   * the backend, repeat — bounds memory and is quietly catastrophic on cost: with ids arriving in arbitrary
   * order, every flush touches nearly every chunk again, so an 11M-id stream at a 1M-id buffer would issue
   * **11x** the OCC round-trips of a single pass. In a library whose headline claim is honest cost, silently
   * multiplying someone's write bill by the size of their input is not a bounded-memory strategy; it is a
   * different bug.
   *
   * So the staging buffer is capped, but it folds into per-chunk **compressed bitmaps** rather than being
   * written out. Peak memory is the roaring representation of the ids seen so far — which is what the segment
   * itself costs, and the floor for any implementation that writes each chunk exactly once — while the backend
   * still sees exactly one read-modify-write per distinct chunk regardless of stream length. Above the staging cap
   * this holds less than the previous sync-only version, which kept every remainder as an uncompressed JS
   * number; below it — the common `addMany` — nothing is compacted until the end and the two are comparable.
   * The guarantee is that a stream of *any* length stays bounded, not that every call got smaller.
   *
   * There is no way to do better without a sorted stream: a chunk can only be written once it is known that no
   * further ids for it will arrive, and unsorted input never gives that guarantee. Callers streaming *very*
   * large sets want `bulkLoadCrbmGeneration` instead — it writes one immutable Cold object rather than tens of
   * thousands of warm rows. The crossover is documented in the guide.
   */
  private async mutateMany(
    seg: SegmentRef,
    ids: Iterable<number> | AsyncIterable<number>,
    apply: Mutator,
  ): Promise<void> {
    const byChunk = new Map<number, CodecBitmap>();
    const staged = new Map<number, number[]>();
    let pending = 0;
    const tickId = yieldEvery(this.clock, YIELD_EVERY_IDS); // async ingest only — see the sync loop's note

    /** Fold the staged remainders into their chunks' bitmaps, releasing the uncompressed buffers. */
    const compact = (): void => {
      for (const [chunkKey, rems] of staged) {
        if (rems.length === 0) continue;
        const existing = byChunk.get(chunkKey);
        if (existing === undefined) byChunk.set(chunkKey, this.codec.fromValues(rems));
        else existing.addMany(rems);
        rems.length = 0;
      }
      pending = 0;
    };

    const stage = (id: number): void => {
      const { chunkKey, remainder } = splitId(id); // validates the u32 range
      let rems = staged.get(chunkKey);
      if (rems === undefined) {
        rems = [];
        staged.set(chunkKey, rems);
      }
      rems.push(remainder);
      pending += 1;
    };

    // Two loops rather than one over a normalising wrapper: routing a sync source through an async generator
    // forces a microtask per id and measured 20x on the bulk-load path. Arrays and Sets are the common input.
    if (Symbol.asyncIterator in ids) {
      for await (const id of ids as AsyncIterable<number>) {
        stage(id);
        if (pending >= MUTATE_STAGE_IDS) compact();
        const pause = tickId();
        if (pause !== null) await pause;
      }
    } else {
      // A SYNC source is drained with no `await` inside the loop, and that is a correctness requirement rather
      // than an optimisation. An async function body runs synchronously up to its first `await`, so a sync
      // input has always been effectively **snapshotted** at call time — `addMany(buf)` without awaiting, then
      // mutating `buf`, could not lose ids. Yielding mid-loop silently broke that: with a yield every
      // `YIELD_EVERY_IDS`, a caller who recycled a 40,000-id scratch buffer before awaiting landed exactly
      // 16,384 ids and got **no error**. Size-dependent, so no small test would ever show it.
      //
      // Nothing is lost by draining eagerly here. The input is already fully in memory (that is what makes it
      // sync), the loop costs ~11 ms per 1M ids, and the operation's real time is the OCC round-trips below,
      // which yield naturally. Streaming callers who want cooperative ingest pass an async iterable.
      for (const id of ids as Iterable<number>) {
        stage(id);
        if (pending >= MUTATE_STAGE_IDS) compact();
      }
    }
    compact();

    // Bounded flusher: one OCC read-modify-write per distinct chunk, at most `writeConcurrency` in flight.
    // Distinct chunks are independent OCC rows, so fanning them out is safe; as before, a mid-flush failure can
    // leave a partial result (`addMany`/`removeMany` are not atomic).
    await mapWithConcurrency([...byChunk], this.writeConcurrency, ([chunkKey, bitmap]) =>
      this.readModifyWrite(seg, chunkKey, (d) => {
        apply(d, bitmap);
      }),
    );
  }

  /** OCC read-modify-write on a chunk's Warm delta, retrying on conflict (bounded). */
  private async readModifyWrite(
    seg: SegmentRef,
    chunkKey: number,
    mutate: (delta: ChunkDelta) => void,
  ): Promise<void> {
    const ref: ChunkRef = { ...seg, chunkKey };
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const row = await this.warmGet(ref);
      const delta = row
        ? decodeDelta(row.bytes, this.maxBitmapBytes, this.codec)
        : emptyDelta(this.codec);
      mutate(delta);
      const encoded = encodeDelta(delta);
      try {
        await this.warm.putConditional(ref, encoded, row ? row.token : NO_ROW);
        if (this.metricsOn) {
          this.metrics.onEvent({
            kind: 'warm.write',
            namespace: ref.namespace,
            segment: ref.segment,
            bytes: encoded.length,
          });
        }
        return;
      } catch (err) {
        if (isWriteConflictError(err) && attempt < this.maxRetries) {
          // Jittered backoff so concurrent writers to a hot chunk don't reconverge into a tight retry storm
          // (full jitter decorrelates them). Instant under the default no-wait clock; real under production wiring.
          const delayMs = applyJitter(
            this.occBackoff,
            backoffDelayMs(this.occBackoff, attempt + 1),
            this.rng,
          );
          if (this.metricsOn) {
            this.metrics.onEvent({ kind: 'retry', reason: 'occ', attempt: attempt + 1, delayMs });
          }
          await this.clock.sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
    throw new WriteConflictError(`OCC retries exhausted for chunk ${chunkKey}`);
  }

  /** `warm.get` + a `warm.read` metric (read bytes = the row size, 0 if absent). */
  private async warmGet(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null> {
    // No `opts` ⇒ the driver default (strong) — the OCC read-modify-write path relies on that; read paths pass
    // `this.readOpts` so `warmReadConsistency: 'eventual'` can lighten them (gap #9).
    const row = await this.warm.get(ref, opts);
    if (this.metricsOn) {
      this.metrics.onEvent({
        kind: 'warm.read',
        namespace: ref.namespace,
        segment: ref.segment,
        bytes: row ? row.bytes.length : 0,
      });
    }
    return row;
  }

  private async collectWarm(
    seg: SegmentRef,
    op: string,
    rowCeiling: number | null,
  ): Promise<Map<number, Uint8Array>> {
    const rows = new Map<number, Uint8Array>();
    let bytes = 0;
    // Read path (count/iterate/intersect): honor warmReadConsistency (gap #9).
    //
    // The budget is enforced HERE, per row, not after the drain. Every caller below used to check it only once
    // this Map was complete, which bounded the fan-out but not the enumeration: a segment can hold up to 65,536
    // chunks, each row individually capped by `decodeDelta` but the aggregate capped nowhere. Measured, a
    // `budget: { maxRequests: 2 }` store still materialised 3,000 chunks / 12 MB before `count()` threw — i.e.
    // the advertised denial-of-wallet protection could only refuse *after* paying the memory cost, which
    // contradicts the bounded-memory invariant. Checking inside the loop makes resident memory O(budget).
    for await (const row of this.warm.listChunks(seg, this.readOpts)) {
      rows.set(row.chunkKey, row.bytes);
      bytes += row.bytes.length;
      // The byte ceiling applies to EVERY read op, including intersect, and ignores `budget` entirely — see
      // `maxWarmScanBytes`. This is the bound that makes `budget: false` safe and that covers intersect, whose
      // product-shaped budget cannot express a memory limit.
      if (bytes > this.maxWarmScanBytes) {
        throw new BudgetExceededError(
          `${op} would hold more than ${this.maxWarmScanBytes} bytes of warm deltas resident for one segment ` +
            `— the scan was abandoned there rather than completed. Raise \`maxWarmScanBytes\`, narrow the ` +
            `segment, or compact it so fewer chunks carry warm deltas. (This ceiling is independent of ` +
            `\`budget\` and stays in force when \`budget: false\`.)`,
        );
      }
      // `>` and `rows.size` (not a raw counter): a duplicate chunkKey overwrites rather than growing the Map,
      // so the size is the true resident row count and matches what the post-drain check used to compare.
      //
      // `rowCeiling` is passed per-op rather than read from `this.budget`, because the budget means different
      // quantities per operation and applying it blindly TIGHTENS the contract:
      //   - count / iterate: their eventual check is against `chunkKeys.length`, and warm keys are a SUBSET of
      //     chunkKeys — so if warm rows alone exceed the budget, the existing check was going to fail too.
      //     Checking early is therefore equivalent-or-earlier, never stricter. Safe to pass the budget.
      //   - intersect: its eventual check is `common.length × operands.length`, a PRODUCT over the keys common
      //     to every operand. One wide operand can hold far more warm rows than the product while still being
      //     legal — so passing the budget here would refuse work the documented contract allows. It gets `null`
      //     and remains unbounded pending a decision on an explicit memory ceiling. An existing budget test
      //     caught exactly this, which is why the distinction is spelled out rather than assumed.
      if (rowCeiling !== null && rows.size > rowCeiling) {
        throw new BudgetExceededError(
          `${op} would read more than ${rowCeiling} warm chunk rows, over the per-op budget — ` +
            `the scan was abandoned at that point rather than completed, so no exact total is available. ` +
            `Raise \`budget.maxRequests\`, override it per-op, or set \`budget: false\``,
        );
      }
    }
    if (this.metricsOn) {
      this.metrics.onEvent({
        kind: 'warm.read',
        namespace: seg.namespace,
        segment: seg.segment,
        bytes,
      });
    }
    return rows;
  }

  private async chunkKeys(seg: SegmentRef, warmRows: Map<number, Uint8Array>): Promise<number[]> {
    const keys = new Set<number>(warmRows.keys());
    for (const k of await this.cold.listChunkKeys(seg)) keys.add(k);
    for (const k of keys) this.assertChunkKeyInRange(k);
    return [...keys].sort((a, b) => a - b);
  }

  /**
   * Tier-derived keys are untrusted (invariant 5) — fail fast on a corrupt/out-of-range key rather than
   * letting it flow into `joinId` and produce a bogus id.
   */
  private assertChunkKeyInRange(k: number): void {
    if (!Number.isInteger(k) || k < 0 || k >= CHUNK_COUNT) {
      throw new IntegrityError(`chunk key from a tier is out of range: ${k}`);
    }
  }

  /**
   * The other half of invariant 5, and the one that was missing: a chunk payload holds **remainders** — 16-bit
   * offsets within one chunk — so every value must be `<= 0xffff`.
   *
   * Nothing upstream established that. The byte cap bounds *size*, and CRC/AEAD prove the bytes are the bytes
   * that were written — which anyone able to write the tier satisfies trivially. A value `>= 65536` then
   * reaches `joinId`, which masks it (`remainder & 0xffff`) and emits a **fabricated id belonging to a
   * different chunk's id space**: indistinguishable from real data, inflating `count()` and creating spurious
   * `intersect` matches. Compaction is the only path that already failed loud (`CrbmWriter` rejects
   * `cardinality > 65536`), which merely turns the same row into a permanently poison segment.
   *
   * Costs one `maximum()` per chunk, not per id — `maximum` is optional on the codec seam precisely so a codec
   * that cannot answer in O(1) opts out instead of making the read path walk every value.
   */
  private assertChunkPayloadInRange(bitmap: CodecBitmap, chunkKey: number): void {
    const max = bitmap.maximum?.();
    if (max !== undefined && max > MAX_REMAINDER) {
      throw new IntegrityError(
        `chunk ${chunkKey} payload holds value ${max}, outside the 16-bit remainder range ` +
          `[0, ${MAX_REMAINDER}] — the stored object is corrupt or was not written by this codec`,
      );
    }
  }

  private async effectiveChunk(
    seg: SegmentRef,
    chunkKey: number,
    warmRows: Map<number, Uint8Array>,
    gen: number | null | undefined,
  ): Promise<CodecBitmap> {
    const warmBytes = warmRows.get(chunkKey);
    const delta = warmBytes
      ? decodeDelta(warmBytes, this.maxBitmapBytes, this.codec)
      : emptyDelta(this.codec);
    const cold = (await this.coldChunk({ ...seg, chunkKey }, gen)) ?? this.codec.empty();
    // Always return a fresh bitmap: `effective` clones Cold before any in-place op, so callers can
    // never mutate the (shared, cached) Cold instance. This is now LOAD-BEARING: `intersectChunk` mutates
    // the returned bitmap in place via `andInPlace`. A single-tier fast path that returns the cached Cold
    // by reference would silently poison the HOT cache through that path — it stays deferred (Phase 5 perf)
    // and MUST come with a read-only bitmap view.
    return effective(cold, delta);
  }

  /** The segment's current generation, resolved once per op (`undefined` ⇒ source can't report it). */
  private currentGen(seg: SegmentRef): Promise<number | null | undefined> {
    return this.cold.currentGeneration
      ? this.cold.currentGeneration(seg)
      : Promise.resolve(undefined);
  }

  /**
   * Decode a Cold chunk. `gen` is the segment's current generation, resolved **once per op** by the caller (not
   * per chunk — that would put a registry re-resolve on every chunk of a count/intersect). The HOT cache is
   * keyed by it (gap #4), so a compaction that advances the generation misses the cache and re-reads the new
   * bytes instead of serving a stale decoded chunk (an erased id can't resurrect from a cached pre-compaction
   * chunk). `gen === null` ⇒ the source reports no current generation ⇒ no cold bytes for any chunk, so skip the
   * fetch entirely (also avoids a redundant re-resolve on the warm-only path). `gen === undefined` ⇒ the source
   * can't report a generation (pins one for its lifetime) ⇒ the key stays generation-free (unchanged behaviour).
   * Superseded-generation entries age out under the LRU ceiling — no active purge.
   */
  private async coldChunk(
    ref: ChunkRef,
    gen: number | null | undefined,
  ): Promise<CodecBitmap | null> {
    if (gen === null) return null;
    const cacheKey = gen === undefined ? chunkRefKey(ref) : chunkGenKey(ref, gen);
    if (this.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        if (this.metricsOn) this.metrics.onEvent({ kind: 'cache', hit: true });
        return cached;
      }
      if (this.metricsOn) this.metrics.onEvent({ kind: 'cache', hit: false });
    }
    const startedAt = this.metricsOn ? this.clock.now() : 0;
    const bytes = await this.cold.getChunk(ref);
    if (this.metricsOn) {
      this.metrics.onEvent({
        kind: 'cold.get',
        namespace: ref.namespace,
        segment: ref.segment,
        bytes: bytes ? bytes.length : 0,
        ms: Math.max(0, this.clock.now() - startedAt),
      });
    }
    if (!bytes) return null;
    const bitmap = this.codec.safeDeserialize(bytes, this.maxBitmapBytes);
    this.assertChunkPayloadInRange(bitmap, ref.chunkKey);
    this.cache?.set(cacheKey, bitmap);
    return bitmap;
  }
}
