import { randomBytes } from 'node:crypto';
import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryStorage,
  MemoryStorageDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryStorageChunkSource, SafeBitmap } from '@/index';
import { TransientError } from '@/core/errors';
import type { ChunkRef, Clock, SegmentRef as Ref, StorageChunkSource } from '@/index';
import { KeyUnavailableError, ValidationError, BudgetExceededError } from '@/core/errors';
import type { SegmentRef } from '@/index';

/**
 * The 14 flat options became one required `storage` plus six groups.
 *
 * A regrouping is the kind of change that passes every existing test while quietly doing nothing: wire
 * `cache.genTtlMs` to the wrong place and it reverts to the 2 s default, which is what most tests want anyway.
 * So each group is asserted by the **effect** it has, not by reading the field back.
 */
const SEG: SegmentRef = { segment: 's' };
const k = (): Uint8Array => randomBytes(32);

describe('grouped options reach the thing they configure', () => {
  it('`seams.clock` drives the store clock', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1], {
      registry: backend.registry,
    });
    // One deadline, two injected clocks either side of it: the ONLY thing deciding the answer is the clock
    // that reached the store, so a `seams.clock` that never arrived would answer 1 both times.
    const deadline = 1_800_000_000_000;
    const after = new CloudRoaring({
      storage: backend,
      seams: { clock: { now: () => deadline + 1, sleep: async () => {} } },
    });
    expect(await after.segment('s', { expiresAt: deadline }).count()).toBe(0);
    const before = new CloudRoaring({
      storage: backend,
      seams: { clock: { now: () => deadline - 1, sleep: async () => {} } },
    });
    expect(await before.segment('s', { expiresAt: deadline }).count()).toBe(1);
  });

  it('`encryption.keystore` + `encryption.required` reach the read path', async () => {
    const backend = new MemoryStorage();
    const keystore = new InProcessKeystore({ keys: { k1: k() }, activeKeyId: 'k1' });
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: backend.registry,
      keystore,
    });
    expect(
      await new CloudRoaring({ storage: backend, encryption: { keystore } }).segment('s').count(),
    ).toBe(3);
    // Without the group the DEK is unreachable — proving the keystore was not being picked up from elsewhere.
    await expect(new CloudRoaring({ storage: backend }).segment('s').count()).rejects.toThrow(
      KeyUnavailableError,
    );

    // `required` refuses a CLEARTEXT segment; if the flag were dropped this would answer 1.
    const clear = new MemoryStorage();
    await bulkLoadCrbmGeneration(clear.storage, { ...SEG, generation: 0 }, [1], {
      registry: clear.registry,
    });
    await expect(
      new CloudRoaring({ storage: clear, encryption: { required: true } }).segment('s').count(),
    ).rejects.toThrow(KeyUnavailableError);
  });

  it('`cache.maxChunks` bounds the chunk cache', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1, 70_000], {
      registry: backend.registry,
    });
    const metrics = new CountingMetricsSink();
    // Two chunks, room for one: alternating reads evict each other, so NOTHING is ever served from cache.
    // Assert on hits rather than misses — with the ceiling dropped, the two cold reads are still misses, so a
    // `misses > 1` assertion passes under the default ceiling too and the mutant survives (it did).
    const store = new CloudRoaring({ storage: backend, cache: { maxChunks: 1 }, metrics });
    const seg = store.segment('s');
    for (let i = 0; i < 3; i++) {
      await seg.has(1);
      await seg.has(70_000);
    }
    expect(metrics.snapshot().cache.hits).toBe(0);
    expect(metrics.snapshot().cache.misses).toBe(6);
  });

  it('`metrics` and `budget` still apply, ungrouped', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1], {
      registry: backend.registry,
    });
    const metrics = new CountingMetricsSink();
    const store = new CloudRoaring({ storage: backend, metrics, budget: { maxRequests: 1 } });
    const drain = async (): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _id of store.segment('s').intersect([store.segment('s')]));
    };
    await expect(drain()).rejects.toThrow(BudgetExceededError);
    expect(metrics.snapshot().storage.gets).toBeGreaterThanOrEqual(0);
  });

  // The flat form took a WHOLE RetryPolicy, so tuning one field meant restating all five — and `onRetry` was a
  // sibling key, so it could not be given at all without one. Both are now expressible alone.
  it('`retry` takes a partial policy, and `onRetry` alone is legal', async () => {
    const backend = new MemoryStorage();
    await bulkLoadCrbmGeneration(backend.storage, { ...SEG, generation: 0 }, [1], {
      registry: backend.registry,
    });
    expect(
      () => new CloudRoaring({ storage: backend, retry: { onRetry: () => {} } }),
    ).not.toThrow();
    expect(() => new CloudRoaring({ storage: backend, retry: { maxAttempts: 2 } })).not.toThrow();
    expect(await new CloudRoaring({ storage: backend, retry: false }).segment('s').count()).toBe(1);
  });
});

/**
 * Every moved option is a knob whose absence is SILENT and wrong — a dropped `requireEncryption` reads
 * cleartext, a dropped `clock` makes a deterministic job non-deterministic. TypeScript catches these at the
 * call site; this catches the plain-JS caller, the JSON config and the `as` cast, which are exactly the
 * callers who would otherwise get the default and never know.
 */
describe('an option that moved into a group is refused, not ignored', () => {
  const backend = (): MemoryStorage => new MemoryStorage();
  const build = (extra: Record<string, unknown>): CloudRoaring =>
    new CloudRoaring({ storage: backend(), ...extra } as unknown as { storage: MemoryStorage });

  it.each([
    ['cacheMaxChunks', 512, 'cache.maxChunks'],
    ['cacheTtlMs', 1000, 'cache.ttlMs'],
    ['storageGenTtlMs', 0, 'cache.genTtlMs'],
    ['storageReaderCacheMax', 8, 'cache.readerMax'],
    ['storageReaderCacheMaxBytes', 1024, 'cache.readerMaxBytes'],
    ['requireEncryption', true, 'encryption.required'],
    ['onRetry', () => {}, 'retry.onRetry'],
    ['rng', { next: () => 0.5 }, 'seams.rng'],
    ['registry', new MemoryRegistryDriver(), 'backend'],
    ['cold', new MemoryStorageDriver(), 'storage'],
  ])('rejects `%s` and names where it went', (key, value, expected) => {
    expect(() => build({ [key]: value })).toThrow(ValidationError);
    expect(() => build({ [key]: value })).toThrow(new RegExp(expected.replace('.', '\\.')));
  });

  it('names every offender at once, not just the first', () => {
    // Order follows the declaration list, not the caller's object, so assert presence rather than sequence.
    const both = (): CloudRoaring =>
      build({ clock: { now: () => 0, sleep: async () => {} }, cacheTtlMs: 5 });
    expect(both).toThrow(/cacheTtlMs/);
    expect(both).toThrow(/clock/);
  });

  // `storageGenTtlMs: 0` is falsy and `requireEncryption: false` is too — a presence check written as a
  // truthiness check would wave both through, and `genTtlMs: 0` is precisely the value tests rely on.
  it('catches a falsy value, which a truthiness check would miss', () => {
    expect(() => build({ storageGenTtlMs: 0 })).toThrow(ValidationError);
    expect(() => build({ requireEncryption: false })).toThrow(ValidationError);
  });

  it('leaves the grouped form alone', () => {
    expect(
      () =>
        new CloudRoaring({
          storage: backend(),
          cache: { maxChunks: 512, genTtlMs: 0 },
          encryption: { required: false },
          seams: { rng: { next: () => 0.5 } },
        }),
    ).not.toThrow();
  });
});

/**
 * A partial policy is the whole point of the `retry` group — and it is also what put this hazard in reach.
 *
 * `{ ...DEFAULT_RETRY_POLICY, ...overrides }` lets a key that is PRESENT WITH VALUE `undefined` overwrite the
 * default instead of falling back to it. `exactOptionalPropertyTypes` is off in this repo, so
 * `retry: { baseDelayMs: cfg.baseDelayMs }` typechecks clean when `cfg.baseDelayMs` is absent — the ordinary
 * shape for a value read from env or JSON. The delays became `NaN`; `SystemClock.sleep` then takes the
 * `setTimeout(resolve, NaN)` path, which Node coerces to 1 ms. Bounded jittered backoff silently becomes a
 * ~1 ms hot retry loop: the read still succeeds, the retry metric still emits, and the thundering-herd and
 * denial-of-wallet protection is gone with nothing to see. Every one of these was a compile error before the
 * policy became a `Partial`.
 */
describe('a partial retry policy fills from the default, even for an explicit undefined', () => {
  const recordingClock = (): Clock & { sleeps: number[] } => {
    const sleeps: number[] = [];
    return {
      now: () => 0,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      sleeps,
    };
  };

  class FlakyOnce implements StorageChunkSource {
    private fails = 0;
    constructor(
      private readonly inner: MemoryStorageChunkSource,
      private readonly failTimes: number,
    ) {}
    getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
      if (this.fails < this.failTimes) {
        this.fails += 1;
        return Promise.reject(new TransientError('injected blip'));
      }
      return this.inner.getChunk(ref);
    }
    listChunkKeys(ref: Ref): Promise<number[]> {
      return this.inner.listChunkKeys(ref);
    }
  }

  const sleepsFor = async (retry: Record<string, unknown>): Promise<number[]> => {
    const inner = new MemoryStorageChunkSource();
    inner.seed({ segment: 's', chunkKey: 0 }, SafeBitmap.fromValues([42]).serialize());
    const clock = recordingClock();
    const store = new CloudRoaring({
      storage: new FlakyOnce(inner, 2),
      retry: retry as { maxAttempts?: number },
      // `next: () => 1` under full jitter makes the wait exactly the computed delay, so the schedule is exact.
      seams: { clock, rng: { next: () => 1 } },
    });
    expect(await store.segment('s').has(42)).toBe(true);
    return clock.sleeps;
  };

  it('an empty partial is exactly the default schedule', async () => {
    expect(await sleepsFor({})).toEqual([50, 100]);
  });

  it('one override keeps the other four defaults', async () => {
    expect(await sleepsFor({ baseDelayMs: 7 })).toEqual([7, 14]);
  });

  // The regression. Each of these produced NaN delays — a ~1 ms hot loop — under a plain spread.
  it.each(['baseDelayMs', 'maxDelayMs', 'backoffFactor', 'maxAttempts', 'jitter'])(
    'an explicitly-undefined `%s` falls back to the default rather than erasing it',
    async (field) => {
      expect(await sleepsFor({ [field]: undefined })).toEqual([50, 100]);
    },
  );
});

describe('a nullish options bag is a typed error, not a TypeError', () => {
  // The constructor reads `options.seams?.clock` before anything validates the bag, so without this guard
  // `new CloudRoaring(null)` threw a raw `TypeError: Cannot read properties of null (reading 'seams')`.
  it.each([null, undefined, 42, 'storage'])('rejects %p with a ValidationError', (bad) => {
    expect(() => new CloudRoaring(bad as unknown as { storage: MemoryStorage })).toThrow(
      ValidationError,
    );
  });
});
