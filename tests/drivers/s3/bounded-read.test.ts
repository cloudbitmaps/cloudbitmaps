import { S3Client } from '@aws-sdk/client-s3';
import { IntegrityError, ValidationError } from '@/core/errors';
import { S3RegistryDriver } from '@/s3/registry';
import { S3StorageDriver } from '@/s3/storage';
import { BOUNDED, EndlessServer } from '../../helpers/endless-http';

/**
 * A response body is read as a stream and counted: a server that ignores the range, or sends a body with no length,
 * cannot make the driver hold more than the read asked for. Each read fails with a typed error as soon as the count
 * passes what was expected, and what the server managed to send stays within the socket buffers.
 */
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };

describe('S3: a response body is bounded by what the read asked for', LIMIT, () => {
  let server: EndlessServer;
  let client: S3Client;

  beforeEach(async () => {
    server = new EndlessServer();
    await server.start();
    client = new S3Client({
      endpoint: server.url,
      region: 'us-east-1',
      credentials: { accessKeyId: 'stub', secretAccessKey: 'stub' },
      forcePathStyle: true,
      maxAttempts: 1,
    });
  });
  afterEach(async () => {
    client.destroy();
    await server.stop();
  });

  it('getRange refuses a body longer than the range', async () => {
    const driver = new S3StorageDriver({ client, bucket: 'b' });
    const err = await driver.getRange(GEN, 0, 16).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(server.sent).toBeLessThan(BOUNDED);
  });

  it('getTail refuses a body longer than maxBytes', async () => {
    const driver = new S3StorageDriver({ client, bucket: 'b' });
    const err = await driver.getTail(GEN, 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(server.sent).toBeLessThan(BOUNDED);
  });

  it('a registry row with no Content-Length is refused at the row cap', async () => {
    const registry = new S3RegistryDriver({ client, bucket: 'b' });
    const err = await registry.get({ segment: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(server.sent).toBeLessThan(BOUNDED);
  });
});
