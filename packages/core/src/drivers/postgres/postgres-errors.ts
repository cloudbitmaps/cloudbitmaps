/**
 * Pure helpers for classifying PostgreSQL (`pg`) errors (Phase 7; transient class mirrors S3/GCS/Azure).
 *
 * SDK-free + side-effect-free — they read only structural shapes off the thrown value (`err.code`, a
 * SQLSTATE string; or a Node socket `code`), so the translation is unit-testable without a live Postgres.
 * Note the driver signals a write-once / OCC conflict itself (a conditional statement affecting **0 rows**),
 * so there is no "conflict" classifier here — only transient-vs-not. Everything not transient propagates
 * unchanged so a real bug is never silently retried.
 */

/**
 * A Node system/socket error `code` (e.g. `ECONNRESET`, `EPIPE`, `EAI_AGAIN`): starts with `E`, only
 * uppercase letters + underscore, no digits. Checked BEFORE {@link sqlState} because some socket codes are
 * exactly 5 chars (`EPIPE`) and would otherwise collide with the SQLSTATE shape — no real Postgres SQLSTATE
 * class begins with a letter `E`, so this disambiguates cleanly.
 */
function networkCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) ? code : undefined;
}

/**
 * `pg` surfaces its most common transient faults — a backend/socket that drops mid-query, or a pool
 * connect-timeout — as a plain `Error` with **no `.code`**, only a message (`pg/lib/client.js`: "Connection
 * terminated unexpectedly", "…is not queryable"; pg-pool's "timeout exceeded when trying to connect"). Without
 * this, such a fault would fall through as non-transient and the retry decorator would not ride it out — the
 * exact class of fault the resilience layer exists to absorb. Only consulted when there's no SQLSTATE/socket
 * code (a deterministic server error always carries a code, so this can never mask one).
 */
const CONNECTION_LOST =
  /connection terminated|not queryable|timeout exceeded when trying to connect/i;
function isConnectionLostMessage(err: unknown): boolean {
  return err instanceof Error && CONNECTION_LOST.test(err.message);
}

/** The `pg` error's SQLSTATE (a 5-char `[0-9A-Z]` code like `40001`), if present and not a socket code. */
function sqlState(err: unknown): string | undefined {
  if (networkCode(err) !== undefined) return undefined;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * A transient Postgres fault that is safe to retry: a serialization failure / deadlock (SQLSTATE class 40),
 * an operator-intervention / cannot-connect-now (57P03 / 57P01 / 57P02), too-many-connections or
 * out-of-memory (53xxx), a connection-exception (class 08), or a dropped/timed-out socket. Deterministic,
 * caller-meaningful outcomes (constraint violations, syntax errors, etc.) are NOT transient — they must
 * surface, never be blind-retried.
 */
export function isTransient(err: unknown): boolean {
  const state = sqlState(err);
  if (state !== undefined) {
    const cls = state.slice(0, 2);
    if (cls === '40' || cls === '08' || cls === '53') return true; // serialization/deadlock, connection, resource
    if (state === '57P03' || state === '57P01' || state === '57P02') return true; // cannot_connect_now / shutdowns
    return false;
  }
  const net = networkCode(err);
  if (
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
  ) {
    return true;
  }
  // pg's code-less connection-lost errors (see CONNECTION_LOST) — the tail case, only if nothing above matched.
  return isConnectionLostMessage(err);
}
