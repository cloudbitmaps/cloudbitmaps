/**
 * Option-bag checks shared by the backends, so each states "refuse what can never be honoured" once: an options value
 * that is not an object, a key the backend does not take (named, with the keys it does), and a `now` that is not a
 * function.
 */
import { ValidationError } from '@/core/errors';

/** Refuse an options bag that is not an object, or that holds a key not in `keys`, naming each such key. */
export function refuseUnknownOptions(
  name: string,
  options: unknown,
  keys: readonly string[],
): void {
  if (options === null || typeof options !== 'object') {
    throw new ValidationError(
      `${name} needs an options object — got ${options === null ? 'null' : typeof options}`,
    );
  }
  const unknown = Object.keys(options).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    const list = (ks: readonly string[]): string => ks.map((k) => `\`${k}\``).join(', ');
    throw new ValidationError(`${name} does not take ${list(unknown)}. It takes ${list(keys)}.`);
  }
}

/** Refuse a `now` that is present and not a function. */
export function checkNow(name: string, now: unknown): void {
  if (now !== undefined && typeof now !== 'function') {
    throw new ValidationError(`${name}: \`now\` must be a function returning epoch milliseconds`);
  }
}
