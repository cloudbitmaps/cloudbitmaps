/**
 * The default {@link Entropy}: the platform's Web Crypto, the production half of the seam a generation's write
 * identity is drawn through.
 *
 * It lives outside `core/`, which may reach no global, and it draws on use, not at construction, so a process that
 * only reads runs on a runtime without Web Crypto. `Math.random` is never a fallback: an identity that two writers
 * could draw alike is no identity.
 */
import { UnsupportedError } from '@cloudbitmaps/core';
import type { Entropy } from '@cloudbitmaps/core';

/** `length` random bytes from `crypto.getRandomValues`; {@link UnsupportedError} on a runtime that has none. */
export const systemEntropy: Entropy = (length) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c === undefined || typeof c.getRandomValues !== 'function') {
    throw new UnsupportedError(
      "this runtime has no Web Crypto (crypto.getRandomValues), which every load needs for its generation's " +
        'write identity: run on a runtime that has it, or pass `seams.entropy`',
    );
  }
  return c.getRandomValues(new Uint8Array(length));
};
