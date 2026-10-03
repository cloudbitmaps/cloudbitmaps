import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CRC32C, Storage } from '@google-cloud/storage';
import { CloudRoaring, MemoryStorage } from '@/index';
import { GcsStorage } from '@/gcs/backend';
import { GcsStorageDriver } from '@/gcs/storage';
import { GcsRegistryDriver } from '@/gcs/registry';
import { resolveReadTimeoutMs } from '@/gcs/read-timeout';
import { ValidationError } from '@/core/errors';

/**
 * `readTimeoutMs`: one deadline bounds each driver read, every attempt the driver makes at it included, and the body
 * with it; when it passes, the read throws `TransientError` and nothing more is sent. Off (`0`) unless set.
 *
 * Each scenario runs the driver in a child process against a stub of the JSON API in this one, through the real SDK,
 * because what can go wrong is the SDK's: destroying a download before its response arrives makes the SDK throw outside
 * any promise once the response does, and destroying one on the SDK's shared keep-alive agent resets every other
 * request on it. A crash is the child's exit code; a timer left behind is a child that does not exit. The stub counts
 * what reaches it, and the requests it is still holding open, which is what a timed-out request costs the server.
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
 * How the stub answers one download of the backend under test (prefix `p`): at once (`ok`); never (`stall-headers`);
 * with its headers and 2 bytes, then nothing (`stall-body`); with its headers and half its body, then a dropped
 * connection (`cut`); with all of it after `late` ms; with its headers and 2 bytes, and the rest after `slow` ms; or a
 * status.
 */
type Media =
  | 'ok'
  | 'stall-headers'
  | 'stall-body'
  | 'cut'
  | { late: number }
  | { late503: number }
  | { slow: number }
  | 404
  | 503
  | 416;

interface StubOptions {
  /** The nth download gets `media[n]`, and every one after the last gets the last. */
  readonly media?: readonly Media[];
  /** The metadata reads (the empty-object path of a tail read), in the same way; `ok` answers a zero-byte object. */
  readonly metadata?: ReadonlyArray<'ok' | 'stall' | 503>;
  /** How long an upload waits before it is answered. */
  readonly uploadDelayMs?: number;
  /** How long a delete or a listing waits before it is answered. */
  readonly slowDeleteListMs?: number;
  /** A real generation and its registry row, served (with ranges) in place of the stand-ins. */
  readonly crbm?: { readonly row: string; readonly object: Buffer };
}

interface Counts {
  downloads: number;
  uploads: number;
  metadata: number;
  deletes: number;
  lists: number;
}

interface Stub {
  readonly endpoint: string;
  readonly counts: Counts;
  /** Requests received and not yet answered whose connection is still open. */
  held(): number;
  close(): Promise<void>;
}

/** The object bytes of a `multipart/related` upload, for the checksums its answer must carry. */
function uploadedBytes(req: IncomingMessage, body: Buffer): Buffer {
  const boundary = /boundary="?([^";]+)"?/.exec(String(req.headers['content-type']))?.[1] ?? '';
  const parts = body.toString('latin1').split(`--${boundary}`);
  const content = parts[2] ?? '';
  return Buffer.from(content.slice(content.indexOf('\r\n\r\n') + 4, -2), 'latin1');
}

/** The part of `object` a `Range` header asks for, with the status and headers GCS answers it with. */
function ranged(
  object: Buffer,
  range: string | undefined,
): [number, Record<string, string>, Buffer] {
  const total = object.length;
  const suffix = /^bytes=-(\d+)$/.exec(range ?? '');
  const span = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
  if (suffix === null && span === null) return [200, { 'content-length': String(total) }, object];
  const first = suffix !== null ? Math.max(0, total - Number(suffix[1])) : Number(span![1]);
  const last = suffix !== null ? total - 1 : Math.min(Number(span![2]), total - 1);
  const body = object.subarray(first, last + 1);
  return [
    206,
    { 'content-range': `bytes ${first}-${last}/${total}`, 'content-length': String(body.length) },
    body,
  ];
}

async function startStub(options: StubOptions): Promise<Stub> {
  const counts: Counts = { downloads: 0, uploads: 0, metadata: 0, deletes: 0, lists: 0 };
  const media = options.media ?? ['ok'];
  const metadata = options.metadata ?? ['ok'];
  const pending = new Set<ServerResponse>();
  const json = { 'content-type': 'application/json' };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    pending.add(res);
    res.on('close', () => pending.delete(res));
    const url = new URL(req.url ?? '/', 'http://stub');
    const name = decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
    if (url.pathname.startsWith('/upload/')) {
      counts.uploads++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () =>
        setTimeout(() => {
          const bytes = uploadedBytes(req, Buffer.concat(chunks));
          const crc = new CRC32C();
          crc.update(bytes);
          res.writeHead(200, json).end(
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
    if (req.method === 'DELETE' || url.pathname.endsWith('/o')) {
      if (req.method === 'DELETE') counts.deletes++;
      else counts.lists++;
      setTimeout(() => {
        if (req.method === 'DELETE') return void res.writeHead(204).end();
        const items = [{ name: `${url.searchParams.get('prefix') ?? ''}3.crbm` }];
        res.writeHead(200, json).end(JSON.stringify({ items }));
      }, options.slowDeleteListMs ?? 0);
      return;
    }
    const registry = url.pathname.includes('registry');
    // The second backend (prefix `q`): its registry row does not exist yet, and its one object is slow but healthy.
    if (name.startsWith('q/')) {
      if (url.searchParams.get('alt') !== 'media' || registry) {
        return void res
          .writeHead(404, json)
          .end(JSON.stringify({ error: { code: 404, message: 'No such object' } }));
      }
      res.writeHead(206, { 'content-range': 'bytes 0-7/8', 'content-length': '8' });
      res.write(OBJECT.slice(0, 2));
      setTimeout(() => res.end(OBJECT.slice(2)), 1_500);
      return;
    }
    if (url.searchParams.get('alt') !== 'media') {
      const answer = metadata[Math.min(counts.metadata, metadata.length - 1)] ?? 'ok';
      counts.metadata++;
      if (answer === 'stall') return;
      if (answer === 503) {
        return void res
          .writeHead(503, json)
          .end(JSON.stringify({ error: { code: 503, message: 'stub' } }));
      }
      res.writeHead(200, json).end(JSON.stringify({ name: 'o', generation: '7', size: '0' }));
      return;
    }
    const answer = media[Math.min(counts.downloads, media.length - 1)] ?? 'ok';
    counts.downloads++;
    if (typeof answer === 'number') {
      res.writeHead(answer, json).end(JSON.stringify({ error: { code: answer, message: 'stub' } }));
      return;
    }
    if (typeof answer === 'object' && 'late503' in answer) {
      setTimeout(
        () =>
          res.writeHead(503, json).end(JSON.stringify({ error: { code: 503, message: 'stub' } })),
        answer.late503,
      );
      return;
    }
    if (answer === 'stall-headers') return;
    let status: number;
    let headers: Record<string, string>;
    let body: Buffer;
    if (options.crbm !== undefined) {
      if (registry) {
        body = Buffer.from(options.crbm.row);
        [status, headers] = [
          200,
          { 'x-goog-generation': '7', 'content-length': String(body.length) },
        ];
      } else {
        [status, headers, body] = ranged(options.crbm.object, req.headers.range);
      }
    } else {
      body = Buffer.from(registry ? ROW : OBJECT);
      status = registry ? 200 : 206;
      headers = registry
        ? { 'x-goog-generation': '7', 'content-length': String(body.length) }
        : { 'content-range': `bytes 0-7/8`, 'content-length': '8' };
    }
    if (typeof answer === 'object' && 'late' in answer) {
      setTimeout(() => res.writeHead(status, headers).end(body), answer.late);
      return;
    }
    res.writeHead(status, headers);
    if (answer === 'ok') return void res.end(body);
    if (answer === 'cut') {
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => req.socket.destroy());
      return;
    }
    res.write(body.subarray(0, 2));
    if (typeof answer === 'object') setTimeout(() => res.end(body.subarray(2)), answer.slow);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    counts,
    held: () => pending.size,
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

/**
 * The child gets a minimal environment, so nothing the developer or CI exports (an emulator host, credentials) leaks in.
 * `onOutcome` runs when the child prints, while it is still up and holding whatever it holds.
 */
function runChild(
  endpoint: string,
  call: string,
  timeout: number | string,
  end = 'linger=300',
  onOutcome: () => void = () => undefined,
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
    proc.stdout.on('data', (d: Buffer) => {
      if (!out.includes('\n')) setImmediate(onOutcome);
      out += d.toString('utf8');
    });
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

interface Scenario {
  readonly run: Run;
  readonly counts: Counts;
  /** Requests the stub was holding open when the child printed its outcome. */
  readonly held: number;
  /** What had reached the stub when the child printed its outcome. */
  readonly atOutcome: Counts;
}

async function scenario(
  call: string,
  timeout: number | string,
  options: StubOptions,
  end?: string,
): Promise<Scenario> {
  const stub = await startStub(options);
  let held = -1;
  let atOutcome: Counts = { ...stub.counts };
  try {
    const run = await runChild(stub.endpoint, call, timeout, end, () => {
      held = stub.held();
      atOutcome = { ...stub.counts };
    });
    return { run, counts: { ...stub.counts }, held, atOutcome };
  } finally {
    await stub.close();
  }
}

/** A short timeout, for reads that must time out. */
const TIMEOUT = 200;
/** A long one, for reads that must not: a cold child's first read can take over 150 ms on a loaded machine. */
const ROOMY = 2_000;
/** The store's read retry: four attempts, and up to 50 + 100 + 200 ms of backoff between them. */
const STORE_ATTEMPTS = 4;
const STORE_BACKOFF_MS = 350;
/** What a loaded machine adds. */
const SLACK_MS = 4_000;
const READ_NAME = {
  tail: /^GCS tail read of s\.0 timed out after 200 ms$/,
  range: /^GCS range read of s\.0 timed out after 200 ms$/,
  registry: /^GCS registry read of p\/\S+ timed out after 200 ms$/,
} as const;

/** A real generation of ids 1, 2 and 3 and its registry row, from an in-memory store. */
async function realGeneration(): Promise<{ row: string; object: Buffer }> {
  const memory = new MemoryStorage();
  const r = await new CloudRoaring({ storage: memory }).load({ segment: 's' }, [1, 2, 3]);
  const generation = r.generation!;
  const { bytes } = await memory.storage.getTail({ segment: 's', generation }, 1 << 20);
  const record = await memory.registry.get({ segment: 's' });
  return {
    // A row the registry writes today is stamped 2: its token carries an incarnation, which a schema-1 row cannot.
    row: JSON.stringify({ schemaVersion: 2, deleted: false, record }),
    object: Buffer.from(bytes),
  };
}

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
    it.concurrent(
      'against a server that never answers: TransientError at the timeout, one request sent, and that one held open',
      async () => {
        // The SDK cannot cancel a request whose response has not begun, so the one in flight at the deadline stays open
        // until the server answers or closes it; nothing is sent after the deadline.
        const { run, counts, held } = await scenario(call, TIMEOUT, { media: ['stall-headers'] });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(String(run.outcome?.message)).toMatch(READ_NAME[call]);
        expect(counts.downloads).toBe(1);
        expect(held).toBe(1);
        const ms = Number(run.outcome?.ms);
        expect(ms).toBeGreaterThanOrEqual(TIMEOUT - 20);
        expect(ms).toBeLessThan(TIMEOUT + SLACK_MS);
      },
      30_000,
    );

    it.concurrent(
      'a body that stalls is cut off at the timeout, and its connection closed',
      async () => {
        const { run, counts, held } = await scenario(call, TIMEOUT, { media: ['stall-body'] });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(String(run.outcome?.message)).toMatch(READ_NAME[call]);
        expect(counts.downloads).toBe(1);
        expect(held).toBe(0);
        expect(Number(run.outcome?.ms)).toBeGreaterThanOrEqual(TIMEOUT - 20);
      },
      30_000,
    );

    it.concurrent(
      'a 503 and then a stall share one deadline: the retry gets only what is left of it',
      async () => {
        // The 503 takes 600 of the 1,000 ms, so a fresh clock for the retry would end past 1,600 ms.
        const timeout = 1_000;
        const { run, counts, held } = await scenario(call, timeout, {
          media: [{ late503: 600 }, 'stall-headers'],
        });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(counts.downloads).toBe(2);
        expect(held).toBe(1);
        const ms = Number(run.outcome?.ms);
        expect(ms).toBeGreaterThanOrEqual(timeout - 20);
        expect(ms).toBeLessThan(timeout + 400);
      },
      30_000,
    );

    it.concurrent(
      'a response that arrives after its read timed out is let go, with no crash',
      async () => {
        // The answer lands 300 ms after the read gave up; the child stays up until it has arrived.
        const { run, counts } = await scenario(
          call,
          TIMEOUT,
          { media: [{ late: TIMEOUT + 300 }] },
          'linger=1500',
        );
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(counts.downloads).toBe(1);
      },
      30_000,
    );

    it.concurrent(
      'a fast read is unaffected: one request',
      async () => {
        const { run, counts } = await scenario(call, ROOMY, { media: ['ok'] });
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

  describe('through the store, whose read retry runs a timed-out read again', () => {
    it.concurrent(
      'a has() against a server that never answers holds one request per store attempt, and fails at about attempts × timeout',
      async () => {
        const { run, counts, held } = await scenario('has', TIMEOUT, { media: ['stall-headers'] });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(counts.downloads).toBe(STORE_ATTEMPTS);
        expect(held).toBe(STORE_ATTEMPTS);
        const ms = Number(run.outcome?.ms);
        expect(ms).toBeGreaterThanOrEqual(STORE_ATTEMPTS * TIMEOUT - 20);
        expect(ms).toBeLessThan(STORE_ATTEMPTS * TIMEOUT + STORE_BACKOFF_MS + SLACK_MS);
      },
      30_000,
    );

    it.concurrent(
      'five has() at once hold five times as many, and no more',
      async () => {
        const { run, counts, held } = await scenario('has5', TIMEOUT, { media: ['stall-headers'] });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ ok: Array(5).fill('TransientError') });
        expect(counts.downloads).toBe(5 * STORE_ATTEMPTS);
        expect(held).toBe(5 * STORE_ATTEMPTS);
      },
      30_000,
    );

    it.concurrent.each(['stall-headers', 'stall-body'] as const)(
      'a has() whose first read stalls (%s) and is then answered succeeds',
      async (stall) => {
        const crbm = await realGeneration();
        const { run, counts } = await scenario('has', ROOMY, { media: [stall, 'ok'], crbm });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ ok: true });
        expect(counts.downloads).toBeGreaterThanOrEqual(2);
        expect(Number(run.outcome?.ms)).toBeGreaterThanOrEqual(ROOMY - 20);
      },
      30_000,
    );
  });

  describe('leaves the other requests in flight alone, timed or not', () => {
    it.concurrent(
      'a read timed out mid-body: the upload on the same backend, and a read and a registry write on another, all complete',
      async () => {
        // A destroyed download on the SDK's shared keep-alive agent makes the SDK destroy that agent, which resets every
        // request on it, these included. Each of them is answered only after 1.5 s.
        const { run, counts } = await scenario('tail+upload', TIMEOUT, {
          media: ['stall-body'],
          uploadDelayMs: 1_500,
        });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({
          error: 'TransientError',
          upload: { ok: 64 },
          otherRead: { ok: 8 },
          otherCreate: { ok: 'created' },
        });
        expect(counts.downloads).toBe(1);
        expect(counts.uploads).toBe(2);
      },
      30_000,
    );

    it.concurrent.each(['tail', 'range', 'registry'] as const)(
      'with no timeout, a %s read whose body is cut off is retried, and the uploads and the other read complete',
      async (call) => {
        // The cut body is an error inside the SDK's own pipeline, which destroys the agent the request went out on.
        const { run, counts } = await scenario(`${call}+upload`, 'default', {
          media: ['cut', 'ok'],
          uploadDelayMs: 1_500,
        });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({
          upload: { ok: 64 },
          otherRead: { ok: 8 },
          otherCreate: { ok: 'created' },
        });
        expect(run.outcome).toHaveProperty('ok');
        expect(counts.downloads).toBe(2);
      },
      30_000,
    );
  });

  it.concurrent(
    'applies readTimeoutMs set beside a client of your own',
    async () => {
      const { run, counts } = await scenario('tail', `client:${TIMEOUT}`, {
        media: ['stall-headers'],
      });
      expect(run.code).toBe(0);
      expect(run.outcome).toMatchObject({ error: 'TransientError' });
      expect(String(run.outcome?.message)).toMatch(READ_NAME.tail);
      expect(counts.downloads).toBe(1);
    },
    30_000,
  );

  it.concurrent.each(['delete', 'list'] as const)(
    'does not time a %s: one slower than the timeout completes',
    async (call) => {
      const { run, counts } = await scenario(call, TIMEOUT, { slowDeleteListMs: 3 * TIMEOUT });
      expect(run.code).toBe(0);
      expect(run.outcome).toHaveProperty('ok');
      expect(Number(run.outcome?.ms)).toBeGreaterThanOrEqual(3 * TIMEOUT - 20);
      expect(call === 'delete' ? counts.deletes : counts.lists).toBe(1);
    },
    30_000,
  );

  describe('the metadata read a tail read falls back on (a 416 asks it whether the object is empty)', () => {
    it.concurrent(
      'is inside the same deadline: a stall there fails the tail read at the timeout, once',
      async () => {
        const { run, counts } = await scenario('tail', TIMEOUT, {
          media: [416],
          metadata: ['stall'],
        });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(String(run.outcome?.message)).toMatch(READ_NAME.tail);
        expect(counts.downloads).toBe(1);
        expect(counts.metadata).toBe(1);
        const ms = Number(run.outcome?.ms);
        expect(ms).toBeGreaterThanOrEqual(TIMEOUT - 20);
        expect(ms).toBeLessThan(TIMEOUT + SLACK_MS);
      },
      30_000,
    );

    it.concurrent(
      'sends nothing after the deadline: a metadata read that keeps failing stops when the tail read does',
      async () => {
        // On a client whose SDK retry is on, the abandoned request would go on retrying after the read had failed.
        const { run, counts, atOutcome } = await scenario(
          'tail',
          TIMEOUT,
          { media: [416], metadata: [503] },
          'linger=3500',
        );
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ error: 'TransientError' });
        expect(atOutcome.metadata).toBeGreaterThanOrEqual(1);
        expect(counts.metadata).toBe(atOutcome.metadata);
      },
      30_000,
    );

    it.concurrent(
      'is retried by the driver after a 503, as a download is',
      async () => {
        const { run, counts } = await scenario('tail', ROOMY, {
          media: [416],
          metadata: [503, 'ok'],
        });
        expect(run.code).toBe(0);
        expect(run.outcome).toMatchObject({ ok: 0 });
        expect(counts.metadata).toBe(2);
      },
      30_000,
    );
  });

  describe('leaves no timer behind: with a 60 s timeout, the process ends by itself as soon as the call settles', () => {
    it.concurrent.each([
      ['a fast tail read', 'tail', { media: ['ok'] }, { ok: 8 }],
      ['a fast range read', 'range', { media: ['ok'] }, { ok: 8 }],
      ['a fast registry read', 'registry', { media: ['ok'] }, { ok: 0 }],
      ['a 404', 'tail', { media: [404] }, { error: 'NotFoundError' }],
      ['a persistent 503', 'range', { media: [503] }, { error: 'TransientError' }],
      ['an empty object, read through its metadata', 'tail', { media: [416] }, { ok: 0 }],
      [
        'a metadata read that fails',
        'tail',
        { media: [416], metadata: [503] },
        { error: 'TransientError' },
      ],
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

  it('reaches both halves of the backend when set, beside a client of your own too', () => {
    const backend = new GcsStorage({ ...gcs, readTimeoutMs: 1_500 });
    expect(timeoutOf(backend.storage)).toBe(1_500);
    expect(registryTimeoutOf(backend)).toBe(1_500);
    const own = new GcsStorage({ bucket: 'b', client: backend.client, readTimeoutMs: 2_500 });
    expect(timeoutOf(own.storage)).toBe(2_500);
    expect(registryTimeoutOf(own)).toBe(2_500);
  });

  it.each([
    ['a string', '100', 'got "100"'],
    ['a number out of range', 2_147_483_648, 'got 2147483648'],
    ['a fraction', 1.5, 'got 1.5'],
    ['a boolean', true, 'got true'],
    ['a bigint', 10n, 'got 10'],
    ['null', null, 'got null'],
    ['a symbol', Symbol('x'), 'got symbol'],
    ['an object with no prototype', Object.create(null) as unknown, 'got object'],
    [
      'an object whose toString throws',
      {
        toString(): string {
          throw new Error('no');
        },
      },
      'got object',
    ],
    ['an array holding a symbol', [Symbol('x')], 'got object'],
    ['a function', () => 5, 'got function'],
  ])('names %s in its ValidationError, and never throws anything else', (_name, bad, got) => {
    const asNumber = bad as unknown as number;
    expect(() => new GcsStorage({ ...gcs, readTimeoutMs: asNumber })).toThrow(ValidationError);
    expect(() => new GcsStorage({ ...gcs, readTimeoutMs: asNumber })).toThrow(
      `readTimeoutMs must be a non-negative safe integer no larger than 2147483647; ${got}`,
    );
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
