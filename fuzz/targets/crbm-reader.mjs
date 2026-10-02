import {
  CrbmReader,
  BufferReader,
  isCloudRoaringError,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from '../build/fuzz-core.js';
import { SafeBitmap, assertConsistentDecode } from '../build/fuzz-codec.js';

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
 * Each input is opened more than once, so the read paths a 1.1 extension block adds are reached too: with the default
 * tail, which holds a small object whole; with a footer-sized tail, so the index and the block come from one range
 * read, and again with every range read coming back a byte short; and with tails that start at the block, at its
 * trailer and at the index, and one byte either side of each, read from the input's own footer without trusting it.
 *
 * Contract: a typed CloudRoaring error (matched by the cross-bundle brand predicate) or a self-consistent success —
 * never a `RangeError`/native crash/hang, and never a decode `assertConsistentDecode` fails.
 */
const PROBE_KEYS = [0, 1, 256, 4096, 65535];
const FOOTER_BYTES = 104;
const EXT_TRAILER_BYTES = 12;

/** A reader of `bytes` whose range reads come back `short` bytes short, as a truncated or replaced object's can. */
function shortReader(bytes, short) {
  const inner = new BufferReader(bytes);
  return {
    getTail: (n) => inner.getTail(n),
    getRange: async (offset, length) => {
      const got = await inner.getRange(offset, length);
      return got.subarray(0, Math.max(0, got.length - short));
    },
  };
}

/** Tail sizes ending a byte either side of, and exactly at, where the input's footer says its block and index start. */
function edgeTails(bytes) {
  const tails = [];
  if (bytes.length < FOOTER_BYTES) return tails;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexOffset = Number(view.getBigUint64(bytes.length - FOOTER_BYTES, true));
  const trailer = indexOffset - EXT_TRAILER_BYTES;
  if (trailer < 0 || indexOffset > bytes.length - FOOTER_BYTES) return tails;
  const block = trailer - view.getUint32(trailer, true);
  for (const start of [indexOffset, trailer, block]) {
    for (const d of [-1, 0, 1]) {
      const tail = bytes.length - (start + d);
      if (tail > FOOTER_BYTES && tail < bytes.length) tails.push(tail);
    }
  }
  return tails;
}

/** Open `bytes` once; `undefined` on a typed refusal, which is the contract. */
async function openOnce(blob, tailBytes) {
  try {
    return await CrbmReader.open(blob, { tailBytes });
  } catch (err) {
    if (isCloudRoaringError(err)) return undefined;
    throw err;
  }
}

export async function fuzz(data) {
  const bytes = Uint8Array.from(data);
  for (const tailBytes of [FOOTER_BYTES, ...edgeTails(bytes)]) {
    await openOnce(new BufferReader(bytes), tailBytes);
  }
  await openOnce(shortReader(bytes, 1), FOOTER_BYTES);
  const reader = await openOnce(new BufferReader(bytes), undefined);
  if (reader === undefined) return;
  const keys = new Set([...reader.chunkKeys(), ...PROBE_KEYS]);
  for (const k of keys) {
    try {
      const chunk = await reader.getChunk(k);
      if (chunk !== null) {
        assertConsistentDecode(SafeBitmap.safeDeserialize(chunk, DEFAULT_MAX_PAYLOAD_BYTES));
      }
    } catch (err) {
      if (isCloudRoaringError(err)) continue; // typed rejection on one chunk is fine
      throw err;
    }
  }
}
