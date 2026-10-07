/**
 * Remove credentials from an error the SDK raised, in place, before the driver throws it or wraps it as a `cause`.
 *
 * The SDK keeps the request it sent on the error it raises (`response.request.headers`, `config.headers`, the raw
 * request line), and that request carries the `Authorization` header, so an application that logs the error or its
 * cause chain would write a live access token to its logs. The status, code, message and every other field stay.
 */

/** Header and field names whose value is a credential. */
const CREDENTIAL_NAME = /^(?:proxy-)?authorization$|^cookie$|^set-cookie$|^x-api-key$/i;
/** A credential header inside a raw request or response text. */
const CREDENTIAL_LINE = /^((?:proxy-)?authorization|cookie|set-cookie|x-api-key):[^\r\n]*/im;
const CREDENTIAL_LINES = new RegExp(CREDENTIAL_LINE.source, 'gim');

const REDACTED = '[redacted]';
/** How far into the object graph and how many objects to look at: an error is shallow, a socket is not. */
const MAX_DEPTH = 6;
const MAX_NODES = 2000;

interface HeaderLike {
  forEach(callback: (value: unknown, name: unknown) => void): void;
  delete(name: never): unknown;
}

function isHeaderLike(value: object): value is HeaderLike {
  const v = value as Partial<HeaderLike>;
  return typeof v.forEach === 'function' && typeof v.delete === 'function';
}

/** Redact `err` in place and return it; a value that is not an object, or that cannot be written, is returned as it is. */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  const seen = new WeakSet<object>();
  let budget = MAX_NODES;
  const walk = (node: object, depth: number): void => {
    if (seen.has(node) || budget-- <= 0 || ArrayBuffer.isView(node)) return;
    seen.add(node);
    if (isHeaderLike(node)) {
      const names: unknown[] = [];
      try {
        node.forEach((_value, name) => {
          if (typeof name === 'string' && CREDENTIAL_NAME.test(name)) names.push(name);
        });
        for (const name of names) node.delete(name as never);
      } catch {
        // A header collection that refuses to change is left as it is.
      }
    }
    for (const name of Object.getOwnPropertyNames(node)) {
      let value: unknown;
      try {
        value = (node as Record<string, unknown>)[name];
        if (CREDENTIAL_NAME.test(name) && value !== undefined && value !== null) {
          (node as Record<string, unknown>)[name] = REDACTED;
          continue;
        }
        if (typeof value === 'string' && CREDENTIAL_LINE.test(value)) {
          (node as Record<string, unknown>)[name] = value.replace(
            CREDENTIAL_LINES,
            `$1: ${REDACTED}`,
          );
          continue;
        }
      } catch {
        continue; // a getter that throws, or a property that is read-only
      }
      if (typeof value === 'object' && value !== null && depth < MAX_DEPTH) walk(value, depth + 1);
    }
  };
  walk(err, 0);
  return err;
}
