/**
 * A dependency-free **reader** for the portable RoaringBitmap serialization.
 *
 * WHY THIS EXISTS. `@cloudbitmaps/roaring` wraps `roaring`, a native N-API addon (`gypfile: true`). No V8
 * isolate — Cloudflare Workers, Deno Deploy, Vercel Edge — can load a native addon under any compatibility
 * flag, so the shipped flavor cannot answer a membership question at the edge no matter how the rest of the
 * stack is arranged. The engine seam is already portable (`packages/core/src/core/` imports zero node builtins
 * and core has zero runtime dependencies); the codec is the only thing in the way. See internal ADR 76.
 *
 * WHY A READER IS ENOUGH. `SegmentEngine.has()` against a segment with no warm tier calls exactly two codec
 * capabilities — deserialize a chunk, and test one value in it. It never reaches `add`, `remove`, `orInPlace`,
 * `andNotInPlace`, `optimize`, `clone` or `serialize`. So read-only membership over a compacted cold generation
 * needs a decoder, not a reimplementation of CRoaring, and this file is deliberately the former.
 *
 * WHAT IT IS NOT. There is no mutation here and there will not be. A set you can query is a much smaller and
 * much more verifiable artifact than a set you can modify, and the write path has a perfectly good native
 * implementation. Anything wanting `add` should use {@link SafeBitmap}.
 *
 * ON TRUSTING THIS FILE. It decodes **untrusted bytes** (hard invariant #5: every byte off a storage tier is
 * hostile until proven otherwise), so every read is bounds-checked against the buffer and every structural
 * quantity is validated before it is used to index. The format knowledge below was written from the Roaring
 * spec and then checked against bytes actually produced by `roaring` — and the differential test in
 * `tests/roaring/portable-decode.test.ts` is what makes it trustworthy, not the prose. If the two ever
 * disagree, the native library is right.
 *
 * @see https://github.com/RoaringBitmap/RoaringFormatSpec
 */
import { IntegrityError } from '@cloudbitmaps/core';

/** Cookie for a bitmap with no run containers. Followed by a u32 container count. */
const SERIAL_COOKIE_NO_RUNCONTAINER = 12_346;
/** Cookie (low 16 bits) for a bitmap that may contain run containers; the high 16 bits hold `count - 1`. */
const SERIAL_COOKIE = 12_347;
/**
 * Below this many containers, a run-cookie bitmap omits the offset header and containers must be located by
 * walking their sizes. At or above it the header is present. (A `NO_RUNCONTAINER` bitmap always has it.)
 */
const NO_OFFSET_THRESHOLD = 4;

/** A container holding more than this many values is stored as a flat 8 KiB bitset rather than a u16 array. */
const ARRAY_MAX_CARDINALITY = 4_096;
/** 65,536 bits, flat. */
const BITMAP_CONTAINER_BYTES = 8_192;

const enum Kind {
  Array,
  Bitmap,
  Run,
}

interface Container {
  /** High 16 bits of every value in this container. */
  readonly key: number;
  /** Number of values. Stored as `cardinality - 1` on the wire, normalized here. */
  readonly cardinality: number;
  readonly kind: Kind;
  /** Absolute byte offset of this container's payload within the source buffer. */
  readonly offset: number;
}

/**
 * A decoded portable-roaring bitmap that can be queried but not modified.
 *
 * Construction parses only the headers — container payloads are read on demand, so a membership test against a
 * large bitmap touches one container rather than materializing the set.
 */
export class PortableRoaringReader {
  private constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
    private readonly containers: readonly Container[],
  ) {}

  /**
   * Parse the headers of a portable-format bitmap.
   *
   * @throws {IntegrityError} if the cookie is unrecognized, or any header field runs past the buffer.
   */
  static decode(bytes: Uint8Array): PortableRoaringReader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const need = (offset: number, length: number, what: string): void => {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
        throw new IntegrityError(
          `portable roaring: ${what} needs bytes [${offset}, ${offset + length}) of a ${bytes.byteLength}-byte buffer`,
        );
      }
    };

    need(0, 4, 'the cookie');
    const cookie = view.getUint32(0, true);

    let count: number;
    let hasRunContainers: boolean;
    let pos: number;
    if (cookie === SERIAL_COOKIE_NO_RUNCONTAINER) {
      need(4, 4, 'the container count');
      count = view.getUint32(4, true);
      hasRunContainers = false;
      pos = 8;
    } else if ((cookie & 0xffff) === SERIAL_COOKIE) {
      // The count is packed into the cookie's high half as `count - 1`, so it can never be zero here.
      count = (cookie >>> 16) + 1;
      hasRunContainers = true;
      pos = 4;
    } else {
      throw new IntegrityError(
        `portable roaring: unrecognized cookie 0x${cookie.toString(16)} — not a portable-format bitmap`,
      );
    }

    // Which containers are runs. Only present under the run cookie; one bit per container, LSB-first.
    let runFlags: Uint8Array | undefined;
    if (hasRunContainers) {
      const flagBytes = (count + 7) >>> 3;
      need(pos, flagBytes, 'the run-container bitmap');
      runFlags = bytes.subarray(pos, pos + flagBytes);
      pos += flagBytes;
    }

    // Descriptive header: (key, cardinality - 1) per container, ascending by key.
    need(pos, count * 4, 'the descriptive header');
    const keys = new Array<number>(count);
    const cards = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      keys[i] = view.getUint16(pos, true);
      cards[i] = view.getUint16(pos + 2, true) + 1;
      pos += 4;
    }
    // Ascending, distinct keys are a structural invariant of the format AND what makes the binary search in
    // `has` correct. A crafted file with them out of order would otherwise yield silent wrong answers rather
    // than a rejection — the same class of hole the crafted-index suite exists to close on the `.crbm` side.
    for (let i = 1; i < count; i++) {
      if ((keys[i] as number) <= (keys[i - 1] as number)) {
        throw new IntegrityError(
          `portable roaring: container keys are not strictly ascending (${keys[i - 1]} then ${keys[i]} at index ${i})`,
        );
      }
    }

    const kindOf = (i: number): Kind => {
      if (runFlags && ((runFlags[i >>> 3] as number) & (1 << (i & 7))) !== 0) return Kind.Run;
      return (cards[i] as number) > ARRAY_MAX_CARDINALITY ? Kind.Bitmap : Kind.Array;
    };

    const containers: Container[] = [];
    // The offset header is present for every NO_RUNCONTAINER bitmap, and for a run-cookie bitmap only once it
    // has at least NO_OFFSET_THRESHOLD containers. Verified against real `roaring` output: a single
    // run-optimized container serializes to 15 bytes (4 cookie + 1 flags + 4 descriptive + 2 runs + 4 run),
    // which leaves no room for an offset header.
    if (!hasRunContainers || count >= NO_OFFSET_THRESHOLD) {
      need(pos, count * 4, 'the offset header');
      for (let i = 0; i < count; i++) {
        const offset = view.getUint32(pos + i * 4, true);
        const kind = kindOf(i);
        // Validate the payload lies inside the buffer before anything is allowed to read through it. Run
        // containers are variable-length, so their extent is checked when the run count is read.
        if (kind === Kind.Bitmap) need(offset, BITMAP_CONTAINER_BYTES, `container ${i} (bitmap)`);
        else if (kind === Kind.Array)
          need(offset, (cards[i] as number) * 2, `container ${i} (array)`);
        else need(offset, 2, `container ${i} (run header)`);
        containers.push({ key: keys[i] as number, cardinality: cards[i] as number, kind, offset });
      }
      pos += count * 4;
    } else {
      // No offset header: containers are laid out contiguously from here, so each one's position is the
      // running total of its predecessors' sizes.
      for (let i = 0; i < count; i++) {
        const kind = kindOf(i);
        let size: number;
        if (kind === Kind.Run) {
          need(pos, 2, `container ${i} (run header)`);
          size = 2 + view.getUint16(pos, true) * 4;
        } else if (kind === Kind.Bitmap) {
          size = BITMAP_CONTAINER_BYTES;
        } else {
          size = (cards[i] as number) * 2;
        }
        need(pos, size, `container ${i}`);
        containers.push({
          key: keys[i] as number,
          cardinality: cards[i] as number,
          kind,
          offset: pos,
        });
        pos += size;
      }
    }

    return new PortableRoaringReader(bytes, view, containers);
  }

  /**
   * Total cardinality.
   *
   * Served entirely from the descriptive header — no container payload is read, so this is O(containers) and
   * independent of how many values the bitmap holds.
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
      case Kind.Bitmap:
        return this.bitmapHas(container, low);
      case Kind.Array:
        return this.arrayHas(container, low);
      default:
        return this.runHas(container, low);
    }
  }

  /** Binary search the descriptive header for the container owning `key`. */
  private findContainer(key: number): Container | undefined {
    let lo = 0;
    let hi = this.containers.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const found = this.containers[mid] as Container;
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
  private bitmapHas(container: Container, low: number): boolean {
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
  private arrayHas(container: Container, low: number): boolean {
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
  private runHas(container: Container, low: number): boolean {
    const runs = this.view.getUint16(container.offset, true);
    const base = container.offset + 2;
    if (base + runs * 4 > this.bytes.byteLength) {
      throw new IntegrityError(
        `portable roaring: run container at ${container.offset} declares ${runs} runs, which overruns the buffer`,
      );
    }
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
