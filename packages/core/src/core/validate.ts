/**
 * Boundary validation for segment / namespace names.
 * Names become object keys, partition keys, and file paths — so they're validated before they
 * ever reach storage: strict charset, bounded length, no path traversal.
 */
import { ValidationError } from './errors';
import type { ChunkRef, SegmentRef } from './ports';

const CHUNK_KEY_MAX = 0xffff;

// The name grammar: 1 leading alphanumeric + up to 255 more (max 256 chars).
//
// `:` is legal after the first character because that is how everyone already names keys — `dedup:2026-08-01`,
// `sent:daily:<day>` — and banning it made a Redis user's first line throw. It is legal in an S3/GCS/Azure
// object key and in a DynamoDB partition key, so no cloud driver cares. The **filesystem** does: on Windows a
// colon opens an NTFS alternate data stream, so `LocalFsDriver` percent-encodes it on the way to a path
// (`drivers/localfs/paths.ts`). `%` stays out of the grammar precisely so that encoding is unambiguous.
//
// Still barred from position 1: a leading `:` reads as an empty family, and a leading `_` is reserved for the
// `_default` namespace sentinel.
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function validatePart(value: string, field: string): void {
  if (typeof value !== 'string' || !NAME.test(value) || value.includes('..')) {
    throw new ValidationError(
      `${field} must match ${String(NAME)} and contain no "..": got ${JSON.stringify(value)}`,
    );
  }
}

export function validateSegmentRef(ref: SegmentRef): void {
  validatePart(ref.segment, 'segment');
  if (ref.namespace !== undefined) validatePart(ref.namespace, 'namespace');
}

/** Validate a chunk ref: the segment/namespace grammar plus `chunkKey` ∈ `[0, 65535]` (a u16). */
export function validateChunkRef(ref: ChunkRef): void {
  validateSegmentRef(ref);
  if (!Number.isInteger(ref.chunkKey) || ref.chunkKey < 0 || ref.chunkKey > CHUNK_KEY_MAX) {
    throw new ValidationError(
      `chunkKey must be an integer in [0, ${CHUNK_KEY_MAX}]; got ${ref.chunkKey}`,
    );
  }
}
