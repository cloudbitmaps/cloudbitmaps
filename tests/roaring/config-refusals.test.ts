import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudRoaring, InProcessKeystore, MemoryStorage, ValidationError } from '@/index';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { judgeLoad } from '@/core/load';
import { dropSegment as coreDropSegment } from '@/core/erasure';
import { eraseIdFromSegment } from '@/core/erase-id';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';
import { roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

/**
 * Options that can never be honoured are refused by the name the caller wrote, before anything is built, read or
 * written: a `cache` size under its own public name rather than an internal one, an `encryption.required` that is not
 * exactly a boolean, a keystore option it does not take, and a sweep `scan` it does not know.
 */

const T0 = MIN_EXPIRES_AT_MS + 700 * 86_400_000;

describe('cache options are refused under the name the caller wrote', () => {
  const build = (cache: unknown): CloudRoaring =>
    new CloudRoaring({ storage: new MemoryStorage(), cache: cache as never });

  it.each([
    ['maxChunks', 0, 'cache.maxChunks must be an integer of at least 1; got 0'],
    ['maxChunks', '5', 'cache.maxChunks must be an integer of at least 1; got "5"'],
    ['maxChunks', null, 'cache.maxChunks must be an integer of at least 1; got null'],
    ['maxChunks', 1.5, 'cache.maxChunks must be an integer of at least 1; got 1.5'],
    ['readerMax', 0, 'cache.readerMax must be an integer of at least 1; got 0'],
    ['readerMax', Number.NaN, 'cache.readerMax must be an integer of at least 1; got NaN'],
    ['readerMax', null, 'cache.readerMax must be an integer of at least 1; got null'],
    ['readerMaxBytes', 0, 'cache.readerMaxBytes must be an integer of at least 1; got 0'],
    ['readerMaxBytes', 1.5, 'cache.readerMaxBytes must be an integer of at least 1; got 1.5'],
    ['ttlMs', -1, 'cache.ttlMs must be a finite number above 0 (milliseconds); got -1'],
    ['ttlMs', 0, 'cache.ttlMs must be a finite number above 0 (milliseconds); got 0'],
    ['ttlMs', '9', 'cache.ttlMs must be a finite number above 0 (milliseconds); got "9"'],
    ['ttlMs', null, 'cache.ttlMs must be a finite number above 0 (milliseconds); got null'],
  ])('cache.%s of %j', (name, value, message) => {
    const make = (): CloudRoaring => build({ [name]: value });
    expect(make).toThrow(ValidationError);
    expect(make).toThrow(message);
  });

  it('takes the sizes it documents, including a reader byte ceiling of 1', () => {
    expect(() =>
      build({ maxChunks: 1, readerMax: 1, readerMaxBytes: 1, ttlMs: 1, genTtlMs: 0 }),
    ).not.toThrow();
    expect(() => build({})).not.toThrow();
  });

  it('a source built by hand names its own options', () => {
    const storage = new MemoryStorageDriver();
    expect(() => new CrbmStorageChunkSource(storage, { maxOpenSegments: 0 })).toThrow(
      'maxOpenSegments must be an integer of at least 1; got 0',
    );
    expect(() => new CrbmStorageChunkSource(storage, { maxOpenIndexBytes: 1.5 })).toThrow(
      'maxOpenIndexBytes must be an integer of at least 1; got 1.5',
    );
  });
});

describe('encryption.required is exactly a boolean', () => {
  const build = (required: unknown): CloudRoaring =>
    new CloudRoaring({
      storage: new MemoryStorage(),
      encryption: { required: required as boolean },
    });

  it.each(['true', 'yes', 'false', '', 1, 0, null, {}, []])('refuses %j', (value) => {
    const make = (): CloudRoaring => build(value);
    expect(make).toThrow(ValidationError);
    expect(make).toThrow("CloudRoaring's `encryption.required` must be a boolean; got ");
  });

  it('names the value it got, a string quoted', () => {
    expect(() => build('true')).toThrow('must be a boolean; got "true"');
  });

  it('takes true, false and absent', () => {
    expect(() => build(false)).not.toThrow();
    expect(() => build(undefined)).not.toThrow();
    expect(
      () =>
        new CloudRoaring({
          storage: new MemoryStorage(),
          encryption: {
            required: true,
            keystore: new InProcessKeystore({ keys: { a: randomBytes(32) }, activeKeyId: 'a' }),
          },
        }),
    ).not.toThrow();
  });

  it('a cleartext read and a cleartext load are both refused, or both allowed', async () => {
    const storage = new MemoryStorage();
    await new CloudRoaring({ storage, retry: false }).load({ segment: 'clear' }, [1, 2]);
    for (const required of [true, false]) {
      const store = new CloudRoaring({ storage, retry: false, encryption: { required } });
      const read = store.segment('clear').has(1);
      const load = store.load({ segment: 'clear' }, [1, 2, 3]);
      if (required) {
        await expect(read).rejects.toThrow('requireEncryption');
        await expect(load).rejects.toThrow('requireEncryption');
      } else {
        await expect(read).resolves.toBe(true);
        await expect(load).resolves.toBeDefined();
      }
    }
  });

  it('the core write paths refuse a non-boolean they are handed', async () => {
    const { bulkLoadCrbmGeneration } = await import('../helpers/bulk-load');
    await expect(
      bulkLoadCrbmGeneration(new MemoryStorageDriver(), { segment: 's', generation: 0 }, [1], {
        registry: new MemoryRegistryDriver(),
        requireEncryption: 'true' as never,
      }),
    ).rejects.toThrow('requireEncryption must be a boolean; got "true"');
  });
});

describe('a keystore built with a recovery key wraps every new key twice', () => {
  it('a load writes the active and the recovery wrapping', async () => {
    const storage = new MemoryStorage();
    const keystore = new InProcessKeystore({
      keys: { active: randomBytes(32), rec: randomBytes(32) },
      activeKeyId: 'active',
      recoveryKeyId: 'rec',
    });
    const store = new CloudRoaring({ storage, retry: false, encryption: { keystore } });
    await store.load({ segment: 's' }, [1, 2, 3]);
    const row = await storage.registry.get({ segment: 's' });
    expect(row?.wrappedDeks?.map((w) => w.keyId)).toEqual(['active', 'rec']);
  });
});

describe('retireExpired refuses a bad option before it lists the registry', () => {
  it.each([
    [{ scan: 'bogus' }, "`scan` must be 'fleet' or 'index'; got \"bogus\""],
    [{ scan: 'idnex' }, "`scan` must be 'fleet' or 'index'; got \"idnex\""],
    [
      { lookbackBuckets: -1 },
      "`lookbackBuckets` must be an integer from 0 to 3660 (days; older rows are the fleet scan's to find); got -1",
    ],
    [{ limit: null }, '`limit` must be an integer'],
    [{ tombstoneGraceMs: 0 }, 'at least 3600000 (one hour'],
    [{ tombstoneGraceMs: null }, '`tombstoneGraceMs` must be a finite number'],
    [{ shards: [], totalShards: 2 }, 'shards is empty'],
    [{ shards: [1, 1], totalShards: 2 }, 'shard 1 is listed twice'],
  ])('%j', async (options, message) => {
    const storage = new MemoryStorage();
    const clock = { now: () => T0, sleep: (): Promise<void> => Promise.resolve() };
    const store = new CloudRoaring({ storage, retry: false, seams: { clock } });
    await store.load({ segment: 'a' }, [1]);
    await store.setRetention({ segment: 'a' }, { expiresAt: T0 - 86_400_000 });
    const list = vi.spyOn(storage.registry, 'list');
    const sweep = store.retireExpired(options as never);
    await expect(sweep).rejects.toBeInstanceOf(ValidationError);
    await expect(sweep).rejects.toThrow(message);
    expect(list).not.toHaveBeenCalled();
    // And nothing was retired.
    expect(await store.segment('a').has(1)).toBe(true);
  });
});

describe('the core entries that take requireEncryption hold it to a boolean', () => {
  const REF = { segment: 's' };
  const coreDeps = () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    return { storage, registry, entropy: testEntropy, codec: roaringCodec };
  };

  it('judgeLoad refuses it', async () => {
    const d = coreDeps();
    await expect(judgeLoad(REF, 1, { ...d, requireEncryption: 'true' as never })).rejects.toThrow(
      'requireEncryption must be a boolean; got "true"',
    );
  });

  it('an erasure refuses it before it reads a cleartext segment as encrypted or not', async () => {
    const d = coreDeps();
    await bulkLoadCrbmGeneration(d.storage, { ...REF, generation: 0 }, [1, 2], {
      registry: d.registry,
    });
    await expect(
      eraseIdFromSegment(REF, 1, { ...d, requireEncryption: 'true' as never }),
    ).rejects.toThrow('requireEncryption must be a boolean; got "true"');
    expect((await d.registry.get(REF))?.currentGen).toBe(0);
  });

  it('a read source refuses it', () => {
    expect(
      () =>
        new CrbmStorageChunkSource(new MemoryStorageDriver(), {
          registry: new MemoryRegistryDriver(),
          requireEncryption: 'true' as never,
        }),
    ).toThrow('requireEncryption must be a boolean; got "true"');
  });
});

describe('null is not the default', () => {
  const T = MIN_EXPIRES_AT_MS + 700 * 86_400_000;
  const world = async () => {
    const clock = { now: () => T, sleep: (): Promise<void> => Promise.resolve() };
    const store = new CloudRoaring({
      storage: new MemoryStorage(),
      retry: false,
      seams: { clock },
    });
    await store.load({ segment: 'a' }, [1, 2]);
    return store;
  };

  it('keep on load and on an Into verb', async () => {
    const store = await world();
    await expect(store.load({ segment: 'a' }, [3], { keep: null as never })).rejects.toThrow(
      'keep must be an integer of at least 0; got null',
    );
    await store.load({ segment: 'b' }, [2]);
    await expect(
      store.segment('a').intersectInto(store.segment('c'), [store.segment('b')], {
        keep: null as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('now on retireExpired, and maxRequests of a per-call budget', async () => {
    const store = await world();
    await expect(store.retireExpired({ now: null as never, dryRun: true })).rejects.toThrow(
      'retireExpired: `now` must be a finite number',
    );
    await expect(
      store.eraseSubject(9, { allNamespaces: true, budget: { maxRequests: null as never } }),
    ).rejects.toThrow('budget.maxRequests must be an integer of at least 1; got null');
  });

  it('cache.genTtlMs, the retry fields and the store budget', () => {
    const build = (o: object): CloudRoaring =>
      new CloudRoaring({ storage: new MemoryStorage(), ...o } as never);
    expect(() => build({ cache: { genTtlMs: null } })).toThrow(
      'cache.genTtlMs must be a finite number',
    );
    expect(() => build({ retry: { maxAttempts: null } })).toThrow(
      'retry.maxAttempts must be an integer',
    );
    expect(() => build({ retry: { jitter: null } })).toThrow('retry.jitter');
    expect(() => build({ budget: { maxRequests: null } })).toThrow(
      'budget.maxRequests must be an integer',
    );
    expect(() => build({ retry: { maxAttempts: undefined } })).not.toThrow();
  });

  it('a null seam or keystore, under required too', () => {
    const build = (o: object): CloudRoaring =>
      new CloudRoaring({ storage: new MemoryStorage(), ...o } as never);
    expect(() => build({ encryption: { keystore: null } })).toThrow(ValidationError);
    expect(() => build({ encryption: { keystore: null, required: true } })).toThrow(
      "CloudRoaring's `encryption.keystore` must be an object with",
    );
    expect(() => build({ seams: { clock: null } })).toThrow(ValidationError);
    expect(() => build({ seams: { rng: null } })).toThrow(ValidationError);
  });
});

describe('retireExpired bounds lookbackBuckets and checks totalShards on its own', () => {
  it('a lookback of 1e9 days is a ValidationError, not a RangeError', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    const sweep = store.retireExpired({ scan: 'index', lookbackBuckets: 1e9, dryRun: true });
    await expect(sweep).rejects.toBeInstanceOf(ValidationError);
    await expect(sweep).rejects.toThrow('`lookbackBuckets` must be an integer from 0 to 3660');
    await expect(
      store.retireExpired({ scan: 'index', lookbackBuckets: 3660, dryRun: true }),
    ).resolves.toBeDefined();
  });

  it('totalShards of "x" with no shards', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await expect(store.retireExpired({ totalShards: 'x' as never })).rejects.toThrow(
      '`totalShards` must be an integer of at least 1; got "x"',
    );
  });
});

describe('setRetention refuses a policy key it does not take', () => {
  it('names the key and the one it takes, and writes nothing', async () => {
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    await store.load({ segment: 'a' }, [1]);
    const before = await storage.registry.get({ segment: 'a' });
    await expect(
      store.setRetention({ segment: 'a' }, { expiresAt: T0 + 1, extra: 1 } as never),
    ).rejects.toThrow('setRetention policy does not take `extra`. It takes `expiresAt`.');
    expect((await storage.registry.get({ segment: 'a' }))?.token).toBe(before?.token);
  });
});

describe("core's dropSegment refuses what the facade does", () => {
  it('a dryRun that is a string does not drop for real, and an unknown key is refused', async () => {
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    await store.load({ segment: 'a' }, [1, 2]);
    const deps = { registry: storage.registry, storage: storage.storage };
    await expect(
      coreDropSegment({ segment: 'a' }, deps as never, {
        confirmSegment: 'a',
        dryRun: 'true' as never,
      }),
    ).rejects.toThrow('dropSegment: `dryRun` must be a boolean; got "true"');
    await expect(
      coreDropSegment(
        { segment: 'a' },
        deps as never,
        { confirmSegment: 'a', dryrun: true } as never,
      ),
    ).rejects.toThrow('dropSegment does not take `dryrun`');
    expect((await storage.registry.get({ segment: 'a' }))?.status).not.toBe('destroyed');
    expect(await store.segment('a').count()).toBe(2);
  });
});
