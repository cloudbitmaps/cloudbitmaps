/**
 * Boundary validation for segment / namespace names.
 *
 * **A name is any non-empty string.** There is no character allowlist, because an allowlist rejects names for
 * the storage layer's convenience — and the storage layer's convenience is this library's problem, not the
 * caller's. Every physical boundary escapes what *it* cannot take literally (`core/name-codec.ts`),
 * so `dedup:2026-08-01`, `user@example.com`, `orders/2026`, `日本語` and `100%` are all ordinary names.
 *
 * A grammar would fail in both directions. It would reject names that are merely unfamiliar, and it would pass
 * names that are genuinely broken — `con`, `nul` and `com1` are Windows device names made only of letters and
 * digits, so `store.segment('con')` would validate cleanly and fail only on a user's machine. Encoding handles
 * both: it accepts what is merely unfamiliar, and defuses what is actually dangerous.
 *
 * What remains is **size** and **representability**, both real constraints rather than tastes.
 *
 * Size: S3 caps an object key at 1024 bytes and a name is only one part of it. The cap is applied to the
 * **encoded** length — and to the longer of the two encodings, since a path escapes `:` three-for-one where a
 * key leaves it literal — because a limit measured on the input would let a key exceed the backend's.
 *
 * Representability: a name must be well-formed UTF-16, because an unpaired surrogate has no UTF-8 encoding at
 * all. Letting one through would not merely store oddly; every lone surrogate encodes to the same replacement
 * bytes, so four distinct names would claim one key.
 */
import { ValidationError } from './errors';
import { encodeNameForKey, encodeNameForPath } from './name-codec';
import type { ChunkRef, SegmentRef } from './ports';

const CHUNK_KEY_MAX = 0xffff;

/**
 * The most an encoded name may occupy in a physical key.
 *
 * S3's limit is 1024 bytes for the WHOLE key, which also carries the caller's prefix, the namespace, a fixed
 * infix (`/segments/`) and the `.<generation>.crbm` suffix. 256 leaves generous room for all of that with both
 * a namespace and a segment at the ceiling.
 */
export const MAX_NAME_LENGTH = 256;

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded by a high one.
 *
 * Deliberately NOT `/u` and not `String.prototype.isWellFormed()`: the flag would make the engine read
 * code points, which is the very distinction being tested, and the method needs an ES2024 lib target
 * this package does not set. Matching on code units is what sees a half of a pair.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether `value` is well-formed UTF-16: no unpaired surrogate, so it survives a round trip through UTF-8. */
export function isWellFormedString(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/**
 * How long a name is once storage has it — the longer of the two encodings.
 *
 * Exported because anything that composes a name out of other names (the due index does) has to measure it the
 * same way, and a second copy of that rule is how the two drifted apart before.
 */
export function encodedNameLength(value: string): number {
  return Math.max(encodeNameForKey(value).length, encodeNameForPath(value).length);
}

function validatePart(value: string, field: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string; got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
  // Cheap bound BEFORE encoding. Encoding never shrinks a string, so a name already over the cap in raw units
  // is over it encoded — and rejecting first means an attacker-supplied name cannot make us build a 60 MB
  // string to find out. (Measured: a 10-million-unit name cost 4.2 s of blocking CPU without this.)
  if (value.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `${field} is too long: ${value.length} characters (limit ${MAX_NAME_LENGTH} once encoded for a storage key)`,
    );
  }
  // A name has to survive the round trip to UTF-8 and back. An unpaired surrogate does not: `TextEncoder`
  // replaces it with U+FFFD, so every lone surrogate AND U+FFFD itself would encode to the same bytes — four
  // distinct names collapsing onto one key, which is the one property everything else here rests on. There is
  // no UTF-8 for a lone surrogate, so this is a limit of the medium rather than a rule we chose.
  if (LONE_SURROGATE.test(value)) {
    throw new ValidationError(
      `${field} contains an unpaired surrogate, so it has no UTF-8 encoding and cannot be stored. This is ` +
        `usually a string sliced through an astral character (an emoji, say) — slice by code point instead.`,
    );
  }
  // Measured on the ENCODED form, because that is what a bucket has to hold — and on the LONGER of the two
  // encodings. A path escapes `:` three-for-one where a key leaves it literal, so measuring the key form alone
  // let `'a' + ':'.repeat(255)` pass the boundary and then fail inside the driver with a raw ENAMETOOLONG
  // rather than a typed error at the edge.
  const encoded = encodedNameLength(value);
  if (encoded > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `${field} is too long: ${encoded} characters once encoded for storage (limit ${MAX_NAME_LENGTH}). The name ` +
        `itself is ${value.length} characters — encoding expands anything outside [A-Za-z0-9._-], so a name of ` +
        `mostly non-ASCII text, or one full of colons, reaches the limit sooner than its length suggests.`,
    );
  }
}

export function validateSegmentRef(ref: SegmentRef): void {
  validatePart(ref.segment, 'segment');
  if (ref.namespace !== undefined) validatePart(ref.namespace, 'namespace');
}

/**
 * The namespace prefix the library keeps for its own bookkeeping: the due index stores one pointer row per
 * expiring segment in `cbm.due.<bucket>` (see `due-index.ts`). **One constant, read by both sides** — the
 * application-facing checks below refuse it in a name an application passes in, and the due index writes and
 * recognises its rows by it — so the two cannot drift.
 *
 * Only this exact prefix is reserved, not `cbm.` as a whole: `cbm.dueX`, `cbm.due` and `cbmdue.eu` are ordinary
 * namespaces. Every fleet-wide enumeration skips the rows of a reserved namespace as bookkeeping, so a segment
 * there would be invisible to an erasure, a consistency check, an export and a retention sweep.
 *
 * Internal: not exported from any entry. The flavor keeps a copy for its own facade checks, and a test pins the
 * two together.
 */
export const RESERVED_NAMESPACE_PREFIX = 'cbm.due.';

/** Does this namespace start with {@link RESERVED_NAMESPACE_PREFIX}? `undefined` (no namespace) never does. */
export function isReservedNamespace(namespace: string | undefined): boolean {
  return namespace !== undefined && namespace.startsWith(RESERVED_NAMESPACE_PREFIX);
}

/**
 * Validate a namespace an application names, as a segment ref's namespace or as a `namespace` option that scopes
 * a scan: the name rules, and **not** in the reserved namespace. Internal; the public `validateSegmentRef` of
 * `@cloudbitmaps/core/driver-kit` is the name rules only, which is what a driver needs, since the due index's own
 * rows live in the reserved namespace and go through the drivers.
 */
export function validateUserNamespace(namespace: string): void {
  validatePart(namespace, 'namespace');
  if (isReservedNamespace(namespace)) {
    throw new ValidationError(
      `namespace "${namespace}" is reserved: names starting with "${RESERVED_NAMESPACE_PREFIX}" hold the ` +
        `library's own bookkeeping rows, which every fleet-wide scan skips, so a segment there would be ` +
        `invisible to an erasure, a consistency check, an export and a retention sweep. Choose another namespace.`,
    );
  }
}

/** Validate a segment ref an application hands in: the name rules, and a namespace outside the reserved prefix. */
export function validateUserRef(ref: SegmentRef): void {
  validatePart(ref.segment, 'segment');
  if (ref.namespace !== undefined) validateUserNamespace(ref.namespace);
}

/** Validate a chunk ref: the segment/namespace rules plus `chunkKey` ∈ `[0, 65535]` (a u16). A driver-boundary check. */
export function validateChunkRef(ref: ChunkRef): void {
  validateSegmentRef(ref);
  if (!Number.isInteger(ref.chunkKey) || ref.chunkKey < 0 || ref.chunkKey > CHUNK_KEY_MAX) {
    throw new ValidationError(
      `chunkKey must be an integer in [0, ${CHUNK_KEY_MAX}]; got ${ref.chunkKey}`,
    );
  }
}
