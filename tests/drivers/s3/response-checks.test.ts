import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { IntegrityError, ValidationError } from '@/core/errors';
import { S3RegistryDriver } from '@/s3/registry';
import { S3StorageDriver } from '@/s3/storage';
import { spanFromContentRange } from '@/s3/s3-errors';

/**
 * What the S3 drivers check of an answer before they believe it, against a real `S3Client` over a loopback server: a
 * range answer must hold the bytes asked for, not as many from elsewhere, and a listing that says it is truncated must
 * say how to go on.
 */
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };

type Answer = (req: IncomingMessage, res: ServerResponse) => void;

describe('S3: an answer is checked against the request', LIMIT, () => {
  let server: Server;
  let client: S3Client;
  let answer: Answer;

  beforeEach(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => answer(req, res));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    client = new S3Client({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      region: 'us-east-1',
      credentials: { accessKeyId: 'stub', secretAccessKey: 'stub' },
      forcePathStyle: true,
      maxAttempts: 1,
    });
  });
  afterEach(async () => {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const ranged =
    (contentRange: string | undefined): Answer =>
    (_req, res) => {
      res.writeHead(contentRange === undefined ? 200 : 206, {
        'content-length': '4',
        ...(contentRange === undefined ? {} : { 'content-range': contentRange }),
      });
      res.end(Buffer.from([1, 2, 3, 4]));
    };

  it('a range answer of the right length from the wrong place is refused', async () => {
    answer = ranged('bytes 10-13/100');
    const driver = new S3StorageDriver({ client, bucket: 'b' });
    const err = await driver.getRange(GEN, 0, 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(String(err)).toMatch(/not \[0, 4\)/);
    // A whole object answered for a range that does not start at 0 is not that range either.
    answer = ranged(undefined);
    await expect(driver.getRange(GEN, 2, 4)).rejects.toBeInstanceOf(ValidationError);
  });

  it('a tail answer that is not the suffix asked for is refused', async () => {
    const driver = new S3StorageDriver({ client, bucket: 'b' });
    // Four bytes from the middle of a 100-byte object, for the last four asked.
    answer = ranged('bytes 10-13/100');
    await expect(driver.getTail(GEN, 4)).rejects.toBeInstanceOf(ValidationError);
    // The last four bytes, but a header that says it holds five.
    answer = ranged('bytes 95-99/100');
    await expect(driver.getTail(GEN, 4)).rejects.toBeInstanceOf(ValidationError);
    // The suffix asked for.
    answer = ranged('bytes 96-99/100');
    expect(await driver.getTail(GEN, 4)).toEqual({
      bytes: Uint8Array.from([1, 2, 3, 4]),
      size: 100,
    });
    // An empty object, as MinIO answers it.
    answer = (_req, res) => {
      res.writeHead(206, { 'content-length': '0', 'content-range': 'bytes 0--1/0' });
      res.end();
    };
    expect(await driver.getTail(GEN, 8)).toEqual({ bytes: new Uint8Array(0), size: 0 });
    // A whole object shorter than the tail asked for.
    answer = ranged('bytes 0-3/4');
    expect(await driver.getTail(GEN, 8)).toEqual({ bytes: Uint8Array.from([1, 2, 3, 4]), size: 4 });
  });

  it('control: the bytes asked for are returned', async () => {
    const driver = new S3StorageDriver({ client, bucket: 'b' });
    answer = ranged('bytes 10-13/100');
    expect([...(await driver.getRange(GEN, 10, 4))]).toEqual([1, 2, 3, 4]);
    answer = ranged(undefined);
    expect([...(await driver.getRange(GEN, 0, 4))]).toEqual([1, 2, 3, 4]);
  });

  it('a listing that hands back the token it was asked with is refused, not asked again forever', async () => {
    let asked = 0;
    answer = (_req, res) => {
      asked += 1;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><IsTruncated>true</IsTruncated>' +
          '<NextContinuationToken>same</NextContinuationToken></ListBucketResult>',
      );
    };
    const drain = async (it: AsyncIterable<unknown>) => {
      for await (const _ of it) void _;
    };
    await expect(
      drain(new S3StorageDriver({ client, bucket: 'b' }).list({ segment: 's' })),
    ).rejects.toThrow('returned the continuation token it was given');
    await expect(drain(new S3RegistryDriver({ client, bucket: 'b' }).list())).rejects.toThrow(
      'returned the continuation token it was given',
    );
    expect(asked).toBe(4);
  });

  it('a listing that says it is truncated and gives no token is refused, not ended short', async () => {
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><IsTruncated>true</IsTruncated>' +
          '<Contents><Key>registry/_default/a.reg</Key></Contents></ListBucketResult>',
      );
    };
    const storage = new S3StorageDriver({ client, bucket: 'b' });
    await expect(
      (async () => {
        for await (const _ of storage.list({ segment: 's' })) void _;
      })(),
    ).rejects.toBeInstanceOf(IntegrityError);
    const registry = new S3RegistryDriver({ client, bucket: 'b' });
    await expect(
      (async () => {
        for await (const _ of registry.list()) void _;
      })(),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('spanFromContentRange', () => {
  it('reads the first and last byte, and nothing it cannot parse', () => {
    expect(spanFromContentRange('bytes 0-3/100')).toEqual({ start: 0, end: 3 });
    expect(spanFromContentRange('bytes 10-13/*')).toEqual({ start: 10, end: 13 });
    expect(spanFromContentRange(undefined)).toBeUndefined();
    expect(spanFromContentRange('bytes */100')).toBeUndefined();
    expect(spanFromContentRange('items 0-3/100')).toBeUndefined();
  });
});
