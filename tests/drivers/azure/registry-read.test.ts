import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AnonymousCredential,
  ContainerClient,
  type StoragePipelineOptions,
} from '@azure/storage-blob';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import { IntegrityError, TransientError } from '@/core/errors';

/**
 * A registry read through a real `@azure/storage-blob` client.
 *
 * The client is the SDK's own, and it talks HTTP to a stub of the Blob service on the loopback interface, started and
 * stopped in this process: what the SDK does with a response it cannot use, and whether the socket under it is let go,
 * happens below any seam a fake could stand in. The stub holds blobs in memory and honours `If-None-Match: *` and
 * `If-Match`, so the driver's own writes put a real row there; then a test replaces the answer to the next GET with
 * one the service should never send.
 *
 * In Node the SDK refuses a response with no ETag or no length itself, by throwing, and leaves the body unread with
 * its socket open; and a body stream that errors with no listener throws out of the event, where nothing can catch it.
 * Each refusal below is held to both: the read rejects with `IntegrityError`, no stray process event fires, and the
 * stub sees the connection closed.
 */

interface StoredBlob {
  readonly body: Buffer;
  readonly etag: string;
  readonly metadata: Record<string, string>;
}

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  /**
   * The body; `'endless'` for one that never ends until the client hangs up; or `{ cut }`, those bytes and then the
   * connection dropped.
   */
  readonly body: Buffer | 'endless' | { readonly cut: Buffer };
}

const xmlError = (status: number, code: string): Answer => ({
  status,
  headers: { 'content-type': 'application/xml', 'x-ms-error-code': code },
  body: Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  ),
});

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** A stub of the slice of the Blob service a registry uses, on 127.0.0.1. */
class StubBlobService {
  readonly blobs = new Map<string, StoredBlob>();
  /** Every request: its method, and the range and condition it carried. */
  readonly requests: Array<{ method: string; range?: string; ifMatch?: string }> = [];
  /** When set, answers every GET instead of the stored blob; `host` is the name the request was sent to. */
  getOverride: ((cur: StoredBlob | undefined, host: string) => Answer) | undefined;
  /**
   * For each GET answered by `getOverride`, whether the connection that carried it has closed, and the body bytes the
   * stub had handed to it by then.
   */
  readonly overridden: Array<{ closed: boolean; sent: number }> = [];
  private seq = 0;
  private readonly server: Server = createServer((req, res) => {
    void this.serve(req, res);
  });
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/devstoreaccount1/c`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** A container client of the SDK's own, with its default pipeline unless `options` change it. */
  client(options?: StoragePipelineOptions): ContainerClient {
    return new ContainerClient(this.url, new AnonymousCredential(), options);
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  private send(res: ServerResponse, answer: Answer, watched?: { sent: number }): void {
    res.writeHead(answer.status, { 'x-ms-request-id': 'stub', ...answer.headers });
    if (Buffer.isBuffer(answer.body)) {
      res.end(answer.body);
      return;
    }
    if (answer.body !== 'endless') {
      // Dropped a moment after the write, so the bytes written go out before the connection does.
      res.write(answer.body.cut);
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    const chunk = Buffer.alloc(64 * 1024, 0x7b);
    const pump = (): void => {
      while (!res.destroyed) {
        if (watched !== undefined) watched.sent += chunk.length;
        if (!res.write(chunk)) break;
      }
      if (!res.destroyed) res.once('drain', pump);
    };
    pump();
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = decodeURIComponent(
      (req.url ?? '').split('?')[0]!.replace(/^\/devstoreaccount1\/c\//, ''),
    );
    const header = (h: string): string | undefined => {
      const v = req.headers[h];
      return typeof v === 'string' ? v : undefined;
    };
    this.requests.push({
      method: req.method ?? '',
      range: header('x-ms-range') ?? header('range'),
      ifMatch: header('if-match'),
    });
    const body = await bodyOf(req);
    const cur = this.blobs.get(name);
    const ifMatch = header('if-match');
    if (ifMatch !== undefined && (cur === undefined || cur.etag !== ifMatch)) {
      return this.send(
        res,
        req.method === 'HEAD'
          ? { ...xmlError(412, 'ConditionNotMet'), body: Buffer.alloc(0) }
          : xmlError(412, 'ConditionNotMet'),
      );
    }
    if (req.method === 'PUT') {
      if (header('if-none-match') === '*' && cur !== undefined) {
        return this.send(res, xmlError(409, 'BlobAlreadyExists'));
      }
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith('x-ms-meta-') && typeof v === 'string') metadata[k.slice(10)] = v;
      }
      const etag = `"0x8D${String(++this.seq).padStart(12, '0')}"`;
      this.blobs.set(name, { body, etag, metadata });
      return this.send(res, { status: 201, headers: { etag }, body: Buffer.alloc(0) });
    }
    if (req.method === 'GET' && this.getOverride !== undefined) {
      const watched = { closed: false, sent: 0 };
      this.overridden.push(watched);
      req.socket.once('close', () => (watched.closed = true));
      return this.send(res, this.getOverride(cur, (header('host') ?? '').split(':')[0]!), watched);
    }
    if (cur === undefined) {
      return this.send(
        res,
        req.method === 'HEAD'
          ? { status: 404, headers: {}, body: Buffer.alloc(0) }
          : xmlError(404, 'BlobNotFound'),
      );
    }
    const headers: Record<string, string> = {
      etag: cur.etag,
      'content-length': String(cur.body.length),
      'content-type': 'application/json',
      'x-ms-blob-type': 'BlockBlob',
    };
    for (const [k, v] of Object.entries(cur.metadata)) headers[`x-ms-meta-${k}`] = v;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'x-ms-request-id': 'stub', ...headers });
      res.end();
      return;
    }
    return this.send(res, { status: 200, headers, body: cur.body });
  }
}

const REF = { segment: 's' };

describe('Azure Blob registry: a pointer read is one request, through the real SDK', () => {
  let stub: StubBlobService;
  beforeEach(async () => {
    stub = new StubBlobService();
    await stub.start();
  });
  afterEach(async () => {
    await stub.stop();
  });

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

  const registryRow = async (): Promise<AzureBlobRegistryDriver> => {
    const registry = new AzureBlobRegistryDriver({ containerClient: stub.client() });
    await registry.create(REF, { currentGen: 0 });
    stub.requests.length = 0;
    return registry;
  };

  /**
   * The connection that carried each refused response has closed. The client keeps the others open for its next
   * request; one holding a response nobody reads is stuck, and is what a leak looks like.
   */
  const released = async (): Promise<boolean> => {
    const done = (): boolean =>
      stub.overridden.length > 0 && stub.overridden.every((o) => o.closed);
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
    return done();
  };

  it('a pointer read is one GET of the whole blob, with no range and no condition', async () => {
    const registry = await registryRow();
    expect(await registry.get(REF)).toMatchObject({ currentGen: 0 });
    expect(stub.requests).toEqual([{ method: 'GET', range: undefined, ifMatch: undefined }]);
  });

  it('an absent row is one GET answered 404, read as null', async () => {
    const registry = new AzureBlobRegistryDriver({ containerClient: stub.client() });
    expect(await registry.get(REF)).toBeNull();
    expect(stub.requests).toEqual([{ method: 'GET', range: undefined, ifMatch: undefined }]);
  });

  it('a compare-and-swap reads in one GET, then writes under the ETag that GET returned', async () => {
    const registry = await registryRow();
    const etag = [...stub.blobs.values()][0]!.etag;
    const { token } = (await registry.get(REF))!;
    stub.requests.length = 0;
    await registry.compareAndSwap(REF, token, { currentGen: 1 });
    expect(stub.requests).toEqual([
      { method: 'GET', range: undefined, ifMatch: undefined },
      { method: 'PUT', range: undefined, ifMatch: etag },
    ]);
  });

  /** Refuse `read` against `answer`, and show the SDK let go of the response: no stray event, every socket closed. */
  const refusedAndReleased = async (answer: (cur: StoredBlob | undefined) => Answer) => {
    const registry = await registryRow();
    stub.getOverride = answer;
    const watch = watchProcess();
    try {
      await expect(registry.get(REF)).rejects.toBeInstanceOf(IntegrityError);
      expect(await released()).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      watch.stop();
    }
    expect(watch.events).toEqual([]);
    expect(stub.count('GET')).toBe(1);
    expect(stub.count('HEAD')).toBe(0);
    // Refused on the headers, so the client hung up having taken no more than the socket buffers hold: a read that
    // buffered the body first would have drawn it all, a gibibyte for the over-cap answer.
    expect(stub.overridden.every((o) => o.sent < 64 * 1024 * 1024)).toBe(true);
    // The client is still usable: the next read is answered as normal.
    stub.getOverride = undefined;
    expect(await registry.get(REF)).toMatchObject({ currentGen: 0 });
  };

  it('a pointer whose advertised length is over the cap is refused before its body is read, and let go', async () => {
    await refusedAndReleased((cur) => ({
      status: 200,
      headers: { etag: cur!.etag, 'content-length': String(MAX_ROW_BYTES * 1024) },
      body: 'endless',
    }));
  });

  it('a pointer with no ETag is refused, and let go', async () => {
    await refusedAndReleased(() => ({
      status: 200,
      headers: { 'content-length': String(MAX_ROW_BYTES) },
      body: 'endless',
    }));
  });

  it('a pointer with an empty ETag is refused, and let go', async () => {
    await refusedAndReleased(() => ({
      status: 200,
      headers: { etag: '', 'content-length': String(MAX_ROW_BYTES) },
      body: 'endless',
    }));
  });

  it('a pointer with no length is refused, and let go', async () => {
    await refusedAndReleased((cur) => ({
      status: 200,
      headers: { etag: cur!.etag },
      body: 'endless',
    }));
  });

  it('a pointer answered 206 to a whole-blob GET is refused, and let go', async () => {
    await refusedAndReleased((cur) => ({
      status: 206,
      headers: {
        etag: cur!.etag,
        'content-length': String(cur!.body.length),
        'content-range': `bytes 0-${cur!.body.length - 1}/${cur!.body.length + 10}`,
      },
      body: cur!.body,
    }));
  });

  it('a pointer body cut off part-way fails the read, and is not resumed with a second request', async () => {
    const registry = await registryRow();
    stub.getOverride = (cur) => ({
      status: 200,
      headers: { etag: cur!.etag, 'content-length': String(cur!.body.length + 100) },
      body: { cut: cur!.body },
    });
    const watch = watchProcess();
    try {
      // The stub sends the row, short of the length it advertised, and drops the connection: a fault in transit, which
      // the store's read retry repeats, and not the caller's own cancellation.
      await expect(registry.get(REF)).rejects.toBeInstanceOf(TransientError);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      watch.stop();
    }
    expect(watch.events).toEqual([]);
    expect(stub.requests).toEqual([{ method: 'GET', range: undefined, ifMatch: undefined }]);
  });

  it('a pointer exactly at the cap is not refused for its length; one byte over is', async () => {
    const registry = await registryRow();
    const of =
      (n: number) =>
      (cur: StoredBlob | undefined): Answer => ({
        status: 200,
        headers: { etag: cur!.etag, 'content-length': String(n) },
        body: Buffer.alloc(n, 0x20),
      });
    stub.getOverride = of(MAX_ROW_BYTES);
    // Read whole, then refused as a row that does not parse: its length was allowed.
    const atCap = await registry.get(REF).catch((e: unknown) => e);
    expect(atCap).toBeInstanceOf(IntegrityError);
    expect(String((atCap as Error).message)).not.toMatch(/exceeds cap|more than/);
    stub.getOverride = of(MAX_ROW_BYTES + 1);
    await expect(registry.get(REF)).rejects.toThrow(/exceeds cap/);
  });

  it('an empty pointer is one GET, refused as a row that does not parse', async () => {
    const registry = await registryRow();
    stub.getOverride = (cur) => ({
      status: 200,
      headers: { etag: cur!.etag, 'content-length': '0' },
      body: Buffer.alloc(0),
    });
    await expect(registry.get(REF)).rejects.toBeInstanceOf(IntegrityError);
    expect(stub.count('GET')).toBe(1);
  });

  it('a retry the client sends to a secondary host is refused, so a stale row there is never read as current', async () => {
    // The client retries a primary 503 against `secondaryHost`, here `localhost` (the same stub), which answers with the
    // row one write behind, under that version's ETag, as a geo-replica can.
    const primary = new AzureBlobRegistryDriver({ containerClient: stub.client() });
    await primary.create(REF, { currentGen: 0 });
    const behind = stub.blobs.get('registry/_default/s.reg');
    expect(behind).toBeDefined();
    await primary.compareAndSwap(REF, (await primary.get(REF))!.token, { currentGen: 5 });
    const registry = new AzureBlobRegistryDriver({
      containerClient: stub.client({
        retryOptions: { secondaryHost: 'localhost', retryDelayInMs: 5, maxRetryDelayInMs: 10 },
      }),
    });
    let primaryFaults = 1;
    stub.getOverride = (cur, host) => {
      if (host === '127.0.0.1' && primaryFaults-- > 0) return xmlError(503, 'ServerBusy');
      const b = host === 'localhost' ? behind! : cur!;
      return {
        status: 200,
        headers: { etag: b.etag, 'content-length': String(b.body.length) },
        body: b.body,
      };
    };
    await expect(registry.get(REF)).rejects.toBeInstanceOf(TransientError);
    // The store's retry asks again; the primary answers, with the current row.
    expect(await registry.get(REF)).toMatchObject({ currentGen: 5 });
  });
});
