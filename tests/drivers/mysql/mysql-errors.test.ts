import { isDuplicateKey, isTransient } from '@/drivers/mysql/mysql-errors';

/** `mysql2` sets `.errno` (a MySQL error number) and `.code` (a string) on a thrown error. */
const myErr = (props: { errno?: number; code?: string }) => Object.assign(new Error('x'), props);

describe('MySQL duplicate-key classification', () => {
  it('recognises ER_DUP_ENTRY by errno 1062 and by code', () => {
    expect(isDuplicateKey(myErr({ errno: 1062 }))).toBe(true);
    expect(isDuplicateKey(myErr({ code: 'ER_DUP_ENTRY' }))).toBe(true);
  });

  it('does not treat other errors as a duplicate key', () => {
    expect(isDuplicateKey(myErr({ errno: 1205 }))).toBe(false);
    expect(isDuplicateKey(myErr({ code: 'ER_PARSE_ERROR' }))).toBe(false);
    expect(isDuplicateKey(null)).toBe(false);
    expect(isDuplicateKey({})).toBe(false);
  });
});

describe('MySQL error classification', () => {
  it('lock-wait/deadlock, too-many-connections, shutdown/killed, server-gone/lost are transient', () => {
    for (const n of [1205, 1213, 1040, 1203, 1053, 1927, 2006, 2013]) {
      expect(isTransient(myErr({ errno: n }))).toBe(true);
    }
  });

  it('mysql2 connection-lost codes and dropped/timed-out sockets are transient', () => {
    for (const c of [
      'PROTOCOL_CONNECTION_LOST',
      'PROTOCOL_SEQUENCE_TIMEOUT',
      'CR_SERVER_GONE_ERROR',
      'CR_SERVER_LOST',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EAI_AGAIN',
      'ENOTFOUND',
    ]) {
      expect(isTransient(myErr({ code: c }))).toBe(true);
    }
  });

  it('deterministic, caller-meaningful errors are NOT transient (must surface, not blind-retry)', () => {
    for (const n of [
      1062, // ER_DUP_ENTRY (a conflict, handled separately — never a transient)
      1064, // ER_PARSE_ERROR
      1146, // ER_NO_SUCH_TABLE
      1054, // ER_BAD_FIELD_ERROR
      1406, // ER_DATA_TOO_LONG
    ]) {
      expect(isTransient(myErr({ errno: n }))).toBe(false);
    }
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});
