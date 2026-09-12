/**
 * Storage-driver contracts the engine depends on.
 *
 * Two tiers and one pointer. **Cold** is immutable object storage holding `.crbm` generations (`IColdDriver`,
 * read by the engine through the per-chunk `ColdChunkSource` view the `.crbm` reader implements); the
 * **registry** is the authoritative per-segment record — which generation is current, the wrapped DEKs, the
 * governance metadata — under optimistic concurrency (`IRegistryDriver`). Drivers move opaque bytes and OCC
 * tokens; they never understand roaring or the `.crbm` layout.
 */

import type { BlobSink } from './blob';
import type { WrappedDek } from './crypto';

/** Opaque optimistic-concurrency token — unique per write, compared by equality only. */
export type Token = string;

export interface SegmentRef {
  readonly namespace?: string;
  readonly segment: string;
}

export interface ChunkRef extends SegmentRef {
  readonly chunkKey: number;
}

/** Identifies one immutable `.crbm` object — a single generation of a segment. */
export interface GenKey extends SegmentRef {
  readonly generation: number;
}

/**
 * A segment's grounded on-disk footprint — the current generation's Cold object bytes, read cheaply from the
 * `.crbm` footer/index (no payload reads). Powers the grounded `costReport()`.
 */
export interface SegmentSize {
  readonly sizeBytes: number;
}

/** Per-chunk read view of the immutable Cold tier (implemented by the `.crbm` reader). */
export interface ColdChunkSource {
  /** Read-only bytes for the chunk, or `null` if absent. Callers must not mutate the buffer. */
  getChunk(ref: ChunkRef): Promise<Uint8Array | null>;
  listChunkKeys(ref: SegmentRef): Promise<number[]>;
  /**
   * Optional: the current generation's grounded size, cheaply (from the already-parsed `.crbm` index — no
   * payload reads), or `null` if the segment has no Cold generation. Powers the grounded `costReport()`.
   */
  sizeOf?(ref: SegmentRef): Promise<SegmentSize | null>;
  /**
   * Optional: the current generation's **per-chunk cardinality** (`chunkKey → count`), read from the
   * already-parsed `.crbm` index with **no payload reads**, or `null` if the segment has no Cold generation.
   * Powers the free `count()` — the engine sums the index instead of fetching a single chunk. A source with no
   * index (e.g. the in-memory source) omits this, and `count()` falls back to fetching every chunk.
   */
  cardinalities?(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null>;
  /**
   * Optional: the segment's **current generation number** as this source resolves it right now (registry
   * `currentGen`, or the highest cold generation), or `null` if the segment has no Cold generation. The engine
   * keys its HOT chunk cache by this so a generation bump (a load's publish) is observed — a new generation
   * misses the cache instead of serving a stale decoded chunk, and an erased id can't resurrect from a cached
   * superseded chunk. Cheap: served from the source's own (short-TTL-refreshed) snapshot, **not** a fresh
   * backend read per call. A source that pins one immutable generation for its whole lifetime and never
   * refreshes may omit this — the engine then keys the cache without a generation.
   */
  currentGeneration?(ref: SegmentRef): Promise<number | null>;
  /**
   * Optional: forget everything this source has derived from `ref` — its resolved snapshot, its open reader,
   * and any key material that reader captured — so the next read resolves from the registry again.
   *
   * The TTL refresh and the generation-keyed chunk cache are both built for **a publish that advances
   * `currentGen`**. Neither covers an event that *destroys* what the cache was derived from: an erasure that
   * deletes the generation holding the bit, a `dropSegment`, a crypto-shred, a retirement. After one of those
   * a source that had already resolved the segment keeps answering from memory — with no backend read at all,
   * so no storage-side control can close the window — until its TTL lapses, and **never** if it has no clock
   * or `coldGenTtlMs: 0` ("pin forever").
   *
   * Callers that destroy or retire a segment must call this. It is synchronous and best-effort: dropping
   * memoized state cannot fail, and a source that memoizes nothing may omit the method entirely.
   */
  invalidate?(ref: SegmentRef): void;
  /**
   * Optional: does this segment **exist as a registered name**, as distinct from resolving to no generation?
   *
   * `currentGeneration` collapses two very different states into `null`: a name nobody ever created, and a
   * segment that exists and is legitimately empty. For a *read* that distinction does not matter — both answer
   * empty. For an **operand of a combine** it is the difference between a suppression list with nobody on it
   * yet and a suppression list you misspelled, and those must not look alike: the first correctly suppresses
   * nothing, the second silently suppresses nothing while you believe it is working.
   *
   * Consulted **only** when an operand resolved to no chunks at all, so a normal combine never calls it.
   */
  exists?(ref: SegmentRef): Promise<boolean>;
}

/** Capabilities a Cold driver advertises; validated at wiring time, fail-fast. */
export interface ColdCaps {
  /** REQUIRED — the format relies on byte-range reads. */
  readonly rangeRead: true;
  /** Largest single object the backend accepts (informs single-object-vs-shard — future). */
  readonly maxObjectBytes: number;
  /** Optional: enables the pure-object `LATEST`-pointer registry variant (S3 conditional put). */
  readonly conditionalPut?: boolean;
}

/**
 * Immutable object storage for `.crbm` generations. A "dumb byte mover": it
 * understands neither roaring nor the `.crbm` layout, only opaque bytes addressed by a {@link GenKey}.
 * The core never reuses a key, so puts are write-once.
 */
export interface IColdDriver {
  capabilities(): ColdCaps;
  /**
   * Stream a new immutable generation. The driver opens a destination, hands `write` a {@link BlobSink},
   * then atomically commits (and computes the content hash). Throws if the key already exists (write-once).
   */
  putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }>;
  /** Range read; the caller bounds-checks. Out-of-range is rejected, never a short/adjacent read. */
  getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array>;
  /** Speculative tail read: the last `min(maxBytes, size)` bytes + the total object size. */
  getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }>;
  delete(key: GenKey): Promise<void>;
  /** Enumerate the generations present for a segment (orphan sweep / latest-gen resolution). */
  list(ref: SegmentRef): AsyncIterable<GenKey>;
}

/**
 * Lifecycle status of a segment. `active` is the steady state; `destroyed` is the post-crypto-shred tombstone
 * (the row is kept for audit but the segment is logically gone). `compacting`/`erasing` are **reserved** —
 * stored and round-tripped so a row written by an earlier build still reads, but no writer in this build sets
 * them.
 */
export type RegistryStatus = 'active' | 'compacting' | 'erasing' | 'destroyed';

/**
 * Free-form, JSON-serializable governance metadata — a **plain object** (both registry boundaries reject `null`,
 * an array or a primitive, because a reader that tests `'key' in meta` would throw an untyped `TypeError`).
 *
 * `retention` has one **reserved key with defined semantics**: `expiresAt`, an absolute epoch-ms after which a
 * retention sweep may retire the segment — written by `setSegmentRetention`, parsed by `readRetentionPolicy`. Any
 * other key is yours (a legal hold, a note, an owner) and is preserved across policy writes. `residency` is still
 * shape-later: stored and round-tripped, no semantics attached.
 */
export type GovernanceMeta = Record<string, unknown>;

/**
 * One registry row — the authoritative per-segment record. Exactly one per segment.
 */
export interface RegistryRecord extends SegmentRef {
  /**
   * **The** authoritative LATEST pointer: which immutable Cold generation is current — or **`null` for a segment
   * that has no Cold generation yet.**
   *
   * `null` is not "unknown", it is a positive statement: *this segment exists and has no Cold data.* It is what
   * lets a segment have a registry row **before its first load** — `setSegmentRetention` mints one so a policy
   * can be recorded ahead of the data, and so the segment is reachable by `registry.list()` and therefore by
   * retention sweeps, `checkConsistency` and every other fleet-wide operation. The alternative — a row with
   * `currentGen: 0` and no object behind it — is the forbidden `missing-cold-generation` state, which fails per
   * read with `NotFoundError`. Generation resolution maps `null` onto the same path a segment with **no row**
   * takes: every read answers empty, and the first publish advances the pointer.
   */
  readonly currentGen: number | null;
  /**
   * Per-segment data-key (DEK) wrappings for encryption-at-rest: the DEK envelope-wrapped under one or more KEKs
   * (active + optional recovery). Reading unwraps with any held KEK; **crypto-shred deletes this whole list**,
   * making the segment's at-rest bytes permanently unrecoverable. Absent ⇒ the segment is cleartext.
   */
  readonly wrappedDeks?: readonly WrappedDek[];
  /**
   * Optional **external** key reference (reserved) — e.g. a KMS key ARN for a future KMS keystore adapter that
   * keeps wrapped material in the KMS rather than in-band {@link wrappedDeks}. Unused by the in-process BYOK
   * keystore. Clearable on crypto-shred.
   */
  readonly keyId?: string;
  readonly status: RegistryStatus;
  /**
   * Governance policy. `retention.expiresAt` drives the retention sweep (see {@link GovernanceMeta}); `residency`
   * is stored and round-tripped with no semantics yet. Both must be plain objects, and both must survive a
   * `list()` projection — a fleet sweep reads the policy from the enumeration rather than per-segment.
   */
  readonly retention?: GovernanceMeta;
  readonly residency?: GovernanceMeta;
  /** Epoch-ms of creation / last mutation (from the driver's injected clock). */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Opaque OCC token — compare-by-equality, never reused (ABA-safe). */
  readonly token: Token;
}

/** The caller-settable fields at {@link IRegistryDriver.create} (audit + token are driver-managed). */
export interface NewRegistryRecord {
  /** `null` ⇒ the segment has no Cold generation yet — see {@link RegistryRecord.currentGen}. */
  readonly currentGen: number | null;
  readonly wrappedDeks?: readonly WrappedDek[];
  readonly keyId?: string;
  /** Defaults to `'active'`. */
  readonly status?: RegistryStatus;
  readonly retention?: GovernanceMeta;
  readonly residency?: GovernanceMeta;
}

/** Fields a {@link IRegistryDriver.compareAndSwap} may mutate (identity + audit + token are off-limits). */
export type RegistryPatch = Partial<
  Pick<
    RegistryRecord,
    'currentGen' | 'wrappedDeks' | 'keyId' | 'status' | 'retention' | 'residency'
  >
>;

/** Capabilities a registry driver advertises; validated fail-fast at wiring time. */
export interface RegCaps {
  /** REQUIRED — `currentGen` feeds read correctness + the publish CAS, so reads must be strongly consistent. */
  readonly strongRead: true;
}

/**
 * Per-segment registry — the authoritative source of `currentGen`, the discovery index, and the wrapped-DEK
 * holder. One row per segment under OCC: a never-reused, equality-compared {@link Token} (ABA-safe across
 * delete→recreate).
 */
export interface IRegistryDriver {
  capabilities(): RegCaps;
  /** The segment's record, or `null` if it doesn't exist (or was deleted). */
  get(ref: SegmentRef): Promise<RegistryRecord | null>;
  /** Create the row; throws {@link WriteConflictError} if it already exists (use CAS to mutate). */
  create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }>;
  /** Server-side compare-and-set: apply `patch` iff the stored token equals `expected`, else `WriteConflictError`. */
  compareAndSwap(ref: SegmentRef, expected: Token, patch: RegistryPatch): Promise<{ token: Token }>;
  /**
   * Discovery: every **existing** record, optionally scoped to one namespace. Order is unspecified.
   *
   * "Existing" means not `delete`d. A **`destroyed` tombstone is still a record and must be yielded** — a driver
   * that filters by `status` breaks callers silently, and two already depend on seeing them: `runConsistencyCheck`
   * skips them itself, and the retention sweep can only clean up a tombstone row it can see (filtering it makes
   * the cleanup a permanent no-op, indistinguishable from having nothing to do, while dead rows accumulate). Same
   * rule for every other field: a row with **`currentGen: null`** must be yielded like any other, and `retention`
   * must survive the projection — a fleet sweep reads the policy straight out of this enumeration rather than
   * paying a `get()` per segment, so a `list()` that drops the field means nothing ever expires, silently.
   */
  list(namespace?: string): AsyncIterable<RegistryRecord>;
  /** Remove the row (tombstoned for ABA-safety — a later `create` still gets a fresh, greater token). */
  delete(ref: SegmentRef): Promise<void>;
}
