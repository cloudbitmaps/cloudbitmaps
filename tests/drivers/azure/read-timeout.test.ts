import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AzureBlobStorage } from '@/azure-blob/backend';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { storageObjectName } from '@/azure-blob/keys';
import { writeCrbmGeneration } from '@/core/crbm-storage-source';
import { IntegrityError, NotFoundError, TransientError, ValidationError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { CloudRoaring } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { resolveReadTimeoutMs } from '@/azure-blob/read-timeout';
import { StubBlobService, watchProcess, type Plan } from '../../helpers/azure-blob-stub';

/**
 * The Azure Blob read timeout, through a real `@azure/storage-blob` client against a stub of the Blob service.
 *
 * Each read request the drivers send, a range read, a tail read's properties and its ranged download, and the
 * registry's one GET, is cut off after `readTimeoutMs` when it is set, the body included, and throws `TransientError`
 * for the store's read retry. The stub stalls a request before its headers, after them, or part-way through its body;
 * each timed-out read is held to the time it took, to the stub seeing its connection closed, and to no process event
 * escaping, since a body stream aborted with nothing listening throws out of the event. Writes, deletes and listings
 * are not timed, and the timeout is off unless set.
 */

const TIMEOUT = 200;
const GEN: GenKey = { segment: 's', generation: 1 };
const REF = { segment: 's' };
const DATA = storageObjectName(undefined, GEN);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let stub: StubBlobService;
/** The seeded generation's size, so a tail read's range is known. */
let size = 0;

beforeEach(async () => {
  stub = new StubBlobService();
  await stub.start();
  const seeding = new AzureBlobStorage({ containerClient: stub.client() });
  size = (
    await writeCrbmGeneration(seeding.storage, GEN, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
    ])
  ).size;
  await seeding.registry.create(REF, { currentGen: GEN.generation });
  stub.requests.length = 0;
});
afterEach(async () => {
  await stub.stop();
});

const storage = (readTimeoutMs?: number): AzureBlobStorageDriver =>
  new AzureBlobStorageDriver({
    containerClient: stub.client(),
    ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
  });
const registry = (readTimeoutMs?: number): AzureBlobRegistryDriver =>
  new AzureBlobRegistryDriver({
    containerClient: stub.client(),
    ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
  });
/** Both halves through the backend, the way a caller builds them; the key is passed even when its value is undefined. */
const backendWith = (readTimeoutMs: number | undefined): AzureBlobStorage =>
  new AzureBlobStorage({ containerClient: stub.client(), readTimeoutMs });
const isRegistryKey = (name: string): boolean => name.includes('registry/');

/**
 * `read` rejects with the timeout's `TransientError`, naming `operation`, at about `TIMEOUT`; the stalled request's
 * connection is closed; and nothing escapes to the process.
 */
async function timesOut(
  read: () => Promise<unknown>,
  operation: 'download' | 'getProperties',
): Promise<void> {
  const watch = watchProcess();
  try {
    const t0 = performance.now();
    const err = await read().then(
      () => undefined,
      (e: unknown) => e,
    );
    const ms = performance.now() - t0;
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toBe(`Azure Blob ${operation} timed out after ${TIMEOUT} ms`);
    expect(ms).toBeGreaterThanOrEqual(TIMEOUT - 25);
    expect(ms).toBeLessThan(TIMEOUT + 1_500);
    expect(await stub.releasedStalls()).toBe(true);
    await sleep(50);
  } finally {
    watch.stop();
  }
  expect(watch.events).toEqual([]);
}

const PHASES = ['before-headers', 'after-headers', 'mid-body'] as const;

describe('Azure Blob: a read that stalls is cut off after readTimeoutMs', () => {
  it.each(PHASES)('a range read stalled %s', async (stall) => {
    stub.plan = (r) => (r.method === 'GET' && r.name === DATA ? { stall } : undefined);
    await timesOut(() => storage(TIMEOUT).getRange(GEN, 0, 4), 'download');
  });

  it("a tail read stalled on its properties, before the headers (a HEAD's headers are the whole answer)", async () => {
    stub.plan = (r) => (r.method === 'HEAD' ? { stall: 'before-headers' } : undefined);
    await timesOut(() => storage(TIMEOUT).getTail(GEN, 16), 'getProperties');
  });

  it.each(PHASES)("a tail read's ranged download stalled %s", async (stall) => {
    stub.plan = (r) => (r.method === 'GET' && r.name === DATA ? { stall } : undefined);
    await timesOut(() => storage(TIMEOUT).getTail(GEN, 16), 'download');
  });

  it.each(PHASES)('a registry read stalled %s', async (stall) => {
    stub.plan = (r) => (r.method === 'GET' && isRegistryKey(r.name) ? { stall } : undefined);
    await timesOut(() => registry(TIMEOUT).get(REF), 'download');
  });

  it('times each request on its own: a tail read whose two requests each take most of the timeout finishes', async () => {
    const held = Math.round(TIMEOUT * 0.6);
    stub.plan = (r) => (r.name === DATA ? { delayMs: held } : undefined);
    const tail = await backendWith(TIMEOUT).storage.getTail(GEN, 16);
    expect(tail.size).toBe(size);
    expect(stub.requests.map((r) => r.method)).toEqual(['HEAD', 'GET']);
  });

  it('AzureBlobStorage gives the timeout to both halves', async () => {
    const backend = new AzureBlobStorage({
      containerClient: stub.client(),
      readTimeoutMs: TIMEOUT,
    });
    stub.plan = (r) => (r.method === 'GET' ? { stall: 'mid-body' } : undefined);
    await timesOut(() => backend.storage.getRange(GEN, 0, 4), 'download');
    await timesOut(() => backend.registry.get(REF), 'download');
  });

  it('so does an AzureBlobStorage built from a connection string and a container', async () => {
    // Azurite's fixed, publicly documented dev account key, pointed at the stub, which checks no signature.
    const connectionString =
      'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
      'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
      `BlobEndpoint=${stub.url.replace(/\/c$/, '')};`;
    const backend = new AzureBlobStorage({
      connectionString,
      container: 'c',
      readTimeoutMs: TIMEOUT,
    });
    stub.plan = (r) => (r.method === 'GET' ? { stall: 'mid-body' } : undefined);
    await timesOut(() => backend.storage.getRange(GEN, 0, 4), 'download');
    await timesOut(() => backend.registry.get(REF), 'download');
  });
});

describe('Azure Blob: what the read timeout leaves alone', () => {
  it('fast reads return as before, well inside the timeout', async () => {
    const backend = backendWith(TIMEOUT);
    // No bound on how long they take: a read the timeout cut off would be a TransientError here, so each one returning
    // is the proof, and an elapsed-time bound would only measure the machine.
    expect(await backend.storage.getRange(GEN, 0, 4)).toHaveLength(4);
    const tail = await backend.storage.getTail(GEN, 16);
    expect(tail).toMatchObject({ size });
    expect(tail.bytes).toHaveLength(Math.min(16, size));
    expect((await backend.registry.get(REF))?.currentGen).toBe(GEN.generation);
  });

  it('a read longer than nothing but shorter than the timeout finishes', async () => {
    stub.plan = (r) => (r.method !== 'PUT' ? { delayMs: 100 } : undefined);
    const backend = backendWith(2_000);
    expect(await backend.storage.getRange(GEN, 0, 4)).toHaveLength(4);
    expect((await backend.registry.get(REF))?.currentGen).toBe(GEN.generation);
  });

  it('0 turns it off: a read held past what any timeout here would allow finishes', async () => {
    stub.plan = (r) => (r.method !== 'PUT' ? { delayMs: TIMEOUT + 300 } : undefined);
    const backend = backendWith(0);
    expect(await backend.storage.getRange(GEN, 0, 4)).toHaveLength(4);
    expect((await backend.storage.getTail(GEN, 16)).size).toBe(size);
    expect((await backend.registry.get(REF))?.currentGen).toBe(GEN.generation);
    expect((await storage(0).getTail(GEN, 16)).size).toBe(size);
    expect((await registry(0).get(REF))?.currentGen).toBe(GEN.generation);
  });

  it('it is off by default: a read held for over two seconds finishes, through each half and the backend', async () => {
    // Each read holds one request: the range read's GET, the tail read's HEAD, the registry read's GET.
    stub.plan = (r): Plan | undefined =>
      r.method === 'HEAD' ||
      (r.method === 'GET' && (r.range === 'bytes=0-3' || isRegistryKey(r.name)))
        ? { delayMs: 2_100 }
        : undefined;
    const backend = backendWith(undefined);
    const results = await Promise.all([
      storage().getRange(GEN, 0, 4),
      storage().getTail(GEN, 16),
      registry().get(REF),
      backend.storage.getRange(GEN, 0, 4),
      backend.registry.get(REF),
    ]);
    expect(results[0]).toHaveLength(4);
    expect((results[1] as { size: number }).size).toBe(size);
    expect(results[2]).toMatchObject({ currentGen: GEN.generation });
    expect(results[3]).toHaveLength(4);
    expect(results[4]).toMatchObject({ currentGen: GEN.generation });
  }, 15_000);

  it('writes, deletes and listings slower than the timeout succeed', async () => {
    const slow = TIMEOUT + 300;
    stub.plan = (r) =>
      r.method === 'PUT' || r.method === 'DELETE' || r.list ? { delayMs: slow } : undefined;
    const backend = backendWith(TIMEOUT);
    const s = backend.storage;
    const g: GenKey = { segment: 's', generation: 2 };
    await writeCrbmGeneration(s, g, [{ chunkKey: 0, bitmap: SafeBitmap.fromValues([7]) }]);
    const listed: number[] = [];
    for await (const k of s.list(REF)) listed.push(k.generation);
    expect(listed.sort()).toEqual([1, 2]);
    await s.delete(g);
    expect(stub.blobs.has(storageObjectName(undefined, g))).toBe(false);

    const r = backend.registry;
    const other = { segment: 'other' };
    const { token } = await r.create(other, { currentGen: 0 });
    const swapped = await r.compareAndSwap(other, token, { currentGen: 1 });
    expect(swapped.token).not.toBe(token);
    const rows: string[] = [];
    for await (const row of r.list()) rows.push(row.segment);
    expect(rows.sort()).toEqual(['other', 's']);
    await r.delete(other);
    expect(await r.get(other)).toBeNull();
    // Every write, delete and listing was held past the timeout, and went through.
    // The writes: the generation, the create and the swap; the deletes: the generation's, and the row's, which removes
    // the row rather than writing a tombstone over it.
    expect(stub.count('PUT')).toBeGreaterThanOrEqual(3);
    expect(stub.count('DELETE')).toBe(2);
  }, 15_000);
});

describe('Azure Blob: a read lets go of a response the SDK refuses', () => {
  // The SDK refuses a download answered with no ETag by throwing a `RangeError`, and leaves the body unread with the
  // socket open. The answer here never ends, so only the read's own abort closes that socket.
  it.each([
    ['off', 0],
    ['set', TIMEOUT],
  ])('a range read answered with no ETag, with the timeout %s', async (_label, readTimeoutMs) => {
    stub.getOverride = () => ({
      status: 206,
      headers: { 'content-length': String(64 * 1024 * 1024), 'content-range': 'bytes 0-3/4' },
      body: 'endless',
    });
    const watch = watchProcess();
    try {
      await expect(storage(readTimeoutMs).getRange(GEN, 0, 4)).rejects.toThrow(RangeError);
      for (let i = 0; i < 200 && !stub.overridden.every((o) => o.closed); i++) await sleep(20);
      expect(stub.overridden).toHaveLength(1);
      expect(stub.overridden[0]!.closed).toBe(true);
      await sleep(50);
    } finally {
      watch.stop();
    }
    expect(watch.events).toEqual([]);
  });
});

describe('Azure Blob: a storage read whose connection drops part-way is a TransientError', () => {
  // The SDK fails such a body with an `AbortError`, which is also what aborting a read raises; only the read's own
  // signal tells the two apart, and here it never fired.
  it.each([
    ['off', 0],
    ['set', TIMEOUT],
  ])('a range read and a tail read, with the timeout %s', async (_label, readTimeoutMs) => {
    stub.plan = (r) => (r.method === 'GET' && r.name === DATA ? { drop: 'mid-body' } : undefined);
    const watch = watchProcess();
    try {
      for (const read of [
        () => storage(readTimeoutMs).getRange(GEN, 0, size),
        () => storage(readTimeoutMs).getTail(GEN, size),
      ]) {
        const err = await read().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(TransientError);
        expect((err as Error).message).toBe('transient Azure fault: ECONNRESET');
        expect(((err as Error).cause as Error).message).toBe(
          'Azure Blob read was cut off before the response completed',
        );
      }
      await sleep(50);
    } finally {
      watch.stop();
    }
    expect(watch.events).toEqual([]);
  });

  it('the store reads it again, and the read succeeds', async () => {
    const store = new CloudRoaring({ storage: backendWith(0) });
    let drops = 1;
    stub.plan = (r) =>
      r.method === 'GET' && r.name === DATA && drops-- > 0 ? { drop: 'mid-body' } : undefined;

    expect(await store.segment('s').has(2)).toBe(true);
    expect(drops).toBeLessThan(0); // the drop was used, and only once
  });
});

describe('Azure Blob: a timed-out read is retried by the store', () => {
  it('a read that stalls once and then answers succeeds, on the retry', async () => {
    const backend = new AzureBlobStorage({
      containerClient: stub.client(),
      readTimeoutMs: TIMEOUT,
    });
    const store = new CloudRoaring({ storage: backend });
    let stalls = 1;
    stub.plan = (r) =>
      r.method === 'GET' && r.name === DATA && stalls-- > 0 ? { stall: 'mid-body' } : undefined;
    const watch = watchProcess();
    try {
      const t0 = performance.now();
      expect(await store.segment('s').has(2)).toBe(true);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(TIMEOUT - 25);
      expect(stalls).toBeLessThan(0); // the stall was used, and only once
      expect(await stub.releasedStalls()).toBe(true);
      await sleep(50);
    } finally {
      watch.stop();
    }
    expect(watch.events).toEqual([]);
  });

  // A segment of its own, in a namespace of its own, so the erasure touches nothing the other tests seeded. Its one
  // generation holds chunks 0, 3 and 6; the id 2 is in chunk 0. The erasure's GETs of it are, in order, the tail read's
  // download, the chunk it edits, then the two it carries through.
  const ERASE = { namespace: 'ns', segment: 'e' };
  const ERASE_GEN0 = storageObjectName(undefined, { ...ERASE, generation: 0 });

  it.each([
    ['the tail read of the generation it rewrites', 1],
    ['the chunk it edits', 2],
    ['a chunk it carries through', 3],
  ] as const)(
    'an erasure whose read of %s stalls once still erases the id',
    async (_label, nth) => {
      const store = new CloudRoaring({ storage: backendWith(TIMEOUT) });
      await store.load(ERASE, [1, 2, 3, 200_000, 400_000]);
      let gets = 0;
      stub.plan = (r) =>
        r.method === 'GET' && r.name === ERASE_GEN0 && ++gets === nth
          ? { stall: 'after-headers' }
          : undefined;
      const watch = watchProcess();
      try {
        const ledger = await store.eraseSubject(2, { namespace: 'ns' });
        expect(ledger.erasedFrom).toEqual([
          expect.objectContaining({ segment: 'e', erased: true, fromGeneration: 0 }),
        ]);
        expect(await stub.releasedStalls()).toBe(true);
        await sleep(50);
      } finally {
        watch.stop();
      }
      expect(watch.events).toEqual([]);
      expect(
        await new CloudRoaring({ storage: backendWith(0) })
          .segment('e', { namespace: 'ns' })
          .has(2),
      ).toBe(false);
    },
  );

  it('a guarded load whose read of the current generation stalls once still publishes', async () => {
    const backend = backendWith(TIMEOUT);
    const store = new CloudRoaring({ storage: backend });
    await store.load(ERASE, [1, 2, 3]);
    // A row with a summary of its current generation is sized from it, and the object is not read. This row has none,
    // so the guard has to open its generation.
    const row = (await backend.registry.get(ERASE))!;
    await backend.registry.compareAndSwap(ERASE, row.token, { summary: undefined });
    let gets = 0;
    stub.plan = (r) =>
      r.method === 'GET' && r.name === ERASE_GEN0 && ++gets === 1
        ? { stall: 'after-headers' }
        : undefined;

    const res = await store.load(ERASE, [1, 2, 3, 4], { guard: { minRetained: 0.5 } });

    expect(res.published).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(2); // the stalled read, then its retry
  });
});

describe('Azure Blob: readTimeoutMs is validated', () => {
  it('is 0, off, when it is not given', () => {
    expect(resolveReadTimeoutMs(undefined)).toBe(0);
  });

  const construct = {
    AzureBlobStorage: (readTimeoutMs: number) =>
      new AzureBlobStorage({ containerClient: stub.client(), readTimeoutMs }),
    AzureBlobStorageDriver: (readTimeoutMs: number) => storage(readTimeoutMs),
    AzureBlobRegistryDriver: (readTimeoutMs: number) => registry(readTimeoutMs),
  };
  it.each(Object.keys(construct) as Array<keyof typeof construct>)(
    '%s takes an integer from 0 to 2,147,483,647, and refuses anything else',
    (name) => {
      for (const ok of [0, 1, 2_147_483_647]) expect(() => construct[name](ok)).not.toThrow();
      for (const bad of [-1, 1.5, NaN, Infinity, 2_147_483_648]) {
        expect(() => construct[name](bad)).toThrow(
          new ValidationError(
            `readTimeoutMs must be a non-negative safe integer no larger than 2147483647; got ${String(bad)}`,
          ),
        );
      }
      // A string is quoted, so '100' does not read as the number it is not, and a value with no string form of its
      // own is named by its type rather than thrown on.
      expect(() => construct[name]('100' as unknown as number)).toThrow(/; got "100"$/);
      for (const odd of [Symbol('ms'), Object.create(null), null]) {
        expect(() => construct[name](odd as unknown as number)).toThrow(ValidationError);
      }
    },
  );
});

describe('Azure Blob: a read leaves no timer behind', () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  // Under node_modules so the bundle resolves `@azure/storage-blob` from the repo, and out of git's way.
  const CACHE = `${ROOT}node_modules/.cache`;
  let outDir = '';
  let child = '';
  let home = '';

  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(`${CACHE}/azure-read-timeout-`);
    home = mkdtempSync(`${tmpdir()}/azure-read-timeout-home-`);
    child = `${outDir}/read-child.mjs`;
    await build({
      entryPoints: [`${HERE}fixtures/read-child.ts`],
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      packages: 'external',
      alias: {
        '@cloudbitmaps/core/driver-kit': `${ROOT}packages/core/src/driver-kit.ts`,
        '@cloudbitmaps/core': `${ROOT}packages/core/src/index.ts`,
      },
    });
  }, 30_000);
  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Run the child, killing it if it is still alive after `boundMs`; resolves with how it ended and how long it took. */
  function runChild(
    call: string,
    boundMs: number,
  ): Promise<{ code: number | null; killed: boolean; ms: number; out: string }> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      // A minimal environment, so nothing the developer or CI exports reaches the child.
      const env = { PATH: process.env.PATH ?? '', HOME: home };
      const proc = spawn(process.execPath, [child, stub.url, call], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, boundMs);
      proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      proc.on('error', reject);
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, killed, ms: performance.now() - t0, out: out.trim() });
      });
    });
  }

  // The child's timeout is a minute. A timer the read left armed would hold the process open for all of it.
  it.each(['range', 'tail', 'registry'])(
    'a process that makes one fast %s read, with a long timeout, exits promptly',
    async (call) => {
      const run = await runChild(call, 15_000);
      expect(run.killed).toBe(false);
      expect(run.code).toBe(0);
      expect(run.out).toMatch(/"ok"/);
    },
    30_000,
  );

  it.each([
    ['missing-range', NotFoundError.name],
    ['missing-tail', NotFoundError.name],
    ['registry', IntegrityError.name],
  ])(
    'a process whose %s read fails, with a long timeout, exits promptly',
    async (call, error) => {
      if (call === 'registry') {
        // A pointer answered with no ETag, which the read refuses with IntegrityError: a read that fails, whose timer
        // must be cleared as a fast read's is. (A socket left open does not hold a process; the release of one is
        // checked in-process, above, where the stub sees the connection close.)
        stub.getOverride = () => ({
          status: 200,
          headers: { 'content-length': String(64 * 1024 * 1024) },
          body: 'endless',
        });
      }
      const run = await runChild(call, 15_000);
      expect(run.killed).toBe(false);
      expect(run.code).toBe(1);
      expect(JSON.parse(run.out)).toMatchObject({ error });
    },
    30_000,
  );
});
