/**
 * Canonical key encoding for a segment / chunk — one source of truth, used by both the storage
 * drivers and the HOT cache (DRY). The encoding is collision-proof and injection-proof:
 *
 * - The field delimiter (a space) and the "no namespace" sentinel (`/`) are characters the name
 *   grammar forbids in a namespace/segment — so they can never appear inside
 *   a name, can't be injected across the delimiter, and the absent-namespace case (`undefined`) is
 *   encoded distinctly from any real namespace (an empty string is rejected by the grammar anyway).
 */
import type { ChunkRef, SegmentRef } from './ports';

const FIELD = ' ';
const NO_NAMESPACE = '/';

export function segmentKey(ref: SegmentRef): string {
  return `${ref.namespace ?? NO_NAMESPACE}${FIELD}${ref.segment}`;
}

export function segmentPrefix(ref: SegmentRef): string {
  return `${segmentKey(ref)}${FIELD}`;
}

export function chunkRefKey(ref: ChunkRef): string {
  return `${segmentPrefix(ref)}${ref.chunkKey}`;
}

/**
 * HOT-cache key for a chunk scoped to a specific **version** of the segment — {@link chunkRefKey} plus that
 * version (space-delimited, injection-proof exactly as above). A publish bumps the version, so it naturally
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
