import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudRoaring, InProcessKeystore, MemoryStorage, ValidationError } from '@/index';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
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
    [{ lookbackBuckets: -1 }, '`lookbackBuckets` must be an integer of at least 0; got -1'],
    [{ limit: null }, '`limit` must be an integer'],
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
