/**
 * Pure helpers for classifying DynamoDB SDK errors (conflict and transient classification).
 *
 * SDK-free + side-effect-free (read structural shapes only), so the transient-vs-fatal decision is
 * unit-testable without DynamoDB-Local or the SDK. Shared AWS shapes come from `_shared/aws-errors`.
 */
import { errorName, isNetworkOrTimeout, isSdkRetryable, isServerSide } from '../_shared/aws-errors';

/** A conditional `UpdateItem`/`DeleteItem` failed its condition — an OCC conflict (or write-once collision). */
export function isConditionalCheckFailed(err: unknown): boolean {
  return errorName(err) === 'ConditionalCheckFailedException';
}

/** Names DynamoDB uses for capacity/throttling + server-side faults that are safe to retry. */
const TRANSIENT_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'LimitExceededException',
]);

/**
 * A transient DynamoDB fault that is safe to retry: throttling / capacity-exceeded, any 5xx, a dropped or
 * timed-out connection, or anything the SDK itself marks retryable. A failed condition is **never** transient
 * (it is a deterministic compare-and-swap outcome — `publishGeneration`'s own re-read-and-retry loop owns that,
 * not this wrapper, because the row has to be read again before the next attempt can decide anything).
 */
export function isTransient(err: unknown): boolean {
  if (isConditionalCheckFailed(err)) return false;
  return (
    TRANSIENT_NAMES.has(errorName(err) ?? '') ||
    isServerSide(err) ||
    isNetworkOrTimeout(err) ||
    isSdkRetryable(err)
  );
}
