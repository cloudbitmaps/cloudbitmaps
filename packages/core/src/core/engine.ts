/**
 * SegmentEngine — the read side of the loaded store: id routing, the chunk-skipping combines, and the HOT cache
 * of decoded Cold chunks, over the {@link ColdChunkSource} port.
 *
 * **Read-only by design.** Every write in this library is a new immutable generation — `bulkLoadCrbmGeneration`,
 * the facade's `*Into` verbs, `eraseIdFromSegment` — published through the registry pointer. Nothing here mutates
 * stored bytes, so a read never merges tiers: one chunk read is one whole, checksum-verified, immutable chunk of
 * one generation. Storage-agnostic and time/random-free (the determinism seam): all I/O is via the injected
 * source; the cache carries its own `Clock`.
 */
import { splitId, joinId, CHUNK_COUNT, MAX_REMAINDER } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { checkBudget, DEFAULT_BUDGET, resolvePerOpBudget } from './budget';
import type { Budget, BudgetOption } from './budget';
import type { Clock } from './determinism';
import { IntegrityError, ValidationError } from './errors';
import { chunkGenKey, chunkRefKey, segmentPrefix } from './keys';
import type { BoundedLru } from './lru';
import { NOOP_METRICS, safeMetrics } from './metrics';
import type { IMetricsSink } from './metrics';
import type { ChunkRef, ColdChunkSource, SegmentRef, SegmentSize } from './ports';

const DEFAULT_MAX_BITMAP_BYTES = 1 << 20; // 1 MiB per bitmap — generous; real chunks are far smaller
/** Max overlapping-chunk intersections in flight — bounds memory + concurrent reads (invariant 6). */
const DEFAULT_INTERSECT_CONCURRENCY = 8;

/** A clock that always reads 0 — used when nothing is injected, so the `cold.get` latency metric reports 0 ms. */
const ZERO_CLOCK: Pick<Clock, 'now'> = { now: () => 0 };

export interface EngineDeps {
  readonly cold: ColdChunkSource;
  /** Optional HOT cache of decoded (immutable) Cold chunks. */
  readonly cache?: BoundedLru<string, CodecBitmap>;
  readonly maxBitmapBytes?: number;
  /**
   * The bitmap codec — **required**. `core/` is codec-agnostic: it can have no default, because the concrete codec
   * lives in a *flavor* package that depends on core (a default here would invert that arrow). A flavor's facade
   * injects it — `@cloudbitmaps/roaring` passes `roaringCodec` — so applications never see this.
   */
  readonly codec: CodecInterface;
  /** Time source for the `cold.get` latency metric only; defaults to a clock that reads 0. */
  readonly clock?: Pick<Clock, 'now'>;
  /** Observability sink; defaults to a no-op. Assumed exception-safe (the facade wraps it). */
  readonly metrics?: IMetricsSink;
  /**
   * Per-op denial-of-wallet budget, already resolved by the facade: a {@link Budget} to enforce, or `null` to
   * disable. Undefined ⇒ {@link DEFAULT_BUDGET} (a direct engine construction still gets the generous default).
   * Read ops refuse before fan-out if they'd exceed it.
   */
  readonly budget?: Budget | null;
}

/** Options common to the chunk-aligned combines. */
export interface CombineOptions {
  /** Max chunk keys resolved concurrently — bounds the Cold footprint. A positive integer. */
  readonly concurrency?: number;
  /** Override the store's per-op budget for this call (`false` lifts it). */
  readonly budget?: BudgetOption;
  /** Segments whose ids are subtracted from the result. */
  readonly exclude?: readonly SegmentRef[];
  /**
   * Allow an operand that names a segment which does not exist. Default `false` — a combine refuses one,
   * because a misspelled or mis-namespaced operand is indistinguishable from a correct one in the result.
   * Set `true` when you genuinely intend to combine against a name that may not have been created yet.
   */
  readonly allowAbsentOperands?: boolean;
}

/** One resolved operand of a chunk-aligned combine: its chunk-key set + pinned generation. */
interface Operand {
  readonly seg: SegmentRef;
  readonly keys: Set<number>;
  readonly gen: number | null | undefined;
}

export class SegmentEngine {
  private readonly cold: ColdChunkSource;
  private readonly cache: BoundedLru<string, CodecBitmap> | undefined;
  private readonly codec: CodecInterface;
  private readonly maxBitmapBytes: number;
  private readonly clock: Pick<Clock, 'now'>;
  private readonly metrics: IMetricsSink;
  private readonly metricsOn: boolean;
  /** Resolved per-op budget (null = disabled); undefined deps ⇒ the generous default. See {@link checkBudget}. */
  private readonly budget: Budget | null;

  constructor(deps: EngineDeps) {
    this.cold = deps.cold;
    this.cache = deps.cache;
    this.codec = deps.codec;
    this.maxBitmapBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
    this.clock = deps.clock ?? ZERO_CLOCK;
    // undefined ⇒ the generous default; null ⇒ explicitly disabled (must not be re-defaulted by `??`).
    this.budget = deps.budget === undefined ? DEFAULT_BUDGET : deps.budget;
    // Wrap for defense-in-depth (idempotent for the no-op) so even a direct engine construction with a
    // throwing sink can't break the data path; `metricsOn` short-circuits all emission when unused.
    this.metrics = safeMetrics(deps.metrics ?? NOOP_METRICS);
    this.metricsOn = this.metrics !== NOOP_METRICS;
  }

  /** Membership: one chunk lookup — the HOT cache, else one Cold fetch of that chunk. */
  async has(seg: SegmentRef, id: number): Promise<boolean> {
    const { chunkKey, remainder } = splitId(id);
    const cold = await this.coldChunk({ ...seg, chunkKey }, await this.currentGen(seg));
    return cold ? cold.has(remainder) : false;
  }

  /**
   * Cardinality. When the Cold source can serve per-chunk cardinality from its `.crbm` index (the `.crbm`
   * source can), the count is summed from the index with **zero payload reads**. A source without that
   * capability (the in-memory source) falls back to fetching every chunk.
   */
  async count(seg: SegmentRef): Promise<number> {
    const cardinalities = this.cold.cardinalities ? await this.cold.cardinalities(seg) : null;
    if (cardinalities) {
      let total = 0;
      for (const [k, n] of cardinalities) {
        this.assertChunkKeyInRange(k);
        total += n;
      }
      return total;
    }
    const chunkKeys = await this.chunkKeys(seg);
    checkBudget(this.budget, chunkKeys.length, 'count'); // one cold fetch per chunk (before fan-out)
    const gen = await this.currentGen(seg); // after the shape read — see `combine`
    let total = 0;
    for (const chunkKey of chunkKeys) {
      total += (await this.coldChunk({ ...seg, chunkKey }, gen))?.size ?? 0;
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

  /** Every id, ascending, one chunk at a time. */
  async *iterate(seg: SegmentRef): AsyncGenerator<number> {
    const chunkKeys = await this.chunkKeys(seg);
    checkBudget(this.budget, chunkKeys.length, 'iterate'); // one cold fetch per chunk (before fan-out)
    const gen = await this.currentGen(seg); // after the shape read — see `combine`
    for (const chunkKey of chunkKeys) {
      const chunk = await this.coldChunk({ ...seg, chunkKey }, gen);
      if (chunk === null) continue;
      // Read straight off the (possibly cached) instance: iteration does not mutate it.
      for (const remainder of chunk) yield joinId(chunkKey, remainder);
    }
  }

  /**
   * `segs[0] ∩ segs[1] ∩ …`, minus every id in `options.exclude` — streamed ascending.
   *
   * The `exclude` operands are what make suppression **compose without materialising**. Applying suppression
   * afterwards (intersect into a temp segment, then subtract) writes an intermediate segment that nobody wants;
   * applying it here folds it into the same chunk-aligned pass. It is also cheaper than it looks: an exclude
   * operand is read **only at the keys that survived the intersection** — the cost is bounded by the
   * audience's surviving key count and **never scales with the size of the suppression list**. Subtracting a
   * 61,000-chunk global opt-out list costs at most one read per surviving key, not 61,000.
   *
   * ---
   *
   * Chunk-skipping intersection. Aligns each segment's chunk-key set (read from the `.crbm` index, no payload),
   * keeps only keys present in **all** operands (a key missing from any operand can't contribute → its Cold
   * chunks are never fetched — the core saving), then for each surviving key fetches the operands' chunks in
   * parallel and hands them to the codec for the AND, streaming results through a bounded in-flight window.
   *
   * **Memory:** the Cold payload footprint is bounded by the window (`concurrency × operands × chunk`), not by
   * segment size — that's the Lambda-friendly property.
   *
   * Generation-consistent within the call (normal case): each operand's current generation is resolved **once**
   * up front (before the fan-out) and threaded into every chunk read, so a concurrent load can't corrupt or tear
   * the result — every chunk read is a whole, checksum-verified, immutable generation. The edge a *long* call can
   * hit: if it straddles a mid-call `coldGenTtlMs` boundary and a load has published, an operand's not-yet-read
   * chunks may re-resolve forward to the newer generation (a generation hop within one long call) — the call
   * never crashes or returns a torn object, but may mix generations. A shorter call is unaffected **unless the
   * reader cache evicts an operand mid-call** (`maxOpenSegments`): the re-read re-resolves fresh (bypassing the
   * TTL), which can hop generations even sub-TTL — still whole/immutable per read, never torn.
   */
  intersect(segs: readonly SegmentRef[], options?: CombineOptions): AsyncGenerator<number> {
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
  union(segs: readonly SegmentRef[], options?: CombineOptions): AsyncGenerator<number> {
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
    options?: Omit<CombineOptions, 'exclude'>,
  ): AsyncGenerator<number> {
    return this.combine([seg], excludes, 'all', 'andNot', options);
  }

  private async *combine(
    segs: readonly SegmentRef[],
    excludeSegs: readonly SegmentRef[],
    mode: 'all' | 'any',
    op: 'intersect' | 'union' | 'andNot',
    options?: Omit<CombineOptions, 'exclude'>,
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

    // ① Index-map extraction: each operand's chunk-key set + its current generation, resolved ONCE here (not
    // per chunk) so the fan-out below adds no per-chunk generation re-resolve. Only metadata so far.
    //
    // Generation resolution ordering: resolve `gen` AFTER the shape read (`listChunkKeys`). A non-empty shape
    // read means the source resolved and cached a non-null snapshot, so `gen` cannot then come back null while
    // cold data is present, and `coldChunk` cannot skip every chunk on a stale null.
    //
    // Honest note on how much this ordering now buys, because the comment used to claim more than it can and a
    // future reader should not take an untested claim for a tested one. Against a `CrbmColdChunkSource` — the
    // only source with a generation to resolve — both reads go through the same resolved-reader memo, so the
    // pathological state (`keys` non-empty, `gen` null) does not arise and swapping the two is observably
    // identical. What made the reverse order genuinely lossy was the removed delta tier: the shape was a union
    // of warm keys and cold keys, so a stale null cold generation dropped real data from a chunk the warm side
    // had put in the shape. The ordering is kept because it is the order that is correct for *any* source
    // satisfying the port — a custom source that resolves its shape and its generation independently can still
    // produce that state — not because a test can currently tell the difference.
    //
    // Within a call shorter than `coldGenTtlMs` the two share one snapshot, so the read is
    // generation-consistent — absent cache-pressure eviction (see `intersect`).
    const extract = async (seg: SegmentRef): Promise<Operand> => {
      const keys = await this.chunkKeys(seg);
      const gen = await this.currentGen(seg);
      return { seg, keys: new Set(keys), gen };
    };
    const [operands, excludes] = await Promise.all([
      Promise.all(segs.map(extract)),
      Promise.all(excludeSegs.map(extract)),
    ]);
    await this.refuseAbsentOperands([...operands, ...excludes], options?.allowAbsentOperands, op);

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
    // one cold fetch per surviving key per operand — refuse up front if that would exceed the budget. Placed
    // above the metric so a refused intersect doesn't report chunks it never fetched.
    //
    // Units are the chunk reads this will actually issue, counted per key: every include present at that key
    // (all of them under 'all'), plus only those excludes that hold the key. Counting excludes as always-present
    // would refuse work that costs nothing — the whole point of the asymmetry above. For a plain `intersect`
    // with no excludes this reduces to `common.length * operands.length`.
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
      for (const o of operands) for (const k of o.keys) distinctKeys.add(k);
      for (const e of excludes) for (const k of e.keys) distinctKeys.add(k);
      // `fetchedChunks` counts **distinct chunk keys**, not per-operand reads — its long-standing documented
      // unit, asserted by the bench anchors and the metrics tests. Deliberately NOT changed to match the
      // budget's request count: they measure different things on purpose (keys vs billable requests). The
      // relationship is documented on the event instead.
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
   * The AND (or OR) of one chunk key across all operands, minus the excludes that hold it, or `null` if empty.
   * Operand chunks are fetched **in parallel** (the spec's parallel byte-range reads).
   *
   * The accumulator is a **clone** of the first operand's chunk, and that clone is load-bearing: every other
   * bitmap here is the cached, shared Cold instance and must never be mutated, or the HOT cache is poisoned for
   * every later reader. The remaining operands and the excludes are only *read* by the in-place ops, so they are
   * used as-is — one clone per key, not one per operand.
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
      present.map((op) => this.coldChunk({ ...op.seg, chunkKey }, op.gen)),
    );
    // A key the index lists but the source cannot produce bytes for reads as empty — and under AND an empty
    // operand empties the result.
    if (mode === 'all' && chunks.some((c) => c === null)) return null;
    const first = chunks[0];
    const acc = first ? first.clone() : this.codec.empty();
    for (let i = 1; i < chunks.length; i++) {
      const other = chunks[i];
      if (other === null || other === undefined) continue; // 'any' only — 'all' returned above
      if (mode === 'all') {
        acc.andInPlace(other);
        if (acc.isEmpty) return null; // once empty, the remaining operands can't revive it
      } else {
        acc.orInPlace(other);
      }
    }
    if (acc.isEmpty) return null;

    // Suppression, folded into the same pass. Only excludes that actually hold this key are fetched — this is
    // where a large global opt-out list stops being expensive. Fetched lazily rather than alongside the
    // includes above, because an AND that collapsed to empty means there is nothing left to suppress.
    const relevant = excludes.filter((e) => e.keys.has(chunkKey));
    if (relevant.length > 0) {
      const cuts = await Promise.all(
        relevant.map((e) => this.coldChunk({ ...e.seg, chunkKey }, e.gen)),
      );
      for (const cut of cuts) {
        if (cut === null) continue;
        acc.andNotInPlace(cut);
        if (acc.isEmpty) return null;
      }
    }
    return acc;
  }

  /** The segment's chunk keys, ascending — a shape read off the index, no payload. Keys are untrusted (invariant 5). */
  private async chunkKeys(seg: SegmentRef): Promise<number[]> {
    const keys = [...(await this.cold.listChunkKeys(seg))];
    for (const k of keys) this.assertChunkKeyInRange(k);
    return keys.sort((a, b) => a - b);
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
   * The other half of invariant 5: a chunk payload holds **remainders** — 16-bit offsets within one chunk — so
   * every value must be `<= 0xffff`.
   *
   * Nothing upstream establishes that. The byte cap bounds *size*, and CRC/AEAD prove the bytes are the bytes
   * that were written — which anyone able to write the bucket satisfies trivially. A value `>= 65536` would then
   * reach `joinId`, which masks it (`remainder & 0xffff`) and emits a **fabricated id belonging to a different
   * chunk's id space**: indistinguishable from real data, inflating `count()` and creating spurious `intersect`
   * matches.
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

  /**
   * Refuse a combine whose operand names a segment that was never created.
   *
   * A segment that resolves to nothing is ambiguous in a way that matters only here. Read it directly and
   * "empty" is the right answer either way. Pass it as an **operand** and the two states diverge: a
   * suppression list with nobody on it correctly suppresses nothing, while one whose namespace you omitted
   * *silently* suppresses nothing — and the result is not empty and obviously wrong, it is the full audience
   * and plausibly right. That direction is the dangerous one: the failure mode is mailing the people who
   * opted out.
   *
   * The asymmetry is why this is checked rather than left to the caller. A mistyped **include** collapses an
   * intersect to nothing, which you notice; a mistyped **exclude** removes a safeguard, which you do not. Both
   * are refused, because both are wiring errors and one rule is easier to trust than two.
   *
   * **Costs nothing on a normal combine.** `exists` is consulted only for an operand that resolved to zero
   * chunks — a segment with data is self-evidently registered — so the check is a registry read exactly when
   * a combine was about to do something suspicious, and no reads at all otherwise. A source that cannot answer
   * `exists` (it has no notion of registration) skips the check rather than guessing.
   */
  private async refuseAbsentOperands(
    resolved: readonly Operand[],
    allow: boolean | undefined,
    op: string,
  ): Promise<void> {
    if (allow === true || this.cold.exists === undefined) return;
    const empty = resolved.filter((o) => o.keys.size === 0);
    if (empty.length === 0) return;
    const checked = await Promise.all(
      empty.map(async (o) => ({ seg: o.seg, exists: await this.cold.exists!(o.seg) })),
    );
    const absent = checked.filter((c) => !c.exists).map((c) => c.seg);
    if (absent.length === 0) return;
    const named = absent
      .map((s) => (s.namespace === undefined ? `"${s.segment}"` : `"${s.namespace}/${s.segment}"`))
      .join(', ');
    throw new ValidationError(
      `${op}: operand ${named} names a segment that does not exist, so it would contribute nothing — ` +
        `an exclude would suppress no ids and an include would contribute none. Check the name and the ` +
        `namespace (a segment addressed without its \`namespace\` is a DIFFERENT segment). ` +
        `Pass \`allowAbsentOperands: true\` if you meant it.`,
    );
  }

  /**
   * Drop every piece of state this engine derived from `ref`, and tell the Cold source to do the same.
   *
   * The decoded-chunk cache is keyed by generation, which handles a *publish* (the new generation misses) but
   * not a *destruction*: a segment that was erased from, dropped, shredded or retired has no newer generation
   * whose key would miss, so its decoded chunks stay resident and keep answering. That is why the erasing
   * process itself could report `erased: true` and then still answer `true` for the same id, out of RAM, with
   * no storage read to intercept.
   *
   * Called by the destructive verbs on the facade. Synchronous and best-effort — forgetting cannot fail.
   */
  invalidate(ref: SegmentRef): void {
    const prefix = segmentPrefix(ref);
    this.cache?.deleteWhere((key) => key.startsWith(prefix));
    this.cold.invalidate?.(ref);
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
   * keyed by it, so a load that advances the generation misses the cache and re-reads the new bytes instead of
   * serving a stale decoded chunk (an erased id can't resurrect from a cached superseded chunk). `gen === null`
   * ⇒ the source reports no current generation ⇒ no cold bytes for any chunk, so skip the fetch entirely.
   * `gen === undefined` ⇒ the source can't report a generation (pins one for its lifetime) ⇒ the key stays
   * generation-free. Superseded-generation entries age out under the LRU ceiling — no active purge.
   *
   * The returned instance is **shared** (it may be the cached one): callers read it or clone it, never mutate it.
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
