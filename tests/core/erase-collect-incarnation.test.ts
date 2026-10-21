import { eraseIdFromSegment } from '@/core/erase-id';
import { destroySegment } from '@/core/erasure';
import { ValidationError, WriteConflictError } from '@/core/errors';
import { collectBelowPointer, gcOrphanGenerations, listingPass } from '@/core/generation-gc';
import { loadSegment } from '@/core/load';
import { MIN_EXPIRES_AT_MS, SWEEP_MARK } from '@/core/retention';
import { retireExpired } from '@/core/retention-sweep';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import type { IAuditSink, SegmentRef } from '@/index';
import type { IRegistryDriver, IStorageDriver } from '@cloudbitmaps/core/driver-kit';
import { roaringCodec } from '@/native-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { testEntropy } from '../helpers/entropy';

/**
 * A collection pass under a tombstone is held to the row incarnation its caller read. The name is purged and loaded
 * again while the pass is between its caller's read and its own first read of the row, so the row it then reads is
 * another segment wearing the same name: its generations are not the ones the caller searched, and they stay.
 */
const SEG: SegmentRef = { segment: 's' };
const X = 42;
const REFUSED_OTHER_ROW = /is not the row this collection works from/;
const DAY = 86_400_000;
const T0 = MIN_EXPIRES_AT_MS + 700 * DAY;

async function generationsOf(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/**
 * Tombstones this sweep wrote two days ago, past their grace, with their objects still under them: each name is a live
 * row with an expired policy and two generations, and a first sweep retires it while the store refuses every delete, so
 * the sweep's own drop writes the tombstone and its mark and the objects stay.
 */
async function stampedTombstones(
  registry: MemoryRegistryDriver,
  storage: MemoryStorageDriver,
  segments: readonly string[],
): Promise<void> {
  const refusing = Object.create(storage) as IStorageDriver;
  refusing.delete = () => Promise.reject(new Error('delete refused'));
  for (const segment of segments) {
    await registry.create({ segment }, { currentGen: 1, retention: { expiresAt: T0 - 3 * DAY } });
    for (const g of [0, 1]) {
      await storage.putImmutable({ segment, generation: g }, (sink) =>
        sink.write(new Uint8Array([1])),
      );
    }
  }
  await retireExpired({ storage: refusing, registry }, { now: T0 - 2 * DAY });
  for (const segment of segments) {
    const row = await registry.get({ segment });
    expect(row?.status).toBe('destroyed');
    expect(row?.retention?.[SWEEP_MARK]).toBe(T0 - 2 * DAY);
  }
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
    await stampedTombstones(registry, storage, ['s']);

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

  it('a pass with nothing to delete still refuses a row replaced while it lists', async () => {
    let t = 1_000;
    const registry = new MemoryRegistryDriver({ now: () => (t += 1) });
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    const listing = Object.create(storage) as IStorageDriver;
    listing.list = async function* (ref) {
      await registry.delete(SEG);
      await registry.create(SEG, { currentGen: 2 });
      yield* storage.list(ref);
    };
    await expect(
      gcOrphanGenerations(SEG, { ...deps, storage: listing }, { keep: 3, incarnation: asked }),
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

  it('on a registry whose tokens carry no incarnation id and whose rows share a creation stamp, an erasure still refuses a re-created row', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, X], { registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1], { registry });
    await destroySegment(SEG, { registry }, { confirmSegment: 's', allowCleartext: true });

    // The rows as a registry of someone else's would give them: an opaque token, and one creation stamp for every row.
    const tokenless = Object.create(registry) as IRegistryDriver;
    tokenless.get = async (ref) => {
      const row = await registry.get(ref);
      return row === null
        ? null
        : {
            ...row,
            token: `opaque:${row.token}`,
            pointerId: `opaque:${row.pointerId}`,
            createdAt: 0,
          };
    };
    const kinds: string[] = [];
    const audit: IAuditSink = { onEvent: (e) => void kinds.push(e.kind) };
    const racing = interleave({ storage, registry: tokenless }, 'getTail', async () => {
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

  it('a pass on an active row refuses when the row is replaced after its re-read and before a delete, and deletes nothing', async () => {
    let t = 1_000;
    const registry = new MemoryRegistryDriver({ now: () => (t += 1) });
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    // Reads: the first, the re-read after the listing, then the re-proof before the first delete. The new row's pointer
    // is the old one, so the pointer rule alone would let the pass go on.
    let reads = 0;
    const replacing = Object.create(registry) as IRegistryDriver;
    replacing.get = async (ref) => {
      reads += 1;
      if (reads === 3) {
        await registry.delete(SEG);
        await registry.create(SEG, { currentGen: asked.currentGen });
      }
      return registry.get(ref);
    };
    const err = await gcOrphanGenerations(
      SEG,
      { ...deps, registry: replacing },
      { keep: 0, incarnation: asked },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    // The same words as a row replaced at the first read or the re-read.
    expect((err as Error).message).toMatch(REFUSED_OTHER_ROW);
    expect(reads).toBe(3);
    expect(await generationsOf(storage)).toEqual([0, 1, 2]);
  });

  it('a pass on an active row refuses a row replaced at a later re-proof, not only the first, and keeps what it has not yet deleted', async () => {
    let t = 1_000;
    const registry = new MemoryRegistryDriver({ now: () => (t += 1) });
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    // Reads: the first, the re-read, the re-proof before generation 1, then the re-proof before generation 0.
    let reads = 0;
    const replacing = Object.create(registry) as IRegistryDriver;
    replacing.get = async (ref) => {
      reads += 1;
      if (reads === 4) {
        await registry.delete(SEG);
        await registry.create(SEG, { currentGen: asked.currentGen });
      }
      return registry.get(ref);
    };
    const err = await gcOrphanGenerations(
      SEG,
      { ...deps, registry: replacing },
      { keep: 0, incarnation: asked },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    // The same words as a row replaced at the first read or the re-read.
    expect((err as Error).message).toMatch(REFUSED_OTHER_ROW);
    expect(reads).toBe(4);
    expect(await generationsOf(storage)).toEqual([0, 2]);
  });

  it('a pass asked for an active row refuses the row once it is a tombstone, before it lists or deletes', async () => {
    const registry = new MemoryRegistryDriver();
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    await destroySegment(SEG, { registry }, { confirmSegment: 's', allowCleartext: true });
    expect((await registry.get(SEG))?.status).toBe('destroyed');
    const err = await gcOrphanGenerations(SEG, deps, { keep: 0, incarnation: asked }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WriteConflictError);
    expect((err as Error).message).toMatch(REFUSED_OTHER_ROW);
    expect(await generationsOf(storage)).toEqual([0, 1, 2]);
  });

  it('a pass given an incarnation resolves empty when the row is already gone at its first read', async () => {
    const registry = new MemoryRegistryDriver();
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const asked = (await registry.get(SEG))!;
    await registry.delete(SEG);
    expect(await gcOrphanGenerations(SEG, deps, { keep: 0, incarnation: asked })).toEqual([]);
    expect(await generationsOf(storage)).toEqual([0, 1]);
  });

  it('collectBelowPointer passes skipKnown on: a name the row knows is spared and reported', async () => {
    const registry = new MemoryRegistryDriver();
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    for (const ids of [[1], [2], [3]]) await loadSegment(SEG, ids, deps, { keep: 3 });
    const res = await collectBelowPointer(SEG, deps, { keep: 0, skipKnown: true });
    expect(res.deleted).toEqual([]);
    expect([...(res.knownSpared ?? [])].sort()).toEqual([0, 1]);
    expect(await generationsOf(storage)).toEqual([0, 1, 2]);
  });

  it('a quiet pass given an incarnation is refused before it reads anything', async () => {
    const registry = new MemoryRegistryDriver();
    const storage = new MemoryStorageDriver();
    const deps = { storage, registry, codec: roaringCodec, entropy: testEntropy };
    await loadSegment(SEG, [1], deps, { keep: 1 });
    const asked = (await registry.get(SEG))!;
    let reads = 0;
    const counting = Object.create(registry) as IRegistryDriver;
    counting.get = (ref) => {
      reads += 1;
      return registry.get(ref);
    };
    await expect(
      listingPass(SEG, { ...deps, registry: counting }, { quiet: true, incarnation: asked }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(reads).toBe(0);
  });
});

describe('the retention sweep counts a collection that lost a race as a lost race', () => {
  it('four tombstones purged and created again mid-pass do not stop it purging the healthy one behind them', async () => {
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const storage = new MemoryStorageDriver();
    const raced = ['a1', 'a2', 'a3', 'a4'];
    await stampedTombstones(registry, storage, [...raced, 'z']);

    const armed = new Set<string>();
    const done = new Set<string>();
    const racingStorage = Object.create(storage) as IStorageDriver;
    racingStorage.list = (ref) => {
      if (ref.segment !== undefined && raced.includes(ref.segment)) armed.add(ref.segment);
      return storage.list(ref);
    };
    const racingRegistry = Object.create(registry) as IRegistryDriver;
    racingRegistry.get = async (ref) => {
      if (armed.has(ref.segment) && !done.has(ref.segment)) {
        done.add(ref.segment);
        // The tombstone is purged and its name made again, with its objects still in the bucket.
        await registry.delete(ref);
        await registry.create(ref, { currentGen: 0 });
      }
      return registry.get(ref);
    };
    const res = await retireExpired(
      { storage: racingStorage, registry: racingRegistry },
      { now: T0 },
    );

    expect(res.entries).toEqual([
      ...raced.map((segment) => ({ segment, action: 'skipped', reason: 'tombstone-not-empty' })),
      { segment: 'z', action: 'purged-tombstone' },
    ]);
    expect(res).toMatchObject({ purgeFaults: 0, tombstonesPurged: 1 });
    expect(await registry.get({ segment: 'z' })).toBeNull();
    for (const segment of raced) expect((await registry.get({ segment }))?.status).toBe('active');
  });
});
