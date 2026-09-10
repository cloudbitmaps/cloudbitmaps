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
 * HOT-cache key for a chunk scoped to a specific Cold **generation** — {@link chunkRefKey} plus the generation
 * (space-delimited, injection-proof exactly as above). Keying the decoded-chunk cache by generation means a
 * generation bump (a load's publish) naturally misses the cache instead of serving a stale superseded chunk; the
 * superseded-generation entries age out under the LRU ceiling (no active purge needed).
 */
export function chunkGenKey(ref: ChunkRef, generation: number): string {
  return `${chunkRefKey(ref)}${FIELD}${generation}`;
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
