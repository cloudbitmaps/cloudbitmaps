/**
 * Shared, SDK-free helpers for classifying AWS-style errors (used by the S3 + DynamoDB drivers, Phase 4b).
 *
 * These only read structural shapes an AWS SDK v3 error carries — `name`, `$metadata.httpStatusCode`, a
 * lower-level `code`/`errno`, and the SDK's own `$retryable` marker — so the (subtle, easy-to-get-wrong)
 * transient-vs-fatal decision is unit-testable without a live backend or even the SDK installed. They live
 * under `drivers/_shared` (part of the SDK-free core bundle): a driver may import them; they import no SDK.
 */

export function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

export function errorName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

/** A lower-level transport code (e.g. `ECONNRESET`) — the Node networking layer sets `code`. */
export function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/** The AWS SDK v3 tags retryable errors with a `$retryable` object (throttling faults carry `.throttling`). */
export function isSdkRetryable(err: unknown): boolean {
  return (err as { $retryable?: unknown } | null)?.$retryable != null;
}

/** Any 5xx is a server-side fault that's safe to retry (the request didn't deterministically fail). */
export function isServerSide(err: unknown): boolean {
  const status = httpStatus(err);
  return status !== undefined && status >= 500 && status <= 599;
}

const NETWORK_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'NetworkingError',
  'AbortError',
]);
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
]);

// Message-text fallback for when the structural signals (name/code/$metadata/$retryable) are absent. Kept
// SPECIFIC on purpose: a loose `/timed? ?out/` matches deterministic messages like "value timed out of
// range" and would wrongly retry them, so we only match timeout/network phrases anchored to a transport word
// (connection/request/socket/read/write) plus the unambiguous standalone phrases.
const NETWORK_MESSAGE =
  /socket hang up|network (error|failure)|(connection|request|socket|operation|read|write)\s+tim(e|ed)\s?out|connection (reset|refused|aborted|closed)/i;

/** A dropped/timed-out connection — transient by nature; a retry on a fresh connection usually succeeds. */
export function isNetworkOrTimeout(err: unknown): boolean {
  if (NETWORK_NAMES.has(errorName(err) ?? '')) return true;
  if (NETWORK_CODES.has(errorCode(err) ?? '')) return true;
  return NETWORK_MESSAGE.test((err as { message?: string } | null)?.message ?? '');
}
