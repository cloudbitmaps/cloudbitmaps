/**
 * Pure helpers for classifying Google Cloud Storage SDK errors (the transient class mirrors S3's).
 *
 * SDK-free + side-effect-free — they only read structural shapes off the thrown value (`err.code`,
 * `err.response.status`, `err.name`), so the GCS-specific translation is unit-testable without a live GCS or
 * an emulator, and without importing `@google-cloud/storage`. GCS's `ApiError` carries the HTTP status on
 * `.code` (a number); dropped/timed-out sockets surface as a Node error with a string `.code` (`ECONNRESET`,
 * `ETIMEDOUT`, …).
 */

/** The HTTP status of a GCS `ApiError`, if present (`err.code` as a number, or `err.response.status`). */
function httpStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; response?: { status?: unknown } } | null;
  if (typeof e?.code === 'number') return e.code;
  if (typeof e?.response?.status === 'number') return e.response.status;
  return undefined;
}

/** A network-level error `code` string (e.g. `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`). */
function networkCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A conditional `ifGenerationMatch: 0` write lost the write-once race — the object already existed, so GCS
 * returns **412 Precondition Failed**. Maps to `WriteConflictError` (caller OCC), never a blind retry.
 */
export function isPreconditionFailed(err: unknown): boolean {
  return httpStatus(err) === 412;
}

/**
 * GCS asked the client to slow down: `429` (`rateLimitExceeded`) or `503` (`backendError`), which the SDK raises as an
 * `ApiError` with the status as a numeric `code`. GCS does not document that a throttled request was not applied, so
 * an upload sent again after one must still tell a landed first send apart.
 */
export function isThrottle(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 429 || status === 503;
}

/** The object / generation does not exist (GCS returns 404). */
export function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}

/** A range request started past EOF (HTTP 416 Requested Range Not Satisfiable). */
export function isInvalidRange(err: unknown): boolean {
  return httpStatus(err) === 416;
}

/** The statuses the SDK's own retry predicate retries (`RETRYABLE_ERR_FN_DEFAULT` in `@google-cloud/storage`). */
const SDK_RETRIED_STATUSES = [408, 429, 500, 502, 503, 504];

/** The connection faults the same predicate names, matched on a lower-cased code or reason as it does. */
function isSdkConnectionProblem(reason: string): boolean {
  return (
    reason.includes('eai_again') ||
    reason === 'econnreset' ||
    reason === 'unexpected connection closure' ||
    reason === 'epipe' ||
    reason === 'socket connection timeout'
  );
}

/**
 * The codes Node gives a connection that failed or was cut off: refused, reset, aborted, timed out, a DNS failure, an
 * unreachable host or network, a broken pipe, and a chunked body cut off mid-stream (`ERR_STREAM_PREMATURE_CLOSE`).
 * Only these: a file the credentials name that is missing or unreadable (`ENOENT`, `EACCES`) and a TLS failure
 * (`EPROTO`, a certificate error) carry codes of the same shape, and would fail the same way again.
 */
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** A download that failed in transit rather than with an HTTP status: one of {@link TRANSPORT_CODES}. */
export function isTransportFault(err: unknown): boolean {
  if (httpStatus(err) !== undefined) return false;
  const code = networkCode(err);
  return code !== undefined && TRANSPORT_CODES.has(code);
}

/**
 * Whether the driver retries a failed download, which it does in the SDK's place: the statuses the SDK's predicate
 * retries (408, 429, 500, 502, 503 and 504, as a number or a string `code`), the connection faults it names in any
 * `errors[].reason`, and every {@link isTransportFault}, which the SDK retried before any response came. A 404, 412,
 * 416 or 403, a 501 or 505, a credentials or TLS failure, and every other answer reach the caller on the first attempt.
 */
export function isDownloadRetryable(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  if (isTransportFault(err)) return true;
  const e = err as { code?: unknown; errors?: unknown };
  if (typeof e.code === 'number' && SDK_RETRIED_STATUSES.includes(e.code)) return true;
  if (typeof e.code === 'string') {
    if (SDK_RETRIED_STATUSES.map(String).includes(e.code)) return true;
    if (isSdkConnectionProblem(e.code.toLowerCase())) return true;
  }
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors as Array<{ reason?: unknown } | null>) {
      const reason = inner?.reason?.toString().toLowerCase();
      if (reason !== undefined && isSdkConnectionProblem(reason)) return true;
    }
  }
  return false;
}

/**
 * A transient GCS fault that is safe to retry: throttling (429), a request timeout (408), any 5xx, or a dropped/timed-out socket.
 * Excludes the deterministic, caller-meaningful outcomes (412/404/416) — those must never be reclassified as
 * a blind transient (a retried doomed conditional write would just fail again, and mask an OCC conflict).
 */
export function isTransient(err: unknown): boolean {
  if (isPreconditionFailed(err) || isNotFound(err) || isInvalidRange(err)) return false;
  const status = httpStatus(err);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600))
    return true;
  const net = networkCode(err);
  return (
    net === 'ECONNRESET' ||
    net === 'ETIMEDOUT' ||
    net === 'ECONNREFUSED' ||
    net === 'EPIPE' ||
    net === 'EAI_AGAIN' ||
    net === 'ENOTFOUND'
  );
}
