import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

// The workload client's socket limit in the calibration harness: 128 unless `CR_CALIBRATE_MAX_SOCKETS` says another, set
// on the SDK handler's own agents, and recorded as the value read back from them after the run, or null when they
// cannot be read. The observable test parks requests on a loopback server and counts the connections accepted.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Evidence = { maxSockets: number | null; maxSocketsSource: string };
const processLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
  LIBRARY_MAX_SOCKETS: number;
  limitSockets: (client: unknown, maxSockets: number) => void;
  socketsOf: (client: unknown) => number | null;
  resolveSocketLimit: (raw: string | undefined) => { maxSockets: number; overridden: boolean };
  limitWorkloadSockets: (
    client: unknown,
    raw: string | undefined,
  ) => Promise<{ observed: number; evidence: () => Evidence }>;
  socketEvidence: (i: {
    observed: number | null;
    configured: number;
    overridden: boolean;
  }) => Evidence;
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  resolveMaxSockets: (raw: string | undefined, fallback: number) => number;
  clientConfigs: (base: Record<string, unknown>) => { work: Record<string, unknown> };
};

const CREDENTIALS = { accessKeyId: 'a', secretAccessKey: 's' };
let server: Server | undefined;
let sockets = new Set<Socket>();

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => s.close(() => done()));
  }
});

async function park(): Promise<string> {
  sockets = new Set();
  const mine = sockets;
  const parked = createServer(() => undefined);
  server = parked;
  parked.on('connection', (socket) => mine.add(socket));
  await new Promise<void>((done) =>
    parked.listen({ port: 0, host: '127.0.0.1', backlog: 1024 }, done),
  );
  return `http://127.0.0.1:${(parked.address() as AddressInfo).port}`;
}

/** The workload client as the harness builds it: its configuration, then the limit. */
function workClient(endpoint: string, limit: number | undefined): S3Client {
  const client = new S3Client(
    guards.clientConfigs({
      endpoint,
      region: 'us-east-1',
      credentials: CREDENTIALS,
      forcePathStyle: true,
    }).work,
  );
  if (limit !== undefined) processLib.limitSockets(client, limit);
  return client;
}

/** A burst of `count` reads; the connections the server accepted, and what the agents said after it. */
async function burst(client: S3Client, count: number, wanted: number) {
  const abort = new AbortController();
  const reads = Array.from({ length: count }, (_, i) =>
    client
      .send(new GetObjectCommand({ Bucket: 'b', Key: `k${i}` }), { abortSignal: abort.signal })
      .catch(() => undefined),
  );
  const end = Date.now() + 1500;
  while (sockets.size < wanted && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 150));
  const opened = sockets.size;
  const observed = processLib.socketsOf(client);
  abort.abort();
  await Promise.all(reads);
  client.destroy();
  return { opened, observed };
}

describe('the workload client socket limit', () => {
  it("defaults to the library's 128", () => {
    expect(processLib.LIBRARY_MAX_SOCKETS).toBe(128);
    expect(guards.resolveMaxSockets(undefined, processLib.LIBRARY_MAX_SOCKETS)).toBe(128);
    expect(guards.resolveMaxSockets('', 128)).toBe(128);
  });

  it('takes a positive integer up to 1024 from the environment', () => {
    expect(guards.resolveMaxSockets('1024', 128)).toBe(1024);
    expect(guards.resolveMaxSockets('64', 128)).toBe(64);
    expect(guards.resolveMaxSockets(' 7 ', 128)).toBe(7);
  });

  it.each([
    '0',
    '-1',
    '1.5',
    'many',
    '1e2',
    '0x10',
    '9007199254740993',
    'NaN',
    '1025',
    '1000000000',
  ])('refuses %j', (raw) => {
    expect(() => guards.resolveMaxSockets(raw, 128)).toThrow(
      /CR_CALIBRATE_MAX_SOCKETS .*positive integer/,
    );
  });

  it('holds on the workload client: a burst above the limit opens at most the limit', async () => {
    const { opened, observed } = await burst(workClient(await park(), 20), 80, 20);
    expect(opened).toBe(20);
    expect(observed).toBe(20);
  });

  it('holds on the very first burst, before any request has made the agents', async () => {
    expect((await burst(workClient(await park(), 5), 40, 5)).opened).toBe(5);
  });

  const parkTls = async (): Promise<string> => {
    sockets = new Set();
    const mine = sockets;
    const tls = createTcpServer((socket) => mine.add(socket));
    server = tls as unknown as Server;
    await new Promise<void>((done) =>
      tls.listen({ port: 0, host: '127.0.0.1', backlog: 1024 }, done),
    );
    return `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
  };

  it('limits https too', async () => {
    expect((await burst(workClient(await parkTls(), 12), 60, 12)).opened).toBe(12);
  });

  it("is the reference: an unlimited client holds the SDK's own 50 on https", async () => {
    expect((await burst(workClient(await parkTls(), undefined), 90, 90)).opened).toBe(50);
  });
});

describe('the socket evidence', () => {
  it('records the value read back, and says where it came from', () => {
    expect(
      processLib.socketEvidence({ observed: 128, configured: 128, overridden: false }),
    ).toEqual({
      maxSockets: 128,
      maxSocketsSource:
        "set by the harness to match the library's own client, read back from the client's agents after the run",
    });
    const set = processLib.socketEvidence({ observed: 7, configured: 7, overridden: true });
    expect(set.maxSockets).toBe(7);
    expect(set.maxSocketsSource).toMatch(/CR_CALIBRATE_MAX_SOCKETS.*read back/);
  });

  it('records what was read back when it is not what was configured', () => {
    const e = processLib.socketEvidence({ observed: 50, configured: 128, overridden: false });
    expect(e.maxSockets).toBe(50);
    expect(e.maxSocketsSource).toMatch(/asked for 128/);
  });

  it('records null, and says so, when the agents cannot be read', () => {
    const e = processLib.socketEvidence({ observed: null, configured: 128, overridden: false });
    expect(e.maxSockets).toBeNull();
    expect(e.maxSocketsSource).toMatch(/not observed/);
    expect(processLib.socketsOf({ config: { requestHandler: {} } })).toBeNull();
    expect(processLib.socketsOf({})).toBeNull();
    // Agents not made yet, or two that disagree, are not one observed value.
    const agents = (a: unknown, b: unknown) => ({
      config: { requestHandler: { httpHandlerConfigs: () => ({ httpAgent: a, httpsAgent: b }) } },
    });
    expect(processLib.socketsOf(agents(undefined, undefined))).toBeNull();
    expect(processLib.socketsOf(agents({ maxSockets: 1 }, { maxSockets: 2 }))).toBeNull();
    expect(processLib.socketsOf(agents({ maxSockets: 9 }, { maxSockets: 9 }))).toBe(9);
  });

  it('reads the limit back from a real client after it has sent, and null from one that has not', async () => {
    const client = workClient(await park(), 12);
    expect(processLib.socketsOf(client)).toBeNull();
    const { observed } = await burst(client, 20, 12);
    expect(observed).toBe(12);
  });
});

/** The workload client as the harness builds it, with no limit yet: `limitWorkloadSockets` is what gives it one. */
const plainWork = (endpoint: string): S3Client =>
  new S3Client(
    guards.clientConfigs({
      endpoint,
      region: 'us-east-1',
      credentials: CREDENTIALS,
      forcePathStyle: true,
    }).work,
  );

type Handler = { httpHandlerConfigs?: unknown };
const handlerOf = (client: S3Client): Handler =>
  (client.config as unknown as { requestHandler: Handler }).requestHandler;

describe('limitWorkloadSockets, the wiring the harness calls', () => {
  it("gives the library's 128 when the environment says nothing, and reads it back", async () => {
    const client = plainWork(await park());
    const limit = await processLib.limitWorkloadSockets(client, undefined);
    expect(limit.observed).toBe(128);
    expect(limit.evidence().maxSockets).toBe(128);
    expect(limit.evidence().maxSocketsSource).toMatch(/library's own client/);
    client.destroy();
  });

  it('honours the environment: 7 opens 7 sockets, and the evidence names the variable', async () => {
    const client = plainWork(await park());
    const limit = await processLib.limitWorkloadSockets(client, '7');
    const abort = new AbortController();
    const reads = Array.from({ length: 40 }, (_, i) =>
      client
        .send(new GetObjectCommand({ Bucket: 'b', Key: `k${i}` }), { abortSignal: abort.signal })
        .catch(() => undefined),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(sockets.size).toBe(7);
    abort.abort();
    await Promise.all(reads);
    const e = limit.evidence();
    expect(e.maxSockets).toBe(7);
    expect(e.maxSocketsSource).toMatch(/CR_CALIBRATE_MAX_SOCKETS/);
    client.destroy();
  });

  it('records what the agents hold after the run, not what was configured', async () => {
    const client = plainWork(await park());
    const limit = await processLib.limitWorkloadSockets(client, '20');
    const agents = (
      handlerOf(client).httpHandlerConfigs as () => {
        httpAgent: { maxSockets: number };
        httpsAgent: { maxSockets: number };
      }
    )();
    agents.httpAgent.maxSockets = 9;
    agents.httpsAgent.maxSockets = 9;
    const e = limit.evidence();
    expect(e.maxSockets).toBe(9);
    expect(e.maxSocketsSource).toMatch(/asked for 20/);
    client.destroy();
  });

  it('records null when the agents can no longer be read', async () => {
    const client = plainWork(await park());
    const limit = await processLib.limitWorkloadSockets(client, undefined);
    handlerOf(client).httpHandlerConfigs = undefined;
    expect(limit.evidence().maxSockets).toBeNull();
    client.destroy();
  });

  it('refuses a value the environment cannot give, before touching the client', async () => {
    const client = plainWork(await park());
    await expect(processLib.limitWorkloadSockets(client, '0')).rejects.toThrow(/positive integer/);
    await expect(processLib.limitWorkloadSockets(client, '1025')).rejects.toThrow(/at most 1024/);
    expect(() => processLib.resolveSocketLimit('many')).toThrow(/positive integer/);
    client.destroy();
  });

  it('refuses when the handler has no agents to read, naming what was read back', async () => {
    const client = plainWork(await park());
    handlerOf(client).httpHandlerConfigs = undefined;
    await expect(processLib.limitWorkloadSockets(client, undefined)).rejects.toThrow(
      /holds an unreadable number of sockets, not 128.*nothing was created/,
    );
    client.destroy();
  });

  it('refuses when the agents ignore the limit', async () => {
    const client = plainWork(await park());
    handlerOf(client).httpHandlerConfigs = () => ({
      httpAgent: { maxSockets: 50 },
      httpsAgent: { maxSockets: 50 },
    });
    await expect(processLib.limitWorkloadSockets(client, undefined)).rejects.toThrow(
      /holds 50 sockets, not 128/,
    );
    client.destroy();
  });

  it('sends nothing: the check opens no connection', async () => {
    const client = plainWork(await park());
    await processLib.limitWorkloadSockets(client, undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets.size).toBe(0);
    client.destroy();
  });
});
