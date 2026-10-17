/**
 * Remove credentials from an error the Azure SDK raised, before the driver throws it or keeps it as a `cause`.
 *
 * A `RestError` keeps the request it sent on `request`, and the response it got on `response` (whose `request` is the
 * same one), on properties `util.inspect` and `JSON.stringify` hide. The request holds the signed `Authorization`
 * header (`SharedKey <account>:<signature>`, or a bearer token) and, with a SAS credential, the signature in its URL
 * (`sig=`). Those objects are live (the pipeline may still read them), so nothing is ever changed in place: an error
 * that holds one, or whose text shows a credential, is replaced by a deep copy of its plain data, the way the GCS
 * driver does it. An error with neither is returned as it is.
 *
 * The copy is a native error with the original's prototype (so `instanceof RestError` holds), name, message, stack,
 * `code`, `statusCode` and `details`, which is what classification reads. It has no transport property, no function
 * or accessor (a `toJSON` or `util.inspect` hook is a closure over the original) and no class instance other than an
 * error. Errors are copied wherever they sit: the `cause` chain, an `AggregateError`'s `errors`, any array or field.
 * A table of copies keeps a cycle a cycle, and anything nested deeper than `MAX_DEPTH` is dropped rather than kept raw.
 * A credential in the copy's text (an `Authorization` header line or scheme value, a `sig=` value in any of its
 * encoded forms, the SharedKey signature Azure echoes in a 403 body) or under a credential key is redacted.
 */

import { types } from 'node:util';

/** Properties that hold the raw transport: the request, the response and what is reachable from them. */
const TRANSPORT = new Set([
  'request',
  'response',
  '_response',
  'socket',
  '_httpMessage',
  'req',
  'res',
  'connection',
  'agent',
]);
/** Header and field names whose value is a credential. */
const CREDENTIAL_NAME =
  /^(?:proxy-)?authorization$|^cookie$|^set-cookie$|^x-api-key$|^x-ms-copy-source-authorization$|^x-ms-encryption-key$|^x-identity-header$|^signature$|^sig$/i;
/** A credential header line inside raw request or response text. */
const CREDENTIAL_LINES =
  /^((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-ms-copy-source-authorization):[^\r\n]*/gim;
/**
 * A SAS signature in a URL, a query string or text that quotes one: after `?`, `&`, `;`, a space, a quote, at the start,
 * or percent-encoded (`%26`, `%3F`) or JSON-escaped (`\u0026`); its `=` may be `%3D` and its value quoted.
 */
const SAS_SIGNATURE =
  /((?:^|[^A-Za-z0-9_]|%26|%3F|\\u0026)sig(?:=|%3D)["']?)(?:(?!%26|\\u0026)[^&\s"'<>)\\])*/gi;
/** An `Authorization` scheme and its value, wherever the text shows it. */
const AUTH_SCHEME = /\b(SharedKey(?:Lite)?|Bearer)(\s+)[A-Za-z0-9\-._~+/:]{16,}=*/gi;
/** The signature Azure echoes in the 403 body for a SharedKey request it could not verify. */
const MAC_ECHO = /(MAC signature found in the HTTP request ')[^']*/g;
const REDACTED = '[redacted]';
/** How deep into errors and plain data the copy goes; anything below is dropped. */
const MAX_DEPTH = 10;

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isError = (value: object): boolean => value instanceof Error || types.isNativeError(value);

/**
 * `text` with every credential it shows replaced. A text the patterns cannot finish matching (one of several MiB that
 * exhausts the regular expression engine's stack) is replaced whole, so a hostile body neither leaks nor changes the
 * error the driver throws.
 */
function redactText(text: string): string {
  try {
    return text
      .replace(CREDENTIAL_LINES, `$1: ${REDACTED}`)
      .replace(SAS_SIGNATURE, `$1${REDACTED}`)
      .replace(AUTH_SCHEME, `$1$2${REDACTED}`)
      .replace(MAC_ECHO, `$1${REDACTED}`);
  } catch {
    return REDACTED;
  }
}

/** The copies made so far, and whether any differs from its original. */
interface Copying {
  copies: WeakMap<object, unknown>;
  changed: boolean;
}

/** Marker for a value the copy leaves out. */
const OMIT = Symbol('omit');

/** An array index as an own key spells it. */
const INDEX = /^(?:0|[1-9]\d*)$/;
const isIndex = (key: string | symbol): key is string =>
  typeof key === 'string' && INDEX.test(key) && Number(key) < 2 ** 32 - 1;

/**
 * Whether `value` has an own property its copy leaves out: any key but an index and `length` on an array, any key at
 * all on a map or a set.
 */
function hasNamedKeys(value: object): boolean {
  if (!Array.isArray(value)) return Reflect.ownKeys(value).length > 0;
  return Reflect.ownKeys(value).some((key) => key !== 'length' && !isIndex(key));
}

/** Define `key` on `copy` as a plain data property. */
function define(copy: object, key: string | symbol, value: unknown, enumerable: boolean): void {
  Object.defineProperty(copy, key, { value, writable: true, configurable: true, enumerable });
}

/** A credential-free copy of `value`: plain data and errors only, `OMIT` for anything else. */
function copyOf(value: unknown, ctx: Copying, depth: number): unknown {
  if (typeof value === 'string') {
    const clean = redactText(value);
    if (clean !== value) ctx.changed = true;
    return clean;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    ctx.changed = true;
    return OMIT;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (ctx.copies.has(value)) return ctx.copies.get(value);
  if (depth > MAX_DEPTH) {
    ctx.changed = true;
    return OMIT;
  }
  if (Array.isArray(value)) return copyList(value as unknown[], ctx, depth);
  if (value instanceof Map) return copyMap(value as Map<unknown, unknown>, ctx, depth);
  if (value instanceof Set) return copySet(value as Set<unknown>, ctx, depth);
  return copyRecord(value, ctx, depth);
}

/**
 * A copy of an array, as sparse as the original: only its own indexes are read, so a hole costs nothing. A named
 * property, and an index that is an accessor (it is not called), are left out.
 */
function copyList(value: unknown[], ctx: Copying, depth: number): unknown[] {
  const list: unknown[] = new Array<unknown>(value.length);
  ctx.copies.set(value, list);
  if (hasNamedKeys(value)) ctx.changed = true;
  let hidden = false;
  let last = -1;
  for (const key of Reflect.ownKeys(value)) {
    if (!isIndex(key)) continue;
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      ctx.changed = true;
      hidden = false;
      continue;
    }
    const item: unknown = descriptor.value;
    // A flat list of header names and values: the value right after a credential name is one.
    if (hidden && index === last + 1 && item != null) {
      list[index] = REDACTED;
      ctx.changed = true;
    } else {
      const kept = copyOf(item, ctx, depth + 1);
      if (kept !== OMIT) list[index] = kept;
    }
    hidden = typeof item === 'string' && CREDENTIAL_NAME.test(item);
    last = index;
  }
  return list;
}

/** A copy of a map: the value under a credential name is redacted. A named property is left out. */
function copyMap(value: Map<unknown, unknown>, ctx: Copying, depth: number): Map<unknown, unknown> {
  const map = new Map<unknown, unknown>();
  ctx.copies.set(value, map);
  if (hasNamedKeys(value)) ctx.changed = true;
  for (const [k, v] of value) {
    const key = copyOf(k, ctx, depth + 1);
    if (key === OMIT) continue;
    if (typeof k === 'string' && CREDENTIAL_NAME.test(k) && v != null) {
      map.set(key, REDACTED);
      ctx.changed = true;
      continue;
    }
    const kept = copyOf(v, ctx, depth + 1);
    if (kept !== OMIT) map.set(key, kept);
  }
  return map;
}

/** A copy of a set. A named property is left out. */
function copySet(value: Set<unknown>, ctx: Copying, depth: number): Set<unknown> {
  const set = new Set<unknown>();
  ctx.copies.set(value, set);
  if (hasNamedKeys(value)) ctx.changed = true;
  for (const v of value) {
    const kept = copyOf(v, ctx, depth + 1);
    if (kept !== OMIT) set.add(kept);
  }
  return set;
}

/** A copy of an error or a plain object, `OMIT` for any other object (a class instance: a stream, a socket). */
function copyRecord(value: object, ctx: Copying, depth: number): unknown {
  const errorLike = isError(value);
  if (!errorLike && !isPlain(value)) {
    ctx.changed = true;
    return OMIT;
  }
  const copy: object = errorLike
    ? (Object.setPrototypeOf(new Error(), Object.getPrototypeOf(value) as object | null) as object)
    : (Object.create(Object.getPrototypeOf(value) as object | null) as object);
  ctx.copies.set(value, copy);
  if (errorLike) delete (copy as { stack?: unknown }).stack;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && TRANSPORT.has(key)) {
      ctx.changed = true;
    } else if (errorLike && key === 'stack') {
      copyStack(value, copy, ctx, depth);
    } else {
      copyField(value, copy, key, ctx, depth);
    }
  }
  return copy;
}

/** Carry an error's stack over, read through the original: it may be an accessor bound to the error itself. */
function copyStack(original: object, copy: object, ctx: Copying, depth: number): void {
  let stack: unknown;
  try {
    stack = (original as { stack?: unknown }).stack;
  } catch {
    return;
  }
  const kept = copyOf(stack, ctx, depth + 1);
  if (kept !== OMIT) define(copy, 'stack', kept, false);
}

/** Carry one own property over, as a data property: redacted under a credential name, left out when it is not data. */
function copyField(
  original: object,
  copy: object,
  key: string | symbol,
  ctx: Copying,
  depth: number,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(original, key);
  if (descriptor === undefined) return;
  // A function or accessor is a closure over the original (a `toJSON`, an inspect hook): it is not carried over.
  if (!('value' in descriptor)) {
    ctx.changed = true;
    return;
  }
  // A key is text too: one that quotes a credential is carried redacted.
  const name = typeof key === 'string' ? redactText(key) : key;
  if (name !== key) ctx.changed = true;
  let kept: unknown;
  if (typeof key === 'string' && CREDENTIAL_NAME.test(key) && descriptor.value != null) {
    kept = REDACTED;
    ctx.changed = true;
  } else {
    kept = copyOf(descriptor.value, ctx, depth + 1);
    if (kept === OMIT) return;
  }
  Object.defineProperty(copy, name, {
    value: kept,
    writable: descriptor.writable ?? true,
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
  });
}

/**
 * `err` as it is safe to throw: a credential-free deep copy of an error, plain data, a list, a map or a set when it
 * holds a transport or shows a credential, the value itself when it holds neither, and any other value (a class
 * instance that is not an error, a primitive) as it is. The live error is never changed.
 */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  const ctx: Copying = { copies: new WeakMap(), changed: false };
  const copy = copyOf(err, ctx, 0);
  return (ctx.changed && copy !== OMIT ? copy : err) as T;
}
