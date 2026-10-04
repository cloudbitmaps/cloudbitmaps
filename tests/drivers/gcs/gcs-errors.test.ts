import {
  isDownloadRetryable,
  isInvalidRange,
  isNotFound,
  isPreconditionFailed,
  isTransient,
  isTransportFault,
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

  // The driver retries a download in the SDK's place, so it retries what the SDK retried: the statuses its predicate
  // (`RETRYABLE_ERR_FN_DEFAULT` in @google-cloud/storage 8.1.0) names, and any fault before a response, which
  // retry-request repeats without asking the predicate. And nothing more.
  it('a download is retried after what the SDK retried, and after nothing else', () => {
    for (const c of [408, 429, 500, 502, 503, 504]) {
      expect(isDownloadRetryable(apiErr(c))).toBe(true);
      expect(isDownloadRetryable({ code: String(c) })).toBe(true);
    }
    for (const n of [
      'ECONNRESET',
      'EPIPE',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ECONNABORTED',
      'ERR_STREAM_PREMATURE_CLOSE',
    ])
      expect(isDownloadRetryable(netErr(n))).toBe(true);
    // node-fetch's FetchError for a connection that never came carries the system code too.
    expect(isDownloadRetryable({ type: 'system', code: 'ECONNREFUSED' })).toBe(true);
    for (const reason of [
      'unexpected connection closure',
      'socket connection timeout',
      'ECONNRESET',
    ])
      expect(isDownloadRetryable({ code: 400, errors: [{ reason }] })).toBe(true);
    for (const c of [400, 401, 403, 404, 412, 416, 501, 505])
      expect(isDownloadRetryable(apiErr(c))).toBe(false);
    // Not a fault in transit, though some share its shape: a credentials file that is missing or unreadable, a TLS
    // failure (Node gives an https request to a plain-HTTP port EPROTO), a checksum mismatch, a programming error, a
    // status as a string.
    for (const n of [
      'ENOENT',
      'EACCES',
      'EISDIR',
      'EPROTO',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CONTENT_DOWNLOAD_MISMATCH',
      'ERR_INVALID_ARG_TYPE',
      '501',
    ])
      expect(isDownloadRetryable(netErr(n))).toBe(false);
    // A status wins over a code-shaped field: an HTTP 404 is never a fault in transit.
    expect(isDownloadRetryable({ code: 404, errno: 'ECONNRESET' })).toBe(false);
    expect(isDownloadRetryable(new Error('Could not load the default credentials'))).toBe(false);
    expect(isDownloadRetryable(null)).toBe(false);
  });

  it('a fault in transit is told from an answer by its code, not its message', () => {
    expect(isTransportFault(netErr('ECONNREFUSED'))).toBe(true);
    expect(isTransportFault(netErr('ERR_STREAM_PREMATURE_CLOSE'))).toBe(true);
    expect(isTransportFault(apiErr(503))).toBe(false);
    expect(isTransportFault({ response: { status: 500 }, code: 'ECONNRESET' })).toBe(false);
    expect(isTransportFault(new Error('ECONNREFUSED'))).toBe(false);
    expect(isTransportFault(netErr('ENOENT'))).toBe(false);
    expect(isTransportFault(netErr('EPROTO'))).toBe(false);
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
