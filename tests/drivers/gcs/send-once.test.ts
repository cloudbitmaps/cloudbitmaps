import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CRC32C, IdempotencyStrategy, Storage } from '@google-cloud/storage';
import { GcsStorage } from '@/gcs/backend';
import { GcsStorageDriver } from '@/gcs/storage';
import { TransientError, WriteConflictError } from '@/core/errors';
import type { GenKey } from '@/core/ports';

/**
 * A conditional write is sent once, through a real `@google-cloud/storage` client.
 *
 * The client is the SDK's own, and it talks HTTP to a stub of the JSON API on the loopback interface, started and
 * stopped in this process: the SDK has no transport seam for its uploads, so a socket is the narrowest place to put
 * the stub. It holds objects in memory, honours `ifGenerationMatch`, and can be told to apply the next matching request
 * and then drop the connection without answering, which is what a timeout or a reset connection does to a write the
 * service had already applied. `file.save()` would re-send that upload and meet its own object, so a driver that let
 * it would report a lost race for a write that landed. Each write test counts the uploads as well as checking the
 * error, because the error alone could come from either.
 *
 * The clients take `retryOptions.maxRetryDelay: 1` (one second) so a retry that does happen is quick. That changes how
 * long the SDK waits, not whether it retries.
 */

const BUCKET = 'b';

type Operation = 'upload' | 'metadata' | 'media' | 'delete';

interface StoredObject {
  readonly body: Buffer;
  readonly generation: number;
}

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

/** The object bytes out of a `multipart/related` upload: its second part, after the JSON metadata. */
function uploadedBytes(req: IncomingMessage, body: Buffer): Buffer {
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
  const content = parts[1];
  if (content === undefined) throw new Error('the stub expects a metadata part and a content part');
  const start = content.indexOf('\r\n\r\n') + 4;
  return content.subarray(start, content.length - 2); // drop the CRLF before the next delimiter
}

/** A stub of the slice of the GCS JSON API the drivers use, on 127.0.0.1, with one armed fault at a time. */
class StubGcs {
  readonly objects = new Map<string, StoredObject>();
  private readonly sent: Operation[] = [];
  private seq = 1_000;
  private fault: { op: Operation; land: boolean } | undefined;
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

  /** Apply the next `op`, then drop the connection without answering. */
  loseResponseOf(op: Operation): void {
    this.fault = { op, land: true };
  }

  /** Drop the connection on the next `op` before applying it — a request that never arrived. */
  failBeforeApplying(op: Operation): void {
    this.fault = { op, land: false };
  }

  count(op: Operation): number {
    return this.sent.filter((o) => o === op).length;
  }

  /** A real client for this stub. */
  client(retryOptions: ConstructorParameters<typeof Storage>[0] = {}): Storage {
    return new Storage({
      projectId: 'test',
      apiEndpoint: this.endpoint,
      ...retryOptions,
      retryOptions: { maxRetryDelay: 1, ...retryOptions.retryOptions },
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const body = await bodyOf(req);
    const upload = url.pathname === `/upload/storage/v1/b/${BUCKET}/o`;
    const objectPrefix = `/storage/v1/b/${BUCKET}/o/`;
    const name = upload
      ? (url.searchParams.get('name') ?? '')
      : decodeURIComponent(url.pathname.slice(objectPrefix.length));
    const op: Operation = upload
      ? 'upload'
      : req.method === 'DELETE'
        ? 'delete'
        : url.searchParams.get('alt') === 'media'
          ? 'media'
          : 'metadata';
    this.sent.push(op);
    const fault = this.fault?.op === op ? this.fault : undefined;
    if (fault !== undefined) this.fault = undefined;
    if (fault?.land === false) {
      req.socket.destroy();
      return;
    }
    const [status, headers, payload] = this.apply(op, name, url.searchParams, req, body);
    if (fault?.land === true) {
      req.socket.destroy();
      return;
    }
    res.writeHead(status, headers);
    res.end(payload);
  }

  private apply(
    op: Operation,
    name: string,
    query: URLSearchParams,
    req: IncomingMessage,
    body: Buffer,
  ): [number, Record<string, string>, Buffer | string] {
    const json = (status: number, value: unknown): [number, Record<string, string>, string] => [
      status,
      { 'content-type': 'application/json' },
      JSON.stringify(value),
    ];
    const error = (status: number, reason: string) =>
      json(status, {
        error: { code: status, message: reason, errors: [{ reason, message: reason }] },
      });
    const resource = (object: StoredObject) => ({
      kind: 'storage#object',
      bucket: BUCKET,
      name,
      generation: String(object.generation),
      metageneration: '1',
      size: String(object.body.length),
      crc32c: crc32c(object.body),
      md5Hash: md5(object.body),
    });
    const current = this.objects.get(name);
    switch (op) {
      case 'upload': {
        const bytes = uploadedBytes(req, body);
        const match = query.get('ifGenerationMatch');
        if (match !== null) {
          const expected = Number(match);
          if (expected === 0 ? current !== undefined : current?.generation !== expected) {
            return error(412, 'conditionNotMet');
          }
        }
        const stored = { body: bytes, generation: ++this.seq };
        this.objects.set(name, stored);
        return json(200, resource(stored));
      }
      case 'metadata':
        return current === undefined ? error(404, 'notFound') : json(200, resource(current));
      case 'media': {
        const pinned = query.get('generation');
        if (current === undefined || (pinned !== null && Number(pinned) !== current.generation)) {
          return error(404, 'notFound');
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
        if (range === null) {
          return [
            200,
            {
              'content-type': 'application/octet-stream',
              'x-goog-hash': `crc32c=${crc32c(current.body)},md5=${md5(current.body)}`,
            },
            current.body,
          ];
        }
        const [start, end] = [Number(range[1]), Number(range[2])];
        const slice = current.body.subarray(start, end + 1);
        return [
          206,
          {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${current.body.length}`,
          },
          slice,
        ];
      }
      case 'delete': {
        if (current === undefined) return error(404, 'notFound');
        this.objects.delete(name);
        return [204, {}, ''];
      }
    }
  }
}

const GEN: GenKey = { segment: 's', generation: 0 };
const REF = { segment: 's' };

const put = (driver: GcsStorageDriver, bytes: Uint8Array) =>
  driver.putImmutable(GEN, async (sink) => {
    await sink.write(bytes);
  });

let stub: StubGcs;
beforeEach(async () => {
  stub = new StubGcs();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

describe('GCS: a conditional write is sent once, whatever the SDK retry would do', () => {
  it('a write-once upload that lands and loses its response throws TransientError', async () => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    stub.loseResponseOf('upload');

    const err = await put(backend.storage as GcsStorageDriver, new Uint8Array([1, 2, 3])).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(WriteConflictError);
    expect(stub.count('upload')).toBe(1);
    expect(stub.objects.size).toBe(1); // it landed: the caller has to find that out, and now can
  });

  it("the registry's create that lands and loses its response throws TransientError", async () => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    stub.loseResponseOf('upload');

    const err = await backend.registry.create(REF, { currentGen: 0 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(stub.count('upload')).toBe(1);
    expect(await backend.registry.get(REF)).toMatchObject({ currentGen: 0, token: '0' });
  });

  it("the registry's compareAndSwap that lands and loses its response throws TransientError", async () => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    stub.loseResponseOf('upload');

    const err = await backend.registry
      .compareAndSwap(REF, token, { currentGen: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect(stub.count('upload')).toBe(2); // the create, then the swap once
    expect(await backend.registry.get(REF)).toMatchObject({ currentGen: 1, token: '1' });
  });

  // The registry's delete writes a tombstone under a generation fence, so it is a conditional write like the others.
  // It is idempotent, so a re-run settles it whichever way the first attempt went.
  it("the registry's delete writes its tombstone once, and a re-run settles it", async () => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    await backend.registry.create(REF, { currentGen: 0 });
    stub.loseResponseOf('upload');

    await expect(backend.registry.delete(REF)).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('upload')).toBe(2); // the create, then the tombstone once
    expect(await backend.registry.get(REF)).toBeNull();
    await backend.registry.delete(REF);
    expect(stub.count('upload')).toBe(2); // already a tombstone: nothing left to write
  });

  it('a precondition that really fails is still WriteConflictError', async () => {
    const driver = new GcsStorageDriver({ storage: stub.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1]));

    await expect(put(driver, new Uint8Array([2]))).rejects.toBeInstanceOf(WriteConflictError);
    expect(stub.count('upload')).toBe(2);
  });

  it('holds for a caller-supplied client that asks for more retries, and leaves its retry options as they were', async () => {
    const client = stub.client({
      retryOptions: { maxRetries: 5, idempotencyStrategy: IdempotencyStrategy.RetryAlways },
    });
    const before = { ...client.retryOptions };
    const driver = new GcsStorageDriver({ storage: client, bucket: BUCKET });
    stub.loseResponseOf('upload');

    await expect(put(driver, new Uint8Array([1]))).rejects.toBeInstanceOf(TransientError);
    expect(stub.count('upload')).toBe(1);
    expect(client.retryOptions).toEqual(before);
  });
});

describe('GCS: a read keeps the SDK retry', () => {
  it('a ranged read retries a dropped connection', async () => {
    const driver = new GcsStorageDriver({ storage: stub.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1, 2, 3, 4]));
    stub.failBeforeApplying('media');

    await expect(driver.getRange(GEN, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(stub.count('media')).toBe(2);
  });
});
