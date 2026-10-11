import { resolveBudget } from '@/core/budget';
import { boundedAll, mapWithConcurrency } from '@/core/concurrency';
import { dueBucketsAt } from '@/core/due-index';
import { ValidationError } from '@/core/errors';
import { BoundedLru } from '@/core/lru';
import { drainRegistry } from '@/core/registry-scan';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';

/**
 * Each option the core validates goes through one number check, so a bad value is refused by name in one wording
 * (`<what> must be an integer of at least 1; got <value>`), and `retry.*`, `retireExpired` and the `keep` checks are
 * held in their own tests. This holds the rest, one refusal each.
 */
const clock = { now: (): number => 0 };

describe('number checks across the core share one wording', () => {
  it('concurrency limit', async () => {
    const wording = 'concurrency limit must be an integer of at least 1; got ';
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(`${wording}0`);
    await expect(boundedAll([1], 1.5, async (n) => n)).rejects.toThrow(`${wording}1.5`);
    await expect(boundedAll([1], 2 ** 53, async (n) => n)).rejects.toThrow(ValidationError);
  });

  it('budget.maxRequests', () => {
    expect(() => resolveBudget({ maxRequests: 0 }, { maxRequests: 10 })).toThrow(
      'budget.maxRequests must be an integer of at least 1; got 0',
    );
    expect(() => resolveBudget({ maxRequests: Infinity }, { maxRequests: 10 })).toThrow(
      ValidationError,
    );
  });

  it('lookbackBuckets', () => {
    expect(() => dueBucketsAt(1, -1)).toThrow(
      'due index: lookbackBuckets must be an integer of at least 0; got -1',
    );
  });

  it('maxScanSegments, a whole number', async () => {
    const registry = new MemoryRegistryDriver();
    await expect(
      drainRegistry(registry, { maxScanSegments: 1.5, op: 'checkConsistency' }),
    ).rejects.toThrow(
      'checkConsistency: maxScanSegments must be an integer of at least 1; got 1.5',
    );
  });

  it('LRU maxEntries and weights', () => {
    expect(() => new BoundedLru<string, number>({ maxEntries: 0, clock })).toThrow(
      'maxEntries must be an integer of at least 1; got 0',
    );
    const lru = new BoundedLru<string, number>({ maxEntries: 2, clock });
    lru.set('a', 1);
    expect(() => lru.setWeight('a', -1)).toThrow(
      'weight must be a finite number of at least 0; got -1',
    );
    expect(() => lru.setWeight('a', NaN)).toThrow('weight must be a finite number');
  });

  it('a read range on the memory driver', async () => {
    const storage = new MemoryStorageDriver();
    const key = { segment: 's', generation: 0 } as never;
    await expect(storage.getRange(key, -1, 1)).rejects.toThrow(
      'range offset must be an integer of at least 0; got -1',
    );
    await expect(storage.getRange(key, 0, 1.5)).rejects.toThrow(
      'range length must be an integer of at least 0; got 1.5',
    );
  });

  it('a rollback target', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    await expect(store.rollback({ segment: 'a' }, -1)).rejects.toThrow(
      'rollback: generation must be an integer of at least 0; got -1',
    );
  });
});
