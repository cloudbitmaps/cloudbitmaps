import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CRC32C, IdempotencyStrategy, Storage } from '@google-cloud/storage';
import { GcsStorage } from '@/gcs/backend';
import { GcsStorageDriver } from '@/gcs/storage';
import { GcsRegistryStore } from '@/gcs/registry';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import type { GenKey } from '@/core/ports';
import { CREATED_TOKEN, tokenAfter } from '../../helpers/tokens';

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
    part.subarray(part.indexOf('\r\n\r\n') + 4, part.length - 2); // drop the CRLF before the next delimiter
  return {
    metadata: JSON.parse(contentOf(metadata).toString('utf8')) as Record<string, unknown>,
    bytes: contentOf(content),
  };
}

interface UploadRecord {
  readonly name: string;
  readonly query: Record<string, string>;
  readonly metadata: Record<string, unknown>;
}

/** A stub of the slice of the GCS JSON API the drivers use, on 127.0.0.1, with one armed fault at a time. */
class StubGcs {
  readonly objects = new Map<string, StoredObject>();
  private readonly sent: Operation[] = [];
  /** Every upload the stub received: its object name, its query string and its JSON metadata part. */
  readonly uploads: UploadRecord[] = [];
  /** The `ifGenerationMatch` each delete of an object that was there carried, or `null` for none. */
  readonly deleteFences: Array<string | null> = [];
  /** When set, an upload's answer names a checksum the stored bytes do not have. */
  corruptChecksums = false;
  private seq = 1_000;
  /** Connections the stub has accepted and seen close, to show a refused response does not leak its socket. */
  opened = 0;
  closed = 0;
  /**
   * When set, answers every media request with `status` and `headers`, then writes an endless body until the client
   * hangs up. `aborted` records whether the client did, which is what a response refused part-way looks like to the
   * server.
   */
  mediaEndless:
    { status: number; headers: (cur: StoredObject) => Record<string, string> } | undefined;
  aborted = false;
  /** When set, replaces the stub's answer to every media (download) request. */
  mediaOverride:
    ((current: StoredObject) => [number, Record<string, string>, Buffer | string]) | undefined;
  private fault: { op: Operation; land: boolean } | undefined;
  private readonly server: Server = createServer((req, res) => {
    void this.serve(req, res);
  });

  constructor() {
    this.server.on('connection', (socket) => {
      this.opened++;
      socket.on('close', () => this.closed++);
    });
  }
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
    const stored = this.objects.get(name);
    if (op === 'media' && stored !== undefined && this.mediaEndless !== undefined) {
      const { status, headers } = this.mediaEndless;
      res.writeHead(status, headers(stored));
      res.on('close', () => {
        if (!res.writableFinished) this.aborted = true;
      });
      const chunk = Buffer.alloc(64 * 1024);
      const pump = (): void => {
        while (!res.destroyed && res.write(chunk)) continue;
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
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
      crc32c: crc32c(this.corruptChecksums ? Buffer.from('other') : object.body),
      md5Hash: md5(object.body),
    });
    const current = this.objects.get(name);
    switch (op) {
      case 'upload': {
        const { metadata, bytes } = uploadParts(req, body);
        this.uploads.push({ name, query: Object.fromEntries(query), metadata });
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
        if (current !== undefined && this.mediaOverride !== undefined) {
          return this.mediaOverride(current);
        }
        const pinned = query.get('generation');
        if (current === undefined || (pinned !== null && Number(pinned) !== current.generation)) {
          return error(404, 'notFound');
        }
        const suffix = /^bytes=-(\d+)$/.exec(String(req.headers.range ?? ''));
        if (suffix !== null) {
          const first = Math.max(0, current.body.length - Number(suffix[1]));
          return [
            206,
            {
              'content-type': 'application/octet-stream',
              'content-range': `bytes ${first}-${current.body.length - 1}/${current.body.length}`,
              'x-goog-generation': String(current.generation),
            },
            current.body.subarray(first),
          ];
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
        if (range === null) {
          return [
            200,
            {
              'content-type': 'application/octet-stream',
              'x-goog-generation': String(current.generation),
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
        const match = query.get('ifGenerationMatch');
        this.deleteFences.push(match);
        if (match !== null && current.generation !== Number(match)) {
          return error(412, 'conditionNotMet');
        }
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

// A conditional delete is not sent once: the SDK retries a request with a precondition, and has no per-request switch
// for a delete. The precondition is what keeps a second copy from removing anything the first could not.
describe("GCS: the registry's conditional delete", () => {
  it('sends ifGenerationMatch with the generation it read, and removes the row', async () => {
    const backend = new GcsStorage({
      bucket: BUCKET,
      client: stub.client(),
      conditionalDelete: true,
    });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    const [stored] = [...stub.objects.values()];
    await backend.registry.delete(REF, token);
    expect(stub.deleteFences).toEqual([String(stored!.generation)]);
    expect(stub.objects.size).toBe(0);
  });

  it('a generation that moved on is a 412: WriteConflictError, and nothing is deleted', async () => {
    const backend = new GcsStorage({
      bucket: BUCKET,
      client: stub.client(),
      conditionalDelete: true,
    });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    const [name, stored] = [...stub.objects.entries()][0]!;
    const store = new GcsRegistryStore(backend.client, backend.client, BUCKET, true);
    await expect(
      store.delete(name, { version: String(stored.generation + 1) }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await backend.registry.get(REF)).toMatchObject({ token });
  });

  it('a delete that lands and loses its response is sent again, meets nothing, and reports a conflict', async () => {
    const backend = new GcsStorage({
      bucket: BUCKET,
      client: stub.client(),
      conditionalDelete: true,
    });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    stub.loseResponseOf('delete');
    await expect(backend.registry.delete(REF, token)).rejects.toBeInstanceOf(WriteConflictError);
    expect(stub.count('delete')).toBe(2);
    expect(stub.objects.size).toBe(0); // the first copy landed; the second removed nothing
    expect(await backend.registry.get(REF)).toBeNull();
  });
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
    expect(await backend.registry.get(REF)).toMatchObject({
      currentGen: 0,
      token: expect.stringMatching(CREATED_TOKEN),
    });
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
    expect(await backend.registry.get(REF)).toMatchObject({
      currentGen: 1,
      token: expect.stringMatching(tokenAfter(token)),
    });
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

describe('GCS: the single request carries what file.save() would have sent', () => {
  it("a registry write is one JSON upload under `ifGenerationMatch: 0`, then one under the row's generation", async () => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    const { token } = await backend.registry.create(REF, { currentGen: 0 });
    const created = stub.objects.get('registry/_default/s.reg')?.generation;
    await backend.registry.compareAndSwap(REF, token, { currentGen: 1 });

    expect(created).toBeDefined();
    expect(stub.uploads).toHaveLength(2);
    expect(stub.uploads[0]?.query.ifGenerationMatch).toBe('0');
    expect(stub.uploads[1]?.query.ifGenerationMatch).toBe(String(created));
    for (const upload of stub.uploads) {
      expect(upload.query.uploadType).toBe('multipart');
      expect(upload.metadata.contentType).toBe('application/json');
    }
  });

  it('a write-once upload is one octet-stream upload under `ifGenerationMatch: 0`', async () => {
    const driver = new GcsStorageDriver({ storage: stub.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1, 2, 3]));

    expect(stub.uploads).toHaveLength(1);
    expect(stub.uploads[0]?.query.ifGenerationMatch).toBe('0');
    expect(stub.uploads[0]?.metadata.contentType).toBe('application/octet-stream');
  });

  it('an upload whose stored checksum does not match the bytes sent is refused, and not sent again', async () => {
    const driver = new GcsStorageDriver({ storage: stub.client(), bucket: BUCKET });
    stub.corruptChecksums = true;

    await expect(put(driver, new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(stub.count('upload')).toBe(1);
  });
});

describe('GCS: a read on a client the caller supplies, with the SDK retry on', () => {
  it('a ranged read retries a dropped connection', async () => {
    const driver = new GcsStorageDriver({ storage: stub.client(), bucket: BUCKET });
    await put(driver, new Uint8Array([1, 2, 3, 4]));
    stub.failBeforeApplying('media');

    await expect(driver.getRange(GEN, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    expect(stub.count('media')).toBe(2);
  });
});

// The single-GET reads, through the real SDK: the fakes elsewhere stand in for its streams, and only the SDK shows
// that refusing a response mid-flight neither throws out of an event handler nor leaves its socket open.
describe('GCS: one-request reads through the real SDK', () => {
  const seed = async (bytes: Uint8Array): Promise<GcsStorage> => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    await put(backend.storage as GcsStorageDriver, bytes);
    return backend;
  };

  /** Collect process-level failures a handler that throws out of an event would raise. */
  const watchProcess = (): { events: unknown[]; stop: () => void } => {
    const events: unknown[] = [];
    const onEvent = (e: unknown): void => void events.push(e);
    process.on('unhandledRejection', onEvent);
    process.on('uncaughtException', onEvent);
    return {
      events,
      stop: () => {
        process.off('unhandledRejection', onEvent);
        process.off('uncaughtException', onEvent);
      },
    };
  };

  const registryRow = async (): Promise<{ backend: GcsStorage; key: string }> => {
    const backend = new GcsStorage({ bucket: BUCKET, client: stub.client() });
    await backend.registry.create(REF, { currentGen: 0 });
    return { backend, key: [...stub.objects.keys()][0] as string };
  };

  it('a pointer read is one HTTP request', async () => {
    const { backend } = await registryRow();
    const before = stub.count('media') + stub.count('metadata');
    expect(await backend.registry.get(REF)).toMatchObject({ currentGen: 0 });
    expect(stub.count('media') + stub.count('metadata') - before).toBe(1);
  });

  it('a tail read is one HTTP request, and a short object is too', async () => {
    const backend = await seed(Uint8Array.from({ length: 100 }, (_, i) => i));
    const driver = backend.storage as GcsStorageDriver;
    const tail = await driver.getTail(GEN, 40);
    expect(tail.size).toBe(100);
    expect(tail.bytes).toEqual(Uint8Array.from({ length: 40 }, (_, i) => 60 + i));
    expect(stub.count('media')).toBe(1);
    expect(stub.count('metadata')).toBe(0);
    const whole = await driver.getTail(GEN, 500);
    expect(whole.size).toBe(100);
    expect(whole.bytes).toHaveLength(100);
    expect(stub.count('media')).toBe(2);
    expect(stub.count('metadata')).toBe(0);
  });

  it('an empty object takes two requests: the refused suffix, then the metadata', async () => {
    const backend = await seed(new Uint8Array(0));
    stub.mediaOverride = () => [
      416,
      { 'content-type': 'application/json' },
      '{"error":{"code":416}}',
    ];
    expect(await (backend.storage as GcsStorageDriver).getTail(GEN, 10)).toEqual({
      bytes: new Uint8Array(0),
      size: 0,
    });
    expect(stub.count('media')).toBe(1);
    expect(stub.count('metadata')).toBe(1);
  });

  /** Refuse `read` against an endless response and show the SDK let go of it: no stray event, the server saw a hang-up. */
  const refusedAndReleased = async (
    read: () => Promise<unknown>,
    expected: new (...a: never[]) => Error,
  ) => {
    const watch = watchProcess();
    try {
      await expect(read()).rejects.toBeInstanceOf(expected);
      for (let i = 0; i < 100 && !stub.aborted; i++) await new Promise((r) => setTimeout(r, 20));
      expect(stub.aborted).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      watch.stop();
    }
    expect(watch.events).toEqual([]);
  };

  it('a pointer whose advertised length is over the cap is refused, and the response is let go', async () => {
    const { backend } = await registryRow();
    stub.mediaEndless = {
      status: 200,
      headers: (cur) => ({
        'x-goog-generation': String(cur.generation),
        'content-length': String(MAX_ROW_BYTES * 1024),
      }),
    };
    await refusedAndReleased(() => backend.registry.get(REF), IntegrityError);
  });

  it('a pointer body that outruns the cap with no length is refused, and the response is let go', async () => {
    const { backend } = await registryRow();
    stub.mediaEndless = {
      status: 200,
      headers: (cur) => ({ 'x-goog-generation': String(cur.generation) }),
    };
    await refusedAndReleased(() => backend.registry.get(REF), IntegrityError);
  });

  it('a tail response past the requested length is refused the same way, by length and by stream', async () => {
    const backend = await seed(new Uint8Array(100));
    const driver = backend.storage as GcsStorageDriver;
    for (const extra of [{ 'content-length': String(1024 ** 3) }, {}] as Array<
      Record<string, string>
    >) {
      stub.aborted = false;
      stub.mediaEndless = {
        status: 206,
        headers: () => ({ 'content-range': 'bytes 90-99/100', ...extra }),
      };
      await refusedAndReleased(() => driver.getTail(GEN, 10), ValidationError);
    }
  });
});
