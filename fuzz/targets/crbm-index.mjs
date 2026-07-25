import { parseIndex, isCloudRoaringError, DEFAULT_MAX_PAYLOAD_BYTES } from '../build/fuzz-core.js';

/*
 * Coverage-guided fuzz target: the hand-written `.crbm` chunk-index parser (`parseIndex`), driven DIRECTLY on
 * raw bytes. This is the target that earns coverage guidance — pure, fully-instrumentable TypeScript with the
 * kind of branch-dense structure fuzzing loves: LEB128 varint decode, delta-decoded chunk keys, duplicate-key
 * detection, chunkKey ≤ 0xffff, per-chunk length/cardinality caps, and payload-offset bounds.
 *
 * Why a dedicated target: in a real read, `parseIndex` sits behind open()'s footer + index CRC32C wall, which
 * a mutational fuzzer can't cross (`crbm-reader.mjs` documents this) — so fuzzing it through the full reader
 * never reaches it. `parseIndex` is exported for this harness only (not public API; see fuzz-support.ts).
 *
 * Contract: the raw index bytes parse to a self-consistent entry set OR throw a typed CloudRoaring error (matched by the cross-bundle brand predicate) —
 * never a `RangeError`/`TypeError`/hang. (`readVarint`/`parseIndex` are provably terminating: each advances
 * ≥ 1 byte or throws, bounded by the index length.)
 */
// A fixed, generous object size so the offset-bounds check (offset + len ≤ objectSize − footer) is meaningful
// but not the dominant rejection — the fuzzer should explore the varint/delta/cap branches, not just overflow.
const OBJECT_SIZE = 1 << 24; // 16 MiB

export function fuzz(data) {
  try {
    parseIndex(Uint8Array.from(data), OBJECT_SIZE, DEFAULT_MAX_PAYLOAD_BYTES);
  } catch (err) {
    if (isCloudRoaringError(err)) return; // typed rejection is the contract
    throw err;
  }
}
