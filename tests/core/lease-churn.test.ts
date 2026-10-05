import { destroySegment, dropSegment } from '@cloudbitmaps/core';
import { eraseIdFromSegment } from '@/core/erase-id';
import { WriteConflictError, NotFoundError } from '@/core/errors';
import {
  LEASE_ONLY_RETRIES,
  MAX_LEASES_PER_SEGMENT,
  leaseChurn,
  onlyLeasesDiffer,
  releaseLease,
  takeLease,
} from '@/core/leases';
import { loadSegment } from '@/core/load';
import type {
  IRegistryDriver,
  IStorageDriver,
  LeaseEntry,
  RegistryRecord,
  SegmentRef,
} from '@/core/ports';
import { clearSegmentRetention, setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import type { Clock } from '@/core/determinism';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';

/**
 * Readers write a segment's leases, in numbers no operator controls, and every lease write moves the row's token. A
 * writer fenced on that token must not be starved by it: a row that differs from the one the writer read only in its
 * leases does not refuse it, and the writer goes on against the row it finds, without redoing its work. A change to
 * anything else refuses exactly as it always has.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = MIN_EXPIRES_AT_MS * 2;
const H = (n: number): string => n.toString(16).padStart(16, '0');
const FAR = T0 * 2;
/** A token in the incarnation form: 32 hex digits of incarnation, a counter, a write part. */
const INC = '0123456789abcdef0123456789abcdef';
const tokenOf = (inc: string, n: number): string => `${inc}.${n}.fedcba987654321${n}`;

function world() {
  const t = { now: T0 };
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t.now,
    sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()),
  };
  const memory = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver({ now: () => t.now });
  const storageCalls: Record<string, number> = {};
  const storage = counting<IStorageDriver>(memory, storageCalls);
  return { t, clock, sleeps, memory, registry, storage, storageCalls };
}
type W = ReturnType<typeof world>;

const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

async function loadN(
  w: W,
  count: number,
  make: (g: number) => number[] = (g) => ids(g + 3),
): Promise<void> {
  for (let g = 0; g < count; g++) {
    await loadSegment(
      SEG,
      make(g),
      { storage: w.storage, registry: w.registry, codec: roaringCodec, clock: w.clock },
      {
        keep: 5,
      },
    );
  }
}

/** One write of the row that changes only its leases, as a reader's take or release does. */
async function leaseWrite(w: W, n = 1): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  const entry: LeaseEntry = { holder: H(n), generation: row.currentGen ?? 0, until: FAR };
  await w.registry.compareAndSwap(SEG, row.token, {
    leases: row.leases === undefined ? [entry] : undefined,
  });
}

/** One write of the row that changes something else: a retention policy. */
async function otherWrite(w: W, nth: number): Promise<void> {
  const row = (await w.registry.get(SEG))!;
  await w.registry.compareAndSwap(SEG, row.token, { retention: { expiresAt: FAR + nth } });
}

/** `registry`, with `before` awaited ahead of each call of `method` for which `when(callIndex)` holds. */
function hooked(
  registry: IRegistryDriver,
  method: 'compareAndSwap' | 'get',
  when: (nth: number) => boolean,
  before: (nth: number) => Promise<void>,
  seen: { calls: number } = { calls: 0 },
): IRegistryDriver {
  return new Proxy(registry, {
    get(t, p, rx) {
      const v: unknown = Reflect.get(t, p, rx);
      if (typeof v !== 'function') return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(t);
      if (p !== method) return fn;
      return async (...a: unknown[]) => {
        const nth = seen.calls++;
        if (when(nth)) await before(nth);
        return fn(...a);
      };
    },
  }) as IRegistryDriver;
}

describe('onlyLeasesDiffer', () => {
  const base: RegistryRecord = {
    namespace: 'ns',
    segment: 's',
    currentGen: 3,
    status: 'active',
    keptGens: [1, 2],
    summary: { generation: 3, cardinality: 5 },
    retention: { expiresAt: 5 },
    createdAt: 1,
    updatedAt: 1,
    token: tokenOf(INC, 0),
  } as RegistryRecord;
  const next = (over: Partial<RegistryRecord>): RegistryRecord =>
    ({
      ...base,
      token: tokenOf(INC, 1),
      updatedAt: 9,
      ...over,
    }) as RegistryRecord;

  it('is true for a row whose leases, token and update time moved and nothing else', () => {
    expect(onlyLeasesDiffer(base, next({}))).toBe(true);
    expect(
      onlyLeasesDiffer(base, next({ leases: [{ holder: H(1), generation: 3, until: 5 }] })),
    ).toBe(true);
  });

  it.each([
    ['the pointer', { currentGen: 4 }],
    ['the kept window', { keptGens: [2] }],
    ['the summary', { summary: { generation: 3, cardinality: 6 } }],
    ['a retention policy', { retention: { expiresAt: 6 } }],
    ['the status', { status: 'destroyed' as const }],
    ['the key wrappings', { wrappedDeks: [{ keyId: 'k', wrapped: 'AA==' }] }],
    ['the residency', { residency: { region: 'x' } }],
  ])('is false when %s changed', (_name, over) => {
    expect(onlyLeasesDiffer(base, next(over as Partial<RegistryRecord>))).toBe(false);
  });

  it('is false for another incarnation, and ignores what the caller says its own write moved', () => {
    expect(
      onlyLeasesDiffer(base, next({ token: tokenOf('ffffffffffffffffffffffffffffffff', 0) })),
    ).toBe(false);
    expect(onlyLeasesDiffer(base, next({ currentGen: 4 }), ['currentGen'])).toBe(true);
  });
});

describe('the retry is bounded, and waits with a jitter', () => {
  it('goes on for the bound and then reports the original refusal', async () => {
    const churn = leaseChurn({});
    const a = {
      currentGen: 1,
      createdAt: 1,
      token: tokenOf(INC, 0),
    } as RegistryRecord;
    const b = {
      ...a,
      token: tokenOf(INC, 1),
    } as RegistryRecord;
    for (let i = 0; i < LEASE_ONLY_RETRIES; i++) expect(await churn.retry(a, b)).toBe(true);
    expect(await churn.retry(a, b)).toBe(false);
  });

  it('waits a jittered time that grows and stops growing, on the injected clock', async () => {
    const waits: number[] = [];
    const churn = leaseChurn({
      clock: { sleep: (ms: number) => (waits.push(ms), Promise.resolve()) },
      rng: { next: () => 0.999999 },
    });
    const a = {
      currentGen: 1,
      createdAt: 1,
      token: tokenOf(INC, 0),
    } as RegistryRecord;
    const b = {
      ...a,
      token: tokenOf(INC, 1),
    } as RegistryRecord;
    for (let i = 0; i < 8; i++) await churn.retry(a, b);
    expect(waits.slice(0, 5)).toEqual([24, 49, 99, 199, 399]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(400);
  });

  it('is derived from the cap: a take and a release by every holder the row can hold, and a few more', () => {
    expect(LEASE_ONLY_RETRIES).toBe(2 * MAX_LEASES_PER_SEGMENT + 8);
  });
});

describe('a lease write during a writer fenced on the row token does not starve it', () => {
  it('(a) an erasure rewrite lands, and does not stream its object again', async () => {
    const w = world();
    await loadN(w, 1, () => [5, 6, 7]);
    w.storageCalls.putImmutable = 0;
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n < 20,
      () => leaseWrite(w, 1).then(() => leaseWrite(w, 1)),
    );
    const res = await eraseIdFromSegment(SEG, 7, {
      storage: w.storage,
      registry: racing,
      codec: roaringCodec,
      clock: w.clock,
    });
    expect(res).toMatchObject({ erased: true, generation: 1 });
    expect(w.storageCalls.putImmutable).toBe(1);
    expect(w.sleeps.length).toBeGreaterThan(0);
  });

  it('(a) and a change of anything else refuses it as it always has', async () => {
    const w = world();
    await loadN(w, 1, () => [5, 6, 7]);
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n === 0,
      () => otherWrite(w, 1),
    );
    const res = await eraseIdFromSegment(SEG, 7, {
      storage: w.storage,
      registry: racing,
      codec: roaringCodec,
      clock: w.clock,
    });
    expect(res).toMatchObject({ erased: false, reason: 'superseded' });
  });

  it('(b) the delete loop above the pointer goes on past lease writes, and every holder is deleted', async () => {
    const w = world();
    await loadN(w, 3, (g) => (g === 0 ? [5, 6] : [5, 6, 7])); // 0 is clean; 1 and 2 hold 7
    await rollbackSegment(SEG, 0, { storage: w.memory, registry: w.registry }); // 1 and 2 are above the pointer
    let churned = 0;
    const racing = hooked(
      w.registry,
      'get',
      () => true,
      async () => {
        if (churned++ < 30) await leaseWrite(w, 2);
      },
    );
    const res = await eraseIdFromSegment(SEG, 7, {
      storage: w.storage,
      registry: racing,
      codec: roaringCodec,
      clock: w.clock,
    });
    expect(res.erased).toBe(true);
    const left: number[] = [];
    for await (const k of w.memory.list(SEG)) left.push(k.generation);
    expect(left.filter((g) => g !== 0)).toEqual([]);
  });

  it('(b) and a change of anything else stops that loop as it always has', async () => {
    const w = world();
    await loadN(w, 3, (g) => (g === 0 ? [5, 6] : [5, 6, 7]));
    await rollbackSegment(SEG, 0, { storage: w.memory, registry: w.registry });
    let n = 0;
    const racing = hooked(
      w.registry,
      'get',
      () => true,
      async () => {
        if (n++ === 3) await otherWrite(w, 1);
      },
    );
    const res = await eraseIdFromSegment(SEG, 7, {
      storage: w.storage,
      registry: racing,
      codec: roaringCodec,
      clock: w.clock,
    });
    expect(res.erased).toBe(false);
  });

  it('(c) a load publishes, with its object written once', async () => {
    const w = world();
    await loadN(w, 2);
    w.storageCalls.putImmutable = 0;
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n < 20,
      () => leaseWrite(w, 3),
    );
    const r = await loadSegment(
      SEG,
      ids(30),
      { storage: w.storage, registry: racing, codec: roaringCodec, clock: w.clock },
      {
        keep: 5,
      },
    );
    expect(r).toMatchObject({ published: true, generation: 2 });
    expect(w.storageCalls.putImmutable).toBe(1);
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
  });

  it('(c) and a change of anything else refuses it, and it deletes nothing of another incarnation', async () => {
    const w = world();
    await loadN(w, 2);
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n === 0,
      () => otherWrite(w, 1),
    );
    const r = await loadSegment(
      SEG,
      ids(30),
      { storage: w.storage, registry: racing, codec: roaringCodec, clock: w.clock },
      {
        keep: 5,
      },
    );
    expect(r).toMatchObject({ published: false, reason: 'superseded' });
  });

  it('(c) a refused load reclaims its object when only leases changed, and not when anything else did', async () => {
    const w = world();
    await loadN(w, 2);
    // Another load takes the pointer: refused. A lease write came first, so the row it finds differs in more than leases.
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n === 0,
      async () => {
        await leaseWrite(w, 1);
        await loadN(w, 1);
      },
    );
    const r = await loadSegment(
      SEG,
      ids(40),
      { storage: w.storage, registry: racing, codec: roaringCodec, clock: w.clock },
      {
        keep: 5,
      },
    );
    expect(r.published).toBe(false);
  });

  it('(c) a load refused by its guard reclaims its object through lease writes, which are not another writer', async () => {
    const w = world();
    await loadN(w, 2);
    const racing = hooked(
      w.registry,
      'get',
      (n) => n >= 1,
      () => leaseWrite(w, 3),
    );
    const r = await loadSegment(SEG, [], {
      storage: w.storage,
      registry: racing,
      codec: roaringCodec,
      clock: w.clock,
    });
    expect(r).toMatchObject({ published: false, reason: 'empty' });
    const left: number[] = [];
    for await (const k of w.memory.list(SEG)) left.push(k.generation);
    expect(left.sort()).toEqual([0, 1]);
  });

  it('(d) destroySegment completes through more lease writes than its 8 attempts', async () => {
    const w = world();
    await loadN(w, 1);
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n < 40,
      () => leaseWrite(w, 4),
    );
    const res = await destroySegment(
      SEG,
      { registry: racing, clock: w.clock },
      { confirmSegment: 's', allowCleartext: true },
    );
    expect(res.destroyed).toBe(true);
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');
  });

  it('(d) and a permanently changing field still ends in the conflict, in the 8 attempts it always had', async () => {
    const w = world();
    await loadN(w, 1);
    const seen = { calls: 0 };
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      () => true,
      () => otherWrite(w, seen.calls),
      seen,
    );
    await expect(
      destroySegment(
        SEG,
        { registry: racing, clock: w.clock },
        { confirmSegment: 's', allowCleartext: true },
      ),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(seen.calls).toBe(8);
  });

  it('(d) and a permanent lease flood ends in the conflict after the bound, not before and not never', async () => {
    const w = world();
    await loadN(w, 1);
    const seen = { calls: 0 };
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      () => true,
      () => leaseWrite(w, 5),
      seen,
    );
    await expect(
      destroySegment(
        SEG,
        { registry: racing, clock: w.clock },
        { confirmSegment: 's', allowCleartext: true },
      ),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(seen.calls).toBe(LEASE_ONLY_RETRIES + 8);
  });

  it('(e) dropSegment completes, and deletes the generations', async () => {
    const w = world();
    await loadN(w, 3);
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n < 40,
      () => leaseWrite(w, 6),
    );
    const res = await dropSegment(
      SEG,
      { registry: racing, storage: w.storage, clock: w.clock },
      { confirmSegment: 's' },
    );
    expect(res.dropped).toBe(true);
    const left: number[] = [];
    for await (const k of w.memory.list(SEG)) left.push(k.generation);
    expect(left).toEqual([]);
  });

  it('(f) a rollback swaps through lease writes, and its undo puts the pointer back through them', async () => {
    const w = world();
    await loadN(w, 4);
    let phase: 'swap' | 'undo' | 'done' = 'swap';
    let lists = 0;
    const storage = new Proxy(w.memory, {
      get(t, p, rx) {
        const v: unknown = Reflect.get(t, p, rx);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => unknown).bind(t);
        if (p !== 'list') return fn;
        // The second listing is the verify of the target's object: it has been collected meanwhile.
        return (...a: unknown[]) =>
          (async function* () {
            if (++lists === 2) {
              phase = 'undo';
              await t.delete({ ...SEG, generation: 1 });
            }
            yield* fn(...a) as AsyncIterable<unknown>;
          })();
      },
    }) as IStorageDriver;
    // Lease writes ahead of the swap, and ahead of the undo, each in its own budget.
    const churned = { swap: 0, undo: 0 };
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      () => true,
      async () => {
        if (phase === 'done') return;
        const k = phase === 'swap' ? 'swap' : 'undo';
        if (churned[k]++ < 12) await leaseWrite(w, 7);
      },
    );
    const err = await rollbackSegment(SEG, 1, { storage, registry: racing, clock: w.clock }).catch(
      (e: unknown) => e,
    );
    phase = 'done';
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain('the pointer was put back');
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
  });

  it('(f) and an undo that meets another change leaves the pointer and says so', async () => {
    const w = world();
    await loadN(w, 4);
    let phase: 'swap' | 'undo' = 'swap';
    let lists = 0;
    const storage = new Proxy(w.memory, {
      get(t, p, rx) {
        const v: unknown = Reflect.get(t, p, rx);
        if (typeof v !== 'function') return v;
        const fn = (v as (...a: unknown[]) => unknown).bind(t);
        if (p !== 'list') return fn;
        // The second listing is the verify of the target's object: it has been collected meanwhile.
        return (...a: unknown[]) =>
          (async function* () {
            if (++lists === 2) {
              phase = 'undo';
              await t.delete({ ...SEG, generation: 1 });
            }
            yield* fn(...a) as AsyncIterable<unknown>;
          })();
      },
    }) as IStorageDriver;
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      () => phase === 'undo',
      () => otherWrite(w, 1),
    );
    const err = await rollbackSegment(SEG, 1, { storage, registry: racing, clock: w.clock }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain('the pointer may still name 1');
  });

  it('(g) setRetention and clearRetention complete through more lease writes than their 5 attempts', async () => {
    const w = world();
    await loadN(w, 1);
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n < 40,
      () => leaseWrite(w, 8),
    );
    await setSegmentRetention(SEG, { registry: racing, clock: w.clock }, { expiresAt: FAR });
    expect((await w.registry.get(SEG))!.retention).toMatchObject({ expiresAt: FAR });
    const again = hooked(
      w.registry,
      'compareAndSwap',
      (n) => n < 40,
      () => leaseWrite(w, 9),
    );
    await expect(clearSegmentRetention(SEG, { registry: again, clock: w.clock })).resolves.toBe(
      true,
    );
  });

  it('(g) and a permanently changing field still ends in the conflict after its 5 attempts', async () => {
    const w = world();
    await loadN(w, 1);
    const seen = { calls: 0 };
    const racing = hooked(
      w.registry,
      'compareAndSwap',
      () => true,
      () => otherWrite(w, seen.calls),
      seen,
    );
    await expect(
      setSegmentRetention(SEG, { registry: racing, clock: w.clock }, { expiresAt: FAR }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(seen.calls).toBe(5);
  });
});

describe('64 holders taking and releasing while a writer works', () => {
  /** Every holder takes a lease and releases it, `rounds` times, all at once. */
  async function holders(w: W, count: number, rounds: number): Promise<void> {
    await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const holder = H(1000 + i);
        for (let r = 0; r < rounds; r++) {
          const row = (await w.registry.get(SEG))!;
          // A holder that loses every one of its attempts to the others reports it and goes on, as a caller would.
          await takeLease(
            SEG,
            { registry: w.registry, clock: w.clock },
            {
              holder,
              generation: row.currentGen as number,
              until: w.t.now + 3_600_000,
              row,
              current: false,
            },
          ).catch((e: unknown) => {
            if (!(e instanceof WriteConflictError || e instanceof NotFoundError)) throw e;
          });
          await releaseLease(SEG, { registry: w.registry, clock: w.clock }, holder).catch(
            (e: unknown) => {
              if (!(e instanceof WriteConflictError || e instanceof NotFoundError)) throw e;
            },
          );
        }
      }),
    );
  }

  it('a load, a shred and a retention write each complete, inside the bound', async () => {
    for (const run of ['load', 'shred', 'retention'] as const) {
      const w = world();
      await loadN(w, 2);
      const seen = { calls: 0 };
      const counted = hooked(
        w.registry,
        'compareAndSwap',
        () => false,
        async () => undefined,
        seen,
      );
      const churn = holders(w, MAX_LEASES_PER_SEGMENT, 2);
      if (run === 'load') {
        const r = await loadSegment(
          SEG,
          ids(30),
          { storage: w.storage, registry: counted, codec: roaringCodec, clock: w.clock },
          { keep: 5 },
        );
        expect(r.published).toBe(true);
      } else if (run === 'shred') {
        await destroySegment(
          SEG,
          { registry: counted, clock: w.clock },
          { confirmSegment: 's', allowCleartext: true },
        );
        expect((await w.registry.get(SEG))!.status).toBe('destroyed');
      } else {
        await setSegmentRetention(SEG, { registry: counted, clock: w.clock }, { expiresAt: FAR });
      }
      await churn;
      expect(seen.calls, run).toBeLessThan(LEASE_ONLY_RETRIES);
    }
  });
});
