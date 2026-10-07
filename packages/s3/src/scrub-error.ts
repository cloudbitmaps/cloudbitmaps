/**
 * Remove credentials from an error the AWS SDK raised, before the driver throws it or keeps it as a `cause`.
 *
 * The SDK keeps the HTTP response it got on the error (`$response`), and through its socket the request it sent, with
 * the signed `Authorization` header and `x-amz-security-token`, on properties `util.inspect` shows only with
 * `showHidden`. Those objects are live (a socket still closing reads them), so they are never changed: the error is
 * replaced by a copy that has none of them (an error with none is returned as it is). The copy keeps its prototype, name, message, stack, status, code, request
 * id and every other plain field, so classification by name, code or status works on it as on the original. A
 * credential header or header line left anywhere in the copy's plain data is redacted.
 */

/** Properties that hold the raw transport: the response, and the request and socket reachable from it. */
const TRANSPORT = new Set([
  '$response',
  'socket',
  '_httpMessage',
  'req',
  'request',
  'connection',
  'agent',
]);
/** Header and field names whose value is a credential. */
const CREDENTIAL_NAME =
  /^(?:proxy-)?authorization$|^cookie$|^set-cookie$|^x-api-key$|^x-amz-security-token$|^x-amz-credential$|^x-amz-signature$/i;
const CREDENTIAL_LINE = new RegExp(
  '^((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-amz-security-token):[^\\r\\n]*',
  'im',
);
const CREDENTIAL_LINES = new RegExp(CREDENTIAL_LINE.source, 'gim');
const REDACTED = '[redacted]';
/** How far down a `cause` chain, and into plain data, to look. */
const MAX_DEPTH = 6;

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Array.isArray(value);
};

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
      } else if (typeof value === 'string' && CREDENTIAL_LINE.test(value)) {
        record[key] = value.replace(CREDENTIAL_LINES, `$1: ${REDACTED}`);
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

/** `err` as it is safe to throw: a credential-free copy of an error object, any other value as it is. */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  // An error with no transport on it is the caller's or ours, and keeps its identity.
  const safe = holdsTransport(err, 0) ? copyOf(err, 0) : err;
  redact(safe, new WeakSet(), 0);
  return safe as T;
}
