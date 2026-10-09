/**
 * Canonical key encoding for a segment / chunk — one source of truth, used by both the storage
 * drivers and the cache (DRY). The encoding is collision-proof and injection-proof.
 *
 * **The name parts are encoded, and that is what makes the delimiters safe.** A name is any non-empty string,
 * so it may contain a space or a `/`, and with the parts left literal two distinct segments could produce one
 * key:
 *
 * ```
 * segmentKey({ segment: 's' })                     → "/ s"
 * segmentKey({ namespace: '/', segment: 's' })     → "/ s"    ← the same key
 * segmentKey({ namespace: 'a', segment: 'b c' })   → "a b c"
 * segmentKey({ namespace: 'a b', segment: 'c' })   → "a b c"  ← the same key
 * ```
 *
 * These keys reach the reader LRU and the decoded-chunk cache, so a collision is one segment serving
 * another's data on the read path, on every backend — invariant 3, and a tenant-isolation break.
 *
 * `encodeNameForKey` escapes both delimiters (`/` → `%2F`, space → `%20`) along with control characters, so
 * neither can be injected across a field — a property of the encoding, not of what a caller chooses to name
 * things. The absent-namespace sentinel keeps the same ours-vs-theirs asymmetry the
 * storage keys use: it is emitted literally while a caller's namespace is encoded, so a namespace actually
 * named `/` encodes to `%2F` and cannot impersonate it.
 *
 * These keys are in-memory and driver-internal; nothing on disk is named by them.
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

/**
 * How many segments' encoded keys a {@link KeptSegmentKeys} holds before it empties: the reader cache's default
 * segment count, a working set a long-lived reader keeps open. With 30-character names that is about 150 KB.
 */
export const KEPT_SEGMENT_KEYS = 1024;

/**
 * Segments' encoded keys ({@link segmentKey}, or {@link segmentPrefix}: whichever `encode` gives), kept so a read that
 * looks up chunk after chunk compares names rather than encoding them again, which costs about a third of a warm
 * `has()`. Held by namespace and then by segment, so segments of one name in several namespaces sit side by side, and
 * no number of segments read in turn makes every lookup encode again. Bounded: at `max` entries it empties and fills
 * again. An encoding is the names' and nothing else, so a kept one is the one an encoding would give now.
 */
export class KeptSegmentKeys {
  private readonly byNamespace = new Map<string | undefined, Map<string, string>>();
  private kept = 0;

  constructor(
    private readonly encode: (ref: SegmentRef) => string,
    private readonly max: number = KEPT_SEGMENT_KEYS,
  ) {}

  /** The segment's encoded key. */
  of(ref: SegmentRef): string {
    let names = this.byNamespace.get(ref.namespace);
    const found = names?.get(ref.segment);
    if (found !== undefined) return found;
    const encoded = this.encode(ref);
    if (this.kept >= this.max) {
      this.byNamespace.clear();
      this.kept = 0;
      names = undefined;
    }
    if (names === undefined) {
      names = new Map();
      this.byNamespace.set(ref.namespace, names);
    }
    names.set(ref.segment, encoded);
    this.kept += 1;
    return encoded;
  }

  /** How many encoded keys are kept. */
  get size(): number {
    return this.kept;
  }
}

export function chunkRefKey(ref: ChunkRef): string {
  return chunkKeyUnder(segmentPrefix(ref), ref.chunkKey);
}

/**
 * {@link chunkRefKey}, or {@link chunkGenKey} with a `version`, from the segment's {@link segmentPrefix} already
 * encoded: for a caller that looks up many chunks of a few segments and keeps their prefixes.
 */
export function chunkKeyUnder(prefix: string, chunkKey: number, version?: string | number): string {
  return version === undefined ? `${prefix}${chunkKey}` : `${prefix}${chunkKey}${FIELD}${version}`;
}

/**
 * Cache key for a chunk scoped to a specific **version** of the segment — {@link chunkRefKey} plus that
 * version (space-delimited, injection-proof exactly as above — the name parts are already encoded). A publish bumps the version, so it naturally
 * misses the cache instead of serving a stale superseded chunk, and the superseded entries age out under the
 * LRU ceiling (no active purge needed).
 *
 * `version` is whatever the Storage source reports as identifying the bytes a read will see — its
 * `currentVersion` where it has one, otherwise the bare generation number. **A generation number alone is not
 * an identity**: a load's generation number restarts at 0 once a registry row is purged and the bucket emptied, so a
 * retired-and-re-created name serves different data at the same `currentGen`, and a key built on the number
 * hands the new incarnation the old one's decoded chunks.
 */
export function chunkGenKey(ref: ChunkRef, version: string | number): string {
  return chunkKeyUnder(segmentPrefix(ref), ref.chunkKey, version);
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
