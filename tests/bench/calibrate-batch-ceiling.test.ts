import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { S3StorageDriver } from '@/s3/storage';

// A batch run cannot spend past the ceiling it confirms. Its one call makes however many requests the engine's grouping and
// the driver's own resends of throttled writes come to, which no projection bounds, so the workload's client is held to the
// ceiling on every send. Each claim is held here against the harness's own pieces (its meter, its ceiling check, its stop
// and teardown, its discard ledger) over a real S3 client and the real S3 storage driver, talking to a server that throttles.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Client = { send: (c: unknown) => Promise<unknown>; destroy: () => void };
const s3 = require_('@aws-sdk/client-s3') as {
  S3Client: new (cfg: Record<string, unknown>) => Client;
  DeleteObjectCommand: new (i: { Bucket: string; Key: string }) => unknown;
  PutObjectCommand: new (i: { Bucket: string; Key: string; Body: Uint8Array }) => unknown;
};
const meterLib = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  meter: (client: unknown) => { put: number; get: number; inFlight: number };
  priceTally: (t: unknown, p: object) => { totalUSD: number };
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  breached: (spent: number, ceiling: number) => boolean;
  clientConfigs: (base: Record<string, unknown>) => {
    work: Record<string, unknown>;
    admin: Record<string, unknown>;
  };
};
const processLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
  ceilingGate: (client: unknown, check: () => void) => void;
  interruptGate: (client: unknown) => {
    abort: () => void;
    drained: (ms: number) => Promise<boolean>;
  };
  chainOf: (err: unknown) => Error[];
  stopThenTearDown: (i: {
    gate: unknown;
    drainMs: number;
    teardown: (o: { unanswered: boolean }) => Promise<string[]>;
    results: Record<string, unknown>;
    cutShort: boolean;
    log: (line: string) => void;
  }) => Promise<string[]>;
  sdkFaultClasses: (
    root: string,
  ) => Record<'isThrottlingError' | 'isTransientError' | 'isServerError', (e: unknown) => boolean>;
};
const samples = require_(join(ROOT, 'bench', 'lib', 'calibrate-samples.cjs')) as {
  discardLedger: (i: {
    isTransient: (err: unknown) => boolean;
    snap: () => unknown;
    between: (a: unknown, b: unknown) => unknown;
    settle: () => Promise<boolean>;
  }) => {
    count: number;
    begin: (s: string) => unknown;
    end: () => void;
    sample: <T>(of: string, index: number, attempt: (rerun: number) => Promise<T>) => Promise<T>;
  };
  transientFault: (err: unknown, sdk: unknown) => boolean;
};
const runner = require_(join(ROOT, 'bench', 'lib', 'calibrate-batch.cjs')) as {
  runBatchSuite: (ctx: Record<string, unknown>) => Promise<void>;
};

// $0.01 for each PUT-class request and $0.004 for each GET-class: with a $0.05 ceiling, five PUT-class requests.
const PRICING = { storage: { putPerMillion: 10_000, getPerMillion: 4_000 } };
const CEILING = 0.05;
const BUCKET = 'b';

/** A server of one bucket that answers the first `throttled` sends of each key `503 SlowDown`, then stores it. */
async function fakeS3(throttled: number) {
  const objects = new Map<string, Buffer>();
  const attempts = new Map<string, number>();
  const seen = { requests: 0 };
  const server: Server = createServer((req, res) => {
    seen.requests += 1;
    const key = (req.url ?? '').split('?')[0]?.replace(`/${BUCKET}/`, '') ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') {
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        if (n <= throttled) {
          res.writeHead(503, { 'content-type': 'application/xml' });
          res.end('<Error><Code>SlowDown</Code><Message>slow down</Message></Error>');
          return;
        }
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"e"' });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code><Message>no</Message></Error>');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    objects,
    seen,
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const configOf = (endpoint: string) =>
  guards.clientConfigs({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** What a run of the harness has before its call: the workload's client with its meter, and a store over the server. */
async function rig({ throttled, ceilingOn }: { throttled: number; ceilingOn: boolean }) {
  const server = await fakeS3(throttled);
  const configs = configOf(server.endpoint);
  const client = new s3.S3Client(configs.work);
  const admin = new s3.S3Client(configs.admin);
  const tally = meterLib.meter(client);
  const gate = processLib.interruptGate(client);
  const check = () => {
    const spent = meterLib.priceTally(tally, PRICING).totalUSD;
    if (guards.breached(spent, CEILING)) {
      throw new Error(`spend ceiling breached mid-run: $${spent.toFixed(6)} >= $${CEILING}`);
    }
  };
  if (ceilingOn) processLib.ceilingGate(client, check);
  const driver = new S3StorageDriver({
    client: client as never,
    bucket: BUCKET,
    prefix: 'calib',
    clock: { sleep: async () => undefined },
    rng: { next: () => 0 },
  });
  cleanups.push(async () => {
    client.destroy();
    admin.destroy();
    await server.close();
  });
  return { server, client, admin, tally, gate, check, driver, ceilingOn };
}

describe('a client held to the ceiling on every send', () => {
  it('sends nothing once the ceiling is reached: the next request is refused, not sent and not billed', async () => {
    const { server, client, tally } = await rig({ throttled: 0, ceilingOn: true });
    const put = (i: number) =>
      client.send(
        new s3.PutObjectCommand({ Bucket: BUCKET, Key: `k${i}`, Body: new Uint8Array(1) }),
      );
    // Five at $0.01 reach the $0.05 ceiling; the sixth is refused before it reaches the wire.
    for (let i = 0; i < 5; i += 1) await put(i);
    expect(server.seen.requests).toBe(5);
    await expect(put(5)).rejects.toThrow(/spend ceiling breached mid-run/);
    await expect(put(6)).rejects.toThrow(/spend ceiling breached mid-run/);
    expect(server.seen.requests).toBe(5);
    expect(tally.put).toBe(5);
  });

  it('is not a fault a sample is run again over', () => {
    const err = new Error('spend ceiling breached mid-run: $0.05 >= $0.05');
    const wrapped = new Error('S3 PutObject failed', { cause: err });
    const sdk = processLib.sdkFaultClasses(ROOT);
    expect(samples.transientFault(err, sdk)).toBe(false);
    expect(samples.transientFault(wrapped, sdk)).toBe(false);
  });

  it('is registered by the harness for the batch suite’s workload client, after the ceiling check it calls', () => {
    const src = require_('node:fs').readFileSync(
      join(ROOT, 'bench', 'calibrate-aws.cjs'),
      'utf8',
    ) as string;
    const check = src.indexOf('const checkCeiling = () => {');
    const gate = src.indexOf("if (SUITE === 'batch') ceilingGate(client, checkCeiling);");
    expect(check).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(check);
    // Before the first stage creates anything.
    expect(gate).toBeLessThan(src.indexOf('new s3.CreateBucketCommand'));
  });
});

describe('a batch run whose call makes more requests than its estimate', () => {
  // The estimate says one write for each of the call's outputs. A throttled fake makes four sends of each: three the server
  // refuses, and the one it takes, as the driver resends a throttled commit.
  const OUTPUTS = 100;
  const plan = {
    shape: 'small',
    operands: 20,
    outputs: OUTPUTS,
    idsPerOperand: 100,
    samples: 1,
    operandBytes: [],
    counts: {
      operandBytes: [],
      sizes: Array.from({ length: OUTPUTS }, () => 0),
      readBack: { put: 0, get: 0 },
      batch: {
        put: OUTPUTS,
        get: 0,
        groups: 1,
        published: OUTPUTS,
        refused: 0,
        outputs: Array.from({ length: OUTPUTS }, () => ({ published: true, cardinality: 0 })),
      },
    },
  };
  const writeAll = async (
    driver: S3StorageDriver,
    outputs: { dest: { name: string } }[],
  ): Promise<{ outputs: unknown[]; stats: { groups: number } }> => {
    const done: unknown[] = [];
    for (const [i, o] of outputs.entries()) {
      await driver.putImmutable({ segment: o.dest.name, generation: 1 }, async (sink) => {
        await sink.write(new Uint8Array([i % 256]));
      });
      done.push({ published: true, cardinality: 0 });
    }
    return { outputs: done, stats: { groups: 1 } };
  };

  const run = async (r: Awaited<ReturnType<typeof rig>>) => {
    const sdk = processLib.sdkFaultClasses(ROOT);
    const zero = {
      put: 0,
      get: 0,
      bytesUp: 0,
      bytesDown: 0,
      parts: 0,
      reads: { whole: { n: 0, bytes: 0 }, suffix: { n: 0, bytes: 0 }, range: { n: 0, bytes: 0 } },
    };
    const ledger = samples.discardLedger({
      isTransient: (err) => samples.transientFault(err, sdk),
      snap: () => ({ put: r.tally.put, get: r.tally.get }),
      between: () => zero,
      settle: async () => true,
    });
    const snap = () => ({
      put: r.tally.put,
      get: r.tally.get,
      up: 0,
      down: 0,
      rangeN: 0,
      rangeBytes: 0,
      suffixN: 0,
      suffixBytes: 0,
      wholeN: 0,
      wholeBytes: 0,
    });
    ledger.begin('batch');
    const failure = await runner
      .runBatchSuite({
        stage: async (_n: string, { run: body }: { run: () => Promise<unknown> }) => {
          await body();
        },
        sample: (of: string, i: number, attempt: (rerun: number) => Promise<unknown>) =>
          ledger.sample(of, i, attempt),
        load: async () => undefined,
        perLoad: () => [],
        summarise: () => ({}),
        snap,
        startDepth: () => undefined,
        depthOf: () => ({ peakInFlight: 1, requestMs: 1, meanInFlight: 1, rounds: 1 }),
        // The control has no ceiling: the check is the one thing taken away.
        checkCeiling: r.ceilingOn ? r.check : () => undefined,
        msSince: () => 10,
        median: (xs: number[]) => xs[0],
        spreadOf: () => ({}),
        timedStore: () => ({
          segment: (name: string) => ({ name, count: async () => 0 }),
          materializeMany: (o: { outputs: { dest: { name: string } }[] }) =>
            writeAll(r.driver, o.outputs),
        }),
        log: () => undefined,
        plan,
        recordMissed: () => undefined,
      })
      .then(
        () => undefined,
        (err: Error) => err,
      );
    ledger.end();
    return { failure, discards: ledger.count };
  };

  it('makes four times what it estimated, with no ceiling in the way (the control)', async () => {
    const r = await rig({ throttled: 3, ceilingOn: false });
    const { failure } = await run(r);
    // Every write took four sends, and the run's checks found nothing wrong with its outputs: the estimate was simply wrong.
    expect(r.server.seen.requests).toBe(4 * OUTPUTS);
    expect(r.tally.put).toBe(4 * OUTPUTS);
    expect(r.server.seen.requests).toBeGreaterThan(Math.ceil((plan.counts.batch.put * 3) / 2));
    expect(failure?.message ?? '').not.toMatch(/ceiling/);
  });

  it('is stopped inside the call at the ceiling, is not run again, and leaves nothing behind', async () => {
    const r = await rig({ throttled: 3, ceilingOn: true });
    const { failure, discards } = await run(r);
    // The call stopped at the fifth request of the $0.05 ceiling, inside its first write's second: not at the end of a sample.
    expect(
      processLib.chainOf(failure).some((e) => /spend ceiling breached mid-run/.test(e.message)),
    ).toBe(true);
    expect(r.server.seen.requests).toBe(5);
    expect(r.tally.put).toBe(5);
    expect(meterLib.priceTally(r.tally, PRICING).totalUSD).toBeLessThanOrEqual(CEILING);
    // A ceiling stop is no transient fault: no sample was discarded and run again.
    expect(discards).toBe(0);
    // One object was written before it stopped. The run's exit stops the client, then tears down with the other client,
    // which the ceiling never gates, and the bucket ends empty.
    expect(r.server.objects.size).toBe(1);
    const left = await processLib.stopThenTearDown({
      gate: r.gate,
      drainMs: 500,
      teardown: async () => {
        for (const key of [...r.server.objects.keys()]) {
          await r.admin.send(new s3.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        }
        return [...r.server.objects.keys()];
      },
      results: {},
      cutShort: false,
      log: () => undefined,
    });
    expect(left).toEqual([]);
    expect(r.server.objects.size).toBe(0);
  });
});
