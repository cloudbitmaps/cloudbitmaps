import { eraseIdFromSegment } from '@/core/erase-id';
import { destroySegment } from '@/core/erasure';
import { WriteConflictError } from '@/core/errors';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { MIN_EXPIRES_AT_MS, SWEEP_MARK } from '@/core/retention';
import { retireExpired } from '@/core/retention-sweep';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IAuditSink, SegmentRef } from '@/index';
import type { IRegistryDriver, IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';

/**
 * A collection pass under a tombstone is held to the row incarnation its caller read. The name is purged and loaded
 * again while the pass is between its caller's read and its own first read of the row, so the row it then reads is
 * another segment wearing the same name: its generations are not the ones the caller searched, and they stay.
 */
const SEG: SegmentRef = { segment: 's' };
const X = 42;
const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;

async function generationsOf(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/**
 * A registry that runs `then` once, just before its first `get` that follows the storage call `after` was first seen
 * on: the interleaving is placed at a call both runs reach, not at a count of reads.
 */
function interleave(
  w: { storage: IStorageDriver; registry: IRegistryDriver },
  after: 'getTail' | 'list',
  then: () => Promise<void>,
): { storage: IStorageDriver; registry: IRegistryDriver } {
  let armed = false;
  let ran = false;
  const storage = Object.create(w.storage) as IStorageDriver;
  const hooked = storage[after].bind(w.storage) as (...a: unknown[]) => unknown;
  (storage as unknown as Record<string, unknown>)[after] = (...a: unknown[]) => {
    armed = true;
    return hooked(...a);
  };
  const registry = Object.create(w.registry) as IRegistryDriver;
  registry.get = async (ref) => {
    if (armed && !ran) {
      ran = true;
      await then();
    }
    return w.registry.get(ref);
  };
  return { storage, registry };
}

describe('a collection under a tombstone is held to the incarnation its caller read', () => {
  it('an erasure whose tombstone is purged and loaded again before its collection reads the row refuses, and the new row keeps its generations', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, X], { registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1], { registry });
    await destroySegment(SEG, { registry }, { confirmSegment: 's', allowCleartext: true });
    expect(await generationsOf(storage)).toEqual([0, 1]);

    const kinds: string[] = [];
    const audit: IAuditSink = { onEvent: (e) => void kinds.push(e.kind) };
    const racing = interleave({ storage, registry }, 'getTail', async () => {
      // A purge (the retention sweep's, here by hand), then two loads that create the name again.
      await gcOrphanGenerations(SEG, deps);
      await registry.delete(SEG);
      await loadSegment(SEG, [5], deps, { keep: 1 });
      await loadSegment(SEG, [6], deps, { keep: 1 });
    });

    await expect(
      eraseIdFromSegment(SEG, X, { ...deps, ...racing }, { audit }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await generationsOf(storage)).toEqual([0, 1]);
    expect((await registry.get(SEG))?.status).toBe('active');
    expect(kinds).not.toContain('segment.collect');
  });

  it('a retention sweep whose tombstone was purged and loaded again before its collection reads the row leaves the new row alone and reports a lost race', async () => {
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    // A tombstone this sweep stamped two days ago, past its grace, with objects still under it.
    await registry.create(SEG, {
      currentGen: null,
      status: 'destroyed',
      retention: { expiresAt: T0 - 3 * DAY, [SWEEP_MARK]: T0 - 2 * DAY },
    });
    for (const g of [0, 1]) {
      await storage.putImmutable({ ...SEG, generation: g }, (sink) =>
        sink.write(new Uint8Array([1])),
      );
    }

    const racing = interleave({ storage, registry }, 'list', async () => {
      // Another sweep purges the tombstone (its objects, then its row), then three loads keep a window of three.
      await retireExpired({ storage, registry }, { now: T0 });
      expect(await registry.get(SEG)).toBeNull();
      for (const ids of [[5], [6], [7]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    });
    const res = await retireExpired(racing, { now: T0 });

    expect(await generationsOf(storage)).toEqual([0, 1, 2]);
    expect((await registry.get(SEG))?.status).toBe('active');
    expect(res.entries).toEqual([
      { segment: 's', action: 'skipped', reason: 'tombstone-not-empty' },
    ]);
    expect(res.purgeFaults).toBe(0);
  });

  it('a pass on an active row refuses when the row is replaced while it lists, and deletes nothing', async () => {
    let t = 1_000;
    const registry = new MemoryRegistryDriver({ now: () => (t += 1) });
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    const listing = Object.create(storage) as IStorageDriver;
    listing.list = async function* (ref) {
      // The row is purged and made again between the pass's first read and its re-read.
      await registry.delete(SEG);
      await registry.create(SEG, { currentGen: 2 });
      yield* storage.list(ref);
    };
    await expect(
      gcOrphanGenerations(SEG, { ...deps, storage: listing }, { keep: 0, incarnation: asked }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await generationsOf(storage)).toEqual([0, 1, 2]);
  });

  it('a pass asked for a row that is already replaced refuses before it lists the bucket', async () => {
    let t = 1_000;
    const registry = new MemoryRegistryDriver({ now: () => (t += 1) });
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    await registry.delete(SEG);
    await registry.create(SEG, { currentGen: 1 });
    let listed = 0;
    const counting = Object.create(storage) as IStorageDriver;
    counting.list = (ref) => {
      listed += 1;
      return storage.list(ref);
    };
    await expect(
      gcOrphanGenerations(SEG, { ...deps, storage: counting }, { keep: 0, incarnation: asked }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(listed).toBe(0);
    expect(await generationsOf(storage)).toEqual([0, 1]);
  });
});
