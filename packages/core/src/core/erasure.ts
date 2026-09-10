/**
 * Whole-segment erasure: crypto-shred (`destroySegment`, `eraseNamespace`) and disposal (`dropSegment`).
 *
 * GDPR "right to erasure" on immutable/backed-up Cold storage: you can't delete a `.crbm` object from every
 * backup, but you can **delete its key**. `destroySegment` drops the segment's wrapped DEK(s) from the registry
 * (a CAS to a `destroyed` tombstone) — the encrypted Cold bytes are then permanently unreadable, everywhere,
 * forever. **Immediate + irreversible**, so it's gated behind an explicit confirmation (name the exact
 * segment/namespace). A `destroyed` segment reads as empty (its DEK is gone). Only works on an **encrypted**
 * segment; a cleartext segment has no key to shred.
 *
 * The tombstone is also the fence every writer respects: `publishGeneration` and `bulkLoadCrbmGeneration` refuse
 * a `destroyed` row, so a load racing an erasure cannot resurrect the segment. A single id's erasure is a different
 * operation — `eraseIdFromSegment` rewrites the generation without it.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { mapWithConcurrency } from './concurrency';
import { ValidationError, WriteConflictError, isWriteConflictError } from './errors';
import type { IColdDriver, IRegistryDriver, SegmentRef } from './ports';

export interface EraseDeps {
  readonly registry: IRegistryDriver;
}

export interface DestroyResult {
  readonly segment: string;
  readonly namespace?: string;
  /** True iff the segment is now a `destroyed` tombstone (incl. the idempotent already-destroyed case). */
  readonly destroyed: boolean;
  /**
   * True iff **this call** performed a genuine crypto-shred — an encrypted segment whose wrapped DEK(s) were
   * dropped, so its Cold bytes are now permanently unreadable. False for a cleartext tombstone (bytes remain
   * readable), for the idempotent already-destroyed case, and for an absent segment. This is what the
   * `segment.erase` audit event keys off — a cleartext "erase" is not an irreversible destruction.
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
 * Cold deletes in flight at once. Erasure is a fan-out over *independent* keys, so serial would pay one
 * round-trip per generation for work that has no ordering between items; unbounded would be a self-inflicted
 * thundering herd against one bucket. Not configurable: an admin path called by a human or a nightly job.
 */
const ERASE_CONCURRENCY = 8;
/**
 * Cold list-then-delete passes a drop will make before giving up and reporting the residual.
 *
 * Two is the honest floor and three is the working value: pass 1 clears what was there, pass 2 catches an object
 * a load was still writing when the tombstone landed (its publish is then refused, but the object write
 * completes), pass 3 covers a second such writer. It terminates regardless — the tombstone hard-fences
 * *publishing* a new generation, so the supply of late objects is whatever was already mid-write, and any
 * residual is reported rather than silently dropped.
 */
const MAX_COLD_SWEEPS = 3;

/**
 * Crypto-shred one segment. **Irreversible.** `confirmSegment` must equal `ref.segment` (a guard against an
 * accidental destroy — you must name the exact segment). A non-encrypted segment is rejected unless you opt in
 * via `allowCleartext` (there's no key to shred; its Cold bytes stay readable — the tombstone only stops the
 * segment resolving).
 */
export async function destroySegment(
  ref: SegmentRef,
  deps: EraseDeps,
  options: { confirmSegment: string; allowCleartext?: boolean; audit?: IAuditSink },
): Promise<DestroyResult> {
  if (options.confirmSegment !== ref.segment) {
    throw new ValidationError(
      `destroySegment: confirmSegment must equal the segment name "${ref.segment}" (guard against accidental crypto-shred)`,
    );
  }
  const result = await shredSegment(ref, deps, options.allowCleartext ?? false);
  // Audit only a genuine crypto-shred — not the idempotent already-destroyed/absent no-ops, and not a
  // cleartext tombstone (whose Cold bytes stay readable, so it is not an irreversible erasure).
  if (result.cryptoShredded) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.erase',
      namespace: ref.namespace,
      segment: ref.segment,
    });
  }
  return result;
}

/**
 * Crypto-shred every segment in a namespace. **Irreversible.** `confirmNamespace` must equal `namespace`.
 * Returns a per-segment result (skips cleartext segments unless `allowCleartext`).
 */
export async function eraseNamespace(
  namespace: string,
  deps: EraseDeps,
  options: { confirmNamespace: string; allowCleartext?: boolean; audit?: IAuditSink },
): Promise<{ destroyed: DestroyResult[] }> {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new ValidationError('eraseNamespace: namespace must be a non-empty string');
  }
  if (options.confirmNamespace !== namespace) {
    throw new ValidationError(
      `eraseNamespace: confirmNamespace must equal the namespace "${namespace}" (guard against accidental erasure)`,
    );
  }
  const refs: SegmentRef[] = [];
  for await (const rec of deps.registry.list(namespace)) {
    refs.push({ namespace: rec.namespace, segment: rec.segment });
  }
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);
  const destroyed: DestroyResult[] = [];
  let segmentsShredded = 0;
  for (const ref of refs) {
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
    try {
      result = await shredSegment(ref, deps, options.allowCleartext ?? false);
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
    destroyed.push(result);
    // A per-segment record for each genuine crypto-shred, so the trail can prove *which* segments were
    // destroyed (each carries the namespace) — not just that the command ran.
    if (result.cryptoShredded) {
      segmentsShredded += 1;
      audit.onEvent({ kind: 'segment.erase', namespace: ref.namespace, segment: ref.segment });
    }
  }
  // Plus one namespace-level record of the erasure command, carrying the honest count actually shredded
  // (may be 0 — e.g. an empty namespace, or all-cleartext without `allowCleartext`): the command ran, but
  // the count keeps the record from over-attesting a destruction that did not happen.
  audit.onEvent({ kind: 'namespace.erase', namespace, segmentsShredded });
  return { destroyed };
}

/**
 * Deps for {@link dropSegment}. Adds `cold`, because unlike a crypto-shred this one deletes the objects.
 */
export interface DropDeps extends EraseDeps {
  readonly cold: IColdDriver;
}

export interface DropResult {
  readonly segment: string;
  readonly namespace?: string;
  /**
   * **True iff this segment is now empty as a result of this call — or already was.** This is the field a
   * retention job should branch on: `false` means the call found nothing to do and your ref is probably wrong.
   */
  readonly dropped: boolean;
  /** Cold generations physically deleted, ascending. Empty on a dry run — see {@link DropResult.wouldDelete}. */
  readonly generationsDeleted: readonly number[];
  /**
   * Generations still present in Cold when the sweep gave up, ascending. **Empty is the normal outcome** — a
   * non-empty value means the storage was NOT fully reclaimed and the drop should be re-run.
   *
   * This field exists because its absence was a defect. A drop used to return `dropped: true` with a populated
   * `generationsDeleted` and no `reason` even when an object holding the **complete set** had just been left in
   * the bucket by a writer that was already mid-write when the tombstone landed (its publish is refused, but the
   * object survives). For a cleartext segment those bytes are readable — and `gcOrphanGenerations` only collects
   * a destroyed segment's generations when something runs it. The result was indistinguishable from a clean
   * drop, so an operator got no signal to re-run. Now they do.
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
   * `undefined` on a real run. This is the one fact in the preview that is irreversible *everywhere*, backups
   * included — a dry run that did not surface it was previewing the recoverable half only.
   */
  readonly wouldCryptoShred?: boolean;
  /**
   * True iff the segment was encrypted and its wrapped DEK(s) were dropped as part of this call — so its bytes
   * are unreadable *everywhere*, backups included, not merely deleted from the bucket. Deleting an object does
   * not reach a noncurrent version, a replica, or a PITR snapshot; discarding the key does.
   */
  readonly cryptoShredded: boolean;
  /**
   * How the segment got to its current state. Absent on a fresh, ordinary drop (tombstone written, Cold swept).
   *
   * - `'already'` — it was already a tombstone. Idempotent; pairs with `dropped: true`. A re-drop is **not** a
   *   no-op — it re-sweeps Cold, so it is how a residual in `generationsRemaining` is collected.
   * - `'absent'` — **nothing existed.** No registry row and no Cold objects. Pairs with `dropped: false`, and it
   *   is the one value worth alerting on: the usual cause is a mistyped name or an omitted `namespace`, both of
   *   which address a *different* segment than you meant.
   */
  readonly reason?: string;
}

/**
 * **Dispose of a segment: tombstone it, then delete its Cold objects.** Irreversible.
 *
 * WHY THIS EXISTS, given {@link destroySegment} already erases. Because `destroySegment` answers a *compliance*
 * question and this one answers an *operational* question, and they are not the same:
 *
 * - `destroySegment` **crypto-shreds** — it discards the key so the bytes are unreadable everywhere including
 *   immutable backups, which is the only erasure that survives WORM. But it **leaves the objects in the
 *   bucket**, still billed, and it *requires* encryption because a cleartext segment has no key to discard.
 * - `dropSegment` **removes the storage**. It works on a cleartext segment, and on an encrypted one it *also*
 *   drops the DEKs, so it is a strict superset there.
 *
 * Before this existed there was no supported way to delete a segment and stop paying for it, and the obvious
 * workaround — an object-store lifecycle rule on the key prefix — deletes the bytes while the registry still
 * points at them. That is exactly the `missing-cold-generation` state the DR runbook says not to serve traffic
 * on, and it surfaces *intermittently*, because a read consults the hot cache before Cold: cached chunks answer
 * correctly and evicted ones throw. The whole value of this function is that the ordering below cannot be got
 * wrong by a caller.
 *
 * **THE ORDER IS THE CONTRACT — registry first, then Cold.**
 *
 * 1. **Registry first.** After the tombstone nothing resolves a generation for this segment, so no reader can
 *    reach for bytes that are about to disappear, and no writer can publish onto it (`publishGeneration` and
 *    `bulkLoadCrbmGeneration` refuse a `destroyed` row).
 * 2. **Cold second, best-effort, and re-swept.** Once the pointer is a tombstone the segment resolves as empty,
 *    so a failure part-way through leaves **orphaned bytes, not a wrong answer.** Orphans cost money and are
 *    cleaned up by re-running; a torn pointer costs correctness and is not self-healing. Given the choice, leak
 *    bytes — but say so: whatever survives the sweep is reported in {@link DropResult.generationsRemaining}.
 *
 * **Why step 2 sweeps more than once.** A load that was already writing its object when the tombstone landed
 * still finishes the write — its publish is then refused, but the object survives, and it holds the complete
 * set. A single list-then-delete misses it entirely. The re-sweep converges because the tombstone *is* a hard
 * fence on **publishing**, so only already-in-flight writes can appear and they are finite.
 *
 * **When "reads as empty" starts being true.** Not instantly, for a store that has already read this segment: a
 * resolved generation is cached and decoded chunks sit in the hot LRU, so an in-flight reader can answer from
 * cache for a window. A fresh store, or any reader that had not touched the segment, sees empty at once.
 *
 * That window is bounded by `coldGenTtlMs` (default 2 s) **only for a reader whose cold source has both a clock
 * and a registry and a positive TTL** — expiry needs all three. A source built without a clock, or with
 * `coldGenTtlMs: 0` (documented as "pin forever"), holds its resolved snapshot for its own lifetime; because a
 * hot-LRU hit never reaches Cold, such a reader can answer `true` for a dropped segment **indefinitely** and must
 * be restarted. This is the *same* caching that makes the delete-bytes-first ordering fail intermittently rather
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
  if (options.confirmSegment !== ref.segment) {
    throw new ValidationError(
      `dropSegment: confirmSegment must equal the segment name "${ref.segment}" (guard against accidental deletion)`,
    );
  }
  const base = { segment: ref.segment, namespace: ref.namespace };

  if (options.dryRun === true) {
    const record = await deps.registry.get(ref);
    const wouldDelete = await listGenerations(deps.cold, ref);
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
  let shred = await shredSegment(ref, deps, true, 'dropSegment');

  // ── THE ABSENT CASE. ───────────────────────────────────────────────────────────────────────────────────────
  // `shredSegment` returns `absent` having written NOTHING when there is no registry row — and this function used
  // to go on and delete every Cold generation anyway. That skipped the one step that makes the ordering safe
  // while still running the destructive one: a drop landing between a load's object write and its publish
  // (minutes apart on a large load) left a published pointer with no object behind it — precisely the
  // `missing-cold-generation` state this function exists to PREVENT.
  //
  // The fix is to claim the identity before deleting anything. A `destroyed` row is exactly the fence the
  // writers already respect — `publishGeneration` and `bulkLoadCrbmGeneration` both refuse one — so creating it
  // converts the race into "the writer is refused and the bytes are collected".
  //
  // Only when Cold actually holds something, though. A drop against a *genuinely* nonexistent segment (the
  // typo the facade docs warn about) must not leave a `destroyed` row behind: that is registry litter, and worse,
  // it would refuse a later legitimate load of that name forever. No row and no objects ⇒ nothing existed ⇒ say
  // `absent` and touch nothing, which is what that reason has always been documented to mean.
  if (shred.reason === 'absent') {
    const orphans = await listGenerations(deps.cold, ref);
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
      await deps.registry.create(ref, {
        // The max listed generation, so the row is consistent with what is on disk if anything reads it before
        // the sweep finishes. It is a tombstone, so no reader resolves through it either way.
        currentGen: orphans[orphans.length - 1]!,
        status: 'destroyed',
      });
      shred = { ...shred, destroyed: true, reason: undefined };
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // A row appeared between our `get` and our `create` — that is the racing writer we were trying to fence,
      // and it won. Fall back into the normal path, which now has a row to CAS into a tombstone.
      shred = await shredSegment(ref, deps, true, 'dropSegment');
    }
  }

  // `segment.erase` ONLY on a genuine crypto-shred — exactly the condition `destroySegment` uses, and
  // deliberately NOT `|| generationsDeleted.length > 0`.
  //
  // It read that way in the first draft, and it was wrong in a way that matters. Four documents — including
  // `docs/guide/dashboards.md`, which calls this event the compliance *receipt* — define `segment.erase` as
  // proof of an irreversible crypto-shred: bytes unreadable everywhere, backups included. Deleting an object is
  // a weaker guarantee, because a noncurrent version, a cross-region replica or a PITR snapshot still holds the
  // cleartext. Emitting one event for both would make a compliance dashboard **over-attest**, which is the one
  // failure an audit trail exists to prevent.
  //
  // The cleartext case is NOT silent — it emits `segment.dispose` after the sweep (below). That kind exists
  // precisely so this one does not have to lie: disposal is attested as disposal, shredding as shredding, and an
  // encrypted drop emits both because both genuinely happened.
  //
  // And it goes out BEFORE the Cold sweep, not after. A genuine crypto-shred is complete the moment
  // `shredSegment` returns — the DEK wrappings are gone and the bytes are unreadable everywhere. If the sweep
  // then throws (a Cold driver that cannot list), emitting afterwards would mean **no receipt for a destruction
  // that really happened** — the exact mirror of the over-attestation above, and just as wrong. Both directions
  // of a false audit trail are defects; only one of them was obvious.
  if (shred.cryptoShredded) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.erase',
      namespace: ref.namespace,
      segment: ref.segment,
    });
  }

  // Step 2, swept until Cold comes back empty. See "Why step 2 sweeps more than once" above. `mapWithConcurrency`
  // returns results in *input* order, so each pass contributes ascending generations and the concatenation stays
  // ascending. Failures are swallowed per item so the pool never aborts — one unreachable generation must not
  // leave the rest orphaned too.
  const generationsDeleted: number[] = [];
  for (let pass = 0; pass < MAX_COLD_SWEEPS; pass++) {
    const present = await listGenerations(deps.cold, ref);
    if (present.length === 0) break;
    const outcomes = await mapWithConcurrency(present, ERASE_CONCURRENCY, async (generation) => {
      try {
        await deps.cold.delete({ ...ref, generation });
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
  // what is still in Cold whichever way the loop ended: empty, a delete that kept failing, or the pass budget
  // exhausted while a writer kept finishing. Inferring it would report `[]` in precisely the case that matters
  // — a final pass that deleted everything it saw, after which one more object appeared.
  const generationsRemaining = await listGenerations(deps.cold, ref);

  // `segment.dispose` attests the *storage reclamation*, which is the weaker but still compliance-relevant fact,
  // and it is emitted AFTER the sweep because unlike a crypto-shred it is not established until the sweep runs.
  // Only when a tombstone was actually written — an absent no-op disposed of nothing.
  if (shred.destroyed) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.dispose',
      namespace: ref.namespace,
      segment: ref.segment,
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

/**
 * Every generation currently present in Cold for a segment, ascending.
 *
 * No error handling on purpose: `IColdDriver.list` is mandatory (not optional in `ports.ts`), so a driver that
 * cannot list cannot exist, and one that *throws* from `list` should propagate.
 *
 * **Be precise about what a throw means at each call site.** From the `dryRun` branch it is accurate that the
 * call "has established nothing". From the real run it is NOT: by then the tombstone is written, so the segment
 * IS dropped and only the bytes leaked. The throw is still the right behaviour — it is the signal to re-run, and
 * a re-run takes the `'already'` path and re-attempts the sweep — but a caller who logs "drop failed" is wrong
 * about the segment's state. This is also why the audit event is emitted *before* the sweep: an irreversible
 * crypto-shred that really happened must not go unrecorded because a later, weaker step threw.
 */
async function listGenerations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const generations: number[] = [];
  for await (const key of cold.list(ref)) generations.push(key.generation);
  return generations.sort((a, b) => a - b);
}

/**
 * The shred itself: CAS the registry row to a `destroyed` tombstone with no wrappings.
 *
 * `op` is only for error text — `destroySegment` and `dropSegment` both come through here, and a message naming
 * the wrong one is operator-facing text on the single path where the operator must act.
 */
async function shredSegment(
  ref: SegmentRef,
  deps: EraseDeps,
  allowCleartext: boolean,
  op: 'destroySegment' | 'dropSegment' = 'destroySegment',
): Promise<DestroyResult> {
  const base = { segment: ref.segment, namespace: ref.namespace };
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const record = await deps.registry.get(ref);
    if (record === null) {
      // No authoritative row → nothing to crypto-shred.
      return { ...base, destroyed: false, cryptoShredded: false, reason: 'absent' };
    }
    if (record.status === 'destroyed') {
      return { ...base, destroyed: true, cryptoShredded: false, reason: 'already' };
    }
    const encrypted = record.wrappedDeks !== undefined && record.wrappedDeks.length > 0;
    if (!encrypted && !allowCleartext) {
      return { ...base, destroyed: false, cryptoShredded: false, reason: 'cleartext' };
    }
    try {
      await deps.registry.compareAndSwap(ref, record.token, {
        status: 'destroyed',
        wrappedDeks: undefined, // ← the crypto-shred: the only copy of the DEK wrappings is gone
        keyId: undefined,
      });
      // A genuine crypto-shred only when there were wrappings to drop; a cleartext opt-in tombstone leaves the
      // Cold bytes readable, so it is not an irreversible destruction (and does not emit `segment.erase`).
      return { ...base, destroyed: true, cryptoShredded: encrypted };
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // A concurrent publish or policy write advanced the row — re-read and shred again (it always converges).
    }
  }
  throw new WriteConflictError(`${op}: contention shredding "${ref.segment}" — retry`);
}
