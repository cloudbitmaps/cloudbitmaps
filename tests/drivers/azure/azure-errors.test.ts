import {
  isConditionalConflict,
  isInvalidRange,
  isNotFound,
  isTransient,
} from '@/drivers/azure/azure-errors';

/** Azure's `RestError` carries the HTTP status on `err.statusCode` and a code on `err.code`/`details.errorCode`. */
const statusErr = (statusCode: number) => ({ statusCode });
const codeErr = (code: string) => ({ code });
const detailsErr = (errorCode: string) => ({ details: { errorCode } });
const netErr = (code: string) => ({ code });

describe('Azure error classification', () => {
  it('409 BlobAlreadyExists = write-once conflict (verified shape; never a transient)', () => {
    // The exact shape Azurite/Azure returns for a lost `ifNoneMatch:'*'` race (empirically confirmed).
    expect(isConditionalConflict({ statusCode: 409, code: 'BlobAlreadyExists' })).toBe(true);
    expect(isConditionalConflict(statusErr(409))).toBe(true);
    expect(isConditionalConflict(codeErr('BlobAlreadyExists'))).toBe(true);
    expect(isTransient({ statusCode: 409, code: 'BlobAlreadyExists' })).toBe(false);
  });

  it('412 ConditionNotMet also = conflict (defensive: specific-ETag / non-Azurite backend)', () => {
    expect(isConditionalConflict(statusErr(412))).toBe(true);
    expect(isConditionalConflict(codeErr('ConditionNotMet'))).toBe(true);
    expect(isTransient(statusErr(412))).toBe(false);
  });

  it('404 = not found — keyed off status (code is undefined on a HEAD/getProperties)', () => {
    expect(isNotFound(statusErr(404))).toBe(true); // getProperties: no body, no code
    expect(isNotFound(detailsErr('BlobNotFound'))).toBe(true); // GET: details.errorCode present
    expect(isNotFound(codeErr('BlobNotFound'))).toBe(true);
    expect(isTransient(statusErr(404))).toBe(false);
  });

  it('416 = out-of-range (never a transient)', () => {
    expect(isInvalidRange(statusErr(416))).toBe(true);
    expect(isInvalidRange(codeErr('InvalidRange'))).toBe(true);
    expect(isTransient(statusErr(416))).toBe(false);
  });

  it('429 + any 5xx + ServerBusy/OperationTimedOut + dropped sockets are transient', () => {
    for (const c of [429, 500, 502, 503, 504]) expect(isTransient(statusErr(c))).toBe(true);
    for (const c of ['ServerBusy', 'OperationTimedOut', 'InternalError']) {
      expect(isTransient(codeErr(c))).toBe(true);
    }
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
    expect(isTransient(statusErr(400))).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});
