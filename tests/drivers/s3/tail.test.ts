import { S3StorageDriver } from '@/s3/storage';
import { CrbmReader } from '@/core/crbm/reader';
import { IntegrityError, NotFoundError, TransientError, ValidationError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { STUB_BUCKET, StubS3Bucket } from '../../helpers/s3-bucket-stub';

/**
 * A tail read of an empty object, through a real `S3Client` over a stub transport. S3 answers a ranged read of a
 * zero-byte object with `416 InvalidRange`, so the driver confirms the size with a `HeadObject` and returns the empty
 * tail, as the GCS driver does. A real range fault on an object that has bytes stays a `ValidationError`.
 */

const GEN: GenKey = { segment: 's', generation: 0 };
const KEY = '_default/segments/s.0.crbm';

function driverOver(bucket: StubS3Bucket): S3StorageDriver {
  return new S3StorageDriver({ client: bucket.client(), bucket: STUB_BUCKET });
}

const store = (bucket: StubS3Bucket, body: Uint8Array): void => {
  bucket.objects.set(KEY, { body: Buffer.from(body), etag: '"e"', metadata: {} });
};

describe('S3StorageDriver.getTail on an empty object', () => {
  it('answers an empty tail of size 0 after confirming the size with a HEAD', async () => {
    const bucket = new StubS3Bucket();
    store(bucket, new Uint8Array(0));
    const tail = await driverOver(bucket).getTail(GEN, 64);
    expect(tail).toEqual({ bytes: new Uint8Array(0), size: 0 });
    expect(bucket.count('GetObject')).toBe(1);
    expect(bucket.count('HeadObject')).toBe(1);
  });

  it('keeps a 416 on an object that has bytes a ValidationError', async () => {
    const bucket = new StubS3Bucket();
    store(bucket, new Uint8Array(10));
    bucket.arm('GetObject', { status: 416, code: 'InvalidRange' });
    await expect(driverOver(bucket).getTail(GEN, 64)).rejects.toBeInstanceOf(ValidationError);
    expect(bucket.count('HeadObject')).toBe(1);
  });

  it('keeps a missing object a NotFoundError and a 5xx on the confirming HEAD a TransientError', async () => {
    await expect(driverOver(new StubS3Bucket()).getTail(GEN, 64)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const bucket = new StubS3Bucket();
    store(bucket, new Uint8Array(0));
    for (let i = 0; i < 8; i++) bucket.arm('HeadObject', { status: 500, code: 'InternalError' });
    await expect(driverOver(bucket).getTail(GEN, 64)).rejects.toBeInstanceOf(TransientError);
  });

  it('is not a valid .crbm: opening it is an IntegrityError, not a range error', async () => {
    const bucket = new StubS3Bucket();
    store(bucket, new Uint8Array(0));
    const driver = driverOver(bucket);
    const blob = {
      getRange: (offset: number, length: number) => driver.getRange(GEN, offset, length),
      getTail: (maxBytes: number) => driver.getTail(GEN, maxBytes),
    };
    await expect(CrbmReader.open(blob)).rejects.toBeInstanceOf(IntegrityError);
  });
});
