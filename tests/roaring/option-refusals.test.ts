import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobServiceClient } from '@azure/storage-blob';
import { S3Storage, type S3StorageOptions } from '@cloudbitmaps/s3';
import { GcsStorage, type GcsStorageOptions } from '@cloudbitmaps/gcs';
import { AzureBlobStorage, type AzureBlobStorageOptions } from '@cloudbitmaps/azure-blob';
import { estimateCost, groundedReport } from '@cloudbitmaps/tools';
import {
  CloudRoaring,
  InProcessKeystore,
  LocalFsStorage,
  MemoryStorage,
  ValidationError,
  destroySegment,
  eraseNamespace,
  type CombineOptions,
  type ExportOptions,
  type InProcessKeystoreOptions,
  type LoadOptions,
  type PinOptions,
  type RetentionPolicy,
  type Segment,
  type SegmentOptions,
} from '@/index';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';

/**
 * The sweep behind "every call checks its options": each public call that takes an options object is given a key it does
 * not take, and, for each option it takes, a value of the wrong kind. Each must throw `ValidationError`, before it reads
 * or writes. Three things keep the table honest:
 *
 *  - the inventory: every callable of the public surface (`api-surface/surface.json`) that has an options, policy or
 *    input parameter is either covered by a row or named in EXCLUDED with a reason, so a new call that takes options
 *    fails here until it has a row or a reason;
 *  - the keys: each row's keys are typed `satisfies Record<keyof …, Kind>` against the call's own options type, so a new
 *    option fails `pnpm typecheck` until the row lists it;
 *  - a positive control: the valid base call of every row must not be refused, so a row cannot pass because its call is
 *    refused for another reason before the option under test is read.
 *
 * Kinds, and the wrong value each is given: `bool` a string, `int` a string, `str` a number, `obj` a number, `fn` a number.
 * `refused` is an option the call does not take, given a plausible value.
 */
type Kind = 'bool' | 'int' | 'str' | 'obj' | 'fn' | 'refused';
const WRONG: Record<Kind, unknown> = { bool: 'true', int: 'x', str: 5, obj: 5, fn: 5, refused: 1 };

/** Run `call`, awaiting its promise or draining its stream, so a refusal is seen however the call reports it. */
async function settle(call: () => unknown): Promise<void> {
  const out = await call();
  if (out !== null && typeof out === 'object' && Symbol.asyncIterator in out) {
    for await (const item of out as AsyncIterable<unknown>) void item;
  }
}

/** Whether `call` throws a `ValidationError`. Anything else, or nothing, is `false`. */
async function refused(call: () => unknown): Promise<boolean> {
  try {
    await settle(call);
    return false;
  } catch (err) {
    return err instanceof ValidationError;
  }
}

const T0 = MIN_EXPIRES_AT_MS + 700 * 86_400_000;
const REF = { segment: 'a' };
const NO_SINK = { open: () => Promise.reject(new Error('the sink must not be opened')) };

interface Row {
  readonly name: string;
  /** The surface.json keys this row covers. */
  readonly covers: readonly string[];
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

type Store = CloudRoaring;
type Arg<F extends (...args: never[]) => unknown, N extends number> = NonNullable<Parameters<F>[N]>;

const RR = '@cloudbitmaps/roaring';
/** What a combine takes: every `CombineOptions` key, the ones the call does not take marked `refused`. */
const combineKeys = (taken: readonly (keyof CombineOptions)[]) => {
  const kinds = {
    after: 'int',
    through: 'int',
    concurrency: 'int',
    budget: 'obj',
    allowAbsentOperands: 'bool',
    exclude: 'obj',
    audit: 'obj',
    allowEmpty: 'bool',
    guard: 'obj',
    metadata: 'obj',
    keep: 'int',
  } as const satisfies Record<keyof CombineOptions, Kind>;
  return Object.fromEntries(
    (Object.keys(kinds) as (keyof CombineOptions)[]).map((k) => [
      k,
      taken.includes(k) ? kinds[k] : 'refused',
    ]),
  ) as Record<keyof CombineOptions, Kind>;
};
const READS: (keyof CombineOptions)[] = [
  'after',
  'through',
  'concurrency',
  'budget',
  'allowAbsentOperands',
];
const INTOS: (keyof CombineOptions)[] = [
  ...READS,
  'audit',
  'allowEmpty',
  'guard',
  'metadata',
  'keep',
];

function rows(w: Awaited<ReturnType<typeof world>>): Row[] {
  const { store, storage, a, b, pinned } = w;
  const into = store.segment('into');
  const eraseDeps = { registry: storage.registry };
  return [
    {
      name: 'store.segment',
      covers: [`${RR} CloudRoaring.segment`],
      base: {},
      keys: { namespace: 'str' } satisfies Record<keyof SegmentOptions, Kind>,
      call: (o) => store.segment('a', o),
    },
    {
      name: 'store.segments',
      covers: [`${RR} CloudRoaring.segments`],
      base: {},
      keys: { namespace: 'str' } satisfies Record<keyof Arg<Store['segments'], 0>, Kind>,
      call: (o) => store.segments(o),
    },
    {
      name: 'store.load',
      covers: [`${RR} CloudRoaring.load`],
      base: {},
      keys: {
        allowEmpty: 'bool',
        guard: 'obj',
        keep: 'int',
        metadata: 'obj',
        audit: 'obj',
        sorted: 'bool',
      } satisfies Record<keyof LoadOptions, Kind>,
      call: (o) => store.load({ segment: 'zz' }, [1], o),
    },
    {
      name: 'store.rollback',
      covers: [`${RR} CloudRoaring.rollback`],
      base: {},
      keys: { audit: 'obj', allowUnknown: 'bool' } satisfies Record<
        keyof Arg<Store['rollback'], 2>,
        Kind
      >,
      call: (o) => store.rollback(REF, 0, o),
    },
    {
      name: 'store.dropSegment',
      covers: [`${RR} CloudRoaring.dropSegment`],
      base: { confirmSegment: 'nothing', dryRun: true },
      keys: { confirmSegment: 'str', dryRun: 'bool', audit: 'obj' } satisfies Record<
        keyof Arg<Store['dropSegment'], 1>,
        Kind
      >,
      call: (o) => store.dropSegment({ segment: 'nothing' }, o as never),
    },
    {
      name: 'store.subjectReport',
      covers: [`${RR} CloudRoaring.subjectReport`],
      base: { allNamespaces: true },
      keys: {
        namespace: 'str',
        allNamespaces: 'bool',
        concurrency: 'int',
        budget: 'obj',
      } satisfies Record<keyof Arg<Store['subjectReport'], 1>, Kind>,
      call: (o) => store.subjectReport(1, o),
    },
    {
      name: 'store.eraseSubject',
      covers: [`${RR} CloudRoaring.eraseSubject`],
      base: { allNamespaces: true },
      keys: {
        namespace: 'str',
        allNamespaces: 'bool',
        audit: 'obj',
        concurrency: 'int',
        budget: 'obj',
      } satisfies Record<keyof Arg<Store['eraseSubject'], 1>, Kind>,
      call: (o) => store.eraseSubject(99, o),
    },
    {
      name: 'store.retireExpired',
      covers: [`${RR} CloudRoaring.retireExpired`],
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
      } satisfies Record<keyof Arg<Store['retireExpired'], 0>, Kind>,
      call: (o) => store.retireExpired(o),
    },
    {
      name: 'store.checkConsistency',
      covers: [`${RR} CloudRoaring.checkConsistency`],
      base: {},
      keys: {
        namespace: 'str',
        concurrency: 'int',
        maxScanSegments: 'int',
        summaries: 'bool',
        generations: 'bool',
      } satisfies Record<keyof Arg<Store['checkConsistency'], 0>, Kind>,
      call: (o) => store.checkConsistency(o),
    },
    {
      name: 'store.exportSegments',
      covers: [`${RR} CloudRoaring.exportSegments`],
      base: {},
      keys: { format: 'str', namespace: 'str', ndjsonBatchBytes: 'int' } satisfies Record<
        keyof ExportOptions,
        Kind
      >,
      call: (o) => store.exportSegments(NO_SINK, o),
    },
    {
      name: 'store.setRetention (policy)',
      covers: [`${RR} CloudRoaring.setRetention`],
      base: { expiresAt: T0 + 86_400_000 },
      keys: { expiresAt: 'int' } satisfies Record<keyof RetentionPolicy, Kind>,
      call: (o) => store.setRetention({ segment: 'nothing' }, o as never),
    },
    {
      name: 'segment.iterate',
      covers: [`${RR} Segment.iterate`],
      base: {},
      keys: combineKeys(['after', 'through']),
      call: (o) => a.iterate(o),
    },
    {
      name: 'segment.everyNth',
      covers: [`${RR} Segment.everyNth`],
      base: {},
      keys: combineKeys(['after', 'through']),
      call: (o) => pinned.everyNth(2, o),
    },
    {
      name: 'segment.pin',
      covers: [`${RR} Segment.pin`],
      base: {},
      keys: { leaseUntil: 'int' } satisfies Record<keyof PinOptions, Kind>,
      call: (o) => a.pin(o),
    },
    {
      name: 'segment.pinAt',
      covers: [`${RR} Segment.pinAt`],
      base: {},
      keys: { leaseUntil: 'int' } satisfies Record<keyof PinOptions, Kind>,
      call: (o) =>
        a.pinAt(
          { generation: pinned.pinnedAt!.generation!, fingerprint: pinned.pinnedAt!.fingerprint! },
          o,
        ),
    },
    {
      name: 'segment.intersect',
      covers: [`${RR} Segment.intersect`],
      base: {},
      keys: combineKeys([...READS, 'exclude']),
      call: (o) => a.intersect([b], o),
    },
    {
      name: 'segment.union',
      covers: [`${RR} Segment.union`],
      base: {},
      keys: combineKeys([...READS, 'exclude']),
      call: (o) => a.union([b], o),
    },
    {
      name: 'segment.andNot',
      covers: [`${RR} Segment.andNot`],
      base: {},
      keys: combineKeys(READS),
      call: (o) => a.andNot([b], o),
    },
    {
      name: 'segment.intersectInto',
      covers: [`${RR} Segment.intersectInto`],
      base: {},
      keys: combineKeys([...INTOS, 'exclude']),
      call: (o) => a.intersectInto(into, [b], o),
    },
    {
      name: 'segment.unionInto',
      covers: [`${RR} Segment.unionInto`],
      base: {},
      keys: combineKeys([...INTOS, 'exclude']),
      call: (o) => a.unionInto(into, [b], o),
    },
    {
      name: 'segment.andNotInto',
      covers: [`${RR} Segment.andNotInto`],
      base: {},
      keys: combineKeys(INTOS),
      call: (o) => a.andNotInto(into, [b], o),
    },
    {
      name: 'destroySegment',
      covers: [`${RR} destroySegment`],
      base: { confirmSegment: 'nothing', allowCleartext: true },
      keys: { confirmSegment: 'str', allowCleartext: 'bool', audit: 'obj' },
      call: (o) => destroySegment({ segment: 'nothing' }, eraseDeps, o as never),
    },
    {
      name: 'eraseNamespace',
      covers: [`${RR} eraseNamespace`],
      base: { confirmNamespace: 'ns', allowCleartext: true },
      keys: {
        confirmNamespace: 'str',
        allowCleartext: 'bool',
        audit: 'obj',
        maxScanSegments: 'int',
      },
      call: (o) => eraseNamespace('ns', eraseDeps, o as never),
    },
  ];
}

/** Public callables with an options, policy or input parameter that the table leaves out, each with the reason. */
const EXCLUDED: Readonly<Record<string, string>> = {
  '@cloudbitmaps/core/driver-kit IRegistryDriver.create':
    'driver port: per-call options the engine builds; segment refs on the ports are another change',
  '@cloudbitmaps/core/driver-kit IRegistryDriver.compareAndSwap':
    'driver port: per-call options the engine builds; segment refs on the ports are another change',
  '@cloudbitmaps/core/driver-kit ObjectStoreRegistry.create':
    'driver port: per-call options the engine builds; segment refs on the ports are another change',
  '@cloudbitmaps/core/driver-kit ObjectStoreRegistry.compareAndSwap':
    'driver port: per-call options the engine builds; segment refs on the ports are another change',
  '@cloudbitmaps/core/driver-kit IStorageDriver.delete':
    'driver port: per-call options the engine builds; segment refs on the ports are another change',
  '@cloudbitmaps/core/driver-kit StorageChunkSource.getChunks':
    'driver port: per-call options the engine builds; segment refs on the ports are another change',
  '@cloudbitmaps/core/driver-kit TransientError.constructor':
    'an error class carrying { cause }, not a configuration',
  '@cloudbitmaps/roaring TransientError.constructor':
    'an error class carrying { cause }, not a configuration',
  '@cloudbitmaps/core/driver-kit refuseUnknownOptions': 'the checker itself',
  '@cloudbitmaps/roaring CloudRoaring.materializeMany':
    'its options are held by its own tests (another change owns the verb)',
  '@cloudbitmaps/roaring CloudRoaring.materializeMany #2':
    'its options are held by its own tests (another change owns the verb)',
  '@cloudbitmaps/roaring CloudRoaring.materializeMany #3':
    'its options are held by its own tests (another change owns the verb)',
};

/** The constructors, which are held below with their own bags. */
const CTOR_COVERS: readonly string[] = [
  `${RR} CloudRoaring.constructor`,
  `${RR} MemoryStorage.constructor`,
  `${RR} LocalFsStorage.constructor`,
  `${RR} InProcessKeystore.constructor`,
  '@cloudbitmaps/s3 S3Storage.constructor',
  '@cloudbitmaps/gcs GcsStorage.constructor',
  '@cloudbitmaps/azure-blob AzureBlobStorage.constructor',
  '@cloudbitmaps/tools estimateCost',
  '@cloudbitmaps/tools groundedReport',
];

/** The callables of the public surface that take an options, policy, input or deps parameter. */
function inventory(): string[] {
  const surface = JSON.parse(
    readFileSync(resolve(__dirname, '../../api-surface/surface.json'), 'utf8'),
  ) as { entries: Record<string, string | string[]> };
  const out: string[] = [];
  for (const [key, value] of Object.entries(surface.entries)) {
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    const params = /\(([^)]*)\)/.exec(text)?.[1];
    if (params === undefined) continue;
    if (/(^|, )(options|policy|opts|input|deps)\??:/.test(params)) out.push(key);
  }
  return out;
}

describe('the table covers every public call that takes options', () => {
  it('finds the calls it exists for (a control that must hit)', () => {
    const found = inventory();
    expect(found).toContain(`${RR} CloudRoaring.load`);
    expect(found).toContain('@cloudbitmaps/s3 S3Storage.constructor');
    expect(found).toContain(`${RR} destroySegment`);
    expect(found.length).toBeGreaterThan(30);
  });

  it('every such call has a row or a reason, and nothing listed has gone', async () => {
    const w = await world();
    const covered = new Set([
      ...rows(w).flatMap((r) => r.covers),
      ...CTOR_COVERS,
      ...Object.keys(EXCLUDED),
    ]);
    const found = new Set(inventory());
    expect([...found].filter((k) => !covered.has(k))).toEqual([]);
    expect([...covered].filter((k) => !found.has(k))).toEqual([]);
  });
});

describe('store, segment and function calls refuse an option they do not take, and a value of the wrong kind', () => {
  let w: Awaited<ReturnType<typeof world>>;
  let table: Row[];
  beforeAll(async () => {
    w = await world();
    table = rows(w);
  });

  it('every row runs', () => {
    expect(table.length).toBeGreaterThan(20);
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
    'destroySegment',
    'eraseNamespace',
  ];
  it('the names list is the table', () => {
    expect(table.map((r) => r.name)).toEqual(names);
  });

  describe.each(names)('%s', (name) => {
    const row = (): Row => table.find((r) => r.name === name)!;
    it('its valid base call is not refused', async () => {
      const r = row();
      expect(await refused(() => r.call(r.base))).toBe(false);
    });
    it('an unknown key', async () => {
      const r = row();
      expect(await refused(() => r.call({ ...r.base, zzUnknown: 1 }))).toBe(true);
    });
    it('a bag that is not an object', async () => {
      const r = row();
      if (name === 'store.segment') return; // `segment('a', 5)` is checked by its own tests
      expect(await refused(() => r.call(5 as never))).toBe(true);
    });
    it('each option given a wrong value of its kind', async () => {
      const r = row();
      for (const [key, kind] of Object.entries(r.keys)) {
        const bad = { ...r.base, [key]: WRONG[kind] };
        expect(
          await refused(() => r.call(bad)),
          `${name}: ${key} of ${JSON.stringify(WRONG[kind])}`,
        ).toBe(true);
      }
    });
    it('null is not read as absent for a number, a switch or a name', async () => {
      const r = row();
      for (const [key, kind] of Object.entries(r.keys)) {
        if (kind === 'obj' || kind === 'fn') continue; // a sink, a guard or an exclude of `null` reads as absent
        const bad = { ...r.base, [key]: null };
        expect(await refused(() => r.call(bad)), `${name}: ${key} of null`).toBe(true);
      }
    });
  });
});

describe('destroySegment and eraseNamespace', () => {
  const deps = (storage: MemoryStorage) => ({ registry: storage.registry });

  it('refuse deps with no registry driver, before any read', async () => {
    const storage = new MemoryStorage();
    const calls = (d: unknown): Array<() => Promise<unknown>> => [
      () => destroySegment({ segment: 'a' }, d as never, { confirmSegment: 'a' }),
      () => eraseNamespace('ns', d as never, { confirmNamespace: 'ns' }),
    ];
    for (const bad of [{}, { registy: storage.registry }, null, 5, { registry: {} }]) {
      for (const call of calls(bad)) {
        await expect(call()).rejects.toBeInstanceOf(ValidationError);
      }
    }
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

  it('a wrong option leaves the segment and its key in place', async () => {
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    await store.load({ namespace: 'ns', segment: 'a' }, [1]);
    for (const bad of [{ allowCleartext: 'true' }, { audit: 5 }, { confirmSegment: 5 }]) {
      await expect(
        destroySegment({ namespace: 'ns', segment: 'a' }, deps(storage), {
          confirmSegment: 'a',
          ...bad,
        } as never),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    for (const bad of [{ allowCleartext: 'true' }, { audit: 5 }, { maxScanSegments: 'x' }]) {
      await expect(
        eraseNamespace('ns', deps(storage), { confirmNamespace: 'ns', ...bad } as never),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await storage.registry.get({ namespace: 'ns', segment: 'a' }))?.status).not.toBe(
      'destroyed',
    );
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
    /** Keys whose wrong value is refused as a pair with the settings in `base`, tested alone by their own rows. */
    readonly pairs?: readonly string[];
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
      keys: { keys: 'obj', activeKeyId: 'str', recoveryKeyId: 'str' } satisfies Record<
        keyof InProcessKeystoreOptions,
        Kind
      >,
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
      } satisfies Record<keyof S3StorageOptions, Kind>,
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
      } satisfies Record<keyof GcsStorageOptions, Kind>,
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
      } satisfies Record<keyof AzureBlobStorageOptions, Kind>,
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
    it('its valid base is not refused', () => {
      const r = row();
      expect(() => r.make(r.base())).not.toThrow();
    });
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
          expect(
            () => r.make({ ...r.base(), [key]: WRONG[kind] }),
            `${name} ${key} of ${JSON.stringify(WRONG[kind])}`,
          ).toThrow(ValidationError);
        }
      },
    );
  });

  const only = (o: object): unknown => o;
  it('S3Storage client alone: a value that is not an S3Client is refused, a client takes', () => {
    for (const bad of [5, {}, 'client', () => 1]) {
      expect(() => new S3Storage(only({ bucket: 'b', client: bad }) as never)).toThrow(
        'S3Storage: `client` must be an S3Client',
      );
    }
    expect(
      () => new S3Storage({ bucket: 'b', client: { send: () => Promise.resolve({}) } as never }),
    ).not.toThrow();
  });
  it('AzureBlobStorage containerClient alone: a BlobServiceClient is named as the likely slip', () => {
    for (const bad of [5, {}, 'client']) {
      expect(() => new AzureBlobStorage(only({ containerClient: bad }) as never)).toThrow(
        'AzureBlobStorage: `containerClient` must be a ContainerClient',
      );
    }
    const service = BlobServiceClient.fromConnectionString(AZ);
    expect(() => new AzureBlobStorage({ containerClient: service as never })).toThrow(
      '.getContainerClient(name)',
    );
    expect(
      () => new AzureBlobStorage({ containerClient: service.getContainerClient('c') }),
    ).not.toThrow();
  });
  it('a bucket of spaces is refused on S3 and GCS, a root of spaces on local files', () => {
    expect(() => new S3Storage({ bucket: '   ', region: 'us-east-1' })).toThrow(ValidationError);
    expect(() => new GcsStorage({ bucket: '   ', apiEndpoint: 'http://127.0.0.1:9' })).toThrow(
      ValidationError,
    );
    expect(() => new LocalFsStorage('   ')).toThrow(ValidationError);
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
  it('a valid call is not refused', () => {
    expect(() => estimateCost({ segments: segs, workload: { readsPerSec: 1 } })).not.toThrow();
    expect(() => groundedReport({ storageBytes: 5 })).not.toThrow();
  });
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

/** The segment type is only named here so the table's rows can be typed against it. */
export type { Segment };
