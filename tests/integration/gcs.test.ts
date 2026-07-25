// Runs against fake-gcs-server from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real GCP needed. Passing `apiEndpoint` (with any `projectId`) targets the
// emulator and skips auth — do NOT also set `STORAGE_EMULATOR_HOST` (empirically it makes the JSON-API calls
// 404 against fake-gcs-server; apiEndpoint alone is the working config).
import { Storage } from '@google-cloud/storage';
import { coldChunkSourceConformance } from '@/testing/conformance';
import { GcsColdDriver } from '@/drivers/gcs/cold';
import { CrbmColdChunkSource, writeCrbmGeneration } from '@/core/crbm-cold-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { bulkLoadCrbmGeneration } from '@/index';
import { CloudRoaring, MemoryWarmDriver } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

const ENDPOINT = process.env.GCS_ENDPOINT ?? 'http://127.0.0.1:4443';
const BUCKET = 'cloud-roaring-it';
const storage = new Storage({ projectId: 'test', apiEndpoint: ENDPOINT });

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

let n = 0;
const freshDriver = (): GcsColdDriver =>
  new GcsColdDriver({ storage, bucket: BUCKET, prefix: `conf/${n++}` });

// The GCS driver must pass the SAME cold-source contract as in-memory + LocalFs + S3 (finding V8).
coldChunkSourceConformance('GcsColdDriver (fake-gcs-server)', async (chunks) => {
  const driver = freshDriver();
  await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, chunks);
  return new CrbmColdChunkSource(driver);
});

describe('GcsColdDriver specifics (fake-gcs-server)', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });

  it('is write-once: a second put to the same key is a WriteConflictError', async () => {
    const driver = freshDriver();
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1, 2, 3) }]);
    await expect(
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(9) }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    // The original is intact.
    const cold = new CrbmColdChunkSource(driver);
    const bytes = await cold.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual([1, 2, 3]);
  });

  // The write-once test above stays under the 8 MiB threshold, so it exercises only the SIMPLE upload path.
  // Force the RESUMABLE (large-object, constant-memory) path with a tiny threshold and prove it round-trips
  // end-to-end against a real emulator — catching a broken resumable stream / backpressure / finalize / read
  // path the simple path can't. This is the compaction write path (readiness audit cold-F2), previously
  // exercised only against an in-process mock.
  //
  // NOTE ON WRITE-ONCE ENFORCEMENT: this test does NOT assert the second write conflicts, because
  // fake-gcs-server does not honor `ifGenerationMatch: 0` on the resumable-upload *finalize* (empirically it
  // overwrites — unlike its simple-upload path, and unlike real GCS). Resumable write-once enforcement is
  // instead covered by (a) the driver-level mock test asserting the driver sends `resumable:true` +
  // `ifGenerationMatch:0` and maps a 412-on-commit to WriteConflictError (tests/drivers/gcs/cold.test.ts), and
  // (b) real GCS, which enforces the precondition. Asserting it here would test the emulator's gap, not ours.
  it('round-trips a generation written via the RESUMABLE (large-object) upload path', async () => {
    const driver = new GcsColdDriver({
      storage,
      bucket: BUCKET,
      prefix: `resumable/${n++}`,
      simpleUploadThresholdBytes: 8, // any real .crbm object exceeds this → resumable stream
    });
    await writeCrbmGeneration(driver, gen(1), [
      { chunkKey: 0, bitmap: bm(1, 2, 3) },
      { chunkKey: 7, bitmap: bm(500, 70_000) },
    ]);
    const cold = new CrbmColdChunkSource(driver);
    const c0 = await cold.getChunk({ segment: 's', chunkKey: 0 });
    const c7 = await cold.getChunk({ segment: 's', chunkKey: 7 });
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

describe('GcsColdDriver end-to-end through the engine (fake-gcs-server)', () => {
  // Proves the driver works behind a real `CloudRoaring` store — not just the low-level cold-source contract:
  // bulk-load two segments to GCS, then count + chunk-skipping intersect via the engine's public API.
  it('bulk-load → GCS → engine count / iterate / intersect (multi-chunk, chunk-skipping)', async () => {
    const driver = new GcsColdDriver({ storage, bucket: BUCKET, prefix: `e2e/${n++}` });
    // Ids straddle two 16-bit chunks (0 and 3), so intersect must chunk-skip, not read everything.
    await bulkLoadCrbmGeneration(driver, { segment: 'a', generation: 1 }, [1, 2, 3, 200_000]);
    await bulkLoadCrbmGeneration(driver, { segment: 'b', generation: 1 }, [2, 3, 4, 200_000]);

    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(driver),
    });
    expect(await store.segment('a').count()).toBe(4);

    const iterated: number[] = [];
    for await (const id of store.segment('a').iterate()) iterated.push(id);
    expect(iterated).toEqual([1, 2, 3, 200_000]);

    const got: number[] = [];
    for await (const id of store.segment('a').intersect([store.segment('b')])) got.push(id);
    expect(got).toEqual([2, 3, 200_000]);
  });
});
