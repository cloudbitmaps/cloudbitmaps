import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from '@/s3/backend';
import { SocketAdvisory, SOCKET_ADVISORY_CONCURRENCY } from '@/s3/socket-advisory';
import { CloudRoaring } from '@/index';
import { DEFAULT_INTERSECT_CONCURRENCY } from '@/core/engine';
import { MemoryStorage } from '@/drivers/backends';
import type { IMetricsSink, MetricEvent } from '@/core/metrics';

/**
 * A pool smaller than twice the default window earns one advisory event on the metrics sink, once the first read has
 * run and the SDK's handler has made its agents. The reads go to a plain-HTTP server in this process that answers a
 * ranged GET with four bytes, through the SDK's own default handler, so what is read is what the SDK built. Nothing
 * leaves loopback, and the credentials are dummies.
 */

const CREDENTIALS = { accessKeyId: 'a', secretAccessKey: 's' };
const KEY = { segment: 'seg', generation: 1 };

let server: Server | undefined;
let requests = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function endpoint(): Promise<string> {
  requests = 0;
  const s = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(206, { 'content-length': '4', 'content-range': 'bytes 0-3/4' });
    res.end('abcd');
  });
  server = s;
  s.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => s.listen({ port: 0, host: '127.0.0.1' }, resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function recorder(): { sink: IMetricsSink; events: MetricEvent[] } {
  const events: MetricEvent[] = [];
  return { sink: { onEvent: (e) => void events.push(e) }, events };
}

function sdkClient(url: string, extra: Record<string, unknown> = {}): S3Client {
  return new S3Client({
    region: 'us-east-1',
    endpoint: url,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    maxAttempts: 1,
    ...extra,
  });
}

function builtStore(url: string, maxSockets?: number): S3Storage {
  return new S3Storage({
    bucket: 'b',
    endpoint: url,
    pathStyle: true,
    region: 'us-east-1',
    credentials: CREDENTIALS,
    ...(maxSockets === undefined ? {} : { maxSockets }),
  });
}

/** One read, then a turn of the loop, so the check the first read starts has settled. */
async function read(store: S3Storage): Promise<Uint8Array> {
  const bytes = await store.storage.getRange(KEY, 0, 4);
  await new Promise((resolve) => setImmediate(resolve));
  return bytes;
}

describe('socket pool advisory', () => {
  it('the threshold is twice the store default window, which the engine owns', () => {
    expect(SOCKET_ADVISORY_CONCURRENCY).toBe(DEFAULT_INTERSECT_CONCURRENCY);
  });

  it('the SDK default client (50 sockets) emits exactly one event after the first read, none after', async () => {
    const url = await endpoint();
    const client = sdkClient(url);
    const store = new S3Storage({ bucket: 'my-bucket', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    expect(events).toEqual([]);
    await read(store);
    expect(events).toEqual([
      {
        kind: 'advisory',
        code: 'socket-pool-below-window',
        driver: 's3',
        bucket: 'my-bucket',
        maxSockets: 50,
        threshold: 64,
        concurrency: 32,
      },
    ]);
    await Promise.all([read(store), read(store), read(store)]);
    await read(store);
    expect(events).toHaveLength(1);
    expect(requests).toBe(5);
    client.destroy();
  });

  it('the event carries only its seven fields: no credential, endpoint, prefix or key', async () => {
    const url = await endpoint();
    const client = sdkClient(url);
    const store = new S3Storage({ bucket: 'b', prefix: 'tenant-prefix', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(
      ['bucket', 'code', 'concurrency', 'driver', 'kind', 'maxSockets', 'threshold'].sort(),
    );
    const text = JSON.stringify(events);
    for (const needle of [url, 'tenant-prefix', 'seg']) expect(text).not.toContain(needle);
    client.destroy();
  });

  it('an injected agent with 64 sockets (twice the window) is enough, 63 is not', async () => {
    const url = await endpoint();
    for (const [sockets, fires] of [
      [64, false],
      [63, true],
    ] as const) {
      const client = sdkClient(url, {
        requestHandler: { httpAgent: new Agent({ maxSockets: sockets }) },
      });
      const store = new S3Storage({ bucket: 'b', client });
      const { sink, events } = recorder();
      store.attachMetrics(sink);
      await read(store);
      expect(events.length, `maxSockets ${sockets}`).toBe(fires ? 1 : 0);
      client.destroy();
    }
  });

  it('the client the store builds (128 sockets) never fires', async () => {
    const url = await endpoint();
    const store = builtStore(url);
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    await read(store);
    expect(events).toEqual([]);
    store.client.destroy();
  });

  it('a built client the caller sized below the window does fire, once', async () => {
    const url = await endpoint();
    const store = builtStore(url, 10);
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    await read(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'advisory', maxSockets: 10, threshold: 64 });
    store.client.destroy();
  });

  it('an agent with no socket limit reads Infinity and does not fire', async () => {
    const url = await endpoint();
    const client = sdkClient(url, {
      requestHandler: { httpAgent: new Agent({ keepAlive: true }) },
    });
    const store = new S3Storage({ bucket: 'b', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    expect(events).toEqual([]);
    client.destroy();
  });

  it('reads the agent of the scheme the client talks, not the other one the SDK made', async () => {
    const url = await endpoint();
    const client = sdkClient(url, {
      requestHandler: {
        httpAgent: new Agent({ maxSockets: 200 }),
        httpsAgent: new Agent({ maxSockets: 5 }),
      },
    });
    const store = new S3Storage({ bucket: 'b', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    expect(events).toEqual([]);
    client.destroy();
  });

  it('a custom handler: no event and no throw', async () => {
    const handler = {
      handle: () =>
        Promise.resolve({
          response: {
            statusCode: 206,
            headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' },
            body: Readable.from([Buffer.from('abcd')]),
          },
        }),
      destroy: () => undefined,
    };
    const client = new S3Client({
      region: 'us-east-1',
      credentials: CREDENTIALS,
      requestHandler: handler as never,
    });
    const store = new S3Storage({ bucket: 'b', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await expect(read(store)).resolves.toBeInstanceOf(Uint8Array);
    expect(events).toEqual([]);
  });

  it('a handler whose configs throw or are shaped wrongly: no event and no throw', async () => {
    for (const handler of [
      {
        httpHandlerConfigs: () => {
          throw new Error('boom');
        },
      },
      { httpHandlerConfigs: () => null },
      { httpHandlerConfigs: () => ({ httpsAgent: { maxSockets: 'many' } }) },
      { httpHandlerConfigs: () => ({}) },
    ]) {
      const client = { config: { requestHandler: handler } } as unknown as S3Client;
      const advisory = new SocketAdvisory(client, 'b');
      const { sink, events } = recorder();
      advisory.attach(sink);
      await expect(Promise.resolve(advisory.afterRequest())).resolves.toBeUndefined();
      expect(events).toEqual([]);
    }
  });

  it('nothing is read from the client on any request after the first', async () => {
    let reads = 0;
    const client = {
      config: {
        requestHandler: {
          httpHandlerConfigs: () => {
            reads += 1;
            return { httpsAgent: { maxSockets: 50 } };
          },
        },
      },
    } as unknown as S3Client;
    const advisory = new SocketAdvisory(client, 'b');
    const { sink, events } = recorder();
    advisory.attach(sink);
    await advisory.afterRequest();
    for (let i = 0; i < 1000; i++) expect(advisory.afterRequest()).toBeUndefined();
    expect(reads).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('with no sink attached, no request reads the client', () => {
    let reads = 0;
    const client = {
      config: {
        requestHandler: {
          httpHandlerConfigs: () => {
            reads += 1;
            return { httpsAgent: { maxSockets: 50 } };
          },
        },
      },
    } as unknown as S3Client;
    const advisory = new SocketAdvisory(client, 'b');
    for (let i = 0; i < 10; i++) expect(advisory.afterRequest()).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('the check sends no request of its own', async () => {
    const url = await endpoint();
    const client = sdkClient(url);
    const store = new S3Storage({ bucket: 'b', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    expect(events).toHaveLength(1);
    expect(requests).toBe(1);
    client.destroy();
  });

  it('prints nothing: no console output and no process warning', async () => {
    const url = await endpoint();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const client = sdkClient(url);
    const store = new S3Storage({ bucket: 'b', client });
    const { sink, events } = recorder();
    store.attachMetrics(sink);
    await read(store);
    await read(store);
    expect(events).toHaveLength(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    client.destroy();
  });

  it('a sink that throws does not break the read', async () => {
    const url = await endpoint();
    const client = sdkClient(url);
    const store = new S3Storage({ bucket: 'b', client });
    store.attachMetrics({
      onEvent: () => {
        throw new Error('sink bug');
      },
    });
    await expect(read(store)).resolves.toHaveLength(4);
    client.destroy();
  });

  it('a store with a metrics sink hands it to a backend that asks for it, and not a no-op', () => {
    const attached: IMetricsSink[] = [];
    const backend = Object.assign(new MemoryStorage(), {
      attachMetrics: (sink: IMetricsSink) => void attached.push(sink),
    });
    const { sink } = recorder();
    new CloudRoaring({ storage: backend, metrics: sink });
    expect(attached).toHaveLength(1);
    new CloudRoaring({ storage: backend });
    expect(attached).toHaveLength(1);
  });

  it('through a store, the advisory reaches the sink the store was given', async () => {
    const url = await endpoint();
    const client = sdkClient(url);
    const backend = new S3Storage({ bucket: 'b', client });
    const { sink, events } = recorder();
    const store = new CloudRoaring({ storage: backend, metrics: sink });
    await backend.storage.getRange(KEY, 0, 4);
    expect(events.filter((e) => e.kind === 'advisory')).toHaveLength(1);
    expect(store).toBeDefined();
    client.destroy();
  });
});
