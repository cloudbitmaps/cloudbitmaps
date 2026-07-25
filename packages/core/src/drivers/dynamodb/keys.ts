/**
 * Logical-ref → DynamoDB key mapping for {@link DynamoDbWarmDriver} (Phase 4a).
 *
 * **Single-table design** (DECISIONS #15): every item is partitioned by segment (`PK`), and the sort key
 * (`SK`) prefix distinguishes entity types — `chunk#<key>` for warm chunk rows, `reg#…` for registry rows
 * (Phase 4b). Pure string logic, no SDK dependency, so it's unit-testable without DynamoDB-Local. Names are
 * re-validated at the boundary (defense in depth — S2); the absent namespace maps to `_default`, which can't
 * collide with a real namespace (the grammar forbids a leading underscore).
 */
import { ValidationError } from '@/core/errors';
import { validateChunkRef, validateSegmentRef } from '@/core/validate';
import type { ChunkRef, SegmentRef } from '@/core/ports';
import { namespacePart } from '../_shared/keys';

const CHUNK_SK_PREFIX = 'chunk#';
/** chunkKey ∈ [0, 65535] → zero-pad to 5 digits so SK lexicographic order == ascending chunkKey. */
const CHUNK_KEY_DIGITS = 5;

/**
 * Validate a caller-supplied `keyPrefix` so prefix-isolation is *structural*, not convention: it must not
 * contain the PK delimiters (`|`, `#`) — which would let one prefix's PK alias another's — or control
 * characters. Empty/undefined means no prefix.
 */
export function assertValidKeyPrefix(prefix: string | undefined): void {
  if (prefix === undefined || prefix === '') return;
  for (const ch of prefix) {
    const code = ch.charCodeAt(0);
    if (ch === '|' || ch === '#' || code < 0x20) {
      throw new ValidationError(`keyPrefix must not contain "|", "#", or control characters`);
    }
  }
}

/**
 * Partition key for all of a segment's items: `[<prefix>|]ns#<ns>|seg#<segment>`. An optional caller
 * `prefix` lets several logical stores share one physical table (and gives tests cheap isolation); it's
 * opaque (the PK is matched exactly, never parsed back), so no traversal concerns apply.
 */
export function partitionKey(ref: SegmentRef, prefix?: string): string {
  validateSegmentRef(ref);
  const base = `ns#${namespacePart(ref.namespace)}|seg#${ref.segment}`;
  return prefix === undefined || prefix === '' ? base : `${prefix}|${base}`;
}

/** Sort key for one chunk's warm row: `chunk#<zero-padded chunkKey>`. */
export function chunkSortKey(chunkKey: number): string {
  return `${CHUNK_SK_PREFIX}${String(chunkKey).padStart(CHUNK_KEY_DIGITS, '0')}`;
}

/** The `(PK, SK)` of one chunk's warm row, validating the full ref. */
export function chunkKeyPair(ref: ChunkRef, prefix?: string): { pk: string; sk: string } {
  validateChunkRef(ref);
  return { pk: partitionKey(ref, prefix), sk: chunkSortKey(ref.chunkKey) };
}

/** The `begins_with` prefix for querying a segment's chunk rows (excludes `reg#…` items). */
export function chunkSortKeyPrefix(): string {
  return CHUNK_SK_PREFIX;
}

/** Sort key of a segment's single registry row — co-located with its chunk rows (DECISIONS #15). */
const REGISTRY_SK = 'reg#';
export function registrySortKey(): string {
  return REGISTRY_SK;
}

/** The `(PK, SK)` of a segment's registry row, validating the ref. */
export function registryKeyPair(ref: SegmentRef, prefix?: string): { pk: string; sk: string } {
  validateSegmentRef(ref);
  return { pk: partitionKey(ref, prefix), sk: REGISTRY_SK };
}

/** Parse a chunkKey out of a `chunk#<n>` sort key, or `null` if it doesn't match (canonical 5-digit). */
export function parseChunkSortKey(sk: string): number | null {
  if (!sk.startsWith(CHUNK_SK_PREFIX)) return null;
  const middle = sk.slice(CHUNK_SK_PREFIX.length);
  // Exactly CHUNK_KEY_DIGITS digits — the canonical form the writer emits (so nothing else aliases it).
  if (!new RegExp(`^\\d{${CHUNK_KEY_DIGITS}}$`).test(middle)) return null;
  const chunkKey = Number(middle);
  return chunkKey <= 0xffff ? chunkKey : null;
}
