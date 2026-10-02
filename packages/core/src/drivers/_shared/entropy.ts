/**
 * The default entropy a shipped registry draws its tokens' random parts from: the platform's Web Crypto.
 *
 * Kept apart from the record helpers, which are pure, because this reads an ambient global. It is checked when a
 * row is written, not when a registry is built, so a process that only reads runs on a runtime without it.
 */
import { UnsupportedError } from '@/core/errors';
import type { Entropy } from '@/core/determinism';

interface WebCrypto {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/** The platform's Web Crypto, or `undefined` when this runtime has none. */
function webCrypto(): WebCrypto | undefined {
  const c = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  return c !== undefined && typeof c.getRandomValues === 'function' ? (c as WebCrypto) : undefined;
}

/** Draws from the platform's Web Crypto; `UnsupportedError` on a runtime without it. */
export const webCryptoEntropy: Entropy = (length) => {
  const c = webCrypto();
  if (c === undefined) {
    throw new UnsupportedError(
      'this runtime has no Web Crypto (crypto.getRandomValues), which a registry needs for the token of every ' +
        'row it writes: run on a runtime that has it',
    );
  }
  return c.getRandomValues(new Uint8Array(length));
};

/** Whether `entropy` can draw here: an injected source always, the default only where Web Crypto exists. */
export function entropyIsAvailable(entropy: Entropy): boolean {
  return entropy !== webCryptoEntropy || webCrypto() !== undefined;
}
