import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { Storage } from '@google-cloud/storage';
import { GcsRegistryDriver } from '@/gcs/registry';
import { GcsStorageDriver } from '@/gcs/storage';

/**
 * The SDK's error reaches, through the request and the HTTP agent it shares with every other call, the raw request text
 * of requests still in flight, each with its own bearer token. A large upload refused before its body is read, a failing
 * call beside a call still running, and a failing call after an abandoned upload all leave such a socket reachable.
 * The error a driver throws holds none of it, however it is printed, and the live objects are not changed.
 */
const TOKEN = 'ya29.placeholder-live-token-0123456789';
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 40_000 };
const BIG = new Uint8Array(6 * 1024 * 1024);

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

const clientFor = (endpoint: string): Storage => {
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: TOKEN });
  return new Storage({
    projectId: 'test',
    apiEndpoint: endpoint,
    useAuthWithCustomEndpoint: true,
    authClient: new GoogleAuth({ authClient: oauth }) as never,
    retryOptions: { autoRetry: false },
  });
};

const serializations = (err: unknown): string[] => [
  inspect(err, { depth: null, showHidden: true }),
  JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
  String((err as { stack?: unknown }).stack),
];

const outcome = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};

type Mode = 'refuse-uploads' | 'hang-uploads';

describe('GCS: the error holds no live request, whatever else is in flight', LIMIT, () => {
  let server: Server;
  let storage: Storage;
  const pending: Array<Promise<unknown>> = [];

  const start = async (mode: Mode): Promise<void> => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.startsWith('/upload/') === true) {
        if (mode === 'refuse-uploads') {
          // Answered before the body is read: the request is still being sent.
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 403, message: 'refused' } }));
        }
        return; // 'hang-uploads': never answered
      }
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 503, message: 'unavailable' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    storage = clientFor(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  };

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(pending.splice(0));
  });

  const upload = (driver: GcsStorageDriver): Promise<unknown> =>
    driver.putImmutable(GEN, async (sink) => {
      await sink.write(BIG);
    });
  const drain = async (it: AsyncIterable<unknown>): Promise<void> => {
    for await (const item of it) void item;
  };
  const expectClean = (err: unknown): void => {
    for (const text of serializations(err)) expect(text).not.toContain(TOKEN);
  };

  it('a 6 MiB upload answered 403 before its body is read', async () => {
    await start('refuse-uploads');
    expectClean(await outcome(() => upload(new GcsStorageDriver({ storage, bucket: 'b' }))));
  });

  it('a failing delete and list while an upload is still in flight on the same client', async () => {
    await start('hang-uploads');
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    const registry = new GcsRegistryDriver({ storage, bucket: 'b' });
    pending.push(upload(driver).catch(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectClean(await outcome(() => driver.delete(GEN)));
    expectClean(await outcome(() => drain(driver.list({ segment: 's' }))));
    expectClean(await outcome(() => registry.delete({ segment: 's' })));
    expectClean(await outcome(() => drain(registry.list())));
  });

  it('a failing delete and list after an abandoned upload', async () => {
    await start('hang-uploads');
    const driver = new GcsStorageDriver({ storage, bucket: 'b' });
    pending.push(upload(driver).catch(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectClean(await outcome(() => driver.delete(GEN)));
    expectClean(await outcome(() => drain(driver.list({ segment: 's' }))));
  });
});
