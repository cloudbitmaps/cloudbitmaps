import {
  isDownloadRetryable,
  isInvalidRange,
  isNotFound,
  isPreconditionFailed,
  isTransient,
} from '@/gcs/gcs-errors';

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

  // The driver retries a download in the SDK's place, so it retries what the SDK's own predicate
  // (`RETRYABLE_ERR_FN_DEFAULT` in @google-cloud/storage 8.1.0) retries, and nothing more.
  it('a download is retried after exactly what the SDK retries, and after nothing else', () => {
    for (const c of [408, 429, 500, 502, 503, 504]) {
      expect(isDownloadRetryable(apiErr(c))).toBe(true);
      expect(isDownloadRetryable({ code: String(c) })).toBe(true);
    }
    for (const n of ['ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'getaddrinfo EAI_AGAIN'])
      expect(isDownloadRetryable(netErr(n))).toBe(true);
    for (const reason of [
      'unexpected connection closure',
      'socket connection timeout',
      'ECONNRESET',
    ])
      expect(isDownloadRetryable({ code: 400, errors: [{ reason }] })).toBe(true);
    for (const c of [400, 401, 403, 404, 412, 416, 501, 505])
      expect(isDownloadRetryable(apiErr(c))).toBe(false);
    for (const n of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'])
      expect(isDownloadRetryable(netErr(n))).toBe(false);
    expect(isDownloadRetryable(new Error('boom'))).toBe(false);
    expect(isDownloadRetryable(null)).toBe(false);
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
