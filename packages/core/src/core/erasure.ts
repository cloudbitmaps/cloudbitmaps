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
import { ValidationError, WriteConflictError, isWriteConflictError } from './errors';
import type { ChunkRef, IRegistryDriver, IWarmDriver, SegmentRef } from './ports';

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

/** The shred itself: clear Warm rows, then CAS the registry row to a `destroyed` tombstone with no wrappings. */
async function shredSegment(
  ref: SegmentRef,
  deps: EraseDeps,
  allowCleartext: boolean,
): Promise<DestroyResult> {
  const base = { segment: ref.segment, namespace: ref.namespace };
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const record = await deps.registry.get(ref);
    if (record === null) {
      // No authoritative row → nothing to crypto-shred. Still clear any stray Warm rows.
      const warmRowsDeleted = await eraseWarm(deps.warm, ref);
      return {
        ...base,
        destroyed: false,
        cryptoShredded: false,
        reason: 'absent',
        warmRowsDeleted,
      };
    }
    if (record.status === 'destroyed') {
      const warmRowsDeleted = await eraseWarm(deps.warm, ref);
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
        warmRowsDeleted: 0,
      };
    }
    // Clear Warm first (cleartext deltas), then flip the tombstone so a reader never sees a destroyed pointer
    // with live Warm data lingering.
    const warmRowsDeleted = await eraseWarm(deps.warm, ref);
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
  throw new WriteConflictError(`destroySegment: contention shredding "${ref.segment}" — retry`);
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
async function eraseWarm(warm: IWarmDriver, ref: SegmentRef): Promise<number> {
  let deleted = 0;
  // Hoisted: the value after the loop is what decides whether the erase actually finished.
  let conflicts = 0;
  for (let pass = 0; pass < MAX_WARM_PASSES; pass++) {
    conflicts = 0;
    const rows: Array<{ chunkKey: number; token: string }> = [];
    for await (const row of warm.listChunks(ref))
      rows.push({ chunkKey: row.chunkKey, token: row.token });
    if (rows.length === 0) break; // nothing left — the only clean finish
    for (const { chunkKey, token } of rows) {
      const chunkRef: ChunkRef = { namespace: ref.namespace, segment: ref.segment, chunkKey };
      try {
        await warm.deleteConditional(chunkRef, token);
        deleted += 1;
      } catch (err) {
        if (!isWriteConflictError(err)) throw err;
        conflicts += 1; // rewritten mid-erase — caught on the next pass
      }
    }
    if (conflicts === 0) break;
  }
  if (conflicts > 0) {
    throw new WriteConflictError(
      `destroySegment: ${conflicts} warm row(s) of "${ref.segment}" were rewritten during every one of ` +
        `${MAX_WARM_PASSES} erase passes — the segment was NOT destroyed and its cleartext warm deltas are ` +
        `still readable. Stop writes to this segment and retry.`,
    );
  }
  return deleted;
}
