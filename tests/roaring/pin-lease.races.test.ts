import {
  CloudRoaring,
  LEASE_SKEW_MS,
  LeaseLimitError,
  MemoryStorage,
  NotFoundError,
  WriteConflictError,
  isLeaseExpiredError,
  destroySegment,
  type SegmentRef,
} from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { takeLease } from '@/core/leases';
import { rollbackSegment } from '@/core/rollback';
import { brandAsBackend } from '@/core/ports';
import type { IRegistryDriver, IStorageDriver, RegistryRecord } from '@/core/ports';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';
import { collect } from '../helpers/loaded';

/**
 * A lease write moves the row's token, so it meets every other writer of the row; and a pin of the current generation
 * cannot lose a race with collection. These hold each interleaving at the step where it matters.
 */

const HOUR = 3_600_000;
const FAR_MS = 4_000_000_000_000;
const T0 = 2_000_000_000_000;
const REF: SegmentRef = { namespace: 'ns', segment: 'audience' };
const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const spread = (chunks: number): number[] =>
  Array.from({ length: chunks * 3 }, (_, i) => Math.floor(i / 3) * 65_536 + (i % 3));

function lcg(seed = 7) {
  let n = seed;
  return {
    next: () => {
      n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
      return n / 2_147_483_648;
    },
  };
}

/** A clock `offset` ms away from the shared real time `world.t`. */
const clockAt = (w: { t: number }, offset = 0) => ({
  now: () => w.t + offset,
  sleep: () => Promise.resolve(),
});

/** `target` with `before` awaited ahead of the first call of `method` that matches `when`. */
function hook<T extends object>(
  target: T,
  method: string,
  before: (nth: number, args: unknown[]) => Promise<void>,
): T {
  let nth = 0;
  return new Proxy(target, {
    get(t, p, rx) {
      const v: unknown = Reflect.get(t, p, rx);
      if (typeof v !== 'function') return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(t);
      if (p !== method) return fn;
      return async (...a: unknown[]) => {
        await before(nth++, a);
        return fn(...a);
      };
    },
  });
}

const generationsIn = async (storage: IStorageDriver): Promise<number[]> => {
  const out: number[] = [];
  for await (const k of storage.list(REF)) out.push(k.generation);
  return out.sort((a, b) => a - b);
};

describe('N simultaneous takers on one segment', () => {
  async function run(n: number) {
    const world = { t: T0 };
    const memory = new MemoryStorage();
    const calls: Record<string, number> = {};
    const backend = brandAsBackend({
      storage: memory.storage,
      registry: counting<IRegistryDriver>(memory.registry, calls),
    });
    const store = new CloudRoaring({
      storage: backend,
      seams: { clock: clockAt(world), rng: lcg() },
      cache: { genTtlMs: 0 },
    });
    await store.load(REF, [1, 2, 3]);
    for (const k of Object.keys(calls)) delete calls[k];
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () =>
        store.segment(REF.segment, { namespace: 'ns' }).pin({ leaseUntil: T0 + HOUR }),
      ),
    );
    return { settled, row: (await memory.registry.get(REF))!, calls };
  }

  it.each([2, 8, 32, 64])(
    'all %i land within the attempt bound, one entry each, in lockstep, which is the worst case',
    async (n) => {
      const { settled, row, calls } = await run(n);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(n);
      expect(new Set(row.leases?.map((e) => e.holder)).size).toBe(n);
      expect(row.leases).toHaveLength(n);
      // Each round exactly one write lands, so n takers cost n(n+1)/2 writes between them and as many reads, plus
      // the n row reads of the pins themselves less the one each of them did not need.
      expect(calls.compareAndSwap).toBe((n * (n + 1)) / 2);
      expect(calls.get).toBeLessThanOrEqual((n * (n + 1)) / 2 + n);
    },
  );

  it('70 at once: 64 land, the other 6 get LeaseLimitError, and the row holds exactly 64', async () => {
    const { settled, row } = await run(70);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(ok).toHaveLength(64);
    expect(failed).toHaveLength(6);
    for (const f of failed) expect(f.reason).toBeInstanceOf(LeaseLimitError);
    expect(row.leases).toHaveLength(64);
  });
});

describe('a lease write against the other writers of the row', () => {
  function world() {
    const w = { t: T0 };
    const memory = new MemoryStorage();
    const make = (storage: MemoryStorage | ReturnType<typeof brandAsBackend>, offset = 0) =>
      new CloudRoaring({
        storage,
        seams: { clock: clockAt(w, offset), rng: lcg(3 + (offset === 0 ? 0 : 1)) },
        cache: { genTtlMs: 0 },
      });
    return { w, memory, make, writer: make(memory), reader: make(memory) };
  }
  const lease = (s: CloudRoaring, w: { t: number }) =>
    s.segment(REF.segment, { namespace: 'ns' }).pin({ leaseUntil: w.t + HOUR });

  it('a load that read the row before the lease and publishes after still publishes, and a load that another write beat is superseded', async () => {
    const x = world();
    await x.writer.load(REF, ids(10));
    let snap: Awaited<ReturnType<typeof lease>> | undefined;
    const racing = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0) snap = await lease(x.reader, x.w); // after the load's row read, before its publish
    });
    const writer = x.make(brandAsBackend({ storage: x.memory.storage, registry: racing }));
    const r = await writer.load(REF, ids(20));
    // A lease write changed nothing the load derived: it publishes, and its object was written once.
    expect(r).toMatchObject({ published: true, generation: 1 });
    expect(await snap!.count()).toBe(10);
    // Any other write beats it, as ever: it leaves its object, an orphan above the pointer that the re-run numbers past.
    const beaten = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0)
        await x.memory.registry.compareAndSwap(REF, (await x.memory.registry.get(REF))!.token, {
          retention: { expiresAt: FAR_MS },
        });
    });
    const loser = x.make(brandAsBackend({ storage: x.memory.storage, registry: beaten }));
    expect(await loser.load(REF, ids(30))).toMatchObject({
      published: false,
      reason: 'superseded',
    });
    expect(await generationsIn(x.memory.storage)).toEqual([0, 1, 2]);
    expect(await x.writer.load(REF, ids(30))).toMatchObject({ published: true, generation: 3 });
  });

  it('a pin whose row went stale before its write lands re-reads and pins the new current generation', async () => {
    const x = world();
    await x.writer.load(REF, ids(10));
    let loaded = false;
    const racing = hook(x.memory.registry, 'compareAndSwap', async () => {
      if (loaded) return;
      loaded = true;
      await x.writer.load(REF, ids(30), { keep: 0 }); // moves the pointer and deletes generation 0 by name
    });
    const reader = x.make(brandAsBackend({ storage: x.memory.storage, registry: racing }));
    const snap = await lease(reader, x.w);
    expect(snap.pinnedAt?.generation).toBe(1);
    const row = (await x.memory.registry.get(REF))!;
    expect(row.leases?.map((e) => e.generation)).toEqual([1]);
    expect(await generationsIn(x.memory.storage)).toEqual([1]);
    expect(await snap.count()).toBe(30);
  });

  it('a pin whose row went stale holds the new current generation, not the one it read, when the old one is still stored', async () => {
    const x = world();
    await x.writer.load(REF, ids(10));
    let loaded = false;
    const racing = hook(x.memory.registry, 'compareAndSwap', async () => {
      if (loaded) return;
      loaded = true;
      await x.writer.load(REF, ids(30)); // the default keep: generation 0 stays in the bucket
    });
    const reader = x.make(brandAsBackend({ storage: x.memory.storage, registry: racing }));
    const snap = await lease(reader, x.w);
    expect(await generationsIn(x.memory.storage)).toEqual([0, 1]);
    expect(snap.pinnedAt?.generation).toBe(1);
    expect((await x.memory.registry.get(REF))!.leases?.map((e) => e.generation)).toEqual([1]);
    expect(await snap.count()).toBe(30);
  });

  it('a collector paused between its row read and its delete cannot take what a pin leases: the pin holds the new current', async () => {
    const x = world();
    await x.writer.load(REF, ids(10));
    let release: () => void = () => undefined;
    const paused = new Promise<void>((r) => (release = r));
    let reached: () => void = () => undefined;
    const atDelete = new Promise<void>((r) => (reached = r));
    const slow = hook(x.memory.storage, 'delete', async () => {
      reached();
      await paused;
    });
    const writer = x.make(brandAsBackend({ storage: slow, registry: x.memory.registry }));
    // Publishes generation 1, then deletes generation 0 by name, and stops on the delete.
    const loading = writer.load(REF, ids(30), { keep: 0 });
    await atDelete;
    const snap = await lease(x.reader, x.w);
    release();
    await loading;
    expect(snap.pinnedAt?.generation).toBe(1);
    expect(await generationsIn(x.memory.storage)).toEqual([1]);
    expect(await snap.count()).toBe(30);
  });

  it('a lease on a PAST generation that lands inside a collector delete does not hold it: the one window that remains', async () => {
    const x = world();
    await x.writer.load(REF, spread(50));
    let release: () => void = () => undefined;
    const paused = new Promise<void>((r) => (release = r));
    let reached: () => void = () => undefined;
    const atDelete = new Promise<void>((r) => (reached = r));
    const slow = hook(x.memory.storage, 'delete', async () => {
      reached();
      await paused;
    });
    const writer = x.make(brandAsBackend({ storage: slow, registry: x.memory.registry }));
    const loading = writer.load(REF, spread(60), { keep: 0 });
    await atDelete; // the collector has read the row and is about to delete generation 0
    const row = (await x.memory.registry.get(REF))!;
    const taken = await takeLease(
      REF,
      { registry: x.memory.registry, clock: clockAt(x.w) },
      { holder: '0123456789abcdef', generation: 0, until: x.w.t + HOUR, row, current: false },
    );
    expect(taken).not.toBe('moved');
    release();
    await loading;
    // The lease is in the row and the object is gone: a read of it is a typed NotFoundError, never a wrong answer.
    expect((await x.memory.registry.get(REF))!.leases).toHaveLength(1);
    expect(await generationsIn(x.memory.storage)).toEqual([1]);
    await expect(x.memory.storage.getTail({ ...REF, generation: 0 }, 0)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('an erasure rewrite that read the row before the lease still lands, and one that another write beat reports superseded', async () => {
    const x = world();
    await x.writer.load(REF, [5, 6, 7]);
    const racing = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0) await lease(x.reader, x.w);
    });
    const deps = { storage: x.memory.storage, registry: racing, codec: roaringCodec };
    const first = await eraseIdFromSegment(REF, 7, deps);
    expect(first).toMatchObject({ erased: true, generation: 1 });
    expect((await x.memory.registry.get(REF))!.leases).toBeUndefined();
    expect(await generationsIn(x.memory.storage)).toEqual([1]);
    // A write of anything else refuses it, as ever.
    await x.writer.load(REF, [5, 6, 8]);
    const beaten = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0)
        await x.memory.registry.compareAndSwap(REF, (await x.memory.registry.get(REF))!.token, {
          retention: { expiresAt: FAR_MS },
        });
    });
    const second = await eraseIdFromSegment(REF, 8, { ...deps, registry: beaten });
    expect(second).toMatchObject({ erased: false, reason: 'superseded' });
  });

  it('a lease that lands during an erasure delete does not keep the generation: erasure ignores it', async () => {
    const x = world();
    await x.writer.load(REF, [5, 6, 7]);
    await x.writer.load(REF, [5, 6, 7, 8]);
    const snap = await lease(x.reader, x.w); // generation 1 is leased, and holds the id
    const res = await eraseIdFromSegment(REF, 7, {
      storage: x.memory.storage,
      registry: x.memory.registry,
      codec: roaringCodec,
    });
    expect(res.erased).toBe(true);
    expect(await generationsIn(x.memory.storage)).toEqual([2]);
    // The pin answers from what it holds or fails with NotFoundError, as any pin of a collected generation does.
    const read = await collect(snap.iterate()).catch((e: unknown) => e);
    expect(Array.isArray(read) || read instanceof NotFoundError).toBe(true);
  });

  it('a rollback that read the row before the lease still moves the pointer, and one that another write beat throws WriteConflictError', async () => {
    const x = world();
    await x.writer.load(REF, ids(5));
    await x.writer.load(REF, ids(6));
    const racing = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0) await lease(x.reader, x.w);
    });
    await rollbackSegment(REF, 0, { storage: x.memory.storage, registry: racing });
    expect((await x.memory.registry.get(REF))!.currentGen).toBe(0);
    // A write of anything else beats it, as ever.
    const beaten = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0)
        await x.memory.registry.compareAndSwap(REF, (await x.memory.registry.get(REF))!.token, {
          retention: { expiresAt: FAR_MS },
        });
    });
    await x.writer.load(REF, ids(8));
    const current = (await x.memory.registry.get(REF))!.currentGen as number;
    const target = (await generationsIn(x.memory.storage)).find((g) => g < current) as number;
    await expect(
      rollbackSegment(REF, target, { storage: x.memory.storage, registry: beaten }),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('a shred that meets a lease write converges and leaves no lease on the tombstone', async () => {
    const x = world();
    await x.writer.load(REF, ids(5));
    const racing = hook(x.memory.registry, 'compareAndSwap', async (nth) => {
      if (nth === 0) await lease(x.reader, x.w);
    });
    await destroySegment(
      REF,
      { registry: racing },
      {
        confirmSegment: REF.segment,
        allowCleartext: true,
      },
    );
    const row = (await x.memory.registry.get(REF)) as RegistryRecord;
    expect(row.status).toBe('destroyed');
    expect(row.leases).toBeUndefined();
  });
});

/**
 * Two processes whose clocks differ. The hold is safe while the difference is at most the margin, whichever way: a reader
 * behind by `r` serves until `until + r`, and a collector ahead by `c` stops holding at `until + margin - c`.
 */
describe('clock skew, in both directions', () => {
  async function skewed(readerOffset: number, collectorOffset: number) {
    const w = { t: T0 };
    const memory = new MemoryStorage();
    const make = (offset: number) =>
      new CloudRoaring({
        storage: memory,
        seams: { clock: clockAt(w, offset), rng: lcg(offset === 0 ? 11 : 12) },
        cache: { genTtlMs: 0 },
      });
    const reader = make(readerOffset);
    const collector = make(collectorOffset);
    const all = spread(300);
    await collector.load(REF, all);
    const snap = await reader
      .segment(REF.segment, { namespace: 'ns' })
      .pin({ leaseUntil: reader_now(w, readerOffset) + HOUR });
    // Generations 1..15 collect by name and never name generation 0; the listing at 16 is the one that meets it.
    for (let g = 1; g <= 15; g++) await collector.load(REF, [...all, 10_000_000 + g]);
    const listing = (): Promise<unknown> => collector.load(REF, [...all, 10_000_016]);
    return { w, memory, snap, listing, all };
  }
  const reader_now = (w: { t: number }, offset: number): number => w.t + offset;

  it('a reader behind by 30 s still has its generation at the last instant of its lease', async () => {
    const x = await skewed(-30_000, 0);
    x.w.t += HOUR - 1; // the reader's clock is one millisecond short of its own `until`
    await x.listing(); // the collector's clock is 30 s short of `until` + margin: it still holds
    expect(await generationsIn(x.memory.storage)).toContain(0);
    expect(await collect(x.snap.iterate())).toEqual(x.all);
  });

  it('a reader behind by 90 s: the collector takes the generation inside the lease; the read is a typed NotFoundError', async () => {
    const x = await skewed(-90_000, 0);
    x.w.t += HOUR - 1; // the reader's lease has one millisecond left; the collector is 30 s past `until` + margin
    await x.listing();
    expect(await generationsIn(x.memory.storage)).not.toContain(0);
    const err = await collect(x.snap.iterate()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(isLeaseExpiredError(err)).toBe(false);
  });

  it('a collector ahead by 30 s still holds the generation when the reader (correct) reaches `until`', async () => {
    const x = await skewed(0, 30_000);
    x.w.t += HOUR - 1;
    await x.listing(); // the collector reads HOUR + 30 s - 1 against a margin of 60 s
    expect(await generationsIn(x.memory.storage)).toContain(0);
    expect(await collect(x.snap.iterate())).toEqual(x.all);
  });

  it('a collector ahead by 90 s deletes inside the lease: a typed NotFoundError, never empty, never a wrong answer', async () => {
    const x = await skewed(0, 90_000);
    x.w.t += HOUR - 1; // the reader's lease has one millisecond left
    await x.listing();
    expect(await generationsIn(x.memory.storage)).not.toContain(0);
    const err = await collect(x.snap.iterate()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('the margin is one minute', () => {
    expect(LEASE_SKEW_MS).toBe(60_000);
  });
});
