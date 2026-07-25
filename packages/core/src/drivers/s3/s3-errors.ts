/**
 * Pure helpers for classifying S3 SDK errors + parsing response headers (Phase 3c; transient class 4b).
 *
 * Kept SDK-free and side-effect-free (they only read structural shapes — `err.name`,
 * `$metadata.httpStatusCode`, a `Content-Range` string) so the subtle S3-specific translation logic is
 * unit-testable without a live MinIO/S3 or even the AWS SDK. Shared AWS shapes come from `_shared/aws-errors`.
 */
import {
  errorName,
  httpStatus,
  isNetworkOrTimeout,
  isSdkRetryable,
  isServerSide,
} from '../_shared/aws-errors';

/** A conditional `If-None-Match: *` PUT lost the write-once race (the object already existed). */
export function isPreconditionFailed(err: unknown): boolean {
  return errorName(err) === 'PreconditionFailed' || httpStatus(err) === 412;
}

/**
 * A conditional write (`If-None-Match: *` / `If-Match: <etag>`) lost the race — **either** outcome S3 uses:
 * the precondition evaluated false (`412 PreconditionFailed`), **or** S3 rejected concurrent conditional
 * writes to the same key to prevent a lost update (`409 ConditionalRequestConflict`, which AWS documents and
 * asks you to retry). Both mean "you lost; re-read and retry" — so both must map to `WriteConflictError` and
 * route through the caller's OCC path, never a blind transient retry (which would just replay a doomed PUT).
 */
export function isConditionalConflict(err: unknown): boolean {
  return (
    isPreconditionFailed(err) ||
    errorName(err) === 'ConditionalRequestConflict' ||
    httpStatus(err) === 409
  );
}

/** The object / generation does not exist (GetObject → `NoSuchKey`, HeadObject → `NotFound`; both 404). */
export function isNotFound(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NoSuchKey' || name === 'NotFound' || httpStatus(err) === 404;
}

/** A range request started past EOF (HTTP 416). */
export function isInvalidRange(err: unknown): boolean {
  return errorName(err) === 'InvalidRange' || httpStatus(err) === 416;
}

/**
 * A transient S3 fault that is safe to retry: throttling (`SlowDown` / 503), any 5xx, a dropped/timed-out
 * connection, or anything the SDK itself marks retryable. Excludes the deterministic outcomes above
 * (412/404/416) — those are caller-meaningful and must never be retried/reclassified.
 */
export function isTransient(err: unknown): boolean {
  // A conditional-write conflict (412/409) is caller-meaningful OCC, not a blind-retryable transient.
  if (isConditionalConflict(err) || isNotFound(err) || isInvalidRange(err)) return false;
  return (
    errorName(err) === 'SlowDown' ||
    isServerSide(err) ||
    isNetworkOrTimeout(err) ||
    isSdkRetryable(err)
  );
}

/**
 * Parse the total object size out of a `Content-Range: bytes <start>-<end>/<total>` header, or `undefined`
 * if absent/unparseable/unsafe. The total is the part after the final `/`.
 */
export function totalFromContentRange(contentRange: string | undefined): number | undefined {
  if (contentRange === undefined) return undefined;
  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (match === null) return undefined;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : undefined;
}
