import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CRC32C, Storage } from '@google-cloud/storage';
import { GcsStorage } from '@/gcs/backend';
import { GcsStorageDriver } from '@/gcs/storage';
import { GcsRegistryDriver } from '@/gcs/registry';
import { resolveReadTimeoutMs } from '@/gcs/read-timeout';
import { ValidationError } from '@/core/errors';

/**
 * `readTimeoutMs`: every download the GCS drivers make is cut off once it has run that long, body included, and the cut
 * is a connection fault the driver retries, then a `TransientError`. Off (`0`) unless set.
 *
 * Each scenario runs the driver in a child process against a stub of the JSON API in this one, through the real SDK,
 * because what can go wrong is the SDK's: destroying a download before its response arrives makes the SDK throw outside
 * any promise once the response does, and destroying one on the SDK's shared keep-alive agent resets every other
 * request on it. A crash is the child's exit code; a timer left behind is a child that does not exit.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CACHE = `${ROOT}node_modules/.cache`;
let outDir = '';
let child = '';
let home = '';

const ROW = JSON.stringify({
  schemaVersion: 1,
  deleted: false,
  record: { segment: 's', currentGen: 0, status: 'active', createdAt: 1, updatedAt: 1, token: '0' },
});
const OBJECT = '12345678';

/**
 * How the stub answers one download: at once (`ok`); never (`stall-headers`); with its headers and 2 bytes, then nothing
 * (`stall-body`); with all of it after `late` ms; with its headers and 2 bytes, and the rest after `slow` ms; or a status.
 */
type Media =
  'ok' | 'stall-headers' | 'stall-body' | { late: number } | { slow: number } | 404 | 503 | 416;

interface StubOptions {
  /** The nth download gets `media[n]`, and every one after the last gets the last. */
  readonly media?: readonly Media[];
  /** The metadata read (the empty-object path of a tail read): `ok` answers a zero-byte object. */
  readonly metadata?: 'ok' | 'stall';
  /** How long an upload waits before it is answered. */
  readonly uploadDelayMs?: number;
}

interface Stub {
  readonly endpoint: string;
  readonly counts: { downloads: number; uploads: number; metadata: number };
  close(): Promise<void>;
}

/** The object bytes of a `multipart/related` upload, for the checksums its answer must carry. */
function uploadedBytes(req: IncomingMessage, body: Buffer): Buffer {
  const boundary = /boundary="?([^";]+)"?/.exec(String(req.headers['content-type']))?.[1] ?? '';
  const parts = body.toString('latin1').split(`--${boundary}`);
  const content = parts[2] ?? '';
  return Buffer.from(content.slice(content.indexOf('\r\n\r\n') + 4, -2), 'latin1');
}

async function startStub(options: StubOptions): Promise<Stub> {
  const counts = { downloads: 0, uploads: 0, metadata: 0 };
  const media = options.media ?? ['ok'];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname.startsWith('/upload/')) {
      counts.uploads++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () =>
        setTimeout(() => {
          const bytes = uploadedBytes(req, Buffer.concat(chunks));
          const crc = new CRC32C();
          crc.update(bytes);
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              name: 'w',
              generation: '9',
              size: String(bytes.length),
              crc32c: crc.toString(),
              md5Hash: createHash('md5').update(bytes).digest('base64'),
            }),
          );
        }, options.uploadDelayMs ?? 0),
      );
      return;
    }
    if (url.searchParams.get('alt') !== 'media') {
      counts.metadata++;
      if (options.metadata === 'stall') return;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ name: 'o', generation: '7', size: '0' }));
      return;
    }
    const answer = media[Math.min(counts.downloads, media.length - 1)] ?? 'ok';
    counts.downloads++;
    if (typeof answer === 'number') {
      res
        .writeHead(answer, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: answer, message: 'stub' } }));
      return;
    }
    if (answer === 'stall-headers') return;
    const registry = url.pathname.includes('registry');
    const body = registry ? ROW : OBJECT;
    const headers = registry
      ? { 'x-goog-generation': '7', 'content-length': String(body.length) }
      : { 'content-range': `bytes 0-7/8`, 'content-length': '8' };
    const status = registry ? 200 : 206;
    if (typeof answer === 'object' && 'late' in answer) {
      setTimeout(() => res.writeHead(status, headers).end(body), answer.late);
      return;
    }
    res.writeHead(status, headers);
    if (answer === 'ok') return void res.end(body);
    res.write(body.slice(0, 2));
    if (typeof answer === 'object') setTimeout(() => res.end(body.slice(2)), answer.slow);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Run {
  readonly code: number | null;
  readonly outcome: Record<string, unknown> | undefined;
  /** From spawning the child to its exit. */
  readonly wallMs: number;
  /** Whether it had to be killed, still running, after `killAfterMs`. */
  readonly killed: boolean;
}

/** The child gets a minimal environment, so nothing the developer or CI exports (an emulator host, credentials) leaks in. */
function runChild(
  endpoint: string,
  call: string,
  timeout: number | 'default',
  end = 'linger=300',
  killAfterMs = 25_000,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(process.execPath, [child, endpoint, call, String(timeout), end], {
      env: { PATH: process.env.PATH ?? '', HOME: home },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, killAfterMs);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(killer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      resolve({
        code,
        outcome: line === undefined ? undefined : (JSON.parse(line) as Run['outcome']),
        wallMs: Date.now() - started,
        killed,
      });
    });
  });
}

async function scenario(
  call: string,
  timeout: number | 'default',
  options: StubOptions,
  end?: string,
): Promise<{ run: Run; counts: Stub['counts'] }> {
  const stub = await startStub(options);
  try {
    const run = await runChild(stub.endpoint, call, timeout, end);
    return { run, counts: { ...stub.counts } };
  } finally {
    await stub.close();
  }
}

const TIMEOUT = 200;
const ATTEMPTS = 4; // the first, and the driver's three retries
/** The driver's backoff before its three retries is at most 100 + 200 + 400 ms; the rest is a loaded machine's slack. */
const SLACK_MS = 700 + 4_000;
const READ_NAME = {
  tail: /GCS tail read of s\.0 timed out after 200 ms/,
  range: /GCS range read of s\.0 timed out after 200 ms/,
  registry: /GCS registry read of p\/\S+ timed out after 200 ms/,
} as const;

describe('a GCS read with readTimeoutMs', () => {
  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(`${CACHE}/gcs-read-timeout-`);
    home = mkdtempSync(`${tmpdir()}/gcs-read-timeout-home-`);
    child = `${outDir}/timeout-child.mjs`;
    await build({
      entryPoints: [`${HERE}fixtures/timeout-child.ts`],
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

  describe.each(['tail', 'range', 'registry'] as const)('the %s read', (call) => {
    it.concurrent.each(['stall-headers', 'stall-body'] as const)(
      'a %s on every attempt is a TransientError after the attempts, at about attempts × the timeout, with no crash',
      async (stall) => {
        const { run, counts } = await scenario(call, TIMEOUT, { media: [stall] });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(String(run.outcome?.message)).toMatch(READ_NAME[call]);
        expect(counts.downloads).toBe(ATTEMPTS);
        const ms = Number(run.outcome?.ms);
        expect(ms).toBeGreaterThanOrEqual(ATTEMPTS * TIMEOUT - 20);
        expect(ms).toBeLessThan(ATTEMPTS * TIMEOUT + SLACK_MS);
      },
      30_000,
    );

    it.concurrent(
      'a response that arrives after its read timed out is let go, with no crash',
      async () => {
        // Each answer lands 300 ms after its read gave up; the child stays up until the last has arrived.
        const { run, counts } = await scenario(
          call,
          TIMEOUT,
          { media: [{ late: TIMEOUT + 300 }] },
          'linger=1500',
        );
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(counts.downloads).toBe(ATTEMPTS);
      },
      30_000,
    );

    it.concurrent(
      'a fast read is unaffected: one request',
      async () => {
        const { run, counts } = await scenario(call, TIMEOUT, { media: ['ok'] });
        expect(run.code).toBe(0);
        expect(run.outcome).toHaveProperty('ok');
        expect(counts.downloads).toBe(1);
      },
      30_000,
    );

    it.concurrent.each([0, 'default'] as const)(
      'readTimeoutMs %s lets a slow read finish',
      async (timeout) => {
        const { run, counts } = await scenario(call, timeout, { media: [{ slow: 1_200 }] });
        expect(run.code).toBe(0);
        expect(run.outcome).toHaveProperty('ok');
        expect(Number(run.outcome?.ms)).toBeGreaterThanOrEqual(1_150);
        expect(counts.downloads).toBe(1);
      },
      30_000,
    );
  });

  it.concurrent.each([['stall-headers'], ['stall-body']] as const)(
    'a read that stalls (%s) and then answers succeeds through the store, with its own retry off',
    async (stall) => {
      const { run, counts } = await scenario('exists', TIMEOUT, { media: [stall, 'ok'] });
      expect(run.code).toBe(0);
      expect(run.outcome).toMatchObject({ ok: true });
      expect(counts.downloads).toBe(2);
    },
    30_000,
  );

  it.concurrent(
    "a timed-out read does not reset an upload in flight on the backend's other client",
    async () => {
      // Every attempt of the read is cut off mid-body while the upload waits 1.5 s for its answer. A destroyed download
      // on the SDK's shared keep-alive agent makes the SDK destroy that agent, which resets the upload.
      const { run, counts } = await scenario('tail+upload', TIMEOUT, {
        media: ['stall-body'],
        uploadDelayMs: 1_500,
      });
      expect(run.code).toBe(0);
      expect(run.outcome).toMatchObject({ error: 'TransientError', upload: { ok: 64 } });
      expect(counts.downloads).toBe(ATTEMPTS);
      expect(counts.uploads).toBe(1);
    },
    30_000,
  );

  it.concurrent(
    'times the metadata read a tail read falls back on, once',
    async () => {
      // A 416 sends the tail read to the object's metadata, to tell an empty object from a range fault.
      const { run, counts } = await scenario('tail', TIMEOUT, { media: [416], metadata: 'stall' });
      expect(run.code).toBe(0);
      expect(run.outcome).toMatchObject({ error: 'TransientError' });
      expect(String(run.outcome?.message)).toMatch(
        /GCS metadata read of s\.0 timed out after 200 ms/,
      );
      expect(counts.downloads).toBe(1);
      expect(counts.metadata).toBe(1);
      expect(Number(run.outcome?.ms)).toBeGreaterThanOrEqual(TIMEOUT - 20);
    },
    30_000,
  );

  describe('leaves no timer behind: with a 60 s timeout, the process ends by itself as soon as the call settles', () => {
    it.concurrent.each([
      ['a fast tail read', 'tail', { media: ['ok'] }, { ok: 8 }],
      ['a fast range read', 'range', { media: ['ok'] }, { ok: 8 }],
      ['a fast registry read', 'registry', { media: ['ok'] }, { ok: 0 }],
      ['a 404', 'tail', { media: [404] }, { error: 'NotFoundError' }],
      ['a persistent 503', 'range', { media: [503] }, { error: 'TransientError' }],
      ['an empty object, read through its metadata', 'tail', { media: [416] }, { ok: 0 }],
    ] as const)(
      '%s',
      async (_name, call, options, expected) => {
        const stub = await startStub(options);
        try {
          const run = await runChild(stub.endpoint, call, 60_000, 'natural');
          expect(run.killed).toBe(false);
          expect(run.code).toBe(0);
          expect(run.outcome).toMatchObject(expected);
          expect(run.wallMs).toBeLessThan(20_000);
        } finally {
          await stub.close();
        }
      },
      30_000,
    );
  });
});

describe('readTimeoutMs validation', () => {
  const gcs = { bucket: 'b', apiEndpoint: 'http://127.0.0.1:1', projectId: 'p' };
  const timeoutOf = (driver: unknown): unknown =>
    (driver as { readTimeoutMs: unknown }).readTimeoutMs;
  const registryTimeoutOf = (backend: GcsStorage): unknown =>
    (backend.registry as unknown as { store: { readTimeoutMs: unknown } }).store.readTimeoutMs;

  it('is off (0) unless set, on both halves of the backend', () => {
    expect(resolveReadTimeoutMs(undefined)).toBe(0);
    const backend = new GcsStorage(gcs);
    expect(timeoutOf(backend.storage)).toBe(0);
    expect(registryTimeoutOf(backend)).toBe(0);
  });

  it('reaches both halves of the backend when set', () => {
    const backend = new GcsStorage({ ...gcs, readTimeoutMs: 1_500 });
    expect(timeoutOf(backend.storage)).toBe(1_500);
    expect(registryTimeoutOf(backend)).toBe(1_500);
  });

  it.each([0, 1, 2_147_483_647])('takes %s', (ms) => {
    expect(() => new GcsStorage({ ...gcs, readTimeoutMs: ms })).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '100', null])(
    'refuses %s, in the backend and in each driver',
    (bad) => {
      const storage = new Storage({ apiEndpoint: gcs.apiEndpoint, projectId: 'p' });
      const message = /readTimeoutMs must be a non-negative safe integer no larger than 2147483647/;
      const asNumber = bad as unknown as number;
      expect(() => new GcsStorage({ ...gcs, readTimeoutMs: asNumber })).toThrow(ValidationError);
      expect(() => new GcsStorage({ ...gcs, readTimeoutMs: asNumber })).toThrow(message);
      expect(() => new GcsStorageDriver({ storage, bucket: 'b', readTimeoutMs: asNumber })).toThrow(
        message,
      );
      expect(
        () => new GcsRegistryDriver({ storage, bucket: 'b', readTimeoutMs: asNumber }),
      ).toThrow(message);
    },
  );
});
