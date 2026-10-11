/**
 * Number checks shared by every option and argument the core validates, so a bad number is refused by one rule and
 * worded one way: `<what> must be <a range>; got <the value>`. Each throws `ValidationError` and returns the value it
 * accepted, so a call can wrap the expression that produced it. Pure: no I/O, time or globals.
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

/** A value as a message shows it: a string quoted (so `'200'` is not mistaken for `200`), another type by its name. */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return value === null ? 'null' : typeof value;
}

/** `from <min> to <max>`, `of at least <min>` or `of at most <max>`, or nothing when neither bound is set. */
function rangeOf(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return ` from ${min} to ${max}`;
  if (min !== undefined) return ` of at least ${min}`;
  if (max !== undefined) return ` of at most ${max}`;
  return '';
}

/**
 * `value` if it is a safe integer from `min` to `max` (inclusive; `max` defaults to the largest safe integer), else a
 * `ValidationError` naming `what`: `<what> must be an integer from <min> to <max>; got <value>`.
 */
export function requireInteger(
  value: unknown,
  bounds: { readonly min: number; readonly max?: number; readonly what: string },
): number {
  const { min, max, what } = bounds;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new ValidationError(
      `${what} must be an integer${rangeOf(min, max)}; got ${shown(value)}`,
    );
  }
  return value;
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
  bounds: { readonly min?: number; readonly max?: number; readonly what: string },
): number {
  const { min, max, what } = bounds;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    throw new ValidationError(
      `${what} must be a finite number${rangeOf(min, max)}; got ${shown(value)}`,
    );
  }
  return value;
}
