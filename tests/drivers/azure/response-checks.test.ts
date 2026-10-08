import { ValidationError, WriteConflictError } from '@/core/errors';
import { AzureBlobRegistryStore } from '@/azure-blob/registry';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { StubBlobService, xmlError } from '../../helpers/azure-blob-stub';

/**
 * What the Azure Blob drivers check before they believe an answer, over a real `ContainerClient` and the loopback stub:
 * a tail length is a whole number, a tail answer holds every byte asked for, and a compare-and-swap whose row was
 * deleted since it was read is a lost race.
 */
const GEN = { segment: 's', generation: 1 };

let stub: StubBlobService;
beforeEach(async () => {
  stub = new StubBlobService();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

async function stored(driver: AzureBlobStorageDriver, n: number): Promise<void> {
  await driver.putImmutable(GEN, async (sink) => {
    await sink.write(Uint8Array.from({ length: n }, (_, i) => i % 251));
  });
}

describe('Azure Blob: an answer is checked against the request', () => {
  it('a tail length that is not a whole number is refused, not read', async () => {
    const driver = new AzureBlobStorageDriver({ containerClient: stub.client() });
    await stored(driver, 64);
    for (const maxBytes of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(driver.getTail(GEN, maxBytes)).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await driver.getTail(GEN, 8)).bytes.length).toBe(8);
  });

  it('a tail answer short of the bytes asked for is refused', async () => {
    const driver = new AzureBlobStorageDriver({ containerClient: stub.client() });
    await stored(driver, 64);
    stub.getOverride = (cur) => {
      const body = cur!.body.subarray(64 - 7); // 7 of the 8 asked for
      return {
        status: 206,
        headers: {
          'content-length': String(body.length),
          'content-range': `bytes 57-63/64`,
          etag: cur!.etag,
        },
        body: Buffer.from(body),
      };
    };
    await expect(driver.getTail(GEN, 8)).rejects.toThrow(/holds 7B of the 8B requested/);
  });

  it('a compare-and-swap whose row was deleted since it was read is a lost race', async () => {
    const store = new AzureBlobRegistryStore(stub.client(), 0, false);
    await store.write('registry/_default/s.reg', new TextEncoder().encode('{}'), 'absent');
    const row = await store.read('registry/_default/s.reg');
    stub.blobs.delete('registry/_default/s.reg');
    // Azurite answers this write 412 `ConditionNotMet`; a service that answers the missing blob instead says 404.
    stub.plan = (req) =>
      req.method === 'PUT' && req.ifMatch !== undefined
        ? { respond: xmlError(404, 'BlobNotFound') }
        : undefined;
    await expect(
      store.write('registry/_default/s.reg', new TextEncoder().encode('{}'), {
        version: row!.version,
      }),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });
});
