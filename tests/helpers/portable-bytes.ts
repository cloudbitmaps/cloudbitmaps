/**
 * Portable-roaring bytes written field by field, so a test can hand the decoder a payload no roaring writer
 * would ever produce.
 *
 * A hostile or corrupted object reaches the decoder as bytes, not as a bitmap, so a test of what the decoder
 * refuses has to start from bytes as well. For well-formed input this writes exactly what the native serializer
 * writes (`tests/roaring/portable-layout.test.ts` checks it byte for byte), so a hostile variant differs from real
 * output only in the one field it forges.
 *
 * The layout, from the portable spec: a cookie; under the run cookie, one flag bit per container marking the run
 * containers; a `(key, cardinality - 1)` pair per container; a `u32` offset per container, present unless the run
 * cookie is used with fewer than four containers; then the containers back to back. An array container is its
 * `u16` values, a bitset is 8 KiB of bits, a run container is a `u16` run count and then `(start, length)` pairs,
 * where a run covers `start` through `start + length`.
 */

const SERIAL_COOKIE_NO_RUNCONTAINER = 12_346;
const SERIAL_COOKIE = 12_347;
const NO_OFFSET_THRESHOLD = 4;
/** Bytes in a bitset container: one bit for each of the 65,536 values a container can hold. */
export const BITSET_BYTES = 8_192;

export type CraftedContainer =
  | { readonly key: number; readonly kind: 'array'; readonly values: readonly number[] }
  | {
      readonly key: number;
      readonly kind: 'bitset';
      readonly bits: Uint8Array;
      /** The header's cardinality. Defaults to the number of bits set. */
      readonly cardinality?: number;
    }
  | {
      readonly key: number;
      readonly kind: 'run';
      /** `(start, length)` pairs; a run covers `start` through `start + length`. */
      readonly runs: ReadonlyArray<readonly [start: number, length: number]>;
      /** The header's cardinality. Defaults to the number of values the runs cover. */
      readonly cardinality?: number;
    };

/** An 8 KiB bitset container body with `values` set. */
export function bitsetOf(values: Iterable<number>): Uint8Array {
  const bits = new Uint8Array(BITSET_BYTES);
  for (const v of values) bits[v >>> 3]! |= 1 << (v & 7);
  return bits;
}

function popcount(bits: Uint8Array): number {
  let n = 0;
  for (const byte of bits) for (let b = byte; b !== 0; b &= b - 1) n++;
  return n;
}

function headerCardinality(c: CraftedContainer): number {
  if (c.kind === 'array') return c.values.length;
  if (c.kind === 'bitset') return c.cardinality ?? popcount(c.bits);
  return c.cardinality ?? c.runs.reduce((sum, [, length]) => sum + length + 1, 0);
}

function body(c: CraftedContainer): Uint8Array {
  if (c.kind === 'bitset') return c.bits;
  const u16s = c.kind === 'array' ? c.values : [c.runs.length, ...c.runs.flat()];
  const out = new Uint8Array(u16s.length * 2);
  const view = new DataView(out.buffer);
  u16s.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}

/**
 * Serialize `containers` in the portable layout, in the order given.
 *
 * `forge.offsets` replaces the offset header's values, which is how a test presents an offset header that
 * disagrees with where the containers actually are. Without it the offsets are the true ones.
 */
export function craftPortable(
  containers: readonly CraftedContainer[],
  forge: { readonly offsets?: readonly number[] } = {},
): Uint8Array {
  const n = containers.length;
  const runCookie = containers.some((c) => c.kind === 'run');
  const flagBytes = runCookie ? (n + 7) >>> 3 : 0;
  const hasOffsets = !runCookie || n >= NO_OFFSET_THRESHOLD;
  const descriptive = (runCookie ? 4 : 8) + flagBytes;
  const headerBytes = descriptive + n * 4 + (hasOffsets ? n * 4 : 0);
  const bodies = containers.map(body);
  const out = new Uint8Array(headerBytes + bodies.reduce((sum, b) => sum + b.length, 0));
  const view = new DataView(out.buffer);

  if (runCookie) {
    view.setUint32(0, (SERIAL_COOKIE | ((n - 1) << 16)) >>> 0, true);
    containers.forEach((c, i) => {
      if (c.kind === 'run') out[4 + (i >>> 3)]! |= 1 << (i & 7);
    });
  } else {
    view.setUint32(0, SERIAL_COOKIE_NO_RUNCONTAINER, true);
    view.setUint32(4, n, true);
  }
  let at = headerBytes;
  containers.forEach((c, i) => {
    view.setUint16(descriptive + i * 4, c.key, true);
    view.setUint16(descriptive + i * 4 + 2, (headerCardinality(c) - 1) & 0xffff, true);
    if (hasOffsets) {
      view.setUint32(descriptive + n * 4 + i * 4, forge.offsets?.[i] ?? at, true);
    }
    out.set(bodies[i]!, at);
    at += bodies[i]!.length;
  });
  return out;
}
