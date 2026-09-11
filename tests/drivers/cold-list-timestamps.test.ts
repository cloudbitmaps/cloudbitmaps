import { S3ColdDriver } from '@/drivers/s3/cold';
import { GcsColdDriver } from '@/drivers/gcs/cold';
import { AzureBlobColdDriver } from '@/drivers/azure/cold';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Storage } from '@google-cloud/storage';
import type { ContainerClient } from '@azure/storage-blob';
import { coldObjectKey } from '@/drivers/s3/keys';
import { coldObjectName as gcsObjectName } from '@/drivers/gcs/keys';
import { coldObjectName as azureBlobName } from '@/drivers/azure/keys';
import type { ListedGeneration, SegmentRef } from '@/core/ports';

/**
 * `list()` must report **when each object was written**, because generation GC's time floor is computed from
 * it: a generation is aged by the object that replaced it. A driver that silently returns no timestamp does
 * not fail — by design an absent timestamp means "unknown", and unknown keeps the generation. So the whole
 * floor quietly stops collecting on that backend, and the only symptom is a storage bill that never falls.
 *
 * That makes this the cheapest possible regression to ship and one of the most expensive to notice, and it
 * had no coverage at any tier: the three cloud `cold.test.ts` files never called `list()`, and the
 * integration tests that do read only `generation`. Each case below asserts the value comes from the field
 * the SDK actually returns, so replacing it with `undefined` — or with the wrong field — fails here.
 */

const SEG: SegmentRef = { segment: 's' };
const WRITTEN = Date.UTC(2026, 8, 11, 12, 0, 0);
/** Built with the driver's own key helper, so these cases cannot drift from the key scheme. */
const s3Key = (generation: number): string => coldObjectKey(undefined, { ...SEG, generation });
const gcsKey = (generation: number): string => gcsObjectName(undefined, { ...SEG, generation });
const azKey = (generation: number): string => azureBlobName(undefined, { ...SEG, generation });

async function drain(it: AsyncIterable<ListedGeneration>): Promise<ListedGeneration[]> {
  const out: ListedGeneration[] = [];
  for await (const e of it) out.push(e);
  return out.sort((a, b) => a.generation - b.generation);
}

describe('S3ColdDriver.list', () => {
  it('carries LastModified from the ListObjectsV2 response', async () => {
    const client = {
      send: async () => ({
        Contents: [
          { Key: s3Key(0), LastModified: new Date(WRITTEN) },
          { Key: s3Key(1), LastModified: new Date(WRITTEN + 60_000) },
        ],
        IsTruncated: false,
      }),
    } as unknown as S3Client;
    const entries = await drain(new S3ColdDriver({ client, bucket: 'b' }).list(SEG));
    expect(entries.map((e) => e.generation)).toEqual([0, 1]);
    expect(entries[0]!.createdAt).toBe(WRITTEN);
    expect(entries[1]!.createdAt).toBe(WRITTEN + 60_000);
  });

  it('reports unknown rather than a wrong number when the field is absent', async () => {
    const client = {
      send: async () => ({ Contents: [{ Key: s3Key(0) }], IsTruncated: false }),
    } as unknown as S3Client;
    const [entry] = await drain(new S3ColdDriver({ client, bucket: 'b' }).list(SEG));
    expect(entry!.generation).toBe(0);
    expect(entry!.createdAt).toBeUndefined();
  });
});

describe('GcsColdDriver.list', () => {
  it('carries timeCreated from the object metadata', async () => {
    const storage = {
      bucket: () => ({
        getFiles: async () => [
          [
            { name: gcsKey(0), metadata: { timeCreated: new Date(WRITTEN).toISOString() } },
            {
              name: gcsKey(1),
              metadata: { timeCreated: new Date(WRITTEN + 60_000).toISOString() },
            },
          ],
        ],
      }),
    } as unknown as Storage;
    const entries = await drain(new GcsColdDriver({ storage, bucket: 'b' }).list(SEG));
    expect(entries.map((e) => e.createdAt)).toEqual([WRITTEN, WRITTEN + 60_000]);
  });

  it('reports unknown for a malformed or missing timeCreated', async () => {
    const storage = {
      bucket: () => ({
        getFiles: async () => [
          [
            { name: gcsKey(0), metadata: { timeCreated: 'not-a-date' } },
            { name: gcsKey(1), metadata: {} },
            { name: gcsKey(2) },
          ],
        ],
      }),
    } as unknown as Storage;
    const entries = await drain(new GcsColdDriver({ storage, bucket: 'b' }).list(SEG));
    expect(entries.map((e) => e.createdAt)).toEqual([undefined, undefined, undefined]);
  });
});

describe('AzureBlobColdDriver.list', () => {
  const containerWith = (items: unknown[]): ContainerClient =>
    ({
      listBlobsFlat: () => ({
        async *[Symbol.asyncIterator]() {
          for (const i of items) yield i;
        },
      }),
    }) as unknown as ContainerClient;

  it('prefers createdOn over lastModified', async () => {
    // Deliberate: a blob's last-modified moves on a metadata-only write, which would make a generation look
    // YOUNGER than it is. Younger is the direction that keeps, so it is not a data-loss risk — but it makes
    // the floor hold objects longer than asked, and creation time is the value actually being modelled.
    const container = containerWith([
      {
        name: azKey(0),
        properties: { createdOn: new Date(WRITTEN), lastModified: new Date(WRITTEN + 99_000) },
      },
    ]);
    const [entry] = await drain(new AzureBlobColdDriver({ containerClient: container }).list(SEG));
    expect(entry!.createdAt).toBe(WRITTEN);
  });

  it('falls back to lastModified when createdOn is absent', async () => {
    // `createdOn` needs a recent service version; `lastModified` is always present. A fallback beats unknown,
    // because unknown stops collection entirely on this backend.
    const container = containerWith([
      { name: azKey(0), properties: { lastModified: new Date(WRITTEN) } },
    ]);
    const [entry] = await drain(new AzureBlobColdDriver({ containerClient: container }).list(SEG));
    expect(entry!.createdAt).toBe(WRITTEN);
  });
});
