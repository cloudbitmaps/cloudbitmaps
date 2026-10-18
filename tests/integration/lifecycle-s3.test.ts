import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketLifecycleCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3Storage } from '@cloudbitmaps/s3';

/**
 * `S3Storage.checkLifecycle` against MinIO from `docker-compose.yml`: the real request and the real answers, where the
 * unit tests use a stub transport. The bucket is this file's own, so a rule set here touches no other test's objects,
 * and the rules expire after a year, so none acts during the run.
 *
 * MinIO answers `NoSuchLifecycleConfiguration` for a bucket with no rule, as S3 does, and stores and returns a rule's
 * prefix, expiration, transitions and abort settings.
 */

const BUCKET = `cloudbitmaps-lifecycle-${randomUUID().slice(0, 8)}`;
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});
const store = (prefix?: string): S3Storage =>
  new S3Storage({ bucket: BUCKET, client: s3, ...(prefix === undefined ? {} : { prefix }) });

beforeAll(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
});

afterEach(async () => {
  await s3.send(new DeleteBucketLifecycleCommand({ Bucket: BUCKET }));
});

const put = (rules: object[]) =>
  s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: BUCKET,
      LifecycleConfiguration: { Rules: rules as never },
    }),
  );

describe('S3Storage.checkLifecycle against MinIO', () => {
  it('is ok for a bucket with no lifecycle configuration, with the advice to abort incomplete uploads', async () => {
    const out = await store('cr').checkLifecycle();
    expect(out.status).toBe('ok');
    expect(out.detail).toContain('AbortIncompleteMultipartUpload');
  });

  it('reports a rule that expires current objects under the prefix', async () => {
    await put([
      { ID: 'expire', Status: 'Enabled', Filter: { Prefix: 'cr/' }, Expiration: { Days: 365 } },
    ]);
    const out = await store('cr').checkLifecycle();
    expect(out.status).toBe('problem');
    expect(out.detail).toContain('expires current objects');
  });

  it('does not report the same rule on a prefix that is not ours', async () => {
    await put([
      { ID: 'expire', Status: 'Enabled', Filter: { Prefix: 'other/' }, Expiration: { Days: 365 } },
    ]);
    expect((await store('cr').checkLifecycle()).status).toBe('ok');
  });

  it('does not report a rule that only expires noncurrent versions and aborts uploads', async () => {
    await put([
      {
        ID: 'safe',
        Status: 'Enabled',
        Filter: { Prefix: 'cr/' },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
      },
    ]);
    // MinIO does not return the abort setting it was given, so whether the advice shows is not asserted here: the
    // unit tests cover that against the SDK's own parsing.
    expect((await store('cr').checkLifecycle()).status).toBe('ok');
  });
});
