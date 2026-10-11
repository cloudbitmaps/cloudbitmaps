import { ValidationError } from '@/core/errors';

/**
 * Check the length a `getTail` asks for: a whole, non-negative, safe integer. `0` is allowed (it asks for the size
 * only), and a length past the object's size is allowed (it answers the whole object). Anything else — `NaN`, a
 * fraction, a negative, an infinity — is refused, so no driver reads it as some other length.
 */
export function checkTailLength(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ValidationError(`invalid tail length ${maxBytes}`);
  }
}
