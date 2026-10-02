import { Readable } from 'node:stream';
import type { ContainerClient } from '@azure/storage-blob';
import { registryConformance, registryConcurrency } from '@/testing/conformance';
import { AzureBlobRegistryDriver } from '@/azure-blob/registry';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';

/**
 * A faithful in-memory fake of the slice of Azure Blob the registry uses: `download`, a **conditional** `upload`,
 * `getProperties` (which a write reads its id back with, on a conflict) and `listBlobsFlat`.
 *
 * It follows Azure's own status codes rather than S3's, because the driver's error mapping keys off them:
 * a lost `ifNoneMatch: '*'` create is **409 `BlobAlreadyExists`** (not the 412 S3 and GCS use), while a lost
 * `ifMatch` is 412. Getting that pair backwards is precisely the sort of drift a per-cloud fake exists to
 * catch. A download answers as the SDK does in Node: the ETag, the length and the status of the one response, and its
 * body as a stream.
 */
function azureError(statusCode: number, code?: string): Error {
  const err = new Error(code ?? `azure ${statusCode}`) as Error & {
    statusCode: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code !== undefined) err.code = code;
  return err;
}

interface FakeBlob {
  bytes: Uint8Array;
  etag: string;
}

/** What one download answers: the parts of the SDK's response the driver reads. */
interface FakeResponse {
  etag?: string;
  contentLength?: number;
  readableStreamBody?: NodeJS.ReadableStream;
  _response: { status: number };
}

class FakeContainer {
  readonly blobs = new Map<string, FakeBlob>();
  private seq = 0;
  /** Round trips issued against the service, to pin the cost of a read. */
  calls = 0;
  /** Each download's arguments: a whole-blob GET has no offset past 0 and no count. */
  readonly downloads: Array<{ offset?: number; count?: number; maxRetryRequests?: number }> = [];
  /** When set, answers downloads instead of the stored blob, given the blob as it was stored when asked. */
  answer: ((blob: FakeBlob) => FakeResponse | Promise<FakeResponse>) | undefined;

  /** Store `bytes` under `name` as a new version, as an unconditional overwrite would. */
  put(name: string, bytes: Uint8Array): void {
    this.blobs.set(name, { bytes, etag: `"etag-${++this.seq}"` });
  }

  getBlockBlobClient(name: string): unknown {
    return {
      url: `https://acct.blob.core.windows.net/c/${name}`,
      download: async (
        offset?: number,
        count?: number,
        opts?: { maxRetryRequests?: number },
      ): Promise<FakeResponse> => {
        this.calls++;
        this.downloads.push({ offset, count, maxRetryRequests: opts?.maxRetryRequests });
        const blob = this.blobs.get(name);
        if (blob === undefined) throw azureError(404, 'BlobNotFound');
        if (this.answer !== undefined) return await this.answer(blob);
        return {
          etag: blob.etag,
          contentLength: blob.bytes.length,
          readableStreamBody: Readable.from([Buffer.from(blob.bytes)]),
          _response: { status: 200 },
        };
      },
      getProperties: async (): Promise<unknown> => {
        this.calls++;
        const blob = this.blobs.get(name);
        if (blob === undefined) throw azureError(404); // a HEAD 404 carries no error code
        return { etag: blob.etag, contentLength: blob.bytes.length };
      },
      upload: async (
        body: Uint8Array,
        length: number,
        opts?: { conditions?: { ifNoneMatch?: string; ifMatch?: string } },
      ): Promise<void> => {
        this.calls++;
        const cur = this.blobs.get(name);
        const c = opts?.conditions ?? {};
        if (c.ifNoneMatch === '*' && cur !== undefined) {
          throw azureError(409, 'BlobAlreadyExists'); // Azure's spelling, not 412
        }
        if (c.ifMatch !== undefined && (cur === undefined || cur.etag !== c.ifMatch)) {
          throw azureError(412, 'ConditionNotMet');
        }
        this.put(name, Uint8Array.from(body.subarray(0, length)));
      },
    };
  }

  async *listBlobsFlat(opts?: { prefix?: string }): AsyncIterable<{ name: string }> {
    for (const name of [...this.blobs.keys()].sort()) {
      if (name.startsWith(opts?.prefix ?? '')) yield { name };
    }
  }
}

/**
 * A response body produced on demand, `chunk` bytes at a time, `chunks` times, that counts what it handed over and
 * whether it was destroyed: what a hostile or broken service streams, held to how much of it the driver takes.
 */
class Body extends Readable {
  produced = 0;
  destroyedBy: 'driver' | undefined;
  constructor(
    private readonly chunk: number,
    private readonly chunks: number,
  ) {
    super();
  }
  override _read(): void {
    if (this.produced >= this.chunk * this.chunks) {
      this.push(null);
      return;
    }
    this.produced += this.chunk;
    this.push(Buffer.alloc(this.chunk, 0x7b));
  }
  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    this.destroyedBy = 'driver';
    cb(err);
  }
}

const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

/** The single registry blob the fake holds — asserts there is exactly one, rather than assuming it. */
function soleBlob(container: FakeContainer): { key: string; blob: FakeBlob } {
  const keys = [...container.blobs.keys()];
  expect(keys).toHaveLength(1);
  const key = keys[0] as string;
  return { key, blob: container.blobs.get(key) as FakeBlob };
}

const driverOver = (container: FakeContainer, prefix = 'cloudbitmaps'): AzureBlobRegistryDriver =>
  new AzureBlobRegistryDriver({
    containerClient: container as unknown as ContainerClient,
    prefix,
    now: ticking(),
  });

// The Azure registry must pass the SAME contract as memory / LocalFs / S3 / GCS, in the fast lane.
registryConformance('AzureBlobRegistryDriver (fake Azure)', () => driverOver(new FakeContainer()));

// …and the cross-process fence, which the sequential suite short-circuits before ever reaching.
registryConcurrency('AzureBlobRegistryDriver (fake Azure)', () => {
  const container = new FakeContainer();
  return [driverOver(container), driverOver(container)];
});

describe('AzureBlobRegistryDriver — construction + Azure specifics', () => {
  const ref = { segment: 's:v1' };

  it('rejects a prefix with `.`/`..` segments or control chars (containment)', () => {
    const containerClient = new FakeContainer() as unknown as ContainerClient;
    for (const prefix of ['..', 'a/../b', './x', 'a\tb']) {
      expect(() => new AzureBlobRegistryDriver({ containerClient, prefix })).toThrow(
        ValidationError,
      );
    }
  });

  it('advertises strongRead', () => {
    const containerClient = new FakeContainer() as unknown as ContainerClient;
    expect(new AzureBlobRegistryDriver({ containerClient }).capabilities()).toEqual({
      strongRead: true,
    });
  });

  it('maps a lost create race to a conflict even though Azure answers 409, not 412', async () => {
    const container = new FakeContainer();
    const [a, b] = [driverOver(container), driverOver(container)];
    const results = await Promise.allSettled([
      a.create(ref, { currentGen: 0 }),
      b.create(ref, { currentGen: 0 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(WriteConflictError);
  });

  // The cost model prices a pointer read as one request on every backend (`requestsPerPointerRead`, 1 by default):
  // the response that carries the row carries its ETag. Held here, so the model moves if the driver does.
  it('reads a row in one request: a GET of the whole blob, with no second request for its rest', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 0 });
    const before = container.calls;
    expect(await d.get(ref)).toMatchObject({ currentGen: 0 });
    expect(container.calls - before).toBe(1);
    expect(container.downloads.at(-1)).toEqual({
      offset: 0,
      count: undefined,
      maxRetryRequests: 0,
    });
  });

  it('reads an absent row as null, in one request', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    expect(await d.get(ref)).toBeNull();
    expect(container.calls).toBe(1);
  });

  // The row and its fence come from one response, so a write that lands after the service answered is simply not in
  // this read: the read returns the older row with the older ETag, and a swap conditioned on that ETag then loses.
  it('a write landing during a read is not in it: the bytes and the ETag are the older version, both', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 7 });
    const { key, blob: before } = soleBlob(container);
    let landed = false;
    container.answer = (blob) => {
      container.answer = undefined;
      const answered = Buffer.from(blob.bytes);
      // A concurrent writer lands once the service has answered, before the body is read.
      container.put(key, new TextEncoder().encode('{"not":"a row"}'));
      landed = true;
      return {
        etag: blob.etag,
        contentLength: answered.length,
        readableStreamBody: Readable.from([answered]),
        _response: { status: 200 },
      };
    };
    const downloads = container.downloads.length;
    const got = await d.get(ref);
    expect(landed).toBe(true);
    expect(got?.currentGen).toBe(7);
    expect(container.blobs.get(key)?.etag).not.toBe(before.etag);
    // One request: nothing was re-read, because nothing in the answer was at odds with itself.
    expect(container.downloads.length - downloads).toBe(1);
  });

  it('a swap is fenced on the ETag its read returned: a writer landing between the read and the write wins', async () => {
    const container = new FakeContainer();
    const [a, b] = [driverOver(container), driverOver(container)];
    const { token } = await a.create(ref, { currentGen: 0 });
    container.answer = async (blob) => {
      container.answer = undefined;
      const answered = { bytes: Buffer.from(blob.bytes), etag: blob.etag };
      // B swaps the row after A's read was answered and before A writes.
      await b.compareAndSwap(ref, token, { currentGen: 1 });
      return {
        etag: answered.etag,
        contentLength: answered.bytes.length,
        readableStreamBody: Readable.from([answered.bytes]),
        _response: { status: 200 },
      };
    };
    // A's read sees its own token (the row as answered), so only the ETag fence can refuse its write.
    await expect(a.compareAndSwap(ref, token, { currentGen: 2 })).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect((await a.get(ref))?.currentGen).toBe(1);
  });

  it('refuses an advertised length over the cap without reading a byte of the body', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 0 });
    const body = new Body(64 * 1024, 64);
    container.answer = (blob) => ({
      etag: blob.etag,
      contentLength: MAX_ROW_BYTES + 1,
      readableStreamBody: body,
      _response: { status: 200 },
    });
    await expect(d.get(ref)).rejects.toThrow(
      new IntegrityError(`registry object ${MAX_ROW_BYTES + 1}B exceeds cap ${MAX_ROW_BYTES}B`),
    );
    expect(body.produced).toBe(0);
    expect(body.destroyedBy).toBe('driver');
  });

  // A length the response understates cannot make the driver hold more than it says, nor more than the cap: the bytes
  // are counted as they arrive, and the read is refused at the first one past either.
  it.each([
    ['understates its length', 10, 64],
    ['states the cap and streams past it', MAX_ROW_BYTES, 64],
  ])(
    'refuses a body that %s as it arrives, holding nothing past the bound',
    async (_label, contentLength, chunks) => {
      const container = new FakeContainer();
      const d = driverOver(container);
      await d.create(ref, { currentGen: 0 });
      const chunk = 64 * 1024;
      const body = new Body(chunk, chunks); // 4 MiB in all, past both bounds
      container.answer = (blob) => ({
        etag: blob.etag,
        contentLength,
        readableStreamBody: body,
        _response: { status: 200 },
      });
      await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
      expect(body.destroyedBy).toBe('driver');
      // Refused at the chunk that crossed the bound, give or take the one the stream had read ahead: never the rest.
      expect(body.produced).toBeLessThanOrEqual(contentLength + 2 * chunk);
      expect(body.produced).toBeLessThan(chunk * chunks);
    },
  );

  it.each([
    ['no ETag', { etag: undefined }],
    ['an empty ETag', { etag: '' }],
    ['no length', { contentLength: undefined }],
    ['a length that is not a whole number', { contentLength: 1.5 }],
    ['a status other than 200', { _response: { status: 206 } }],
    ['no body', { readableStreamBody: undefined }],
  ])('refuses a response with %s, before reading its body', async (_label, change) => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 0 });
    const body = new Body(16, 4);
    container.answer = (blob) => ({
      etag: blob.etag,
      contentLength: blob.bytes.length,
      readableStreamBody: body,
      _response: { status: 200 },
      ...change,
    });
    // Without a version there is nothing to compare-and-swap against; the driver must refuse, not proceed.
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    expect(body.produced).toBe(0);
  });
});
