import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Storage } from '@/s3/backend';
import { S3StorageDriver } from '@/s3/storage';
import { S3RegistryStore } from '@/s3/registry';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { CREATED_TOKEN, tokenAfter } from '../../helpers/tokens';

/**
 * A conditional write is sent once, through a real `S3Client`.
 *
 * The client here is the SDK's own, with its default retry strategy, signing and checksums; only the transport under
 * it is a stub, so what these tests see is what the SDK does. The stub is a bucket in memory that honours
 * `If-None-Match: *` and `If-Match`, and it can be told to apply the next matching request and then lose its response,
 * which is what a timeout or a reset connection does to a write the service had already applied. The SDK's retry
 * would re-send that write, meet the write itself, and get 412; so a driver that let it would report a lost race for
 * a write that landed. Each write test asserts the request count as well as the error, because the error alone could
 * come from either.
 */

import { BUCKET, StubBucket } from '../../helpers/stub-s3-bucket';

const FIVE_MIB = 5 * 1024 * 1024;

const GEN: GenKey = { segment: 's', generation: 0 };
const REF = { segment: 's' };

const put = (driver: S3StorageDriver, bytes: Uint8Array, key: GenKey = GEN) =>
  driver.putImmutable(key, async (sink) => {
    await sink.write(bytes);
  });

describe('S3: a conditional write is sent once, whatever the SDK retry would do', () => {
  it('a write-once PutObject that lands and loses its response throws TransientError', async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    bucket.loseResponseOf('PutObject');

    const err = await put(backend.storage as S3StorageDriver, new Uint8Array([1, 2, 3])).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(bucket.objects.size).toBe(1); // it landed: the caller has to find that out, and now can
  });

  it('a multipart CompleteMultipartUpload that lands and loses its response throws TransientError', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({
      client: bucket.client(),
      bucket: BUCKET,
      partBytes: FIVE_MIB,
    });
    bucket.loseResponseOf('CompleteMultipartUpload');

    const err = await put(driver, new Uint8Array(FIVE_MIB + 1)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(bucket.count('CompleteMultipartUpload')).toBe(1);
    expect(bucket.objects.size).toBe(1);
  });

  it("the registry's create that lands and loses its response throws TransientError", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    bucket.loseResponseOf('PutObject');

    const err = await backend.registry.create(REF, { currentGen: 0 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(await backend.registry.get(REF)).toMatchObject({
      currentGen: 0,
      token: expect.stringMatching(CREATED_TOKEN),
    });
  });

  it("the registry's compareAndSwap that lands and loses its response throws TransientError", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    bucket.loseResponseOf('PutObject');

    const err = await backend.registry
      .compareAndSwap(REF, token, { currentGen: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(2); // the create, then the swap once
    expect(await backend.registry.get(REF)).toMatchObject({
      currentGen: 1,
      token: expect.stringMatching(tokenAfter(token)),
    });
  });

  // The registry's delete writes a tombstone under `If-Match`, so it is a conditional write like the others. It is
  // idempotent, so a re-run settles it whichever way the first attempt went.
  it("the registry's delete writes its tombstone once, and a re-run settles it", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    await backend.registry.create(REF, { currentGen: 0 });
    bucket.loseResponseOf('PutObject');

    await expect(backend.registry.delete(REF)).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(2); // the create, then the tombstone once
    expect(await backend.registry.get(REF)).toBeNull();
    await backend.registry.delete(REF);
    expect(bucket.count('PutObject')).toBe(2); // already a tombstone: nothing left to write
  });

  // With `conditionalDelete` on, a delete removes the row with a DeleteObject under If-Match. A replay that met its own
  // landed delete would fail the precondition and read as a lost race, so it is sent once like the writes.
  it("the registry's conditional DeleteObject is sent once, with If-Match, and a re-run settles it", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({
      bucket: BUCKET,
      client: bucket.client(),
      conditionalDelete: true,
    });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    bucket.loseResponseOf('DeleteObject');

    await expect(backend.registry.delete(REF, token)).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('DeleteObject')).toBe(1);
    expect(bucket.ifMatchOnDelete).toEqual([expect.stringMatching(/^"e\d+"$/)]);
    expect(bucket.objects.size).toBe(0); // it landed: nothing is left for a full listing to read
    expect(await backend.registry.get(REF)).toBeNull();
    await backend.registry.delete(REF); // the unfenced re-run finds nothing, and sends nothing
    expect(bucket.count('DeleteObject')).toBe(1);
  });

  it('a DeleteObject answered 404 NoSuchKey (the object is gone, as for a delete that met its own landed twin) is a WriteConflictError', async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({
      bucket: BUCKET,
      client: bucket.client(),
      conditionalDelete: true,
    });
    await backend.registry.create(REF, { currentGen: 0 });
    const store = new S3RegistryStore(backend.client, BUCKET, 0, true);
    const [key] = [...bucket.objects.keys()];
    bucket.answerWith('DeleteObject', 404, 'NoSuchKey');
    // A lost race, not a fault: the sweep reports `failed: contended` and keeps purging, where a raw error would count
    // against the purges it is allowed to have refused.
    await expect(store.delete(key!, { version: '"any"' })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(bucket.count('DeleteObject')).toBe(1);
  });

  it('a DeleteObject whose If-Match no longer holds deletes nothing and is a WriteConflictError', async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({
      bucket: BUCKET,
      client: bucket.client(),
      conditionalDelete: true,
    });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    const store = new S3RegistryStore(backend.client, BUCKET, 0, true);
    const [key] = [...bucket.objects.keys()];
    await expect(store.delete(key!, { version: '"stale"' })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(bucket.count('DeleteObject')).toBe(1);
    expect(await backend.registry.get(REF)).toMatchObject({ token });
  });

  it('a conditional write refused for a skewed clock throws TransientError, unapplied', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    bucket.refuseForClockSkew('PutObject');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(bucket.objects.size).toBe(0);
    // The SDK corrected the client's clock on the refusal, so the caller's re-run is signed right and lands.
    await put(driver, new Uint8Array([1]));
    expect(bucket.objects.size).toBe(1);
  });

  it('a precondition that really fails is still WriteConflictError', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1]));

    await expect(put(driver, new Uint8Array([2]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('PutObject')).toBe(2);
  });

  it('holds for a caller-supplied client with more attempts and a cached middleware stack', async () => {
    const bucket = new StubBucket();
    const client = bucket.client({ cacheMiddleware: true, maxAttempts: 5 });
    // A plain PutObject through the same client first, so the client caches a handler for the class, retry in it.
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'other', Body: new Uint8Array([9]) }),
    );
    const driver = new S3StorageDriver({ client, bucket: BUCKET });
    bucket.loseResponseOf('PutObject');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(2); // the plain one, then the conditional one once
  });
});

describe('S3: a caller-supplied retry strategy does not reach a conditional write', () => {
  /** A strategy that grants the first retry at once and counts how often it is asked; a second ask is refused. */
  function eagerStrategy(): { strategy: unknown; asked: () => number } {
    let asked = 0;
    const token = { getRetryCount: () => asked, getRetryDelay: () => 0 };
    return {
      asked: () => asked,
      strategy: {
        acquireInitialRetryToken: async () => token,
        refreshRetryTokenForRetry: async () => {
          asked += 1;
          if (asked > 1) throw new Error('retry budget spent');
          return token;
        },
        recordSuccess: () => {},
      },
    };
  }

  it('sends the write once, and never asks the strategy', async () => {
    const bucket = new StubBucket();
    const { strategy, asked } = eagerStrategy();
    const driver = new S3StorageDriver({
      client: bucket.client({ retryStrategy: strategy }),
      bucket: BUCKET,
    });
    bucket.loseResponseOf('PutObject');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(asked()).toBe(0);
  });

  it('still lets that strategy retry a read', async () => {
    const bucket = new StubBucket();
    const { strategy, asked } = eagerStrategy();
    const driver = new S3StorageDriver({
      client: bucket.client({ retryStrategy: strategy }),
      bucket: BUCKET,
    });
    await put(driver, new Uint8Array([1, 2, 3, 4]));
    bucket.failBeforeApplying('GetObject');

    await expect(driver.getRange(GEN, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(bucket.count('GetObject')).toBe(2);
    expect(asked()).toBe(1);
  });
});

describe('S3: everything else keeps the SDK retry', () => {
  it('a read retries a dropped connection', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1, 2, 3, 4]));
    bucket.failBeforeApplying('GetObject');

    await expect(driver.getRange(GEN, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(bucket.count('GetObject')).toBe(2);
  });

  it('a delete retries a dropped connection', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1]));
    bucket.failBeforeApplying('DeleteObject');

    await driver.delete(GEN);
    expect(bucket.count('DeleteObject')).toBe(2);
    expect(bucket.objects.size).toBe(0);
  });

  it('a multipart upload’s part upload retries a dropped connection, and the upload still completes', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({
      client: bucket.client(),
      bucket: BUCKET,
      partBytes: FIVE_MIB,
    });
    bucket.failBeforeApplying('UploadPart');

    await put(driver, new Uint8Array(FIVE_MIB + 1));
    expect(bucket.count('UploadPart')).toBe(2); // the part, sent again after the drop
    expect(bucket.count('CompleteMultipartUpload')).toBe(1);
    expect(bucket.objects.size).toBe(1);
  });

  it('the caller’s own PutObject through the same client still retries after the driver wrote', async () => {
    const bucket = new StubBucket();
    const client = bucket.client();
    const driver = new S3StorageDriver({ client, bucket: BUCKET });
    await put(driver, new Uint8Array([1]));
    bucket.loseResponseOf('PutObject');

    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'other', Body: new Uint8Array([9]) }),
    );
    expect(bucket.count('PutObject')).toBe(3); // the driver's, then the caller's twice: its retry is intact
  });
});
