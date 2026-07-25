/**
 * Pure helpers for classifying Cassandra / ScyllaDB (`cassandra-driver`) errors (Phase 7; transient class
 * mirrors the other drivers).
 *
 * SDK-free + side-effect-free — they read only structural shapes off the thrown value (`err.name`, `err.code`).
 * The driver signals an OCC conflict itself (an LWT that returns `wasApplied() === false`), so there's no
 * "conflict" classifier here — only transient-vs-not. Everything not transient propagates unchanged so a real
 * bug is never blind-retried.
 */

/** A network-level error `code` string (starts with `E`, uppercase letters + underscore, no digits). */
function networkCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) ? code : undefined;
}

/**
 * Transient `cassandra-driver` error classes: no coordinator reachable, a client-side operation timeout, or a
 * server response for a timeout / overload / unavailable / bootstrapping node. All safe to retry (the
 * resilience layer rides them out). A deterministic server error (syntax, invalid query, unauthorized) is a
 * `ResponseError` with a non-retryable code and is NOT matched here, so it surfaces.
 */
const TRANSIENT_NAMES = new Set<string>([
  'NoHostAvailableError',
  'OperationTimedOutError',
  'BusyConnectionError', // connection-pool exhaustion — a transient back-pressure fault
  'DriverError', // generic connection-level driver fault (e.g. socket closed mid-request)
]);

// ResponseError `code` values (CQL binary protocol) that are retryable: server overloaded / bootstrapping,
// truncate, and read/write TIMEOUTS + unavailable. NOTE: an LWT write-timeout retry is ambiguous — the write
// may have committed, so a retry can surface a spurious WriteConflictError (the caller's OCC re-read converges;
// no data loss). ReadFailure/WriteFailure (0x1300/0x1500) are deliberately EXCLUDED — they signal a replica-
// side *failure* (e.g. a tombstone-threshold breach), not a timeout, so a blind retry wouldn't help. Other
// deterministic codes (SyntaxError 0x2000, Invalid 0x2200, Unauthorized 0x2100, AlreadyExists 0x2400) are
// likewise excluded so a real bug surfaces.
const RETRYABLE_RESPONSE_CODES = new Set<number>([
  0x1000, // Unavailable
  0x1001, // Overloaded
  0x1002, // IsBootstrapping
  0x1003, // TruncateError
  0x1100, // WriteTimeout
  0x1200, // ReadTimeout
]);

export function isTransient(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && TRANSIENT_NAMES.has(name)) return true;
  if (name === 'ResponseError') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number' && RETRYABLE_RESPONSE_CODES.has(code)) return true;
    return false; // a ResponseError with any other code is deterministic → must surface
  }
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
