import { Readable } from 'node:stream';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * A bucket in memory behind the SDK's transport seam, for tests that want a real `S3Client` (its default retry,
 * signing, checksums, endpoint resolution) and only the transport stubbed. It honours `If-None-Match: *` and
 * `If-Match` on writes and deletes, and can be told to apply the next matching request and then lose its response,
 * which is what a timeout or a reset connection does to a request the service had already applied.
 */

export const BUCKET = 'b';

export type Operation =
  | 'PutObject'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'GetObject'
  | 'ListObjectsV2'
  | 'DeleteObject';

interface StubRequest {
  readonly method: string;
  readonly hostname?: string;
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
  if (req.method === 'GET') return 'list-type' in q ? 'ListObjectsV2' : 'GetObject';
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
export class StubBucket {
  readonly objects = new Map<string, { body: Buffer; etag: string }>();
  private readonly uploads = new Map<string, Map<number, Buffer>>();
  private readonly sent: Operation[] = [];
  /** The `If-Match` each applied `DeleteObject` carried. */
  readonly ifMatchOnDelete: Array<string | undefined> = [];
  /** The host each request the transport received was addressed to, in order: where the SDK resolved the endpoint. */
  readonly hosts: Array<string | undefined> = [];
  private seq = 0;
  private fault:
    | { op: Operation; kind: 'lose-response' | 'drop' | 'clock-skew' }
    | { op: Operation; kind: 'answer'; statusCode: number; code: string }
    | undefined;

  /** Apply the next `op`, then lose its response. */
  loseResponseOf(op: Operation): void {
    this.fault = { op, kind: 'lose-response' };
  }

  /** Fail the next `op` before it is applied — a request that never arrived. */
  failBeforeApplying(op: Operation): void {
    this.fault = { op, kind: 'drop' };
  }

  /** Answer the next `op` with this error, unapplied: what S3 says for an object that is not there, for one. */
  answerWith(op: Operation, statusCode: number, code: string): void {
    this.fault = { op, kind: 'answer', statusCode, code };
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
      this.hosts.push(req.hostname);
      const fault = this.fault?.op === op ? this.fault : undefined;
      if (fault !== undefined) this.fault = undefined;
      if (fault?.kind === 'drop') throw connectionReset();
      if (fault?.kind === 'answer') return { response: s3Error(fault.statusCode, fault.code) };
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
    extra: {
      cacheMiddleware?: boolean;
      maxAttempts?: number;
      retryStrategy?: unknown;
      /** Replaces the stub's own endpoint; `undefined` leaves the client to resolve one, as AWS S3's. */
      endpoint?: string | undefined;
    } = {},
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
    if (op === 'ListObjectsV2') {
      const prefix = String(q.prefix ?? '');
      const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const contents = [...this.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((k) => `<Contents><Key>${esc(k)}</Key></Contents>`)
        .join('');
      return respond(
        200,
        { 'content-type': 'application/xml' },
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
    }
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
        // `If-Match` on a delete is applied as on a write; a delete without one removes whatever is there.
        const refused = conditional();
        if (refused !== undefined) return refused;
        this.ifMatchOnDelete.push(header('if-match'));
        this.objects.delete(key);
        return respond(204, {});
      }
    }
  }
}

/**
 * Make `command` behave as it does in an SDK that predates `member`: the SDK reads an input for the members its model
 * knows, so an unmodelled one is dropped from the request without a word. Patches the command class for every instance,
 * the ones the registry sends and the ones the client probe builds alike, as an older SDK would be. Returns the function
 * that puts the class back; a test calls it in `afterEach`.
 */
export function sdkWithout(
  command: 'DeleteObjectCommand' | 'PutObjectCommand',
  member: 'IfMatch' | 'IfNoneMatch',
): () => void {
  const Class = command === 'DeleteObjectCommand' ? DeleteObjectCommand : PutObjectCommand;
  const original = Class.prototype.resolveMiddleware;
  Class.prototype.resolveMiddleware = function (this: InstanceType<typeof Class>, ...args) {
    type Call = { input: object };
    (
      this as unknown as {
        middlewareStack: { add(middleware: unknown, options: unknown): void };
      }
    ).middlewareStack.add(
      (next: (call: Call) => unknown) => (call: Call) => {
        delete (call.input as Record<string, unknown>)[member];
        return next(call);
      },
      { step: 'initialize', name: `drop-${command}-${member}` },
    );
    return original.apply(this, args);
  } as typeof original;
  return () => {
    Class.prototype.resolveMiddleware = original;
  };
}
