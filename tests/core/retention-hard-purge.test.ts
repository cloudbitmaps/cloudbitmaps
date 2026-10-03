/**
 * The retention sweep's purge, on a registry that removes a row for good.
 *
 * A namespace that churns short-lived segments must not pay, on every full sweep, one read for every row it has ever
 * had. So once a retired segment's tombstone has aged past its grace and its storage is gone, the purge removes the
 * row from the store, by a delete the store applies only while the row is still the version the purge read. The due
 * index carries a pointer for the purge, filed under the day the grace ends, so a sweep that reads only the index
 * purges too.
 *
 * These run the real sweep over `ObjectStoreRegistry` on a store that counts its requests and fences its writes and
 * deletes for real, so a request count here is the count a cloud store would bill.
 */
import { describe, expect, it } from 'vitest';
import { retireExpired, DEFAULT_LOOKBACK_BUCKETS } from '@/core/retention-sweep';
import { setSegmentRetention } from '@/core/retention';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { publishGeneration } from '@/core/crbm-storage-source';
import { loadSegment } from '@/core/load';
import { dueBucket, dueBucketsAt, dueIndexRef, dueNamespace } from '@/core/due-index';
import { TransientError, UnsupportedError, WriteConflictError } from '@/core/errors';
import type { IStorageDriver, RegistryRecord, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { segmentKey, shardOf } from '@/core/keys';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { registryListPrefix, registryObjectKey } from '@/drivers/_shared/object-registry-keys';
import { MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { CloudRoaring } from '@/index';
import { CountingObjectStore } from '../helpers/counting';
import { readAs011 } from '../helpers/release-0-11';
import { tokenParts } from '../helpers/tokens';

const DAY = 86_400_000;
const T0 = 1_790_000_000_000;
/** The consumer's numbers: a 72 h retention, and a 14-day grace before a tombstone is purged. */
const RETENTION = 3 * DAY;
const GRACE = 14 * DAY;

/** A registry over a counting store, storage in memory, and a clock the test moves. */
function world(options: { conditionalDelete?: boolean } = {}) {
  const store = new CountingObjectStore(0, {
    conditionalDelete: options.conditionalDelete ?? true,
  });
  let t = T0;
  const registry = new ObjectStoreRegistry(store, undefined, () => t);
  const storage = new MemoryStorageDriver();
  return {
    store,
    registry,
    storage,
    deps: { registry, storage },
    now: (): number => t,
    advance: (ms: number): number => (t += ms),
  };
}
type World = ReturnType<typeof world>;

/** A segment with one generation in storage and a retention policy: what `setRetention` and a load leave behind. */
async function seed(w: World, ref: SegmentRef, expiresAt?: number): Promise<void> {
  if (expiresAt !== undefined) {
    await setSegmentRetention(ref, { registry: w.registry }, { expiresAt });
  } else {
    await w.registry.create(ref, { currentGen: null });
  }
  await w.storage.putImmutable({ ...ref, generation: 0 }, (sink) =>
    sink.write(new Uint8Array([1])),
  );
  const row = await w.registry.get(ref);
  await w.registry.compareAndSwap(ref, row!.token, { currentGen: 0 });
}

/** The registry reads (GETs) one call makes. */
async function readsOf<T>(w: World, call: () => Promise<T>): Promise<{ reads: number; result: T }> {
  const before = w.store.reads;
  const result = await call();
  return { reads: w.store.reads - before, result };
}

/** The objects the store holds under the registry prefix: rows, tombstones and due pointers alike. */
const registryObjects = (w: World): number => w.store.size(registryListPrefix(undefined));

/** The pointers a due bucket holds, as a 0.12 listing yields them. */
async function bucketRows(w: World, bucket: number): Promise<RegistryRecord[]> {
  const rows: RegistryRecord[] = [];
  for await (const row of w.registry.list(dueNamespace(bucket))) rows.push(row);
  return rows;
}

describe('the done-when: a full sweep costs what is live and in its grace, not what was ever retired', () => {
  it('after 10,000 segments are created, retired and purged, a full sweep reads only the live row', async () => {
    const N = 10_000;
    const w = world();
    const ns = 'sends';
    for (let i = 0; i < N; i++)
      await seed(w, { namespace: ns, segment: `copy-${i}` }, T0 + RETENTION);
    await seed(w, { namespace: ns, segment: 'live' }); // no policy: stays

    w.advance(RETENTION + 1);
    const retired = await retireExpired(w.deps, {
      namespace: ns,
      now: w.now(),
      limit: N + 1,
      tombstoneGraceMs: GRACE,
    });
    expect(retired.retired).toBe(N);

    // Mid-grace, the tombstones are still rows, and a sweep reads each: proportional to the grace-period rows.
    w.advance(7 * DAY);
    const midGrace = await readsOf(w, () =>
      retireExpired(w.deps, { namespace: ns, now: w.now(), tombstoneGraceMs: GRACE }),
    );
    expect(midGrace.result.scanned).toBe(N + 1);
    expect(midGrace.reads).toBe(N + 1);

    w.advance(7 * DAY);
    const purged = await retireExpired(w.deps, {
      namespace: ns,
      now: w.now(),
      limit: N + 1,
      tombstoneGraceMs: GRACE,
    });
    expect(purged.tombstonesPurged).toBe(N);
    // Nothing of them is left in the store: no tombstone, no expiry pointer, no purge pointer.
    expect(registryObjects(w)).toBe(1);

    const scoped = await readsOf(w, () =>
      retireExpired(w.deps, { namespace: ns, now: w.now(), tombstoneGraceMs: GRACE }),
    );
    expect(scoped.result.scanned).toBe(1);
    expect(scoped.reads).toBe(1);

    const listsBefore = w.store.lists;
    const unscoped = await readsOf(w, () =>
      retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE }),
    );
    expect(unscoped.result.scanned).toBe(1);
    expect(unscoped.reads).toBe(1);
    expect(w.store.lists - listsBefore).toBe(1);
  }, 120_000);

  it('the same churn behind a store that vouches for no conditional delete still reads every tombstone', async () => {
    const N = 200;
    const w = world({ conditionalDelete: false });
    for (let i = 0; i < N; i++)
      await seed(w, { namespace: 'sends', segment: `copy-${i}` }, T0 + RETENTION);
    await seed(w, { namespace: 'sends', segment: 'live' });
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), limit: N + 1, tombstoneGraceMs: GRACE });
    w.advance(GRACE + 1);
    const purged = await retireExpired(w.deps, {
      now: w.now(),
      limit: N + 1,
      tombstoneGraceMs: GRACE,
    });
    // The ledger is the same; what is left behind is not.
    expect(purged.tombstonesPurged).toBe(N);
    expect(w.store.deletes).toBe(0);
    const scoped = await readsOf(w, () =>
      retireExpired(w.deps, { namespace: 'sends', now: w.now(), tombstoneGraceMs: GRACE }),
    );
    expect(scoped.result.scanned).toBe(1);
    expect(scoped.reads).toBe(N + 1); // every tombstone read again, on every sweep
  }, 60_000);
});

describe('an index-only deployment purges too', () => {
  it('retires by index, then purges by index on the purge day, and leaves the buckets empty', async () => {
    const N = 2_000;
    const w = world();
    for (let i = 0; i < N; i++)
      await seed(w, { namespace: 'sends', segment: `copy-${i}` }, T0 + RETENTION);
    w.advance(RETENTION + 1);
    const retired = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      limit: N,
      tombstoneGraceMs: GRACE,
    });
    expect(retired.retired).toBe(N);
    const purgeDay = dueBucket(w.now() + GRACE);
    expect(await bucketRows(w, purgeDay)).toHaveLength(N);

    w.advance(GRACE + 1);
    const purged = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      limit: N,
      tombstoneGraceMs: GRACE,
    });
    expect(purged.tombstonesPurged).toBe(N);
    for (const bucket of dueBucketsAt(w.now(), 30)) expect(await bucketRows(w, bucket)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
  }, 60_000);
});

describe('the purge keeps what is inside its grace', () => {
  it.each(['fleet', 'index'] as const)(
    '%s scan: keeps a tombstone until its grace has passed, then removes it',
    async (scan) => {
      const w = world();
      const ref = { namespace: 'n', segment: 'day' };
      await seed(w, ref, T0 + RETENTION);
      w.advance(RETENTION + 1);
      await retireExpired(w.deps, { scan, now: w.now(), tombstoneGraceMs: GRACE });
      const stamp = w.now();

      w.advance(GRACE - 1);
      const early = await retireExpired(w.deps, { scan, now: w.now(), tombstoneGraceMs: GRACE });
      expect(early.tombstonesPurged).toBe(0);
      expect(early.entries).toEqual([]);
      expect(w.store.text(registryObjectKey(undefined, ref))).toBeDefined();

      w.advance(1); // exactly the grace: due
      expect(w.now() - stamp).toBe(GRACE);
      const due = await retireExpired(w.deps, { scan, now: w.now(), tombstoneGraceMs: GRACE });
      expect(due.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
      expect(w.store.text(registryObjectKey(undefined, ref))).toBeUndefined();
    },
  );

  it('removes the generation objects before the row, and keeps the row while storage holds one', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    // A load that was writing when the tombstone landed finished its object after the drop's sweep.
    await w.storage.putImmutable({ ...ref, generation: 1 }, (sink) =>
      sink.write(new Uint8Array([2])),
    );

    const order: string[] = [];
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      putImmutable: (k, f) => w.storage.putImmutable(k, f),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      list: (r) => w.storage.list(r),
      delete: async (k) => {
        order.push(`storage ${k.generation}`);
        await w.storage.delete(k);
      },
    };
    w.store.beforeDelete = async () => {
      order.push('row');
    };
    w.advance(GRACE);
    const res = await retireExpired(
      { registry: w.registry, storage },
      {
        now: w.now(),
        tombstoneGraceMs: GRACE,
      },
    );
    expect(res.tombstonesPurged).toBe(1);
    expect(order).toEqual(['storage 1', 'row']);
  });
});

describe('only a row born with an incarnation id is removed', () => {
  /** A `destroyed` row as 0.11 retired one: schema 1, a decimal token, stamped by its sweep long ago. */
  const legacyTombstone = (ref: SegmentRef): string =>
    JSON.stringify({
      schemaVersion: 1,
      deleted: false,
      record: {
        namespace: ref.namespace,
        segment: ref.segment,
        currentGen: 0,
        status: 'destroyed',
        retention: { expiresAt: T0 - 30 * DAY, retiredBySweepAt: T0 - 20 * DAY },
        createdAt: T0 - 40 * DAY,
        updatedAt: T0 - 20 * DAY,
        token: '7',
      },
    });

  it('a tombstone 0.11 left is purged as a tombstone: the object stays, and a full scan still reads it', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'old' };
    const key = registryObjectKey(undefined, ref);
    w.store.plant(key, legacyTombstone(ref));

    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
    expect(w.store.deletes).toBe(0);
    const stored = JSON.parse(w.store.text(key)!) as {
      deleted: boolean;
      record: { token: string };
    };
    expect(stored.deleted).toBe(true);
    expect(stored.record.token).toMatch(/^8\.[0-9a-f]{16}$/); // its own form: no incarnation
    const next = await readsOf(w, () => retireExpired(w.deps, { namespace: 'n', now: w.now() }));
    expect(next.reads).toBe(1); // the envelope, read and skipped
  });

  it('a row 0.11 created and 0.12 has since written is tombstoned too', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'old' };
    const key = registryObjectKey(undefined, ref);
    w.store.plant(key, legacyTombstone(ref).replace('"status":"destroyed"', '"status":"active"'));
    const { token } = await w.registry.compareAndSwap(ref, '7', { status: 'destroyed' });
    expect(token).toMatch(/^8\.[0-9a-f]{16}$/); // still no incarnation
    await w.registry.delete(ref, token);
    expect(w.store.deletes).toBe(0);
    expect(w.store.text(key)).toBeDefined();
  });
});

describe('the gate', () => {
  it('off, the purge tombstones as it did before 0.12, and reports the same ledger entry', async () => {
    const w = world({ conditionalDelete: false });
    expect(w.registry.capabilities().conditionalDelete).toBe(false);
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
    expect(await w.registry.get(ref)).toBeNull();
    const stored = JSON.parse(w.store.text(registryObjectKey(undefined, ref))!) as {
      deleted: boolean;
    };
    expect(stored.deleted).toBe(true);
    expect(w.store.deletes).toBe(0);
    // A name purged as a tombstone carries its counter on into the next incarnation, as before.
    const { token } = await w.registry.create(ref, { currentGen: null });
    expect(tokenParts(token).counter).toBeGreaterThan(0);
  });
});

describe('races and faults: the purge removes only the row it judged', () => {
  /** A retired segment whose tombstone is past its grace, ready to purge. */
  async function due(w: World, ref: SegmentRef): Promise<RegistryRecord> {
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    return (await w.registry.get(ref))!;
  }

  it('a write between its read and its delete fails the delete: the row stays, and the ledger says contended', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const tomb = await due(w, ref);
    const other = new ObjectStoreRegistry(w.store, undefined, w.now);
    let written = '';
    w.store.beforeDelete = async () => {
      written = (await other.compareAndSwap(ref, tomb.token, { residency: { note: 'late' } }))
        .token;
    };
    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.entries).toEqual([{ ...ref, action: 'skipped', reason: 'failed: contended' }]);
    expect(await w.registry.get(ref)).toMatchObject({ token: written, status: 'destroyed' });
    // And the purge pointer is kept, so an index sweep comes back for it.
    const stamp = tomb.retention!.retiredBySweepAt as number;
    expect(await bucketRows(w, dueBucket(stamp + GRACE))).toHaveLength(1);
  });

  it('a re-create racing the purge keeps the new incarnation, its data included', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const tomb = await due(w, ref);
    const other = new ObjectStoreRegistry(w.store, undefined, w.now);
    let reborn = '';
    w.store.beforeDelete = async () => {
      // Another sweeper purges the tombstone first, and the name is loaded anew before this delete lands.
      await other.delete(ref, tomb.token);
      await w.storage.putImmutable({ ...ref, generation: 0 }, (sink) =>
        sink.write(new Uint8Array([9])),
      );
      reborn = (await other.create(ref, { currentGen: 0 })).token;
    };
    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.entries).toEqual([{ ...ref, action: 'skipped', reason: 'failed: contended' }]);
    expect(await w.registry.get(ref)).toMatchObject({
      status: 'active',
      currentGen: 0,
      token: reborn,
    });
    expect(tokenParts(reborn).incarnation).not.toBe(tokenParts(tomb.token).incarnation);
    const left: number[] = [];
    for await (const k of w.storage.list(ref)) left.push(k.generation);
    expect(left).toEqual([0]);
  });

  it('a delete that lands and loses its response is a fault: nothing else is deleted, and the next sweep settles it', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const tomb = await due(w, ref);
    const pointerDay = dueBucket((tomb.retention!.retiredBySweepAt as number) + GRACE);
    w.store.landThenFailDelete = new TransientError('connection reset after the delete');
    const first = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(first.entries).toEqual([
      { ...ref, action: 'skipped', reason: 'failed: connection reset after the delete' },
    ]);
    // The outcome was not known, so the pointer was left for the next sweep to find.
    expect(await bucketRows(w, pointerDay)).toHaveLength(1);
    const next = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(next.entries).toEqual([]); // the row had gone: the pointer is litter, and is removed
    expect(await bucketRows(w, pointerDay)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
  });

  it('a late fenced publish onto a purged name is refused, whether the name is empty or re-created', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    const stale = (await w.registry.get(ref))!.token; // what a loader read before the segment was retired
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(await w.registry.get(ref)).toBeNull();

    expect(
      await publishGeneration(w.registry, { ...ref, generation: 1 }, { expectToken: stale }),
    ).toBe(false);
    expect(await w.registry.get(ref)).toBeNull();

    const { token: reborn } = await w.registry.create(ref, { currentGen: 0 });
    expect(
      await publishGeneration(w.registry, { ...ref, generation: 1 }, { expectToken: stale }),
    ).toBe(false);
    expect(await w.registry.get(ref)).toMatchObject({ currentGen: 0, token: reborn });
  });

  it('a load whose write straddles a retirement, a purge and a re-create reports superseded and leaves the new segment', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const backend = brandAsBackend({ storage: w.storage, registry: w.registry });
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    await store.load(ref, [1, 2, 3]);
    await store.setRetention(ref, { expiresAt: T0 + RETENTION });

    let straddled = false;
    const slow = brandAsBackend({
      registry: w.registry,
      storage: {
        capabilities: () => w.storage.capabilities(),
        getRange: (k, o, l) => w.storage.getRange(k, o, l),
        getTail: (k, m) => w.storage.getTail(k, m),
        list: (r) => w.storage.list(r),
        delete: (k) => w.storage.delete(k),
        putImmutable: async (k, f) => {
          if (!straddled) {
            straddled = true;
            // While this load writes, the segment expires, is retired, purged, and loaded anew by someone else.
            w.advance(RETENTION + 1);
            await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: 0 });
            await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: 0 });
            expect(await w.registry.get(ref)).toBeNull();
            await store.load(ref, [7]);
          }
          return w.storage.putImmutable(k, f);
        },
      } satisfies IStorageDriver,
    });
    const late = new CloudRoaring({ storage: slow, cache: { genTtlMs: 0 } });
    const result = await late.load(ref, [4, 5, 6]);
    expect(result).toMatchObject({ published: false, reason: 'superseded' });
    const reader = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    const ids: number[] = [];
    for await (const id of reader.segment(ref.segment, { namespace: ref.namespace }).iterate())
      ids.push(id);
    expect(ids).toEqual([7]);
  });

  it('a collection pass over a destroyed segment never takes the new incarnation for the old one', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const tomb = await due(w, ref);
    await w.storage.putImmutable({ ...ref, generation: 3 }, (sink) =>
      sink.write(new Uint8Array([1])),
    );
    const other = new ObjectStoreRegistry(w.store, undefined, w.now);
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      putImmutable: (k, f) => w.storage.putImmutable(k, f),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      delete: (k) => w.storage.delete(k),
      list: (r) =>
        (async function* () {
          // Mid-listing, the tombstone is purged and the name created again with a generation of its own.
          yield* w.storage.list(r);
          await w.storage.delete({ ...ref, generation: 3 });
          await other.delete(ref, tomb.token);
          await w.storage.putImmutable({ ...ref, generation: 0 }, (sink) =>
            sink.write(new Uint8Array([5])),
          );
          await other.create(ref, { currentGen: 0 });
        })(),
    };
    await expect(
      gcOrphanGenerations(ref, { registry: w.registry, storage }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    const left: number[] = [];
    for await (const k of w.storage.list(ref)) left.push(k.generation);
    expect(left).toEqual([0]);
  });
});

describe('the purge pointer in the due index', () => {
  it('a retirement files a pointer under the day its grace ends, and forgets the expiry pointer', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    const expiryDay = dueBucket(T0 + RETENTION);
    expect(await bucketRows(w, expiryDay)).toHaveLength(1);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(await bucketRows(w, expiryDay)).toEqual([]);
    const purgeDay = dueBucket(w.now() + GRACE);
    expect((await bucketRows(w, purgeDay)).map((r) => r.segment)).toEqual([
      dueIndexRef(purgeDay, ref).segment,
    ]);
    // No field records the purge time: the pointer's bucket is the index, and the purge derives it from the stamp.
    const row = await w.registry.get(ref);
    expect(Object.keys(row!.retention!).sort()).toEqual(['expiresAt', 'retiredBySweepAt']);
  });

  it('a fleet purge removes the pointer too', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    const purgeDay = dueBucket(w.now() + GRACE);
    w.advance(GRACE);
    await retireExpired(w.deps, { scan: 'fleet', now: w.now(), tombstoneGraceMs: GRACE });
    expect(await bucketRows(w, purgeDay)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
  });

  it('an index scan inside the grace keeps the pointer, and finds the row again later', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: DAY }); // a pointer due tomorrow
    const purgeDay = dueBucket(w.now() + DAY);
    w.advance(DAY);
    // A sweep with a longer grace than the one that filed the pointer finds it early, and leaves it.
    const longer = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(longer.entries).toEqual([]);
    expect(await bucketRows(w, purgeDay)).toHaveLength(1);
    const same = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: DAY,
    });
    expect(same.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
    expect(await bucketRows(w, purgeDay)).toEqual([]);
  });

  it('a pointer whose row is gone is removed by the next index scan of its bucket', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'gone' };
    const bucket = dueBucket(w.now());
    await w.registry.create(dueIndexRef(bucket, ref), { currentGen: null }); // litter: no row behind it
    const reads = await readsOf(w, () => retireExpired(w.deps, { scan: 'index', now: w.now() }));
    expect(reads.result.entries).toEqual([]);
    expect(await bucketRows(w, bucket)).toEqual([]);
    // Read once: the next scan of the bucket pays nothing for it.
    const again = await readsOf(w, () => retireExpired(w.deps, { scan: 'index', now: w.now() }));
    expect(again.reads).toBe(0);
  });

  it('a pointer a setRetention takes as its own while the sweep runs is kept, though the scan read it as litter', async () => {
    const w = world();
    const reused = { namespace: 'n', segment: 'reused' };
    const expiring = { namespace: 'n', segment: 'expiring' };
    await seed(w, expiring, T0 + RETENTION);
    w.advance(RETENTION + 1);
    const today = dueBucket(w.now());
    await w.registry.create(dueIndexRef(today, reused), { currentGen: null }); // litter from an earlier incarnation
    // While the sweep retires the expiring segment, the reused name is created anew with a policy due today: its
    // pointer write finds the litter already at that key and takes it as its own.
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      putImmutable: (k, f) => w.storage.putImmutable(k, f),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      delete: (k) => w.storage.delete(k),
      list: (r) =>
        (async function* () {
          if ((await w.registry.get(reused)) === null) {
            const set = await setSegmentRetention(
              reused,
              { registry: w.registry },
              { expiresAt: w.now() },
            );
            expect(set.indexed).toBe(true);
          }
          yield* w.storage.list(r);
        })(),
    };
    await retireExpired(
      { registry: w.registry, storage },
      { scan: 'index', now: w.now(), tombstoneGraceMs: GRACE },
    );
    expect((await bucketRows(w, today)).map((r) => r.segment)).toContain(
      dueIndexRef(today, reused).segment,
    );
  });

  it('an index purge removes every pointer it read to the row, pointers left behind included', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    // Two pointers whose removal failed earlier (an interrupted reindex, a failed forget), on days inside the
    // lookback: the scan reads them before the purge pointer, under today.
    const today = dueBucket(w.now());
    for (const day of [today - 2, today - 1]) {
      await w.registry.create(dueIndexRef(day, ref), { currentGen: null });
    }
    const res = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(res.tombstonesPurged).toBe(1);
    for (const day of [today - 2, today - 1, today]) expect(await bucketRows(w, day)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
  });

  it('a dry run files no pointer and removes none, litter included', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    const litter = { namespace: 'n', segment: 'gone' };
    const today = dueBucket(T0 + RETENTION + 1);
    await w.registry.create(dueIndexRef(today, litter), { currentGen: null });
    w.advance(RETENTION + 1);
    const before = registryObjects(w);
    await retireExpired(w.deps, {
      scan: 'index',
      dryRun: true,
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(registryObjects(w)).toBe(before);
  });

  it('with purgeTombstones off, the pointer is still filed, and a later sweep with purging on uses it', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), purgeTombstones: false, tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    const kept = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      purgeTombstones: false,
      tombstoneGraceMs: GRACE,
    });
    expect(kept.entries).toEqual([]);
    const purged = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(purged.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
    expect(registryObjects(w)).toBe(0);
  });

  it('a namespace-scoped sweep leaves litter in other namespaces', async () => {
    const w = world();
    const mine = { namespace: 'mine', segment: 'gone' };
    const theirs = { namespace: 'theirs', segment: 'gone' };
    const bucket = dueBucket(w.now());
    await w.registry.create(dueIndexRef(bucket, mine), { currentGen: null });
    await w.registry.create(dueIndexRef(bucket, theirs), { currentGen: null });
    await retireExpired(w.deps, { scan: 'index', namespace: 'mine', now: w.now() });
    expect((await bucketRows(w, bucket)).map((r) => r.segment)).toEqual([
      dueIndexRef(bucket, theirs).segment,
    ]);
  });

  it('a sharded sweep leaves litter in shards it does not own', async () => {
    const w = world();
    const bucket = dueBucket(w.now());
    const refs = Array.from({ length: 8 }, (_, i) => ({ namespace: 'n', segment: `gone-${i}` }));
    const shard = (r: SegmentRef): number => shardOf(segmentKey(r), 2);
    expect(new Set(refs.map(shard)).size).toBe(2); // a control: both shards are represented
    for (const r of refs) await w.registry.create(dueIndexRef(bucket, r), { currentGen: null });
    await retireExpired(w.deps, { scan: 'index', shards: [0], totalShards: 2, now: w.now() });
    const left = (await bucketRows(w, bucket)).map((r) => r.segment).sort();
    expect(left).toEqual(
      refs
        .filter((r) => shard(r) === 1)
        .map((r) => dueIndexRef(bucket, r).segment)
        .sort(),
    );
  });

  it('a segment too long to index gets no pointer, and the fleet scan purges it', async () => {
    const w = world();
    const ref = { namespace: 'n'.repeat(125), segment: 's'.repeat(130) };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    expect(
      (await retireExpired(w.deps, { scan: 'index', now: w.now(), tombstoneGraceMs: GRACE }))
        .entries,
    ).toEqual([]);
    const fleet = await retireExpired(w.deps, {
      scan: 'fleet',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(fleet.tombstonesPurged).toBe(1);
  });

  it('a 0.11 index scan meets a purge pointer as it meets every row 0.12 writes: it fails closed, typed', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    const purgeDay = dueBucket(w.now() + GRACE);

    // 0.11's `list(cbm.due.<day>)`: one listing, then each row parsed, the stamp checked first.
    const scanAs011 = async (bucket: number): Promise<void> => {
      for await (const key of w.store.listKeys(
        registryListPrefix(undefined, dueNamespace(bucket)),
      )) {
        readAs011(w.store.text(key)!);
      }
    };
    await expect(scanAs011(purgeDay)).rejects.toBeInstanceOf(UnsupportedError);
    // A control: the same scan reads a bucket holding a pointer 0.11 wrote.
    const older = purgeDay - 1000;
    w.store.plant(
      registryObjectKey(undefined, dueIndexRef(older, ref)),
      JSON.stringify({
        schemaVersion: 1,
        deleted: false,
        record: {
          ...dueIndexRef(older, ref),
          currentGen: null,
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          token: '0',
        },
      }),
    );
    await expect(scanAs011(older)).resolves.toBeUndefined();
  });

  it('the lookback reaches a purge pointer the sweep missed for a week, and no further', async () => {
    const missed = async (days: number): Promise<number> => {
      const w = world();
      const ref = { namespace: 'n', segment: 'day' };
      await seed(w, ref, T0 + RETENTION);
      w.advance(RETENTION + 1);
      await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
      w.advance(GRACE + days * DAY);
      const res = await retireExpired(w.deps, {
        scan: 'index',
        now: w.now(),
        tombstoneGraceMs: GRACE,
      });
      return res.tombstonesPurged;
    };
    expect(await missed(DEFAULT_LOOKBACK_BUCKETS)).toBe(1);
    expect(await missed(DEFAULT_LOOKBACK_BUCKETS + 1)).toBe(0); // the fleet repair pass's, from here
  });
});

describe('a delete the backend refuses starves nothing', () => {
  /** What each provider throws, raw, for a delete it will not apply for a reason that is not a lost race. */
  const refusals: Array<[string, () => Error, string]> = [
    [
      'a policy that denies delete',
      () =>
        Object.assign(new Error('Access Denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        }),
      'failed: Access Denied',
    ],
    [
      'Azure Blob: the blob has a snapshot',
      () =>
        Object.assign(
          new Error('There are snapshots present, and the request did not delete them.'),
          { name: 'RestError', statusCode: 409, code: 'SnapshotsPresent' },
        ),
      'failed: There are snapshots present, and the request did not delete them.',
    ],
  ];

  /** Six retired tombstones past their grace, then three segments that have since expired, in scan order. */
  async function stuckThenExpired(w: World): Promise<void> {
    for (let i = 0; i < 6; i++)
      await seed(w, { namespace: 'n', segment: `stuck-${i}` }, T0 + RETENTION);
    w.advance(RETENTION + 1);
    const retired = await retireExpired(w.deps, {
      now: w.now(),
      limit: 6,
      tombstoneGraceMs: GRACE,
    });
    expect(retired.retired).toBe(6);
    for (let i = 0; i < 3; i++)
      await seed(w, { namespace: 'n', segment: `late-${i}` }, w.now() + DAY);
    w.advance(GRACE); // the tombstones are due, and the three have expired
  }

  it.each(refusals)(
    '%s: a purge that fails is not charged to the limit, and the expired segments behind it are retired',
    async (_name, refusal, reason) => {
      const w = world();
      await stuckThenExpired(w);
      w.store.refuseDelete = () => refusal();
      const deletesBefore = w.store.deletes;

      const res = await retireExpired(w.deps, { now: w.now(), limit: 4, tombstoneGraceMs: GRACE });

      expect(res.retired).toBe(3);
      expect(res.limited).toBe(false);
      expect(res.tombstonesPurged).toBe(0);
      // One purge was tried, and failed; the sweep stopped purging, and went on to retire.
      expect(res.entries.filter((e) => e.action === 'skipped')).toEqual([
        { namespace: 'n', segment: 'stuck-0', action: 'skipped', reason },
      ]);
      expect(res.entries.filter((e) => e.action === 'retired')).toHaveLength(3);
      // The fault is in the result, not only in the ledger: that purge, and the three expiry pointers it could not remove.
      expect(res.purgeFaults).toBe(4);
      expect(res.firstPurgeFault).toBe(reason);
      expect(w.store.deletes - deletesBefore).toBe(4); // 1 purge, then 3 pointers; the other five tombstones untried
    },
  );

  it('a refused purge costs nothing against the limit: a limit equal to the segments behind it still retires them all', async () => {
    const w = world();
    await stuckThenExpired(w);
    w.store.refuseDelete = () => refusals[0]![1]();
    const res = await retireExpired(w.deps, { now: w.now(), limit: 3, tombstoneGraceMs: GRACE });
    expect(res.retired).toBe(3);
    expect(res.limited).toBe(false);
  });

  it('the first fault is the one reported, whichever delete refuses later', async () => {
    const w = world();
    await stuckThenExpired(w);
    w.store.refuseDelete = (key) =>
      Object.assign(new Error(key.includes('cbm.due.') ? 'pointer denied' : 'row denied'), {
        name: 'AccessDenied',
      });
    const res = await retireExpired(w.deps, { now: w.now(), limit: 4, tombstoneGraceMs: GRACE });
    expect(res.purgeFaults).toBe(4);
    expect(res.firstPurgeFault).toBe('failed: row denied');
  });

  it('a segment that held nothing, whose row the registry will not delete, is counted and still stamped', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'typo' };
    await setSegmentRetention(ref, { registry: w.registry }, { expiresAt: T0 + RETENTION }); // a row, and no storage
    w.advance(RETENTION + 1);
    w.store.refuseDelete = () =>
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.retired).toBe(1);
    // The expiry pointer's removal, and the empty row's: both refused.
    expect(res.purgeFaults).toBe(2);
    expect(res.firstPurgeFault).toBe('failed: Access Denied');
    const row = await w.registry.get(ref);
    expect(row?.status).toBe('destroyed');
    expect(row?.retention?.retiredBySweepAt).toBe(w.now()); // stamped, so a later sweep purges it
  });

  it('the stop lasts one call: with the refusal lifted, the next sweep purges every tombstone', async () => {
    const w = world();
    await stuckThenExpired(w);
    w.store.refuseDelete = () => refusals[0]![1]();
    await retireExpired(w.deps, { now: w.now(), limit: 4, tombstoneGraceMs: GRACE });
    w.store.refuseDelete = undefined;
    const next = await retireExpired(w.deps, { now: w.now(), limit: 100, tombstoneGraceMs: GRACE });
    expect(next.purgeFaults).toBe(0);
    expect(next.firstPurgeFault).toBeUndefined();
    expect(next.tombstonesPurged).toBe(6);
  });

  describe('a lost race is not a fault', () => {
    /** Two tombstones past their grace, the first of which another writer changes between the purge's read and delete. */
    async function raced(): Promise<{ w: World; refs: SegmentRef[] }> {
      const w = world();
      const refs = [0, 1].map((i) => ({ namespace: 'n', segment: `raced-${i}` }));
      for (const ref of refs) await seed(w, ref, T0 + RETENTION);
      w.advance(RETENTION + 1);
      await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
      w.advance(GRACE);
      const other = new ObjectStoreRegistry(w.store, undefined, w.now);
      w.store.beforeDelete = async () => {
        const row = (await w.registry.get(refs[0]!))!;
        await other.compareAndSwap(refs[0]!, row.token, { residency: { note: 'late' } });
      };
      return { w, refs };
    }

    it('the purges go on, and nothing is reported as a fault', async () => {
      const { w, refs } = await raced();
      const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
      expect(res.entries).toEqual([
        { ...refs[0]!, action: 'skipped', reason: 'failed: contended' },
        { ...refs[1]!, action: 'purged-tombstone' },
      ]);
      expect(res.purgeFaults).toBe(0);
      expect(res.firstPurgeFault).toBeUndefined();
    });

    it('a pointer that changed under its removal is a lost race too: it is kept, and nothing is reported', async () => {
      const w = world();
      const gone = dueIndexRef(dueBucket(w.now()), { namespace: 'n', segment: 'gone' });
      await w.registry.create(gone, { currentGen: null }); // litter: no row behind it
      const other = new ObjectStoreRegistry(w.store, undefined, w.now);
      let reborn = '';
      w.store.beforeDelete = async () => {
        // Between the sweep's read of the pointer and its fenced delete, the pointer is removed and filed anew.
        await other.delete(gone);
        reborn = (await other.create(gone, { currentGen: null })).token;
      };
      const res = await retireExpired(w.deps, { scan: 'index', now: w.now() });
      expect(res.purgeFaults).toBe(0);
      expect(res.firstPurgeFault).toBeUndefined();
      expect(await w.registry.get(gone)).toMatchObject({ token: reborn });
    });

    it('it is still charged to the limit, as every attempt was before', async () => {
      const { w } = await raced();
      const res = await retireExpired(w.deps, { now: w.now(), limit: 1, tombstoneGraceMs: GRACE });
      expect(res.tombstonesPurged).toBe(0);
      expect(res.limited).toBe(true);
    });
  });

  it('a pointer the backend will not delete is counted too, and the row it pointed at is still purged', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    w.advance(GRACE);
    const refusal = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    w.store.refuseDelete = (key) => (key.includes('cbm.due.') ? refusal : undefined);

    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.tombstonesPurged).toBe(1);
    expect(res.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
    expect(res.purgeFaults).toBe(1);
    expect(res.firstPurgeFault).toBe('failed: Access Denied');
    expect(registryObjects(w)).toBe(1); // the purge pointer, left behind
  });

  it('a pointer to nothing that the backend will not delete is counted', async () => {
    const w = world();
    const bucket = dueBucket(w.now());
    await w.registry.create(dueIndexRef(bucket, { namespace: 'n', segment: 'gone' }), {
      currentGen: null,
    });
    w.store.refuseDelete = () =>
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const res = await retireExpired(w.deps, { scan: 'index', now: w.now() });
    expect(res.purgeFaults).toBe(1);
    expect(res.firstPurgeFault).toBe('failed: Access Denied');
  });

  it('a clean sweep reports no faults', async () => {
    const w = world();
    await seed(w, { namespace: 'n', segment: 'day' }, T0 + RETENTION);
    w.advance(RETENTION + 1);
    const res = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(res.purgeFaults).toBe(0);
    expect('firstPurgeFault' in res).toBe(false);
  });
});

describe('what a retirement and a purge cost, per segment, with the gate on and off', () => {
  /**
   * Fifty segments retired, then purged after their grace, then a full unscoped sweep, on a store that counts. A
   * registry that cannot remove a row has no use for a purge pointer, so its costs stay what a retirement and a purge
   * cost before the pointer existed.
   */
  async function costs(conditionalDelete: boolean) {
    const N = 50;
    const w = world({ conditionalDelete });
    for (let i = 0; i < N; i++)
      await seed(w, { namespace: 'sends', segment: `copy-${i}` }, T0 + RETENTION);
    const per = (n: number): number => n / N;
    const snap = () => ({ reads: w.store.reads, writes: w.store.writes, deletes: w.store.deletes });
    const delta = (a: ReturnType<typeof snap>) => ({
      reads: per(w.store.reads - a.reads),
      writes: per(w.store.writes - a.writes),
      deletes: per(w.store.deletes - a.deletes),
    });

    w.advance(RETENTION + 1);
    let before = snap();
    const retired = await retireExpired(w.deps, {
      now: w.now(),
      limit: N,
      tombstoneGraceMs: GRACE,
    });
    expect(retired.retired).toBe(N);
    const retirement = delta(before);

    w.advance(GRACE);
    before = snap();
    const purged = await retireExpired(w.deps, { now: w.now(), limit: N, tombstoneGraceMs: GRACE });
    expect(purged.tombstonesPurged).toBe(N);
    const purge = delta(before);

    const objectsLeft = per(registryObjects(w));
    before = snap();
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    return {
      retirement,
      purge,
      objectsLeft,
      nextUnscopedSweepReads: w.store.reads - before.reads,
    };
  }

  it('gate off: a retirement is 8 reads and 3 writes, a purge 3 and 1, two objects stay, and a sweep reads 100', async () => {
    expect(await costs(false)).toEqual({
      retirement: { reads: 8, writes: 3, deletes: 0 },
      purge: { reads: 3, writes: 1, deletes: 0 },
      objectsLeft: 2,
      nextUnscopedSweepReads: 100,
    });
  });

  it('gate on: a retirement is 9 reads, 3 writes and a delete, a purge 4 reads and 2 deletes, and nothing stays', async () => {
    expect(await costs(true)).toEqual({
      retirement: { reads: 9, writes: 3, deletes: 1 },
      purge: { reads: 4, writes: 0, deletes: 2 },
      objectsLeft: 0,
      nextUnscopedSweepReads: 0,
    });
  });

  it.each([true, false])(
    'a retirement that faulted after its tombstone landed files a purge pointer only where rows are removed (gate on: %s)',
    async (conditionalDelete) => {
      const w = world({ conditionalDelete });
      const ref = { namespace: 'n', segment: 'day' };
      await seed(w, ref, T0 + RETENTION);
      w.advance(RETENTION + 1);
      // Storage cannot be listed once the tombstone is written: the segment is retired, with a fault.
      const storage: IStorageDriver = {
        capabilities: () => w.storage.capabilities(),
        putImmutable: (k, f) => w.storage.putImmutable(k, f),
        getRange: (k, o, l) => w.storage.getRange(k, o, l),
        getTail: (k, m) => w.storage.getTail(k, m),
        delete: (k) => w.storage.delete(k),
        list: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('storage list unavailable')),
          }),
        }),
      };
      const res = await retireExpired(
        { registry: w.registry, storage },
        { now: w.now(), tombstoneGraceMs: GRACE },
      );
      expect(res.entries[0]).toMatchObject({
        action: 'retired',
        fault: 'failed: storage list unavailable',
      });
      expect(await bucketRows(w, dueBucket(w.now() + GRACE))).toHaveLength(
        conditionalDelete ? 1 : 0,
      );
    },
  );

  it('gate off: a pointer to nothing is left alone, since removing it would only rewrite it as a tombstone', async () => {
    const w = world({ conditionalDelete: false });
    const bucket = dueBucket(w.now());
    const gone = dueIndexRef(bucket, { namespace: 'n', segment: 'gone' });
    await w.registry.create(gone, { currentGen: null });
    const writes = w.store.writes;
    const res = await retireExpired(w.deps, { scan: 'index', now: w.now() });
    expect(res.purgeFaults).toBe(0);
    expect(w.store.writes).toBe(writes);
    expect(await bucketRows(w, bucket)).toHaveLength(1);
  });

  it('gate off: no purge pointer is filed, so an index scan has nothing to purge and the fleet scan purges, as before', async () => {
    const w = world({ conditionalDelete: false });
    const ref = { namespace: 'n', segment: 'day' };
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(await bucketRows(w, dueBucket(w.now() + GRACE))).toEqual([]);
    w.advance(GRACE);
    const byIndex = await retireExpired(w.deps, {
      scan: 'index',
      now: w.now(),
      tombstoneGraceMs: GRACE,
    });
    expect(byIndex.tombstonesPurged).toBe(0);
    const byFleet = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(byFleet.tombstonesPurged).toBe(1);
  });
});

describe('a purge pointer that outlives its row is removed by the unscoped fleet scan', () => {
  /** A segment retired with `grace`, so its purge pointer sits under the day that grace ends. */
  async function retired(w: World, ref: SegmentRef, grace: number): Promise<number> {
    await seed(w, ref, T0 + RETENTION);
    w.advance(RETENTION + 1);
    await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: grace });
    return dueBucket(w.now() + grace);
  }

  it('a grace changed between retirement and purge: the pointer filed under the old day is removed with the row', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const filedUnder = await retired(w, ref, GRACE);
    w.advance(DAY);
    // The purge runs with a shorter grace, so it computes a day that holds no pointer; the scan read the real one.
    const res = await retireExpired(w.deps, { scan: 'fleet', now: w.now(), tombstoneGraceMs: DAY });
    expect(res.entries).toEqual([{ ...ref, action: 'purged-tombstone' }]);
    expect(await bucketRows(w, filedUnder)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
  });

  it('a delete that landed and lost its response: the next unscoped scan finds the pointer to nothing and removes it', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const filedUnder = await retired(w, ref, GRACE);
    w.advance(GRACE);
    w.store.landThenFailDelete = new TransientError('connection reset after the delete');
    const first = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(first.entries).toEqual([
      { ...ref, action: 'skipped', reason: 'failed: connection reset after the delete' },
    ]);
    expect(await w.registry.get(ref)).toBeNull(); // it landed
    expect(await bucketRows(w, filedUnder)).toHaveLength(1); // outcome unknown, so the pointer was kept

    const next = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: GRACE });
    expect(next.entries).toEqual([]);
    expect(await bucketRows(w, filedUnder)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
    const after = await readsOf(w, () => retireExpired(w.deps, { now: w.now() }));
    expect(after.reads).toBe(0); // read once, and gone
  });

  it('a pointer older than the lookback, which no index scan reaches, is removed by the unscoped fleet scan', async () => {
    const w = world();
    const ref = { namespace: 'n', segment: 'day' };
    const filedUnder = await retired(w, ref, GRACE);
    w.store.remove(registryObjectKey(undefined, ref)); // the row goes by another route; the pointer stays
    w.advance(GRACE + (DEFAULT_LOOKBACK_BUCKETS + 3) * DAY);

    await retireExpired(w.deps, { scan: 'index', now: w.now(), tombstoneGraceMs: GRACE });
    expect(await bucketRows(w, filedUnder)).toHaveLength(1); // out of reach of the index scan

    await retireExpired(w.deps, { scan: 'fleet', now: w.now(), tombstoneGraceMs: GRACE });
    expect(await bucketRows(w, filedUnder)).toEqual([]);
    expect(registryObjects(w)).toBe(0);
  });

  describe('its scope', () => {
    /** Litter: pointers in a past bucket to segments with no row, in two namespaces. */
    async function litter(w: World): Promise<SegmentRef[]> {
      const refs = ['mine', 'theirs'].flatMap((namespace) =>
        [0, 1, 2, 3].map((i) => ({ namespace, segment: `gone-${i}` })),
      );
      const bucket = dueBucket(w.now()) - 30; // far outside the index scan's lookback
      for (const ref of refs)
        await w.registry.create(dueIndexRef(bucket, ref), { currentGen: null });
      return refs;
    }
    const left = async (w: World): Promise<number> =>
      (await bucketRows(w, dueBucket(w.now()) - 30)).length;

    it('an unscoped fleet scan removes it, and a pointer whose row exists stays', async () => {
      const w = world();
      await litter(w);
      const live = { namespace: 'mine', segment: 'live' };
      await seed(w, live, w.now() + 10 * DAY); // its expiry pointer is under a future day
      const res = await retireExpired(w.deps, { now: w.now() });
      expect(res.purgeFaults).toBe(0);
      expect(await left(w)).toBe(0);
      expect(await bucketRows(w, dueBucket(w.now() + 10 * DAY))).toHaveLength(1);
    });

    it('a namespace-scoped scan does not list pointers, and leaves them', async () => {
      const w = world();
      await litter(w);
      await retireExpired(w.deps, { namespace: 'mine', now: w.now() });
      expect(await left(w)).toBe(8);
    });

    it('a dry run removes none', async () => {
      const w = world();
      await litter(w);
      await retireExpired(w.deps, { dryRun: true, now: w.now() });
      expect(await left(w)).toBe(8);
    });

    it('a sharded scan removes only the pointers of its own shard', async () => {
      const w = world();
      const refs = await litter(w);
      const shard = (r: SegmentRef): number => shardOf(segmentKey(r), 2);
      expect(new Set(refs.map(shard)).size).toBe(2); // a control: both shards hold some
      await retireExpired(w.deps, { shards: [0], totalShards: 2, now: w.now() });
      expect(await left(w)).toBe(refs.filter((r) => shard(r) === 1).length);
    });

    it('removes at most `limit` of them in one call, and the next call goes on', async () => {
      const w = world();
      await litter(w);
      await retireExpired(w.deps, { limit: 3, now: w.now() });
      expect(await left(w)).toBe(5);
      await retireExpired(w.deps, { limit: 3, now: w.now() });
      expect(await left(w)).toBe(2);
      await retireExpired(w.deps, { limit: 3, now: w.now() });
      expect(await left(w)).toBe(0);
    });

    it('one the registry refuses to delete still counts against the limit, so a refusing registry costs at most `limit` tries', async () => {
      const w = world();
      await litter(w);
      w.store.refuseDelete = () =>
        Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      const res = await retireExpired(w.deps, { limit: 3, now: w.now() });
      expect(res.purgeFaults).toBe(3);
      expect(await left(w)).toBe(8);
    });

    it('an index scan is capped the same way', async () => {
      const w = world();
      const bucket = dueBucket(w.now());
      for (let i = 0; i < 8; i++) {
        await w.registry.create(dueIndexRef(bucket, { namespace: 'n', segment: `gone-${i}` }), {
          currentGen: null,
        });
      }
      await retireExpired(w.deps, { scan: 'index', limit: 3, now: w.now() });
      expect(await bucketRows(w, bucket)).toHaveLength(5);
    });

    it('where the registry only tombstones, none is removed: it would rewrite each as a tombstone the next scan reads', async () => {
      const w = world({ conditionalDelete: false });
      await litter(w);
      const writes = w.store.writes;
      await retireExpired(w.deps, { now: w.now() });
      expect(w.store.writes).toBe(writes);
      expect(await left(w)).toBe(8);
    });
  });

  describe('it is removed only if its row is still absent, and only the pointer that was read', () => {
    it('a row created for the name after the scan read the pointer keeps it', async () => {
      const w = world();
      const reused = { namespace: 'n', segment: 'reused' };
      const expiring = { namespace: 'n', segment: 'expiring' };
      await seed(w, expiring, T0 + RETENTION);
      w.advance(RETENTION + 1);
      const today = dueBucket(w.now());
      await w.registry.create(dueIndexRef(today, reused), { currentGen: null }); // litter from an earlier incarnation
      // While the sweep retires `expiring`, the name is created with a policy due today: its pointer write finds the
      // litter at that key and takes it as its own.
      const storage: IStorageDriver = {
        capabilities: () => w.storage.capabilities(),
        putImmutable: (k, f) => w.storage.putImmutable(k, f),
        getRange: (k, o, l) => w.storage.getRange(k, o, l),
        getTail: (k, m) => w.storage.getTail(k, m),
        delete: (k) => w.storage.delete(k),
        list: (r) =>
          (async function* () {
            if ((await w.registry.get(reused)) === null) {
              await setSegmentRetention(reused, { registry: w.registry }, { expiresAt: w.now() });
            }
            yield* w.storage.list(r);
          })(),
      };
      await retireExpired(
        { registry: w.registry, storage },
        { scan: 'fleet', now: w.now(), tombstoneGraceMs: GRACE },
      );
      expect((await bucketRows(w, today)).map((r) => r.segment)).toContain(
        dueIndexRef(today, reused).segment,
      );
    });

    it('a pointer filed anew between the read and the delete is kept, and is no fault', async () => {
      const w = world();
      const gone = dueIndexRef(dueBucket(w.now()) - 30, { namespace: 'n', segment: 'gone' });
      await w.registry.create(gone, { currentGen: null });
      const other = new ObjectStoreRegistry(w.store, undefined, w.now);
      let reborn = '';
      w.store.beforeDelete = async () => {
        await other.delete(gone);
        reborn = (await other.create(gone, { currentGen: null })).token;
      };
      const res = await retireExpired(w.deps, { now: w.now() });
      expect(res.purgeFaults).toBe(0);
      expect(await w.registry.get(gone)).toMatchObject({ token: reborn });
    });
  });
});

describe('a load that collects by name meets a row the purge removed', () => {
  const ref = { namespace: 'n', segment: 'day' };
  const idsOf = (g: number): number[] => Array.from({ length: g + 1 }, (_, i) => i);
  const present = async (w: World): Promise<number[]> => {
    const out: number[] = [];
    for await (const k of w.storage.list(ref)) out.push(k.generation);
    return out.sort((a, b) => a - b);
  };

  /** A segment loaded five times (generations 0 to 4, of which 3 and 4 remain), whose sixth load publishes 5. */
  async function atFour(w: World, expiresAt?: number): Promise<void> {
    if (expiresAt !== undefined)
      await setSegmentRetention(ref, { registry: w.registry }, { expiresAt });
    for (let g = 0; g < 5; g++) {
      const r = await loadSegment(ref, idsOf(g), { ...w.deps, codec: roaringCodec });
      expect(r).toMatchObject({ generation: g, published: true });
    }
    expect(await present(w)).toEqual([3, 4]);
  }

  /** `registry`, with `after` run once, when its first compare-and-swap (the load's publish) has landed. */
  function afterPublish(w: World, after: () => Promise<void>): ObjectStoreRegistry {
    const wrapped = Object.create(w.registry) as ObjectStoreRegistry;
    let fired = false;
    wrapped.compareAndSwap = async (...args: Parameters<ObjectStoreRegistry['compareAndSwap']>) => {
      const out = await w.registry.compareAndSwap(...args);
      if (!fired) {
        fired = true;
        await after();
      }
      return out;
    };
    return wrapped;
  }

  it('a row removed outright at that moment: nothing is deleted by name, and the publish stands', async () => {
    const w = world();
    await atFour(w);
    const registry = afterPublish(w, () => w.registry.delete(ref));
    const r = await loadSegment(ref, idsOf(5), {
      storage: w.storage,
      registry,
      codec: roaringCodec,
    });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await present(w)).toEqual([3, 4, 5]);
  });

  it('a name purged and created again with a pointer below the published generation: nothing is deleted', async () => {
    const w = world();
    await atFour(w);
    const registry = afterPublish(w, async () => {
      await w.registry.delete(ref);
      await w.registry.create(ref, { currentGen: 0 });
    });
    const r = await loadSegment(ref, idsOf(5), {
      storage: w.storage,
      registry,
      codec: roaringCodec,
    });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await present(w)).toEqual([3, 4, 5]);
  });

  it('the sweep itself retires and purges the row between the publish and the delete: the load is unharmed, and no object outlives the row', async () => {
    const w = world();
    await atFour(w, T0 + RETENTION);
    w.advance(RETENTION + 1);
    const registry = afterPublish(w, async () => {
      // A retirement drops the segment (tombstone, then every object), and with no grace the next sweep purges the row.
      await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: 0 });
      const purged = await retireExpired(w.deps, { now: w.now(), tombstoneGraceMs: 0 });
      expect(purged.tombstonesPurged).toBe(1);
      expect(await w.registry.get(ref)).toBeNull();
    });
    const r = await loadSegment(ref, idsOf(5), {
      storage: w.storage,
      registry,
      codec: roaringCodec,
    });
    expect(r).toMatchObject({ generation: 5, published: true, collected: [] });
    expect(await present(w)).toEqual([]); // the drop took them all, and the by-name pass found no row to act on
    expect(registryObjects(w)).toBe(0);
  });
});
