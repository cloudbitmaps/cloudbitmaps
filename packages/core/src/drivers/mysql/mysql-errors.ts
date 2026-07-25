/**
 * Pure helpers for classifying MySQL (`mysql2`) errors (Phase 7; transient class mirrors S3/GCS/Azure/Postgres).
 *
 * SDK-free + side-effect-free — they read only structural shapes off the thrown value (`err.errno`, a MySQL
 * error number; and `err.code`, a `mysql2`/Node string code), so the translation is unit-testable without a
 * live MySQL. Two classifiers: {@link isDuplicateKey} (the create-if-absent conflict signal, MySQL errno 1062)
 * and {@link isTransient} (retryable). Everything else propagates unchanged so a real bug is never blind-retried.
 */

/** The MySQL error number off a thrown `mysql2` error, if present. */
function errno(err: unknown): number | undefined {
  const n = (err as { errno?: unknown } | null)?.errno;
  return typeof n === 'number' ? n : undefined;
}

/** The string `code` off a thrown `mysql2`/Node error (e.g. `ER_DUP_ENTRY`, `PROTOCOL_CONNECTION_LOST`, `ECONNRESET`). */
function code(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

/**
 * A duplicate-key violation (MySQL errno **1062** / `ER_DUP_ENTRY`). The driver's create-if-absent path is a
 * plain `INSERT`; a pre-existing row surfaces as this, which the driver maps to a `WriteConflictError`. Kept
 * separate from {@link isTransient} — a duplicate key is a **deterministic** conflict, never retried.
 */
export function isDuplicateKey(err: unknown): boolean {
  return errno(err) === 1062 || code(err) === 'ER_DUP_ENTRY';
}

/**
 * A transient MySQL fault that is safe to retry: a lock-wait timeout / deadlock (1205 / 1213), too-many-
 * connections (1040 / 1203), a server shutdown / killed connection (1053 / 1927), the client's
 * server-gone / connection-lost codes (2006 / 2013, `PROTOCOL_CONNECTION_LOST`, `PROTOCOL_SEQUENCE_TIMEOUT`),
 * or a dropped/timed-out socket. Deterministic, caller-meaningful outcomes (duplicate key, unknown table,
 * syntax errors, etc.) are NOT transient — they must surface, never be blind-retried.
 */
export function isTransient(err: unknown): boolean {
  const n = errno(err);
  if (
    n === 1205 || // ER_LOCK_WAIT_TIMEOUT
    n === 1213 || // ER_LOCK_DEADLOCK
    n === 1040 || // ER_CON_COUNT_ERROR (too many connections)
    n === 1203 || // ER_TOO_MANY_USER_CONNECTIONS
    n === 1053 || // ER_SERVER_SHUTDOWN
    n === 1927 || // ER_CONNECTION_KILLED
    n === 2006 || // CR_SERVER_GONE_ERROR
    n === 2013 // CR_SERVER_LOST
  ) {
    return true;
  }
  const c = code(err);
  return (
    c === 'PROTOCOL_CONNECTION_LOST' ||
    c === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    c === 'CR_SERVER_GONE_ERROR' ||
    c === 'CR_SERVER_LOST' ||
    c === 'ECONNRESET' ||
    c === 'ECONNABORTED' ||
    c === 'ETIMEDOUT' ||
    c === 'ESOCKETTIMEDOUT' ||
    c === 'ECONNREFUSED' ||
    c === 'EHOSTUNREACH' ||
    c === 'ENETUNREACH' ||
    c === 'EPIPE' ||
    c === 'EAI_AGAIN' ||
    c === 'ENOTFOUND'
  );
}
