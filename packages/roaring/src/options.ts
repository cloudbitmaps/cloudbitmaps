/**
 * The shape checks every call that takes an options bag makes before it reads or writes anything: the bag is an
 * object, it names only keys the call takes, and each switch is a boolean. The per-call key tables stay with the
 * facade, because each is held to the options type it describes.
 */
import { ValidationError } from '@cloudbitmaps/core';

/** A key of `T` that `K` does not list: a key table missing one fails to compile. */
type Unlisted<T, K extends readonly PropertyKey[]> = Exclude<keyof T, K[number]>;

/** The keys of `T`, every one of them, as a table the options check below reads. */
export const keysOf =
  <T>() =>
  <const K extends readonly (keyof T & string)[]>(
    keys: K & ([Unlisted<T, K>] extends [never] ? unknown : never),
  ): readonly string[] =>
    keys;

/** How a value of the wrong kind is named in a message: by its kind, never by its content. */
export const kindOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`;

/**
 * Why `options` cannot be a call's options, or `undefined` when it can. `undefined` and `null` read as none; anything
 * but an object is refused, and so is a key `known` does not list, unless its value is `undefined`, so a spread of
 * options keeps working; and each of `booleans` present must be a boolean, `null` included. A bag of the wrong shape, a misspelt key or
 * a switch given as a string would otherwise read as no option at all, and silently widen what the call does: a scope
 * passed as a string swept every namespace, and `dryRun: 'true'` deleted.
 *
 * `misplaced` names the keys of a wider options type that the call does not take, such as `exclude` on `andNot`, which
 * shares its options type with the combines that do. Each is read by name, so one inherited from a prototype or held
 * in a getter, which `Object.keys` does not list, is refused as an own key is, rather than dropped without a word.
 */
export function optionsError(
  options: unknown,
  op: string,
  known: readonly string[],
  booleans: readonly string[] = [],
  misplaced: readonly string[] = [],
): ValidationError | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== 'object' || Array.isArray(options)) {
    return new ValidationError(`${op}: options must be an object; got ${kindOf(options)}`);
  }
  const bag = options as Record<string, unknown>;
  const unknown = Object.keys(bag).filter((k) => !known.includes(k) && bag[k] !== undefined);
  for (const k of misplaced) if (!unknown.includes(k) && bag[k] !== undefined) unknown.push(k);
  if (unknown.length > 0) {
    return new ValidationError(
      `${op}: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}; ` +
        `it takes { ${known.join(', ')} }`,
    );
  }
  // An `audit` that is not a sink would receive nothing and say nothing: refused here, before the call reads or scans
  // anything, as the core entries refuse it before they write.
  const audit = bag.audit;
  if (
    audit !== undefined &&
    audit !== null &&
    typeof (audit as { onEvent?: unknown }).onEvent !== 'function'
  ) {
    return new ValidationError(
      `${op}: audit must be a sink with an onEvent(event) method, such as a RecordingAuditSink`,
    );
  }
  // A switch is `true` or `false`. `null` is refused with the rest: read as absent, `dryRun: null` dropped for real.
  for (const name of booleans) {
    const v = bag[name];
    if (v !== undefined && typeof v !== 'boolean') {
      return new ValidationError(`${op}: \`${name}\` must be a boolean; got ${kindOf(v)}`);
    }
  }
  return undefined;
}

/**
 * The keys of `options` a call takes, each read by name. A spread copies only own enumerable properties, so an option
 * held in a getter or inherited from a prototype, which TypeScript accepts and {@link optionsError} reads, would pass
 * the checks and then be dropped: a `dryRun` so held ran a real sweep, and a `namespace` exported every tenant. The
 * call then reads the copy only, so it runs with exactly what was checked.
 */
export function picked<T extends object>(
  options: T | null | undefined,
  keys: readonly string[],
): Partial<T> {
  const out: Record<string, unknown> = {};
  if (options === undefined || options === null) return out as Partial<T>;
  for (const key of keys) {
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** {@link optionsError}, thrown: for a call that rejects, rather than one that returns a stream. */
export function checkOptions(
  options: unknown,
  op: string,
  known: readonly string[],
  booleans?: readonly string[],
  misplaced?: readonly string[],
): void {
  const err = optionsError(options, op, known, booleans, misplaced);
  if (err !== undefined) throw err;
}
