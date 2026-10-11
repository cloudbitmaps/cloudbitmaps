import { isTransient as isS3Transient, transientFaultMessage as s3Message } from '@/s3/s3-errors';
import {
  isTransient as isGcsTransient,
  transientFaultMessage as gcsMessage,
} from '@/gcs/gcs-errors';
import {
  isTransient as isAzureTransient,
  transientFaultMessage as azureMessage,
} from '@/azure-blob/azure-errors';

/**
 * A connection Node reports as failed or cut off is transient on every cloud driver: the codes come from one predicate
 * in the driver kit, so a write and a read, or two drivers, cannot disagree about one. Each driver's own additions are
 * pinned here too, so changing them is a decision a test records.
 */
const DRIVERS = [
  ['S3', isS3Transient],
  ['GCS', isGcsTransient],
  ['Azure Blob', isAzureTransient],
] as const;

const SHARED = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
];

const netErr = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code });

describe.each(DRIVERS)('%s: a connection fault is transient', (_label, isTransient) => {
  it.each(SHARED)('%s', (code) => {
    expect(isTransient(netErr(code))).toBe(true);
  });

  it('a missing credentials file or a TLS failure is not', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPROTO']) {
      expect(isTransient(netErr(code)), code).toBe(false);
    }
  });
});

describe('the codes one driver takes beside the shared ones', () => {
  it('a body cut off mid-stream is transient on GCS alone', () => {
    expect(isGcsTransient(netErr('ERR_STREAM_PREMATURE_CLOSE'))).toBe(true);
    expect(isS3Transient(netErr('ERR_STREAM_PREMATURE_CLOSE'))).toBe(false);
    expect(isAzureTransient(netErr('ERR_STREAM_PREMATURE_CLOSE'))).toBe(false);
  });

  it('a socket timeout under its older name is transient on Azure Blob alone', () => {
    expect(isAzureTransient(netErr('ESOCKETTIMEDOUT'))).toBe(true);
    expect(isS3Transient(netErr('ESOCKETTIMEDOUT'))).toBe(false);
    expect(isGcsTransient(netErr('ESOCKETTIMEDOUT'))).toBe(false);
  });
});

describe('one wording per driver for a transient fault', () => {
  it('S3 names the SDK error', () => {
    expect(s3Message(Object.assign(new Error('x'), { name: 'SlowDown' }))).toBe(
      'transient S3 fault: SlowDown',
    );
    expect(s3Message({})).toBe('transient S3 fault: unknown');
  });

  it('GCS names the status or the connection code, else the error', () => {
    expect(gcsMessage({ code: 503 })).toBe('transient GCS fault: 503');
    expect(gcsMessage(netErr('ECONNRESET'))).toBe('transient GCS fault: ECONNRESET');
    expect(gcsMessage({ name: 'ApiError', response: { status: 503 } })).toBe(
      'transient GCS fault: ApiError',
    );
    expect(gcsMessage({})).toBe('transient GCS fault: unknown');
  });

  it('Azure Blob names the Azure error code or the connection code, else the error', () => {
    expect(azureMessage({ statusCode: 503, code: 'ServerBusy', name: 'RestError' })).toBe(
      'transient Azure fault: ServerBusy',
    );
    expect(azureMessage({ statusCode: 500, details: { errorCode: 'InternalError' } })).toBe(
      'transient Azure fault: InternalError',
    );
    expect(azureMessage(netErr('ECONNRESET'))).toBe('transient Azure fault: ECONNRESET');
    expect(azureMessage({ statusCode: 503, name: 'RestError' })).toBe(
      'transient Azure fault: RestError',
    );
    expect(azureMessage({})).toBe('transient Azure fault: unknown');
  });
});
