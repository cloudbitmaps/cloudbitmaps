import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from '@/s3/storage';
import { S3Storage } from '@/s3/backend';
import { storageObjectKey } from '@/s3/keys';
import { NotFoundError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { isolateAwsEnv, type IsolatedAwsEnv } from '../../helpers/aws-env';
import { BUCKET, StubBucket, sdkWithout } from '../../helpers/stub-s3-bucket';

/**
 * The S3 storage half's conditional delete: a `DeleteObject` under `If-Match: <the ETag a tail read reported>`, where
 * the store applies it. The client is the SDK's real one over a bucket in memory that honours `If-Match` on a delete
 * and answers `412` for one on a key with no object, as RFC 9110 has it, so the cases see what the driver sends and
 * what it makes of each answer.
 */

const KEY: GenKey = { segment: 's', generation: 1 };
const OBJECT = storageObjectKey(undefined, KEY);

let env: IsolatedAwsEnv;
const restores: Array<() => void> = [];
beforeEach(() => {
  env = isolateAwsEnv();
});
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  env.restore();
});

/** A client that resolves its own endpoint, as a default AWS S3 client does, over `bucket`'s transport. */
const awsClient = (bucket: StubBucket): S3Client => bucket.client({ endpoint: undefined });

/** Store `text` under the generation's key, as a load would, and return the ETag a tail read of it reports. */
async function stored(driver: S3StorageDriver, text: string): Promise<string> {
  await driver.putImmutable(KEY, (sink) => sink.write(new TextEncoder().encode(text)));
  const { version } = await driver.getTail(KEY, 4);
  expect(version).toEqual(expect.stringMatching(/^"e\d+"$/));
  return version!;
}

describe('S3StorageDriver: a tail read reports the ETag', () => {
  it('of the GetObject that carried the bytes, and of the HeadObject when none were asked for', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await driver.putImmutable(KEY, (sink) => sink.write(new TextEncoder().encode('hello')));
    const etag = bucket.objects.get(OBJECT)!.etag;
    expect((await driver.getTail(KEY, 3)).version).toBe(etag);
    expect((await driver.getTail(KEY, 0)).version).toBe(etag);
    expect((await driver.getTail(KEY, 100)).version).toBe(etag);
  });
});

describe('S3StorageDriver: a delete given ifVersion on AWS S3', () => {
  it('is off until the first such delete asks the client, then sends If-Match with the ETag, and deletes', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: awsClient(bucket), bucket: BUCKET });
    const etag = await stored(driver, 'one');
    expect(driver.capabilities().conditionalDelete).toBe(false);
    await driver.delete(KEY, { ifVersion: etag });
    expect(driver.capabilities().conditionalDelete).toBe(true);
    expect(bucket.ifMatchOnDelete).toEqual([etag]);
    expect(bucket.objects.has(OBJECT)).toBe(false);
  });

  it('another object under the key since: 412, a HeadObject finds it, WriteConflictError, and it stays', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: awsClient(bucket), bucket: BUCKET });
    const first = await stored(driver, 'one');
    await driver.delete(KEY);
    const second = await stored(driver, 'two');
    expect(second).not.toBe(first);
    await expect(driver.delete(KEY, { ifVersion: first })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(bucket.objects.get(OBJECT)?.etag).toBe(second);
    expect(bucket.count('HeadObject')).toBeGreaterThanOrEqual(1);
  });

  it('a 409 for a conditional request racing another on the key is a conflict while an object is there', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: awsClient(bucket), bucket: BUCKET });
    const etag = await stored(driver, 'one');
    bucket.answerWith('DeleteObject', 409, 'ConditionalRequestConflict');
    await expect(driver.delete(KEY, { ifVersion: etag })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(bucket.objects.has(OBJECT)).toBe(true);
  });

  it.each([
    ['204, as AWS documents', undefined],
    ['404 NoSuchKey', { statusCode: 404, code: 'NoSuchKey' }],
    ['412, as RFC 9110 has it (what the stub answers)', 'stub'],
  ] as const)('an absent object is a no-op whichever answer it gets: %s', async (_, answer) => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: awsClient(bucket), bucket: BUCKET });
    const etag = await stored(driver, 'one');
    await driver.delete(KEY);
    if (answer === undefined) {
      // A 204 for the absent key: the stub's own answer is a 412, so the request is answered as AWS documents it.
      bucket.answerWith('DeleteObject', 204, '');
    } else if (answer !== 'stub') {
      bucket.answerWith('DeleteObject', answer.statusCode, answer.code);
    }
    await expect(driver.delete(KEY, { ifVersion: etag })).resolves.toBeUndefined();
    await expect(driver.delete({ ...KEY, generation: 9 }, { ifVersion: etag })).resolves.toBe(
      undefined,
    );
  });

  it('a copy the SDK sends again after a lost response meets its own landed delete: success', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: awsClient(bucket), bucket: BUCKET });
    const etag = await stored(driver, 'one');
    bucket.loseResponseOf('DeleteObject');
    await expect(driver.delete(KEY, { ifVersion: etag })).resolves.toBeUndefined();
    expect(bucket.ifMatchOnDelete).toEqual([etag]); // applied once
    expect(bucket.count('DeleteObject')).toBe(2); // and sent again, which found the key empty
    expect(bucket.objects.has(OBJECT)).toBe(false);
  });

  it('a bucket that does not exist is not an absent object', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: awsClient(bucket), bucket: BUCKET });
    const etag = await stored(driver, 'one');
    bucket.answerWith('DeleteObject', 404, 'NoSuchBucket');
    const err = await driver.delete(KEY, { ifVersion: etag }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(WriteConflictError);
  });
});

describe('S3StorageDriver: where the condition is not relied on, it is not sent', () => {
  it('a custom endpoint, by default: no If-Match, and a stale version deletes what is there', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    const first = await stored(driver, 'one');
    await driver.delete(KEY);
    await stored(driver, 'two');
    await driver.delete(KEY, { ifVersion: first });
    expect(driver.capabilities().conditionalDelete).toBe(false);
    expect(bucket.ifMatchOnDelete).toEqual([undefined, undefined]);
    expect(bucket.objects.has(OBJECT)).toBe(false);
  });

  it('`conditionalDelete: true` on a custom endpoint sends it, and `false` on AWS S3 does not', async () => {
    const vouched = new StubBucket();
    const on = new S3StorageDriver({
      client: vouched.client(),
      bucket: BUCKET,
      conditionalDelete: true,
    });
    expect(on.capabilities().conditionalDelete).toBe(true);
    const first = await stored(on, 'one');
    await expect(on.delete(KEY, { ifVersion: '"stale"' })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    await on.delete(KEY, { ifVersion: first });
    expect(vouched.ifMatchOnDelete).toEqual([first]);

    const aws = new StubBucket();
    const off = new S3StorageDriver({
      client: awsClient(aws),
      bucket: BUCKET,
      conditionalDelete: false,
    });
    await stored(off, 'one');
    await off.delete(KEY, { ifVersion: '"stale"' });
    expect(off.capabilities().conditionalDelete).toBe(false);
    expect(aws.ifMatchOnDelete).toEqual([undefined]);
    expect(aws.objects.has(OBJECT)).toBe(false);
  });

  it('an SDK that does not send If-Match on a DeleteObject: never relied on, even when vouched for', async () => {
    restores.push(sdkWithout('DeleteObjectCommand', 'IfMatch'));
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({
      client: awsClient(bucket),
      bucket: BUCKET,
      conditionalDelete: true,
    });
    await stored(driver, 'one');
    await driver.delete(KEY, { ifVersion: '"stale"' });
    expect(driver.capabilities().conditionalDelete).toBe(false);
    expect(bucket.objects.has(OBJECT)).toBe(false);
  });

  it('a value that is not a boolean is refused', () => {
    const bucket = new StubBucket();
    expect(
      () =>
        new S3StorageDriver({
          client: bucket.client(),
          bucket: BUCKET,
          conditionalDelete: 'yes' as unknown as boolean,
        }),
    ).toThrow(ValidationError);
  });

  it('S3Storage hands its `conditionalDelete` to the storage half as well as the registry', async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({
      bucket: BUCKET,
      client: bucket.client(),
      conditionalDelete: true,
    });
    expect(backend.storage.capabilities().conditionalDelete).toBe(true);
    await backend.storage.putImmutable(KEY, (sink) => sink.write(new TextEncoder().encode('x')));
    await expect(backend.storage.delete(KEY, { ifVersion: '"stale"' })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });
});
