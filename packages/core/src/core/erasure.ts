/**
 * Whole-segment erasure: crypto-shred (`destroySegment`, `eraseNamespace`) and disposal (`dropSegment`).
 *
 * GDPR "right to erasure" on immutable, backed-up storage: you can't delete a `.crbm` object from every
 * backup, but you can **delete its key**. `destroySegment` drops the segment's wrapped DEK(s) from its current
 * registry row (a CAS to a `destroyed` tombstone). Every copy of the encrypted Storage bytes, backups and WORM copies
 * included, is then unreadable once no retained copy of the row still holds the wrapped key (a noncurrent version, a
 * backup or a point-in-time copy of the row), or once every KEK that wrapped it is destroyed; until then a registry
 * restore to a point before the shred makes the segment readable again. **Immediate**, and it cannot be undone
 * through the library (a registry restore to before it can), so it's gated behind an explicit confirmation (the
 * segment's name; the namespace is not checked, so build the ref's `namespace` from a value you have checked). A `destroyed` segment reads as empty (its current row holds no DEK). Only works on an
 * **encrypted** segment; a cleartext segment has no key to shred.
 *
 * The tombstone is also the fence every writer respects: a load refuses
 * a `destroyed` row, so a load racing an erasure cannot resurrect the segment. A single id's erasure is a different
 * operation — `eraseIdFromSegment` rewrites the generation without it.
 */
import { type IAuditSink, NOOP_AUDIT, checkedAuditSink, safeAudit } from './audit';
import { incarnationField } from './token';
import { mapWithConcurrency } from './concurrency';
import { generationsOf } from './generation-list';
import { ValidationError, WriteConflictError, isWriteConflictError } from './errors';
import { casRetry } from './cas-retry';
import type { ChurnDeps } from './leases';
import type { IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef, Token } from './ports';
import { validateUserNamespace, validateUserRef } from './validate';
import { DEFAULT_MAX_SCAN_SEGMENTS, drainRegistry } from './registry-scan';
import { withoutSweepMark } from './retention';

/**
 * What the erasure calls need: the registry whose rows they tombstone, and, optionally, the clock and rng they wait out
 * lease churn with.
 */
export interface EraseDeps extends ChurnDeps {
  /** The registry holding the segments' rows. */
  readonly registry: IRegistryDriver;
}

/**
 * What destroying one segment did: a crypto-shred, a cleartext tombstone (the bytes stay readable), nothing for a
 * segment already destroyed or absent, or, with `destroyed: false` and a `reason`, a segment left as it was, which may
 * still hold data. The result of `destroySegment`, and one entry of what `eraseNamespace` returns.
 */
export interface DestroyResult {
  /** The segment's name. */
  readonly segment: string;
  /** The segment's namespace, or `undefined` for the default one. */
  readonly namespace?: string;
  /** True iff the segment is now a `destroyed` tombstone (incl. the idempotent already-destroyed case). */
  readonly destroyed: boolean;
  /**
   * True iff **this call** performed a genuine crypto-shred — an encrypted segment whose wrapped DEK(s) were
   * dropped from its current registry row, so its Storage bytes, in any copy, are unreadable once no retained copy
   * of the row holds the key, or every KEK that wrapped it is destroyed. False for a cleartext tombstone (bytes
   * remain readable), for the idempotent already-destroyed case, and for an absent segment. This is what the
   * `segment.erase` audit event keys off — a cleartext "erase" destroys no key.
   */
  readonly cryptoShredded: boolean;
  /**
   * Why this segment was not a fresh crypto-shred. `'absent'` (no registry row), `'already'` (already
   * destroyed), `'cleartext'` (no DEK to shred) — and from `eraseNamespace` only, where per-segment faults are
   * isolated so one failure cannot discard the ledger: `'contended'` (the row was rewritten during every CAS
   * attempt) or `` `failed: <message>` `` (any other fault).
   *
   * The last two come with `destroyed: false` and mean **the segment still holds data**. A namespace erase
   * returns them rather than throwing, so its entries have to be inspected — see {@link eraseNamespace}.
   */
  readonly reason?: string;
}

const MAX_CAS_ATTEMPTS = 8;
/**
 * Storage deletes (or, for a namespace erase, segment shreds) in flight at once. Erasure is a fan-out over *independent* keys, so serial would pay one
 * round-trip per generation for work that has no ordering between items; unbounded would be a self-inflicted
 * thundering herd against one bucket. Not configurable: an admin path called by a human or a nightly job.
 */
const ERASE_CONCURRENCY = 8;
/**
 * Storage list-then-delete passes a drop will make before giving up and reporting the residual.
 *
 * Two is the honest floor and three is the working value: pass 1 clears what was there, pass 2 catches an object
 * a load that had read the row before the tombstone landed went on to write (its publish is then refused, but the
 * object write completes), pass 3 covers a second such writer. It terminates regardless — the tombstone
 * hard-fences *publishing* a new generation, and any residual is reported rather than silently dropped. A load still
 * consuming its ids can write after the last pass; it deletes its own object once its publish is refused.
 */
const MAX_STORAGE_SWEEPS = 3;

/**
 * Crypto-shred one segment. It cannot be undone through the library (a registry restore to a point before it can).
 * `confirmSegment` must equal `ref.segment` (a guard against an accidental destroy of another name; it checks the
 * name only, not the namespace, so build the ref's `namespace` from a value you have checked). A non-encrypted segment is rejected unless you opt in via `allowCleartext` (there's no key to shred; its
 * Storage bytes stay readable — the tombstone only stops the segment resolving).
 */
export async function destroySegment(
  ref: SegmentRef,
  deps: EraseDeps,
  options: { confirmSegment: string; allowCleartext?: boolean; audit?: IAuditSink },
): Promise<DestroyResult> {
  validateUserRef(ref, 'destroySegment');
  checkedAuditSink(options.audit, 'destroySegment');
  if (options.confirmSegment !== ref.segment) {
    throw new ValidationError(
      `destroySegment: confirmSegment must equal the segment name "${ref.segment}" (guard against accidental crypto-shred)`,
    );
  }
  const { token, ...result } = await shredSegment(ref, deps, {
    allowCleartext: options.allowCleartext ?? false,
  });
  // Audit only a genuine crypto-shred — not the idempotent already-destroyed/absent no-ops, and not a
  // cleartext tombstone (whose Storage bytes stay readable, so it destroys no key).
  if (result.cryptoShredded) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.erase',
      namespace: ref.namespace,
      segment: ref.segment,
      ...incarnationField(token),
    });
  }
  return result;
}

/**
 * Crypto-shred every segment in a namespace. It cannot be undone through the library (a registry restore to a point
 * before it can). `confirmNamespace` must equal `namespace`. Returns a per-segment result (skips cleartext segments
 * unless `allowCleartext`).
 *
 * **Bounded.** It lists the whole namespace before it destroys anything, and holds the listing resident, so the
 * listing is capped at `maxScanSegments` (default 250,000), the ceiling every
 * other fleet scan keeps. A namespace over it throws `BudgetExceededError` **before any segment is destroyed**,
 * never part-way through; raise `maxScanSegments` when the namespace really is that large and the memory is there.
 * A `maxScanSegments` that is not a safe whole number of at least 1 throws `ValidationError`, again before anything is destroyed.
 */
export async function eraseNamespace(
  namespace: string,
  deps: EraseDeps,
  options: {
    confirmNamespace: string;
    allowCleartext?: boolean;
    audit?: IAuditSink;
    maxScanSegments?: number;
  },
): Promise<{ destroyed: DestroyResult[] }> {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new ValidationError('eraseNamespace: namespace must be a non-empty string');
  }
  validateUserNamespace(namespace);
  checkedAuditSink(options.audit, 'eraseNamespace');
  if (options.confirmNamespace !== namespace) {
    throw new ValidationError(
      `eraseNamespace: confirmNamespace must equal the namespace "${namespace}" (guard against accidental erasure)`,
    );
  }
  // The whole listing is drained, and bounded, before the first segment is destroyed: a namespace over the
  // ceiling is refused with nothing erased, not abandoned part-way through a loop the library cannot undo.
  const rows = await drainRegistry(deps.registry, {
    namespace,
    // Only an absent value means the default: a `null` or a malformed one is refused, as a malformed `budget` is.
    maxScanSegments:
      options.maxScanSegments === undefined ? DEFAULT_MAX_SCAN_SEGMENTS : options.maxScanSegments,
    op: 'eraseNamespace',
    narrowable: false, // already one namespace: the only remedy is a higher ceiling
  });
  const refs: SegmentRef[] = rows.map((rec) => ({
    namespace: rec.namespace,
    segment: rec.segment,
  }));
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);
  let segmentsShredded = 0;
  // Segments are shredded with bounded concurrency, each behind its own fence (a get and a compare-and-swap), and
  // the ledger comes back in the listing's order whatever order they finish in. The `segment.erase` events are
  // emitted as each segment finishes, so their order is the order of finishing, not the listing's; the `namespace.erase` event
  // still comes last.
  const destroyed = await mapWithConcurrency(refs, ERASE_CONCURRENCY, async (ref) => {
    // Per-segment faults stay isolated so one failure cannot discard the ledger, mirroring `eraseSubject`'s
    // entries ("one failure never aborts the ledger") and for the same reason: on an erasure command the
    // caller's load-bearing question is *which segments are now destroyed*, and an exception thrown from the
    // middle of the loop answers it for none of them while having already destroyed some.
    //
    // Every error is caught, not just contention — again matching `eraseSubject`, which records any thrown
    // fault as a ledger entry rather than deciding which faults deserve a record. A `KeyUnavailableError` on
    // segment 3 is exactly as important to report as a `WriteConflictError`, and just as segment-local.
    //
    // NOTE the caller's obligation, because this is quieter than a throw: entries must be INSPECTED.
    // `destroyed: false` with a `reason` is a segment that still holds data. The `namespace.erase` audit event
    // carries the honest `segmentsShredded` count, which will be lower than the segment count, so an audit
    // trail still shows the shortfall even if the return value is ignored.
    let result: DestroyResult;
    let token: Token | undefined;
    try {
      ({ token, ...result } = await shredSegment(ref, deps, {
        allowCleartext: options.allowCleartext ?? false,
      }));
    } catch (err) {
      result = {
        segment: ref.segment,
        namespace: ref.namespace,
        destroyed: false,
        cryptoShredded: false,
        reason: isWriteConflictError(err)
          ? 'contended'
          : `failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // A per-segment record for each genuine crypto-shred, so the trail can prove *which* segments were
    // destroyed (each carries the namespace) — not just that the command ran.
    if (result.cryptoShredded) {
      segmentsShredded += 1;
      audit.onEvent({
        kind: 'segment.erase',
        namespace: ref.namespace,
        segment: ref.segment,
        ...incarnationField(token),
      });
    }
    return result;
  });
  // Plus one namespace-level record of the erasure command, carrying the honest count actually shredded
  // (may be 0 — e.g. an empty namespace, or all-cleartext without `allowCleartext`): the command ran, but
  // the count keeps the record from over-attesting a destruction that did not happen.
  audit.onEvent({ kind: 'namespace.erase', namespace, segmentsShredded });
  return { destroyed };
}

/**
 * Deps for {@link dropSegment}. Adds `storage`, because unlike a crypto-shred this one deletes the objects.
 */
export interface DropDeps extends EraseDeps {
  readonly storage: IStorageDriver;
}

/** What `dropSegment` did to one segment, or, on a dry run, would do. */
export interface DropResult {
  /** The segment's name. */
  readonly segment: string;
  /** The segment's namespace, or `undefined` for the default one. */
  readonly namespace?: string;
  /**
   * **True iff this segment is now empty as a result of this call — or already was.** This is the field a
   * retention job should branch on: `false` means the call found nothing to do and your ref is probably wrong.
   */
  readonly dropped: boolean;
  /** Storage generations physically deleted, ascending. Empty on a dry run — see {@link DropResult.wouldDelete}. */
  readonly generationsDeleted: readonly number[];
  /**
   * Generations still present in Storage when the sweep gave up, ascending. **Empty is the normal outcome** — a
   * non-empty value means the storage was NOT fully reclaimed and the drop should be re-run.
   *
   * Without it, a drop would return `dropped: true` with a populated `generationsDeleted` and no `reason` even
   * when an object holding the **complete set** had just been left in the bucket by a writer that was already
   * mid-write when the tombstone landed (its publish is refused, but the object survives). For a cleartext
   * segment those bytes are readable — and the collection only takes a destroyed segment's generations
   * when something runs it. That result would look like a clean drop, and an operator would get no signal to
   * re-run.
   */
  readonly generationsRemaining: readonly number[];
  /**
   * On a dry run, the generations that **would** be deleted. `undefined` on a real run.
   *
   * This exists because the confirmation guard the erasure calls use — naming the segment twice — protects a
   * hand-typed literal and nothing else. In the loop this operation is actually *for*
   * (`for (const day of expired) drop({segment: day}, {confirmSegment: day})`) the same variable appears twice
   * and the guard is pure ceremony. A dry run is the guard that still works when a machine is calling.
   *
   * It is a **snapshot**: a later real run can see a different set.
   */
  readonly wouldDelete?: readonly number[];
  /**
   * On a dry run, whether the real drop would **also** crypto-shred (i.e. the segment is encrypted).
   * `undefined` on a real run. This is the one fact in the preview that reaches every copy of the objects, backups
   * and WORM copies included (once no retained copy of the row holds the key, or every KEK that wrapped it is
   * destroyed) — a dry run that did not surface it would preview the recoverable half only.
   */
  readonly wouldCryptoShred?: boolean;
  /**
   * True iff the segment was encrypted and its wrapped DEK(s) were dropped from its current registry row as part of
   * this call — so its bytes are unreadable in every copy, backups included, once no retained copy of the row holds
   * the key or every KEK that wrapped it is destroyed, not merely deleted from the bucket. Deleting an object does
   * not reach a noncurrent version, a replica, or a PITR snapshot; removing the key does, on those terms.
   */
  readonly cryptoShredded: boolean;
  /**
   * How the segment got to its current state. Absent on a fresh, ordinary drop (tombstone written, Storage swept).
   *
   * - `'already'` — it was already a tombstone. Idempotent; pairs with `dropped: true`. A re-drop is **not** a
   *   no-op — it re-sweeps Storage, so it is how a residual in `generationsRemaining` is collected.
   * - `'absent'` — **nothing existed.** No registry row and no Storage objects. Pairs with `dropped: false`, and it
   *   is the one value worth alerting on: the usual cause is a mistyped name or an omitted `namespace`, both of
   *   which address a *different* segment than you meant.
   */
  readonly reason?: string;
}

/**
 * **Dispose of a segment: tombstone it, then delete its Storage objects.** It cannot be undone through the library
 * (a restore from the registry's and the bucket's versions or backups can).
 *
 * WHY THIS EXISTS, given {@link destroySegment} already erases. Because `destroySegment` answers a *compliance*
 * question and this one answers an *operational* question, and they are not the same:
 *
 * - `destroySegment` **crypto-shreds** — it removes the key from the segment's current registry row, so the bytes
 *   are unreadable everywhere, immutable backups included, once no retained copy of the row holds the key or every
 *   KEK that wrapped it is destroyed: the only erasure that reaches WORM copies of the objects. But it **leaves the
 *   objects in the bucket**, still billed, and it *requires* encryption because a cleartext segment has no key to
 *   discard.
 * - `dropSegment` **removes the storage**. It works on a cleartext segment, and on an encrypted one it *also*
 *   drops the DEKs, so it is a strict superset there.
 *
 * It is the supported way to delete a segment and stop paying for it. The obvious workaround — an object-store
 * lifecycle rule on the key prefix — deletes the bytes while the registry still points at them. That is exactly the `missing-storage-generation` state the DR runbook says not to serve traffic
 * on, and it surfaces *intermittently*, because a read consults the cache before Storage: cached chunks answer
 * correctly and evicted ones throw. The whole value of this function is that the ordering below cannot be got
 * wrong by a caller.
 *
 * **THE ORDER IS THE CONTRACT — registry first, then Storage.**
 *
 * 1. **Registry first.** After the tombstone nothing resolves a generation for this segment, so no reader can
 *    reach for bytes that are about to disappear, and no writer can publish onto it (a
 *    load refuses a `destroyed` row).
 * 2. **Storage second, best-effort, and re-swept.** Once the pointer is a tombstone the segment resolves as empty,
 *    so a failure part-way through leaves **orphaned bytes, not a wrong answer.** Orphans cost money and are
 *    cleaned up by re-running; a torn pointer costs correctness and is not self-healing. Given the choice, leak
 *    bytes — but say so: whatever survives the sweep is reported in {@link DropResult.generationsRemaining}.
 *
 * **Why step 2 sweeps more than once.** A load that had read the row before the tombstone landed, whether it was
 * already writing its object or still consuming its ids, still finishes the write — its publish is then refused,
 * but the object exists, and it holds the complete set. A single list-then-delete misses it entirely. The re-sweep
 * converges because the tombstone *is* a hard fence on **publishing**, so only loads already under way can write
 * and they are finite. One that writes after the last pass deletes its own object when its publish is refused, as a
 * refused load and a refused erasure rewrite do under a `destroyed` row; only one whose process stops in between, or whose publish fails without
 * a definite answer (a lost response, a timeout), leaves it behind, for a re-run of the drop, and
 * `generationsRemaining` cannot report an object written after this call returned.
 *
 * **When "reads as empty" starts being true.** Not instantly, for a store that has already read this segment: a
 * resolved generation is cached and decoded chunks sit in the cache, so an in-flight reader can answer from
 * cache for a window. A fresh store, or any reader that had not touched the segment, sees empty at once.
 *
 * That window is bounded by `cache.genTtlMs` (default 2 s) **only for a reader whose storage source has both a clock
 * and a registry and a positive TTL** — expiry needs all three. A source built without a clock or a registry, or
 * with `cache.genTtlMs: 0`, has no timed refresh: it notices the drop only when a read has to fetch from a deleted
 * generation or its reader cache evicts the segment. Because a cache-LRU hit never reaches Storage, such a reader
 * can answer `true` for a dropped segment **indefinitely**, and must be invalidated or restarted. This is the *same* caching that makes the delete-bytes-first ordering fail intermittently rather
 * than loudly — it cuts both ways.
 *
 * `confirmSegment` must equal `ref.segment`, matching `destroySegment`/`eraseNamespace`. For an automated
 * caller that guard is ceremony — use `dryRun` first, which reports what would go without touching anything.
 */
export async function dropSegment(
  ref: SegmentRef,
  deps: DropDeps,
  options: { confirmSegment: string; dryRun?: boolean; audit?: IAuditSink },
): Promise<DropResult> {
  return (await dropSegmentFor(ref, deps, options, undefined))!;
}

/**
 * What the retention sweep adds to a drop. `wanted` is judged on every row the shred is about to replace with a
 * tombstone, so a row whose expiry was extended or cleared after the sweep looked, or that someone else has already
 * destroyed or purged, is left as it is rather than retired. `stamp` is the `retention` the tombstone carries, written
 * in the shred's own write, so only a tombstone a sweep wrote ever carries a sweep's mark, which is what lets a later
 * sweep purge it and never a crypto-shred's.
 */
interface SweepDrop {
  readonly wanted: (row: RegistryRecord) => boolean;
  readonly stamp: (retention: RegistryRecord['retention']) => RegistryRecord['retention'];
}

/**
 * {@link dropSegment}, with what a retention sweep adds: `null` when `sweep.wanted` refused the row, with nothing
 * written or deleted.
 */
export async function dropSegmentFor(
  ref: SegmentRef,
  deps: DropDeps,
  options: { confirmSegment: string; dryRun?: boolean; audit?: IAuditSink },
  sweep: SweepDrop | undefined,
): Promise<DropResult | null> {
  validateUserRef(ref, 'dropSegment');
  checkedAuditSink(options.audit, 'dropSegment');
  if (options.confirmSegment !== ref.segment) {
    throw new ValidationError(
      `dropSegment: confirmSegment must equal the segment name "${ref.segment}" (guard against accidental deletion)`,
    );
  }
  const base = { segment: ref.segment, namespace: ref.namespace };

  if (options.dryRun === true) {
    const record = await deps.registry.get(ref);
    const wouldDelete = await generationsOf(deps.storage, ref);
    return {
      ...base,
      dropped: false,
      generationsDeleted: [],
      generationsRemaining: [],
      wouldDelete,
      wouldCryptoShred: record?.wrappedDeks !== undefined && record.wrappedDeks.length > 0,
      cryptoShredded: false,
      reason:
        record === null
          ? wouldDelete.length === 0
            ? 'absent'
            : undefined
          : record.status === 'destroyed'
            ? 'already'
            : undefined,
    };
  }

  // Step 1, reused wholesale. `allowCleartext` is true because deleting objects does not need a key — the
  // encryption requirement belongs to crypto-shred, not to disposal.
  const first = await shredSegment(ref, deps, { allowCleartext: true, op: 'dropSegment', sweep });
  if (first === null) return null;
  let shred = first;

  // ── THE ABSENT CASE. ───────────────────────────────────────────────────────────────────────────────────────
  // `shredSegment` returns `absent` having written NOTHING when there is no registry row — and going on to delete
  // every Storage generation anyway would skip the one step that makes the ordering safe while still running the
  // destructive one: a drop landing between a load's object write and its publish (minutes apart on a large
  // load) would leave a published pointer with no object behind it — precisely the
  // `missing-storage-generation` state this function exists to PREVENT.
  //
  // So the identity is claimed before anything is deleted. A `destroyed` row is exactly the fence the
  // writers already respect — a load refuses one — so creating it
  // converts the race into "the writer is refused and the bytes are collected".
  //
  // Only when Storage actually holds something, though. A drop against a *genuinely* nonexistent segment (the
  // typo the facade docs warn about) must not leave a `destroyed` row behind: that is registry litter, and worse,
  // it would refuse a later legitimate load of that name forever. No row and no objects ⇒ nothing existed ⇒ say
  // `absent` and touch nothing, which is what that reason is documented to mean.
  if (shred.reason === 'absent') {
    const orphans = await generationsOf(deps.storage, ref);
    if (orphans.length === 0) {
      return {
        ...base,
        dropped: false,
        generationsDeleted: [],
        generationsRemaining: [],
        cryptoShredded: false,
        reason: 'absent',
      };
    }
    try {
      const tombstone = await deps.registry.create(ref, {
        // The max listed generation, so the row is consistent with what is on disk if anything reads it before
        // the sweep finishes. It is a tombstone, so no reader resolves through it either way.
        currentGen: orphans[orphans.length - 1]!,
        status: 'destroyed',
      });
      shred = { ...shred, destroyed: true, reason: undefined, token: tombstone.token };
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // A row appeared between our `get` and our `create` — that is the racing writer we were trying to fence,
      // and it won. Fall back into the normal path, which now has a row to CAS into a tombstone.
      shred = await shredSegment(ref, deps, { allowCleartext: true, op: 'dropSegment' });
    }
  }

  // `segment.erase` ONLY on a genuine crypto-shred — exactly the condition `destroySegment` uses, and
  // deliberately NOT `|| generationsDeleted.length > 0`.
  //
  // Adding that disjunct would be wrong in a way that matters. Four documents — including
  // `docs/guide/dashboards.md`, which calls this event the compliance *receipt* — define `segment.erase` as
  // proof of a crypto-shred: the key gone from the segment's current row, which reaches every copy of the objects,
  // backups included, once no retained copy of the row holds it. Deleting an object is a weaker guarantee, because
  // a noncurrent version, a cross-region replica or a PITR snapshot still holds the cleartext. Emitting one event
  // for both would make a compliance dashboard **over-attest**, which is the one failure an audit trail exists to
  // prevent.
  //
  // The cleartext case is NOT silent — it emits `segment.dispose` after the sweep (below). That kind exists
  // precisely so this one does not have to lie: disposal is attested as disposal, shredding as shredding, and an
  // encrypted drop emits both because both genuinely happened.
  //
  // And it goes out BEFORE the Storage sweep, not after. The library's part of a genuine crypto-shred is done the
  // moment `shredSegment` returns — the DEK wrappings are gone from the current row. If the sweep
  // then throws (a Storage driver that cannot list), emitting afterwards would mean **no receipt for a destruction
  // that really happened** — the exact mirror of the over-attestation above, and just as wrong. Both directions
  // of a false audit trail are defects; only one of them was obvious.
  if (shred.cryptoShredded) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.erase',
      namespace: ref.namespace,
      segment: ref.segment,
      ...incarnationField(shred.token),
    });
  }

  // Step 2, swept until Storage comes back empty. See "Why step 2 sweeps more than once" above. `mapWithConcurrency`
  // returns results in *input* order, so each pass contributes ascending generations and the concatenation stays
  // ascending. Failures are swallowed per item so the pool never aborts — one unreachable generation must not
  // leave the rest orphaned too.
  // A throw from a listing propagates, and from the real run it does not mean the drop failed: the tombstone is written,
  // so the segment is dropped and only bytes leaked. It is the signal to re-run, which takes the `'already'` path and
  // sweeps again. The audit event for the shred is emitted before the sweep for the same reason.
  const generationsDeleted: number[] = [];
  for (let pass = 0; pass < MAX_STORAGE_SWEEPS; pass++) {
    const present = await generationsOf(deps.storage, ref);
    if (present.length === 0) break;
    const outcomes = await mapWithConcurrency(present, ERASE_CONCURRENCY, async (generation) => {
      try {
        await deps.storage.delete({ ...ref, generation });
        return generation;
      } catch {
        // Leave it orphaned. The segment already reads as empty, so this is a billing problem, not a
        // correctness one, and re-running the drop collects whatever was missed.
        return null;
      }
    });
    let deletedThisPass = 0;
    for (const g of outcomes) {
      if (g !== null) {
        generationsDeleted.push(g);
        deletedThisPass += 1;
      }
    }
    if (deletedThisPass === 0) break; // nothing went — another pass will not help
  }
  // Enumerate once more rather than inferring the residual from the last pass, so the reported value is exactly
  // what is still in Storage whichever way the loop ended: empty, a delete that kept failing, or the pass budget
  // exhausted while a writer kept finishing. Inferring it would report `[]` in precisely the case that matters
  // — a final pass that deleted everything it saw, after which one more object appeared.
  const generationsRemaining = await generationsOf(deps.storage, ref);

  // `segment.dispose` attests the *storage reclamation*, which is the weaker but still compliance-relevant fact,
  // and it is emitted AFTER the sweep because unlike a crypto-shred it is not established until the sweep runs.
  // Only when a tombstone was actually written — an absent no-op disposed of nothing.
  if (shred.destroyed) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.dispose',
      namespace: ref.namespace,
      segment: ref.segment,
      ...incarnationField(shred.token),
      generationsDeleted: generationsDeleted.length,
    });
  }

  return {
    ...base,
    dropped: shred.destroyed,
    generationsDeleted,
    generationsRemaining,
    cryptoShredded: shred.cryptoShredded,
    reason: shred.reason,
  };
}

/** What a shred is told: whether a cleartext segment may be tombstoned, which command's name its errors carry, and the sweep it serves. */
interface ShredOptions {
  readonly allowCleartext: boolean;
  readonly op?: 'destroySegment' | 'dropSegment';
  readonly sweep?: SweepDrop;
}

/** A shred's result, with a token of the tombstone it wrote or found: where its audit events read the incarnation. */
type Shred = DestroyResult & { readonly token?: Token };

/**
 * The shred itself: CAS the registry row to a `destroyed` tombstone with no wrappings.
 *
 * `op` is only for error text — `destroySegment` and `dropSegment` both come through here, and a message naming
 * the wrong one is operator-facing text on the single path where the operator must act.
 */
async function shredSegment(
  ref: SegmentRef,
  deps: EraseDeps,
  options: ShredOptions & { readonly sweep?: undefined },
): Promise<Shred>;
async function shredSegment(
  ref: SegmentRef,
  deps: EraseDeps,
  options: ShredOptions & { readonly sweep: SweepDrop | undefined },
): Promise<Shred | null>;
async function shredSegment(
  ref: SegmentRef,
  deps: EraseDeps,
  options: ShredOptions,
): Promise<Shred | null> {
  const { allowCleartext, op = 'destroySegment', sweep } = options;
  const base = { segment: ref.segment, namespace: ref.namespace };
  // A shred is never optional, so a row that readers keep writing the leases of does not wear its attempts out: `casRetry`
  // waits out a race lost to a lease write without using an attempt, up to the churn bound.
  return casRetry(
    deps,
    ref,
    {
      attempts: MAX_CAS_ATTEMPTS,
      contention: () =>
        new WriteConflictError(`${op}: contention shredding "${ref.segment}" — retry`),
    },
    async (record) => {
      // A sweep retires only the row it judged expired: one purged or destroyed meanwhile is not its to claim, and one
      // whose policy changed is not expired any more.
      if (
        sweep !== undefined &&
        (record === null || record.status === 'destroyed' || !sweep.wanted(record))
      ) {
        return null;
      }
      if (record === null) {
        // No authoritative row → nothing to crypto-shred.
        return { ...base, destroyed: false, cryptoShredded: false, reason: 'absent' };
      }
      if (record.status === 'destroyed') {
        return {
          ...base,
          destroyed: true,
          cryptoShredded: false,
          reason: 'already',
          token: record.token,
        };
      }
      const encrypted = record.wrappedDeks !== undefined && record.wrappedDeks.length > 0;
      if (!encrypted && !allowCleartext) {
        return { ...base, destroyed: false, cryptoShredded: false, reason: 'cleartext' };
      }
      const unmarked = sweep === undefined ? withoutSweepMark(record.retention) : null;
      const tombstone = await deps.registry.compareAndSwap(ref, record.token, {
        status: 'destroyed',
        // ← the crypto-shred: the current row's DEK wrappings are gone (earlier versions and backups of the row keep
        // theirs)
        wrappedDeks: undefined,
        keyId: undefined,
        // The current generation's cached count and metadata go with it: sealed, they cannot be opened without
        // the wrappings; clear, they would outlive the segment on its tombstone.
        summary: undefined,
        // A tombstone holds nothing: a lease names a generation of a segment that now resolves none, and the ledger
        // vouches for objects of a segment no read resolves, which the pointer staying put would otherwise keep.
        knownGens: undefined,
        leases: undefined,
        // A sweep's mark, in this same write, so no other tombstone ever carries it: any other tombstone write removes
        // one a restored or hand-edited row carried.
        ...(sweep !== undefined
          ? { retention: sweep.stamp(record.retention) }
          : unmarked === null
            ? {}
            : { retention: unmarked }),
      });
      // A genuine crypto-shred only when there were wrappings to drop; a cleartext opt-in tombstone leaves the
      // Storage bytes readable, so it destroys no key (and does not emit `segment.erase`).
      return { ...base, destroyed: true, cryptoShredded: encrypted, token: tombstone.token };
    },
  );
}
