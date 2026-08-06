/**
 * Crash-safe compaction — the 2-phase commit that folds Warm deltas into a fresh immutable Cold generation
 * (invariants I3/I4/I5).
 *
 * Memory (Phase 4f): a generation is merged **and written as a stream** — {@link mergeChunksStream} yields one
 * merged chunk at a time and {@link writeCrbmGenerationStream} feeds each to a streaming cold sink (S3 multipart
 * / LocalFs temp file), freeing it. The cold generation is merged and written as a stream, so peak COLD-side
 * memory is ~one chunk + one upload part + the cold reader's index. Caveat: `collectDirty` first materializes
 * the whole dirty Warm delta set in memory, so total peak also scales with the dirty-warm working set (up to a
 * whole segment for an all-warm/never-compacted segment) — pinning only `{chunkKey,token}` + lazy re-read is a
 * deferred fix (gap #12).
 *
 * The algorithm, per chunk: `newCold(k) = (cold_g(k) ∪ adds(k)) \ removes(k)` — exactly the read-time
 * effective set ({@link effective}), so the segment's visible set is unchanged (**I3**). Steps:
 *
 *   1. LEASE   acquire the per-segment compaction lease (status→compacting; steal an expired one)
 *   2. PIN     g := registry.currentGen; archive each dirty chunk's OCC token (`v_archived`)
 *   3. RECONCILE delete orphan Cold generations > g (a crashed prior stage), safe under the lease
 *   4. MERGE   build gen g+1: dirty chunks merged, clean chunks copied through
 *   5. STAGE   write segment.<g+1>.crbm (immutable, write-once)
 *   6. VERIFY  re-open it; its chunk-key set + footer cardinality must equal the merge (+ the codec's CRC checks)
 *   7. SWAP    registry.currentGen := g+1, release the lease — CONDITIONAL on the lease token (atomic commit)
 *   8. PURGE   delete each archived Warm row CONDITIONAL on token == v_archived (a write after the scan has a
 *              newer token → its purge fails → it survives into the next dirty set: **no lost writes, I4**)
 *
 * **Correctness without a lock:** the commit is the conditional `currentGen` swap; write-once generations +
 * version-fenced purge make even two concurrent compactions safe (the loser's staged generation is an orphan
 * GC'd later; no torn read — readers are pinned to a committed generation, **I5**). The lease only avoids that
 * wasted duplicate work.
 *
 * Pure orchestration over the injected driver interfaces + an injected {@link Clock} (timer-free; the daemon
 * layer owns scheduling/heartbeat). A crash at *any* step is recoverable: nothing is destructive until after
 * the commit, and the swap is atomic.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import type { CodecBitmap, CodecInterface } from './codec';
import { requireCodec } from './codec';
import { decodeDelta, effective, emptyDelta } from './chunk';
import type { ChunkDelta } from './chunk';
import type { BlobReader } from './blob';
import type { Yielder } from './cooperative';
import type { Clock } from './determinism';
import type { IMetricsSink } from './metrics';
import {
  KeyUnavailableError,
  ValidationError,
  WriteConflictError,
  isWriteConflictError,
} from './errors';
import { segmentKey } from './keys';
import { LEASE_NAMESPACE } from './lease';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore, WrappedDek } from './crypto';
import { writeCrbmGenerationStream } from './crbm-cold-source';
import { CrbmReader } from './crbm/reader';
import type {
  ChunkRef,
  GenKey,
  IColdDriver,
  IRegistryDriver,
  IWarmDriver,
  RegistryRecord,
  SegmentRef,
  Token,
} from './ports';

const DEFAULT_MAX_BITMAP_BYTES = 1 << 20;
/** Default compaction-lease duration. Generous: a compaction longer than this risks being stolen (safe — the
 * commit is fenced on the lease token — but wasteful). The daemon layer can renew (heartbeat) for big segments. */
const DEFAULT_LEASE_MS = 60_000;
/** Default consecutive-failure count at/after which discovery quarantines (skips) a poison segment (gap #2). */
const DEFAULT_QUARANTINE_THRESHOLD = 5;
/** Default cooldown before a quarantined segment is retried once, so a transient fault can self-heal (gap #2). */
const DEFAULT_QUARANTINE_COOLDOWN_MS = 5 * 60_000;

export interface CompactionDeps {
  readonly cold: IColdDriver;
  readonly warm: IWarmDriver;
  readonly registry: IRegistryDriver;
  /**
   * Injected time source for lease expiry (the determinism seam — `core/` never reads ambient time).
   *
   * `now` is required; `sleep`/`yieldNow` are **optional and used only for cooperative yielding** while writing
   * a generation. Supplying a full {@link Clock} (the facade does) makes compaction hand the event loop back
   * periodically instead of blocking it for the whole write; supplying a bare `{ now }` keeps the previous
   * uninterrupted behaviour. Optional rather than required because every existing caller passes `{ now }`, and
   * requiring more would be a breaking change — the reason the yield below shipped unreachable the first time.
   */
  readonly clock: Pick<Clock, 'now'> & Partial<Pick<Clock, 'sleep' | 'yieldNow'>>;
  readonly maxBitmapBytes?: number;
  /**
   * Bitmap codec — compaction only merges bitmaps through it. Optional in the type so this
   * stays call-compatible public API; a **flavor** package binds it (see {@link requireCodec}).
   */
  readonly codec?: CodecInterface;
  /**
   * Keystore for **encrypted** segments (Phase 4e). An encrypted segment (its registry record carries wrapped
   * DEK(s)) reuses that same DEK: compaction unwraps it to decrypt the old generation and encrypt the new one.
   * A bootstrap (gen 0) with a keystore mints a fresh DEK. Compacting an encrypted segment without a keystore
   * throws {@link KeyUnavailableError}. Absent ⇒ cleartext compaction (unless {@link requireEncryption}).
   */
  readonly keystore?: IKeystore;
  /** When true, refuse to write a cleartext generation — a segment without a keystore-backed DEK throws. */
  readonly requireEncryption?: boolean;
  /**
   * Optional observability sink (Phase D, gap #2). `compactSegment` emits one `compaction` event per attempt
   * (committed or not, timed). Assumed exception-safe (the `CloudRoaring` facade wraps the user sink); the emit
   * is additionally guarded so a throwing sink can never break compaction. Absent ⇒ no emission.
   */
  readonly metrics?: IMetricsSink;
}

export interface CompactionOptions {
  /** Opaque id of this worker — the lease owner (e.g. `host:pid:uuid`). Required so a steal is attributable. */
  readonly owner: string;
  /** Lease duration in ms (default 60s). */
  readonly leaseMs?: number;
  /**
   * Optional audit sink (Phase 5d). A `segment.compact` event is emitted once per **committed** generation
   * (never on a no-op/contention path). Exception-safe; the default records nothing.
   */
  readonly audit?: IAuditSink;
}

export interface CompactionResult {
  readonly segment: string;
  readonly namespace?: string;
  /** True iff a new generation was committed. */
  readonly compacted: boolean;
  /**
   * Why nothing was committed, when `compacted` is false: `'clean'` (no dirty rows), `'leased-by-other'`
   * (a live lease elsewhere), `'lease-lost'` (our lease was stolen before the commit — staged gen is an
   * orphan, no rows purged), `'superseded'` (a concurrent publish/bulk-load advanced `currentGen` past the
   * generation we pinned — we abort so RECONCILE never deletes the just-published generation; the next cycle
   * re-pins the new current gen; gap #5), `'bootstrap-raced'` (another worker wrote gen 0; our rows are left
   * for the next compaction), `'stage-conflict'` (a generation write-conflict we couldn't reconcile),
   * `'destroyed'` (the segment was crypto-shredded — terminal), or `'error'` (an isolated per-segment fault
   * recorded by {@link runCompactionCycle}).
   */
  readonly reason?: string;
  /** The fault message when `reason === 'error'` (a per-segment failure isolated by {@link runCompactionCycle}). */
  readonly error?: string;
  readonly fromGen: number | null;
  readonly toGen?: number;
  readonly dirtyChunks: number;
  /** Archived Warm rows actually purged (≤ dirtyChunks; the rest were rewritten post-scan and survive). */
  readonly purged: number;
  readonly survived: number;
}

/** A dirty chunk pinned at scan time: its merged delta + the OCC token to fence its purge against. */
interface PinnedChunk {
  readonly chunkKey: number;
  readonly delta: ChunkDelta;
  readonly token: Token;
}

/**
 * Fail fast on bad lease config at the boundary: an empty owner makes a lease steal unattributable, and a
 * non-positive/NaN leaseMs would produce a lease that's already expired (or never), silently defeating the
 * lease's whole job. Cheap to check once, up front, so a misconfigured daemon errors immediately. Exported so
 * callers that mutate **before** compacting (e.g. `CloudRoaring.eraseSubject`, which writes a `remove` tombstone
 * first) can validate the options up front rather than after the tombstone is written.
 */
export function validateCompactionOptions(options: CompactionOptions): void {
  if (typeof options.owner !== 'string' || options.owner.length === 0) {
    throw new ValidationError(
      'compaction: options.owner must be a non-empty string (the lease owner id)',
    );
  }
  if (
    options.leaseMs !== undefined &&
    (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0)
  ) {
    throw new ValidationError(
      `compaction: options.leaseMs must be a positive finite number; got ${options.leaseMs}`,
    );
  }
}

/**
 * Compact one segment. A no-op (returns `compacted: false`) if it has no dirty Warm rows or another worker
 * holds a live lease. Never throws on the normal contention/lease-loss paths — those are reported in `reason`.
 * Emits a `compaction` metric event per attempt (Phase D, gap #2) when a sink is wired, timing the attempt.
 */
export async function compactSegment(
  ref: SegmentRef,
  deps: CompactionDeps,
  options: CompactionOptions,
): Promise<CompactionResult> {
  validateCompactionOptions(options);
  const startedAt = deps.clock.now();
  const emit = (
    r: Pick<CompactionResult, 'compacted' | 'reason' | 'dirtyChunks' | 'purged'>,
  ): void => {
    if (deps.metrics === undefined) return;
    try {
      deps.metrics.onEvent({
        kind: 'compaction',
        namespace: ref.namespace,
        segment: ref.segment,
        compacted: r.compacted,
        reason: r.reason,
        dirtyChunks: r.dirtyChunks,
        purged: r.purged,
        ms: Math.max(0, deps.clock.now() - startedAt),
      });
    } catch {
      /* metrics must never break compaction */
    }
  };
  try {
    const result = await compactSegmentInner(ref, deps, options);
    emit(result);
    return result;
  } catch (err) {
    // A genuine fault (non-contention) — surface it, but still record the attempt (reason 'error') so a
    // poison segment is visible; `runCompactionCycle` isolates it + bumps consecutiveFailures.
    emit({ compacted: false, reason: 'error', dirtyChunks: 0, purged: 0 });
    throw err;
  }
}

async function compactSegmentInner(
  ref: SegmentRef,
  deps: CompactionDeps,
  options: CompactionOptions,
): Promise<CompactionResult> {
  const now = (): number => deps.clock.now();
  const maxBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const base = { segment: ref.segment, namespace: ref.namespace };
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);
  // Emit the audit record the moment a generation is *durably committed* — before the (idempotent, fenced,
  // resumable-next-cycle) Warm purge, so a post-commit purge fault can never drop the compliance record for a
  // generation that is already the authoritative current one. Called only on the two committed paths.
  const auditCompacted = (generation: number): void =>
    audit.onEvent({
      kind: 'segment.compact',
      namespace: ref.namespace,
      segment: ref.segment,
      generation,
    });
  // The crypto context for one generation of this segment, given its DEK's AEAD (undefined ⇒ cleartext). The
  // AAD binds each chunk/index to (segment, generation), so reading gen g and writing gen g+1 use distinct
  // contexts over the same DEK.
  const cryptoAt = (aead: Aead | undefined, generation: number): CrbmCrypto | undefined =>
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(ref, generation, scope) };
  const record = await deps.registry.get(ref);

  // A crypto-shredded segment is terminal — never resurrect it by compacting (that would re-encrypt under a
  // DEK whose wrappings are gone, or re-acquire a lease on a `destroyed` row). Leave it as the tombstone it is.
  if (record !== null && record.status === 'destroyed') {
    return {
      ...base,
      compacted: false,
      reason: 'destroyed',
      fromGen: record.currentGen,
      dirtyChunks: 0,
      purged: 0,
      survived: 0,
    };
  }

  // ── Bootstrap: a segment with **no Cold generation to merge onto**. That is either no registry row at all
  // (never compacted / bulk-loaded) or a row whose `currentGen` is `null` — a warm-only accumulator that has a
  // row only because something else needed it enumerable (a retention policy, `checkConsistency`, …). Both take
  // this path for the same reason: there is no gen `g` to read, so `g + 1` is meaningless and the merge basis is
  // the empty set. No cold base, no lease needed — publishing the pointer is the exclusivity point. Two workers
  // can race here, and gen 0 is write-once, so at most one *writes* it; the other(s) only see a conflict.
  // Critically, an adopter must NOT purge its pinned Warm rows against a gen 0 it didn't write — that gen may not
  // reflect them, which would be a lost write (**I4**). So only the worker that actually wrote gen 0 *and* saw
  // the pointer land purges; anyone else leaves its Warm rows for the next compaction to fold over gen 0. ──
  if (record === null || record.currentGen === null) {
    const pinned = await collectDirty(
      deps.warm,
      ref,
      maxBytes,
      requireCodec(deps.codec, 'compactSegment'),
    );
    if (pinned.length === 0)
      return {
        ...base,
        compacted: false,
        reason: 'clean',
        fromGen: null,
        dirtyChunks: 0,
        purged: 0,
        survived: 0,
      };
    // Encryption: mint a fresh per-segment DEK for gen 0 (or write cleartext). If we LOSE the gen-0 write race we
    // must not publish this DEK at all — see `publishGenZero`, which refuses to write key material for an object
    // this worker did not write. (An earlier version of this comment claimed a lost race meant "our minted DEK is
    // simply discarded". It was not: the publish ran unconditionally, so the loser could CAS its own wrapping onto
    // the row while the winner's bytes were encrypted under a different key — and the winner, seeing `currentGen`
    // at 0, then purged the Warm rows that held the only readable copy. Reproduced; see the tests.)
    let aead: Aead | undefined;
    let wrappedDeks: readonly WrappedDek[] | undefined;
    if (record?.wrappedDeks !== undefined && record.wrappedDeks.length > 0) {
      // A null-gen row that carries a DEK. No writer in this library produces that state today (every
      // `registry.create` site either publishes a generation or writes no wrappings), so in practice this is a
      // hand-written or restored row — the guard stays because the alternative is silent key loss. REUSE it rather than
      // minting a second one: the row's wrappings are what readers resolve the key from, so a fresh DEK would
      // either be overwritten (gen 0 unreadable) or overwrite theirs (nothing else decryptable). Same fail-fast
      // as the normal path — an encrypted row with no keystore is a lost key, not a cleartext segment.
      if (deps.keystore === undefined) {
        throw new KeyUnavailableError(
          `segment "${ref.segment}" is encrypted but compaction has no keystore`,
        );
      }
      aead = await deps.keystore.openDek(record.wrappedDeks);
      wrappedDeks = record.wrappedDeks;
    } else if (deps.keystore !== undefined) {
      const minted = await deps.keystore.createDek();
      aead = minted.aead;
      wrappedDeks = minted.wrapped;
    } else if (deps.requireEncryption === true) {
      throw new ValidationError(
        `requireEncryption: segment "${ref.segment}" needs a keystore to bootstrap encrypted`,
      );
    }
    const gen0: GenKey = { namespace: ref.namespace, segment: ref.segment, generation: 0 };
    const stream = mergeChunksStream(ref, null, pinned, deps, maxBytes, undefined);
    let wrote = true;
    let tally: { chunkKeys: number[]; cardinality: number } | undefined;
    try {
      tally = await writeCrbmGenerationStream(deps.cold, gen0, stream, {
        clock: deps.clock, // cooperative if the caller's clock can yield; a no-op if it only tells the time
        crypto: cryptoAt(aead, 0),
      });
    } catch (err) {
      // A concurrent bootstrap (or a crashed prior attempt) already wrote gen 0 — adopt it, don't fail.
      if (!isWriteConflictError(err)) throw err;
      wrote = false;
    }
    if (wrote && tally !== undefined) {
      await verifyGeneration(deps.cold, gen0, tally, cryptoAt(aead, 0)); // verify only bytes we wrote
    }
    // Publish the gen-0 pointer. Contention here is NOT only "another bootstrap worker": a null-gen row is a
    // normal row that `setRetention`, the dirty-count hint or an erasure can also CAS, so a conflict does not
    // imply someone published gen 0. `publishGenZero` re-reads and only reports success when the row actually
    // points at gen 0 — purging Warm against a pointer that is still `null` would be a silent lost write (I4).
    const published = await publishGenZero(deps.registry, ref, record, wrappedDeks, wrote);
    if (!wrote || !published)
      // Either we adopted another worker's gen 0 (our Warm rows may not be in it) or the pointer never landed on
      // ours — pointing somewhere else, or carrying someone else's key. All of them mean the same thing: purging
      // could lose data, so leave the rows for the next compaction to merge over the committed gen 0. No loss, no
      // torn read, and an unpublished gen-0 object is adopted by the next bootstrap rather than collected (a
      // null-gen row is never reconciled — `gcOrphanGenerations` deliberately collects nothing while the pointer
      // is null). `bootstrap-raced` covers all of them; the distinction is not actionable for a caller.
      return {
        ...base,
        compacted: false,
        reason: 'bootstrap-raced',
        fromGen: null,
        dirtyChunks: pinned.length,
        purged: 0,
        survived: pinned.length,
      };
    auditCompacted(0); // gen 0 is now the committed current generation (write-once object + registry row)
    const { purged, survived } = await purgeAfterCommit(deps.warm, ref, pinned);
    return {
      ...base,
      compacted: true,
      fromGen: null,
      toGen: 0,
      dirtyChunks: pinned.length,
      purged,
      survived,
    };
  }

  // ── Normal path: acquire/steal the lease. ──
  const expired = record.leaseExpiresAt === undefined || record.leaseExpiresAt <= now();
  const ownedByOther =
    record.status === 'compacting' && !expired && record.leaseOwner !== options.owner;
  if (ownedByOther) {
    return {
      ...base,
      compacted: false,
      reason: 'leased-by-other',
      fromGen: record.currentGen,
      dirtyChunks: 0,
      purged: 0,
      survived: 0,
    };
  }
  let leaseToken: Token;
  try {
    const res = await deps.registry.compareAndSwap(ref, record.token, {
      status: 'compacting',
      leaseOwner: options.owner,
      leaseExpiresAt: now() + leaseMs,
    });
    leaseToken = res.token;
  } catch (err) {
    if (isWriteConflictError(err)) {
      return {
        ...base,
        compacted: false,
        reason: 'leased-by-other',
        fromGen: record.currentGen,
        dirtyChunks: 0,
        purged: 0,
        survived: 0,
      };
    }
    throw err;
  }

  const g = record.currentGen;
  try {
    // Resolve the segment's DEK first (encrypted segments reuse it across generations). Doing it BEFORE the
    // gap-#5 re-read keeps a potentially slow keystore/KMS `openDek` OUT of the fence window below. Inside the
    // try so a failure releases the lease; KeyUnavailableError here is a genuine fault (lost key) — it propagates.
    let aead: Aead | undefined;
    if (record.wrappedDeks !== undefined && record.wrappedDeks.length > 0) {
      if (deps.keystore === undefined) {
        throw new KeyUnavailableError(
          `segment "${ref.segment}" is encrypted but compaction has no keystore`,
        );
      }
      aead = await deps.keystore.openDek(record.wrappedDeks);
    } else if (deps.requireEncryption === true) {
      throw new ValidationError(`requireEncryption: segment "${ref.segment}" is cleartext`);
    }

    // Fence RECONCILE against a concurrent publish/bulk-load (gap #5). `publishGeneration` /
    // `bulkLoadCrbmGeneration` CAS on the *current* token, NOT the lease, so one can advance `currentGen`
    // past `g` after our pre-lease read. Re-read it now that we hold the lease: if it moved, our compaction
    // basis (g) is stale and RECONCILE (`deleteGenerationsAbove(g)`) would delete the just-published
    // generation. Abort cleanly (nothing destructive has run) and let the next cycle re-pin.
    //
    // This closes the publish-completed-before-RECONCILE window. RESIDUAL (deferred — only lease-aware
    // publishing, the heavier option (a), fully closes it): a publish that lands *during* the sweep below,
    // after this re-read, is not caught, and its blast radius is NOT merely "a narrower lost update" — if the
    // raced publish picks gen == g+1 it's a silent whole-generation lost update; if it picks gen > g+1 the
    // sweep deletes the object `currentGen` now points at, leaving a dangling pointer (reads AND the next
    // compaction both throw, with no self-heal). Self-healing recovery here is a known deferral.
    const live = await deps.registry.get(ref);
    if (live === null || live.currentGen !== g) {
      // Best-effort: in this very race the superseding publish already bumped the record's token, so this CAS
      // typically conflicts and no-ops (swallowed) — the lease then recovers via expiry/steal, not here.
      await releaseLease(deps, ref, leaseToken);
      return {
        ...base,
        compacted: false,
        reason: 'superseded',
        fromGen: g,
        dirtyChunks: 0,
        purged: 0,
        survived: 0,
      };
    }

    // RECONCILE: drop orphan generations > g (a crashed prior stage). Safe — we hold the lease (exclusive), `g`
    // was just re-confirmed current, and readers are pinned to a committed gen ≤ g, so nothing references a gen > g.
    await deleteGenerationsAbove(deps.cold, ref, g);

    const pinned = await collectDirty(
      deps.warm,
      ref,
      maxBytes,
      requireCodec(deps.codec, 'compactSegment'),
    );
    if (pinned.length === 0) {
      await releaseLease(deps, ref, leaseToken); // nothing to do — give the lease back
      return {
        ...base,
        compacted: false,
        reason: 'clean',
        fromGen: g,
        dirtyChunks: 0,
        purged: 0,
        survived: 0,
      };
    }

    const newGen = g + 1;
    // Read the old generation under its (gen g) crypto; stream-write the new one under its (gen g+1) crypto.
    const stream = mergeChunksStream(ref, g, pinned, deps, maxBytes, cryptoAt(aead, g));
    await stageGeneration(
      deps.cold,
      { namespace: ref.namespace, segment: ref.segment, generation: newGen },
      stream,
      cryptoAt(aead, newGen),
      deps.clock,
    );

    // SWAP (commit) — conditional on the lease token. If our lease was stolen/expired-and-taken, this fails and
    // we abort *before* purging: the staged generation becomes an orphan (GC'd later), and not one Warm row was
    // deleted, so there is no data loss. We must NOT release the lease here — it belongs to the thief now.
    try {
      await deps.registry.compareAndSwap(ref, leaseToken, {
        currentGen: newGen,
        status: 'active',
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        dirtyChunkCount: 0,
        lastCompactedAt: now(), // dead-man's-switch (gap #2): a stale value = a stuck segment
        consecutiveFailures: 0, // a successful commit clears any prior poison-quarantine streak
      });
    } catch (err) {
      if (isWriteConflictError(err)) {
        return {
          ...base,
          compacted: false,
          reason: 'lease-lost',
          fromGen: g,
          dirtyChunks: pinned.length,
          purged: 0,
          survived: 0,
        };
      }
      throw err;
    }

    // The conditional currentGen swap above is the atomic commit — audit here, before purge.
    auditCompacted(newGen);
    const { purged, survived } = await purgeAfterCommit(deps.warm, ref, pinned);
    return {
      ...base,
      compacted: true,
      fromGen: g,
      toGen: newGen,
      dirtyChunks: pinned.length,
      purged,
      survived,
    };
  } catch (err) {
    // Abnormal exit before the commit (corrupt Warm row, cold I/O fault, or a stage write-conflict): release
    // the lease so the segment isn't stuck `compacting` until expiry. A WriteConflict here is a staging
    // conflict (an orphan we couldn't reconcile) — report it cleanly; any other error is a genuine fault, so
    // propagate it for the caller to handle (`runCompactionCycle` isolates per-segment failures).
    await releaseLease(deps, ref, leaseToken).catch(() => undefined);
    if (isWriteConflictError(err)) {
      return {
        ...base,
        compacted: false,
        reason: 'stage-conflict',
        fromGen: g,
        dirtyChunks: 0,
        purged: 0,
        survived: 0,
      };
    }
    throw err;
  }
}

/** How many times bootstrap re-reads and retries the gen-0 pointer publish before giving up for this cycle. */
const PUBLISH_GEN0_ATTEMPTS = 5;

/**
 * Make gen 0 the segment's current generation, whether the row is absent or exists with `currentGen: null`.
 * Returns **whether the row now points at gen 0** — the caller may only purge its pinned Warm rows if it does.
 *
 * `create` alone is not enough once a row can exist without a generation: it would throw a conflict against that
 * row, and the old code swallowed the conflict as "someone else published", then purged. Against a null-gen row
 * that is a silent lost write — the object exists, the pointer still says "no Cold data", and the Warm rows that
 * held the only copy are gone. So a conflict re-reads and retries, and `false` (never an exception) is how a
 * pointer we could not land is reported: nothing destructive has happened, and the next cycle re-pins.
 */
async function publishGenZero(
  registry: IRegistryDriver,
  ref: SegmentRef,
  known: RegistryRecord | null,
  wrappedDeks: readonly WrappedDek[] | undefined,
  wrote: boolean,
): Promise<boolean> {
  // A worker that LOST the write-once race must never publish key material, and this is the whole reason `wrote`
  // is threaded down here. The loser skips `verifyGeneration` (a full re-read of the object), so it is *likely* to
  // reach the registry first — and if it CASes its own wrapping onto the row, the winner then finds `currentGen`
  // at 0, concludes the publish succeeded, and purges the Warm rows that held the only readable copy. Gen 0 is
  // encrypted under the winner's DEK and the row carries the loser's: reads fail `AEAD authentication failed`
  // under an ACTIVE pointer, and `checkConsistency` cannot see it because the object is present. Reproduced.
  //
  // Adopting a cleartext generation stays safe (there is no key to get wrong) and is what keeps a crashed
  // bootstrap's orphan object from blocking the segment forever, so only the encrypted case bails.
  if (!wrote && wrappedDeks !== undefined) return false;
  let current = known;
  for (let attempt = 0; attempt < PUBLISH_GEN0_ATTEMPTS; attempt += 1) {
    try {
      if (current === null) {
        await registry.create(ref, {
          currentGen: 0,
          dirtyChunkCount: 0,
          status: 'active',
          wrappedDeks,
        });
      } else if (current.status === 'destroyed') {
        // A `dropSegment` landed while we were writing. Never resurrect a tombstone by pointing it at a fresh
        // generation — the shredded DEK makes those bytes unreadable anyway. Report failure; we purge nothing.
        return false;
      } else if (current.currentGen === null) {
        // `wrappedDeks` is spread in only when there is something to store: a patch clears an optional field by
        // mentioning it, so an unconditional `wrappedDeks: undefined` would wipe key material off the row on
        // every cleartext bootstrap. (The caller already reuses a DEK the row carries, so "undefined" here means
        // the row had none — but this must not depend on that staying true.)
        await registry.compareAndSwap(ref, current.token, {
          currentGen: 0,
          dirtyChunkCount: 0,
          ...(wrappedDeks === undefined ? {} : { wrappedDeks }),
        });
      } else {
        // Someone published while we worked. Only gen 0 can be the object we wrote (generations are write-once) —
        // AND the key on the row has to be the one we encrypted it with, or the pointer is live over bytes nobody
        // can decrypt. Reporting success on a key mismatch is what let the race above purge the last copy.
        return current.currentGen === 0 && sameWrappings(current.wrappedDeks, wrappedDeks);
      }
      return true;
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      current = await registry.get(ref);
    }
  }
  return false; // sustained contention — leave the Warm rows; the next cycle folds them over whatever won
}

/**
 * Whether a row's wrapped DEKs are the ones this worker wrote its generation under — compared by `(keyId,
 * wrapped)` pairs, since a wrapping is an opaque string and two DEKs never produce the same one. Cleartext on both
 * sides counts as a match; cleartext on one side and encrypted on the other does not, which is the point.
 */
function sameWrappings(
  a: readonly WrappedDek[] | undefined,
  b: readonly WrappedDek[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((w, i) => w.keyId === b[i]?.keyId && w.wrapped === b[i]?.wrapped);
}

/**
 * Garbage-collect superseded Cold generations for a segment: everything strictly below `currentGen`, keeping
 * the most recent `keep` of them as a grace window for in-flight readers pinned to a just-superseded
 * generation (**I5**). Generations ≥ `currentGen` are never touched. Returns the generations deleted.
 *
 * **Except on a `destroyed` segment, where EVERY generation is garbage** and the grace window is meaningless.
 * A tombstoned segment resolves no generation at all, so no reader is or can become pinned to one; and nothing
 * else in the library would ever collect them — the reconcile path that deletes generations above `currentGen`
 * returns early on a destroyed row, so without this those objects are billed forever.
 *
 * That state is reachable in practice: a `dropSegment` whose Cold sweep threw part-way, or a compaction that was
 * already staging when the tombstone landed and finished writing its object afterwards. `dropSegment` re-sweeps
 * and reports whatever it could not reclaim in `generationsRemaining`, but a drop that was never re-run leaves a
 * residual, and this is what eventually collects it under a running daemon.
 */
export async function gcOrphanGenerations(
  ref: SegmentRef,
  deps: Pick<CompactionDeps, 'cold' | 'registry'>,
  options: { keep?: number } = {},
): Promise<number[]> {
  const keep = Math.max(0, options.keep ?? 1);
  const record = await deps.registry.get(ref);
  if (record === null) return []; // no authoritative pointer → don't delete anything
  const current = record.currentGen;
  const gens: number[] = [];
  for await (const key of deps.cold.list(ref)) gens.push(key.generation);
  const toDelete =
    record.status === 'destroyed'
      ? gens.sort((a, b) => a - b) // all of it: no reader can be pinned to a tombstoned segment
      : current === null
        ? // No Cold pointer yet, so "below current" selects nothing and there is nothing safe to infer: an
          // object here is either a bootstrap about to publish gen 0 or an orphan we cannot tell apart from it.
          // Deleting would race that publish into a dangling pointer. RECONCILE collects it on the next cycle.
          []
        : // Delete generations below current, except the newest `keep` of them (the grace window).
          gens
            .filter((g) => g < current)
            .sort((a, b) => b - a) // newest-first
            .slice(keep);
  for (const generation of toDelete) {
    await deps.cold.delete({ namespace: ref.namespace, segment: ref.segment, generation });
  }
  return toDelete;
}

/** Collect + decode every live Warm row, pinning each chunk's OCC token for the fenced purge. */
async function collectDirty(
  warm: IWarmDriver,
  ref: SegmentRef,
  maxBytes: number,
  codec: CodecInterface,
): Promise<PinnedChunk[]> {
  const out: PinnedChunk[] = [];
  for await (const row of warm.listChunks(ref)) {
    out.push({
      chunkKey: row.chunkKey,
      token: row.token,
      delta: decodeDelta(row.bytes, maxBytes, codec),
    });
  }
  return out;
}

/**
 * Yield the new generation's chunks **ascending**: dirty chunks merged `(cold ∪ adds) \ removes`, clean chunks
 * copied through. An async generator so the writer streams them in constant memory (Phase 4f) — only one merged
 * chunk + the cold reader's index are live at a time, never the whole cold generation. (The pinned
 * Warm-delta map is still fully in memory — see the module caveat.)
 */
async function* mergeChunksStream(
  ref: SegmentRef,
  g: number | null,
  pinned: PinnedChunk[],
  deps: CompactionDeps,
  maxBytes: number,
  readCrypto: CrbmCrypto | undefined,
): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
  const codec = requireCodec(deps.codec, 'compactSegment');
  const dirty = new Map(pinned.map((p) => [p.chunkKey, p.delta]));
  const reader =
    g === null
      ? null
      : await openReader(
          deps.cold,
          { namespace: ref.namespace, segment: ref.segment, generation: g },
          readCrypto,
        );
  // The union of cold keys + dirty keys (a clean cold chunk is copied through unchanged), ascending.
  const keys = new Set<number>(dirty.keys());
  if (reader !== null) for (const k of reader.chunkKeys()) keys.add(k);

  for (const chunkKey of [...keys].sort((a, b) => a - b)) {
    const coldBytes = reader === null ? null : await reader.getChunk(chunkKey);
    const cold = coldBytes === null ? codec.empty() : codec.safeDeserialize(coldBytes, maxBytes);
    const merged = effective(cold, dirty.get(chunkKey) ?? emptyDelta(codec));
    if (!merged.isEmpty) yield { chunkKey, bitmap: merged };
  }
}

/** Stream-write the new generation (write-once), then re-open it to verify it round-trips what we merged. */
async function stageGeneration(
  cold: IColdDriver,
  key: GenKey,
  chunks: AsyncIterable<{ chunkKey: number; bitmap: CodecBitmap }>,
  crypto: CrbmCrypto | undefined,
  /** Threaded purely so the write can yield the event loop; see {@link CompactionDeps.clock}. */
  clock: Yielder | undefined,
): Promise<void> {
  // The normal path deletes orphan generations > g first, so a write-conflict here is a real race (a
  // concurrent compaction beat us to this generation) — let it surface as the staging conflict it is.
  const tally = await writeCrbmGenerationStream(cold, key, chunks, { crypto, clock });
  await verifyGeneration(cold, key, tally, crypto);
}

/**
 * Re-open a freshly written generation and assert it round-trips exactly what we merged: same per-chunk key
 * set *and* same total cardinality (on top of the codec's own per-chunk CRC + footer checks). `expected` is the
 * streaming writer's tally (the stream is consumed, so we can't re-iterate it) — the key-set comparison catches
 * a dropped/extra chunk that a cardinality-only check could miss when two errors cancel out.
 */
async function verifyGeneration(
  cold: IColdDriver,
  key: GenKey,
  expected: { chunkKeys: number[]; cardinality: number },
  crypto: CrbmCrypto | undefined,
): Promise<void> {
  const expectedCount = expected.cardinality;
  const expectedKeys = [...expected.chunkKeys].sort((a, b) => a - b);
  const reader = await openReader(cold, key, crypto);
  const actualKeys = [...reader.chunkKeys()].sort((a, b) => a - b);
  const keysMatch =
    actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]);
  if (!keysMatch) {
    throw new WriteConflictError(
      `compaction verify failed for ${key.segment}.${key.generation}: chunk-key set mismatch (${actualKeys.length} vs ${expectedKeys.length})`,
    );
  }
  if (reader.count() !== expectedCount) {
    throw new WriteConflictError(
      `compaction verify failed for ${key.segment}.${key.generation}: cardinality ${reader.count()} != ${expectedCount}`,
    );
  }
}

/** Version-fenced purge: delete each archived Warm row iff its token is unchanged; a newer one survives (I4). */
async function purge(
  warm: IWarmDriver,
  ref: SegmentRef,
  pinned: PinnedChunk[],
): Promise<{ purged: number; survived: number }> {
  let purged = 0;
  let survived = 0;
  for (const { chunkKey, token } of pinned) {
    const chunkRef: ChunkRef = { namespace: ref.namespace, segment: ref.segment, chunkKey };
    try {
      await warm.deleteConditional(chunkRef, token);
      purged += 1;
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      survived += 1; // rewritten after the scan → keep it for the next dirty set
    }
  }
  return { purged, survived };
}

/**
 * Purge archived Warm rows **after** a durable commit. Best-effort: the generation is already committed, and the
 * purge is fenced + idempotent (any row left behind simply re-folds — unchanged — on the next cycle, **I4**), so
 * a transient Warm fault here must NOT be attributed to compaction, which succeeded. Swallow it and report the
 * commit; the next cycle purges the remainder. Returns 0-purged on fault (the pinned rows survive, to be retried).
 * (Mirrors the best-effort `gcOrphanGenerations` call in {@link runCompactionCycle} — both are post-commit cleanup.)
 */
async function purgeAfterCommit(
  warm: IWarmDriver,
  ref: SegmentRef,
  pinned: PinnedChunk[],
): Promise<{ purged: number; survived: number }> {
  return purge(warm, ref, pinned).catch(() => ({ purged: 0, survived: pinned.length }));
}

/**
 * Delete every Cold generation strictly greater than `g` (crashed-stage orphans). Called under the lease with
 * `g` == the generation just **re-confirmed current** (gap #5) — never a stale pre-lease value, or a
 * concurrently published generation could be deleted. currentGen and below (which readers may be pinned to)
 * are never touched.
 */
async function deleteGenerationsAbove(
  cold: IColdDriver,
  ref: SegmentRef,
  g: number,
): Promise<void> {
  for await (const key of cold.list(ref)) {
    if (key.generation > g) await cold.delete(key);
  }
}

/** Best-effort lease release (set status back to active). Swallows a conflict — the lease will simply expire. */
async function releaseLease(
  deps: CompactionDeps,
  ref: SegmentRef,
  leaseToken: Token,
): Promise<void> {
  try {
    await deps.registry.compareAndSwap(ref, leaseToken, {
      status: 'active',
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
  } catch (err) {
    if (!isWriteConflictError(err)) throw err;
  }
}

/** Open a {@link CrbmReader} for one generation over the cold driver's range/tail reads (decrypting if `crypto`). */
function openReader(
  cold: IColdDriver,
  key: GenKey,
  crypto: CrbmCrypto | undefined,
): Promise<CrbmReader> {
  const blob: BlobReader = {
    getRange: (offset, length) => cold.getRange(key, offset, length),
    getTail: (maxBytes) => cold.getTail(key, maxBytes),
  };
  return CrbmReader.open(blob, { crypto });
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Discovery + daemon cycle (Option A: no hot-path coupling — the write path never touches the registry). To
// scale toward 100K segments (gap #3), discovery is **shardable** (each worker drains ~1/N of Warm), consumes
// the `dirtyChunkCount` hint for change-guarded CAS + urgency ordering, and **quarantines** poison segments
// (gap #2). It still drains Warm per in-shard segment to *count* dirty rows for correctness (O(total warm /
// shards)); turning that into O(dirty) needs the deferred cheap-enumeration seam (GSI/Select:COUNT — gap #3).
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  /** Scope discovery to one namespace (registry `list(namespace)`). */
  readonly namespace?: string;
  /** Minimum dirty Warm rows for a segment to be a candidate (default 1). */
  readonly threshold?: number;
  /**
   * Extra segments to consider beyond the registry's known set. Discovery enumerates `registry.list()`, which
   * only contains segments that have a committed generation — a brand-new **all-warm** segment isn't there
   * yet, so name it here (or bulk-load it once) for the daemon to pick it up.
   */
  readonly candidates?: readonly SegmentRef[];
  /**
   * Shard this worker's slice of the fleet (gap #3). With `totalShards > 1`, discovery considers only segments
   * whose **stable hash** (FNV-1a of the segment key, mod `totalShards`) falls in `shard` (0-based). Run N
   * daemons with `{ shard: i, totalShards: N }` to partition the fleet N ways — each **drains and compacts** only
   * its ~1/N of segments per cycle. NB: the registry enumeration + in-memory candidate set stay O(total segments)
   * per worker (the hash needs the key, which only the scan yields); only the Warm drain + compaction shard. The
   * O(dirty) indexed-enumeration seam that would shard the scan too is deferred (gap #3). Default: handle all.
   */
  readonly shard?: number;
  readonly totalShards?: number;
  /**
   * Poison-segment quarantine (gap #2): a segment whose `consecutiveFailures` has reached this threshold is
   * skipped by discovery (not even drained) until `quarantineCooldownMs` since its last registry update has
   * elapsed — then it's retried once (a transient fault self-heals; a persistent one re-quarantines). Default 5.
   */
  readonly quarantineThreshold?: number;
  /** Cooldown (ms) before a quarantined segment is retried once (default 5 min). */
  readonly quarantineCooldownMs?: number;
}

export interface CompactionCandidate {
  readonly ref: SegmentRef;
  readonly dirtyChunks: number;
  readonly currentGen: number | null;
  /** Epoch-ms of the segment's last successful compaction (undefined = never) — the urgency tie-break. */
  readonly lastCompactedAt?: number;
}

function validateShard(shard: number, totalShards: number): void {
  if (!Number.isInteger(totalShards) || totalShards < 1) {
    throw new ValidationError(`totalShards must be a positive integer; got ${totalShards}`);
  }
  if (!Number.isInteger(shard) || shard < 0 || shard >= totalShards) {
    throw new ValidationError(`shard must be an integer in [0, ${totalShards}); got ${shard}`);
  }
}

/** Deterministic FNV-1a shard assignment for a segment key — dependency-free, stable across workers/restarts. */
function shardOf(key: string, totalShards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  return (h >>> 0) % totalShards;
}

interface KnownSegment {
  readonly ref: SegmentRef;
  readonly currentGen: number | null;
  readonly token?: Token;
  readonly dirtyHint: number;
  readonly consecutiveFailures: number;
  readonly updatedAt: number;
  readonly lastCompactedAt?: number;
}

/**
 * Find segments worth compacting: those in this worker's shard with ≥ `threshold` dirty Warm rows, excluding
 * quarantined poison segments (gap #2). Enumerates the registry (optionally one namespace) plus explicit
 * `candidates`, then for each in-shard, non-quarantined segment drains `warm.listChunks` to count dirty rows —
 * O(total warm / shards) (turning that into O(dirty) needs the deferred GSI/Select:COUNT seam, gap #3). Refreshes
 * the `dirtyChunkCount` hint only when it **changed** (change-guarded CAS — no idle-segment write storm).
 */
export async function findCompactable(
  deps: Pick<CompactionDeps, 'warm' | 'registry' | 'clock'>,
  options: DiscoveryOptions = {},
): Promise<CompactionCandidate[]> {
  const threshold = Math.max(1, options.threshold ?? 1);
  const totalShards = options.totalShards ?? 1;
  const shard = options.shard ?? 0;
  validateShard(shard, totalShards);
  const quarantineThreshold = options.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
  const cooldownMs = options.quarantineCooldownMs ?? DEFAULT_QUARANTINE_COOLDOWN_MS;
  const now = deps.clock.now();

  const known = new Map<string, KnownSegment>();
  for await (const rec of deps.registry.list(options.namespace)) {
    // Partition leases are not segments — skip them in an unscoped fleet scan. They would never pass the dirty
    // threshold, so this is hygiene rather than a correctness fix: a lease row must not appear in `scanned`, or
    // an operator watching discovery counts sees a fleet that is one-per-partition larger than it is.
    if (options.namespace === undefined && rec.namespace === LEASE_NAMESPACE) continue;
    known.set(segmentKey(rec), {
      ref: { namespace: rec.namespace, segment: rec.segment },
      currentGen: rec.currentGen,
      token: rec.token,
      dirtyHint: rec.dirtyChunkCount,
      consecutiveFailures: rec.consecutiveFailures ?? 0,
      updatedAt: rec.updatedAt,
      lastCompactedAt: rec.lastCompactedAt,
    });
  }
  for (const ref of options.candidates ?? []) {
    const k = segmentKey(ref);
    if (!known.has(k)) {
      known.set(k, { ref, currentGen: null, dirtyHint: 0, consecutiveFailures: 0, updatedAt: 0 });
    }
  }

  const out: CompactionCandidate[] = [];
  for (const [key, seg] of known) {
    // Shard filter (gap #3): a worker handles only its slice, so it drains ~1/N of Warm per cycle.
    if (totalShards > 1 && shardOf(key, totalShards) !== shard) continue;
    // Poison-segment quarantine (gap #2): skip a repeatedly-failing segment — don't even drain it — until the
    // cooldown since its last update elapses, then let it retry once. Transient faults self-heal; persistent
    // ones re-quarantine on the next failure.
    if (seg.consecutiveFailures >= quarantineThreshold && now - seg.updatedAt < cooldownMs)
      continue;

    let dirty = 0;
    for await (const row of deps.warm.listChunks(seg.ref)) {
      void row;
      dirty += 1;
    }
    // Change-guarded CAS (gap #3): rewrite the hint only when it actually moved — no per-idle-segment write.
    if (seg.token !== undefined && dirty !== seg.dirtyHint) {
      try {
        await deps.registry.compareAndSwap(seg.ref, seg.token, { dirtyChunkCount: dirty });
      } catch (err) {
        if (!isWriteConflictError(err)) throw err;
      }
    }
    if (dirty >= threshold) {
      out.push({
        ref: seg.ref,
        dirtyChunks: dirty,
        currentGen: seg.currentGen,
        lastCompactedAt: seg.lastCompactedAt,
      });
    }
  }
  return out;
}

/** What one {@link runCompactionCycle} did: candidates found, how many committed, how many the budget deferred. */
export interface CompactionCycleResult {
  /** In-shard, non-quarantined segments over threshold this cycle. */
  readonly candidates: number;
  /** How many committed a new generation. */
  readonly compacted: number;
  /** Candidates left unprocessed by the `maxSegments` budget — run again to drain them. */
  readonly deferred: number;
  readonly results: CompactionResult[];
}

/**
 * Run one discovery → compact → GC cycle. The CLI/daemon calls this once (Lambda) or on a loop (K8s/ECS).
 * Candidates are processed **most-dirty first** (tie-broken by oldest/never-compacted), and an optional
 * `maxSegments` budget caps the **compact/GC** work per cycle — the rest are `deferred` to the next cycle
 * (urgency ordering keeps the hottest from starving). The budget bounds only compaction: discovery (the registry
 * scan + in-shard Warm drain + urgency sort) is paid in full each cycle, so at very large fleets discovery — not
 * compaction — is the per-cycle floor; the deferred resumable cursor (gap #3) is what will bound it. Per-segment
 * faults are isolated **and** counted toward quarantine (gap #2), so one poison segment can neither abort the
 * cycle nor silently freeze.
 */
export async function runCompactionCycle(
  deps: CompactionDeps,
  options: CompactionOptions & DiscoveryOptions & { keep?: number; maxSegments?: number },
): Promise<CompactionCycleResult> {
  validateCompactionOptions(options); // fail fast even when discovery finds zero candidates
  if (
    options.maxSegments !== undefined &&
    (!Number.isInteger(options.maxSegments) || options.maxSegments < 1)
  ) {
    // A positive integer or nothing. (0 as "compact none" is a footgun; negatives were silently "unlimited".)
    throw new ValidationError(`maxSegments must be a positive integer; got ${options.maxSegments}`);
  }
  const found = await findCompactable(deps, options);
  // Urgency ordering (gap #3): most-dirty first, tie-broken by oldest/never-compacted (undefined ⇒ 0 ⇒ first),
  // so a limited budget spends where it matters and the backlog can't starve the hottest segments.
  found.sort(
    (a, b) => b.dirtyChunks - a.dirtyChunks || (a.lastCompactedAt ?? 0) - (b.lastCompactedAt ?? 0),
  );
  const budget = options.maxSegments; // validated to a positive integer (or undefined) above
  const picked = budget !== undefined ? found.slice(0, budget) : found;

  const results: CompactionResult[] = [];
  let compacted = 0;
  for (const { ref } of picked) {
    // Isolate per-segment faults: a poison-pill segment (corrupt Warm row, cold I/O error) must not abort the
    // whole cycle — record it, count it toward quarantine, and move on to the healthy segments.
    try {
      const result = await compactSegment(ref, deps, options);
      results.push(result);
      if (result.compacted) {
        compacted += 1;
        // Orphan GC is best-effort cleanup (the next cycle's GC catches up the backlog), and the new generation is
        // already durably committed — so a GC fault must NOT be attributed to compaction. Isolate it from the
        // fault path below: otherwise a transient cold/registry error here would bump this *healthy* segment's
        // consecutiveFailures toward quarantine and push a phantom `error` result for a segment that succeeded.
        await gcOrphanGenerations(ref, deps, { keep: options.keep }).catch(() => undefined);
      }
    } catch (err) {
      await bumpFailure(deps, ref).catch(() => undefined); // best-effort; quarantine only needs it eventually
      results.push({
        segment: ref.segment,
        namespace: ref.namespace,
        compacted: false,
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
        fromGen: null,
        dirtyChunks: 0,
        purged: 0,
        survived: 0,
      });
    }
  }
  return { candidates: found.length, compacted, deferred: found.length - picked.length, results };
}

/**
 * Increment a segment's `consecutiveFailures` toward poison-quarantine (gap #2) after an isolated compaction
 * fault. Best-effort + conditional: a lost CAS (a concurrent writer) is harmless — the count just advances on a
 * later failing cycle. A successful compaction resets it to 0 (in the commit swap).
 */
async function bumpFailure(deps: Pick<CompactionDeps, 'registry'>, ref: SegmentRef): Promise<void> {
  const rec = await deps.registry.get(ref);
  if (rec === null) return; // no row yet (a bootstrap fault) — nothing to quarantine against
  try {
    await deps.registry.compareAndSwap(ref, rec.token, {
      consecutiveFailures: (rec.consecutiveFailures ?? 0) + 1,
    });
  } catch (err) {
    if (!isWriteConflictError(err)) throw err;
  }
}
