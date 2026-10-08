import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { PROBE_KEY } from '@/s3/client-probe';
import { S3RegistryDriver } from '@/s3/registry';
import { S3Storage } from '@/s3/backend';
import { ValidationError } from '@/core/errors';
import { isolateAwsEnv, type IsolatedAwsEnv } from '../../helpers/aws-env';
import { BUCKET, StubBucket, sdkWithout } from '../../helpers/stub-s3-bucket';

/**
 * Whether the S3 registry removes a deleted row, or tombstones it, follows where the client sends its requests and
 * whether the SDK sends the precondition: decided from the client's own resolution of both, once, before the first
 * request, never from the constructor's settings alone. The client is the SDK's real one over a bucket in memory, so a
 * delete either arrives as a `DeleteObject` or it does not, and the resolved host is the one the SDK chose.
 */

const REF = { segment: 's' };

let env: IsolatedAwsEnv;
const restores: Array<() => void> = [];
beforeEach(() => {
  env = isolateAwsEnv();
});
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  env.restore();
});
/** Make the SDK behave as one that predates `member` of `command`, for the rest of the test. */
const without = (...args: Parameters<typeof sdkWithout>): void => {
  restores.push(sdkWithout(...args));
};

/** A client that resolves its own endpoint, as a default AWS S3 client does, over `bucket`'s transport. */
const awsClient = (bucket: StubBucket): S3Client => bucket.client({ endpoint: undefined });

/** What deleting a freshly created row did: whether a DeleteObject was sent, and what the bucket holds after. */
async function createAndDelete(driver: S3RegistryDriver, bucket: StubBucket) {
  const { token } = await driver.create(REF, { currentGen: 0 });
  await driver.delete(REF, token);
  return {
    deleteObjects: bucket.count('DeleteObject'),
    objectsLeft: bucket.objects.size,
    stored: [...bucket.objects.values()].map((o) => JSON.parse(o.body.toString()) as unknown),
  };
}

describe('the default follows the client', () => {
  it('on AWS S3: not known before the first request, then on, and the row is removed by a DeleteObject', async () => {
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    expect(driver.capabilities().conditionalDelete).toBe(false);
    expect(await driver.get(REF)).toBeNull();
    expect(driver.capabilities().conditionalDelete).toBe(true);

    const seen = await createAndDelete(driver, bucket);
    expect(seen).toMatchObject({ deleteObjects: 1, objectsLeft: 0 });
    expect(bucket.ifMatchOnDelete).toEqual([expect.stringMatching(/^"e\d+"$/)]);
    expect(new Set(bucket.hosts)).toEqual(new Set(['s3.us-east-1.amazonaws.com']));
  });

  it('the probe sends nothing: the transport sees the registry’s own requests and no others', async () => {
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    await driver.get(REF);
    expect(bucket.count('GetObject')).toBe(1);
    expect(bucket.count('PutObject')).toBe(0);
    expect(bucket.count('DeleteObject')).toBe(0);
  });

  it.each([
    [
      'AWS_ENDPOINT_URL_S3',
      (e: IsolatedAwsEnv) => e.set({ AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9000' }),
    ],
    [
      'AWS_ENDPOINT_URL',
      (e: IsolatedAwsEnv) => e.set({ AWS_ENDPOINT_URL: 'http://minio.internal:9000' }),
    ],
    [
      'an endpoint_url in the shared config file',
      (e: IsolatedAwsEnv) => e.writeConfig('[default]\nendpoint_url = http://127.0.0.1:9000\n'),
    ],
  ])('off when the endpoint comes from %s: the row is tombstoned', async (_name, configure) => {
    configure(env);
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    await driver.get(REF);
    expect(driver.capabilities().conditionalDelete).toBe(false);

    const seen = await createAndDelete(driver, bucket);
    expect(seen.deleteObjects).toBe(0);
    expect(seen.objectsLeft).toBe(1);
    expect(seen.stored).toEqual([expect.objectContaining({ deleted: true })]);
  });

  it('off for a constructor endpoint that is not AWS, and on for one that is', async () => {
    const compatible = new StubBucket();
    const minio = new S3RegistryDriver({
      client: compatible.client({ endpoint: 'http://127.0.0.1:9000' }),
      bucket: BUCKET,
    });
    await minio.get(REF);
    expect(minio.capabilities().conditionalDelete).toBe(false);

    const regional = new StubBucket();
    const aws = new S3RegistryDriver({
      client: regional.client({ endpoint: 'https://s3.us-east-1.amazonaws.com' }),
      bucket: BUCKET,
    });
    await aws.get(REF);
    expect(aws.capabilities().conditionalDelete).toBe(true);
  });

  it('on for FIPS and dual-stack hosts', async () => {
    for (const options of [{ useFipsEndpoint: true }, { useDualstackEndpoint: true }]) {
      const bucket = new StubBucket();
      const driver = new S3RegistryDriver({
        client: bucket.client({ endpoint: undefined, ...options } as never),
        bucket: BUCKET,
      });
      await driver.get(REF);
      expect(driver.capabilities().conditionalDelete, JSON.stringify(options)).toBe(true);
    }
  });

  it('is decided once: concurrent first reads share one probe, and later reads add none', async () => {
    const bucket = new StubBucket();
    // Count the probe's commands where they are built: its second client is not the one the registry holds.
    const probes: string[] = [];
    for (const Command of [DeleteObjectCommand, PutObjectCommand]) {
      const original = Command.prototype.resolveMiddleware;
      Command.prototype.resolveMiddleware = function (
        this: { input: { Key?: string }; constructor: { name: string } },
        ...args: unknown[]
      ) {
        if (this.input.Key === PROBE_KEY) probes.push(this.constructor.name);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof original;
      restores.push(() => {
        Command.prototype.resolveMiddleware = original;
      });
    }
    const driver = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    await Promise.all([driver.get(REF), driver.get(REF), driver.get(REF)]);
    await driver.get(REF);
    await createAndDelete(driver, bucket);
    expect(probes.sort()).toEqual(['DeleteObjectCommand', 'PutObjectCommand']);
  });

  it('a client the probe cannot read (a double) is off by default, and nothing refuses its writes', async () => {
    const bucket = new StubBucket();
    const real = awsClient(bucket);
    const double = { send: real.send.bind(real) } as unknown as S3Client;
    const driver = new S3RegistryDriver({ client: double, bucket: BUCKET });
    await driver.get(REF);
    expect(driver.capabilities().conditionalDelete).toBe(false);
    const seen = await createAndDelete(driver, bucket);
    expect(seen.deleteObjects).toBe(0);
    expect(seen.objectsLeft).toBe(1);
  });
});

describe('an explicit setting wins over the endpoint', () => {
  it('true keeps the delete on for an endpoint the caller vouches for', async () => {
    env.set({ AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9000' });
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({
      client: awsClient(bucket),
      bucket: BUCKET,
      conditionalDelete: true,
    });
    expect(driver.capabilities().conditionalDelete).toBe(true); // vouched for, before any request
    await driver.get(REF);
    expect(driver.capabilities().conditionalDelete).toBe(true);
    expect(await createAndDelete(driver, bucket)).toMatchObject({
      deleteObjects: 1,
      objectsLeft: 0,
    });
  });

  it('false keeps the row tombstoned on AWS S3', async () => {
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({
      client: awsClient(bucket),
      bucket: BUCKET,
      conditionalDelete: false,
    });
    await driver.get(REF);
    expect(driver.capabilities().conditionalDelete).toBe(false);
    expect(await createAndDelete(driver, bucket)).toMatchObject({
      deleteObjects: 0,
      objectsLeft: 1,
    });
  });

  it('S3Storage passes it through and decides the default from the client it builds', async () => {
    env.set({ AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9000' });
    const viaEnv = new S3Storage({ bucket: BUCKET, region: 'us-east-1', credentials: stub });
    expect(viaEnv.registry.capabilities().conditionalDelete).toBe(false);
    const vouched = new S3Storage({
      bucket: BUCKET,
      region: 'us-east-1',
      credentials: stub,
      conditionalDelete: true,
    });
    expect(vouched.registry.capabilities().conditionalDelete).toBe(true);
  });

  it('refuses a conditionalDelete that is not a boolean', () => {
    for (const bad of ['yes', 'false', 0, 1, null]) {
      expect(
        () =>
          new S3RegistryDriver({
            client: awsClient(new StubBucket()),
            bucket: BUCKET,
            conditionalDelete: bad as never,
          }),
      ).toThrow(ValidationError);
    }
  });
});

const stub = { accessKeyId: 'stub', secretAccessKey: 'stub' };

describe('an SDK that does not send the header cannot fence a delete', () => {
  it.each([undefined, true])(
    'a DeleteObject with no If-Match is never sent: the row is tombstoned (conditionalDelete: %s)',
    async (conditionalDelete) => {
      without('DeleteObjectCommand', 'IfMatch');
      const bucket = new StubBucket();
      const driver = new S3RegistryDriver({
        client: awsClient(bucket),
        bucket: BUCKET,
        ...(conditionalDelete === undefined ? {} : { conditionalDelete }),
      });
      await driver.get(REF);
      expect(driver.capabilities().conditionalDelete).toBe(false);
      const seen = await createAndDelete(driver, bucket);
      expect(seen.deleteObjects).toBe(0);
      expect(seen.objectsLeft).toBe(1);
      expect(seen.stored).toEqual([expect.objectContaining({ deleted: true })]);
    },
  );
});

describe('an SDK that does not send a write precondition cannot host the registry', () => {
  it('a compare-and-swap without If-Match is refused before it is sent, and the row is untouched', async () => {
    without('PutObjectCommand', 'IfMatch');
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    const { token } = await driver.create(REF, { currentGen: 0 }); // its If-None-Match is sent
    await expect(driver.compareAndSwap(REF, token, { currentGen: 1 })).rejects.toThrow(/If-Match/);
    await expect(driver.compareAndSwap(REF, token, { currentGen: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(bucket.count('PutObject')).toBe(1); // the create only
    expect(await driver.get(REF)).toMatchObject({ currentGen: 0, token });
  });

  it('a create without If-None-Match is refused before it is sent', async () => {
    without('PutObjectCommand', 'IfNoneMatch');
    const bucket = new StubBucket();
    const driver = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    await expect(driver.create(REF, { currentGen: 0 })).rejects.toThrow(/If-None-Match/);
    expect(bucket.count('PutObject')).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });

  it('reads still work: only a write is refused', async () => {
    const bucket = new StubBucket();
    const good = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    const { token } = await good.create(REF, { currentGen: 0 });
    without('PutObjectCommand', 'IfMatch');
    const old = new S3RegistryDriver({ client: awsClient(bucket), bucket: BUCKET });
    expect(await old.get(REF)).toMatchObject({ token });
  });
});
