/**
 * SegmentEngine — the in-memory core: routing + tombstone merge + the HOT cache, exposing the seven
 * ops over the driver interfaces. Storage-agnostic and time/random-free
 * (the determinism seam): all I/O is via injected drivers; the cache carries its own `Clock`.
 */
import { splitId, joinId, CHUNK_COUNT } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { emptyDelta, applyAdd, applyRemove, effective, encodeDelta, decodeDelta } from './chunk';
import type { ChunkDelta } from './chunk';
import { checkBudget, DEFAULT_BUDGET, resolvePerOpBudget } from './budget';
import type { Budget, BudgetOption } from './budget';
import { mapWithConcurrency } from './concurrency';
import type { Clock, Rng } from './determinism';
import {
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
}
class ZeroRng implements Rng {
  next(): number {
    return 0;
  }
}

export interface EngineDeps {
  readonly warm: IWarmDriver;
  readonly cold: ColdChunkSource;
  /** Optional HOT cache of decoded (immutable) Cold chunks. */
  readonly cache?: BoundedLru<string, CodecBitmap>;
  readonly maxBitmapBytes?: number;
  /**
   * The bitmap codec (DECISIONS #58) — **required**. `core/` is
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
   * Max Warm chunk writes in flight per `addMany`/`removeMany` (the bounded flusher). Default **1** (serial —
   * unchanged behavior). Higher values fan out distinct-chunk writes for throughput; each chunk is its own OCC
   * row, so bounded concurrency is safe (`addMany` is already non-atomic on partial failure).
   */
  readonly writeConcurrency?: number;
  /**
   * Per-op denial-of-wallet budget (07 Decision #3 / T3), already resolved by the facade: a {@link Budget} to
   * enforce, or `null` to disable. Undefined ⇒ {@link DEFAULT_BUDGET} (a direct engine construction still gets
   * the generous default). Read ops refuse before fan-out if they'd exceed it.
   */
  readonly budget?: Budget | null;
}

type Mutator = (delta: ChunkDelta, remainder: number) => void;

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
    this.writeConcurrency = deps.writeConcurrency ?? 1;
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

  addMany(seg: SegmentRef, ids: Iterable<number>): Promise<void> {
    return this.mutateMany(seg, ids, applyAdd);
  }

  removeMany(seg: SegmentRef, ids: Iterable<number>): Promise<void> {
    return this.mutateMany(seg, ids, applyRemove);
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
    const warmRows = await this.collectWarm(seg);
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
    const warmRows = await this.collectWarm(seg);
    const chunkKeys = await this.chunkKeys(seg, warmRows);
    checkBudget(this.budget, chunkKeys.length, 'iterate'); // one cold fetch per effective chunk (before fan-out)
    const gen = await this.currentGen(seg); // after the shape read (see `count`) — avoids a first-publish undercount
    for (const chunkKey of chunkKeys) {
      const eff = await this.effectiveChunk(seg, chunkKey, warmRows, gen);
      for (const remainder of eff) yield joinId(chunkKey, remainder);
    }
  }

  /**
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
  async *intersect(
    segs: readonly SegmentRef[],
    options?: { concurrency?: number; budget?: BudgetOption },
  ): AsyncGenerator<number> {
    if (segs.length === 0) {
      throw new ValidationError('intersect requires at least one segment');
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
    const operands = await Promise.all(
      segs.map(async (seg) => {
        const warmRows = await this.collectWarm(seg);
        const keys = await this.chunkKeys(seg, warmRows);
        const gen = await this.currentGen(seg);
        return { seg, warmRows, keys: new Set(keys), gen };
      }),
    );

    // ② Key alignment: keys present in ALL operands. Start from the smallest set to minimize the scan.
    const pivot = operands.reduce((a, b) => (a.keys.size <= b.keys.size ? a : b));
    const common: number[] = [];
    for (const k of pivot.keys) {
      if (operands.every((op) => op.keys.has(k))) common.push(k);
    }
    common.sort((a, b) => a - b); // defensive: `chunkKeys` already returns sorted; don't rely on it

    // Denial-of-wallet budget (before the fan-out AND before we emit a "work done" metric): the heavy cost is
    // one cold fetch per surviving key per operand — refuse up front if that would exceed the budget (07
    // Decision #3 / T3). Placed above the metric so a refused intersect doesn't report chunks it never fetched.
    checkBudget(budget, common.length * operands.length, 'intersect');

    // Emit the chunk-skipping efficiency: `fetched` = shared keys we'll read, `skipped` = distinct keys
    // pruned across all operands (never fetched — the core saving). Bounded metadata work, no extra I/O.
    if (this.metricsOn) {
      const distinctKeys = new Set<number>();
      for (const op of operands) {
        for (const k of op.keys) distinctKeys.add(k);
      }
      this.metrics.onEvent({
        kind: 'intersect',
        operands: segs.length,
        fetchedChunks: common.length,
        skippedChunks: distinctKeys.size - common.length,
      });
    }

    // ③–⑤ Surgical streaming AND through a bounded, order-preserving window: fetch+intersect at most
    // `limit` keys concurrently, yield each key's ids before priming far ahead (bounded Cold footprint).
    // Each task resolves to a value (never rejects) so an error on one key can't leave the other in-flight
    // promises unhandled — we surface it, in key order, when its slot is drained.
    type Slot = { key: number; result: CodecBitmap | null; error?: unknown };
    const startAt = (key: number): Promise<Slot> =>
      this.intersectChunk(operands, key).then(
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
  private async intersectChunk(
    operands: ReadonlyArray<{
      seg: SegmentRef;
      warmRows: Map<number, Uint8Array>;
      gen: number | null | undefined;
    }>,
    chunkKey: number,
  ): Promise<CodecBitmap | null> {
    const chunks = await Promise.all(
      operands.map((op) => this.effectiveChunk(op.seg, chunkKey, op.warmRows, op.gen)),
    );
    const acc = chunks[0]!; // fresh, owned (see method note)
    for (let i = 1; i < chunks.length; i++) {
      acc.andInPlace(chunks[i]!);
      if (acc.isEmpty) return null; // once empty, the remaining operands can't revive it
    }
    return acc.isEmpty ? null : acc;
  }

  /**
   * Materialize `seg[0] ∩ seg[1] ∩ …` into `dest` via batched `addMany` (streaming, bounded memory).
   * **Not atomic** — like `addMany`, ids land chunk-by-chunk; a failure mid-stream leaves a partial result.
   * `dest` is added to, not replaced.
   */
  async intersectInto(
    dest: SegmentRef,
    segs: readonly SegmentRef[],
    options?: { concurrency?: number; batchSize?: number },
  ): Promise<void> {
    const batchSize = Math.max(1, options?.batchSize ?? 4096);
    let batch: number[] = [];
    for await (const id of this.intersect(segs, options)) {
      batch.push(id);
      if (batch.length >= batchSize) {
        await this.addMany(dest, batch);
        batch = [];
      }
    }
    if (batch.length > 0) await this.addMany(dest, batch);
  }

  private async mutateMany(seg: SegmentRef, ids: Iterable<number>, apply: Mutator): Promise<void> {
    const byChunk = new Map<number, number[]>();
    for (const id of ids) {
      const { chunkKey, remainder } = splitId(id);
      const rems = byChunk.get(chunkKey) ?? [];
      rems.push(remainder);
      byChunk.set(chunkKey, rems);
    }
    // Bounded flusher: one OCC read-modify-write per distinct chunk, at most `writeConcurrency` in flight
    // (default 1 ⇒ serial, unchanged). Distinct chunks are independent OCC rows, so fanning them out is safe;
    // as before, a mid-flush failure can leave a partial result (`addMany`/`removeMany` are not atomic).
    await mapWithConcurrency([...byChunk], this.writeConcurrency, ([chunkKey, rems]) =>
      this.readModifyWrite(seg, chunkKey, (d) => {
        for (const r of rems) apply(d, r);
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

  private async collectWarm(seg: SegmentRef): Promise<Map<number, Uint8Array>> {
    const rows = new Map<number, Uint8Array>();
    let bytes = 0;
    // Read path (count/iterate/intersect): honor warmReadConsistency (gap #9).
    for await (const row of this.warm.listChunks(seg, this.readOpts)) {
      rows.set(row.chunkKey, row.bytes);
      bytes += row.bytes.length;
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
    this.cache?.set(cacheKey, bitmap);
    return bitmap;
  }
}
