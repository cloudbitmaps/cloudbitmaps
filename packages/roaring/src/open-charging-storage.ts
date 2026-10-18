/**
 * A storage driver that charges every **generation open** to a per-op budget, for `eraseSubject`.
 *
 * The budget counts fan-out in units of one backend read. `eraseSubject`'s scan charges one unit per registered
 * segment, but a segment whose current generation lacks the id is searched anyway: every other generation in its
 * bucket is opened, one tail read each, and with the keep-everything default of the `*Into` verbs that is one per
 * generation the segment ever had. Those opens are the work the scan's own count leaves out. They are counted here,
 * at the storage port where they happen, so an open added to the erasure later is charged without anyone
 * remembering to charge it, and no option of the public erasure call had to grow.
 *
 * Two opens are never charged, because the segment's unit already pays for them: the generation the row named when
 * the scan listed it, which every erasure must read to decide membership, and an object this call wrote itself,
 * which it reads back to verify. Every other generation is charged once, at its first open: a later open of the same
 * number in the same call is paid for by that unit. The look for a holder left once the call has deleted opens again
 * each generation it found clean, and an object whose open failed has its footer read on its own; neither costs a unit
 * more. A refusal here comes from a read. Most of an erasure's reads that can be refused come before its deletes; two
 * kinds come after one: the look for a holder left, when it opens a generation the call never opened before, and the
 * zero-byte read of a generation the call deleted that the row then names. A refusal of either is thrown in place of
 * the call's answer, so the call reports the budget, not what it deleted.
 */
import type {
  GenKey,
  IStorageDriver,
  SegmentRef,
  StorageDeleteOptions,
} from '@cloudbitmaps/core/driver-kit';

export class OpenChargingStorage implements IStorageDriver {
  /** Generations an open of costs nothing more: the scan's current one, this call's writes, and each one charged. */
  private readonly free = new Set<number>();

  /**
   * @param inner   the driver the erasure would otherwise use
   * @param current the generation the segment's row named when it was listed, or `null` when it named none
   * @param charge  called once per charged open; it throws to refuse
   */
  constructor(
    private readonly inner: IStorageDriver,
    current: number | null,
    private readonly charge: () => void,
  ) {
    if (current !== null) this.free.add(current);
  }

  capabilities(): ReturnType<IStorageDriver['capabilities']> {
    return this.inner.capabilities();
  }

  async putImmutable(
    key: GenKey,
    write: Parameters<IStorageDriver['putImmutable']>[1],
  ): ReturnType<IStorageDriver['putImmutable']> {
    const written = await this.inner.putImmutable(key, write);
    this.free.add(key.generation);
    return written;
  }

  getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    return this.inner.getRange(key, offset, length);
  }

  /**
   * One `getTail` is one open: a reader takes the footer and the index from it, and reads chunks with `getRange`. A
   * generation is charged at its first open only.
   */
  async getTail(key: GenKey, maxBytes: number): ReturnType<IStorageDriver['getTail']> {
    if (!this.free.has(key.generation)) {
      this.charge();
      this.free.add(key.generation);
    }
    return this.inner.getTail(key, maxBytes);
  }

  /** Handed through whole: the erasure's delete of a holder is conditioned on the object it searched. */
  delete(key: GenKey, options?: StorageDeleteOptions): Promise<void> {
    return this.inner.delete(key, options);
  }

  list(ref: SegmentRef): AsyncIterable<GenKey> {
    return this.inner.list(ref);
  }
}
