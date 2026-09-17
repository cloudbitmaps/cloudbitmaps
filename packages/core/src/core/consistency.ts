/**
 * Fail-safe cross-store disaster-recovery check. The registry (`currentGen`) and the immutable `.crbm`
 * generations can be restored **independently**, so a failover can recover the registry *ahead of* the storage
 * objects — leaving `currentGen` pointing at a generation whose `.crbm` isn't present yet. That is likelier
 * than it sounds even now that both usually live in one bucket: a restore scoped to a prefix, or replayed
 * per-object from a version history, recovers the two prefixes at different points. That's a torn restore: reads of the affected segment then throw. This scan
 * detects it up front (run it at startup after a restore) instead of discovering it on the first read.
 *
 * Read-only; bounded fan-out. `destroyed` (crypto-shredded) segments are skipped — their Storage is intentionally
 * gone/unreadable, not a torn restore. A segment whose Storage/registry can't be read this pass is recorded in
 * `errored` (never aborts the scan). Each segment is checked against its **authoritative live pointer** — one
 * strong `registry.get` per segment — never the enumeration snapshot from `registry.list`, which can be
 * eventually-consistent (an unindexed Scan) and lag a recent in-place pointer advance: trusting it would both
 * miss a torn *live* generation and cry torn on a generation the pointer has already advanced past (GC'd during
 * the scan). Residual: a load's publish plus a GC landing in the tiny per-segment get→list gap can still yield a
 * transient false positive — run the scan against a quiesced fleet (the documented restore procedure), or re-run
 * to confirm a reported tear.
 */

import { mapWithConcurrency } from './concurrency';
import { ValidationError } from './errors';
import { DEFAULT_MAX_SCAN_SEGMENTS, drainRegistry } from './registry-scan';
import type { IStorageDriver, IRegistryDriver, SegmentRef } from './ports';

/** Default in-flight fan-out for the consistency scan — bounded, no thundering herd. */
/**
 * Default ceiling on how many registry records one consistency check may hold resident: 250,000.
 *
 * **Named `maxScanSegments`, not `maxSegments`, on purpose.** A `maxSegments`-style option caps how much work
 * one cycle does and then *continues normally* (the retention sweep's `limit` is that shape). This one caps how
 * much a scan may hold and *refuses* past it. Same-sounding names with opposite behaviour at the limit is a
 * trap; the name says what it is — a ceiling on a scan that fails closed.
 *
 * Generous — fleets of 100K+ segments are the design target — while still bounding a DR drill's memory to
 * something a modest operator box survives. Raisable, because a ceiling you cannot lift is a landmine.
 */
// Re-exported from its original home so `@cloudbitmaps/core`'s public name does not move; the value and the loop
// that enforces it now live in `registry-scan.ts`, shared with the retention sweep.
export { DEFAULT_MAX_SCAN_SEGMENTS } from './registry-scan';
const DEFAULT_CHECK_CONCURRENCY = 8;

export interface ConsistencyIssue {
  readonly segment: string;
  readonly namespace?: string;
  /** The registry's `currentGen` for the segment — the generation whose `.crbm` is missing from Storage. */
  readonly currentGen: number;
  /** The only issue class today: `currentGen` references a Storage generation that is not present (torn restore). */
  readonly issue: 'missing-storage-generation';
}

/** A segment that could not be checked this pass (Storage/registry read fault) — not proof of a torn restore. */
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
async function generationsPresent(storage: IStorageDriver, ref: SegmentRef): Promise<Set<number>> {
  const present = new Set<number>();
  for await (const key of storage.list(ref)) present.add(key.generation);
  return present;
}

type Outcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'issue'; readonly issue: ConsistencyIssue }
  | { readonly kind: 'error'; readonly error: ConsistencyErrorEntry };

/**
 * Verify every registered segment's `currentGen` `.crbm` actually exists in Storage. Enumerates the registry
 * (optionally one namespace) and, for each non-`destroyed` segment, checks the object store lists that
 * generation. Returns the torn segments in `inconsistent` (empty ⇒ coherent) and any unreadable segments in
 * `errored`.
 */
export async function runConsistencyCheck(
  deps: { readonly storage: IStorageDriver; readonly registry: IRegistryDriver },
  options: { namespace?: string; concurrency?: number; maxScanSegments?: number } = {},
): Promise<ConsistencyReport> {
  const concurrency = options.concurrency ?? DEFAULT_CHECK_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    // Fail fast before the (possibly huge) registry scan, not after.
    throw new ValidationError(`concurrency must be a positive integer; got ${concurrency}`);
  }
  const maxScanSegments = options.maxScanSegments ?? DEFAULT_MAX_SCAN_SEGMENTS;
  // Bounded enumeration, shared with the retention sweep — see `registry-scan.ts` for why a fleet-wide scan is
  // drained rather than streamed, and why the ceiling is not optional. This used to be an inline copy of that loop.
  const recs = await drainRegistry(deps.registry, {
    namespace: options.namespace,
    maxScanSegments,
    op: 'checkConsistency',
  });
  const results = await mapWithConcurrency(recs, concurrency, async (rec): Promise<Outcome> => {
    if (rec.status === 'destroyed') return { kind: 'ok' }; // Storage intentionally gone — not a torn restore
    const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
    try {
      // Resolve the AUTHORITATIVE live pointer (strong read) — not the drained `rec.currentGen`, which the
      // enumeration may have read eventually-consistently and can lag the live pointer. `rec` is used only to
      // enumerate + skip destroyed segments.
      const live = await deps.registry.get(ref);
      if (!live || live.status === 'destroyed') return { kind: 'ok' }; // vanished/shredded — no live pointer
      // A row with no Storage generation is *deliberately* Storage-less — a retention policy recorded before the first
      // load, given a row so the segment is enumerable at all. There is no generation that ought to exist, so nothing can be missing. Reporting it
      // would make `missing-storage-generation` fire on the healthy steady state of every such segment, which is the
      // opposite of what a DR triage needs: the one real signal drowned in expected noise.
      if (live.currentGen === null) return { kind: 'ok' };
      const present = await generationsPresent(deps.storage, ref);
      if (present.has(live.currentGen)) return { kind: 'ok' };
      return {
        kind: 'issue',
        issue: {
          segment: rec.segment,
          namespace: rec.namespace,
          currentGen: live.currentGen,
          issue: 'missing-storage-generation',
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
