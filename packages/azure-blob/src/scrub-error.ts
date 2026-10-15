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
  if (Array.isArray(value)) {
    const list: unknown[] = [];
    ctx.copies.set(value, list);
    let hidden = false;
    for (const item of value) {
      // A flat list of header names and values: the value after a credential name is one.
      if (hidden && item != null) {
        list.push(REDACTED);
        ctx.changed = true;
      } else {
        const kept = copyOf(item, ctx, depth + 1);
        list.push(kept === OMIT ? undefined : kept);
      }
      hidden = typeof item === 'string' && CREDENTIAL_NAME.test(item);
    }
    return list;
  }
  if (value instanceof Map) {
    const map = new Map<unknown, unknown>();
    ctx.copies.set(value, map);
    for (const [k, v] of value as Map<unknown, unknown>) {
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
  if (value instanceof Set) {
    const set = new Set<unknown>();
    ctx.copies.set(value, set);
    for (const v of value as Set<unknown>) {
      const kept = copyOf(v, ctx, depth + 1);
      if (kept !== OMIT) set.add(kept);
    }
    return set;
  }
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
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    let kept: unknown;
    if (errorLike && key === 'stack') {
      // Read through the original: the stack may be an accessor bound to the error itself.
      let stack: unknown;
      try {
        stack = (value as { stack?: unknown }).stack;
      } catch {
        continue;
      }
      kept = copyOf(stack, ctx, depth + 1);
      Object.defineProperty(copy, key, {
        value: kept,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      continue;
    }
    // A function or accessor is a closure over the original (a `toJSON`, an inspect hook): it is not carried over.
    if (!('value' in descriptor)) {
      ctx.changed = true;
      continue;
    }
    if (typeof key === 'string' && CREDENTIAL_NAME.test(key) && descriptor.value != null) {
      kept = REDACTED;
      ctx.changed = true;
    } else {
      kept = copyOf(descriptor.value, ctx, depth + 1);
      if (kept === OMIT) continue;
    }
    Object.defineProperty(copy, key, {
      value: kept,
      writable: descriptor.writable ?? true,
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
    });
  }
  return copy;
}

/**
 * `err` as it is safe to throw: a credential-free deep copy of an error object when it holds a transport or shows a
 * credential, the error itself when it holds neither, any other value as it is. The live error is never changed.
 */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  if (!isError(err) && !isPlain(err)) return err;
  const ctx: Copying = { copies: new WeakMap(), changed: false };
  const copy = copyOf(err, ctx, 0);
  return (ctx.changed && copy !== OMIT ? copy : err) as T;
}
