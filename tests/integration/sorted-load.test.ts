import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { CreateBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { loadSegment } from '@/core/load';
import type { IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver } from '@/drivers/memory';
import { GcsStorageDriver } from '@/gcs/storage';
import { storeCodec } from '../helpers/store-codec';
import { S3StorageDriver } from '@/s3/storage';
import { counterEntropy } from '../helpers/entropy';

/**
 * `load(…, { sorted: true })` against MinIO, fake-gcs-server and Azurite from `docker-compose.yml`, where the object
 * really streams to the backend while the ids are read.
 *
 * Over one part, a sorted load stores the bytes an unsorted load of the same ids stores, under the same write identity.
 * And a sorted load whose ids raise an error after two or more parts are uploaded throws that error and leaves no
 * object: S3 aborts its multipart upload, GCS drops its resumable session, and Azure Blob never commits the blocks it
 * staged (which Azure bills until it collects them).
 */

// Over ten MiB streamed to each emulator, twice.
vi.setConfig({ testTimeout: 180_000 });

const RUN =
  process.env.GITHUB_RUN_ID === undefined
    ? randomUUID().slice(0, 8)
    : `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
const BUCKET = 'cloudbitmaps-it';
const SEG: SegmentRef = { namespace: 'sorted', segment: 's' };
const MiB = 1024 * 1024;

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true,
});
const gcs = new Storage({
  projectId: 'test',
  apiEndpoint: process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443',
});
// fake-gcs-server can close a connection after an answer without saying so, and the SDK keeps that socket for its
// next request, which then fails with ECONNRESET. As in `gcs.test.ts`: an agent that keeps no socket, for this file.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@google-cloud/storage'));
(sdkRequire('teeny-request/build/src/agents') as { pool: Map<string, http.Agent> }).pool.set(
  'http:forever',
  new http.Agent({ keepAlive: false, maxSockets: Infinity }),
);
const BLOB_ENDPOINT =
  process.env.AZURITE_BLOB_ENDPOINT ?? 'http://127.0.0.1:10000/devstoreaccount1';
// Azurite's fixed, publicly documented dev account and key (not a secret: the same value ships in every SDK).
const container = BlobServiceClient.fromConnectionString(
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;` +
    `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;` +
    `BlobEndpoint=${BLOB_ENDPOINT};`,
).getContainerClient(BUCKET);

/** Poll until the emulator answers: `docker compose up --wait` returns before it accepts HTTP. */
async function ready(probe: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await probe();
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

beforeAll(async () => {
  await ready(() => s3.send(new ListBucketsCommand({})));
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((err: { name?: string }) => {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  });
  await ready(() => gcs.getBuckets());
  await gcs.createBucket(BUCKET).catch((err: { code?: number }) => {
    if (err.code !== 409) throw err;
  });
  await ready(() => container.createIfNotExists());
}, 60_000);

let n = 0;
/** Each backend's driver, with its upload unit small where the driver allows it, under a prefix of its own. */
const BACKENDS: Record<string, () => IStorageDriver> = {
  'S3 (MinIO)': () =>
    new S3StorageDriver({
      client: s3,
      bucket: BUCKET,
      prefix: `${RUN}/sorted/${n++}`,
      partBytes: 5 * MiB,
    }),
  'GCS (fake-gcs-server)': () =>
    new GcsStorageDriver({
      storage: gcs,
      bucket: BUCKET,
      prefix: `${RUN}/sorted/${n++}`,
      simpleUploadThresholdBytes: 256 * 1024,
    }),
  'Azure Blob (Azurite)': () =>
    new AzureBlobStorageDriver({
      containerClient: container,
      prefix: `${RUN}/sorted/${n++}`,
      blockBytes: MiB,
    }),
};

const depsOver = (storage: IStorageDriver) => ({
  storage,
  registry: new MemoryRegistryDriver(),
  entropy: counterEntropy(),
  codec: storeCodec,
});

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out;
}

async function storedSha256(storage: IStorageDriver, generation: number): Promise<string> {
  const tail = await storage.getTail({ ...SEG, generation }, 64 * MiB);
  return createHash('sha256').update(tail.bytes).digest('hex');
}

/**
 * Ascending ids in array containers of 4,096, two apart (8 KiB each, no runs to compress), over `chunks` chunks: about
 * 8 KiB of object per chunk.
 */
function* spread(chunks: number): Generator<number> {
  for (let chunk = 0; chunk < chunks; chunk++) {
    for (let i = 0; i < 4_096; i++) yield chunk * 65_536 + 2 * i;
  }
}

describe.each(Object.keys(BACKENDS))('a sorted load on %s', (name) => {
  it('stores the bytes an unsorted load of the same ids stores, over one part', async () => {
    const sortedStore = BACKENDS[name]!();
    const unsortedStore = BACKENDS[name]!();
    const ids = [...spread(60)];
    const sorted = await loadSegment(SEG, spread(60), depsOver(sortedStore), { sorted: true });
    const unsorted = await loadSegment(SEG, ids.reverse(), depsOver(unsortedStore));
    expect(sorted).toEqual(unsorted);
    expect(sorted).toMatchObject({ published: true, cardinality: 60 * 4_096, chunkCount: 60 });
    expect(sorted.size).toBeLessThan(MiB);
    const stored = await storedSha256(sortedStore, sorted.generation);
    expect(stored).toBe(await storedSha256(unsortedStore, unsorted.generation));
    expect(stored).toBe(sorted.sha256);
  });

  it('throws the error its ids raised after two or more parts went up, and leaves no object', async () => {
    const storage = BACKENDS[name]!();
    const raised = Object.assign(new Error('the warehouse cursor expired'), {
      name: 'PreconditionFailed',
      code: 412,
      statusCode: 412,
      $metadata: { httpStatusCode: 412 },
    });
    // About 11 MiB before the error: two S3 parts of 5 MiB, past GCS's switch to a resumable upload, and ten Azure blocks.
    function* ids(): Generator<number> {
      yield* spread(1_400);
      throw raised;
    }
    const deps = depsOver(storage);
    const err = await loadSegment(SEG, ids(), deps, { sorted: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(raised);
    expect(await generations(storage)).toEqual([]);
    expect(await deps.registry.get(SEG)).toBeNull();
  });
});
