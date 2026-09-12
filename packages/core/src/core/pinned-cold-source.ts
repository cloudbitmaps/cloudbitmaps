/**
 * A {@link ColdChunkSource} view that holds **one** segment at **one** generation, and passes everything else
 * through to the live source.
 *
 * A pin exists so a long job describes a single instant. An ordinary handle re-resolves on `coldGenTtlMs`, so a
 * publish part-way through an export, a send or a reconciliation means the second half of the job describes a
 * different instant than the first — and nothing in the result says so.
 *
 * **A pin is a generation NUMBER, not a captured reader.** The number is immutable, so the reader behind it can
 * live in the shared bounded LRU and be evicted freely: re-opening at the same number reproduces the same
 * bytes. Holding the reader instead put every live pin outside the library's memory ceiling.
 *
 * **Other segments are not pinned, and that is the contract, not an omission.** `snap.intersect([other])` reads
 * `snap` at its pinned generation and `other` at whatever is current. Pinning the whole query means pinning
 * each segment. The alternative shapes are both worse: refusing the combine outright makes a pin useless to the
 * export and reconciliation jobs it exists for, and silently pinning the operands would quietly change what
 * `other` means to a caller who did not ask.
 *
 * What this must never do is the inverse — read a pinned handle's segment **live** because the call was made
 * on some other handle. That is why the routing is by segment identity here rather than by which object the
 * caller happened to start from.
 */
import type { ChunkRef, ColdChunkSource, SegmentRef, SegmentSize } from './ports';
import type { CrbmColdChunkSource } from './crbm-cold-source';
import { segmentKey } from './keys';

/** What a pin holds for one segment: the generation, and the version identifying those exact bytes. */
export interface PinnedAt {
  readonly generation: number | null;
  readonly version: string | null;
}

export class PinnedColdChunkSource implements ColdChunkSource {
  constructor(
    private readonly inner: CrbmColdChunkSource,
    /**
     * The pinned segments, keyed by {@link segmentKey}. A **set** rather than one entry because a combine may
     * involve several pinned handles, and each must be read at its own pin — including when the call was made
     * on a different handle. Reading a pinned handle live because the caller started elsewhere is the silent
     * wrong answer this exists to prevent.
     */
    private readonly pins: ReadonlyMap<string, PinnedAt>,
  ) {}

  /**
   * The pin for this segment, or `undefined` if it is not pinned here.
   *
   * A pin whose `generation` is `null` is a segment that had none when it was pinned: that handle reads empty
   * for its lifetime, which is exactly what an unpinned read of it does. That is **not** the same as "this
   * source cannot pin" — a source that genuinely cannot is a capability gap and fails fast at `pin()`.
   */
  private pinFor(ref: SegmentRef): PinnedAt | undefined {
    return this.pins.get(segmentKey(ref));
  }

  getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.getChunk(ref);
    return pin.generation === null
      ? Promise.resolve(null)
      : this.inner.getChunkAt(ref, pin.generation);
  }

  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.listChunkKeys(ref);
    return pin.generation === null
      ? Promise.resolve([])
      : this.inner.listChunkKeysAt(ref, pin.generation);
  }

  sizeOf(ref: SegmentRef): Promise<SegmentSize | null> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.sizeOf(ref);
    return pin.generation === null
      ? Promise.resolve(null)
      : this.inner.sizeOfAt(ref, pin.generation);
  }

  cardinalities(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.cardinalities(ref);
    return pin.generation === null
      ? Promise.resolve(null)
      : this.inner.cardinalitiesAt(ref, pin.generation);
  }

  currentGeneration(ref: SegmentRef): Promise<number | null> {
    const pin = this.pinFor(ref);
    return pin === undefined ? this.inner.currentGeneration(ref) : Promise.resolve(pin.generation);
  }

  /**
   * A pinned segment reports the version captured when it was pinned, so its decoded chunks are cached under a
   * key that cannot collide with the live generation's. That is what lets a pinned handle share the store's
   * chunk cache safely; sharing it on a generation-only key was how a pinned read could resurrect an id that
   * `eraseIdFromSegment` had reported physically gone.
   */
  currentVersion(ref: SegmentRef): Promise<string | null> {
    const pin = this.pinFor(ref);
    return pin === undefined ? this.inner.currentVersion(ref) : Promise.resolve(pin.version);
  }

  exists(ref: SegmentRef): Promise<boolean> {
    return this.inner.exists(ref);
  }

  invalidate(ref: SegmentRef): void {
    this.inner.invalidate(ref);
  }
}
