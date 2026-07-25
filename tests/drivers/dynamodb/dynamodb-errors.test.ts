import { isConditionalCheckFailed, isTransient } from '@/drivers/dynamodb/dynamodb-errors';

// Transient-vs-fatal classification for DynamoDB, unit-tested over fake SDK error shapes (off the
// DynamoDB-Local lane).
describe('DynamoDB error classification', () => {
  it('detects a failed condition (OCC conflict)', () => {
    expect(isConditionalCheckFailed({ name: 'ConditionalCheckFailedException' })).toBe(true);
    expect(isConditionalCheckFailed({ name: 'ThrottlingException' })).toBe(false);
    expect(isConditionalCheckFailed(null)).toBe(false);
  });

  describe('isTransient (retryable faults)', () => {
    it('flags throttling/capacity, 5xx, network/timeout, and SDK-marked retryables', () => {
      expect(isTransient({ name: 'ThrottlingException' })).toBe(true);
      expect(isTransient({ name: 'ProvisionedThroughputExceededException' })).toBe(true);
      expect(isTransient({ name: 'RequestLimitExceeded' })).toBe(true);
      expect(isTransient({ name: 'InternalServerError' })).toBe(true);
      expect(isTransient({ name: 'ServiceUnavailable' })).toBe(true);
      expect(isTransient({ $metadata: { httpStatusCode: 500 } })).toBe(true);
      expect(isTransient({ name: 'TimeoutError' })).toBe(true);
      expect(isTransient({ code: 'ECONNRESET' })).toBe(true);
      expect(isTransient({ $retryable: {} })).toBe(true);
    });
    it('never reclassifies a failed condition or a plain validation error', () => {
      expect(isTransient({ name: 'ConditionalCheckFailedException' })).toBe(false);
      expect(isTransient({ name: 'ValidationException' })).toBe(false);
      expect(isTransient(new Error('plain'))).toBe(false);
    });
  });
});
