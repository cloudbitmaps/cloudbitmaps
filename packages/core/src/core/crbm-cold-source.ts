/**
 * Bridges the `.crbm` archive format to the engine's Cold seam (decision 4).
 *
 * `CrbmColdChunkSource` implements the {@link ColdChunkSource} the engine reads through, over an
 * {@link IColdDriver}: it resolves a segment's current generation, opens its {@link CrbmReader} once, and serves
 * per-chunk payloads. `writeCrbmGeneration` / `writeCrbmGenerationStream` are the write primitives (a generation
 * built from bitmaps, in memory or streamed), `bulkLoadCrbmGeneration` is the load path over them, and
 * `publishGeneration` is the forward-only pointer advance every write ends with.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import {
  IntegrityError,
  CapabilityError,
  KeyUnavailableError,
  ValidationError,
  WriteConflictError,
  isNotFoundError,
  isWriteConflictError,
} from './errors';
import type { BlobReader } from './blob';
import { yieldEvery } from './cooperative';
import type { Yielder } from './cooperative';
import type { Clock } from './determinism';
import { BoundedLru } from './lru';
import { splitId } from './bit-route';
import { segmentKey } from './keys';
import { aadFor } from './crypto';
import type { CrbmCrypto, IKeystore, WrappedDek } from './crypto';
import { validateChunkRef, validateSegmentRef } from './validate';
import type {
  ChunkRef,
  ColdChunkSource,
  GenKey,
  IColdDriver,
  IRegistryDriver,
  SegmentRef,
  SegmentSize,
} from './ports';
import { CrbmReader } from './crbm/reader';
import type { CrbmReaderOptions } from './crbm/reader';
import { CrbmWriter } from './crbm/writer';
import type { CodecBitmap, CodecInterface } from './codec';
import { requireCodec } from './codec';

export interface CrbmColdChunkSourceOptions extends CrbmReaderOptions {
  /**
   * Optional {@link IRegistryDriver}. When provided, the current generation is resolved via the registry's
   * authoritative `currentGen` (one cheap strong read) instead of a `list` scan of every generation — the
   * retirement of that scan. When absent, the source falls back to the `list`-scan (so the
   * in-memory / simple setups keep working with no registry). The resolved generation is cached and
   * **re-resolved on a short TTL** ({@link currentGenTtlMs}, needs a {@link clock}) so a long-lived source
   * observes a load's new generation within the TTL instead of pinning one generation forever.
   */
  readonly registry?: IRegistryDriver;
  /**
   * Optional {@link IKeystore} for reading **encrypted** segments. When a segment's registry record
   * carries wrapped DEK(s), the source unwraps the DEK via this keystore and decrypts each chunk/index. Reading
   * an encrypted segment without a keystore throws {@link KeyUnavailableError}; cleartext segments ignore it.
   * Requires a `registry` (that's where the wrapped DEKs live).
   */
  readonly keystore?: IKeystore;
  /**
   * Enforce that every segment read is encrypted. When true, resolving a **cleartext** segment (no
   * wrapped DEKs) throws {@link KeyUnavailableError} — a guard against silently reading a segment that should
   * have been encrypted. Off by default (encryption is opt-in).
   */
  readonly requireEncryption?: boolean;
  /**
   * Time source for the current-generation TTL refresh — the determinism seam; `core/` never reads
   * ambient time. Refresh needs **both** a clock and a `registry`; without either the source **pins** the
   * first-resolved generation for its lifetime (the behaviour before the registry was wired in). The `CloudRoaring` facade passes its
   * clock automatically, so wiring a `registry` is enough to get live cross-generation invalidation.
   */
  readonly clock?: Pick<Clock, 'now'>;
  /**
   * How long (ms) a resolved `currentGen` is trusted before the next read re-resolves it (default 2000) — the
   * bound on read staleness after a load publishes: a reader may serve the prior generation for up to this long,
   * then converges. Lazy (checked on read — no timer); ≤ one cheap registry read per segment per window, and a
   * new {@link CrbmReader} is opened only when the generation actually changed. `0` (or no clock) ⇒ pin forever.
   */
  readonly currentGenTtlMs?: number;
  /**
   * Hard ceiling on how many segments' readers (each holding a fully-parsed `.crbm` index) are cached at once
   * (default 1024) — a memory bound for a long-running server. Past it, the least-recently-used
   * segment's reader is evicted; the next read of an evicted segment re-opens it (one cheap tail GET, since
   * generations are immutable). Raise it for a big hot working set of small segments.
   */
  readonly maxOpenSegments?: number;
  /**
   * Aggregate byte ceiling on the parsed `.crbm` indices resident in the reader cache (default 64 MiB) — the
   * **second half of that memory bound**. `maxOpenSegments` alone bounds by *count*, but a wide/dense segment's
   * parsed index can be several MB, so 1024 wide indices could pin ~GBs and blow a small heap (e.g. a 128 MB
   * Lambda) while the count is nominally "in bounds". This caps the summed {@link CrbmReader.retainedIndexBytes}
   * across cached readers; the least-recently-used reader is evicted once the total would exceed it — whichever
   * of the count/byte bounds binds first. Lower it for memory-tight deployments with wide segments; a single
   * segment whose index alone exceeds the budget is still cached (it can't be shrunk) but nothing else alongside.
   */
  readonly maxOpenIndexBytes?: number;
}

/** Adapt one `(driver, key)` pair to the codec's `BlobReader` seam. */
function coldBlobReader(driver: IColdDriver, key: GenKey): BlobReader {
  return {
    getRange(offset, length) {
      return driver.getRange(key, offset, length);
    },
    getTail(maxBytes) {
      return driver.getTail(key, maxBytes);
    },
  };
}

/** The generation target `resolveTarget` produces: which generation is current + its DEK wrappings (if encrypted). */
type Target = { generation: number; wrappedDeks?: readonly WrappedDek[] };

/** A memoized per-segment reader plus the time it was installed, for the current-generation TTL refresh. */
interface Snapshot {
  readonly reader: Promise<CrbmReader | null>;
  readonly installedAtMs: number;
}

/** Default TTL (ms) for re-resolving a segment's `currentGen` — the bound on post-publish read staleness. */
const DEFAULT_CURRENT_GEN_TTL_MS = 2000;
/**
 * How many buffered remainders bulk-load holds before flushing them into their chunk bitmaps. Bounds the
 * transient JS-side buffer to **~28 MB measured** irrespective of input size, while keeping batches large
 * enough that the per-id JS↔native crossing is amortised away.
 */
const BULK_FLUSH_IDS = 1 << 20;
/**
 * Ids between ingest-loop yields. 16x coarser than the per-chunk cadence because the per-id work is ~40 ns
 * (a `splitId` and an array push) against ~1.3 µs per chunk — matching cadences would put the yield cost on the
 * wrong side of the work it interrupts. Sized against the *slowest* ingest, an in-memory async generator at
 * ~220 ns/id, so the resulting stretch stays a few ms there and well under 1 ms on a plain array.
 */
const YIELD_EVERY_IDS = 1 << 14;

/** Default ceiling on cached segment readers (each holds a parsed `.crbm` index) — the steady-state count bound. */
const DEFAULT_MAX_OPEN_SEGMENTS = 1024;

/** Default aggregate ceiling (bytes) on resident parsed indices in the reader cache — the steady-state byte bound. */
const DEFAULT_MAX_OPEN_INDEX_BYTES = 64 * 1024 * 1024;

export class CrbmColdChunkSource implements ColdChunkSource {
  /**
   * One resolved reader per segment, re-resolved on a short TTL ({@link CrbmColdChunkSourceOptions.currentGenTtlMs},
   * needs a clock). Within the TTL a segment's Cold bytes are treated as an immutable snapshot; when the TTL
   * elapses the next read cheaply re-resolves `currentGen` and, only if it advanced (a load published),
   * opens the new generation — so a long-lived source observes new generations within the TTL rather than
   * pinning one forever. The engine pairs this with a **generation-keyed** HOT cache so a bump never
   * serves a stale decoded chunk. Without a clock or a registry the source pins the first generation for its
   * lifetime (the behaviour before the registry was wired in). A segment with no generation yet is not memoized, so it's re-checked until
   * one exists. **Bounded** by a {@link BoundedLru} ({@link CrbmColdChunkSourceOptions.maxOpenSegments}, default
   * 1024): past the ceiling the least-recently-used segment's reader (and its parsed index) is evicted — the
   * steady-state memory bound; re-opening an evicted segment is one cheap tail GET.
   */
  private readonly snapshots: BoundedLru<string, Snapshot>;
  private readonly registry: IRegistryDriver | undefined;
  private readonly keystore: IKeystore | undefined;
  private readonly requireEncryption: boolean;
  private readonly readerOptions: CrbmReaderOptions;
  private readonly clock: Pick<Clock, 'now'> | undefined;
  private readonly currentGenTtlMs: number;

  constructor(
    private readonly driver: IColdDriver,
    options: CrbmColdChunkSourceOptions = {},
  ) {
    if (!driver.capabilities().rangeRead) {
      throw new CapabilityError('Cold driver must support range reads (rangeRead)');
    }
    const {
      registry,
      keystore,
      requireEncryption,
      clock,
      currentGenTtlMs,
      maxOpenSegments,
      maxOpenIndexBytes,
      ...readerOptions
    } = options;
    if (keystore !== undefined && registry === undefined) {
      throw new CapabilityError(
        'a keystore needs a registry (that is where wrapped DEKs are stored)',
      );
    }
    if (requireEncryption === true && registry === undefined) {
      // Without a registry the source can't see wrapped DEKs or `destroyed` tombstones (it list-scans cold),
      // so encryption can't be enforced or even observed here — fail fast rather than mislead.
      throw new CapabilityError('requireEncryption needs a registry');
    }
    this.registry = registry;
    this.keystore = keystore;
    this.requireEncryption = requireEncryption ?? false;
    this.readerOptions = readerOptions;
    this.clock = clock;
    this.currentGenTtlMs = currentGenTtlMs ?? DEFAULT_CURRENT_GEN_TTL_MS;
    // Bound the reader cache by BOTH count and aggregate parsed-index bytes. No TTL on the LRU itself —
    // the currentGen TTL is handled separately via each snapshot's `installedAtMs`; these ceilings only bound how
    // many segment readers/indices stay resident. Each reader's byte weight is reported once it resolves (below).
    // The cache never compares against wall-clock, so a zero clock is fine when none is injected.
    this.snapshots = new BoundedLru<string, Snapshot>({
      maxEntries: maxOpenSegments ?? DEFAULT_MAX_OPEN_SEGMENTS,
      maxBytes: maxOpenIndexBytes ?? DEFAULT_MAX_OPEN_INDEX_BYTES,
      clock: clock ?? { now: () => 0 },
    });
  }

  /** The current resolved reader for a segment, refreshing on the TTL. Cheap within the TTL window. */
  private resolvedReader(ref: SegmentRef): Promise<CrbmReader | null> {
    const key = segmentKey(ref);
    const existing = this.snapshots.get(key);
    if (existing === undefined) return this.install(key, this.resolveLatest(ref)).reader;
    if (!this.expired(existing.installedAtMs)) return existing.reader;
    // Expired: install the in-flight refresh **synchronously** (before any await) so concurrent readers in this
    // window coalesce onto the one re-resolve — ≤ one registry read + at most one reopen per segment per window
    // (no boundary thundering-herd). computeRefreshedReader reuses the prior reader unless the generation moved.
    return this.install(key, this.computeRefreshedReader(ref, existing)).reader;
  }

  /** TTL elapsed: cheaply re-resolve `currentGen`; reopen only if it actually changed, else reuse the prior reader. */
  private async computeRefreshedReader(
    ref: SegmentRef,
    existing: Snapshot,
  ): Promise<CrbmReader | null> {
    const current = await existing.reader.catch(() => null);
    let target: Target | null | undefined;
    try {
      target = await this.resolveTarget(ref);
    } catch {
      target = undefined; // transient resolve fault
    }
    // Transient resolve fault: keep serving the prior reader if it's alive; if it's dead (null/failed open),
    // reopen rather than re-arm a dead snapshot (else the segment reads empty for a whole TTL window).
    if (target === undefined) return current ?? this.resolveLatest(ref);
    if (target === null) return null; // segment gone / destroyed
    if (current !== null && target.generation === current.generation) return current; // unchanged — reuse
    return this.openForTarget(ref, target); // advanced / appeared / prior open was dead — reopen fresh
  }

  /**
   * Memoize a reader-promise as the segment's snapshot at `now()`, forgetting it later if it resolves to
   * null / throws (identity-guarded, so a stale cleanup never clobbers a fresher snapshot). Installing the
   * (pending) promise **synchronously** is what lets concurrent callers coalesce onto one in-flight resolve.
   */
  private install(key: string, reader: Promise<CrbmReader | null>): Snapshot {
    const snap: Snapshot = { reader, installedAtMs: this.now() };
    this.snapshots.set(key, snap);
    const forgetIfStale = (): void => {
      if (this.snapshots.get(key) === snap) this.snapshots.delete(key);
    };
    reader.then((r) => {
      if (r === null) {
        forgetIfStale();
        return;
      }
      // Report the parsed index's footprint so the cache can bound aggregate resident bytes. Identity-
      // guarded via `peek` (no recency change) so a since-replaced snapshot doesn't mis-weight the fresh entry.
      if (this.snapshots.peek(key) === snap) this.snapshots.setWeight(key, r.retainedIndexBytes);
    }, forgetIfStale);
    return snap;
  }

  private now(): number {
    return this.clock ? this.clock.now() : 0;
  }

  private expired(installedAtMs: number): boolean {
    // Refresh needs a clock (the TTL) AND a registry (the *cheap* `currentGen` read the design assumes —
    // without one, re-resolution is a full cold `list`-scan, and a registry-less setup is single-process
    // local, not the shared bucket that separate loaders publish into). Otherwise: pin for the lifetime.
    return (
      this.clock !== undefined &&
      this.registry !== undefined &&
      this.currentGenTtlMs > 0 &&
      this.clock.now() - installedAtMs >= this.currentGenTtlMs
    );
  }

  /**
   * The segment's current generation number — the engine keys its HOT chunk cache by this so a generation bump
   * is observed instead of serving a stale decoded chunk. Served from the (TTL-refreshed)
   * snapshot, so no extra backend read within the TTL window. `null` if the segment has no committed generation.
   *
   * Heals a swept generation exactly like {@link withFreshSnapshot} — the engine calls this **once per op**,
   * before any chunk fetch, so an unhealed miss here fails the whole operation rather than one chunk. It is
   * spelled out rather than delegated because this is the hottest call in the library: once per operand of
   * every `has`/`count`/`iterate`/`intersect`, and almost always served from the cached snapshot with no
   * backend call at all. Routing it through the generic helper cost ~115 ns/op on that path (a second async
   * frame, a per-call closure, and an `await` on a plain number) for a race that fires only during a
   * concurrent sweep. One retry, then propagate — same contract, same eviction rule.
   */
  async currentGeneration(ref: SegmentRef): Promise<number | null> {
    const pending = this.resolvedReader(ref);
    try {
      return (await pending)?.generation ?? null;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      this.dropStale(segmentKey(ref), pending);
      return (await this.resolvedReader(ref))?.generation ?? null; // a second miss propagates
    }
  }

  /**
   * Evict a snapshot we just failed to read from — matched by its reader *promise*, so a concurrent call's
   * fresher snapshot is never clobbered. The identity guard is the whole point: `install` replaces the entry
   * wholesale, so comparing anything else would drop a good snapshot on the floor.
   */
  private dropStale(key: string, pending: Promise<CrbmReader | null>): void {
    const cur = this.snapshots.get(key);
    if (cur !== undefined && cur.reader === pending) this.snapshots.delete(key);
  }

  private async resolveLatest(ref: SegmentRef): Promise<CrbmReader | null> {
    const target = await this.resolveTarget(ref);
    if (target === null) return null;
    return this.openForTarget(ref, target);
  }

  /** Open a {@link CrbmReader} for an already-resolved generation target (decrypting if the segment is encrypted). */
  private async openForTarget(ref: SegmentRef, target: Target): Promise<CrbmReader | null> {
    const genKey: GenKey = {
      namespace: ref.namespace,
      segment: ref.segment,
      generation: target.generation,
    };
    const crypto = await this.cryptoForRead(ref, target.generation, target.wrappedDeks);
    return CrbmReader.open(coldBlobReader(this.driver, genKey), { ...this.readerOptions, crypto });
  }

  /**
   * The current generation + its DEK wrappings: the registry's authoritative record (one strong read), or a
   * `list` scan for the max generation when there's no registry (a registry-less source can only read cleartext
   * — there's nowhere a wrapped DEK could live).
   */
  private async resolveTarget(ref: SegmentRef): Promise<Target | null> {
    if (this.registry !== undefined) {
      const record = await this.registry.get(ref);
      if (record === null) return null;
      // A crypto-shredded segment reads as empty — its DEK is gone, so its Cold bytes are unrecoverable.
      if (record.status === 'destroyed') return null;
      // A row with no Cold generation yet (minted by `setSegmentRetention` ahead of the first load, so admin tools
      // can see the segment) resolves exactly like a segment with NO row: every read answers empty. Returning
      // `null` here rather than a generation is the whole reason such a row is safe to create — the alternative,
      // pointing at a generation that does not exist, is the `missing-cold-generation` state.
      if (record.currentGen === null) return null;
      return { generation: record.currentGen, wrappedDeks: record.wrappedDeks };
    }
    let maxGen = -1;
    for await (const key of this.driver.list(ref)) {
      if (key.generation > maxGen) maxGen = key.generation;
    }
    return maxGen < 0 ? null : { generation: maxGen };
  }

  /** Build the per-generation decryption context for an encrypted segment (undefined for cleartext). */
  private async cryptoForRead(
    ref: SegmentRef,
    generation: number,
    wrappedDeks: readonly WrappedDek[] | undefined,
  ): Promise<CrbmCrypto | undefined> {
    if (wrappedDeks === undefined || wrappedDeks.length === 0) {
      if (this.requireEncryption) {
        throw new KeyUnavailableError(
          `requireEncryption: segment "${ref.segment}" is cleartext but encryption is required`,
        );
      }
      return undefined; // cleartext segment
    }
    if (this.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but this CrbmColdChunkSource has no keystore`,
      );
    }
    const aead = await this.keystore.openDek(wrappedDeks);
    return { aead, aadFor: (scope) => aadFor(ref, generation, scope) };
  }

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    validateChunkRef(ref);
    return this.withFreshSnapshot(ref, (reader) => reader.getChunk(ref.chunkKey), null);
  }

  async listChunkKeys(ref: SegmentRef): Promise<number[]> {
    validateSegmentRef(ref);
    return this.withFreshSnapshot(ref, (reader) => reader.chunkKeys(), []);
  }

  async sizeOf(ref: SegmentRef): Promise<SegmentSize | null> {
    validateSegmentRef(ref);
    return this.withFreshSnapshot<SegmentSize | null>(
      ref,
      (reader) => ({ sizeBytes: reader.sizeBytes }),
      null,
    );
  }

  async cardinalities(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null> {
    validateSegmentRef(ref);
    return this.withFreshSnapshot<ReadonlyMap<number, number> | null>(
      ref,
      (reader) => reader.cardinalities(),
      null,
    );
  }

  /**
   * Run `read` against the pinned snapshot, healing the torn-read window generation GC can open: if the
   * generation we resolved was superseded *and* swept (the grace window elapsed), the Cold driver throws
   * {@link NotFoundError}. Rather than surface that as a query failure (**I5**), we drop the stale snapshot,
   * re-resolve `currentGen`, and retry once — the read then serves the newer (committed, immutable) generation,
   * a monotonic move forward.
   *
   * **Resolution and open are inside the retry, not before it.** Resolving `currentGen` and opening that
   * generation's object are two backend round trips with a gap between them, so the object can be swept after
   * the registry named it and before its tail is read — and that miss surfaces from awaiting the snapshot, not
   * from `read`. Awaiting outside the retry left the *first* attempt unhealed on the one path GC actually
   * races: `keep: 0`, which every id erasure passes, sweeps microseconds after the publish.
   *
   * A *second* NotFound is pathological (GC outrunning resolution) and propagates rather than fabricating an
   * absent answer — never return a wrong result. `ifGone` is returned when the segment has no committed
   * generation to serve: cold is empty, or the row was dropped or crypto-shredded, in which case reading empty
   * is the documented outcome rather than a failure.
   *
   * **Bounded to exactly two resolve-and-open round trips.** That is a cost contract, not a detail: the retry
   * now re-reads the *registry*, so an unbounded one would hammer the shared, throttle-prone resource in a
   * tight loop on a segment whose pointer names an object that is permanently absent — and an N-way
   * `intersect` would do it N times. Gated in `tests/core/cold-source-heal-open.test.ts` by counting calls.
   */
  private async withFreshSnapshot<T>(
    ref: SegmentRef,
    read: (reader: CrbmReader) => T | Promise<T>,
    ifGone: T,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = this.resolvedReader(ref);
      try {
        const reader = await pending;
        if (reader === null) return ifGone;
        return await read(reader);
      } catch (err) {
        // Only a vanished pinned generation is recoverable here, and only on the first try; anything else
        // (corruption, a real second miss) propagates / falls through.
        if (!isNotFoundError(err) || attempt === 1) throw err;
        this.dropStale(segmentKey(ref), pending); // lazily: the happy path never needs the key
      }
    }
    return ifGone;
  }
}

/**
 * Write one immutable generation from in-memory bitmaps (the seed / bulk-load primitive). Chunks are
 * sorted ascending and empty bitmaps skipped (empty chunks are never stored). Returns the driver's
 * `{ size, sha256 }` for the written object. Pass `options.crypto` to AES-256-GCM-encrypt the generation
 * (the caller builds it from the segment's DEK + a `(segment, generation)`-bound {@link aadFor}).
 */
export function writeCrbmGeneration(
  driver: IColdDriver,
  key: GenKey,
  chunks: Iterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  options: { crypto?: CrbmCrypto; clock?: Yielder } = {},
): Promise<{ size: number; sha256: string }> {
  const sorted = [...chunks].sort((a, b) => a.chunkKey - b.chunkKey);
  // The single longest blocking stretch in a bulk load: serialize + CRC32C + frame, once per chunk, ~62,000
  // times. `await writer.addChunk(...)` looks like it yields and does not — the sink buffers in memory, so the
  // promise is already resolved and awaiting it is a microtask. See {@link yieldEvery}.
  const tick = yieldEvery(options.clock);
  return driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, { generation: key.generation, crypto: options.crypto });
    for (const { chunkKey, bitmap } of sorted) {
      if (bitmap.isEmpty) continue;
      // Run-encode before serializing. Cold generations are immutable and read many times, so the one-off cost
      // here buys every later read a smaller fetch — see CodecBitmap.optimize for the measured factors.
      bitmap.optimize?.();
      await writer.addChunk(chunkKey, bitmap.serialize(), bitmap.size);
      const pause = tick();
      if (pause !== null) await pause;
    }
    await writer.finish();
  });
}

/** What {@link writeCrbmGenerationStream} wrote: the driver's `{ size, sha256 }` + a tally of the generation. */
export interface StreamWriteResult {
  readonly size: number;
  readonly sha256: string;
  /** Non-empty chunk keys written, in ascending order (for the post-write verify, since the stream is consumed). */
  readonly chunkKeys: number[];
  /** Total ids written. */
  readonly cardinality: number;
}

/**
 * Streaming variant of {@link writeCrbmGeneration} for a **constant-memory** rewrite (the erasure rewrite, a
 * sorted load): consumes an **already-ascending** async stream of `{ chunkKey, bitmap }`, feeding each to the
 * codec and freeing it, instead of materializing the whole generation. Paired with a streaming cold sink (S3
 * multipart / LocalFs temp file), peak memory is ~one chunk + one part. Returns a tally so the caller can verify
 * the re-opened object without re-iterating the (now-consumed) stream. Input **must** be ascending by `chunkKey`
 * — the codec rejects an out-of-order chunk; empty bitmaps are skipped.
 */
export async function writeCrbmGenerationStream(
  driver: IColdDriver,
  key: GenKey,
  chunks: AsyncIterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  options: { crypto?: CrbmCrypto; clock?: Yielder } = {},
): Promise<StreamWriteResult> {
  const chunkKeys: number[] = [];
  let cardinality = 0;
  // A rewrite runs this over a whole segment. The `for await` is not itself a yield — a stream backed by
  // already-resident chunks resolves on a microtask — so it needs the same periodic macrotask as the
  // non-streaming writer above.
  const tick = yieldEvery(options.clock);
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, { generation: key.generation, crypto: options.crypto });
    for await (const { chunkKey, bitmap } of chunks) {
      if (bitmap.isEmpty) continue;
      bitmap.optimize?.(); // same cold-write rationale as the non-streaming writer above
      await writer.addChunk(chunkKey, bitmap.serialize(), bitmap.size);
      chunkKeys.push(chunkKey);
      cardinality += bitmap.size;
      const pause = tick();
      if (pause !== null) await pause;
    }
    await writer.finish();
  });
  return { size, sha256, chunkKeys, cardinality };
}

/**
 * Point a segment's registry `currentGen` at `key.generation` — the publish step that makes a freshly-written
 * generation the authoritative latest (so registry-aware readers see it). **Forward-only and idempotent:**
 * if the registry has no row it creates one; if it's already at/ahead of `key.generation` it's a no-op (an
 * out-of-order/duplicate publish never regresses the pointer); otherwise it advances via compare-and-swap,
 * retrying a few times under contention. Separated from the Cold write so callers can publish atomically
 * after the immutable object is durable (write-then-publish).
 *
 * **Throws** rather than returning, in two cases, because each would otherwise create a state no reader can
 * recover from: a `destroyed` (crypto-shredded) row, where advancing the pointer would name an object encrypted
 * under a shredded key; and an advance carrying **new** `wrappedDeks`, which would either strand that key or make
 * the row advertise encryption over cleartext generations. Contention that never clears throws
 * {@link WriteConflictError} after the retries.
 *
 * **`expectFrom` turns forward-only into read-modify-write.** Forward-only is the right rule for a writer whose
 * content does not depend on what was current — a load computes its ids upstream, so publishing over a newer
 * generation loses nothing the loader knew about. It is the WRONG rule for a writer that *derived* its content
 * from a particular generation: the erasure rewrite streams generation `from` and clears one bit, so publishing
 * it over a newer generation silently discards whatever that generation added. Passing `expectFrom` makes the
 * publish land only while the pointer is still exactly there, and return `false` otherwise, so the caller can
 * report `superseded` and re-derive. The compare-and-swap itself carries the token read in the same iteration,
 * so the check and the write see the same row.
 */
export async function publishGeneration(
  registry: IRegistryDriver,
  key: GenKey,
  options: { wrappedDeks?: readonly WrappedDek[]; expectFrom?: number } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const record = await registry.get(key);
    try {
      if (options.expectFrom !== undefined && record?.currentGen !== options.expectFrom) {
        // The pointer is no longer where the caller derived its content from — including the cases where the row
        // has vanished or has no generation at all. Not an error: the caller re-reads and re-derives.
        return false;
      }
      if (record === null) {
        // First publish for the segment — carry the wrapped DEK(s) so encrypted reads can resolve the key.
        await registry.create(key, {
          currentGen: key.generation,
          wrappedDeks: options.wrappedDeks,
        });
      } else if (record.status === 'destroyed') {
        // Closes the window between a writer's own destroyed-check and its publish.
        //
        // `bulkLoadCrbmGeneration` reads the registry record once, refuses if it is already destroyed, and then
        // spends a KMS call plus a whole object write before getting here — seconds to minutes on a large load.
        // A `destroySegment` landing inside that window used to be invisible to this function: it compares only
        // `currentGen`, so it would advance the pointer on a destroyed record, leaving an object encrypted with
        // the DEK that destroy had just shredded — permanently unreadable, still paid for, and attached to a
        // segment the registry says was erased.
        //
        // Checking here rather than at the caller is what makes it a fence instead of a second guess: this
        // record was re-read moments ago inside the retry loop, so the check and the CAS that follows it see the
        // same state. `erasure.ts` notes that coupling the write path to destruction was left as "a later
        // hardening" — for the publish step, this is it.
        throw new ValidationError(
          `segment "${key.segment}" was destroyed (crypto-shredded) while generation ${key.generation} was ` +
            `being written — refusing to publish it; the written object is unreadable. Use a new segment.`,
        );
      } else if (record.currentGen === null) {
        // The row exists with no Cold generation yet (a retention policy recorded ahead of the first load). There
        // is no pointer to regress past, so this publish advances it — and carries the wrapped
        // DEK(s) exactly like a first publish onto no row, since no generation is encrypted under the row's
        // current wrappings (there is no generation at all).
        //
        // `wrappedDeks` is spread in ONLY when there is something to store. A registry patch clears an optional
        // field by *mentioning* it (`'wrappedDeks' in patch`), so passing `wrappedDeks: undefined` unconditionally
        // would wipe key material off the row whenever a cleartext generation is published onto it — a divergence
        // from the branch below, which never touches the field.
        await registry.compareAndSwap(key, record.token, {
          currentGen: key.generation,
          ...(options.wrappedDeks === undefined ? {} : { wrappedDeks: options.wrappedDeks }),
        });
      } else if (record.currentGen > key.generation) {
        return false; // a newer generation is already current — forward-only, never regress
      } else if (record.currentGen === key.generation) {
        return true; // already exactly current (an idempotent re-publish) — nothing to advance
      } else {
        // Advancing over an existing generation. `wrappedDeks` is deliberately NOT carried here, and a caller
        // that supplies it is refused rather than served.
        //
        // Reaching this branch with a freshly minted DEK means an encrypted generation is being published onto a
        // lineage whose current generation the row already describes — i.e. onto a segment whose existing
        // generations are cleartext. Both ways of resolving that silently are damaging: dropping the wrapping
        // (what this branch used to do) advances the pointer to an object encrypted under a key that exists
        // nowhere, so the data is unrecoverable the moment the call returns; carrying it makes the row advertise
        // encryption over a lineage that still holds readable cleartext objects, which is what makes
        // `destroySegment` emit `segment.erase` — "unreadable everywhere, backups included" — over plaintext.
        // Two independent reviews reproduced the first one from two different entry points (a re-load with a
        // keystore newly wired, and an `*Into` on a keystore-wired store whose destination was cleartext), and
        // it needed no race. So the state is refused before the pointer moves; the object stays an orphan.
        if (options.wrappedDeks !== undefined && options.wrappedDeks.length > 0) {
          throw new ValidationError(
            `publishGeneration: refusing to publish generation ${key.generation} of "${key.segment}" with new ` +
              `key material onto a segment that already has generation ${record.currentGen} — its existing ` +
              `generations are not encrypted under this key. Encrypt a new segment and load into that instead.`,
          );
        }
        await registry.compareAndSwap(key, record.token, { currentGen: key.generation });
      }
      return true; // created or advanced the pointer to key.generation → it is now current
    } catch (err) {
      if (isWriteConflictError(err)) continue; // lost the race — re-read and retry
      throw err;
    }
  }
  // Exhausted: only possible if competing writers kept advancing currentGen — which likely already satisfies
  // the forward-only goal. Confirm before reporting failure, so a lost-every-race-but-already-current case
  // isn't a spurious error. Whether *this* generation is the current one decides the returned flag.
  const final = await registry.get(key);
  // `currentGen === null` after exhausting the retries is a genuine failure, not an already-current case: nothing
  // is published, so it falls through to the conflict below rather than being read as "a newer gen won".
  if (final !== null && final.currentGen !== null && final.currentGen >= key.generation)
    return final.currentGen === key.generation;
  throw new WriteConflictError(
    `publishGeneration: contention setting currentGen for ${key.segment}`,
  );
}

/** What a bulk-load wrote — the driver's `{ size, sha256 }` plus a summary of the built generation. */
export interface BulkLoadResult {
  /** Bytes written to the Cold object. */
  readonly size: number;
  /** The driver's content hash of the object. */
  readonly sha256: string;
  /** Distinct non-empty chunks written (≤ 65536). */
  readonly chunkCount: number;
  /** Total distinct ids in the generation (post-dedup). */
  readonly cardinality: number;
  /**
   * Whether this generation is now the segment's **current** one — `undefined` when no `registry` was wired, so
   * there is no pointer and no publish step to report on.
   *
   * `false` means the object is durable but a **concurrent writer published a higher generation first**, so this
   * one is an orphan that no reader will ever resolve. The write succeeded and the *load* did not: whatever this
   * call was asked to make the segment contain, the segment does not contain. That is not a detail a caller can
   * be left to infer — a `*Into` materialisation used to report the generation it wrote as "the destination's
   * new current generation" on exactly this path, which is a plain untruth — so the flag is on the result and the
   * verbs that promise a published generation check it.
   */
  readonly becameCurrent?: boolean;
}

/**
 * **Bulk-load** a whole immutable generation from a flat id source — the batch "seed/rebuild" entry point.
 * Unlike {@link writeCrbmGeneration} (which takes pre-grouped bitmaps), this
 * consumes an arbitrary, **unsorted** stream of u32 ids (sync or async) and routes each into its chunk's
 * Roaring bitmap as it goes. The input is consumed lazily and ids dedup on insert, so memory is bounded by
 * the **built generation** — the in-memory Roaring representation of the *distinct* set (≤ one bitmap per
 * non-empty chunk) — not by the input length: you can stream a billion duplicate-heavy ids and hold only the
 * distinct result. Note this is `O(distinct set)`, **not** window-bounded like {@link SegmentEngine.intersect}:
 * bulk-load holds the whole generation in RAM, which suits batch seed/rebuild jobs but not an
 * unbounded-cardinality stream (a segment larger than RAM needs external-merge / pre-sorted input — later phase).
 *
 * Each id must be an integer in `[0, 2³²)` ({@link splitId} throws {@link ValidationError} otherwise) — the
 * source is consumed lazily, so a bad id aborts mid-stream without writing a partial object (the driver
 * commits only after the callback resolves). An empty source writes a valid empty generation.
 *
 * Writes a fresh full snapshot of a segment. The caller picks the generation number in `key` — `nextGeneration`
 * computes the right one from the registry and the bucket — and re-using an existing generation throws
 * {@link WriteConflictError} (write-once). Without a registry a `ColdChunkSource` serves the **highest**
 * generation present, so a too-high number silently shadows real data; with one, `publishGeneration` decides.
 */
export async function bulkLoadCrbmGeneration(
  driver: IColdDriver,
  key: GenKey,
  ids: Iterable<number> | AsyncIterable<number>,
  options: {
    registry?: IRegistryDriver;
    keystore?: IKeystore;
    requireEncryption?: boolean;
    audit?: IAuditSink;
    /** Bitmap codec. Optional in the type; a **flavor** package binds it ({@link requireCodec}). */
    codec?: CodecInterface;
    /**
     * Injected clock. Supplying one makes bulk-load **cooperative**: it yields the event loop periodically so a
     * long load does not stall everything else on the process. Without it the load still completes, just
     * without yielding — which is the pre-existing behaviour, kept so this is purely additive.
     *
     * `@cloudbitmaps/roaring` supplies a real clock by default, so flavor users get cooperative behaviour with
     * no wiring. `core/` cannot default it: it is timer-free by lint, which is exactly why waiting goes through
     * this seam rather than `setTimeout`.
     */
    clock?: Clock;
  } = {},
): Promise<BulkLoadResult> {
  if (options.keystore === undefined && options.requireEncryption === true) {
    throw new ValidationError('requireEncryption: bulk-load needs a keystore to write encrypted');
  }
  const codec = requireCodec(options.codec, 'bulkLoadCrbmGeneration');
  const byChunk = new Map<number, CodecBitmap>();
  // Batched per chunk, not one native `add()` per id.
  //
  // The obvious loop — `bitmap.add(remainder)` for every id — crosses the JS↔native boundary once per id, and
  // measured **1,679 ms for 1M ids** with no yield point anywhere in it. Since this is a synchronous stretch on
  // Node's only thread, a caller who wires it to a request handler stalls every other request on that instance
  // for over a second (measured separately: a 0.7 ms health check took 275 ms).
  //
  // Buffering the remainders and inserting them per chunk in one `fromValues`/`addMany` call amortises that
  // boundary crossing across the whole batch.
  //
  // WHY THE BUFFER IS CAPPED. Bucketing *everything* first and inserting once per chunk at the end is faster
  // still, but it holds every remainder as a JS number before any bitmap compression happens — and with up to
  // 65,536 chunks in play that is unbounded in exactly the way this library refuses to be. So the buffer is
  // flushed whenever the total pending count crosses `BULK_FLUSH_IDS`, bounding the extra memory regardless of
  // input size or key distribution while still getting the batching win. That bound is **~28 MB measured** at
  // 1M staged ids across ~65,000 chunks — not the ~8 MB a naive 8-bytes-per-number estimate gives, because the
  // cost is dominated by per-array and Map overhead across tens of thousands of small arrays.
  const pendingByChunk = new Map<number, number[]>();
  let pending = 0;
  // Yield periodically, NOT per chunk — see {@link yieldEvery} for why per-unit async is a 7x regression here.
  const tickChunk = yieldEvery(options.clock);
  const tickId = yieldEvery(options.clock, YIELD_EVERY_IDS);
  // Yield every N chunks, NOT per chunk. Measured: handing each chunk's insert to the threadpool
  // (`fromArrayAsync`) costs ~9 µs of dispatch against ~1.5 µs of actual work once ids are spread across
  // ~61,000 chunks — 636 ms versus 92 ms, a 7x regression that would have undone the per-chunk batching this
  // function already does. Keeping the inserts synchronous and interrupting them periodically gets the
  // starvation fix without the cost — measured on the per-chunk insert microbenchmark: 88 ms wall against a
  // 92 ms unyielded baseline. The whole-load end-to-end figures are a DIFFERENT experiment and live in
  // `cooperative.ts`; an earlier version of this comment spliced the two, pairing a 92 ms operation with
  // 819 ms of starvation, which is impossible on its face.
  //
  // The yield must be a REAL macrotask. `await Promise.resolve()` is a microtask and never lets I/O run, which
  // is the trap that makes naive "just await something" fixes measure as no change at all.
  const flushPending = async (): Promise<void> => {
    for (const [chunkKey, rems] of pendingByChunk) {
      if (rems.length === 0) continue;
      const existingBitmap = byChunk.get(chunkKey);
      if (existingBitmap === undefined) byChunk.set(chunkKey, codec.fromValues(rems));
      else existingBitmap.addMany(rems);
      rems.length = 0;
      const pause = tickChunk();
      if (pause !== null) await pause;
    }
    pending = 0;
  };
  /** Bucket one id. Returns true when the pending buffer is full and must be flushed. */
  const ingest = (id: number): boolean => {
    const { chunkKey, remainder } = splitId(id); // validates the u32 range
    let bucket = pendingByChunk.get(chunkKey);
    if (bucket === undefined) {
      bucket = [];
      pendingByChunk.set(chunkKey, bucket);
    }
    bucket.push(remainder);
    return ++pending >= BULK_FLUSH_IDS;
  };
  // The two ingest loops are deliberately NOT collapsed into one `for await` over a normalising wrapper.
  //
  // That is the tidier code and it was measured at **20x** the cost: routing a sync source through an async
  // generator forces a microtask per id, and over 1M ids that is 224 ms against 11 ms for a plain `for..of` —
  // 55% of a whole bulk load spent on iteration protocol rather than on work. Since an array, a Set and a
  // generator are what callers actually hand this function most of the time, the sync path is the common one.
  //
  // Note that `for await` yields nothing to the event loop either way: a microtask per id still drains before
  // the loop turns a phase. Both paths therefore need the same explicit yield.
  if (Symbol.asyncIterator in ids) {
    for await (const id of ids as AsyncIterable<number>) {
      if (ingest(id)) await flushPending();
      const pause = tickId();
      if (pause !== null) await pause;
    }
  } else {
    for (const id of ids as Iterable<number>) {
      if (ingest(id)) await flushPending();
      const pause = tickId();
      if (pause !== null) await pause;
    }
  }
  await flushPending();

  let cardinality = 0;
  const chunks: Array<{ chunkKey: number; bitmap: CodecBitmap }> = [];
  for (const [chunkKey, bitmap] of byChunk) {
    // Every chunk in the map received at least one id, so no bitmap here is empty.
    cardinality += bitmap.size; // a native call per chunk — 5 ms across 62,000 of them, so it yields too
    chunks.push({ chunkKey, bitmap });
    const pause = tickChunk();
    if (pause !== null) await pause;
  }

  if (options.keystore !== undefined && options.registry === undefined) {
    throw new ValidationError('bulk-load encryption requires a registry to store the wrapped DEK');
  }
  // Read the segment's record once (when a registry is wired): to refuse writing to a crypto-shredded segment
  // (which would create unreadable/unreachable bytes), and to reuse its DEK if it's encrypted.
  const existing = options.registry !== undefined ? await options.registry.get(key) : null;
  if (existing?.status === 'destroyed') {
    throw new ValidationError(
      `segment "${key.segment}" is destroyed (crypto-shredded) — refusing to write; use a new segment`,
    );
  }

  // An encrypted row with no keystore is a lost key, not a cleartext segment — the same fail-fast the erasure
  // rewrite does. Without it this wrote a CLEARTEXT generation onto a row that still advertises `wrappedDeks`, and the
  // damage is not just a confusing state: `destroySegment` keys `cryptoShredded` off the *presence* of wrappings,
  // so shredding that segment emits `segment.erase` — the audit event defined as "these bytes are unreadable
  // everywhere, backups included" — over bytes that are plaintext and stay readable from any copy. An audit trail
  // that over-attests is the one failure it exists to prevent, so this refuses to create the state.
  if (
    existing?.wrappedDeks !== undefined &&
    existing.wrappedDeks.length > 0 &&
    options.keystore === undefined
  ) {
    throw new KeyUnavailableError(
      `segment "${key.segment}" is encrypted but this bulk-load has no keystore — refusing to write a cleartext ` +
        `generation onto an encrypted segment. Pass the keystore holding its DEK.`,
    );
  }

  // Encryption (opt-in): reuse the segment's existing DEK, or mint a fresh one on its FIRST generation.
  //
  // The segment's own posture decides, not the presence of a keystore. A keystore is wired on the store, so it is
  // in scope for every segment that store touches — including ones deliberately left cleartext — and minting on
  // that basis alone is what made "load it again with a keystore wired" destroy the data: the minted wrapping has
  // nowhere to live on a row whose pointer is already set (see `publishGeneration`'s advance branch), so the
  // generation ends up encrypted under a key that exists in no persistent store. `requireEncryption` is the way
  // to *demand* encryption, and on an already-cleartext lineage it fails fast rather than silently downgrading.
  let crypto: CrbmCrypto | undefined;
  let newWrapped: readonly WrappedDek[] | undefined;
  if (options.keystore !== undefined) {
    if (existing?.wrappedDeks !== undefined && existing.wrappedDeks.length > 0) {
      const aead = await options.keystore.openDek(existing.wrappedDeks); // reuse the segment's DEK
      crypto = { aead, aadFor: (scope) => aadFor(key, key.generation, scope) };
    } else if (existing !== null && existing.currentGen !== null) {
      // An existing lineage with no key material on the row: the segment is cleartext, and one segment cannot be
      // half-encrypted — a reader pinned to a superseded generation would find bytes its key cannot open, and a
      // later `destroySegment` would attest that shredding one DEK made every copy unreadable while the older
      // cleartext objects stay readable from any of them.
      if (options.requireEncryption === true) {
        throw new ValidationError(
          `requireEncryption: segment "${key.segment}" already has generation ${existing.currentGen} in ` +
            `cleartext, so this load cannot be encrypted — encryption is chosen when a segment is first ` +
            `loaded. Load into a new segment with the keystore wired, then drop this one.`,
        );
      }
      // Otherwise the segment stays what it is: cleartext.
    } else {
      const minted = await options.keystore.createDek();
      newWrapped = minted.wrapped;
      crypto = { aead: minted.aead, aadFor: (scope) => aadFor(key, key.generation, scope) };
    }
  }

  const { size, sha256 } = await writeCrbmGeneration(driver, key, chunks, {
    crypto,
    clock: options.clock,
  });
  // Publish only after the immutable object is durable (write-then-publish): a registry-aware reader should
  // never point at a generation that isn't fully written. A freshly minted DEK is stored on this publish.
  if (options.registry !== undefined) {
    const becameCurrent = await publishGeneration(options.registry, key, {
      wrappedDeks: newWrapped,
    });
    // Audit the publish only when this generation actually *became* the current one — not when a
    // forward-only publish no-oped because a newer generation was already current (the event's contract is
    // "became the segment's current generation"). Needs a registry to have a "current generation" at all.
    if (becameCurrent) {
      safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
        kind: 'segment.publish',
        namespace: key.namespace,
        segment: key.segment,
        generation: key.generation,
      });
    }
    return { size, sha256, chunkCount: chunks.length, cardinality, becameCurrent };
  }
  return { size, sha256, chunkCount: chunks.length, cardinality };
}

/**
 * Open a {@link CrbmReader} on one generation over the cold driver's range/tail reads (decrypting if `crypto`).
 * The reader the write paths use to re-read what they wrote, and the erasure rewrite uses to stream the old
 * generation; the engine's read path goes through {@link CrbmColdChunkSource} instead, which caches these.
 */
export function openGenerationReader(
  cold: IColdDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
  options: Omit<CrbmReaderOptions, 'crypto'> = {},
): Promise<CrbmReader> {
  return CrbmReader.open(coldBlobReader(cold, key), { ...options, crypto });
}

/**
 * Re-open a freshly written generation and assert it round-trips exactly what was streamed into it: the same
 * per-chunk key set *and* the same total cardinality (on top of the codec's own per-chunk CRC + footer checks).
 * `expected` is the streaming writer's tally (the stream is consumed, so it can't be re-iterated) — the key-set
 * comparison catches a dropped/extra chunk that a cardinality-only check could miss when two errors cancel out.
 * Throws {@link IntegrityError}: the object is on disk but must not be published.
 */
export async function verifyGeneration(
  cold: IColdDriver,
  key: GenKey,
  expected: { readonly chunkKeys: readonly number[]; readonly cardinality: number },
  crypto: CrbmCrypto | undefined,
): Promise<void> {
  const expectedKeys = [...expected.chunkKeys].sort((a, b) => a - b);
  const reader = await openGenerationReader(cold, key, crypto);
  const actualKeys = [...reader.chunkKeys()].sort((a, b) => a - b);
  const keysMatch =
    actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]);
  if (!keysMatch) {
    throw new IntegrityError(
      `verify failed for ${key.segment}.${key.generation}: chunk-key set mismatch (${actualKeys.length} vs ${expectedKeys.length})`,
    );
  }
  if (reader.count() !== expected.cardinality) {
    throw new IntegrityError(
      `verify failed for ${key.segment}.${key.generation}: cardinality ${reader.count()} != ${expected.cardinality}`,
    );
  }
}
