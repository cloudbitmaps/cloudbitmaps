import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { GcsStorage } from '@/gcs/backend';
import type { Storage } from '@google-cloud/storage';

/**
 * A GCS download is sent once by the SDK and retried by the driver, and a retried read cannot crash the process.
 *
 * `@google-cloud/storage` (7.x and 8.x) retries a failed `download()` by default, on a reset connection, a 408, a 429 and
 * a 5xx. When the retried request succeeds, the SDK throws `ERR_STREAM_UNABLE_TO_PIPE` outside any promise ("Cannot pipe
 * to a closed or destroyed stream") and Node exits with code 1, whatever the caller wrote around the call. So the client
 * the driver builds sends each download once, and the driver runs a download again itself after exactly the faults the
 * SDK would have retried, a few times, whichever call made it and whether or not the store's own read retry is on.
 *
 * Each scenario runs the driver in a child process, against a stub of the JSON API in this one, so a crash is the child's
 * exit code and not the test runner's. The real SDK is the thing under test: a mock of it could not crash.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Under node_modules so the bundle resolves `@google-cloud/storage` and `roaring` from the repo, and out of git's way.
const CACHE = `${ROOT}node_modules/.cache`;
let outDir = '';
let child = '';
let home = '';

const ROW = JSON.stringify({
  schemaVersion: 1,
  deleted: false,
  record: { segment: 's', currentGen: 0, status: 'active', createdAt: 1, updatedAt: 1, token: '0' },
});

type Fault = 'reset' | 503 | 429 | 408 | 404;

interface Stub {
  readonly endpoint: string;
  /** Requests seen so far, as `kind`: `media` (a download), `list` or `metadata`. */
  readonly seen: string[];
  close(): Promise<void>;
}

/**
 * Answers the first `times` downloads with `fault` (a reset drops the socket without answering) and every request after
 * that with a small 200.
 */
async function startStub(
  options: { fault?: Fault; times?: number; failList?: number } = {},
): Promise<Stub> {
  const seen: string[] = [];
  let faulted = 0;
  let listsFailed = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const isList = url.pathname.endsWith('/o');
    const kind = url.searchParams.get('alt') === 'media' ? 'media' : isList ? 'list' : 'metadata';
    seen.push(kind);
    if (kind === 'media' && options.fault !== undefined && faulted < (options.times ?? 1)) {
      faulted++;
      if (options.fault === 'reset') req.socket.destroy();
      else res.writeHead(options.fault).end('fault');
      return;
    }
    if (kind === 'list' && listsFailed === 0 && options.failList !== undefined) {
      listsFailed++;
      res.writeHead(options.failList).end('fail');
      return;
    }
    if (kind === 'media') {
      const registry = url.pathname.includes('registry');
      res.writeHead(200, { 'x-goog-generation': '7' }).end(registry ? ROW : '12345678');
      return;
    }
    const json = { 'content-type': 'application/json' };
    if (kind === 'list') {
      res
        .writeHead(200, json)
        .end(
          JSON.stringify({ items: [{ name: `${url.searchParams.get('prefix') ?? ''}3.crbm` }] }),
        );
      return;
    }
    res.writeHead(200, json).end(JSON.stringify({ name: 'o', generation: '7', size: '100' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Run {
  readonly code: number | null;
  readonly outcome: Record<string, unknown> | undefined;
}

/** The child gets a minimal environment, so nothing the developer or CI exports (an emulator host, credentials) leaks in. */
function runChild(endpoint: string, call: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', HOME: home };
    const proc = spawn(process.execPath, [child, endpoint, call], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      resolve({
        code,
        outcome: line === undefined ? undefined : (JSON.parse(line) as Run['outcome']),
      });
    });
  });
}

/** Run `call` against a stub with `options`; the stub is closed afterwards. */
async function scenario(
  call: string,
  options: Parameters<typeof startStub>[0],
): Promise<{ run: Run; downloads: number; seen: string[] }> {
  const stub = await startStub(options);
  try {
    const run = await runChild(stub.endpoint, call);
    return { run, downloads: stub.seen.filter((s) => s === 'media').length, seen: stub.seen };
  } finally {
    await stub.close();
  }
}

describe('a GCS download', () => {
  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(`${CACHE}/gcs-read-retry-`);
    home = mkdtempSync(`${tmpdir()}/gcs-read-retry-home-`);
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

  describe.each(['tail', 'range', 'registry'] as const)('read by %s', (call) => {
    it.concurrent.each([503, 429, 408, 'reset'] as const)(
      'a first fault (%s) is retried once: success, two requests, no crash',
      async (fault) => {
        const { run, downloads } = await scenario(call, { fault });
        expect(run.code).toBe(0);
        expect(run.outcome).toHaveProperty('ok');
        expect(downloads).toBe(2);
      },
      20_000,
    );

    it.concurrent(
      'a persistent 503 is a TransientError after the bounded attempts, with no crash',
      async () => {
        const { run, downloads } = await scenario(call, { fault: 503, times: 100 });
        expect(run.code).toBe(0);
        expect(run.outcome).toEqual({ error: 'TransientError' });
        expect(downloads).toBe(4);
      },
      20_000,
    );
  });

  it.concurrent.each(['tail', 'range'] as const)(
    'a 404 on a %s read is not retried',
    async (call) => {
      const { run, downloads } = await scenario(call, { fault: 404, times: 100 });
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ error: 'NotFoundError' });
      expect(downloads).toBe(1);
    },
    20_000,
  );

  it.concurrent(
    'is retried on a facade call that reads the registry with the store retry off',
    async () => {
      const { run, downloads } = await scenario('exists', { fault: 'reset' });
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ ok: true });
      expect(downloads).toBe(2);
    },
    20_000,
  );

  it.concurrent(
    'is the only request the SDK is kept from retrying: a listing keeps its retry',
    async () => {
      const { run, seen } = await scenario('list', { failList: 503 });
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ ok: [3] });
      expect(seen.filter((s) => s === 'list')).toHaveLength(2);
    },
    20_000,
  );

  describe('the clients the driver builds', () => {
    const readClientOf = (backend: GcsStorage): Storage =>
      (backend.storage as unknown as { readStorage: Storage }).readStorage;

    it('send downloads once and leave every other call on the default retries', () => {
      const backend = new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
      });
      expect(readClientOf(backend).retryOptions.autoRetry).toBe(false);
      expect(backend.client.retryOptions.autoRetry).toBe(true);
    });

    it('never touch a client the caller supplies', () => {
      const own = new GcsStorage({
        bucket: 'b',
        apiEndpoint: 'http://127.0.0.1:1',
        projectId: 'p',
      }).client;
      const backend = new GcsStorage({ bucket: 'b', client: own });
      expect(backend.client).toBe(own);
      expect(readClientOf(backend)).toBe(own);
      expect(own.retryOptions.autoRetry).toBe(true);
    });
  });
});
