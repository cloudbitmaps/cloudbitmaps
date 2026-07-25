/**
 * Pure helpers for classifying Google Cloud Storage SDK errors (Phase 7; transient class mirrors S3's).
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

/** The object / generation does not exist (GCS returns 404). */
export function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404;
}

/** A range request started past EOF (HTTP 416 Requested Range Not Satisfiable). */
export function isInvalidRange(err: unknown): boolean {
  return httpStatus(err) === 416;
}

/**
 * A transient GCS fault that is safe to retry: throttling (429), any 5xx, or a dropped/timed-out socket.
 * Excludes the deterministic, caller-meaningful outcomes (412/404/416) — those must never be reclassified as
 * a blind transient (a retried doomed conditional write would just fail again, and mask an OCC conflict).
 */
export function isTransient(err: unknown): boolean {
  if (isPreconditionFailed(err) || isNotFound(err) || isInvalidRange(err)) return false;
  const status = httpStatus(err);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
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
