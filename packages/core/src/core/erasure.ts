/**
 * Crypto-shred erasure (Phase 4e).
 *
 * GDPR "right to erasure" on immutable/backed-up Cold storage: you can't delete a `.crbm` object from every
 * backup, but you can **delete its key**. `destroySegment` drops the segment's wrapped DEK(s) from the registry
 * (a CAS to a `destroyed` tombstone) — the encrypted Cold bytes are then permanently unreadable, everywhere,
 * forever — and physically deletes the segment's (cleartext) Warm rows. **Immediate + irreversible**, so it's
 * gated behind an explicit confirmation (name the exact segment/namespace). A `destroyed` segment reads as
 * empty (its DEK is gone). Only works on an **encrypted** segment; a cleartext segment has no key to shred.
 *
 * Note (scope): this shreds the Cold key + clears Warm rows present *now*. Preventing *new* writes to a
 * destroyed segment (a registry-checked write path) is a later hardening; the write path stays uncoupled today.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { mapWithConcurrency } from './concurrency';
import { ValidationError, WriteConflictError, isWriteConflictError } from './errors';
import type { ChunkRef, IColdDriver, IRegistryDriver, IWarmDriver, SegmentRef } from './ports';

export interface EraseDeps {
  readonly registry: IRegistryDriver;
  readonly warm: IWarmDriver;
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
   * isolated so one failure cannot discard the ledger: `'contended'` (warm rows were rewritten during every
   * erase pass) or `` `failed: <message>` `` (any other fault).
   *
   * The last two come with `destroyed: false` and mean **the segment still holds data**. A namespace erase
   * returns them rather than throwing, so its entries have to be inspected — see {@link eraseNamespace}.
   */
  readonly reason?: string;
  /** Warm rows physically deleted as part of the erase. */
  readonly warmRowsDeleted: number;
}

const MAX_CAS_ATTEMPTS = 8;
const MAX_WARM_PASSES = 4;
/**
 * Deletes in flight at once, for both the Warm rows and the Cold generations.
 *
 * Serial was the first cut and it is the wrong shape for this path: erasure is a fan-out over *independent*
 * keys, so a segment with 400 warm chunks paid 400 sequential round-trips (~20 s at 50 ms) for work that has no
 * ordering between items. This is the same bound `engine.writeConcurrency` and `S3RegistryDriver`'s
 * `LIST_READ_CONCURRENCY` already apply to the same kind of fan-out; the ceiling matters because an unbounded
 * `Promise.all` over a large segment is a self-inflicted thundering herd against one table/bucket.
 *
 * Not configurable: this is an admin path called by a human or a nightly job, so a knob would be surface with no
 * caller. If a deployment ever needs it tuned, it becomes an option then.
 */
const ERASE_CONCURRENCY = 8;
/**
 * Cold list-then-delete passes a drop will make before giving up and reporting the residual.
 *
 * Two is the honest floor and three is the working value: pass 1 clears what was there, pass 2 catches a
 * generation staged by a compaction that was already in flight when the tombstone landed, pass 3 covers a second
 * such worker. It terminates regardless — the tombstone hard-fences *starting* a new generation, so the supply of
 * late stagings is whatever was already running, and any residual is reported rather than silently dropped.
 */
const MAX_COLD_SWEEPS = 3;

/**
 * Crypto-shred one segment. **Irreversible.** `confirmSegment` must equal `ref.segment` (a guard against an
 * accidental destroy — you must name the exact segment). A non-encrypted segment is rejected unless you opt in
 * via `allowCleartext` (there's no key to shred; its Cold bytes stay readable, only Warm is cleared).
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
        // Deliberately 0, and not a partial count. `eraseWarm` may have deleted rows before it threw, but the
        // erase did not complete as a unit, so a partial figure on a failed entry would invite reading it as
        // progress toward a destruction that did not happen. The attestation that matters is `destroyed`.
        warmRowsDeleted: 0,
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
   *
   * It is *not* simply "a tombstone exists", and that distinction is load-bearing. A **pure accumulator**
   * segment — one created by writing to it and never compacted, so it has no registry row and no Cold objects —
   * is retired by deleting its Warm rows alone, with no tombstone to write. That reports `dropped: true` with
   * `reason: 'warm-only'`, because the data really is gone. Reporting it as `false` (which it did until
   * `0.8.2`) made every successful retirement of an accumulator look like a failure.
   */
  readonly dropped: boolean;
  /** Warm rows physically deleted. */
  readonly warmRowsDeleted: number;
  /** Cold generations physically deleted, ascending. Empty on a dry run — see {@link DropResult.wouldDelete}. */
  readonly generationsDeleted: readonly number[];
  /**
   * Generations still present in Cold when the sweep gave up, ascending. **Empty is the normal outcome** — a
   * non-empty value means the storage was NOT fully reclaimed and the drop should be re-run.
   *
   * This field exists because its absence was a defect. `dropped: true` with a populated `generationsDeleted`
   * and no `reason` used to be returned even when a `.crbm` holding the **complete effective set** had just been
   * left in the bucket by a compaction that was already mid-flight (it stages from data it read before the
   * tombstone, so its commit fails on the voided lease but its object survives). For a cleartext segment those
   * bytes are readable — and nothing in the library reclaimed them, because `gcOrphanGenerations` only considers
   * generations *below* `currentGen` and `checkConsistency` skips destroyed segments. The result was
   * indistinguishable from a clean drop, so an operator got no signal to re-run. Now they do.
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
   * On a dry run, how many Warm rows would be deleted. `undefined` on a real run.
   *
   * Previewing only the Cold generations was a gap: Warm rows hold **cleartext** deltas, so for the automated
   * caller this preview exists for, "how much unencrypted data is about to go" is at least as load-bearing as
   * the object count.
   */
  readonly wouldDeleteWarmRows?: number;
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
   * - `'warm-only'` — **a successful retirement.** No registry row and no Cold objects, so this was an accumulator
   *   segment: its Warm rows were deleted and it now reads empty. Pairs with `dropped: true`. Note this depends on
   *   the segment having **no row**: `setRetention` mints one (that is what makes a warm-only segment enumerable),
   *   so a retention-managed accumulator takes the ordinary row-bearing path and reports `reason: undefined` with a
   *   tombstone instead. Branch on `dropped`; `reason` is for understanding, not for control flow.
   * - `'already'` — it was already a tombstone. Idempotent; pairs with `dropped: true`. Note a re-drop is **not**
   *   a no-op — it also clears Warm rows that landed after the tombstone.
   * - `'absent'` — **nothing existed.** No registry row, no Cold objects, and no Warm rows to delete. Pairs with
   *   `dropped: false`, and it is the one value worth alerting on: the usual cause is a mistyped name or an
   *   omitted `namespace`, both of which address a *different* segment than you meant.
   *
   * Two things `'absent'` used to mean and no longer does: it was returned while the call deleted every Cold
   * generation it found with no tombstone written (a data-integrity bug, fixed in `0.8.0`), and it was returned
   * for a successfully retired accumulator segment (misleading, fixed in `0.8.2`).
   */
  readonly reason?: string;
}

/**
 * **Dispose of a segment: tombstone it, delete its Warm rows, and delete its Cold objects.** Irreversible.
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
 * **THE ORDER IS THE CONTRACT — Warm, then registry, then Cold.** Each step is placed against a specific way
 * the other orders break:
 *
 * 1. **Warm first.** A `destroyed` row makes Cold read as empty, but Warm is consulted *separately* and earlier
 *    on the read path — so a tombstone with live Warm deltas still answers `true` for ids in those deltas.
 *    (This is why {@link shredSegment} already orders it this way; the reasoning is inherited, not invented.)
 *    **Necessary, but not sufficient** — see "writes must have stopped" below.
 * 2. **Registry second.** After the tombstone nothing resolves a generation for this segment, so no reader can
 *    reach for bytes that are about to disappear.
 * 3. **Cold last, best-effort, and re-swept.** Once the pointer is a tombstone the segment resolves as empty, so
 *    a failure part-way through leaves **orphaned bytes, not a wrong answer.** Orphans cost money and are cleaned
 *    up by re-running; a torn pointer costs correctness and is not self-healing. Given the choice, leak bytes —
 *    but say so: whatever survives the sweep is reported in {@link DropResult.generationsRemaining}.
 *
 * **Why step 3 sweeps more than once.** A compaction that was already mid-flight when the tombstone landed will
 * still finish *staging* a fresh generation, built from data it read beforehand — its commit then fails on the
 * lease the tombstone voided, but the object it wrote survives, and it holds the complete effective set including
 * the Warm deltas step 1 just deleted. A single list-then-delete misses it entirely. The re-sweep converges
 * because the tombstone *is* a hard fence on **starting** a new generation (compaction returns `destroyed`
 * before it does anything), so only already-in-flight stagings can appear and they are finite.
 *
 * **Writes must have stopped.** Nothing here prevents a *new* Warm write after step 1 (the write path is
 * deliberately uncoupled — see this module's header). For `destroySegment` that is a scope note; here it is
 * sharper, because a Warm row that lands after the tombstone is **immortal**: compaction refuses to fold or purge
 * a destroyed segment, so nothing ever reaps it, and a fresh reader will report the dropped segment as non-empty
 * *forever*. Step 1 therefore runs a second time after the tombstone, which converges for anything in flight at
 * drop time — but a writer that keeps writing will keep resurrecting the segment. Stop writes first, or re-run.
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
      warmRowsDeleted: 0,
      generationsDeleted: [],
      generationsRemaining: [],
      wouldDelete,
      wouldDeleteWarmRows: await countWarmRows(deps.warm, ref),
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

  // Steps 1 and 2, reused wholesale. `allowCleartext` is true because deleting objects does not need a key —
  // the encryption requirement belongs to crypto-shred, not to disposal.
  let shred = await shredSegment(ref, deps, true, 'dropSegment');

  // ── THE ABSENT CASE. ───────────────────────────────────────────────────────────────────────────────────────
  // `shredSegment` returns `absent` having written NOTHING when there is no registry row — and this function used
  // to go on and delete every Cold generation anyway. That skipped the one step that makes the ordering safe
  // while still running the destructive one, and it produced two measured disasters, both from ordinary
  // interleavings:
  //
  //  - A drop landing between `bulkLoadCrbmGeneration`'s object write and its `publishGeneration` (minutes apart
  //    on a large load) left `currentGen: 0`, `status: 'active'` and no object — precisely the
  //    `missing-cold-generation` state this function exists to PREVENT. Reads threw; nothing self-healed it,
  //    because `publishGeneration`'s destroyed-fence has no row to check on the create path.
  //  - A drop during a compaction bootstrap (which had already pinned the Warm rows in memory) deleted those
  //    rows, reported `absent`, and then watched the bootstrap write them back to Cold and `create` an ACTIVE
  //    row. Full resurrection, with no tombstone anywhere.
  //
  // The fix is to claim the identity before deleting anything. A `destroyed` row is exactly the fence the three
  // writers already respect — `publishGeneration`, `bulkLoadCrbmGeneration` and `compactSegmentInner` all refuse
  // one — so creating it converts both disasters into "the writer is refused and the bytes are collected".
  //
  // Only when Cold actually holds something, though. A drop against a *genuinely* nonexistent segment (the
  // typo the facade docs warn about) must not leave a `destroyed` row behind: that is registry litter, and worse,
  // it would refuse a later legitimate load of that name forever. No row and no objects ⇒ nothing existed ⇒ say
  // `absent` and touch nothing, which is what that reason has always been documented to mean.
  if (shred.reason === 'absent') {
    const orphans = await listGenerations(deps.cold, ref);
    if (orphans.length === 0) {
      // Nothing in Cold and no registry row. Two very different situations reach here, and reporting them
      // identically was a defect — found by the first real consumer, whose whole workload lives in this shape.
      //
      // A **pure accumulator** segment (created by writing to it, never compacted, so it has no registry row and
      // no Cold objects — the documented and supported way to use this as a runtime set) has now had its Warm
      // rows deleted. Its data is gone: a fresh reader sees `count() === 0`. That is a successful retirement, and
      // it used to be reported as `dropped: false, reason: 'absent'` *with* a non-zero `warmRowsDeleted` — which
      // is self-contradictory, and which a retention cron written as `if (!res.dropped) alert()` would alarm on
      // every single time it worked.
      //
      // A **genuinely nonexistent** segment — the typo the facade docs warn about — deleted nothing, and that one
      // SHOULD alarm.
      //
      // So `dropped` now answers the question callers actually ask: *is this segment empty as a result of this
      // call (or already was)?* `reason` says which route got there. There is deliberately still no tombstone in
      // either case: a `destroyed` row for every retired accumulator would be registry litter, and for a typo'd
      // name it would refuse that name forever.
      const clearedWarmOnly = shred.warmRowsDeleted > 0;
      return {
        ...base,
        dropped: clearedWarmOnly,
        warmRowsDeleted: shred.warmRowsDeleted,
        generationsDeleted: [],
        generationsRemaining: [],
        cryptoShredded: false,
        reason: clearedWarmOnly ? 'warm-only' : 'absent',
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

  // Step 1, again. A Warm write that landed after the first pass would otherwise be IMMORTAL: compaction returns
  // `destroyed` before it can fold or purge it, so nothing in the system ever reaps it and a fresh reader reports
  // this "dropped" segment as non-empty forever. This second pass converges for anything in flight at drop time.
  // It runs after the tombstone deliberately — that ordering is safe here precisely because the tombstone is
  // already written, so there is no window in which a destroyed pointer coexists with live deltas we have not
  // tried to clear.
  const lateWarmRows = shred.destroyed ? await eraseWarmQuietly(deps.warm, ref) : 0;

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

  // Step 3, swept until Cold comes back empty. See "Why step 3 sweeps more than once" above: a compaction already
  // mid-flight when the tombstone landed still finishes *staging* a generation, so one list-then-delete can miss
  // an object holding the complete effective set. `mapWithConcurrency` returns results in *input* order, so each
  // pass contributes ascending generations and the concatenation stays ascending. Failures are swallowed per item
  // so the pool never aborts — one unreachable generation must not leave the rest orphaned too.
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
  // exhausted while a compaction kept staging. Inferring it would report `[]` in precisely the case that matters
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
    warmRowsDeleted: shred.warmRowsDeleted + lateWarmRows,
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
 * cannot list cannot exist, and one that *throws* from `list` should propagate. (An earlier version of this
 * comment claimed it "tolerates a driver that cannot list", describing a `try`/`catch` that was never written.)
 *
 * **Be precise about what a throw means at each call site**, because a previous version of this comment was not.
 * From the `dryRun` branch it is accurate that the call "has established nothing". From the real run it is NOT:
 * by then the tombstone is written and the Warm rows are gone, so the segment IS dropped and only the bytes
 * leaked. The throw is still the right behaviour — it is the signal to re-run, and a re-run takes the `'already'`
 * path and re-attempts the sweep — but a caller who logs "drop failed" is wrong about the segment's state. This is
 * also why the audit event is emitted *before* the sweep: an irreversible crypto-shred that really happened must
 * not go unrecorded because a later, weaker step threw.
 */
async function listGenerations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const generations: number[] = [];
  for await (const key of cold.list(ref)) generations.push(key.generation);
  return generations.sort((a, b) => a - b);
}

/**
 * Count the Warm rows a drop would delete, for {@link DropResult.wouldDeleteWarmRows}. Read-only.
 */
async function countWarmRows(warm: IWarmDriver, ref: SegmentRef): Promise<number> {
  let n = 0;
  for await (const _row of warm.listChunks(ref)) {
    void _row;
    n += 1;
  }
  return n;
}

/**
 * {@link eraseWarm}, but a contention failure is reported as "cleared nothing" instead of thrown.
 *
 * Used only for the **second** Warm pass, after the tombstone. Throwing there would be wrong in both directions:
 * the drop has already succeeded at everything the caller asked for (tombstone written, original rows cleared),
 * and a throw would discard that truthful result *and* skip the Cold sweep, so contention from a writer that
 * refuses to stop would make the storage permanently unreclaimable. A row this pass cannot clear is a row a
 * subsequent drop will clear; the pass exists to converge, not to gate.
 */
async function eraseWarmQuietly(warm: IWarmDriver, ref: SegmentRef): Promise<number> {
  try {
    return await eraseWarm(warm, ref, 'dropSegment');
  } catch (err) {
    if (!isWriteConflictError(err)) throw err;
    return 0;
  }
}

/**
 * The shred itself: clear Warm rows, then CAS the registry row to a `destroyed` tombstone with no wrappings.
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
  // Hoisted, and accumulated across attempts. Declaring it inside the loop meant only the LAST attempt's tally
  // survived: one benign concurrent registry write (`findCompactable`'s change-guarded CAS, `bumpFailure`, a lease
  // acquisition) made attempt 1's CAS conflict, and attempt 2 re-listed an already-empty Warm set — so the call
  // reported `warmRowsDeleted: 0` having physically deleted every row. On a right-to-erasure record that is
  // under-attestation, which is the same class of defect as over-attesting, pointed the other way.
  let warmRowsDeleted = 0;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const record = await deps.registry.get(ref);
    if (record === null) {
      // No authoritative row → nothing to crypto-shred. Still clear any stray Warm rows.
      warmRowsDeleted += await eraseWarm(deps.warm, ref, op);
      return {
        ...base,
        destroyed: false,
        cryptoShredded: false,
        reason: 'absent',
        warmRowsDeleted,
      };
    }
    if (record.status === 'destroyed') {
      warmRowsDeleted += await eraseWarm(deps.warm, ref, op);
      return {
        ...base,
        destroyed: true,
        cryptoShredded: false,
        reason: 'already',
        warmRowsDeleted,
      };
    }
    const encrypted = record.wrappedDeks !== undefined && record.wrappedDeks.length > 0;
    if (!encrypted && !allowCleartext) {
      return {
        ...base,
        destroyed: false,
        cryptoShredded: false,
        reason: 'cleartext',
        warmRowsDeleted,
      };
    }
    // Clear Warm first (cleartext deltas), then flip the tombstone so a reader never sees a destroyed pointer
    // with live Warm data lingering.
    warmRowsDeleted += await eraseWarm(deps.warm, ref, op);
    try {
      await deps.registry.compareAndSwap(ref, record.token, {
        status: 'destroyed',
        wrappedDeks: undefined, // ← the crypto-shred: the only copy of the DEK wrappings is gone
        keyId: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      });
      // A genuine crypto-shred only when there were wrappings to drop; a cleartext opt-in tombstone leaves the
      // Cold bytes readable, so it is not an irreversible destruction (and does not emit `segment.erase`).
      return { ...base, destroyed: true, cryptoShredded: encrypted, warmRowsDeleted };
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // A concurrent compaction/write advanced the row — re-read and shred again (it always converges).
    }
  }
  throw new WriteConflictError(`${op}: contention shredding "${ref.segment}" — retry`);
}

/**
 * Physically delete a segment's Warm rows (version-fenced per row; re-list on contention). Returns the count.
 *
 * **Throws rather than giving up quietly.** This used to run out of passes and `return deleted` with rows still
 * live, and the caller would go on to CAS the `destroyed` tombstone — so `destroySegment` could answer
 * `destroyed: true` on a segment whose Warm rows, which this module's header notes are CLEARTEXT, were still
 * readable. For a right-to-erasure command that is the worst available failure: it reports the one thing it did
 * not do, and `warmRowsDeleted` is a count of successes that cannot express "and N remain".
 *
 * Failing typed here is also what the rest of the codebase already does when a bounded retry runs out —
 * `shredSegment`'s own CAS loop below, and `S3RegistryDriver.delete`, which comments that it "fails typed rather
 * than silently leaving the row live". This function was the one deviation.
 *
 * It is safe to throw from here specifically because of the ordering at the call site: Warm is cleared BEFORE
 * the tombstone CAS, so an exception leaves the segment un-destroyed and retryable rather than marked destroyed
 * with data behind it.
 */
async function eraseWarm(
  warm: IWarmDriver,
  ref: SegmentRef,
  op: 'destroySegment' | 'dropSegment' = 'destroySegment',
): Promise<number> {
  let deleted = 0;
  // Hoisted: the value after the loop is what decides whether the erase actually finished.
  let conflicts = 0;
  for (let pass = 0; pass < MAX_WARM_PASSES; pass++) {
    conflicts = 0;
    const rows: Array<{ chunkKey: number; token: string }> = [];
    for await (const row of warm.listChunks(ref))
      rows.push({ chunkKey: row.chunkKey, token: row.token });
    if (rows.length === 0) break; // nothing left — the only clean finish
    // A conflict is caught inside `fn` and reported as `false`, so a rewritten row never aborts the pool — it is
    // retried on the next pass. Any *other* error rejects, which propagates out of `eraseWarm` exactly as the
    // serial version did (see the throw-vs-swallow note above); the running `deleted` tally is then discarded
    // along with the result, which is why it is safe not to account for the in-flight deletes that still land.
    const erased = await mapWithConcurrency(
      rows,
      ERASE_CONCURRENCY,
      async ({ chunkKey, token }) => {
        const chunkRef: ChunkRef = { namespace: ref.namespace, segment: ref.segment, chunkKey };
        try {
          await warm.deleteConditional(chunkRef, token);
          return true;
        } catch (err) {
          if (!isWriteConflictError(err)) throw err;
          return false; // rewritten mid-erase — caught on the next pass
        }
      },
    );
    for (const ok of erased) if (ok) deleted += 1;
    conflicts = erased.length - erased.filter(Boolean).length;
    if (conflicts === 0) break;
  }
  if (conflicts > 0) {
    throw new WriteConflictError(
      `${op}: ${conflicts} warm row(s) of "${ref.segment}" were rewritten during every one of ` +
        `${MAX_WARM_PASSES} erase passes — the segment was NOT destroyed and its cleartext warm deltas are ` +
        `still readable. Stop writes to this segment and retry.`,
    );
  }
  return deleted;
}
