/**
 * The resident-bytes ledger of a batch combine. Pure: no I/O, time or randomness.
 *
 * It counts what is **resident**, not what a bitmap serializes to: a bitmap costs a fixed amount over its
 * serialized bytes, so a million small chunks hold far more than their serialized size says. Measured on the store's
 * codec, the TypeScript Roaring codec, as the live JS heap plus external memory after a forced collection, with one
 * bitmap per chunk, the cost over serialized size was about 450 bytes for a bitmap decoded from its stored bytes and
 * 670 to 800 for one built by adds, for a chunk of up to 1,000 ids; for a chunk of 3,000 ids built by adds (an array
 * container's spare capacity) the whole bitmap held about 8,900 bytes, and a bitset about 8,650 decoded and 8,900
 * built. {@link residentBytes} is a model that stays above every measured point.
 */

/**
 * The fixed resident cost of one bitmap beyond its serialized bytes. Measured on the TypeScript codec over 50,000
 * bitmaps of one chunk each (live heap plus external memory after a forced collection, macOS arm64, Node 24), it was
 * 435 to 452 bytes for a bitmap decoded from stored bytes and 674 to 803 for one built by adds, at every cardinality
 * from 1 to 20,000; the constant is the highest of those rounded up to a multiple of 64. The resident-set growth of
 * the same process was larger (1,600 to 4,500 bytes a bitmap), because the collector keeps freed pages: that is the
 * allocator's slack, which the ledger does not count and the process-memory guidance in the loading guide covers.
 */
export const RESIDENT_BITMAP_OVERHEAD = 832;

/** The most one chunk's portable payload can be after run optimization: a bitset container and its header. */
const MAX_CHUNK_SERIALIZED = 8_208;

/** An upper bound on the serialized size of a chunk of `cardinality` ids: an array container, capped at a bitset. */
export function serializedBound(cardinality: number): number {
  return Math.min(2 * cardinality + 16, MAX_CHUNK_SERIALIZED);
}

/**
 * The most the data of one chunk's bitmap holds resident: an array container stops at 4,096 values and becomes a bitset
 * of 8,192 bytes, so past that its spare capacity cannot grow. Measured at 8,643 (decoded) to 8,882 (built by adds) bytes with the overhead,
 * for every chunk of 4,096 values or more.
 */
const MAX_RESIDENT_DATA = 8_800;

/** The resident bytes of one bitmap whose serialized size is `serialized`: above every measured point. */
export function residentBytes(serialized: number): number {
  return Math.ceil(
    RESIDENT_BITMAP_OVERHEAD + Math.min(1.6 * serialized, serialized + 2_200, MAX_RESIDENT_DATA),
  );
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
   * Charge `bytes`, asking `makeRoom` to free some while they do not fit. `makeRoom` is told how many bytes are wanted,
   * releases what it frees (through {@link release}) and answers whether it freed anything; the charge is refused when
   * it cannot.
   */
  reserve(bytes: number, makeRoom: (needed: number) => boolean): boolean {
    while (!this.tryCharge(bytes)) if (!makeRoom(bytes)) return false;
    return true;
  }

  release(bytes: number): void {
    this.held -= bytes;
  }
}
