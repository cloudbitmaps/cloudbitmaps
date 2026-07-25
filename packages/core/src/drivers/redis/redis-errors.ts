/**
 * Pure helpers for classifying Redis (`ioredis`) errors (Phase 7; transient class mirrors the other drivers).
 *
 * SDK-free + side-effect-free — they read only structural shapes off the thrown value (`err.code`, a Node
 * socket code; or the error message, which for a Redis server reply begins with the error-code word). The
 * driver signals an OCC conflict itself (its Lua CAS returns 0), so there's no "conflict" classifier — only
 * transient-vs-not. Everything not transient propagates unchanged so a real bug is never blind-retried.
 */

/** A network-level error `code` string (starts with `E`, uppercase letters + underscore, no digits). */
function networkCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z_]+$/.test(code) ? code : undefined;
}

/**
 * Transient Redis error-reply prefixes + ioredis connection-state messages. A Redis server error reply's
 * message begins with the code word (`LOADING`, `CLUSTERDOWN`, …); ioredis raises connection faults as an
 * `Error` whose message is one of the phrases below. All are safe to retry (the resilience layer rides them
 * out); a deterministic reply (`WRONGTYPE`, a Lua `ERR`, etc.) is NOT here, so it surfaces.
 */
const TRANSIENT_MESSAGE =
  /^(LOADING|CLUSTERDOWN|TRYAGAIN|MASTERDOWN|READONLY)\b|Connection is closed|Command timed out|Stream isn't writeable|Reached the max retries per request limit|max number of clients reached|failed to refresh slots cache/i;

export function isTransient(err: unknown): boolean {
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
  return err instanceof Error && TRANSIENT_MESSAGE.test(err.message);
}
