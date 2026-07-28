/**
 * Tombstone-aware chunk model + the effective-set merge.
 *
 * A chunk's Warm state is a delta over Cold: `{ adds, removes }`, kept **disjoint**.
 * The effective set is `(cold ∪ adds) \ removes`. This module owns that logic plus the
 * (de)serialization of a delta to the opaque bytes a Warm driver stores.
 */
import type { CodecBitmap, CodecInterface } from './codec';
import { MAX_REMAINDER } from './bit-route';
import { IntegrityError, UnsupportedError } from './errors';

export interface ChunkDelta {
  readonly adds: CodecBitmap;
  readonly removes: CodecBitmap;
}

export function emptyDelta(codec: CodecInterface): ChunkDelta {
  return { adds: codec.empty(), removes: codec.empty() };
}

/** `add(x)`: x enters `adds`, leaves `removes` — preserving the disjoint invariant (I1). */
export function applyAdd(delta: ChunkDelta, remainder: number): void {
  delta.adds.add(remainder);
  delta.removes.remove(remainder);
}

/** `remove(x)`: x enters `removes`, leaves `adds` — preserving the disjoint invariant (I1). */
export function applyRemove(delta: ChunkDelta, remainder: number): void {
  delta.removes.add(remainder);
  delta.adds.remove(remainder);
}

/**
 * `add` for a whole batch at once — set-wise, not id-by-id.
 *
 * Identical in meaning to calling {@link applyAdd} for every remainder in `ids`, including the disjoint
 * invariant (I1): everything added leaves `removes`. It exists because the streaming `addMany` path already
 * holds its pending ids as a bitmap, and folding that in with two native set operations rather than 2N of them
 * is the difference between one call and millions.
 */
export function applyAddAll(delta: ChunkDelta, ids: CodecBitmap): void {
  delta.adds.orInPlace(ids);
  delta.removes.andNotInPlace(ids);
}

/** {@link applyAddAll}'s mirror: `remove` for a whole batch, preserving the same disjoint invariant. */
export function applyRemoveAll(delta: ChunkDelta, ids: CodecBitmap): void {
  delta.removes.orInPlace(ids);
  delta.adds.andNotInPlace(ids);
}

/** The effective set of a chunk: `(cold ∪ adds) \ removes`. Does not mutate its inputs. */
export function effective(cold: CodecBitmap, delta: ChunkDelta): CodecBitmap {
  const out = cold.clone();
  out.orInPlace(delta.adds);
  out.andNotInPlace(delta.removes);
  return out;
}

/**
 * Current Warm-row delta schema version — a pre-1.0 format-freeze prerequisite (Phase G). The delta is
 * an internal cross-tier transport, not a user-facing format, but a **1-byte version prefix** lets a reader
 * fail-closed on bytes written by a future, incompatible writer instead of misparsing them — the pre-1.0
 * format-freeze guarantee. Bump only on a backward-incompatible layout change; a reader rejects any version
 * it doesn't recognize (`UnsupportedError`). The versioned on-disk Cold format is `.crbm` (Phase 2).
 */
export const WARM_DELTA_VERSION = 1;
const VERSION_BYTES = 1;
const HEADER_BYTES = 4; // u32 LE addsLen, after the version byte

/** Encode a delta to bytes: `[u8 version][u32 LE addsLen][adds portable][removes portable]`. */
export function encodeDelta(delta: ChunkDelta): Uint8Array {
  const adds = delta.adds.serialize();
  const removes = delta.removes.serialize();
  const out = new Uint8Array(VERSION_BYTES + HEADER_BYTES + adds.length + removes.length);
  out[0] = WARM_DELTA_VERSION;
  new DataView(out.buffer).setUint32(VERSION_BYTES, adds.length, true);
  out.set(adds, VERSION_BYTES + HEADER_BYTES);
  out.set(removes, VERSION_BYTES + HEADER_BYTES + adds.length);
  return out;
}

/**
 * Decode a delta from bytes, size-capping each bitmap (S1). Rejects an unrecognized schema version with
 * `UnsupportedError` (fail-closed) and malformed bytes with `IntegrityError`.
 */
export function decodeDelta(
  bytes: Uint8Array,
  maxBitmapBytes: number,
  codec: CodecInterface,
): ChunkDelta {
  if (bytes.length < VERSION_BYTES + HEADER_BYTES) {
    throw new IntegrityError(`delta too short: ${bytes.length}B`);
  }
  const version = bytes[0];
  if (version !== WARM_DELTA_VERSION) {
    throw new UnsupportedError(
      `Warm delta schema version ${version} is unsupported (this build reads v${WARM_DELTA_VERSION})`,
    );
  }
  // Cap the whole row, not just each half — a hostile Warm tier shouldn't be able to amplify a chunk
  // to ~2× the per-bitmap cap before the per-bitmap checks fire.
  const totalCap = 2 * maxBitmapBytes + VERSION_BYTES + HEADER_BYTES;
  if (bytes.length > totalCap) {
    throw new IntegrityError(`delta is ${bytes.length}B, exceeds cap ${totalCap}B`);
  }
  const addsStart = VERSION_BYTES + HEADER_BYTES;
  const addsLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    VERSION_BYTES,
    true,
  );
  const addsEnd = addsStart + addsLen;
  if (addsLen > bytes.length - addsStart) {
    throw new IntegrityError(
      `delta addsLen ${addsLen} exceeds payload ${bytes.length - addsStart}`,
    );
  }
  const adds = codec.safeDeserialize(bytes.subarray(addsStart, addsEnd), maxBitmapBytes);
  const removes = codec.safeDeserialize(bytes.subarray(addsEnd), maxBitmapBytes);
  // A warm delta is a CHUNK payload: both halves hold 16-bit remainders. Same reasoning as the cold path in
  // the engine — the length checks above bound size, and CRC/AEAD only prove the bytes are the bytes that were
  // written, so a corrupt or hostile row can still carry a value >= 65536 that `joinId` would mask into a
  // fabricated id in another chunk's space. One `maximum()` per half, not per id.
  assertRemainderRange(adds, 'adds');
  assertRemainderRange(removes, 'removes');
  return { adds, removes };
}

/** Shared by both delta halves; `maximum` is optional on the seam, so a codec without it opts out. */
function assertRemainderRange(bitmap: CodecBitmap, half: 'adds' | 'removes'): void {
  const max = bitmap.maximum?.();
  if (max !== undefined && max > MAX_REMAINDER) {
    throw new IntegrityError(
      `warm delta ${half} holds value ${max}, outside the 16-bit remainder range [0, ${MAX_REMAINDER}] — ` +
        `the stored row is corrupt or was not written by this codec`,
    );
  }
}
