/**
 * Make an error the SDK raised safe to throw, or to keep as a `cause`: a copy of it with no credential and none of the
 * live transport.
 *
 * The SDK keeps the request it sent on the error (`response.request`, `config.headers`, the raw request line), and
 * through that request the HTTP agent it shares with every other call, whose sockets hold the raw text, bearer token
 * included, of requests still in flight. An application that logs the error or its cause chain would write a live
 * access token. The error is therefore replaced by a copy built from what it is: its prototype, name, message, stack,
 * code, status and other plain data; `response` reduced to its status; the request, agent, socket and config dropped.
 * Nothing live is ever changed, only read, and the copy is made from plain data alone, so no depth or size limit can
 * stop short of a secret. A credential header or header line in the plain data that is kept is redacted.
 */

/** Properties that hold the raw transport or the request's configuration. They are not copied. */
const DROPPED = new Set([
  'request',
  'agent',
  'socket',
  '_httpMessage',
  'connection',
  'req',
  'res',
  'config',
]);
/** Header and field names whose value is a credential. */
const CREDENTIAL_NAME = /^(?:proxy-)?authorization$|^cookie$|^set-cookie$|^x-api-key$/i;
/** A credential header inside a raw request or response text. */
const CREDENTIAL_LINES = /^((?:proxy-)?authorization|cookie|set-cookie|x-api-key):[^\r\n]*/gim;
const REDACTED = '[redacted]';

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** The part of an HTTP response worth keeping: what the server said, as numbers and text. */
function responseSummary(response: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['status', 'statusText']) {
    const value: unknown = (response as Record<string, unknown>)[key];
    if (typeof value === 'number' || typeof value === 'string') out[key] = value;
  }
  return out;
}

/** A copy of `value` from plain data only: other objects (streams, headers, sockets) are left out. */
function clean(value: unknown, copies: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return value.replace(CREDENTIAL_LINES, `$1: ${REDACTED}`);
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (copies.has(value)) return copies.get(value);
  if (Array.isArray(value)) {
    const list: unknown[] = [];
    copies.set(value, list);
    for (const item of value) list.push(clean(item, copies));
    return list;
  }
  const isError = value instanceof Error;
  if (!isError && !isPlain(value)) return undefined;
  const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<
    string | symbol,
    unknown
  >;
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && DROPPED.has(key)) continue;
    let held: unknown;
    try {
      held = (value as Record<string | symbol, unknown>)[key];
    } catch {
      continue; // a getter that throws
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    let kept: unknown;
    if (typeof key === 'string' && CREDENTIAL_NAME.test(key)) kept = held == null ? held : REDACTED;
    else if (key === 'response' && typeof held === 'object' && held !== null) {
      kept = responseSummary(held);
    } else kept = clean(held, copies);
    if (kept === undefined && held !== undefined) continue; // an object this copy leaves out
    Object.defineProperty(copy, key, {
      value: kept,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
    });
  }
  return copy;
}

/** Whether `err`, or an error in its `cause` chain, holds a response, a request or the rest of the transport. */
function holdsTransport(err: object, seen: Set<object>): boolean {
  if (seen.has(err)) return false;
  seen.add(err);
  if (Object.getOwnPropertyNames(err).some((key) => DROPPED.has(key) || key === 'response')) {
    return true;
  }
  const cause: unknown = (err as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null && holdsTransport(cause, seen);
}

/**
 * `err` as it is safe to throw: a credential-free copy of an error that holds the SDK's request or response, and any
 * other value as it is (a timeout, a connection fault or an error of the driver's own holds no credential, and keeps
 * its identity).
 */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  return holdsTransport(err, new Set()) ? (clean(err, new WeakMap()) as T) : err;
}
