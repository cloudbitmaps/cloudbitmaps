import { parseIndex, isCloudRoaringError, DEFAULT_MAX_PAYLOAD_BYTES } from '../build/fuzz-core.js';

/*
 * Coverage-guided fuzz target: the hand-written `.crbm` chunk-index parser (`parseIndex`), driven DIRECTLY on
 * raw bytes. This is the target that earns coverage guidance — pure, fully-instrumentable TypeScript with the
 * kind of branch-dense structure fuzzing loves: LEB128 varint decode, delta-decoded chunk keys, duplicate-key
 * detection, chunkKey ≤ 0xffff, per-chunk length/cardinality caps, adjacent payloads, and payload-region bounds.
 *
 * Why a dedicated target: in a real read, `parseIndex` sits behind open()'s footer + index CRC32C wall, which
 * a mutational fuzzer can't cross (`crbm-reader.mjs` documents this) — so fuzzing it through the full reader
 * never reaches it. `parseIndex` is exported for this harness only (not public API; see fuzz-core.ts).
 *
 * Contract: the raw index bytes parse to a self-consistent entry set OR throw a typed CloudRoaring error (matched by the cross-bundle brand predicate) —
 * never a `RangeError`/`TypeError`/hang. (`readVarint`/`parseIndex` are provably terminating: each advances
 * ≥ 1 byte or throws, bounded by the index length.)
 */
// The payload region's end is part of the input: the first four bytes (little-endian) are how far past the 8-byte
// preamble the region runs, and the rest is the index. `parseIndex` accepts only an index whose payloads fill the
// region exactly with no gap, so a fixed end would make almost every input a refusal; this way the fuzzer can reach
// the accepting path and every check before it.
const PREAMBLE_BYTES = 8;

export function fuzz(data) {
  const bytes = Uint8Array.from(data);
  if (bytes.length < 4) return;
  const regionLength = new DataView(bytes.buffer).getUint32(0, true);
  try {
    parseIndex(bytes.subarray(4), PREAMBLE_BYTES + regionLength, DEFAULT_MAX_PAYLOAD_BYTES);
  } catch (err) {
    if (isCloudRoaringError(err)) return; // typed rejection is the contract
    throw err;
  }
}
