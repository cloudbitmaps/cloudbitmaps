import { describe, expect, it } from 'vitest';
import { retireExpired } from '@/core/retention-sweep';
import { MIN_EXPIRES_AT_MS, SWEEP_MARK } from '@/core/retention';
import { WriteConflictError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;

/** A tombstone this sweep wrote two days ago, past its grace, with generation objects still under it. */
async function staleTombstone(
  registry: MemoryRegistryDriver,
  storage: IStorageDriver,
  ref: SegmentRef,
) {
  await registry.create(ref, {
    currentGen: null,
    status: 'destroyed',
    retention: { expiresAt: T0 - 3 * DAY, [SWEEP_MARK]: T0 - 2 * DAY },
  });
  await storage.putImmutable({ ...ref, generation: 0 }, (sink) => sink.write(new Uint8Array([1])));
}

async function objects(storage: IStorageDriver, ref: SegmentRef): Promise<number[]> {
  const out: number[] = [];
  for await (const key of storage.list(ref)) out.push(key.generation);
  return out;
}

describe('retireExpired — a tombstone whose objects remain', () => {
  it('under dryRun collects nothing and counts no refusal', async () => {
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    await staleTombstone(registry, storage, { segment: 't' });
    const res = await retireExpired({ registry, storage }, { now: T0, dryRun: true });
    expect(await objects(storage, { segment: 't' })).toEqual([0]);
    expect(res.entries).toEqual([
      { segment: 't', action: 'skipped', reason: 'tombstone-not-empty' },
    ]);
    expect(res.purgeFaults).toBe(0);
  });

  it('charges a collection that lost a race, and does not count it as a refusal', async () => {
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const base = new MemoryStorageDriver();
    for (const segment of ['t1', 't2']) await staleTombstone(registry, base, { segment });
    const storage: IStorageDriver = {
      capabilities: () => base.capabilities(),
      putImmutable: (k, fn) => base.putImmutable(k, fn),
      getRange: (k, o, l) => base.getRange(k, o, l),
      getTail: (k, m) => base.getTail(k, m),
      delete: (k, o) =>
        k.segment === 't1' ? Promise.reject(new WriteConflictError('raced')) : base.delete(k, o),
      list: (ref) => base.list(ref),
    };
    const res = await retireExpired({ registry, storage }, { now: T0, limit: 1 });
    expect(res.entries).toEqual([
      { segment: 't1', action: 'skipped', reason: 'tombstone-not-empty' },
    ]);
    expect(res).toMatchObject({ purgeFaults: 0, limited: true, tombstonesPurged: 0 });
  });
});

describe('retireExpired — the budget and the stop', () => {
  async function expired(registry: MemoryRegistryDriver, storage: IStorageDriver, segment: string) {
    await registry.create({ segment }, { currentGen: 0, retention: { expiresAt: T0 - DAY } });
    await storage.putImmutable({ segment, generation: 0 }, (sink) =>
      sink.write(new Uint8Array([1])),
    );
  }

  it('gives the charge back when the drop finds the policy extended after the re-read', async () => {
    const base = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    for (const segment of ['a', 'b', 'c']) await expired(base, storage, segment);
    let readsOfA = 0;
    const registry: IRegistryDriver = {
      capabilities: () => base.capabilities(),
      get: async (ref) => {
        if (ref.segment === 'a' && ++readsOfA === 2) {
          // the drop's own read: an operator extends the policy between the sweep's re-read and the drop
          const row = (await base.get(ref))!;
          await base.compareAndSwap(ref, row.token, { retention: { expiresAt: T0 + DAY } });
        }
        return base.get(ref);
      },
      create: (ref, rec) => base.create(ref, rec),
      compareAndSwap: (ref, token, patch) => base.compareAndSwap(ref, token, patch),
      list: (namespace) => base.list(namespace),
      delete: (ref, token) => base.delete(ref, token),
    };
    const res = await retireExpired({ registry, storage }, { now: T0, limit: 2 });
    expect(res.entries.map((e) => [e.segment, e.action])).toEqual([
      ['a', 'skipped'],
      ['b', 'retired'],
      ['c', 'retired'],
    ]);
    expect(res).toMatchObject({ retired: 2, limited: false });
  });

  it('stops reading at the first row the limit defers', async () => {
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    for (const segment of ['a', 'b', 'c', 'd']) await expired(registry, storage, segment);
    const res = await retireExpired({ registry, storage }, { now: T0, limit: 1 });
    expect(res).toMatchObject({ retired: 1, eligible: 2, limited: true });
  });

  it('leaves no row and no pointer behind for an empty segment it retired', async () => {
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    await registry.create(
      { segment: 'typo' },
      { currentGen: null, retention: { expiresAt: T0 - DAY } },
    );
    const res = await retireExpired({ registry, storage }, { now: T0 });
    expect(res.retired).toBe(1);
    const left: string[] = [];
    for await (const row of registry.list()) left.push(`${row.namespace ?? ''}/${row.segment}`);
    expect(left).toEqual([]);
  });
});
