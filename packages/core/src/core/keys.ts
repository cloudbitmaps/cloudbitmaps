/**
 * Canonical key encoding for a segment / chunk — one source of truth, used by both the storage
 * drivers and the HOT cache (DRY). The encoding is collision-proof and injection-proof.
 *
 * **The name parts are encoded, and that is what makes the delimiters safe.** This module used to rest on the
 * name grammar instead: a space and `/` were characters a name could not contain, so neither could be injected
 * across a field. When the grammar was deleted — a name is any non-empty string now — that argument silently
 * became false, and two distinct segments could produce one key:
 *
 * ```
 * segmentKey({ segment: 's' })                     → "/ s"
 * segmentKey({ namespace: '/', segment: 's' })     → "/ s"    ← the same key
 * segmentKey({ namespace: 'a', segment: 'b c' })   → "a b c"
 * segmentKey({ namespace: 'a b', segment: 'c' })   → "a b c"  ← the same key
 * ```
 *
 * These keys reach the reader LRU and the decoded-chunk HOT cache, so a collision is one segment serving
 * another's data on the read path, on every backend — invariant 3, and a tenant-isolation break.
 *
 * `encodeNameForKey` escapes both delimiters (`/` → `%2F`, space → `%20`) along with control characters, so
 * the original argument holds again — but now as a property of the encoding rather than of a grammar that can
 * be relaxed out from under it. The absent-namespace sentinel keeps the same ours-vs-theirs asymmetry the
 * storage keys use: it is emitted literally while a caller's namespace is encoded, so a namespace actually
 * named `/` encodes to `%2F` and cannot impersonate it.
 *
 * These keys are in-memory and driver-internal, so encoding them moves nothing on disk.
 */
import { encodeNameForKey } from './name-codec';
import type { ChunkRef, SegmentRef } from './ports';

const FIELD = ' ';
const NO_NAMESPACE = '/';

export function segmentKey(ref: SegmentRef): string {
  const ns = ref.namespace === undefined ? NO_NAMESPACE : encodeNameForKey(ref.namespace);
  return `${ns}${FIELD}${encodeNameForKey(ref.segment)}`;
}

export function segmentPrefix(ref: SegmentRef): string {
  return `${segmentKey(ref)}${FIELD}`;
}

export function chunkRefKey(ref: ChunkRef): string {
  return `${segmentPrefix(ref)}${ref.chunkKey}`;
}

/**
 * HOT-cache key for a chunk scoped to a specific **version** of the segment — {@link chunkRefKey} plus that
 * version (space-delimited, injection-proof exactly as above — the name parts are already encoded). A publish bumps the version, so it naturally
 * misses the cache instead of serving a stale superseded chunk, and the superseded entries age out under the
 * LRU ceiling (no active purge needed).
 *
 * `version` is whatever the Cold source reports as identifying the bytes a read will see — its
 * `currentVersion` where it has one, otherwise the bare generation number. **A generation number alone is not
 * an identity**: `nextGeneration` restarts at 0 once a registry row is purged and the bucket emptied, so a
 * retired-and-re-created name serves different data at the same `currentGen`, and a key built on the number
 * hands the new incarnation the old one's decoded chunks.
 */
export function chunkGenKey(ref: ChunkRef, version: string | number): string {
  return `${chunkRefKey(ref)}${FIELD}${version}`;
}

/**
 * Deterministic FNV-1a shard assignment for a segment key — dependency-free, stable across workers and
 * restarts. One definition, so every sharded fleet operation (today the retention sweep) agrees on it exactly:
 * two definitions that disagreed would make the union across workers neither disjoint nor complete.
 */
export function shardOf(key: string, totalShards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  return (h >>> 0) % totalShards;
}
