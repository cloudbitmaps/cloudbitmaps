/**
 * Bridges the `.crbm` archive format to the engine's Storage seam.
 *
 * `CrbmStorageChunkSource` implements the {@link StorageChunkSource} the engine reads through, over an
 * {@link IStorageDriver}: it resolves a segment's current generation, opens its {@link CrbmReader} once, and serves
 * per-chunk payloads. `writeCrbmGeneration` / `writeCrbmGenerationStream` are the write primitives (a generation
 * built from bitmaps, in memory or streamed), `bulkLoadCrbmGeneration` is the loader `load()` is built on, and
 * `publishGeneration` is the forward-only pointer advance every write ends with.
 */
import {
  DEFAULT_CURRENT_GEN_TTL_MS,
  DEFAULT_MAX_OPEN_INDEX_BYTES,
  DEFAULT_MAX_OPEN_SEGMENTS,
  REFRESH_RETRY_MS,
} from './reader-defaults';
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import {
  IntegrityError,
  CapabilityError,
  KeyUnavailableError,
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isIntegrityError,
  isNotFoundError,
  isTransientError,
  isValidationError,
  isWriteConflictError,
} from './errors';
import type { BlobReader } from './blob';
import { yieldEvery } from './cooperative';
import type { Yielder } from './cooperative';
import type { Clock, Rng } from './determinism';
import { sameIncarnation } from './token';
import { BoundedLru } from './lru';
import { splitId } from './bit-route';
import { segmentKey } from './keys';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore, WrappedDek } from './crypto';
import { validateChunkRef, validateUserRef } from './validate';
import type {
  ChunkRef,
  StorageChunkSource,
  GenerationMetadata,
  GenerationSummary,
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
  SegmentSize,
  Token,
} from './ports';
import { DEFAULT_TAIL_BYTES } from './crbm/format';
import { CrbmReader, fingerprintFor, footerSaysEncrypted } from './crbm/reader';
import type { CrbmReaderOptions } from './crbm/reader';
import { CrbmWriter } from './crbm/writer';
import type { CodecBitmap, CodecInterface, EncodedChunk } from './codec';
import { requireCodec } from './codec';
import { DecodedLoadInput } from './load-input';
import { summaryAgrees, summaryOf, usableSummary } from './summary';
import type { GenerationDescription } from './summary';

export interface CrbmStorageChunkSourceOptions extends CrbmReaderOptions {
  /**
   * Optional {@link IRegistryDriver}. When provided, the current generation is resolved via the registry's
   * authoritative `currentGen` (one cheap strong read) instead of a `list` scan of every generation — the
   * retirement of that scan. When absent, the source falls back to the `list`-scan (so the
   * in-memory / simple setups keep working with no registry). The resolved generation is cached and
   * **re-resolved on a short TTL** ({@link currentGenTtlMs}, needs a {@link clock}) so a long-lived source
   * observes another process's load within the TTL, not only when something else happens to re-resolve it.
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
   * ambient time. Refresh needs **both** a clock and a `registry`. Without either there is no timed refresh, and
   * that is the only difference: a segment is still re-resolved when its reader is evicted, when a fetch finds its
   * generation swept, and on {@link CrbmStorageChunkSource.invalidate}. What goes is the bound on how long another
   * process's publish takes to arrive. The `CloudRoaring` facade passes its clock automatically, so wiring a
   * `registry` is enough to get the bounded refresh.
   */
  readonly clock?: Pick<Clock, 'now'>;
  /**
   * How long (ms) a resolved `currentGen` is trusted before the next read re-resolves it (default 2000) — the
   * bound on read staleness after a load publishes: a reader may serve the prior generation for up to this long,
   * then converges. Lazy (checked on read — no timer); ≤ one cheap registry read per segment per window, and a
   * new {@link CrbmReader} is opened only when the generation actually changed. `0` turns the refresh off, as a
   * missing clock or registry does: {@link clock} says what that changes, and what it does not.
   */
  readonly currentGenTtlMs?: number;
  /**
   * Hard ceiling on how many segments' readers (each holding a fully-parsed `.crbm` index) are cached at once
   * (default 1024) — a memory bound for a long-running server. Past it, the least-recently-used
   * segment's reader is evicted; the next read of an evicted segment re-opens it (one cheap tail GET, since
   * generations are immutable). Raise it for a big cache working set of small segments.
   */
  readonly maxOpenSegments?: number;
  /**
   * Aggregate byte ceiling on the parsed `.crbm` indices resident in the reader cache (default 64 MiB) — the
   * **second half of that memory bound**. `maxOpenSegments` alone bounds by *count*, but a wide/dense segment's
   * parsed index can reach about 1.3 MB, so 1024 wide indices could pin over a GB and blow a small heap (e.g. a 128 MB
   * Lambda) while the count is nominally "in bounds". This caps the summed {@link CrbmReader.retainedBytes} (the
   * parsed index, and any metadata a generation carries) across cached readers; the least-recently-used reader is evicted once the total would exceed it — whichever
   * of the count/byte bounds binds first. Lower it for memory-tight deployments with wide segments; a single
   * segment whose index alone exceeds the budget is still cached (it can't be shrunk) but nothing else alongside.
   */
  readonly maxOpenIndexBytes?: number;
}

/** Adapt one `(driver, key)` pair to the codec's `BlobReader` seam. */
function storageBlobReader(driver: IStorageDriver, key: GenKey): BlobReader {
  return {
    getRange(offset, length) {
      return driver.getRange(key, offset, length);
    },
    getTail(maxBytes) {
      return driver.getTail(key, maxBytes);
    },
  };
}

/**
 * A resolved read target, as `resolveLive` produces it: which generation is current, and its DEK wrappings if it
 * is encrypted. `lineage` is the registry row's OCC token — the identity that survives a delete, because a shipped
 * registry never gives two writes under one name the same token, but for a collision of probability 2^-128 per pair of
 * incarnations: each row's token carries a random 128-bit incarnation id, and each write a random part of its own. It is what separates two *incarnations*
 * of one name, which a generation number cannot:
 * the numbering restarts at 0 once the row is purged and the bucket emptied, so a retired-and-re-created
 * segment presents different data at the same `currentGen`. Undefined for a registry-less source, which has no
 * row: there, only the object itself tells two incarnations apart, by the fingerprint a pin records.
 */
type Target = { generation: number; lineage?: Token; wrappedDeks?: readonly WrappedDek[] };

/**
 * What a pin holds of the object it pinned: the version its cache entries are keyed by, and the object's
 * fingerprint, which a pinned read checks each time it opens the generation. `pinGeneration` always records one.
 * A pin built by hand without one is not checked: it reads whatever object is under its generation's key.
 */
export interface PinnedObject {
  readonly version: string;
  readonly fingerprint?: string;
}

/** A pinned read of a generation that is no longer the object the pin opened: stated as a fact, not a cause. */
const notThePinned = (ref: SegmentRef, generation: number): NotFoundError =>
  new NotFoundError(
    `segment "${ref.segment}" generation ${generation} is no longer the object this handle pinned`,
  );

/**
 * The version of one generation of one incarnation: `<generation>`, or `<generation>:<row token>` where there is
 * a row. One spelling, for the live lookup and for what a pin holds.
 */
function versionOf(generation: number, lineage: unknown): string {
  return lineage === undefined ? String(generation) : `${generation}:${String(lineage)}`;
}

/**
 * What one resolution of a segment's pointer found: the target, and what its row says of the generation, each
 * computed only when asked for. The key is unwrapped once however many ask, and a failure is not remembered, so a
 * transient fault in the keystore is asked again.
 */
interface Live {
  readonly target: Target;
  /** The generation's decryption context (`undefined` for a cleartext segment); applies `requireEncryption`. */
  readonly crypto: () => Promise<CrbmCrypto | undefined>;
  /** The segment's unwrapped key, shared with the next resolution while the row's wrapped keys are the same. */
  readonly unwrap: (() => Promise<Aead>) | undefined;
  /** What the row's summary says of the generation, when the row's summary is usable for it. */
  readonly summary: () => Promise<GenerationDescription | undefined>;
  /** What the resolution weighs while no reader is open: the row's summary. */
  readonly bytes: number;
}

/** A summary in the shape the port returns: `metadata` left off when there is none. */
function summaryOfGeneration(
  generation: number,
  description: GenerationDescription,
): GenerationSummary {
  const { cardinality, metadata } = description;
  // A copy, frozen: the row's own object stays what the cross-check compares against whatever a caller does.
  return metadata === undefined || Object.keys(metadata).length === 0
    ? { generation, cardinality }
    : { generation, cardinality, metadata: Object.freeze({ ...metadata }) };
}

/** Whether two rows carry the same wrapped keys. */
const sameKeys = (a: readonly WrappedDek[] | undefined, b: readonly WrappedDek[]): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** A thunk that runs `fn` once, and runs it again after a failure. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending === undefined) {
      const mine = fn();
      pending = mine;
      mine.catch(() => {
        if (pending === mine) pending = undefined;
      });
    }
    return pending;
  };
}

/** Whether a reader is of the generation, and the row incarnation, a resolution found. */
const readerIsOf = (reader: CrbmReader, live: Live): boolean =>
  reader.generation === live.target.generation && reader.lineage === live.target.lineage;

/** What a generation's object says of itself, which is what a summary is held against: its count and metadata. */
function describe(reader: CrbmReader): GenerationDescription {
  let cardinality = 0;
  for (const n of reader.cardinalities().values()) cardinality += n;
  return { cardinality, metadata: reader.metadata };
}

/**
 * A memoized per-segment snapshot plus the time it was installed, for the current-generation TTL refresh. A live
 * snapshot is a resolved target, and a reader that is opened only when a read needs one: one resolution serves a
 * `count` answered from the row and a `has` that follows it, which reads the generation the count saw. A pinned
 * snapshot is its reader alone.
 */
class Snapshot {
  /** When the snapshot's refresh clock started. A refresh that failed transiently moves it back, so it lapses sooner. */
  installedAtMs = 0;
  /** Set by the cache, to hear of a reader as it is opened. */
  onReader: ((reader: Promise<CrbmReader | null>) => void) | undefined;
  private opened: Promise<CrbmReader | null> | undefined;

  private constructor(
    /** What the pointer resolved to; absent on a pinned snapshot. */
    readonly target: Promise<Live | null> | undefined,
    private readonly open: ((live: Live) => Promise<CrbmReader>) | undefined,
    /** The reader of the snapshot this one refreshes, kept if the refresh finds the same generation. */
    private prior: Promise<CrbmReader | null> | undefined,
  ) {}

  static live(
    target: Promise<Live | null>,
    open: (live: Live) => Promise<CrbmReader>,
    prior?: Promise<CrbmReader | null>,
  ): Snapshot {
    return new Snapshot(target, open, prior);
  }

  static eager(reader: Promise<CrbmReader | null>): Snapshot {
    const snap = new Snapshot(undefined, undefined, undefined);
    snap.opened = reader;
    return snap;
  }

  /** The reader, opened by the first call. */
  get reader(): Promise<CrbmReader | null> {
    if (this.opened === undefined) {
      const target = this.target as Promise<Live | null>;
      this.opened = target.then(async (live) => {
        if (live === null) return null;
        const kept = await this.reuse(live);
        this.prior = undefined;
        return kept ?? (this.open as (live: Live) => Promise<CrbmReader>)(live);
      });
      this.onReader?.(this.opened);
    }
    return this.opened;
  }

  /** The reader if one has been asked for, without asking for one. */
  get openedReader(): Promise<CrbmReader | null> | undefined {
    return this.opened;
  }

  /** The prior snapshot's reader, if it is of what this snapshot resolved. */
  async reuse(live: Live): Promise<CrbmReader | null> {
    const prior = this.prior;
    const reader = prior === undefined ? null : await prior.catch(() => null);
    return reader !== null && readerIsOf(reader, live) ? reader : null;
  }

  /** Keep the prior snapshot's reader when the refresh found its generation, so a count does not drop it. */
  async adopt(live: Live): Promise<void> {
    if (this.opened !== undefined || this.prior === undefined) return;
    const reader = await this.reuse(live);
    this.prior = undefined;
    if (reader !== null && this.opened === undefined) {
      this.opened = Promise.resolve(reader);
      this.onReader?.(this.opened);
    }
  }
}

/**
 * How many buffered remainders bulk-load holds before flushing them into their chunk bitmaps. Bounds the
 * transient JS-side buffer to **~28 MB measured** irrespective of input size, while keeping batches large
 * enough that the per-id JS↔native crossing is amortised away.
 */
const SNAPSHOT_BASE_BYTES = 256;
const BULK_FLUSH_IDS = 1 << 20;
/**
 * Ids between ingest-loop yields. 16x coarser than the per-chunk cadence because the per-id work is ~40 ns
 * (a `splitId` and an array push) against ~1.3 µs per chunk — matching cadences would put the yield cost on the
 * wrong side of the work it interrupts. Sized against the *slowest* ingest, an in-memory async generator at
 * ~220 ns/id, so the resulting stretch stays a few ms there and well under 1 ms on a plain array.
 */
const YIELD_EVERY_IDS = 1 << 14;

export class CrbmStorageChunkSource implements StorageChunkSource {
  /**
   * One resolved reader per segment, re-resolved on a short TTL ({@link CrbmStorageChunkSourceOptions.currentGenTtlMs},
   * needs a clock). Within the TTL a segment's Storage bytes are treated as an immutable snapshot; when the TTL
   * elapses the next read cheaply re-resolves `currentGen` and, only if it advanced (a load published),
   * opens the new generation — so a long-lived source observes new generations within the TTL. The engine pairs
   * this with a **generation-keyed** cache so a bump never serves a stale decoded chunk. Without a clock or a
   * registry there is no timed refresh, and a segment's reader is replaced only when it is evicted, when a read
   * has to fetch from a generation a sweep deleted, or when {@link invalidate} drops it. A segment with no generation yet is not memoized, so
   * it's re-checked until one exists. **Bounded** by a {@link BoundedLru} ({@link CrbmStorageChunkSourceOptions.maxOpenSegments}, default
   * 1024): past the ceiling the least-recently-used segment's reader (and its parsed index) is evicted — the
   * steady-state memory bound; re-opening an evicted segment is one cheap tail GET.
   */
  private readonly snapshots: BoundedLru<string, Snapshot>;
  /**
   * Pins ({@link heldKey}) whose object has been found replaced: another object is under its generation's key. Kept,
   * and bounded as the readers are, so that a pin's later chunk reads and any reopen fail at once rather than pay for
   * the check again. A replacement can be undone, by a restore that puts the pinned object back, so
   * {@link invalidate} forgets the segment's, and a pin of the same version that opens the object forgets the one
   * against it. An object found gone is not kept: that is the open's own `NotFoundError`, and a 404 can pass. A
   * reader still memoised keeps answering from the index it holds, so the pin's `count()` does, until a later pin of
   * that version opens the object now under the key, which takes its place.
   */
  private readonly replacedPins: BoundedLru<string, true>;
  /**
   * A check of a pinned object still under way, by {@link heldKey}, so the reads that ask at once share one footer
   * read. One forgotten before it ends, by {@link invalidate} or a pin, keeps nothing it finds.
   */
  private readonly checking = new Map<string, Promise<boolean>>();
  /**
   * How many times {@link invalidate} has run, so a read that waited can tell whether the store was told something
   * meanwhile. An eviction from the reader cache is not an invalidation, and what a read found stands through one. It
   * counts every segment's invalidations: a read that waited through another segment's only costs a later read the
   * check again.
   */
  private invalidations = 0;
  /**
   * Generations whose row summary this process found to disagree with their object, by segment and generation. A
   * summary here is not used again: a count of that generation reads the object. Bounded as the readers are, so a
   * long-lived process cannot grow it without limit; one that falls out is trusted again until its next open finds
   * the disagreement again.
   */
  private readonly distrusted: BoundedLru<string, true>;
  private readonly registry: IRegistryDriver | undefined;
  private readonly keystore: IKeystore | undefined;
  private readonly requireEncryption: boolean;
  private readonly readerOptions: CrbmReaderOptions;
  private readonly clock: Pick<Clock, 'now'> | undefined;
  private readonly currentGenTtlMs: number;

  constructor(
    private readonly driver: IStorageDriver,
    options: CrbmStorageChunkSourceOptions = {},
  ) {
    if (!driver.capabilities().rangeRead) {
      throw new CapabilityError('Storage driver must support range reads (rangeRead)');
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
        'a keystore needs a storage backend — that is where the wrapped DEKs live. A bare IStorageDriver has no registry to hold them',
      );
    }
    if (requireEncryption === true && registry === undefined) {
      // Without a registry the source can't see wrapped DEKs or `destroyed` tombstones (it list-scans storage),
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
    this.distrusted = new BoundedLru<string, true>({
      maxEntries: maxOpenSegments ?? DEFAULT_MAX_OPEN_SEGMENTS,
      clock: { now: () => 0 },
    });
    this.replacedPins = new BoundedLru<string, true>({
      maxEntries: maxOpenSegments ?? DEFAULT_MAX_OPEN_SEGMENTS,
      clock: { now: () => 0 },
    });
  }

  /**
   * The segment's live snapshot, refreshing on the TTL. Cheap within the TTL window. The snapshot holds the resolved
   * target, and its reader once a read has asked for one.
   */
  private liveSnapshot(ref: SegmentRef): Snapshot {
    const key = segmentKey(ref);
    const existing = this.snapshots.get(key);
    if (existing === undefined) {
      return this.install(
        key,
        Snapshot.live(this.resolveLive(ref), (live) => this.openLive(ref, live)),
      );
    }
    if (!this.expired(existing.installedAtMs)) return existing;
    // Expired: install the in-flight refresh **synchronously** (before any await) so concurrent readers in this
    // window coalesce onto the one re-resolve — ≤ one registry read + at most one reopen per segment per window
    // (no boundary thundering-herd). The refresh keeps the prior reader unless the generation moved.
    const snap: Snapshot = this.install(
      key,
      Snapshot.live(
        this.refreshedTarget(ref, existing, () => this.retrySoon(snap)),
        (live) => this.openLive(ref, live),
        existing.openedReader,
      ),
    );
    return snap;
  }

  /** The current resolved reader for a segment, refreshing on the TTL. */
  private resolvedReader(ref: SegmentRef): Promise<CrbmReader | null> {
    return this.liveSnapshot(ref).reader;
  }

  /**
   * A refresh failed transiently and the prior reader keeps serving: make this snapshot lapse after
   * {@link REFRESH_RETRY_MS} (never longer than the TTL) rather than after a whole TTL, so the next read after
   * that asks the registry again. It costs no read of its own; it only changes when the next refresh happens.
   */
  private retrySoon(snap: Snapshot): void {
    snap.installedAtMs =
      this.now() - (this.currentGenTtlMs - Math.min(this.currentGenTtlMs, REFRESH_RETRY_MS));
  }

  /**
   * TTL elapsed: cheaply re-resolve the pointer. The row read is always fresh, so what the new snapshot says of the
   * generation (its summary included) is what the row says now, never the prior snapshot's. The reader is reopened
   * only if the generation or the row changed, and only when a read asks for it.
   */
  private async refreshedTarget(
    ref: SegmentRef,
    existing: Snapshot,
    onTransientFault: () => void,
  ): Promise<Live | null> {
    const prior = await (existing.target as Promise<Live | null>).catch(() => null);
    try {
      return await this.resolveLive(ref, prior);
    } catch (err) {
      // Only a transient fault is ridden out. Anything else — an access denial, a corrupt row, a registry that
      // answers NotFound — fails this read exactly as a cold resolve of the segment would, and the snapshot is
      // forgotten, so the reader and the key it unwrapped do not outlive a refresh that could not be trusted.
      if (!isTransientError(err)) throw err;
      // Transient resolve fault: keep serving the prior snapshot if it's alive, but ask again soon rather than a
      // whole TTL later, so an outage ends the stale serving shortly after the registry answers. If it's dead (no
      // target, or a failed open), resolve again rather than re-arm a dead snapshot (else the segment reads empty for a
      // whole TTL window).
      const alive = prior !== null;
      if (!alive) return this.resolveLive(ref);
      onTransientFault();
      return prior;
    }
  }

  /**
   * Memoize a snapshot as the segment's at `now()`, forgetting it later if it resolves to null / throws
   * (identity-guarded, so a stale cleanup never clobbers a fresher snapshot). Installing the (pending) snapshot
   * **synchronously** is what lets concurrent callers coalesce onto one in-flight resolve.
   */
  private install(key: string, snap: Snapshot): Snapshot {
    snap.installedAtMs = this.now();
    this.snapshots.set(key, snap);
    const forgetIfStale = (): void => {
      if (this.snapshots.get(key) === snap) this.snapshots.delete(key);
    };
    // Report what the snapshot holds so the cache can bound aggregate resident bytes: the row's summary while only
    // the target is resolved, and the reader (its parsed index and any metadata) once one is open. Identity-guarded
    // via `peek` (no recency change) so a since-replaced snapshot doesn't mis-weight the fresh entry.
    snap.onReader = (reader) => {
      reader.then((r) => {
        if (r === null) {
          forgetIfStale();
          return;
        }
        if (this.snapshots.peek(key) === snap) this.snapshots.setWeight(key, r.retainedBytes);
      }, forgetIfStale);
    };
    if (snap.target !== undefined) {
      snap.target.then(async (live) => {
        if (live === null) {
          forgetIfStale();
          return;
        }
        if (snap.openedReader === undefined && this.snapshots.peek(key) === snap) {
          this.snapshots.setWeight(key, live.bytes);
        }
        await snap.adopt(live);
      }, forgetIfStale);
    }
    if (snap.openedReader !== undefined) snap.onReader(snap.openedReader);
    return snap;
  }

  private now(): number {
    return this.clock ? this.clock.now() : 0;
  }

  /**
   * How often this source re-reads a segment's pointer while the segment is being read, in ms: its TTL, or 0 when
   * it has no timed refresh (no clock, no registry, or a TTL of 0). The grounded cost report prices the refresh at
   * this.
   */
  get pointerRefreshMs(): number {
    return this.clock !== undefined && this.registry !== undefined ? this.currentGenTtlMs : 0;
  }

  private expired(installedAtMs: number): boolean {
    // Refresh needs a clock (the TTL) AND a registry (the *cheap* `currentGen` read the design assumes —
    // without one, re-resolution is a full storage `list`-scan, and a registry-less setup is single-process
    // local, not the shared bucket that separate loaders publish into). Otherwise there is no timed refresh, and
    // only an eviction, a sweep's heal or `invalidate` re-resolves the segment.
    return (
      this.clock !== undefined &&
      this.registry !== undefined &&
      this.currentGenTtlMs > 0 &&
      this.clock.now() - installedAtMs >= this.currentGenTtlMs
    );
  }

  /**
   * The segment's current generation number — the engine keys its chunk cache by this so a generation bump
   * is observed instead of serving a stale decoded chunk. Served from the (TTL-refreshed)
   * snapshot, so no extra backend read within the TTL window. `null` if the segment has no committed generation.
   *
   * Heals a swept generation exactly like {@link withFreshSnapshot}: a caller that resolves the generation once
   * per op, before any chunk fetch, would otherwise fail the whole operation rather than one chunk. The engine
   * keys by {@link currentVersion} instead, which heals the same way, and falls back to this for a source that
   * cannot report a version. It is spelled out rather than delegated because a lookup like this runs once per
   * operand of every `has`/`count`/`iterate`/`intersect`, almost always served from the cached snapshot with
   * no backend call at all. Routing it through the generic helper cost ~115 ns/op on that path (a second async
   * frame, a per-call closure, and an `await` on a plain number) for a race that fires only during a
   * concurrent sweep. One retry, then propagate — same contract, same eviction rule.
   */
  async currentGeneration(ref: SegmentRef): Promise<number | null> {
    const snap = this.liveSnapshot(ref);
    try {
      return (await snap.reader)?.generation ?? null;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      this.dropStale(segmentKey(ref), snap);
      return (await this.resolvedReader(ref))?.generation ?? null; // a second miss propagates
    }
  }

  /**
   * Forget everything derived from `ref`: the resolved snapshot and the open reader behind it (and with the
   * reader, the DEK it unwrapped at open time), and what its pins' objects were found to be. The next read
   * resolves the segment again.
   *
   * Needed because the TTL refresh only ever answers "has the pointer moved?", and every *destructive* verb —
   * an erasure that deletes the generation holding the bit, a `dropSegment`, a crypto-shred, a retirement —
   * leaves the pointer's answer unchanged from this source's point of view while making the snapshot wrong.
   * Until this is called the source keeps serving that snapshot with no backend read at all, so nothing on the
   * storage side can close the window; with no registry, no clock or `cache.genTtlMs: 0`, nothing bounds it at all.
   */
  invalidate(ref: SegmentRef): void {
    this.invalidations += 1;
    const key = segmentKey(ref);
    this.snapshots.delete(key);
    // …and every PINNED reader of the same segment, which is memoized under `<key>@<generation>`. Dropping
    // only the live entry left a pinned handle reading a crypto-shredded segment: the pin is exactly the
    // reader that does not re-resolve on its own, so it is the one that most needs to be told.
    const pinnedPrefix = `${key}@`;
    this.distrusted.deleteWhere((k) => k.startsWith(pinnedPrefix));
    this.snapshots.deleteWhere((k) => k.startsWith(pinnedPrefix));
    // …and what its pins' objects were found to be, and any check still finding out: an object restored under its
    // key is its pin's again, and a restore is what an operator invalidates for.
    this.replacedPins.deleteWhere((k) => k.startsWith(pinnedPrefix));
    for (const k of this.checking.keys()) if (k.startsWith(pinnedPrefix)) this.checking.delete(k);
  }

  /**
   * `<generation>` for a registry-less source, or `<generation>:<row token>` with one. The token moves on every row
   * write, so an unrelated write (a `setRetention`) costs the segment's decoded chunks once — bounded, and on an
   * admin path. Exactness in the direction that matters: with a registry, two incarnations can never share a version
   * string. Without one they can: a name purged and loaded again out of band restarts at the same bare number, and
   * a live read that reopens it after an eviction reads the new object's chunks beside the old one's cached ones. A
   * store with no registry cannot write, so that takes a change made from outside it; a pin is kept apart from it by
   * the fingerprint it records.
   *
   * This is the call the engine makes **once per operand of every read**, before any chunk fetch, to key its
   * chunk cache, so it heals a swept generation exactly as {@link currentGeneration} does: unhealed, a cold read
   * racing a publish and a `keep: 0` sweep failed the whole operation with `NotFoundError`, where the same race
   * on a chunk fetch heals. Spelled out rather than delegated for the reason `currentGeneration` gives: it is
   * almost always served from the cached snapshot with no backend call at all. One retry, then propagate.
   */
  async currentVersion(ref: SegmentRef): Promise<string | null> {
    const snap = this.liveSnapshot(ref);
    let reader: CrbmReader | null;
    try {
      reader = await snap.reader;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      this.dropStale(segmentKey(ref), snap);
      reader = await this.resolvedReader(ref); // a second miss propagates
    }
    return reader === null ? null : versionOf(reader.generation, reader.lineage);
  }

  /**
   * Resolve the segment **once** and report what a pin should hold: the generation, and the version that
   * identifies those exact bytes. `null` when the segment resolves to no generation — there is nothing to pin,
   * and a caller must treat that as "this handle reads empty", not "pinning is unsupported here".
   *
   * Heals a generation swept between the registry read and the open, as {@link currentVersion} does: a publish
   * and a `keep: 0` sweep can land in that gap, and nothing has been handed out yet, so the generation current
   * once the swept one is gone is exactly what a pin taken now should hold. One retry, then propagate.
   */
  async pinGeneration(
    ref: SegmentRef,
  ): Promise<({ generation: number } & Required<PinnedObject>) | null> {
    try {
      return await this.pinOnce(ref);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      return this.pinOnce(ref); // a second miss propagates
    }
  }

  private async pinOnce(
    ref: SegmentRef,
  ): Promise<({ generation: number } & Required<PinnedObject>) | null> {
    // Resolved FRESH, not through the snapshot memo. "The generation current right now" is the whole promise
    // of a pin, and the memo is allowed to be up to `cache.genTtlMs` behind — or, on a store with no timed refresh,
    // arbitrarily far behind. Pinning through it made a pin on such a store
    // return whatever generation the store happened to hold, however old.
    const live = await this.resolveLive(ref);
    if (live === null) return null;
    const target = live.target;
    const version = versionOf(target.generation, target.lineage);
    // Opened now, not at the first pinned read, so the pin knows which object it holds: a name purged and loaded
    // again starts again at generation 0, and only the object itself tells the two apart. With a registry the
    // version already does, since the row a name is loaded into again is a new row with a new token, so every pin of
    // this version shares one open. It is installed before it resolves, so pins taken at the same moment wait on it
    // rather than each make their own: N pins of one generation make one tail read and one key unwrap between them,
    // while the store keeps the reader. Without a registry the version is the bare generation number, which two
    // incarnations share, so every pin opens the object afresh and reads its fingerprint.
    let reader: CrbmReader | null;
    let opened = true;
    if (target.lineage === undefined) {
      reader = await this.openLive(ref, live);
      this.install(
        this.pinnedKey(ref, version, reader.fingerprint),
        Snapshot.eager(Promise.resolve(reader)),
      );
    } else {
      const epoch = this.invalidations;
      const key = this.pinnedKey(ref, version);
      let entry = this.snapshots.get(key);
      opened = entry === undefined;
      entry ??= this.install(key, Snapshot.eager(this.openLive(ref, live)));
      reader = await entry.reader;
      // A pinned read's reopen of this version, already under way, found the row gone or destroyed: the segment
      // resolves no generation now, so this pin pins nothing, as one taken a moment later would.
      if (reader === null) return null;
      const replaced = (r: CrbmReader) =>
        this.replacedPins.get(this.heldKey(ref, version, r.fingerprint)) !== undefined;
      // A memoised reader is of the object that was under the key when it was opened. One the store has since found
      // replaced is not what is there now, so this pin opens the object afresh rather than pin a replaced one, and
      // pins taken at the same moment share that one open. The replaced pin's reader goes from the memo with it, so
      // that pin's index answers, its `count()` among them, end here: what is under its key is another object now.
      const known = !opened && replaced(reader);
      // The open this pin shared can be gone by now: a replaced pin's reopen removes the reader it opened, and the
      // reader cache can evict it. With no invalidation in between, and no replacement found, that reader is still of
      // the object under the key, and this pin keeps it memoised.
      if (!known && this.invalidations === epoch && this.snapshots.peek(key) === undefined) {
        this.install(key, Snapshot.eager(Promise.resolve(reader)));
      }
      if (known) {
        const current = this.snapshots.peek(key);
        let fresh =
          current !== undefined && current !== entry
            ? current
            : this.install(key, Snapshot.eager(this.openLive(ref, live)));
        reader = await fresh.reader;
        // A reopen of this version, already under way, found the row gone or destroyed.
        if (reader === null) return null;
        // What another pin put there can be the replaced reader too, put back before its verdict was known.
        if (fresh === current && replaced(reader)) {
          fresh = this.install(key, Snapshot.eager(this.openLive(ref, live)));
          reader = await fresh.reader;
          if (reader === null) return null;
        }
        opened = fresh !== current;
      }
    }
    // Only an open this call made has read what is under the key. The object there is that one now, whatever was
    // found before: a restore puts back what a replacement took, and a verdict kept against it would fail this pin.
    if (opened) {
      const held = this.heldKey(ref, version, reader.fingerprint);
      this.replacedPins.delete(held);
      this.checking.delete(held);
    }
    return { generation: target.generation, version, fingerprint: reader.fingerprint };
  }

  /**
   * Where a pinned reader of one object is memoised. With a registry that is its version, which names the object:
   * a name purged and loaded again gets a new row, and with it a new token. Without one the version is the bare
   * generation number, which two incarnations share, so the object's fingerprint is added to tell them apart.
   */
  private pinnedKey(ref: SegmentRef, version: string, fingerprint?: string): string {
    return this.registry === undefined && fingerprint !== undefined
      ? this.heldKey(ref, version, fingerprint)
      : `${segmentKey(ref)}@${version}`;
  }

  /**
   * One pin's hold on one segment: its version, and the fingerprint of the object it pinned. A check of that object
   * is shared under it, and what the check finds is kept under it, with a registry or without one: pins of one
   * version can hold different objects, since a pin built by hand can name any, and an object replaced from outside
   * the store leaves the row, and so the version, as it was.
   */
  private heldKey(ref: SegmentRef, version: string, fingerprint: string): string {
    return `${segmentKey(ref)}@${version}#${fingerprint}`;
  }

  /**
   * A reader for one **specific** generation, memoized in the same bounded LRU as the live snapshots under a
   * generation-qualified key.
   *
   * Sharing the LRU is the point, not an implementation detail. A pinned reader held in a private field is
   * outside the memory ceiling the library advertises — measured at 10.34 MiB per live pin, 32 pins holding
   * 111.7 MiB against an 8 MiB configured bound. A pinned *generation number* has no such problem: an object is
   * immutable, so eviction is harmless, and re-opening at the same number reopens the same bytes unless the name
   * was purged and loaded again, which the pin's fingerprint then says. It also removes a memoized-rejection bug by
   * construction — `install` forgets a promise that rejects,
   * where a hand-rolled `this.reader ??= open()` cached the rejection for the life of the handle and made a pin
   * the one read path with no resilience.
   *
   * **`status` is re-checked here**, on every open rather than once at pin time. A pin taken before a
   * crypto-shred must not keep unwrapping a DEK the shred destroyed; a destroyed segment resolves no generation
   * for anyone, and a pin's read of one fails. That holds from the pin's next open: a reader already open keeps
   * the key it unwrapped until it is evicted or invalidated.
   *
   * **And the object is checked**, when the caller says which one it pinned. A generation number is not an
   * identity (invariant 1): once a name is purged and loaded again, its new segment starts again at generation 0,
   * so a pin of the old one would open the new one's object as its own, and read it beside the chunks it had
   * already cached from the old one. The row's token cannot tell them apart, since it moves on every write, a
   * publish included; the object's fingerprint can, and a pin whose object has been replaced fails, as one whose
   * generation has been swept does. The memo is keyed so that two pins of one generation number in two
   * incarnations never share a reader, with a registry or without one ({@link pinnedKey}).
   */
  private async readerAt(
    ref: SegmentRef,
    generation: number,
    version?: string,
    fingerprint?: string,
  ): Promise<CrbmReader | null> {
    const at = version ?? String(generation);
    const key = this.pinnedKey(ref, at, fingerprint);
    const epoch = this.invalidations;
    let entry = this.snapshots.get(key);
    const opening = entry === undefined;
    if (entry === undefined) {
      // An object already found replaced is not opened again: the open would pay a row read and a key unwrap for
      // an object that is not the pin's.
      if (
        fingerprint !== undefined &&
        this.replacedPins.get(this.heldKey(ref, at, fingerprint)) !== undefined
      )
        throw notThePinned(ref, generation);
      entry = this.install(key, Snapshot.eager(this.openAt(ref, generation)));
    }
    let reader: CrbmReader | null;
    try {
      reader = await entry.reader;
    } catch (err) {
      // An open can fail on an object that is not the pinned one: written under a key this store lacks, or stored in
      // the clear where encryption is required. Its footer says which, with no key and no row. One that is gone needs
      // no footer read to say so: that is this NotFoundError.
      if (fingerprint === undefined || isTransientError(err) || isNotFoundError(err)) throw err;
      await this.throwIfReplaced(ref, generation, at, fingerprint);
      throw err;
    }
    // A pin's read fails where a bare read of a generation reads nothing: a pin describes one instant, and one that
    // goes empty partway through a call, because its row was dropped or destroyed, has torn it.
    if (reader === null) {
      if (version === undefined) return null;
      throw new NotFoundError(
        `segment "${ref.segment}" generation ${generation}, which this handle pinned, can no longer be read: its ` +
          'registry row is gone or destroyed',
      );
    }
    if (fingerprint !== undefined && reader.fingerprint !== fingerprint) {
      // The verdict is kept only if nothing was invalidated while this read waited: an invalidation forgets the
      // segment's verdicts, as after a restore, and this one is from before it. An eviction from the reader cache is
      // no reason to forget it. What this read opened is the object now under the key, which is not the pin's: left
      // memoised under the pin's key, it would hold a place in the reader cache, and the key it unwrapped, for reads
      // that can only fail, so it goes whatever was invalidated.
      if (this.invalidations === epoch)
        this.replacedPins.set(this.heldKey(ref, at, fingerprint), true);
      if (opening && this.snapshots.peek(key) === entry) this.snapshots.delete(key);
      throw notThePinned(ref, generation);
    }
    return reader;
  }

  private async openAt(ref: SegmentRef, generation: number): Promise<CrbmReader | null> {
    if (this.registry === undefined) return this.openForTarget(ref, { generation });
    // One read of the row, for its status, its incarnation and its key wrappings together.
    const record = await this.registry.get(ref);
    // Re-checked at open, not captured at pin: a shred between the two must be observed. A row that has gone
    // takes its key material with it, so there is nothing left to read under any generation.
    if (record === null || record.status === 'destroyed') return null;
    return this.openForTarget(ref, {
      generation,
      lineage: record.token,
      wrappedDeks: record.wrappedDeks,
    });
  }

  /**
   * Read one chunk of a specific generation — the pinned read path. `held`, when given, is what a pin holds of the
   * object, and the read fails if the generation is now another object.
   */
  async getChunkAt(
    ref: ChunkRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<Uint8Array | null> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held?.version, held?.fingerprint);
    if (reader === null) return null;
    const fingerprint = held?.fingerprint;
    if (
      held !== undefined &&
      fingerprint !== undefined &&
      this.replacedPins.get(this.heldKey(ref, held.version, fingerprint)) !== undefined
    )
      throw notThePinned(ref, generation);
    try {
      return await reader.getChunk(ref.chunkKey);
    } catch (err) {
      // A pin's memoised reader outlives its object when the name is purged and loaded again: its index then points
      // into bytes that are not its own, so the chunk fails its checksum or, when the new object is smaller, asks
      // for a range past its end, which every driver refuses with a ValidationError. The object's footer says which
      // it was: replaced, which is a pin's NotFoundError, or not, and the error stands. Only these two errors pay
      // for the footer read. Told apart by their brands, not `instanceof`: the range error is a driver package's,
      // which may carry a copy of core of its own.
      if (held === undefined || fingerprint === undefined) throw err;
      if (!(isIntegrityError(err) || isValidationError(err))) throw err;
      await this.throwIfReplaced(ref, generation, held.version, fingerprint);
      throw err;
    }
  }

  /**
   * Throws the pin's NotFoundError if the object under `generation`'s key is no longer the one the pin holds. Its
   * footer says, read with no key and no row ({@link CrbmReader.sameObject}), so an object written under a key this
   * store lacks answers the same way, and so does one gone from its key. A replacement is kept
   * ({@link replacedPins}), and a check under way is shared by the reads that ask at once; neither "gone" nor "the
   * same" is kept, since either can change. A transient fault is rethrown, for the store's retries to see for what it
   * is. A footer that cannot be read otherwise says nothing about which object is there, so this returns, and the
   * caller's own error stands.
   */
  private async throwIfReplaced(
    ref: SegmentRef,
    generation: number,
    version: string,
    fingerprint: string,
  ): Promise<void> {
    const held = this.heldKey(ref, version, fingerprint);
    if (this.replacedPins.get(held) !== undefined) throw notThePinned(ref, generation);
    let check = this.checking.get(held);
    if (check === undefined) {
      const at: GenKey = { namespace: ref.namespace, segment: ref.segment, generation };
      // Whether this check is still the one asked for as it ends, which it then stops being. One forgotten before it
      // ends (see checking) keeps nothing it finds, and leaves in place the one asked for since.
      const ended = (): boolean =>
        this.checking.get(held) === started && this.checking.delete(held);
      // True when the object under the key is not the pin's: another one, or none.
      const started: Promise<boolean> = CrbmReader.sameObject(
        storageBlobReader(this.driver, at),
        fingerprint,
      ).then(
        (same) => {
          if (ended() && !same) this.replacedPins.set(held, true);
          return !same;
        },
        (err: unknown) => {
          ended();
          if (isNotFoundError(err)) return true;
          throw err;
        },
      );
      this.checking.set(held, started);
      check = started;
    }
    let replaced: boolean;
    try {
      replaced = await check;
    } catch (err) {
      if (isTransientError(err)) throw err;
      return;
    }
    if (replaced) throw notThePinned(ref, generation);
  }

  /** Chunk keys of a specific generation — the pinned shape read. `held` as for {@link getChunkAt}. */
  async listChunkKeysAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<number[]> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held?.version, held?.fingerprint);
    return reader === null ? [] : reader.chunkKeys();
  }

  /**
   * Per-chunk cardinalities of a specific generation — powers a pinned `count()` with no payload reads. `held` as
   * for {@link getChunkAt}.
   */
  async cardinalitiesAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<ReadonlyMap<number, number> | null> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held?.version, held?.fingerprint);
    return reader === null ? null : reader.cardinalities();
  }

  /** Grounded size of a specific generation. `held` as for {@link getChunkAt}. */
  async sizeOfAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<SegmentSize | null> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held?.version, held?.fingerprint);
    return reader === null ? null : { sizeBytes: reader.sizeBytes };
  }

  /**
   * Whether the segment is a registered name at all. With a registry that is exactly "a row exists" — including
   * a row with no generation yet (minted by `setRetention` before the first load) and a `destroyed` tombstone,
   * both of which are names somebody deliberately created. Without a registry there is no registration to
   * consult, so the honest answer is whether the bucket holds any generation of it.
   *
   * Deliberately NOT served from the snapshot memo: the memo resolves to `null` for both states this exists to
   * tell apart.
   */
  async exists(ref: SegmentRef): Promise<boolean> {
    if (this.registry !== undefined) return (await this.registry.get(ref)) !== null;
    for await (const key of this.driver.list(ref)) {
      void key;
      return true;
    }
    return false;
  }

  /**
   * Evict a snapshot we just failed to read from — matched by the snapshot itself, so a concurrent call's
   * fresher snapshot is never clobbered. The identity guard is the whole point: `install` replaces the entry
   * wholesale, so comparing anything else would drop a good snapshot on the floor.
   */
  private dropStale(key: string, snap: Snapshot): void {
    if (this.snapshots.get(key) === snap) this.snapshots.delete(key);
  }

  /** Open a {@link CrbmReader} for an already-resolved generation target (decrypting if the segment is encrypted). */
  private async openForTarget(ref: SegmentRef, target: Target): Promise<CrbmReader> {
    const crypto = await this.cryptoForRead(ref, target.generation, target.wrappedDeks);
    return this.openGeneration(ref, target, crypto);
  }

  private openGeneration(
    ref: SegmentRef,
    target: Target,
    crypto: CrbmCrypto | undefined,
  ): Promise<CrbmReader> {
    const genKey: GenKey = {
      namespace: ref.namespace,
      segment: ref.segment,
      generation: target.generation,
    };
    return openChecked(this.driver, genKey, {
      ...this.readerOptions,
      crypto,
      lineage: target.lineage,
    });
  }

  /**
   * Open the generation a resolution found, and hold the row's summary against the object while it is open anyway:
   * the same count and metadata, or the summary is not believed again in this process ({@link distrusted}). This
   * costs no request; a mismatch is not an error, since the object is the truth and this read has it.
   */
  private async openLive(ref: SegmentRef, live: Live): Promise<CrbmReader> {
    const reader = await this.openGeneration(ref, live.target, await live.crypto());
    const summary = await live.summary();
    if (summary !== undefined && !summaryAgrees(summary, describe(reader))) {
      this.distrusted.set(this.distrustKey(ref, live.target.generation, live.target.lineage), true);
    }
    return reader;
  }

  private distrustKey(ref: SegmentRef, generation: number, lineage: unknown): string {
    return `${segmentKey(ref)}@${generation}:${String(lineage)}`;
  }

  /** What the row says of the generation, unless it is a summary this process has found to disagree with its object. */
  private async trustedSummary(
    ref: SegmentRef,
    live: Live,
  ): Promise<GenerationDescription | undefined> {
    if (
      this.distrusted.peek(this.distrustKey(ref, live.target.generation, live.target.lineage)) !==
      undefined
    ) {
      return undefined;
    }
    return live.summary();
  }

  /**
   * The current generation + its DEK wrappings: the registry's authoritative record (one strong read), or a
   * `list` scan for the max generation when there's no registry (a registry-less source can only read cleartext
   * — there's nowhere a wrapped DEK could live). The row's summary rides along, to be used or not by whoever
   * asks.
   */
  private async resolveLive(ref: SegmentRef, prior?: Live | null): Promise<Live | null> {
    if (this.registry !== undefined) {
      const record = await this.registry.get(ref);
      if (record === null) return null;
      // A crypto-shredded segment reads as empty — its DEK is gone, so its Storage bytes are unrecoverable.
      if (record.status === 'destroyed') return null;
      // A row with no Storage generation yet (minted by `setSegmentRetention` ahead of the first load, so admin tools
      // can see the segment) resolves exactly like a segment with NO row: every read answers empty. Returning
      // `null` here rather than a generation is the whole reason such a row is safe to create — the alternative,
      // pointing at a generation that does not exist, is the `missing-storage-generation` state.
      if (record.currentGen === null) return null;
      const generation = record.currentGen;
      // A refresh that finds the same wrapped keys keeps the key it already unwrapped, so a count polling an encrypted
      // segment asks the keystore once, not once each `genTtlMs`. Different keys (a shred, a re-created name) unwrap afresh.
      const keys = record.wrappedDeks;
      const unwrap =
        keys === undefined || keys.length === 0 || this.keystore === undefined
          ? undefined
          : prior?.unwrap !== undefined && sameKeys(prior.target.wrappedDeks, keys)
            ? prior.unwrap
            : once(() => (this.keystore as IKeystore).openDek(keys));
      const crypto = once(() => this.cryptoForRead(ref, generation, keys, unwrap));
      return {
        target: { generation, lineage: record.token, wrappedDeks: record.wrappedDeks },
        crypto,
        unwrap,
        // The same checks as a read of the object makes (`requireEncryption`, a keystore for an encrypted row)
        // come first, then the row's summary, used only if it names this generation in the shape the keys call for.
        summary: once(async () => usableSummary(ref, record, (await crypto())?.aead)),
        bytes:
          SNAPSHOT_BASE_BYTES +
          (record.summary === undefined ? 0 : JSON.stringify(record.summary).length),
      };
    }
    let maxGen = -1;
    for await (const key of this.driver.list(ref)) {
      if (key.generation > maxGen) maxGen = key.generation;
    }
    if (maxGen < 0) return null;
    return {
      target: { generation: maxGen },
      crypto: () => Promise.resolve(undefined),
      unwrap: undefined,
      summary: () => Promise.resolve(undefined),
      bytes: SNAPSHOT_BASE_BYTES,
    };
  }

  /** Build the per-generation decryption context for an encrypted segment (undefined for cleartext). */
  private async cryptoForRead(
    ref: SegmentRef,
    generation: number,
    wrappedDeks: readonly WrappedDek[] | undefined,
    unwrap?: () => Promise<Aead>,
  ): Promise<CrbmCrypto | undefined> {
    if (wrappedDeks === undefined || wrappedDeks.length === 0) {
      if (this.requireEncryption) {
        throw new KeyUnavailableError(
          `requireEncryption: segment "${ref.segment}" is cleartext but encryption is required`,
        );
      }
      return undefined; // cleartext segment
    }
    const keystore = this.keystore;
    if (keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but this CrbmStorageChunkSource has no keystore`,
      );
    }
    const aead = await (unwrap ?? (() => keystore.openDek(wrappedDeks)))();
    return { aead, aadFor: (scope) => aadFor(ref, generation, scope) };
  }

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    validateChunkRef(ref);
    return this.withFreshSnapshot(ref, (reader) => reader.getChunk(ref.chunkKey), null);
  }

  async listChunkKeys(ref: SegmentRef): Promise<number[]> {
    validateUserRef(ref);
    return this.withFreshSnapshot(ref, (reader) => reader.chunkKeys(), []);
  }

  async sizeOf(ref: SegmentRef): Promise<SegmentSize | null> {
    validateUserRef(ref);
    return this.withFreshSnapshot<SegmentSize | null>(
      ref,
      (reader) => ({ sizeBytes: reader.sizeBytes }),
      null,
    );
  }

  async cardinalities(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null> {
    validateUserRef(ref);
    return this.withFreshSnapshot<ReadonlyMap<number, number> | null>(
      ref,
      (reader) => reader.cardinalities(),
      null,
    );
  }

  /**
   * The current generation's number, id count and metadata. The answer comes from the row the snapshot resolved when
   * it can: the row's summary of the generation it names, on an active row, in the shape the row's keys call for
   * (a sealed one is opened with the segment's key), and one this process has not found to disagree with its
   * object. That is one registry read when the snapshot is cold, none when it is warm, and no read of the object.
   * With no summary it can use (an older row, one for another generation, one that does not open), it opens the
   * generation and answers from the object. A row that names an object that is gone still answers, while a read
   * of the object throws: the number is true of the generation the row names.
   *
   * What the row says is not confirmed here: a summary edited to agree with itself by whoever can write the row is
   * believed until the next time the object is opened, which holds it against the summary.
   */
  async summary(ref: SegmentRef): Promise<GenerationSummary | null> {
    validateUserRef(ref);
    for (let attempt = 0; attempt < 2; attempt++) {
      const snap = this.liveSnapshot(ref);
      try {
        const live = await (snap.target as Promise<Live | null>);
        if (live === null) return null;
        const row = await this.trustedSummary(ref, live);
        if (row !== undefined) return summaryOfGeneration(live.target.generation, row);
        const reader = await snap.reader;
        return reader === null ? null : summaryOfGeneration(reader.generation, describe(reader));
      } catch (err) {
        // The same healing a read of the object has: a generation swept from under the snapshot is resolved again.
        if (attempt === 1) throw err;
        // A fault that is neither a miss nor corruption (a keystore's, say) is not asked about again: reading the
        // snapshot's reader here would call the keystore a second time.
        const checks = isNotFoundError(err) || isIntegrityError(err) || isValidationError(err);
        if (
          !checks ||
          (!isNotFoundError(err) && !(await this.replacedUnder(ref, snap.reader, err)))
        ) {
          throw err;
        }
        this.dropStale(segmentKey(ref), snap);
      }
    }
    return null;
  }

  /** {@link summary} of a specific generation, from the object a pin holds. `held` as for {@link getChunkAt}. */
  async summaryAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<GenerationSummary | null> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held?.version, held?.fingerprint);
    return reader === null ? null : summaryOfGeneration(reader.generation, describe(reader));
  }

  /**
   * Run `read` against the pinned snapshot, healing the torn-read window generation GC can open: if the
   * generation we resolved was superseded *and* swept (the grace window elapsed), the Storage driver throws
   * {@link NotFoundError}. Surfacing that as a query failure would turn a benign, recoverable race into a
   * caller-visible error, so instead we drop the stale snapshot,
   * re-resolve `currentGen`, and retry once — the read then serves the newer (committed, immutable) generation,
   * a monotonic move forward — within one incarnation of the row. A name that was retired and re-created is a
   * different segment and can resolve to a LOWER generation, which is why the snapshot carries the row's token
   * as its lineage rather than trusting the generation number (invariant 1).
   *
   * **Resolution and open are inside the retry, not before it.** Resolving `currentGen` and opening that
   * generation's object are two backend round trips with a gap between them, so the object can be swept after
   * the registry named it and before its tail is read — and that miss surfaces from awaiting the snapshot, not
   * from `read`. Awaiting outside the retry left the *first* attempt unhealed on the one path GC actually
   * races: `keep: 0`, which every id erasure passes, sweeps microseconds after the publish.
   *
   * A *second* NotFound is pathological (GC outrunning resolution) and propagates rather than fabricating an
   * absent answer — never return a wrong result. `ifGone` is returned when the segment has no committed
   * generation to serve: storage is empty, or the row was dropped or crypto-shredded, in which case reading empty
   * is the documented outcome rather than a failure.
   *
   * **Bounded to exactly two resolve-and-open round trips.** That is a cost contract, not a detail: the retry
   * now re-reads the *registry*, so an unbounded one would hammer the shared, throttle-prone resource in a
   * tight loop on a segment whose pointer names an object that is permanently absent — and an N-way
   * `intersect` would do it N times. Gated in `tests/core/storage-source-heal-open.test.ts` by counting calls.
   */
  private async withFreshSnapshot<T>(
    ref: SegmentRef,
    read: (reader: CrbmReader) => T | Promise<T>,
    ifGone: T,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const snap = this.liveSnapshot(ref);
      const pending = snap.reader;
      try {
        const reader = await pending;
        if (reader === null) return ifGone;
        return await read(reader);
      } catch (err) {
        // Two misses are recoverable here, and only on the first try: a generation swept from under the snapshot,
        // and one whose object was replaced under the same number (see `replacedUnder`). Anything else
        // (corruption, a real second miss) propagates.
        if (attempt === 1) throw err;
        if (!isNotFoundError(err) && !(await this.replacedUnder(ref, pending, err))) throw err;
        this.dropStale(segmentKey(ref), snap); // lazily: the happy path never needs the key
      }
    }
    return ifGone;
  }

  /**
   * Whether `err`, raised by a read through the snapshot's reader, came from an object that is no longer the one the
   * reader opened. A generation number can be taken again once its object is deleted (an erasure removes the
   * generations above a rolled-back pointer that held the id, a collection pass can stop part-way, and a load then
   * numbers `currentGen + 1` again), so a reader that still holds the old object's index reads the new object's
   * bytes at the old offsets: a chunk checksum fails, or a range runs past the end. The object's footer says which it
   * was, as it does for a pin ({@link CrbmReader.sameObject}): replaced, or gone, re-resolves; the same object means
   * the error is real, and it stands. Only these two errors pay for the footer read, never a read that succeeded. A
   * transient fault in the check is rethrown; a footer that cannot be read says nothing, and the error stands.
   */
  private async replacedUnder(
    ref: SegmentRef,
    pending: Promise<CrbmReader | null>,
    err: unknown,
  ): Promise<boolean> {
    if (!(isIntegrityError(err) || isValidationError(err))) return false;
    let reader: CrbmReader | null;
    try {
      reader = await pending;
    } catch {
      return false;
    }
    if (reader === null) return false;
    const at: GenKey = {
      namespace: ref.namespace,
      segment: ref.segment,
      generation: reader.generation,
    };
    try {
      return !(await CrbmReader.sameObject(storageBlobReader(this.driver, at), reader.fingerprint));
    } catch (checkErr) {
      if (isNotFoundError(checkErr)) return true;
      if (isTransientError(checkErr)) throw checkErr;
      return false;
    }
  }
}

/**
 * Write one immutable generation from in-memory bitmaps. Chunks are
 * sorted ascending and empty bitmaps skipped (empty chunks are never stored). Returns the driver's
 * `{ size, sha256 }` for the written object. Pass `options.crypto` to AES-256-GCM-encrypt the generation
 * (built from the segment's DEK, with associated data bound to `(segment, generation)`).
 */
export async function writeCrbmGeneration(
  driver: IStorageDriver,
  key: GenKey,
  chunks: Iterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  options: { crypto?: CrbmCrypto; clock?: Yielder; metadata?: GenerationMetadata } = {},
): Promise<{ size: number; sha256: string; fingerprint: string }> {
  const sorted = [...chunks].sort((a, b) => a.chunkKey - b.chunkKey);
  const { size, sha256, fingerprint } = await writeEncodedChunks(
    driver,
    key,
    encodeEach(sorted),
    options,
  );
  return { size, sha256, fingerprint };
}

/** Each non-empty bitmap as the chunk it stores, in the order given. */
function* encodeEach(
  chunks: Iterable<{ chunkKey: number; bitmap: CodecBitmap }>,
): Generator<EncodedChunk> {
  for (const { chunkKey, bitmap } of chunks) {
    if (bitmap.isEmpty) continue;
    // Run-encode before serializing. Storage generations are immutable and read many times, so the one-off cost
    // here buys every later read a smaller fetch — see CodecBitmap.optimize for the measured factors.
    bitmap.optimize?.();
    yield { chunkKey, payload: bitmap.serialize(), cardinality: bitmap.size };
  }
}

/**
 * Write one immutable generation from chunks already encoded, which must ascend by key (the writer refuses one
 * that does not). Returns the driver's `{ size, sha256 }` and a tally of what was written.
 */
async function writeEncodedChunks(
  driver: IStorageDriver,
  key: GenKey,
  chunks: Iterable<EncodedChunk>,
  options: { crypto?: CrbmCrypto; clock?: Yielder; metadata?: GenerationMetadata },
): Promise<{
  size: number;
  sha256: string;
  chunkCount: number;
  cardinality: number;
  fingerprint: string;
}> {
  // The single longest blocking stretch in a bulk load: serialize + CRC32C + frame, once per chunk, ~62,000
  // times. `await writer.addChunk(...)` looks like it yields and does not — the sink buffers in memory, so the
  // promise is already resolved and awaiting it is a microtask. See {@link yieldEvery}.
  const tick = yieldEvery(options.clock);
  let chunkCount = 0;
  let cardinality = 0;
  let identity: { readonly size: number; readonly footerCrc: number } | undefined;
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, {
      generation: key.generation,
      crypto: options.crypto,
      metadata: options.metadata,
    });
    for (const chunk of chunks) {
      await writer.addChunk(chunk.chunkKey, chunk.payload, chunk.cardinality);
      chunkCount++;
      cardinality += chunk.cardinality;
      const pause = tick();
      if (pause !== null) await pause;
    }
    await writer.finish();
    identity = writer.identity;
  });
  if (identity === undefined) {
    throw new IntegrityError(
      `the driver committed ${key.segment}.${key.generation} without writing it`,
    );
  }
  // The fingerprint of what this call wrote, which tells it from an object stored later under the same key.
  return {
    size,
    sha256,
    chunkCount,
    cardinality,
    fingerprint: fingerprintFor(identity.size, identity.footerCrc),
  };
}

/**
 * Whether the object under `key` is provably the one `fingerprint` names ({@link CrbmReader.fingerprint}), from one
 * read of its footer. False when it is another object, when it is gone, and when the read fails in any way: a caller
 * that deletes on `true` deletes nothing it cannot prove is its own.
 */
export async function holdsObject(
  storage: IStorageDriver,
  key: GenKey,
  fingerprint: string,
): Promise<boolean> {
  try {
    return await CrbmReader.sameObject(storageBlobReader(storage, key), fingerprint);
  } catch {
    return false;
  }
}

/** Whether the object under `key` says it is encrypted, from one read of its footer, with no key. */
export function objectIsEncrypted(storage: IStorageDriver, key: GenKey): Promise<boolean> {
  return footerSaysEncrypted(storageBlobReader(storage, key));
}

/**
 * `blob`, with its first tail read remembered: a later tail read of no more bytes is answered from it, so a caller that
 * asks the footer a question and then opens the object makes one request, not two.
 */
function rememberingTail(blob: BlobReader): BlobReader {
  let first: { bytes: Uint8Array; size: number } | undefined;
  return {
    getRange: (offset, length) => blob.getRange(offset, length),
    async getTail(maxBytes) {
      // Answered from the first read when it holds the bytes asked for, or holds the whole object, which is all there is.
      if (
        first !== undefined &&
        (maxBytes <= first.bytes.length || first.bytes.length === first.size)
      ) {
        const take = Math.min(maxBytes, first.bytes.length);
        return { bytes: first.bytes.subarray(first.bytes.length - take), size: first.size };
      }
      const read = await blob.getTail(maxBytes);
      first ??= read;
      return read;
    },
  };
}

/**
 * What one tail read of the object under `key` tells a rollback about it: whether the footer says it is encrypted, and,
 * when the object and the key agree (an encrypted object opened with `crypto`, a cleartext one with none), the reader
 * the open gives, which holds its count and metadata. No reader when they disagree, which the caller refuses as a
 * target the row cannot use, and none for an encrypted object when the caller has no key. A footer that fails its own
 * checks, an object another generation's, and an index or metadata that do not open are an {@link IntegrityError}.
 */
export async function openRollbackTarget(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
): Promise<{ encrypted: boolean; reader: CrbmReader | undefined }> {
  const blob = rememberingTail(storageBlobReader(storage, key));
  await blob.getTail(DEFAULT_TAIL_BYTES);
  const encrypted = await footerSaysEncrypted(blob);
  if (encrypted !== (crypto !== undefined)) return { encrypted, reader: undefined };
  const reader = await CrbmReader.open(blob, { crypto });
  if (reader.generation !== key.generation) {
    throw new IntegrityError(
      `segment "${key.segment}" generation ${key.generation}: its footer says generation ${reader.generation}`,
    );
  }
  return { encrypted, reader };
}

/** What {@link writeCrbmGenerationStream} wrote: the driver's `{ size, sha256 }` + a tally of the generation. */
export interface StreamWriteResult {
  readonly size: number;
  readonly sha256: string;
  /** Non-empty chunk keys written, in ascending order (for the post-write verify, since the stream is consumed). */
  readonly chunkKeys: number[];
  /** Total ids written. */
  readonly cardinality: number;
  /** The fingerprint of what this call wrote ({@link CrbmReader.fingerprint}), which tells it from another object under its key. */
  readonly fingerprint: string;
}

/**
 * Streaming variant of {@link writeCrbmGeneration} for a **constant-memory** rewrite (the erasure rewrite, a
 * sorted load): consumes an **already-ascending** async stream of `{ chunkKey, bitmap }`, feeding each to the
 * codec and freeing it, instead of materializing the whole generation. Paired with a streaming storage sink (S3
 * multipart / LocalFs temp file), peak memory is ~one chunk + one part. Returns a tally so the caller can verify
 * the re-opened object without re-iterating the (now-consumed) stream. Input **must** be ascending by `chunkKey`
 * — the codec rejects an out-of-order chunk; empty bitmaps are skipped.
 */
export async function writeCrbmGenerationStream(
  driver: IStorageDriver,
  key: GenKey,
  chunks: AsyncIterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  options: { crypto?: CrbmCrypto; clock?: Yielder; metadata?: GenerationMetadata } = {},
): Promise<StreamWriteResult> {
  const chunkKeys: number[] = [];
  let cardinality = 0;
  // A rewrite runs this over a whole segment. The `for await` is not itself a yield — a stream backed by
  // already-resident chunks resolves on a microtask — so it needs the same periodic macrotask as the
  // non-streaming writer above.
  const tick = yieldEvery(options.clock);
  let identity: { readonly size: number; readonly footerCrc: number } | undefined;
  const { size, sha256 } = await driver.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, {
      generation: key.generation,
      crypto: options.crypto,
      metadata: options.metadata,
    });
    for await (const { chunkKey, bitmap } of chunks) {
      if (bitmap.isEmpty) continue;
      bitmap.optimize?.(); // same storage-write rationale as the non-streaming writer above
      await writer.addChunk(chunkKey, bitmap.serialize(), bitmap.size);
      chunkKeys.push(chunkKey);
      cardinality += bitmap.size;
      const pause = tick();
      if (pause !== null) await pause;
    }
    await writer.finish();
    identity = writer.identity;
  });
  if (identity === undefined) {
    throw new IntegrityError(
      `the driver committed ${key.segment}.${key.generation} without writing it`,
    );
  }
  return {
    size,
    sha256,
    chunkKeys,
    cardinality,
    fingerprint: fingerprintFor(identity.size, identity.footerCrc),
  };
}

/**
 * Refuses, with {@link KeyUnavailableError}, to point a row that carries key material at a generation written in
 * cleartext. The writer decided its key from the row it read before the write; another writer that created the
 * segment encrypted meanwhile leaves this one holding a cleartext object that no reader of the segment can open.
 */
function refuseCleartextOntoKey(
  key: GenKey,
  record: RegistryRecord,
  cleartext: boolean | undefined,
): void {
  if (cleartext !== true || record.wrappedDeks === undefined || record.wrappedDeks.length === 0) {
    return;
  }
  throw new KeyUnavailableError(
    `segment "${key.segment}" is encrypted, and generation ${key.generation} was written in cleartext: another ` +
      `writer created the segment with a key while this one was writing. Nothing was published. Re-run the ` +
      `write with the keystore that holds the segment's key.`,
  );
}

/**
 * How many times a publish sends a fresh compare-and-swap after one that ended without an answer and left the row as it
 * was: four sends of the row write in all.
 */
const UNANSWERED_RESENDS = 3;
/** The wait before the first of those, in ms, as an upper bound: each next one doubles it, and a full jitter spreads it. */
const UNANSWERED_RESEND_BASE_MS = 500;

/**
 * Point a segment's registry `currentGen` at `key.generation` — the publish step that makes a freshly-written
 * generation the authoritative latest (so registry-aware readers see it). **Forward-only and idempotent:**
 * if the registry has no row it creates one; if it's already at/ahead of `key.generation` it's a no-op (an
 * out-of-order/duplicate publish never regresses the pointer); otherwise it advances via compare-and-swap,
 * retrying a few times under contention. Separated from the Storage write so callers can publish atomically
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
 *
 * **`expectToken` fences the LINEAGE, and a derived writer needs both.** A generation number identifies a
 * generation only within one incarnation of a name: the numbering restarts at `0` once the row is purged and
 * the bucket empty, so a name that is retired and re-created has a *different* segment wearing the *same*
 * `currentGen`. `expectFrom` alone matched it — and an erasure rewrite then published one incarnation's content
 * over another's, deleted the live objects with its `keep: 0` collection, and returned `erased: true`. The row's
 * OCC token is the identity that survives this: a shipped registry's later `create` gets a token never issued before
 * under that name, but for a collision of probability 2^-128 per pair of incarnations, so no token is reused across them.
 *
 * Pass the token read alongside `expectFrom` and the publish lands only on the same row it was derived from.
 * The check is deliberately **conservative**: the token also changes on writes that are not supersessions at
 * all (a `setRetention`, a due-index reindex), so such a write makes a derived publish report `superseded` and
 * the caller re-derive. That costs a re-run on a rare, unrelated write; the alternative costs a segment.
 *
 * **The driver sends a registry write once, and an unanswered one is reconciled by its effect.** A `create` or
 * `compareAndSwap` that fails with {@link TransientError} (a throttle, a lost response, a timeout) may or may not
 * have landed, and may still be in flight. The publish reads the row once more and decides from what it holds:
 *
 * - the pointer names `key.generation`, on the incarnation the write was made against (the row's `createdAt`), and
 *   `holdsOwnObject` proves the object under it the caller's: the write landed, and the publish returns `true`. Only
 *   the writer of a write-once object publishes its number, and a number is never taken while an object holds it;
 * - the row is still the one the write was made against (the same token, or still no row): the write may land yet. The
 *   publish then waits, on the injected clock, and sends a **new** write from the row it just read: a request of its
 *   own, not a replay of the driver's, carrying the same version, so under the registry's fence at most one of the two
 *   lands and the other meets a conflict, which the next read settles. At most {@link UNANSWERED_RESENDS} follow, after
 *   a wait under 500 ms, then 1 s, then 2 s (full jitter when an `rng` is given); each is settled the same way. Still
 *   unanswered, or with no clock to wait on, this throws the registry's own `TransientError` and writes nothing more.
 *   A caller must not delete its object on it;
 * - anything else: the row has moved past the state the write was conditioned on, so that write can never land, and
 *   the publish goes on as after a lost race, from the row it just read. A pointer at `key.generation` that is not over
 *   the caller's own object, or is on another incarnation, is a lost race too and answers `false`, never an already
 *   current re-publish.
 *
 * A failed read throws `TransientError` too. The same check of the pointer runs after a {@link WriteConflictError},
 * so a write that landed and then met itself (a registry whose client re-sent it) is not taken for a lost race.
 *
 * **A `summary` goes in the same write that moves the pointer**, so a reader that sees this generation as current
 * sees the count and metadata that describe it, and every attempt sends the same one. It must be the shape the row's
 * keys call for: sealed for an object written with a key, clear for one written without.
 */
export async function publishGeneration(
  registry: IRegistryDriver,
  key: GenKey,
  options: {
    wrappedDeks?: readonly WrappedDek[];
    expectFrom?: number;
    expectToken?: Token;
    /**
     * Publish only while the segment still has **no registry row**.
     *
     * The fence for a caller whose decision rests on the row being ABSENT. `expectFrom` and `expectToken`
     * cannot express it: both compare against a value read from a row, so when there was no row there is
     * nothing to compare and both are simply omitted — leaving the publish a bare forward-only advance that
     * happily lands over whatever appeared in the meantime.
     *
     * That gap was a silent wipe, not a theoretical one. A guarded load into a segment that did not exist yet
     * read "no row", so its empty/`minRetained` bounds had nothing to judge and passed vacuously; a
     * concurrent writer then created the row and published a thousand ids; and the guarded load published an
     * EMPTY generation over them, reporting `published: true` with no reason. Reproduced through both
     * `loadSegment` and the `*Into` verbs, which hit it far more often because materialising into a
     * destination that does not exist yet is the ordinary first run of a pipeline.
     */
    expectAbsent?: boolean;
    /**
     * The generation's summary (see {@link RegistrySummary}), written by the write that moves the pointer to it. It
     * names `key.generation`. Absent, the row is left with none for this generation.
     */
    summary?: RegistrySummary;
    /**
     * The segment's row as the caller already read it (`null`: it found none). The first attempt acts on it
     * instead of reading the row again, which is sound because that attempt writes only under the row's own
     * fence: its compare-and-swap carries this row's token, and with no row it creates create-only, so a row
     * that changed or appeared since makes the write lose and the next attempt reads the row afresh. Only the
     * idempotent "already current" answer writes nothing, so a reused row never gives it.
     */
    row?: RegistryRecord | null;
    /**
     * The object was written without encryption. Its publish is refused, with {@link KeyUnavailableError}, onto a row
     * that carries key material: a reader of that segment opens every generation with its key, and a later
     * `destroySegment` would attest that shredding it made a readable object unreadable. A caller decides its key
     * from the row it read before the write, so this closes the window in which another writer creates the
     * segment encrypted meanwhile.
     */
    cleartext?: boolean;
    /**
     * Whether the object under `key` is the one the caller wrote, and throws when it cannot tell. Asked only when a
     * registry write failed and the row then names `key.generation`, to tell this publish's write from another
     * writer's at the same number. Every caller that writes the object passes it. Without it, a write that ended
     * without an answer over a row that names `key.generation` cannot be settled: the publish throws
     * {@link TransientError} and the caller keeps its object.
     */
    holdsOwnObject?: () => Promise<boolean>;
    /**
     * What a publish waits on before it sends a fresh compare-and-swap, after a write that ended without an answer and
     * left the row as it was. Without a `sleep`, such a write throws at once instead of being sent again.
     */
    clock?: Yielder;
    /** Spreads that wait (full jitter) so concurrent publishers do not retry together. Without it the wait is the bound. */
    rng?: Rng;
    /**
     * Called once for each registry write that ended without an answer, before the row is read back. A caller whose
     * publish then answers `false` can say that it cannot tell whether its own write landed first: the row may have
     * held its generation for a while before another writer moved on.
     */
    onUnanswered?: () => void;
  } = {},
): Promise<boolean> {
  // A row read after a write that failed, which the next attempt acts on instead of reading it again.
  let fresh: RegistryRecord | null | undefined;
  // The row a failed write was made against. The next attempt first checks its row for that write's effect.
  let failedOn: RegistryRecord | null | undefined;
  // The error of the last attempt, while it ended without an answer over an unchanged row; and how many fresh writes
  // such answers have bought so far.
  let unanswered: TransientError | undefined;
  let resends = 0;
  // Whether any write of this call ended without an answer: what the pointer then says about this number is not
  // taken for the caller's own write without the proof.
  let sawUnanswered = false;
  // The row the last attempt acted on, which its write was made against: where the incarnation is read from when the
  // attempts run out.
  let lastRecord: RegistryRecord | null | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const reused = attempt === 0 && options.row !== undefined;
    const record =
      fresh !== undefined ? fresh : reused ? (options.row ?? null) : await registry.get(key);
    fresh = undefined;
    unanswered = undefined;
    lastRecord = record;
    if (failedOn !== undefined) {
      let landed: boolean;
      try {
        landed = await landedHere(record, failedOn, key, options.holdsOwnObject);
      } catch (proofErr) {
        throw outcomeUnknown(key, proofErr);
      }
      if (landed) return true;
      // The pointer names this number, but not over this publish's write: another writer's object under it, or
      // another incarnation of the name. That is not an already-current re-publish, which the branch below would
      // answer `true`: nothing this call wrote is published.
      if (record !== null && record.status === 'active' && record.currentGen === key.generation) {
        return false;
      }
      failedOn = undefined;
    }
    try {
      if (options.expectFrom !== undefined && record?.currentGen !== options.expectFrom) {
        // The pointer is no longer where the caller derived its content from — including the cases where the row
        // has vanished or has no generation at all. Not an error: the caller re-reads and re-derives.
        return false;
      }
      if (options.expectAbsent === true && record !== null) {
        // A row appeared since the caller looked. Whatever it decided from "this segment does not exist" no
        // longer holds — most importantly "there is nothing here to overwrite".
        return false;
      }
      if (options.expectToken !== undefined && record?.token !== options.expectToken) {
        // Same pointer VALUE, different row. Either the row was written since (harmless, and we re-derive
        // anyway) or the name was retired and re-created, in which case `currentGen` matching means nothing:
        // it is a different segment that restarted its generation counter at the same number.
        return false;
      }
      if (
        record === null &&
        options.summary !== undefined &&
        'sealed' in options.summary &&
        options.wrappedDeks === undefined
      ) {
        // An object sealed under a key that a row held when the object was written (it carries no new key of its own),
        // with no row now: a row made from nothing would hold no key to open it with. A row passed in is the one the
        // caller read before it wrote, which another writer may have created since, so this reads again. A row still
        // absent then is a purged one, and the object cannot be published.
        if (reused) continue;
        return false;
      }
      if (record === null) {
        // First publish for the segment — carry the wrapped DEK(s) so encrypted reads can resolve the key.
        await registry.create(key, {
          currentGen: key.generation,
          wrappedDeks: options.wrappedDeks,
          ...(options.summary === undefined ? {} : { summary: options.summary }),
        });
      } else if (record.status === 'destroyed') {
        // Closes the window between a writer's own destroyed-check and its publish.
        //
        // `bulkLoadCrbmGeneration` reads the registry record once, refuses if it is already destroyed, and then
        // spends a KMS call plus a whole object write before getting here — seconds to minutes on a large load.
        // A check of `currentGen` alone cannot see a `destroySegment` landing inside that window: it would
        // advance the pointer on a destroyed record, leaving an object encrypted with the DEK that destroy had
        // just shredded — permanently unreadable, still paid for, and attached to a segment the registry says
        // was erased.
        //
        // Checking here rather than at the caller is what makes it a fence instead of a second guess: this
        // record was re-read moments ago inside the retry loop, so the check and the CAS that follows it see the
        // same state. This is the publish step's half of coupling the write path to destruction.
        throw new ValidationError(
          `segment "${key.segment}" was destroyed (crypto-shredded) while generation ${key.generation} was ` +
            `being written — refusing to publish it; the written object is unreadable. Use a new segment.`,
        );
      } else if (record.currentGen === null) {
        // The row exists with no Storage generation yet (a retention policy recorded ahead of the first load). There
        // is no pointer to regress past, so this publish advances it — and carries the wrapped
        // DEK(s) exactly like a first publish onto no row, since no generation is encrypted under the row's
        // current wrappings (there is no generation at all).
        //
        // `wrappedDeks` is spread in ONLY when there is something to store. A registry patch clears an optional
        // field by *mentioning* it (`'wrappedDeks' in patch`), so passing `wrappedDeks: undefined` unconditionally
        // would wipe key material off the row whenever a cleartext generation is published onto it — a divergence
        // from the branch below, which never touches the field.
        refuseCleartextOntoKey(key, record, options.cleartext);
        await registry.compareAndSwap(key, record.token, {
          currentGen: key.generation,
          ...(options.wrappedDeks === undefined ? {} : { wrappedDeks: options.wrappedDeks }),
          ...(options.summary === undefined ? {} : { summary: options.summary }),
        });
      } else if (record.currentGen > key.generation) {
        return false; // a newer generation is already current — forward-only, never regress
      } else if (record.currentGen === key.generation) {
        if (reused) continue; // only a fresh read can show the pointer already there
        return true; // already exactly current (an idempotent re-publish) — nothing to advance
      } else {
        // Advancing over an existing generation. `wrappedDeks` is deliberately NOT carried here, and a caller
        // that supplies it is refused rather than served.
        //
        // Reaching this branch with a freshly minted DEK means an encrypted generation is being published onto a
        // lineage whose current generation the row already describes — i.e. onto a segment whose existing
        // generations are cleartext. Both ways of resolving that silently are damaging: dropping the wrapping
        // advances the pointer to an object encrypted under a key that exists
        // nowhere, so the data is unrecoverable the moment the call returns; carrying it makes the row advertise
        // encryption over a lineage that still holds readable cleartext objects, which is what makes
        // `destroySegment` emit `segment.erase` — "unreadable everywhere, backups included" — over plaintext.
        // Two entry points reach it with no race: a re-load with a keystore newly wired, and an `*Into` on a
        // keystore-wired store whose destination is cleartext. So the state is refused before the pointer moves;
        // the object stays an orphan.
        if (options.wrappedDeks !== undefined && options.wrappedDeks.length > 0) {
          throw new ValidationError(
            `publishGeneration: refusing to publish generation ${key.generation} of "${key.segment}" with new ` +
              `key material onto a segment that already has generation ${record.currentGen}: its generations ` +
              `are not encrypted under this key, and nothing was published. If another writer published to the ` +
              `segment while this one was writing, re-run the write, which then uses the segment's own key; ` +
              `if the segment's generations are cleartext, encrypt a new segment and load into that instead.`,
          );
        }
        refuseCleartextOntoKey(key, record, options.cleartext);
        await registry.compareAndSwap(key, record.token, {
          currentGen: key.generation,
          ...(options.summary === undefined ? {} : { summary: options.summary }),
        });
      }
      return true; // created or advanced the pointer to key.generation → it is now current
    } catch (err) {
      if (isWriteConflictError(err)) {
        failedOn = record; // lost the race, or met its own landed write: the next read says which
        continue;
      }
      // Only the write itself raises a transient fault in here, and it is the one outcome that is not an answer.
      if (!isTransientError(err)) throw err;
      options.onUnanswered?.();
      sawUnanswered = true;
      let now: RegistryRecord | null;
      try {
        now = await registry.get(key);
      } catch (readErr) {
        // A row that is not one the library wrote says more than a throttle does, and the next call would raise it
        // anyway. It is not a refusal either, so the caller keeps its object. Any other fault leaves the outcome unknown.
        if (isIntegrityError(readErr)) throw readErr;
        throw outcomeUnknown(key, err);
      }
      if (sameRow(now, record)) {
        // The write did not land, or is still on its way. Send a new one from the row just read, a bounded number of
        // times; the registry's fence lets at most one of the two copies land.
        const sleep = options.clock?.sleep;
        if (sleep === undefined || resends >= UNANSWERED_RESENDS) throw outcomeUnknown(key, err);
        const bound = UNANSWERED_RESEND_BASE_MS * 2 ** resends;
        resends += 1;
        await sleep.call(options.clock, Math.floor((options.rng?.next() ?? 1) * bound));
        unanswered = outcomeUnknown(key, err);
        fresh = now;
        continue;
      }
      failedOn = record;
      fresh = now;
    }
  }
  // Exhausted: only possible if competing writers kept advancing currentGen — which likely already satisfies
  // the forward-only goal. Confirm before reporting failure, so a lost-every-race-but-already-current case
  // isn't a spurious error. Whether *this* generation is the current one decides the returned flag.
  const final = await registry.get(key);
  // `currentGen === null` after exhausting the retries is a genuine failure, not an already-current case: nothing
  // is published, so it falls through to the conflict below rather than being read as "a newer gen won".
  if (final !== null && final.currentGen !== null && final.currentGen >= key.generation) {
    if (final.currentGen !== key.generation) return false;
    if (!sawUnanswered) return true;
    // A write that went unanswered may have landed during the last wait, or the number may be another writer's, or
    // another incarnation's: the incarnation and the object under it decide, as after any unanswered write.
    try {
      return await landedHere(final, lastRecord ?? null, key, options.holdsOwnObject);
    } catch (proofErr) {
      throw outcomeUnknown(key, proofErr);
    }
  }
  // The attempts ran out on writes that went unanswered, not on contention: say so.
  if (unanswered !== undefined) throw unanswered;
  throw new WriteConflictError(
    `publishGeneration: contention setting currentGen for ${key.segment}`,
  );
}

/**
 * Whether `now` shows the effect of a publish's write that was made against `before`: an active row, on the same
 * incarnation (a `create` has none to compare), whose pointer names `key.generation`, over the caller's own object.
 *
 * The incarnation is the one in the row's token ({@link sameIncarnation}): exact, and no clock. A row with no id in its
 * token (one 0.11 wrote, or a registry of someone else's) is compared by its creation stamp, a clock reading that two
 * incarnations can share. So the object is always proved too, never assumed: the pointer and the incarnation alone
 * cannot say whose write this is. With no proof to ask for, the answer cannot be given, and that is an unknown outcome,
 * never a guess.
 */
async function landedHere(
  now: RegistryRecord | null,
  before: RegistryRecord | null,
  key: GenKey,
  holdsOwnObject: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (now === null || now.status === 'destroyed' || now.currentGen !== key.generation) return false;
  if (before !== null && !sameIncarnation(before, now)) return false;
  if (holdsOwnObject === undefined) {
    throw new TransientError(
      `publish of "${key.segment}" generation ${key.generation}: whether its registry write landed could not be ` +
        `settled, since the caller gave no way to tell its own object from another's. Its object is kept; re-run the ` +
        `write, which numbers past it.`,
    );
  }
  return holdsOwnObject();
}

/** Whether two reads of a row saw it unwritten in between: the same token, or no row both times. */
function sameRow(a: RegistryRecord | null, b: RegistryRecord | null): boolean {
  return a === null ? b === null : b !== null && a.token === b.token;
}

/**
 * The error for a publish that cannot tell whether its registry write landed: always a {@link TransientError}, so no
 * caller treats it as a refusal and deletes the object the write may yet point the row at; a re-run numbers past that
 * object. A cause that is already one (the registry's own error, whose `cause` is the SDK's) is thrown as it is, so
 * what a caller reads from it does not move; any other is wrapped.
 */
function outcomeUnknown(key: GenKey, cause: unknown): TransientError {
  if (isTransientError(cause)) return cause;
  return new TransientError(
    `publish of "${key.segment}" generation ${key.generation}: whether its registry write landed could not be ` +
      `settled (${(cause as { name?: string } | null)?.name ?? 'error'} while checking its object). Its object is ` +
      `kept, since the write may still land; re-run the write, which numbers past it.`,
    { cause },
  );
}

/**
 * Whether the object under `key` is the one `fingerprint` names, from one read of its footer: false when it is another
 * object or gone. Unlike {@link holdsObject}, a read that cannot tell throws, for a caller that must not take "could
 * not look" for "not this object".
 */
export async function provesOwnObject(
  storage: IStorageDriver,
  key: GenKey,
  fingerprint: string,
): Promise<boolean> {
  try {
    return await CrbmReader.sameObject(storageBlobReader(storage, key), fingerprint);
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/** What a bulk-load wrote — the driver's `{ size, sha256 }` plus a summary of the built generation. */
export interface BulkLoadResult {
  /** Bytes written to the Storage object. */
  readonly size: number;
  /** The driver's content hash of the object. */
  readonly sha256: string;
  /** Distinct non-empty chunks written (≤ 65536). */
  readonly chunkCount: number;
  /**
   * The DEK freshly minted for this generation, wrapped — present only when the segment is encrypted AND this
   * call minted one (an existing segment reuses its key, which is already on the row).
   *
   * Returned so a caller that deliberately does **not** pass `registry` here — writing now and publishing later,
   * which is how a load applies a guard while the old generation is still authoritative — can carry the key onto
   * its own `publishGeneration`. Without it that publish stores no DEK and the generation it makes current is
   * unreadable: the bytes are encrypted with a key nothing recorded.
   */
  readonly wrappedDeks?: readonly WrappedDek[];
  /** Whether the object was written encrypted: under the segment's key, or under one this call minted. */
  readonly encrypted: boolean;
  /** The written object's fingerprint, which tells it from an object stored later under the same key. */
  readonly fingerprint: string;
  /** Total distinct ids in the generation (post-dedup). */
  readonly cardinality: number;
  /**
   * The summary of what was written, for the write that makes it current: its id count and metadata, sealed under the
   * segment's key when the object was written with one. A caller that defers the publish (`publish: false`) passes it
   * to {@link publishGeneration}.
   */
  readonly summary: RegistrySummary;
  /**
   * Whether this generation is now the segment's **current** one — `undefined` when no `registry` was wired, so
   * there is no pointer and no publish step to report on.
   *
   * `false` means the object is durable but a **concurrent writer published a higher generation first**, so this
   * one is an orphan that no reader will ever resolve. The write succeeded and the *load* did not: whatever this
   * call was asked to make the segment contain, the segment does not contain. That is not a detail a caller can
   * be left to infer — a `*Into` materialisation that reported the generation it wrote as "the destination's new
   * current generation" on this path would state a plain untruth — so the flag is on the result and the verbs that
   * promise a published generation check it.
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
 * computes one from the registry and the bucket, as `nextLoadGeneration` does for a load — and re-using an existing
 * generation throws
 * {@link WriteConflictError} (write-once). Without a registry a `StorageChunkSource` serves the **highest**
 * generation present, so a too-high number silently shadows real data; with one, `publishGeneration` decides.
 */
export async function bulkLoadCrbmGeneration(
  driver: IStorageDriver,
  key: GenKey,
  ids: Iterable<number> | AsyncIterable<number> | DecodedLoadInput,
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
    /**
     * Write the object but do **not** advance the pointer (default: publish when a `registry` is wired).
     *
     * For a caller that has to inspect what it wrote before deciding whether it should become current — a
     * guarded {@link loadSegment} is the one in-tree case — because the check is only meaningful while the old
     * generation is still authoritative. The `registry` is still required for an encrypted segment and still
     * consulted: it is where an existing segment's DEK lives, and reusing that key is not optional. The wrapped
     * DEK comes back on the result so the deferred publish can store it.
     *
     * A caller that defers the publish owns what it wrote: an unpublished object sits ABOVE `currentGen`, where
     * generation collection deliberately never looks, so nothing reclaims it until a later generation above it is
     * current.
     */
    publish?: boolean;
    /**
     * The generation's metadata (see {@link GenerationMetadata}), written into the object and carried in the summary.
     * The caller has checked it against the metadata rules; the writer checks it again, and refuses a record that breaks
     * one before a byte is written.
     */
    metadata?: GenerationMetadata;
    /**
     * The segment's row as the caller already read it (`null`: it found none), for a caller that defers the
     * publish (`publish: false`) and fences it on that same row. A present cleartext row is then used as read,
     * rather than read again: a row that changes in between (a publish, a drop, a purge and re-create) makes the
     * fenced publish lose, so the object is never published on the strength of the stale read. A row read as
     * absent, or one carrying key material, is read again after the ids, as with no row passed: a first load must
     * see a row another writer created meanwhile, and an encrypted segment's key is unwrapped only from a row read
     * after the ids, so a segment shredded while they streamed is refused before its key is used.
     */
    row?: RegistryRecord | null;
  } = {},
): Promise<BulkLoadResult> {
  if (options.keystore === undefined && options.requireEncryption === true) {
    throw new ValidationError('requireEncryption: a load needs a keystore to write encrypted');
  }
  const codec = requireCodec(options.codec, 'bulkLoadCrbmGeneration');
  // A decoded bitmap writes its own chunks, which never touches an id. Ids, and the bitmap of a codec that cannot
  // encode its own chunks, are bucketed per chunk instead; both give the same bytes.
  let chunks: Iterable<EncodedChunk>;
  if (ids instanceof DecodedLoadInput && ids.bitmap.encodeChunks !== undefined) {
    // The whole-bitmap steps each get a slice of their own: the decode the load made before its first request, the
    // re-encode and serialize `encodeChunks` makes when called, and then the cut, which is lazy, so the writer's
    // periodic yield interrupts it.
    const pause = yieldEvery(options.clock, 1);
    await pause();
    chunks = ids.bitmap.encodeChunks();
    await pause();
  } else {
    chunks = encodeEach(
      await bucketIds(ids instanceof DecodedLoadInput ? ids.bitmap : ids, codec, options.clock),
    );
  }

  if (options.keystore !== undefined && options.registry === undefined) {
    throw new ValidationError('an encrypted load requires a registry to store the wrapped DEK');
  }
  // Read the segment's record once (when a registry is wired): to refuse writing to a crypto-shredded segment (which
  // would create unreadable/unreachable bytes), and to reuse its DEK if it's encrypted. A present cleartext row the
  // caller already read is used as read (see `row`).
  const passed = options.row;
  const existing =
    passed !== undefined &&
    passed !== null &&
    (passed.wrappedDeks === undefined || passed.wrappedDeks.length === 0)
      ? passed
      : options.registry !== undefined
        ? await options.registry.get(key)
        : null;
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
      `segment "${key.segment}" is encrypted but this load has no keystore — refusing to write a cleartext ` +
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
      // half-encrypted — a pin of a superseded generation, once its reader is reopened, would find bytes its key
      // cannot open, and a later `destroySegment` would attest that shredding one DEK made every copy unreadable
      // while the older cleartext objects stay readable from any of them.
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

  const { size, sha256, chunkCount, cardinality, fingerprint } = await writeEncodedChunks(
    driver,
    key,
    chunks,
    { crypto, clock: options.clock, metadata: options.metadata },
  );
  const summary = summaryOf(
    key,
    key.generation,
    { cardinality, metadata: options.metadata },
    crypto?.aead,
  );
  // Publish only after the immutable object is durable (write-then-publish): a registry-aware reader should
  // never point at a generation that isn't fully written. A freshly minted DEK is stored on this publish.
  if (options.registry !== undefined && options.publish !== false) {
    const becameCurrent = await publishGeneration(options.registry, key, {
      wrappedDeks: newWrapped,
      summary,
      cleartext: crypto === undefined,
      holdsOwnObject: () => provesOwnObject(driver, key, fingerprint),
      clock: options.clock,
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
    return {
      size,
      sha256,
      chunkCount,
      cardinality,
      summary,
      becameCurrent,
      wrappedDeks: newWrapped,
      encrypted: crypto !== undefined,
      fingerprint,
    };
  }
  return {
    size,
    sha256,
    chunkCount,
    cardinality,
    summary,
    wrappedDeks: newWrapped,
    encrypted: crypto !== undefined,
    fingerprint,
  };
}

/** Route each id into its chunk's bitmap, consuming the source lazily. Returns the chunks, ascending by key. */
async function bucketIds(
  ids: Iterable<number> | AsyncIterable<number>,
  codec: CodecInterface,
  clock: Clock | undefined,
): Promise<Array<{ chunkKey: number; bitmap: CodecBitmap }>> {
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
  const tickChunk = yieldEvery(clock);
  const tickId = yieldEvery(clock, YIELD_EVERY_IDS);
  // Yield every N chunks, NOT per chunk. Measured: handing each chunk's insert to the threadpool
  // (`fromArrayAsync`) costs ~9 µs of dispatch against ~1.5 µs of actual work once ids are spread across
  // ~61,000 chunks — 636 ms versus 92 ms, a 7x regression that would have undone the per-chunk batching this
  // function already does. Keeping the inserts synchronous and interrupting them periodically gets the
  // starvation fix without the cost — measured on the per-chunk insert microbenchmark: 88 ms wall against a
  // 92 ms unyielded baseline. The whole-load end-to-end figures are a DIFFERENT experiment and live in
  // `cooperative.ts`. Quoting this 92 ms baseline beside that experiment's 450 ms stall would describe a 92 ms
  // operation with 450 ms of starvation inside it, which is impossible on its face.
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

  // Every chunk in the map received at least one id, so no bitmap here is empty.
  return [...byChunk]
    .map(([chunkKey, bitmap]) => ({ chunkKey, bitmap }))
    .sort((a, b) => a.chunkKey - b.chunkKey);
}

/**
 * Open a {@link CrbmReader} on one generation over the storage driver's range/tail reads (decrypting if `crypto`).
 * The reader the write paths use to re-read what they wrote, and the erasure rewrite uses to stream the old
 * generation; the engine's read path goes through {@link CrbmStorageChunkSource} instead, which caches these.
 */
export function openGenerationReader(
  storage: IStorageDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
  options: Omit<CrbmReaderOptions, 'crypto'> = {},
): Promise<CrbmReader> {
  return openChecked(storage, key, { ...options, crypto });
}

/**
 * Open a reader on `key`, refusing an object whose footer names another generation. Every writer stamps the key's
 * number, and the chunk cache, the load guard and the erasure rewrite all trust it, so an object that disagrees
 * was written under another key or altered. Every open, the live read's, a pin's and the write paths', comes here.
 */
async function openChecked(
  storage: IStorageDriver,
  key: GenKey,
  options: CrbmReaderOptions,
): Promise<CrbmReader> {
  const reader = await CrbmReader.open(storageBlobReader(storage, key), options);
  if (reader.generation !== key.generation) {
    throw new IntegrityError(
      `segment "${key.segment}" generation ${key.generation}: its footer says generation ${reader.generation}`,
    );
  }
  return reader;
}

/**
 * Re-open a freshly written generation and assert it round-trips exactly what was streamed into it: the same
 * per-chunk key set *and* the same total cardinality (on top of the codec's own per-chunk CRC + footer checks), and the
 * metadata it was given. `expected` is the streaming writer's tally (the stream is consumed, so it can't be
 * re-iterated) — the key-set comparison catches a dropped/extra chunk that a cardinality-only check could miss when
 * two errors cancel out. The count and the metadata are what the generation's row summary is about to claim, so the
 * summary is held to the object it describes before it is published.
 * Throws {@link IntegrityError}: the object is on disk but must not be published.
 */
export async function verifyGeneration(
  storage: IStorageDriver,
  key: GenKey,
  expected: {
    readonly chunkKeys: readonly number[];
    readonly cardinality: number;
    readonly metadata?: GenerationMetadata | undefined;
  },
  crypto: CrbmCrypto | undefined,
): Promise<void> {
  const expectedKeys = [...expected.chunkKeys].sort((a, b) => a - b);
  const reader = await openGenerationReader(storage, key, crypto);
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
  if (!summaryAgrees(expected, { cardinality: reader.count(), metadata: reader.metadata })) {
    throw new IntegrityError(
      `verify failed for ${key.segment}.${key.generation}: the object's metadata is not the metadata it was written with`,
    );
  }
}
