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
 * A stream records the epoch it opened at and asks {@link InvalidationRecord.invalidatedSince} before it caches a
 * chunk, so the scope holds no reference to a stream: a read its caller drops without closing holds nothing here. The
 * `.crbm` source keeps an {@link InvalidationRecord} of its own, by segment, which a pinned stream asks before it hands
 * out a chunk, so only its own segment's invalidation makes it open its object again.
 *
 * Internal to core: not exported from any entry point.
 */
import type { CodecBitmap } from './codec';

/**
 * How many segments' latest invalidation a record remembers. Past it the oldest is forgotten, and a segment the record
 * does not remember, never-invalidated ones included, counts as invalidated at the newest invalidation it has
 * forgotten, which is always on the safe side. In the engines' scope it means a stream that opened before then caches
 * no more of that segment's chunks, which costs it cache entries, never correctness: so a sweep that invalidates more
 * than this many segments at once (a `retireExpired` or an `eraseSubject` over a large fleet) stops every stream open
 * at the time caching, whatever segment it reads. In the `.crbm` source it means a pinned stream looks its pin up
 * again, which costs a request only where the reader cache has let the pin's reader go. With names at their
 * 256-character limit a record is about 0.6 MB, and about 0.1 MB with 30-character names; a store keeps two.
 */
export const REMEMBERED_INVALIDATIONS = 1024;

/** A chunk read in flight: `token` tells the read whether its entry is still the registered one. */
export interface OpenRead {
  readonly token: object;
  readonly read: Promise<CodecBitmap | null>;
}

/**
 * How many invalidations there have been, and the epoch of each of the latest {@link REMEMBERED_INVALIDATIONS}
 * segments' latest one, by whatever key names a segment to its owner: a cache-key prefix in the engines' scope, a
 * segment key in the `.crbm` source.
 */
export class InvalidationRecord {
  private count = 0;
  /** The epoch of each remembered segment's latest invalidation, the oldest first. */
  private readonly latest = new Map<string, number>();
  /** The epoch of the newest invalidation the record has forgotten: what a segment it does not remember counts as. */
  private floor = 0;

  /** How many invalidations there have been: a read compares it with the epoch it began under. */
  get epoch(): number {
    return this.count;
  }

  /** Record an invalidation of the segment `key` names. */
  invalidate(key: string): void {
    this.count += 1;
    // Deleted first, so the map stays in the order of each segment's latest invalidation.
    this.latest.delete(key);
    this.latest.set(key, this.count);
    if (this.latest.size > REMEMBERED_INVALIDATIONS) {
      const [oldest, at] = this.latest.entries().next().value!;
      this.latest.delete(oldest);
      this.floor = at;
    }
  }

  /** Whether the segment `key` names has been invalidated since epoch `since`. */
  invalidatedSince(key: string, since: number): boolean {
    return since < this.count && (this.latest.get(key) ?? this.floor) > since;
  }
}

/** The engines' record, by cache-key prefix, and the chunk reads open on all of them. */
export class InvalidationScope extends InvalidationRecord {
  /**
   * The chunk reads open right now, by cache key: a caller that misses the cache and finds its key here awaits that
   * read instead of making its own. An entry lives from the request until it settles, so the map holds at most one
   * promise per distinct key in flight. An invalidation drops the segment's entries, and a read whose entry is gone
   * caches nothing.
   */
  private readonly openReads = new Map<string, OpenRead>();

  /** Record an invalidation of the segment whose cache keys start with `prefix`, and drop its open reads. */
  override invalidate(prefix: string): void {
    super.invalidate(prefix);
    // A read already open was asked for before this call, so a caller after it must not join it.
    for (const key of this.openReads.keys()) if (key.startsWith(prefix)) this.openReads.delete(key);
  }

  /** The read of `key` open now, for a caller that misses the cache to await instead of making its own. */
  openRead(key: string): Promise<CodecBitmap | null> | undefined {
    return this.openReads.get(key)?.read;
  }

  /** Register `entry` as the open read of `key`. */
  beginRead(key: string, entry: OpenRead): void {
    this.openReads.set(key, entry);
  }

  /** `entry` has settled: forget it, unless an invalidation dropped it and a newer read has taken the key. */
  endRead(key: string, entry: OpenRead): void {
    if (this.openReads.get(key) === entry) this.openReads.delete(key);
  }

  /** Whether the read `token` names is still the open read of `key`: one an invalidation dropped caches nothing. */
  isOpen(key: string, token: object): boolean {
    return this.openReads.get(key)?.token === token;
  }
}
