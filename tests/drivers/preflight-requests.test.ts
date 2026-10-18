import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudRoaring } from '@/index';
import { S3Storage } from '@/s3/backend';
import { GcsStorage } from '@/gcs/backend';
import { AzureBlobStorage } from '@/azure-blob/backend';
import { StubBucket, type Operation } from '../helpers/stub-s3-bucket';
import { StubGcsService } from '../helpers/gcs-stub';
import { StubBlobService } from '../helpers/azure-blob-stub';
import { guardLoopback } from '../helpers/loopback-guard';

/**
 * What `store.preflight()` sends, counted at each real SDK client over a stub: nothing leaves the process, and the
 * loopback guard shows no connection went anywhere but 127.0.0.1.
 */

let guard: ReturnType<typeof guardLoopback>;
const gcs = new StubGcsService();
const azure = new StubBlobService();
beforeAll(async () => {
  guard = guardLoopback();
  await gcs.start();
  await azure.start();
});
afterAll(async () => {
  await gcs.stop();
  await azure.stop();
  guard.restore();
  expect(guard.attempts).toEqual([]);
});

const S3_OPS: Operation[] = [
  'PutObject',
  'GetObject',
  'HeadObject',
  'ListObjectsV2',
  'DeleteObject',
  'GetBucketLifecycleConfiguration',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'AbortMultipartUpload',
];

describe('store.preflight request counts per backend', () => {
  it('S3: seven requests, two of them writes that carry a precondition', async () => {
    const bucket = new StubBucket();
    const store = new CloudRoaring({
      storage: new S3Storage({ bucket: 'b', client: bucket.client() }),
    });
    const out = await store.preflight();
    expect(out.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'registry:ok',
      'write:ok',
      'write-once:ok',
      'read:ok',
      'list:ok',
      'delete:ok',
      // The stub has no lifecycle configuration, which S3 answers as no rules.
      'lifecycle:ok',
    ]);
    const counts = Object.fromEntries(
      S3_OPS.map((op) => [op, bucket.count(op)]).filter(([, n]) => n !== 0),
    );
    expect(counts).toEqual({
      PutObject: 2,
      GetObject: 2,
      ListObjectsV2: 1,
      DeleteObject: 1,
      GetBucketLifecycleConfiguration: 1,
    });
    expect((Object.values(counts) as number[]).reduce((a, b) => a + b, 0)).toBe(7);
    expect([...bucket.objects.keys()]).toEqual([]);
    // A client at a custom endpoint does not assume the service applies If-Match on a delete, so the delete is plain.
    expect(bucket.ifMatchOnDelete).toEqual([undefined]);
  });

  it("S3 with conditional delete on: still seven requests, and the delete carries the tail read's version", async () => {
    const bucket = new StubBucket();
    const store = new CloudRoaring({
      storage: new S3Storage({ bucket: 'b', client: bucket.client(), conditionalDelete: true }),
    });
    const out = await store.preflight();
    expect(out.ok).toBe(true);
    const total = S3_OPS.reduce((n, op) => n + bucket.count(op), 0);
    expect(total).toBe(7);
    expect(bucket.ifMatchOnDelete).toEqual([expect.stringMatching(/^"e\d+"$/)]);
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  it("GCS: seven requests, and one more listing on the driver's first missing registry row", async () => {
    const store = new CloudRoaring({
      storage: new GcsStorage({ bucket: 'b', client: gcs.client() }),
    });
    const countOf = (): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const s of gcs.sent) counts[s.op] = (counts[s.op] ?? 0) + 1;
      return counts;
    };
    gcs.sent.length = 0;
    const first = await store.preflight();
    expect(first.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // The first 404 the driver sees lists once to learn whether the bucket exists, so a first run is eight.
    expect(countOf()).toEqual({ media: 2, upload: 2, list: 2, delete: 1, bucket: 1 });
    expect(gcs.sent).toHaveLength(8);
    gcs.sent.length = 0;
    await store.preflight();
    expect(countOf()).toEqual({ media: 2, upload: 2, list: 1, delete: 1, bucket: 1 });
    expect(gcs.sent).toHaveLength(7);
    expect([...gcs.objects.keys()]).toEqual([]);
  });

  it('Azure Blob: eight requests, and the lifecycle is unchecked with none of them spent on it', async () => {
    const store = new CloudRoaring({
      storage: new AzureBlobStorage({ containerClient: azure.client() }),
    });
    azure.requests.length = 0;
    const out = await store.preflight();
    expect(out.ok).toBe(true);
    expect(out.checks.map((c) => c.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'unchecked',
    ]);
    const counts: Record<string, number> = {};
    for (const r of azure.requests) counts[r.method] = (counts[r.method] ?? 0) + 1;
    expect(azure.requests).toHaveLength(8);
    // The conflicting second write reads the blob's properties back, and a tail read takes two requests.
    expect(counts).toEqual({ GET: 3, PUT: 2, HEAD: 2, DELETE: 1 });
    expect([...azure.blobs.keys()]).toEqual([]);
  });
});
