// Runs against Azurite from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real Azure needed. The well-known dev connection string points at the emulator
// and skips auth; the driver takes a `ContainerClient` scoped to an already-created container.
import { BlobServiceClient } from '@azure/storage-blob';
import { coldChunkSourceConformance } from '@/testing/conformance';
import { AzureBlobColdDriver } from '@/drivers/azure/cold';
import { isConditionalConflict } from '@/drivers/azure/azure-errors';
import { CrbmColdChunkSource, writeCrbmGeneration } from '@/core/crbm-cold-source';
// bulk-load is codec-bound: import the public (flavor) entry point, exactly as an application would.
import { bulkLoadCrbmGeneration } from '@/index';
import { CloudRoaring, MemoryWarmDriver } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { NotFoundError, ValidationError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

const BLOB_ENDPOINT =
  process.env.AZURITE_BLOB_ENDPOINT ?? 'http://127.0.0.1:10000/devstoreaccount1';
// Azurite's fixed, publicly-documented dev account + key (not a secret — the same value ships in every SDK).
const CONN =
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;` +
  `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;` +
  `BlobEndpoint=${BLOB_ENDPOINT};`;
const CONTAINER = 'cloud-roaring-it';

const service = BlobServiceClient.fromConnectionString(CONN);
const container = service.getContainerClient(CONTAINER);

beforeAll(async () => {
  // `docker compose up --wait` returns when the container is *running*, not necessarily accepting HTTP — poll
  // until the emulator answers so a cold-start ECONNREFUSED can't red the suite (deterministic readiness).
  for (let attempt = 0; ; attempt++) {
    try {
      await container.createIfNotExists();
      break;
    } catch (err) {
      if (attempt >= 30) throw err; // ~15s
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}, 30_000);

let n = 0;
const freshDriver = (): AzureBlobColdDriver =>
  new AzureBlobColdDriver({ containerClient: container, prefix: `conf/${n++}` });

// The Azure driver must pass the SAME cold-source contract as in-memory + LocalFs + S3 + GCS (finding V8).
coldChunkSourceConformance('AzureBlobColdDriver (Azurite)', async (chunks) => {
  const driver = freshDriver();
  await writeCrbmGeneration(driver, { segment: 's', generation: 1 }, chunks);
  return new CrbmColdChunkSource(driver);
});

describe('AzureBlobColdDriver specifics (Azurite)', () => {
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

  it('is write-once on the STAGED path too (object forced past one block)', async () => {
    // A tiny blockBytes forces the staged `commitBlockList` path; write-once must hold there as well.
    const staged = (): AzureBlobColdDriver =>
      new AzureBlobColdDriver({
        containerClient: container,
        prefix: `staged/${n++}`,
        blockBytes: 8,
        maxObjectBytes: 1 << 20,
      });
    const driver = staged();
    const many = Array.from({ length: 400 }, (_, i) => i);
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(...many) }]);
    await expect(
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    const cold = new CrbmColdChunkSource(driver);
    const bytes = await cold.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual(many);
  });

  it('two CONCURRENT staged writers to one key: exactly one wins, its bytes commit intact (block-id isolation)', async () => {
    // Regression for the block-id collision: block ids must be unique per writer, else two racing staged
    // uploads to the same blob name overwrite each other's pooled uncommitted blocks and the winning commit
    // could reference an INTERLEAVED mix of both payloads (corrupt blob, wrong-vs-returned-hash). With the
    // per-sink nonce, each writer stages a disjoint id space → the winner commits only its own blocks.
    const staged = (): AzureBlobColdDriver =>
      new AzureBlobColdDriver({
        containerClient: container,
        prefix: `race/${n++}`,
        blockBytes: 8, // tiny → many blocks → heavy interleaving, forcing the staged path
        maxObjectBytes: 1 << 20,
      });
    const driver = staged();
    const aVals = Array.from({ length: 300 }, (_, i) => i);
    const bVals = Array.from({ length: 300 }, (_, i) => 1000 + i); // disjoint → tells the winners apart
    const results = await Promise.allSettled([
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(...aVals) }]),
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(...bVals) }]),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // write-once: exactly one commit succeeds
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WriteConflictError);
    // The committed blob is ONE writer's payload intact — never an interleaved mix of both.
    const cold = new CrbmColdChunkSource(driver);
    const bytes = await cold.getChunk({ segment: 's', chunkKey: 0 });
    const got = JSON.stringify(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray());
    expect([JSON.stringify(aVals), JSON.stringify(bVals)]).toContain(got);
  });

  it('Azurite returns 409 BlobAlreadyExists on a lost ifNoneMatch:"*" race (classifier ground truth)', async () => {
    // Grounds the load-bearing "Azure uses 409, not 412" claim against the real emulator (not just an author-
    // supplied error shape), and cross-checks the classifier the driver relies on.
    const blob = container.getBlockBlobClient(`raw-409/${n++}.bin`);
    await blob.upload(Buffer.from([1, 2, 3]), 3, { conditions: { ifNoneMatch: '*' } });
    const err = await blob
      .upload(Buffer.from([9]), 1, { conditions: { ifNoneMatch: '*' } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect(isConditionalConflict(err)).toBe(true);
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
    // Start fully past EOF (Azure 416) maps to ValidationError too.
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

describe('AzureBlobColdDriver end-to-end through the engine (Azurite)', () => {
  // Proves the driver works behind a real `CloudRoaring` store — not just the low-level cold-source contract:
  // bulk-load two segments to Azure Blob, then count + chunk-skipping intersect via the engine's public API.
  it('bulk-load → Azure Blob → engine count / iterate / intersect (multi-chunk, chunk-skipping)', async () => {
    const driver = new AzureBlobColdDriver({ containerClient: container, prefix: `e2e/${n++}` });
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
