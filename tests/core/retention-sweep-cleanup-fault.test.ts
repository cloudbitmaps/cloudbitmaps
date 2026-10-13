import { describe, expect, it } from 'vitest';
import { retireExpired } from '@/core/retention-sweep';
import { MIN_EXPIRES_AT_MS } from '@/core/retention';
import type { IRegistryDriver } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;

/**
 * A retirement is recorded before the cleanup that follows it, so a fault the cleanup lets through cannot take the
 * `retired` entry out of the ledger. Here the empty segment's row delete throws synchronously (a driver method that is
 * not `async`), and the read that would settle which side of the tombstone the fault fell on fails too.
 */
describe('retireExpired — a fault after the retirement', () => {
  it('keeps the retired entry when the cleanup throws', async () => {
    const base = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    await base.create(
      { segment: 'empty' },
      { currentGen: null, retention: { expiresAt: T0 - DAY } },
    );
    let reads = 0;
    const registry: IRegistryDriver = {
      capabilities: () => base.capabilities(),
      get: (ref) =>
        ref.segment === 'empty' && ++reads >= 4
          ? Promise.reject(new Error('Service Unavailable'))
          : base.get(ref),
      create: (ref, rec) => base.create(ref, rec),
      compareAndSwap: (ref, token, patch) => base.compareAndSwap(ref, token, patch),
      list: (namespace) => base.list(namespace),
      delete: (ref, token) => {
        if (ref.segment === 'empty' && ref.namespace === undefined)
          throw new Error('Access Denied');
        return base.delete(ref, token);
      },
    };
    const res = await retireExpired({ registry, storage }, { now: T0 });
    expect((await base.get({ segment: 'empty' }))?.status).toBe('destroyed');
    expect(res.retired).toBe(1);
    expect(res.entries.filter((e) => e.action === 'retired').map((e) => e.segment)).toEqual([
      'empty',
    ]);
  });
});
