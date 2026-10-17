/**
 * Remove credentials from an error the GCS SDK raised, before the driver throws it or keeps it as a `cause`.
 *
 * The SDK keeps the response it got on the error (`response`). On an `ApiError` that is the HTTP layer's response
 * stream, whose `request` holds the headers it sent, the bearer token in `Authorization` included, and the HTTP agent
 * it shares with every other call, whose sockets hold the raw text of requests still in flight. A `GaxiosError` (a
 * resumable upload's, or a token request's) keeps the request's `config`, with its headers and body, and a `response`
 * that holds another copy of it. On a download, and wherever a body lists no errors, the SDK makes the body the error's
 * message as it came, so a proxy's error page or a JSON body can quote the `Authorization` value, or any other header,
 * anywhere in a line. The live objects are never changed (a socket still sending reads them): an error that holds a
 * transport, or whose data shows a credential, is replaced by a deep copy of its plain data. An error with neither is
 * returned as it is.
 *
 * The copy is a native error with the original's prototype (so `instanceof ApiError` holds), name, message, stack,
 * `code`, `status`, `errors` and every other plain field, with `response` reduced to its status and status text: what
 * classification reads. It has no `config`, request, agent or socket, no function or accessor (a `toJSON` or
 * `util.inspect` hook is a closure over the original) and no class instance other than an error. Errors are copied
 * wherever they sit: the `cause` chain, an `AggregateError`'s `errors`, any array or field. A table of copies keeps a
 * cycle a cycle, and anything nested deeper than `MAX_DEPTH` is dropped rather than kept raw.
 *
 * The value under a credential's name is replaced by `[redacted]`: a credential header's (`authorization`, the
 * encryption key's `x-goog-encryption-key`), a signed URL's signature and credential, what a service quotes of a request
 * whose signature it refused, an OAuth token or client secret, a service account's private key (its `client_email` and
 * key id are kept: they name the account and sign nothing); and so is the value after one in a flat list, under one
 * in a map, or beside one in a record (a `{ name, value }` pair, a `{ th, td }` row), except a number, a boolean and
 * the fields a Google error item describes an error with (`message`, `reason`, `location`), which classification reads.
 * In the copy's text, these are redacted: a credential header line; an `Authorization` value, an encryption
 * key, an API key, an OAuth token or client secret and a signed URL's signature or credential after its name; a bearer
 * token after its scheme; a Google access token (`ya29.`) or a JWT on its own; a V2 signed URL's `Signature=`; a PEM
 * private key's body; the text of an element named for a credential (`<CanonicalRequest>`); and the text of the cell
 * after one that names a credential (a table's `<th>` and `<td>`, a list's `<dt>` and `<dd>`). A credential in any
 * other form is not recognised, and a text too large for these patterns is replaced whole.
 */

import { types } from 'node:util';

/** Properties that hold the raw transport or the request's configuration. They are not copied. */
const TRANSPORT = new Set([
  'request',
  'agent',
  'socket',
  '_httpMessage',
  'connection',
  'req',
  'res',
  'config',
]);
/** What a copy keeps of a `response`: what the server said, as numbers and text. */
const RESPONSE_FIELDS = ['status', 'statusText', 'statusCode', 'statusMessage'];
/**
 * Header and field names whose value is a credential: the credential headers, a customer-supplied encryption key (as
 * a header and as the SDK's option), a signed URL's signature and credential, what a service quotes of a request whose
 * signature it refused, and the OAuth and service-account fields that hold a secret. A service account's `client_email`
 * and `private_key_id` are not among them: they name the account and its key, and sign nothing.
 */
const CREDENTIAL_NAMES = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
  'x-goog-encryption-key',
  'x-goog-copy-source-encryption-key',
  'encryption-key',
  'encryption-key-base64',
  'x-goog-signature',
  'x-goog-credential',
  'signature',
  'signature-provided',
  'canonical-request',
  'token',
  'access-token',
  'refresh-token',
  'id-token',
  'subject-token',
  'client-secret',
  'private-key',
  'assertion',
];
/** A name as it is compared: without the spaces and colon around it, in lower case, with `-` and `_` taken out. */
const fold = (name: string): string =>
  name.trim().replace(/:$/, '').replace(/[-_]/g, '').toLowerCase();
const CREDENTIAL_NAME = new Set(CREDENTIAL_NAMES.map(fold));
/** The longest text that can spell one of the names. */
const LONGEST_NAME = 64;
/** A credential header line inside raw request or response text. */
const CREDENTIAL_LINES =
  /^((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-goog-api-key|x-goog-(?:copy-source-)?encryption-key):[^\r\n]*/gim;
/**
 * An `Authorization` value after its name anywhere in a text, its scheme with it: `authorization: Basic <value>`,
 * `authorization=Bearer%20<token>`, JSON's `"authorization":"Bearer <token>"` (also escaped once more).
 */
const AUTHORIZATION_VALUE =
  /((?:proxy-)?authorization\\?["']?\s*(?::|=|%3D)\s*\\?["']?)(?:[A-Za-z][\w-]*(?:\s+|%20|\+))?[^\s&"'<>\\,;]+/gi;
/** The headers and fields whose value follows their name in a text: an encryption key, an API key, a signed URL's parts. */
const NAMED =
  'x-goog-(?:copy-source-)?encryption-key|x-goog-api-key|x-goog-signature|x-goog-credential|' +
  '(?:access|refresh|id|subject)[-_]token|client[-_]secret';
/**
 * One of those after its name anywhere in a text: `name: value`, `name=value` (also percent-encoded) or JSON's
 * `"name":"value"` (also escaped once more).
 */
const NAMED_SECRET = new RegExp(
  `((?:${NAMED})\\\\?["']?\\s*(?::|=|%3D)\\s*\\\\?["']?)[^\\s&"'<>\\\\,;]+`,
  'gi',
);
/** A bearer token after its scheme, wherever the text shows it, also percent-encoded. */
const BEARER = /\b(Bearer)(\s+|%20|\+)(?=[A-Za-z0-9\-._~+/]{16})[A-Za-z0-9\-._~+/]+=*/gi;
/** A Google OAuth access token (`ya29.`), and a JWT: a signed assertion, an ID token, a self-signed account token. */
const TOKEN_TEXT =
  /ya29\.(?=[A-Za-z0-9_.-]{16})[A-Za-z0-9_.-]+|(?<![A-Za-z0-9_-])eyJ(?=[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+\.eyJ(?=[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+\.(?=[A-Za-z0-9_-]{16})[A-Za-z0-9_-]+/g;
/** A signed URL's `Signature=`: a V2 one is base64, percent-encoded; 16 characters or more. */
const SIGNATURE = /(Signature(?:=|%3D))(?=[A-Za-z0-9%+/=_.-]{16})(?:[A-Za-z0-9+/=_.-]+|%(?!26))+/gi;
/** A PEM private key's body, its line breaks escaped or not; the lines that open and close it are kept. */
const PRIVATE_KEY =
  /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)(?:[^-]+|-(?!----END))*(-----END [A-Z0-9 ]*PRIVATE KEY-----)?/g;
/** An XML element; its text is redacted when its name is a credential's (`<CanonicalRequest>`, `<x-goog-encryption-key>`). */
const ELEMENT = /(<([A-Za-z][\w.:-]{0,63})>)([^<]*)(<\/\2>)/g;
/**
 * An element whose text may be a credential's name, and the text of the one after it, with up to four tags around
 * either: a table's `<th>` and `<td>`, a list's `<dt>` and `<dd>`, `<b>name:</b> <span>value`.
 */
const CELL =
  /(<([A-Za-z][\w-]{0,15})\b[^<>]{0,256}>\s{0,32}([^<>\s](?:[^<>]{0,62}[^<>\s])?)\s{0,32}<\/\2\s{0,32}>(?:\s{0,32}<\/[A-Za-z][\w-]{0,15}\s{0,32}>){0,4}(?:\s{0,32}<[A-Za-z][\w-]{0,15}\b[^<>]{0,256}>){1,4})([^<]*)/g;
const REDACTED = '[redacted]';
/** How deep into errors and plain data the copy goes; anything below is dropped. */
const MAX_DEPTH = 10;

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isError = (value: object): boolean => value instanceof Error || types.isNativeError(value);

/**
 * Whether `text` is a credential's name, as a key, a list item or a map key holds it. The whole name must match, in any
 * case and with `-` or `_` between its words or neither (`accessToken`, `access_token`): `pageToken` does not.
 */
const isCredentialName = (text: string): boolean =>
  text.length <= LONGEST_NAME && CREDENTIAL_NAME.has(fold(text));

/**
 * `text` with every credential it shows replaced. Each pattern runs in time linear in the text, and none needs the
 * regular expression engine's stack to grow with it; a text a pattern still cannot finish matching is replaced whole,
 * so a hostile body neither leaks nor stops the error being thrown.
 */
function redactText(text: string): string {
  try {
    return text
      .replace(PRIVATE_KEY, `$1${REDACTED}$2`)
      .replace(CREDENTIAL_LINES, `$1: ${REDACTED}`)
      .replace(AUTHORIZATION_VALUE, `$1${REDACTED}`)
      .replace(NAMED_SECRET, `$1${REDACTED}`)
      .replace(BEARER, `$1$2${REDACTED}`)
      .replace(TOKEN_TEXT, REDACTED)
      .replace(SIGNATURE, `$1${REDACTED}`)
      .replace(ELEMENT, (whole, open: string, tag: string, inner: string, close: string) =>
        isCredentialName(tag) && inner.trim() !== '' ? `${open}${REDACTED}${close}` : whole,
      )
      .replace(CELL, (whole, head: string, _tag: string, name: string, value: string) =>
        isCredentialName(name) && value.trim() !== '' ? `${head}${REDACTED}` : whole,
      );
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
 * property is left out.
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
      if (item !== REDACTED) ctx.changed = true;
    } else {
      const kept = copyOf(item, ctx, depth + 1);
      if (kept === OMIT) delete list[index];
      else list[index] = kept;
    }
    hidden = typeof item === 'string' && isCredentialName(item);
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
    if (typeof k === 'string' && isCredentialName(k) && v != null) {
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
  if (errorLike) keepSlotFields(value, copy, ctx, depth);
  redactPairs(value, copy, errorLike, ctx);
  return copy;
}

/**
 * The fields a Google error item describes an error with (`{ message, domain, reason, location, locationType }`). They
 * are not a name and a value: a `401` names the header it refused in `location` (`Authorization`) beside the reason and
 * message classification reads. They are never taken as a credential's name, and never redacted beside one; the text
 * rules still apply to them.
 */
const DESCRIBING = new Set([
  'message',
  'domain',
  'reason',
  'location',
  'locationType',
  'extendedHelp',
]);

/**
 * Redact the value a record holds beside a credential's name: a `{ name, value }` pair, a table row parsed to
 * `{ th, td }`. On a plain record every field but the name is redacted. On an error, whose other fields are what
 * classification reads, only the `...Value` field beside a `...Name` one is. A number or a boolean is never a
 * credential, and is kept.
 */
function redactPairs(original: object, copy: object, errorLike: boolean, ctx: Copying): void {
  const names = Reflect.ownKeys(original).filter((key): key is string => {
    if (typeof key !== 'string' || DESCRIBING.has(key)) return false;
    const held = Object.getOwnPropertyDescriptor(original, key)?.value as unknown;
    return typeof held === 'string' && isCredentialName(held);
  });
  if (names.length === 0) return;
  const values = errorLike
    ? names
        .filter((key) => /name$/i.test(key))
        .map((key) => `${key.slice(0, -4)}value`.toLowerCase())
    : undefined;
  for (const key of Reflect.ownKeys(copy)) {
    if (typeof key !== 'string' || names.includes(key) || DESCRIBING.has(key)) continue;
    if (values !== undefined && !values.includes(key.toLowerCase())) continue;
    const descriptor = Object.getOwnPropertyDescriptor(copy, key);
    if (descriptor?.value == null || descriptor.value === REDACTED) continue;
    // What classification reads of a record is a number or a boolean (a response's `status`), never a credential.
    if (typeof descriptor.value !== 'string' && typeof descriptor.value !== 'object') continue;
    define(copy, key, REDACTED, descriptor.enumerable ?? false);
    ctx.changed = true;
  }
}

/** Whether `value` is a response as a copy keeps it: a plain record of the response's numbers and text alone. */
function isSummary(value: object): boolean {
  return (
    isPlain(value) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const held: unknown = descriptor?.value;
      return (
        typeof key === 'string' &&
        RESPONSE_FIELDS.includes(key) &&
        (typeof held === 'number' || typeof held === 'string')
      );
    })
  );
}

/**
 * The part of an HTTP response worth keeping: what the server said, as numbers and text. Only those are read (a getter
 * such as a fetch `Response`'s `status` included), and the live response is never kept.
 */
function copyResponse(response: object, ctx: Copying, depth: number): unknown {
  // A copy's response is already this, and is copied as the plain data it is.
  if (isSummary(response)) return copyOf(response, ctx, depth);
  ctx.changed = true;
  const summary: Record<string, unknown> = {};
  for (const key of RESPONSE_FIELDS) {
    let held: unknown;
    try {
      held = (response as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof held === 'number' || typeof held === 'string') {
      summary[key] = copyOf(held, ctx, depth + 1);
    }
  }
  return summary;
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

/**
 * Carry one own property over, as a data property: redacted under a credential name, reduced to its status when it is
 * a `response`, left out when it is not data.
 */
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
  const held: unknown = descriptor.value;
  let kept: unknown;
  if (typeof key === 'string' && isCredentialName(key) && held != null) {
    kept = REDACTED;
    if (held !== REDACTED) ctx.changed = true;
  } else if (key === 'response' && typeof held === 'object' && held !== null) {
    kept = copyResponse(held, ctx, depth + 1);
  } else {
    kept = copyOf(held, ctx, depth + 1);
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
