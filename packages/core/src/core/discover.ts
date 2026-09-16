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
  /**
   * The generation the **pointer names** — not what a read would resolve. On a `destroyed` tombstone this is
   * still a number while reads answer empty, so read it together with {@link SegmentInfo.status} rather than
   * alone. `null` means the row exists with no Cold generation yet.
   */
  readonly currentGen: number | null;
  /**
   * `destroyed` is a tombstone: the row stays so sweeps can still find it, and the generations are gone — on an
   * encrypted segment the DEK wrappings went with them, which is what makes the bytes unrecoverable rather than
   * merely deleted.
   */
  readonly status: RegistryRecord['status'];
}

/**
 * Whether this segment's pointer resolves a generation — the question behind "does it already exist?".
 *
 * One registry point read, on every backend. Deliberately narrower than "is there a row": it is **false** for a
 * row that exists with `currentGen: null` (a retention policy recorded ahead of the first load) and for a
 * `destroyed` tombstone, because a read answers empty in both. The predicate mirrors generation resolution
 * clause for clause, which is what keeps the two from disagreeing.
 *
 * It is NOT the same question as `count() > 0`. A segment loaded with no ids exists and counts zero — the
 * distinction between "never loaded" and "loaded, and genuinely empty" is the one `count()` cannot make and
 * the main reason this function is worth having.
 *
 * Two states answer `true` where a read still gives you nothing, and neither is this call's job to detect: a
 * **torn restore** (`missing-cold-generation` — a live pointer whose object was deleted) makes reads *throw*
 * `NotFoundError` rather than answer empty, and `runConsistencyCheck` is the call that looks for it; and a
 * handle carrying an expired `expiresAt` reads as empty by a rule that lives on the handle, not on the row.
 *
 * Not a lock. A segment can be created or dropped between this call and whatever you do next; if the answer
 * has to hold, use the fences that exist for it — `load`'s guard, or `expectFrom`/`expectToken` on a publish.
 */
export async function segmentExists(ref: SegmentRef, registry: IRegistryDriver): Promise<boolean> {
  validateSegmentRef(ref);
  const record = await registry.get(ref);
  return record !== null && record.status !== 'destroyed' && record.currentGen !== null;
}

/**
 * Every segment the registry holds, streamed — optionally scoped to one namespace.
 *
 * **This is an admin/discovery call, not a request-path one.** It is the registry's own enumeration — a paged
 * LIST over the `registry/` prefix — so cost grows with the fleet, not with what you are looking for. The
 * fleet-wide sweeps that *drain* it bound it (`maxScanSegments`); this one streams, so the bound is yours.
 *
 * **Scoping to a namespace narrows the LIST prefix**, so it really is the difference between reading one
 * tenant and reading all of them.
 *
 * Streams, so a large fleet need not be held at once, and stopping the iteration stops the scan — **with one
 * exception that matters**: a driver that buffers its enumeration defeats both properties, and
 * `RetryingRegistryDriver` does exactly that (it must, to retry a `list` as a unit). Wrapped in it, the whole
 * scan is paid for and resident before the first row reaches you. On the four native drivers the guarantee
 * holds; on S3 the granularity is a page, so one LIST page and its in-flight row reads complete regardless.
 *
 * Yields `destroyed` tombstones, and rows whose `currentGen` is `null`, because hiding either would make this
 * disagree with the registry it reports on — a filtered enumeration that looks complete is how a retention
 * sweep ends up permanently skipping rows nobody can see. Filter on `status`/`currentGen` yourself, or use
 * {@link segmentExists} for the "does the pointer resolve" question. Internal bookkeeping rows are the one
 * exclusion, and only on an unscoped scan: they are not segments, and a caller naming their namespace still
 * sees them.
 */
export async function* listSegments(
  registry: IRegistryDriver,
  options: { namespace?: string } = {},
): AsyncIterable<SegmentInfo> {
  // Validated here rather than only at the facade: this is a public export of `@cloudbitmaps/core`, and its
  // sibling `segmentExists` validates. Without it a typo'd or externally-supplied tenant id reads as "this
  // tenant has no segments" — an empty result is the most dangerous possible answer to a malformed question.
  if (options.namespace !== undefined)
    validateSegmentRef({ segment: 'x', namespace: options.namespace });
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
