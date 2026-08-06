/**
 * Partition leases (ADR 83). Every test here maps to a claim in `24-ENGINE`, and the whole protocol is driven
 * through an injected clock — no timers, no sleeps, no flake. That determinism is the reason a lease protocol is
 * a reasonable thing for this project to own at all.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_NAMESPACE,
  MAX_PARTITIONS,
  MIN_LEASE_TTL_MS,
  MemoryRegistryDriver,
  drainRegistry,
  emptyLeaseState,
  leaseRef,
  leaseRenewIntervalMs,
  partitionOfLeaseRow,
  releaseAll,
  runLeaseCycle,
} from '@/index';
import { ValidationError } from '@/core/errors';
import type { LeaseDeps, LeaseState } from '@/index';

const TTL = 60_000;

/** A clock we advance by hand — every ordering below is exact rather than probable. */
function testClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: () => Promise.resolve(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deps(registry: MemoryRegistryDriver, clock: { now: () => number }): LeaseDeps {
  return { registry, clock: clock as LeaseDeps['clock'] };
}

/** One worker, carrying its own state across cycles exactly as the engine will. */
class Worker {
  state: LeaseState = emptyLeaseState();
  constructor(
    readonly owner: string,
    private readonly registry: MemoryRegistryDriver,
    private readonly clock: { now: () => number },
    private readonly partitions: number,
  ) {}

  async cycle() {
    const result = await runLeaseCycle(this.state, deps(this.registry, this.clock), {
      owner: this.owner,
      partitions: this.partitions,
      ttlMs: TTL,
    });
    this.state = result.state;
    return result;
  }

  async stop() {
    const released = await releaseAll(this.state, deps(this.registry, this.clock));
    this.state = emptyLeaseState();
    return released;
  }
}

describe('partition leases — claiming', () => {
  it('a lone worker takes every partition', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const w = new Worker('w1', registry, clock, 4);

    const result = await w.cycle();

    expect(result.held).toEqual([0, 1, 2, 3]);
    expect(result.claimed).toEqual([0, 1, 2, 3]);
    expect(result.workers).toBe(1);
    expect(result.target).toBe(4);
  });

  it('the lease row is a registry record with no Cold generation', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await new Worker('w1', registry, clock, 1).cycle();

    const row = await registry.get(leaseRef(0));
    expect(row).not.toBeNull();
    expect(row?.currentGen).toBeNull();
    expect(row?.leaseOwner).toBe('w1');
    expect(row?.namespace).toBe(LEASE_NAMESPACE);
  });

  it('two workers split the partitions and neither holds the same one', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const a = new Worker('a', registry, clock, 4);
    const b = new Worker('b', registry, clock, 4);

    await a.cycle(); // a is alone, takes all four
    await b.cycle(); // b sees a live owner: W=2, target=2, but nothing is free yet — it steals ONE
    await a.cycle();
    await b.cycle();
    await a.cycle();
    await b.cycle();

    const held = new Set([...a.state.held.keys(), ...b.state.held.keys()]);
    expect(held.size).toBe(a.state.held.size + b.state.held.size); // disjoint
    expect(b.state.held.size).toBeGreaterThan(0);
  });

  it('converges to ceil(P/W) — six workers, eight partitions', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const workers = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(
      (o) => new Worker(o, registry, clock, 8),
    );

    for (let round = 0; round < 12; round++) {
      for (const w of workers) await w.cycle();
      clock.advance(leaseRenewIntervalMs(TTL));
    }

    const counts = workers.map((w) => w.state.held.size);
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBe(8); // every partition owned exactly once
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(8 / 6)); // nobody over their share
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1); // and nobody starved
  });

  it('leaves free partitions for other workers instead of hoarding them', async () => {
    // The fair share must bind on the CLAIM path, not only on the steal path: a worker that finds three free
    // rows while another worker is live may take its share and no more. Without this case, removing the
    // `held.size >= target` guard entirely passes the suite — mutation testing found exactly that hole.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const a = new Worker('a', registry, clock, 4);
    const b = new Worker('b', registry, clock, 4);
    const c = new Worker('c', registry, clock, 4);

    await a.cycle(); // alone: takes all four
    await b.cycle(); // steals one → a:3, b:1
    expect(b.state.held.size).toBe(1);
    await a.stop(); // three rows are now free, b is still live

    const result = await c.cycle();

    expect(result.workers).toBe(2); // b and c
    expect(result.target).toBe(2); // ceil(4/2)
    expect(result.claimed).toHaveLength(2); // NOT all three
    expect(result.held).toHaveLength(2);
  });

  it('steals at most one partition per cycle — the anti-thrash rule', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const a = new Worker('a', registry, clock, 8);
    const b = new Worker('b', registry, clock, 8);

    await a.cycle();
    expect(a.state.held.size).toBe(8);

    const first = await b.cycle();
    expect(first.stolen).toHaveLength(1);
    expect(first.claimed).toHaveLength(0);
  });
});

describe('partition leases — liveness is the token, not the clock', () => {
  it('a renewing holder is never stolen from by an observer whose clock is a day fast', async () => {
    // The two workers run on SEPARATE, SKEWED clocks — the whole point. An earlier version of this test shared
    // one clock between them, which meant it could not fail when staleness was decided by the wall clock:
    // both sides read the same `now`, so no skew existed to expose. Mutation testing caught that.
    const holderClock = testClock();
    const observerClock = testClock(1_700_000_000_000 + 24 * 60 * 60 * 1000); // a full day fast
    const registry = new MemoryRegistryDriver({ now: holderClock.now });

    const holder = new Worker('holder', registry, holderClock, 1);
    const observer = new Worker('observer', registry, observerClock, 1);

    await holder.cycle();
    await observer.cycle(); // first sighting, on the observer's own (fast) clock

    // Every `leaseExpiresAt` the holder writes is ~a day in the observer's past, so a wall-clock comparison
    // would declare the lease dead on every single cycle. The token keeps moving, so it must not.
    for (let i = 0; i < 5; i++) {
      holderClock.advance(leaseRenewIntervalMs(TTL));
      observerClock.advance(leaseRenewIntervalMs(TTL));
      await holder.cycle();
      const result = await observer.cycle();
      expect(result.held).toEqual([]);
      expect(result.stolen).toEqual([]);
      expect(result.claimed).toEqual([]);
    }
    expect(holder.state.held.size).toBe(1);
  });

  it('a holder that stops renewing is stolen from after one TTL', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const dead = new Worker('dead', registry, clock, 1);
    const taker = new Worker('taker', registry, clock, 1);

    await dead.cycle();
    await taker.cycle(); // sighting recorded, nothing taken
    expect(taker.state.held.size).toBe(0);

    clock.advance(TTL - 1);
    expect((await taker.cycle()).held).toEqual([]); // one ms short — still alive as far as we know

    clock.advance(1);
    const result = await taker.cycle();
    expect(result.held).toEqual([0]);
    expect(result.claimed).toEqual([0]);
  });

  it('the victim of a steal learns on its next renew and reports the loss', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const dead = new Worker('dead', registry, clock, 1);
    const taker = new Worker('taker', registry, clock, 1);

    await dead.cycle();
    await taker.cycle();
    clock.advance(TTL);
    await taker.cycle(); // taker steals

    const result = await dead.cycle();
    expect(result.lost).toEqual([0]);
    expect(result.held).toEqual([]);
  });

  it('a woken-up straggler cannot renew with its stale token — the CAS refuses', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const paused = new Worker('paused', registry, clock, 1);
    const taker = new Worker('taker', registry, clock, 1);

    await paused.cycle();
    const staleToken = paused.state.held.get(0);
    await taker.cycle();
    clock.advance(TTL);
    await taker.cycle();

    // The paused worker's token is exactly what compaction would carry into its SWAP. It must not apply.
    await expect(
      registry.compareAndSwap(leaseRef(0), staleToken!, { leaseOwner: 'paused' }),
    ).rejects.toThrow();
  });
});

describe('partition leases — release', () => {
  it('a graceful release short-circuits the TTL for the next worker', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const leaving = new Worker('leaving', registry, clock, 1);
    const next = new Worker('next', registry, clock, 1);

    await leaving.cycle();
    await next.cycle();
    expect(next.state.held.size).toBe(0);

    expect(await leaving.stop()).toEqual([0]);

    // No clock advance at all: an unowned row is claimable immediately.
    const result = await next.cycle();
    expect(result.held).toEqual([0]);
  });

  it('a worker reclaims a lease its own owner id abandoned across a restart', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await new Worker('same-id', registry, clock, 1).cycle();

    const restarted = new Worker('same-id', registry, clock, 1); // fresh state, same identity
    const result = await restarted.cycle();

    expect(result.held).toEqual([0]);
    expect(result.claimed).toEqual([0]);
  });

  it('shrinking the partition count releases the leases that fall outside it', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const w = new Worker('w', registry, clock, 4);
    await w.cycle();
    expect(w.state.held.size).toBe(4);

    const shrunk = await runLeaseCycle(w.state, deps(registry, clock), {
      owner: 'w',
      partitions: 2,
      ttlMs: TTL,
    });

    expect(shrunk.held).toEqual([0, 1]);
    expect(shrunk.lost).toEqual(expect.arrayContaining([2, 3]));
    expect((await registry.get(leaseRef(3)))?.leaseOwner).toBeUndefined();
  });
});

describe('partition leases — the reserved namespace is not a segment', () => {
  it('an unscoped fleet drain does not see lease rows', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await registry.create({ namespace: 'prod', segment: 'vips' }, { currentGen: 0 });
    await new Worker('w', registry, clock, 4).cycle();

    const rows = await drainRegistry(registry, { maxScanSegments: 1000, op: 'test' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.segment).toBe('vips');
  });

  it('a scan explicitly scoped to the lease namespace still sees them', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await new Worker('w', registry, clock, 3).cycle();

    const rows = await drainRegistry(registry, {
      namespace: LEASE_NAMESPACE,
      maxScanSegments: 1000,
      op: 'test',
    });

    expect(rows).toHaveLength(3);
  });

  it('ignores a foreign row in the reserved namespace rather than adopting it', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await registry.create(
      { namespace: LEASE_NAMESPACE, segment: 'not-a-partition' },
      { currentGen: 0 },
    );

    const result = await new Worker('w', registry, clock, 1).cycle();

    expect(result.held).toEqual([0]);
    expect(
      (await registry.get({ namespace: LEASE_NAMESPACE, segment: 'not-a-partition' }))?.leaseOwner,
    ).toBeUndefined();
  });

  it('parses only the names we write', () => {
    expect(partitionOfLeaseRow('p0')).toBe(0);
    expect(partitionOfLeaseRow('p42')).toBe(42);
    expect(partitionOfLeaseRow('p01')).toBeNull(); // no leading zeros — one name per partition
    expect(partitionOfLeaseRow('p')).toBeNull();
    expect(partitionOfLeaseRow('px')).toBeNull();
    expect(partitionOfLeaseRow('vips')).toBeNull();
    expect(partitionOfLeaseRow('p-1')).toBeNull();
  });

  it('the reserved namespace obeys the locked name grammar', () => {
    expect(LEASE_NAMESPACE).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
    expect(LEASE_NAMESPACE).not.toContain('..');
  });
});

describe('partition leases — validation', () => {
  const clock = testClock();
  const registry = new MemoryRegistryDriver({ now: clock.now });

  it('refuses an empty owner', async () => {
    await expect(
      runLeaseCycle(emptyLeaseState(), deps(registry, clock), { owner: '' }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a partition count outside [1, MAX_PARTITIONS]', async () => {
    for (const partitions of [0, -1, 1.5, MAX_PARTITIONS + 1]) {
      await expect(
        runLeaseCycle(emptyLeaseState(), deps(registry, clock), { owner: 'w', partitions }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it('refuses a TTL below the floor, where a GC pause reads as death', async () => {
    await expect(
      runLeaseCycle(emptyLeaseState(), deps(registry, clock), {
        owner: 'w',
        ttlMs: MIN_LEASE_TTL_MS - 1,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('renews three times per TTL, so one lost round trip is survivable', () => {
    expect(leaseRenewIntervalMs(TTL)).toBe(20_000);
    expect(leaseRenewIntervalMs()).toBe(Math.floor(DEFAULT_LEASE_TTL_MS / 3));
  });
});
