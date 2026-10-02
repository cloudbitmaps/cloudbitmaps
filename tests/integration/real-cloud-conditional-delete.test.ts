/**
 * REAL-CLOUD PROBE, skipped unless asked for: do real S3 and real GCS apply the precondition on a delete?
 *
 * The S3 registry removes a row with `DeleteObject` under `If-Match: <etag>`, and the GCS registry with a delete under
 * `ifGenerationMatch: <generation>`, by default on AWS S3 and on the public GCS endpoint. That default is safe only if
 * the service refuses a delete whose precondition no longer holds: one that deleted anyway would let two sweepers and a
 * re-create delete a live row. The integration lane cannot show it, because MinIO and fake-gcs-server ignore the
 * precondition (see `conditional-delete.test.ts`). This file is the check, against real buckets, and it is a release
 * gate for the release that turns the default on: if a stale precondition deletes, turn that backend's default off
 * before the cut, and record what this printed either way.
 *
 * It never runs in CI or on a laptop by accident: each half is skipped unless its bucket is named. It writes, reads
 * and deletes a handful of small objects under one random prefix in the bucket you name, and removes them at the end.
 *
 *   CBM_PROBE_S3_BUCKET=<scratch bucket> AWS_REGION=<its region> \
 *     pnpm exec vitest run -c vitest.integration.config.ts tests/integration/real-cloud-conditional-delete.test.ts
 *   CBM_PROBE_GCS_BUCKET=<scratch bucket> \
 *     pnpm exec vitest run -c vitest.integration.config.ts tests/integration/real-cloud-conditional-delete.test.ts
 *
 * Credentials come from each SDK's own default chain, as in production; nothing here reads or prints them.
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { S3RegistryDriver, S3RegistryStore } from '@/s3/registry';
import { GcsRegistryDriver, GcsRegistryStore } from '@/gcs/registry';
import { ObjectStoreRegistry, type ObjectRegistryStore } from '@/drivers/_shared/object-registry';
import { registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { WriteConflictError } from '@/core/errors';
import type { IRegistryDriver } from '@/core/ports';

const S3_BUCKET = process.env.CBM_PROBE_S3_BUCKET;
const GCS_BUCKET = process.env.CBM_PROBE_GCS_BUCKET;
const PREFIX = `cloudbitmaps-delete-probe/${randomUUID()}`;
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

/** What a delete did: refused it with `WriteConflictError`, or deleted. Any other error fails the probe. */
async function outcome(run: () => Promise<void>): Promise<'refused' | 'deleted'> {
  try {
    await run();
    return 'deleted';
  } catch (err) {
    if (err instanceof WriteConflictError) return 'refused';
    throw err;
  }
}

/**
 * The registry end to end: a write that lands between a delete's read and its delete must fail the delete, through
 * the store's precondition alone, since the registry's own token check passed before the write.
 */
async function raceThroughTheRegistry(
  real: ObjectRegistryStore,
  other: IRegistryDriver,
  prefix: string,
  exists: (key: string) => Promise<boolean>,
): Promise<void> {
  let hook: (() => Promise<void>) | undefined;
  const store: ObjectRegistryStore = {
    label: real.label,
    conditionalDelete: true,
    read: (k) => real.read(k),
    write: (k, b, e) => real.write(k, b, e),
    listKeys: (p) => real.listKeys(p),
    delete: async (k, e) => {
      const run = hook;
      hook = undefined;
      if (run !== undefined) await run();
      return real.delete!(k, e);
    },
  };
  const a = new ObjectStoreRegistry(store, prefix, ticking());
  const ref = { segment: 'raced' };
  const { token } = await a.create(ref, { currentGen: 0 });
  let written = '';
  hook = async () => {
    written = (await other.compareAndSwap(ref, token, { currentGen: 1 })).token;
  };
  await expect(a.delete(ref, token)).rejects.toBeInstanceOf(WriteConflictError);
  expect(await other.get(ref)).toMatchObject({ currentGen: 1, token: written });
  await a.delete(ref, written);
  expect(await exists(registryObjectKey(prefix, ref))).toBe(false);
}

describe.skipIf(S3_BUCKET === undefined)('REAL S3: DeleteObject with If-Match', () => {
  // Built in `beforeAll`, so a skipped run constructs no client and consults no credential chain.
  let client: S3Client;
  let store: S3RegistryStore;
  const bucket = S3_BUCKET ?? '';
  beforeAll(() => {
    client = new S3Client({});
    store = new S3RegistryStore(client, bucket, 0, true);
  });
  const put = async (key: string, text: string): Promise<string> =>
    (await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text }))).ETag!;
  const exists = (key: string): Promise<boolean> =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(
      () => true,
      () => false,
    );

  afterAll(async () => {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX }));
    for (const o of listed.Contents ?? []) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
    }
  });

  it('GATE: a stale ETag is refused, and the object stays', async () => {
    const key = `${PREFIX}/s3-stale`;
    const stale = await put(key, 'one');
    await put(key, 'two');
    expect(await outcome(() => store.delete(key, { version: stale }))).toBe('refused');
    expect(await exists(key)).toBe(true);
  });

  it('the current ETag deletes', async () => {
    const key = `${PREFIX}/s3-current`;
    const etag = await put(key, 'one');
    expect(await outcome(() => store.delete(key, { version: etag }))).toBe('deleted');
    expect(await exists(key)).toBe(false);
  });

  it('RECORD: what an If-Match on a missing key answers (either is safe; the evidence names which)', async () => {
    const seen = await outcome(() => store.delete(`${PREFIX}/s3-missing`, { version: '"0"' }));
    console.info(`real S3, DeleteObject with If-Match on a missing key: ${seen}`);
    expect(['refused', 'deleted']).toContain(seen);
  });

  it('GATE: a write between the registry’s read and its delete fails the delete', async () => {
    const prefix = `${PREFIX}/s3-race`;
    await raceThroughTheRegistry(
      store,
      new S3RegistryDriver({ client, bucket, prefix, now: ticking() }),
      prefix,
      exists,
    );
  });
});

describe.skipIf(GCS_BUCKET === undefined)('REAL GCS: delete with ifGenerationMatch', () => {
  // Built in `beforeAll`, so a skipped run constructs no client and consults no credential chain.
  let storage: Storage;
  let store: GcsRegistryStore;
  const bucket = GCS_BUCKET ?? '';
  beforeAll(() => {
    storage = new Storage();
    store = new GcsRegistryStore(storage, storage, bucket, true);
  });
  const file = (name: string) => storage.bucket(bucket).file(name);
  const put = async (name: string, text: string): Promise<string> => {
    await file(name).save(text, { resumable: false });
    return String((await file(name).getMetadata())[0].generation);
  };
  const exists = async (name: string): Promise<boolean> => (await file(name).exists())[0];

  afterAll(async () => {
    const [files] = await storage.bucket(bucket).getFiles({ prefix: PREFIX });
    for (const f of files) await f.delete({ ignoreNotFound: true });
  });

  it('GATE: a stale generation is refused, and the object stays', async () => {
    const name = `${PREFIX}/gcs-stale`;
    const stale = await put(name, 'one');
    await put(name, 'two');
    expect(await outcome(() => store.delete(name, { version: stale }))).toBe('refused');
    expect(await exists(name)).toBe(true);
  });

  it('the current generation deletes', async () => {
    const name = `${PREFIX}/gcs-current`;
    const generation = await put(name, 'one');
    expect(await outcome(() => store.delete(name, { version: generation }))).toBe('deleted');
    expect(await exists(name)).toBe(false);
  });

  it('RECORD: what ifGenerationMatch on a missing object answers (either is safe; the evidence names which)', async () => {
    const seen = await outcome(() => store.delete(`${PREFIX}/gcs-missing`, { version: '1' }));
    console.info(`real GCS, delete with ifGenerationMatch on a missing object: ${seen}`);
    expect(['refused', 'deleted']).toContain(seen);
  });

  it('GATE: a write between the registry’s read and its delete fails the delete', async () => {
    const prefix = `${PREFIX}/gcs-race`;
    await raceThroughTheRegistry(
      store,
      new GcsRegistryDriver({ storage, bucket, prefix, now: ticking() }),
      prefix,
      exists,
    );
  });
});
