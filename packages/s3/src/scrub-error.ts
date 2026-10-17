/**
 * Remove credentials from an error the AWS SDK raised, before the driver throws it or keeps it as a `cause`.
 *
 * The SDK keeps the HTTP response it got on the error (`$response`), and through its socket the request it sent, with
 * the signed `Authorization` header and `x-amz-security-token`, on properties `util.inspect` shows only with
 * `showHidden`; a body it could not parse it keeps as text (`$responseBodyText`). It also copies every field of the
 * error body onto the error, where a logger prints it. A `SignatureDoesNotMatch` body from S3 quotes the request back:
 * its signature (`SignatureProvided`) and the canonical request S3 computed (`CanonicalRequest`, in hex
 * `CanonicalRequestBytes`), which lists every signed header with its value, the session token's included. A proxy's
 * error page, parsed the same way, can quote the `Authorization` value or the token in any field. The live objects are
 * never changed (a socket still closing reads them): an error that holds a transport, or whose data shows a credential,
 * is replaced by a deep copy of its plain data. An error with neither is returned as it is.
 *
 * The copy is a native error with the original's prototype (so `instanceof S3ServiceException` holds), name, message,
 * stack, `$metadata`, `$fault`, `$retryable`, `Code`, `RequestId` and every other plain field, which is what
 * classification reads. It has no transport property, no function or accessor (a `toJSON` or `util.inspect` hook is a
 * closure over the original) and no class instance other than an error. Errors are copied wherever they sit: the `cause`
 * chain, an `AggregateError`'s `errors`, any array or field. A table of copies keeps a cycle a cycle, and anything
 * nested deeper than `MAX_DEPTH` is dropped rather than kept raw. The value under a credential key is replaced by
 * `[redacted]`: a credential header's, an SSE-C key's, an AWS credential's fields, and the signature and canonical
 * request S3 quotes (the access key id it names is kept: it names a key and signs nothing). In the copy's text, a
 * credential header line, a SigV4 signature (`Signature=` in an `Authorization` value, `X-Amz-Signature=` in a URL) and
 * a session token or SSE-C key written after its header name are redacted. A credential in any other form is not
 * recognised, and a text too large for these patterns is replaced whole.
 */

import { types } from 'node:util';

/** Properties that hold the raw transport: the response, its unparsed body, and the request and socket reachable from it. */
const TRANSPORT = new Set([
  '$response',
  '$responseBodyText',
  'socket',
  '_httpMessage',
  'req',
  'request',
  'connection',
  'agent',
]);
/** The headers whose value is a credential: the signature, the session tokens, an SSE-C key. */
const SECRET_HEADER =
  'x-amz-security-token|x-amz-s3session-token|x-amz-(?:copy-source-)?server-side-encryption-customer-key';
/**
 * Header and field names whose value is a credential: the credential headers, the SDK's SSE-C members, an AWS
 * credential's fields, and what S3 quotes of a request whose signature it refused.
 */
const CREDENTIAL_NAME = new RegExp(
  `^(?:(?:proxy-)?authorization|cookie|set-cookie|x-api-key|${SECRET_HEADER}|x-amz-credential|x-amz-signature|` +
    '(?:copysource)?ssecustomerkey|secretaccesskey|sessiontoken|signatureprovided|canonicalrequest(?:bytes)?)$',
  'i',
);
/** A credential header line inside raw request or response text. */
const CREDENTIAL_LINES = new RegExp(
  `^((?:proxy-)?authorization|cookie|set-cookie|x-api-key|${SECRET_HEADER}):[^\\r\\n]*`,
  'gim',
);
/**
 * A session token or SSE-C key after its header or query name anywhere in a text: `name: value`, `name=value` (also
 * percent-encoded) or JSON's `"name":"value"`.
 */
const NAMED_SECRET = new RegExp(
  `((?:${SECRET_HEADER})["']?\\s*(?::|=|%3D)\\s*["']?)[^\\s&"'<>\\\\,;]+`,
  'gi',
);
/** A SigV4 signature: an `Authorization` value's `Signature=`, a presigned URL's `X-Amz-Signature=`, also percent-encoded. */
const SIGNATURE = /(Signature(?:=|%3D))[0-9A-Fa-f]{16,}/gi;
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
      .replace(NAMED_SECRET, `$1${REDACTED}`)
      .replace(SIGNATURE, `$1${REDACTED}`);
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

/**
 * Whether `value` has own properties other than the `carried` ones its copy keeps (an array's indices and `length`,
 * none on a map or a set): the copy leaves them out.
 */
function hasExtraKeys(value: object, carried: number): boolean {
  return Reflect.ownKeys(value).length !== carried;
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

/** A copy of an array. A hole or a named property is left out. */
function copyList(value: unknown[], ctx: Copying, depth: number): unknown[] {
  const list: unknown[] = [];
  ctx.copies.set(value, list);
  if (hasExtraKeys(value, value.length + 1)) ctx.changed = true;
  let hidden = false;
  for (const item of value) {
    // A flat list of header names and values: the value after a credential name is one.
    if (hidden && item != null) {
      list.push(REDACTED);
      if (item !== REDACTED) ctx.changed = true;
    } else {
      const kept = copyOf(item, ctx, depth + 1);
      list.push(kept === OMIT ? undefined : kept);
    }
    hidden = typeof item === 'string' && CREDENTIAL_NAME.test(item);
  }
  return list;
}

/** A copy of a map: the value under a credential name is redacted. A named property is left out. */
function copyMap(value: Map<unknown, unknown>, ctx: Copying, depth: number): Map<unknown, unknown> {
  const map = new Map<unknown, unknown>();
  ctx.copies.set(value, map);
  if (hasExtraKeys(value, 0)) ctx.changed = true;
  for (const [k, v] of value) {
    const key = copyOf(k, ctx, depth + 1);
    if (key === OMIT) continue;
    if (typeof k === 'string' && CREDENTIAL_NAME.test(k) && v != null) {
      map.set(key, REDACTED);
      if (v !== REDACTED) ctx.changed = true;
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
  if (hasExtraKeys(value, 0)) ctx.changed = true;
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
  if (errorLike) keepSlotFields(value, copy, ctx, depth);
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
    if (descriptor.value !== REDACTED) ctx.changed = true;
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
 * Carry over a `name`, `message` or `code` the original reads through its prototype and the copy cannot: a
 * `DOMException`'s are getters over the instance's internal state, which throw on any other object.
 */
function keepSlotFields(original: object, copy: object, ctx: Copying, depth: number): void {
  for (const key of ['name', 'message', 'code'] as const) {
    if (Object.prototype.hasOwnProperty.call(original, key)) continue;
    let held: unknown;
    try {
      held = (original as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    let read: unknown = OMIT;
    try {
      read = (copy as Record<string, unknown>)[key];
    } catch {
      // the copy cannot read it
    }
    if (read === held) continue;
    const kept = copyOf(held, ctx, depth + 1);
    if (kept !== OMIT) define(copy, key, kept, false);
  }
}

/**
 * `err` as it is safe to throw: a credential-free deep copy of an error or plain object when it holds a transport or
 * shows a credential, the value itself when it holds neither, and any other value (a class instance that is not an
 * error, a primitive) as it is. The live error is never changed.
 */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  const ctx: Copying = { copies: new WeakMap(), changed: false };
  const copy = copyOf(err, ctx, 0);
  return (ctx.changed && copy !== OMIT ? copy : err) as T;
}
