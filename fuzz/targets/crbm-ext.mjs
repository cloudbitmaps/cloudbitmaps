import { parseExtension, isCloudRoaringError } from '../build/fuzz-core.js';

/*
 * Coverage-guided fuzz target: the `.crbm` 1.1 extension block's sections (`parseExtension`), driven DIRECTLY on raw
 * bytes. In a real read they sit behind the block's own CRC32C, which a mutational fuzzer cannot satisfy, so
 * `crbm-reader.mjs` reaches only the trailer checks in front of it. Past that wall are the section walk (a u8 type and
 * a u32 length each, ascending, filling the block exactly) and the metadata record: untrusted bytes through a fatal
 * UTF-8 decode, `JSON.parse`, the metadata rules and the canonical-form check. `parseExtension` is exported for this
 * harness only (not public API; see fuzz-core.ts). Cleartext: an encrypted section is an AEAD open, which no mutation
 * passes.
 *
 * Contract: the bytes parse to a metadata record (or none) OR throw a typed CloudRoaring error (matched by the
 * cross-bundle brand predicate) — never a `RangeError`/`TypeError`/hang.
 */
export function fuzz(data) {
  try {
    parseExtension(Uint8Array.from(data), undefined);
  } catch (err) {
    if (isCloudRoaringError(err)) return; // typed rejection is the contract
    throw err;
  }
}
