import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '@cloudbitmaps/s3';
import { GcsStorage } from '@cloudbitmaps/gcs';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { estimateCost, groundedReport } from '@cloudbitmaps/tools';
import {
  CloudRoaring,
  InProcessKeystore,
  LocalFsStorage,
  MemoryStorage,
  ValidationError,
  destroySegment,
  eraseNamespace,
} from '@/index';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';

/**
 * The sweep behind "every call checks its options": each public call that takes an options object is given a key it does
 * not take, and, for each option it takes, a value of the wrong kind. Each must throw `ValidationError`, before it reads
 * or writes. A new call that takes options belongs in the table below; one that is left out is not covered.
 *
 * Kinds, and the wrong value each is given: `bool` a string, `int` a string, `str` a number, `obj` a number, `fn` a number.
 */
type Kind = 'bool' | 'int' | 'str' | 'obj' | 'fn';
const WRONG: Record<Kind, unknown> = { bool: 'true', int: 'x', str: 5, obj: 5, fn: 5 };

/** Run `call`, awaiting its promise or draining its stream, so a refusal is seen however the call reports it. */
async function settle(call: () => unknown): Promise<void> {
  const out = await call();
  if (out !== null && typeof out === 'object' && Symbol.asyncIterator in out) {
    for await (const item of out as AsyncIterable<unknown>) void item;
  }
}

const T0 = MIN_EXPIRES_AT_MS + 700 * 86_400_000;
const REF = { segment: 'a' };
const NO_SINK = { open: () => Promise.reject(new Error('the sink must not be opened')) };

interface Row {
  readonly name: string;
  /** Valid options for the call, so that only the key under test is wrong. */
  readonly base: Record<string, unknown>;
  readonly keys: Readonly<Record<string, Kind>>;
  readonly call: (opts: Record<string, unknown>) => unknown;
}

async function world() {
  const storage = new MemoryStorage();
  const clock = { now: () => T0, sleep: (): Promise<void> => Promise.resolve() };
  const store = new CloudRoaring({ storage, retry: false, seams: { clock } });
  await store.load({ segment: 'a' }, [1, 2, 3]);
  await store.load({ segment: 'b' }, [2, 3, 4]);
  return {
    store,
    storage,
    a: store.segment('a'),
    b: store.segment('b'),
    pinned: await store.segment('a').pin(),
  };
}

const READ = { after: 'int', through: 'int' } as const;
const COMBINE_READ = {
  ...READ,
  concurrency: 'int',
  budget: 'obj',
  allowAbsentOperands: 'bool',
} as const;
const INTO = {
  ...COMBINE_READ,
  exclude: 'obj',
  audit: 'obj',
  allowEmpty: 'bool',
  guard: 'obj',
  metadata: 'obj',
  keep: 'int',
} as const;

function storeRows(w: Awaited<ReturnType<typeof world>>): Row[] {
  const { store, a, b, pinned } = w;
  const into = store.segment('into');
  return [
    {
      name: 'store.segment',
      base: {},
      keys: { namespace: 'str' },
      call: (o) => store.segment('a', o),
    },
    {
      name: 'store.segments',
      base: {},
      keys: { namespace: 'str' },
      call: (o) => store.segments(o),
    },
    {
      name: 'store.load',
      base: {},
      keys: {
        allowEmpty: 'bool',
        guard: 'obj',
        keep: 'int',
        metadata: 'obj',
        audit: 'obj',
        sorted: 'bool',
      },
      call: (o) => store.load({ segment: 'zz' }, [1], o),
    },
    {
      name: 'store.rollback',
      base: {},
      keys: { audit: 'obj', allowUnknown: 'bool' },
      call: (o) => store.rollback(REF, 0, o),
    },
    {
      name: 'store.dropSegment',
      base: { confirmSegment: 'nothing', dryRun: true },
      keys: { confirmSegment: 'str', dryRun: 'bool', audit: 'obj' },
      call: (o) => store.dropSegment({ segment: 'nothing' }, o as never),
    },
    {
      name: 'store.subjectReport',
      base: { allNamespaces: true },
      keys: { namespace: 'str', allNamespaces: 'bool', concurrency: 'int', budget: 'obj' },
      call: (o) => store.subjectReport(1, o),
    },
    {
      name: 'store.eraseSubject',
      base: { allNamespaces: true },
      keys: {
        namespace: 'str',
        allNamespaces: 'bool',
        audit: 'obj',
        concurrency: 'int',
        budget: 'obj',
      },
      call: (o) => store.eraseSubject(99, o),
    },
    {
      name: 'store.retireExpired',
      base: { dryRun: true },
      keys: {
        namespace: 'str',
        now: 'int',
        limit: 'int',
        dryRun: 'bool',
        audit: 'obj',
        maxScanSegments: 'int',
        scan: 'str',
        shards: 'obj',
        totalShards: 'int',
        lookbackBuckets: 'int',
        purgeTombstones: 'bool',
        tombstoneGraceMs: 'int',
      },
      call: (o) => store.retireExpired(o),
    },
    {
      name: 'store.checkConsistency',
      base: {},
      keys: {
        namespace: 'str',
        concurrency: 'int',
        maxScanSegments: 'int',
        summaries: 'bool',
        generations: 'bool',
      },
      call: (o) => store.checkConsistency(o),
    },
    {
      name: 'store.exportSegments',
      base: {},
      keys: { format: 'str', namespace: 'str', ndjsonBatchBytes: 'int' },
      call: (o) => store.exportSegments(NO_SINK, o),
    },
    {
      name: 'store.setRetention (policy)',
      base: { expiresAt: T0 + 86_400_000 },
      keys: { expiresAt: 'int' },
      call: (o) => store.setRetention({ segment: 'nothing' }, o as never),
    },
    { name: 'segment.iterate', base: {}, keys: READ, call: (o) => a.iterate(o) },
    { name: 'segment.everyNth', base: {}, keys: READ, call: (o) => pinned.everyNth(2, o) },
    {
      name: 'segment.pin',
      base: {},
      keys: { leaseUntil: 'int' },
      call: (o) => a.pin(o),
    },
    {
      name: 'segment.pinAt',
      base: {},
      keys: { leaseUntil: 'int' },
      call: (o) => a.pinAt({ generation: 0, fingerprint: 'x' } as never, o),
    },
    {
      name: 'segment.intersect',
      base: {},
      keys: { ...COMBINE_READ, exclude: 'obj' },
      call: (o) => a.intersect([b], o),
    },
    {
      name: 'segment.union',
      base: {},
      keys: { ...COMBINE_READ, exclude: 'obj' },
      call: (o) => a.union([b], o),
    },
    { name: 'segment.andNot', base: {}, keys: COMBINE_READ, call: (o) => a.andNot([b], o) },
    {
      name: 'segment.intersectInto',
      base: {},
      keys: INTO,
      call: (o) => a.intersectInto(into, [b], o),
    },
    { name: 'segment.unionInto', base: {}, keys: INTO, call: (o) => a.unionInto(into, [b], o) },
    {
      name: 'segment.andNotInto',
      base: {},
      keys: { ...INTO, exclude: undefined as never },
      call: (o) => a.andNotInto(into, [b], o),
    },
  ];
}

describe('store and segment calls refuse an option they do not take, and a value of the wrong kind', () => {
  let w: Awaited<ReturnType<typeof world>>;
  let rows: Row[];
  beforeAll(async () => {
    w = await world();
    rows = storeRows(w);
  });

  it('every row runs', () => {
    expect(rows.length).toBeGreaterThan(20);
  });

  const names = [
    'store.segment',
    'store.segments',
    'store.load',
    'store.rollback',
    'store.dropSegment',
    'store.subjectReport',
    'store.eraseSubject',
    'store.retireExpired',
    'store.checkConsistency',
    'store.exportSegments',
    'store.setRetention (policy)',
    'segment.iterate',
    'segment.everyNth',
    'segment.pin',
    'segment.pinAt',
    'segment.intersect',
    'segment.union',
    'segment.andNot',
    'segment.intersectInto',
    'segment.unionInto',
    'segment.andNotInto',
  ];
  describe.each(names)('%s', (name) => {
    const row = (): Row => rows.find((r) => r.name === name)!;
    it('an unknown key', async () => {
      const r = row();
      await expect(settle(() => r.call({ ...r.base, zzUnknown: 1 }))).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
    it('a bag that is not an object', async () => {
      const r = row();
      if (name === 'store.segment') return; // `segment('a', 5)` is checked by its own tests
      await expect(settle(() => r.call(5 as never))).rejects.toBeInstanceOf(ValidationError);
    });
    for (const kind of Object.keys(WRONG) as Kind[]) {
      it(`a ${kind} option given a wrong value`, async () => {
        const r = row();
        const keys = Object.entries(r.keys).filter(([, k]) => k === kind);
        for (const [key] of keys) {
          const bad = { ...r.base, [key]: WRONG[kind] };
          try {
            await settle(() => r.call(bad));
          } catch (err) {
            expect(err, `${name} ${key}`).toBeInstanceOf(ValidationError);
            continue;
          }
          expect.fail(`${name}: ${key} of ${JSON.stringify(WRONG[kind])} was not refused`);
        }
      });
    }
  });
});

describe('destroySegment and eraseNamespace', () => {
  const deps = (storage: MemoryStorage) => ({ registry: storage.registry });

  it.each([
    ['destroySegment', 'confirmSegment', 'str'],
    ['destroySegment', 'allowCleartext', 'bool'],
    ['destroySegment', 'audit', 'obj'],
    ['eraseNamespace', 'confirmNamespace', 'str'],
    ['eraseNamespace', 'allowCleartext', 'bool'],
    ['eraseNamespace', 'maxScanSegments', 'int'],
    ['eraseNamespace', 'audit', 'obj'],
  ] as const)('%s refuses a wrong %s (%s)', async (call, key, kind) => {
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    await store.load({ namespace: 'ns', segment: 'a' }, [1]);
    const base = call === 'destroySegment' ? { confirmSegment: 'a' } : { confirmNamespace: 'ns' };
    const bad = { ...base, [key]: WRONG[kind] } as never;
    const run = (): Promise<unknown> =>
      call === 'destroySegment'
        ? destroySegment({ namespace: 'ns', segment: 'a' }, deps(storage), bad)
        : eraseNamespace('ns', deps(storage), bad);
    await expect(run()).rejects.toBeInstanceOf(ValidationError);
    expect((await storage.registry.get({ namespace: 'ns', segment: 'a' }))?.status).not.toBe(
      'destroyed',
    );
  });

  it('a dryRun, which neither takes, shreds nothing: the segment and its key stay', async () => {
    const storage = new MemoryStorage();
    const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
    const store = new CloudRoaring({ storage, encryption: { keystore } });
    await store.load({ namespace: 'ns', segment: 'a' }, [1, 2]);
    await store.load({ namespace: 'ns', segment: 'b' }, [3]);
    const before = await storage.registry.get({ namespace: 'ns', segment: 'a' });
    expect(before?.wrappedDeks?.length).toBeGreaterThan(0);
    await expect(
      destroySegment({ namespace: 'ns', segment: 'a' }, deps(storage), {
        confirmSegment: 'a',
        dryRun: true,
      } as never),
    ).rejects.toThrow('destroySegment does not take `dryRun`');
    await expect(
      eraseNamespace('ns', deps(storage), { confirmNamespace: 'ns', dryRun: true } as never),
    ).rejects.toThrow('eraseNamespace does not take `dryRun`');
    for (const segment of ['a', 'b']) {
      const row = await storage.registry.get({ namespace: 'ns', segment });
      expect(row?.status).not.toBe('destroyed');
      expect(row?.wrappedDeks?.length).toBeGreaterThan(0);
    }
    expect(await store.segment('a', { namespace: 'ns' }).count()).toBe(2);
  });

  it('allowCleartext of "false" does not tombstone a cleartext segment', async () => {
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    await store.load({ segment: 'plain' }, [1]);
    await expect(
      destroySegment({ segment: 'plain' }, deps(storage), {
        confirmSegment: 'plain',
        allowCleartext: 'false' as never,
      }),
    ).rejects.toThrow('destroySegment: `allowCleartext` must be a boolean; got "false"');
    expect((await storage.registry.get({ segment: 'plain' }))?.status).not.toBe('destroyed');
  });

  it('still destroys with the options it takes', async () => {
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    await store.load({ segment: 'plain' }, [1]);
    const res = await destroySegment({ segment: 'plain' }, deps(storage), {
      confirmSegment: 'plain',
      allowCleartext: true,
    });
    expect(res.destroyed).toBe(true);
  });
});

describe('constructors refuse an option they do not take, and a value of the wrong kind', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cr-option-refusals-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const key32 = (): Uint8Array => randomBytes(32);
  interface Ctor {
    readonly name: string;
    readonly base: () => Record<string, unknown>;
    readonly keys: Readonly<Record<string, Kind>>;
    readonly make: (o: Record<string, unknown>) => unknown;
  }
  const AZ =
    'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Zm9vYmFy;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';
  const ctors = (): Ctor[] => [
    {
      name: 'new CloudRoaring',
      base: () => ({ storage: new MemoryStorage() }),
      keys: {
        storage: 'obj',
        cache: 'obj',
        retry: 'obj',
        metrics: 'obj',
        budget: 'obj',
        seams: 'obj',
        encryption: 'obj',
      },
      make: (o) => new CloudRoaring(o as never),
    },
    {
      name: 'new MemoryStorage',
      base: () => ({}),
      keys: { now: 'fn' },
      make: (o) => new MemoryStorage(o as never),
    },
    {
      name: 'new LocalFsStorage',
      base: () => ({}),
      keys: { now: 'fn' },
      make: (o) => new LocalFsStorage(dir, o as never),
    },
    {
      name: 'new InProcessKeystore',
      base: () => ({ keys: { a: key32() }, activeKeyId: 'a' }),
      keys: { keys: 'obj', activeKeyId: 'str', recoveryKeyId: 'str' },
      make: (o) => new InProcessKeystore(o as never),
    },
    {
      name: 'new S3Storage',
      base: () => ({ bucket: 'b', region: 'us-east-1' }),
      keys: {
        bucket: 'str',
        prefix: 'str',
        client: 'obj',
        region: 'str',
        endpoint: 'str',
        pathStyle: 'bool',
        credentials: 'obj',
        maxSockets: 'int',
        maxObjectBytes: 'int',
        partBytes: 'int',
        readTimeoutMs: 'int',
        conditionalDelete: 'bool',
        now: 'fn',
      },
      make: (o) => new S3Storage(o as never),
    },
    {
      name: 'new GcsStorage',
      base: () => ({ bucket: 'b', apiEndpoint: 'http://127.0.0.1:9' }),
      keys: {
        bucket: 'str',
        prefix: 'str',
        client: 'obj',
        projectId: 'str',
        apiEndpoint: 'str',
        maxObjectBytes: 'int',
        simpleUploadThresholdBytes: 'int',
        readTimeoutMs: 'int',
        conditionalDelete: 'bool',
        now: 'fn',
      },
      make: (o) => new GcsStorage(o as never),
    },
    {
      name: 'new AzureBlobStorage',
      base: () => ({ connectionString: AZ, container: 'c' }),
      keys: {
        containerClient: 'obj',
        connectionString: 'str',
        container: 'str',
        prefix: 'str',
        maxObjectBytes: 'int',
        blockBytes: 'int',
        readTimeoutMs: 'int',
        conditionalDelete: 'bool',
        now: 'fn',
      },
      make: (o) => new AzureBlobStorage(o as never),
    },
  ];
  const names = [
    'new CloudRoaring',
    'new MemoryStorage',
    'new LocalFsStorage',
    'new InProcessKeystore',
    'new S3Storage',
    'new GcsStorage',
    'new AzureBlobStorage',
  ];
  describe.each(names)('%s', (name) => {
    const row = (): Ctor => ctors().find((c) => c.name === name)!;
    it('an unknown key', () => {
      const r = row();
      expect(() => r.make({ ...r.base(), zzUnknown: 1 })).toThrow(ValidationError);
    });
    it('a bag that is not an object', () => {
      const r = row();
      expect(() => r.make(5 as never)).toThrow(ValidationError);
      expect(() => r.make(null as never)).toThrow(ValidationError);
    });
    it.each(['bool', 'int', 'str', 'obj', 'fn'] as const)(
      'a %s option given a wrong value',
      (kind) => {
        const r = row();
        for (const key of Object.keys(r.keys).filter((k) => r.keys[k] === kind)) {
          // `client` and `containerClient` beside the settings that build one are refused as a pair, not as a type.
          expect(
            () => r.make({ ...r.base(), [key]: WRONG[kind] }),
            `${name} ${key} of ${JSON.stringify(WRONG[kind])}`,
          ).toThrow(ValidationError);
        }
      },
    );
  });

  const GROUPS: ReadonlyArray<readonly [string, string, Kind]> = [
    ['cache', 'maxChunks', 'int'],
    ['cache', 'ttlMs', 'int'],
    ['cache', 'genTtlMs', 'int'],
    ['cache', 'readerMax', 'int'],
    ['cache', 'readerMaxBytes', 'int'],
    ['retry', 'maxAttempts', 'int'],
    ['retry', 'baseDelayMs', 'int'],
    ['retry', 'maxDelayMs', 'int'],
    ['retry', 'backoffFactor', 'int'],
    ['retry', 'jitter', 'str'],
    ['retry', 'onRetry', 'fn'],
    ['budget', 'maxRequests', 'int'],
    ['encryption', 'required', 'bool'],
    ['encryption', 'keystore', 'obj'],
    ['seams', 'clock', 'obj'],
    ['seams', 'rng', 'obj'],
    ['seams', 'entropy', 'fn'],
  ];
  it.each(GROUPS)('new CloudRoaring: %s.%s given a wrong value', (group, key, kind) => {
    const options = { storage: new MemoryStorage(), [group]: { [key]: WRONG[kind] } };
    expect(() => new CloudRoaring(options as never)).toThrow(ValidationError);
  });
  it.each(GROUPS)('new CloudRoaring: %s.%s given null', (group, key) => {
    const options = { storage: new MemoryStorage(), [group]: { [key]: null } };
    expect(() => new CloudRoaring(options as never)).toThrow(ValidationError);
  });
  it.each(['cache', 'retry', 'budget', 'encryption', 'seams'])(
    'new CloudRoaring: %s refuses a key it does not take',
    (group) => {
      const options = { storage: new MemoryStorage(), [group]: { zzUnknown: 1 } };
      expect(() => new CloudRoaring(options as never)).toThrow(ValidationError);
    },
  );
});

describe('the cost model refuses an unknown key and a wrong kind at each level', () => {
  const workloadNumbers = [
    'readsPerSec',
    'intersectsPerSec',
    'cacheHitRate',
    'chunksPerIntersect',
    'operandsPerIntersect',
    'loadsPerMonth',
    'requestsPerLoad',
    'hotSegments',
    'readerProcesses',
    'genTtlMs',
    'retirementsPerMonth',
    'purgesPerMonth',
  ];
  const segs = [{ sizeBytes: 5 }];
  it.each(workloadNumbers)('workload.%s given a string', (key) => {
    expect(() => estimateCost({ segments: segs, workload: { [key]: 'x' } as never })).toThrow(
      ValidationError,
    );
    expect(() => groundedReport({ storageBytes: 5, workload: { [key]: 'x' } as never })).toThrow(
      ValidationError,
    );
  });
  it('workload.conditionalDelete given a string', () => {
    expect(() =>
      estimateCost({ segments: segs, workload: { conditionalDelete: 'false' } as never }),
    ).toThrow('conditionalDelete must be a boolean; got "false"');
  });
  it.each(['sizeBytes', 'cardinality', 'count'])('segments[0].%s given a string', (key) => {
    expect(() => estimateCost({ segments: [{ sizeBytes: 5, [key]: 'x' }] as never })).toThrow(
      ValidationError,
    );
  });
  it('an unknown key at the input, a segment, the workload and the rate card', () => {
    expect(() => estimateCost({ segments: segs, zz: 1 } as never)).toThrow(ValidationError);
    expect(() => estimateCost({ segments: [{ sizeBytes: 5, zz: 1 }] } as never)).toThrow(
      ValidationError,
    );
    expect(() => estimateCost({ segments: segs, workload: { zz: 1 } } as never)).toThrow(
      ValidationError,
    );
    expect(() => estimateCost({ segments: segs, pricing: { zz: 1 } } as never)).toThrow(
      ValidationError,
    );
    expect(() => groundedReport({ storageBytes: 5, zz: 1 } as never)).toThrow(ValidationError);
  });
  it('groundedReport refuses a storageBytes that is not a number or null', () => {
    expect(() => groundedReport({ storageBytes: '5' as never })).toThrow(ValidationError);
  });
  it('quotes a string it refuses, so "5" is not read as 5', () => {
    expect(() => estimateCost({ segments: segs, workload: { readsPerSec: '5' } as never })).toThrow(
      'got "5"',
    );
  });
});
