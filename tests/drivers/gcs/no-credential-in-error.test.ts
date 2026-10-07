import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { Storage } from '@google-cloud/storage';
import { GcsRegistryDriver } from '@/gcs/registry';
import { GcsStorageDriver } from '@/gcs/storage';

/**
 * An error a GCS driver raises carries no credential. The SDK keeps the request it sent, `Authorization` header
 * included, on the error it raises, so an application that logs `err` or its `cause` would log a live access token.
 * The client below is the SDK's own, over a real socket to a loopback server that refuses every request, with an auth
 * client that signs each request with a stand-in token.
 */
const TOKEN = 'ya29.placeholder-token-0123456789';
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 30_000 };

const nodeRequire = createRequire(import.meta.url);
interface AuthLibrary {
  GoogleAuth: new (options: { authClient: unknown }) => unknown;
  OAuth2Client: new () => { setCredentials(credentials: { access_token: string }): void };
}
const { GoogleAuth, OAuth2Client } = nodeRequire(
  nodeRequire.resolve('google-auth-library', {
    paths: [nodeRequire.resolve('@google-cloud/storage')],
  }),
) as AuthLibrary;

function clientFor(endpoint: string): Storage {
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: TOKEN });
  return new Storage({
    projectId: 'test',
    apiEndpoint: endpoint,
    useAuthWithCustomEndpoint: true,
    authClient: new GoogleAuth({ authClient: oauth }) as never,
    retryOptions: { autoRetry: false },
  });
}

/** Every place an error could be turned into text. */
function serializations(err: unknown): string[] {
  return [
    inspect(err, { depth: null, showHidden: true }),
    JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
    String((err as { stack?: unknown }).stack),
  ];
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

for (const status of [503, 403]) {
  describe(`GCS: a ${status} from the server leaves no credential in the error`, LIMIT, () => {
    let server: Server;
    let storage: Storage;

    beforeEach(async () => {
      server = createServer((req, res) => {
        req.resume();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: status, message: 'refused' } }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      storage = clientFor(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const cases: Array<[string, (s: Storage) => Promise<unknown>]> = [
      [
        'storage getRange',
        (s) => new GcsStorageDriver({ storage: s, bucket: 'b' }).getRange(GEN, 0, 8),
      ],
      ['storage getTail', (s) => new GcsStorageDriver({ storage: s, bucket: 'b' }).getTail(GEN, 8)],
      [
        'storage putImmutable',
        (s) =>
          new GcsStorageDriver({ storage: s, bucket: 'b' }).putImmutable(GEN, async (sink) => {
            await sink.write(new Uint8Array([1, 2, 3]));
          }),
      ],
      [
        'registry get',
        (s) => new GcsRegistryDriver({ storage: s, bucket: 'b' }).get({ segment: 's' }),
      ],
    ];

    it.each(cases)('%s', async (_name, run) => {
      const err = await outcome(() => run(storage));
      for (const text of serializations(err)) expect(text).not.toContain(TOKEN);
      // The cause keeps what is useful for a diagnosis.
      const cause = (err as { cause?: { code?: unknown } }).cause;
      if (status === 503) expect(cause?.code).toBe(503);
    });
  });
}
