/**
 * Logical-ref → MongoDB document-id mapping for {@link MongoWarmDriver} (Phase 7).
 *
 * Pure, SDK-free string logic — unit-testable without a live MongoDB. Each chunk is one document with a
 * **deterministic composite `_id`** `<prefix>|<ns>|<seg>|<chunkKey>`, so create-if-absent is a plain
 * `insertOne` (a duplicate `_id` → the unique-index conflict, no extra index needed) and `get` is a direct
 * `_id` lookup. The ref fields are ALSO stored as separate typed fields (`kp`/`ns`/`seg`/`ck`) so `listChunks`
 * can query + **numerically** sort by `ck` (an `_id`-string sort would order `10` before `9`). The name grammar
 * (validateSegmentRef) forbids `|` in ns/seg and {@link normalizeKeyPrefix} forbids it in the prefix, so the
 * `|`-joined id is unambiguous.
 */
import { ValidationError } from '@/core/errors';
import { validateChunkRef, validateSegmentRef } from '@/core/validate';
import type { ChunkRef, SegmentRef } from '@/core/ports';
import { namespacePart } from '../_shared/keys';

/** The scope fields shared by every doc of a segment — the `listChunks` filter. */
export interface SegmentScope {
  kp: string;
  ns: string;
  seg: string;
}

/**
 * Validate a caller-supplied key prefix: no control characters and no `|` (the composite-`_id` delimiter), so
 * it can neither corrupt an id nor alias another prefix. Empty/undefined ⇒ no prefix (stored as `''`).
 */
export function normalizeKeyPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return '';
  for (const ch of prefix) {
    if (ch.charCodeAt(0) < 0x20 || ch === '|') {
      throw new ValidationError('keyPrefix must not contain "|" or control characters');
    }
  }
  return prefix;
}

/** The scope filter for all of a segment's chunk docs. Validates the ref. */
export function segmentScope(prefix: string, ref: SegmentRef): SegmentScope {
  validateSegmentRef(ref);
  return { kp: prefix, ns: namespacePart(ref.namespace), seg: ref.segment };
}

/** The deterministic `_id` of one chunk's doc: `<prefix>|<ns>|<seg>|<chunkKey>`. Validates the full ref. */
export function chunkDocId(prefix: string, ref: ChunkRef): string {
  validateChunkRef(ref);
  return `${prefix}|${namespacePart(ref.namespace)}|${ref.segment}|${ref.chunkKey}`;
}
