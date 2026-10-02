import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudRoaring } from '@/index';
import { IntegrityError, NotFoundError, TransientError, ValidationError } from '@/core/errors';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { brandAsBackend } from '@/core/ports';
import { MemoryStorageDriver } from '@/drivers/memory';
import { S3StorageDriver } from '@/s3/storage';
import { CountingObjectStore } from '../helpers/counting';

// A timed sample that meets a transient fault is discarded whole and run again on a fresh store; the requests it made
// are billed and recorded, and kept out of what the stage is held to. These drive the harness's own sampling code
// against the real engine and the real SDK, with stubs that fail on purpose, and hold the harness's loops to it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

type Reads = Record<'whole' | 'suffix' | 'range', { n: number; bytes: number }>;
type Requests = {
  put: number;
  get: number;
  bytesUp: number;
  bytesDown: number;
  parts: number;
  reads: Reads;
};
type Fault = {
  name: string;
  cause: string | null;
  code: string | null;
  attempts: number | null;
  httpStatus: number | null;
  message: string;
};
type Discard = Fault & { of: string; sample: number; failedAfterMs: number; requests: Requests };
type SdkFaults = Record<
  'isThrottlingError' | 'isTransientError' | 'isServerError',
  (e: unknown) => boolean
>;
type Ledger = {
  readonly count: number;
  readonly perRun: number;
  readonly perStage: number;
  readonly unfinished: { stage: string; discarded: Discard[] } | null;
  begin: (stage: string) => Discard[];
  end: () => void;
  sample: <T>(of: string, index: number, attempt: (rerun: number) => Promise<T>) => Promise<T>;
};

const samples = require_(join(ROOT, 'bench', 'lib', 'calibrate-samples.cjs')) as {
  DISCARDS_PER_RUN: number;
  DISCARDS_PER_STAGE: number;
  QUIET_MS: number;
  transientFault: (err: unknown, sdk: SdkFaults) => boolean;
  quiesce: (i: {
    activity: () => { inFlight: number; sent: number };
    quietMs?: number;
    maxMs: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) => Promise<boolean>;
  discardLedger: <S>(i: {
    perRun?: number;
    perStage?: number;
    isTransient: (err: unknown) => boolean;
    snap: () => S;
    between: (a: S, b: S) => Requests;
    settle: () => Promise<boolean>;
    onDiscard?: (d: Discard, at: { stage: string; count: number; stageCount: number }) => void;
  }) => Ledger;
  discardedRequests: (discarded?: Discard[]) => Requests;
  keptRequests: (record: { requests: Requests; discarded?: Discard[] }) => Requests;
  parseFaultGets: (raw: unknown) => number[];
  injectFaults: (client: unknown, at: number[]) => { readonly pending: number[] };
};
const processLib = require_(join(ROOT, 'bench', 'lib', 'calibrate-process.cjs')) as {
  faultOf: (err: unknown) => Fault;
  failureOf: (err: unknown) => Fault | null;
  describeFault: (f: Fault) => string;
  sdkFaultClasses: (root: string) => SdkFaults;
};
const guards = require_(join(ROOT, 'bench', 'lib', 'calibrate-guards.cjs')) as {
  DEFAULT_LAYOUT: { overlap: number; stride: number };
  TIMED_STORE: { retry: false; cache: { genTtlMs: number } };
  warmStore: (chunks: number) => Record<string, unknown>;
  clientConfigs: (base: Record<string, unknown>) => {
    work: Record<string, unknown>;
    admin: Record<string, unknown>;
  };
  planLayout: (i: { segments: number; idsPerSegment: number; overlap: number; stride: number }) => {
    sharedChunks: number;
    expected: { count: number; sum: number };
    stride: number;
  };
  layoutIds: (layout: unknown, i: number) => Iterable<number>;
};
const stages = require_(join(ROOT, 'bench', 'lib', 'calibrate-stages.cjs')) as {
  coldIntersectGets: (k: number) => number;
  coldIntersectBound: (k: number) => number;
};
const meterLib = require_(join(ROOT, 'bench', 'lib', 'aws-meter.cjs')) as {
  meter: (client: unknown) => {
    put: number;
    get: number;
    free: number;
    inFlight: number;
    reads: Reads;
  };
};
const s3 = require_('@aws-sdk/client-s3') as {
  S3Client: new (cfg: Record<string, unknown>) => {
    send: (c: unknown) => Promise<unknown>;
    destroy: () => void;
  };
  GetObjectCommand: new (i: { Bucket: string; Key: string }) => unknown;
};

/** What the SDK counts as a fault it would retry, read from the SDK the harness sends with. */
const SDK = processLib.sdkFaultClasses(ROOT);

/**
 * The error a reset socket raises through the S3 driver, shaped as the real one is: the SDK's HTTP handler names a
 * request error with code `ECONNRESET` `TimeoutError` and keeps the code, the SDK's retry step adds its attempt count,
 * and the driver wraps the lot in a `TransientError`. The test below that resets a real socket checks this shape.
 */
const resetSocket = (): TransientError =>
  new TransientError('transient S3 fault: TimeoutError', {
    cause: Object.assign(new Error('socket hang up'), {
      name: 'TimeoutError',
      code: 'ECONNRESET',
      $metadata: { attempts: 1, totalRetryDelay: 0 },
    }),
  });

type MeterSnap = {
  get: number;
  wholeN: number;
  suffixN: number;
  rangeN: number;
  rangeBytes: number;
};
/** A fault's record without its message, which says where it was raised and not what it was. */
const withoutMessage = (f: Fault): Omit<Fault, 'message'> => {
  const { name, cause, code, attempts, httpStatus } = f;
  return { name, cause, code, attempts, httpStatus };
};

const zeroReads = (): Reads => ({
  whole: { n: 0, bytes: 0 },
  suffix: { n: 0, bytes: 0 },
  range: { n: 0, bytes: 0 },
});

/**
 * A meter at the driver's edge, standing in for the AWS one: each storage read and each pointer read is a GET, counted
 * when it is sent and filed by kind when it answers, with the reads in flight beside. Every read answers after
 * `delayMs`, so a cold intersect has its window of reads in flight at once, as it has against S3; a read `failAt`
 * names fails at once with `fault`, as a reset socket does.
 */
function meteredBackend({ delayMs }: { delayMs: number }) {
  const tally = { get: 0, inFlight: 0, reads: zeroReads() };
  const storage = new MemoryStorageDriver();
  const pointer = new CountingObjectStore(0);
  let ranges = 0;
  const failAt = new Set<number>();
  let fault = resetSocket;
  const answer = async <T>(
    kind: 'whole' | 'suffix' | 'range',
    call: () => Promise<T>,
    fail: boolean,
  ): Promise<T> => {
    tally.get += 1;
    tally.inFlight += 1;
    try {
      if (fail) throw fault();
      await new Promise((done) => setTimeout(done, delayMs));
      const out = await call();
      tally.reads[kind].n += 1;
      const bytes = (out as { bytes?: Uint8Array } | Uint8Array | null) ?? null;
      tally.reads[kind].bytes +=
        bytes instanceof Uint8Array ? bytes.length : (bytes?.bytes?.length ?? 0);
      return out;
    } finally {
      tally.inFlight -= 1;
    }
  };
  const readStorage = new Proxy(storage, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => Promise<unknown>).bind(t);
      if (prop === 'getTail') return (...a: unknown[]) => answer('suffix', () => fn(...a), false);
      if (prop === 'getRange') {
        return (...a: unknown[]) => {
          ranges += 1;
          return answer('range', () => fn(...a), failAt.delete(ranges));
        };
      }
      return fn;
    },
  });
  const readPointer = new Proxy(pointer, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => Promise<unknown>).bind(t);
      if (prop === 'read') return (...a: unknown[]) => answer('whole', () => fn(...a), false);
      return fn;
    },
  });
  const snap = (): MeterSnap => ({
    get: tally.get,
    wholeN: tally.reads.whole.n,
    suffixN: tally.reads.suffix.n,
    rangeN: tally.reads.range.n,
    rangeBytes: tally.reads.range.bytes,
  });
  const between = (a: MeterSnap, b: MeterSnap): Requests => ({
    put: 0,
    get: b.get - a.get,
    bytesUp: 0,
    bytesDown: 0,
    parts: 0,
    reads: {
      whole: { n: b.wholeN - a.wholeN, bytes: 0 },
      suffix: { n: b.suffixN - a.suffixN, bytes: 0 },
      range: { n: b.rangeN - a.rangeN, bytes: 0 },
    },
  });
  return {
    tally,
    snap,
    between,
    /** Where segments are loaded: the same objects, read with no meter, no delay and no fault. */
    loader: brandAsBackend({
      storage,
      registry: new ObjectStoreRegistry(pointer, undefined, () => 0),
    }),
    reader: brandAsBackend({
      storage: readStorage,
      registry: new ObjectStoreRegistry(readPointer, undefined, () => 0),
    }),
    /** Fail the `n`th chunk read from now, once, with `with`. */
    failRange(n: number, withFault: () => TransientError = resetSocket): void {
      failAt.add(ranges + n);
      fault = withFault;
    },
  };
}

/** A ledger over `m`, waiting for a failed sample's reads as the harness does, on a shorter quiet window. */
function ledgerOver(
  m: ReturnType<typeof meteredBackend>,
  extra: { perRun?: number; perStage?: number } = {},
) {
  return samples.discardLedger({
    isTransient: (err) => samples.transientFault(err, SDK),
    snap: m.snap,
    between: m.between,
    settle: () =>
      samples.quiesce({
        activity: () => ({ inFlight: m.tally.inFlight, sent: m.tally.get }),
        quietMs: 100,
        maxMs: 10_000,
      }),
    ...extra,
  });
}

const stride = guards.DEFAULT_LAYOUT.stride;
const layout = guards.planLayout({ segments: 5, idsPerSegment: 20_000, overlap: 0.1, stride });
const k = layout.sharedChunks;

async function loaded(m: ReturnType<typeof meteredBackend>): Promise<void> {
  const loader = new CloudRoaring({ storage: m.loader, ...guards.TIMED_STORE });
  for (let i = 0; i < 5; i += 1)
    await loader.load({ segment: `seg-${i}` }, guards.layoutIds(layout, i));
}

describe('a sample that meets a transient fault', () => {
  it('is discarded and run again, and the stage keeps exactly the counts of the samples that finished', async () => {
    const m = meteredBackend({ delayMs: 20 });
    await loaded(m);
    const ledger = ledgerOver(m);
    const discarded = ledger.begin('intersect');
    const s0 = m.snap();
    let rangeAtThrow = -1;
    // The fifth chunk read of the stage fails: the first intersect's third shared chunk, with the rest of its window
    // of reads still in flight.
    m.failRange(5);
    const reads: Array<Record<string, number>> = [];
    for (let i = 0; i < 4; i += 1) {
      reads.push(
        await ledger.sample('cold intersect', i, async () => {
          const store = new CloudRoaring({ storage: m.reader, ...guards.TIMED_STORE });
          const before = m.snap();
          let n = 0;
          let sum = 0;
          try {
            for await (const id of store
              .segment(`seg-${i}`)
              .intersect([store.segment(`seg-${i + 1}`)])) {
              n += 1;
              sum += id;
            }
          } catch (err) {
            rangeAtThrow = m.snap().rangeN - before.rangeN;
            throw err;
          }
          const after = m.snap();
          if (n !== layout.expected.count || sum !== layout.expected.sum) {
            throw new Error(`intersect ${i} was not exact`);
          }
          return {
            gets: after.get - before.get,
            chunkReads: after.rangeN - before.rangeN,
            tailReads: after.suffixN - before.suffixN,
            pointerReads: after.wholeN - before.wholeN,
          };
        }),
      );
    }
    ledger.end();
    const stage = m.between(s0, m.snap());

    // Every sample the stage kept made exactly what a fault-free cold intersect makes.
    for (const r of reads) {
      expect(r).toEqual({
        gets: stages.coldIntersectGets(k),
        chunkReads: 2 * k,
        tailReads: 2,
        pointerReads: 2,
      });
    }
    // The one that failed is recorded, with its fault and its requests.
    expect(discarded).toHaveLength(1);
    const [d] = discarded;
    expect(d).toMatchObject({
      of: 'cold intersect',
      sample: 0,
      name: 'TransientError',
      cause: 'TimeoutError',
      code: 'ECONNRESET',
      attempts: 1,
    });
    // Its reads still in flight when it failed answered after, and were counted against it, not against the next one.
    expect(rangeAtThrow).toBeGreaterThan(0);
    expect(d?.requests.reads.range.n).toBeGreaterThan(rangeAtThrow);
    // It made no more than a finished sample may: the bound a discard is projected at.
    expect(d?.requests.get).toBeLessThanOrEqual(stages.coldIntersectBound(k));
    // The stage billed both, and is held to what it kept.
    expect(stage.get).toBe(4 * stages.coldIntersectGets(k) + (d?.requests.get ?? 0));
    expect(samples.keptRequests({ requests: stage, discarded }).get).toBe(
      4 * stages.coldIntersectGets(k),
    );
    expect(samples.keptRequests({ requests: stage, discarded }).reads.range.n).toBe(4 * 2 * k);
    expect(ledger.count).toBe(1);
  });

  // The harness re-runs a point read where the read assumed it was: a first count() on a store that is told to forget
  // the segment, a has() on an open segment on the same store, and the warm stage's priming pass on a fresh store.
  // Each re-run makes exactly what the read it replaced makes, and the warm repeat after it still makes none.
  it('runs again as the read it replaced, so a point read and a priming pass keep their exact counts', async () => {
    const m = meteredBackend({ delayMs: 1 });
    await loaded(m);
    const ledger = ledgerOver(m, { perStage: 3 });
    const discarded = ledger.begin('pointReads');
    const counted = new CloudRoaring({ storage: m.reader, ...guards.warmStore(1_024) });
    const gets = async (fn: () => Promise<unknown>): Promise<number> => {
      const g0 = m.tally.get;
      await fn();
      return m.tally.get - g0;
    };

    // A first count() whose tail read fails: forgotten, then read again as a first read.
    const failTail = new Proxy(m.reader.storage, {
      get(t, prop, receiver) {
        const value: unknown = Reflect.get(t, prop, receiver);
        if (prop !== 'getTail' || typeof value !== 'function') return value;
        return (...a: unknown[]) => {
          if (tailFaults > 0) {
            tailFaults -= 1;
            m.tally.get += 1;
            return Promise.reject(resetSocket());
          }
          return (value as (...b: unknown[]) => Promise<unknown>).apply(t, a);
        };
      },
    });
    let tailFaults = 1;
    const countStore = new CloudRoaring({
      storage: brandAsBackend({ storage: failTail, registry: m.reader.registry }),
      ...guards.warmStore(1_024),
    });
    const counts = await ledger.sample('count() first read', 0, (rerun) =>
      gets(async () => {
        if (rerun > 0) countStore.invalidate({ segment: 'seg-0' });
        expect(await countStore.segment('seg-0').count()).toBe(20_000);
      }),
    );
    expect(counts, 'a first count() is a pointer and a tail').toBe(2);

    // A has() on an open segment whose chunk read fails: the same store, with nothing cached for it, reads it again.
    await counted.segment('seg-1').count();
    const id = Math.ceil(65_536 / stride) * stride; // the first shared id of chunk 1
    m.failRange(1);
    const open = await ledger.sample('has() on an open segment', 0, () =>
      gets(async () => expect(await counted.segment('seg-1').has(id)).toBe(true)),
    );
    expect(open, 'a has() on an open segment is one chunk read').toBe(1);
    expect(await gets(async () => expect(await counted.segment('seg-1').has(id)).toBe(true))).toBe(
      0,
    );

    // A priming pass that fails part-way is run again whole, on a fresh store: each segment once, then none.
    m.failRange(3);
    const priming = await ledger.sample('priming pass', 0, async () => {
      const fresh = new CloudRoaring({ storage: m.reader, ...guards.warmStore(1_024) });
      const g = await gets(async () => {
        for (let i = 0; i < 3; i += 1) {
          for await (const x of fresh
            .segment(`seg-${i}`)
            .intersect([fresh.segment(`seg-${i + 1}`)]))
            void x;
        }
      });
      return { fresh, g };
    });
    expect(priming.g).toBe(4 * (2 + k));
    expect(
      await gets(async () => {
        for await (const x of priming.fresh
          .segment('seg-0')
          .intersect([priming.fresh.segment('seg-1')]))
          void x;
      }),
    ).toBe(0);
    ledger.end();
    expect(discarded.map((d) => d.of)).toEqual([
      'count() first read',
      'has() on an open segment',
      'priming pass',
    ]);
  });

  it('records the error the SDK raised for a reset socket: its name, and the code beneath the rename', async () => {
    // A server that resets every connection, as a socket that failed mid-run did.
    const server = createServer((req) => req.socket.destroy());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const client = new s3.S3Client(
      guards.clientConfigs({
        endpoint: `http://127.0.0.1:${port}`,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }).work,
    );
    const tally = meterLib.meter(client);
    const driver = new S3StorageDriver({ client: client as never, bucket: 'b', prefix: 'calib' });
    try {
      const ledger = samples.discardLedger({
        isTransient: (err) => samples.transientFault(err, SDK),
        snap: () => tally.get,
        between: (a, b) => ({ ...samples.discardedRequests(), get: b - a }),
        settle: () =>
          samples.quiesce({
            activity: () => ({ inFlight: tally.inFlight, sent: tally.get }),
            quietMs: 50,
            maxMs: 5_000,
          }),
      });
      const discarded = ledger.begin('pointReads');
      let thrown: unknown;
      const out = await ledger.sample('has() first read', 7, async (rerun) => {
        if (rerun > 0) return 'read again';
        try {
          return await driver.getTail({ segment: 's', generation: 0 }, 1024);
        } catch (err) {
          thrown = err;
          throw err;
        }
      });
      ledger.end();
      expect(out).toBe('read again');
      // The handler renamed the socket's error and kept its code; the driver wrapped it; the SDK counted one attempt.
      expect(processLib.faultOf(thrown)).toMatchObject({
        name: 'TransientError',
        cause: 'TimeoutError',
        code: 'ECONNRESET',
        attempts: 1,
        httpStatus: null,
        message: 'transient S3 fault: TimeoutError',
      });
      expect(discarded).toHaveLength(1);
      expect(discarded[0]).toMatchObject({
        of: 'has() first read',
        sample: 7,
        name: 'TransientError',
        cause: 'TimeoutError',
        code: 'ECONNRESET',
        attempts: 1,
      });
      expect(discarded[0]?.requests.get).toBe(1);
      // The fault the stand-in above raises is this one, field for field.
      expect(withoutMessage(processLib.faultOf(resetSocket()))).toEqual(
        withoutMessage(processLib.faultOf(thrown)),
      );
      // The run's error records the same, so the next failure says which socket error it was.
      expect(processLib.failureOf(thrown)).toMatchObject({
        name: 'TransientError',
        code: 'ECONNRESET',
      });
      expect(processLib.describeFault(processLib.faultOf(thrown))).toBe(
        'transient S3 fault: TimeoutError (TransientError from TimeoutError, code ECONNRESET, 1 attempt)',
      );
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('what counts as a transient fault', () => {
  const sdkError = (name: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error(name), { name, ...extra });

  it("is the library's TransientError, or what the SDK itself would retry, anywhere in its causes", () => {
    for (const err of [
      resetSocket(),
      new TransientError('transient S3 fault: SlowDown'),
      sdkError('TimeoutError', { code: 'EPIPE' }),
      sdkError('Error', { code: 'ETIMEDOUT' }),
      sdkError('SlowDown', { $metadata: { httpStatusCode: 503 } }),
      sdkError('InternalError', { $metadata: { httpStatusCode: 500 } }),
      sdkError('NotImplemented', { $metadata: { httpStatusCode: 501 } }),
      new Error('read failed', { cause: sdkError('TimeoutError', { code: 'ECONNRESET' }) }),
    ]) {
      expect(samples.transientFault(err, SDK), String(err)).toBe(true);
    }
  });

  it('is never a deterministic failure, a wrong answer, or the run stopping', () => {
    const interrupted = sdkError('CalibrationInterrupted');
    for (const err of [
      new IntegrityError('checksum mismatch'),
      new NotFoundError('no such generation'),
      new ValidationError('range out of bounds'),
      new Error('intersect returned 12 ids; expected exactly 13'),
      sdkError('AccessDenied', { $metadata: { httpStatusCode: 403 } }),
      sdkError('PreconditionFailed', { $metadata: { httpStatusCode: 412 } }),
      interrupted,
      // A send the gate refused while the run stops is an interrupt, whatever wraps it.
      new TransientError('transient S3 fault: CalibrationInterrupted', { cause: interrupted }),
      'not even an error',
    ]) {
      expect(samples.transientFault(err, SDK), String(err)).toBe(false);
    }
  });

  it('fails the run at once on any of those, discarding nothing', async () => {
    for (const err of [
      new IntegrityError('checksum mismatch'),
      new Error('andNot returned 3 ids; expected exactly 4'),
      sdkError('AccessDenied', { $metadata: { httpStatusCode: 403 } }),
      sdkError('CalibrationInterrupted'),
    ]) {
      const ledger = samples.discardLedger({
        isTransient: (e) => samples.transientFault(e, SDK),
        snap: () => ({}),
        between: () => samples.discardedRequests(),
        settle: () => Promise.resolve(true),
      });
      const discarded = ledger.begin('andNot');
      let attempts = 0;
      await expect(
        ledger.sample('andNot call', 0, () => {
          attempts += 1;
          return Promise.reject(err);
        }),
      ).rejects.toBe(err);
      expect(attempts).toBe(1);
      expect(discarded).toEqual([]);
      expect(ledger.count).toBe(0);
    }
  });
});

describe('the discards are bounded', () => {
  const ledger = () =>
    samples.discardLedger({
      isTransient: (e) => samples.transientFault(e, SDK),
      snap: () => ({}),
      between: () => samples.discardedRequests(),
      settle: () => Promise.resolve(true),
    });
  /** A sample that meets `faults` transient faults, then finishes. */
  const flaky = (faults: number) => () =>
    faults-- > 0 ? Promise.reject(resetSocket()) : Promise.resolve('ok');

  it('at three a run and two a stage', () => {
    expect(samples.DISCARDS_PER_RUN).toBe(3);
    expect(samples.DISCARDS_PER_STAGE).toBe(2);
  });

  it('fails the run on the transient fault one past the run bound, and says which fault it was', async () => {
    const l = ledger();
    l.begin('intersect');
    expect(await l.sample('cold intersect', 0, flaky(2))).toBe('ok');
    l.end();
    l.begin('sweep');
    expect(await l.sample('cold intersect', 3, flaky(1))).toBe('ok');
    expect(l.count).toBe(samples.DISCARDS_PER_RUN);
    let thrown: unknown;
    try {
      await l.sample('cold intersect', 4, flaky(1));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(processLib.faultOf(thrown)).toMatchObject({
      name: 'DiscardBoundExceeded',
      cause: 'TimeoutError',
      code: 'ECONNRESET',
      attempts: 1,
    });
    expect((thrown as Error).message).toMatch(
      /sweep: cold intersect 4 met a transient fault \(transient S3 fault: TimeoutError\) after the run had discarded 3 samples/,
    );
    // The fault that failed the run was not discarded: the run stops with what it had.
    expect(l.count).toBe(3);
    expect(l.unfinished?.stage).toBe('sweep');
    expect(l.unfinished?.discarded).toHaveLength(1);
  });

  it('fails the run on the transient fault one past the stage bound, though the run bound has room', async () => {
    const l = ledger();
    l.begin('andNot');
    await expect(l.sample('andNot call', 2, flaky(3))).rejects.toMatchObject({
      name: 'DiscardBoundExceeded',
    });
    expect(l.count).toBe(samples.DISCARDS_PER_STAGE);
    expect(l.count).toBeLessThan(samples.DISCARDS_PER_RUN);
  });

  it('fails the run when a failed sample is still sending, rather than count its requests against the next one', async () => {
    const l = samples.discardLedger({
      isTransient: (e) => samples.transientFault(e, SDK),
      snap: () => ({}),
      between: () => samples.discardedRequests(),
      settle: () => Promise.resolve(false),
    });
    l.begin('intersect');
    await expect(l.sample('cold intersect', 0, flaky(1))).rejects.toMatchObject({
      name: 'DiscardUnsettled',
    });
    expect(l.count).toBe(0);
  });
});

describe("a failed sample's requests are waited for", () => {
  /** A clock that only moves when the wait sleeps. */
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: (ms: number) => ((t += ms), Promise.resolve()) };
  };

  it('until nothing is in flight and nothing new has been sent for the quiet window', async () => {
    const c = clock();
    // In flight for 50 ms, then a straggler sent at 300 ms that answers at 320 ms.
    const activity = () => ({
      inFlight: c.now() < 50 || (c.now() >= 300 && c.now() < 320) ? 1 : 0,
      sent: c.now() < 300 ? 10 : 11,
    });
    expect(await samples.quiesce({ activity, quietMs: 1_000, maxMs: 30_000, ...c })).toBe(true);
    // Quiet from 320 ms, so it stopped waiting a second after the straggler answered.
    expect(c.now()).toBeGreaterThanOrEqual(1_320);
    expect(c.now()).toBeLessThan(1_400);
  });

  it('notices a request sent and answered between two looks', async () => {
    const c = clock();
    const activity = () => ({ inFlight: 0, sent: c.now() < 500 ? 1 : 2 });
    expect(await samples.quiesce({ activity, quietMs: 1_000, maxMs: 30_000, ...c })).toBe(true);
    expect(c.now()).toBeGreaterThanOrEqual(1_500);
  });

  it('gives up on a request that never answers, so the run cannot hang', async () => {
    const c = clock();
    const activity = () => ({ inFlight: 1, sent: 1 });
    expect(await samples.quiesce({ activity, quietMs: 1_000, maxMs: 30_000, ...c })).toBe(false);
    expect(c.now()).toBeGreaterThanOrEqual(30_000);
  });

  it('waits a second by default, and the harness waits as long as an interrupt does', () => {
    expect(samples.QUIET_MS).toBe(1_000);
    const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
    const settle = src.slice(src.indexOf('settle: () =>'), src.indexOf('onDiscard:'));
    expect(settle).toContain('quiesce({');
    expect(settle).toContain('inFlight: tally.inFlight');
    expect(settle).toContain('sent: tally.put + tally.get + tally.free');
    expect(settle).toContain('maxMs: DRAIN_MS');
  });
});

describe("a rehearsal's injected fault", () => {
  it('fails each listed GetObject once, as a reset socket fails it, before it reaches the wire', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const client = new s3.S3Client(
      guards.clientConfigs({
        endpoint: `http://127.0.0.1:${port}`,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }).work,
    );
    const tally = meterLib.meter(client);
    const injected = samples.injectFaults(client, [2]);
    const driver = new S3StorageDriver({ client: client as never, bucket: 'b', prefix: 'calib' });
    try {
      await driver.getTail({ segment: 's', generation: 0 }, 1024);
      let thrown: unknown;
      try {
        await driver.getTail({ segment: 's', generation: 0 }, 1024);
      } catch (err) {
        thrown = err;
      }
      await driver.getTail({ segment: 's', generation: 0 }, 1024);
      expect(hits).toBe(2);
      expect(tally.get).toBe(3);
      expect(injected.pending).toEqual([]);
      expect(samples.transientFault(thrown, SDK)).toBe(true);
      // The driver and the SDK classify it as they would a real reset.
      expect(withoutMessage(processLib.faultOf(thrown))).toEqual(
        withoutMessage(processLib.faultOf(resetSocket())),
      );
    } finally {
      client.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('is a list of positive request numbers, and a list it cannot read is refused', () => {
    expect(samples.parseFaultGets(undefined)).toEqual([]);
    expect(samples.parseFaultGets(' ')).toEqual([]);
    expect(samples.parseFaultGets('1200, 30000')).toEqual([1200, 30_000]);
    for (const bad of ['0', '-1', '1.5', 'a', '5,', '5,5']) {
      expect(() => samples.parseFaultGets(bad), bad).toThrow(/CR_CALIBRATE_FAULT_GETS/);
    }
  });

  // A real run must never fail a request on purpose, and a projection would apply it to nothing.
  it('is refused in every mode but a rehearsal, before anything is read', () => {
    const home = mkdtempSync(join(tmpdir(), 'calib-no-aws-'));
    try {
      const run = (args: string[], faults: string) =>
        spawnSync(process.execPath, [join(ROOT, 'bench', 'calibrate-aws.cjs'), ...args], {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            AWS_CONFIG_FILE: join(home, 'no-config'),
            AWS_SHARED_CREDENTIALS_FILE: join(home, 'no-credentials'),
            AWS_EC2_METADATA_DISABLED: 'true',
            CR_CALIBRATE_FAULT_GETS: faults,
          },
          encoding: 'utf8',
          timeout: 60_000,
        });
      for (const args of [[], ['--run'], ['--cleanup', '2026-10-02-a']]) {
        const out = run(args, '1200');
        expect(out.status, args.join(' ')).toBe(2);
        expect(out.stderr).toMatch(/CR_CALIBRATE_FAULT_GETS is for a rehearsal only/);
      }
      // A rehearsal takes it, and refuses one it cannot read before it contacts anything.
      const bad = run(['--rehearse'], '12x');
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/CR_CALIBRATE_FAULT_GETS entry "12x"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// The harness's loops cannot run here, so they are read: every timed sample runs through the ledger and times only
// the attempt that finishes, loads do not, and each stage is held to what it kept.
describe('the harness runs every timed sample through the ledger', () => {
  const src = readFileSync(join(ROOT, 'bench', 'calibrate-aws.cjs'), 'utf8');
  const between = (from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    expect(a, from).toBeGreaterThan(-1);
    expect(b, to).toBeGreaterThan(a);
    return src.slice(a, b);
  };
  // Each loop that times a sample, from where it starts to where the next begins.
  const loops: Array<[string, string, string]> = [
    ['cold intersects', 'const coldIntersects = async', 'const describeReads ='],
    ['the point reads', 'const timedCalls = async', 'const mustMake ='],
    ['the first reads', 'const fresh = [];', 'const firstRead = {'],
    ['the andNot calls', 'for (let i = 0; i < ANDNOT_CALLS', 'const ms = reads.map'],
  ];

  it('runs the priming pass, which it does not time, through sample() too', () => {
    expect(between("await stage('warm'", 'const ms = [];')).toContain(
      "await sample('priming pass', 0, async () => {",
    );
  });

  it.each(loops)(
    '%s run through sample(), with the clock started inside the attempt',
    (_name, from, to) => {
      const loop = between(from, to);
      const call = loop.indexOf('await sample(');
      expect(call, 'the loop no longer runs its sample through sample()').toBeGreaterThan(-1);
      // A clock started before the attempt would time the discarded attempt into the kept one's latency.
      const attempt = loop.slice(
        loop.lastIndexOf('async', loop.indexOf('process.hrtime.bigint()')),
      );
      expect(loop.indexOf('process.hrtime.bigint()')).toBeGreaterThan(-1);
      const head = loop.includes('const timed = ') ? loop.indexOf('const timed = ') : call;
      expect(loop.slice(0, head)).not.toContain('hrtime');
      expect(attempt).toContain('msSince(t0)');
    },
  );

  it('builds a fresh store inside each attempt, so a sample run again starts from nothing the failed one left', () => {
    for (const [from, to, store] of [
      ['const coldIntersects = async', 'const describeReads =', 'const store = timedStore();'],
      ["await stage('warm'", 'const ms = [];', 'const fresh = new CloudRoaring({'],
      ['const fresh = [];', 'const firstRead = {', 'const store = timedStore();'],
      ['for (let i = 0; i < ANDNOT_CALLS', 'const ms = reads.map', 'const store = timedStore();'],
    ] as const) {
      const loop = between(from, to);
      expect(loop.indexOf(store), from).toBeGreaterThan(loop.indexOf('await sample('));
    }
  });

  it('re-runs a first count() on a store told to forget the segment, and a has() on an open segment as it is', () => {
    const points = between("await stage('pointReads'", "await stage('andNot'");
    expect(points).toContain('if (rerun > 0) counted.invalidate({ segment: name });');
    expect(points).toContain("timedCalls(names.map(firstCount), counts, 'count() first read')");
    const open = points.slice(
      points.indexOf('const openSegment = {'),
      points.indexOf('const hasWarm = {'),
    );
    expect(open).toContain("'has() on an open segment'");
    expect(open).not.toContain('invalidate');
    // The warm reads make no request, so they are not samples: they pass no name to timedCalls.
    for (const warm of ['const countWarm = {', 'const hasWarm = {']) {
      const phase = points.slice(
        points.indexOf(warm),
        points.indexOf('mustMake(', points.indexOf(warm)),
      );
      expect(phase, warm).toMatch(/counts,\s*\)\),|present,\s*\)\),/);
    }
  });

  it('does not run a load as a sample', () => {
    const load = between('const load = async', 'const perLoad =');
    expect(load).not.toContain('sample(');
    expect(load).toContain('loader.load(');
  });

  it("records each stage's discards, holds its expected count to what it kept, and its bound too", () => {
    const stage = between('const stage = async (name, { setup, run }) => {', 'return record;');
    expect(stage.indexOf('discards.begin(name)')).toBeLessThan(
      stage.indexOf('await run(prepared)'),
    );
    expect(stage.indexOf('discards.end()')).toBeGreaterThan(stage.indexOf('await run(prepared)'));
    expect(stage).toContain('requests: requestsBetween(s1, s2), discarded }');
    expect(stage).toContain('const kept = keptRequests(record);');
    expect(stage).toContain('if (kept.get !== expected) {');
    const settle = between('const settle = () => {', 'writeResults();');
    expect(settle).toContain('const kept = keptRequests(record);');
    expect(settle).toContain('for (const m of exceedsProjection(discarded, discardBound)) {');
    expect(settle).toContain('...(discards.unfinished?.discarded ?? []),');
    expect(src).toContain('discards: { perRun: DISCARDS_PER_RUN, perStage: DISCARDS_PER_STAGE },');
    // The ceiling is checked after a discard, whose requests were billed.
    expect(between('onDiscard: (d, at) => {', 'const sample = ')).toContain('checkCeiling();');
  });
});
