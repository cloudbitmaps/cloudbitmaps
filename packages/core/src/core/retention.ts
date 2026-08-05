/**
 * Segment retention policy (Phase 6) — **when** a segment becomes eligible for retirement.
 *
 * This module only *records and reads the intent*. Nothing here deletes anything, and nothing here runs on a
 * timer: setting a policy is one registry write, and the sweep that acts on it (`retireExpired`) is a separate
 * call the operator schedules. That split is deliberate — see the "who owns what" note below.
 *
 * **The expiry is an absolute epoch-ms the writer sets, not a duration the library derives.** A relative TTL
 * anchored to anything the library knows would be wrong: compaction republishes `currentGen` and touches
 * `updatedAt`, so a "30 days since last write" rule would keep a daily bucket alive forever precisely because
 * the daemon is doing its job. The caller who knows what the segment *means* computes the instant:
 *
 * ```ts
 * const DAY = 86_400_000;
 * await store.setRetention({ namespace: 'active-daily', segment: '2026-08-05' }, {
 *   expiresAt: Date.now() + 30 * DAY,
 * });
 * ```
 *
 * **Who owns what.** The library owns the policy field, its validation, and the sweep that acts on it. **You own
 * the heartbeat** — an EventBridge rule, a Kubernetes CronJob, `cron`, a queue consumer, whatever already runs in
 * your deployment. There is no background thread here, and there will not be one: this library runs in a Lambda,
 * an edge isolate and a long-lived server alike, and a timer that only works in one of those is worse than none.
 *
 * **Storage.** The policy lives in the registry row's free-form `retention` metadata, which already round-trips
 * through every driver and is carried by `list()` — so a fleet-wide sweep reads it from the enumeration with no
 * per-segment `get()`. A segment that has no row yet (a warm-only accumulator) gets one, with
 * `currentGen: null`: the row exists so the segment is *enumerable*, and it claims no Cold generation, so every
 * read still resolves exactly as it did before.
 */
import { ValidationError, WriteConflictError, isWriteConflictError } from './errors';
import type { GovernanceMeta, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';

/** The key the policy is stored under inside the row's `retention` metadata. */
const EXPIRES_AT = 'expiresAt';

/** How many times a policy write re-reads and retries under contention before reporting a conflict. */
const RETENTION_CAS_ATTEMPTS = 5;

/**
 * The smallest accepted `expiresAt`: 2001-09-09, the point below which an epoch-**seconds** value would land.
 *
 * This is a deliberate guard against the single most damaging typo available here. `Date.now() / 1000 + 30 * 86400`
 * is a natural thing to write, and it produces a number ~1.8 billion — an instant in **1970**, which is to say
 * *already expired*. Without this check, that typo is not a validation error, it is a sweep that retires the
 * segment on its very next pass. Anything below this floor is far likelier to be seconds than a genuine intent to
 * expire a segment two decades ago, and the caller who really means "retire it now" can say so with `dropSegment`.
 */
export const MIN_EXPIRES_AT_MS = 1_000_000_000_000;

/** A segment's retention policy: the instant it becomes eligible for retirement. */
export interface RetentionPolicy {
  /**
   * Absolute epoch-**milliseconds**. Once `now >= expiresAt`, a retention sweep may retire the segment — delete
   * its Warm rows and its Cold generations. A value in the past is legal (backfilling a policy onto existing
   * buckets is a normal thing to do) and means "eligible on the next sweep".
   */
  readonly expiresAt: number;
}

export interface RetentionDeps {
  readonly registry: IRegistryDriver;
}

export interface SetRetentionResult {
  readonly segment: string;
  readonly namespace?: string;
  /** The policy now stored on the row. */
  readonly expiresAt: number;
  /**
   * True iff this call **minted the registry row**. That is the warm-only-accumulator case: the segment existed
   * only as Warm deltas, invisible to `registry.list()` and therefore to every fleet-wide operation, and it is
   * now enumerable. The row claims no Cold generation (`currentGen: null`), so reads are unaffected.
   */
  readonly createdRow: boolean;
}

/** Fail-fast validation of a caller-supplied policy. Boundary check — untrusted-input posture. */
export function validateRetentionPolicy(policy: RetentionPolicy): void {
  const { expiresAt } = policy;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) {
    throw new ValidationError(
      `retention.expiresAt must be an integer epoch-ms; got ${String(expiresAt)}`,
    );
  }
  if (expiresAt < MIN_EXPIRES_AT_MS) {
    throw new ValidationError(
      `retention.expiresAt (${expiresAt}) is before ${MIN_EXPIRES_AT_MS} — that is almost certainly epoch ` +
        `SECONDS rather than milliseconds, which would read as "already expired" and retire the segment on the ` +
        `next sweep. Use \`Date.now() + days * 86_400_000\`. To retire a segment now, call \`dropSegment\`.`,
    );
  }
}

/**
 * Read the policy off a registry row's `retention` metadata. Returns `null` when there is no policy, and
 * `'invalid'` when the key is present but unusable (wrong type, or below the epoch-seconds floor).
 *
 * The three-way answer exists so a fleet sweep can *report* a malformed policy instead of choosing between two
 * bad options: treating it as "no policy" hides an operator error on a segment someone believes is expiring, and
 * throwing aborts a ledger over one bad row. Nothing writes an invalid policy through
 * {@link setSegmentRetention} — hand-edited rows, an older/newer writer, or a restore are how it happens.
 */
export function readRetentionPolicy(
  meta: GovernanceMeta | undefined,
): RetentionPolicy | null | 'invalid' {
  if (meta === undefined || !(EXPIRES_AT in meta)) return null;
  const raw = meta[EXPIRES_AT];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_EXPIRES_AT_MS)
    return 'invalid';
  return { expiresAt: raw };
}

/** The stored policy for one segment, or `null` if it has none (and `'invalid'` for a malformed one). */
export async function getSegmentRetention(
  ref: SegmentRef,
  deps: RetentionDeps,
): Promise<RetentionPolicy | null | 'invalid'> {
  const record = await deps.registry.get(ref);
  if (record === null || record.status === 'destroyed') return null;
  return readRetentionPolicy(record.retention);
}

/**
 * Record when a segment becomes eligible for retirement, creating its registry row if it has none.
 *
 * Idempotent and safe to re-run: writing the same instant twice is a no-op in effect. Other keys already in the
 * row's `retention` metadata are preserved — this owns one key, not the whole object.
 *
 * Refuses a `destroyed` segment: a tombstone has nothing left to retire, and putting a policy on one would make
 * a sweep repeatedly "retire" bytes that are already gone.
 */
export async function setSegmentRetention(
  ref: SegmentRef,
  deps: RetentionDeps,
  policy: RetentionPolicy,
): Promise<SetRetentionResult> {
  validateRetentionPolicy(policy);
  const base = { segment: ref.segment, namespace: ref.namespace };
  for (let attempt = 0; attempt < RETENTION_CAS_ATTEMPTS; attempt += 1) {
    const record = await deps.registry.get(ref);
    try {
      if (record === null) {
        // The warm-only accumulator case. `currentGen: null` is what makes this safe: the row exists purely so
        // the segment is enumerable, and it claims no Cold generation, so generation resolution takes the same
        // path it takes for a segment with no row at all.
        await deps.registry.create(ref, {
          currentGen: null,
          retention: { [EXPIRES_AT]: policy.expiresAt },
        });
        return { ...base, expiresAt: policy.expiresAt, createdRow: true };
      }
      assertNotDestroyed(record, ref);
      await deps.registry.compareAndSwap(ref, record.token, {
        retention: { ...record.retention, [EXPIRES_AT]: policy.expiresAt },
      });
      return { ...base, expiresAt: policy.expiresAt, createdRow: false };
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // Lost the race (a compaction commit, a dirty-count hint, another policy write) — re-read and retry.
    }
  }
  throw new WriteConflictError(
    `setRetention: contention writing the retention policy for segment "${ref.segment}"`,
  );
}

/**
 * Remove a segment's expiry so no sweep will retire it. Returns whether a policy was actually removed (`false`
 * for a segment with no row, or one that had no policy) — a separate verb from setting one, because "cancel the
 * expiry" and "expire at time T" are different intents and a magic sentinel value for the first is how a typo
 * becomes a deletion.
 *
 * Other `retention` keys are left in place; if removing the expiry empties the metadata, the field is cleared.
 */
export async function clearSegmentRetention(
  ref: SegmentRef,
  deps: RetentionDeps,
): Promise<boolean> {
  for (let attempt = 0; attempt < RETENTION_CAS_ATTEMPTS; attempt += 1) {
    const record = await deps.registry.get(ref);
    if (record === null) return false; // nothing to clear — and creating a row to say so would be litter
    if (record.status === 'destroyed') return false; // terminal; a tombstone has no expiry to cancel
    if (record.retention === undefined || !(EXPIRES_AT in record.retention)) return false;
    const rest = { ...record.retention };
    delete rest[EXPIRES_AT];
    try {
      // `retention: undefined` CLEARS the field (a patch clears by mentioning), which is what an emptied policy
      // object should become — a row carrying `{}` reads as "has retention metadata" to anything inspecting it.
      await deps.registry.compareAndSwap(ref, record.token, {
        retention: Object.keys(rest).length === 0 ? undefined : rest,
      });
      return true;
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
    }
  }
  throw new WriteConflictError(
    `clearRetention: contention clearing the retention policy for segment "${ref.segment}"`,
  );
}

function assertNotDestroyed(record: RegistryRecord, ref: SegmentRef): void {
  if (record.status === 'destroyed') {
    throw new ValidationError(
      `segment "${ref.segment}" is destroyed (crypto-shredded) — refusing to set a retention policy on a ` +
        `tombstone; there is nothing left to retire. Use a new segment.`,
    );
  }
}
