/**
 * The checks on untrusted tier data (invariant 5), in one place: every chunk key, chunk cardinality and chunk payload
 * that comes back from storage passes through here before it is used. Pure: no I/O, time or randomness.
 */
import { CHUNK_COUNT, MAX_REMAINDER } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { IntegrityError } from './errors';

/**
 * Tier-derived keys are untrusted (invariant 5) — fail fast on a corrupt/out-of-range key rather than
 * letting it flow into the id-routing step and produce a bogus id.
 */
export function assertChunkKeyInRange(k: number): void {
  if (!Number.isInteger(k) || k < 0 || k >= CHUNK_COUNT) {
    throw new IntegrityError(`chunk key from a tier is out of range: ${k}`);
  }
}

/** A chunk holds at least one id and at most {@link CHUNK_COUNT}; a count outside that came from a corrupt tier. */
export function assertChunkCardinalityInRange(c: number): void {
  if (!Number.isInteger(c) || c < 1 || c > CHUNK_COUNT) {
    throw new IntegrityError(`chunk cardinality from a tier is out of range: ${c}`);
  }
}

/** A segment's chunk keys, ascending — a shape read off the index, no payload. Keys are untrusted (invariant 5). */
export function checkedChunkKeys(listed: Iterable<number>): number[] {
  const keys = [...listed];
  for (const k of keys) assertChunkKeyInRange(k);
  keys.sort((a, b) => a - b);
  // A key listed twice would be read and yielded twice; the `.crbm` reader refuses one, a custom source may not.
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === keys[i - 1]) {
      throw new IntegrityError(`chunk key from a tier is listed twice: ${keys[i]}`);
    }
  }
  return keys;
}

/**
 * The other half of invariant 5: a chunk payload holds **remainders** — 16-bit offsets within one chunk — so
 * every value must be `<= 0xffff`.
 *
 * Nothing upstream establishes that. The byte cap bounds *size*, and CRC/AEAD prove the bytes are the bytes
 * that were written — which anyone able to write the bucket satisfies trivially. A value `>= 65536` would then
 * reach the id-routing step, which masks it (`remainder & 0xffff`) and emits a **fabricated id belonging to a different
 * chunk's id space**: indistinguishable from real data, inflating `count()` and creating spurious `intersect`
 * matches.
 *
 * Costs one `maximum()` per chunk, not per id — `maximum` is optional on the codec seam precisely so a codec
 * that cannot answer in O(1) opts out instead of making the read path walk every value.
 *
 * One value stands for all of them only because the decode is structurally checked. Roaring answers `maximum()`
 * from its last container, so a payload listing its containers out of order would report the wrong one's
 * largest value and pass here while holding values above 65,535. The codec's `safeDeserialize` refuses that
 * payload, and every other shape that would make this answer wrong, before it reaches this check.
 */
export function assertChunkPayloadInRange(bitmap: CodecBitmap, chunkKey: number): void {
  const max = bitmap.maximum?.();
  if (max !== undefined && max > MAX_REMAINDER) {
    throw new IntegrityError(
      `chunk ${chunkKey} payload holds value ${max}, outside the 16-bit remainder range ` +
        `[0, ${MAX_REMAINDER}] — the stored object is corrupt or was not written by this codec`,
    );
  }
}

/**
 * A chunk's stored bytes decoded under the size cap (invariant 5) and range-checked: the one place a chunk becomes a
 * bitmap, whether its bytes came from a request of its own or from a stream of coalesced ranges.
 */
export function decodeChunkBytes(
  codec: CodecInterface,
  bytes: Uint8Array,
  chunkKey: number,
  maxBitmapBytes: number,
): CodecBitmap {
  const bitmap = codec.safeDeserialize(bytes, maxBitmapBytes);
  assertChunkPayloadInRange(bitmap, chunkKey);
  return bitmap;
}
