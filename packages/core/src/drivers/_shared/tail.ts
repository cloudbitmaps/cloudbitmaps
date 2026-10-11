import { ValidationError } from '@/core/errors';

/**
 * Check the length a `getTail` asks for: a whole number. The tail is the last `min(maxBytes, size)` bytes, so zero or
 * less is an empty tail with the size, and a length past the object's size answers the whole object. `NaN`, a
 * fraction and an infinity are refused, so no driver reads one as some other length.
 */
export function checkTailLength(maxBytes: number): void {
  if (!Number.isInteger(maxBytes)) {
    throw new ValidationError(`invalid tail length ${maxBytes}`);
  }
}
