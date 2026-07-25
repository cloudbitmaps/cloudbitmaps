import {
  errorCode,
  errorName,
  httpStatus,
  isNetworkOrTimeout,
  isSdkRetryable,
  isServerSide,
} from '@/drivers/_shared/aws-errors';

// Shared structural AWS-error readers, used by both the S3 and DynamoDB transient classifiers.
describe('shared AWS error helpers', () => {
  it('reads name / httpStatus / code defensively (null-safe)', () => {
    expect(errorName({ name: 'X' })).toBe('X');
    expect(errorName(null)).toBeUndefined();
    expect(httpStatus({ $metadata: { httpStatusCode: 503 } })).toBe(503);
    expect(httpStatus({})).toBeUndefined();
    expect(errorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(errorCode(undefined)).toBeUndefined();
  });

  it('isServerSide is true only for 5xx', () => {
    expect(isServerSide({ $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(isServerSide({ $metadata: { httpStatusCode: 599 } })).toBe(true);
    expect(isServerSide({ $metadata: { httpStatusCode: 499 } })).toBe(false);
    expect(isServerSide({ $metadata: { httpStatusCode: 400 } })).toBe(false);
  });

  it('isSdkRetryable keys off the SDK $retryable marker', () => {
    expect(isSdkRetryable({ $retryable: { throttling: true } })).toBe(true);
    expect(isSdkRetryable({ $retryable: {} })).toBe(true);
    expect(isSdkRetryable({})).toBe(false);
  });

  it('isNetworkOrTimeout matches transport names, codes, and anchored message patterns', () => {
    expect(isNetworkOrTimeout({ name: 'TimeoutError' })).toBe(true);
    expect(isNetworkOrTimeout({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isNetworkOrTimeout({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isNetworkOrTimeout(new Error('socket hang up'))).toBe(true);
    expect(isNetworkOrTimeout(new Error('connection timed out'))).toBe(true);
    expect(isNetworkOrTimeout(new Error('Request timeout after 3000ms'))).toBe(true);
    expect(isNetworkOrTimeout(new Error('deterministic boom'))).toBe(false);
    expect(isNetworkOrTimeout({ name: 'ValidationException' })).toBe(false);
  });

  it('does NOT over-match deterministic messages that merely contain "time out" (regression)', () => {
    // The classifier must not retry a deterministic ValidationException just because its message says
    // "timed out of range" — only timeout phrases anchored to a transport word count.
    expect(isNetworkOrTimeout(new Error('value timed out of range'))).toBe(false);
    expect(isNetworkOrTimeout(new Error('parameter timeout exceeded the allowed set'))).toBe(false);
    expect(isNetworkOrTimeout(new Error('the item timed out of the cache window'))).toBe(false);
  });
});
