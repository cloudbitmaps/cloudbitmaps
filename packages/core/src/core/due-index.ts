/**
 * The **due index** — a time-bucketed set of the segments that carry an expiry, so a retention cycle costs what
 * is *expiring* rather than what the fleet *holds*.
 *
 * Without it, every sweep drains `registry.list()` and filters: `O(fleet)` reads every cycle, forever, even when
 * nothing expires. At 500 segments that is free; at 100,000 on a 15-minute cadence it is a standing bill for
 * finding nothing. Redis solves the same problem with a separate `expires` dict, and Elasticsearch ILM with a
 * scheduler; this is that structure, built out of registry rows so it needs **no driver change** and works on
 * every backend.
 *
 * ## Why a namespace per bucket
 *
 * `IRegistryDriver.list()` filters by **namespace and nothing else** — there is no cursor, no `startAfter`, no
 * key range. That single fact drives the whole design: the only way to read a *subset* of rows is to make the
 * subset a namespace. So the day a segment expires becomes the namespace, and listing one due day yields exactly
 * the segments due that day.
 *
 * ```
 *   cbm.due.20356  ─►  the segments whose expiry falls on day 20,356
 *   cbm.due.20357  ─►  … day 20,357
 * ```
 *
 * A day index rather than a formatted date, because `core/` reads no ambient time and formatting a date would
 * drag in a calendar (and a timezone question) for no benefit. `Math.floor(expiresAt / 86_400_000)` is total,
 * reversible and has no edge cases.
 *
 * ## The index is a FAST PATH, never the source of truth
 *
 * The segment's own registry row holds the policy; an index row is a pointer that may be stale, missing, or
 * left behind. That is deliberate, and it is what makes a second index safe here — the failure family this
 * project has hit fourteen times is *a check that cannot fire*, and the answer is that **nothing is only known
 * by the index**:
 *
 * - **A stale pointer cannot retire anything.** The sweep re-reads the live segment row before acting (it
 *   already does this — the `policy-changed` skip), so an index row whose policy has since been cleared or
 *   moved is a wasted read and nothing worse.
 * - **A missing pointer cannot lose data.** The full `registry.list()` scan still exists, demoted from the
 *   primary path to a periodic **repair** pass. Anything the index never learned about — a segment written
 *   before the index existed, or one whose name is too long to encode (see {@link canIndex}) — is retired by
 *   that pass instead. Slower, never never.
 *
 * So the index can only make the sweep *cheaper*, never *wronger*, and both drift directions are bounded by
 * machinery that already exists.
 */
import { ValidationError } from './errors';
import type { RegistryRecord, SegmentRef } from './ports';

/** Namespace prefix for due-index rows. Obeys the locked name grammar (leading alphanumeric, dots allowed). */
export const DUE_NAMESPACE_PREFIX = 'cbm.due.';

/** Bucket width. One day: small enough that a cycle reads little, coarse enough that the index stays tiny. */
export const DUE_BUCKET_MS = 86_400_000;

/**
 * The locked name grammar caps a segment or namespace at 256 characters, and an index row encodes **both** of
 * the original ref's parts into one name. A ref whose encoding would exceed this is simply not indexed — see
 * {@link canIndex}.
 */
export const MAX_NAME_LENGTH = 256;

/** Which bucket an expiry falls in. Total and reversible; no calendar, no timezone, no ambient time. */
export function dueBucket(expiresAt: number): number {
  return Math.floor(expiresAt / DUE_BUCKET_MS);
}

/** The namespace holding one bucket's pointers. */
export function dueNamespace(bucket: number): string {
  return `${DUE_NAMESPACE_PREFIX}${bucket}`;
}

/** Is this record a due-index pointer rather than a segment? */
export function isDueIndexRow(record: Pick<RegistryRecord, 'namespace'>): boolean {
  return record.namespace !== undefined && record.namespace.startsWith(DUE_NAMESPACE_PREFIX);
}

/**
 * Encode a ref into one index-row name, unambiguously.
 *
 * `${namespaceLength}.${namespace}${segment}` — a decimal length, a dot, then the two parts concatenated. The
 * length prefix is what makes it reversible: every character the grammar allows (`.`, `-`, `_`, alphanumerics)
 * is legal *inside* a name, so no separator character could ever be unambiguous on its own. Reading the digits
 * up to the first dot tells the parser exactly where the namespace ends.
 */
export function encodeDueName(ref: SegmentRef): string {
  const ns = ref.namespace ?? '';
  return `${ns.length}.${ns}${ref.segment}`;
}

/**
 * Can this ref be indexed at all? False when the encoded name would exceed the grammar's 256-character cap —
 * possible only for a ref whose namespace and segment are together near the limit.
 *
 * **Not indexable is not "not retired".** The repair scan still sees the segment's own row, so the consequence
 * is that it expires on the repair cadence instead of the fast one. Callers must not treat `false` as an error.
 */
export function canIndex(ref: SegmentRef): boolean {
  return encodeDueName(ref).length <= MAX_NAME_LENGTH;
}

/** The registry ref of the pointer for `ref` in `bucket`. Throws if the ref cannot be encoded — check first. */
export function dueIndexRef(bucket: number, ref: SegmentRef): SegmentRef {
  const segment = encodeDueName(ref);
  if (segment.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `due index: ${JSON.stringify(ref)} encodes to ${segment.length} characters, over the ` +
        `${MAX_NAME_LENGTH}-character name limit — check canIndex() first; such a segment is retired by the ` +
        `repair scan instead`,
    );
  }
  return { namespace: dueNamespace(bucket), segment };
}

/**
 * Recover the original ref from an index row's name. `null` for anything we did not write — a foreign row in
 * the reserved namespace is ignored rather than acted upon, exactly as with partition leases.
 */
export function decodeDueName(name: string): SegmentRef | null {
  const dot = name.indexOf('.');
  if (dot <= 0) return null;
  const lengthPart = name.slice(0, dot);
  if (!/^(0|[1-9][0-9]*)$/.test(lengthPart)) return null;
  const nsLength = Number(lengthPart);
  const rest = name.slice(dot + 1);
  const namespace = rest.slice(0, nsLength);
  const segment = rest.slice(nsLength);
  // A pointer to a segment with no name is meaningless — and would round-trip to a ref the grammar rejects.
  // This also covers a length prefix larger than the remainder: the slice then consumes everything and leaves
  // the segment empty, so a separate overflow guard would be unreachable (it was, and was removed).
  if (segment.length === 0) return null;
  return namespace.length === 0 ? { segment } : { namespace, segment };
}

/**
 * Which buckets a cycle must read at `now`: everything from `since` up to and including the current one.
 *
 * Past buckets are included because a sweep that did not run — a scaled-to-zero worker, a failed deploy, a
 * paused schedule — must not leave its buckets stranded. `lookbackBuckets` bounds how far back a first run
 * reaches, so a long outage costs a bounded number of list calls per cycle rather than one per day since the
 * epoch; anything older is the repair scan's job.
 */
export function dueBucketsAt(now: number, lookbackBuckets: number): number[] {
  if (!Number.isSafeInteger(lookbackBuckets) || lookbackBuckets < 0) {
    throw new ValidationError(
      `due index: lookbackBuckets must be a non-negative integer; got ${lookbackBuckets}`,
    );
  }
  const current = dueBucket(now);
  const buckets: number[] = [];
  for (let b = current - lookbackBuckets; b <= current; b++) buckets.push(b);
  return buckets;
}
