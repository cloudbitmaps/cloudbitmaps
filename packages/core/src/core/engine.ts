/**
 * SegmentEngine — the read side of the loaded store: id routing, the chunk-skipping combines, and the cache
 * of decoded Storage chunks, over the {@link StorageChunkSource} port.
 *
 * **Read-only by design.** Every write in this library is a new immutable generation — a load, the facade's
 * `*Into` verbs, `eraseIdFromSegment` — published through the registry pointer. Nothing here mutates
 * stored bytes, so a read never merges tiers: one chunk read is one whole, checksum-verified, immutable chunk of
 * one generation. Storage-agnostic and time/random-free (the determinism seam): all I/O is via the injected
 * source; the cache carries its own `Clock`.
 */
import { splitId, joinId, CHUNK_COUNT, MAX_REMAINDER, U32_MAX } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { checkBudget, DEFAULT_BUDGET, resolvePerOpBudget } from './budget';
import type { Budget, BudgetOption } from './budget';
import type { Clock } from './determinism';
import { IntegrityError, ValidationError } from './errors';
import { chunkGenKey, chunkRefKey, segmentPrefix } from './keys';
import type { BoundedLru } from './lru';
import { NOOP_METRICS, safeMetrics } from './metrics';
import type { IMetricsSink } from './metrics';
import type { ChunkRef, StorageChunkSource, SegmentRef, SegmentSize } from './ports';

const DEFAULT_MAX_BITMAP_BYTES = 1 << 20; // 1 MiB per bitmap — generous; real chunks are far smaller
/** Max overlapping-chunk intersections in flight — bounds memory + concurrent reads (invariant 6). */
const DEFAULT_INTERSECT_CONCURRENCY = 8;

/** A clock that always reads 0 — used when nothing is injected, so the `storage.get` latency metric reports 0 ms. */
const ZERO_CLOCK: Pick<Clock, 'now'> = { now: () => 0 };

export interface EngineDeps {
  readonly storage: StorageChunkSource;
  /** Optional cache of decoded (immutable) Storage chunks. */
  readonly cache?: BoundedLru<string, CodecBitmap>;
  readonly maxBitmapBytes?: number;
  /**
   * The bitmap codec — **required**. `core/` is codec-agnostic: it can have no default, because the concrete codec
   * lives in a *flavor* package that depends on core (a default here would invert that arrow). A flavor's facade
   * injects it — `@cloudbitmaps/roaring` passes the roaring codec — so applications never see this.
   */
  readonly codec: CodecInterface;
  /** Time source for the `storage.get` latency metric only; defaults to a clock that reads 0. */
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

/**
 * A range of ids for a read to yield: those greater than `after` and no greater than `through`, `(after, through]`.
 *
 * Built for keyset paging: `after` is the last id the caller already has, `through` the end of its window. Each is
 * optional: left out, the read starts at the first id or runs to the last. Each is an integer in `0..4294967295`, or
 * the read throws {@link ValidationError} when it is first read. `after >= through` is an empty range, not an error,
 * because a cursor that has reached the end of its window is normal; an empty range reads nothing, not even whether
 * a combine's operands exist.
 *
 * A read with a range fetches only the chunks the range overlaps, on a combine for every operand and every
 * `exclude`. The per-op budget is charged once, before the first fetch, for every chunk in the range, so with
 * `after` alone it is charged to the end of the segment however early the caller stops; pass `through` to bound it.
 */
export interface IdRange {
  /** Exclusive lower bound: the read yields only ids greater than this. */
  readonly after?: number | undefined;
  /** Inclusive upper bound: the read yields only ids up to and including this. */
  readonly through?: number | undefined;
}

/** Options common to the chunk-aligned combines. */
export interface CombineOptions extends IdRange {
  /** Max chunk keys resolved concurrently — bounds the Storage footprint. A positive integer. */
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
  /** The operand's chunk keys, inside the read's range when it has one. */
  readonly keys: Set<number>;
  /** Whether the segment has no chunks at all, whatever the range: what the absent-operand check judges. */
  readonly chunkless: boolean;
  /** The cache-key component — a `currentVersion` string, a generation number, or absent. */
  readonly gen: string | number | null | undefined;
}

/** A validated {@link IdRange}: inclusive id bounds, and the chunk key and remainder at each end. */
interface IdWindow {
  readonly loKey: number;
  readonly loRem: number;
  readonly hiKey: number;
  readonly hiRem: number;
}

/**
 * Validate a read's range. `null` when none was asked for, so the read does no extra work; `'empty'` when no id can
 * be in it.
 */
function windowOf(range: IdRange | undefined): IdWindow | 'empty' | null {
  const after = range?.after;
  const through = range?.through;
  if (after === undefined && through === undefined) return null;
  for (const [name, bound] of [
    ['after', after],
    ['through', through],
  ] as const) {
    if (bound !== undefined && (!Number.isInteger(bound) || bound < 0 || bound > U32_MAX)) {
      const got = typeof bound === 'number' ? String(bound) : `a ${typeof bound}`;
      throw new ValidationError(`${name} must be an integer in 0..${U32_MAX}; got ${got}`);
    }
  }
  const lo = after === undefined ? 0 : after + 1;
  const hi = through ?? U32_MAX;
  if (lo > hi) return 'empty';
  return {
    loKey: Math.floor(lo / CHUNK_COUNT),
    loRem: lo % CHUNK_COUNT,
    hiKey: Math.floor(hi / CHUNK_COUNT),
    hiRem: hi % CHUNK_COUNT,
  };
}

/** The window a range with neither bound set describes: every id. */
const WHOLE_ID_SPACE: IdWindow = {
  loKey: 0,
  loRem: 0,
  hiKey: CHUNK_COUNT - 1,
  hiRem: MAX_REMAINDER,
};

/**
 * Whether the range cuts inside `chunkKey`: one of its two edge chunks, and only where the bound falls inside the
 * chunk rather than on its boundary. A chunk the range covers whole is yielded by the plain loop.
 */
const isEdge = (chunkKey: number, w: IdWindow): boolean =>
  (chunkKey === w.loKey && w.loRem > 0) || (chunkKey === w.hiKey && w.hiRem < MAX_REMAINDER);

/** The ids of an edge chunk that lie inside the window. The chunk iterates ascending, so it stops at the top. */
function* edgeIds(chunk: CodecBitmap, chunkKey: number, w: IdWindow): Generator<number> {
  const from = chunkKey === w.loKey ? w.loRem : 0;
  const to = chunkKey === w.hiKey ? w.hiRem : MAX_REMAINDER;
  for (const remainder of chunk) {
    if (remainder > to) return;
    if (remainder >= from) yield joinId(chunkKey, remainder);
  }
}

/** The ascending `keys` inside the window's chunk span: two binary searches, no scan. */
function keysWithin(keys: readonly number[], w: IdWindow): number[] {
  const firstAtLeast = (key: number): number => {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return keys.slice(firstAtLeast(w.loKey), firstAtLeast(w.hiKey + 1));
}

/**
 * An ordered window of chunk reads: up to `max` reads open ahead of the one being consumed, handed back in key
 * order. With `ramp`, the window opens 1, 2, 4, 8 wide instead of `max` at once, so a read that stops after a few
 * ids has fetched a handful of chunks, not a full window.
 *
 * Each read is wrapped to resolve and never reject, so a read nobody consumes (the consumer stopped, or an
 * earlier chunk failed) cannot raise an unhandled rejection; its error surfaces from {@link take} only if the
 * read reaches that chunk. Memory is bounded by the window: at most `max` decoded chunks are held ahead.
 */
class ChunkWindow {
  private readonly open: Array<Promise<{ chunk: CodecBitmap | null; error?: { cause: unknown } }>> =
    [];
  private launched = 0;
  private taken = 0;

  constructor(
    private readonly keys: readonly number[],
    private readonly fetch: (chunkKey: number) => Promise<CodecBitmap | null>,
    private readonly max: number,
    private readonly ramp: boolean,
  ) {}

  /** The next chunk in key order (null if the source holds none), or the error its read raised. */
  async take(): Promise<CodecBitmap | null> {
    const width = this.ramp ? Math.min(this.max, 2 ** Math.min(this.taken, 30)) : this.max;
    while (this.launched < this.keys.length && this.launched - this.taken < width) {
      this.open.push(
        this.fetch(this.keys[this.launched++]!).then(
          (chunk) => ({ chunk }),
          (cause: unknown) => ({ chunk: null, error: { cause } }),
        ),
      );
    }
    const slot = await this.open.shift()!;
    this.taken += 1;
    if (slot.error) throw slot.error.cause;
    return slot.chunk;
  }
}

export class SegmentEngine {
  private readonly storage: StorageChunkSource;
  private readonly cache: BoundedLru<string, CodecBitmap> | undefined;
  private readonly codec: CodecInterface;
  private readonly maxBitmapBytes: number;
  private readonly clock: Pick<Clock, 'now'>;
  private readonly metrics: IMetricsSink;
  private readonly metricsOn: boolean;
  /** Resolved per-op budget (null = disabled); undefined deps ⇒ the generous default. */
  private readonly budget: Budget | null;

  constructor(deps: EngineDeps) {
    this.storage = deps.storage;
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

  /** Membership: one chunk lookup — the cache, else one Storage fetch of that chunk. */
  async has(seg: SegmentRef, id: number): Promise<boolean> {
    const { chunkKey, remainder } = splitId(id);
    const chunk = await this.storageChunk({ ...seg, chunkKey }, await this.cacheVersion(seg));
    return chunk ? chunk.has(remainder) : false;
  }

  /**
   * Cardinality. When the Storage source can serve per-chunk cardinality from its `.crbm` index (the `.crbm`
   * source can), the count is summed from the index with **zero payload reads**. A source without that
   * capability (the in-memory source) falls back to fetching every chunk.
   *
   * The index sum is trusted, not confirmed: the reader checked the index for internal consistency when it opened
   * the object, and a corrupt index that is still internally consistent yields a wrong count. `iterate()` and the
   * combines decode the payloads.
   */
  async count(seg: SegmentRef): Promise<number> {
    const cardinalities = this.storage.cardinalities ? await this.storage.cardinalities(seg) : null;
    if (cardinalities) {
      let total = 0;
      for (const [k, n] of cardinalities) {
        this.assertChunkKeyInRange(k);
        total += n;
      }
      return total;
    }
    const chunkKeys = await this.chunkKeys(seg);
    checkBudget(this.budget, chunkKeys.length, 'count'); // one storage fetch per chunk (before fan-out)
    const gen = await this.cacheVersion(seg); // after the shape read — see `combine`
    // Order does not matter to a sum, but the window hands chunks back in key order: no more state than that.
    const window = this.chunkWindow(seg, chunkKeys, gen, false);
    let total = 0;
    for (let i = 0; i < chunkKeys.length; i++) total += (await window.take())?.size ?? 0;
    return total;
  }

  /** Whether the Storage source can measure segment size (for grounded cost); false ⇒ storage isn't grounded. */
  get supportsStorageSize(): boolean {
    return typeof this.storage.sizeOf === 'function';
  }

  /** How often the Storage source re-reads a pointer while reading (cost reporting); undefined if it does not say. */
  get pointerRefreshMs(): number | undefined {
    return this.storage.pointerRefreshMs;
  }

  /** Grounded Storage size of a segment's current generation (cost reporting), or null if it has no generation. */
  segmentSize(seg: SegmentRef): Promise<SegmentSize | null> {
    return this.storage.sizeOf ? this.storage.sizeOf(seg) : Promise.resolve(null);
  }

  /** The chunks of `seg` at `chunkKeys`, read through a window of {@link DEFAULT_INTERSECT_CONCURRENCY}. */
  private chunkWindow(
    seg: SegmentRef,
    chunkKeys: readonly number[],
    gen: string | number | null | undefined,
    ramp: boolean,
  ): ChunkWindow {
    return new ChunkWindow(
      chunkKeys,
      (chunkKey) => this.storageChunk({ ...seg, chunkKey }, gen),
      DEFAULT_INTERSECT_CONCURRENCY,
      ramp,
    );
  }

  /**
   * Every id, ascending, reading ahead through a window of up to 8 chunk fetches that opens 1, 2, 4, 8 wide, so a
   * read that stops early has fetched only a handful of chunks past the one it stopped in; with `range`, only the ids in `(after, through]`, fetching only the
   * chunks the range overlaps (see {@link IdRange}).
   *
   * Two generators, not one with a branch: a second `yield` site in the full read's generator grows its frame, and
   * every id of a read that asked for no range paid for it (measured at about 5% per id). The full read keeps the
   * loop it always had.
   */
  iterate(seg: SegmentRef, range?: IdRange): AsyncGenerator<number> {
    return range === undefined ? this.iterateAll(seg) : this.iterateRange(seg, range);
  }

  private async *iterateAll(seg: SegmentRef): AsyncGenerator<number> {
    const chunkKeys = await this.chunkKeys(seg);
    checkBudget(this.budget, chunkKeys.length, 'iterate'); // one storage fetch per chunk (before fan-out)
    const gen = await this.cacheVersion(seg); // after the shape read — see `combine`
    const window = this.chunkWindow(seg, chunkKeys, gen, true);
    for (const chunkKey of chunkKeys) {
      const chunk = await window.take();
      if (chunk === null) continue;
      // Read straight off the (possibly cached) instance: iteration does not mutate it.
      for (const remainder of chunk) yield joinId(chunkKey, remainder);
    }
  }

  private async *iterateRange(seg: SegmentRef, range: IdRange): AsyncGenerator<number> {
    const w = windowOf(range) ?? WHOLE_ID_SPACE;
    if (w === 'empty') return;
    const chunkKeys = keysWithin(await this.chunkKeys(seg), w);
    checkBudget(this.budget, chunkKeys.length, 'iterate'); // one storage fetch per chunk (before fan-out)
    const gen = await this.cacheVersion(seg); // after the shape read — see `combine`
    const window = this.chunkWindow(seg, chunkKeys, gen, true);
    for (const chunkKey of chunkKeys) {
      const chunk = await window.take();
      if (chunk === null) continue;
      if (isEdge(chunkKey, w)) {
        for (const id of edgeIds(chunk, chunkKey, w)) yield id;
      } else {
        for (const remainder of chunk) yield joinId(chunkKey, remainder);
      }
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
   * keeps only keys present in **all** operands (a key missing from any operand can't contribute → its Storage
   * chunks are never fetched — the core saving), then for each surviving key fetches the operands' chunks in
   * parallel and hands them to the codec for the AND, streaming results through a bounded in-flight window.
   *
   * **Memory:** the Storage payload footprint is bounded by the window (`concurrency × operands × chunk`), not by
   * segment size — that's the Lambda-friendly property.
   *
   * Generation-consistent within the call (normal case): each operand's current generation is resolved **once**
   * up front (before the fan-out) and threaded into every chunk read, so a concurrent load can't corrupt or tear
   * the result — every chunk read is a whole, checksum-verified, immutable generation. The edge a *long* call can
   * hit is invariant 3's: if it straddles a mid-call `cache.genTtlMs` boundary and a load has published, an
   * operand's not-yet-read chunks may re-resolve forward to the newer generation (a generation hop within one long
   * call) — the call never crashes or returns a torn object, but may mix generations. Three things hop it without
   * waiting for the TTL, so a shorter call can meet them too: **the reader cache evicting an operand mid-call**
   * (`maxOpenSegments`), whose re-read re-resolves fresh; a sweep deleting the generation it was reading, which
   * heals the read forward; and an invalidation, which this store's own `load`, `rollback` and `eraseSubject` make
   * and `invalidate()` makes on request. Still whole/immutable per read, never torn.
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
    // The range, if any, cuts every operand's keys once, here, so what follows — alignment, the budget, the
    // metrics, the fan-out — sees only chunks inside it. Only the two edge chunks are cut again, where ids leave.
    const w = windowOf(options);
    if (w === 'empty') return;

    // ① Index-map extraction: each operand's chunk-key set + its current generation, resolved ONCE here (not
    // per chunk) so the fan-out below adds no per-chunk generation re-resolve. Only metadata so far.
    //
    // Generation resolution ordering: resolve `gen` AFTER the shape read (`listChunkKeys`). A non-empty shape
    // read means the source resolved and cached a non-null snapshot, so `gen` cannot then come back null while
    // storage data is present, and `storageChunk` cannot skip every chunk on a stale null.
    //
    // Honest note on how much this ordering buys, so a future reader does not take an untested claim for a tested
    // one. Against a `CrbmStorageChunkSource` — the
    // only source with a generation to resolve — both reads go through the same resolved-reader memo, so the
    // pathological state (`keys` non-empty, `gen` null) does not arise and swapping the two is observably
    // identical. The ordering is kept because it is the order that is correct for *any* source
    // satisfying the port — a custom source that resolves its shape and its generation independently can still
    // produce that state — not because a test can currently tell the difference.
    //
    // Within a call shorter than `cache.genTtlMs` the two share one snapshot, so the read is
    // generation-consistent — absent cache-pressure eviction (see `intersect`).
    const extract = async (seg: SegmentRef): Promise<Operand> => {
      const all = await this.chunkKeys(seg);
      const gen = await this.cacheVersion(seg);
      const keys = w === null ? all : keysWithin(all, w);
      return { seg, keys: new Set(keys), chunkless: all.length === 0, gen };
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
    // one storage fetch per surviving key per operand — refuse up front if that would exceed the budget. Placed
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
      // `fetchedChunks` counts **distinct chunk keys**, not per-operand reads — its documented unit, asserted by
      // the bench anchors and the metrics tests. It deliberately differs from the budget's request count: they
      // measure different things on purpose (keys vs billable requests). The
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
    // `limit` keys concurrently, yield each key's ids before priming far ahead (bounded Storage footprint).
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
        if (w !== null && isEdge(slot.key, w)) {
          for (const id of edgeIds(slot.result, slot.key, w)) yield id;
        } else {
          for (const remainder of slot.result) yield joinId(slot.key, remainder);
        }
      }
    }
  }

  /**
   * The AND (or OR) of one chunk key across all operands, minus the excludes that hold it, or `null` if empty.
   * Operand chunks are fetched **in parallel** (the spec's parallel byte-range reads).
   *
   * The accumulator is a **clone** of the first operand's chunk, and that clone is load-bearing: every other
   * bitmap here is the cached, shared Storage instance and must never be mutated, or the cache is poisoned for
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
      present.map((op) => this.storageChunk({ ...op.seg, chunkKey }, op.gen)),
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
        relevant.map((e) => this.storageChunk({ ...e.seg, chunkKey }, e.gen)),
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
    const keys = [...(await this.storage.listChunkKeys(seg))];
    for (const k of keys) this.assertChunkKeyInRange(k);
    keys.sort((a, b) => a - b);
    // A key listed twice would be read and yielded twice; the `.crbm` reader refuses one, a custom source may not.
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] === keys[i - 1]) {
        throw new IntegrityError(`chunk key from a tier is listed twice: ${keys[i]}`);
      }
    }
    return keys;
  }

  /**
   * Tier-derived keys are untrusted (invariant 5) — fail fast on a corrupt/out-of-range key rather than
   * letting it flow into the id-routing step and produce a bogus id.
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
   * reach the id-routing step, which masks it (`remainder & 0xffff`) and emits a **fabricated id belonging to a different
   * chunk's id space**: indistinguishable from real data, inflating `count()` and creating spurious `intersect`
   * matches.
   *
   * Costs one `maximum()` per chunk, not per id — `maximum` is optional on the codec seam precisely so a codec
   * that cannot answer in O(1) opts out instead of making the read path walk every value.
   *
   * One value stands for all of them only because the decode is structurally checked. Roaring answers `maximum()`
   * from its last container, so a payload listing its containers out of order would report the wrong one's
   * largest value and pass here while holding values above 65,535. The codec's `safeDeserialize` refuses that
   * payload, and every other shape that would make this answer wrong, before it reaches this check.
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
   * `exists` (it has no notion of registration) skips the check rather than guessing. An operand is judged by
   * all its chunks, not those inside a range: one with nothing in range but data elsewhere is not suspicious.
   */
  private async refuseAbsentOperands(
    resolved: readonly Operand[],
    allow: boolean | undefined,
    op: string,
  ): Promise<void> {
    if (allow === true || this.storage.exists === undefined) return;
    const empty = resolved.filter((o) => o.chunkless);
    if (empty.length === 0) return;
    const checked = await Promise.all(
      empty.map(async (o) => ({ seg: o.seg, exists: await this.storage.exists!(o.seg) })),
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
   * Drop every piece of state this engine derived from `ref`, and tell the Storage source to do the same.
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
    this.storage.invalidate?.(ref);
  }

  /** The segment's current generation, resolved once per op (`undefined` ⇒ source can't report it). */
  private currentGen(seg: SegmentRef): Promise<number | null | undefined> {
    return this.storage.currentGeneration
      ? this.storage.currentGeneration(seg)
      : Promise.resolve(undefined);
  }

  /**
   * The cache-key component identifying **which bytes** this op will read: the source's `currentVersion` when
   * it has one, else the generation alone.
   *
   * The generation alone is not an identity. A load's generation number restarts at 0 once a row is purged
   * and the bucket emptied, so a retired-and-re-created name serves different data at the same `currentGen` — and a
   * decoded chunk cached under `(segment, chunk, 0)` is handed straight back to the new incarnation. That is an
   * erased id reappearing with no read to intercept it, which is why this is keyed on the version rather than
   * the number.
   */
  private async cacheVersion(seg: SegmentRef): Promise<string | number | null | undefined> {
    if (this.storage.currentVersion) return this.storage.currentVersion(seg);
    return this.currentGen(seg);
  }

  /**
   * Decode a Storage chunk. `gen` is the segment's current generation, resolved **once per op** by the caller (not
   * per chunk — that would put a registry re-resolve on every chunk of a count/intersect). The cache is
   * keyed by it, so a load that advances the generation misses the cache and re-reads the new bytes instead of
   * serving a stale decoded chunk (an erased id can't resurrect from a cached superseded chunk). `gen === null`
   * ⇒ the source reports no current generation ⇒ no storage bytes for any chunk, so skip the fetch entirely.
   * `gen === undefined` ⇒ the source can't report a generation (it only ever serves one) ⇒ the key stays
   * generation-free. Superseded-generation entries age out under the LRU ceiling — no active purge.
   *
   * The returned instance is **shared** (it may be the cached one): callers read it or clone it, never mutate it.
   */
  private async storageChunk(
    ref: ChunkRef,
    gen: string | number | null | undefined,
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
    const bytes = await this.storage.getChunk(ref);
    if (this.metricsOn) {
      this.metrics.onEvent({
        kind: 'storage.get',
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
