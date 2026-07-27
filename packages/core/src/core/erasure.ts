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
  /** `'absent'` (no registry row), `'already'` (already destroyed), or `'cleartext'` (no DEK to shred). */
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
    const result = await shredSegment(ref, deps, options.allowCleartext ?? false);
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

/** Physically delete a segment's Warm rows (version-fenced per row; re-list on contention). Returns the count. */
async function eraseWarm(warm: IWarmDriver, ref: SegmentRef): Promise<number> {
  let deleted = 0;
  for (let pass = 0; pass < MAX_WARM_PASSES; pass++) {
    const rows: Array<{ chunkKey: number; token: string }> = [];
    for await (const row of warm.listChunks(ref))
      rows.push({ chunkKey: row.chunkKey, token: row.token });
    if (rows.length === 0) break;
    let conflicts = 0;
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
  return deleted;
}
