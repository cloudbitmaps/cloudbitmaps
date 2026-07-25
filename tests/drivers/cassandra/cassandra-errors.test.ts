import { isTransient } from '@/drivers/cassandra/cassandra-errors';

const named = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, ...extra });
const codeErr = (code: string) => Object.assign(new Error(code), { code });

describe('Cassandra error classification', () => {
  it('driver connection/timeout/pool error classes are transient', () => {
    for (const n of [
      'NoHostAvailableError',
      'OperationTimedOutError',
      'BusyConnectionError',
      'DriverError',
    ]) {
      expect(isTransient(named(n))).toBe(true);
    }
  });

  it('a ResponseError with a retryable code (timeout/unavailable/overloaded) is transient', () => {
    for (const c of [0x1000, 0x1001, 0x1002, 0x1100, 0x1200]) {
      expect(isTransient(named('ResponseError', { code: c }))).toBe(true);
    }
  });

  it('a ResponseError that is deterministic OR a replica-side failure is NOT transient', () => {
    // 0x2xxx = deterministic (syntax/invalid/unauthorized/already-exists); 0x1300/0x1500 = replica-side
    // read/write FAILURE (not a timeout) — a blind retry wouldn't help, so they must surface.
    for (const c of [0x2000, 0x2200, 0x2100, 0x2400, 0x1300, 0x1500]) {
      expect(isTransient(named('ResponseError', { code: c }))).toBe(false);
    }
  });

  it('dropped/timed-out sockets are transient; unknown errors are not', () => {
    for (const n of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']) {
      expect(isTransient(codeErr(n))).toBe(true);
    }
    expect(isTransient(new Error('boom'))).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
  });
});
