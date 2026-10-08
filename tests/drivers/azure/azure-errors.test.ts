import {
  isConditionalConflict,
  isInvalidRange,
  isMissingContainer,
  isNotFound,
  isPreconditionFailed,
  isTransient,
} from '@/azure-blob/azure-errors';

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

  it('a 409 or 412 that names another cause is not a lost race', () => {
    // A write-once (WORM) container refuses every overwrite with 409 BlobImmutableDueToPolicy, and a blob leased in
    // the portal answers 412 LeaseIdMissing: read as a lost race, a load reported another loader winning and a
    // registry write spent its attempts as "contention".
    for (const [status, code] of [
      [409, 'BlobImmutableDueToPolicy'],
      [409, 'LeaseAlreadyPresent'],
      [409, 'BlobArchived'],
      [412, 'LeaseIdMissing'],
      [412, 'LeaseNotPresentWithBlobOperation'],
    ] as const) {
      expect(isConditionalConflict({ statusCode: status, code })).toBe(false);
      expect(isConditionalConflict({ statusCode: status, details: { errorCode: code } })).toBe(
        false,
      );
      expect(isPreconditionFailed({ statusCode: status, code })).toBe(false);
      expect(isTransient({ statusCode: status, code })).toBe(false);
    }
    expect(isPreconditionFailed({ statusCode: 412, code: 'ConditionNotMet' })).toBe(true);
    expect(isPreconditionFailed(statusErr(412))).toBe(true);
    expect(isConditionalConflict({ statusCode: 409, code: 'BlobAlreadyExists' })).toBe(true);
    expect(isConditionalConflict({ statusCode: 412, code: 'ConditionNotMet' })).toBe(true);
  });

  it('404 = not found — keyed off status (code is undefined on a HEAD/getProperties)', () => {
    expect(isNotFound(statusErr(404))).toBe(true); // getProperties: no body, no code
    expect(isNotFound(detailsErr('BlobNotFound'))).toBe(true); // GET: details.errorCode present
    expect(isNotFound(codeErr('BlobNotFound'))).toBe(true);
    // A missing container is not a missing blob, on a GET (code) or a HEAD (the header's code only).
    const noContainer = { statusCode: 404, code: 'ContainerNotFound' };
    const noContainerHead = { statusCode: 404, details: { errorCode: 'ContainerNotFound' } };
    expect(isMissingContainer(noContainer)).toBe(true);
    expect(isMissingContainer(noContainerHead)).toBe(true);
    expect(isNotFound(noContainer)).toBe(false);
    expect(isNotFound(noContainerHead)).toBe(false);
    expect(isTransient(noContainer)).toBe(false);
    expect(isMissingContainer(detailsErr('BlobNotFound'))).toBe(false);
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
