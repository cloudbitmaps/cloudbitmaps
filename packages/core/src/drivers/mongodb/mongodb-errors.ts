/**
 * Pure helpers for classifying MongoDB (`mongodb`) errors (Phase 7; transient class mirrors the other drivers).
 *
 * SDK-free + side-effect-free — they read only structural shapes off the thrown value (`err.code`, `err.name`,
 * the driver's `hasErrorLabel`, or a Node socket code). The driver signals a create-if-absent conflict itself
 * (a duplicate-key error, {@link isDuplicateKey}) and a token-fenced conflict via a 0 matched/deleted count,
 * so there's no general OCC classifier here — only duplicate-key + transient-vs-not.
 */

/** A MongoDB numeric server error code, if present (`err.code`). */
function serverCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** A Node system/socket error `code` string (starts with `E`, uppercase letters + underscore, no digits). */
function networkCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) ? code : undefined;
}

/** A create-if-absent lost the race — the `_id` already existed (duplicate key: 11000 / 11001). */
export function isDuplicateKey(err: unknown): boolean {
  const code = serverCode(err);
  return code === 11000 || code === 11001;
}

/**
 * Retryable MongoDB server error codes: failover / primary-stepdown / node-unreachable / shutdown / network
 * timeouts. (Names from the server error catalogue.) These are safe to retry; deterministic errors
 * (BadValue, duplicate key, etc.) are not listed, so they surface.
 */
const RETRYABLE_CODES = new Set<number>([
  6, // HostUnreachable
  7, // HostNotFound
  89, // NetworkTimeout
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  262, // ExceededTimeLimit
  9001, // SocketException
  10107, // NotWritablePrimary
  11600, // InterruptedAtShutdown
  11602, // InterruptedDueToReplStateChange
  13435, // NotPrimaryNoSecondaryOk
  13436, // NotPrimaryOrSecondary
  63, // StaleShardVersion
  150, // StaleEpoch
]);

/**
 * A transient MongoDB fault safe to retry: a network error, a server-selection timeout, a driver retryable
 * label (`RetryableWriteError` / `TransientTransactionError`), a retryable server code, or a dropped socket.
 * A duplicate-key error is NOT transient (it's the deterministic create-if-absent conflict).
 */
export function isTransient(err: unknown): boolean {
  if (isDuplicateKey(err)) return false;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'MongoNetworkError' || name === 'MongoServerSelectionError') return true;
  const hasLabel = (err as { hasErrorLabel?: (l: string) => boolean } | null)?.hasErrorLabel;
  if (typeof hasLabel === 'function') {
    if (
      hasLabel.call(err, 'RetryableWriteError') ||
      hasLabel.call(err, 'TransientTransactionError')
    ) {
      return true;
    }
  }
  const code = serverCode(err);
  if (code !== undefined && RETRYABLE_CODES.has(code)) return true;
  const net = networkCode(err);
  return (
    net === 'ECONNRESET' ||
    net === 'ECONNABORTED' ||
    net === 'ETIMEDOUT' ||
    net === 'ESOCKETTIMEDOUT' ||
    net === 'ECONNREFUSED' ||
    net === 'EHOSTUNREACH' ||
    net === 'ENETUNREACH' ||
    net === 'EPIPE' ||
    net === 'EAI_AGAIN' ||
    net === 'ENOTFOUND'
  );
}
