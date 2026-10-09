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
 * which it reads back to verify. A refusal here comes from a read, and in an erasure the reads that can be refused
 * come before the deletes.
 */
import type { GenKey, IStorageDriver, SegmentRef, StorageDeleteOptions } from '@cloudbitmaps/core';

export class OpenChargingStorage implements IStorageDriver {
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

  /** One `getTail` is one open: a reader takes the footer and the index from it, and reads chunks with `getRange`. */
  async getTail(key: GenKey, maxBytes: number): ReturnType<IStorageDriver['getTail']> {
    if (!this.free.has(key.generation)) this.charge();
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
