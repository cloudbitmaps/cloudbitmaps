import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import { IntegrityError, TransientError } from '@/core/errors';
import {
  StubBlobService,
  watchProcess,
  xmlError,
  type Answer,
  type StoredBlob,
} from '../../helpers/azure-blob-stub';

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
