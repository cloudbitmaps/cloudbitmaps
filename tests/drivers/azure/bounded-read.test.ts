import { AnonymousCredential, ContainerClient } from '@azure/storage-blob';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { ValidationError } from '@/core/errors';
import { BOUNDED, EndlessServer } from '../../helpers/endless-http';

/**
 * A response body is read as a stream and counted: a server that ignores the range, or sends a body with no length,
 * cannot make the driver hold more than the read asked for. Each read fails with a typed error as soon as the count
 * passes what was expected, and what the server managed to send stays within the socket buffers.
 */
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };

describe('Azure: a response body is bounded by what the read asked for', LIMIT, () => {
  let server: EndlessServer;
  let driver: AzureBlobStorageDriver;

  beforeEach(async () => {
    server = new EndlessServer();
    // The SDK requires a length header, so the server declares a vast one and never finishes it.
    await server.start(206, {
      'content-length': '1099511627776',
      'content-range': 'bytes 0-1099511627775/1099511627776',
      'x-ms-blob-type': 'BlockBlob',
      etag: '"e"',
    });
    const container = new ContainerClient(`${server.url}/c`, new AnonymousCredential(), {
      retryOptions: { maxTries: 1 },
    });
    driver = new AzureBlobStorageDriver({ containerClient: container });
  });
  afterEach(async () => {
    await server.stop();
  });

  it('getRange refuses a body longer than the range', async () => {
    const err = await driver.getRange(GEN, 0, 16).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(server.sent).toBeLessThan(BOUNDED);
  });

  it('getTail refuses a body longer than the tail it asked for', async () => {
    const err = await driver.getTail(GEN, 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(server.sent).toBeLessThan(BOUNDED);
  });
});
