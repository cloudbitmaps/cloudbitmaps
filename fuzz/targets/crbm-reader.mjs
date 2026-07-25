import {
  CrbmReader,
  BufferReader,
  isCloudRoaringError,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from '../build/fuzz-core.js';
import { SafeBitmap } from '../build/fuzz-codec.js';

/*
 * Coverage-guided fuzz target: the `.crbm` reader's FRONT — `CrbmReader.open` (footer magic/CRC · version ·
 * flags · element_width/serialization/codec · index bounds + size cap · footer↔index cross-checks) and, on the
 * seed corpus's valid files, `getChunk` + `safeDeserialize`.
 *
 * IMPORTANT scope note (why this is the "front", not the "full chain"): open() gates the index parser and the
 * payload deserialize behind a triple CRC32C wall (footer CRC, index CRC, per-chunk payload CRC). A mutational
 * fuzzer cannot satisfy a CRC32C, so evolved inputs almost never reach `parseIndex`/`getChunk`/native-decode —
 * they exercise open()'s validation + the CRC-rejection paths (which is real, coverage-guided value). The
 * CRC-gated deep surfaces are fuzzed elsewhere: the hand-written index parser by `crbm-index.mjs` (direct, past
 * the wall) and the native deserializer by `safe-deserialize.mjs` (direct, ungated); the deterministic
 * crafted-hostile suite (tests/core/crbm/crafted.test.ts) forges valid-CRC hostile indexes too.
 *
 * Contract: a typed CloudRoaring error (matched by the cross-bundle brand predicate) or a self-consistent success — never a `RangeError`/native crash/hang.
 */
const PROBE_KEYS = [0, 1, 256, 4096, 65535];

export async function fuzz(data) {
  let reader;
  try {
    reader = await CrbmReader.open(new BufferReader(Uint8Array.from(data)));
  } catch (err) {
    if (isCloudRoaringError(err)) return; // rejected at open() — the contract
    throw err;
  }
  const keys = new Set([...reader.chunkKeys(), ...PROBE_KEYS]);
  for (const k of keys) {
    try {
      const bytes = await reader.getChunk(k);
      if (bytes !== null) SafeBitmap.safeDeserialize(bytes, DEFAULT_MAX_PAYLOAD_BYTES).toArray();
    } catch (err) {
      if (isCloudRoaringError(err)) continue; // typed rejection on one chunk is fine
      throw err;
    }
  }
}
