/**
 * The layout of a portable-roaring bitmap: parsed, and checked for the structure every reader of it assumes.
 *
 * WHY THIS EXISTS. `roaring` deserializes the portable format with CRoaring's
 * `roaring_bitmap_portable_deserialize_safe`, and that function makes exactly one promise: it never reads past the
 * buffer. CRoaring's header says the bitmap it returns must then pass `roaring_bitmap_internal_validate` before
 * anything uses it, and `roaring` neither calls that function nor exposes it. Every other invariant of the format
 * is therefore taken on trust from bytes that come off a storage tier, which hard invariant 5 says are hostile
 * until proven otherwise. What `roaring` 2.7.0 does with such bytes when nothing checks them first:
 *
 * - **Containers out of order.** `maximum()` reads the last container, so a chunk payload listing container 1
 *   before container 0 passes the engine's 16-bit range check, and a read then yields container 1's values masked
 *   into the chunk: ids the segment does not hold, which `has()` denies.
 * - **Values or runs out of order, duplicated or overlapping.** `has()` binary-searches, so it denies values that
 *   iteration yields, `size` counts duplicates, and a range read stops early.
 * - **A run past the end of its container.** `maximum()` wraps to a small value, so the range check passes, and
 *   iteration yields values from the next container's id space.
 * - **A run container with no runs.** Iterating it, or intersecting or unioning with it, crashes the process.
 * - **A bitset whose header cardinality disagrees with its bits.** `size` answers the header. Where the header
 *   says fewer values than the bits hold, `remove()` converts the container into an array sized by the header and
 *   writes every bit into it: a heap overflow in the native addon, and then a crash.
 *
 * None of those is caught by a CRC, which proves only that the bytes are the bytes that were written. Anyone who
 * can write the bucket writes those.
 *
 * WHAT IT CHECKS, which is what `roaring_bitmap_internal_validate` checks, stated on the serialized form: container
 * keys strictly ascend; array values strictly ascend; runs ascend, stay inside their container, and neither overlap
 * nor touch (a writer merges touching runs); a run container has at least one run; a bitset's popcount is the
 * cardinality its header states. And two things the native deserializer ignores and the pure-JS reader uses: every
 * offset in the offset header is where its container really starts, and a run container's header cardinality is
 * the number of values its runs cover. Anything a real writer produces passes, because a real writer produces
 * exactly this structure.
 *
 * WHAT IT COSTS. One pass over the bytes the decode is about to copy anyway, once per decode: never per id, and
 * never on a cache hit. Measured on an M3 Pro under Node 24, with the check, the native deserialize and a CRC32C
 * of the same bytes timed in alternating rounds: about 70 ns for a payload of one small container, 0.7 us for a
 * 2 KB array container, and 2.5 to 3.2 us for an 8 KB one of any kind. That is a third to a half of the CRC32C the
 * `.crbm` reader already computes over the stored payload before it gets here.
 *
 * Both decoders run it: `SafeBitmap.safeDeserialize` before the native addon sees a byte, and the pure-JS reader
 * in `decode.ts`, which builds on the layout it returns. One check in one place is what keeps the two decoders
 * from disagreeing about which bytes are a bitmap.
 *
 * @see https://github.com/RoaringBitmap/RoaringFormatSpec
 */
import { IntegrityError } from '@cloudbitmaps/core';
import type { EncodedChunk } from '@cloudbitmaps/core';

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
/** The largest value a container holds: its low 16 bits. */
const MAX_LOW = 0xffff;

/** A container of sorted `u16` values. */
export const ARRAY = 0;
/** A container of 65,536 bits. */
export const BITMAP = 1;
/** A container of `(start, length)` runs. */
export const RUN = 2;
export type ContainerKind = typeof ARRAY | typeof BITMAP | typeof RUN;

export interface PortableContainer {
  /** High 16 bits of every value in this container. */
  readonly key: number;
  /** Number of values. Stored as `cardinality - 1` on the wire, normalized here. */
  readonly cardinality: number;
  readonly kind: ContainerKind;
  /** Absolute byte offset of this container's payload within the source buffer; a run container's run count. */
  readonly offset: number;
}

/**
 * The error for a field that runs past the buffer. Callers test the bound inline and call this only when it
 * fails, so a well-formed bitmap never builds the message: the test runs once per container, and a string built
 * on every pass would cost a bitmap of many small containers more than the check itself does.
 */
function overrun(bytes: Uint8Array, offset: number, length: number, what: string): IntegrityError {
  return new IntegrityError(
    `portable roaring: ${what} needs bytes [${offset}, ${offset + length}) of a ${bytes.byteLength}-byte buffer`,
  );
}

/**
 * Parse the portable-format bitmap in `bytes`, and check its structure.
 *
 * An empty buffer is the empty bitmap, as it is to the native addon, which returns one without reading a byte.
 *
 * @throws {IntegrityError} if the cookie is unrecognized, any field runs past the buffer, or the structure is not
 * one a writer produces (see the module header for the list).
 */
export function parsePortableLayout(bytes: Uint8Array): PortableContainer[] {
  const containers: PortableContainer[] = [];
  walk(bytes, containers);
  return containers;
}

/**
 * {@link parsePortableLayout}'s check alone, for a caller that hands the bytes to another decoder afterwards and
 * so has no use for the layout: it allocates nothing per container.
 *
 * @throws {IntegrityError} exactly where {@link parsePortableLayout} does.
 */
export function checkPortableLayout(bytes: Uint8Array): void {
  walk(bytes, null);
}

/** A one-container payload's header without run containers: cookie, count, `(key, cardinality - 1)`, offset. */
const SINGLE_HEADER_BYTES = 16;
/** A one-container payload's header under the run cookie: cookie holding `count - 1`, one flag byte, the pair. */
const SINGLE_RUN_HEADER_BYTES = 9;

/**
 * Each container of the portable bitmap in `bytes`, as the one-container portable bitmap a `.crbm` chunk stores:
 * its key moved to 0, its cardinality and kind kept, its body copied unchanged. These are exactly the bytes the
 * native serializer writes for a bitmap holding only that container's low 16 bits, so a chunk cut from a whole
 * bitmap is the chunk built from its ids, provided the whole bitmap was encoded canonically first.
 *
 * Header and body copies only: no value is read one by one beyond the structural check
 * {@link parsePortableLayout} makes.
 *
 * @throws {IntegrityError} where {@link parsePortableLayout} does.
 */
export function* containerPayloads(bytes: Uint8Array): Generator<EncodedChunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const { key, cardinality, kind, offset } of parsePortableLayout(bytes)) {
    const size =
      kind === ARRAY
        ? cardinality * 2
        : kind === BITMAP
          ? BITMAP_CONTAINER_BYTES
          : 2 + 4 * view.getUint16(offset, true);
    const header = kind === RUN ? SINGLE_RUN_HEADER_BYTES : SINGLE_HEADER_BYTES;
    const payload = new Uint8Array(header + size);
    const out = new DataView(payload.buffer);
    if (kind === RUN) {
      out.setUint32(0, SERIAL_COOKIE, true); // count - 1 = 0 in the high half
      payload[4] = 1; // container 0 is a run container
      out.setUint16(7, cardinality - 1, true); // after key 0 at byte 5
    } else {
      out.setUint32(0, SERIAL_COOKIE_NO_RUNCONTAINER, true);
      out.setUint32(4, 1, true);
      out.setUint16(10, cardinality - 1, true); // after key 0 at byte 8
      out.setUint32(12, SINGLE_HEADER_BYTES, true);
    }
    payload.set(bytes.subarray(offset, offset + size), header);
    yield { chunkKey: key, payload, cardinality };
  }
}

/** Check every container of `bytes`, appending each one's layout to `out` when there is one to append to. */
function walk(bytes: Uint8Array, out: PortableContainer[] | null): void {
  const length = bytes.byteLength;
  if (length === 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);

  if (length < 4) throw overrun(bytes, 0, 4, 'the cookie');
  const cookie = view.getUint32(0, true);
  let count: number;
  /** Where the run-container flag bits start, or -1 under the cookie that has none. */
  let runFlagsAt = -1;
  let pos: number;
  if (cookie === SERIAL_COOKIE_NO_RUNCONTAINER) {
    if (length < 8) throw overrun(bytes, 4, 4, 'the container count');
    count = view.getUint32(4, true);
    pos = 8;
  } else if ((cookie & 0xffff) === SERIAL_COOKIE) {
    // The count is packed into the cookie's high half as `count - 1`, so it can never be zero here.
    count = (cookie >>> 16) + 1;
    runFlagsAt = 4;
    const flagBytes = (count + 7) >>> 3;
    if (runFlagsAt + flagBytes > length) {
      throw overrun(bytes, runFlagsAt, flagBytes, 'the run-container bitmap');
    }
    pos = runFlagsAt + flagBytes;
  } else {
    throw new IntegrityError(
      `portable roaring: unrecognized cookie 0x${cookie.toString(16)}, not a portable-format bitmap`,
    );
  }

  // Descriptive header: (key, cardinality - 1) per container. Then the offset header, when this layout has one.
  const descriptiveAt = pos;
  if (pos + count * 4 > length) throw overrun(bytes, pos, count * 4, 'the descriptive header');
  pos += count * 4;
  let offsetsAt = -1;
  if (runFlagsAt < 0 || count >= NO_OFFSET_THRESHOLD) {
    if (pos + count * 4 > length) throw overrun(bytes, pos, count * 4, 'the offset header');
    offsetsAt = pos;
    pos += count * 4;
  }

  let previousKey = -1;
  // Containers lie back to back from here. That is how the native deserializer finds them (it never reads the
  // offset header), so the offsets are checked against it rather than followed.
  for (let i = 0; i < count; i++) {
    const key = view.getUint16(descriptiveAt + i * 4, true);
    if (key <= previousKey) {
      throw new IntegrityError(
        `portable roaring: container keys are not strictly ascending (${previousKey} then ${key} at index ${i})`,
      );
    }
    previousKey = key;
    const cardinality = view.getUint16(descriptiveAt + i * 4 + 2, true) + 1;
    const isRun =
      runFlagsAt >= 0 && ((bytes[runFlagsAt + (i >>> 3)] as number) & (1 << (i & 7))) !== 0;
    const kind: ContainerKind = isRun ? RUN : cardinality > ARRAY_MAX_CARDINALITY ? BITMAP : ARRAY;
    if (offsetsAt >= 0) {
      const stated = view.getUint32(offsetsAt + i * 4, true);
      if (stated !== pos) {
        throw new IntegrityError(
          `portable roaring: the offset header puts container ${i} at byte ${stated}, but it starts at ${pos}`,
        );
      }
    }

    let size: number;
    if (kind === ARRAY) {
      size = cardinality * 2;
      if (pos + size > length) throw overrun(bytes, pos, size, `container ${i} (array)`);
      checkArray(view, pos, cardinality, i);
    } else if (kind === BITMAP) {
      size = BITMAP_CONTAINER_BYTES;
      if (pos + size > length) throw overrun(bytes, pos, size, `container ${i} (bitmap)`);
      const bits = popcount(view, pos);
      if (bits !== cardinality) {
        throw new IntegrityError(
          `portable roaring: container ${i} (bitmap) holds ${bits} values, but its header says ${cardinality}`,
        );
      }
    } else {
      if (pos + 2 > length) throw overrun(bytes, pos, 2, `container ${i} (run count)`);
      const runs = view.getUint16(pos, true);
      size = 2 + runs * 4;
      if (pos + size > length) throw overrun(bytes, pos, size, `container ${i} (run)`);
      const covered = checkRuns(view, pos + 2, runs, i);
      // A header cannot state zero values, so this is also what refuses a run container with no runs, the shape
      // that crashes the native addon when anything iterates it.
      if (covered !== cardinality) {
        throw new IntegrityError(
          `portable roaring: container ${i} (run) covers ${covered} values, but its header says ${cardinality}`,
        );
      }
    }
    out?.push({ key, cardinality, kind, offset: pos });
    pos += size;
  }
}

/**
 * An array container's values must strictly ascend: `has` binary-searches them and iteration yields them in order.
 *
 * Read two values per `u32` (little-endian, so the first value is the low half): half the loads and half the loop
 * trips of reading them one at a time, which measured about twice as fast.
 */
function checkArray(view: DataView, at: number, cardinality: number, index: number): void {
  let previous = -1;
  let p = at;
  const end = at + cardinality * 2;
  for (; p + 4 <= end; p += 4) {
    const pair = view.getUint32(p, true);
    const first = pair & 0xffff;
    const second = pair >>> 16;
    if (first <= previous || second <= first) throw unordered(index, (p - at) / 2);
    previous = second;
  }
  if (p < end && view.getUint16(p, true) <= previous) throw unordered(index, (p - at) / 2);
}

function unordered(index: number, element: number): IntegrityError {
  return new IntegrityError(
    `portable roaring: container ${index} (array) is not strictly ascending at or after element ${element}`,
  );
}

/**
 * Runs must ascend, stay inside the container, and leave at least one value between each other: overlapping runs
 * count their shared values twice, and touching ones are two runs a writer would have merged into one. Returns the
 * number of values the runs cover. Each run is one `u32`: its start in the low half, its length in the high.
 */
function checkRuns(view: DataView, at: number, runs: number, index: number): number {
  let covered = 0;
  /** The lowest start the next run may have: one past the value after the previous run's last. */
  let lowest = 0;
  for (let r = 0; r < runs; r++) {
    const run = view.getUint32(at + r * 4, true);
    const start = run & 0xffff;
    const last = start + (run >>> 16);
    if (start < lowest) {
      throw new IntegrityError(
        `portable roaring: container ${index} (run) has run ${r} out of order, overlapping or touching the one before`,
      );
    }
    if (last > MAX_LOW) {
      throw new IntegrityError(
        `portable roaring: container ${index} (run) has run ${r} running past the end of the container`,
      );
    }
    covered += last - start + 1;
    lowest = last + 2;
  }
  return covered;
}

/** Set bits in a bitset container's 2,048 little-endian `u32` words. */
function popcount(view: DataView, at: number): number {
  let bits = 0;
  for (let p = at, end = at + BITMAP_CONTAINER_BYTES; p < end; p += 4) {
    let w = view.getUint32(p, true);
    w -= (w >>> 1) & 0x5555_5555;
    w = (w & 0x3333_3333) + ((w >>> 2) & 0x3333_3333);
    bits += Math.imul((w + (w >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
  }
  return bits;
}
