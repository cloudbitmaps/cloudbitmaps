/**
 * Boundary validation for segment / namespace names.
 *
 * **A name is any non-empty string.** There is no character allowlist, because an allowlist rejects names for
 * the storage layer's convenience — and the storage layer's convenience is this library's problem, not the
 * caller's. Every physical boundary escapes what *it* cannot take literally (`core/name-codec.ts`),
 * so `dedup:2026-08-01`, `user@example.com`, `orders/2026`, `日本語` and `100%` are all ordinary names.
 *
 * That replaced a grammar which had banned the colon *by accident rather than by decision*: every dated-bucket
 * example the retention docs published threw, because prose in a fenced block is not run by anything. The
 * grammar also **permitted** names that were genuinely broken — `con`, `nul` and `com1` are Windows device
 * names, and `store.segment('con')` validated cleanly here and failed only on a user's machine. Encoding
 * handles both directions: it stops rejecting what is merely unfamiliar, and starts defusing what is actually
 * dangerous.
 *
 * What remains is **size**, and it is a real constraint rather than a taste: S3 caps an object key at 1024
 * bytes, and a segment's name is only one part of that key. The cap is therefore applied to the **encoded**
 * length — what storage actually stores — because encoding expands (`🎉` is one character and twelve bytes),
 * and a limit measured on the input would silently let a key exceed the backend's.
 */
import { ValidationError } from './errors';
import { encodeNameForKey } from './name-codec';
import type { ChunkRef, SegmentRef } from './ports';

const CHUNK_KEY_MAX = 0xffff;

/**
 * The most an encoded name may occupy in a physical key.
 *
 * S3's limit is 1024 bytes for the WHOLE key, which also carries the caller's prefix, the namespace, a fixed
 * infix (`/segments/`) and the `.<generation>.crbm` suffix. 256 leaves generous room for all of that with both
 * a namespace and a segment at the ceiling, and matches the limit the previous grammar advertised, so no name
 * that was legal before becomes illegal now.
 */
const MAX_ENCODED = 256;

function validatePart(value: string, field: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string; got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
  // Measured on the ENCODED form, because that is what a bucket has to hold. Reported with both numbers: a
  // name of 200 emoji is well under any character limit anyone would guess and far over the real one.
  const encoded = encodeNameForKey(value);
  if (encoded.length > MAX_ENCODED) {
    throw new ValidationError(
      `${field} is too long: ${encoded.length} characters once encoded for a storage key (limit ` +
        `${MAX_ENCODED}). The name itself is ${value.length} characters — encoding expands anything outside ` +
        `[A-Za-z0-9._:-], so a name of mostly non-ASCII text reaches the limit sooner than its length suggests.`,
    );
  }
}

export function validateSegmentRef(ref: SegmentRef): void {
  validatePart(ref.segment, 'segment');
  if (ref.namespace !== undefined) validatePart(ref.namespace, 'namespace');
}

/** Validate a chunk ref: the segment/namespace rules plus `chunkKey` ∈ `[0, 65535]` (a u16). */
export function validateChunkRef(ref: ChunkRef): void {
  validateSegmentRef(ref);
  if (!Number.isInteger(ref.chunkKey) || ref.chunkKey < 0 || ref.chunkKey > CHUNK_KEY_MAX) {
    throw new ValidationError(
      `chunkKey must be an integer in [0, ${CHUNK_KEY_MAX}]; got ${ref.chunkKey}`,
    );
  }
}
