import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
// Runs against fake-gcs-server from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real GCP needed. Passing `apiEndpoint` (with any `projectId`) targets the
// emulator and skips auth — do NOT also set `STORAGE_EMULATOR_HOST` (empirically it makes the JSON-API calls
// 404 against fake-gcs-server; apiEndpoint alone is the working config).
import { Storage } from '@google-cloud/storage';
import {
  storageChunkSourceConformance,
  registryConformance,
  registryConcurrency,
  CONFORMANCE_SEGMENT,
} from '@/testing/conformance';
import { GcsStorageDriver } from '@/gcs/storage';
import { GcsRegistryDriver } from '@/gcs/registry';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { CrbmStorageChunkSource, writeCrbmGeneration } from '@/core/crbm-storage-source';
import { CloudRoaring } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
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
registryConformance(
  'GcsRegistryDriver (fake-gcs-server)',
  () =>
    new GcsRegistryDriver({
      storage,
      bucket: BUCKET,
      prefix: `${RUN}/reg-conf/${rn++}`,
      now: ticking(),
    }),
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
});
