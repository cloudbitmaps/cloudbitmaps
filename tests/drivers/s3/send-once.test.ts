import { Readable } from 'node:stream';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from '@/s3/backend';
import { S3StorageDriver } from '@/s3/storage';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';
import { CREATED_TOKEN, tokenAfter } from '../../helpers/tokens';

/**
 * A conditional write is sent once, through a real `S3Client`.
 *
 * The client here is the SDK's own, with its default retry strategy, signing and checksums; only the transport under
 * it is a stub, so what these tests see is what the SDK does. The stub is a bucket in memory that honours
 * `If-None-Match: *` and `If-Match`, and it can be told to apply the next matching request and then lose its response,
 * which is what a timeout or a reset connection does to a write the service had already applied. The SDK's retry
 * would re-send that write, meet the write itself, and get 412; so a driver that let it would report a lost race for
 * a write that landed. Each write test asserts the request count as well as the error, because the error alone could
 * come from either.
 */

const BUCKET = 'b';
const FIVE_MIB = 5 * 1024 * 1024;

type Operation =
  | 'PutObject'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'GetObject'
  | 'DeleteObject';

interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

interface StubResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Readable;
}

function operationOf(req: StubRequest): Operation {
  const q = req.query ?? {};
  if (req.method === 'PUT') return 'uploadId' in q ? 'UploadPart' : 'PutObject';
  if (req.method === 'POST')
    return 'uploads' in q ? 'CreateMultipartUpload' : 'CompleteMultipartUpload';
  if (req.method === 'DELETE') return 'uploadId' in q ? 'AbortMultipartUpload' : 'DeleteObject';
  if (req.method === 'GET') return 'GetObject';
  throw new Error(`the stub does not serve ${req.method} ${req.path}`);
}

async function bytesOf(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const respond = (statusCode: number, headers: Record<string, string>, body = ''): StubResponse => ({
  statusCode,
  headers,
  body: Readable.from([Buffer.from(body)]),
});

const s3Error = (statusCode: number, code: string): StubResponse =>
  respond(
    statusCode,
    { 'content-type': 'application/xml' },
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  );

/** What a dropped connection looks like to the SDK: Node's socket error, which the SDK counts as transient. */
const connectionReset = (): Error =>
  Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

/** A bucket in memory behind the SDK's transport seam, with one armed fault at a time. */
class StubBucket {
  readonly objects = new Map<string, { body: Buffer; etag: string }>();
  private readonly uploads = new Map<string, Map<number, Buffer>>();
  private readonly sent: Operation[] = [];
  private seq = 0;
  private fault: { op: Operation; kind: 'lose-response' | 'drop' | 'clock-skew' } | undefined;

  /** Apply the next `op`, then lose its response. */
  loseResponseOf(op: Operation): void {
    this.fault = { op, kind: 'lose-response' };
  }

  /** Fail the next `op` before it is applied — a request that never arrived. */
  failBeforeApplying(op: Operation): void {
    this.fault = { op, kind: 'drop' };
  }

  /** Refuse the next `op` unapplied, as S3 refuses a signature made by a clock ten minutes behind its own. */
  refuseForClockSkew(op: Operation): void {
    this.fault = { op, kind: 'clock-skew' };
  }

  count(op: Operation): number {
    return this.sent.filter((o) => o === op).length;
  }

  /** The transport the SDK calls: the whole of what an `S3Client` needs from its `requestHandler`. */
  readonly handler = {
    handle: async (req: StubRequest): Promise<{ response: StubResponse }> => {
      const op = operationOf(req);
      this.sent.push(op);
      const fault = this.fault?.op === op ? this.fault : undefined;
      if (fault !== undefined) this.fault = undefined;
      if (fault?.kind === 'drop') throw connectionReset();
      if (fault?.kind === 'clock-skew') {
        const serverTime = new Date(Date.now() + 10 * 60_000);
        return {
          response: {
            ...s3Error(403, 'RequestTimeTooSkewed'),
            headers: { 'content-type': 'application/xml', date: serverTime.toUTCString() },
          },
        };
      }
      const response = await this.apply(op, req);
      if (fault?.kind === 'lose-response') throw connectionReset();
      return { response };
    },
    updateHttpClientConfig: (): void => {},
    httpHandlerConfigs: (): Record<string, never> => ({}),
  };

  /** A real `S3Client` over this bucket: the SDK's default retry, signing and checksums, and this transport. */
  client(
    extra: { cacheMiddleware?: boolean; maxAttempts?: number; retryStrategy?: unknown } = {},
  ): S3Client {
    return new S3Client({
      region: 'us-east-1',
      endpoint: 'http://s3.stub.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'stub', secretAccessKey: 'stub' },
      requestHandler: this.handler as never,
      ...(extra as object),
    });
  }

  private async apply(op: Operation, req: StubRequest): Promise<StubResponse> {
    const key = decodeURIComponent(req.path.slice(`/${BUCKET}/`.length));
    const q = req.query ?? {};
    const header = (name: string): string | undefined =>
      req.headers[name] ?? req.headers[name.toLowerCase()];
    const conditional = (): StubResponse | undefined => {
      const current = this.objects.get(key);
      if (header('if-none-match') === '*' && current !== undefined) {
        return s3Error(412, 'PreconditionFailed');
      }
      const ifMatch = header('if-match');
      if (ifMatch !== undefined && current?.etag !== ifMatch)
        return s3Error(412, 'PreconditionFailed');
      return undefined;
    };
    const store = (body: Buffer): string => {
      const etag = `"e${++this.seq}"`;
      this.objects.set(key, { body, etag });
      return etag;
    };
    switch (op) {
      case 'PutObject': {
        const refused = conditional();
        if (refused !== undefined) return refused;
        return respond(200, { etag: store(await bytesOf(req.body)) });
      }
      case 'CreateMultipartUpload': {
        const id = `u${++this.seq}`;
        this.uploads.set(id, new Map());
        return respond(
          200,
          { 'content-type': 'application/xml' },
          `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case 'UploadPart': {
        const parts = this.uploads.get(String(q.uploadId));
        if (parts === undefined) return s3Error(404, 'NoSuchUpload');
        parts.set(Number(q.partNumber), await bytesOf(req.body));
        return respond(200, { etag: `"p${String(q.partNumber)}"` });
      }
      case 'CompleteMultipartUpload': {
        await bytesOf(req.body);
        // The precondition first, so a replayed completion meets the object it made. Whether a service checks the
        // precondition or the upload id first on a replay is not what these tests are about: they count requests.
        const refused = conditional();
        if (refused !== undefined) return refused;
        const parts = this.uploads.get(String(q.uploadId));
        if (parts === undefined) return s3Error(404, 'NoSuchUpload');
        const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
        this.uploads.delete(String(q.uploadId));
        const etag = store(Buffer.concat(ordered));
        return respond(
          200,
          { 'content-type': 'application/xml' },
          `<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      case 'AbortMultipartUpload': {
        this.uploads.delete(String(q.uploadId));
        return respond(204, {});
      }
      case 'GetObject': {
        const current = this.objects.get(key);
        if (current === undefined) return s3Error(404, 'NoSuchKey');
        const range = /^bytes=(\d+)-(\d+)$/.exec(header('range') ?? '');
        if (range === null) {
          return {
            statusCode: 200,
            headers: { etag: current.etag, 'content-length': String(current.body.length) },
            body: Readable.from([current.body]),
          };
        }
        const [start, end] = [Number(range[1]), Number(range[2])];
        const slice = current.body.subarray(start, end + 1);
        return {
          statusCode: 206,
          headers: {
            etag: current.etag,
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${current.body.length}`,
          },
          body: Readable.from([slice]),
        };
      }
      case 'DeleteObject': {
        this.objects.delete(key);
        return respond(204, {});
      }
    }
  }
}

const GEN: GenKey = { segment: 's', generation: 0 };
const REF = { segment: 's' };

const put = (driver: S3StorageDriver, bytes: Uint8Array, key: GenKey = GEN) =>
  driver.putImmutable(key, async (sink) => {
    await sink.write(bytes);
  });

describe('S3: a conditional write is sent once, whatever the SDK retry would do', () => {
  it('a write-once PutObject that lands and loses its response throws TransientError', async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    bucket.loseResponseOf('PutObject');

    const err = await put(backend.storage as S3StorageDriver, new Uint8Array([1, 2, 3])).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(bucket.objects.size).toBe(1); // it landed: the caller has to find that out, and now can
  });

  it('a multipart CompleteMultipartUpload that lands and loses its response throws TransientError', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({
      client: bucket.client(),
      bucket: BUCKET,
      partBytes: FIVE_MIB,
    });
    bucket.loseResponseOf('CompleteMultipartUpload');

    const err = await put(driver, new Uint8Array(FIVE_MIB + 1)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(bucket.count('CompleteMultipartUpload')).toBe(1);
    expect(bucket.objects.size).toBe(1);
  });

  it("the registry's create that lands and loses its response throws TransientError", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    bucket.loseResponseOf('PutObject');

    const err = await backend.registry.create(REF, { currentGen: 0 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(await backend.registry.get(REF)).toMatchObject({
      currentGen: 0,
      token: expect.stringMatching(CREATED_TOKEN),
    });
  });

  it("the registry's compareAndSwap that lands and loses its response throws TransientError", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    bucket.loseResponseOf('PutObject');

    const err = await backend.registry
      .compareAndSwap(REF, token, { currentGen: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(2); // the create, then the swap once
    expect(await backend.registry.get(REF)).toMatchObject({
      currentGen: 1,
      token: tokenAfter(token),
    });
  });

  // The registry's delete writes a tombstone under `If-Match`, so it is a conditional write like the others. It is
  // idempotent, so a re-run settles it whichever way the first attempt went.
  it("the registry's delete writes its tombstone once, and a re-run settles it", async () => {
    const bucket = new StubBucket();
    const backend = new S3Storage({ bucket: BUCKET, client: bucket.client() });
    await backend.registry.create(REF, { currentGen: 0 });
    bucket.loseResponseOf('PutObject');

    await expect(backend.registry.delete(REF)).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(2); // the create, then the tombstone once
    expect(await backend.registry.get(REF)).toBeNull();
    await backend.registry.delete(REF);
    expect(bucket.count('PutObject')).toBe(2); // already a tombstone: nothing left to write
  });

  it('a conditional write refused for a skewed clock throws TransientError, unapplied', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    bucket.refuseForClockSkew('PutObject');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(bucket.objects.size).toBe(0);
    // The SDK corrected the client's clock on the refusal, so the caller's re-run is signed right and lands.
    await put(driver, new Uint8Array([1]));
    expect(bucket.objects.size).toBe(1);
  });

  it('a precondition that really fails is still WriteConflictError', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1]));

    await expect(put(driver, new Uint8Array([2]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(bucket.count('PutObject')).toBe(2);
  });

  it('holds for a caller-supplied client with more attempts and a cached middleware stack', async () => {
    const bucket = new StubBucket();
    const client = bucket.client({ cacheMiddleware: true, maxAttempts: 5 });
    // A plain PutObject through the same client first, so the client caches a handler for the class, retry in it.
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'other', Body: new Uint8Array([9]) }),
    );
    const driver = new S3StorageDriver({ client, bucket: BUCKET });
    bucket.loseResponseOf('PutObject');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(2); // the plain one, then the conditional one once
  });
});

describe('S3: a caller-supplied retry strategy does not reach a conditional write', () => {
  /** A strategy that grants the first retry at once and counts how often it is asked; a second ask is refused. */
  function eagerStrategy(): { strategy: unknown; asked: () => number } {
    let asked = 0;
    const token = { getRetryCount: () => asked, getRetryDelay: () => 0 };
    return {
      asked: () => asked,
      strategy: {
        acquireInitialRetryToken: async () => token,
        refreshRetryTokenForRetry: async () => {
          asked += 1;
          if (asked > 1) throw new Error('retry budget spent');
          return token;
        },
        recordSuccess: () => {},
      },
    };
  }

  it('sends the write once, and never asks the strategy', async () => {
    const bucket = new StubBucket();
    const { strategy, asked } = eagerStrategy();
    const driver = new S3StorageDriver({
      client: bucket.client({ retryStrategy: strategy }),
      bucket: BUCKET,
    });
    bucket.loseResponseOf('PutObject');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(bucket.count('PutObject')).toBe(1);
    expect(asked()).toBe(0);
  });

  it('still lets that strategy retry a read', async () => {
    const bucket = new StubBucket();
    const { strategy, asked } = eagerStrategy();
    const driver = new S3StorageDriver({
      client: bucket.client({ retryStrategy: strategy }),
      bucket: BUCKET,
    });
    await put(driver, new Uint8Array([1, 2, 3, 4]));
    bucket.failBeforeApplying('GetObject');

    await expect(driver.getRange(GEN, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(bucket.count('GetObject')).toBe(2);
    expect(asked()).toBe(1);
  });
});

describe('S3: everything else keeps the SDK retry', () => {
  it('a read retries a dropped connection', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1, 2, 3, 4]));
    bucket.failBeforeApplying('GetObject');

    await expect(driver.getRange(GEN, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(bucket.count('GetObject')).toBe(2);
  });

  it('a delete retries a dropped connection', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({ client: bucket.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1]));
    bucket.failBeforeApplying('DeleteObject');

    await driver.delete(GEN);
    expect(bucket.count('DeleteObject')).toBe(2);
    expect(bucket.objects.size).toBe(0);
  });

  it('a multipart upload’s part upload retries a dropped connection, and the upload still completes', async () => {
    const bucket = new StubBucket();
    const driver = new S3StorageDriver({
      client: bucket.client(),
      bucket: BUCKET,
      partBytes: FIVE_MIB,
    });
    bucket.failBeforeApplying('UploadPart');

    await put(driver, new Uint8Array(FIVE_MIB + 1));
    expect(bucket.count('UploadPart')).toBe(2); // the part, sent again after the drop
    expect(bucket.count('CompleteMultipartUpload')).toBe(1);
    expect(bucket.objects.size).toBe(1);
  });

  it('the caller’s own PutObject through the same client still retries after the driver wrote', async () => {
    const bucket = new StubBucket();
    const client = bucket.client();
    const driver = new S3StorageDriver({ client, bucket: BUCKET });
    await put(driver, new Uint8Array([1]));
    bucket.loseResponseOf('PutObject');

    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'other', Body: new Uint8Array([9]) }),
    );
    expect(bucket.count('PutObject')).toBe(3); // the driver's, then the caller's twice: its retry is intact
  });
});
