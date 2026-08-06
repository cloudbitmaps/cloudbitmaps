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
  MemoryWarmDriver,
  drainRegistry,
  findCompactable,
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
    const { released, state } = await releaseAll(this.state, deps(this.registry, this.clock));
    this.state = state; // the API returns the emptied state — the caller must not have to know to reset it
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

describe('partition leases — a late joiner must not starve', () => {
  it('a worker joining a CONVERGED fleet acquires its share', async () => {
    // The defect this guards, found by adversarial review and reproduced before the fix: stealing only from an
    // owner strictly over the CEILING is a stable fixed point. With P=4 and W=3 the ceiling is 2, both
    // incumbents hold exactly 2, and a newcomer holding 0 finds no eligible victim — forever. Measured at 50
    // cycles: a=2 b=2 c=0. The whole point of the feature is that a process you start does work.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const a = new Worker('a', registry, clock, 4);
    const b = new Worker('b', registry, clock, 4);

    for (let round = 0; round < 6; round++) {
      await a.cycle();
      await b.cycle();
      clock.advance(leaseRenewIntervalMs(TTL));
    }
    expect(a.state.held.size + b.state.held.size).toBe(4); // converged before c exists

    const c = new Worker('c', registry, clock, 4);
    for (let round = 0; round < 6; round++) {
      for (const w of [a, b, c]) await w.cycle();
      clock.advance(leaseRenewIntervalMs(TTL));
    }

    expect(c.state.held.size).toBeGreaterThanOrEqual(1);
    expect(a.state.held.size + b.state.held.size + c.state.held.size).toBe(4);
  });

  it('a staggered rollout leaves nobody idle — six workers, eight partitions', async () => {
    // The realistic shape of the same bug: workers appearing one at a time, as a deployment scales. Before the
    // fix this ended [2,2,2,2,0,0] — two of six processes permanently doing nothing.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const workers: Worker[] = [];

    for (let round = 0; round < 36; round++) {
      if (round % 3 === 0 && workers.length < 6) {
        workers.push(new Worker(`w${workers.length}`, registry, clock, 8));
      }
      for (const w of workers) await w.cycle();
      clock.advance(leaseRenewIntervalMs(TTL));
    }

    const counts = workers.map((w) => w.state.held.size);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(8);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  });

  it('a balanced fleet does not oscillate — no steals once converged', async () => {
    // The other half of the trade: stealing from anyone above the FLOOR converges instantly and then ping-pongs
    // forever (a worker with 1 takes from a worker with 2, which takes it back). P=8/W=6 is the case where the
    // floor and the ceiling differ, so it is where oscillation would show.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const workers = [0, 1, 2, 3, 4, 5].map((i) => new Worker(`w${i}`, registry, clock, 8));

    for (let round = 0; round < 15; round++) {
      for (const w of workers) await w.cycle();
      clock.advance(leaseRenewIntervalMs(TTL));
    }

    let steals = 0;
    for (let round = 0; round < 10; round++) {
      for (const w of workers) steals += (await w.cycle()).stolen.length;
      clock.advance(leaseRenewIntervalMs(TTL));
    }
    expect(steals).toBe(0);
  });

  it('picks the MOST loaded eligible owner as the victim', async () => {
    // Needs TWO owners simultaneously over the floor with different counts — otherwise "first eligible" and
    // "most loaded" are the same choice and the test cannot tell them apart. Mutation testing caught that: an
    // earlier version left `light` holding 1, which is below the floor and therefore never eligible.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const heavy = new Worker('heavy', registry, clock, 8);
    const middle = new Worker('middle', registry, clock, 8);

    await heavy.cycle(); // 8
    for (let i = 0; i < 3; i++) {
      await middle.cycle(); // one steal per cycle → heavy 5, middle 3
      clock.advance(leaseRenewIntervalMs(TTL));
      await heavy.cycle();
    }
    expect(heavy.state.held.size).toBe(5);
    expect(middle.state.held.size).toBe(3);

    // W=3 → floor 2, ceiling 3. Both heavy (5) and middle (3) are over the floor, so both are eligible and the
    // choice is observable.
    const thief = new Worker('thief', registry, clock, 8);
    const result = await thief.cycle();

    expect(result.stolen).toHaveLength(1);
    expect(heavy.state.held.has(result.stolen[0]!)).toBe(true);
    expect(middle.state.held.has(result.stolen[0]!)).toBe(false);
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

  it('an observer polling SLOWER than the TTL still does not steal from a live holder', async () => {
    // This pins the load-bearing conjunct `previous.token === row.token`. Every other test polls at TTL/3, so
    // deleting that conjunct and keeping only the elapsed-time check survived the whole suite: the gap never
    // exceeded the TTL for a live holder. Here the observer's gap is 15 renew intervals.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const holder = new Worker('holder', registry, clock, 1);
    const observer = new Worker('observer', registry, clock, 1);

    await holder.cycle();
    await observer.cycle();

    for (let round = 0; round < 3; round++) {
      for (let renew = 0; renew < 15; renew++) {
        clock.advance(leaseRenewIntervalMs(TTL));
        await holder.cycle(); // on time, every time
      }
      const result = await observer.cycle(); // its own gap is 15 intervals — five TTLs
      expect(result.held).toEqual([]);
      expect(result.claimed).toEqual([]);
      expect(result.sinceLastCycleMs).toBeGreaterThan(TTL); // the misconfiguration IS reported
    }
    expect(holder.state.held.size).toBe(1);
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

  it('a restart under the SAME owner id waits one TTL rather than reclaiming instantly', async () => {
    // An earlier version treated any row bearing our own id as free — "a lease we abandoned across a restart".
    // That is catastrophic when two live processes share an id, so the shortcut is gone and a same-id restart
    // pays one TTL. See the shared-id test below for what the shortcut actually did.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await new Worker('same-id', registry, clock, 1).cycle();

    const restarted = new Worker('same-id', registry, clock, 1);
    expect((await restarted.cycle()).held).toEqual([]); // observed, not taken

    clock.advance(TTL);
    expect((await restarted.cycle()).held).toEqual([0]); // stale by the token rule → taken
  });

  it('two live processes sharing an owner id no longer produce duplicated ownership', async () => {
    // The regression this guards: with the old same-id shortcut, each process took the other's live leases every
    // cycle using a FRESH token, so both ended every cycle reporting held=[0,1] — duplicated ownership,
    // affirmatively reported by the API — and the same partition then appeared in `held` AND `lost` in one
    // result. A hostname is per-HOST, not per-process, so this is not an exotic misconfiguration.
    //
    // What IS still expected, and is property 2 rather than a defect: a steal takes a LIVE lease and the victim
    // only learns at its next renew. So the invariant is checked once both sides have polled — not instantly.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const a = new Worker('samehost', registry, clock, 2);
    const b = new Worker('samehost', registry, clock, 2);

    for (let round = 0; round < 5; round++) {
      for (const r of [await a.cycle(), await b.cycle(), await a.cycle(), await b.cycle()]) {
        // Within ONE result these must be disjoint: `lost` means "stop work on these now" and `held` means
        // "this is your slice", so a partition in both is a contradiction the caller cannot act on.
        expect(r.held.filter((x) => r.lost.includes(x))).toEqual([]);
      }
      // Both sides have now renewed, so at most one of them still believes it holds any given partition.
      expect([...a.state.held.keys()].filter((x) => b.state.held.has(x))).toEqual([]);
      // And neither ends up holding everything — which is what the old shortcut produced on every cycle.
      expect(a.state.held.size).toBeLessThan(2);
      clock.advance(leaseRenewIntervalMs(TTL));
    }
  });

  it('releaseAll hands back the emptied state, so a trailing cycle cannot re-take everything', async () => {
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const w = new Worker('w', registry, clock, 2);
    await w.cycle();

    const { released, state } = await releaseAll(w.state, deps(registry, clock));

    expect(released).toEqual([0, 1]);
    expect(state.held.size).toBe(0);
    // A shutdown path that lets one in-flight cycle finish must not resurrect the leases it just gave up.
    const trailing = await runLeaseCycle(state, deps(registry, clock), {
      owner: 'w',
      partitions: 2,
      ttlMs: TTL,
    });
    expect(trailing.lost).toEqual([]);
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

  it('does not adopt a real segment that happens to be named like a partition', async () => {
    // A row named `p0` in the reserved namespace but carrying a Cold generation is somebody's data. Stamping a
    // lease on it would make it un-compactable (every compaction CAS would race a renew every ttl/3) and
    // invisible to every unscoped drain. The earlier test only covered the NAME guard, which read as though
    // foreign rows were protected in general — they were not.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    await registry.create(leaseRef(0), { currentGen: 7 });

    const result = await new Worker('w', registry, clock, 1).cycle();

    expect(result.held).toEqual([]);
    const row = await registry.get(leaseRef(0));
    expect(row?.currentGen).toBe(7);
    expect(row?.leaseOwner).toBeUndefined();
  });

  it('compaction discovery does not scan warm chunks for lease rows', async () => {
    // Half the CHANGELOG's "Changed" section had no test. And the filter's value is NOT that it changes the
    // candidate list — it cannot, since `threshold` has a floor of 1 and a lease row always has 0 dirty chunks.
    // Its value is that discovery drains `warm.listChunks` for EVERY known row before applying the threshold,
    // so without the filter every partition costs one wasted warm scan per cycle: 1,024 of them at
    // MAX_PARTITIONS. That is the reachable effect, so that is what this asserts.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const warm = new MemoryWarmDriver();
    const scanned: string[] = [];
    const countingWarm = {
      get: warm.get.bind(warm),
      putConditional: warm.putConditional.bind(warm),
      deleteConditional: warm.deleteConditional.bind(warm),
      listChunks: (ref: { namespace?: string; segment: string }) => {
        scanned.push(`${ref.namespace ?? ''}/${ref.segment}`);
        return warm.listChunks(ref);
      },
    } as unknown as MemoryWarmDriver;

    await registry.create({ namespace: 'prod', segment: 'vips' }, { currentGen: 0 });
    await new Worker('w', registry, clock, 4).cycle();

    await findCompactable({ registry, warm: countingWarm, clock });

    expect(scanned).toEqual(['prod/vips']);
    expect(scanned.filter((s) => s.startsWith(LEASE_NAMESPACE))).toEqual([]);
  });

  it('a release that loses its CAS is not an error', async () => {
    // The documented "best-effort by design" on the graceful-shutdown path was entirely unverified.
    const clock = testClock();
    const registry = new MemoryRegistryDriver({ now: clock.now });
    const w = new Worker('w', registry, clock, 1);
    await w.cycle();

    // Somebody else writes the row, invalidating our token.
    const row = await registry.get(leaseRef(0));
    await registry.compareAndSwap(leaseRef(0), row!.token, { leaseOwner: 'thief' });

    const { released, state } = await releaseAll(w.state, deps(registry, clock));
    expect(released).toEqual([]); // nothing we could release
    expect(state.held.size).toBe(0); // but the state is still cleared
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
