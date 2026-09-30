import { randomUUID } from 'node:crypto';
// Runs against Azurite from docker-compose (see docker-compose.yml): `docker compose up -d` then
// `pnpm test:integration`. No real Azure needed. The well-known dev connection string points at the emulator
// and skips auth; the driver takes a `ContainerClient` scoped to an already-created container.
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import {
  storageChunkSourceConformance,
  storageDriverConformance,
  registryConformance,
  registryConcurrency,
  CONFORMANCE_SEGMENT,
} from '@/testing/conformance';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { isConditionalConflict } from '@/azure-blob/azure-errors';
import { storageObjectName } from '@/azure-blob/keys';
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

const BLOB_ENDPOINT =
  process.env.AZURITE_BLOB_ENDPOINT ?? 'http://127.0.0.1:10000/devstoreaccount1';
// Azurite's fixed, publicly-documented dev account + key (not a secret — the same value ships in every SDK).
const CONN =
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;` +
  `AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;` +
  `BlobEndpoint=${BLOB_ENDPOINT};`;
const CONTAINER = 'cloudbitmaps-it';

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

// The Azure registry must pass the SAME registry contract as memory / LocalFs / S3 — against real blob
// conditions (`ifNoneMatch: '*'` for create-only, `ifMatch: <etag>` for CAS) via Azurite. This is what makes
// an Azure-only topology viable: the pointer to the current generation lives in the same container as the
// objects, so an Azure user needs no second service, and no second cloud account, to store it.
let rn = 0;
const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};
registryConformance(
  'AzureBlobRegistryDriver (Azurite)',
  () =>
    new AzureBlobRegistryDriver({
      containerClient: container,
      prefix: `${RUN}/reg-conf/${rn++}`,
      now: ticking(),
    }),
);

// The cross-process half of the contract: two drivers over one container, racing the same row. Azurite
// enforces `If-None-Match: *` / `If-Match` for real, so these prove the fence rather than the in-process
// token check that answers every sequential case above.
registryConcurrency('AzureBlobRegistryDriver (Azurite)', () => {
  const prefix = `${RUN}/reg-race/${rn++}`;
  return [
    new AzureBlobRegistryDriver({ containerClient: container, prefix, now: ticking() }),
    new AzureBlobRegistryDriver({ containerClient: container, prefix, now: ticking() }),
  ];
});

let n = 0;
const freshDriver = (): AzureBlobStorageDriver =>
  new AzureBlobStorageDriver({ containerClient: container, prefix: `${RUN}/conf/${n++}` });

// The Azure driver must pass the SAME storage-source contract as in-memory + LocalFs + S3 + GCS.
// The same IStorageDriver contract memory and LocalFs pass: write-once, typed errors, true tail size, idempotent
// delete, read-after-delete listing.
storageDriverConformance('AzureBlobStorageDriver (Azurite)', freshDriver);
// The same cases with 64-byte blocks, so every object is staged blocks and a conditional commit.
storageDriverConformance(
  'AzureBlobStorageDriver, blocks (Azurite)',
  () =>
    new AzureBlobStorageDriver({
      containerClient: container,
      prefix: `${RUN}/conf-blocks/${n++}`,
      blockBytes: 64,
    }),
  { largeBytes: 4096 },
);

storageChunkSourceConformance('AzureBlobStorageDriver (Azurite)', async (chunks) => {
  const driver = freshDriver();
  await writeCrbmGeneration(driver, { segment: CONFORMANCE_SEGMENT, generation: 1 }, chunks);
  return new CrbmStorageChunkSource(driver);
});

describe('AzureBlobStorageDriver specifics (Azurite)', () => {
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

  it('is write-once on the STAGED path too (object forced past one block)', async () => {
    // A tiny blockBytes forces the staged `commitBlockList` path; write-once must hold there as well.
    const staged = (): AzureBlobStorageDriver =>
      new AzureBlobStorageDriver({
        containerClient: container,
        prefix: `${RUN}/staged/${n++}`,
        blockBytes: 8,
        maxObjectBytes: 1 << 20,
      });
    const driver = staged();
    const many = Array.from({ length: 400 }, (_, i) => i);
    await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(...many) }]);
    await expect(
      writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(1) }]),
    ).rejects.toBeInstanceOf(WriteConflictError);
    const storage = new CrbmStorageChunkSource(driver);
    const bytes = await storage.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toEqual(many);
  });

  it('two CONCURRENT staged writers to one key: exactly one wins, its bytes commit intact (block-id isolation)', async () => {
    // The block-id collision: block ids must be unique per writer, else two racing staged uploads to the
    // same blob name overwrite each other's pooled uncommitted blocks and the winning commit can reference an
    // INTERLEAVED mix of both payloads (corrupt blob, wrong-vs-returned-hash). With the per-sink nonce, each
    // writer stages a disjoint id space → the winner commits only its own blocks.
    const staged = (): AzureBlobStorageDriver =>
      new AzureBlobStorageDriver({
        containerClient: container,
        prefix: `${RUN}/race/${n++}`,
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
    const storage = new CrbmStorageChunkSource(driver);
    const bytes = await storage.getChunk({ segment: 's', chunkKey: 0 });
    const got = JSON.stringify(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray());
    expect([JSON.stringify(aVals), JSON.stringify(bVals)]).toContain(got);
  });

  it('Azurite returns 409 BlobAlreadyExists on a lost ifNoneMatch:"*" race (classifier ground truth)', async () => {
    // Grounds the load-bearing "Azure uses 409, not 412" claim against the real emulator (not just an author-
    // supplied error shape), and cross-checks the classifier the driver relies on.
    const blob = container.getBlockBlobClient(`${RUN}/raw-409/${n++}.bin`);
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

describe('AzureBlobStorageDriver end-to-end through the engine (Azurite)', () => {
  // Proves the driver works behind a real `CloudRoaring` store — not just the low-level storage-source contract:
  // load two segments to Azure Blob, then count + chunk-skipping intersect via the engine's public API.
  it('load → Azure Blob → engine count / iterate / intersect (multi-chunk, chunk-skipping)', async () => {
    const driver = new AzureBlobStorageDriver({
      containerClient: container,
      prefix: `${RUN}/e2e/${n++}`,
    });
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

describe('AzureBlobStorage (Azurite) — the backend builds its own container client', () => {
  it('loads and reads through one object, with both halves in the same container and prefix', async () => {
    const backend = new AzureBlobStorage({
      connectionString: CONN,
      container: CONTAINER,
      prefix: `${RUN}/backend/${n++}`,
    });
    const store = new CloudRoaring({ storage: backend });
    await bulkLoadCrbmGeneration(
      backend.storage,
      { segment: 'via-backend', generation: 0 },
      [3, 4],
      {
        registry: backend.registry,
      },
    );
    expect(await store.segment('via-backend').count()).toBe(2);
    expect(await backend.registry.get({ segment: 'via-backend' })).not.toBeNull();
  });

  // The size settings are options of the backend, and reach the storage half that writes the blobs. A block of
  // 8 bytes puts every real generation on the staged path; a ceiling of 16 bytes refuses one.
  it('takes blockBytes and maxObjectBytes and loads a generation through the staged path', async () => {
    const backend = new AzureBlobStorage({
      connectionString: CONN,
      container: CONTAINER,
      prefix: `${RUN}/backend-blocks/${n++}`,
      blockBytes: 8,
      maxObjectBytes: 1 << 20,
    });
    expect(backend.storage.capabilities().maxObjectBytes).toBe(1 << 20);
    const store = new CloudRoaring({ storage: backend });
    const ids = Array.from({ length: 2000 }, (_, i) => i * 3);
    expect((await store.load({ segment: 'sized' }, ids)).published).toBe(true);
    expect(await store.segment('sized').count()).toBe(2000);
    expect(await store.segment('sized').has(5997)).toBe(true);
  });

  it('refuses a generation past maxObjectBytes, and a setting that is not a positive integer', async () => {
    const options = { connectionString: CONN, container: CONTAINER };
    const backend = new AzureBlobStorage({
      ...options,
      prefix: `${RUN}/backend-ceiling/${n++}`,
      maxObjectBytes: 16,
    });
    const store = new CloudRoaring({ storage: backend });
    await expect(store.load({ segment: 'sized' }, [1, 2, 3])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await store.exists({ segment: 'sized' })).toBe(false);
    expect(() => new AzureBlobStorage({ ...options, blockBytes: 0 })).toThrow(ValidationError);
  });
});

// A conditional write that lands and loses its response is sent again by the client's retry policy, meets its own
// blob, and is answered 409 or 412. The proxy below reproduces that against Azurite: it sends the write, which lands,
// then sends the same request again and throws what Azurite answers to the replay. Each write tags its blob with an id
// in metadata, so the driver reads the blob back on that conflict and reports success for its own write.
function replayingContainer(): ContainerClient {
  const replay =
    <A extends unknown[]>(send: (...args: A) => Promise<unknown>) =>
    async (...args: A): Promise<unknown> => {
      await send(...args);
      return send(...args);
    };
  return new Proxy(container, {
    get(target, prop, receiver) {
      if (prop !== 'getBlockBlobClient') return Reflect.get(target, prop, receiver) as unknown;
      return (name: string) => {
        const blob = target.getBlockBlobClient(name);
        return new Proxy(blob, {
          get(b, p) {
            if (p === 'upload') return replay(b.upload.bind(b));
            if (p === 'commitBlockList') return replay(b.commitBlockList.bind(b));
            const v = Reflect.get(b, p) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(b) : v;
          },
        });
      };
    },
  });
}

describe('Azure conflict against the write own id (Azurite)', () => {
  const bm = (...v: number[]): SafeBitmap => SafeBitmap.fromValues(v);
  const gen = (generation: number): GenKey => ({ segment: 's', generation });
  const many = bm(...Array.from({ length: 400 }, (_, i) => i));
  const uniq = (label: string): string => `${RUN}/${label}/${n++}`;

  describe.each([
    ['upload (one block)', undefined],
    ['staged commit (several blocks)', 8],
  ])('a generation on the %s path', (_label, blockBytes) => {
    const opts = (containerClient: ContainerClient, prefix: string) => ({
      containerClient,
      prefix,
      ...(blockBytes === undefined ? {} : { blockBytes, maxObjectBytes: 1 << 20 }),
    });

    it('is a success when the conflict is the write meeting its own blob', async () => {
      const prefix = uniq('own');
      const driver = new AzureBlobStorageDriver(opts(replayingContainer(), prefix));
      await writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: many }]);
      // it landed, intact
      const source = new CrbmStorageChunkSource(
        new AzureBlobStorageDriver(opts(container, prefix)),
      );
      const bytes = await source.getChunk({ segment: 's', chunkKey: 0 });
      expect(SafeBitmap.safeDeserialize(bytes!, 1 << 20).toArray()).toHaveLength(400);
    });

    it('stays a conflict when another writer holds the key', async () => {
      const prefix = uniq('other');
      await writeCrbmGeneration(new AzureBlobStorageDriver(opts(container, prefix)), gen(1), [
        { chunkKey: 0, bitmap: bm(1, 2, 3) },
      ]);
      // A second writer, through the replaying client: the blob is not its own, so its replay is not a success.
      await expect(
        writeCrbmGeneration(
          new AzureBlobStorageDriver(opts(replayingContainer(), prefix)),
          gen(1),
          [{ chunkKey: 0, bitmap: many }],
        ),
      ).rejects.toBeInstanceOf(WriteConflictError);
    });

    it('stays a conflict when the blob was written with no id', async () => {
      const prefix = uniq('noid');
      const driver = new AzureBlobStorageDriver(opts(container, prefix));
      const name = storageObjectName(prefix, gen(1));
      await container
        .getBlockBlobClient(name)
        .upload(new Uint8Array([1]), 1, { conditions: { ifNoneMatch: '*' } });
      await expect(
        writeCrbmGeneration(driver, gen(1), [{ chunkKey: 0, bitmap: bm(9) }]),
      ).rejects.toBeInstanceOf(WriteConflictError);
    });
  });

  it('a registry create, swap and tombstone that meet their own row are successes', async () => {
    const prefix = uniq('reg-own');
    const reg = new AzureBlobRegistryDriver({
      containerClient: replayingContainer(),
      prefix,
      now: ticking(),
    });
    const ref = { segment: 'r' };
    const { token } = await reg.create(ref, { currentGen: 0 });
    const swapped = await reg.compareAndSwap(ref, token, { currentGen: 1 });
    expect(swapped.token).not.toBe(token);
    expect((await reg.get(ref))?.currentGen).toBe(1);
    await reg.delete(ref);
    expect(await reg.get(ref)).toBeNull();
  });

  it('a registry swap that lost to another writer stays a conflict', async () => {
    const prefix = uniq('reg-lost');
    const a = new AzureBlobRegistryDriver({ containerClient: container, prefix, now: ticking() });
    const b = new AzureBlobRegistryDriver({ containerClient: container, prefix, now: ticking() });
    const ref = { segment: 'r' };
    const { token } = await a.create(ref, { currentGen: 0 });
    await b.compareAndSwap(ref, token, { currentGen: 1 });
    await expect(a.compareAndSwap(ref, token, { currentGen: 2 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect((await a.get(ref))?.currentGen).toBe(1);
  });
});
