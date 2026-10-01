import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { GcsStorage } from '@/gcs/backend';
import type { Storage } from '@google-cloud/storage';

/**
 * A read the SDK retries can crash the process; the driver's own client must not let it.
 *
 * `@google-cloud/storage` 8.x retries a failed `download()` by default. When the retried request succeeds, the SDK
 * throws `ERR_STREAM_UNABLE_TO_PIPE` outside any promise ("Cannot pipe to a closed or destroyed stream") and Node
 * exits with code 1, whatever the caller wrote around the call. The library already retries reads itself, one layer up,
 * on a `TransientError`, so the client the driver builds sends each download once.
 *
 * Each scenario runs the driver in a child process, against a stub of the JSON API in this one that answers the first
 * download with 503 and every request after it with 200, so a crash is the child's exit code and not the test
 * runner's. The real SDK is the thing under test: a mock of it could not crash.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Under node_modules so the bundle resolves `@google-cloud/storage` from the repo, and out of git's way.
const OUT = `${ROOT}node_modules/.cache/cloudbitmaps-gcs-read-retry`;
const CHILD = `${OUT}/read-child.mjs`;

interface Stub {
  readonly endpoint: string;
  /** Requests seen so far, as `METHOD kind`, where kind is `media` (a download), `list` or `metadata`. */
  readonly seen: string[];
  close(): Promise<void>;
}

/** Answers the first download with `failWith` (503 by default) and everything else with a small 200. */
async function startStub(
  options: { failDownload?: number; failList?: number } = {},
): Promise<Stub> {
  const seen: string[] = [];
  let downloadsFailed = 0;
  let listsFailed = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const isList = url.pathname.endsWith('/o');
    const kind = url.searchParams.get('alt') === 'media' ? 'media' : isList ? 'list' : 'metadata';
    seen.push(`${req.method} ${kind}`);
    if (kind === 'media' && downloadsFailed === 0 && options.failDownload !== undefined) {
      downloadsFailed++;
      res.writeHead(options.failDownload).end('fail');
      return;
    }
    if (kind === 'list' && listsFailed === 0 && options.failList !== undefined) {
      listsFailed++;
      res.writeHead(options.failList).end('fail');
      return;
    }
    if (kind === 'media') {
      res.writeHead(200, { 'x-goog-generation': '7' }).end('12345678');
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

function runChild(endpoint: string, call: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, endpoint, call], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      resolve({
        code,
        outcome: line === undefined ? undefined : (JSON.parse(line) as Run['outcome']),
      });
    });
  });
}

describe('a read through the GCS driver the SDK would retry', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    await build({
      entryPoints: [`${HERE}fixtures/read-child.ts`],
      outfile: CHILD,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      external: ['@google-cloud/storage'],
      alias: {
        '@cloudbitmaps/core/driver-kit': `${ROOT}packages/core/src/driver-kit.ts`,
        '@cloudbitmaps/core': `${ROOT}packages/core/src/index.ts`,
      },
    });
  }, 30_000);
  afterAll(() => rmSync(OUT, { recursive: true, force: true }));

  for (const call of ['tail', 'range', 'registry'] as const) {
    it(`${call}: one 503 is one request and a TransientError, and the process survives`, async () => {
      const stub = await startStub({ failDownload: 503 });
      try {
        const run = await runChild(stub.endpoint, call);
        expect(run.code).toBe(0);
        expect(run.outcome).toEqual({ error: 'TransientError' });
        expect(stub.seen.filter((s) => s.endsWith('media'))).toHaveLength(1);
      } finally {
        await stub.close();
      }
    }, 20_000);
  }

  it('a 429 is treated the same way', async () => {
    const stub = await startStub({ failDownload: 429 });
    try {
      const run = await runChild(stub.endpoint, 'range');
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ error: 'TransientError' });
      expect(stub.seen.filter((s) => s.endsWith('media'))).toHaveLength(1);
    } finally {
      await stub.close();
    }
  }, 20_000);

  it('a listing, which is not a stream, keeps the SDK retry', async () => {
    const stub = await startStub({ failList: 503 });
    try {
      const run = await runChild(stub.endpoint, 'list');
      expect(run.code).toBe(0);
      expect(run.outcome).toEqual({ ok: [3] });
      expect(stub.seen.filter((s) => s.endsWith('list'))).toHaveLength(2);
    } finally {
      await stub.close();
    }
  }, 20_000);

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
      const own = new GcsStorage({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:1', projectId: 'p' })
        .client;
      const backend = new GcsStorage({ bucket: 'b', client: own });
      expect(backend.client).toBe(own);
      expect(readClientOf(backend)).toBe(own);
      expect(own.retryOptions.autoRetry).toBe(true);
    });
  });
});
