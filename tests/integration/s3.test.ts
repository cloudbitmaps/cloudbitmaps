import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  CreateBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  storageChunkSourceConformance,
  storageDriverConformance,
  registryConformance,
  registryConcurrency,
  CONFORMANCE_SEGMENT,
} from '@/testing/conformance';
import { S3StorageDriver } from '@/s3/storage';
import { S3Storage } from '@cloudbitmaps/s3';
import { S3RegistryDriver } from '@/s3/registry';
import { storageObjectKey } from '@/s3/keys';
import { CrbmStorageChunkSource, writeCrbmGeneration } from '@/core/crbm-storage-source';
import { CloudRoaring } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import { brandAsBackend, type GenKey } from '@/core/ports';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A keyspace unique to THIS run.
 *
 * Every prefix below is numbered from a counter that restarts at 0. Under a fixed root, a second run against
 * the same LIVE container would replay the same write-once keys and fail with
 * `WriteConflictError: generation already exists` — failures that read exactly like a real write-once
 * regression rather than like a dirty container. CI would never see them, because each job gets fresh
 * containers; every local re-run would.
 *
 * `GITHUB_RUN_ID` plus `GITHUB_RUN_ATTEMPT` in CI, a random token locally. The attempt matters: re-running
 * a failed job keeps the same run id, so the id alone would replay the very keys that just failed.
 */
const RUN =
  process.env.GITHUB_RUN_ID === undefined
    ? randomUUID().slice(0, 8)
    : `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;

// Runs against MinIO from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real AWS needed.
const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = 'cloudbitmaps-it';

const client = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  forcePathStyle: true, // MinIO requires path-style addressing
});

beforeAll(async () => {
  // `docker compose up --wait` returns when the container is *running*, not necessarily accepting HTTP — poll
  // until MinIO answers so a cold-start ECONNREFUSED can't red the suite (deterministic readiness).
  //
  // The GCS and Azure suites poll the same way. Without the poll this suite passes on an accident of timing
  // rather than a margin: MinIO accepts connections a few tens of milliseconds after `--wait` returns, the AWS
  // SDK gives up on ECONNREFUSED in about the same, and the only thing covering the gap is vitest's own
  // startup. A `beforeAll` failure here reds every test in the file at once, which reads like a driver
  // regression rather than a cold container.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new ListBucketsCommand({}));
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // ~15s, inside the 30s hookTimeout
      await new Promise((r) => setTimeout(r, 500));
    }
  }
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
  new S3StorageDriver({ client, bucket: BUCKET, prefix: `${RUN}/conf/${n++}` });

// The S3 driver must pass the SAME storage-source contract as in-memory + LocalFs.
// The same IStorageDriver contract memory and LocalFs pass: write-once, typed errors, true tail size, idempotent
// delete, read-after-delete listing.
// `largeBytes` is past one 5 MiB part, so the collision is raised by the conditional CompleteMultipartUpload.
storageDriverConformance('S3StorageDriver (MinIO)', freshDriver, { largeBytes: 6 * 1024 * 1024 });

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
    new S3RegistryDriver({
      client,
      bucket: BUCKET,
      prefix: `${RUN}/reg-conf/${rn++}`,
      now: ticking(),
    }),
);

// Two drivers over one bucket, racing the same row — the cross-process fence (`If-None-Match: *` /
// `If-Match: <etag>`) that the sequential suite never exercises.
registryConcurrency('S3RegistryDriver (MinIO)', () => {
  const prefix = `${RUN}/reg-race/${rn++}`;
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
    // CrbmStorageChunkSource, with no registry, resolves the highest generation in the bucket.
    const storage = new CrbmStorageChunkSource(driver);
    const bytes = await storage.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([9]);
  });

  it('end to end: load → S3 → engine count/iterate/intersect', async () => {
    const driverA = new S3StorageDriver({ client, bucket: BUCKET, prefix: `${RUN}/e2e/${n++}` });
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
      prefix: `${RUN}/backend/${n++}`,
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

  // The size settings are options of the backend, and reach the storage half that writes the objects.
  const minio = (
    prefix: string,
    sizes: { partBytes?: number; maxObjectBytes?: number },
  ): S3Storage =>
    new S3Storage({
      bucket: BUCKET,
      prefix,
      endpoint: ENDPOINT,
      pathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
      ...sizes,
    });

  it('takes partBytes and loads a generation of more than one part through multipart', async () => {
    const FIVE_MIB = 5 * 1024 * 1024;
    const prefix = `${RUN}/backend-parts/${n++}`;
    const backend = minio(prefix, { partBytes: FIVE_MIB });
    expect(backend.storage.capabilities().maxObjectBytes).toBe(FIVE_MIB * 10_000);
    const store = new CloudRoaring({ storage: backend });
    // Every 16th id fills each 16-bit chunk with 4,096 ids, stored as an 8 KiB array: about 6.4 MiB in all, which
    // is one 5 MiB part and a remainder.
    const count = 3_200_000;
    const ids = Array.from({ length: count }, (_, i) => i * 16);
    expect((await store.load({ segment: 'sized' }, ids)).published).toBe(true);
    const seg = store.segment('sized');
    expect(await seg.count()).toBe(count);
    expect(await seg.has((count - 1) * 16)).toBe(true);
    expect(await seg.has(1)).toBe(false);
    // A multipart object's ETag carries its part count (`<md5>-<parts>`), where a single PUT's is a bare md5: the
    // object is larger than one 5 MiB part and smaller than the 8 MiB default, so only the option puts it here.
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: storageObjectKey(prefix, { segment: 'sized', generation: 0 }),
      }),
    );
    expect(head.ContentLength).toBeGreaterThan(FIVE_MIB);
    expect(head.ContentLength).toBeLessThan(8 * 1024 * 1024);
    expect(head.ETag).toMatch(/-2"$/);
  }, 120_000);

  it('takes maxObjectBytes, advertises it, and refuses a generation past it', async () => {
    const backend = minio(`${RUN}/backend-ceiling/${n++}`, { maxObjectBytes: 16 });
    expect(backend.storage.capabilities().maxObjectBytes).toBe(16);
    const store = new CloudRoaring({ storage: backend });
    await expect(store.load({ segment: 'sized' }, [1, 2, 3])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await store.exists({ segment: 'sized' })).toBe(false);
  });
});

// What `store.load()` sends to S3, counted by the request meter the calibration harness bills with. The in-memory
// counts that the cost model is held to (`tests/core/cost.test.ts`) are of the driver ports; these are of the wire,
// command by command. A load reads its row once before the publish and checks the next generation number with one
// HeadObject instead of listing. It collects by name: it re-reads the pointer and deletes the one generation its
// publish pushed out of the window, listing nothing, except on every sixteenth generation, where it lists instead.
describe('S3 (MinIO): the requests one store.load() sends', () => {
  const require_ = createRequire(import.meta.url);
  const { meter } = require_('../../bench/lib/aws-meter.cjs') as {
    meter: (c: S3Client) => { put: number; get: number; byCommand: Record<string, number> };
  };

  it('a first load, a reload, and every load from the third on, with a listing every sixteenth', async () => {
    const metered = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
      forcePathStyle: true,
    });
    const tally = meter(metered);
    const prefix = `${RUN}/load-requests/${n++}`;
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: new S3StorageDriver({ client: metered, bucket: BUCKET, prefix }),
        registry: new S3RegistryDriver({ client: metered, bucket: BUCKET, prefix }),
      }),
    });
    const load = async (generation: number) => {
      tally.put = 0;
      tally.get = 0;
      for (const k of Object.keys(tally.byCommand)) delete tally.byCommand[k];
      const ids = Array.from({ length: generation + 1 }, (_, i) => i);
      const result = await store.load({ namespace: 'ns', segment: 's' }, ids);
      expect(result).toMatchObject({ generation, published: true });
      return { put: tally.put, get: tally.get, byCommand: { ...tally.byCommand } };
    };
    // The object and the row (2 PutObject) are PUT-class; the row read, its second read after the ids (a first load
    // found no row), the create's read and the check are GET-class. Nothing is outside the window yet, so nothing
    // is read or deleted after the publish.
    const first = {
      put: 2,
      get: 4,
      byCommand: { GetObjectCommand: 3, HeadObjectCommand: 1, PutObjectCommand: 2 },
    };
    expect(await load(0)).toEqual(first);
    // A reload also reads the current generation's index, to count what it replaces: its row read, that tail read and
    // the compare-and-swap's read of the row's version, where the first load's second row read and create's read were.
    expect(await load(1)).toEqual(first);
    // From the third load on the collection deletes by name, re-reading the pointer before it.
    const steady = {
      put: 2,
      get: 5,
      byCommand: {
        GetObjectCommand: 4,
        HeadObjectCommand: 1,
        PutObjectCommand: 2,
        DeleteObjectCommand: 1,
      },
    };
    for (let g = 2; g < 16; g++) expect(await load(g), `generation ${g}`).toEqual(steady);
    // Every sixteenth generation lists instead: one ListObjectsV2, and the pointer read before and after it.
    expect(await load(16)).toEqual({
      put: 3,
      get: 7,
      byCommand: {
        GetObjectCommand: 6,
        HeadObjectCommand: 1,
        PutObjectCommand: 2,
        ListObjectsV2Command: 1,
        DeleteObjectCommand: 1,
      },
    });
    expect(await load(17)).toEqual(steady);
    metered.destroy();
  });
});

describe('S3 (MinIO): a write-once object the client is told was throttled', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });
  const throttle = (): Error =>
    Object.assign(new Error('Please reduce your request rate.'), {
      name: 'SlowDown',
      $fault: 'server',
      $metadata: { httpStatusCode: 503 },
    });

  /**
   * A client whose first `command` on a generation object is answered `503 SlowDown`: after MinIO applied it
   * (`landed`), or before it was sent. Every answer the re-send gets is recorded, MinIO's own.
   */
  function throttledOnce(command: string, landed: boolean) {
    const answers: string[] = [];
    const c = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
      forcePathStyle: true,
    });
    let fired = false;
    c.middlewareStack.add(
      (next, context) => async (args) => {
        const key = (args.input as { Key?: string }).Key ?? '';
        const ours = context.commandName === command && key.includes('/segments/');
        if (ours && !fired) {
          fired = true;
          if (!landed) throw throttle();
          await next(args);
          throw throttle();
        }
        try {
          return await next(args);
        } catch (err) {
          if (ours) answers.push((err as { name?: string }).name ?? 'unknown');
          throw err;
        }
      },
      { step: 'initialize', name: 'throttledOnce' },
    );
    return { client: c, answers };
  }

  const quick = { sleep: async () => {} };

  it('stores the write id in the object user metadata, outside its bytes', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1, 2, 3) }]);
    const prefix = `${RUN}/conf/${n - 1}`;
    const head = await client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: storageObjectKey(prefix, gen(1)) }),
    );
    expect(head.Metadata?.cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([
    ['PutObjectCommand', 1024],
    ['CompleteMultipartUploadCommand', 6 * 1024 * 1024],
  ] as const)(
    'a %s MinIO applied is sent again, meets its own object, and is its own',
    async (command, size) => {
      const { client: c, answers } = throttledOnce(command, true);
      const prefix = `${RUN}/throttle-own/${n++}`;
      const driver = new S3StorageDriver({
        client: c,
        bucket: BUCKET,
        prefix,
        partBytes: 5 * 1024 * 1024,
        clock: quick,
      });
      const res = await driver.putImmutable(gen(1), async (sink) => {
        await sink.write(new Uint8Array(size).fill(7));
      });
      expect(res.size).toBe(size);
      // What MinIO answered the re-sent commit: a precondition failure, or for a completion, possibly an unknown
      // upload id. Either is read back by write id.
      expect(answers).toHaveLength(1);
      expect(['PreconditionFailed', 'NoSuchUpload']).toContain(answers[0]);
      const head = await client.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: storageObjectKey(prefix, gen(1)) }),
      );
      expect(head.ContentLength).toBe(size);
    },
  );

  it('a commit throttled before MinIO saw it is sent again and lands', async () => {
    const { client: c } = throttledOnce('PutObjectCommand', false);
    const prefix = `${RUN}/throttle-unapplied/${n++}`;
    const driver = new S3StorageDriver({ client: c, bucket: BUCKET, prefix, clock: quick });
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(4, 5) }]);
    const source = new CrbmStorageChunkSource(
      new S3StorageDriver({ client, bucket: BUCKET, prefix }),
    );
    const bytes = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([4, 5]);
  });

  it('stays a conflict when another writer took the key before the re-send', async () => {
    const { client: c } = throttledOnce('PutObjectCommand', false);
    const prefix = `${RUN}/throttle-other/${n++}`;
    const other = new S3StorageDriver({ client, bucket: BUCKET, prefix });
    const driver = new S3StorageDriver({
      client: c,
      bucket: BUCKET,
      prefix,
      clock: {
        sleep: async () => {
          await writeCrbmGeneration(other, gen(1), [{ chunkKey: 0, bitmap: bm(9) }]);
        },
      },
    });
    await expect(
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });
});
