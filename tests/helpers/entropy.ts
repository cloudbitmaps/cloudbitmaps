import type { Entropy } from '@/core/determinism';
import { FOOTER, FOOTER_BYTES } from '@/core/crbm/format';

/**
 * The deterministic sources a test injects where production draws a write's identity, so a run replays byte for byte.
 * Never use one outside a test: a source that repeats makes the objects it writes alike again.
 */

/** Always zeros: the footer an object written before the write identity existed carries. */
export const zeroEntropy: Entropy = (length) => new Uint8Array(length);

/**
 * A fresh source whose n-th draw (counting from 1) is `n` as a little-endian counter, padded with `fill`. Two draws
 * differ, two sources started alike draw alike, which is what a test needs to tell "this write" from "that write"
 * and to replay either.
 */
export function counterEntropy(fill = 0xa5): Entropy {
  let n = 0;
  return (length) => {
    n += 1;
    const out = new Uint8Array(length).fill(fill);
    let v = n;
    for (let i = 0; i < Math.min(length, 4); i++) {
      out[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    return out;
  };
}

/** Draws the given bytes every time (a fixed identity, for a golden file). */
export function fixedEntropy(bytes: Uint8Array): Entropy {
  return (length) => {
    if (bytes.length !== length)
      throw new Error(`fixedEntropy holds ${bytes.length} bytes, asked ${length}`);
    return Uint8Array.from(bytes);
  };
}

/** Records every draw's length and returns the bytes of its inner source. */
export function recordingEntropy(inner: Entropy): { entropy: Entropy; draws: number[] } {
  const draws: number[] = [];
  return {
    draws,
    entropy: (length) => {
      draws.push(length);
      return inner(length);
    },
  };
}

/** The write identity the cleartext golden files carry: twelve distinct bytes, so an offset or a width slip shows. */
export const GOLDEN_NONCE = Uint8Array.from({ length: 12 }, (_, i) => 0xc0 + i);

/**
 * One counter source shared by everything a test file builds with it, so two loaders sharing no state still never draw
 * alike within the file, and the whole run replays the same. A test of a write identity makes its own source.
 */
export const testEntropy: Entropy = counterEntropy(0x5a);

/**
 * An object's bytes with its write identity masked: the footer's `indexNonce` field and the footer checksum that covers it
 * zeroed. Two loads of the same ids are the same object but for exactly these bytes, which is what a test that
 * compares what two paths wrote asks.
 */
export function withoutWriteIdentity(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  const footer = out.length - FOOTER_BYTES;
  out.fill(0, footer + FOOTER.indexNonce, footer + FOOTER.indexNonce + 12);
  out.fill(0, footer + FOOTER.footerCrc32c, footer + FOOTER.footerCrc32c + 4);
  return out;
}
