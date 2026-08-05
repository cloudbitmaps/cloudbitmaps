/**
 * Storage-driver contracts the engine depends on.
 *
 * Phase 1 uses the subset needed by the in-memory engine: the per-chunk Warm store (under OCC) and a
 * per-chunk read view of Cold. Drivers move opaque bytes + an OCC token; they never understand roaring,
 * `adds`/`removes`, or the `.crbm` layout. The full `IColdDriver` (blob/range) + `IRegistryDriver` arrive
 * with generations in Phase 2/3 — the `.crbm` reader will implement `ColdChunkSource`.
 */

import type { BlobSink } from './blob';
import type { WrappedDek } from './crypto';

/** Opaque optimistic-concurrency token — unique per write, compared by equality only. */
export type Token = string;

/** Sentinel for `putConditional` meaning "the row must not exist yet" (create). */
// `Symbol.for` (the global registry), NOT `Symbol()`: the package ships multiple bundles (the core entry and
// the `./dynamodb` / `./s3` subpaths), and tsup inlines `core/ports` into each. A plain `Symbol('no-row')`
// would be a DISTINCT instance per bundle, so the engine's `NO_ROW` wouldn't `===` the one the DynamoDb warm
// driver compares against — every create would misroute to the token-fenced path and fail. A registry symbol
// is identity-stable across bundles/realms. (Invisible in tests, which share one source module graph.)
export const NO_ROW: unique symbol = Symbol.for('cloud-roaring.no-row');
export type NoRow = typeof NO_ROW;

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

export interface WarmRow {
  readonly token: Token;
  /** Read-only: owned by the driver. Callers must NOT mutate the buffer (re-encode to write). */
  readonly bytes: Uint8Array;
}

/**
 * Read consistency for a Warm fetch (gap #9). `consistent: true` (the default — omitted ⇒ true) is a
 * strong, read-your-writes read, as the OCC read-modify-write path requires. `consistent: false` requests an
 * **eventually-consistent** read — on DynamoDB that is ~½ the RCU cost; a driver that is always strongly
 * consistent (in-memory, LocalFs) ignores it. The engine uses it only on read paths (`has`/`count`/`iterate`/
 * `intersect`) when the store opts into `warmReadConsistency: 'eventual'`, trading read-after-write for cost.
 */
export interface WarmReadOptions {
  readonly consistent?: boolean;
}

/** Per-chunk Warm store under optimistic concurrency. Returned byte buffers are read-only. */
export interface IWarmDriver {
  get(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null>;
  /** OCC write. `expected` = `NO_ROW` to create, else the token previously read. Throws `WriteConflictError` on mismatch. */
  putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }>;
  /**
   * Fenced delete — only if the stored token still equals `expected`; throws `WriteConflictError`
   * otherwise. **Used by compaction (Phase 4); the Phase-1 engine never calls it** — drivers still
   * implement it to satisfy the conformance suite.
   */
  deleteConditional(ref: ChunkRef, expected: Token): Promise<void>;
  /** All dirty chunks of a segment, ascending `chunkKey`. Yielded `bytes` are read-only. */
  listChunks(
    ref: SegmentRef,
    opts?: WarmReadOptions,
  ): AsyncIterable<{ chunkKey: number } & WarmRow>;
}

/**
 * A segment's grounded on-disk footprint (Phase 5b) — the current generation's Cold object bytes, read
 * cheaply from the `.crbm` footer/index (no payload reads). Powers the grounded `costReport()`.
 */
export interface SegmentSize {
  readonly sizeBytes: number;
}

/** Per-chunk read view of the immutable Cold tier (implemented by the `.crbm` reader from Phase 2). */
export interface ColdChunkSource {
  /** Read-only bytes for the chunk, or `null` if absent. Callers must not mutate the buffer. */
  getChunk(ref: ChunkRef): Promise<Uint8Array | null>;
  listChunkKeys(ref: SegmentRef): Promise<number[]>;
  /**
   * Optional (Phase 5b): the current generation's grounded size, cheaply (from the already-parsed
   * `.crbm` index — no payload reads), or `null` if the segment has no Cold generation. Powers the
   * grounded `costReport()`.
   */
  sizeOf?(ref: SegmentRef): Promise<SegmentSize | null>;
  /**
   * Optional (Phase 5c): the current generation's **per-chunk cardinality** (`chunkKey → count`), read
   * from the already-parsed `.crbm` index with **no payload reads**, or `null` if the segment has no Cold
   * generation. Powers the cheap `count()` — a warm-delta-free chunk is counted straight from the index
   * instead of fetching + deserializing it. A source with no index (e.g. the in-memory source) omits this,
   * and `count()` falls back to fetching + merging every chunk.
   */
  cardinalities?(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null>;
  /**
   * Optional (Phase B, gap #4): the segment's **current generation number** as this source resolves it right now
   * (registry `currentGen`, or the highest cold generation), or `null` if the segment has no Cold generation. The
   * engine keys its HOT chunk cache by this so a generation bump (a compaction commit) is observed — a new
   * generation misses the cache instead of serving a stale decoded chunk, and an erased id can't resurrect from a
   * cached pre-compaction chunk. Cheap: served from the source's own (short-TTL-refreshed) snapshot, **not** a
   * fresh backend read per call. A source that pins one immutable generation for its whole lifetime and never
   * refreshes may omit this — the engine then keys the cache without a generation, exactly as before.
   */
  currentGeneration?(ref: SegmentRef): Promise<number | null>;
}

/** Capabilities a Cold driver advertises; validated at wiring time, fail-fast. */
export interface ColdCaps {
  /** REQUIRED — the format relies on byte-range reads. */
  readonly rangeRead: true;
  /** Largest single object the backend accepts (informs single-object-vs-shard, B7 — future). */
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
 * Lifecycle status of a segment. `active` is the steady state;
 * `compacting`/`erasing` are transient flags a daemon sets while it works (Phase 4d/4e); `destroyed` is the
 * post-crypto-shred tombstone (the row is kept for audit but the segment is logically gone). The 4c registry
 * stores and round-trips the field; the *transitions* are driven by their owning features.
 */
export type RegistryStatus = 'active' | 'compacting' | 'erasing' | 'destroyed';

/**
 * Free-form, JSON-serializable governance metadata — a **plain object** (both registry boundaries reject `null`,
 * an array or a primitive, because a reader that tests `'key' in meta` would throw an untyped `TypeError`).
 *
 * `retention` now has one **reserved key with defined semantics**: `expiresAt`, an absolute epoch-ms after which a
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
   * lets a **warm-only accumulator** (created by writing to it, never bulk-loaded, never compacted) have a
   * registry row at all — which it needs to be reachable by `registry.list()`, and therefore by retention
   * sweeps, `checkConsistency`, `eraseNamespace` and every other fleet-wide operation. Without it those
   * segments are invisible to every admin tool in the library.
   *
   * The alternative — a row with `currentGen: 0` and no object behind it — is the forbidden
   * `missing-cold-generation` state, and it fails *per operation* rather than cleanly: `has()` short-circuits on
   * the Warm delta and keeps answering, while `count()` resolves the generation and throws `NotFoundError`.
   *
   * Generation resolution maps `null` onto the same path a segment with **no row** takes, so Cold contributes
   * the empty set and the Warm delta alone produces the answer. Read behaviour is unchanged by construction.
   */
  readonly currentGen: number | null;
  /**
   * Per-segment data-key (DEK) wrappings for encryption-at-rest (Phase 4e): the DEK envelope-wrapped under one
   * or more KEKs (active + optional recovery). Reading unwraps with any held KEK; **crypto-shred deletes this
   * whole list**, making the segment's at-rest bytes permanently unrecoverable. Absent ⇒ the segment is
   * cleartext.
   */
  readonly wrappedDeks?: readonly WrappedDek[];
  /**
   * Optional **external** key reference (reserved) — e.g. a KMS key ARN for a future KMS keystore adapter that
   * keeps wrapped material in the KMS rather than in-band {@link wrappedDeks}. Unused by the in-process BYOK
   * keystore. Clearable on crypto-shred.
   */
  readonly keyId?: string;
  /**
   * Dirty-row hint written by `findCompactable`. Discovery still recomputes the live dirty count by scanning
   * Warm each cycle (the count that decides candidacy), but it now **reads** this hint to gate a change-guarded
   * CAS — the hint is only rewritten when the count actually moved, so an all-idle fleet issues no per-segment
   * registry writes. It does not yet drive candidacy — turning the Warm scan itself into O(dirty) is a
   * deferred cheap-enumeration fix.
   */
  readonly dirtyChunkCount: number;
  readonly status: RegistryStatus;
  /**
   * Daemon health (Phase D, gap #2): epoch-ms of the last **successfully committed** compaction, and the
   * count of **consecutive** compaction failures (reset to 0 by a successful commit). `lastCompactedAt`
   * powers a dead-man's-switch / staleness alarm; `consecutiveFailures` drives **poison-segment quarantine** —
   * discovery skips a segment past a failure threshold so one corrupt Warm row can't freeze the compaction of a
   * segment **that has a committed generation** forever (with no alarm) while its Warm backlog grows unbounded.
   * (A segment whose *very first* compaction keeps failing has no registry row to count against yet —
   * bootstrap faults are surfaced as `error` results but not yet quarantined; gap #2.) Both
   * **optional** (absent on rows written before Phase D, and on a segment never compacted) — read them as
   * `lastCompactedAt ?? undefined`, `consecutiveFailures ?? 0`.
   */
  readonly lastCompactedAt?: number;
  readonly consecutiveFailures?: number;
  /**
   * Compaction lease (Phase 4d): the opaque id of the worker currently compacting this segment, and the
   * epoch-ms at which its lease expires. `status === 'compacting'` with `leaseExpiresAt` in the future means
   * a live daemon owns it; once `leaseExpiresAt` is past, another worker may **steal** the lease (the prior
   * holder crashed). Both absent in the steady (`active`) state. The lease is an efficiency guard only — the
   * 2-phase commit is correct without it (OCC-fenced swap + write-once generations + version-fenced purge).
   */
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
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
  /** Opaque OCC token — compare-by-equality, never reused (ABA-safe), exactly like {@link WarmRow.token}. */
  readonly token: Token;
}

/** The caller-settable fields at {@link IRegistryDriver.create} (audit + token are driver-managed). */
export interface NewRegistryRecord {
  /** `null` ⇒ the segment has no Cold generation yet — see {@link RegistryRecord.currentGen}. */
  readonly currentGen: number | null;
  readonly wrappedDeks?: readonly WrappedDek[];
  readonly keyId?: string;
  /** Defaults to 0. */
  readonly dirtyChunkCount?: number;
  /** Defaults to `'active'`. */
  readonly status?: RegistryStatus;
  readonly retention?: GovernanceMeta;
  readonly residency?: GovernanceMeta;
}

/** Fields a {@link IRegistryDriver.compareAndSwap} may mutate (identity + audit + token are off-limits). */
export type RegistryPatch = Partial<
  Pick<
    RegistryRecord,
    | 'currentGen'
    | 'wrappedDeks'
    | 'keyId'
    | 'dirtyChunkCount'
    | 'status'
    | 'leaseOwner'
    | 'leaseExpiresAt'
    | 'lastCompactedAt'
    | 'consecutiveFailures'
    | 'retention'
    | 'residency'
  >
>;

/** Capabilities a registry driver advertises; validated fail-fast at wiring time. */
export interface RegCaps {
  /** REQUIRED — `currentGen` feeds read correctness + compaction CAS, so reads must be strongly consistent. */
  readonly strongRead: true;
}

/**
 * Per-segment registry — the authoritative source of `currentGen`, the discovery index, and (Phase 4e) the
 * wrapped-DEK holder. One row per segment under OCC: a
 * never-reused, equality-compared {@link Token} (ABA-safe across delete→recreate, like the Warm tier).
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
