/**
 * Number checks shared by every option and argument the core validates, so a bad number is refused by one rule and
 * worded one way: `<what> must be <a range>; got <the value>`. Each throws `ValidationError` and returns the value it
 * accepted, so a call can wrap the expression that produced it. Pure: no I/O, time or globals.
 *
 * A `note` is a short clause set after the range (`must be an integer of at least 0 (required); got undefined`), for
 * what the range alone does not say.
 *
 * ```
 * requireInteger(1.5, { min: 1, max: 8, what: 'concurrency' })
 *   -> ValidationError: concurrency must be an integer from 1 to 8; got 1.5
 * requirePositiveInteger('3', 'limit')
 *   -> ValidationError: limit must be an integer of at least 1; got "3"
 * requireFiniteNumber(Infinity, { min: 0, what: 'tombstoneGraceMs' })
 *   -> ValidationError: tombstoneGraceMs must be a finite number of at least 0; got Infinity
 * ```
 *
 * Integers are safe integers: 2^53 and above are refused, whatever the bounds say.
 */
import { ValidationError } from './errors';

/**
 * A value as a message shows it: a number or boolean as itself, a bigint with an `n` (so `5n` is not mistaken for
 * `5`), a string quoted (so `'200'` is not mistaken for `200`), and anything else by its type.
 */
export function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null ? 'null' : typeof value;
}

/**
 * `from <min> to <max>`, `of at least <min>` or `of at most <max>`, or nothing when neither bound is set, then the
 * `note` in parentheses when there is one.
 */
function rangeOf(
  min: number | undefined,
  max: number | undefined,
  note: string | undefined,
): string {
  let range = '';
  if (min !== undefined && max !== undefined) range = ` from ${min} to ${max}`;
  else if (min !== undefined) range = ` of at least ${min}`;
  else if (max !== undefined) range = ` of at most ${max}`;
  return note === undefined ? range : `${range} (${note})`;
}

/**
 * `value` if it is a safe integer from `min` to `max` (inclusive; `max` defaults to the largest safe integer), else a
 * `ValidationError` naming `what`: `<what> must be an integer from <min> to <max>; got <value>`.
 */
export function requireInteger(
  value: unknown,
  bounds: {
    readonly min: number;
    readonly max?: number;
    readonly what: string;
    readonly note?: string;
  },
): number {
  const { min, max, what, note } = bounds;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new ValidationError(
      `${what} must be an integer${rangeOf(min, max, note)}; got ${shown(value)}`,
    );
  }
  return value;
}

/**
 * Refuse a `requireEncryption` that is present and not exactly a boolean. Every site that acts on the flag compares it
 * with `=== true`, so a truthy string would be taken for `true` by one and for `false` by another.
 */
export function checkRequireEncryption(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ValidationError(`requireEncryption must be a boolean; got ${shown(value)}`);
  }
}

/** `value` if it is a safe integer of 1 or more, else a `ValidationError` naming `what`. */
export function requirePositiveInteger(value: unknown, what: string): number {
  return requireInteger(value, { min: 1, what });
}

/**
 * `value` if it is a finite number within the optional `min` and `max` (inclusive), else a `ValidationError` naming
 * `what`: `<what> must be a finite number from <min> to <max>; got <value>`. `NaN` and the infinities are refused.
 */
export function requireFiniteNumber(
  value: unknown,
  bounds: {
    readonly min?: number;
    readonly max?: number;
    readonly what: string;
    readonly note?: string;
  },
): number {
  const { min, max, what, note } = bounds;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    throw new ValidationError(
      `${what} must be a finite number${rangeOf(min, max, note)}; got ${shown(value)}`,
    );
  }
  return value;
}

/**
 * Refuse an options bag that is not an object, or that holds a key not in `keys`, naming each such key and the keys it
 * takes. `hint`, when given, ends the message, to point at where a likely mistake belongs (`an S3 client goes in
 * \`client\``). Only the bag's own enumerable string keys are read, so a key inherited through a prototype is not
 * checked.
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

/**
 * The option `name`'s `value`, refused with `ValidationError` unless it is absent or a boolean: a truthy string or a
 * `1` is not taken for `true`, and `null` is not taken for absent. An absent value comes back `undefined`, for the
 * caller's default.
 */
export function requireBool(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${name} must be a boolean; got ${shown(value)}`);
  }
  return value;
}

/**
 * The option `name`'s `value`, refused with `ValidationError` unless it is absent or a string with something in it
 * (one that is empty or only whitespace is refused, as is `null`). An absent value comes back `undefined`.
 */
export function requireNonEmptyString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(
      `${name} must be a non-empty string; got ${typeof value === 'string' ? 'an empty string' : shown(value)}`,
    );
  }
  return value;
}
