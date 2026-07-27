/**
 * Fail-safe cross-tier DR check (gap #11). The registry (`currentGen`, e.g. in
 * DynamoDB) and the immutable `.crbm` generations (e.g. in S3) back up and restore **independently**, so a
 * failover can recover the registry *ahead of* the object store — leaving `currentGen` pointing at a generation
 * whose `.crbm` isn't present yet. That's a torn restore: reads of the affected segment then throw. This scan
 * detects it up front (run it at startup after a restore) instead of discovering it on the first read.
 *
 * Read-only; bounded fan-out. `destroyed` (crypto-shredded) segments are skipped — their Cold is intentionally
 * gone/unreadable, not a torn restore. A segment whose Cold/registry can't be read this pass is recorded in
 * `errored` (never aborts the scan). Each segment is checked against its **authoritative live pointer** — one
 * strong `registry.get` per segment — never the enumeration snapshot from `registry.list`, which can be
 * eventually-consistent (an unindexed Scan) and lag a recent in-place pointer advance: trusting it would both
 * miss a torn *live* generation and cry torn on a generation the pointer has already advanced past (GC'd during
 * the scan). Residual: a full compaction+GC landing in the tiny per-segment get→list gap can still yield a
 * transient false positive — run the scan against a quiesced fleet (the documented restore procedure), or re-run
 * to confirm a reported tear.
 */

import { mapWithConcurrency } from './concurrency';
import { BudgetExceededError, ValidationError } from './errors';
import type { IColdDriver, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';

/** Default in-flight fan-out for the consistency scan — bounded, no thundering herd. */
/**
 * Default ceiling on how many registry records one consistency check may hold resident: 250,000.
 *
 * Generous — the compaction docs target 100K+ segment fleets — while still bounding a DR drill's memory to
 * something a modest operator box survives. Raisable, because a ceiling you cannot lift is a landmine.
 */
export const DEFAULT_MAX_CHECK_SEGMENTS = 250_000;
const DEFAULT_CHECK_CONCURRENCY = 8;

export interface ConsistencyIssue {
  readonly segment: string;
  readonly namespace?: string;
  /** The registry's `currentGen` for the segment — the generation whose `.crbm` is missing from Cold. */
  readonly currentGen: number;
  /** The only issue class today: `currentGen` references a Cold generation that is not present (torn restore). */
  readonly issue: 'missing-cold-generation';
}

/** A segment that could not be checked this pass (Cold/registry read fault) — not proof of a torn restore. */
export interface ConsistencyErrorEntry {
  readonly segment: string;
  readonly namespace?: string;
  /** The read error's message (never the raw error, so the report stays serializable/loggable). */
  readonly error: string;
}

export interface ConsistencyReport {
  /** Registered segments scanned (a `destroyed` segment counts as scanned but is never an issue). */
  readonly checked: number;
  /** Segments whose `currentGen` `.crbm` is absent — recover the object store (or restore to a coherent point). */
  readonly inconsistent: ConsistencyIssue[];
  /**
   * Segments that couldn't be read this pass (a transient/partial object store during a restore is exactly when
   * this runs) — **triage these too**: an unread segment is neither proven-coherent nor proven-torn. Empty on a
   * clean pass.
   */
  readonly errored: ConsistencyErrorEntry[];
}

/** Collect the set of generations the object store currently lists for a segment. */
async function listGenerations(cold: IColdDriver, ref: SegmentRef): Promise<Set<number>> {
  const present = new Set<number>();
  for await (const key of cold.list(ref)) present.add(key.generation);
  return present;
}

type Outcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'issue'; readonly issue: ConsistencyIssue }
  | { readonly kind: 'error'; readonly error: ConsistencyErrorEntry };

/**
 * Verify every registered segment's `currentGen` `.crbm` actually exists in Cold. Enumerates the registry
 * (optionally one namespace) and, for each non-`destroyed` segment, checks the object store lists that
 * generation. Returns the torn segments in `inconsistent` (empty ⇒ coherent) and any unreadable segments in
 * `errored`.
 */
export async function runConsistencyCheck(
  deps: { readonly cold: IColdDriver; readonly registry: IRegistryDriver },
  options: { namespace?: string; concurrency?: number; maxSegments?: number } = {},
): Promise<ConsistencyReport> {
  const concurrency = options.concurrency ?? DEFAULT_CHECK_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    // Fail fast before the (possibly huge) registry scan, not after.
    throw new ValidationError(`concurrency must be a positive integer; got ${concurrency}`);
  }
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_CHECK_SEGMENTS;
  if (!Number.isFinite(maxSegments) || maxSegments < 1) {
    throw new ValidationError(
      `maxSegments must be a finite number >= 1; got ${String(options.maxSegments)}`,
    );
  }
  // Bounded enumeration, matching the engine's read paths. The comment above already noted the scan is
  // "possibly huge" and then drained it into an array regardless: memory scaled with total fleet size, which
  // the caller had no way to cap. This is operator-invoked rather than request-reachable, so it is less exposed
  // than the GDPR paths that were fixed first — but "an operator runs it" is not a bound, and a DR drill against
  // a large fleet from a modest box is exactly when it would bite.
  const recs: RegistryRecord[] = [];
  for await (const rec of deps.registry.list(options.namespace)) {
    recs.push(rec);
    if (recs.length > maxSegments) {
      throw new BudgetExceededError(
        `checkConsistency would enumerate more than ${maxSegments} segments — the scan was abandoned there ` +
          `rather than completed. Narrow it with \`namespace\`, or raise \`maxSegments\` if the fleet really ` +
          `is that large and the memory is available.`,
      );
    }
  }
  const results = await mapWithConcurrency(recs, concurrency, async (rec): Promise<Outcome> => {
    if (rec.status === 'destroyed') return { kind: 'ok' }; // Cold intentionally gone — not a torn restore
    const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
    try {
      // Resolve the AUTHORITATIVE live pointer (strong read) — not the drained `rec.currentGen`, which the
      // enumeration may have read eventually-consistently and can lag the live pointer. `rec` is used only to
      // enumerate + skip destroyed segments.
      const live = await deps.registry.get(ref);
      if (!live || live.status === 'destroyed') return { kind: 'ok' }; // vanished/shredded — no live pointer
      const present = await listGenerations(deps.cold, ref);
      if (present.has(live.currentGen)) return { kind: 'ok' };
      return {
        kind: 'issue',
        issue: {
          segment: rec.segment,
          namespace: rec.namespace,
          currentGen: live.currentGen,
          issue: 'missing-cold-generation',
        },
      };
    } catch (error) {
      // Fault isolation: one unreadable segment (a partial/transient object store mid-restore) must not abort
      // the whole triage. Record it and keep scanning the rest.
      return {
        kind: 'error',
        error: {
          segment: rec.segment,
          namespace: rec.namespace,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  const inconsistent: ConsistencyIssue[] = [];
  const errored: ConsistencyErrorEntry[] = [];
  for (const r of results) {
    if (r.kind === 'issue') inconsistent.push(r.issue);
    else if (r.kind === 'error') errored.push(r.error);
  }
  return { checked: recs.length, inconsistent, errored };
}
