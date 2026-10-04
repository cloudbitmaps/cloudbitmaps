import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';

/**
 * A bucket in memory behind a real `S3Client`'s transport seam, for tests that need to see what the SDK does with an
 * answer: its retry, its signing and its error parsing all run, and only the HTTP layer under them is a stub.
 *
 * It honours `If-None-Match: *` and `If-Match`, keeps user metadata (`x-amz-meta-*`) and answers `HeadObject` with it,
 * and runs multipart uploads. A test arms faults on the requests it chooses, by operation and key: a throttle answer
 * (`503 SlowDown`) with the request applied first, applied later, or not at all; a lost response after applying it;
 * or any S3 error code.
 */

export const STUB_BUCKET = 'b';

export type Operation =
  | 'PutObject'
  | 'HeadObject'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'GetObject'
  | 'DeleteObject'
  | 'ListObjectsV2';

/** What an armed fault does to the request it matches. */
export type FaultKind =
  /** Answer `503 SlowDown` without applying the request. */
  | 'throttle'
  /** Apply the request, then answer `503 SlowDown`. */
  | 'throttle-after-applying'
  /** Answer `503 SlowDown`, and keep the request for the test to apply later (`landHeld`). */
  | 'throttle-and-hold'
  /** Apply the request, then drop the connection without answering. */
  | 'lose-response'
  /** Answer this status and S3 error code without applying the request. */
  | { readonly status: number; readonly code: string };

interface Fault {
  readonly op: Operation;
  readonly key?: (key: string) => boolean;
  readonly kind: FaultKind;
}

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

export interface StoredObject {
  readonly body: Buffer;
  readonly etag: string;
  readonly metadata: Record<string, string>;
}

function operationOf(req: StubRequest): Operation {
  const q = req.query ?? {};
  if (req.method === 'PUT') return 'uploadId' in q ? 'UploadPart' : 'PutObject';
  if (req.method === 'POST')
    return 'uploads' in q ? 'CreateMultipartUpload' : 'CompleteMultipartUpload';
  if (req.method === 'DELETE') return 'uploadId' in q ? 'AbortMultipartUpload' : 'DeleteObject';
  if (req.method === 'HEAD') return 'HeadObject';
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

/** An S3 error answer, as the service sends one: XML with the code, or a bare status for a `HEAD`. */
export const s3Error = (statusCode: number, code: string, head = false): StubResponse =>
  head
    ? respond(statusCode, {})
    : respond(
        statusCode,
        { 'content-type': 'application/xml' },
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      );

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class StubS3Bucket {
  readonly objects = new Map<string, StoredObject>();
  private readonly uploads = new Map<
    string,
    { parts: Map<number, Buffer>; metadata: Record<string, string> }
  >();
  /** Every request, in order: its operation and its key. */
  readonly sent: Array<{ op: Operation; key: string }> = [];
  private seq = 0;
  private faults: Fault[] = [];
  private held: Array<() => Promise<void>> = [];
  /** How a re-sent completion of an upload that already completed is answered: its precondition, or its upload id. */
  completedUploadAnswer: 'precondition' | 'no-such-upload' = 'precondition';

  /** Arm `kind` on the next request for `op` (and, given `key`, on a key it accepts). Faults fire in arming order. */
  arm(op: Operation, kind: FaultKind, key?: (key: string) => boolean): void {
    this.faults.push({ op, kind, ...(key === undefined ? {} : { key }) });
  }

  /** How many requests for `op` (on a key `key` accepts, given one) the stub has seen. */
  count(op: Operation, key?: (key: string) => boolean): number {
    return this.sent.filter((s) => s.op === op && (key === undefined || key(s.key))).length;
  }

  /** Apply every request a `throttle-and-hold` fault kept, in order: a throttled write that lands after all. */
  async landHeld(): Promise<void> {
    const held = this.held;
    this.held = [];
    for (const apply of held) await apply();
  }

  readonly handler = {
    handle: async (req: StubRequest): Promise<{ response: StubResponse }> => {
      const op = operationOf(req);
      const key = decodeURIComponent(req.path.slice(`/${STUB_BUCKET}/`.length));
      this.sent.push({ op, key });
      const at = this.faults.findIndex((f) => f.op === op && (f.key === undefined || f.key(key)));
      const fault = at === -1 ? undefined : this.faults.splice(at, 1)[0];
      const body = await bytesOf(req.body);
      const throttled = (): { response: StubResponse } => ({
        response: s3Error(503, 'SlowDown', op === 'HeadObject'),
      });
      if (fault?.kind === 'throttle') return throttled();
      if (fault?.kind === 'throttle-and-hold') {
        this.held.push(async () => {
          await this.apply(op, key, req, body);
        });
        return throttled();
      }
      if (typeof fault?.kind === 'object') {
        return { response: s3Error(fault.kind.status, fault.kind.code, op === 'HeadObject') };
      }
      const response = await this.apply(op, key, req, body);
      if (fault?.kind === 'throttle-after-applying') return throttled();
      if (fault?.kind === 'lose-response') {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return { response };
    },
    updateHttpClientConfig: (): void => {},
    httpHandlerConfigs: (): Record<string, never> => ({}),
  };

  /** A real `S3Client` over this bucket: the SDK's default retry, signing and checksums, and this transport. */
  client(extra: Record<string, unknown> = {}): S3Client {
    return new S3Client({
      region: 'us-east-1',
      endpoint: 'http://s3.stub.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'stub', secretAccessKey: 'stub' },
      requestHandler: this.handler as never,
      ...extra,
    });
  }

  private async apply(
    op: Operation,
    key: string,
    req: StubRequest,
    body: Buffer,
  ): Promise<StubResponse> {
    const q = req.query ?? {};
    const header = (name: string): string | undefined =>
      req.headers[name] ?? req.headers[name.toLowerCase()];
    const metadataOf = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase().startsWith('x-amz-meta-')) out[k.toLowerCase().slice(11)] = v;
      }
      return out;
    };
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
    const store = (bytes: Buffer, metadata: Record<string, string>): string => {
      const etag = `"e${++this.seq}"`;
      this.objects.set(key, { body: bytes, etag, metadata });
      return etag;
    };
    switch (op) {
      case 'PutObject': {
        const refused = conditional();
        if (refused !== undefined) return refused;
        return respond(200, { etag: store(body, metadataOf()) });
      }
      case 'HeadObject': {
        const current = this.objects.get(key);
        if (current === undefined) return s3Error(404, 'NotFound', true);
        const headers: Record<string, string> = {
          etag: current.etag,
          'content-length': String(current.body.length),
        };
        for (const [k, v] of Object.entries(current.metadata)) headers[`x-amz-meta-${k}`] = v;
        return { statusCode: 200, headers, body: Readable.from([Buffer.alloc(0)]) };
      }
      case 'CreateMultipartUpload': {
        const id = `u${++this.seq}`;
        this.uploads.set(id, { parts: new Map(), metadata: metadataOf() });
        return respond(
          200,
          { 'content-type': 'application/xml' },
          `<InitiateMultipartUploadResult><Bucket>${STUB_BUCKET}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case 'UploadPart': {
        const upload = this.uploads.get(String(q.uploadId));
        if (upload === undefined) return s3Error(404, 'NoSuchUpload');
        upload.parts.set(Number(q.partNumber), body);
        return respond(200, { etag: `"p${String(q.partNumber)}"` });
      }
      case 'CompleteMultipartUpload': {
        const upload = this.uploads.get(String(q.uploadId));
        if (upload === undefined && this.completedUploadAnswer === 'no-such-upload') {
          return s3Error(404, 'NoSuchUpload');
        }
        const refused = conditional();
        if (refused !== undefined) return refused;
        if (upload === undefined) return s3Error(404, 'NoSuchUpload');
        const ordered = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
        this.uploads.delete(String(q.uploadId));
        const etag = store(Buffer.concat(ordered), upload.metadata);
        return respond(
          200,
          { 'content-type': 'application/xml' },
          `<CompleteMultipartUploadResult><Bucket>${STUB_BUCKET}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      case 'AbortMultipartUpload': {
        this.uploads.delete(String(q.uploadId));
        return respond(204, {});
      }
      case 'GetObject': {
        const current = this.objects.get(key);
        if (current === undefined) return s3Error(404, 'NoSuchKey');
        const suffix = /^bytes=-(\d+)$/.exec(header('range') ?? '');
        const range = /^bytes=(\d+)-(\d+)$/.exec(header('range') ?? '');
        if (suffix === null && range === null) {
          return {
            statusCode: 200,
            headers: { etag: current.etag, 'content-length': String(current.body.length) },
            body: Readable.from([current.body]),
          };
        }
        const size = current.body.length;
        const [start, end] =
          suffix !== null
            ? [Math.max(0, size - Number(suffix[1])), size - 1]
            : [Number(range![1]), Math.min(Number(range![2]), size - 1)];
        const slice = current.body.subarray(start, end + 1);
        return {
          statusCode: 206,
          headers: {
            etag: current.etag,
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${size}`,
          },
          body: Readable.from([slice]),
        };
      }
      case 'DeleteObject': {
        this.objects.delete(key);
        return respond(204, {});
      }
      case 'ListObjectsV2': {
        const prefix = String(q.prefix ?? '');
        const contents = [...this.objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(
            ([k, o]) =>
              `<Contents><Key>${xmlEscape(k)}</Key><ETag>${o.etag}</ETag><Size>${o.body.length}</Size></Contents>`,
          )
          .join('');
        return respond(
          200,
          { 'content-type': 'application/xml' },
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${STUB_BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
    }
  }
}
