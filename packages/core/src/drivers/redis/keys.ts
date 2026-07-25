/**
 * Logical-ref → Redis key mapping for {@link RedisWarmDriver} (Phase 7).
 *
 * Pure, SDK-free string logic — unit-testable without a live Redis. Each chunk is one hash (`t` = token,
 * `b` = payload); each segment has one sorted-set index of its live chunk keys (Redis has no range scan, so
 * `listChunks` reads the index). Both keys for a segment share a **hash tag** `{<prefix>|<ns>|<seg>}` so they
 * always land in the same Redis Cluster slot — the OCC Lua script touches both atomically, which Cluster only
 * allows for same-slot keys. The name grammar (validateSegmentRef) forbids `|`/`{`/`}`/`:`/control chars in
 * ns/seg, and {@link normalizeRedisPrefix} forbids them in the prefix, so the tag can't be broken or aliased.
 */
import { ValidationError } from '@/core/errors';
import { validateChunkRef, validateSegmentRef } from '@/core/validate';
import type { ChunkRef, SegmentRef } from '@/core/ports';
import { namespacePart } from '../_shared/keys';

/**
 * Validate the caller-supplied key prefix: no control characters and none of the reserved key/tag delimiters
 * (`{`, `}`, `|`, `:`), so it can neither break out of the hash tag nor alias another prefix's keyspace.
 * Empty/undefined ⇒ no prefix.
 */
export function normalizeRedisPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return '';
  for (const ch of prefix) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || ch === '{' || ch === '}' || ch === '|' || ch === ':') {
      throw new ValidationError(
        `keyPrefix must not contain "{", "}", "|", ":", or control characters`,
      );
    }
  }
  return prefix;
}

/** The shared hash-tag body for a segment: `<prefix>|<ns>|<seg>` (all delimiter-free by grammar). */
function tag(prefix: string, ref: SegmentRef): string {
  return `${prefix}|${namespacePart(ref.namespace)}|${ref.segment}`;
}

/** The sorted-set index key holding a segment's live chunk keys (scored by chunkKey): `{tag}idx`. */
export function segmentIndexKey(prefix: string, ref: SegmentRef): string {
  validateSegmentRef(ref);
  return `{${tag(prefix, ref)}}idx`;
}

/** The hash key for one chunk's warm row (`t`/`b` fields): `{tag}c:<chunkKey>`. Validates the full ref. */
export function chunkHashKey(prefix: string, ref: ChunkRef): string {
  validateChunkRef(ref);
  return `{${tag(prefix, ref)}}c:${ref.chunkKey}`;
}

/** Parse a chunkKey out of a sorted-set index member (the canonical decimal the writer stored), or null. */
export function parseIndexMember(member: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(member)) return null;
  const chunkKey = Number(member);
  return Number.isInteger(chunkKey) && chunkKey >= 0 && chunkKey <= 0xffff ? chunkKey : null;
}
