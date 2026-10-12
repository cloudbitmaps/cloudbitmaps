/**
 * Fail-safe cross-store disaster-recovery check. The registry (`currentGen`) and the immutable `.crbm`
 * generations can be restored **independently**, so a failover can recover the registry *ahead of* the storage
 * objects — leaving `currentGen` pointing at a generation whose `.crbm` isn't present yet. That is likelier
 * than it sounds even with both in one bucket: a restore scoped to a prefix, or replayed
 * per-object from a version history, recovers the two prefixes at different points. That's a torn restore: reads of
 * the affected segment then throw. This scan
 * detects it up front (run it at startup after a restore) instead of discovering it on the first read.
 *
 * Read-only; bounded fan-out. `destroyed` (crypto-shredded) segments are skipped — their Storage is intentionally
 * gone/unreadable, not a torn restore. A segment whose Storage/registry can't be read this pass is recorded in
 * `errored` (never aborts the scan). Each segment is checked against its **authoritative live pointer** — one
 * strong `registry.get` per segment — never the enumeration snapshot from `registry.list`, which a driver may
 * serve eventually-consistently and so lag a recent in-place pointer advance: trusting it would both
 * miss a torn *live* generation and cry torn on a generation the pointer has already advanced past (GC'd during
 * the scan). Residual: a load's publish plus a GC landing in the tiny per-segment get→read gap can still yield a
 * transient false positive — run the scan against a quiesced fleet (the documented restore procedure), or re-run
 * to confirm a reported tear.
 */

import { requirePositiveInteger } from './check';
import { mapWithConcurrency } from './concurrency';
import { generationsOf } from './generation-list';
import { ValidationError, isIntegrityError, isKeyUnavailableError } from './errors';
import { DEFAULT_MAX_SCAN_SEGMENTS, drainRegistry } from './registry-scan';
import type { GenKey, IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';
import { openNamedGeneration } from './crbm-open';
import { fingerprintParts } from './crbm/fingerprint';
import type { Aead, IKeystore, WrappedDek } from './crypto';
import { aadFor } from './crypto';
import { summaryAgrees, usableSummary } from './summary';
import { validateUserNamespace } from './validate';

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
// Re-exported from its original home because this module is where the ceiling is documented; the value and the
// loop that enforces it live in `registry-scan.ts`, shared with the retention sweep. This is an INTERNAL
// re-export: it is not on `@cloudbitmaps/core`'s main entry, and a caller passes their own `maxScanSegments` rather
// than read ours.
export { DEFAULT_MAX_SCAN_SEGMENTS } from './registry-scan';
/** Default in-flight fan-out for the consistency scan — bounded, no thundering herd. */
const DEFAULT_CHECK_CONCURRENCY = 8;

export interface ConsistencyIssue {
  readonly segment: string;
  readonly namespace?: string;
  /** The registry's `currentGen` for the segment — the generation whose `.crbm` is missing from Storage. */
  readonly currentGen: number;
  /**
   * `missing-storage-generation`: `currentGen` references a Storage generation that is not present (torn restore).
   * `summary-mismatch` (only when asked for): the generation is there, but its row's summary names another object
   * than the one under its number, says a different id count or metadata than the object holds (a row restored from
   * another point than its bucket, or an object put back from outside the library), or records a fingerprint that
   * names no object. A summary that names another object is what a count and a `stat()` answer from while every read
   * that opens the object refuses it; one whose count or metadata disagrees is answered from until a read opens the
   * object, which stops that store using it; one whose fingerprint names no object is not used, so every read opens the
   * object unchecked.
   */
  readonly issue: 'missing-storage-generation' | 'summary-mismatch';
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
  /**
   * With `summaries: true`, the segments whose row's summary could not be held against its object because it is
   * sealed and no keystore was given, or does not open under the one given: neither checked nor found wrong. Present
   * only when summaries were asked for.
   */
  readonly summariesUnchecked?: number;
}

type Outcome =
  | { readonly kind: 'ok'; readonly unchecked?: boolean }
  | { readonly kind: 'issue'; readonly issue: ConsistencyIssue }
  | { readonly kind: 'error'; readonly error: ConsistencyErrorEntry };

/**
 * Hold a row's summary against the object it describes. `found` is called once the open's first read of the object has
 * answered.
 */
async function checkSummary(
  ref: SegmentRef,
  live: RegistryRecord,
  deps: { readonly storage: IStorageDriver; readonly keystore?: IKeystore },
  found?: () => void,
): Promise<Outcome> {
  const generation = live.currentGen as number;
  const keyed = live.wrappedDeks !== undefined && live.wrappedDeks.length > 0;
  let aead: Aead | undefined;
  if (keyed) {
    if (deps.keystore === undefined) return { kind: 'ok', unchecked: true };
    try {
      aead = await deps.keystore.openDek(live.wrappedDeks as readonly WrappedDek[]);
    } catch (err) {
      if (isIntegrityError(err) || isKeyUnavailableError(err))
        return { kind: 'ok', unchecked: true };
      throw err;
    }
  }
  const mismatch: Outcome = {
    kind: 'issue',
    issue: {
      segment: ref.segment,
      namespace: ref.namespace,
      currentGen: generation,
      issue: 'summary-mismatch',
    },
  };
  const described = usableSummary(ref, live, aead);
  if (described === undefined) {
    // A clear summary of this generation whose fingerprint names no object (a registry of your own can hand one over)
    // is not used by any read, so the object is opened unchecked: a row to report, not one that passes.
    const summary = live.summary;
    const unnamed =
      !keyed &&
      live.status === 'active' &&
      summary !== undefined &&
      !('sealed' in summary) &&
      summary.generation === generation &&
      fingerprintParts(summary.fingerprint) === undefined;
    return unnamed ? mismatch : { kind: 'ok', unchecked: keyed };
  }
  // The object must be the one the summary names, as well as hold what it says: another object under the number (a
  // restore that put back an object the row does not name) is what every read of the segment refuses. Its footer says
  // which, before its index is opened, so an object sealed under another key is found too.
  const reader = await openNamedGeneration(
    deps.storage,
    { namespace: ref.namespace, segment: ref.segment, generation },
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(ref, generation, scope) },
    described.fingerprint,
    found,
  );
  if (
    reader !== undefined &&
    summaryAgrees(described, { cardinality: reader.count(), metadata: reader.metadata })
  ) {
    return { kind: 'ok' };
  }
  return mismatch;
}

/**
 * Whether the object under `key` is there. A zero-length tail read that answers settles it. When that read fails, in
 * any way, the segment's listing decides, as it did before the read was made: a `NotFoundError` may be a missing bucket
 * (S3 answers a `HEAD` of a missing object and of a missing bucket alike), and a `HEAD` that fails otherwise carries no
 * error body, so S3 names no code for it and Azure Blob no message. The listing's own error is the segment's.
 */
async function objectIsPresent(storage: IStorageDriver, key: GenKey): Promise<boolean> {
  try {
    await storage.getTail(key, 0);
    return true;
  } catch {
    return await listed(storage, key);
  }
}

/** Whether the segment's listing holds `key`'s generation; a listing that fails throws. */
async function listed(storage: IStorageDriver, key: GenKey): Promise<boolean> {
  const present = await generationsOf(storage, { namespace: key.namespace, segment: key.segment });
  return present.includes(key.generation);
}

/**
 * Whether {@link checkSummary} will open the row's object with no request before it: a clear summary of the current
 * generation that names an object. The open's first request is a tail read that fails with `NotFoundError` for a
 * missing object, so it settles presence and the check needs no request of its own. Any other row (sealed, or a summary
 * not used) may end the check before the object is read, so presence is asked first, as it always was.
 */
function summaryOpensObject(ref: SegmentRef, live: RegistryRecord): boolean {
  const keyed = live.wrappedDeks !== undefined && live.wrappedDeks.length > 0;
  return !keyed && usableSummary(ref, live, undefined) !== undefined;
}

/**
 * Verify every registered segment's `currentGen` `.crbm` actually exists in Storage. Enumerates the registry
 * (optionally one namespace) and, for each non-`destroyed` segment, asks the object store for that generation with a
 * zero-length tail read. Returns the torn segments in `inconsistent` (empty ⇒ coherent) and any unreadable segments in
 * `errored`.
 *
 * When that read fails, in any way, the segment's listing decides and its own error is the segment's, so a missing
 * object, a missing bucket and a failing store are reported as when every segment was listed. One difference: a store
 * that answers reads but refuses listings (an identity without list permission, or a listing-only outage) reports each
 * object that is there as present, where every segment was reported errored.
 *
 * With `summaries: true` it also opens each segment's current object (one tail read, and a second for an index longer
 * than it) and holds the row's summary against it: the object it names by its fingerprint, and the count and metadata
 * it says, reporting `summary-mismatch` where they disagree, and for a clear summary whose fingerprint names no
 * object, which no read uses. For a row with a clear summary that open is the only request of the object; if it fails
 * before its first read answered, the listing decides, and once that read has answered a failure is an error of the
 * segment. A sealed summary needs `deps.keystore`; without it the segment is counted in `summariesUnchecked`. Off by
 * default, since the default check only looks for the object.
 */
export async function runConsistencyCheck(
  deps: {
    readonly storage: IStorageDriver;
    readonly registry: IRegistryDriver;
    readonly keystore?: IKeystore;
  },
  options: {
    namespace?: string;
    concurrency?: number;
    maxScanSegments?: number;
    summaries?: boolean;
  } = {},
): Promise<ConsistencyReport> {
  if (options.namespace !== undefined) validateUserNamespace(options.namespace);
  if (options.summaries !== undefined && typeof options.summaries !== 'boolean') {
    throw new ValidationError(`summaries must be a boolean; got ${String(options.summaries)}`);
  }
  const concurrency = options.concurrency ?? DEFAULT_CHECK_CONCURRENCY;
  // Fail fast before the (possibly huge) registry scan, not after.
  requirePositiveInteger(concurrency, 'concurrency');
  const maxScanSegments = options.maxScanSegments ?? DEFAULT_MAX_SCAN_SEGMENTS;
  // Bounded enumeration, shared with the retention sweep — see `registry-scan.ts` for why a fleet-wide scan is
  // drained rather than streamed, and why the ceiling is not optional.
  const recs = await drainRegistry(deps.registry, {
    namespace: options.namespace,
    maxScanSegments,
    op: 'checkConsistency',
    // Two callers reach this refusal, and only one of them can raise the ceiling: `store.checkConsistency` takes
    // no `maxScanSegments`, so the advice names the call that does.
    raise:
      'raise `maxScanSegments` on `runConsistencyCheck` (`store.checkConsistency` takes no ceiling, so run ' +
      '`runConsistencyCheck({ storage: backend.storage, registry: backend.registry }, { maxScanSegments })` ' +
      'over the same backend instead)',
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
      // load, given a row so the segment is enumerable at all. There is no generation that ought to exist, so nothing
      // can be missing. Reporting it
      // would make `missing-storage-generation` fire on the healthy steady state of every such segment, which is the
      // opposite of what a DR triage needs: the one real signal drowned in expected noise.
      if (live.currentGen === null) return { kind: 'ok' };
      const key: GenKey = {
        namespace: ref.namespace,
        segment: ref.segment,
        generation: live.currentGen,
      };
      const missing: Outcome = {
        kind: 'issue',
        issue: {
          segment: rec.segment,
          namespace: rec.namespace,
          currentGen: live.currentGen,
          issue: 'missing-storage-generation',
        },
      };
      const checksSummary = options.summaries === true && live.summary !== undefined;
      if (checksSummary && summaryOpensObject(ref, live)) {
        let found = false;
        try {
          return await checkSummary(ref, live, deps, () => (found = true));
        } catch (err) {
          // Once the open's first read has found the object, a failure is an error of the segment, as it was when the
          // listing had found it first: an object that goes mid-open is not reported torn. Before that, the listing
          // decides, as it did, and its own error is the segment's.
          if (found) throw err;
          if (!(await listed(deps.storage, key))) return missing;
          throw err;
        }
      }
      if (!(await objectIsPresent(deps.storage, key))) return missing;
      return checksSummary ? await checkSummary(ref, live, deps) : { kind: 'ok' };
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
  let summariesUnchecked = 0;
  for (const r of results) {
    if (r.kind === 'issue') inconsistent.push(r.issue);
    else if (r.kind === 'error') errored.push(r.error);
    else if (r.unchecked === true) summariesUnchecked += 1;
  }
  return options.summaries === true
    ? { checked: recs.length, inconsistent, errored, summariesUnchecked }
    : { checked: recs.length, inconsistent, errored };
}
