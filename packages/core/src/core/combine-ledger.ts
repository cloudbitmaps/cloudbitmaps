/**
 * The resident-bytes ledger of a batch combine. Pure: no I/O, time or randomness.
 *
 * It counts what is **resident**, not what a bitmap serializes to: a native bitmap costs a fixed amount over its
 * serialized bytes, so a million small chunks hold far more than their serialized size says. Measured on the shipped
 * codec with one bitmap per chunk, the cost over serialized size was about 440 bytes for a chunk of up to 50 ids,
 * rising to about 1,700 bytes around 3,000 ids (an array container's spare capacity) and falling to about 300 bytes for
 * a bitset. {@link residentBytes} is a model that stays above every measured point.
 */

/** The fixed resident cost of one native bitmap beyond its serialized bytes, as measured. */
export const RESIDENT_BITMAP_OVERHEAD = 450;

/** The most one chunk's portable payload can be after run optimization: a bitset container and its header. */
const MAX_CHUNK_SERIALIZED = 8_208;

/** An upper bound on the serialized size of a chunk of `cardinality` ids: an array container, capped at a bitset. */
export function serializedBound(cardinality: number): number {
  return Math.min(2 * cardinality + 16, MAX_CHUNK_SERIALIZED);
}

/** The resident bytes of one bitmap whose serialized size is `serialized`: above every measured point. */
export function residentBytes(serialized: number): number {
  return Math.ceil(RESIDENT_BITMAP_OVERHEAD + Math.min(1.6 * serialized, serialized + 1_800));
}

/** The resident bytes of one chunk of at most `cardinality` ids. */
export function residentBound(cardinality: number): number {
  return residentBytes(serializedBound(cardinality));
}

/**
 * A byte budget with a high-water mark. Everything the pass keeps resident is charged to it and released when it is
 * let go, so `used` is the pass's own count of what it holds, and `maxBufferedBytes` is a bound on it.
 */
export class ResidentLedger {
  private held = 0;
  private peak = 0;

  constructor(readonly limit: number) {}

  get used(): number {
    return this.held;
  }

  get highWater(): number {
    return this.peak;
  }

  /** Bytes still free. */
  get room(): number {
    return this.limit - this.held;
  }

  /** Charge `bytes` if they fit. */
  tryCharge(bytes: number): boolean {
    if (this.held + bytes > this.limit) return false;
    this.held += bytes;
    if (this.held > this.peak) this.peak = this.held;
    return true;
  }

  /**
   * Charge `bytes`, asking `makeRoom` to free some while they do not fit. `makeRoom` releases what it frees (through
   * {@link release}) and answers whether it freed anything; the charge is refused when it cannot.
   */
  reserve(bytes: number, makeRoom: () => boolean): boolean {
    while (!this.tryCharge(bytes)) if (!makeRoom()) return false;
    return true;
  }

  release(bytes: number): void {
    this.held -= bytes;
  }
}
