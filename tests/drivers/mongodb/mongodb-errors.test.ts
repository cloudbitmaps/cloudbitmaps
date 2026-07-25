import { isDuplicateKey, isTransient } from '@/drivers/mongodb/mongodb-errors';

const codeErr = (code: number | string) => Object.assign(new Error(String(code)), { code });
const named = (name: string) => Object.assign(new Error(name), { name });
const labelled = (label: string) =>
  Object.assign(new Error(label), { hasErrorLabel: (l: string) => l === label });

describe('MongoDB error classification', () => {
  it('duplicate key (11000/11001) is the create-if-absent conflict, never transient', () => {
    expect(isDuplicateKey(codeErr(11000))).toBe(true);
    expect(isDuplicateKey(codeErr(11001))).toBe(true);
    expect(isTransient(codeErr(11000))).toBe(false);
  });

  it('network / server-selection / retryable-label / failover-code faults are transient', () => {
    expect(isTransient(named('MongoNetworkError'))).toBe(true);
    expect(isTransient(named('MongoServerSelectionError'))).toBe(true);
    expect(isTransient(labelled('RetryableWriteError'))).toBe(true);
    expect(isTransient(labelled('TransientTransactionError'))).toBe(true);
    for (const c of [10107, 11602, 13435, 189, 91, 6, 7, 89]) {
      expect(isTransient(codeErr(c))).toBe(true);
    }
    for (const n of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']) {
      expect(isTransient(codeErr(n))).toBe(true);
    }
  });

  it('deterministic / unknown errors are NOT transient (must surface)', () => {
    expect(isTransient(codeErr(2))).toBe(false); // BadValue
    expect(isTransient(codeErr(121))).toBe(false); // DocumentValidationFailure
    expect(isTransient(named('MongoServerError'))).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
  });
});
