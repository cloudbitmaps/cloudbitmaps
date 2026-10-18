import {
  CloudRoaringError,
  TransientError,
  ValidationError,
  WriteConflictError,
  errorKind,
  isUnsettledConflict,
  isWriteConflictError,
  unsettledConflict,
} from '@/core/errors';
import * as driverKit from '@/driver-kit';

/**
 * `unsettledConflict` marks a registry conflict that may follow the write's own landing. This pins the factory and the
 * predicate; where a publish reads the mark is held by `registry-write-token.test.ts` and `publish-reconcile.test.ts`.
 */

const MARK = Symbol.for('cloudbitmaps.error.unsettled-conflict');
const ERROR_MARK = Symbol.for('cloudbitmaps.error');

describe('unsettledConflict', () => {
  it('is a WriteConflictError in every other way', () => {
    const err = unsettledConflict('lost it');
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(err.message).toBe('lost it');
    expect(errorKind(err)).toBe('WriteConflictError');
    expect(isWriteConflictError(err)).toBe(true);
    expect(err.name).toBe('WriteConflictError');
  });

  it('carries the registered brand, not enumerably, and no cause', () => {
    const err = unsettledConflict('x');
    expect((err as unknown as Record<symbol, unknown>)[MARK]).toBe(true);
    expect(Object.keys(err)).not.toContain('cause');
    expect(Object.getOwnPropertySymbols(err)).toContain(MARK);
    expect(Object.prototype.propertyIsEnumerable.call(err, MARK)).toBe(false);
    // The brand cannot be removed or changed afterwards.
    expect(Object.getOwnPropertyDescriptor(err, MARK)).toEqual({
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect('cause' in err).toBe(false);
  });

  it('is exported by driver-kit, and the predicate by no entry', () => {
    expect(driverKit.unsettledConflict).toBe(unsettledConflict);
    expect('isUnsettledConflict' in driverKit).toBe(false);
  });
});

describe('isUnsettledConflict', () => {
  it('holds for the marked conflict, and for nothing else', () => {
    expect(isUnsettledConflict(unsettledConflict('x'))).toBe(true);
    expect(isUnsettledConflict(new WriteConflictError('x'))).toBe(false);
    expect(isUnsettledConflict(new ValidationError('x'))).toBe(false);
    expect(isUnsettledConflict(new CloudRoaringError('x'))).toBe(false);
    expect(isUnsettledConflict(new TransientError('x'))).toBe(false);
    for (const v of [null, undefined, 'x', 1, {}, new Error('x')]) {
      expect(isUnsettledConflict(v)).toBe(false);
    }
  });

  it('does not hold for another class carrying the mark: both the mark and the name are read', () => {
    const marked = new ValidationError('x');
    Object.defineProperty(marked, MARK, { value: true });
    expect(isUnsettledConflict(marked)).toBe(false);
    // A plain object with the mark and the name but no error brand is not one of ours either.
    expect(
      isUnsettledConflict(
        Object.defineProperty({ name: 'WriteConflictError' }, MARK, { value: true }),
      ),
    ).toBe(false);
  });

  it('reads an error from another copy of the package, by its registered brands and name alone', () => {
    class ForeignConflict extends Error {
      override name = 'WriteConflictError';
    }
    const foreign = new ForeignConflict('from another copy');
    Object.defineProperty(foreign, ERROR_MARK, { value: true });
    expect(foreign instanceof WriteConflictError).toBe(false);
    expect(isUnsettledConflict(foreign)).toBe(false);
    Object.defineProperty(foreign, MARK, { value: true });
    expect(isUnsettledConflict(foreign)).toBe(true);
  });

  it('is lost when the error is copied into a new one', () => {
    const err = unsettledConflict('x');
    expect(isUnsettledConflict(new WriteConflictError(err.message))).toBe(false);
    expect(isUnsettledConflict(Object.assign(new WriteConflictError('x'), err))).toBe(false);
  });

  it('the mark is a Symbol.for key: a local Symbol of the same description is not it', () => {
    const local = new WriteConflictError('x');
    Object.defineProperty(local, Symbol('cloudbitmaps.error.unsettled-conflict'), { value: true });
    expect(isUnsettledConflict(local)).toBe(false);
  });
});
