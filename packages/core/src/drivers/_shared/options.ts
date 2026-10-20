/**
 * Option-bag checks shared by the backends and the drivers, so each states "refuse what can never be honoured" once:
 * an options value that is not an object, a key the backend does not take (named, with the keys it does), a `now` that
 * is not a function, a size that is not a positive safe integer and a switch that is not a boolean. Each throws
 * `ValidationError`, so a wiring mistake fails where it is made rather than at the first read.
 */
import {
  refuseUnknownOptions,
  requireBool,
  requireNonEmptyString,
  requirePositiveInteger,
} from '@/core/check';

export { refuseUnknownOptions, requireBool, requireNonEmptyString };
import { ValidationError } from '@/core/errors';

/** Refuse a `now` that is present and not a function. */
export function checkNow(name: string, now: unknown): void {
  if (now !== undefined && typeof now !== 'function') {
    throw new ValidationError(`${name}: \`now\` must be a function returning epoch milliseconds`);
  }
}

/**
 * The option `name`'s `value`, refused with `ValidationError` unless it is absent or a positive safe integer (a whole
 * number from 1 to 2^53 - 1): `0`, a negative, a fraction, `NaN`, an infinity and a string are refused by name. An
 * absent value comes back `undefined`, for the caller's default.
 */
export function requirePositiveInt(name: string, value: unknown): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, name);
}
