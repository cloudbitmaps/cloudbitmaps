import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  storageChunkSourceConformance,
  registryConformance,
  registryConcurrency,
  CONFORMANCE_SEGMENT,
} from '@/testing/conformance';
import { S3StorageDriver } from '@/s3/storage';
import { S3Storage } from '@cloudbitmaps/s3';
import { S3RegistryDriver } from '@/s3/registry';
import { CrbmStorageChunkSource, writeCrbmGeneration } from '@/core/crbm-storage-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { CloudRoaring, bulkLoadCrbmGeneration } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

// Runs against MinIO from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real AWS needed.
const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = 'cloud-roaring-it';

const client = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true, // MinIO requires path-style addressing
});

beforeAll(async () => {
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    // Bucket already exists (from a prior run) — fine.
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
});

let n = 0;
const freshDriver = (): S3StorageDriver =>
  new S3StorageDriver({ client, bucket: BUCKET, prefix: `conf/${n++}` });

// The S3 driver must pass the SAME storage-source contract as in-memory + LocalFs.
storageChunkSourceConformance('S3StorageDriver (MinIO)', async (chunks) => {
  const driver = freshDriver();
  await writeCrbmGeneration(driver, { segment: CONFORMANCE_SEGMENT, generation: 1 }, chunks);
  return new CrbmStorageChunkSource(driver);
});

// The S3 registry must pass the SAME registry contract as memory / LocalFs / GCS / Azure — against real S3
// conditional-write (If-None-Match / If-Match) semantics via MinIO. Proves S3-only topology is viable.
let rn = 0;
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};
registryConformance(
  'S3RegistryDriver (MinIO)',
  () =>
    new S3RegistryDriver({ client, bucket: BUCKET, prefix: `reg-conf/${rn++}`, now: ticking() }),
);

// Two drivers over one bucket, racing the same row — the cross-process fence (`If-None-Match: *` /
// `If-Match: <etag>`) that the sequential suite never exercises.
registryConcurrency('S3RegistryDriver (MinIO)', () => {
  const prefix = `reg-race/${rn++}`;
  return [
    new S3RegistryDriver({ client, bucket: BUCKET, prefix, now: ticking() }),
    new S3RegistryDriver({ client, bucket: BUCKET, prefix, now: ticking() }),
  ];
});

describe('S3StorageDriver specifics (MinIO)', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });

  it('is write-once: a second put to the same key is a WriteConflictError', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1, 2, 3) }]);
    await expect(
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(9) }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    // The original is intact.
    const storage = new CrbmStorageChunkSource(driver);
    const bytes = await storage.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([1, 2, 3]);
  });

  it('reports NotFoundError for a missing generation', async () => {
    const driver = freshDriver();
    await expect(driver.getRange(gen(7), 0, 4)).rejects.toBeInstanceOf(NotFoundError);
    await expect(driver.getTail(gen(7), 1024)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an out-of-bounds range with ValidationError', async () => {
    const driver = freshDriver();
    const { size } = await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]);
    await expect(driver.getRange(gen(1), 0, size + 100)).rejects.toBeInstanceOf(ValidationError);
    // A range whose START is in-bounds but END runs past EOF must also be rejected (S3 returns a short
    // 206 body; the driver treats that short read as out-of-bounds, never a partial result).
    await expect(driver.getRange(gen(1), size - 1, 50)).rejects.toBeInstanceOf(ValidationError);
    // A range starting fully past EOF (S3 416) maps to ValidationError too.
    await expect(driver.getRange(gen(1), size + 10, 4)).rejects.toBeInstanceOf(ValidationError);
    // A zero-length read is valid and empty.
    expect(await driver.getRange(gen(1), 0, 0)).toEqual(new Uint8Array(0));
  });

  it('getTail returns the trailing bytes plus the true total size', async () => {
    const driver = freshDriver();
    const { size } = await writeCrbmGeneration(driver, gen(1), [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
    ]);
    const tail = await driver.getTail(gen(1), 16);
    expect(tail.size).toBe(size); // total size even though we asked for only 16 bytes
    expect(tail.bytes.length).toBe(Math.min(16, size));
    // Asking for more than the object returns the whole object, size still correct.
    const whole = await driver.getTail(gen(1), size + 1000);
    expect(whole.size).toBe(size);
    expect(whole.bytes.length).toBe(size);
  });

  it('delete is idempotent and actually removes the object', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]);
    await driver.delete(gen(1));
    await expect(driver.getTail(gen(1), 1024)).rejects.toBeInstanceOf(NotFoundError);
    await driver.delete(gen(1)); // deleting again is a no-op, not an error
    await driver.delete(gen(99)); // never existed — also a no-op
  });

  it('lists a segment generations and resolves the latest', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]);
    await writeCrbmGeneration(driver, gen(5), [{ chunkKey: 0, bitmap: bm(9) }]);
    const gens: number[] = [];
    for await (const k of driver.list({ segment: 's' })) gens.push(k.generation);
    expect(gens.sort((a, b) => a - b)).toEqual([1, 5]);
    // CrbmStorageChunkSource pins the highest generation.
    const storage = new CrbmStorageChunkSource(driver);
    const bytes = await storage.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([9]);
  });

  it('end to end: bulk-load → S3 → engine count/iterate/intersect', async () => {
    const driverA = new S3StorageDriver({ client, bucket: BUCKET, prefix: `e2e/${n++}` });
    const driverB = driverA; // same prefix space, different segments
    await bulkLoadCrbmGeneration(driverA, { segment: 'a', generation: 1 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(driverB, { segment: 'b', generation: 1 }, [2, 3, 4, 200_000]);

    const store = new CloudRoaring({ storage: new CrbmStorageChunkSource(driverA) });
    expect(await store.segment('a').count()).toBe(4);

    const got: number[] = [];
    for await (const id of store.segment('a').intersect([store.segment('b')])) got.push(id);
    expect(got).toEqual([2, 3, 200_000]);
  });
});

// The backend is the shape users are given, so it gets an end-to-end run of its own — and it is the only test
// that exercises the client it BUILDS rather than one handed in, which is where an endpoint/path-style/
// credentials mistake would hide.
describe('S3Storage (MinIO) — the backend builds its own client', () => {
  it('loads and reads through one object, with both halves in the same bucket and prefix', async () => {
    const storage = new S3Storage({
      bucket: BUCKET,
      prefix: `backend/${n++}`,
      endpoint: ENDPOINT,
      pathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    const store = new CloudRoaring({ storage });
    await bulkLoadCrbmGeneration(
      storage.storage,
      { segment: 'via-backend', generation: 0 },
      [1, 2, 200_000],
      { registry: storage.registry },
    );
    expect(await store.segment('via-backend').count()).toBe(3);
    expect(await store.segment('via-backend').has(200_000)).toBe(true);
    // The pointer resolves, which is the half that silently reads empty when the two are mismatched.
    expect(await storage.registry.get({ segment: 'via-backend' })).not.toBeNull();
  });
});
