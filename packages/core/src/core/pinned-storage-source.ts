/**
 * A {@link StorageChunkSource} view that holds **one** segment at **one** generation, and passes everything else
 * through to the live source.
 *
 * A pin exists so a long job describes a single instant. An ordinary handle re-resolves on `cache.genTtlMs`, so a
 * publish part-way through an export, a send or a reconciliation means the second half of the job describes a
 * different instant than the first — and nothing in the result says so.
 *
 * **A pin is a generation number and the object it named, not a captured reader.** The reader behind it can live
 * in the shared bounded LRU and be evicted freely: re-opening at the same number reopens the same object, or, if
 * the name was purged and loaded again since, finds another one, which the pin's fingerprint refuses. Holding the
 * reader instead put every live pin outside the library's memory ceiling.
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
import type { ChunkRef, StorageChunkSource, SegmentRef, SegmentSize } from './ports';
import type { CrbmStorageChunkSource, PinnedObject } from './crbm-storage-source';
import { segmentKey } from './keys';

/**
 * What a pin holds for one segment: the generation, the version identifying those exact bytes, and the pinned
 * object's fingerprint, so a read can tell that the generation it opens is still that object.
 *
 * `fingerprint` is optional so that a pin built by hand, before there was one, still compiles; such a pin is
 * checked by version only, and so cannot tell a name purged and loaded again from the segment it pinned.
 * `seg.pin()` always records it.
 */
export interface PinnedAt {
  readonly generation: number | null;
  readonly version: string | null;
  readonly fingerprint?: string | null;
}

/** The part of a pin a pinned read checks the object against; none for a pin of no generation. */
const heldBy = (pin: PinnedAt): PinnedObject | undefined => {
  if (pin.version === null) return undefined;
  return pin.fingerprint == null
    ? { version: pin.version }
    : { version: pin.version, fingerprint: pin.fingerprint };
};

export class PinnedStorageChunkSource implements StorageChunkSource {
  constructor(
    private readonly inner: CrbmStorageChunkSource,
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
      : this.inner.getChunkAt(ref, pin.generation, heldBy(pin));
  }

  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.listChunkKeys(ref);
    return pin.generation === null
      ? Promise.resolve([])
      : this.inner.listChunkKeysAt(ref, pin.generation, heldBy(pin));
  }

  sizeOf(ref: SegmentRef): Promise<SegmentSize | null> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.sizeOf(ref);
    return pin.generation === null
      ? Promise.resolve(null)
      : this.inner.sizeOfAt(ref, pin.generation, heldBy(pin));
  }

  cardinalities(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.cardinalities(ref);
    return pin.generation === null
      ? Promise.resolve(null)
      : this.inner.cardinalitiesAt(ref, pin.generation, heldBy(pin));
  }

  currentGeneration(ref: SegmentRef): Promise<number | null> {
    const pin = this.pinFor(ref);
    return pin === undefined ? this.inner.currentGeneration(ref) : Promise.resolve(pin.generation);
  }

  /**
   * A pinned segment reports the version captured when it was pinned, marked as a pin's, so its decoded chunks
   * are cached under keys that no live read writes. A live read keys its fetches by the version it resolved when
   * it began, but is served whatever generation the live source holds when each fetch lands — after a publish
   * and a lapsed `cache.genTtlMs`, a reader-cache eviction, a sweep that heals the read forward, or an
   * invalidation, a different one — so an entry under a live version can hold another generation's chunk.
   * Invariant 3 lets that live call see it, and later live reads resolve the current version and never look the
   * entry up; a pin sharing the key would be handed it, and return a read that mixed two generations. A pinned
   * read fetches exactly its own generation, so the entries it fills are always that generation's.
   *
   * The pin still shares the store's chunk cache, and its memory ceiling; what it gives up is a hit on a chunk a
   * live read of the same version cached, which costs a pin one GET per such chunk. Live reads make no call for it,
   * though a pin's entries share the cache's bound with theirs, so under a small `cache.maxChunks` each can evict
   * the other. The version, not the bare generation, is still what the key carries: sharing on a generation-only
   * key was how a pinned read could resurrect an id that `eraseIdFromSegment` had reported physically gone.
   */
  currentVersion(ref: SegmentRef): Promise<string | null> {
    const pin = this.pinFor(ref);
    if (pin === undefined) return this.inner.currentVersion(ref);
    // A live version starts with its generation number, so no live version can equal a pin's. The fingerprint keeps
    // two incarnations' pins apart where the version cannot: on a store with no registry it is the bare number.
    if (pin.version === null) return Promise.resolve(null);
    return Promise.resolve(
      `pin ${pin.version}${pin.fingerprint == null ? '' : `#${pin.fingerprint}`}`,
    );
  }

  exists(ref: SegmentRef): Promise<boolean> {
    return this.inner.exists(ref);
  }

  invalidate(ref: SegmentRef): void {
    this.inner.invalidate(ref);
  }
}
