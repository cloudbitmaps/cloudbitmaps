/**
 * LEB128 unsigned varint codec for the `.crbm` chunk index.
 *
 * The index is delta+varint encoded so a full 16-bit span stays ~400–650 KB instead of ~900 KB of
 * fixed triplets. All index varint values are small (chunk-key deltas ≤ 65535,
 * cardinalities ≤ 65536, payload lengths bounded by a size cap) — well within 32 bits — so this codec
 * accepts unsigned integers in `[0, 0xffffffff]` and rejects anything wider as a programming error.
 */
import { U32_MAX } from '../bit-route';
import { crbmIntegrity } from './integrity';

const U32_CEIL = U32_MAX + 1;

/**
 * The number of bytes the LEB128 encoding of a u32 `value` takes (1 to 5). A value that is not an integer in
 * `[0, 0xffffffff]` throws `RangeError`, so a sizing pass can never misjudge a value the writing pass would refuse.
 */
export function varintLength(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= U32_CEIL) {
    throw new RangeError('varint value must be a u32');
  }
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x20_0000) return 3;
  if (value < 0x1000_0000) return 4;
  return 5;
}

/**
 * Write the LEB128 encoding of a u32 `value` into `out` at `pos`, and return the offset just past it. A value that is
 * not a u32 throws `RangeError` before anything is written. The caller sizes `out` (with {@link varintLength}) and
 * checks where the writes ended: a typed array drops a write past its end without an error.
 */
export function writeVarintAt(out: Uint8Array, pos: number, value: number): number {
  varintLength(value);
  let v = value;
  let at = pos;
  while (v > 0x7f) {
    out[at++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  out[at++] = v;
  return at;
}

interface VarintRead {
  readonly value: number;
  /** Offset just past the bytes consumed. */
  readonly next: number;
}

/**
 * Decode a LEB128 varint from `bytes` starting at `offset`. Throws `IntegrityError` on a truncated or
 * over-long (> 5-byte / > u32) encoding — the bytes are untrusted, so a malformed index must fail
 * cleanly, never loop or overflow.
 */
export function readVarint(bytes: Uint8Array, offset: number): VarintRead {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (let i = 0; i < 5; i++) {
    if (pos >= bytes.length) {
      throw crbmIntegrity('varint truncated past end of buffer');
    }
    const byte = bytes[pos]!;
    pos += 1;
    // The 5th byte may contribute at most 4 bits (32 total); reject wider.
    if (i === 4 && byte > 0x0f) {
      throw crbmIntegrity('varint exceeds u32 range');
    }
    // Integer arithmetic: the value stays a small integer where it fits, rather than a heap-boxed double.
    result = (result | ((byte & 0x7f) << shift)) >>> 0;
    if ((byte & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7;
  }
  throw crbmIntegrity('varint exceeds u32 range');
}
