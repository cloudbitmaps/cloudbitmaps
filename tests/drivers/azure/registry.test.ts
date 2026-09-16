import type { ContainerClient } from '@azure/storage-blob';
import { registryConformance, registryConcurrency } from '@/testing/conformance';
import { AzureBlobRegistryDriver } from '@/drivers/azure/registry';
import { MAX_ROW_BYTES } from '@/drivers/_shared/object-registry';
import { IntegrityError, ValidationError, WriteConflictError } from '@/core/errors';

/**
 * A faithful in-memory fake of the slice of Azure Blob the registry uses: `getProperties`, an ETag-pinned
 * `downloadToBuffer`, a **conditional** `upload`, and `listBlobsFlat`.
 *
 * It follows Azure's own status codes rather than S3's, because the driver's error mapping keys off them:
 * a lost `ifNoneMatch: '*'` create is **409 `BlobAlreadyExists`** (not the 412 S3 and GCS use), while a lost
 * `ifMatch` is 412. Getting that pair backwards is precisely the sort of drift a per-cloud fake exists to
 * catch.
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

class FakeContainer {
  readonly blobs = new Map<string, FakeBlob>();
  private seq = 0;
  /** Round trips issued against the service, to pin the cost of a read. */
  calls = 0;

  getBlockBlobClient(name: string): unknown {
    return {
      getProperties: async (): Promise<unknown> => {
        this.calls++;
        const blob = this.blobs.get(name);
        if (blob === undefined) throw azureError(404); // a HEAD 404 carries no error code
        return { etag: blob.etag, contentLength: blob.bytes.length };
      },
      downloadToBuffer: async (
        _offset: number,
        count?: number,
        opts?: { conditions?: { ifMatch?: string } },
      ): Promise<Buffer> => {
        this.calls++;
        const blob = this.blobs.get(name);
        if (blob === undefined) throw azureError(404, 'BlobNotFound');
        const ifMatch = opts?.conditions?.ifMatch;
        if (ifMatch !== undefined && ifMatch !== blob.etag) {
          throw azureError(412, 'ConditionNotMet');
        }
        // `count` must be the length the caller already measured; a falsy count would make the real SDK
        // issue its own getProperties first, which is the round trip this driver exists not to spend.
        expect(count).toBe(blob.bytes.length);
        return Buffer.from(blob.bytes);
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
        this.blobs.set(name, {
          bytes: Uint8Array.from(body.subarray(0, length)),
          etag: `"etag-${++this.seq}"`,
        });
      },
    };
  }

  async *listBlobsFlat(opts?: { prefix?: string }): AsyncIterable<{ name: string }> {
    for (const name of [...this.blobs.keys()].sort()) {
      if (name.startsWith(opts?.prefix ?? '')) yield { name };
    }
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

const driverOver = (container: FakeContainer, prefix = 'cloudroaring'): AzureBlobRegistryDriver =>
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

  it('reads a row in two round trips, not three', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 0 });
    const before = container.calls;
    await d.get(ref);
    // getProperties (for the ETag fence and the length) + one pinned download. Nothing else.
    expect(container.calls - before).toBe(2);
  });

  // A read-only caller must never see a WRITE conflict, and one row being rewritten must not abort an
  // enumeration over all the others. Both were true before the port pinned down what a lost pin means.
  it('re-reads rather than failing when a write lands mid-read', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 7 });
    const { key } = soleBlob(container);

    const real = container.getBlockBlobClient.bind(container);
    let armed = true;
    vi.spyOn(container, 'getBlockBlobClient').mockImplementation((name: string) => {
      const client = real(name) as { downloadToBuffer: (...a: unknown[]) => Promise<Buffer> };
      return {
        ...(client as object),
        downloadToBuffer: async (...args: unknown[]): Promise<Buffer> => {
          if (armed) {
            armed = false; // a concurrent writer moves the ETag out from under our pin
            const cur = container.blobs.get(key) as FakeBlob;
            container.blobs.set(key, { ...cur, etag: '"etag-moved"' });
          }
          return client.downloadToBuffer(...args);
        },
      } as never;
    });

    const got = await d.get(ref);
    expect(armed).toBe(false); // the race really did fire
    expect(got).not.toBeNull();
    expect(got!.currentGen).toBe(7);
    vi.restoreAllMocks();
  });

  it('rejects an oversized blob on its advertised length, before downloading it', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 0 });
    container.blobs.set(soleBlob(container).key, {
      bytes: new Uint8Array(MAX_ROW_BYTES + 1),
      etag: '"big"',
    });
    const before = container.calls;
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    expect(container.calls - before).toBe(1); // getProperties only; the body was never fetched
  });

  it('rejects a backend that omits the ETag fence entirely', async () => {
    const container = new FakeContainer();
    const d = driverOver(container);
    await d.create(ref, { currentGen: 0 });
    const { blob: cur } = soleBlob(container);
    vi.spyOn(container, 'getBlockBlobClient').mockImplementation(
      () =>
        ({
          getProperties: async () => ({ etag: undefined, contentLength: cur.bytes.length }),
          downloadToBuffer: async () => Buffer.from(cur.bytes),
        }) as never,
    );
    // Without a version there is nothing to compare-and-swap against; the driver must refuse, not proceed.
    await expect(d.get(ref)).rejects.toBeInstanceOf(IntegrityError);
    vi.restoreAllMocks();
  });
});
