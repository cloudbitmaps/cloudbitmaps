/**
 * Pure helpers for classifying Azure Blob Storage SDK errors (Phase 7; transient class mirrors S3/GCS).
 *
 * SDK-free + side-effect-free — they only read structural shapes off the thrown value (`err.statusCode`,
 * `err.code`, `err.details.errorCode`), so the Azure-specific translation is unit-testable without a live
 * Azure or an Azurite emulator, and without importing `@azure/storage-blob`. The SDK throws a `RestError`
 * carrying the HTTP status on `.statusCode` (a number) and, usually, the Azure error code string on `.code`
 * / `.details.errorCode` (e.g. `BlobAlreadyExists`, `BlobNotFound`, `InvalidRange`).
 *
 * **Empirically verified against Azurite** (see the driver's write-once note): a conditional
 * `ifNoneMatch: '*'` write that loses the race returns **409 `BlobAlreadyExists`** on BOTH the single-upload
 * and staged-block-commit paths — Azure uses 409 here, NOT the 412 that GCS/S3-`If-None-Match` return. A HEAD
 * (`getProperties`) on a missing blob returns 404 with `.code` *undefined* (no response body), so NotFound is
 * keyed off the status, not the code.
 */

/** The HTTP status of an Azure `RestError`, if present (`err.statusCode` as a number). */
function httpStatus(err: unknown): number | undefined {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

/** The Azure error-code string, from `err.code` or `err.details.errorCode` (either may be absent). */
function azureCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; details?: { errorCode?: unknown } } | null;
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.details?.errorCode === 'string') return e.details.errorCode;
  return undefined;
}

/** A network-level error `code` string (e.g. `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`). */
function networkCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A conditional `ifNoneMatch: '*'` write lost the write-once race — the blob already existed. Azure signals
 * this as **409 `BlobAlreadyExists`** (verified on both the single-upload and `commitBlockList` paths); we
 * also accept **412 `ConditionNotMet`** defensively (the status a specific-ETag precondition would use, and
 * what a non-Azurite backend might return). Both map to `WriteConflictError` (caller OCC), never a blind retry.
 */
export function isConditionalConflict(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 409 || status === 412) return true;
  const code = azureCode(err);
  return code === 'BlobAlreadyExists' || code === 'ConditionNotMet';
}

/**
 * The blob does not exist. Azure returns **404**; the code is `BlobNotFound` on a GET but *undefined* on a
 * HEAD (`getProperties`) since a HEAD has no response body — so the 404 status is the reliable signal.
 */
export function isNotFound(err: unknown): boolean {
  return httpStatus(err) === 404 || azureCode(err) === 'BlobNotFound';
}

/** A range request started past EOF (HTTP 416 `InvalidRange`). */
export function isInvalidRange(err: unknown): boolean {
  return httpStatus(err) === 416 || azureCode(err) === 'InvalidRange';
}

/**
 * A transient Azure fault that is safe to retry: throttling (429 / `ServerBusy` / `OperationTimedOut`), any
 * 5xx, or a dropped/timed-out socket. Excludes the deterministic, caller-meaningful outcomes (409/412/404/416)
 * — those must never be reclassified as a blind transient (a retried doomed conditional write would just fail
 * again, and mask an OCC conflict).
 */
export function isTransient(err: unknown): boolean {
  if (isConditionalConflict(err) || isNotFound(err) || isInvalidRange(err)) return false;
  const status = httpStatus(err);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  const code = azureCode(err);
  if (code === 'ServerBusy' || code === 'OperationTimedOut' || code === 'InternalError')
    return true;
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
