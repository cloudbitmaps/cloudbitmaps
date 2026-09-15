/**
 * `segmentExists` and `listSegments` — ask the registry what is there.
 *
 * The registry has always known which segments exist; it is what `checkConsistency`, the retention sweep and
 * `exportSegments` each enumerate. It was simply never exposed, so a user asking "do I already have this?" had
 * to infer it: `count()` returns `0` for a segment that was never loaded AND for one loaded with no ids, and
 * `generations()` costs a bucket listing to answer a question the pointer alone settles.
 *
 * Inferring it is the expensive kind of wrong. The alternative a user reaches for is keeping their own list of
 * segment names alongside the store — a second source of truth, updated by hand, drifting from the first the
 * moment a load fails halfway. The registry is already the list; these two functions read it.
 */
import type { IRegistryDriver, RegistryRecord, SegmentRef } from './ports';
import { excludingReservedRows } from './registry-scan';
import { validateSegmentRef } from './validate';

/** One segment the registry knows about. */
export interface SegmentInfo extends SegmentRef {
  /** The generation a read would resolve, or `null` for a segment that exists with no data yet. */
  readonly currentGen: number | null;
  /** `destroyed` is a crypto-shredded tombstone: the row is still here, the bytes are gone for good. */
  readonly status: RegistryRecord['status'];
}

/**
 * Whether a read of this segment would resolve a generation — the question behind "does it already exist?".
 *
 * One registry point read, on every backend. Deliberately narrower than "is there a row": it is **false** for a
 * row that exists with `currentGen: null` (a retention policy recorded ahead of the first load) and for a
 * `destroyed` tombstone, because in both cases a read answers empty. The rule is exactly *would a read find
 * anything*, which is the only definition that never surprises the caller who is deciding whether to load.
 *
 * It is NOT the same question as `count() > 0`. A segment loaded with no ids exists and counts zero — the
 * distinction between "never loaded" and "loaded, and genuinely empty" is the one `count()` cannot make and
 * the main reason this function is worth having.
 *
 * Not a lock. A segment can be created or dropped between this call and whatever you do next; if the answer
 * has to hold, use the fences that exist for it — `load`\'s guard, or `expectFrom`/`expectToken` on a publish.
 */
export async function segmentExists(ref: SegmentRef, registry: IRegistryDriver): Promise<boolean> {
  validateSegmentRef(ref);
  const record = await registry.get(ref);
  return record !== null && record.status !== 'destroyed' && record.currentGen !== null;
}

/**
 * Every segment the registry holds, streamed — optionally scoped to one namespace.
 *
 * **This is an admin/discovery call, not a request-path one.** It is the registry\'s own enumeration, which on
 * DynamoDB is a `Scan` and on an object-store registry a paged LIST: cost grows with the fleet, not with what
 * you are looking for. Every internal caller bounds it (`maxScanSegments`) for that reason. Scope it to a
 * `namespace` whenever you can — that is the difference between reading one tenant and reading everyone.
 *
 * Streams rather than collecting, so a large fleet does not have to fit in memory at once; stop iterating and
 * the underlying scan stops with it.
 *
 * Yields `destroyed` tombstones, and rows whose `currentGen` is `null`, because hiding either would make this
 * disagree with the registry it reports on — a filtered enumeration that looks complete is how a retention
 * sweep ends up permanently skipping rows nobody can see. Filter on `status`/`currentGen` yourself, or use
 * {@link segmentExists} for the "is there data" question. Internal bookkeeping rows are the one exclusion, and
 * only on an unscoped scan: they are not segments, and a caller naming their namespace still sees them.
 */
export async function* listSegments(
  registry: IRegistryDriver,
  options: { namespace?: string } = {},
): AsyncIterable<SegmentInfo> {
  const raw = registry.list(options.namespace);
  const source = options.namespace === undefined ? excludingReservedRows(raw) : raw;
  for await (const record of source) {
    yield {
      ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
      segment: record.segment,
      currentGen: record.currentGen,
      status: record.status,
    };
  }
}
