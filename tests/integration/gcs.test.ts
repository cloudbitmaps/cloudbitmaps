import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
// Runs against fake-gcs-server from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real GCP needed. Passing `apiEndpoint` (with any `projectId`) targets the
// emulator and skips auth — do NOT also set `STORAGE_EMULATOR_HOST` (empirically it makes the JSON-API calls
// 404 against fake-gcs-server; apiEndpoint alone is the working config).
import { Writable } from 'node:stream';
import { Storage } from '@google-cloud/storage';
import {
  storageChunkSourceConformance,
  storageDriverConformance,
  registryConformance,
  registryConcurrency,
  CONFORMANCE_SEGMENT,
} from '@/testing/conformance';
import { GcsStorageDriver } from '@/gcs/storage';
import { storageObjectName } from '@/gcs/keys';
import { GcsRegistryDriver } from '@/gcs/registry';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { CrbmStorageChunkSource, writeCrbmGeneration } from '@/core/crbm-storage-source';
import { CloudRoaring } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import { brandAsBackend, type GenKey } from '@/core/ports';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import {
  expectMissingLocationFails,
  expectMissingObjectIsAbsent,
} from '../helpers/missing-location';
import { forwardingProxy } from '../helpers/forwarding-proxy';

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

const ENDPOINT = process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443';
const BUCKET = 'cloudbitmaps-it';
const storage = new Storage({ projectId: 'test', apiEndpoint: ENDPOINT });
// fake-gcs-server closes the connection after it answers a 416 (a range starting past EOF) without saying so, and
// the SDK keeps that socket in its keep-alive pool. The next request on it, whatever it is, fails with ECONNRESET
// before the server reads a byte. The driver sends a conditional write once, so it reports that reset as a
// `TransientError` where an SDK retry would have hidden it.
//
// The SDK exposes no client option for its HTTP agent: its transport (`teeny-request`) takes the agent from a
// module-level pool keyed by scheme, and only creates the keep-alive one when the key is absent. Seeding the key
// with an agent that does not keep sockets makes every request open a fresh connection, so the emulator's quirk
// cannot reach a test. It applies to this test file only (vitest gives each file its own worker); the driver is untouched.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@google-cloud/storage'));
(sdkRequire('teeny-request/build/src/agents') as { pool: Map<string, http.Agent> }).pool.set(
  'http:forever',
  new http.Agent({ keepAlive: false, maxSockets: Infinity }),
);

beforeAll(async () => {
  // `docker compose up --wait` returns when the container is *running*, not necessarily accepting HTTP — poll
  // until the emulator answers so a cold-start ECONNREFUSED can't red the suite (deterministic readiness).
  for (let attempt = 0; ; attempt++) {
    try {
      await storage.getBuckets();
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // ~15s
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    await storage.createBucket(BUCKET);
  } catch (err) {
    // Bucket already exists (from a prior run) — fine (GCS returns 409).
    if ((err as { code?: number }).code !== 409) throw err;
  }
}, 30_000);

// The GCS registry must pass the SAME registry contract as memory / LocalFs / S3 — against real object
// preconditions (`ifGenerationMatch: 0` for create-only, `ifGenerationMatch: <generation>` for CAS) via
// fake-gcs-server. This is what makes a GCS-only topology viable: the pointer to the current generation lives
// in the same bucket as the objects, so a GCS user needs no second service, and no second cloud account, to
// store it.
let rn = 0;
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};
// Never created: the emulator answers as the service does for a bucket that is not there.
const MISSING = `cloudbitmaps-missing-${RUN}`.toLowerCase();
// fake-gcs-server 1.52.2 does not page a listing: it truncates at `maxResults` and sends no `nextPageToken`, so a listing
// past one page cannot be held here. The registry, which asks for 1,000 rows a page, is held to paging by its unit fake
// (three rows a page). A generation listing is paged by the SDK's auto-pagination, which sends no page size, so the
// emulator answers it in one page: there the case holds the count, and the paging rests on the SDK.
const PAST_ONE_PAGE = 1_001;
registryConformance(
  'GcsRegistryDriver (fake-gcs-server)',
  () =>
    new GcsRegistryDriver({
      storage,
      bucket: BUCKET,
      prefix: `${RUN}/reg-conf/${rn++}`,
      now: ticking(),
    }),
  {
    missingLocation: () =>
      new GcsRegistryDriver({ storage, bucket: MISSING, prefix: `${RUN}/missing`, now: ticking() }),
  },
);

// And it must fence writers that do NOT share a process — the property the sequential suite above cannot
// reach, because the shared class short-circuits on its in-memory token check before the store is asked.
// The emulator only enforces `ifGenerationMatch` on the simple (non-resumable) upload path, which is
// precisely why `GcsStore.write` pins `resumable: false`; these cases fail without it.
registryConcurrency('GcsRegistryDriver (fake-gcs-server)', () => {
  const prefix = `${RUN}/reg-race/${rn++}`;
  return [
    new GcsRegistryDriver({ storage, bucket: BUCKET, prefix, now: ticking() }),
    new GcsRegistryDriver({ storage, bucket: BUCKET, prefix, now: ticking() }),
  ];
});

let n = 0;
const freshDriver = (): GcsStorageDriver =>
  new GcsStorageDriver({ storage, bucket: BUCKET, prefix: `${RUN}/conf/${n++}` });

// The GCS driver must pass the SAME storage-source contract as in-memory + LocalFs + S3.
// The same IStorageDriver contract memory and LocalFs pass: write-once, typed errors, true tail size, idempotent
// delete, read-after-delete listing.
storageDriverConformance('GcsStorageDriver (fake-gcs-server)', freshDriver, {
  missingLocation: () =>
    new GcsStorageDriver({ storage, bucket: MISSING, prefix: `${RUN}/missing` }),
  pagedListSize: PAST_ONE_PAGE,
});
// The same cases with a 100-byte threshold, so every object takes the resumable upload. fake-gcs-server does not
// enforce `ifGenerationMatch` on a resumable upload (a second write to the key succeeds and overwrites), so the
// collision is skipped here: a real GCS answers it with 412, and the driver maps that the same way as the simple path.
storageDriverConformance(
  'GcsStorageDriver, resumable (fake-gcs-server)',
  () =>
    new GcsStorageDriver({
      storage,
      bucket: BUCKET,
      prefix: `${RUN}/conf-resumable/${n++}`,
      simpleUploadThresholdBytes: 100,
    }),
  { skip: ['collision'] },
);

storageChunkSourceConformance('GcsStorageDriver (fake-gcs-server)', async (chunks) => {
  const driver = freshDriver();
  await writeCrbmGeneration(driver, { segment: CONFORMANCE_SEGMENT, generation: 1 }, chunks);
  return new CrbmStorageChunkSource(driver);
});

describe('GcsStorageDriver specifics (fake-gcs-server)', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });

  it('is write-once: a second put to the same key is a WriteConflictError', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1, 2, 3) }]);
    await expect(
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(9) }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    // The original is intact.
    const source = new CrbmStorageChunkSource(driver);
    const bytes = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([1, 2, 3]);
  });

  // The write-once test above stays under the 8 MiB threshold, so it exercises only the SIMPLE upload path.
  // Force the RESUMABLE (large-object, constant-memory) path with a tiny threshold and prove it round-trips
  // end-to-end against a real emulator — catching a broken resumable stream / backpressure / finalize / read
  // path the simple path can't. This is the large-generation load path, which the unit suite exercises only
  // against an in-process mock.
  //
  // NOTE ON WRITE-ONCE ENFORCEMENT: this test does NOT assert the second write conflicts, because
  // fake-gcs-server does not honor `ifGenerationMatch: 0` on the resumable-upload *finalize* (empirically it
  // overwrites — unlike its simple-upload path, and unlike real GCS). Resumable write-once enforcement is
  // instead covered by (a) the driver-level mock test asserting the driver sends `resumable:true` +
  // `ifGenerationMatch:0` and maps a 412-on-commit to WriteConflictError (tests/drivers/gcs/storage.test.ts), and
  // (b) real GCS, which enforces the precondition. Asserting it here would test the emulator's gap, not ours.
  it('round-trips a generation written via the RESUMABLE (large-object) upload path', async () => {
    const driver = new GcsStorageDriver({
      storage,
      bucket: BUCKET,
      prefix: `${RUN}/resumable/${n++}`,
      simpleUploadThresholdBytes: 8, // any real .crbm object exceeds this → resumable stream
    });
    await writeCrbmGeneration(driver, gen(1), [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
      { chunkKey: 7, bitmap: bm(500, 70_000) },
    ]);
    const source = new CrbmStorageChunkSource(driver);
    const c0 = await source.getChunk({ segment: 's', chunkKey: 0 });
    const c7 = await source.getChunk({ segment: 's', chunkKey: 7 });
    expect(SafeBitmap.safeDeserialize(c0!, 1 << 20).toArray()).toEqual([1, 2, 3]);
    expect(SafeBitmap.safeDeserialize(c7!, 1 << 20).toArray()).toEqual([500, 70_000]);
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
    // Start in-bounds but END past EOF → a short read → treated as out-of-bounds, never a partial result.
    await expect(driver.getRange(gen(1), size - 1, 50)).rejects.toBeInstanceOf(ValidationError);
    // Start fully past EOF (GCS 416) maps to ValidationError too.
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
    expect(tail.size).toBe(size);
    expect(tail.bytes.length).toBe(Math.min(16, size));
    const whole = await driver.getTail(gen(1), size + 1000);
    expect(whole.size).toBe(size);
    expect(whole.bytes.length).toBe(size);
  });

  it('delete is idempotent and actually removes the object', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]);
    await driver.delete(gen(1));
    await expect(driver.getTail(gen(1), 1024)).rejects.toBeInstanceOf(NotFoundError);
    await driver.delete(gen(1)); // idempotent — no throw on an absent object
  });

  it('lists exactly the generations present for a segment', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]);
    await writeCrbmGeneration(driver, gen(3), [{ chunkKey: 0, bitmap: bm(2) }]);
    const gens: number[] = [];
    for await (const k of driver.list({ segment: 's' })) gens.push(k.generation);
    expect(gens.sort((a, b) => a - b)).toEqual([1, 3]);
  });
});

// A resumable upload is a session the SDK retries within, so a commit that landed and lost its response can be
// answered 412 by its own replay. fake-gcs-server does not enforce `ifGenerationMatch` on a resumable commit (see the
// note above), so it can produce neither answer. The proxy below stands in for the service's 412 and keeps the rest
// real: a resumable stream that sends the object to the emulator, with the metadata the driver attached, and then
// fails its commit with a 412, as the replay of a write that landed does (`'replay'`), or fails its commit with a 412
// without sending anything, as a write that lost to another does (`'refuse'`). The driver's read-back is real: it
// reads the stored object's metadata from the emulator.
function resumableAnswering412(mode: 'replay' | 'refuse'): Storage {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop !== 'bucket') return Reflect.get(target, prop, receiver) as unknown;
      return (name: string) => {
        const bucket = target.bucket(name);
        return new Proxy(bucket, {
          get(b, p) {
            if (p !== 'file') {
              const v = Reflect.get(b, p) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(b) : v;
            }
            return (objectName: string) => {
              const file = b.file(objectName);
              return new Proxy(file, {
                get(f, q) {
                  if (q !== 'createWriteStream') {
                    const v = Reflect.get(f, q) as unknown;
                    return typeof v === 'function'
                      ? (v as (...a: unknown[]) => unknown).bind(f)
                      : v;
                  }
                  return (options: Parameters<typeof f.createWriteStream>[0]) => {
                    const chunks: Buffer[] = [];
                    return new Writable({
                      write(chunk: Buffer, _enc, cb) {
                        chunks.push(chunk);
                        cb();
                      },
                      final(cb) {
                        const lost = Object.assign(new Error('precondition failed'), { code: 412 });
                        if (mode === 'refuse') return cb(lost);
                        const real = f.createWriteStream(options);
                        real.once('error', cb);
                        real.once('finish', () => cb(lost));
                        real.end(Buffer.concat(chunks));
                      },
                    });
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

describe('GCS resumable conflict against the write own id (fake-gcs-server)', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });
  const resumable = (client: Storage, prefix: string): GcsStorageDriver =>
    new GcsStorageDriver({
      storage: client,
      bucket: BUCKET,
      prefix,
      simpleUploadThresholdBytes: 8, // any real .crbm object exceeds this: resumable
    });

  it('stores the id in the object custom metadata, outside its bytes', async () => {
    const prefix = `${RUN}/wid-meta/${n++}`;
    await writeCrbmGeneration(resumable(storage, prefix), gen(1), [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
    ]);
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix });
    expect(files).toHaveLength(1);
    const [meta] = await files[0]!.getMetadata();
    expect((meta.metadata as { cbwid?: string }).cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is a success when the 412 is the upload meeting its own object', async () => {
    const prefix = `${RUN}/wid-own/${n++}`;
    await writeCrbmGeneration(resumable(resumableAnswering412('replay'), prefix), gen(1), [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
    ]);
    const source = new CrbmStorageChunkSource(resumable(storage, prefix));
    const bytes = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([1, 2, 3]);
  });

  it('stays a conflict when another writer holds the key', async () => {
    const prefix = `${RUN}/wid-other/${n++}`;
    await writeCrbmGeneration(resumable(storage, prefix), gen(1), [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
    ]);
    await expect(
      writeCrbmGeneration(resumable(resumableAnswering412('refuse'), prefix), gen(1), [
        { chunkKey: 0, bitmap: bm(9) },
      ]),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('stays a conflict when the object was written with no id', async () => {
    const prefix = `${RUN}/wid-noid/${n++}`;
    const name = storageObjectName(prefix, gen(1));
    await storage
      .bucket(BUCKET)
      .file(name)
      .save(Buffer.from([1]), { resumable: false });
    await expect(
      writeCrbmGeneration(resumable(resumableAnswering412('refuse'), prefix), gen(1), [
        { chunkKey: 0, bitmap: bm(9) },
      ]),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });
});

describe('GcsStorageDriver end-to-end through the engine (fake-gcs-server)', () => {
  // Proves the driver works behind a real `CloudRoaring` store — not just the low-level storage-source contract:
  // load two segments to GCS, then count + chunk-skipping intersect via the engine's public API.
  it('load → GCS → engine count / iterate / intersect (multi-chunk, chunk-skipping)', async () => {
    const driver = new GcsStorageDriver({ storage, bucket: BUCKET, prefix: `${RUN}/e2e/${n++}` });
    // Ids straddle two 16-bit chunks (0 and 3), so intersect must chunk-skip, not read everything.
    await bulkLoadCrbmGeneration(driver, { segment: 'a', generation: 1 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(driver, { segment: 'b', generation: 1 }, [2, 3, 4, 200_000]);

    const store = new CloudRoaring({ storage: new CrbmStorageChunkSource(driver) });
    expect(await store.segment('a').count()).toBe(4);

    const iterated: number[] = [];
    for await (const id of store.segment('a').iterate()) iterated.push(id);
    expect(iterated).toEqual([1, 2, 3, 200_000]);

    const got: number[] = [];
    for await (const id of store.segment('a').intersect([store.segment('b')])) got.push(id);
    expect(got).toEqual([2, 3, 200_000]);
  });
});

describe('GcsStorage (fake-gcs-server) — the backend builds its own client', () => {
  it('loads and reads through one object, with both halves in the same bucket and prefix', async () => {
    const backend = new GcsStorage({
      bucket: BUCKET,
      prefix: `${RUN}/backend/${n++}`,
      projectId: 'test',
      apiEndpoint: ENDPOINT,
    });
    const store = new CloudRoaring({ storage: backend });
    await bulkLoadCrbmGeneration(
      backend.storage,
      { segment: 'via-backend', generation: 0 },
      [7, 8],
      {
        registry: backend.registry,
      },
    );
    expect(await store.segment('via-backend').count()).toBe(2);
    expect(await backend.registry.get({ segment: 'via-backend' })).not.toBeNull();
  });

  // The size settings are options of the backend, and reach the storage half that writes the objects. A
  // threshold of 8 bytes puts every real generation on the resumable path; a ceiling of 16 bytes refuses one.
  it('takes simpleUploadThresholdBytes and loads a generation through the resumable path', async () => {
    const prefix = `${RUN}/backend-threshold/${n++}`;
    const backend = new GcsStorage({
      bucket: BUCKET,
      prefix,
      projectId: 'test',
      apiEndpoint: ENDPOINT,
      simpleUploadThresholdBytes: 8,
    });
    const store = new CloudRoaring({ storage: backend });
    const ids = Array.from({ length: 2000 }, (_, i) => i * 3);
    expect((await store.load({ segment: 'sized' }, ids)).published).toBe(true);
    expect(await store.segment('sized').count()).toBe(2000);
    expect(await store.segment('sized').has(5997)).toBe(true);
    // A resumable upload tags its object with a write id in custom metadata; a simple upload does not.
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix });
    const [meta] = await files[0]!.getMetadata();
    expect((meta.metadata as { cbwid?: string } | undefined)?.cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  // A timeout well above the emulator's answers leaves a healthy store alone: the load, then its reads of the
  // pointer, the generation's tail and its chunk ranges, all complete under it.
  it('takes readTimeoutMs, and a load and its reads complete under it', async () => {
    const backend = new GcsStorage({
      bucket: BUCKET,
      prefix: `${RUN}/backend-timeout/${n++}`,
      projectId: 'test',
      apiEndpoint: ENDPOINT,
      readTimeoutMs: 10_000,
    });
    const store = new CloudRoaring({ storage: backend });
    const ids = Array.from({ length: 2000 }, (_, i) => i * 3);
    expect((await store.load({ segment: 'timed' }, ids)).published).toBe(true);
    expect(await store.exists({ segment: 'timed' })).toBe(true);
    expect(await store.segment('timed').count()).toBe(2000);
    expect(await store.segment('timed').has(5997)).toBe(true);
    expect(await store.segment('timed').has(5998)).toBe(false);
  });

  it('takes maxObjectBytes, advertises it, and refuses a generation past it', async () => {
    const backend = new GcsStorage({
      bucket: BUCKET,
      prefix: `${RUN}/backend-ceiling/${n++}`,
      projectId: 'test',
      apiEndpoint: ENDPOINT,
      maxObjectBytes: 16,
    });
    expect(backend.storage.capabilities().maxObjectBytes).toBe(16);
    const store = new CloudRoaring({ storage: backend });
    await expect(store.load({ segment: 'sized' }, [1, 2, 3])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await store.exists({ segment: 'sized' })).toBe(false);
  });
});

describe('GCS (fake-gcs-server): a single-request upload the client is told was throttled', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });

  /** A client whose first upload of a generation object is applied by the emulator and then answered `status`. */
  function throttledAfterLanding(status: number): Storage {
    let fired = false;
    return new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== 'bucket') return Reflect.get(target, prop, receiver) as unknown;
        return (name: string) => {
          const bucket = target.bucket(name);
          return new Proxy(bucket, {
            get(b, p) {
              if (p !== 'file') {
                const v = Reflect.get(b, p) as unknown;
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(b) : v;
              }
              return (objectName: string) => {
                const file = b.file(objectName);
                return new Proxy(file, {
                  get(f, q) {
                    if (q !== 'createWriteStream' || fired || !objectName.includes('/segments/')) {
                      const v = Reflect.get(f, q) as unknown;
                      return typeof v === 'function'
                        ? (v as (...a: unknown[]) => unknown).bind(f)
                        : v;
                    }
                    fired = true;
                    return (options: Parameters<typeof f.createWriteStream>[0]) => {
                      const chunks: Buffer[] = [];
                      return new Writable({
                        write(chunk: Buffer, _enc, cb) {
                          chunks.push(chunk);
                          cb();
                        },
                        final(cb) {
                          const throttled = Object.assign(new Error('rateLimitExceeded'), {
                            code: status,
                            errors: [{ reason: 'rateLimitExceeded' }],
                          });
                          const real = f.createWriteStream(options);
                          real.once('error', cb);
                          real.once('finish', () => cb(throttled));
                          real.end(Buffer.concat(chunks));
                        },
                      });
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
  }

  it('stores the write id in the custom metadata of a single-request upload', async () => {
    const prefix = `${RUN}/simple-wid/${n++}`;
    const driver = new GcsStorageDriver({ storage, bucket: BUCKET, prefix });
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1, 2, 3) }]);
    const [meta] = await storage
      .bucket(BUCKET)
      .file(storageObjectName(prefix, gen(1)))
      .getMetadata();
    expect((meta.metadata as { cbwid?: string }).cbwid).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([429, 503])(
    'an upload the emulator applied and the client was told was %i is sent again, and is its own',
    async (status) => {
      const prefix = `${RUN}/simple-throttle/${n++}`;
      const driver = new GcsStorageDriver({
        storage: throttledAfterLanding(status),
        bucket: BUCKET,
        prefix,
        clock: { sleep: async () => {} },
      });
      await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(4, 5) }]);
      const source = new CrbmStorageChunkSource(
        new GcsStorageDriver({ storage, bucket: BUCKET, prefix }),
      );
      const bytes = await source.getChunk({ segment: 's', chunkKey: 0 });
      expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([4, 5]);
    },
  );
});

// A cold count is one request on the wire: the pointer row's GET, and no read of the object, however wide its index is.
// Counted by a forwarding proxy in front of fake-gcs-server, with a reader store that has read nothing.
describe('GCS (fake-gcs-server): a cold count is one request', () => {
  const storeOver = (apiEndpoint: string, prefix: string): CloudRoaring => {
    const client = new Storage({ projectId: 'test', apiEndpoint });
    return new CloudRoaring({
      storage: brandAsBackend({
        storage: new GcsStorageDriver({ storage: client, bucket: BUCKET, prefix }),
        registry: new GcsRegistryDriver({ storage: client, bucket: BUCKET, prefix }),
      }),
    });
  };

  it.each([
    ['a medium index', 200],
    ['an index wider than the 256 KiB tail read', 40_000],
  ])('%s: one GET of the row', async (_, chunks) => {
    const prefix = `${RUN}/cold-count/${n++}`;
    const ref = { namespace: 'ns', segment: 's' };
    await storeOver(ENDPOINT, prefix).load(
      ref,
      Array.from({ length: chunks }, (_, c) => c * 65_536),
    );
    const proxy = await forwardingProxy(ENDPOINT);
    try {
      const reader = storeOver(proxy.url, prefix);
      expect(await reader.segment('s', { namespace: 'ns' }).count()).toBe(chunks);
      expect(proxy.requests.map((r) => r.method)).toEqual(['GET']);
      expect(decodeURIComponent(proxy.requests[0]!.path)).toContain('registry');
      proxy.requests.length = 0;
      expect(await reader.segment('s', { namespace: 'ns' }).stat()).toMatchObject({
        generation: 0,
        cardinality: chunks,
      });
      // A stat after it reads the object for its size, and not the row, which the count just read: one tail read, and a
      // range read more for an index longer than the tail read.
      expect(proxy.requests.map((r) => r.method)).toEqual(
        chunks > 10_000 ? ['GET', 'GET'] : ['GET'],
      );
      expect(proxy.requests.filter((r) => decodeURIComponent(r.path).includes('registry'))).toEqual(
        [],
      );
    } finally {
      await proxy.close();
    }
  });
});

// A registry write made against a row the caller read is one request on the wire, conditioned on the object's
// generation, and fake-gcs-server refuses it once the row has moved on. Counted by a forwarding proxy.
describe('GCS (fake-gcs-server): a registry write made against a held row', () => {
  const registryOver = (apiEndpoint: string, prefix: string): GcsRegistryDriver =>
    new GcsRegistryDriver({
      storage: new Storage({ projectId: 'test', apiEndpoint }),
      bucket: BUCKET,
      prefix,
    });
  const ref = { namespace: 'ns', segment: 'held' };

  it('a compare-and-swap is one write under ifGenerationMatch and no read; a stale row is refused', async () => {
    const prefix = `${RUN}/held-row/${n++}`;
    const direct = registryOver(ENDPOINT, prefix);
    const proxy = await forwardingProxy(ENDPOINT);
    try {
      const viaProxy = registryOver(proxy.url, prefix);
      await direct.create(ref, { currentGen: 0 });
      const held = (await viaProxy.get(ref))!;
      proxy.requests.length = 0;
      await viaProxy.compareAndSwap(ref, held.token, { currentGen: 1 }, { held });
      expect(proxy.requests.map((r) => r.method)).toEqual(['POST']);
      expect(proxy.requests[0]!.path).toMatch(/ifGenerationMatch=\d+/);

      const stale = (await viaProxy.get(ref))!;
      await direct.compareAndSwap(ref, stale.token, { currentGen: 2 });
      proxy.requests.length = 0;
      await expect(
        viaProxy.compareAndSwap(ref, stale.token, { currentGen: 9 }, { held: stale }),
      ).rejects.toBeInstanceOf(WriteConflictError);
      // The write reached fake-gcs-server, which refused it: nothing was read to decide it.
      expect(proxy.requests.map((r) => r.method)).toEqual(['POST']);
      expect((await direct.get(ref))?.currentGen).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  it('a create with no row held is one write under ifGenerationMatch=0 and no read', async () => {
    const prefix = `${RUN}/held-row/${n++}`;
    const proxy = await forwardingProxy(ENDPOINT);
    try {
      const viaProxy = registryOver(proxy.url, prefix);
      await viaProxy.create(ref, { currentGen: 0 }, { held: null });
      expect(proxy.requests.map((r) => r.method)).toEqual(['POST']);
      expect(proxy.requests[0]!.path).toMatch(/ifGenerationMatch=0/);
    } finally {
      await proxy.close();
    }
  });
});

describe('a bucket that does not exist', () => {
  it("fails every read and a delete with the service's own error, not as an absent object", async () => {
    await expectMissingLocationFails(
      () =>
        new GcsStorage({
          bucket: MISSING,
          apiEndpoint: ENDPOINT,
          projectId: 'test',
          prefix: `${RUN}/missing`,
        }),
    );
  });

  it('control: in the bucket that exists, a missing object still reads as absent', async () => {
    await expectMissingObjectIsAbsent(
      () =>
        new GcsStorage({
          bucket: BUCKET,
          apiEndpoint: ENDPOINT,
          projectId: 'test',
          prefix: `${RUN}/missing`,
        }),
    );
  });
});
