import { isTransient } from '@/drivers/postgres/postgres-errors';

/** `pg` sets `.code` to the SQLSTATE (5 chars) on a server error, or a Node socket code on a connection drop. */
const pgErr = (code: string) => Object.assign(new Error(code), { code });

describe('Postgres error classification', () => {
  it('serialization/deadlock (class 40), connection (08), resource (53) are transient', () => {
    for (const c of ['40001', '40P01', '08006', '08003', '08000', '53300', '53200']) {
      expect(isTransient(pgErr(c))).toBe(true);
    }
  });

  it('operator-intervention shutdown / cannot-connect-now are transient', () => {
    for (const c of ['57P03', '57P01', '57P02']) expect(isTransient(pgErr(c))).toBe(true);
  });

  it('dropped/timed-out sockets are transient', () => {
    for (const n of [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EAI_AGAIN',
      'ENOTFOUND',
    ]) {
      expect(isTransient(pgErr(n))).toBe(true);
    }
  });

  it('pg connection-lost errors (code-less, message-only) are transient', () => {
    // pg throws these as a plain Error with NO `.code` (pg/lib/client.js, pg-pool) — must still be retried.
    for (const m of [
      'Connection terminated unexpectedly',
      'Connection terminated due to connection timeout',
      'Client has encountered a connection error and is not queryable',
      'timeout exceeded when trying to connect',
    ]) {
      expect(isTransient(new Error(m))).toBe(true);
    }
    // An unrelated message with no code is NOT transient.
    expect(isTransient(new Error('relation does not exist'))).toBe(false);
  });

  it('deterministic, caller-meaningful errors are NOT transient (must surface, not blind-retry)', () => {
    for (const c of [
      '23505', // unique_violation
      '23502', // not_null_violation
      '42601', // syntax_error
      '42P01', // undefined_table
      '42703', // undefined_column
      '22P02', // invalid_text_representation
    ]) {
      expect(isTransient(pgErr(c))).toBe(false);
    }
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});
