/**
 * What the engines reading through one chunk cache share about invalidations: how many there have been, the segment
 * each of the latest was of, and the chunk reads open right now. A store's own engine, each pin's and each combine's
 * with a pinned operand read through one cache, and an invalidation through any of them must reach a read running on
 * another: a read that had its bytes before the invalidation would otherwise write them back into the cache it
 * shares, and later reads would be answered from them, an erased id included, until the cache evicted them.
 *
 * ```
 *  engine (store) ──┐
 *  engine (pin)   ──┼── one InvalidationScope ── epoch · latest invalidation of each segment · open reads
 *  engine (combine)─┘        └── one chunk cache
 * ```
 *
 * A stream records the epoch it opened at and asks {@link InvalidationScope.invalidatedSince} before it caches a chunk,
 * so the scope holds no reference to a stream: a read its caller drops without closing holds nothing here.
 *
 * Internal to core: not exported from any entry point.
 */
import type { CodecBitmap } from './codec';

/**
 * How many segments' latest invalidation a scope remembers. Past it the oldest is forgotten, and a segment the scope
 * does not remember counts as invalidated at the newest invalidation it has forgotten: a stream that opened before then
 * caches no more of that segment's chunks, which costs it cache entries, never correctness. With names at their
 * 256-character limit that is about 0.6 MB, and about 0.1 MB with 30-character names.
 */
export const REMEMBERED_INVALIDATIONS = 1024;

/** A chunk read in flight: `token` tells the read whether its entry is still the registered one. */
export interface OpenRead {
  readonly token: object;
  readonly read: Promise<CodecBitmap | null>;
}

export class InvalidationScope {
  /**
   * The chunk reads open right now, by cache key: a caller that misses the cache and finds its key here awaits that
   * read instead of making its own. An entry lives from the request until it settles, so the map holds at most one
   * promise per distinct key in flight. An invalidation drops the segment's entries, and a read whose entry is gone
   * caches nothing.
   */
  readonly openReads = new Map<string, OpenRead>();
  private count = 0;
  /** The epoch of each remembered segment's latest invalidation, by cache-key prefix, the oldest first. */
  private readonly latest = new Map<string, number>();
  /** The epoch of the newest invalidation the scope has forgotten: what a segment it does not remember counts as. */
  private floor = 0;

  /** How many invalidations there have been: a read compares it with the epoch it began under. */
  get epoch(): number {
    return this.count;
  }

  /** Record an invalidation of the segment whose cache keys start with `prefix`, and drop its open reads. */
  invalidate(prefix: string): void {
    this.count += 1;
    // Deleted first, so the map stays in the order of each segment's latest invalidation.
    this.latest.delete(prefix);
    this.latest.set(prefix, this.count);
    if (this.latest.size > REMEMBERED_INVALIDATIONS) {
      const [oldest, at] = this.latest.entries().next().value!;
      this.latest.delete(oldest);
      this.floor = at;
    }
    // A read already open was asked for before this call, so a caller after it must not join it.
    for (const key of this.openReads.keys()) if (key.startsWith(prefix)) this.openReads.delete(key);
  }

  /** Whether the segment whose cache keys start with `prefix` has been invalidated since epoch `since`. */
  invalidatedSince(prefix: string, since: number): boolean {
    return since < this.count && (this.latest.get(prefix) ?? this.floor) > since;
  }
}
