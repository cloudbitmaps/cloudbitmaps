import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { vi } from 'vitest';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CloudRoaring } from '@/index';
import { S3Storage } from '@/s3/backend';
import { S3RegistryDriver } from '@/s3/registry';
import { S3StorageDriver } from '@/s3/storage';
import { IntegrityError, TransientError, ValidationError } from '@/core/errors';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import type { GenKey } from '@/core/ports';

/**
 * Every S3 read is cut off at `readTimeoutMs`, and nothing else is.
 *
 * The client is the SDK's own, with its default HTTP handler, retry, signing and checksums, over a real socket to a
 * stub S3 endpoint in this process, so what these tests see is what the SDK does on a connection that stops answering:
 * before the headers, or after them, part-way through the body. The stub is a bucket in memory that serves the slice of
 * S3 the store uses, path-style, and can be told to stall or slow down the next requests of one kind. The credentials
 * are dummies, and nothing leaves the loopback interface.
 */

const BUCKET = 'b';
const FIVE_MIB = 5 * 1024 * 1024;
/**
 * Small enough to keep the suite quick, large enough that a loaded machine answers a fast request well inside it: the
 * tests that need a read to succeed run it under this timeout too.
 */
const TIMEOUT = 200;
/** How long a test waits for a read that should end before calling it hung. Generous, so a loaded machine does not flake. */
const HUNG = 8_000;
/** Each test's own limit, above {@link HUNG}, so a hung read fails the assertion rather than the runner's timeout. */
const LIMIT = { timeout: 20_000 };

type Op =
  | 'GetObject'
  | 'HeadObject'
  | 'PutObject'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'DeleteObject'
  | 'ListObjectsV2';

/**
 * - `no-headers`: the request arrives and nothing ever comes back.
 * - `mid-body`: the status, the headers and the first half of the body come back, and then nothing.
 * - `delay`: the whole response comes back, `ms` late.
 * - `oversize`: a `200` that declares a body over the registry's row cap, sends a few bytes of it, and then nothing.
 * - `status`: an S3 error with that status, at once, which the SDK's own retry sends again for a 5xx.
 * - `cut-body`: the status, the headers and the first half of the body come back, and then the connection drops.
 */
type Fault =
  | { kind: 'no-headers' }
  | { kind: 'mid-body' }
  | { kind: 'delay'; ms: number }
  | { kind: 'oversize' }
  | { kind: 'status'; status: number }
  | { kind: 'cut-body' };

interface Armed {
  readonly op: Op;
  readonly fault: Fault;
  readonly keyIncludes: string | undefined;
  times: number;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A bucket in memory behind a real HTTP endpoint, with faults armed per operation. */
class StubS3 {
  readonly objects = new Map<string, { body: Buffer; etag: string }>();
  readonly seen: { op: Op; key: string }[] = [];
  /** Stalled responses whose connection is still open: a timed-out read that released its socket is not in here. */
  readonly stalled = new Set<ServerResponse>();
  /** Requests whose response was sent in full, and those whose client hung up before it could be: a timed request. */
  readonly answered: Op[] = [];
  readonly cut: Op[] = [];
  /** Answer a ranged GET with the whole object and no `Content-Range`, as a backend that ignores `Range` does. */
  ignoreRange = false;
  private readonly uploads = new Map<string, Map<number, Buffer>>();
  private readonly armed: Armed[] = [];
  private seq = 0;
  private server: Server | undefined;
  endpoint = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.serve(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Apply `fault` to the next `times` requests of `op` (only those whose key contains `keyIncludes`, if given). */
  arm(op: Op, fault: Fault, opts: { times?: number; keyIncludes?: string } = {}): void {
    this.armed.push({ op, fault, keyIncludes: opts.keyIncludes, times: opts.times ?? 1 });
  }

  count(op: Op, keyIncludes?: string): number {
    return this.seen.filter(
      (s) => s.op === op && (keyIncludes === undefined || s.key.includes(keyIncludes)),
    ).length;
  }

  /** Static dummy credentials, path-style, the SDK's default transport: the client a user would build for MinIO. */
  options(): {
    bucket: string;
    endpoint: string;
    pathStyle: true;
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  } {
    return {
      bucket: BUCKET,
      endpoint: this.endpoint,
      pathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'stub', secretAccessKey: 'stub' },
    };
  }

  client(extra: { cacheMiddleware?: boolean } = {}): S3Client {
    const { endpoint, region, credentials } = this.options();
    return new S3Client({ endpoint, region, credentials, forcePathStyle: true, ...extra });
  }

  private static operationOf(method: string, key: string, q: URLSearchParams): Op {
    if (method === 'HEAD') return 'HeadObject';
    if (method === 'GET') return key === '' && q.has('list-type') ? 'ListObjectsV2' : 'GetObject';
    if (method === 'PUT') return q.has('uploadId') ? 'UploadPart' : 'PutObject';
    if (method === 'POST')
      return q.has('uploads') ? 'CreateMultipartUpload' : 'CompleteMultipartUpload';
    if (method === 'DELETE') return q.has('uploadId') ? 'AbortMultipartUpload' : 'DeleteObject';
    throw new Error(`the stub does not serve ${method}`);
  }

  private take(op: Op, key: string): Fault | undefined {
    const i = this.armed.findIndex(
      (a) => a.op === op && (a.keyIncludes === undefined || key.includes(a.keyIncludes)),
    );
    if (i < 0) return undefined;
    const armed = this.armed[i]!;
    armed.times -= 1;
    if (armed.times <= 0) this.armed.splice(i, 1);
    return armed.fault;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
    const op = StubS3.operationOf(req.method ?? '', key, url.searchParams);
    this.seen.push({ op, key });
    res.once('close', () => (res.writableFinished ? this.answered : this.cut).push(op));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const fault = this.take(op, key);
    if (fault?.kind === 'no-headers') {
      this.stall(res);
      return;
    }
    if (fault?.kind === 'oversize') {
      res.writeHead(200, { etag: '"big"', 'content-length': String(MAX_ROW_BYTES + 1) });
      res.write(Buffer.alloc(16, 0x7b));
      this.stall(res);
      return;
    }
    if (fault?.kind === 'status') {
      const xml = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>injected</Message></Error>`,
      );
      res.writeHead(fault.status, {
        'content-type': 'application/xml',
        'content-length': String(xml.length),
      });
      res.end(xml);
      return;
    }
    if (fault?.kind === 'delay') await new Promise((resolve) => setTimeout(resolve, fault.ms));
    if (res.destroyed) return;
    const answer = this.apply(op, key, url.searchParams, req, body);
    res.writeHead(answer.status, answer.headers);
    if (fault?.kind === 'cut-body' && answer.body.length > 1) {
      res.write(answer.body.subarray(0, Math.floor(answer.body.length / 2)), () =>
        res.socket?.destroy(),
      );
      return;
    }
    if (fault?.kind === 'mid-body' && answer.body.length > 1) {
      res.write(answer.body.subarray(0, Math.floor(answer.body.length / 2)));
      this.stall(res);
      return;
    }
    res.end(req.method === 'HEAD' ? undefined : answer.body);
  }

  private stall(res: ServerResponse): void {
    this.stalled.add(res);
    res.once('close', () => this.stalled.delete(res));
  }

  private apply(
    op: Op,
    key: string,
    q: URLSearchParams,
    req: IncomingMessage,
    body: Buffer,
  ): { status: number; headers: Record<string, string>; body: Buffer } {
    const xml = { 'content-type': 'application/xml' };
    const ok = (headers: Record<string, string>, out: Buffer | string = Buffer.alloc(0)) => {
      const bytes = typeof out === 'string' ? Buffer.from(out) : out;
      return {
        status: 200,
        headers: { 'content-length': String(bytes.length), ...headers },
        body: bytes,
      };
    };
    const error = (status: number, code: string) => {
      const bytes = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      );
      return { status, headers: { ...xml, 'content-length': String(bytes.length) }, body: bytes };
    };
    const store = (bytes: Buffer): string => {
      const etag = `"e${++this.seq}"`;
      this.objects.set(key, { body: bytes, etag });
      return etag;
    };
    const current = this.objects.get(key);
    const conditional = () => {
      if (req.headers['if-none-match'] === '*' && current !== undefined) {
        return error(412, 'PreconditionFailed');
      }
      const ifMatch = req.headers['if-match'];
      if (ifMatch !== undefined && current?.etag !== ifMatch)
        return error(412, 'PreconditionFailed');
      return undefined;
    };
    switch (op) {
      case 'PutObject':
        return conditional() ?? ok({ etag: store(body) });
      case 'CreateMultipartUpload': {
        const id = `u${++this.seq}`;
        this.uploads.set(id, new Map());
        return ok(
          xml,
          `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case 'UploadPart': {
        const parts = this.uploads.get(q.get('uploadId') ?? '');
        if (parts === undefined) return error(404, 'NoSuchUpload');
        parts.set(Number(q.get('partNumber')), body);
        return ok({ etag: `"p${q.get('partNumber')}"` });
      }
      case 'CompleteMultipartUpload': {
        const refused = conditional();
        if (refused !== undefined) return refused;
        const parts = this.uploads.get(q.get('uploadId') ?? '');
        if (parts === undefined) return error(404, 'NoSuchUpload');
        this.uploads.delete(q.get('uploadId') ?? '');
        const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
        const etag = store(Buffer.concat(ordered));
        return ok(
          xml,
          `<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      case 'AbortMultipartUpload':
        this.uploads.delete(q.get('uploadId') ?? '');
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      case 'DeleteObject':
        this.objects.delete(key);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      case 'ListObjectsV2': {
        const prefix = q.get('prefix') ?? '';
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        return ok(
          xml,
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys
            .map(
              (k) =>
                `<Contents><Key>${xmlEscape(k)}</Key><Size>${this.objects.get(k)!.body.length}</Size></Contents>`,
            )
            .join('')}</ListBucketResult>`,
        );
      }
      case 'HeadObject':
        if (current === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        return {
          status: 200,
          headers: { etag: current.etag, 'content-length': String(current.body.length) },
          body: Buffer.alloc(0),
        };
      case 'GetObject': {
        if (current === undefined) return error(404, 'NoSuchKey');
        const size = current.body.length;
        const range = req.headers.range ?? '';
        const span = /^bytes=(\d+)-(\d+)$/.exec(range);
        const suffix = /^bytes=-(\d+)$/.exec(range);
        if (this.ignoreRange || (span === null && suffix === null)) {
          return ok({ etag: current.etag }, current.body);
        }
        const start = span !== null ? Number(span[1]) : Math.max(0, size - Number(suffix![1]));
        const end = span !== null ? Math.min(Number(span[2]), size - 1) : size - 1;
        if (start >= size) return error(416, 'InvalidRange');
        const slice = current.body.subarray(start, end + 1);
        return {
          status: 206,
          headers: {
            etag: current.etag,
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${size}`,
          },
          body: slice,
        };
      }
    }
  }
}

const GEN: GenKey = { segment: 's', generation: 0 };
const OBJECT_KEY = '_default/segments/s.0.crbm';
const BYTES = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

type Outcome<T> =
  | { readonly value: T; readonly ms: number }
  | { readonly error: unknown; readonly ms: number }
  | { readonly hung: true };

/** Settle `promise`, timing it; a promise still pending after {@link HUNG} ms is reported as hung, not awaited. */
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<{ hung: true }>((resolve) => {
    timer = setTimeout(() => resolve({ hung: true }), HUNG);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value, ms: performance.now() - t0 }),
        (error: unknown) => ({ error, ms: performance.now() - t0 }),
      ),
      hung,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assert a read ended in a `TransientError` that names its request and says it timed out, near `timeoutMs`: not before
 * it, and within a second after it, which a loaded machine meets and a timer set at a multiple of the value does not.
 */
function expectTimedOut<T>(
  outcome: Outcome<T>,
  timeoutMs = TIMEOUT,
  operation: 'GetObject' | 'HeadObject' = 'GetObject',
): void {
  expect(outcome).not.toHaveProperty('hung');
  expect(outcome).not.toHaveProperty('value');
  const { error, ms } = outcome as { error: unknown; ms: number };
  expect(error).toBeInstanceOf(TransientError);
  expect((error as Error).message).toBe(`S3 ${operation} timed out after ${timeoutMs} ms`);
  // A little early is the timer's clock, not the read: Node starts a timer from the event loop's cached time, which
  // a busy loop leaves a few ms behind.
  expect(ms).toBeGreaterThanOrEqual(timeoutMs - 25);
  expect(ms).toBeLessThan(timeoutMs + 1_000);
}

/** Wait (bounded) until every stalled response's connection has closed: a timed-out read let go of its socket. */
async function expectReleased(stub: StubS3): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (stub.stalled.size > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(stub.stalled.size).toBe(0);
}

describe('S3: a read is cut off at readTimeoutMs', LIMIT, () => {
  let stub: StubS3;
  let backend: S3Storage;

  beforeEach(async () => {
    stub = new StubS3();
    await stub.start();
    stub.objects.set(OBJECT_KEY, { body: BYTES, etag: '"seed"' });
    backend = new S3Storage({ ...stub.options(), readTimeoutMs: TIMEOUT });
  });
  afterEach(async () => {
    backend.client.destroy();
    await stub.stop();
  });

  it('a GET whose headers never come is a TransientError at the timeout, sent once', async () => {
    stub.arm('GetObject', { kind: 'no-headers' });

    expectTimedOut(await settle(backend.storage.getRange(GEN, 0, 8)));
    await expectReleased(stub);
    // The SDK does not send an aborted request again: the retry is the store's to make.
    await new Promise((resolve) => setTimeout(resolve, 2 * TIMEOUT));
    expect(stub.count('GetObject')).toBe(1);
  });

  it('a GET that sends its headers and then stalls mid-body is a TransientError, and lets go of the socket', async () => {
    stub.arm('GetObject', { kind: 'mid-body' });

    expectTimedOut(await settle(backend.storage.getRange(GEN, 0, 32)));
    await expectReleased(stub);
  });

  it('a tail GET that stalls mid-body is a TransientError', async () => {
    stub.arm('GetObject', { kind: 'mid-body' });

    expectTimedOut(await settle(backend.storage.getTail(GEN, 32)));
    await expectReleased(stub);
  });

  it('a HEAD that stalls is a TransientError', async () => {
    stub.arm('HeadObject', { kind: 'no-headers' });

    expectTimedOut(await settle(backend.storage.getTail(GEN, 0)), TIMEOUT, 'HeadObject');
    await expectReleased(stub);
  });

  it('the HEAD a tail read falls back to, for a backend that ignores Range, is timed too', async () => {
    stub.ignoreRange = true;
    stub.arm('HeadObject', { kind: 'no-headers' });

    expectTimedOut(await settle(backend.storage.getTail(GEN, BYTES.length)), TIMEOUT, 'HeadObject');
    expect(stub.count('GetObject')).toBe(1);
    expect(stub.count('HeadObject')).toBe(1);
  });

  it('a fast read is unaffected', async () => {
    const range = await settle(backend.storage.getRange(GEN, 8, 4));
    expect(range).toMatchObject({ value: new Uint8Array([8, 9, 10, 11]) });
    const tail = await settle(backend.storage.getTail(GEN, 4));
    expect(tail).toMatchObject({ value: { bytes: new Uint8Array([60, 61, 62, 63]), size: 64 } });
    const head = await settle(backend.storage.getTail(GEN, 0));
    expect(head).toMatchObject({ value: { size: 64 } });
  });

  it('a read that answers late but inside the timeout succeeds', async () => {
    const slow = new S3Storage({ ...stub.options(), readTimeoutMs: 2_000 });
    try {
      stub.arm('GetObject', { kind: 'delay', ms: 3 * TIMEOUT });
      const range = await settle(slow.storage.getRange(GEN, 0, 4));
      expect(range).toMatchObject({ value: new Uint8Array([0, 1, 2, 3]) });
    } finally {
      slow.client.destroy();
    }
  });

  it('readTimeoutMs: 0 turns it off: a read slower than any timeout here completes', async () => {
    const untimed = new S3Storage({ ...stub.options(), readTimeoutMs: 0 });
    try {
      stub.arm('GetObject', { kind: 'delay', ms: 3 * TIMEOUT });
      const range = await settle(untimed.storage.getRange(GEN, 0, 4));
      expect(range).toMatchObject({ value: new Uint8Array([0, 1, 2, 3]) });
      stub.arm('HeadObject', { kind: 'delay', ms: 3 * TIMEOUT });
      expect(await settle(untimed.storage.getTail(GEN, 0))).toMatchObject({ value: { size: 64 } });
    } finally {
      untimed.client.destroy();
    }
  });

  it('is off by default: each read is sent with no options, and a stalled one is not cut off', async () => {
    const defaulted = new S3Storage(stub.options());
    await defaulted.registry.create({ segment: 's' }, { currentGen: 0 });
    const send = vi.spyOn(defaulted.client, 'send');
    try {
      expect(await settle(defaulted.storage.getRange(GEN, 0, 4))).toHaveProperty('value');
      expect(await settle(defaulted.storage.getTail(GEN, 0))).toHaveProperty('value');
      expect(await settle(defaulted.registry.get({ segment: 's' }))).toHaveProperty('value');
      expect(send).toHaveBeenCalledTimes(3);
      // No options at all, not an options object without a signal: nothing is timed.
      for (const call of send.mock.calls) expect(call).toHaveLength(2);
      for (const call of send.mock.calls) expect(call[1]).toBeUndefined();

      stub.arm('GetObject', { kind: 'no-headers' });
      const stalled = defaulted.storage.getRange(GEN, 0, 4);
      stalled.catch(() => {}); // it ends when the client is destroyed below
      const after = await Promise.race([
        stalled.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise((resolve) => setTimeout(() => resolve('still pending'), 5 * TIMEOUT)),
      ]);
      expect(after).toBe('still pending');
    } finally {
      defaulted.client.destroy();
    }
  });

  it("reaches a client the caller built, and leaves the caller's own requests on it untimed", async () => {
    const own = stub.client();
    const stack = own.middlewareStack.identify();
    const mine = new S3Storage({ bucket: BUCKET, client: own, readTimeoutMs: TIMEOUT });
    try {
      stub.arm('GetObject', { kind: 'no-headers' });
      expectTimedOut(await settle(mine.storage.getRange(GEN, 0, 4)));
      expect(mine.client).toBe(own);
      expect(own.middlewareStack.identify()).toEqual(stack);
      // The caller's own read through the same client, slower than the backend's timeout, is not cut off.
      stub.arm('GetObject', { kind: 'delay', ms: 3 * TIMEOUT });
      const res = await settle(own.send(new GetObjectCommand({ Bucket: BUCKET, Key: OBJECT_KEY })));
      expect(res).toHaveProperty('value');
    } finally {
      own.destroy();
    }
  });

  it('fires near its configured value: a 1,000 ms timeout ends a stalled read well before 3,000 ms', async () => {
    const second = new S3Storage({ ...stub.options(), readTimeoutMs: 1_000 });
    try {
      stub.arm('GetObject', { kind: 'no-headers' });
      expectTimedOut(await settle(second.storage.getRange(GEN, 0, 4)), 1_000);
    } finally {
      second.client.destroy();
    }
  });

  it("the SDK's own retry of a 5xx runs inside one timed read", async () => {
    const timed = new S3Storage({ ...stub.options(), readTimeoutMs: 2_000 });
    try {
      stub.arm('GetObject', { kind: 'status', status: 500 });
      const range = await settle(timed.storage.getRange(GEN, 0, 4));
      expect(range).toMatchObject({ value: new Uint8Array([0, 1, 2, 3]) });
      expect(stub.count('GetObject')).toBe(2); // the 500, then the SDK's retry, under the one timer
    } finally {
      timed.client.destroy();
    }
  });

  it('a 5xx and then a stall: the timer runs from the first attempt, not from the retry', async () => {
    const timed = new S3Storage({ ...stub.options(), readTimeoutMs: 1_000 });
    try {
      stub.arm('GetObject', { kind: 'status', status: 500 });
      stub.arm('GetObject', { kind: 'no-headers' });
      expectTimedOut(await settle(timed.storage.getRange(GEN, 0, 4)), 1_000);
      expect(stub.count('GetObject')).toBe(2);
    } finally {
      timed.client.destroy();
    }
  });

  it('readTimeoutMs: 0 sends no options, so a cacheMiddleware client keeps reusing its handler', async () => {
    const resolve = vi.spyOn(GetObjectCommand.prototype, 'resolveMiddleware');
    const reads = async (readTimeoutMs: number): Promise<number> => {
      const client = stub.client({ cacheMiddleware: true });
      try {
        const b = new S3Storage({ bucket: BUCKET, client, readTimeoutMs });
        resolve.mockClear();
        for (let i = 0; i < 3; i++) await b.storage.getRange(GEN, 0, 4);
        return resolve.mock.calls.length;
      } finally {
        client.destroy();
      }
    };
    try {
      expect(await reads(0)).toBe(1); // resolved once, then the cached handler
      expect(await reads(TIMEOUT * 50)).toBe(3); // a timed read is sent with options, so it resolves each time
    } finally {
      resolve.mockRestore();
    }
  });

  it('the S3StorageDriver takes it directly', async () => {
    const client = stub.client();
    try {
      const driver = new S3StorageDriver({ client, bucket: BUCKET, readTimeoutMs: TIMEOUT });
      stub.arm('GetObject', { kind: 'no-headers' });
      expectTimedOut(await settle(driver.getRange(GEN, 0, 4)));
    } finally {
      client.destroy();
    }
  });
});

describe('S3: writes, deletes and listings are not timed', LIMIT, () => {
  let stub: StubS3;
  let backend: S3Storage;

  beforeEach(async () => {
    stub = new StubS3();
    await stub.start();
    backend = new S3Storage({ ...stub.options(), readTimeoutMs: TIMEOUT, partBytes: FIVE_MIB });
  });
  afterEach(async () => {
    backend.client.destroy();
    await stub.stop();
  });

  /** Write each of `parts` to the sink in turn: a write that reaches `partBytes` uploads a part. */
  const put = (...parts: Uint8Array[]) =>
    backend.storage.putImmutable(GEN, async (sink) => {
      for (const part of parts) await sink.write(part);
    });

  it('a single PutObject slower than the read timeout succeeds', async () => {
    stub.arm('PutObject', { kind: 'delay', ms: 3 * TIMEOUT });

    const outcome = await settle(put(new Uint8Array([1, 2, 3])));
    expect(outcome).toMatchObject({ value: { size: 3 } });
    expect((outcome as { ms: number }).ms).toBeGreaterThanOrEqual(3 * TIMEOUT - 25);
    expect(stub.count('PutObject')).toBe(1);
    expect(stub.cut).toEqual([]);
  });

  it('a multipart upload whose every request is slower than the read timeout succeeds', async () => {
    for (const op of ['CreateMultipartUpload', 'UploadPart', 'CompleteMultipartUpload'] as const) {
      stub.arm(op, { kind: 'delay', ms: 3 * TIMEOUT }, { times: 2 });
    }

    const outcome = await settle(put(new Uint8Array(FIVE_MIB), new Uint8Array(1)));
    expect(outcome).toMatchObject({ value: { size: FIVE_MIB + 1 } });
    expect(stub.count('UploadPart')).toBe(2);
    expect(stub.count('CompleteMultipartUpload')).toBe(1);
    expect(stub.objects.get(OBJECT_KEY)?.body.length).toBe(FIVE_MIB + 1);
    expect(stub.cut).toEqual([]);
  });

  it("a failed upload's AbortMultipartUpload, slower than the read timeout, is sent in full", async () => {
    stub.arm('AbortMultipartUpload', { kind: 'delay', ms: 3 * TIMEOUT });
    const failed = new Error('the writer failed after one part');

    const outcome = await settle(
      backend.storage.putImmutable(GEN, async (sink) => {
        await sink.write(new Uint8Array(FIVE_MIB)); // one part uploaded, so there is an upload to abort
        throw failed;
      }),
    );
    expect(outcome).toMatchObject({ error: failed });
    expect((outcome as { ms: number }).ms).toBeGreaterThanOrEqual(3 * TIMEOUT - 25);
    expect(stub.answered).toContain('AbortMultipartUpload');
    expect(stub.cut).toEqual([]);
  });

  it('a DeleteObject slower than the read timeout succeeds', async () => {
    stub.objects.set(OBJECT_KEY, { body: BYTES, etag: '"seed"' });
    stub.arm('DeleteObject', { kind: 'delay', ms: 3 * TIMEOUT });

    const outcome = await settle(backend.storage.delete(GEN));
    expect(outcome).toHaveProperty('value');
    expect((outcome as { ms: number }).ms).toBeGreaterThanOrEqual(3 * TIMEOUT - 25);
    expect(stub.objects.has(OBJECT_KEY)).toBe(false);
    expect(stub.cut).toEqual([]);
  });

  it("the storage's listing, slower than the read timeout, succeeds", async () => {
    stub.objects.set(OBJECT_KEY, { body: BYTES, etag: '"seed"' });
    stub.arm('ListObjectsV2', { kind: 'delay', ms: 3 * TIMEOUT });

    const listed = async (): Promise<number[]> => {
      const out: number[] = [];
      for await (const key of backend.storage.list({ segment: 's' })) out.push(key.generation);
      return out;
    };
    expect(await settle(listed())).toMatchObject({ value: [0] });
    expect(stub.cut).toEqual([]);
  });

  it("the registry's create, slower than the read timeout, succeeds", async () => {
    stub.arm('PutObject', { kind: 'delay', ms: 3 * TIMEOUT });

    const outcome = await settle(backend.registry.create({ segment: 's' }, { currentGen: 0 }));
    expect(outcome).toMatchObject({ value: { token: '0' } });
    expect(stub.cut).toEqual([]);
  });

  it("the registry's compare-and-swap and delete, slower than the read timeout, succeed", async () => {
    const { token } = await backend.registry.create({ segment: 's' }, { currentGen: 0 });
    stub.arm('PutObject', { kind: 'delay', ms: 3 * TIMEOUT });
    const swapped = await settle(
      backend.registry.compareAndSwap({ segment: 's' }, token, { currentGen: 1 }),
    );
    expect(swapped).toMatchObject({ value: { token: '1' } });
    expect(await backend.registry.get({ segment: 's' })).toMatchObject({ currentGen: 1 });

    stub.arm('PutObject', { kind: 'delay', ms: 3 * TIMEOUT }); // the tombstone
    expect(await settle(backend.registry.delete({ segment: 's' }))).toHaveProperty('value');
    expect(await backend.registry.get({ segment: 's' })).toBeNull();
    expect(stub.cut).toEqual([]);
  });

  it("the registry's listing, slower than the read timeout, succeeds", async () => {
    await backend.registry.create({ segment: 's' }, { currentGen: 0 });
    stub.arm('ListObjectsV2', { kind: 'delay', ms: 3 * TIMEOUT });

    const listed = async (): Promise<string[]> => {
      const out: string[] = [];
      for await (const row of backend.registry.list()) out.push(row.segment);
      return out;
    };
    expect(await settle(listed())).toMatchObject({ value: ['s'] });
    expect(stub.cut).toEqual([]);
  });
});

describe("S3: the registry's read is timed too", LIMIT, () => {
  let stub: StubS3;
  let backend: S3Storage;

  beforeEach(async () => {
    stub = new StubS3();
    await stub.start();
    backend = new S3Storage({ ...stub.options(), readTimeoutMs: TIMEOUT });
    await backend.registry.create({ segment: 's' }, { currentGen: 0 });
  });
  afterEach(async () => {
    backend.client.destroy();
    await stub.stop();
  });

  it('a registry GET whose headers never come is a TransientError', async () => {
    stub.arm('GetObject', { kind: 'no-headers' });

    expectTimedOut(await settle(backend.registry.get({ segment: 's' })));
    await expectReleased(stub);
  });

  it('a registry GET that stalls mid-body is a TransientError', async () => {
    stub.arm('GetObject', { kind: 'mid-body' });

    expectTimedOut(await settle(backend.registry.get({ segment: 's' })));
    await expectReleased(stub);
  });

  // Not a timeout: the connection drops part-way through the body, with the timeout off, and the store's read retry
  // must see a fault it repeats rather than the SDK's raw error.
  it('a registry GET whose body is cut off is a TransientError, with or without a timeout', async () => {
    for (const readTimeoutMs of [0, 50 * TIMEOUT]) {
      const cutting = new S3Storage({ ...stub.options(), readTimeoutMs });
      try {
        stub.arm('GetObject', { kind: 'cut-body' });
        const outcome = await settle(cutting.registry.get({ segment: 's' }));
        expect((outcome as { error?: unknown }).error).toBeInstanceOf(TransientError);
      } finally {
        cutting.client.destroy();
      }
    }
  });

  it('a fast registry read is unaffected', async () => {
    expect(await settle(backend.registry.get({ segment: 's' }))).toMatchObject({
      value: { currentGen: 0 },
    });
  });

  // A row whose response declares more than the cap is refused before its body is read. The refusal must let go of
  // the connection too, with the timeout off and with one set, since the read has settled and no timer will abort it.
  it.each([0, 50 * TIMEOUT])(
    'three rows refused for their size leave no connection open (readTimeoutMs: %s)',
    async (readTimeoutMs) => {
      const refusing = new S3Storage({ ...stub.options(), readTimeoutMs });
      try {
        for (let i = 0; i < 3; i++) {
          stub.arm('GetObject', { kind: 'oversize' });
          const outcome = await settle(refusing.registry.get({ segment: 's' }));
          expect((outcome as { error?: unknown }).error).toBeInstanceOf(IntegrityError);
        }
        await expectReleased(stub);
      } finally {
        refusing.client.destroy();
      }
    },
  );

  it('the S3RegistryDriver takes it directly', async () => {
    const client = stub.client();
    try {
      const registry = new S3RegistryDriver({ client, bucket: BUCKET, readTimeoutMs: TIMEOUT });
      stub.arm('GetObject', { kind: 'no-headers' });
      expectTimedOut(await settle(registry.get({ segment: 's' })));
    } finally {
      client.destroy();
    }
  });
});

describe("S3: through the store, a stalled read is the store's retry to repeat", LIMIT, () => {
  let stub: StubS3;
  let backend: S3Storage;

  beforeEach(async () => {
    stub = new StubS3();
    await stub.start();
    backend = new S3Storage({ ...stub.options(), readTimeoutMs: TIMEOUT });
    await new CloudRoaring({ storage: backend }).load({ segment: 's' }, [1, 2, 70_000]);
  });
  afterEach(async () => {
    backend.client.destroy();
    await stub.stop();
  });

  it('one stalled chunk read, then a fast one: the read succeeds', async () => {
    const store = new CloudRoaring({ storage: backend });
    const before = stub.count('GetObject', '.crbm');
    stub.arm('GetObject', { kind: 'no-headers' }, { keyIncludes: '.crbm' });

    const outcome = await settle(store.segment('s').has(70_000));
    expect(outcome).toMatchObject({ value: true });
    expect((outcome as { ms: number }).ms).toBeGreaterThanOrEqual(TIMEOUT - 25);
    // The stalled request, then the store's retry of it, then whatever else the read needed.
    expect(stub.count('GetObject', '.crbm') - before).toBeGreaterThanOrEqual(2);
    await expectReleased(stub);
  });

  it('with the store retry off, the same stall reaches the caller as a TransientError', async () => {
    const store = new CloudRoaring({ storage: backend, retry: false });
    stub.arm('GetObject', { kind: 'no-headers' }, { keyIncludes: '.crbm' });

    expectTimedOut(await settle(store.segment('s').has(70_000)));
  });
});

describe('S3: readTimeoutMs is validated where the backend is built', () => {
  const client = {} as unknown as S3Client;
  // 2 ** 31 is a safe integer, but a Node timer that long fires after 1 ms instead, so it is refused too.
  const invalid = [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 31] as const;
  const REFUSAL = /readTimeoutMs must be a non-negative safe integer/;

  it.each(invalid)('refuses %s', (readTimeoutMs) => {
    expect(() => new S3Storage({ bucket: BUCKET, client, readTimeoutMs })).toThrow(ValidationError);
    expect(() => new S3Storage({ bucket: BUCKET, client, readTimeoutMs })).toThrow(REFUSAL);
    expect(() => new S3StorageDriver({ client, bucket: BUCKET, readTimeoutMs })).toThrow(
      ValidationError,
    );
    expect(() => new S3RegistryDriver({ client, bucket: BUCKET, readTimeoutMs })).toThrow(
      ValidationError,
    );
  });

  it('refuses a value that is not a number', () => {
    const readTimeoutMs = '100' as unknown as number;
    expect(() => new S3Storage({ bucket: BUCKET, client, readTimeoutMs })).toThrow(ValidationError);
    expect(() => new S3Storage({ bucket: BUCKET, client, readTimeoutMs })).toThrow(REFUSAL);
  });

  it.each([0, 1, 2_000, 2 ** 31 - 1])('accepts %s', (readTimeoutMs) => {
    expect(() => new S3Storage({ bucket: BUCKET, client, readTimeoutMs })).not.toThrow();
  });
});

describe('S3: a read leaves no timer behind', () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  // Under node_modules so the bundle resolves `@aws-sdk/client-s3` from the repo, and out of git's way.
  const CACHE = `${ROOT}node_modules/.cache`;
  let outDir = '';
  let child = '';
  let home = '';
  let stub: StubS3;

  beforeAll(async () => {
    mkdirSync(CACHE, { recursive: true });
    outDir = mkdtempSync(`${CACHE}/s3-read-timeout-`);
    home = mkdtempSync(`${tmpdir()}/s3-read-timeout-home-`);
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
    stub = new StubS3();
    await stub.start();
    stub.objects.set(OBJECT_KEY, { body: BYTES, etag: '"seed"' });
    const seeding = new S3Storage(stub.options());
    await seeding.registry.create({ segment: 's' }, { currentGen: 0 });
    seeding.client.destroy();
  }, 30_000);
  afterAll(async () => {
    await stub.stop();
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
      // A minimal environment, so nothing the developer or CI exports (a profile, credentials) reaches the child.
      const env = { PATH: process.env.PATH ?? '', HOME: home };
      const proc = spawn(process.execPath, [child, stub.endpoint, call], {
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
  it.each(['range', 'tail', 'head', 'registry'] as const)(
    'a process that makes one fast %s read, with a long timeout, exits promptly',
    async (call) => {
      const run = await runChild(call, 15_000);
      expect(run.killed).toBe(false);
      expect(run.code).toBe(0);
      expect(run.out).toMatch(/"ok"/);
    },
    30_000,
  );

  // A read that fails clears its timer too: the same minute-long timeout, on a read the stub answers with a 404.
  it.each(['missing', 'head-missing'] as const)(
    'a process whose one %s read fails, with a long timeout, exits promptly',
    async (call) => {
      const run = await runChild(call, 15_000);
      expect(run.killed).toBe(false);
      expect(run.out).toMatch(/"error":"NotFoundError"/);
      expect(run.code).toBe(1);
    },
    30_000,
  );
});
