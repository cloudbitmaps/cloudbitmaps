/**
 * Remove credentials from an error the Azure SDK raised, before the driver throws it or keeps it as a `cause`.
 *
 * A `RestError` keeps the request it sent on `request`, and the response it got on `response` (whose `request` is the
 * same one), on properties `util.inspect` and `JSON.stringify` hide. The request holds the signed `Authorization`
 * header (`SharedKey <account>:<signature>`, or a bearer token) and, with a SAS credential, the signature in its URL
 * (`sig=`). Those objects are live (the pipeline may still read them), so they are never changed: the error is
 * replaced by a copy that has none of them (an error with none is returned as it is). The copy keeps its prototype,
 * name, message, stack, `code`, `statusCode`, `details` and every other plain field, so classification by status or
 * code works on it as on the original. Its `cause` chain is copied the same way. A credential left anywhere in the
 * copy's plain data (an `Authorization` value or header line, a `sig=` value in a URL, in the message, the stack or
 * `details`) is redacted.
 */

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
  /^(?:proxy-)?authorization$|^cookie$|^set-cookie$|^x-api-key$|^x-ms-copy-source-authorization$|^sig$/i;
/** A credential header line inside raw request or response text. */
const CREDENTIAL_LINES =
  /^((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-ms-copy-source-authorization):[^\r\n]*/gim;
/** A SAS signature in a URL or query string. */
const SAS_SIGNATURE = /([?&;\s"'(]sig=)[^&\s"'<>)]*/gi;
/** An `Authorization` scheme and its value, wherever the text shows it. */
const AUTH_SCHEME = /\b(SharedKey(?:Lite)?|Bearer)\s+[^\s"'<>,;]+/g;
const REDACTED = '[redacted]';
/** How far down a `cause` chain, and into plain data, to look. */
const MAX_DEPTH = 6;

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Array.isArray(value);
};

/** `text` with every credential it shows replaced. */
function redactText(text: string): string {
  return text
    .replace(CREDENTIAL_LINES, `$1: ${REDACTED}`)
    .replace(SAS_SIGNATURE, `$1${REDACTED}`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`);
}

/** Redact credential values in plain data, in place. Class instances (live objects) are left alone. */
function redact(node: object, seen: WeakSet<object>, depth: number): void {
  if (seen.has(node) || depth > MAX_DEPTH) return;
  seen.add(node);
  if (Array.isArray(node)) {
    // A flat list of header names and values.
    for (let i = 0; i + 1 < node.length; i++) {
      const item: unknown = node[i];
      if (typeof item === 'string' && CREDENTIAL_NAME.test(item)) node[i + 1] = REDACTED;
    }
  }
  for (const key of Reflect.ownKeys(node)) {
    try {
      const record = node as Record<string | symbol, unknown>;
      const value = record[key];
      if (typeof key === 'string' && CREDENTIAL_NAME.test(key) && value != null) {
        record[key] = REDACTED;
      } else if (typeof value === 'string') {
        const clean = redactText(value);
        if (clean !== value) record[key] = clean;
      } else if (typeof value === 'object' && value !== null && isPlain(value)) {
        redact(value, seen, depth + 1);
      }
    } catch {
      // a getter that throws, or a property that is read-only
    }
  }
}

/** A copy of `err` without the transport properties, its `cause` chain copied the same way. */
function copyOf(err: object, depth: number): object {
  const copy = Object.create(Object.getPrototypeOf(err) as object | null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(err)) {
    if (typeof key === 'string' && TRANSPORT.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(err, key);
    if (descriptor === undefined) continue;
    // The SDK's `util.inspect` hook is a closure over the original error, request included: it is not carried over.
    if (typeof key === 'symbol' && typeof descriptor.value === 'function') continue;
    if (key === 'cause' && 'value' in descriptor) {
      const cause: unknown = descriptor.value;
      if (typeof cause === 'object' && cause !== null && depth < MAX_DEPTH) {
        descriptor.value = copyOf(cause, depth + 1);
      }
    }
    if (key === 'stack') {
      // Read through the original: the stack may be an accessor bound to the error itself.
      Object.defineProperty(copy, key, {
        value: (err as { stack?: unknown }).stack,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      continue;
    }
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

/** Whether `err`, or an error in its `cause` chain, holds a raw transport object. */
function holdsTransport(err: object, depth: number): boolean {
  if (Object.getOwnPropertyNames(err).some((key) => TRANSPORT.has(key))) return true;
  const cause: unknown = (err as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null && depth < MAX_DEPTH
    ? holdsTransport(cause, depth + 1)
    : false;
}

/** Redact `err` and the errors in its `cause` chain, in place. */
function redactChain(err: object, seen: WeakSet<object>, depth: number): void {
  redact(err, seen, 0);
  const cause: unknown = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null && depth < MAX_DEPTH) {
    redactChain(cause, seen, depth + 1);
  }
}

/** `err` as it is safe to throw: a credential-free copy of an error object, any other value as it is. */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  // An error with no transport on it is the caller's or ours, and keeps its identity.
  const safe = holdsTransport(err, 0) ? copyOf(err, 0) : err;
  redactChain(safe, new WeakSet(), 0);
  return safe as T;
}
