/**
 * The retention **sweep** (Phase 6) — the thing that acts on the policies `setSegmentRetention` records.
 *
 * `retireExpired` enumerates the registry, selects the segments whose `expiresAt` has passed, and retires each
 * one through {@link dropSegment}. It deliberately **delegates rather than reimplements**: the Warm → registry →
 * Cold ordering, the re-sweep for a generation staged by an in-flight compaction, and the `generationsRemaining`
 * report are all load-bearing and already live there. A sweep that open-coded the deletions would be a second
 * implementation of the most dangerous ordering in the library.
 *
 * **This is a call, not a daemon.** Nothing here schedules itself. You run it from whatever heartbeat your
 * deployment already has — an EventBridge rule, a Kubernetes CronJob, a queue consumer, the compaction worker's
 * loop — and the library stays a library: it has to behave identically in a Lambda, an edge isolate and a
 * long-lived server, and a timer that only works in one of those is worse than none.
 *
 * Three properties make it safe to point at a fleet:
 *
 *  - **`dryRun` at the sweep level.** `dropSegment`'s `confirmSegment` guard is vacuous in a loop (it is the same
 *    variable twice), so the meaningful preview is here: it reports what it *would* retire, per segment, and
 *    touches nothing.
 *  - **A per-cycle `limit`.** Clock skew, a bad backfill, or a namespace-wide policy mistake should cost one
 *    bounded batch, not the fleet. When the limit bites, the result says so (`limited: true`) rather than looking
 *    like a completed sweep.
 *  - **A ledger, never an exception.** A per-segment fault is recorded and the sweep continues — the caller's
 *    load-bearing question is *which* segments were retired, and a throw from the middle of the loop answers it
 *    for none of them while having already retired some. Same posture as `eraseNamespace`.
 *
 * It also **purges the tombstones its own retirements leave behind**. A retired segment that had a registry row
 * gets a `destroyed` row, and one dead row per retired daily bucket — or per retired dedup wave — is exactly the
 * registry litter `dropSegment` already refuses to create for a row-less accumulator. Purging is narrow on
 * purpose: only a tombstone that still carries an **expired retention policy** (so it is attributably ours, never
 * a GDPR crypto-shred), only after a grace period, and only once Warm and Cold are provably empty for it —
 * because deleting the row is what makes the name reusable and takes the segment out of reach of
 * `gcOrphanGenerations`.
 */
import { type IAuditSink } from './audit';
import { BudgetExceededError, ValidationError, isWriteConflictError } from './errors';
import { gcOrphanGenerations } from './compaction';
import { drainRegistry } from './registry-scan';
import { dropSegment } from './erasure';
import type { DropDeps, DropResult } from './erasure';
import { MIN_EXPIRES_AT_MS, readRetentionPolicy } from './retention';
import { DEFAULT_MAX_SCAN_SEGMENTS } from './registry-scan';
import {
  canIndex,
  decodeDueName,
  dueBucket,
  dueBucketsAt,
  dueIndexRef,
  dueNamespace,
} from './due-index';
import type { IRegistryDriver, RegistryRecord } from './ports';
import type { GovernanceMeta, IColdDriver, IWarmDriver, SegmentRef } from './ports';

/** Default cap on retirements per sweep — a bounded batch, so a policy mistake costs one batch, not the fleet. */
export const DEFAULT_RETIRE_LIMIT = 100;

/**
 * Default delay before a retirement's own tombstone row is purged: 24 h.
 *
 * The row is a fence — while it exists, `publishGeneration`, `bulkLoadCrbmGeneration` and `compactSegment` all
 * refuse the segment, so a writer that was mid-operation when the drop landed cannot resurrect it. That window is
 * seconds to minutes in practice; a day of margin costs one tiny row and removes any need to reason about it.
 */
export const DEFAULT_TOMBSTONE_GRACE_MS = 86_400_000;

export interface RetireExpiredOptions {
  /** Scope the sweep to one namespace. Omit to sweep every namespace the registry knows. */
  readonly namespace?: string;
  /**
   * The instant to compare policies against (epoch-ms). Required here because `core/` takes its time from the
   * caller, never from the platform — `store.retireExpired()` fills it in from the store's clock.
   */
  readonly now: number;
  /** Maximum segments to retire in this cycle (default {@link DEFAULT_RETIRE_LIMIT}). */
  readonly limit?: number;
  /** Report what would be retired and change nothing. */
  readonly dryRun?: boolean;
  /** Forwarded to each `dropSegment`, so every retirement lands in the audit trail as `segment.dispose`. */
  readonly audit?: IAuditSink;
  /** Ceiling on rows enumerated (default `DEFAULT_MAX_SCAN_SEGMENTS`, 250,000); exceeding it throws. */
  readonly maxScanSegments?: number;
  /**
   * **Where the candidates come from.**
   *
   * - `'fleet'` (default) — drain `registry.list()` and filter. Cost tracks the **fleet**, every cycle, even
   *   when nothing expires. Complete by construction: it cannot miss a policy.
   * - `'index'` — read only the due buckets of the {@link dueBucket due index}. Cost tracks **what is
   *   expiring**. Each candidate's live row is still re-read before anything is decided, so a stale pointer
   *   costs one read and retires nothing.
   *
   * **`'index'` is not a drop-in replacement for `'fleet'`; it is the fast half of a pair.** A policy written
   * before the index existed, or one whose pointer write failed (`indexed: false`), has no pointer — so a
   * deployment that *only* ever runs `'index'` will never retire those. Run `'fleet'` periodically as the
   * repair pass. The default stays `'fleet'` so that upgrading changes nothing about what gets retired.
   */
  readonly scan?: 'fleet' | 'index';
  /**
   * How many **past** buckets an `'index'` scan reads besides the current one (default
   * {@link DEFAULT_LOOKBACK_BUCKETS}). A sweep that did not run — scaled to zero, a failed deploy, a paused
   * schedule — leaves its buckets behind, and this is how far back a later cycle reaches for them. Bounded so a
   * long outage costs a bounded number of list calls per cycle rather than one per day since the epoch;
   * anything older is the `'fleet'` repair pass's job.
   */
  readonly lookbackBuckets?: number;
  /**
   * Whether to delete the tombstone rows this sweep's own past retirements left (default `true`). Set `false` to
   * keep every tombstone forever — the right choice if something outside this library treats the presence of a
   * `destroyed` row as an attestation.
   *
   * Two knobs rather than one `number | 'never'`, deliberately: `0` would have had to mean "purge immediately"
   * here while `coldGenTtlMs: 0` in this same library means "pin forever", and one option whose zero is the
   * opposite of another's is a reading hazard for whoever tunes both.
   */
  readonly purgeTombstones?: boolean;
  /** How long a retirement's tombstone must age before this sweep deletes it (default 24 h). */
  readonly tombstoneGraceMs?: number;
}

/** What happened to one segment in a sweep. */
export type RetireEntry =
  | {
      readonly segment: string;
      readonly namespace?: string;
      /** Retired: `result` is `dropSegment`'s full report — **check `generationsRemaining`**. */
      readonly action: 'retired';
      readonly expiresAt: number;
      readonly result: DropResult;
      /**
       * Present when the retirement **completed the destructive part and then faulted** — the tombstone is written
       * and the segment reads empty, but something after that (the Cold sweep) threw. The storage may not be fully
       * reclaimed; re-run. Reported as `retired` rather than `skipped` because the segment really is retired, and
       * saying otherwise is the one thing a caller cannot recover from.
       */
      readonly fault?: `failed: ${string}`;
    }
  | {
      readonly segment: string;
      readonly namespace?: string;
      /** `dryRun` only — what a real sweep would have retired, with `dropSegment`'s own preview attached. */
      readonly action: 'would-retire';
      readonly expiresAt: number;
      readonly result: DropResult;
    }
  | {
      readonly segment: string;
      readonly namespace?: string;
      /** A tombstone row from an earlier retirement was deleted (or would be, under `dryRun`). */
      readonly action: 'purged-tombstone' | 'would-purge-tombstone';
    }
  | {
      readonly segment: string;
      readonly namespace?: string;
      readonly action: 'skipped';
      /**
       * `'invalid-policy'` — the row has an `expiresAt` that is not usable (hand-edited, or restored from another
       * schema). Reported rather than ignored: reading as "never expires" on a segment someone believes is
       * expiring is the silence that costs a retention commitment.
       * `'limit'` — eligible, but this cycle's `limit` was already spent. Re-run to continue.
       * `'tombstone-not-empty'` — a tombstone whose Warm rows or Cold generations are not gone even after a GC
       * attempt, so its row is kept: the row is what keeps the segment reachable by `gcOrphanGenerations` and
       * refused by every writer.
       * `'policy-changed'` — the live row no longer says "expired" (a `clearRetention`, a new `expiresAt`, or
       * someone else's drop landed between the enumeration and this segment's turn). Not an error: the sweep
       * re-reads before every deletion precisely so cancelling an expiry works on a sweep already in flight.
       * `` `failed: …` `` — any fault, isolated to this segment. A fault that happened *after* the tombstone
       * landed is reported as `retired` with a `fault` instead, because that segment IS retired.
       */
      readonly reason:
        | 'invalid-policy'
        | 'limit'
        | 'tombstone-not-empty'
        | 'policy-changed'
        | `failed: ${string}`;
    };

export interface RetireExpiredResult {
  /** Registry rows enumerated. */
  readonly scanned: number;
  /** Rows whose policy said "expired" — including any the `limit` deferred. */
  readonly eligible: number;
  /**
   * Segments **actually retired**. Zero under `dryRun` — see `wouldRetire`. Kept honest because this is the field
   * most likely to end up on a dashboard, and the CLI emits it: a counter that means "deleted" in one mode and
   * "would delete" in another produces phantom deletions on any graph that does not also join on `dryRun`.
   */
  readonly retired: number;
  /** Segments a real sweep **would** have retired. Only ever non-zero under `dryRun`. */
  readonly wouldRetire: number;
  /** Tombstone rows actually deleted. Zero under `dryRun`; the `would-purge-tombstone` entries carry the preview. */
  readonly tombstonesPurged: number;
  /** True when `limit` cut the cycle short — **more segments are still eligible**. Re-run. */
  readonly limited: boolean;
  readonly dryRun: boolean;
  /** Per-segment ledger. Inspect it: a `skipped` or failed entry is a segment that still holds data. */
  readonly entries: readonly RetireEntry[];
}

/**
 * Retire every segment whose retention policy has expired, and clean up the tombstones earlier sweeps left.
 *
 * Returns a ledger; **never throws for a per-segment fault** (those become entries). It does throw for a bad
 * argument, and for a fleet larger than `maxScanSegments` — a scan that cannot be held in memory is a fail-loud
 * condition, not a partial result to be mistaken for a complete sweep.
 */
/**
 * How many past buckets an index scan reads besides the current one. A week: long enough that a weekend outage
 * or a paused schedule recovers on its own, short enough that a cycle is eight list calls rather than hundreds.
 */
export const DEFAULT_LOOKBACK_BUCKETS = 7;

/**
 * Candidates from the due index: read the buckets that are due, resolve each pointer, and **re-read the live
 * row**.
 *
 * That re-read is the load-bearing line. The index is a fast path and the segment's own row is the truth, so a
 * pointer whose policy has since been cleared, moved, or destroyed must cost one read and change nothing — the
 * ordinary eligibility check downstream then skips it, using exactly the same logic the fleet scan uses. There
 * is no second decision path to keep in step, which is the property that makes a second index safe here.
 *
 * A pointer we cannot decode, or one whose segment no longer exists, is skipped rather than repaired: this
 * function decides nothing irreversible, and cleaning up is the sweep's job once a retirement actually happens.
 */
async function rowsFromDueIndex(
  registry: IRegistryDriver,
  options: { now: number; lookbackBuckets: number; namespace?: string; maxScanSegments: number },
): Promise<RegistryRecord[]> {
  const rows: RegistryRecord[] = [];
  const seen = new Set<string>();
  for (const bucket of dueBucketsAt(options.now, options.lookbackBuckets)) {
    for await (const pointer of registry.list(dueNamespace(bucket))) {
      const ref = decodeDueName(pointer.segment);
      if (ref === null) continue; // a foreign row in the reserved namespace — ignored, never acted on
      if (options.namespace !== undefined && ref.namespace !== options.namespace) continue;
      // A segment can appear in two buckets at once: `reindex` writes the new pointer before deleting the old,
      // so an interruption leaves both. De-duplicate here rather than retiring twice and reporting a phantom.
      const key = `${ref.namespace ?? ''}\u0000${ref.segment}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (rows.length >= options.maxScanSegments) {
        throw new BudgetExceededError(
          `retireExpired: the due index yielded more than ${options.maxScanSegments} segments — the scan was ` +
            `abandoned there rather than completed. Raise \`maxScanSegments\`, narrow with \`namespace\`, or ` +
            `reduce \`lookbackBuckets\`.`,
        );
      }
      const live = await registry.get(ref);
      if (live === null) continue; // the segment is gone; the pointer is litter a later retirement will clear
      rows.push(live);
    }
  }
  return rows;
}

/**
 * Best-effort removal of a retired segment's due-index pointer. A failure here leaves litter that costs one
 * read when its bucket next comes due and is then skipped (the segment is gone, so the live re-read yields
 * `null`) — never a wrong retirement, so it must not turn a successful retirement into a fault.
 */
async function forgetDuePointer(
  registry: IRegistryDriver,
  ref: SegmentRef,
  expiresAt: number,
): Promise<void> {
  if (!canIndex(ref)) return;
  try {
    await registry.delete(dueIndexRef(dueBucket(expiresAt), ref));
  } catch {
    // See above: litter, not a fault.
  }
}

export async function retireExpired(
  deps: DropDeps,
  options: RetireExpiredOptions,
): Promise<RetireExpiredResult> {
  const now = options.now;
  if (!Number.isFinite(now)) {
    throw new ValidationError(
      `retireExpired: \`now\` must be a finite epoch-ms; got ${String(now)}`,
    );
  }
  // A floor on `now` for the same reason `expiresAt` has one, and in the direction that actually destroys data: a
  // clock returning seconds makes every policy in the fleet look expired. (Too *small* a `now` is harmless —
  // nothing expires — but a sweep against a pre-2001 instant cannot legitimately expire anything anyway, so
  // refusing it costs nothing and catches the units mistake.)
  if (now < MIN_EXPIRES_AT_MS) {
    throw new ValidationError(
      `retireExpired: \`now\` (${now}) is before ${MIN_EXPIRES_AT_MS} — that is almost certainly epoch SECONDS ` +
        `rather than milliseconds. A sweep with a wrong-units clock treats every policy as expired.`,
    );
  }
  const limit = options.limit ?? DEFAULT_RETIRE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`retireExpired: \`limit\` must be a positive integer; got ${limit}`);
  }
  const purgeTombstones = options.purgeTombstones ?? true;
  const grace = options.tombstoneGraceMs ?? DEFAULT_TOMBSTONE_GRACE_MS;
  if (!Number.isFinite(grace) || grace < 0) {
    throw new ValidationError(
      `retireExpired: \`tombstoneGraceMs\` must be a non-negative finite number; got ${String(grace)}`,
    );
  }
  const maxScanSegments = options.maxScanSegments ?? DEFAULT_MAX_SCAN_SEGMENTS;
  if (!Number.isFinite(maxScanSegments) || maxScanSegments < 1) {
    throw new ValidationError(
      `retireExpired: \`maxScanSegments\` must be a finite number >= 1; got ${String(maxScanSegments)}`,
    );
  }
  const dryRun = options.dryRun === true;

  // Drain the enumeration first, bounded. The sweep mutates rows as it goes (a tombstone CAS, a row delete), and
  // iterating a live listing while doing so is driver-dependent — a Scan may or may not observe its own writes.
  // Draining makes the candidate set a snapshot; the retire path then RE-READS each row before acting on it,
  // because deciding an irreversible deletion from a minutes-old copy is not the same as enumerating from one.
  const scan = options.scan ?? 'fleet';
  const rows =
    scan === 'index'
      ? await rowsFromDueIndex(deps.registry, {
          now,
          lookbackBuckets: options.lookbackBuckets ?? DEFAULT_LOOKBACK_BUCKETS,
          namespace: options.namespace,
          maxScanSegments,
        })
      : await drainRegistry(deps.registry, {
          namespace: options.namespace,
          maxScanSegments,
          op: 'retireExpired',
        });

  const entries: RetireEntry[] = [];
  let eligible = 0;
  let retired = 0;
  let wouldRetire = 0;
  let tombstonesPurged = 0;
  let limited = false;
  // The budget is charged on ATTEMPT, not on success, and that distinction is the whole guard. `dropSegment`
  // deletes Warm and writes the tombstone BEFORE sweeping Cold, so a fault in the Cold phase is a segment that is
  // already retired — counting only successes meant a partial cold outage marched through the entire fleet with
  // the cap never engaging, reporting `retired: 0, limited: false` (a "completed sweep that retired nothing") while
  // every Warm row in the namespace was deleted. Reproduced by two independent reviews.
  let attempted = 0;

  for (const rec of rows) {
    const ref: SegmentRef = { namespace: rec.namespace, segment: rec.segment };
    const base = { segment: rec.segment, namespace: rec.namespace };
    const policy = readRetentionPolicy(rec.retention);

    if (rec.status === 'destroyed') {
      if (!purgeTombstones) continue;
      // Attribution is a POSITIVE MARKER the sweep writes on its own retirements, never an inference from
      // "destroyed + an expired policy". That inference was wrong and the consequence was serious: `shredSegment`
      // never touches `retention`, so the ordinary ordering — set a 30-day policy, then a GDPR request arrives
      // mid-window and you `destroySegment` — leaves a **crypto-shred** tombstone carrying an expired policy.
      // Deleting that row destroys the local attestation for a right-to-erasure execution and un-fences the name
      // for every writer. Two reviews reproduced it. A marker cannot be forged by that ordering.
      const retiredAt = retirementStamp(rec.retention);
      if (retiredAt === null) continue; // not ours — a GDPR tombstone, or one from a manual drop
      if (now - retiredAt < grace) continue; // inside the fence window; not ledger noise
      if (attempted >= limit) {
        limited = true;
        break;
      }
      attempted += 1;
      try {
        if (!(await isFullyReclaimed(deps, ref))) {
          // Self-heal rather than report-and-wait: `gcOrphanGenerations` takes EVERY generation of a destroyed
          // row, and nothing else will ever call it for this segment (a tombstone is never a compaction candidate,
          // and the GC only runs after a successful compaction). Without this the row is stuck forever, the
          // objects are billed forever, and the sweep pays two list calls per cycle to say so again. Measured.
          if (!dryRun) await gcOrphanGenerations(ref, deps).catch(() => undefined);
          if (!(await isFullyReclaimed(deps, ref))) {
            entries.push({ ...base, action: 'skipped', reason: 'tombstone-not-empty' });
            continue;
          }
        }
        if (!dryRun) await deps.registry.delete(ref);
        if (!dryRun) tombstonesPurged += 1;
        entries.push({
          ...base,
          action: dryRun ? 'would-purge-tombstone' : 'purged-tombstone',
        });
      } catch (err) {
        entries.push({ ...base, action: 'skipped', reason: failureReason(err) });
      }
      continue;
    }

    if (policy === null) continue; // no policy — this segment is not the sweep's business
    if (policy === 'invalid') {
      entries.push({ ...base, action: 'skipped', reason: 'invalid-policy' });
      continue;
    }
    if (policy.expiresAt > now) continue; // not yet
    eligible += 1;
    if (attempted >= limit) {
      // Stop SCANNING, not just stop acting. Pushing a `limit` entry per deferred row made the ledger scale with
      // the fleet rather than with the batch — 250,000 rows behind a bad backfill is ~15 MB of entries the caller
      // did not ask for, and the CLI then serialised all of them into one stdout line. They are not information:
      // the next run picks them up, which is what `limited` says.
      limited = true;
      break;
    }

    try {
      // Re-read the AUTHORITATIVE row before deleting anything. The enumeration is a snapshot, and on a large
      // fleet the gap between drawing it and reaching this segment is the whole sweep — minutes. Cancelling an
      // expiry is exactly the operator's recovery action for the bad-backfill case `limit` exists to survive, and
      // it did not work if a sweep was already running: the segment was retired from the stale copy. One strong
      // read per *eligible* segment, so the fleet enumeration stays a single `list()`. (`consistency.ts` takes the
      // same care for a read-only check; an irreversible deletion deserves at least as much.)
      const live = await deps.registry.get(ref);
      const livePolicy = live === null ? null : readRetentionPolicy(live.retention);
      if (
        live === null ||
        live.status === 'destroyed' ||
        livePolicy === null ||
        livePolicy === 'invalid' ||
        livePolicy.expiresAt > now
      ) {
        entries.push({ ...base, action: 'skipped', reason: 'policy-changed' });
        continue;
      }

      attempted += 1;
      // `confirmSegment` is satisfied structurally here — in a loop the guard is the same value twice, which is
      // why `dryRun` is the real preview. The dry run goes through `dropSegment` too, so the preview reports the
      // generations a real sweep would delete rather than a guess.
      const result = await dropSegment(ref, deps, {
        confirmSegment: rec.segment,
        dryRun,
        audit: options.audit,
      });
      if (dryRun) {
        wouldRetire += 1;
        entries.push({ ...base, action: 'would-retire', expiresAt: livePolicy.expiresAt, result });
        continue;
      }
      if (!result.dropped) {
        // `dropped: false` means the call found nothing to do, and the documented cause is a ref that does not
        // address what the caller meant. Counting that as a retirement is how a sweep addressing the wrong segment
        // reports success — so it is a ledger entry instead, carrying the reason `dropSegment` gave.
        //
        // Unreachable in practice now that the live re-read above proves the row exists (the only `dropped: false`
        // path needs no row at all), except through the microsecond in which someone else deletes it. Kept, and
        // labelled rather than claimed as covered: the invariant is "never count a no-op as a retirement", and it
        // must hold if either that re-read or `dropSegment`'s reporting ever changes.
        entries.push({
          ...base,
          action: 'skipped',
          reason: `failed: drop reported ${result.reason}`,
        });
        continue;
      }
      retired += 1;
      entries.push({ ...base, action: 'retired', expiresAt: livePolicy.expiresAt, result });
      // The pointer has done its job. Dropping it keeps a bucket from accumulating rows that every subsequent
      // lookback re-reads forever — the index would otherwise grow monotonically and slowly undo its own
      // purpose. Best-effort and unconditional on `scan`: a fleet sweep retires index-pointed segments too, and
      // leaving their pointers behind would make a later index scan re-read segments that no longer exist.
      await forgetDuePointer(deps.registry, ref, livePolicy.expiresAt);
      if (result.warmRowsDeleted === 0 && result.generationsDeleted.length === 0) {
        // The segment was already empty, so `dropSegment` has just written a tombstone for a name that held
        // nothing. Left in place that row FENCES the name against every writer — and `setRetention` will mint a
        // row for any name, including a typo'd one, so this is reachable from a single mistake. Nothing existed,
        // so there is nothing a delete could resurrect: remove the row instead of bricking the name.
        await deps.registry.delete(ref).catch(() => undefined);
        continue;
      }
      // Stamp the tombstone as OURS, so a later sweep may purge the row (see the attribution note above). A
      // failure here only means the row is never auto-purged — never data loss — so it is best-effort.
      await stampRetirement(deps.registry, ref, now).catch(() => undefined);
    } catch (err) {
      // A fault AFTER the tombstone landed is a segment that IS retired, and reporting it as skipped told the
      // caller the opposite of the truth ("a skipped entry is a segment that still holds data"). One cheap read
      // settles which side of the tombstone we failed on.
      const after = await deps.registry.get(ref).catch(() => null);
      if (after?.status === 'destroyed') {
        // Stamp it here too. Without this a retirement that faulted after the tombstone landed is a row no later
        // sweep can attribute to itself, so it is never auto-purged — exactly the litter the purge exists to
        // prevent, and reachable from any transient Cold fault.
        await stampRetirement(deps.registry, ref, now).catch(() => undefined);
        retired += 1;
        entries.push({
          ...base,
          action: 'retired',
          expiresAt: policy.expiresAt,
          result: {
            ...base,
            dropped: true,
            warmRowsDeleted: 0,
            generationsDeleted: [],
            generationsRemaining: [],
            cryptoShredded: false,
            reason: undefined,
          },
          fault: failureReason(err),
        });
        continue;
      }
      entries.push({ ...base, action: 'skipped', reason: failureReason(err) });
    }
  }

  return {
    scanned: rows.length,
    eligible,
    retired,
    wouldRetire,
    tombstonesPurged,
    limited,
    dryRun,
    entries,
  };
}

/** The key the sweep stamps on its own tombstones, so a purge is attributable rather than inferred. */
const RETIRED_AT = 'retiredBySweepAt';

/** Read the sweep's own retirement stamp off a row, or `null` if this tombstone is not one of ours. */
function retirementStamp(meta: GovernanceMeta | undefined): number | null {
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const raw = (meta as Record<string, unknown>)[RETIRED_AT];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_EXPIRES_AT_MS ? raw : null;
}

/**
 * Mark a freshly written tombstone as this sweep's own work, preserving whatever else the row's `retention`
 * metadata carried. Retried a couple of times on contention, then given up on: an unstamped tombstone is simply
 * never auto-purged, which is the safe direction.
 */
async function stampRetirement(
  registry: DropDeps['registry'],
  ref: SegmentRef,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rec = await registry.get(ref);
    if (rec === null || rec.status !== 'destroyed') return; // nothing to stamp
    try {
      await registry.compareAndSwap(ref, rec.token, {
        retention: { ...rec.retention, [RETIRED_AT]: now },
      });
      return;
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
    }
  }
}

/**
 * Whether a tombstoned segment's storage is provably gone — no Cold generations **and** no Warm rows.
 *
 * Both halves matter, and both are about what deleting the row would break rather than about tidiness:
 *
 *  - **Cold.** `gcOrphanGenerations` reads the registry row to decide what to collect and returns empty when there
 *    is none, so deleting the row while objects remain strands them permanently — billed forever, reachable by
 *    nothing. (A generation staged by a compaction that was in flight when the tombstone landed is exactly how
 *    they get there, which is why `dropSegment` reports `generationsRemaining` at all.)
 *  - **Warm.** The Warm tier is consulted independently of the registry, so a row-less segment with live Warm
 *    deltas is not an empty segment — it is a warm-only accumulator holding data. Deleting the tombstone over the
 *    top of one resurrects it, complete with the ids a writer added after the drop.
 *
 * Leaving the tombstone in place is self-healing: a running compaction daemon collects the orphan generations
 * (`gcOrphanGenerations` takes *every* generation of a destroyed row), a re-run of the drop clears late Warm rows,
 * and the next sweep purges the row.
 */
async function isFullyReclaimed(
  deps: { readonly cold: IColdDriver; readonly warm: IWarmDriver },
  ref: SegmentRef,
): Promise<boolean> {
  for await (const key of deps.cold.list(ref)) {
    void key;
    return false;
  }
  for await (const row of deps.warm.listChunks(ref)) {
    void row;
    return false;
  }
  return true;
}

function failureReason(err: unknown): `failed: ${string}` {
  if (isWriteConflictError(err)) return 'failed: contended';
  return `failed: ${err instanceof Error ? err.message : String(err)}`;
}
