import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { S3Storage } from '@cloudbitmaps/s3';
import { CloudRoaring } from '@/index';

/**
 * `store.preflight()` against the three emulators from `docker-compose.yml`: MinIO, fake-gcs-server and Azurite. Each
 * run uses a bucket or container of its own, so the objects it counts are its own. The first six checks must be `ok`
 * on every one, the probe must be gone afterwards, and the lifecycle check says what each backend can say: MinIO and
 * fake-gcs-server answer a bucket with no rules, and Azure Blob is always `unchecked`.
 */

const NAMES = ['registry', 'write', 'write-once', 'read', 'list', 'delete', 'lifecycle'];
const RUN = randomUUID().slice(0, 8);

const retry = async (fn: () => Promise<unknown>): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

describe('store.preflight (MinIO)', () => {
  const bucket = `cloudbitmaps-preflight-${RUN}`;
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true,
  });
  beforeAll(() => retry(() => s3.send(new CreateBucketCommand({ Bucket: bucket }))));

  it('passes all seven checks, twice, and leaves no object', async () => {
    const store = new CloudRoaring({
      storage: new S3Storage({ bucket, client: s3, prefix: 'pf' }),
    });
    for (let i = 0; i < 2; i++) {
      const out = await store.preflight();
      expect(out.checks.map((c) => `${c.name}:${c.status}`)).toEqual(NAMES.map((n) => `${n}:ok`));
    }
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(listed.Contents ?? []).toEqual([]);
  });
});

describe('store.preflight (fake-gcs-server)', () => {
  const endpoint = process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443';
  const bucket = `cloudbitmaps-preflight-${RUN}`;
  const storage = new Storage({ projectId: 'test', apiEndpoint: endpoint });
  beforeAll(() => retry(() => storage.createBucket(bucket)));

  it('passes the six storage checks, twice, and leaves no object', async () => {
    const store = new CloudRoaring({
      storage: new GcsStorage({ bucket, prefix: 'pf', projectId: 'test', apiEndpoint: endpoint }),
    });
    for (let i = 0; i < 2; i++) {
      const out = await store.preflight();
      expect(out.checks.slice(0, 6).map((c) => `${c.name}:${c.status}`)).toEqual(
        NAMES.slice(0, 6).map((n) => `${n}:ok`),
      );
      expect(out.checks[6]?.name).toBe('lifecycle');
      expect(out.checks[6]?.status).not.toBe('problem');
    }
    const [files] = await storage.bucket(bucket).getFiles();
    expect(files).toEqual([]);
  });
});

describe('store.preflight (Azurite)', () => {
  const account = 'devstoreaccount1';
  const endpoint = process.env.AZURITE_BLOB_ENDPOINT ?? `http://127.0.0.1:10000/${account}`;
  const connection =
    `DefaultEndpointsProtocol=http;AccountName=${account};` +
    `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;` +
    `BlobEndpoint=${endpoint};`;
  const container = BlobServiceClient.fromConnectionString(connection).getContainerClient(
    `preflight-${RUN}`,
  );
  beforeAll(() => retry(() => container.createIfNotExists()));

  it('passes the six storage checks, twice, with the lifecycle unchecked, and leaves no blob', async () => {
    const store = new CloudRoaring({
      storage: new AzureBlobStorage({ containerClient: container, prefix: 'pf' }),
    });
    for (let i = 0; i < 2; i++) {
      const out = await store.preflight();
      expect(out.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
        ...NAMES.slice(0, 6).map((n) => `${n}:ok`),
        'lifecycle:unchecked',
      ]);
    }
    const names: string[] = [];
    for await (const blob of container.listBlobsFlat()) names.push(blob.name);
    expect(names).toEqual([]);
  });
});
