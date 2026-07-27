import {
  CloudRoaringError,
  IntegrityError,
  NotFoundError,
  TimeoutError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isCloudRoaringError,
  isIntegrityError,
  isNotFoundError,
  isTransientError,
  isValidationError,
  isWriteConflictError,
} from '@/core/errors';

/**
 * Bundle-safe error predicates. This pins the classification LOGIC (brand + name matching);
 * the actual cross-bundle behaviour against the built subpath bundles is guarded by `scripts/smoke.cjs`.
 */
describe('error predicates', () => {
  it('classify each error by kind, and reject other kinds', () => {
    expect(isWriteConflictError(new WriteConflictError('x'))).toBe(true);
    expect(isNotFoundError(new NotFoundError('x'))).toBe(true);
    expect(isIntegrityError(new IntegrityError('x'))).toBe(true);
    expect(isValidationError(new ValidationError('x'))).toBe(true);
    // A different kind is not misclassified.
    expect(isWriteConflictError(new NotFoundError('x'))).toBe(false);
    expect(isValidationError(new IntegrityError('x'))).toBe(false);
  });

  it('isTransientError matches TransientError AND its TimeoutError subclass (brand, not name)', () => {
    expect(isTransientError(new TransientError('x'))).toBe(true);
    expect(isTransientError(new TimeoutError('x'))).toBe(true); // subclass — name differs, brand carries
    expect(isTransientError(new WriteConflictError('x'))).toBe(false);
  });

  it('isCloudRoaringError matches any of ours and nothing else', () => {
    expect(isCloudRoaringError(new WriteConflictError('x'))).toBe(true);
    expect(isCloudRoaringError(new CloudRoaringError('x'))).toBe(true);
    for (const foreign of [
      new Error('x'),
      new TypeError('x'),
      null,
      undefined,
      'x',
      {},
      { name: 'WriteConflictError' },
    ]) {
      expect(isCloudRoaringError(foreign)).toBe(false);
    }
    // A plain object merely NAMED like our error is not branded → not misclassified.
    expect(isWriteConflictError({ name: 'WriteConflictError' })).toBe(false);
  });
});
