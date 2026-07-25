/**
 * Boundary validation for segment / namespace names (finding S2).
 * Names become object keys, partition keys, and file paths — so they're validated before they
 * ever reach storage: strict charset, bounded length, no path traversal.
 */
import { ValidationError } from './errors';
import type { ChunkRef, SegmentRef } from './ports';

const CHUNK_KEY_MAX = 0xffff;

// The locked name grammar: 1 leading alphanumeric + up to 255 more (max 256 chars).
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

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
