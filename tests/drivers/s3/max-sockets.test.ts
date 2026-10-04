import { createServer, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from '@/s3/backend';
import { ValidationError } from '@/core/errors';

/**
 * The client the store builds opens up to `maxSockets` connections at once (128 by default; the SDK's own default is
 * 50), and is otherwise the SDK's own: a plain `S3Client` is the reference each test compares it with. The server here
 * accepts every request and answers none, so each in-flight request holds one socket for as long as the test wants, and
 * the connections it has accepted are the sockets the client opened. Nothing leaves loopback.
 */

const BURST = 200;
const CREDENTIALS = { accessKeyId: 'a', secretAccessKey: 's' };

let server: Server | TcpServer | undefined;
let sockets = new Set<Socket>();
let expects: (string | undefined)[] = [];

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A TLS endpoint that accepts connections and never answers the handshake, so each https request holds one socket. */
async function parkTls(): Promise<string> {
  sockets = new Set();
  const mine = sockets;
  const parked = createTcpServer((socket) => {
    mine.add(socket);
  });
  server = parked;
  await new Promise<void>((resolve) => parked.listen(0, '127.0.0.1', resolve));
  return `https://127.0.0.1:${(parked.address() as AddressInfo).port}`;
}

async function park(): Promise<string> {
  sockets = new Set();
  expects = [];
  const mineExpects = expects;
  const parked = createServer((req) => {
    mineExpects.push(req.headers.expect);
  });
  server = parked;
  const mine = sockets;
  parked.on('connection', (socket) => mine.add(socket));
  // A request that asks for `100-continue` is answered by this event, not the request one: take it and answer nothing.
  parked.on('checkContinue', (req) => {
    mineExpects.push(req.headers.expect);
  });
  await new Promise<void>((resolve) => parked.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(parked.address() as AddressInfo).port}`;
}

/** Wait until the server has accepted `count` connections, or `ms` has passed; the count it reached either way. */
async function until(count: number, ms = 5_000): Promise<number> {
  const end = Date.now() + ms;
  while (sockets.size < count && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  // A little longer, so a client that opens more than `count` is seen doing it.
  await new Promise((r) => setTimeout(r, 150));
  return sockets.size;
}

/** Send a burst of reads through `client` against the parked server; resolves with the connections it opened. */
async function burst(client: S3Client, count: number, wanted: number): Promise<number> {
  const abort = new AbortController();
  const reads = Array.from({ length: count }, (_, i) =>
    client
      .send(new GetObjectCommand({ Bucket: 'b', Key: `k${i}` }), { abortSignal: abort.signal })

      .catch(() => undefined),
  );
  const opened = await until(wanted, 1500);
  abort.abort();
  await Promise.all(reads);
  client.destroy();
  return opened;
}

const built = (endpoint: string, options: { maxSockets?: number } = {}): S3Client =>
  new S3Storage({
    bucket: 'b',
    region: 'us-east-1',
    endpoint,
    pathStyle: true,
    credentials: CREDENTIALS,
    ...options,
  }).client;

describe('S3Storage maxSockets, on the client it builds', () => {
  it('allows 128 sockets by default, more than the SDK default of 50', async () => {
    expect(await burst(built(await park()), BURST, 128)).toBe(128);
  });

  it('allows exactly `maxSockets` when set, below and above the default', async () => {
    expect(await burst(built(await park(), { maxSockets: 10 }), BURST, 10)).toBe(10);
    expect(await burst(built(await park(), { maxSockets: 160 }), BURST, 160)).toBe(160);
  });

  it('holds on the very first burst to a plain-http endpoint', async () => {
    // The SDK's own handler makes its http agent on the first request, so the limit has to be in place before it.
    expect(await burst(built(await park(), { maxSockets: 20 }), 80, 20)).toBe(20);
  });

  it('limits https too: no more sockets are opened to a TLS endpoint than `maxSockets`', async () => {
    const endpoint = await parkTls();
    const { client } = new S3Storage({
      bucket: 'b',
      region: 'us-east-1',
      endpoint,
      pathStyle: true,
      credentials: CREDENTIALS,
      maxSockets: 12,
    });
    // The server speaks no TLS, so each connect is accepted and the handshake never finishes: the sockets stay open.
    expect(await burst(client, 60, 12)).toBe(12);
  });

  it("a plain client's https pool is the SDK's 50, the reference the built client's 128 is set against", async () => {
    // A plain client's https pool is 50; the built client's is 128. Compared on https, where the SDK makes its agent up front.
    const endpoint = await parkTls();
    const plain = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: CREDENTIALS,
    });
    expect(await burst(plain, BURST, 50)).toBe(50);
  });

  it('keeps `Expect: 100-continue` uploads off the pool, as the SDK does', async () => {
    const parts = 40;
    const send = async (
      make: (endpoint: string) => S3Client,
    ): Promise<{ opened: number; expect: Set<string | undefined> }> => {
      const client = make(await park());
      const abort = new AbortController();
      const puts = Array.from({ length: parts }, (_, i) =>
        client
          .send(new PutObjectCommand({ Bucket: 'b', Key: `p${i}`, Body: Buffer.alloc(3 << 20) }), {
            abortSignal: abort.signal,
          })
          .catch(() => undefined),
      );
      const opened = await until(parts);
      const seen = new Set(expects);
      abort.abort();
      await Promise.all(puts);
      client.destroy();
      return { opened, expect: seen };
    };
    const plain = await send(
      (endpoint) =>
        new S3Client({
          region: 'us-east-1',
          endpoint,
          forcePathStyle: true,
          credentials: CREDENTIALS,
        }),
    );
    expect(plain.expect.has('100-continue')).toBe(true);
    // With a pool of 2, uploads that went through it would open 2 connections; the SDK's own route opens one each.
    const mine = await send((endpoint) => built(endpoint, { maxSockets: 2 }));
    expect(mine.expect.has('100-continue')).toBe(true);
    expect(mine.opened).toBe(plain.opened);
  });

  it('keeps the SDK defaults-mode connection timeout', async () => {
    const before = process.env.AWS_DEFAULTS_MODE;
    process.env.AWS_DEFAULTS_MODE = 'in-region';
    try {
      const timeout = async (client: S3Client): Promise<unknown> => {
        const handler = (await client.config.requestHandler) as unknown as {
          httpHandlerConfigs?: () => { connectionTimeout?: number };
          configProvider?: Promise<{ connectionTimeout?: number }>;
        };
        return (await handler.configProvider)?.connectionTimeout;
      };
      const plain = await timeout(new S3Client({ region: 'us-east-1' }));
      expect(plain).toBe(1100);
      expect(await timeout(new S3Storage({ bucket: 'b', region: 'us-east-1' }).client)).toBe(plain);
    } finally {
      if (before === undefined) delete process.env.AWS_DEFAULTS_MODE;
      else process.env.AWS_DEFAULTS_MODE = before;
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8' as unknown as number])(
    'refuses %s',
    (value) => {
      const build = () => new S3Storage({ bucket: 'b', maxSockets: value });
      expect(build).toThrow(ValidationError);
      expect(build).toThrow(/maxSockets must be a positive safe integer; got /);
    },
  );

  it('names a string value in quotes, as `readTimeoutMs` does', () => {
    expect(() => new S3Storage({ bucket: 'b', maxSockets: '8' as unknown as number })).toThrow(
      'got "8"',
    );
  });
});

describe('a client the caller passes', () => {
  it('is untouched: same object, same handler, and its pool is still the SDK default', async () => {
    const client = new S3Client({ region: 'us-east-1' });
    const handler = client.config.requestHandler;
    const before = await (handler as unknown as { configProvider: Promise<unknown> })
      .configProvider;
    const store = new S3Storage({ bucket: 'b', client });
    expect(store.client).toBe(client);
    expect(client.config.requestHandler).toBe(handler);
    expect(await (handler as unknown as { configProvider: Promise<unknown> }).configProvider).toBe(
      before,
    );
    const endpoint = await parkTls();
    const passed = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: CREDENTIALS,
    });
    new S3Storage({ bucket: 'b', client: passed });
    expect(await burst(passed, BURST, 50)).toBe(50);
  });
});
