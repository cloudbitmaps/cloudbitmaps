import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { S3Client } from '@aws-sdk/client-s3';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { AzureBlobStorageDriver } from '@/azure-blob/storage';
import { S3RegistryDriver } from '@/s3/registry';
import { S3StorageDriver } from '@/s3/storage';

/**
 * The S3 and Azure drivers leave no credential in the errors they raise, `cause` chain included: the same check as the
 * GCS driver's, against the SDKs' own clients over a loopback server that refuses every request.
 */
const ACCESS_KEY = 'STANDINACCESSKEYID';
const SECRET = 'placeholder-secret-access-key-0123456789';
const SESSION = 'placeholder-session-token-0123456789';
const ACCOUNT_KEY = Buffer.from('stand-in-account-key-0123456789').toString('base64');
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };

/**
 * What a logger can reach: the error as `util.inspect` and `JSON.stringify` print it. With `hidden`, the properties
 * `inspect` does not list by default as well.
 */
const serializations = (err: unknown, hidden: boolean): string[] => [
  inspect(err, { depth: null, showHidden: hidden }),
  JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
  String((err as { stack?: unknown }).stack),
];

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

for (const status of [503, 403]) {
  describe(
    `S3 and Azure: a ${status} from the server leaves no credential in the error`,
    LIMIT,
    () => {
      let server: Server;
      let url: string;

      beforeEach(async () => {
        server = createServer((req, res) => {
          req.resume();
          res.writeHead(status, { 'content-type': 'application/xml' });
          res.end(`<Error><Code>Refused</Code><Message>refused</Message></Error>`);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      });
      afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      const s3 = (): S3Client =>
        new S3Client({
          endpoint: url,
          region: 'us-east-1',
          forcePathStyle: true,
          maxAttempts: 1,
          credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, sessionToken: SESSION },
        });
      const azure = (): ContainerClient =>
        new ContainerClient(`${url}/c`, new StorageSharedKeyCredential('stand-in', ACCOUNT_KEY), {
          retryOptions: { maxTries: 1 },
        });

      // The AWS SDK keeps its HTTP response, and through the socket the request line with `x-amz-security-token`, on a
      // non-enumerable property: out of reach of `inspect` and `JSON.stringify` as they print by default, so S3 is
      // checked at that level, and Azure, which keeps none, with the hidden properties too.
      const cases: Array<[string, () => Promise<unknown>, string[], boolean]> = [
        [
          'S3 getRange',
          () => new S3StorageDriver({ client: s3(), bucket: 'b' }).getRange(GEN, 0, 8),
          [SECRET, SESSION],
          false,
        ],
        [
          'S3 getTail',
          () => new S3StorageDriver({ client: s3(), bucket: 'b' }).getTail(GEN, 8),
          [SECRET, SESSION],
          false,
        ],
        [
          'S3 registry get',
          () => new S3RegistryDriver({ client: s3(), bucket: 'b' }).get({ segment: 's' }),
          [SECRET, SESSION],
          false,
        ],
        [
          'Azure getRange',
          () => new AzureBlobStorageDriver({ containerClient: azure() }).getRange(GEN, 0, 8),
          [ACCOUNT_KEY, 'SharedKey stand-in:'],
          true,
        ],
        [
          'Azure getTail',
          () => new AzureBlobStorageDriver({ containerClient: azure() }).getTail(GEN, 8),
          [ACCOUNT_KEY, 'SharedKey stand-in:'],
          true,
        ],
      ];

      it.each(cases)('%s', async (_name, run, secrets, hidden) => {
        const err = await outcome(run);
        for (const text of serializations(err, hidden)) {
          for (const secret of secrets) expect(text).not.toContain(secret);
        }
      });
    },
  );
}
