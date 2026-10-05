import { destroySegment, dropSegment } from '@cloudbitmaps/core';
import { eraseIdFromSegment } from '@/core/erase-id';
import {
  LeaseLimitError,
  NotFoundError,
  TransientError,
  WriteConflictError,
  isLeaseExpiredError,
  isLeaseLimitError,
  LeaseExpiredError,
} from '@/core/errors';
import { LIST_COLLECTION_CADENCE, gcOrphanGenerations } from '@/core/generation-gc';
import {
  LEASE_CAS_ATTEMPTS,
  LEASE_SKEW_MS,
  MAX_LEASE_MS,
  MAX_LEASES_PER_SEGMENT,
  heldGenerations,
  isLive,
  liveLeases,
  releaseLease,
  takeLease,
} from '@/core/leases';
import { loadSegment, type LoadDeps, type LoadOptions } from '@/core/load';
import type {
  IRegistryDriver,
  IStorageDriver,
  LeaseEntry,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { rollbackSegment } from '@/core/rollback';
import { setSegmentRetention } from '@/core/retention';
import type { Clock } from '@/core/determinism';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';

/**
 * Leases at the core: the pure helpers, the registry writes that take and release one, and what each collector does
 * with a lease on the row. A lease keeps a generation out of a load's collection until it ends; erasure, shred, drop
 * and retention never look at it.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const H = (n: number): string => n.toString(16).padStart(16, '0');

/** A clock the test moves; waits return at once and are counted. */
function fakeClock(start = T0) {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: (ms: number): Promise<void> => {
      c.sleeps.push(ms);
      return Promise.resolve();
    },
    advance: (ms: number): void => {
      c.t += ms;
    },
  };
  return c as typeof c & Clock;
}

function world() {
  const clock = fakeClock();
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver({ now: () => clock.t });
  const storageCalls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(memory, storageCalls);
  const counted = counting<IRegistryDriver>(registry, registryCalls);
  const deps: LoadDeps = { storage, registry: counted, codec: roaringCodec, clock };
  return { clock, memory, registry, counted, storage, storageCalls, registryCalls, deps };
}
type World = ReturnType<typeof world>;

async function load(w: World, ids: number[], options: LoadOptions = {}) {
  return loadSegment(SEG, ids, w.deps, options);
}

/** Load `count` generations of a growing id set, so no load is refused as a shrink. */
async function loadMany(w: World, count: number, options: LoadOptions = {}): Promise<void> {
  const have = (await w.registry.get(SEG))?.currentGen ?? -1;
  for (let g = have + 1; g < have + 1 + count; g++) {
    const r = await load(
      w,
      Array.from({ length: g + 1 }, (_, i) => i),
      options,
    );
    expect(r).toMatchObject({ generation: g, published: true });
  }
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** Write leases straight into the row, as another process's take would. */
async function putLeases(w: World, entries: LeaseEntry[]): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  await w.registry.compareAndSwap(SEG, row.token, { leases: entries });
}
const lease = (n: number, generation: number, until: number): LeaseEntry => ({
  holder: H(n),
  generation,
  until,
});
const leasesOf = async (w: World) => (await w.registry.get(SEG))?.leases;

describe('isLive, heldGenerations and liveLeases', () => {
  const e = lease(1, 4, 10_000);
  it('holds until the end plus the margin, and not at it', () => {
    expect(isLive(e, 10_000 + LEASE_SKEW_MS - 1)).toBe(true);
    expect(isLive(e, 10_000 + LEASE_SKEW_MS)).toBe(false);
    expect(isLive(e, 0)).toBe(true);
  });

  it('does not honour an end further out than an honest holder could have written', () => {
    const now = 1_000_000;
    expect(isLive(lease(1, 1, now + MAX_LEASE_MS + LEASE_SKEW_MS), now)).toBe(true);
    expect(isLive(lease(1, 1, now + MAX_LEASE_MS + LEASE_SKEW_MS + 1), now)).toBe(false);
  });

  const row = (leases: LeaseEntry[]): RegistryRecord =>
    ({ segment: 's', currentGen: 9, status: 'active', leases }) as unknown as RegistryRecord;

  it('names the generations of live entries only', () => {
    const r = row([lease(1, 3, 100), lease(2, 5, 100 + 10 * LEASE_SKEW_MS), lease(3, 3, 100)]);
    const now = 100 + 2 * LEASE_SKEW_MS;
    expect([...heldGenerations(r, now)]).toEqual([5]);
    expect(heldGenerations(null, now).size).toBe(0);
    expect(heldGenerations(row([]), now).size).toBe(0);
    expect(liveLeases(r, now).map((x) => x.holder)).toEqual([H(2)]);
  });
});

describe('takeLease', () => {
  async function seeded(loads = 3) {
    const w = world();
    await loadMany(w, loads);
    w.clock.sleeps.length = 0; // a serialized load yields on the clock; only the waits of a take are counted
    const row = (await w.registry.get(SEG))!;
    const take = (n: number, over: Partial<Parameters<typeof takeLease>[2]> = {}) =>
      takeLease(
        SEG,
        { registry: w.counted, clock: w.clock },
        {
          holder: H(n),
          generation: row.currentGen as number,
          until: w.clock.t + 1000,
          row,
          current: true,
          ...over,
        },
      );
    return { w, row, take };
  }

  it('writes a sorted entry with one write and no read of its own, and returns the row token', async () => {
    const { w, row, take } = await seeded();
    w.registryCalls.get = 0;
    w.registryCalls.compareAndSwap = 0;
    const got = await take(2);
    expect(got).not.toBe('moved');
    expect(w.registryCalls.get ?? 0).toBe(0);
    expect(w.registryCalls.compareAndSwap).toBe(1);
    const after = (await w.registry.get(SEG))!;
    expect((got as { token: string }).token).toBe(after.token);
    expect(after.leases).toEqual([
      { holder: H(2), generation: row.currentGen, until: w.clock.t + 1000 },
    ]);
  });

  it('returns moved when the pointer is no longer at the generation, and writes nothing', async () => {
    const { w, take } = await seeded();
    await loadMany(w, 1);
    const before = (await w.registry.get(SEG))!;
    expect(await take(1)).toBe('moved');
    expect((await w.registry.get(SEG))!.token).toBe(before.token);
  });

  it('refuses a generation that is not published, and a row that is gone or destroyed', async () => {
    const { w, take } = await seeded();
    await expect(take(1, { generation: 99, current: false })).rejects.toBeInstanceOf(NotFoundError);
    await destroySegment(
      SEG,
      { registry: w.registry },
      {
        confirmSegment: SEG.segment,
        allowCleartext: true,
      },
    );
    await expect(take(1, { current: false })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is idempotent by holder: a second take replaces the entry and never duplicates it', async () => {
    const { w, take } = await seeded();
    await take(7);
    const again = await take(7, { row: (await w.registry.get(SEG))!, until: w.clock.t + 5000 });
    expect(again).not.toBe('moved');
    const rows = await leasesOf(w);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.until).toBe(w.clock.t + 5000);
  });

  it('takes the 64th live lease and refuses the 65th without writing', async () => {
    const { w, take } = await seeded();
    for (let i = 0; i < MAX_LEASES_PER_SEGMENT; i++) {
      await take(i, { row: (await w.registry.get(SEG))! });
    }
    expect(await leasesOf(w)).toHaveLength(MAX_LEASES_PER_SEGMENT);
    const before = (await w.registry.get(SEG))!;
    w.registryCalls.compareAndSwap = 0;
    const err = await take(999, { row: before }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseLimitError);
    expect(isLeaseLimitError(err)).toBe(true);
    expect(w.registryCalls.compareAndSwap).toBe(0);
    expect((await w.registry.get(SEG))!.token).toBe(before.token);
  });

  it('prunes ended entries in the write, and never counts them toward the cap', async () => {
    const { w, take } = await seeded();
    for (let i = 0; i < MAX_LEASES_PER_SEGMENT; i++) {
      await take(i, { row: (await w.registry.get(SEG))!, until: w.clock.t + 1000 });
    }
    w.clock.advance(1000 + LEASE_SKEW_MS); // every entry has ended
    await take(500, { row: (await w.registry.get(SEG))!, until: w.clock.t + 1000 });
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(500)]);
  });

  it('retries after a lost race with a fresh read and a wait, and lands', async () => {
    const { w, row, take } = await seeded();
    // Another writer moves the row after the caller read it.
    await w.registry.compareAndSwap(SEG, row.token, { retention: { expiresAt: T0 * 2 } });
    w.registryCalls.get = 0;
    const got = await take(3);
    expect(got).not.toBe('moved');
    expect(w.registryCalls.get).toBe(1);
    expect(w.clock.sleeps).toHaveLength(1);
    expect(w.clock.sleeps[0]).toBeLessThanOrEqual(25);
    expect(await leasesOf(w)).toHaveLength(1);
  });

  it('reports contention as WriteConflictError after the attempt bound, and writes nothing', async () => {
    const { w, row } = await seeded();
    const losing = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p === 'compareAndSwap') {
          return () => Promise.reject(new WriteConflictError('lost'));
        }
        const v: unknown = Reflect.get(t, p, rx);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as IRegistryDriver;
    await expect(
      takeLease(
        SEG,
        { registry: losing, clock: w.clock },
        {
          holder: H(1),
          generation: row.currentGen as number,
          until: w.clock.t + 10,
          row,
          current: true,
        },
      ),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(w.clock.sleeps).toHaveLength(LEASE_CAS_ATTEMPTS);
    expect(await leasesOf(w)).toBeUndefined();
  });

  /** A registry whose Nth `compareAndSwap` throws `TransientError`, applying it first or not. */
  function flaky(w: World, plan: Array<'apply' | 'drop' | 'ok'>): IRegistryDriver {
    let i = 0;
    return new Proxy(w.registry, {
      get(t, p, rx) {
        const v: unknown = Reflect.get(t, p, rx);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => Promise<unknown>).bind(t);
        if (p !== 'compareAndSwap') return fn;
        return async (...a: unknown[]) => {
          const how = plan[i++] ?? 'ok';
          if (how === 'ok') return fn(...a);
          if (how === 'apply') await fn(...a);
          throw new TransientError('no answer');
        };
      },
    }) as IRegistryDriver;
  }

  it('settles a write that landed with no answer by the holder id: one entry, no second write', async () => {
    const { w, row } = await seeded();
    w.registryCalls.compareAndSwap = 0;
    const reg = counting(flaky(w, ['apply']), w.registryCalls);
    const got = await takeLease(
      SEG,
      { registry: reg, clock: w.clock },
      {
        holder: H(4),
        generation: row.currentGen as number,
        until: w.clock.t + 10,
        row,
        current: true,
      },
    );
    expect(got).not.toBe('moved');
    expect(w.registryCalls.compareAndSwap).toBe(1);
    expect(await leasesOf(w)).toHaveLength(1);
    expect(w.clock.sleeps).toHaveLength(0);
  });

  it('sends a fresh write after one that did not land, and lands it', async () => {
    const { w, row } = await seeded();
    const got = await takeLease(
      SEG,
      { registry: flaky(w, ['drop']), clock: w.clock },
      {
        holder: H(5),
        generation: row.currentGen as number,
        until: w.clock.t + 10,
        row,
        current: true,
      },
    );
    expect(got).not.toBe('moved');
    expect(await leasesOf(w)).toHaveLength(1);
    expect(w.clock.sleeps).toHaveLength(1);
  });

  it('throws the registry error after three fresh writes went unanswered, writing nothing more', async () => {
    const { w, row } = await seeded();
    const err = await takeLease(
      SEG,
      { registry: flaky(w, ['drop', 'drop', 'drop', 'drop', 'drop']), clock: w.clock },
      {
        holder: H(6),
        generation: row.currentGen as number,
        until: w.clock.t + 10,
        row,
        current: true,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(w.clock.sleeps).toHaveLength(3);
    expect(await leasesOf(w)).toBeUndefined();
  });
});

describe('releaseLease', () => {
  async function leased() {
    const w = world();
    await loadMany(w, 2);
    await putLeases(w, [lease(1, 1, w.clock.t + 1000), lease(2, 1, w.clock.t + 2000)]);
    const release = (n: number) => releaseLease(SEG, { registry: w.counted, clock: w.clock }, H(n));
    return { w, release };
  }

  it('removes the holder, keeps the others, and costs one read and one write', async () => {
    const { w, release } = await leased();
    w.registryCalls.get = 0;
    w.registryCalls.compareAndSwap = 0;
    await release(1);
    expect(w.registryCalls.get).toBe(1);
    expect(w.registryCalls.compareAndSwap).toBe(1);
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(2)]);
  });

  it('is idempotent: a holder that is not there makes no write', async () => {
    const { w, release } = await leased();
    await release(1);
    w.registryCalls.compareAndSwap = 0;
    await release(1);
    await release(99);
    expect(w.registryCalls.compareAndSwap).toBe(0);
  });

  it('drops the last entry as the field, and prunes ended entries it finds', async () => {
    const { w, release } = await leased();
    w.clock.advance(1000 + LEASE_SKEW_MS); // holder 1 has ended; holder 2 has not
    await release(2);
    expect(await leasesOf(w)).toBeUndefined();
  });

  it('resolves for a row that is gone or destroyed', async () => {
    const { w, release } = await leased();
    await destroySegment(
      SEG,
      { registry: w.registry },
      {
        confirmSegment: SEG.segment,
        allowCleartext: true,
      },
    );
    await expect(release(1)).resolves.toBeUndefined();
    await expect(
      releaseLease({ segment: 'absent' }, { registry: w.registry, clock: w.clock }, H(1)),
    ).resolves.toBeUndefined();
  });
});

describe('the typed errors', () => {
  it('LeaseExpiredError and LeaseLimitError are instances, carry their facts, and have predicates', () => {
    const expired = new LeaseExpiredError('ended', 5, 'released');
    expect(expired).toBeInstanceOf(LeaseExpiredError);
    expect(expired).toBeInstanceOf(Error);
    expect(expired.until).toBe(5);
    expect(expired.reason).toBe('released');
    expect(expired.name).toBe('LeaseExpiredError');
    expect(isLeaseExpiredError(expired)).toBe(true);
    expect(isLeaseExpiredError(new LeaseLimitError('full'))).toBe(false);
    expect(isLeaseLimitError(new LeaseLimitError('full'))).toBe(true);
    expect(isLeaseLimitError(expired)).toBe(false);
    expect(isLeaseExpiredError(new Error('x'))).toBe(false);
  });
});

describe('a load collects around a lease', () => {
  it('by name: spares a leased name and still deletes the others the window pushed out', async () => {
    const w = world();
    await loadMany(w, 6, { keep: 5 }); // gens 0..5, the window names 0..4
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3, 4, 5]);
    await putLeases(w, [lease(1, 2, w.clock.t + 1000)]);
    const r = await load(
      w,
      Array.from({ length: 8 }, (_, i) => i),
      { keep: 2 },
    );
    expect(r).toMatchObject({ generation: 6, published: true });
    expect(w.storageCalls.list).toBeUndefined();
    expect(r.collected).toEqual([0, 1, 3]); // the leased name is not among them
    expect(await generations(w.memory)).toEqual([2, 4, 5, 6]);
  });

  it('by name: a lease that lands after the pass began is seen by the per-name read', async () => {
    const w = world();
    await loadMany(w, 6, { keep: 5 });
    let reads = 0;
    const racing = new Proxy(w.registry, {
      get(t, p, rx) {
        const v: unknown = Reflect.get(t, p, rx);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => Promise<unknown>).bind(t);
        if (p !== 'get') return fn;
        return async (...a: unknown[]) => {
          reads += 1;
          // The load's reads: its own row read, then one per evicted name. The lease lands before the third.
          if (reads === 3) {
            const row = (await fn(...a)) as RegistryRecord;
            await t.compareAndSwap(SEG, row.token, { leases: [lease(1, 2, w.clock.t + 1000)] });
          }
          return fn(...a);
        };
      },
    }) as IRegistryDriver;
    await loadSegment(
      SEG,
      Array.from({ length: 8 }, (_, i) => i),
      { ...w.deps, registry: racing },
      {
        keep: 2,
      },
    );
    expect(await generations(w.memory)).toContain(2);
  });

  it('the periodic listing spares a leased generation while the lease and its margin run', async () => {
    const w = world();
    await loadMany(w, 1, { keep: 1 });
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]); // generation 0 is below every later window
    await loadManyTo(w, LIST_COLLECTION_CADENCE); // the listing at 16 runs and meets it
    expect(await generations(w.memory)).toContain(0);
    w.clock.advance(1000 + LEASE_SKEW_MS - 1);
    await loadManyTo(w, 2 * LIST_COLLECTION_CADENCE); // the listing at 32, one millisecond short of the end
    expect(await generations(w.memory)).toContain(0);
  });

  it('collects it at the first listing after the lease and the margin have ended', async () => {
    const w = world();
    await loadMany(w, 1, { keep: 1 });
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]);
    const to = (n: number) => loadManyTo(w, n);
    await to(LIST_COLLECTION_CADENCE - 1);
    expect(await generations(w.memory)).toContain(0);
    w.clock.advance(1000 + LEASE_SKEW_MS); // ended, by the margin
    await to(LIST_COLLECTION_CADENCE); // the listing at 16
    expect(await generations(w.memory)).not.toContain(0);
  });

  it('a leased generation takes no slot of the window', async () => {
    const w = world();
    await loadMany(w, 1, { keep: 2 });
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]);
    (w.deps as { collectByListing?: boolean }).collectByListing = true;
    await loadMany(w, 5, { keep: 2 });
    // The two newest below the pointer are kept, and generation 0 beside them.
    const have = await generations(w.memory);
    expect(have).toContain(0);
    expect(have).toEqual([0, 3, 4, 5]);
  });

  it('a row with no list lists and spares the lease, then records the window without it', async () => {
    const w = world();
    await loadMany(w, 3, { keep: 100 }); // keep above 64 records no list
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]);
    await loadMany(w, 1, { keep: 1 });
    const row = (await w.registry.get(SEG))!;
    expect(await generations(w.memory)).toEqual([0, 2, 3]);
    expect(row.keptGens).toEqual([2]);
  });

  it('a load with no clock cannot tell a live lease from an ended one, and reads none', async () => {
    const w = world();
    await loadMany(w, 6, { keep: 5 });
    await putLeases(w, [lease(1, 2, w.clock.t + 10_000_000)]); // live by the clock the other loads have
    const noClock = { storage: w.storage, registry: w.counted, codec: roaringCodec };
    await loadSegment(
      SEG,
      Array.from({ length: 8 }, (_, i) => i),
      noClock,
      { keep: 2 },
    );
    expect(await generations(w.memory)).not.toContain(2);
    // and its publish leaves the list as it found it: it cannot tell which entries have ended
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(1)]);
  });

  it('a publish drops ended entries from the row in its own write, and keeps live ones', async () => {
    const w = world();
    await loadMany(w, 2);
    await putLeases(w, [lease(1, 1, w.clock.t + 10), lease(2, 1, w.clock.t + 10_000_000)]);
    w.clock.advance(10 + LEASE_SKEW_MS);
    w.registryCalls.compareAndSwap = 0;
    await loadMany(w, 1);
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(2)]);
    // The list was rewritten by the publish itself, not by a write of its own.
    expect(w.registryCalls.compareAndSwap).toBe(1);
  });

  it('a publish with no ended entry leaves the list alone, and a pointer move keeps it', async () => {
    const w = world();
    await loadMany(w, 2);
    await putLeases(w, [lease(1, 1, w.clock.t + 10_000_000)]);
    await loadMany(w, 3);
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(1)]);
  });

  it('the re-proof skips a name that was leased after the pass read the row, and goes on', async () => {
    const w = world();
    // Generations 0..4 with no list recorded, so the pass lists.
    await loadMany(w, 6, { keep: 100 });
    let gets = 0;
    const racing = new Proxy(w.registry, {
      get(t, p, rx) {
        const v: unknown = Reflect.get(t, p, rx);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => Promise<unknown>).bind(t);
        if (p !== 'get') return fn;
        return async (...a: unknown[]) => {
          gets += 1;
          const out = await fn(...a);
          // The listing pass reads the row twice and then once per delete; lease the second candidate in between.
          if (gets === 5) {
            const row = (await fn(...a)) as RegistryRecord;
            await t.compareAndSwap(SEG, row.token, { leases: [lease(1, 2, w.clock.t + 1000)] });
          }
          return out;
        };
      },
    }) as IRegistryDriver;
    await loadSegment(
      SEG,
      Array.from({ length: 9 }, (_, i) => i),
      { ...w.deps, registry: racing, collectByListing: true },
      { keep: 1 },
    );
    const have = await generations(w.memory);
    expect(have).toContain(2); // spared
    expect(have).not.toContain(0);
    expect(have).not.toContain(1);
  });
});

async function loadManyTo(w: World, to: number): Promise<void> {
  const have = (await w.registry.get(SEG))!.currentGen as number;
  for (let g = have + 1; g <= to; g++) {
    await load(
      w,
      Array.from({ length: g + 1 }, (_, i) => i),
    );
  }
}

describe('what always wins over a lease', () => {
  it('gcOrphanGenerations has no lease to honour: a leased generation below the pointer goes', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 3 });
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]);
    const deleted = await gcOrphanGenerations(
      SEG,
      { storage: w.storage, registry: w.registry },
      { keep: 0 },
    );
    expect(deleted).toContain(0);
    expect(await generations(w.memory)).toEqual([3]);
    // @ts-expect-error erasure's collection takes no lease option, so none can be passed by accident
    await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry }, { leases: {} });
  });

  it('an erasure of an ex-member deletes the leased generation that holds the id', async () => {
    const w = world();
    await load(w, [5, 6, 7], { keep: 3 });
    await load(w, [5, 6, 8], { keep: 3 });
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]);
    const res = await eraseIdFromSegment(SEG, 7, {
      storage: w.storage,
      registry: w.registry,
      codec: roaringCodec,
    });
    expect(res.erased).toBe(true);
    expect(await generations(w.memory)).toEqual([1]);
  });

  it('an erasure that rewrites the current generation deletes every leased one and clears the list', async () => {
    const w = world();
    await load(w, [5, 6, 7], { keep: 3 });
    await load(w, [5, 6, 7, 8], { keep: 3 });
    await putLeases(w, [lease(1, 0, w.clock.t + 1000), lease(2, 1, w.clock.t + 1000)]);
    const res = await eraseIdFromSegment(SEG, 7, {
      storage: w.storage,
      registry: w.registry,
      codec: roaringCodec,
    });
    expect(res).toMatchObject({ erased: true, generation: 2 });
    expect(await generations(w.memory)).toEqual([2]);
    expect(await leasesOf(w)).toBeUndefined();
  });

  it('a shred and a drop delete every generation, whatever a lease says, and clear the list', async () => {
    for (const how of ['shred', 'drop'] as const) {
      const w = world();
      await loadMany(w, 3, { keep: 3 });
      await putLeases(w, [lease(1, 1, w.clock.t + 1000)]);
      if (how === 'shred') {
        await destroySegment(
          SEG,
          { registry: w.registry },
          {
            confirmSegment: SEG.segment,
            allowCleartext: true,
          },
        );
        expect(await leasesOf(w)).toBeUndefined();
        await gcOrphanGenerations(SEG, { storage: w.storage, registry: w.registry });
      } else {
        await dropSegment(
          SEG,
          { storage: w.storage, registry: w.registry },
          {
            confirmSegment: SEG.segment,
          },
        );
      }
      expect(await generations(w.memory)).toEqual([]);
    }
  });

  it('a retention policy does not touch the list, and the segment still retires when it falls due', async () => {
    const w = world();
    await loadMany(w, 2, { keep: 2 });
    await putLeases(w, [lease(1, 0, w.clock.t + 10_000_000)]);
    await setSegmentRetention(SEG, { registry: w.registry }, { expiresAt: T0 + 5 });
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(1)]);
    await dropSegment(SEG, { storage: w.storage, registry: w.registry }, { confirmSegment: 's' });
    expect(await generations(w.memory)).toEqual([]);
  });

  it('a rollback deletes nothing and keeps the list; a later load still spares the leased generation', async () => {
    const w = world();
    await loadMany(w, 4, { keep: 3 });
    await putLeases(w, [lease(1, 2, w.clock.t + 1_000_000)]);
    await rollbackSegment(SEG, 1, { storage: w.memory, registry: w.registry });
    expect((await leasesOf(w))?.map((x) => x.holder)).toEqual([H(1)]);
    expect(await generations(w.memory)).toEqual([0, 1, 2, 3]);
    (w.deps as { collectByListing?: boolean }).collectByListing = true;
    const r = await load(
      w,
      Array.from({ length: 20 }, (_, i) => i),
      { keep: 1 },
    );
    expect(r.published).toBe(true);
    expect(await generations(w.memory)).toContain(2);
  });

  it('a purged and re-created segment starts with no lease', async () => {
    const w = world();
    await loadMany(w, 2);
    await putLeases(w, [lease(1, 0, w.clock.t + 1000)]);
    await w.registry.delete(SEG);
    await w.registry.create(SEG, { currentGen: null });
    expect(await leasesOf(w)).toBeUndefined();
  });
});
