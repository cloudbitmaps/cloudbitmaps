import {
  isConditionalConflict,
  isInvalidRange,
  isNotFound,
  isPreconditionFailed,
  isTransient,
  totalFromContentRange,
} from '@/drivers/s3/s3-errors';

// The subtlest S3-specific logic — error classification + Content-Range parsing — unit-tested over fake
// SDK error/header shapes, so it's covered on the normal lane (not only the Docker/MinIO integration lane).
describe('S3 error classification', () => {
  it('detects a precondition failure (write-once conflict) by name or status', () => {
    expect(isPreconditionFailed({ name: 'PreconditionFailed' })).toBe(true);
    expect(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    expect(isPreconditionFailed({ name: 'NoSuchKey' })).toBe(false);
    expect(isPreconditionFailed(undefined)).toBe(false);
    expect(isPreconditionFailed(null)).toBe(false);
  });

  it('detects a conditional-write conflict from BOTH 412 and 409 (concurrent conditional writes)', () => {
    expect(isConditionalConflict({ name: 'PreconditionFailed' })).toBe(true); // 412 path
    expect(isConditionalConflict({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    expect(isConditionalConflict({ name: 'ConditionalRequestConflict' })).toBe(true); // 409 path
    expect(isConditionalConflict({ $metadata: { httpStatusCode: 409 } })).toBe(true);
    expect(isConditionalConflict({ name: 'NoSuchKey' })).toBe(false);
    // A 409 conflict is caller-meaningful OCC, NOT a blind-retryable transient.
    expect(isTransient({ $metadata: { httpStatusCode: 409 } })).toBe(false);
    expect(isTransient({ name: 'ConditionalRequestConflict' })).toBe(false);
  });

  it('detects not-found (GetObject NoSuchKey, HeadObject NotFound, or 404)', () => {
    expect(isNotFound({ name: 'NoSuchKey' })).toBe(true); // GetObject on a missing key
    expect(isNotFound({ name: 'NotFound' })).toBe(true); // HeadObject on a missing key
    expect(isNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isNotFound({ name: 'PreconditionFailed' })).toBe(false);
    expect(isNotFound(new Error('boom'))).toBe(false);
  });

  it('detects an invalid range (416)', () => {
    expect(isInvalidRange({ name: 'InvalidRange' })).toBe(true);
    expect(isInvalidRange({ $metadata: { httpStatusCode: 416 } })).toBe(true);
    expect(isInvalidRange({ $metadata: { httpStatusCode: 200 } })).toBe(false);
  });

  describe('isTransient (retryable faults)', () => {
    it('flags throttling, 5xx, network/timeout, and SDK-marked retryables', () => {
      expect(isTransient({ name: 'SlowDown' })).toBe(true); // S3 throttling
      expect(isTransient({ $metadata: { httpStatusCode: 503 } })).toBe(true);
      expect(isTransient({ $metadata: { httpStatusCode: 500 } })).toBe(true);
      expect(isTransient({ name: 'TimeoutError' })).toBe(true);
      expect(isTransient({ code: 'ECONNRESET' })).toBe(true);
      expect(isTransient({ $retryable: { throttling: true } })).toBe(true);
    });
    it('never reclassifies the deterministic outcomes (412/404/416)', () => {
      expect(isTransient({ name: 'PreconditionFailed' })).toBe(false);
      expect(isTransient({ $metadata: { httpStatusCode: 404 } })).toBe(false);
      expect(isTransient({ name: 'InvalidRange' })).toBe(false);
      expect(isTransient({ $metadata: { httpStatusCode: 400 } })).toBe(false); // a 4xx is the caller's fault
      expect(isTransient(new Error('plain'))).toBe(false);
    });
  });

  describe('totalFromContentRange', () => {
    it('parses the total after the final slash', () => {
      expect(totalFromContentRange('bytes 0-15/1234')).toBe(1234);
      expect(totalFromContentRange('bytes 1200-1233/1234')).toBe(1234);
      expect(totalFromContentRange('bytes 0-0/1')).toBe(1);
    });

    it('returns undefined for missing / unsatisfiable / unparseable / unsafe', () => {
      expect(totalFromContentRange(undefined)).toBeUndefined();
      expect(totalFromContentRange('bytes */1234')).toBe(1234); // total still present
      expect(totalFromContentRange('bytes 0-15/*')).toBeUndefined(); // unknown total
      expect(totalFromContentRange('garbage')).toBeUndefined();
      expect(totalFromContentRange('bytes 0-15/99999999999999999999')).toBeUndefined(); // > MAX_SAFE_INTEGER
    });
  });
});
