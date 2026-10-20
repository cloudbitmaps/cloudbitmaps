/**
 * Bridges the `.crbm` archive format to the engine's Storage seam.
 *
 * `CrbmStorageChunkSource` implements the {@link StorageChunkSource} the engine reads through, over an
 * {@link IStorageDriver}: it resolves a segment's current generation, opens its {@link CrbmReader} once, and serves
 * per-chunk payloads. The write path lives beside it, in `crbm-write.ts`, `publish.ts` and `bulk-load.ts`, and the
 * opening of a stored generation in `crbm-open.ts`.
 */
import { checkRequireEncryption, requireFiniteNumber, requirePositiveInteger } from './check';
import {
  DEFAULT_CURRENT_GEN_TTL_MS,
  DEFAULT_MAX_OPEN_INDEX_BYTES,
  DEFAULT_MAX_OPEN_SEGMENTS,
  REFRESH_RETRY_MS,
  RESOLUTION_BYTES_DIVISOR,
  RESOLUTIONS_PER_OPEN_SEGMENT,
} from './reader-defaults';
import {
  CapabilityError,
  KeyUnavailableError,
  NotFoundError,
  ValidationError,
  WriteConflictError,
  isIntegrityError,
  isNotFoundError,
  isTransientError,
  isValidationError,
} from './errors';
import type { Clock } from './determinism';
import { pointerIdOf } from './pointer-id';
import { BoundedLru } from './lru';
import { KeptSegmentKeys, segmentKey } from './keys';
import { aadFor, sameKeys } from './crypto';
import type { Aead, CrbmCrypto, IKeystore, WrappedDek } from './crypto';
import {
  validateChunkKey,
  validateChunkKeyOrder,
  validateChunkRef,
  validateSegmentRef,
  validateUserRef,
} from './validate';
import type {
  ChunkRef,
  ChunkRead,
  ReadChunksOptions,
  StorageChunkSource,
  GenerationSummary,
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
  SegmentSize,
  TailRead,
  Token,
} from './ports';
import { CrbmReader } from './crbm/reader';
import { compactFingerprint } from './crbm/fingerprint';
import type { ChunkStream, CrbmReaderOptions } from './crbm/reader';
import { InvalidationRecord } from './invalidation-scope';
import { ItemPull } from './item-pull';
import { sizeOfFingerprint, summaryAgrees, usableSummary } from './summary';
import type { GenerationDescription, SummaryDescription } from './summary';
import { storageBlobReader, openChecked, sizedTailBytes, startTailRead } from './crbm-open';

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
   * new {@link CrbmReader} is opened only when the row's pointer was renewed. `0` turns the refresh off, as a
   * missing clock or registry does: {@link clock} says what that changes, and what it does not.
   */
  readonly currentGenTtlMs?: number;
  /**
   * Hard ceiling on how many segments' readers (each holding a fully-parsed `.crbm` index) are cached at once
   * (default 1024) — a memory bound for a long-running server. Past it, the least-recently-used
   * segment's reader is evicted; the next read of an evicted segment re-opens it (one cheap tail GET, since
   * generations are immutable). Raise it for a big cache working set of small segments, and raise {@link maxOpenIndexBytes} with it: each open reader counts about 3.75 KiB there, so past about 17,000 tiny readers the byte ceiling binds first. A source with a timed refresh
   * also keeps up to 8 times this many segments' resolutions apart from their readers, for the TTL: the re-open then
   * reads no row, and comes only when a read needs the reader, for the index or for a chunk.
   */
  readonly maxOpenSegments?: number;
  /**
   * Aggregate byte ceiling on what the reader cache holds (default 64 MiB): the parsed `.crbm` indices, and the chunk bytes a
   * reader keeps when its first read returned a whole small object (see below) — the
   * **second half of that memory bound**. `maxOpenSegments` alone bounds by *count*, but a wide/dense segment's
   * parsed index can reach about 1.3 MB, so 1024 wide indices could pin over a GB and blow a small heap (e.g. a 128 MB
   * Lambda) while the count is nominally "in bounds". This caps the summed {@link CrbmReader.retainedBytes} (the
   * parsed index, any metadata a generation carries, and any kept chunk bytes) plus a fixed 3.75 KiB for the objects each open reader
   * holds around them, across cached readers, so that many tiny segments are bounded too; the least-recently-used reader is evicted once the total would exceed it — whichever
   * of the count/byte bounds binds first. A reader whose open read the whole object keeps a copy of its chunk region when
   * that region is at most this ceiling divided by {@link maxOpenSegments} (64 KiB by default) — its fair share — so a small generation's
   * chunks are served from memory with no further request, and a bigger one is read by range. Only a source with a timed
   * pointer refresh ({@link currentGenTtlMs} above 0, a registry and a clock) keeps chunk bytes. Lower it for memory-tight deployments with wide segments; a single
   * segment whose weight alone exceeds the budget is still cached (it can't be shrunk) but nothing else alongside. A
   * sixteenth of it bounds the resolutions a source with a timed refresh keeps besides (4 MiB by default).
   */
  readonly maxOpenIndexBytes?: number;
}

/**
 * A resolved read target, as a resolution of the segment produces it: which generation is current, and its DEK wrappings
 * if it is encrypted. `lineage` is the registry row's `pointerId`: the token of the last write that named a field a read
 * resolves through, at any value, which a shipped registry never gives two writes under one name, but for a collision of probability 2^-128 per pair
 * of incarnations. It is what separates two *incarnations* of one name, which a generation number cannot: the numbering
 * restarts at 0 once the row is purged and the bucket emptied, so a retired-and-re-created segment presents different
 * data at the same `currentGen`; and it separates two resolutions of one number within an incarnation, since every write
 * that changes what the row resolves to renews it. A lease or a policy write leaves it, so what is cached under it
 * outlives those. Undefined for a registry-less source, which has no row: there, only the object itself tells two
 * incarnations apart, by the fingerprint a pin records.
 */
type Target = { generation: number; lineage?: Token; wrappedDeks?: readonly WrappedDek[] };

/**
 * What one resolution of a segment found: the fields of its row a read resolves through (the generation, the row's
 * `pointerId`, the wrapped keys and the summary), and nothing else. Not the row: its token, leases, retention and the
 * rest are no part of what a read reads. Not a key either: the wrapped keys are unwrapped by each snapshot built on the
 * resolution ({@link Live.unwrap}), so an unwrapped key is held only while a reader of the segment is.
 */
interface Resolved extends Target {
  readonly summary?: RegistrySummary;
}

/**
 * One read of a segment's pointer: the registry's row, or a listing of the bucket with no registry, and when it was sent.
 * `null` for no generation: no row, a row with no generation yet, or a destroyed one. Its TTL counts from
 * {@link sentAtMs}, the instant the read was sent, not the one it answered, so a slow read does not lengthen the life of
 * what it found; a reopen and a read that finds it leave it, and only a refresh that failed transiently moves it, to ask
 * again sooner.
 */
interface Resolution {
  readonly resolved: Promise<Resolved | null>;
  sentAtMs: number;
  /**
   * Set when the read failed transiently and this answers what the resolution `from` found instead: only the snapshot
   * that replaces one on `from` is served it, and any other fails with the read's `fault`, as a cold resolve does.
   * Cleared when the next refresh rides out from this one, so an outage holds one link of it, however long.
   */
  rodeOut?: { readonly from: Resolution; readonly fault: unknown };
}

/**
 * The fields of a row a read resolves through, or `null` where a read finds no generation: no row; a destroyed
 * one, through which no read resolves a generation (after a crypto-shred its DEK is gone from the row too); and a row
 * with no Storage
 * generation yet (minted by `setSegmentRetention` ahead of the first load, so admin tools can see the segment), which
 * resolves exactly like a segment with no row. Returning `null` for that last one rather than a generation is the whole reason such a row is safe
 * to create: the alternative, pointing at a generation that does not exist, is the `missing-storage-generation` state.
 */
function resolvedOf(record: RegistryRecord | null): Resolved | null {
  if (record === null || record.status === 'destroyed' || record.currentGen === null) return null;
  return {
    generation: record.currentGen,
    lineage: pointerIdOf(record),
    wrappedDeks: record.wrappedDeks,
    summary: record.summary,
  };
}

/**
 * What a resolution weighs, in the resolution cache and in the reader cache while a snapshot holds no reader: a fixed
 * part for the entry and its strings, then the row's summary and wrapped keys as JSON.
 */
function weightOf(resolved: Resolved): number {
  return (
    SNAPSHOT_BASE_BYTES +
    (resolved.summary === undefined ? 0 : JSON.stringify(resolved.summary).length) +
    (resolved.wrappedDeks === undefined ? 0 : JSON.stringify(resolved.wrappedDeks).length)
  );
}

/**
 * What a pin holds of the object it pinned: the version its cache entries are keyed by, and the object's
 * fingerprint, which a pinned read checks each time it opens the generation. `pinGeneration` always records both,
 * and a pinned read given one without both as strings throws a `ValidationError`.
 */
export interface PinnedObject {
  readonly version: string;
  readonly fingerprint: string;
}

/** A pinned read of a generation that is no longer the object the pin opened: stated as a fact, not a cause. */
const notThePinned = (ref: SegmentRef, generation: number): NotFoundError =>
  new NotFoundError(
    `segment "${ref.segment}" generation ${generation} is no longer the object this handle pinned`,
  );

/** A read of a generation whose registry row has gone or been destroyed while it ran, which it cannot finish. */
const goneUnder = (ref: SegmentRef, generation: number): NotFoundError =>
  new NotFoundError(
    `segment "${ref.segment}" generation ${generation} can no longer be read: its registry row is gone or destroyed`,
  );

/** The storage key of the generation a resolution found. */
function genKeyOf(ref: SegmentRef, target: { readonly generation: number }): GenKey {
  return { namespace: ref.namespace, segment: ref.segment, generation: target.generation };
}

/**
 * What a resolution names: `<generation>`, or `<generation>:<pointerId>` where there is a row. One spelling, for the
 * live lookup and for what a pin holds. It names an object only as of the row read that produced it: a number can be
 * taken again once its object is deleted, and every row write that leads there renews the `pointerId`, so an object
 * opened after that row read can be another one under the same name. {@link versionOfReader} adds the object.
 */
function versionOf(generation: number, lineage: unknown): string {
  return lineage === undefined ? String(generation) : `${generation}:${String(lineage)}`;
}

/** The version of each open reader, spelled once per reader: the hot path asks for it once per operand of a read. */
const readerVersions = new WeakMap<CrbmReader, string>();

/**
 * The version a live reader's chunks are read and cached under: what its resolution named ({@link versionOf}), then
 * `#` and the fingerprint of the object it opened, from the footer its open read. Two objects under one name do not
 * share a version, as far as their sizes and footer checksums tell them apart, so chunks cached from one are not served
 * for the other, however late the second was opened.
 */
function versionOfReader(reader: CrbmReader): string {
  let version = readerVersions.get(reader);
  if (version === undefined) {
    version = `${versionOf(reader.generation, reader.lineage)}#${compactFingerprint(reader.fingerprint)}`;
    readerVersions.set(reader, version);
  }
  return version;
}

/** What {@link versionOfReader} ends a version with: `#`, then the object's size and footer checksum in base 36. */
const OBJECT_SUFFIX = /#[0-9a-z]+\.[0-9a-z]+$/;

/**
 * What a live version's resolution named, without the object's fingerprint: `<generation>:<pointerId>`, or
 * `<generation>` with no registry. For a caller that compares a live version, from
 * {@link CrbmStorageChunkSource.currentVersion} or a chunk of its `getChunks`, with a row it read. A live version always
 * ends with the suffix, which holds no `#`, so the match starts at its last `#` and a `pointerId` holding `#` of its own
 * is kept whole. Known limit: a string with no suffix, such as a pin's version or one from another source, loses its end
 * when its `pointerId` itself ends in `#<base 36>.<base 36>`; no caller passes one.
 */
export function rowVersionOf(version: string): string {
  return version.replace(OBJECT_SUFFIX, '');
}

/** What a pin that leases its generation does between reading the row and opening the object. */
export interface PinLease {
  /** Write the lease against the row the pin read: its token, or `'moved'` when the pointer is no longer at the generation. */
  take(row: RegistryRecord): Promise<{ readonly token: Token } | 'moved'>;
}

/** The pointer moved before a lease could be written against it: the pin starts again from a fresh read. */
class PinMoved extends Error {}

/**
 * What a snapshot makes of one resolution of a segment's pointer: the target, and what its row says of the generation,
 * each computed only when asked for. The key is unwrapped once however many ask, and a failure is not remembered, so a
 * transient fault in the keystore is asked again.
 */
interface Live {
  readonly target: Target;
  /** The row a pin's resolution read, which its lease is written against. A snapshot's resolution keeps no row. */
  readonly row?: RegistryRecord;
  /** The generation's decryption context (`undefined` for a cleartext segment); applies `requireEncryption`. */
  readonly crypto: () => Promise<CrbmCrypto | undefined>;
  /** The segment's unwrapped key, shared with the next snapshot while the row's wrapped keys are the same. */
  readonly unwrap: (() => Promise<Aead>) | undefined;
  /** What the row's summary says of the generation, when the row's summary is usable for it. */
  readonly summary: () => Promise<SummaryDescription | undefined>;
  /**
   * The version any reader opened for this resolution names ({@link versionOfReader}), when the row's summary names the
   * object: every live open is held to that object, so no reader that opens names another. `undefined` when the row has
   * no summary it can use: only an open then says which object is under the number.
   */
  readonly version: () => Promise<string | undefined>;
  /** What the resolution weighs while no reader is open ({@link weightOf}). */
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

/** What an opened generation says of itself, with its object's size. */
function sizedSummary(reader: CrbmReader): GenerationSummary & SegmentSize {
  return {
    ...summaryOfGeneration(reader.generation, describe(reader)),
    sizeBytes: reader.sizeBytes,
  };
}

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

/** Whether a reader is of the generation, and the row's `pointerId`, a resolution found. */
const readerIsOf = (reader: CrbmReader, live: Live): boolean =>
  reader.generation === live.target.generation && reader.lineage === live.target.lineage;

/**
 * Whether `snap` reads the object `reader` opened. Once the snapshot's reader has opened, its version says, which names
 * the object. Until then, while none has been asked for and while another read's open of it is under way, its
 * resolution says, by generation and the row's `pointerId`, so nothing is opened, and nothing waited on, to learn it; the
 * snapshot's reader can still turn out to be another object under that name, which the caller checks once it opens.
 * An open that failed is another read's failure, and never the caller's: the reader cache forgets a snapshot whose open
 * failed as the failure lands, so the caller meets a new snapshot next and resolves the segment through it.
 */
async function readsObjectOf(snap: Snapshot, reader: CrbmReader): Promise<boolean> {
  const settled = snap.settled;
  if (settled !== undefined) {
    const other = settled.reader;
    return (
      other !== null && (other === reader || versionOfReader(other) === versionOfReader(reader))
    );
  }
  const live = await (snap.target as Promise<Live | null>);
  return (
    live !== null &&
    versionOf(live.target.generation, live.target.lineage) ===
      versionOf(reader.generation, reader.lineage)
  );
}

/** What a generation's object says of itself, which is what a summary is held against: its count and metadata. */
function describe(reader: CrbmReader): GenerationDescription {
  return { cardinality: reader.count(), metadata: reader.metadata, tailBytes: reader.tailBytes };
}

/** Runs one storage request, and may run it again if it fails. */
type Retry = <R>(request: () => Promise<R>) => Promise<R>;

/** What a read holds while it resolves a segment: the live snapshot and the reader it is opening. */
interface Resolving {
  snap: Snapshot;
  pending: Promise<CrbmReader | null>;
}

/** `request`, run through `retry` when the caller has one. */
function viaRetry<R>(retry: Retry | undefined, request: () => Promise<R>): Promise<R> {
  return retry === undefined ? request() : retry(request);
}

/** The checks every chunk read starts with: a user's segment, chunk keys that are valid and in ascending order (a key may repeat). */
function validateRead(ref: SegmentRef, keys: readonly number[]): void {
  validateUserRef(ref);
  // A chunk ref is a copy of this ref, so it carries only the ref's own enumerable names: checked once, not once a key.
  if (keys.length > 0) validateSegmentRef({ ...ref });
  for (const chunkKey of keys) validateChunkKey(chunkKey);
  validateChunkKeyOrder(keys);
}

/**
 * A memoized per-segment snapshot, on one resolution of the segment, whose TTL is the snapshot's. A live snapshot is a
 * resolved target, and a reader that is opened only when a read needs one: one resolution serves a `count` answered
 * from the row and a `has` that follows it, which reads the generation the count saw. The reader opens whatever object
 * is under that generation's key when it opens, which is another object than the row named if the number has been
 * taken again since the row was read; it is held to the object the row's summary names where there is one
 * ({@link CrbmStorageChunkSource.openLive}), and its version names the object it opened ({@link versionOfReader}), so
 * nothing cached from the earlier object answers for it. A pinned snapshot is its reader alone.
 */
class Snapshot {
  /** Set by the cache, to hear of a reader as it is opened. */
  onReader: ((reader: Promise<CrbmReader | null>) => void) | undefined;
  private opened: Promise<CrbmReader | null> | undefined;
  private outcome: { readonly reader: CrbmReader | null } | undefined;

  private constructor(
    /** The read of the pointer this snapshot is on, whose TTL is the snapshot's; absent on a pinned snapshot. */
    readonly resolution: Resolution | undefined,
    /** What the pointer resolved to; absent on a pinned snapshot. */
    readonly target: Promise<Live | null> | undefined,
    private readonly open: ((live: Live) => Promise<CrbmReader>) | undefined,
    /** The reader of the snapshot this one refreshes, kept if the refresh finds the same generation. */
    private prior: Promise<CrbmReader | null> | undefined,
  ) {}

  static live(
    resolution: Resolution,
    target: Promise<Live | null>,
    open: (live: Live) => Promise<CrbmReader>,
    prior?: Promise<CrbmReader | null>,
  ): Snapshot {
    return new Snapshot(resolution, target, open, prior);
  }

  static eager(reader: Promise<CrbmReader | null>): Snapshot {
    const snap = new Snapshot(undefined, undefined, undefined, undefined);
    snap.hold(reader);
    return snap;
  }

  /** The reader, opened by the first call. */
  get reader(): Promise<CrbmReader | null> {
    if (this.opened === undefined) {
      const target = this.target as Promise<Live | null>;
      const opened = this.hold(
        target.then(async (live) => {
          if (live === null) return null;
          const kept = await this.reuse(live);
          this.prior = undefined;
          return kept ?? (this.open as (live: Live) => Promise<CrbmReader>)(live);
        }),
      );
      this.onReader?.(opened);
      return opened;
    }
    return this.opened;
  }

  /**
   * Take `reader` as this snapshot's, and note the reader once it has opened. A failed open is not noted: the reader
   * cache forgets the snapshot as the failure lands, and whoever awaits the reader meets the error.
   */
  private hold(reader: Promise<CrbmReader | null>): Promise<CrbmReader | null> {
    this.opened = reader;
    reader.then(
      (r) => {
        this.outcome = { reader: r };
      },
      () => undefined,
    );
    return reader;
  }

  /** The reader if one has been asked for, without asking for one. */
  get openedReader(): Promise<CrbmReader | null> | undefined {
    return this.opened;
  }

  /**
   * The reader once it has opened (`null` for no generation). Undefined while no reader has been asked for, while the
   * open is under way, and after an open that failed.
   */
  get settled(): { readonly reader: CrbmReader | null } | undefined {
    return this.outcome;
  }

  /**
   * The prior snapshot's reader, if it is of what this snapshot resolved: the same generation and `pointerId`, and the
   * object the row's summary names, where it names one. A registry renews `pointerId` with every write that changes the
   * summary, so the last holds whenever the first two do; it is checked anyway, since it costs no request, and a reader
   * kept across a write that should have renewed it would serve another object's chunks.
   */
  async reuse(live: Live): Promise<CrbmReader | null> {
    const prior = this.prior;
    const reader = prior === undefined ? null : await prior.catch(() => null);
    if (reader === null || !readerIsOf(reader, live)) return null;
    // A summary that cannot be had now (its key is unreachable) names nothing; the open that follows meets the same.
    const named = await live.summary().catch(() => undefined);
    return named === undefined || named.fingerprint === reader.fingerprint ? reader : null;
  }

  /** Keep the prior snapshot's reader when the refresh found its generation, so a count does not drop it. */
  async adopt(live: Live): Promise<void> {
    if (this.opened !== undefined || this.prior === undefined) return;
    const reader = await this.reuse(live);
    this.prior = undefined;
    if (reader !== null && this.opened === undefined) {
      this.onReader?.(this.hold(Promise.resolve(reader)));
    }
  }
}

/** The fixed part of what a resolution weighs ({@link weightOf}): the entry, its generation and its `pointerId`. */
const SNAPSHOT_BASE_BYTES = 256;

/**
 * The fixed heap an open reader's snapshot holds beyond {@link CrbmReader.retainedBytes}: the snapshot, the reader, its
 * five index arrays as objects, and the closures and promises that tie them. It is added to a reader's weight in the
 * reader cache, so that the byte ceiling bounds many tiny segments as it does a few wide ones. Measured as the heap that
 * stayed (full collections until stable) per segment after a source opened 2,000 one-chunk segments, minus the 20 bytes
 * of index the weight already counts: about 3.7 KiB on Node 24, rounded up to 3.75 KiB.
 * `tests/core/reader-cache-heap.test.ts` holds the counted weight to that heap.
 */
export const OPEN_READER_BYTES = 3_840;

export class CrbmStorageChunkSource implements StorageChunkSource {
  /**
   * One resolved reader per segment, re-resolved on a short TTL ({@link CrbmStorageChunkSourceOptions.currentGenTtlMs},
   * needs a clock). Within the TTL a segment's Storage bytes are treated as an immutable snapshot; when the TTL
   * elapses the next read cheaply re-resolves `currentGen` and, only if it advanced (a load published),
   * opens the new generation — so a long-lived source observes new generations within the TTL. The engine pairs
   * this with a cache keyed by {@link currentVersion}, which names the object a reader opened, so a bump never serves
   * a stale decoded chunk, and neither does a number taken again by another object. Without a clock or a
   * registry there is no timed refresh, and a segment's reader is replaced only when it is evicted, when a read
   * has to fetch from a generation a sweep deleted, or when {@link invalidate} drops it. A segment with no generation yet is not memoized, so
   * it's re-checked until one exists. **Bounded** by a {@link BoundedLru} ({@link CrbmStorageChunkSourceOptions.maxOpenSegments}, default
   * 1024): past the ceiling the least-recently-used segment's reader (and its parsed index) is evicted — the
   * steady-state memory bound; re-opening an evicted segment is one cheap tail GET.
   */
  private readonly snapshots: BoundedLru<string, Snapshot>;
  /**
   * Each segment's resolution, kept apart from its reader, by segment: what a read of its row found, for the TTL from
   * the instant that read was sent, whether or not the reader cache still holds the segment's reader. So letting a reader
   * go moves nothing: the next read builds a snapshot on the resolution, reads no row, and opens the object when it needs
   * the index or a chunk the chunk cache does not hold (a version, a count and a stat from the row's summary need
   * neither). It holds the resolved fields only ({@link Resolved}): the wrapped keys, never an unwrapped one, so a
   * snapshot built on it unwraps the key again through the keystore. It never holds a resolution that found no
   * generation: the next read of such a segment reads the row.
   *
   * Only a source with a timed refresh has one: without it, letting a reader go is one of the few things that ever moves
   * a read on, and keeping the resolution would keep it forever. **Bounded** by count and by bytes, both derived from
   * the reader cache's: {@link RESOLUTIONS_PER_OPEN_SEGMENT} times its count bound, and its byte bound over
   * {@link RESOLUTION_BYTES_DIVISOR}. An entry heavier than the byte bound is kept alone, as the reader cache keeps one.
   */
  private readonly resolutions: BoundedLru<string, Resolution> | undefined;
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
  private get invalidations(): number {
    return this.invalidated.epoch;
  }
  /**
   * Which segments {@link invalidate} has been called for, the latest invalidation of up to 1,024 of them: a pinned
   * stream asks it whether its own segment was invalidated since it last looked.
   */
  private readonly invalidated = new InvalidationRecord();
  /**
   * Generations whose row summary this process found to disagree with their object, by segment and generation. A
   * summary here is not used again: a count of that generation reads the object. Bounded as the readers are, so a
   * long-lived process cannot grow it without limit; one that falls out is trusted again until its next open finds
   * the disagreement again.
   */
  private readonly distrusted: BoundedLru<string, true>;
  /**
   * The readers held to the row's summary: by a live open ({@link openLive}), or by a live pin that shared one. A pin
   * that finds one memoised under its version shares it as it is: the version names the row's `pointerId`, and every
   * write of the summary renews it, so the summary it was held to is the one the row has now. Any other memoised reader
   * (a `pinAt`'s, held to the fingerprint its caller named) is held to the row's summary before a live pin shares it.
   */
  private readonly rowChecked = new WeakSet<CrbmReader>();
  private readonly registry: IRegistryDriver | undefined;
  private readonly keystore: IKeystore | undefined;
  private readonly requireEncryption: boolean;
  private readonly readerOptions: CrbmReaderOptions;
  /** The most chunk bytes a reader keeps from its open: the reader cache's byte bound over its count bound, per reader; 0 without a timed pointer refresh. */
  private readonly keepChunkBytesUpTo: number;
  private readonly clock: Pick<Clock, 'now'> | undefined;
  private readonly currentGenTtlMs: number;
  /**
   * Whether the segment's pointer is re-read on a timer: it needs a clock (the TTL), a registry (the cheap row read; with
   * none, resolving is a listing of the bucket) and a TTL above 0. It decides the keeping of chunk bytes and the TTL
   * lapse, so it is decided once.
   */
  private readonly timedRefresh: boolean;

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
    // Exactly a boolean: a truthy string read as `true` here, and not by the write paths, which compare with `=== true`.
    checkRequireEncryption(requireEncryption);
    if (maxOpenSegments !== undefined) requirePositiveInteger(maxOpenSegments, 'maxOpenSegments');
    if (maxOpenIndexBytes !== undefined) {
      requirePositiveInteger(maxOpenIndexBytes, 'maxOpenIndexBytes');
    }
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
    // `0` turns the timed refresh off on purpose. Anything else that is not a finite, non-negative number (`NaN` from an
    // unset variable, a negative, a string) would turn it off too, silently, so another process's load or erasure would
    // never reach a long-lived reader: refused instead.
    if (currentGenTtlMs !== undefined) {
      requireFiniteNumber(currentGenTtlMs, {
        min: 0,
        what: 'cache.genTtlMs',
        note: 'milliseconds; 0 turns the timed refresh off',
      });
    }
    // The cap on an index an open accepts, and the bound a sized tail read is held to: a whole number of bytes, so a
    // `NaN` from an unset variable is refused here rather than silently turning the cap off.
    if (readerOptions.maxIndexBytes !== undefined) {
      requirePositiveInteger(readerOptions.maxIndexBytes, 'maxIndexBytes');
    }
    // A kept chunk is never fetched, so a sweep of its generation is not met: only the timed pointer refresh moves the
    // reader on. A source without one (no registry or clock, or a zero TTL) keeps nothing, and heals as any read does.
    this.timedRefresh =
      registry !== undefined &&
      clock !== undefined &&
      (currentGenTtlMs ?? DEFAULT_CURRENT_GEN_TTL_MS) > 0;
    this.keepChunkBytesUpTo = this.timedRefresh
      ? Math.floor(
          (maxOpenIndexBytes ?? DEFAULT_MAX_OPEN_INDEX_BYTES) /
            (maxOpenSegments ?? DEFAULT_MAX_OPEN_SEGMENTS),
        )
      : 0;
    this.clock = clock;
    this.currentGenTtlMs = currentGenTtlMs ?? DEFAULT_CURRENT_GEN_TTL_MS;
    // Bound the reader cache by BOTH count and aggregate parsed-index bytes. No TTL on the LRU itself —
    // the currentGen TTL is handled separately via each snapshot's resolution (`sentAtMs`); these ceilings only bound
    // how many segment readers/indices stay resident. Each reader's byte weight is reported once it resolves (below).
    // The cache never compares against wall-clock, so a zero clock is fine when none is injected.
    this.snapshots = new BoundedLru<string, Snapshot>({
      maxEntries: maxOpenSegments ?? DEFAULT_MAX_OPEN_SEGMENTS,
      maxBytes: maxOpenIndexBytes ?? DEFAULT_MAX_OPEN_INDEX_BYTES,
      clock: clock ?? { now: () => 0 },
    });
    this.resolutions = this.timedRefresh
      ? new BoundedLru<string, Resolution>({
          maxEntries: RESOLUTIONS_PER_OPEN_SEGMENT * (maxOpenSegments ?? DEFAULT_MAX_OPEN_SEGMENTS),
          maxBytes: (maxOpenIndexBytes ?? DEFAULT_MAX_OPEN_INDEX_BYTES) / RESOLUTION_BYTES_DIVISOR,
          clock: { now: () => 0 },
        })
      : undefined;
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
   * The keys of the segments this source reads, kept rather than encoded again: a read asks for its segment's snapshot
   * once per operand, and a stream before every cached chunk it serves, and encoding the names cost about a
   * microsecond each time.
   */
  private readonly keys = new KeptSegmentKeys(segmentKey);

  private keyOf(ref: SegmentRef): string {
    return this.keys.of(ref);
  }

  /**
   * The segment's live snapshot, refreshing on the TTL. Cheap within the TTL window: the snapshot the reader cache holds,
   * while its resolution is inside the TTL. With a timed refresh, a segment whose reader the cache let go is served a
   * snapshot built on its kept resolution, while that is inside the TTL: no row is read, and the reader opens only when a
   * read needs one. Otherwise the pointer is read now. The snapshot holds the resolved target, and its reader once a read
   * has asked for one.
   */
  private liveSnapshot(ref: SegmentRef): Snapshot {
    const key = this.keyOf(ref);
    const existing = this.snapshots.get(key);
    if (existing !== undefined && !this.expired(existing.resolution as Resolution)) return existing;
    const kept = this.resolutions?.get(key);
    if (kept !== undefined && kept !== existing?.resolution && !this.expired(kept)) {
      return this.install(key, this.snapshotOn(ref, kept, existing));
    }
    // Expired, or never resolved: the pointer is read now, and the resolution and the snapshot on it are installed
    // **synchronously** (before any await) so concurrent readers in this window coalesce onto the one read — ≤ one
    // registry read + at most one reopen per segment per window (no boundary thundering-herd). The refresh keeps the
    // prior reader unless the generation moved. Only a snapshot the reader cache still holds rides out a transient
    // fault in that read, and what it rides out on is not kept: a lapsed resolution kept with no snapshot on it is not
    // served past its TTL, so once the reader cache lets the snapshot go the read fails as a cold resolve does,
    // whatever wrapped keys the lapsed resolution held.
    const resolution = this.resolveNow(ref, existing?.resolution);
    this.remember(key, resolution);
    return this.install(key, this.snapshotOn(ref, resolution, existing));
  }

  /**
   * Read the segment's pointer now. The read is sent before this returns, and the TTL counts from this instant: a read
   * that answers late does not lengthen the life of what it found. The row read is always fresh, so what a snapshot on
   * it says of the generation (its summary included) is what the row says now, never `prior`'s.
   *
   * A read that fails with a transient fault answers what `prior` found, when it found a generation, and is asked again
   * soon ({@link retrySoon}): `prior` is the resolution of the snapshot the reader cache still holds, so an outage of the
   * registry keeps that snapshot's generation, and its reader and unwrapped key where it has them; one resolved without
   * an open, for a count or a generation lookup, unwraps the key from `prior`'s wrapped keys when a read first needs
   * it. The outage ends shortly after the registry answers.
   * That answer is the snapshot's alone ({@link Resolution.rodeOut}): it is not kept as the segment's resolution, and a
   * snapshot built on it after the reader cache let that one go fails with the fault. With no `prior` the fault
   * fails the read, as a cold resolve's does. If `prior` found none or failed, the pointer is read once more rather than
   * a dead resolution re-armed (else the segment reads empty for a whole TTL window). Anything else — an access denial, a corrupt row, a
   * registry that answers NotFound — fails the read exactly as a cold resolve of the segment would, and the resolution
   * and the snapshot on it are forgotten, so a reader and the key it unwrapped do not outlive a refresh that could not
   * be trusted.
   */
  private resolveNow(ref: SegmentRef, prior: Resolution | undefined): Resolution {
    const sentAtMs = this.now();
    const sent = this.resolve(ref);
    if (prior === undefined) return { resolved: sent, sentAtMs };
    const resolution: Resolution = {
      sentAtMs,
      resolved: sent.catch(async (err: unknown) => {
        if (!isTransientError(err)) throw err;
        const before = await prior.resolved.catch(() => null);
        if (before === null) return this.resolve(ref);
        this.retrySoon(resolution);
        // What `prior` found is served to the snapshot that held it, and to nothing else. Kept as the segment's
        // resolution, it would be built on again once the reader cache let that snapshot go, unwrapping the key again
        // from the wrapped keys of a row the registry was not asked about; and a stream on the snapshot, once let go,
        // would not re-check. Not kept, both resolve afresh, as a cold read does.
        const key = this.keyOf(ref);
        if (this.resolutions?.peek(key) === resolution) this.resolutions.delete(key);
        resolution.rodeOut = { from: prior, fault: err };
        // `prior` has settled and is no longer the segment's resolution, so what it rode out from is needed no more:
        // kept, each retry of a long outage would hold the one before it, and its fault.
        prior.rodeOut = undefined;
        return before;
      }),
    };
    return resolution;
  }

  /**
   * A refresh failed transiently and the prior resolution keeps serving: make it lapse after {@link REFRESH_RETRY_MS}
   * (never longer than the TTL) rather than after a whole TTL, so the next read after that asks the registry again. It
   * costs no read of its own; it only changes when the next refresh happens.
   */
  private retrySoon(resolution: Resolution): void {
    resolution.sentAtMs =
      this.now() - (this.currentGenTtlMs - Math.min(this.currentGenTtlMs, REFRESH_RETRY_MS));
  }

  /**
   * Keep `resolution` as the segment's, from the instant its read was sent, so the reads that come while it is in flight
   * share it, and a read after the reader cache let the segment go builds on it. Its weight is reported once it lands,
   * and one that finds no generation, or fails, is forgotten. Both are identity-guarded, as the reader cache's are, and
   * nothing is installed when the read lands: an `invalidate` while it is in flight, or a newer resolution, is never
   * undone by its answer.
   */
  private remember(key: string, resolution: Resolution): void {
    const cache = this.resolutions;
    if (cache === undefined) return;
    cache.set(key, resolution);
    const forgetIfStale = (): void => {
      if (cache.peek(key) === resolution) cache.delete(key);
    };
    resolution.resolved.then((resolved) => {
      if (resolved === null) forgetIfStale();
      else if (cache.peek(key) === resolution) cache.setWeight(key, weightOf(resolved));
    }, forgetIfStale);
  }

  /**
   * A live snapshot on `resolution`. `before` is the snapshot it replaces, while the reader cache still holds one: its
   * reader is kept if the resolution finds the same generation, `pointerId` and object ({@link Snapshot.reuse}), and its
   * unwrapped key if the same wrapped keys. A snapshot built after the reader cache let the segment go has neither, so
   * its open asks the keystore again: a key is held only while a reader of the segment is.
   */
  private snapshotOn(
    ref: SegmentRef,
    resolution: Resolution,
    before: Snapshot | undefined,
  ): Snapshot {
    // The target is built in a function of its own. The snapshot keeps its `open` closure for life, and closures made in
    // one call share what any of them reads from it: built here, the target's would have `open` keep `before`, and
    // through it every snapshot before that, with their readers and keys, outside the reader cache's bounds.
    return Snapshot.live(
      resolution,
      this.targetOn(ref, resolution, before),
      (live) => this.openLive(ref, live),
      before?.openedReader,
    );
  }

  /** What the snapshot on `resolution` that replaces `before` reads: see {@link snapshotOn}. */
  private targetOn(
    ref: SegmentRef,
    resolution: Resolution,
    before: Snapshot | undefined,
  ): Promise<Live | null> {
    const prior = before?.target;
    const replaces = before?.resolution;
    return resolution.resolved.then(async (resolved) => {
      if (resolved === null) return null;
      // A read that came while the refresh was in flight, after the reader cache let the snapshot it replaces go, built
      // on the refresh as the segment's resolution: a ride-out is not served to it ({@link resolveNow}).
      const rodeOut = resolution.rodeOut;
      if (rodeOut !== undefined && replaces !== rodeOut.from) throw rodeOut.fault;
      return this.liveOf(ref, resolved, prior === undefined ? null : await prior.catch(() => null));
    });
  }

  /**
   * Memoize a snapshot as the segment's, forgetting it later if it resolves to null / throws (identity-guarded, so a
   * stale cleanup never clobbers a fresher snapshot). Installing the (pending) snapshot **synchronously** is what lets
   * concurrent callers coalesce onto one in-flight resolve.
   */
  private install(key: string, snap: Snapshot): Snapshot {
    this.snapshots.set(key, snap);
    const forgetIfStale = (): void => {
      if (this.snapshots.get(key) === snap) this.snapshots.delete(key);
    };
    // Report what the snapshot holds so the cache can bound aggregate resident bytes: the row's summary while only
    // the target is resolved, and the reader (its parsed index and any metadata) once one is open. Identity-guarded
    // via `peek` (no recency change) so a since-replaced snapshot doesn't mis-weight the fresh entry. An open that
    // fails forgets the resolution too, as `dropStale` does: what it names could not be read, so the next read reads
    // the row again, as a cold read does.
    snap.onReader = (reader) => {
      reader.then(
        (r) => {
          if (r === null) {
            forgetIfStale();
            return;
          }
          if (this.snapshots.peek(key) === snap)
            this.snapshots.setWeight(key, OPEN_READER_BYTES + r.retainedBytes);
        },
        () => this.dropStale(key, snap),
      );
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
   * Whether a stream reading from `snap` must resolve its segment again before its next chunk, as a read of one chunk
   * would. In this order: an invalidation has happened since `epoch` (what the store that erased stops on, at once);
   * the TTL of the snapshot's resolution has lapsed; or that resolution is no longer the segment's: another read
   * installed a newer one (a refresh, or a heal), or the resolution cache let it go. With no resolution cache (no timed
   * refresh) the last test is of the snapshot itself, so there the reader cache letting it go is a move, as it is one of
   * the few things that ever moves such a store's read on. With one, it is not. Else nothing can have moved it, and the
   * check costs a compare and a lookup in each cache.
   */
  private mayHaveMoved(key: string, snap: Snapshot, epoch: number): boolean {
    const resolution = snap.resolution as Resolution;
    if (this.invalidations !== epoch || this.expired(resolution)) return true;
    // Looked up as a read of the segment would be, which keeps a running stream's snapshot in its place in the reader
    // cache: else other reads push it out under pressure, and a read of the segment beside the stream opens it again.
    const held = this.snapshots.get(key);
    return this.resolutions === undefined
      ? held !== snap
      : this.resolutions.get(key) !== resolution;
  }

  private expired(resolution: Resolution): boolean {
    // With no timed refresh, only an eviction, a sweep's heal or `invalidate` re-resolves the segment. A registry-less
    // setup is single-process local, not the shared bucket that separate loaders publish into.
    return this.timedRefresh && this.now() - resolution.sentAtMs >= this.currentGenTtlMs;
  }

  /**
   * The segment's current generation number, as its snapshot's resolution found it: no backend read within the TTL
   * window, and no open of the object, ever. `null` if the segment has no committed generation. A generation swept from
   * under the resolution is met by the read that fetches from it, which heals ({@link withFreshSnapshot}). Since it
   * opens nothing, the only error it meets is the resolution's own, and it fails with that error at once: there is
   * nothing to heal. The reads that can open the object (`listChunkKeys`, `summary`, `currentVersion` and the rest)
   * resolve once more on any `NotFoundError`, a registry's among them, since theirs can be a swept generation.
   *
   * It is spelled out rather than delegated because a lookup like this runs once per operand of every
   * `has`/`count`/`iterate`/`intersect`, almost always served from the cached snapshot with no backend call at all.
   * Routing it through the generic helper cost ~115 ns/op on that path (a second async frame, a per-call closure, and
   * an `await` on a plain number).
   */
  async currentGeneration(ref: SegmentRef): Promise<number | null> {
    const snap = this.liveSnapshot(ref);
    const settled = snap.settled;
    if (settled !== undefined) return settled.reader?.generation ?? null;
    return (await (snap.target as Promise<Live | null>))?.target.generation ?? null;
  }

  /**
   * Forget everything derived from `ref`: its resolution, the resolved snapshot and the open reader behind it (and with
   * the reader, the DEK it unwrapped at open time), and what its pins' objects were found to be. The next read
   * resolves the segment again.
   *
   * Needed because the TTL refresh only ever answers "has the pointer moved?", and every *destructive* verb —
   * an erasure that deletes the generation holding the bit, a `dropSegment`, a crypto-shred, a retirement —
   * leaves the pointer's answer unchanged from this source's point of view while making the snapshot wrong.
   * Until this is called the source keeps serving that snapshot with no backend read at all, so nothing on the
   * storage side can close the window; with no registry, no clock or `cache.genTtlMs: 0`, nothing bounds it at all.
   */
  invalidate(ref: SegmentRef): void {
    const key = segmentKey(ref);
    this.invalidated.invalidate(key);
    this.snapshots.delete(key);
    // …and the resolution the snapshot was built on, which the next read would otherwise build a snapshot on again.
    this.resolutions?.delete(key);
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
   * `<generation>#<object>` for a registry-less source, or `<generation>:<pointerId>#<object>` with one: the generation
   * the segment's snapshot resolved, and the object a reader of it opens, by that object's size and footer checksum in
   * base 36. The row's `pointerId` moves only with a write that names a field a read resolves through, at any value, so
   * a lease or a policy write (a `setRetention`) leaves the version, the open reader and the decoded chunks as they were.
   * Two objects do not share a version string, as far as their sizes and footer checksums tell them apart, whichever way
   * a number came to name a second one: a name purged and loaded again (a new row, or with no registry the same bare
   * number), a number taken again within one row once its object was deleted, or an object put back under its key from
   * outside the library. The version is opaque: compare two for equality.
   *
   * Where the row's summary names the object, the version is answered from the resolution, with no open: every live
   * open of the generation is held to that object ({@link openLive}), refused as a move otherwise, so the one object any
   * reader of this resolution can name is the one the summary names, and a version named from it is the one that
   * reader's would be. So a `has()` whose chunk is in the chunk cache opens nothing, after the reader cache let
   * the segment go included (a read that needs the index opens the object for it, and on an encrypted segment the
   * key is unwrapped to read the row's sealed summary); an object under the number that is not the row's is met by the read that fetches from it,
   * which refuses it and heals. Where the row has no summary it can use, or there is no registry, nothing names the
   * object but the object: the reader is opened, and the version names what it opened, however long after its row read
   * that is.
   *
   * This is the call the engine makes **once per operand of every read**, before any chunk fetch, to key its chunk
   * cache, so an open it makes heals a swept generation as a read does: unhealed, a cold read racing a publish and a
   * `keep: 0` sweep failed the whole operation with `NotFoundError`, where the same race on a chunk fetch heals. Spelled
   * out rather than delegated for the reason `currentGeneration` gives: it is almost always served from the cached
   * snapshot with no backend call at all. One retry, then propagate.
   */
  async currentVersion(ref: SegmentRef): Promise<string | null> {
    const snap = this.liveSnapshot(ref);
    const settled = snap.settled;
    if (settled !== undefined) {
      return settled.reader === null ? null : versionOfReader(settled.reader);
    }
    try {
      return await this.versionOn(snap);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      this.dropStale(segmentKey(ref), snap);
      return await this.versionOn(this.liveSnapshot(ref)); // a second miss propagates
    }
  }

  /** {@link currentVersion} of one snapshot: named by the row's summary when it can be, else by the reader, opened. */
  private async versionOn(snap: Snapshot): Promise<string | null> {
    const live = await (snap.target as Promise<Live | null>);
    if (live === null) return null;
    const named = await live.version();
    if (named !== undefined) return named;
    const reader = await snap.reader;
    return reader === null ? null : versionOfReader(reader);
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
    lease?: PinLease,
  ): Promise<({ generation: number } & Required<PinnedObject>) | null> {
    validateUserRef(ref);
    for (let moved = 0; ; moved++) {
      try {
        try {
          return await this.pinOnce(ref, lease);
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
          return await this.pinOnce(ref, lease); // a second miss propagates
        }
      } catch (err) {
        if (!(err instanceof PinMoved)) throw err;
        // The pointer moved between the row read and the lease write, so the generation read is not the current one.
        if (moved >= 2) {
          throw new WriteConflictError(
            `pin: the pointer of "${ref.segment}" moved on every attempt to lease its current generation`,
          );
        }
      }
    }
  }

  /**
   * Open one named generation and verify it is the object `at.fingerprint` names, for a pin the caller reopens. One
   * row read and one tail read with a registry (none of the row for a store without one): the open is the one a
   * pinned read makes ({@link readerAt}), memoised under the version the pin will read by, so the pin's first read
   * finds it open. A generation that is gone, above the row's pointer, on a destroyed or absent row, or another
   * object than the fingerprint names, throws `NotFoundError`; nothing here reads empty.
   *
   * A generation counts as published while the pointer is at or above it. A rollback deletes nothing, so after one
   * and a later load, a generation it rolled back from can be reopened while its object is still stored and the
   * fingerprint matches. Like `pinGeneration`'s pinned reads, this opens the object without the live open's check
   * of the row's summary against it, since that check is made where the row's own generation is read.
   */
  async pinGenerationAt(
    ref: SegmentRef,
    at: { readonly generation: number; readonly fingerprint: string },
    lease?: PinLease,
  ): Promise<{ generation: number } & Required<PinnedObject>> {
    validateUserRef(ref);
    if (typeof (at as Partial<typeof at> | undefined)?.fingerprint !== 'string')
      throw new ValidationError(
        `a pin of segment "${ref.segment}" needs the fingerprint of the object it names`,
      );
    const { generation, fingerprint } = at;
    const gone = (why: string): NotFoundError =>
      new NotFoundError(
        `segment "${ref.segment}" generation ${generation} cannot be pinned: ${why}`,
      );
    let version = versionOf(generation, undefined);
    let installed: Snapshot | undefined;
    let pinKey: string | undefined;
    // Whether the pinned reader was already memoised: only an open this call makes has read what is under the key.
    let memoised = false;
    if (this.registry !== undefined) {
      const record = await this.registry.get(ref);
      if (record === null || record.status === 'destroyed')
        throw gone('the segment has no readable row');
      if (record.currentGen === null || generation > record.currentGen) {
        throw gone('it is not a published generation of this segment');
      }
      // A lease goes before the open and the verify, as a pin's does: the write is fenced on the row just read, so what
      // it holds is held from here on. For a generation below the pointer one window remains: a collector that read the
      // row before this write and deletes after it, inside its own round trip, takes the generation anyway, and the verify
      // below, or a later read, then fails with `NotFoundError`. The caller releases the lease when this throws. A lease
      // changes nothing the row resolves to, so the version is the row's as read.
      const lineage = pointerIdOf(record);
      if (lease !== undefined) {
        const taken = await lease.take(record);
        if (taken === 'moved') throw gone('the segment moved while its lease was taken');
      }
      version = versionOf(generation, lineage);
      const key = this.pinnedKey(ref, version);
      memoised = this.snapshots.peek(key) !== undefined;
      if (!memoised) {
        installed = this.install(
          key,
          Snapshot.eager(
            this.openForTarget(ref, {
              generation,
              lineage,
              wrappedDeks: record.wrappedDeks,
            }),
          ),
        );
      }
      pinKey = key;
    }
    if (this.registry === undefined) {
      memoised = this.snapshots.peek(this.pinnedKey(ref, version, fingerprint)) !== undefined;
    }
    try {
      await this.readerAt(ref, generation, { version, fingerprint });
    } catch (err) {
      // What this call opened is not the object asked for: it must not hold a place in the reader cache, and the
      // key it unwrapped, for reads that can only fail.
      if (
        installed !== undefined &&
        pinKey !== undefined &&
        this.snapshots.peek(pinKey) === installed
      ) {
        this.snapshots.delete(pinKey);
      }
      throw err;
    }
    // An open this call made has read what is under the key, so it is the pinned object now whatever an earlier check
    // found: a restore puts back what a replacement took, and a verdict kept against it would fail this pin. A reader
    // already memoised was not read by this call, and the verdict that protects the pin holding it stays. A check
    // under way ends itself when it finishes, so dropping one here only matters for a check started before this open,
    // which a test cannot hold open deterministically.
    if (!memoised) {
      const held = this.heldKey(ref, version, fingerprint);
      this.replacedPins.delete(held);
      this.checking.delete(held);
    }
    return { generation, version, fingerprint };
  }

  private async pinOnce(
    ref: SegmentRef,
    lease?: PinLease,
  ): Promise<({ generation: number } & Required<PinnedObject>) | null> {
    // Resolved FRESH, not through the snapshot memo. "The generation current right now" is the whole promise
    // of a pin, and the memo is allowed to be up to `cache.genTtlMs` behind — or, on a store with no timed refresh,
    // arbitrarily far behind. Pinning through it made a pin on such a store
    // return whatever generation the store happened to hold, however old.
    const live = await this.resolveLive(ref);
    if (live === null) return null;
    if (lease !== undefined && live.row !== undefined) {
      // The lease goes first and the open second. The write lands only while the row is the one just read, so the
      // generation was current at that instant and no collection can have taken it; every later collection reads
      // the row, and the lease with it. A lease changes nothing the row resolves to, so the row's `pointerId`, and with
      // it the version, are the ones just read: leased and unleased pins of one generation share one open.
      const taken = await lease.take(live.row);
      if (taken === 'moved') throw new PinMoved();
    }
    const target = live.target;
    const version = versionOf(target.generation, target.lineage);
    // Opened now, not at the first pinned read, so the pin knows which object it holds: a name purged and loaded
    // again starts again at generation 0, and only the object itself tells the two apart. With a registry the
    // version already does, since the row a name is loaded into again is a new row with a new `pointerId`, so every pin
    // of this version shares one open. It is installed before it resolves, so pins taken at the same moment wait on it
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
      // A memoised reader can have been opened by `pinAt`, which holds the object to the fingerprint its caller names
      // and not to the row: before this pin shares one, it is held to the fingerprint the row's summary records. One a
      // live open made was held to it already ({@link rowChecked}), so the common pin unwraps no key for it.
      let named: Promise<string | undefined> | undefined;
      const replaced = async (r: CrbmReader): Promise<boolean> => {
        if (this.replacedPins.get(this.heldKey(ref, version, r.fingerprint)) !== undefined)
          return true;
        if (this.rowChecked.has(r)) return false;
        // A keystore fault fails this pin, as it would fail a cold open of the generation, which needs the key too.
        const fingerprint = await (named ??= live.summary().then((d) => d?.fingerprint));
        if (fingerprint !== undefined && r.fingerprint !== fingerprint) return true;
        // Held to the row now: the version names the summary it was held to, so no later pin of it asks again.
        this.rowChecked.add(r);
        return false;
      };
      // A memoised reader is of the object that was under the key when it was opened. One the store has since found
      // replaced, or one of another object than the row names, is not what this pin may hold, so this pin opens the
      // object afresh, against the row, and pins taken at the same moment share that one open. The replaced pin's
      // reader goes from the memo with it, so that pin's index answers, its `count()` among them, end here: what is
      // under its key is another object now.
      const known = !opened && (await replaced(reader));
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
        if (fresh === current && (await replaced(reader))) {
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
   * a name purged and loaded again gets a new row, and with it a new `pointerId`. Without one the version is the bare
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
   * crypto-shred must not keep unwrapping a DEK whose wrapping the shred removed; a destroyed segment resolves no
   * generation
   * for anyone, and a pin's read of one fails. That holds from the pin's next open: a reader already open keeps
   * the key it unwrapped until it is evicted or invalidated.
   *
   * **And the object is checked**, when the caller says which one it pinned. A generation number is not an
   * identity (invariant 1): once a name is purged and loaded again, its new segment starts again at generation 0,
   * so a pin of the old one would open the new one's object as its own, and read it beside the chunks it had
   * already cached from the old one. The row's `pointerId` cannot tell them apart, since it moves with every write
   * that changes what the row resolves to, a publish included, while the pinned object stays what it was; the
   * object's fingerprint can, and a pin whose object has been replaced fails, as one whose generation has been swept
   * does. The memo is keyed so that two pins of one generation number in two
   * incarnations never share a reader, with a registry or without one ({@link pinnedKey}).
   */
  private async readerAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<CrbmReader | null> {
    if (
      held !== undefined &&
      (typeof held.version !== 'string' || typeof held.fingerprint !== 'string')
    )
      throw new ValidationError(
        `a pinned read of segment "${ref.segment}" generation ${generation} needs the version and the fingerprint of the object it pinned`,
      );
    const version = held?.version;
    const fingerprint = held?.fingerprint;
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
    // Re-checked at open, not captured at pin: a destroy between the two must be observed. A row that has gone
    // takes its key material with it, so there is nothing left to read under any generation.
    if (record === null || record.status === 'destroyed') return null;
    return this.openForTarget(ref, {
      generation,
      lineage: pointerIdOf(record),
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
    const reader = await this.readerAt(ref, generation, held);
    if (reader === null) return null;
    if (
      held !== undefined &&
      this.replacedPins.get(this.heldKey(ref, held.version, held.fingerprint)) !== undefined
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
      if (held === undefined) throw err;
      if (!(isIntegrityError(err) || isValidationError(err))) throw err;
      await this.throwIfReplaced(ref, generation, held.version, held.fingerprint);
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
    const reader = await this.readerAt(ref, generation, held);
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
    const reader = await this.readerAt(ref, generation, held);
    return reader === null ? null : reader.cardinalities();
  }

  /** Size of a specific generation. `held` as for {@link getChunkAt}. */
  async sizeOfAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<SegmentSize | null> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held);
    return reader === null ? null : { sizeBytes: reader.sizeBytes };
  }

  /**
   * Whether the segment is a registered name at all. With a registry: a row that is not a `destroyed` tombstone,
   * including one with no generation yet (minted by `setRetention` before the first load), which somebody deliberately
   * created. No generation resolves through a tombstone, so it answers `false`. Without a registry there is no
   * registration to
   * consult, so the honest answer is whether the bucket holds any generation of it.
   *
   * Deliberately NOT served from the snapshot memo: the memo resolves to `null` for both states this exists to
   * tell apart.
   */
  async exists(ref: SegmentRef): Promise<boolean> {
    validateUserRef(ref);
    // A `destroyed` row is a segment that was dropped, retired, crypto-shredded or destroyed in the clear: no
    // generation resolves through it, so a combine that names it is refused as one naming a segment that never was,
    // rather than read as empty. An exclude read empty suppresses
    // nobody. A row with no generation yet (a retention policy set first) still exists.
    if (this.registry !== undefined) {
      const row = await this.registry.get(ref);
      return row !== null && row.status !== 'destroyed';
    }
    for await (const key of this.driver.list(ref)) {
      void key;
      return true;
    }
    return false;
  }

  /**
   * Evict a snapshot we just failed to read from, and the resolution it was built on — each matched by identity, so a
   * concurrent call's fresher snapshot or resolution is never clobbered. The identity guard is the whole point: `install`
   * and `remember` replace an entry wholesale, so comparing anything else would drop a good one on the floor. The
   * resolution goes too, or the read's retry would build its snapshot on it again and reopen the generation it just
   * found gone; and so does a snapshot the reader cache holds on that same resolution, which another read built once the
   * cache had let `snap` go, or the retry would open that one.
   */
  private dropStale(key: string, snap: Snapshot): void {
    const resolution = snap.resolution;
    const held = this.snapshots.peek(key);
    if (held === snap || (resolution !== undefined && held?.resolution === resolution)) {
      this.snapshots.delete(key);
    }
    if (resolution !== undefined && this.resolutions?.peek(key) === resolution) {
      this.resolutions.delete(key);
    }
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
    named?: string,
    early?: Promise<TailRead>,
    hint?: SummaryDescription,
  ): Promise<CrbmReader> {
    return openChecked(
      this.driver,
      genKeyOf(ref, target),
      {
        ...this.readerOptions,
        crypto,
        lineage: target.lineage,
        ...(hint === undefined ? {} : { tailBytes: sizedTailBytes(hint, this.readerOptions) }),
      },
      this.keepChunkBytesUpTo,
      named,
      undefined,
      early,
    );
  }

  /**
   * Open the generation a resolution found, and hold the row's summary against the object: the object must be the one
   * the summary names by its fingerprint, and is refused before its index is opened otherwise, as another object under
   * the generation's number ({@link NotFoundError}, so the read resolves the row again, as for a swept generation); and
   * it should hold the same count and metadata, or the summary is not believed again in this process
   * ({@link distrusted}). Neither check costs a request. A row with no summary it can use names no object, and its
   * generation's object is opened as it is.
   *
   * An encrypted generation's tail read is sent first, beside the key, because the key (a keystore call, a network
   * round trip for a KMS keystore) and the tail are independent: only the index needs the key, and it comes out of the
   * tail. The row's summary of an encrypted generation is sealed under the same key, so it is read after the key. The
   * open then holds the footer to the summary and decrypts, as an open that waited for the key does, and nothing of the
   * tail is read before then. The key is awaited first, so a keystore fault reaches the caller before a storage fault,
   * and the request already sent is not cancelled: it is billed, and its answer or failure is dropped when the key
   * fails.
   *
   * A cleartext generation's tail read is sized from the `tailBytes` of that summary ({@link sizedTailBytes}), so a
   * generation whose index is longer than the default tail comes in the one read, with no range read for the index
   * after it. Only a summary this process still believes sizes a read ({@link trustedSummary}): one found to disagree
   * with its object is not used again, so a wrong number costs one extra read for the process, not for each open. An
   * encrypted generation is not sized: its summary is sealed under the key, so sizing from it would send the tail read
   * after the key, which the early read above avoids where no earlier step has already waited for the key (a cold
   * `has()` has).
   */
  private async openLive(ref: SegmentRef, live: Live): Promise<CrbmReader> {
    const wrapped = live.target.wrappedDeks;
    const keyed = wrapped !== undefined && wrapped.length > 0;
    const early =
      this.keystore !== undefined && keyed
        ? startTailRead(this.driver, genKeyOf(ref, live.target), {
            ...this.readerOptions,
            lineage: live.target.lineage,
          })
        : undefined;
    const crypto = await live.crypto();
    const summary = await live.summary();
    const hint = keyed ? undefined : await this.trustedSummary(ref, live);
    const reader = await this.openGeneration(
      ref,
      live.target,
      crypto,
      summary?.fingerprint,
      early,
      hint,
    );
    this.rowChecked.add(reader);
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
  ): Promise<SummaryDescription | undefined> {
    if (
      this.distrusted.peek(this.distrustKey(ref, live.target.generation, live.target.lineage)) !==
      undefined
    ) {
      return undefined;
    }
    return live.summary();
  }

  /**
   * What the segment resolves to now: the fields of the registry's authoritative record a read resolves through (one
   * strong read), or the highest generation a `list` of the bucket finds when there is no registry (a registry-less
   * source can only read cleartext: there is nowhere a wrapped DEK could live). `null` for no generation.
   */
  private async resolve(ref: SegmentRef): Promise<Resolved | null> {
    if (this.registry !== undefined) return resolvedOf(await this.registry.get(ref));
    let maxGen = -1;
    for await (const key of this.driver.list(ref)) {
      if (key.generation > maxGen) maxGen = key.generation;
    }
    return maxGen < 0 ? null : { generation: maxGen };
  }

  /**
   * The segment resolved afresh for a pin, with the row it read, which a lease is written against. Never a kept
   * resolution, and kept nowhere: the generation current right now is the whole promise of a pin.
   */
  private async resolveLive(ref: SegmentRef): Promise<Live | null> {
    if (this.registry === undefined) {
      const resolved = await this.resolve(ref);
      return resolved === null ? null : this.liveOf(ref, resolved, null);
    }
    const row = await this.registry.get(ref);
    const resolved = resolvedOf(row);
    return resolved === null || row === null ? null : this.liveOf(ref, resolved, null, row);
  }

  /**
   * What a snapshot, or a pin, makes of a resolution: its decryption context and what the row's summary says of the
   * generation, each made only when asked for. A snapshot that replaces `prior` with the same wrapped keys keeps the key
   * `prior` unwrapped, so a count polling an encrypted segment asks the keystore once, not once each `genTtlMs`.
   * Different keys (a shred, a re-created name) unwrap afresh, and so does a snapshot with no prior: the resolution
   * holds the wrapped keys, never an unwrapped one.
   */
  private liveOf(
    ref: SegmentRef,
    resolved: Resolved,
    prior: Live | null,
    row?: RegistryRecord,
  ): Live {
    if (this.registry === undefined) {
      return {
        target: resolved,
        crypto: () => Promise.resolve(undefined),
        unwrap: undefined,
        summary: () => Promise.resolve(undefined),
        version: () => Promise.resolve(undefined),
        bytes: weightOf(resolved),
      };
    }
    const { generation, lineage, wrappedDeks: keys, summary } = resolved;
    const unwrap =
      keys === undefined || keys.length === 0 || this.keystore === undefined
        ? undefined
        : prior?.unwrap !== undefined && sameKeys(prior.target.wrappedDeks, keys)
          ? prior.unwrap
          : once(() => (this.keystore as IKeystore).openDek(keys));
    const crypto = once(() => this.cryptoForRead(ref, generation, keys, unwrap));
    // The same checks as a read of the object makes (`requireEncryption`, a keystore for an encrypted row) come first,
    // then the row's summary, used only if it names this generation in the shape the keys call for.
    const described = once(async () =>
      usableSummary(
        ref,
        { status: 'active', currentGen: generation, summary, wrappedDeks: keys },
        (await crypto())?.aead,
      ),
    );
    return {
      target: resolved,
      ...(row === undefined ? {} : { row }),
      crypto,
      unwrap,
      summary: described,
      version: once(async () => {
        const named = (await described())?.fingerprint;
        return named === undefined
          ? undefined
          : `${versionOf(generation, lineage)}#${compactFingerprint(named)}`;
      }),
      bytes: weightOf(resolved),
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
        `segment "${ref.segment}" is encrypted, and the store reading it was built with no keystore (encryption.keystore)`,
      );
    }
    const aead = await (unwrap ?? (() => keystore.openDek(wrappedDeks)))();
    return { aead, aadFor: (scope) => aadFor(ref, generation, scope) };
  }

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    validateChunkRef(ref);
    return this.withFreshSnapshot(ref, (reader) => reader.getChunk(ref.chunkKey), null);
  }

  /**
   * Several chunks as a stream, in as few storage requests as {@link CrbmReader.readChunks} can make them (see
   * {@link StorageChunkSource.getChunks}). The stream is served from one resolved generation, and every chunk says
   * which version it came from. A generation swept, or an object replaced under its number, while the stream runs
   * re-resolves the segment and carries on with the keys not yet yielded from whatever is current then, so each chunk
   * is whole and from one generation and the stream may describe two; a second failure with no chunk yielded in between
   * propagates. `options.retry` runs the resolution, each range request and the check that a failed read's object was
   * replaced, so a transient fault repeats that step alone. Nothing is resolved until the first chunk is asked for.
   */
  async *getChunks(
    ref: SegmentRef,
    keys: readonly number[],
    options?: ReadChunksOptions,
  ): AsyncGenerator<ChunkRead> {
    validateRead(ref, keys);
    const retry = options?.retry;
    const key = segmentKey(ref);
    let yielded = 0;
    let healed = false; // a heal since the last chunk yielded
    for (;;) {
      const at = this.resolution(ref);
      let epoch = this.invalidations;
      let chunks: ChunkStream | undefined;
      try {
        const reader = await this.resolveReader(ref, retry, at);
        if (reader === null) {
          for (; yielded < keys.length; yielded++) {
            yield { key: keys[yielded]!, bytes: null, version: null };
          }
          return;
        }
        // The version names the object this stream reads, as `currentVersion` does: chunks of an object replaced under
        // the same number and token, read after a heal, carry another version than the ones read before it.
        const version = versionOfReader(reader);
        // What the open of the snapshot this stream last compared itself with had come to: when that snapshot's
        // reader opens later, the stream compares again, since it can be another object under the same name.
        let seen = at.snap.settled;
        chunks = reader.readChunks(keys.slice(yielded), this.readOptionsOf(options));
        // Pulled by hand, not by `for await`: a loop binding would keep the chunk just yielded (a view into a range, or
        // a decrypted chunk) alive while the next one is awaited.
        const pull = new ItemPull(chunks);
        let movedOn = false;
        try {
          while (await pull.advance()) {
            // Before a chunk is handed out, the segment is resolved as a read of that chunk alone would resolve it: a
            // `cache.genTtlMs` boundary, the reader cache having let the segment go, an invalidation, and a newer
            // snapshot another read installed each leave the snapshot this stream was opened on no longer the live
            // one. If that moved the segment to another generation or incarnation, or to none, nothing more is served
            // from this stream: its ranges are dropped and the keys not yet yielded are read afresh. The live snapshot
            // is compared by its reader where one has opened, which names the object, and otherwise by its resolution
            // (the registry's row, or a listing of the bucket with no registry), so the stream neither opens an object
            // nor waits on another read's open to learn it. A snapshot taken on by its resolution is compared again
            // once its reader opens: a reader opened after its row read can be another object under the same name,
            // which the rest of the read, a chunk served from the cache among it, reads from then on. An open that
            // failed is forgotten by the reader cache, so the stream meets a new snapshot. A fault in resolving starts
            // the stream over at the top, where a caller's retry runs the resolution.
            if (this.mayHaveMoved(key, at.snap, epoch) || at.snap.settled !== seen) {
              const live = this.liveSnapshot(ref);
              if (live !== at.snap || live.settled !== seen) {
                const looked = live.settled;
                let same: boolean;
                try {
                  same = await readsObjectOf(live, reader);
                } catch (err) {
                  if (!isTransientError(err)) throw err;
                  movedOn = true;
                  break;
                }
                if (!same) {
                  movedOn = true;
                  break;
                }
                at.snap = live;
                seen = looked;
              }
              epoch = this.invalidations;
            }
            // Counted as it is handed out: the next thing to happen to the stream is the consumer asking for more.
            yield pull.take((chunk) => {
              yielded += 1;
              healed = false;
              return { ...chunk, version };
            });
          }
        } finally {
          await pull.close();
        }
        if (!movedOn) return;
        // The ranges the dropped stream still has in flight finish first, so the next stream's window does not open
        // beside them.
        await chunks.settled();
        healed = false;
        continue;
      } catch (err) {
        // Each heal needs a chunk yielded since the last, so a stream heals at most once per range it reads (a heal
        // plans the keys that remain again). The two misses that are recoverable, as for a single chunk: a
        // generation swept from under the snapshot, and one whose object was replaced under the same number.
        // Anything else propagates at once, and so does a second miss with no chunk in between.
        if (healed) throw err;
        if (!isNotFoundError(err) && !(await this.replacedUnder(ref, at.pending, err, retry)))
          throw err;
        // Only a heal waits: the ranges the failed stream still has in flight finish first, so the new stream's
        // window does not open beside them.
        await chunks?.settled();
        this.dropStale(key, at.snap);
        healed = true;
      }
    }
  }

  /**
   * {@link getChunks} of a specific generation, the pinned shape read. It yields the chunks without a version: the
   * caller that pinned the generation knows it. It never moves to another generation; `held` as for
   * {@link getChunkAt}.
   *
   * Before it hands out a chunk after an {@link invalidate}, it looks its generation up as a read of that chunk alone
   * would. Where the invalidation was of its segment, which forgets the pinned reader, it opens the object again, and
   * fails as that read would, with `NotFoundError` once the object is gone or replaced, or its row is gone or
   * destroyed. An object still there is the one it was reading, since an object is immutable and the open is held to
   * the pin, so the stream carries on with the ranges it holds. Another segment's invalidation costs it nothing, the
   * pin's reader still in the reader cache or not, and with no invalidation since it last looked the check is a
   * compare. The one exception is a store that invalidates more than 1,024 other segments while the stream runs: the
   * record of invalidations then counts the stream's segment as invalidated too, and the stream looks its pin up
   * again, at no cost where the reader cache still holds the pin's reader and with one open where it has let it go.
   */
  async *getChunksAt(
    ref: SegmentRef,
    generation: number,
    keys: readonly number[],
    held?: PinnedObject,
    options?: ReadChunksOptions,
  ): AsyncGenerator<Omit<ChunkRead, 'version'>> {
    validateRead(ref, keys);
    const retry = options?.retry;
    const open = (): Promise<CrbmReader | null> => this.readerAt(ref, generation, held);
    const segment = segmentKey(ref);
    let since = this.invalidated.epoch;
    const reader = await viaRetry(retry, open);
    if (reader === null) {
      for (const key of keys) yield { key, bytes: null };
      return;
    }
    if (
      held !== undefined &&
      this.replacedPins.get(this.heldKey(ref, held.version, held.fingerprint)) !== undefined
    )
      throw notThePinned(ref, generation);
    try {
      // Pulled by hand, as in getChunks: `yield*` would keep the chunk just yielded while the next is awaited.
      const pull = new ItemPull(reader.readChunks(keys, this.readOptionsOf(options)));
      try {
        while (await pull.advance()) {
          if (this.invalidated.invalidatedSince(segment, since)) {
            // Looked up as a read of the generation would be: the invalidation forgot the pin's reader, so it is opened
            // again. The count is taken first, so an invalidation that lands while it opens is met at the next chunk.
            since = this.invalidated.epoch;
            if ((await viaRetry(retry, open)) === null) throw goneUnder(ref, generation);
          }
          yield pull.take((chunk) => chunk);
        }
      } finally {
        await pull.close();
      }
    } catch (err) {
      // As for a single chunk ({@link getChunkAt}): a pin's reader outlives its object when the name is purged and
      // loaded again, and its index then points into bytes that are not its own.
      if (held === undefined) throw err;
      if (!(isIntegrityError(err) || isValidationError(err))) throw err;
      const check = (): Promise<void> =>
        this.throwIfReplaced(ref, generation, held.version, held.fingerprint);
      await viaRetry(retry, check);
      throw err;
    }
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
   * With no summary it can use (a row written without one, one for another generation, one that does not open), it
   * opens the generation and answers from the object. A row that names an object that is gone, or another object
   * under the number, still answers, while a read of the object throws: the number is true of the generation the row
   * names.
   *
   * What the row says is not confirmed here: a summary edited to agree with itself by whoever can write the row is
   * believed until the next time the object is opened, which holds it against the summary.
   */
  async summary(ref: SegmentRef): Promise<GenerationSummary | null> {
    validateUserRef(ref);
    return this.described(
      ref,
      (generation, row) => summaryOfGeneration(generation, row),
      (reader) => summaryOfGeneration(reader.generation, describe(reader)),
    );
  }

  /**
   * What one resolution of the segment says of its generation: from the row's summary when this process may use it,
   * else from the generation's object, opened. `null` for no generation. One heal, as a read of the object has: a
   * generation swept from under the snapshot, or replaced under its number, is resolved again once.
   */
  private async described<T>(
    ref: SegmentRef,
    fromRow: (generation: number, row: SummaryDescription) => T,
    fromObject: (reader: CrbmReader) => T,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const snap = this.liveSnapshot(ref);
      try {
        const live = await (snap.target as Promise<Live | null>);
        if (live === null) return null;
        const row = await this.trustedSummary(ref, live);
        if (row !== undefined) return fromRow(live.target.generation, row);
        const reader = await snap.reader;
        return reader === null ? null : fromObject(reader);
      } catch (err) {
        if (attempt === 1) throw err;
        // A fault that is neither a miss nor corruption (a keystore's, say) is not asked about again: reading the
        // snapshot's reader here would call the keystore a second time.
        if (
          !isNotFoundError(err) &&
          !(
            (isIntegrityError(err) || isValidationError(err)) &&
            (await this.replacedUnder(ref, snap.reader, err))
          )
        )
          throw err;
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
    const reader = await this.readerAt(ref, generation, held);
    return reader === null ? null : summaryOfGeneration(reader.generation, describe(reader));
  }

  /**
   * The current generation's number, id count and metadata, with its object's size, all from one resolution. The answer
   * comes from the row when it can, as {@link summary}'s does: the row's summary of the generation it names, whose
   * fingerprint carries the object's size. That is one registry read when the snapshot is cold, none when it is warm,
   * and no read of the object; on an encrypted segment the key is unwrapped to open the summary, as for a count. With no
   * summary it can use, it opens the generation and answers from its footer and index, with no payload read: a tail read
   * more when cold. A row that names an object that is gone, or another object, still answers from the row: the figures
   * are the generation's the row names, and `checkConsistency` is what finds such a row.
   */
  async stat(ref: SegmentRef): Promise<(GenerationSummary & SegmentSize) | null> {
    validateUserRef(ref);
    return this.described<GenerationSummary & SegmentSize>(
      ref,
      (generation, row) => ({
        ...summaryOfGeneration(generation, row),
        sizeBytes: sizeOfFingerprint(row.fingerprint),
      }),
      (reader) => sizedSummary(reader),
    );
  }

  /** {@link stat} of a specific generation, from the object a pin holds. `held` as for {@link getChunkAt}. */
  async statAt(
    ref: SegmentRef,
    generation: number,
    held?: PinnedObject,
  ): Promise<(GenerationSummary & SegmentSize) | null> {
    validateUserRef(ref);
    const reader = await this.readerAt(ref, generation, held);
    return reader === null ? null : sizedSummary(reader);
  }

  /**
   * Run `read` against the pinned snapshot, healing the torn-read window generation GC can open: if the
   * generation we resolved was superseded *and* swept (the grace window elapsed), the Storage driver throws
   * {@link NotFoundError}. Surfacing that as a query failure would turn a benign, recoverable race into a
   * caller-visible error, so instead we drop the stale snapshot,
   * re-resolve `currentGen`, and retry once — the read then serves the newer (committed, immutable) generation,
   * a monotonic move forward — within one incarnation of the row. A name that was retired and re-created is a
   * different segment and can resolve to a LOWER generation, which is why the snapshot carries the row's
   * `pointerId` as its lineage rather than trusting the generation number (invariants 1 and 2).
   *
   * **Resolution and open are inside the retry, not before it.** Resolving `currentGen` and opening that
   * generation's object are two backend round trips with a gap between them, so the object can be swept after
   * the registry named it and before its tail is read — and that miss surfaces from awaiting the snapshot, not
   * from `read`. Awaiting outside the retry left the *first* attempt unhealed on the one path GC actually
   * races: `keep: 0`, which every id erasure passes, sweeps microseconds after the publish.
   *
   * A *second* NotFound is pathological (GC outrunning resolution) and propagates rather than fabricating an
   * absent answer — never return a wrong result. `ifGone` is returned when the segment has no committed
   * generation to serve: storage is empty, or the row is destroyed (crypto-shredded, destroyed in the clear or
   * dropped), in which case
   * reading empty is the documented outcome rather than a failure.
   *
   * **Bounded to exactly two resolve-and-open round trips.** That is a cost contract, not a detail: the retry
   * re-reads the *registry*, so an unbounded one would hammer the shared, throttle-prone resource in a
   * tight loop on a segment whose pointer names an object that is permanently absent — and an N-way
   * `intersect` would do it N times. Gated in `tests/core/storage-source-heal-open.test.ts` by counting calls.
   */
  private async withFreshSnapshot<T>(
    ref: SegmentRef,
    read: (reader: CrbmReader) => T | Promise<T>,
    ifGone: T,
    retry?: Retry,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = this.resolution(ref);
      try {
        const reader = await this.resolveReader(ref, retry, at);
        if (reader === null) return ifGone;
        return await read(reader);
      } catch (err) {
        // Two misses are recoverable here, and only on the first try: a generation swept from under the snapshot,
        // and one whose object was replaced under the same number (see `replacedUnder`). Anything else
        // (corruption, a real second miss) propagates.
        if (attempt === 1) throw err;
        if (!isNotFoundError(err) && !(await this.replacedUnder(ref, at.pending, err, retry)))
          throw err;
        this.dropStale(segmentKey(ref), at.snap); // lazily: the happy path never needs the key
      }
    }
    return ifGone;
  }

  /** The live snapshot of `ref` and the reader it is opening, as a read holds them while it resolves. */
  private resolution(ref: SegmentRef): Resolving {
    const snap = this.liveSnapshot(ref);
    return { snap, pending: snap.reader };
  }

  /**
   * The reader `at` resolves to. A caller that retries has the resolution and open run through its `retry`; a failed
   * one forgets itself, so each try resolves anew and `at` is moved to the snapshot that try resolved.
   */
  private resolveReader(
    ref: SegmentRef,
    retry: Retry | undefined,
    at: Resolving,
  ): Promise<CrbmReader | null> {
    if (retry === undefined) return at.pending;
    let tried = false;
    return retry(() => {
      if (tried) {
        at.snap = this.liveSnapshot(ref);
        at.pending = at.snap.reader;
      }
      tried = true;
      return at.pending;
    });
  }

  /** The options a chunk stream is read with: the caller's tuning, its retry for each range, and this source's clock. */
  private readOptionsOf(
    options: ReadChunksOptions | undefined,
  ): Parameters<CrbmReader['readChunks']>[1] {
    return {
      ...(options?.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options?.ramp === undefined ? {} : { ramp: options.ramp }),
      ...(options?.retry === undefined ? {} : { readRange: options.retry }),
      ...(options?.onRequest === undefined ? {} : { onRequest: options.onRequest }),
      now: () => this.now(),
    };
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
    retry?: Retry,
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
      const check = (): Promise<boolean> =>
        CrbmReader.sameObject(storageBlobReader(this.driver, at), reader.fingerprint);
      return !(await (retry === undefined ? check() : retry(check)));
    } catch (checkErr) {
      if (isNotFoundError(checkErr)) return true;
      if (isTransientError(checkErr)) throw checkErr;
      return false;
    }
  }
}
