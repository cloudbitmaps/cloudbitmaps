import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from '@/s3/backend';
import { ValidationError } from '@/core/errors';

/**
 * The client the store builds opens up to `maxSockets` connections at once (128 by default; the SDK's own default is
 * 50). The server here accepts every request and answers none, so each in-flight read holds one socket for as long as
 * the test wants, and the connections it has accepted are the sockets the client opened. Nothing leaves loopback.
 */

const BURST = 200;
let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Send a burst of reads against a parked server and return how many connections the client opened. */
async function socketsOpened(options: { maxSockets?: number }, burst = BURST): Promise<number> {
  const sockets = new Set<Socket>();
  const parked = createServer(() => {
    /* accept the request, never answer */
  });
  server = parked;
  parked.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => parked.listen(0, '127.0.0.1', resolve));
  const { port } = parked.address() as AddressInfo;
  const { client } = new S3Storage({
    bucket: 'b',
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${port}`,
    pathStyle: true,
    credentials: { accessKeyId: 'a', secretAccessKey: 's' },
    ...options,
  });
  const abort = new AbortController();
  const reads = Array.from({ length: burst }, (_, i) =>
    client
      .send(new GetObjectCommand({ Bucket: 'b', Key: `k${i}` }), { abortSignal: abort.signal })
      .catch(() => undefined),
  );
  // Long enough for every socket the pool will grant to connect; a pool that granted more would have by now.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const opened = sockets.size;
  abort.abort();
  await Promise.all(reads);
  client.destroy();
  return opened;
}

describe('S3Storage maxSockets, on the client it builds', () => {
  it('allows 128 sockets by default, more than the SDK default of 50', async () => {
    expect(await socketsOpened({})).toBe(128);
  });

  it('allows exactly `maxSockets` when set, below and above the default', async () => {
    expect(await socketsOpened({ maxSockets: 10 })).toBe(10);
    expect(await socketsOpened({ maxSockets: 160 })).toBe(160);
  });

  it('sets the limit on the https agent and the http agent, and keeps the SDK keep-alive default', async () => {
    const agents = async (options: { maxSockets?: number }) => {
      const { client } = new S3Storage({ bucket: 'b', region: 'us-east-1', ...options });
      const handler = client.config.requestHandler as unknown as {
        configProvider: Promise<{
          httpAgent?: { maxSockets: number; keepAlive?: boolean };
          httpsAgent: { maxSockets: number; keepAlive?: boolean };
          httpAgentProvider: () => Promise<{ maxSockets: number; keepAlive?: boolean }>;
        }>;
      };
      const config = await handler.configProvider;
      return {
        httpsAgent: config.httpsAgent,
        httpAgent: config.httpAgent ?? (await config.httpAgentProvider()),
      };
    };
    const dflt = await agents({});
    expect([dflt.httpsAgent.maxSockets, dflt.httpAgent.maxSockets]).toEqual([128, 128]);
    expect([dflt.httpsAgent.keepAlive, dflt.httpAgent.keepAlive]).toEqual([true, true]);
    const set = await agents({ maxSockets: 77 });
    expect([set.httpsAgent.maxSockets, set.httpAgent.maxSockets]).toEqual([77, 77]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8' as unknown as number])(
    'refuses %s',
    (value) => {
      const build = () => new S3Storage({ bucket: 'b', maxSockets: value });
      expect(build).toThrow(ValidationError);
      expect(build).toThrow(/`maxSockets` must be a positive integer/);
    },
  );

  it('leaves a client the caller passes untouched', () => {
    const client = new S3Client({ region: 'us-east-1' });
    const handler = client.config.requestHandler;
    const store = new S3Storage({ bucket: 'b', client });
    expect(store.client).toBe(client);
    expect(client.config.requestHandler).toBe(handler);
  });
});
