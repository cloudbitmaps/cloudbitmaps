/**
 * Storage-driver contracts the engine depends on.
 *
 * Two tiers and one pointer. **Storage** is immutable object storage holding `.crbm` generations (`IStorageDriver`,
 * read by the engine through the per-chunk `StorageChunkSource` view the `.crbm` reader implements); the
 * **registry** is the authoritative per-segment record — which generation is current, the wrapped DEKs, the
 * governance metadata — under optimistic concurrency (`IRegistryDriver`). Drivers move opaque bytes and OCC
 * tokens; they never understand roaring or the `.crbm` layout.
 */

import { UnsupportedError, ValidationError } from './errors';
import type { BlobSink } from './blob';
import type { WrappedDek } from './crypto';

/** Opaque optimistic-concurrency token — unique per write, compared by equality only. */
export type Token = string;

/**
 * The address of one segment: a `namespace` and a `segment` name, both any non-empty string of at most 256
 * characters once encoded for storage. Omitting the namespace addresses a different segment from one that names it.
 *
 * **A namespace starting with `cbm.due.` is reserved**, and every call of the store, and of the free functions
 * behind it, that takes a ref or a `namespace` option throws `ValidationError` for one. The library keeps the due
 * index there (one pointer row per expiring segment), and every fleet-wide scan skips those rows as bookkeeping, so a
 * segment in such a namespace would be invisible to an erasure, a consistency check, an export and a retention sweep.
 * A driver takes the prefix, since the due index's own rows go through it. Only that exact prefix is reserved:
 * `cbm.dueX` and `cbmdue.eu` are ordinary namespaces, and a segment name is never restricted.
 */
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
 * A segment's grounded on-disk footprint — the current generation's Storage object bytes, read cheaply from the
 * `.crbm` footer/index (no payload reads). Powers the grounded `costReport()`.
 */
export interface SegmentSize {
  readonly sizeBytes: number;
}

/**
 * What {@link StorageChunkSource.getChunks} answers: the chunks, aligned with the keys asked for (`null` where the
 * generation has none), and the version of the one generation they were all read from, or `null` when the segment
 * has no generation. The version is what {@link StorageChunkSource.currentVersion} reports for that generation,
 * so a caller can key what it keeps by the generation the bytes came from rather than the one it resolved earlier.
 */
export interface ChunksRead {
  readonly version: string | null;
  readonly chunks: readonly (Uint8Array | null)[];
}

/** Options of {@link StorageChunkSource.getChunks}. */
export interface ReadChunksOptions {
  /**
   * Runs one storage request, and may run it again if it fails. A source passes each request it makes through
   * this, so a caller that retries transient faults repeats the one request that failed, not the ones that landed.
   * Absent, each request runs once.
   */
  readonly retry?: <T>(request: () => Promise<T>) => Promise<T>;
}

/** Per-chunk read view of the immutable Storage tier (implemented by the `.crbm` reader). */
export interface StorageChunkSource {
  /** Read-only bytes for the chunk, or `null` if absent. Callers must not mutate the buffer. */
  getChunk(ref: ChunkRef): Promise<Uint8Array | null>;
  listChunkKeys(ref: SegmentRef): Promise<number[]>;
  /**
   * Optional: several chunks of one segment in one call, answered **from one generation**, with fewer storage
   * requests than one per chunk where the chunks sit near each other in the object. `keys` are chunk keys; the
   * answer lines up with them ({@link ChunksRead}), and a key the generation does not hold answers `null`, as
   * {@link StorageChunkSource.getChunk} does. Each chunk is checked as a read of it alone is. A source that cannot
   * read a range of an object (the in-memory source) omits this, and a caller reads chunk by chunk.
   */
  getChunks?(
    ref: SegmentRef,
    keys: readonly number[],
    options?: ReadChunksOptions,
  ): Promise<ChunksRead>;
  /**
   * Optional: the current generation's grounded size, cheaply (from the already-parsed `.crbm` index — no
   * payload reads), or `null` if the segment has no Storage generation. Powers the grounded `costReport()`.
   */
  sizeOf?(ref: SegmentRef): Promise<SegmentSize | null>;
  /**
   * Optional: how often this source re-reads a segment's pointer while the segment is being read, in ms, or 0 if
   * it never does. The grounded `costReport()` prices the pointer refresh at this interval; a source that omits it
   * is priced at the store's default.
   */
  readonly pointerRefreshMs?: number;
  /**
   * Optional: the current generation's **per-chunk cardinality** (`chunkKey → count`), read from the
   * already-parsed `.crbm` index with **no payload reads**, or `null` if the segment has no Storage generation.
   * Powers the free `count()` of a source with no {@link StorageChunkSource.summary} — the engine sums the index
   * instead of fetching a single chunk. A source with no
   * index (e.g. the in-memory source) omits this, and `count()` falls back to fetching every chunk.
   */
  cardinalities?(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null>;
  /**
   * Optional: the current generation's number, id count and metadata, or `null` if the segment has no Storage
   * generation. The `.crbm` source answers from the registry row's summary when it can use it, which is one
   * registry read and no read of the object, and from the opened generation when it cannot. A source with no
   * summary omits this, and `count()` keeps its other paths.
   */
  summary?(ref: SegmentRef): Promise<GenerationSummary | null>;
  /**
   * Optional: the segment's **current generation number** as this source resolves it right now (registry
   * `currentGen`, or the highest storage generation), or `null` if the segment has no Storage generation. The engine
   * keys its chunk cache by this so a generation bump (a load's publish) is observed — a new generation
   * misses the cache instead of serving a stale decoded chunk, and an erased id can't resurrect from a cached
   * superseded chunk. Cheap: served from the source's own (short-TTL-refreshed) snapshot, **not** a fresh
   * backend read per call. A source that only ever serves one immutable generation may omit this — the engine
   * then keys the cache without a generation.
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
   * so no storage-side control can close the window — until its TTL lapses, and with no bound at all if it has
   * no registry, no clock or `cache.genTtlMs: 0`.
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
  /**
   * Optional: an opaque token identifying **which bytes** a read of this segment will see right now —
   * the generation *and* the incarnation of the name it belongs to.
   *
   * {@link StorageChunkSource.currentGeneration} is not enough to key a decoded-chunk cache, and the gap is not
   * theoretical: a load numbers its generation from the row's pointer and what is in the bucket, so the number
   * **restarts at 0** once a registry row is purged and the bucket emptied. A retired, re-created name therefore
   * serves different data at the same `currentGen`, and a cache keyed on `(segment, chunk, generation)` hands back
   * the previous incarnation's ids — an erased id reappearing, with no read to intercept.
   *
   * Note that putting the incarnation in the *object key* would not fix this: the new incarnation still starts
   * at generation 0, so the cache key collides either way. The identity has to reach the cache.
   *
   * Returns `null` when the segment resolves to no generation. A source that only ever serves one immutable
   * generation may omit this, and the engine falls back to the generation alone.
   */
  currentVersion?(ref: SegmentRef): Promise<string | null>;
}

/** Capabilities a Storage driver advertises; validated at wiring time, fail-fast. */
export interface StorageCaps {
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
 *
 * **What a driver must do** — callers rely on each of these, and the storage conformance suite holds every
 * shipped driver to them:
 *
 * - **`putImmutable` is write-once and reports a collision as {@link WriteConflictError}.** It never overwrites a
 *   stored object. `load` reads that error as a lost race for the generation number (`superseded`), so a driver
 *   that threw anything else for an existing key would surface as a failed load.
 * - **A missing object makes `getRange` and `getTail` throw {@link NotFoundError}** — never an empty or short
 *   result. Heal-forward (a read whose generation a sweep collected re-resolves), the erasure's holder probe and
 *   its verify of the rewrite, and a pin's replaced-object check all branch on that one error. (A zero-length
 *   `getRange` may answer empty without reaching the backend, so it proves neither that the object exists nor
 *   that the offset lies inside it: the cloud drivers answer it empty, the memory and local-filesystem drivers
 *   throw for a missing object or an offset past the end.)
 * - **An out-of-range read throws {@link ValidationError}**: a range that runs past the end of the object, or a
 *   negative or non-integer offset or length. Never a clamped, short or adjacent read. A pin whose object
 *   was purged and loaded again as a smaller one asks for a range past its end, and this error is what sends it
 *   to check that the object is still the one it pinned.
 * - **`getTail` reports the object's true total size**, not the number of bytes it returned.
 * - **`delete` is idempotent.** Deleting an absent key is a no-op, not an error: collection passes race each
 *   other and retry.
 * - **`list` is strongly consistent, read-after-delete.** Once `delete` has resolved, `list` no longer yields
 *   that generation, and once `putImmutable` has resolved it does. The erasure's re-check for a generation still
 *   holding the id, `dropSegment`'s `generationsRemaining`, the retention sweep's check that a tombstone's storage
 *   is gone, and rollback's post-move check prove a deletion or a presence by listing, so a listing that lags
 *   reports an erasure as incomplete or a stale object as gone.
 * - **Never replay a conditional write without telling the replay apart.** A `putImmutable` that lands and then
 *   loses its response, sent again, finds its own object and would report a collision. Either send each write
 *   once, with the backend client's retry off for that request, or recognise your own write when the
 *   precondition fails by reading an id you stored with it back, and treat a match as success. The first is
 *   what the registry writes of every shipped driver do; the second is what the Azure Blob driver and the
 *   resumable GCS upload do, and what the S3 driver and the single-request GCS upload do when they send an object
 *   again after a throttle, which is the one replay a driver may make on purpose.
 * - **Raise a transient fault as {@link TransientError}** (throttling, a 5xx, a dropped connection), so the read
 *   retry can ride it out and a write's caller can tell it from a deterministic failure.
 */
export interface IStorageDriver {
  capabilities(): StorageCaps;
  /**
   * Stream a new immutable generation. The driver opens a destination, hands `write` a {@link BlobSink},
   * then atomically commits (and computes the content hash). Throws {@link WriteConflictError} if the key
   * already exists (write-once).
   */
  putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }>;
  /**
   * Range read; the caller bounds-checks. Out-of-range throws {@link ValidationError}, never a short/adjacent
   * read, and a missing object throws {@link NotFoundError}.
   */
  getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array>;
  /**
   * Speculative tail read: the last `min(maxBytes, size)` bytes + the object's **true total size**. A missing
   * object throws {@link NotFoundError}.
   */
  getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }>;
  /** Idempotent: deleting an absent key is a no-op, not an error. */
  delete(key: GenKey): Promise<void>;
  /**
   * Enumerate the generations present for a segment (orphan sweep / latest-gen resolution). Strongly
   * consistent, read-after-delete and read-after-put.
   */
  list(ref: SegmentRef): AsyncIterable<GenKey>;
}

/**
 * Lifecycle status of a segment. `active` is the steady state; `destroyed` is the post-crypto-shred tombstone
 * (the row is kept for audit but the segment is logically gone).
 */
export type RegistryStatus = 'active' | 'destroyed';

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
 * A cached description of one generation, carried on the registry row: how many ids it holds, and the metadata it
 * was loaded with. The generation's `.crbm` object stays the truth; this is a copy, written by the same write that
 * moves the pointer, and it names the generation it describes so a copy left behind by a writer that did not
 * carry it can never be taken for another generation's.
 *
 * Two shapes. On a cleartext segment the values are in the clear. On an encrypted segment (a row with
 * `wrappedDeks`) they are sealed under the segment's data key, as the generation's index is, so the row reveals
 * neither the count nor the metadata. A shipped registry refuses a write whose summary disagrees with the row's
 * keys. It still reads a stored row that disagrees, so that one such row cannot stop every listing: a reader must not
 * use that row's summary.
 */
export type RegistrySummary = ClearRegistrySummary | SealedRegistrySummary;

/**
 * A generation's metadata: string keys, string or finite-number values, no nesting, at most 1 KiB as canonical JSON.
 * The rules are in `core/metadata.ts`.
 */
export type GenerationMetadata = Readonly<Record<string, string | number>>;

/** What a generation is, as one read answers it: its number, its id count and the metadata it was written with. */
export interface GenerationSummary {
  readonly generation: number;
  readonly cardinality: number;
  /** Absent when the generation has none. */
  readonly metadata?: GenerationMetadata;
}

/** {@link RegistrySummary} on a cleartext segment. */
export interface ClearRegistrySummary {
  /** The generation this describes. A non-negative safe integer. */
  readonly generation: number;
  /** How many ids the generation holds: an integer from 0 to 2^32. */
  readonly cardinality: number;
  /** The generation's metadata, when it has any. Never the empty object. */
  readonly metadata?: GenerationMetadata;
}

/** {@link RegistrySummary} on an encrypted segment. */
export interface SealedRegistrySummary {
  /** The generation this describes. A non-negative safe integer. */
  readonly generation: number;
  /**
   * Base64 of `nonce(12) ‖ ciphertext ‖ tag(16)`, sealing the cardinality as a little-endian u64 followed by the
   * metadata's canonical JSON, if any. The count is fixed-width, so the length reveals only the metadata's size.
   */
  readonly sealed: string;
}

/**
 * One registry row — the authoritative per-segment record. Exactly one per segment.
 */
export interface RegistryRecord extends SegmentRef {
  /**
   * **The** authoritative LATEST pointer: which immutable Storage generation is current — or **`null` for a segment
   * that has no Storage generation yet.**
   *
   * `null` is not "unknown", it is a positive statement: *this segment exists and has no Storage data.* It is what
   * lets a segment have a registry row **before its first load** — `setSegmentRetention` mints one so a policy
   * can be recorded ahead of the data, and so the segment is reachable by `registry.list()` and therefore by
   * retention sweeps, `checkConsistency` and every other fleet-wide operation. The alternative — a row with
   * `currentGen: 0` and no object behind it — is the forbidden `missing-storage-generation` state, which fails per
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
  /**
   * A cached description of the current generation (see {@link RegistrySummary}). Optional: a row without one is
   * correct, and a reader then opens the generation instead. Trusted only for the generation it names.
   */
  readonly summary?: RegistrySummary;
  /** Epoch-ms of creation / last mutation (from the driver's injected clock). */
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Opaque OCC token — compare-by-equality, ABA-safe. A shipped registry gives no two writes under one name the same
   * token: not two writes of this row, not a write of an earlier row under the name, and not a write after this row is
   * restored from a backup. It holds with overwhelming probability rather than by construction, since the token carries random parts: a
   * 128-bit incarnation id drawn when the row is created, and a 64-bit part drawn for each write. Two incarnations of one
   * name meet with probability 2^-128 for any pair (about n^2 / 2^129 among n of them), and two writes at one counter,
   * after a restore, with probability 2^-64. A bare decimal token, on a row no 0.12 or later registry has written,
   * carries neither part.
   */
  readonly token: Token;
}

/** The caller-settable fields at {@link IRegistryDriver.create} (audit + token are driver-managed). */
export interface NewRegistryRecord {
  /** `null` ⇒ the segment has no Storage generation yet — see {@link RegistryRecord.currentGen}. */
  readonly currentGen: number | null;
  readonly wrappedDeks?: readonly WrappedDek[];
  readonly keyId?: string;
  /** Defaults to `'active'`. */
  readonly status?: RegistryStatus;
  readonly retention?: GovernanceMeta;
  readonly residency?: GovernanceMeta;
  /** Must name `currentGen` when given. */
  readonly summary?: RegistrySummary;
}

/**
 * Fields a {@link IRegistryDriver.compareAndSwap} may mutate (identity + audit + token are off-limits).
 *
 * Presence-based: a field the patch does not mention is left as it was. `summary` is the one exception, because it
 * describes the current generation: a patch that moves `currentGen` and does not mention `summary` drops the old
 * one rather than keep a description of another generation. A `summary` the patch gives must name the
 * `currentGen` the row will have.
 */
export type RegistryPatch = Partial<
  Pick<
    RegistryRecord,
    'currentGen' | 'wrappedDeks' | 'keyId' | 'status' | 'retention' | 'residency' | 'summary'
  >
>;

/** Capabilities a registry driver advertises; validated fail-fast at wiring time. */
export interface RegCaps {
  /** REQUIRED — `currentGen` feeds read correctness + the publish CAS, so reads must be strongly consistent. */
  readonly strongRead: true;
  /**
   * `false` when this registry cannot write a row in this runtime, though it reads: a shipped registry draws random
   * bytes for every token it issues, and on a runtime with no Web Crypto it has none to draw. A write path that
   * writes an object before its row (a load, an erasure rewrite) checks it first and refuses with `UnsupportedError`
   * before it writes anything, rather than leave an object no row names. Absent means the registry can write.
   */
  readonly canWrite?: false;
  /**
   * `true` when this registry's `delete` removes a row from its backend for good, so that no later `list` reads it, and
   * removes it only while it is still the exact version the delete read: by a delete the backend applies under a
   * precondition (an S3 or Azure Blob ETag, a GCS object generation), or under a lock no other writer of the backend
   * can take. Only a row whose token carries an incarnation id is removed so. A row first written by a release before
   * 0.12 has a bare decimal token, and a delete still tombstones it: a process on that release, re-creating the name
   * over nothing, would issue those counters again from 0, so its row could not be told apart from the deleted one.
   *
   * `false` or absent: every `delete` leaves a tombstone, which every later full `list` still reads. A shipped registry
   * says which it is.
   */
  readonly conditionalDelete?: boolean;
}

/**
 * Refuse, with `UnsupportedError`, a write that would write an object before its row when the registry reports it
 * cannot write a row (see {@link RegCaps.canWrite}). Called before the write's first request.
 */
export function assertRegistryCanWrite(registry: IRegistryDriver, what: string): void {
  if (registry.capabilities().canWrite === false) {
    throw new UnsupportedError(
      `${what}: the registry reports it cannot write a row in this runtime (capabilities().canWrite is false), ` +
        'so nothing is written',
    );
  }
}

/**
 * Brand for {@link StorageBackend}.
 *
 * `Symbol.for` rather than a class check, for the same reason the error brands are: a class object is only
 * shared while one copy of core is loaded, so a backend built from one copy and checked by another — after a
 * version skew, or behind a duplicating bundler — would fail an `instanceof`. A registered symbol is
 * identity-stable across all of them, and across realms.
 *
 * A brand string is part of that identity contract, so once a release carries one it never changes: a changed
 * string would stop matching the copies already installed.
 */
const STORAGE_BACKEND_BRAND: unique symbol = Symbol.for('cloudbitmaps.storage-backend');

/**
 * Where a store keeps everything: the generations, and the pointer saying which one is current.
 *
 * **Branded on purpose.** The two fields alone are not enough to qualify, and that is the whole point. This
 * shape is also {@link LoadDeps}, so before the brand any `{ storage, registry }`
 * object literal satisfied it — including one assembling halves from two *unrelated* stores, which the store
 * accepted and then answered **empty** for a segment that holds data, because it read a pointer from a place
 * nothing had ever been written. That is the exact silent-empty failure one-class-per-backend exists to
 * remove, and it was reachable in five lines.
 *
 * So a backend comes from `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
 * `AzureBlobStorage` — each deriving both halves from one bucket and one prefix. A driver author composing halves
 * of their own says so on purpose, with {@link brandAsBackend}. The halves stay readable as `.storage` /
 * `.registry`, because the free functions genuinely need them.
 *
 * **What this stops is the accident, not a determined caller.** The brand is a registered symbol, so it can
 * be written by hand; nothing here is a security boundary. It stops the two spellings people reach for
 * without deciding to — an object literal, and a spread of a real backend.
 */
export interface StorageBackend {
  /** Cross-bundle brand. Set by the backend classes; not part of the public surface. */
  readonly [STORAGE_BACKEND_BRAND]: true;
  /** Where the immutable `.crbm` generations live. */
  readonly storage: IStorageDriver;
  /** Where the `currentGen` pointer, the discovery index and the wrapped DEKs live. */
  readonly registry: IRegistryDriver;
}

/**
 * The brand key, for the type-only `declare` field a backend class carries.
 *
 * Exported from `@cloudbitmaps/core/driver-kit` and part of the driver contract: a third-party storage
 * package needs it to declare the field that {@link brandAsBackend} then stamps at runtime.
 */
export const STORAGE_BACKEND: typeof STORAGE_BACKEND_BRAND = STORAGE_BACKEND_BRAND;

/**
 * Stamp the brand on a backend, **non-enumerably**, after checking both halves are drivers. Returns `target`.
 *
 * This is the driver author's door, and it works on a backend class (`brandAsBackend(this)` as the last line of
 * its constructor) and on a plain `{ storage, registry }` object alike — the latter is how a backend of your
 * own halves is built: a driver wrapped for auditing, metrics, tenant scoping or client-side encryption, or
 * paired with a registry in a database you already run. An application does not need it: it gets both halves
 * from one backend class, which derives them from one bucket and one prefix so they cannot disagree.
 *
 * It throws {@link ValidationError} when `storage` has no `putImmutable` or `registry` has no `compareAndSwap`,
 * so a half that is not a driver is refused here rather than at its first write, and when `target` is frozen or
 * non-extensible, since the brand is stamped on it in place.
 *
 * It cannot check that the halves agree: `IStorageDriver` and `IRegistryDriver` do not expose a location, so
 * nothing here can compare one. Branding two unrelated halves is you taking that on — the plain
 * `{ storage, registry }` literal is refused by the store precisely because it let the two halves come from
 * unrelated places by accident, and answer **empty** rather than fail.
 *
 * Non-enumerable is load-bearing, not tidiness. A class field (`readonly [BRAND] = true`) emits an
 * *enumerable* own property, and spread and `Object.assign` copy exactly those — so
 * `{ ...backend, registry: other.registry }` carried the brand and was accepted, reproducing the silent-empty
 * bug the brand exists to close. This does not make the brand unforgeable — the symbol is registered, so anyone
 * who wants it can write `Symbol.for('cloudbitmaps.storage-backend')`. That is deliberate effort equivalent to
 * calling this function, and it is not what the check is for. The check is for the accident.
 */
export function brandAsBackend<T extends { storage: IStorageDriver; registry: IRegistryDriver }>(
  target: T,
): T & StorageBackend {
  if (target === null || typeof target !== 'object') {
    throw new ValidationError('brandAsBackend needs `{ storage, registry }`');
  }
  const { storage, registry } = target;
  if (
    storage === null ||
    typeof storage !== 'object' ||
    typeof storage.putImmutable !== 'function'
  ) {
    throw new ValidationError(
      'brandAsBackend: `storage` must be an IStorageDriver (it has no `putImmutable`)',
    );
  }
  if (
    registry === null ||
    typeof registry !== 'object' ||
    typeof registry.compareAndSwap !== 'function'
  ) {
    throw new ValidationError(
      'brandAsBackend: `registry` must be an IRegistryDriver (it has no `compareAndSwap`)',
    );
  }
  try {
    Object.defineProperty(target, STORAGE_BACKEND_BRAND, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    // A frozen, sealed or non-extensible object cannot take the brand, and the brand is stamped in place.
    throw new ValidationError(
      'brandAsBackend: cannot brand a frozen or non-extensible object — pass a plain object or a class instance',
    );
  }
  return target as T & StorageBackend;
}

/**
 * Is this a branded backend — from a backend class or from {@link brandAsBackend}?
 *
 * Checks the brand, not the shape — see {@link StorageBackend} for why the shape alone is not enough.
 */
export function isStorageBackend(value: unknown): value is StorageBackend {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[STORAGE_BACKEND_BRAND] === true
  );
}

/**
 * Per-segment registry — the authoritative source of `currentGen`, the discovery index, and the wrapped-DEK
 * holder. One row per segment under OCC: a never-reused, equality-compared {@link Token} (ABA-safe across
 * delete→recreate).
 *
 * **What a driver must do** — callers rely on each of these, and the registry conformance suite holds every
 * shipped driver to them:
 *
 * - **`create` and `compareAndSwap` are atomic conditional writes.** A `create` over a live row, and a
 *   `compareAndSwap` whose token is not the stored one, throw {@link WriteConflictError} and change nothing.
 *   Two racing writers have exactly one winner.
 * - **A token is not reused, not even across `delete` then `create`**, short of a collision of probability 2^-128 for
 *   any two incarnations of one name: a recreated row carries a token no earlier incarnation held, so a stale holder
 *   cannot swap into it. The shipped drivers draw a random 128-bit incarnation id into the token of every row they
 *   create and a random 64-bit part into the token of every write, beside a counter a tombstone (or a global counter)
 *   keeps going; where nothing of the earlier row is left, or the row is restored from a backup to an older counter, the
 *   random parts alone keep the tokens apart: with probability 1 - 2^-128 per pair of incarnations, and 1 - 2^-64 per
 *   pair of writes at one counter.
 * - **`delete` is idempotent** without an `expected` token: deleting an absent row is a no-op, not an error.
 *   **With `expected` it is fenced**: it lands only while the row still carries that token, and otherwise throws
 *   {@link WriteConflictError} and leaves the row.
 * - **Reads are strongly consistent** (`RegCaps.strongRead`), and `list` yields every existing row,
 *   `destroyed` tombstones included, with every field (see {@link IRegistryDriver.list}).
 * - **Never replay a conditional write without telling the replay apart.** A `create` or `compareAndSwap`
 *   that lands and then loses its response, sent again, finds its own write and would report a conflict.
 *   Either send each write once, with the backend client's retry off for that request, or recognise your own
 *   write when the precondition fails by reading an id you stored with it back. The shipped registries do
 *   one or the other.
 * - **Raise a transient fault as {@link TransientError}.**
 */
export interface IRegistryDriver {
  capabilities(): RegCaps;
  /**
   * The segment's record, or `null` if it doesn't exist (or was deleted). Throw {@link TransientError} for a fault
   * worth riding out (throttling, a 5xx, a dropped connection): a reader whose pointer refresh meets one keeps
   * serving what it holds and asks again shortly, while any other error reaches the read that met it.
   */
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
  /**
   * Remove the row. A registry whose {@link RegCaps.conditionalDelete} is `true` removes a row whose token carries an
   * incarnation id from its backend; every other row is tombstoned. Either way a later `create` gets a token no
   * earlier incarnation of the name held, but for a collision of probability 2^-128 per pair of incarnations.
   *
   * Without `expected`, idempotent: deleting an absent row is a no-op.
   *
   * With `expected`, the delete is **fenced like a {@link IRegistryDriver.compareAndSwap}**: it lands only while
   * the row still carries exactly that token, and otherwise — the token differs, or the row is absent or already
   * deleted — throws {@link WriteConflictError} and leaves the row. Pass the token of the row you read when you
   * decided to delete it, so a delete that is delayed, replayed, or racing a re-create cannot tombstone a row
   * created after the decision. A third-party driver that ignores `expected` keeps the unfenced behaviour.
   */
  delete(ref: SegmentRef, expected?: Token): Promise<void>;
}
