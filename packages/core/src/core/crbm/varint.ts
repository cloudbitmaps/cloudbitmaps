/**
 * LEB128 unsigned varint codec for the `.crbm` chunk index.
 *
 * The index is delta+varint encoded so a full 16-bit span stays ~400–650 KB instead of ~900 KB of
 * fixed triplets (finding B6). All index varint values are small (chunk-key deltas ≤ 65535,
 * cardinalities ≤ 65536, payload lengths bounded by a size cap) — well within 32 bits — so this codec
 * accepts unsigned integers in `[0, 0xffffffff]` and rejects anything wider as a programming error.
 */
import { IntegrityError } from '../errors';

const U32_CEIL = 0x1_0000_0000; // 2^32

/** Append the LEB128 encoding of a u32 `value` to `out`. */
export function writeVarint(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= U32_CEIL) {
    throw new RangeError(`varint value must be a u32; got ${value}`);
  }
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

export interface VarintRead {
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
      throw new IntegrityError('varint truncated past end of buffer');
    }
    const byte = bytes[pos]!;
    pos += 1;
    // The 5th byte may contribute at most 4 bits (32 total); reject wider.
    if (i === 4 && byte > 0x0f) {
      throw new IntegrityError('varint exceeds u32 range');
    }
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7;
  }
  throw new IntegrityError('varint exceeds u32 range');
}
