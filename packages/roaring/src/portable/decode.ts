/**
 * A dependency-free **reader** for the portable RoaringBitmap serialization.
 *
 * WHY THIS EXISTS. `@cloudbitmaps/roaring` wraps `roaring`, a native N-API addon (`gypfile: true`). No V8
 * isolate — Cloudflare Workers, Deno Deploy, Vercel Edge — can load a native addon under any compatibility
 * flag, so the shipped flavor cannot answer a membership question at the edge no matter how the rest of the
 * stack is arranged. The engine seam is already portable (`packages/core/src/core/` imports zero node builtins
 * and core has zero runtime dependencies); the codec is the only thing in the way.
 *
 * WHY A READER IS ENOUGH. `SegmentEngine.has()` calls exactly two codec capabilities — deserialize a chunk, and
 * test one value in it. It never reaches `add`, `remove`, `orInPlace`, `andNotInPlace`, `optimize`, `clone` or
 * `serialize`. So read-only membership over a loaded generation needs a decoder, not a reimplementation of
 * CRoaring, and this file is deliberately the former.
 *
 * WHAT IT IS NOT. There is no mutation here and there will not be. A set you can query is a much smaller and
 * much more verifiable artifact than a set you can modify, and the write path has a perfectly good native
 * implementation. Anything wanting `add` should use {@link SafeBitmap}.
 *
 * ON TRUSTING THIS FILE. It decodes **untrusted bytes** (hard invariant #5: every byte off a storage tier is
 * hostile until proven otherwise), so no reader exists until {@link parsePortableLayout} has bounded every field
 * against the buffer and checked the structure the lookups below rely on: keys and values ascending, runs
 * disjoint, cardinalities matching. That is the same check the native path runs, so the two decoders refuse the
 * same bytes. The format knowledge in `layout.ts` was written from the Roaring spec and then checked against
 * bytes actually produced by `roaring` — and the differential tests in `tests/roaring/portable-decode.test.ts`
 * and `tests/roaring/portable-layout.test.ts` are what make it trustworthy, not the prose. If the two ever
 * disagree, the native library is right.
 *
 * @see https://github.com/RoaringBitmap/RoaringFormatSpec
 */
import { ARRAY, BITMAP, parsePortableLayout, type PortableContainer } from './layout';

/**
 * A decoded portable-roaring bitmap that can be queried but not modified.
 *
 * Construction checks every container once, in {@link parsePortableLayout}, which is the same check the native
 * path runs; after that a membership test reads one container rather than materializing the set.
 */
export class PortableRoaringReader {
  private constructor(
    private readonly view: DataView,
    private readonly containers: readonly PortableContainer[],
  ) {}

  /**
   * Parse and check a portable-format bitmap.
   *
   * @throws {IntegrityError} if the bytes are not a well-formed portable bitmap: see {@link parsePortableLayout}.
   */
  static decode(bytes: Uint8Array): PortableRoaringReader {
    const containers = parsePortableLayout(bytes);
    return new PortableRoaringReader(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      containers,
    );
  }

  /**
   * Total cardinality.
   *
   * Served entirely from the descriptive header, which {@link parsePortableLayout} has checked against every
   * container's payload, so this is O(containers) and independent of how many values the bitmap holds.
   */
  count(): number {
    let total = 0;
    for (const c of this.containers) total += c.cardinality;
    return total;
  }

  /** Is `value` (a `u32`) in the set? */
  has(value: number): boolean {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) return false;
    const container = this.findContainer(value >>> 16);
    if (!container) return false;
    const low = value & 0xffff;
    switch (container.kind) {
      case BITMAP:
        return this.bitmapHas(container, low);
      case ARRAY:
        return this.arrayHas(container, low);
      default:
        return this.runHas(container, low);
    }
  }

  /** Binary search the descriptive header for the container owning `key`. */
  private findContainer(key: number): PortableContainer | undefined {
    let lo = 0;
    let hi = this.containers.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const found = this.containers[mid] as PortableContainer;
      if (found.key === key) return found;
      if (found.key < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  /**
   * 1,024 little-endian `u64` words. Read as `u32` at `(low >> 5) * 4`: a LE `u64` is two LE `u32`s with the
   * low word first, so the 32-bit view lands on the right half without any 64-bit arithmetic.
   */
  private bitmapHas(container: PortableContainer, low: number): boolean {
    const word = this.view.getUint32(container.offset + (low >>> 5) * 4, true);
    return ((word >>> (low & 31)) & 1) === 1;
  }

  /**
   * Sorted `u16` values — binary search.
   *
   * The `at === low` early return means the `at < low` below is only ever evaluated when `at !== low`, so
   * writing it `at <= low` would behave identically. That is recorded because mutation testing surfaced it as
   * a surviving mutant: it is an *equivalent* one, unkillable by any test rather than a coverage gap — three
   * non-equivalent mutations of these same lines (inverting the branches, never reporting a hit, dropping the
   * last element) are all caught. Do not "fix" the survivor, and do not add a test chasing it.
   */
  private arrayHas(container: PortableContainer, low: number): boolean {
    let lo = 0;
    let hi = container.cardinality - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.view.getUint16(container.offset + mid * 2, true);
      if (at === low) return true;
      if (at < low) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /**
   * `u16` run count, then that many `(start, length)` `u16` pairs sorted by start.
   *
   * `length` is the number of values **after** `start`, so a run covers the inclusive range
   * `[start, start + length]` and a single-value run is stored with length 0. Getting this off by one is the
   * easiest mistake in the format and is why the differential test drives runs specifically.
   */
  private runHas(container: PortableContainer, low: number): boolean {
    const runs = this.view.getUint16(container.offset, true);
    const base = container.offset + 2;
    let lo = 0;
    let hi = runs - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const start = this.view.getUint16(base + mid * 4, true);
      const length = this.view.getUint16(base + mid * 4 + 2, true);
      if (low < start) hi = mid - 1;
      else if (low > start + length) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

/** Convenience wrapper over {@link PortableRoaringReader.decode}. */
export function decodePortableRoaring(bytes: Uint8Array): PortableRoaringReader {
  return PortableRoaringReader.decode(bytes);
}
