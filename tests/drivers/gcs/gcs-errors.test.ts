import {
  isInvalidRange,
  isNotFound,
  isPreconditionFailed,
  isTransient,
} from '@/drivers/gcs/gcs-errors';

/** GCS carries the HTTP status on `err.code` (number) or `err.response.status`; sockets use a string code. */
const apiErr = (code: number) => ({ code });
const respErr = (status: number) => ({ response: { status } });
const netErr = (code: string) => ({ code });

describe('GCS error classification', () => {
  it('412 = write-once precondition conflict (never a transient)', () => {
    expect(isPreconditionFailed(apiErr(412))).toBe(true);
    expect(isPreconditionFailed(respErr(412))).toBe(true);
    expect(isTransient(apiErr(412))).toBe(false);
  });

  it('404 = not found (never a transient)', () => {
    expect(isNotFound(apiErr(404))).toBe(true);
    expect(isTransient(apiErr(404))).toBe(false);
  });

  it('416 = out-of-range (never a transient)', () => {
    expect(isInvalidRange(apiErr(416))).toBe(true);
    expect(isTransient(apiErr(416))).toBe(false);
  });

  it('429 + any 5xx + dropped sockets are transient', () => {
    for (const c of [429, 500, 502, 503, 504]) expect(isTransient(apiErr(c))).toBe(true);
    for (const n of [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EPIPE',
      'EAI_AGAIN',
      'ENOTFOUND',
    ]) {
      expect(isTransient(netErr(n))).toBe(true);
    }
  });

  it('a 400 / unknown error is NOT transient (surfaces, not blind-retried)', () => {
    expect(isTransient(apiErr(400))).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});
