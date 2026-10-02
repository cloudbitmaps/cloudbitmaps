import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CRC32C, Storage } from '@google-cloud/storage';

/**
 * A stub of the slice of the GCS JSON API the drivers use, on 127.0.0.1, for tests that drive a real
 * `@google-cloud/storage` client: the SDK has no transport seam for its uploads, so a socket is the narrowest place to
 * put a stub, and what these tests check is what the SDK does with an answer.
 *
 * It holds objects in memory with their custom metadata, honours `ifGenerationMatch`, and serves single-request
 * uploads, object metadata, downloads (whole, ranged and suffix), deletes and listings. A test arms faults on the
 * uploads it chooses, by object name: a throttle answer (`429 rateLimitExceeded`, `503 backendError`) given before the
 * upload is applied or after it.
 */

export const STUB_GCS_BUCKET = 'b';

export interface StoredGcsObject {
  readonly body: Buffer;
  readonly generation: number;
  readonly metadata?: Record<string, string>;
}

/** What an armed upload fault does. */
export interface UploadFault {
  /** The status answered: 429 or 503 as GCS sends them, or any other. */
  readonly status: number;
  /** Apply the upload first, so the answer reaches a client whose write landed. */
  readonly afterApplying?: boolean;
  /** Only uploads of a name this accepts. */
  readonly name?: (name: string) => boolean;
}

const REASONS: Record<number, string> = {
  429: 'rateLimitExceeded',
  503: 'backendError',
  500: 'backendError',
};

const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('base64');
const crc32c = (bytes: Buffer): string => {
  const crc = new CRC32C();
  crc.update(bytes);
  return crc.toString();
};

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** The two parts of a `multipart/related` upload: the JSON metadata, then the object bytes. */
function uploadParts(
  req: IncomingMessage,
  body: Buffer,
): { metadata: Record<string, unknown>; bytes: Buffer } {
  const boundary = /boundary="?([^";]+)"?/.exec(String(req.headers['content-type']))?.[1];
  if (boundary === undefined) throw new Error('the stub expects a multipart upload');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const next = body.indexOf(delimiter, at + delimiter.length);
    if (next === -1) break;
    parts.push(body.subarray(at + delimiter.length, next));
    at = next;
  }
  const [metadata, content] = parts;
  if (metadata === undefined || content === undefined) {
    throw new Error('the stub expects a metadata part and a content part');
  }
  const contentOf = (part: Buffer): Buffer =>
    part.subarray(part.indexOf('\r\n\r\n') + 4, part.length - 2);
  return {
    metadata: JSON.parse(contentOf(metadata).toString('utf8')) as Record<string, unknown>,
    bytes: contentOf(content),
  };
}

type Operation = 'upload' | 'metadata' | 'media' | 'delete' | 'list';

export class StubGcsService {
  readonly objects = new Map<string, StoredGcsObject>();
  /** Every request, in order: its operation and the object it named (`''` for a listing). */
  readonly sent: Array<{ op: Operation; name: string }> = [];
  private faults: UploadFault[] = [];
  private seq = 1_000;
  private readonly server: Server = createServer((req, res) => {
    void this.serve(req, res);
  });
  endpoint = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Answer the next upload a fault matches with it. Faults fire in arming order. */
  arm(fault: UploadFault): void {
    this.faults.push(fault);
  }

  count(op: Operation, name?: (name: string) => boolean): number {
    return this.sent.filter((s) => s.op === op && (name === undefined || name(s.name))).length;
  }

  /** A real client for this stub; its retries are quick (`maxRetryDelay: 1`), not off. */
  client(options: ConstructorParameters<typeof Storage>[0] = {}): Storage {
    return new Storage({
      projectId: 'test',
      apiEndpoint: this.endpoint,
      ...options,
      retryOptions: { maxRetryDelay: 1, ...options.retryOptions },
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const body = await bodyOf(req);
    const listPath = `/storage/v1/b/${STUB_GCS_BUCKET}/o`;
    const upload = url.pathname === `/upload${listPath}`;
    const list = req.method === 'GET' && url.pathname === listPath;
    const name = upload
      ? (url.searchParams.get('name') ?? '')
      : list
        ? ''
        : decodeURIComponent(url.pathname.slice(listPath.length + 1));
    const op: Operation = upload
      ? 'upload'
      : list
        ? 'list'
        : req.method === 'DELETE'
          ? 'delete'
          : url.searchParams.get('alt') === 'media'
            ? 'media'
            : 'metadata';
    this.sent.push({ op, name });
    let fault: UploadFault | undefined;
    if (op === 'upload') {
      const at = this.faults.findIndex((f) => f.name === undefined || f.name(name));
      if (at !== -1) fault = this.faults.splice(at, 1)[0];
    }
    if (fault !== undefined && fault.afterApplying !== true) {
      return this.send(res, this.error(fault.status, REASONS[fault.status] ?? 'error'));
    }
    const answer = this.apply(op, name, url.searchParams, req, body);
    if (fault !== undefined) {
      return this.send(res, this.error(fault.status, REASONS[fault.status] ?? 'error'));
    }
    this.send(res, answer);
  }

  private send(res: ServerResponse, [status, headers, payload]: Answer): void {
    res.writeHead(status, headers);
    res.end(payload);
  }

  private json(status: number, value: unknown): Answer {
    return [status, { 'content-type': 'application/json' }, JSON.stringify(value)];
  }

  private error(status: number, reason: string): Answer {
    return this.json(status, {
      error: { code: status, message: reason, errors: [{ reason, message: reason }] },
    });
  }

  private resource(name: string, object: StoredGcsObject): Record<string, unknown> {
    return {
      kind: 'storage#object',
      bucket: STUB_GCS_BUCKET,
      name,
      generation: String(object.generation),
      metageneration: '1',
      size: String(object.body.length),
      crc32c: crc32c(object.body),
      md5Hash: md5(object.body),
      ...(object.metadata === undefined ? {} : { metadata: object.metadata }),
    };
  }

  private apply(
    op: Operation,
    name: string,
    query: URLSearchParams,
    req: IncomingMessage,
    body: Buffer,
  ): Answer {
    const current = this.objects.get(name);
    switch (op) {
      case 'upload': {
        const { metadata, bytes } = uploadParts(req, body);
        const match = query.get('ifGenerationMatch');
        if (match !== null) {
          const expected = Number(match);
          if (expected === 0 ? current !== undefined : current?.generation !== expected) {
            return this.error(412, 'conditionNotMet');
          }
        }
        const custom = metadata.metadata as Record<string, string> | undefined;
        const stored: StoredGcsObject = {
          body: bytes,
          generation: ++this.seq,
          ...(custom === undefined ? {} : { metadata: custom }),
        };
        this.objects.set(name, stored);
        return this.json(200, this.resource(name, stored));
      }
      case 'metadata':
        return current === undefined
          ? this.error(404, 'notFound')
          : this.json(200, this.resource(name, current));
      case 'list': {
        const prefix = query.get('prefix') ?? '';
        const items = [...this.objects.entries()]
          .filter(([n]) => n.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([n, o]) => this.resource(n, o));
        return this.json(200, { kind: 'storage#objects', items });
      }
      case 'delete': {
        if (current === undefined) return this.error(404, 'notFound');
        this.objects.delete(name);
        return [204, {}, ''];
      }
      case 'media': {
        if (current === undefined) return this.error(404, 'notFound');
        const size = current.body.length;
        const header = String(req.headers.range ?? '');
        const suffix = /^bytes=-(\d+)$/.exec(header);
        const range = /^bytes=(\d+)-(\d+)$/.exec(header);
        if (suffix === null && range === null) {
          return [
            200,
            {
              'content-type': 'application/octet-stream',
              'content-length': String(size),
              'x-goog-generation': String(current.generation),
              'x-goog-hash': `crc32c=${crc32c(current.body)},md5=${md5(current.body)}`,
            },
            current.body,
          ];
        }
        const [start, end] =
          suffix !== null
            ? [Math.max(0, size - Number(suffix[1])), size - 1]
            : [Number(range![1]), Math.min(Number(range![2]), size - 1)];
        return [
          206,
          {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${size}`,
            'x-goog-generation': String(current.generation),
          },
          current.body.subarray(start, end + 1),
        ];
      }
    }
  }
}

type Answer = [number, Record<string, string>, Buffer | string];
