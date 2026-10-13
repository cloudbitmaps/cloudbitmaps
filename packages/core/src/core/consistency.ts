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
 * `errored` (never aborts the scan). One segment can add several entries to `inconsistent` (its current object, and with
 * `generations` one per known generation whose object is not the one recorded) and can also be in `errored`, when a
 * read failed after those were found; with `generations` a segment costs up to one read per entry of its ledger.
 * Each segment is checked against its **authoritative live pointer** — one
 * strong `registry.get` per segment — never the enumeration snapshot from `registry.list`, which a driver may
 * serve eventually-consistently and so lag a recent in-place pointer advance: trusting it would both
 * miss a torn *live* generation and cry torn on a generation the pointer has already advanced past (GC'd during
 * the scan). Residual: a load's publish plus a GC landing in the per-segment gap between the pointer read and the
 * object reads (one read, or with `generations` as many as the ledger names) can still yield a transient false
 * positive — run the scan against a quiesced fleet (the documented restore procedure), or re-run to confirm a
 * reported tear.
 */

import { requirePositiveInteger } from './check';
import { mapWithConcurrency } from './concurrency';
import { generationsOf } from './generation-list';
import {
  ValidationError,
  isIntegrityError,
  isKeyUnavailableError,
  isNotFoundError,
} from './errors';
import { DEFAULT_MAX_SCAN_SEGMENTS, drainRegistry } from './registry-scan';
import type { GenKey, IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';
import type { BlobReader } from './blob';
import { openNamedGeneration, storageBlobReader } from './crbm-open';
import { readFooter } from './crbm/reader';
import { fingerprintParts } from './crbm/fingerprint';
import type { Aead, IKeystore, WrappedDek } from './crypto';
import { aadFor } from './crypto';
import { MAX_STORED_KNOWN_GENERATIONS, usableKnownGens } from './known-generations';
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
  /**
   * The registry's `currentGen` for the segment. For `missing-storage-generation` it is the generation whose `.crbm` is
   * missing from Storage; for the other issues it is the segment's current generation, whichever generation the issue
   * is about (see `generation`).
   */
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
   * `known-generation-mismatch` (only when asked for): the object under the number `generation` is not the one the row's
   * ledger of known generations recorded for it: its footer checksum differs, or its footer fails its own checks (it is
   * not a `.crbm` object, or is cut short). It says nothing of what a rollback does with that generation.
   * What it covers: each object's footer is held to the recorded checksum, so another object, or bytes that are not a
   * `.crbm`, under a known number is found. It does not find damage inside an object whose footer is intact (a cut or a
   * flipped byte in the body: a read of that generation reports it as `IntegrityError`), nor a metadata change that keeps
   * the footer's bytes.
   */
  readonly issue: 'missing-storage-generation' | 'summary-mismatch' | 'known-generation-mismatch';
  /**
   * With `known-generation-mismatch` only: the generation whose object is not the one the row recorded. It is
   * `currentGen` when the current object is the one that differs. Absent on every other issue.
   */
  readonly generation?: number;
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
  /**
   * The issues found, one entry each: a segment whose `currentGen` `.crbm` is absent (recover the object store, or
   * restore to a coherent point), and with the options asked for the other kinds. One segment can have several entries:
   * at most one for its current object plus one per entry of its ledger, so at most 1 plus the ledger's length (384 at
   * most). The ledger's length is bounded by the registry, and the report is not capped.
   */
  readonly inconsistent: ConsistencyIssue[];
  /**
   * Segments that couldn't be read this pass (a transient/partial object store during a restore is exactly when
   * this runs) — **triage these too**: an unread segment is neither proven-coherent nor proven-torn. A segment can be in
   * this list and in `inconsistent` too: what was found before the read that failed is kept. Empty on a clean pass.
   */
  readonly errored: ConsistencyErrorEntry[];
  /**
   * With `summaries: true`, the segments whose row's summary could not be held against its object because it is
   * sealed and no keystore was given, or does not open under the one given: neither checked nor found wrong. Present
   * only when summaries were asked for.
   */
  readonly summariesUnchecked?: number;
  /**
   * With `generations: true`, the rows with a pointer whose ledger of known generations could not be used (absent, or
   * failing the validation every reader of it applies, or not shaped as a ledger a registry of this library stores):
   * none of their known generations was held against its object. A count, not an issue. Present only when generations
   * were asked for.
   */
  readonly generationsUnchecked?: number;
}

type Outcome =
  | { readonly kind: 'ok'; readonly unchecked?: boolean }
  | { readonly kind: 'issue'; readonly issue: ConsistencyIssue };

/** What one segment adds to the report: the issues found, a read that failed, and which counts it adds to. */
interface SegmentResult {
  readonly issues: readonly ConsistencyIssue[];
  readonly error?: ConsistencyErrorEntry;
  readonly summaryUnchecked?: boolean;
  readonly generationsUnchecked?: boolean;
}

const NOTHING: SegmentResult = { issues: [] };

const errorEntry = (rec: RegistryRecord, error: unknown): ConsistencyErrorEntry => ({
  segment: rec.segment,
  namespace: rec.namespace,
  error: error instanceof Error ? error.message : String(error),
});

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
  // The open's tail read is sized from the summary's `tailBytes`: a sealed summary was opened with the key above,
  // before any read of the object, so unlike an open that starts from the object (which sends its tail read beside the
  // key) there is no overlap to give up: the key already comes first.
  const reader = await openNamedGeneration(
    deps.storage,
    { namespace: ref.namespace, segment: ref.segment, generation },
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(ref, generation, scope) },
    described,
    found,
  );
  if (
    reader !== undefined &&
    summaryAgrees(described, {
      cardinality: reader.count(),
      metadata: reader.metadata,
      tailBytes: reader.tailBytes,
    })
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
 * Whether `value` is a ledger as a registry of this library stores one: an array of at most
 * {@link MAX_STORED_KNOWN_GENERATIONS} entries, each exactly `{ generation, footerCrc }`, the generation a non-negative
 * safe integer and unique, the checksum an integer from 0 to 2^32 - 1. These are the rules the built-in registries hold a
 * stored row to (and `undefined`, no ledger, passes: the usable-ledger rule then counts it). A registry of your own can
 * hand back anything, so this is checked before a ledger is read or walked: the walk's reads are bounded by the cap, and
 * a checksum that cannot be a footer's is never held against an object. The validator the registries apply is in the
 * driver layer, which this module cannot import, so the rules are written here.
 */
function storedLedgerOk(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_STORED_KNOWN_GENERATIONS) return false;
  const seen = new Set<number>();
  for (const e of value as unknown[]) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
    const entry = e as Record<string, unknown>;
    if (Object.keys(entry).some((k) => k !== 'generation' && k !== 'footerCrc')) return false;
    const { generation, footerCrc } = entry;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) return false;
    if (
      !Number.isInteger(footerCrc) ||
      (footerCrc as number) < 0 ||
      (footerCrc as number) > 0xffff_ffff
    ) {
      return false;
    }
    if (seen.has(generation as number)) return false;
    seen.add(generation as number);
  }
  return true;
}

/**
 * Hold each generation the row's usable ledger names against its object, by the footer checksum the ledger records. One
 * footer read each (the footer's bytes only; not retried, as the check's other reads are), one after another, so a
 * segment never has more than the one request in flight that the check's `concurrency` already allows it. The footer
 * needs no key, whether the object is sealed or not.
 *
 * How a footer read is classed:
 * - the object is not in the bucket (`NotFoundError`): skipped. A lifecycle rule, a restore of the bucket from another
 *   point than the registry, or an object removed by hand leaves such entries, and they harm nothing;
 * - the footer's checksum is not the recorded one, or the footer fails its own checks (the bytes are not a `.crbm`, or
 *   are cut short): `known-generation-mismatch`, since the object is not the one that was recorded;
 * - the driver answers a size that is not a byte count its tail fits in: that is the driver's word, not the object's, so
 *   it is an error of the segment, not a mismatch;
 * - any other failed read (a transient fault included): stops the segment's reads and is its error, with the mismatches
 *   found before it kept.
 */
async function checkKnownGenerations(
  ref: SegmentRef,
  currentGen: number,
  known: readonly { readonly generation: number; readonly footerCrc: number }[],
  deps: { readonly storage: IStorageDriver },
): Promise<{ readonly issues: ConsistencyIssue[]; readonly failed?: unknown }> {
  const issues: ConsistencyIssue[] = [];
  for (const entry of known) {
    let mismatch: boolean;
    try {
      const { footerCrc } = await readFooter(footerReader(deps.storage, ref, entry.generation));
      mismatch = footerCrc !== entry.footerCrc;
    } catch (err) {
      if (isNotFoundError(err)) continue;
      if (!isIntegrityError(err)) return { issues, failed: err };
      mismatch = true;
    }
    if (mismatch) {
      issues.push({
        segment: ref.segment,
        namespace: ref.namespace,
        currentGen,
        issue: 'known-generation-mismatch',
        generation: entry.generation,
      });
    }
  }
  return { issues };
}

/**
 * The blob reader of one generation's object, which refuses a tail answer whose size is not a byte count, as a fault of
 * the driver.
 */
function footerReader(storage: IStorageDriver, ref: SegmentRef, generation: number): BlobReader {
  const blob = storageBlobReader(storage, { ...ref, generation });
  return {
    getRange: (offset, length) => blob.getRange(offset, length),
    getTail: async (maxBytes) => {
      const tail = await blob.getTail(maxBytes);
      if (!Number.isSafeInteger(tail.size) || tail.size < tail.bytes.length) {
        // A plain error, not an IntegrityError: the size is the driver's answer, so it says nothing of the object.
        throw new Error(
          `the storage driver answered a tail whose size is not a byte count its bytes fit in: ${String(tail.size)}`,
        );
      }
      return tail;
    },
  };
}

/**
 * Whether the row's current object is there and, with `summaries`, agrees with the row's summary. The row has a pointer
 * and is active.
 */
async function checkCurrentObject(
  ref: SegmentRef,
  live: RegistryRecord,
  deps: { readonly storage: IStorageDriver; readonly keystore?: IKeystore },
  summaries: boolean,
): Promise<Outcome> {
  const currentGen = live.currentGen as number;
  const key: GenKey = { namespace: ref.namespace, segment: ref.segment, generation: currentGen };
  const missing: Outcome = {
    kind: 'issue',
    issue: {
      segment: ref.segment,
      namespace: ref.namespace,
      currentGen,
      issue: 'missing-storage-generation',
    },
  };
  const checksSummary = summaries && live.summary !== undefined;
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
 *
 * With `generations: true` it also holds every generation a row's ledger of known generations names, the current one
 * included, against its object: one footer read each (104 bytes, no key, not retried), reporting
 * `known-generation-mismatch` with the `generation` where the object's footer checksum is not the one the ledger records
 * or its footer fails its own checks. That finds another object, or bytes that are not a `.crbm`, under a known number;
 * it does not find damage inside an object whose footer is intact (a read of it reports that as `IntegrityError`), nor a
 * metadata change that keeps the footer's bytes. A segment adds at most 1 plus its ledger's length issues. A named
 * generation that is not in the bucket is not reported. A row with a pointer whose ledger cannot be used (absent, failing
 * the validation every reader of it applies, or not shaped as a ledger a registry of this library stores) is counted in
 * `generationsUnchecked` and none of its objects is read. The listing is not used: a read of a missing object
 * answers `NotFoundError`, which is how an absent one is told. A segment whose current object is missing is reported as
 * ever and its older generations are still checked. Off by default.
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
    generations?: boolean;
  } = {},
): Promise<ConsistencyReport> {
  if (options.namespace !== undefined) validateUserNamespace(options.namespace);
  if (options.summaries !== undefined && typeof options.summaries !== 'boolean') {
    throw new ValidationError(`summaries must be a boolean; got ${String(options.summaries)}`);
  }
  if (options.generations !== undefined && typeof options.generations !== 'boolean') {
    throw new ValidationError(`generations must be a boolean; got ${String(options.generations)}`);
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
  const summaries = options.summaries === true;
  const generations = options.generations === true;
  const results = await mapWithConcurrency(
    recs,
    concurrency,
    async (rec): Promise<SegmentResult> => {
      if (rec.status === 'destroyed') return NOTHING; // Storage intentionally gone — not a torn restore
      const ref: SegmentRef = { segment: rec.segment, namespace: rec.namespace };
      let live: RegistryRecord | null;
      let current: Outcome;
      try {
        // Resolve the AUTHORITATIVE live pointer (strong read) — not the drained `rec.currentGen`, which the
        // enumeration may have read eventually-consistently and can lag the live pointer. `rec` is used only to
        // enumerate + skip destroyed segments.
        live = await deps.registry.get(ref);
        if (!live || live.status === 'destroyed') return NOTHING; // vanished/shredded — no live pointer
        // A row with no Storage generation is *deliberately* Storage-less — a retention policy recorded before the first
        // load, given a row so the segment is enumerable at all. There is no generation that ought to exist, so nothing
        // can be missing. Reporting it
        // would make `missing-storage-generation` fire on the healthy steady state of every such segment, which is the
        // opposite of what a DR triage needs: the one real signal drowned in expected noise.
        if (live.currentGen === null) return NOTHING;
        current = await checkCurrentObject(ref, live, deps, summaries);
      } catch (error) {
        // Fault isolation: one unreadable segment (a partial/transient object store mid-restore) must not abort
        // the whole triage. Record it and keep scanning the rest.
        return { issues: [], error: errorEntry(rec, error) };
      }
      const issues = current.kind === 'issue' ? [current.issue] : [];
      const summaryUnchecked = current.kind === 'ok' && current.unchecked === true;
      if (!generations) return { issues, summaryUnchecked };
      // The ledger every reader of it uses: one that is absent, disagrees with its row, or is not shaped as a registry
      // stores it is not used, and the row is counted rather than read. A registry of your own can hand back anything,
      // so the walk is inside the segment's fault isolation too: one bad row never aborts the check.
      try {
        const known = storedLedgerOk(live.knownGens) ? usableKnownGens(live) : undefined;
        if (known === undefined) return { issues, summaryUnchecked, generationsUnchecked: true };
        const held = await checkKnownGenerations(ref, live.currentGen, known, deps);
        return {
          issues: [...issues, ...held.issues],
          summaryUnchecked,
          ...(held.failed === undefined ? {} : { error: errorEntry(rec, held.failed) }),
        };
      } catch (error) {
        return { issues, summaryUnchecked, error: errorEntry(rec, error) };
      }
    },
  );
  const inconsistent: ConsistencyIssue[] = [];
  const errored: ConsistencyErrorEntry[] = [];
  let summariesUnchecked = 0;
  let generationsUnchecked = 0;
  for (const r of results) {
    inconsistent.push(...r.issues);
    if (r.error !== undefined) errored.push(r.error);
    if (r.summaryUnchecked === true) summariesUnchecked += 1;
    if (r.generationsUnchecked === true) generationsUnchecked += 1;
  }
  return {
    checked: recs.length,
    inconsistent,
    errored,
    ...(summaries ? { summariesUnchecked } : {}),
    ...(generations ? { generationsUnchecked } : {}),
  };
}
