/**
 * A registry's conditional delete, and a storage driver's, against the three emulators the integration lane runs.
 *
 * A registry removes a row for good only by a delete its backend applies under a precondition: S3 `DeleteObject` with
 * `If-Match: <etag>`, GCS with `ifGenerationMatch: <generation>`, Azure Blob with `ifMatch: <etag>`. Each driver must
 * send that precondition, and each must read a precondition that no longer holds as `WriteConflictError`.
 *
 * What the emulators do with it differs, and the drivers' defaults follow from that:
 *
 * - **Azurite applies it.** A stale ETag is a 412 and the blob stays. The Azure Blob registry removes rows by default,
 *   and this lane proves the fenced path end to end.
 * - **MinIO and fake-gcs-server ignore it.** A delete with a stale ETag or generation deletes the object anyway. So S3
 *   with a custom endpoint, and GCS everywhere, keep tombstones by default, and the cases below that run a stale precondition
 *   against them record that they ignore it: if a pinned image starts applying it, they fail, and the default can be
 *   reconsidered. This lane can therefore show that the S3 and GCS drivers *send* the precondition, never that real
 *   S3 or GCS apply it; `real-cloud-conditional-delete.test.ts` is the probe for that, and it is skipped here.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import {
  CreateBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { BlobServiceClient } from '@azure/storage-blob';
import { registryDeleteConformance, type RegistryDeleteHarness } from '@/testing/conformance';
import { S3RegistryDriver, S3RegistryStore } from '@/s3/registry';
import { GcsRegistryDriver, GcsRegistryStore } from '@/gcs/registry';
import { AzureBlobRegistryDriver, AzureBlobRegistryStore } from '@/azure-blob/registry';
import { S3StorageDriver } from '@/s3/storage';
import { GcsStorageDriver } from '@/gcs/storage';
import { storageObjectKey } from '@/s3/keys';
import { storageObjectName as gcsObjectName } from '@/gcs/keys';
import type { GenKey } from '@/core/ports';
import { S3Storage } from '@cloudbitmaps/s3';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { ObjectStoreRegistry, type ObjectRegistryStore } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { WriteConflictError } from '@/core/errors';
import type { SegmentRef, StorageBackend } from '@/core/ports';
import { CloudRoaring } from '@/index';

const RUN =
  process.env.GITHUB_RUN_ID === undefined
    ? randomUUID().slice(0, 8)
    : `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;

const BUCKET = 'cloudbitmaps-it';
const encoder = new TextEncoder();
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};
let n = 0;
const prefix = (what: string): string => `${RUN}/cdel-${what}/${n++}`;

/** What a delete with a stale precondition did: refused it (`WriteConflictError`), or deleted anyway. */
async function staleDeleteOutcome(run: () => Promise<void>): Promise<'refused' | 'deleted'> {
  try {
    await run();
    return 'deleted';
  } catch (err) {
    if (err instanceof WriteConflictError) return 'refused';
    throw err;
  }
}

// ── MinIO ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const minio = (): S3Client =>
  new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true,
  });
const s3 = minio();
const s3Exists = async (key: string): Promise<boolean> =>
  s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).then(
    () => true,
    () => false,
  );
const s3Put = async (key: string, text: string): Promise<string> =>
  (await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: encoder.encode(text) })))
    .ETag!;

// ── fake-gcs-server ───────────────────────────────────────────────────────────────────────────────────────────────

// fake-gcs-server closes a connection after some answers without saying so, and the SDK keeps the socket in its
// keep-alive pool; seeding the pool with an agent that keeps no sockets makes every request open a fresh one. It
// applies to this file only (vitest gives each file its own worker).
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@google-cloud/storage'));
(sdkRequire('teeny-request/build/src/agents') as { pool: Map<string, http.Agent> }).pool.set(
  'http:forever',
  new http.Agent({ keepAlive: false, maxSockets: Infinity }),
);
const gcs = new Storage({
  projectId: 'test',
  apiEndpoint: process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443',
});
const gcsFile = (name: string) => gcs.bucket(BUCKET).file(name);
const gcsExists = async (name: string): Promise<boolean> => (await gcsFile(name).exists())[0];
const gcsPut = async (name: string, text: string): Promise<number> => {
  await gcsFile(name).save(text, { resumable: false });
  return Number((await gcsFile(name).getMetadata())[0].generation);
};

// ── Azurite ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Azurite's fixed, publicly-documented dev account + key (not a secret — the same value ships in every SDK).
const CONN =
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;` +
  `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;` +
  `BlobEndpoint=${process.env.AZURITE_BLOB_ENDPOINT ?? 'http://127.0.0.1:10000/devstoreaccount1'};`;
const container = BlobServiceClient.fromConnectionString(CONN).getContainerClient(BUCKET);
const azureExists = async (name: string): Promise<boolean> =>
  (await container.getBlockBlobClient(name).exists()) === true;
const azurePut = async (name: string, text: string): Promise<string> => {
  const bytes = encoder.encode(text);
  return (await container.getBlockBlobClient(name).upload(bytes, bytes.length)).etag!;
};

beforeAll(async () => {
  // Each emulator answers before its bucket is made, so poll until it does, then make the bucket once.
  for (let attempt = 0; ; attempt++) {
    try {
      await s3.send(new ListBucketsCommand({}));
      await gcs.getBuckets();
      await container.createIfNotExists();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((err: { name?: string }) => {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  });
  await gcs.createBucket(BUCKET).catch((err: { code?: number }) => {
    if (err.code !== 409) throw err;
  });
}, 30_000);

/** A delete-conformance harness over one emulator, probing and planting through its own SDK. */
function harness(
  driver: (p: string) => ObjectStoreRegistry,
  exists: (key: string) => Promise<boolean>,
  put: (key: string, text: string) => Promise<unknown>,
): () => RegistryDeleteHarness {
  return () => {
    const p = prefix('conf');
    return {
      driver: driver(p),
      stored: (ref) => exists(registryObjectKey(p, ref)),
      plantRow: async (ref, text) => {
        await put(registryObjectKey(p, ref), text);
      },
    };
  };
}

// What a delete leaves behind, per emulator, with each driver's default: tombstones on MinIO and fake-gcs-server (a
// custom endpoint), removal on Azurite; and with the gate set the other way where that is safe to run.
registryDeleteConformance(
  'S3RegistryDriver (MinIO, default: tombstones)',
  harness(
    (p) => new S3RegistryDriver({ client: s3, bucket: BUCKET, prefix: p, now: ticking() }),
    s3Exists,
    s3Put,
  ),
);
registryDeleteConformance(
  'GcsRegistryDriver (fake-gcs-server, default: tombstones)',
  harness(
    (p) => new GcsRegistryDriver({ storage: gcs, bucket: BUCKET, prefix: p, now: ticking() }),
    gcsExists,
    gcsPut,
  ),
);
registryDeleteConformance(
  'AzureBlobRegistryDriver (Azurite, default: removes)',
  harness(
    (p) => new AzureBlobRegistryDriver({ containerClient: container, prefix: p, now: ticking() }),
    azureExists,
    azurePut,
  ),
);
registryDeleteConformance(
  'AzureBlobRegistryDriver (Azurite, conditionalDelete: false)',
  harness(
    (p) =>
      new AzureBlobRegistryDriver({
        containerClient: container,
        prefix: p,
        now: ticking(),
        conditionalDelete: false,
      }),
    azureExists,
    azurePut,
  ),
);

describe('S3 (MinIO): the driver sends If-Match; MinIO ignores it', () => {
  it('the gate is off by default for a client with a custom endpoint', () => {
    expect(
      new S3RegistryDriver({ client: s3, bucket: BUCKET }).capabilities().conditionalDelete,
    ).toBe(false);
    expect(
      new S3Storage({ bucket: BUCKET, client: s3 }).registry.capabilities().conditionalDelete,
    ).toBe(false);
  });

  it('the DeleteObject carries If-Match set to the ETag the registry read', async () => {
    const p = prefix('header');
    const sent: Array<string | undefined> = [];
    const watched = minio();
    watched.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'DeleteObjectCommand') {
          const headers = (args.request as { headers: Record<string, string> }).headers;
          sent.push(headers['if-match']);
        }
        return next(args);
      },
      { step: 'finalizeRequest', name: 'watchDeleteIfMatch' },
    );
    const reg = new S3RegistryDriver({
      client: watched,
      bucket: BUCKET,
      prefix: p,
      now: ticking(),
      conditionalDelete: true,
    });
    const ref = { segment: 's' };
    const { token } = await reg.create(ref, { currentGen: 0 });
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: registryObjectKey(p, ref) }),
    );
    await reg.delete(ref, token);
    expect(sent).toEqual([head.ETag]);
    expect(await s3Exists(registryObjectKey(p, ref))).toBe(false);
  });

  it('MinIO ignores If-Match on DeleteObject: a stale ETag deletes anyway, and so does one on a missing key', async () => {
    const store = new S3RegistryStore(s3, BUCKET, 0, true);
    const key = `${prefix('stale')}/row.reg`;
    const stale = await s3Put(key, 'one');
    await s3Put(key, 'two'); // the object moves on
    expect(await staleDeleteOutcome(() => store.delete(key, { version: stale }))).toBe('deleted');
    expect(await s3Exists(key)).toBe(false);
    expect(await staleDeleteOutcome(() => store.delete(`${key}.missing`, { version: stale }))).toBe(
      'deleted',
    );
  });

  it('a delete with the current ETag removes the object', async () => {
    const store = new S3RegistryStore(s3, BUCKET, 0, true);
    const key = `${prefix('current')}/row.reg`;
    const etag = await s3Put(key, 'one');
    await store.delete(key, { version: etag });
    expect(await s3Exists(key)).toBe(false);
  });

  it('a retention purge on MinIO, with the default, leaves the tombstone', async () => {
    const p = prefix('sweep');
    const backend = new S3Storage({ bucket: BUCKET, client: s3, prefix: p });
    await expectPurgeLeaves(backend, true, (ref) => s3Exists(registryObjectKey(p, ref)));
  });
});

describe('GCS (fake-gcs-server): the driver sends ifGenerationMatch; the emulator ignores it', () => {
  it('the gate is off by default for a client with a custom endpoint', () => {
    expect(
      new GcsRegistryDriver({ storage: gcs, bucket: BUCKET }).capabilities().conditionalDelete,
    ).toBe(false);
  });

  it('the delete carries ifGenerationMatch set to the generation the registry read', async () => {
    const p = prefix('header');
    const sent: unknown[] = [];
    const watched = new Storage({
      projectId: 'test',
      apiEndpoint: process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443',
    });
    watched.interceptors.push({
      // The interceptor sees each request's options as the SDK built them, and hands them on unchanged.
      request: (reqOpts) => {
        const seen = reqOpts as { method?: string; qs?: Record<string, unknown> };
        if (seen.method === 'DELETE') sent.push(seen.qs?.ifGenerationMatch);
        return reqOpts as Parameters<typeof watched.makeAuthenticatedRequest>[0];
      },
    });
    const reg = new GcsRegistryDriver({
      storage: watched,
      bucket: BUCKET,
      prefix: p,
      now: ticking(),
      conditionalDelete: true,
    });
    const ref = { segment: 's' };
    const { token } = await reg.create(ref, { currentGen: 0 });
    const [meta] = await gcsFile(registryObjectKey(p, ref)).getMetadata();
    await reg.delete(ref, token);
    expect(sent).toEqual([Number(meta.generation)]);
    expect(await gcsExists(registryObjectKey(p, ref))).toBe(false);
  });

  it('fake-gcs-server ignores ifGenerationMatch on a delete: a stale generation deletes anyway', async () => {
    const store = new GcsRegistryStore(gcs, gcs, BUCKET, 0, true);
    const name = `${prefix('stale')}/row.reg`;
    const stale = await gcsPut(name, 'one');
    await gcsPut(name, 'two');
    expect(await staleDeleteOutcome(() => store.delete(name, { version: String(stale) }))).toBe(
      'deleted',
    );
    expect(await gcsExists(name)).toBe(false);
  });

  it('a delete of a missing object is a conflict', async () => {
    const store = new GcsRegistryStore(gcs, gcs, BUCKET, 0, true);
    await expect(
      store.delete(`${prefix('missing')}/row.reg`, { version: '1' }),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('a retention purge on fake-gcs-server, with the default, leaves the tombstone', async () => {
    const p = prefix('sweep');
    const backend = new GcsStorage({ bucket: BUCKET, client: gcs, prefix: p });
    await expectPurgeLeaves(backend, true, (ref) => gcsExists(registryObjectKey(p, ref)));
  });
});

describe('Azure Blob (Azurite): the precondition is applied', () => {
  it('the gate is on by default', () => {
    expect(
      new AzureBlobStorage({ containerClient: container }).registry.capabilities()
        .conditionalDelete,
    ).toBe(true);
  });

  it('a stale ETag is a 412: WriteConflictError, and the blob stays', async () => {
    const store = new AzureBlobRegistryStore(container, 0, true);
    const name = `${prefix('stale')}/row.reg`;
    const stale = await azurePut(name, 'one');
    await azurePut(name, 'two');
    expect(await staleDeleteOutcome(() => store.delete(name, { version: stale }))).toBe('refused');
    expect(await azureExists(name)).toBe(true);
  });

  it('a missing blob is a conflict, and the current ETag removes it', async () => {
    const store = new AzureBlobRegistryStore(container, 0, true);
    const name = `${prefix('current')}/row.reg`;
    await expect(store.delete(`${name}.missing`, { version: '"0x1"' })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    const etag = await azurePut(name, 'one');
    await store.delete(name, { version: etag });
    expect(await azureExists(name)).toBe(false);
  });

  it('a write between the registry’s read and its delete fails the delete, and the written row survives', async () => {
    const p = prefix('race');
    const real = new AzureBlobRegistryStore(container, 0, true);
    let hook: (() => Promise<void>) | undefined;
    const store: ObjectRegistryStore = {
      label: real.label,
      conditionalDelete: true,
      read: (k) => real.read(k),
      write: (k, b, e) => real.write(k, b, e),
      listKeys: (pre) => real.listKeys(pre),
      delete: async (k, e) => {
        const run = hook;
        hook = undefined;
        if (run !== undefined) await run();
        return real.delete(k, e);
      },
    };
    const a = new ObjectStoreRegistry(store, p, ticking());
    const b = new AzureBlobRegistryDriver({
      containerClient: container,
      prefix: p,
      now: ticking(),
    });
    const ref = { segment: 's' };
    const { token } = await a.create(ref, { currentGen: 0 });
    let written = '';
    hook = async () => {
      written = (await b.compareAndSwap(ref, token, { currentGen: 1 })).token;
    };
    await expect(a.delete(ref, token)).rejects.toBeInstanceOf(WriteConflictError);
    expect(await b.get(ref)).toMatchObject({ currentGen: 1, token: written });
  });

  it('a retention purge on Azurite removes the row for good', async () => {
    const p = prefix('sweep');
    const backend = new AzureBlobStorage({ containerClient: container, prefix: p });
    await expectPurgeLeaves(backend, false, (ref) => azureExists(registryObjectKey(p, ref)));
  });

  it('a row blob that has a snapshot refuses the purge: a purge fault in the result, retirements unharmed, and the next sweep purges once it is gone', async () => {
    // Delete Blob without `deleteSnapshots` answers 409 SnapshotsPresent for a blob that has one. It is no lost race, so
    // it is not read as one: the ledger says why, the result counts it, and the sweep goes on to retire what is behind it.
    const p = prefix('snapshot');
    const backend = new AzureBlobStorage({ containerClient: container, prefix: p });
    let t = 1_800_000_000_000;
    const clock = { now: () => t, sleep: () => Promise.resolve() };
    const store = new CloudRoaring({ storage: backend, seams: { clock } });
    const stuck = { namespace: 'sends', segment: 'a-stuck' };
    const behind = { namespace: 'sends', segment: 'z-behind' };
    await store.load(stuck, [1]);
    await store.setRetention(stuck, { expiresAt: t + 1 });
    t += 2;
    expect((await store.retireExpired({ tombstoneGraceMs: 1_000 })).retired).toBe(1);
    const row = container.getBlockBlobClient(registryObjectKey(p, stuck));
    const { snapshot } = await row.createSnapshot();
    await store.load(behind, [2]);
    await store.setRetention(behind, { expiresAt: t + 1 });
    t += 1_002; // the stuck tombstone is due, and `behind` has expired

    const res = await store.retireExpired({ tombstoneGraceMs: 1_000, limit: 1 });
    expect(res.retired).toBe(1); // not held back by the refused purge, though the limit is 1
    expect(res.tombstonesPurged).toBe(0);
    expect(res.entries[0]).toMatchObject({
      segment: 'a-stuck',
      action: 'skipped',
      reason: expect.stringMatching(/^failed: .*snapshot/i),
    });
    expect(res.purgeFaults).toBeGreaterThanOrEqual(1);
    expect(res.firstPurgeFault).toMatch(/snapshot/i);
    expect(await backend.registry.get(stuck)).toMatchObject({ status: 'destroyed' });

    await row.withSnapshot(snapshot!).delete();
    const next = await store.retireExpired({ tombstoneGraceMs: 1_000 });
    expect(next.purgeFaults).toBe(0);
    expect(await backend.registry.get(stuck)).toBeNull();
    expect(await azureExists(registryObjectKey(p, stuck))).toBe(false);
  });
});

// ── Storage: a delete given the version a tail read reported ──────────────────────────────────────────────────────

const GEN: GenKey = { segment: 's', generation: 0 };
const writeText = (driver: { putImmutable: S3StorageDriver['putImmutable'] }, text: string) =>
  driver.putImmutable(GEN, (sink) => sink.write(encoder.encode(text)));

describe('S3 storage (MinIO): the driver sends If-Match with the ETag its tail read reported; MinIO ignores it', () => {
  it('the gate is off by default for a client with a custom endpoint', async () => {
    const driver = new S3StorageDriver({ client: s3, bucket: BUCKET, prefix: prefix('st-gate') });
    await driver.delete(GEN, { ifVersion: '"settles the client"' });
    expect(driver.capabilities().conditionalDelete).toBe(false);
    expect(
      new S3Storage({ bucket: BUCKET, client: s3 }).storage.capabilities().conditionalDelete,
    ).toBe(false);
  });

  it('vouched for, the DeleteObject carries the ETag the tail read reported, and a stale one deletes anyway', async () => {
    const p = prefix('st-header');
    const sent: Array<string | undefined> = [];
    const watched = minio();
    watched.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'DeleteObjectCommand') {
          sent.push((args.request as { headers: Record<string, string> }).headers['if-match']);
        }
        return next(args);
      },
      { step: 'finalizeRequest', name: 'watchStorageDeleteIfMatch' },
    );
    const driver = new S3StorageDriver({
      client: watched,
      bucket: BUCKET,
      prefix: p,
      conditionalDelete: true,
    });
    await writeText(driver, 'one');
    const { version } = await driver.getTail(GEN, 3);
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: storageObjectKey(p, GEN) }),
    );
    expect(version).toBe(head.ETag);
    await driver.delete(GEN);
    await writeText(driver, 'two');
    expect(await staleDeleteOutcome(() => driver.delete(GEN, { ifVersion: version }))).toBe(
      'deleted',
    );
    expect(sent).toEqual([undefined, version]);
    expect(await s3Exists(storageObjectKey(p, GEN))).toBe(false);
  });
});

describe('GCS storage (fake-gcs-server): the driver sends ifGenerationMatch; the emulator ignores it', () => {
  it('the gate is off by default', () => {
    expect(
      new GcsStorageDriver({ storage: gcs, bucket: BUCKET }).capabilities().conditionalDelete,
    ).toBe(false);
  });

  it('vouched for, the delete carries the generation the tail read reported, and a stale one deletes anyway', async () => {
    const p = prefix('st-header');
    const sent: unknown[] = [];
    const watched = new Storage({
      projectId: 'test',
      apiEndpoint: process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443',
    });
    watched.interceptors.push({
      request: (reqOpts) => {
        const seen = reqOpts as { method?: string; qs?: Record<string, unknown> };
        if (seen.method === 'DELETE') sent.push(seen.qs?.ifGenerationMatch);
        return reqOpts as Parameters<typeof watched.makeAuthenticatedRequest>[0];
      },
    });
    const driver = new GcsStorageDriver({
      storage: watched,
      bucket: BUCKET,
      prefix: p,
      conditionalDelete: true,
    });
    await writeText(driver, 'one');
    const { version } = await driver.getTail(GEN, 3);
    const [meta] = await gcsFile(gcsObjectName(p, GEN)).getMetadata();
    expect(version).toBe(String(meta.generation));
    await driver.delete(GEN);
    await writeText(driver, 'two');
    expect(await staleDeleteOutcome(() => driver.delete(GEN, { ifVersion: version }))).toBe(
      'deleted',
    );
    expect(sent).toEqual([undefined, Number(version)]);
    expect(await gcsExists(gcsObjectName(p, GEN))).toBe(false);
  });
});

/**
 * Load a segment, give it a policy, retire it and purge its tombstone through the store, then check whether the
 * backend still holds an object for its row.
 */
async function expectPurgeLeaves(
  backend: StorageBackend,
  tombstone: boolean,
  stored: (ref: SegmentRef) => Promise<boolean>,
): Promise<void> {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const store = new CloudRoaring({ storage: backend, seams: { clock } });
  const ref = { namespace: 'sends', segment: 'copy' };
  await store.load(ref, [1, 2, 3]);
  await store.setRetention(ref, { expiresAt: t + 1 });
  t += 2;
  expect((await store.retireExpired({ tombstoneGraceMs: 1_000 })).retired).toBe(1);
  t += 1_000;
  expect((await store.retireExpired({ tombstoneGraceMs: 1_000 })).tombstonesPurged).toBe(1);
  expect(await backend.registry.get(ref)).toBeNull();
  expect(await stored(ref)).toBe(tombstone);
}
