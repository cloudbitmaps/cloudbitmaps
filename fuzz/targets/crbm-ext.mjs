import { parseExtension, isCloudRoaringError, IntegrityError } from '../build/fuzz-core.js';

/*
 * Coverage-guided fuzz target: the `.crbm` 1.1 extension block's sections (`parseExtension`), driven DIRECTLY on raw
 * bytes. In a real read they sit behind the block's own CRC32C, which a mutational fuzzer cannot satisfy, so
 * `crbm-reader.mjs` reaches only the trailer checks in front of it. Past that wall are the section walk (a u8 type and
 * a u32 length each, ascending, filling the block exactly) and the metadata record: untrusted bytes through a fatal
 * UTF-8 decode, `JSON.parse`, the metadata rules and the canonical-form check. `parseExtension` is exported for this
 * harness only (not public API; see fuzz-core.ts). Each input is parsed twice: as a cleartext object's sections, and as
 * an encrypted one's, under a key whose every open fails, since no mutation passes an AEAD; that second pass reaches
 * the sealed section's own checks, its length and the failure it reports.
 *
 * Contract: the bytes parse to a metadata record (or none) OR throw a typed CloudRoaring error (matched by the
 * cross-bundle brand predicate) — never a `RangeError`/`TypeError`/hang.
 */
const failingCrypto = {
  aead: {
    seal: () => {
      throw new IntegrityError('the fuzz target seals nothing');
    },
    open: () => {
      throw new IntegrityError('AEAD authentication failed');
    },
  },
  aadFor: () => new Uint8Array(0),
};

export function fuzz(data) {
  const bytes = Uint8Array.from(data);
  for (const crypto of [undefined, failingCrypto]) {
    try {
      parseExtension(bytes, crypto);
    } catch (err) {
      if (isCloudRoaringError(err)) continue; // typed rejection is the contract
      throw err;
    }
  }
}
