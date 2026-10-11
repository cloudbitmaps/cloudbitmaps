/**
 * The retention **sweep** — the thing that acts on the policies `setSegmentRetention` records.
 *
 * `retireExpired` enumerates the registry, selects the segments whose `expiresAt` has passed, and retires each
 * one through {@link dropSegment}. It deliberately **delegates rather than reimplements**: the registry → Storage
 * ordering, the re-sweep for an object a load was still writing, and the `generationsRemaining` report are all
 * load-bearing and already live there. A sweep that open-coded the deletions would be a second
 * implementation of the most dangerous ordering in the library.
 *
 * **This is a call, not a daemon.** Nothing here schedules itself. You run it from whatever heartbeat your
 * deployment already has — an EventBridge rule, a Kubernetes CronJob, a queue consumer, the job that runs your
 * loads — and the library stays a library: it has to behave identically in a Lambda, an edge isolate and a
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
 * purpose: only a tombstone carrying the **stamp this sweep writes on its own retirements** (so it is attributably
 * ours: a crypto-shred's tombstone does not carry it, unless the shred lands between this sweep's re-read of the
 * row and its drop, which then reports the tombstone dropped and stamps it), only after a grace period, and only
 * once Storage is provably empty for it —
 * because deleting the row is what makes the name reusable and takes the segment out of reach of
 * the generation collection.
 *
 * **On a registry that reports `conditionalDelete`, the purge removes the row for good**, so a full scan stops paying a
 * read for every name a namespace ever held: the scan costs what is live and what is inside its grace. The delete is
 * fenced on the token the purge judged and applied by the store only to that version of the row. Each retirement
 * files a pointer in the due index under the day its tombstone's grace ends, so `scan: 'index'` purges as well as
 * retires; nothing on the row records that day, which the purge derives from the stamp. The purge removes every pointer
 * it read to the row, and a pointer that outlives its row anyway (a purge that ran with another grace, a delete that
 * landed and lost its response, a pointer older than an index scan's lookback) is removed by the next scan that reads
 * it: an index scan in its buckets, and an unscoped fleet scan, which reads every pointer, in all of them. Where a
 * delete only rewrites the row as a tombstone, none of this is done: nothing is removed for good, so a pointer would
 * only add a row for every scan to read. The pointers a scan reads to a tombstone this sweep did not write (a
 * crypto-shred, a drop by hand) are removed too, since the sweep will never act on that row; the row stays.
 */
import { type IAuditSink, checkedAuditSink } from './audit';
import { BudgetExceededError, ValidationError, isWriteConflictError } from './errors';
import { gcOrphanGenerations } from './generation-gc';
import { drainRegistry } from './registry-scan';
import { dropSegmentFor } from './erasure';
import type { DropDeps, DropResult } from './erasure';
import { MIN_EXPIRES_AT_MS, SWEEP_MARK, readRetentionPolicy } from './retention';
import { DEFAULT_MAX_SCAN_SEGMENTS } from './registry-scan';
import {
  canIndex,
  decodeDueName,
  dueBucket,
  dueBucketsAt,
  dueIndexRef,
  dueNamespace,
} from './due-index';
import { segmentKey, shardOf } from './keys';
import type { IRegistryDriver, RegistryRecord, Token } from './ports';
import type { GovernanceMeta, IStorageDriver, SegmentRef } from './ports';
import { isReservedNamespace, validateUserNamespace } from './validate';

/** Default cap on retirements per sweep — a bounded batch, so a policy mistake costs one batch, not the fleet. */
export const DEFAULT_RETIRE_LIMIT = 100;

/**
 * How many purges in a row the registry may refuse in one call before the sweep stops purging for the rest of it. A
 * blanket refusal (a policy that denies delete) costs this many attempts and no more; a refusal particular to one row
 * (a blob with a snapshot, an object under a legal hold) does not hold the purges behind it, since a purge that succeeds
 * starts the count again.
 */
export const MAX_CONSECUTIVE_PURGE_FAULTS = 3;

/**
 * Default delay before a retirement's own tombstone row is purged: 24 h.
 *
 * The row is a fence — while it exists, a load refuses the segment, so
 * a load that was mid-write when the drop landed cannot resurrect it. That window is
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
  /**
   * Maximum segments to retire in this cycle (default 100). It also bounds the purges attempted (a purge the registry
   * refuses is not charged; {@link RetireExpiredResult.purgeFaults} says how purging stops after refusals) and the
   * due-index pointers to nothing one call removes.
   */
  readonly limit?: number;
  /** Report what would be retired and change nothing. */
  readonly dryRun?: boolean;
  /** Forwarded to each `dropSegment`, so every retirement lands in the audit trail as `segment.dispose`. */
  readonly audit?: IAuditSink;
  /** Ceiling on rows enumerated (default 250,000); exceeding it throws. */
  readonly maxScanSegments?: number;
  /**
   * **Where the candidates come from.**
   *
   * - `'fleet'` (default) — drain `registry.list()` and filter. Cost tracks the **fleet**, every cycle, even
   *   when nothing expires. Complete by construction: it cannot miss a policy.
   * - `'index'` — read only the due buckets of the due index. Cost tracks **what is
   *   expiring**. Each candidate's live row is still re-read before anything is decided, so a stale pointer
   *   costs one read and retires nothing.
   *
   * **`'index'` is not a drop-in replacement for `'fleet'`; it is the fast half of a pair.** A policy whose
   * pointer write failed (`indexed: false`), or whose ref is too long to index, has no pointer — so a
   * deployment that *only* ever runs `'index'` will never retire those. Run `'fleet'` periodically as the
   * repair pass. The default is `'fleet'` because it is complete by construction.
   *
   * An index scan purges too, on a registry that reports `conditionalDelete`: each retirement files a pointer to its
   * tombstone under the day the tombstone's grace ends, and the scan reads it back with the expiry pointers. A pointer
   * whose segment is gone is removed once read, by an index scan in the buckets it reads, and by an unscoped `'fleet'`
   * scan (no `namespace`) in every bucket.
   */
  readonly scan?: 'fleet' | 'index';
  /**
   * **The shards this worker owns**, with {@link totalShards}. Without them every replica sweeps the whole
   * fleet and contends over the same segments. A stable hash of the segment key, so a worker owns the same slice
   * across restarts.
   */
  readonly shards?: readonly number[];
  /** Total shards the fleet is split into. Required with {@link shards}; ignored without it. */
  readonly totalShards?: number;
  /**
   * How many **past** buckets an `'index'` scan reads besides the current one (default 7, one per day).
   * A sweep that did not run — scaled to zero, a failed deploy, a paused
   * schedule — leaves its buckets behind, and this is how far back a later cycle reaches for them. Bounded so a
   * long outage costs a bounded number of list calls per cycle rather than one per day since the epoch;
   * anything older is the `'fleet'` repair pass's job.
   */
  readonly lookbackBuckets?: number;
  /**
   * Whether to delete the tombstone rows this sweep's own past retirements left (default `true`): removed for good on
   * a registry that reports `conditionalDelete`, tombstoned on one that does not. Set `false` to
   * keep every one of them — the right choice if something outside this library treats the presence of a
   * `destroyed` row as an attestation. That includes the row of a retirement whose drop found no Storage
   * generation to delete and left none behind: with the default that row is deleted in the same pass, since it
   * would do nothing but fence the name against every writer, and with `false` it stays, stamped like any other
   * of this sweep's tombstones, so a later sweep with purging on deletes it once `tombstoneGraceMs` has passed.
   * While it stays, it fences the name like every kept tombstone. What records a retirement either way is its
   * ledger entry, and its `segment.dispose` event (`generationsDeleted: 0` for an empty one) when an `audit` sink
   * is passed.
   *
   * Two knobs rather than one `number | 'never'`, deliberately: `0` would have had to mean "purge immediately"
   * here while `cache.genTtlMs: 0` in this same library means "never refresh on a timer", and one option whose
   * zero is the opposite of another's is a reading hazard for whoever tunes both.
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
       * and the segment reads empty, but something after that (the Storage sweep) threw. The storage may not be fully
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
       * `'tombstone-not-empty'` — a tombstone whose Storage generations are not gone even after a GC
       * attempt, so its row is kept, and, unless the collection lost a race to a write of the row, a refused purge
       * (see {@link RetireExpiredResult.purgeFaults}): the row is what keeps the segment reachable by the generation collection and
       * refused by every writer. Several causes, all self-healing: the storage really could not be reclaimed,
       * the collection *declined* because the row changed underneath it (`WriteConflictError`, which this
       * sweep swallows deliberately), or this was a `dryRun`, which reports the reason without attempting the
       * collection at all. Except under `dryRun` the next cycle retries.
       * `'policy-changed'` — the live row no longer says "expired" (a `clearRetention`, a new `expiresAt`, or
       * someone else's drop landed between the enumeration and this segment's turn). Not an error: the sweep
       * re-reads before every deletion precisely so cancelling an expiry works on a sweep already in flight.
       * `` `failed: …` `` — any fault, isolated to this segment. A fault that happened *after* the tombstone
       * landed is reported as `retired` with a `fault` instead, because that segment IS retired.
       */
      readonly reason:
        'invalid-policy' | 'limit' | 'tombstone-not-empty' | 'policy-changed' | `failed: ${string}`;
    };

export interface RetireExpiredResult {
  /** Registry rows enumerated. */
  readonly scanned: number;
  /**
   * Rows whose policy said "expired", counted until the `limit` stopped the scan: the first row it deferred is counted
   * and the rows after it are not read, so with `limited: true` this is a lower bound.
   */
  readonly eligible: number;
  /**
   * Segments **actually retired**. Zero under `dryRun` — see `wouldRetire`. Kept honest because this is the field
   * most likely to end up on a dashboard: a counter that means "deleted" in one mode and
   * "would delete" in another produces phantom deletions on any graph that does not also join on `dryRun`.
   */
  readonly retired: number;
  /** Segments a real sweep **would** have retired. Only ever non-zero under `dryRun`. */
  readonly wouldRetire: number;
  /** Tombstone rows actually deleted. Zero under `dryRun`; the `would-purge-tombstone` entries carry the preview. */
  readonly tombstonesPurged: number;
  /** True when `limit` cut the cycle short — **more segments are still eligible**. Re-run. */
  readonly limited: boolean;
  /**
   * Deletes this sweep attempted that were **refused for a reason other than a lost race**: a tombstone's purge
   * (including one whose objects were still there after a collection that raised nothing), or the removal of a
   * due-index pointer. A policy that denies delete, an Azure blob with a snapshot, or any
   * raw provider error is one; a write that landed between the sweep's read and its fenced delete is not (that is
   * `failed: contended` in the ledger). Each leaves its row or pointer in place, so a purge that keeps failing never
   * frees the name.
   *
   * A refused purge is not charged to `limit`, so retirements go on: a tombstone that cannot be purged does not hold
   * the segments behind it past their expiry. **Purging stops for the rest of the call after
   * {@link MAX_CONSECUTIVE_PURGE_FAULTS} (3) refused purges in a row**, and a purge that succeeds starts the count
   * again. A blanket refusal therefore costs three attempts a call, and a refusal particular to one row (a blob with a
   * snapshot, an object under a legal hold) holds nothing behind it. The next call tries again. Check this field; a
   * ledger entry for each is `skipped`, but a caller that reads only `retired` sees none of it.
   */
  readonly purgeFaults: number;
  /** The first of those faults, as a ledger reason (`failed: …` with the provider's message). Absent when there were none. */
  readonly firstPurgeFault?: `failed: ${string}`;
  readonly dryRun: boolean;
  /** Per-segment ledger. Inspect it: a `skipped` or failed entry is a segment that still holds data. */
  readonly entries: readonly RetireEntry[];
}

/**
 * How many past buckets an index scan reads besides the current one. A week: long enough that a weekend outage
 * or a paused schedule recovers on its own, short enough that a cycle is eight list calls rather than hundreds.
 */
export const DEFAULT_LOOKBACK_BUCKETS = 7;

/** A due-index pointer as a scan found it: where it is, the segment it points at, and its token. */
interface FoundPointer {
  /** The pointer row's own ref, in its `cbm.due.<day>` namespace. */
  readonly ref: SegmentRef;
  /** The segment it points at. */
  readonly target: SegmentRef;
  /** The pointer row's token, which fences its removal; absent for a pointer computed rather than read. */
  readonly token?: Token;
}

/** What an index scan found: the candidates' live rows, the pointers to each, and the pointers to nothing. */
interface IndexScan {
  readonly rows: RegistryRecord[];
  /** Every pointer the scan read to each candidate, by the candidate's segment key. */
  readonly pointers: ReadonlyMap<string, readonly FoundPointer[]>;
  /** Pointers whose segment has no row: litter a retirement or a purge left when removing them failed. */
  readonly litter: readonly FoundPointer[];
}

/**
 * Candidates from the due index: read the buckets that are due, resolve each pointer, and **re-read the live
 * row**.
 *
 * That re-read is the load-bearing line. The index is a fast path and the segment's own row is the truth, so a
 * pointer whose policy has since been cleared, moved, or destroyed must cost one read and change nothing — the
 * ordinary eligibility check downstream then skips it, using exactly the same logic the fleet scan uses. There
 * is no second decision path to keep in step, which is the property that makes a second index safe here. A
 * `destroyed` row is handed to the same purge branch the fleet scan uses, so the pointer a retirement files for its
 * tombstone lets an index scan purge it too.
 *
 * A pointer we cannot decode is skipped. One whose segment no longer exists is returned as litter, for the sweep to
 * remove: this function decides nothing irreversible.
 */
async function rowsFromDueIndex(
  registry: IRegistryDriver,
  options: { now: number; lookbackBuckets: number; namespace?: string; maxScanSegments: number },
): Promise<IndexScan> {
  const rows: RegistryRecord[] = [];
  const pointers = new Map<string, FoundPointer[]>();
  const litter: FoundPointer[] = [];
  const gone = new Set<string>();
  for (const bucket of dueBucketsAt(options.now, options.lookbackBuckets)) {
    for await (const pointer of registry.list(dueNamespace(bucket))) {
      const ref = decodeDueName(pointer.segment);
      if (ref === null) continue; // a foreign row in the reserved namespace — ignored, never acted on
      // A pointer to a segment in the reserved namespace itself: one written before that namespace was refused.
      // The fleet scan skips such a row as bookkeeping, so this scan does too, rather than fail on it each cycle.
      if (isReservedNamespace(ref.namespace)) continue;
      if (options.namespace !== undefined && ref.namespace !== options.namespace) continue;
      const found: FoundPointer = {
        ref: { namespace: pointer.namespace, segment: pointer.segment },
        target: ref,
        token: pointer.token,
      };
      // A segment can appear in two buckets at once: `reindex` writes the new pointer before deleting the old,
      // so an interruption leaves both, and a retirement's tombstone has a pointer of its own. De-duplicate here
      // rather than retiring twice and reporting a phantom, and keep every pointer for the purge to remove.
      const key = segmentKey(ref);
      const known = pointers.get(key);
      if (known !== undefined) {
        known.push(found);
        continue;
      }
      // Strays are held up to the same bound as rows, as the fleet scan holds its pointers: removing one decides nothing
      // irreversible, and those past it are left for a later scan. The bound never skips a pointer unread: a live
      // segment behind any number of strays is still found.
      if (gone.has(key)) {
        if (litter.length < options.maxScanSegments) litter.push(found);
        continue;
      }
      if (rows.length >= options.maxScanSegments) {
        throw new BudgetExceededError(
          `retireExpired: the due index yielded more than ${options.maxScanSegments} segments — the scan was ` +
            `abandoned there rather than completed. Raise \`maxScanSegments\`, narrow with \`namespace\`, or ` +
            `reduce \`lookbackBuckets\`.`,
        );
      }
      const live = await registry.get(ref);
      if (live === null) {
        // The segment is gone; nothing will read this pointer usefully again. Past the bound, a second pointer to it
        // costs one more read rather than a place in memory.
        if (gone.size < options.maxScanSegments) gone.add(key);
        if (litter.length < options.maxScanSegments) litter.push(found);
        continue;
      }
      rows.push(live);
      pointers.set(key, [found]);
    }
  }
  return { rows, pointers, litter };
}

/**
 * Candidates from the whole registry, as `registry.list()` yields them, and the due-index pointers it yielded on the
 * way. An unscoped listing reads every pointer (the listing pays a read for each before the scan skips it), and a
 * pointer whose segment is not among the rows is litter, as it is to an index scan: whatever left it (a purge that
 * ran with another grace than the one that filed it, a delete that landed and lost its response, a pointer older than
 * an index scan's lookback) the fleet scan, which reads every row, is the one that can see it. A scan limited to a
 * `namespace` lists no pointers, and finds none.
 *
 * At most `maxScanSegments` pointers are held; the rest are left for a later scan. This decides nothing irreversible:
 * a pointer is removed only after its segment is read again, and the row it names is still absent.
 */
async function rowsFromFleet(
  registry: IRegistryDriver,
  options: { namespace?: string; maxScanSegments: number },
): Promise<IndexScan> {
  const held: FoundPointer[] = [];
  const rows = await drainRegistry(registry, {
    namespace: options.namespace,
    maxScanSegments: options.maxScanSegments,
    op: 'retireExpired',
    onReserved: (pointer) => {
      if (held.length >= options.maxScanSegments) return;
      const target = decodeDueName(pointer.segment);
      // A foreign row in the reserved namespace, or a pointer to a segment in that namespace itself (written before it
      // was refused): not the sweep's to read, and never acted on.
      if (target === null || isReservedNamespace(target.namespace)) return;
      held.push({
        ref: { namespace: pointer.namespace, segment: pointer.segment },
        target,
        token: pointer.token,
      });
    },
  });
  const pointers = new Map<string, FoundPointer[]>();
  const litter: FoundPointer[] = [];
  if (held.length === 0) return { rows, pointers, litter };
  const present = new Set(rows.map((rec) => segmentKey(rec)));
  for (const found of held) {
    const key = segmentKey(found.target);
    if (!present.has(key)) litter.push(found);
    else if (pointers.has(key)) pointers.get(key)!.push(found);
    else pointers.set(key, [found]);
  }
  return { rows, pointers, litter };
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
  onFault: (err: unknown) => void,
): Promise<void> {
  if (!canIndex(ref)) return;
  try {
    await registry.delete(dueIndexRef(dueBucket(expiresAt), ref));
  } catch (err) {
    // See above: litter, not a wrong retirement. The caller is told, though: a delete the registry refuses is counted.
    onFault(err);
  }
}

/**
 * File the pointer that lets an index scan purge a tombstone: under the day its grace ends, the stamp plus the grace.
 * No field of the row records that day; the bucket is the index, and the purge derives the day from the stamp.
 *
 * Best-effort, like every pointer write: a pointer already there is the same pointer, and one that fails to appear
 * leaves the tombstone to the fleet scan, which purges it on the repair cadence.
 */
async function filePurgePointer(
  registry: IRegistryDriver,
  ref: SegmentRef,
  purgeAt: number,
): Promise<void> {
  if (!canIndex(ref)) return;
  try {
    await registry.create(dueIndexRef(dueBucket(purgeAt), ref), { currentGen: null });
  } catch {
    // Already there, or not written: see above.
  }
}

/**
 * Remove the pointers a scan read to a tombstone the sweep will never act on, each fenced on the token it was read
 * with. Best-effort: a pointer left behind is read again by the next scan, which removes it then.
 */
async function forgetFoundPointers(
  registry: IRegistryDriver,
  found: readonly FoundPointer[],
  onFault: (err: unknown) => void,
): Promise<void> {
  for (const pointer of found) {
    try {
      await registry.delete(pointer.ref, pointer.token);
    } catch (err) {
      // A lost race is the pointer changing under the delete, and is no fault; anything else is counted.
      onFault(err);
    }
  }
}

/**
 * Remove the pointers to a purged tombstone: every one the index scan read to it, each fenced on the token it was
 * read with, and the one this sweep's grace would have filed, which a fleet scan has not read. Best-effort: a pointer
 * left behind costs one read when its bucket is next scanned, which then finds its row gone and removes it.
 *
 * Runs only once the row is gone, never after a delete whose outcome is unknown, so a pointer is only ever removed
 * from a tombstone that no longer needs finding.
 */
async function forgetPurgePointers(
  registry: IRegistryDriver,
  ref: SegmentRef,
  purgeAt: number,
  found: readonly FoundPointer[],
  onFault: (err: unknown) => void,
): Promise<void> {
  if (!canIndex(ref)) return;
  const filed = dueIndexRef(dueBucket(purgeAt), ref);
  const all = found.some((p) => p.ref.namespace === filed.namespace)
    ? found
    : [...found, { ref: filed, target: ref }];
  for (const pointer of all) {
    try {
      await registry.delete(pointer.ref, pointer.token);
    } catch (err) {
      // See above: litter, not a wrong purge. A lost race is the pointer changing under the delete, and is no fault.
      onFault(err);
    }
  }
}

/**
 * Retire every segment whose retention policy has expired, and clean up the tombstones earlier sweeps left.
 *
 * Returns a ledger; **never throws for a per-segment fault** (those become entries). It does throw for a bad
 * argument, and for a fleet larger than `maxScanSegments` — a scan that cannot be held in memory is a fail-loud
 * condition, not a partial result to be mistaken for a complete sweep.
 */
export async function retireExpired(
  deps: DropDeps,
  options: RetireExpiredOptions,
): Promise<RetireExpiredResult> {
  checkedAuditSink(options.audit, 'retireExpired');
  // Shards are numbered from 0, below `totalShards`. Without `totalShards`, or with a number outside that range, a
  // replica owned everything or nothing, silently: replicas numbered from 1 left shard 0 unswept for good.
  if (options.shards !== undefined) {
    const total = options.totalShards;
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 1) {
      throw new ValidationError('retireExpired: shards needs totalShards, an integer of 1 or more');
    }
    if (!Array.isArray(options.shards)) {
      throw new ValidationError('retireExpired: shards must be an array of shard numbers');
    }
    for (const shard of options.shards as readonly unknown[]) {
      if (typeof shard !== 'number' || !Number.isInteger(shard) || shard < 0 || shard >= total) {
        throw new ValidationError(
          `retireExpired: a shard is an integer from 0 to totalShards - 1 (${total - 1}); got ${String(shard)}`,
        );
      }
    }
  }
  if (options.namespace !== undefined) validateUserNamespace(options.namespace);
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
  // iterating a live listing while doing so is driver-dependent — a paged listing may or may not observe its own
  // writes. Draining makes the candidate set a snapshot; the retire path then RE-READS each row before acting on
  // it, because deciding an irreversible deletion from a minutes-old copy is not the same as enumerating from one.
  const scan = options.scan ?? 'fleet';
  const scanned =
    scan === 'index'
      ? await rowsFromDueIndex(deps.registry, {
          now,
          lookbackBuckets: options.lookbackBuckets ?? DEFAULT_LOOKBACK_BUCKETS,
          namespace: options.namespace,
          maxScanSegments,
        })
      : await rowsFromFleet(deps.registry, { namespace: options.namespace, maxScanSegments });
  const rows = scanned.rows;

  // Whether a delete removes a row for good. Read after the enumeration: a registry that settles this lazily (S3, from
  // the host its client resolves) has done so by its first listing. Where it does not, a purge only rewrites the row as
  // a tombstone, which a full scan reads for ever, so a pointer to find it by, or to remove, buys nothing and costs a
  // read and a write at retirement and again at purge.
  const removesRows = deps.registry.capabilities().conditionalDelete === true;

  const shards = options.shards;
  const totalShards = options.totalShards ?? 0;
  const owned = (ref: SegmentRef): boolean =>
    shards === undefined ||
    totalShards <= 1 ||
    shards.includes(shardOf(segmentKey(ref), totalShards));
  const mine = rows.filter(owned);

  const entries: RetireEntry[] = [];
  let eligible = 0;
  let retired = 0;
  let wouldRetire = 0;
  let tombstonesPurged = 0;
  let limited = false;
  // Deletes the registry refused for a reason other than a lost race, and the first one's reason. A lost race is the
  // row or pointer changing under a fenced delete, which is the fence working; anything else (a denied delete, a blob
  // with a snapshot, a raw provider error) will happen again for the next one.
  let purgeFaults = 0;
  let firstPurgeFault: `failed: ${string}` | undefined;
  const noteFault = (err: unknown): void => {
    if (isWriteConflictError(err)) return;
    purgeFaults += 1;
    firstPurgeFault ??= failureReason(err);
  };
  // Purging stops after this many refused purges in a row, and a purge that succeeds starts the count again. Each refused
  // attempt costs reads before it fails, and a blanket refusal would fail them all; one row's refusal must not hold the rest.
  let purgeRun = 0;
  let purging = true;
  // The budget is charged on ATTEMPT, not on success, and that distinction is the whole guard. `dropSegment`
  // writes the tombstone BEFORE sweeping Storage, so a fault in the Storage phase is a segment that is
  // already retired. Counting only successes would let a partial storage outage march through the entire fleet
  // with the cap never engaging, reporting `retired: 0, limited: false` (a "completed sweep that retired nothing")
  // while every segment in the namespace is tombstoned.
  let attempted = 0;

  for (const rec of mine) {
    const ref: SegmentRef = { namespace: rec.namespace, segment: rec.segment };
    const base = { segment: rec.segment, namespace: rec.namespace };
    const policy = readRetentionPolicy(rec.retention);

    if (rec.status === 'destroyed') {
      // A tombstone this sweep did not write (a crypto-shred, a drop by hand) is never retired or purged here, and it
      // has no expiry left to act on, so the pointers the scan read to it name nothing: they go, and the row stays.
      if (retirementStamp(rec.retention) === null) {
        if (!dryRun && removesRows) {
          await forgetFoundPointers(
            deps.registry,
            scanned.pointers.get(segmentKey(ref)) ?? [],
            noteFault,
          );
        }
        continue;
      }
      if (!purgeTombstones || !purging) continue;
      // Attribution is a POSITIVE MARKER the sweep writes on its own retirements, never an inference from
      // "destroyed + an expired policy". That inference would be wrong, and the consequence serious: `shredSegment`
      // never touches `retention`, so the ordinary ordering — set a 30-day policy, then a GDPR request arrives
      // mid-window and you `destroySegment` — leaves a **crypto-shred** tombstone carrying an expired policy.
      // Deleting that row destroys the local attestation for a right-to-erasure execution and un-fences the name
      // for every writer. A marker cannot be forged by that ordering.
      const retiredAt = retirementStamp(rec.retention)!; // not null: a foreign tombstone went on above
      if (now - retiredAt < grace) continue; // inside the fence window; not ledger noise
      if (attempted >= limit) {
        limited = true;
        break;
      }
      attempted += 1;
      try {
        if (!(await isFullyReclaimed(deps, ref))) {
          // Self-heal rather than report-and-wait: `gcOrphanGenerations` takes EVERY generation of a destroyed
          // row, and nothing else will ever call it for this segment (no load publishes onto a tombstone, and the
          // erasure rewrite refuses one). Without this the row is stuck forever, the
          // objects are billed forever, and the sweep pays two list calls per cycle to say so again. Measured.
          let collectFault: { error: unknown } | undefined;
          if (!dryRun) {
            await gcOrphanGenerations(ref, deps).catch((error: unknown) => {
              collectFault = { error };
            });
          }
          if (!(await isFullyReclaimed(deps, ref))) {
            // A refused purge, as a refused row delete is below: not charged to `limit`, so the retirements behind it
            // still get their turn (a role without delete permission makes every retirement a stuck tombstone, and
            // charged, enough of them stopped every new one), and after enough in a row no more purges are tried this
            // call. The collection's error, when it raised one, names the cause; a collection that lost a race to a
            // write of the row is not a refusal, as a row delete's is not.
            const lostRace = collectFault !== undefined && isWriteConflictError(collectFault.error);
            if (!dryRun && !lostRace) {
              attempted -= 1;
              purgeRun += 1;
              if (purgeRun >= MAX_CONSECUTIVE_PURGE_FAULTS) purging = false;
              if (collectFault !== undefined) noteFault(collectFault.error);
              else {
                // The collection answered and the objects are still there: a store that acknowledges a delete it did not
                // make, or a write that landed after its listing. Counted all the same, with what was seen as its cause.
                purgeFaults += 1;
                firstPurgeFault ??=
                  "failed: the tombstone's objects were still there after its collection";
              }
            }
            entries.push({ ...base, action: 'skipped', reason: 'tombstone-not-empty' });
            continue;
          }
        }
        // Fenced on the token of the row this decision was made from (the marker and its grace window), so a
        // tombstone that was purged and re-created, or rewritten, since the scan is refused rather than deleted.
        // Storage went first, above: the row is what keeps a straggler generation reachable by the collection.
        // On a registry with a conditional delete the row is removed for good, under the version this delete
        // reads, which carries that token; elsewhere it is tombstoned. Its pointers go only once it is gone: a
        // delete that threw, its outcome unknown, removes nothing more, and the next scan reads the row again.
        if (!dryRun) {
          await deps.registry.delete(ref, rec.token);
          tombstonesPurged += 1;
          purgeRun = 0;
          if (removesRows) {
            await forgetPurgePointers(
              deps.registry,
              ref,
              retiredAt + grace,
              scanned.pointers.get(segmentKey(ref)) ?? [],
              noteFault,
            );
          }
        }
        entries.push({
          ...base,
          action: dryRun ? 'would-purge-tombstone' : 'purged-tombstone',
        });
      } catch (err) {
        if (!isWriteConflictError(err)) {
          // Refused for a reason other than a lost race. Not charged to the limit, so the retirements behind it still
          // get their turn; and after enough in a row, no more purges are tried this call.
          attempted -= 1;
          purgeRun += 1;
          if (purgeRun >= MAX_CONSECUTIVE_PURGE_FAULTS) purging = false;
          noteFault(err);
        }
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
      // Stop SCANNING, not just stop acting. A `limit` entry per deferred row would make the ledger scale with the
      // fleet rather than with the batch — 250,000 rows behind a bad backfill is ~15 MB of entries the caller did
      // not ask for, all in one result object. They are not information: the next run picks them up, which is
      // what `limited` says.
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
      //
      // The re-read above is not the last word: the drop reads the row again, and an extension, a clear, a purge or
      // someone else's tombstone can land between the two. So the drop is told what this sweep may retire, judged on
      // every row its shred is about to replace, and writes this sweep's mark in the tombstone's own write.
      const result = await dropSegmentFor(
        ref,
        deps,
        { confirmSegment: rec.segment, dryRun, audit: options.audit },
        dryRun
          ? undefined
          : {
              wanted: (row) => {
                const p = readRetentionPolicy(row.retention);
                return p !== null && p !== 'invalid' && p.expiresAt <= now;
              },
              stamp: (retention) => ({ ...retention, [RETIRED_AT]: now }),
            },
      );
      if (result === null) {
        attempted -= 1;
        entries.push({ ...base, action: 'skipped', reason: 'policy-changed' });
        continue;
      }
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
      await forgetDuePointer(deps.registry, ref, livePolicy.expiresAt, noteFault);
      if (
        purgeTombstones &&
        result.generationsDeleted.length === 0 &&
        result.generationsRemaining.length === 0
      ) {
        // The segment really held nothing, so `dropSegment` has just written a tombstone for a name that was
        // empty. Left in place that row FENCES the name against every writer — and `setRetention` will mint a
        // row for any name, including a typo'd one, so this is reachable from a single mistake. Nothing
        // existed, so there is nothing a delete could resurrect: remove the row instead of bricking the name.
        //
        // **Only while `purgeTombstones` is on.** `false` is the caller asking for every row of this sweep's
        // retirements to stay, this one included; it falls through to the stamp below, so a later sweep with
        // purging on can still delete it after the grace window (an empty segment is trivially fully reclaimed).
        // Nothing re-processes it meanwhile: a `destroyed` row is skipped before any policy is read.
        //
        // **Both halves of the predicate are load-bearing.** `generationsDeleted: []` alone does NOT mean the
        // segment was empty — it is equally what a segment whose every `storage.delete` threw produces, because
        // `dropSegment`'s sweep loop stops once a pass deletes nothing. Purging the row on that reading left
        // the expired objects readable and billed, and then unreachable by everything that could have
        // collected them: `gcOrphanGenerations` returns `[]` with no row to compare against, the next sweep
        // never sees the name again (no row to enumerate), and `dropSegment` takes its `'absent'` path. The
        // data that was contractually supposed to expire stayed, silently, forever. `generationsRemaining` is
        // the honest question and `dropSegment` computes it one field over for exactly this reason.
        //
        // When something DOES remain, falling through is the right move rather than a special case: the row
        // keeps its tombstone, so reads stay refused, and the tombstone-purge pass above re-sweeps it with
        // `gcOrphanGenerations` (which takes every generation of a destroyed row) and purges the row once it is
        // genuinely empty. The residual is visible in this entry's `result.generationsRemaining` meanwhile.
        //
        // Fenced on the tombstone just written, so a name purged and re-created by someone else since is not
        // tombstoned by this delete: only a `destroyed` row is removed, and only at the token it was read with.
        //
        // **A delete that fails falls through to the stamp as well.** Left unstamped, the row is indistinguishable
        // from a crypto-shred's tombstone, which no sweep may ever delete, so one transient registry fault would
        // keep a fenced name for good. Stamped, it is this sweep's own tombstone, and a later sweep purges it. The
        // stamp itself only touches a `destroyed` row, so a name that was re-created meanwhile is left alone.
        const tombstone = await deps.registry.get(ref).catch(() => null);
        if (tombstone?.status === 'destroyed') {
          const deleted = await deps.registry.delete(ref, tombstone.token).then(
            () => true,
            (err: unknown) => {
              noteFault(err);
              return false;
            },
          );
          if (deleted) continue;
        }
      }
      // The tombstone carries this sweep's mark from the write that made it, so a later sweep may purge the row (see
      // the attribution note above). File the pointer an index scan finds it by on the day its grace ends.
      if (removesRows) await filePurgePointer(deps.registry, ref, now + grace);
    } catch (err) {
      // A fault AFTER the tombstone landed is a segment that IS retired, and reporting it as skipped told the
      // caller the opposite of the truth ("a skipped entry is a segment that still holds data"). One cheap read
      // settles which side of the tombstone we failed on.
      const after = await deps.registry.get(ref).catch(() => null);
      // Only this sweep's own tombstone, the one carrying its mark: a tombstone someone else wrote (a crypto-shred, a
      // drop) is not a retirement of this sweep, and claiming it would let a later sweep purge an attestation.
      if (
        after?.status === 'destroyed' &&
        (after.retention as Record<string, unknown> | undefined)?.[RETIRED_AT] === now
      ) {
        if (removesRows) await filePurgePointer(deps.registry, ref, now + grace);
        retired += 1;
        entries.push({
          ...base,
          action: 'retired',
          expiresAt: policy.expiresAt,
          result: {
            ...base,
            dropped: true,
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

  // Pointers to nothing, from either scan: remove each, so it is not read for again. Only those for this sweep's own slice
  // of the fleet, and never under `dryRun`. The segment is read again just before, since the scan may be minutes old: a
  // `setRetention` that created the name since files its pointer after its row, and finding one already at that key,
  // takes it as its own. Fenced on the token the scan read, so a pointer filed anew is left. What remains is a round trip
  // in which such a pointer can still go, and then the fleet scan retires that segment. At most `limit` of them per call:
  // each costs reads before its delete, and a long backlog must not make one call arbitrarily long. A pointer attempted
  // counts whether or not it goes, as a retirement does.
  if (!dryRun && removesRows) {
    let attemptedLitter = 0;
    for (const pointer of scanned.litter) {
      if (!owned(pointer.target)) continue;
      if (attemptedLitter >= limit) break;
      attemptedLitter += 1;
      try {
        if ((await deps.registry.get(pointer.target)) !== null) continue;
        await deps.registry.delete(pointer.ref, pointer.token);
      } catch (err) {
        // Left for a later scan: litter, not a wrong sweep. A delete the registry refuses is counted.
        noteFault(err);
      }
    }
  }

  return {
    scanned: mine.length,
    eligible,
    retired,
    wouldRetire,
    tombstonesPurged,
    limited,
    purgeFaults,
    ...(firstPurgeFault === undefined ? {} : { firstPurgeFault }),
    dryRun,
    entries,
  };
}

/** The key the sweep stamps on its own tombstones, so a purge is attributable rather than inferred. */
const RETIRED_AT = SWEEP_MARK;

/** Read the sweep's own retirement stamp off a row, or `null` if this tombstone is not one of ours. */
function retirementStamp(meta: GovernanceMeta | undefined): number | null {
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const raw = (meta as Record<string, unknown>)[RETIRED_AT];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_EXPIRES_AT_MS ? raw : null;
}

/**
 * Whether a tombstoned segment's storage is provably gone — no Storage generations.
 *
 * The check is about what deleting the row would break rather than about tidiness: `gcOrphanGenerations` reads
 * the registry row to decide what to collect and returns empty when there is none, so deleting the row while
 * objects remain strands them permanently — billed forever, reachable by nothing. (An object a load was still
 * writing when the tombstone landed is exactly how they get there, which is why `dropSegment` reports
 * `generationsRemaining` at all.)
 *
 * Leaving the tombstone in place is self-healing: this sweep collects the orphan generations itself
 * (`gcOrphanGenerations` takes *every* generation of a destroyed row), and the next cycle purges the row.
 */
async function isFullyReclaimed(
  deps: { readonly storage: IStorageDriver },
  ref: SegmentRef,
): Promise<boolean> {
  for await (const key of deps.storage.list(ref)) {
    void key;
    return false;
  }
  return true;
}

function failureReason(err: unknown): `failed: ${string}` {
  if (isWriteConflictError(err)) return 'failed: contended';
  return `failed: ${err instanceof Error ? err.message : String(err)}`;
}
