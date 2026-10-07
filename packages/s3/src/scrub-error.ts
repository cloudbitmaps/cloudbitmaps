/**
 * Remove credentials from an error the AWS SDK raised, in place, before the driver throws it or keeps it as a `cause`.
 *
 * The SDK keeps the HTTP response it got on the error (`$response`), and through its socket the request it sent, with
 * the signed `Authorization` header and `x-amz-security-token`, on properties `util.inspect` shows only with
 * `showHidden`. The raw response, request and socket objects are dropped; the status, code, message and request id
 * (`$metadata`, `name`, `message`) stay. Credential headers found anywhere else in what remains are redacted.
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
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

/** Remove a property, or blank it; `false` when it can be neither (a frozen own property), so the caller looks inside it. */
function drop(record: Record<string | symbol, unknown>, key: string): boolean {
  try {
    delete record[key];
  } catch {
    // not configurable
  }
  if (!(key in record)) return true;
  try {
    record[key] = undefined;
  } catch {
    // not writable
  }
  return record[key] === undefined;
}

/** Redact `err` in place and return it; a value that is not an object, or that cannot be written, is returned as it is. */
export function scrubCredentials<T>(err: T): T {
  if (typeof err !== 'object' || err === null) return err;
  const seen = new WeakSet<object>();
  let budget = MAX_NODES;
  const walk = (node: object, depth: number): void => {
    if (seen.has(node) || budget-- <= 0 || ArrayBuffer.isView(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      // A flat list of header names and values, as Node keeps `rawHeaders`.
      for (let i = 0; i < node.length; i++) {
        const item: unknown = node[i];
        if (typeof item === 'string' && CREDENTIAL_NAME.test(item) && i + 1 < node.length) {
          try {
            node[i + 1] = REDACTED;
          } catch {
            // left as it is
          }
        }
      }
    }
    const keys: Array<string | symbol> = [
      ...Object.getOwnPropertyNames(node),
      ...Object.getOwnPropertySymbols(node),
    ];
    for (const key of keys) {
      let value: unknown;
      try {
        value = (node as Record<string | symbol, unknown>)[key];
        const record = node as Record<string | symbol, unknown>;
        if (typeof key === 'string' && TRANSPORT.has(key) && typeof value === 'object') {
          if (drop(record, key)) continue;
        }
        if (typeof key === 'string' && CREDENTIAL_NAME.test(key) && value != null) {
          record[key] = REDACTED;
          continue;
        }
        if (typeof value === 'string' && CREDENTIAL_LINE.test(value)) {
          record[key] = value.replace(CREDENTIAL_LINES, `$1: ${REDACTED}`);
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
