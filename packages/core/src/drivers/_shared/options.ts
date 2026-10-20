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
  shown,
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

const DELETE_OPTION_KEYS: readonly string[] = ['ifVersion'];
const WRITE_OPTION_KEYS: readonly string[] = ['held', 'onToken'];

/**
 * The per-call options of a storage port's `delete`, checked: absent, or an object holding only `ifVersion`, a string.
 * A misspelt key would otherwise read as no condition and delete whatever is under the key. Returns the `ifVersion`.
 */
export function checkDeleteOptions(options: unknown): string | undefined {
  if (options === undefined) return undefined;
  refuseUnknownOptions('delete options', options, DELETE_OPTION_KEYS);
  const { ifVersion } = options as { ifVersion?: unknown };
  if (ifVersion !== undefined && typeof ifVersion !== 'string') {
    throw new ValidationError(
      `delete options: \`ifVersion\` must be a string; got ${shown(ifVersion)}`,
    );
  }
  return ifVersion;
}

/**
 * The per-call options of a registry port's `create` and `compareAndSwap`, checked: absent, or an object holding only
 * `held` (a record or `null`) and `onToken` (a function). A misspelt key would otherwise drop the hint or the token report
 * a publish relies on.
 */
export function checkRegistryWriteOptions(options: unknown): void {
  if (options === undefined) return;
  refuseUnknownOptions('write options', options, WRITE_OPTION_KEYS);
  const { held, onToken } = options as { held?: unknown; onToken?: unknown };
  if (held !== undefined && held !== null && typeof held !== 'object') {
    throw new ValidationError(
      `write options: \`held\` must be a registry record or null; got ${shown(held)}`,
    );
  }
  if (onToken !== undefined && typeof onToken !== 'function') {
    throw new ValidationError(
      `write options: \`onToken\` must be a function; got ${shown(onToken)}`,
    );
  }
}
