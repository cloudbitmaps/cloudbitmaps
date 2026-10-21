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
 * has already vouched for.
 */
import { IntegrityError } from '@cloudbitmaps/core';
import {
  parsePortableLayout,
  ARRAY as LAYOUT_ARRAY,
  BITMAP as LAYOUT_BITMAP,
} from '../portable/layout';
import {
  ARRAY,
  BITSET,
  BITSET_BYTES,
  RUN,
  WORDS,
  arrayContainer,
  bitsetContainer,
  runContainer,
  type Container,
} from './containers';

const COOKIE_NO_RUNS = 12_346;
const COOKIE_RUNS = 12_347;
/** A run-cookie bitmap carries an offset header from this many containers up. */
const OFFSETS_FROM = 4;

/** The size of a container's body on the wire. */
function bodySize(c: Container): number {
  if (c.kind === ARRAY) return 2 * c.len;
  if (c.kind === BITSET) return BITSET_BYTES;
  return 2 + 4 * c.len;
}

function writeBody(c: Container, view: DataView, at: number): void {
  if (c.kind === ARRAY) {
    for (let i = 0; i < c.len; i++) view.setUint16(at + 2 * i, c.u16[i] as number, true);
  } else if (c.kind === BITSET) {
    for (let i = 0; i < WORDS; i++) view.setUint32(at + 4 * i, c.words[i] as number, true);
  } else {
    view.setUint16(at, c.len, true);
    for (let i = 0; i < 2 * c.len; i++) view.setUint16(at + 2 + 2 * i, c.u16[i] as number, true);
  }
}

/** The portable bytes of the bitmap holding `conts`, under the ascending 16-bit `keys`. Empty input is the 8-byte empty bitmap. */
export function serializeContainers(
  keys: readonly number[],
  conts: readonly Container[],
): Uint8Array {
  const n = conts.length;
  const hasRun = conts.some((c) => c.kind === RUN);
  const offsets = !hasRun || n >= OFFSETS_FROM;
  let at = hasRun ? 4 + ((n + 7) >>> 3) : 8;
  const describeAt = at;
  at += 4 * n;
  const offsetsAt = at;
  if (offsets) at += 4 * n;
  let total = at;
  for (const c of conts) total += bodySize(c);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  if (hasRun) {
    view.setUint32(0, COOKIE_RUNS | ((n - 1) << 16), true);
    conts.forEach((c, i) => {
      if (c.kind === RUN) out[4 + (i >>> 3)] = (out[4 + (i >>> 3)] as number) | (1 << (i & 7));
    });
  } else {
    view.setUint32(0, COOKIE_NO_RUNS, true);
    view.setUint32(4, n, true);
  }
  for (let i = 0; i < n; i++) {
    const c = conts[i] as Container;
    view.setUint16(describeAt + 4 * i, keys[i] as number, true);
    view.setUint16(describeAt + 4 * i + 2, c.card - 1, true);
    if (offsets) view.setUint32(offsetsAt + 4 * i, at, true);
    writeBody(c, view, at);
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
 * Read the portable bitmap in `bytes`. An empty buffer is the empty bitmap.
 *
 * @throws {IntegrityError} for every shape {@link parsePortableLayout} refuses.
 */
export function decodeContainers(bytes: Uint8Array): Decoded {
  const layout = parsePortableLayout(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keys: number[] = [];
  const conts: Container[] = [];
  // A bitmap of no containers is its 8-byte header (the run cookie cannot state a count of zero).
  let end = bytes.byteLength === 0 ? 0 : 8;
  for (const { key, cardinality, kind, offset } of layout) {
    keys.push(key);
    if (kind === LAYOUT_ARRAY) {
      const values = new Uint16Array(cardinality);
      for (let i = 0; i < cardinality; i++) values[i] = view.getUint16(offset + 2 * i, true);
      conts.push(arrayContainer(values, cardinality));
      end = offset + 2 * cardinality;
    } else if (kind === LAYOUT_BITMAP) {
      const words = new Uint32Array(WORDS);
      for (let i = 0; i < WORDS; i++) words[i] = view.getUint32(offset + 4 * i, true);
      conts.push(bitsetContainer(words, cardinality));
      end = offset + BITSET_BYTES;
    } else {
      const runs = view.getUint16(offset, true);
      const pairs = new Uint16Array(2 * runs);
      for (let i = 0; i < 2 * runs; i++) pairs[i] = view.getUint16(offset + 2 + 2 * i, true);
      conts.push(runContainer(pairs, runs, cardinality));
      end = offset + 2 + 4 * runs;
    }
  }
  return { keys, conts, end };
}

/** The refusal for bytes that follow the bitmap's last container when the buffer must be exactly one bitmap. */
export function trailingBytes(length: number, end: number): IntegrityError {
  return new IntegrityError(
    `portable roaring: ${length - end} bytes follow the bitmap's last container, which ends at byte ${end}. ` +
      `One buffer holds one bitmap: to load several as one segment, combine them first and serialize the result.`,
  );
}
