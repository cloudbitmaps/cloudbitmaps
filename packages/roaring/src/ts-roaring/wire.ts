/**
 * The portable Roaring bytes of a set of containers: written from them, and read back into them.
 *
 * The layout is the RoaringFormatSpec's, as this repo's format page states it. A bitmap with no run container starts
 * with the cookie 12,346 and a `u32` container count; one with a run container starts with the cookie 12,347 whose high
 * half holds `count - 1`, then one bit per container (a run container's) in `ceil(count / 8)` bytes. Then come a
 * `(key, cardinality - 1)` pair of `u16`s per container, an offset per container (always without runs; with runs only
 * from four containers up) and the bodies back to back: an array's values as `u16`s, a bitset's 2,048 words, a run
 * container's run count and `(start, length - 1)` pairs. All integers are little-endian.
 *
 * Reading goes through {@link parsePortableLayout}, which holds every rule a reader refuses on (bounds, ordering, runs,
 * cardinalities, offsets), so there is one code path for what is a bitmap and this module only copies bytes the layout
 * has already vouched for, on a private copy of the input.
 */
import { IntegrityError } from '@cloudbitmaps/core';
import {
  NO_OFFSET_THRESHOLD,
  SERIAL_COOKIE,
  SERIAL_COOKIE_NO_RUNCONTAINER,
  parsePortableLayout,
  ARRAY as LAYOUT_ARRAY,
  BITMAP as LAYOUT_BITMAP,
} from '../portable/layout';
import {
  ARRAY,
  BITSET,
  BITSET_BYTES,
  RUN,
  LITTLE_ENDIAN,
  WORDS,
  bitsetContainer,
  Container,
} from './containers';

/** The size of a container's body on the wire. */
function bodySize(c: Container): number {
  if (c.kind === ARRAY) return 2 * c.len;
  if (c.kind === BITSET) return BITSET_BYTES;
  return 2 + 4 * c.len;
}

/** A body of fewer `u16`s than this is written with a loop, not a view and a copy. */
const SMALL_BODY = 64;

/** Write `count` `u16`s of `src` from index `from` at byte `at` of `out`, little-endian. */
function putU16s(out: Uint8Array, at: number, src: Uint16Array, from: number, count: number): void {
  if (count < SMALL_BODY) {
    // A short body is written by a loop: a view over it costs more than its bytes. Byte by byte is little-endian on any machine.
    for (let i = 0; i < count; i++) {
      const v = src[from + i] as number;
      out[at++] = v & 255;
      out[at++] = v >>> 8;
    }
    return;
  }
  if (LITTLE_ENDIAN) {
    out.set(new Uint8Array(src.buffer, src.byteOffset + 2 * from, 2 * count), at);
    return;
  }
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < count; i++) view.setUint16(at + 2 * i, src[from + i] as number, true);
}

function writeBody(c: Container, out: Uint8Array, view: DataView, at: number): void {
  if (c.kind === ARRAY) {
    putU16s(out, at, c.data as Uint16Array, c.off, c.len);
  } else if (c.kind === BITSET) {
    const words = c.data as Uint32Array;
    if (LITTLE_ENDIAN) out.set(new Uint8Array(words.buffer, words.byteOffset, BITSET_BYTES), at);
    else for (let i = 0; i < WORDS; i++) view.setUint32(at + 4 * i, words[i] as number, true);
  } else {
    view.setUint16(at, c.len, true);
    putU16s(out, at + 2, c.data as Uint16Array, c.off, 2 * c.len);
  }
}

/** The portable bytes of the bitmap holding `conts`, under the ascending 16-bit `keys`. Empty input is the 8-byte empty bitmap. */
export function serializeContainers(
  keys: readonly number[],
  conts: readonly Container[],
): Uint8Array {
  const n = conts.length;
  let hasRun = false;
  for (let i = 0; i < n; i++) if ((conts[i] as Container).kind === RUN) hasRun = true;
  const offsets = !hasRun || n >= NO_OFFSET_THRESHOLD;
  let at = hasRun ? 4 + ((n + 7) >>> 3) : 8;
  const describeAt = at;
  at += 4 * n;
  const offsetsAt = at;
  if (offsets) at += 4 * n;
  let total = at;
  for (let i = 0; i < n; i++) total += bodySize(conts[i] as Container);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  if (hasRun) {
    view.setUint32(0, SERIAL_COOKIE | ((n - 1) << 16), true);
    for (let i = 0; i < n; i++) {
      if ((conts[i] as Container).kind === RUN) {
        out[4 + (i >>> 3)] = (out[4 + (i >>> 3)] as number) | (1 << (i & 7));
      }
    }
  } else {
    view.setUint32(0, SERIAL_COOKIE_NO_RUNCONTAINER, true);
    view.setUint32(4, n, true);
  }
  for (let i = 0; i < n; i++) {
    const c = conts[i] as Container;
    view.setUint16(describeAt + 4 * i, keys[i] as number, true);
    view.setUint16(describeAt + 4 * i + 2, c.card - 1, true);
    if (offsets) view.setUint32(offsetsAt + 4 * i, at, true);
    writeBody(c, out, view, at);
    at += bodySize(c);
  }
  return out;
}

/** What {@link decodeContainers} found: the containers in key order, and where the bitmap ends in the buffer. */
interface Decoded {
  readonly keys: number[];
  readonly conts: Container[];
  /** One past the last byte of the last container (0 for an empty buffer). */
  readonly end: number;
}

/**
 * Read the portable bitmap in `bytes`. An empty buffer is the empty bitmap. With `detached`, the result holds no view of
 * the input's copy: a bitset is copied into an array of its own, and the arrays and runs are copied into slabs of at
 * most {@link DETACHED_SLAB_BYTES} each (a container larger than a slab gets storage of its own), so a container that
 * outlives the rest keeps at most one slab alive.
 *
 * @throws {IntegrityError} for every shape {@link parsePortableLayout} refuses.
 */
export function decodeContainers(input: Uint8Array, detached = false): Decoded {
  // The bytes are copied before they are checked, and the checked copy is the one read (Uint8Array's own slice, which
  // always copies; a Node Buffer's slice is a view of the same memory): a buffer another thread is
  // still writing (a shared one) could otherwise pass the check and then hold different bytes when they are copied
  // into containers, leaving an unsorted array or a bitset whose cardinality is not its bit count.
  const bytes = Uint8Array.prototype.slice.call(input) as Uint8Array;
  const layout = parsePortableLayout(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Sized to the container count, not grown by pushes: a pushed-to array reserves room for sixteen more, which for the
  // one-container bitmaps a store decodes is most of what the two lists hold.
  const keys = new Array<number>(layout.length);
  const conts = new Array<Container>(layout.length);
  let n = 0;
  // A bitmap of no containers is its 8-byte header (the run cookie cannot state a count of zero).
  let end = bytes.byteLength === 0 ? 0 : 8;
  // The arrays and run containers of one bitmap share a single `Uint16Array`, each reading its own stretch of it, so a
  // run container of a few bytes costs its bytes and one small object, not a typed array of its own. When the bitmap
  // has only one of them it is the whole slab and owns it.
  // A detached decode sizes its slabs as it goes (a slab holds the next arrays and runs that fit in the bound), so the
  // pass over the layout that measures one slab for the whole bitmap is skipped.
  let slabLength = 0;
  let small = 0;
  if (!detached) {
    for (const { cardinality, kind, offset } of layout) {
      if (kind === LAYOUT_ARRAY) {
        slabLength += cardinality;
        small++;
      } else if (kind !== LAYOUT_BITMAP) {
        slabLength += 2 * view.getUint16(offset, true);
        small++;
      }
    }
  }
  // The private copy's memory is its own when the copy starts at its buffer's first byte and fills it, which a copy made
  // by `Uint8Array.prototype.slice` does. A body that sits at a suitably aligned offset of it can then be read in place,
  // as a typed array over the copy, with no second copy of it: the one bitset of a chunk, or its one array or run container.
  const own =
    LITTLE_ENDIAN &&
    bytes.byteOffset === 0 &&
    bytes.buffer instanceof ArrayBuffer &&
    bytes.buffer.byteLength === bytes.byteLength;
  const alias = !detached && own && small === 1;
  // A container with storage of its own: the lone array or run container of a bitmap that cannot be read in place.
  const solo = alias;
  let slab = solo || detached ? NO_U16 : new Uint16Array(slabLength);
  let used = 0;
  // Whether the slab in hand holds more than one container, so that a write to one copies it out.
  let sharers = small > 1;
  for (let at = 0; at < layout.length; at++) {
    const { key, cardinality, kind, offset } = layout[at] as (typeof layout)[number];
    keys[n] = key;
    // A detached decode opens its next slab when the container does not fit what is left of the current one. A
    // container above the bound is the exception: it takes an array of its own, as a lone container does.
    let lone = false;
    if (detached && kind !== LAYOUT_BITMAP) {
      const count = kind === LAYOUT_ARRAY ? cardinality : 2 * view.getUint16(offset, true);
      if (count > DETACHED_SLAB_VALUES) {
        lone = true;
      } else if (used + count > slab.length) {
        let length = 0;
        let held = 0;
        for (let j = at; j < layout.length; j++) {
          const next = layout[j] as (typeof layout)[number];
          if (next.kind === LAYOUT_BITMAP) continue;
          const c =
            next.kind === LAYOUT_ARRAY ? next.cardinality : 2 * view.getUint16(next.offset, true);
          if (c > DETACHED_SLAB_VALUES) continue;
          if (length + c > DETACHED_SLAB_VALUES) break;
          length += c;
          held++;
        }
        slab = new Uint16Array(length);
        used = 0;
        sharers = held > 1;
      }
    }
    if (kind === LAYOUT_ARRAY) {
      if (alias && offset % 2 === 0) {
        const values = new Uint16Array(bytes.buffer, offset, cardinality);
        conts[n++] = new Container(ARRAY, values, 0, cardinality, cardinality, false);
      } else {
        const own = solo || lone;
        const into = own ? new Uint16Array(cardinality) : slab;
        getU16s(bytes, view, offset, into, own ? 0 : used, cardinality);
        conts[n++] = new Container(
          ARRAY,
          into,
          own ? 0 : used,
          cardinality,
          cardinality,
          !own && sharers,
        );
        if (!own) used += cardinality;
      }
      end = offset + 2 * cardinality;
    } else if (kind === LAYOUT_BITMAP) {
      let words: Uint32Array;
      if (!detached && own && offset % 4 === 0) {
        words = new Uint32Array(bytes.buffer, offset, WORDS);
      } else {
        words = new Uint32Array(WORDS);
        if (LITTLE_ENDIAN) {
          new Uint8Array(words.buffer).set(bytes.subarray(offset, offset + BITSET_BYTES));
        } else {
          for (let i = 0; i < WORDS; i++) words[i] = view.getUint32(offset + 4 * i, true);
        }
      }
      conts[n++] = bitsetContainer(words, cardinality);
      end = offset + BITSET_BYTES;
    } else {
      const runs = view.getUint16(offset, true);
      if (alias && (offset + 2) % 2 === 0) {
        const pairs = new Uint16Array(bytes.buffer, offset + 2, 2 * runs);
        conts[n++] = new Container(RUN, pairs, 0, runs, cardinality, false);
      } else {
        const own = solo || lone;
        const into = own ? new Uint16Array(2 * runs) : slab;
        getU16s(bytes, view, offset + 2, into, own ? 0 : used, 2 * runs);
        conts[n++] = new Container(RUN, into, own ? 0 : used, runs, cardinality, !own && sharers);
        if (!own) used += 2 * runs;
      }
      end = offset + 2 + 4 * runs;
    }
  }
  return { keys, conts, end };
}

const NO_U16 = new Uint16Array(0);

/** The most bytes of one slab a detached decode allocates for arrays and runs. */
export const DETACHED_SLAB_BYTES = 64 * 1024;
const DETACHED_SLAB_VALUES = DETACHED_SLAB_BYTES / 2;

/** Copy `count` little-endian `u16`s from byte `at` of `bytes` into `slab` from index `to`. */
function getU16s(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  slab: Uint16Array,
  to: number,
  count: number,
): void {
  if (LITTLE_ENDIAN) {
    new Uint8Array(slab.buffer, 2 * to, 2 * count).set(bytes.subarray(at, at + 2 * count));
    return;
  }
  for (let i = 0; i < count; i++) slab[to + i] = view.getUint16(at + 2 * i, true);
}

/** The refusal for bytes that follow the bitmap's last container when the buffer must be exactly one bitmap. */
export function trailingBytes(length: number, end: number): IntegrityError {
  return new IntegrityError(
    `portable roaring: ${length - end} bytes follow the bitmap's last container, which ends at byte ${end}. ` +
      `One buffer holds one bitmap: to load several as one segment, combine them first and serialize the result.`,
  );
}
