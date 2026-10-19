/**
 * Option-bag checks shared by the backends and the drivers, so each states "refuse what can never be honoured" once:
 * an options value that is not an object, a key the backend does not take (named, with the keys it does), a `now` that
 * is not a function, a size that is not a positive safe integer and a switch that is not a boolean. Each throws
 * `ValidationError`, so a wiring mistake fails where it is made rather than at the first read.
 */
import { requirePositiveInteger } from '@/core/check';
import { ValidationError } from '@/core/errors';

/**
 * Refuse an options bag that is not an object, or that holds a key not in `keys`, naming each such key and the keys it
 * takes. `hint`, when given, ends the message, to point at where a likely mistake belongs (`an S3 client goes in
 * \`client\``). Only the bag's own enumerable string keys are read.
 */
export function refuseUnknownOptions(
  name: string,
  options: unknown,
  keys: readonly string[],
  hint?: string,
): void {
  if (options === null || typeof options !== 'object') {
    throw new ValidationError(
      `${name} needs an options object — got ${options === null ? 'null' : typeof options}`,
    );
  }
  const unknown = Object.keys(options).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    const list = (ks: readonly string[]): string => ks.map((k) => `\`${k}\``).join(', ');
    throw new ValidationError(
      `${name} does not take ${list(unknown)}. It takes ${list(keys)}${hint === undefined ? '' : `; ${hint}`}.`,
    );
  }
}

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

/**
 * The option `name`'s `value`, refused with `ValidationError` unless it is absent or a boolean: a truthy string or a
 * `1` is not taken for `true`. An absent value comes back `undefined`, for the caller's default.
 */
export function requireBool(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${name} must be a boolean; got ${shown(value)}`);
  }
  return value;
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

/** A value as a message shows it: a string quoted, so `'200'` is not mistaken for `200`, and never a throw. */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return value === null ? 'null' : typeof value;
}
