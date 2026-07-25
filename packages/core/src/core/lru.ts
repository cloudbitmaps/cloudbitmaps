/**
 * Bounded LRU cache with optional TTL — the HOT tier's memory ceiling (finding C6).
 *
 * Time comes from an injected `Clock` (never `Date.now()`) so the cache is deterministic
 * under simulation.
 *
 * The cache can be bounded by entry **count** (`maxEntries`, always) and, optionally, by an aggregate
 * **byte weight** (`maxBytes`). The byte bound exists for values whose footprint is large and uneven — the
 * cold reader cache, where one entry pins a fully-parsed `.crbm` index that can be ~6 MB for a wide segment
 * yet a few hundred bytes for a small one (gap #1: a count-only bound lets 1024 wide indices blow a Lambda's
 * memory even though the count is "in bounds"). Weights arrive **after** insertion (a cached reader is a
 * pending promise; its size is known only once it resolves), so weight is reported via {@link setWeight} and
 * eviction re-runs then.
 */
import type { Clock } from './determinism';
import { ValidationError } from './errors';

export interface LruOptions {
  /** Hard ceiling on entries; the least-recently-used is evicted past it. */
  readonly maxEntries: number;
  /**
   * Optional aggregate byte ceiling across all entries' reported weights (see {@link BoundedLru.setWeight}).
   * When set, the least-recently-used entries are evicted until the total is within budget — in addition to
   * the `maxEntries` bound. Omit for a pure count-bounded cache (weights stay 0, no byte eviction).
   */
  readonly maxBytes?: number;
  /** Optional time-to-live in ms; an entry older than this is treated as absent. */
  readonly ttlMs?: number;
  /** Only `now()` is used (never `sleep`), so a count-only cache can pass a minimal time source. */
  readonly clock: Pick<Clock, 'now'>;
}

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number; // Infinity when no TTL
  bytes: number; // reported weight (0 until setWeight); summed against maxBytes
}

export class BoundedLru<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number | undefined;
  private readonly ttlMs: number | undefined;
  private readonly clock: Pick<Clock, 'now'>;
  private totalBytes = 0;

  constructor(options: LruOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new ValidationError(`maxEntries must be a positive integer; got ${options.maxEntries}`);
    }
    if (
      options.maxBytes !== undefined &&
      (!(options.maxBytes > 0) || !Number.isFinite(options.maxBytes))
    ) {
      throw new ValidationError(
        `maxBytes must be a positive finite number; got ${options.maxBytes}`,
      );
    }
    if (options.ttlMs !== undefined && (!(options.ttlMs > 0) || !Number.isFinite(options.ttlMs))) {
      throw new ValidationError(`ttlMs must be a positive finite number; got ${options.ttlMs}`);
    }
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.ttlMs = options.ttlMs;
    this.clock = options.clock;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.drop(key, entry);
      return undefined;
    }
    // Refresh recency: re-insert so it becomes most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Read a value **without** counting as an access (recency unchanged, no purge on expiry). */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: K, value: V): void {
    const prev = this.map.get(key);
    if (prev !== undefined) this.totalBytes -= prev.bytes;
    this.map.delete(key);
    const expiresAt = this.ttlMs === undefined ? Infinity : this.clock.now() + this.ttlMs;
    this.map.set(key, { value, expiresAt, bytes: 0 });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.dropKey(oldest.value);
    }
    this.evictToBudget(key);
  }

  /**
   * Report an entry's byte weight (typically once a cached promise resolves and its size is known). Updates
   * the running total and evicts the least-recently-used entries if the aggregate now exceeds `maxBytes`.
   * Recency is **not** changed. The `key` being weighted is protected from this eviction pass (we just
   * populated it) — so a single entry larger than the whole budget is kept rather than immediately dropped.
   */
  setWeight(key: K, bytes: number): void {
    if (!(bytes >= 0) || !Number.isFinite(bytes)) {
      // Guard the running total against a NaN/negative weight, which no removal path could ever restore.
      throw new ValidationError(`weight must be a non-negative finite number; got ${bytes}`);
    }
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.totalBytes += bytes - entry.bytes;
    entry.bytes = bytes;
    this.evictToBudget(key);
  }

  private evictToBudget(protectKey: K): void {
    if (this.maxBytes === undefined) return;
    while (this.totalBytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.oldestExcept(protectKey);
      if (oldest === undefined) break; // only the protected key remains
      this.dropKey(oldest);
    }
  }

  /** The least-recently-used key that is not `protectKey`, or undefined if none other exists. */
  private oldestExcept(protectKey: K): K | undefined {
    for (const key of this.map.keys()) {
      if (key !== protectKey) return key;
    }
    return undefined;
  }

  private dropKey(key: K): void {
    const entry = this.map.get(key);
    if (entry !== undefined) this.drop(key, entry);
  }

  private drop(key: K, entry: Entry<V>): void {
    this.totalBytes -= entry.bytes;
    this.map.delete(key);
  }

  /** Membership test that does NOT count as an access (recency is unchanged). Purges if expired. */
  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (entry.expiresAt <= this.clock.now()) {
      this.drop(key, entry);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    this.drop(key, entry);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  /** Current entry count (may include not-yet-evicted expired entries). */
  get size(): number {
    return this.map.size;
  }

  /** Current aggregate reported weight (bytes) across all entries. */
  get weightBytes(): number {
    return this.totalBytes;
  }
}
