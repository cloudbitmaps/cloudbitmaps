/**
 * The engine loop's operational behaviour — every property the resilience audit asked for, asserted on a fake
 * clock rather than by waiting. That is the whole reason the loop lives in `core/`: "it worked when I ran it" is
 * not evidence for a background job, and a timer-based design could only be tested by sleeping.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVAL_MS,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  createEngineLoop,
  roaringCodec,
  type LifecycleDeps,
} from '@/index';
import { CloudRoaring } from '@/index';
import { ValidationError } from '@/core/errors';

const T0 = 1_754_000_000_000;

/**
 * A clock whose `sleep` resolves only when the test says so — the seam that makes the loop observable. A real
 * `setTimeout` would make every assertion below a race.
 */
function controllable(start = T0) {
  let t = start;
  let pending: { ms: number; resolve: () => void }[] = [];
  return {
    clock: {
      now: () => t,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          pending.push({ ms, resolve });
        }),
    },
    /**
     * Let the loop run until it is waiting on a sleep, WITHOUT releasing that sleep. Separating "let it get
     * there" from "let it continue" is what makes the sleep observable — a single combined helper released the
     * sleep it was supposed to be measuring.
     */
    async settle(times = 20): Promise<void> {
      for (let i = 0; i < times; i++) await Promise.resolve();
    },
    /** Release every sleep currently waiting, so the loop proceeds to its next cycle. */
    async release(): Promise<void> {
      const due = pending;
      pending = [];
      for (const p of due) p.resolve();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    /** Move the clock without releasing anything — for staleness assertions. */
    advance(ms: number): void {
      t += ms;
    },
    /** Advance and release: the ordinary "time passes" step. */
    async fire(ms = 0): Promise<void> {
      t += ms;
      await this.release();
    },
    sleepsRequested: () => pending.map((p) => p.ms),
    bump: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

/**
 * Wrap a registry, overriding one method. Spreading the instance would silently drop every prototype method and
 * turn a "slow registry" test into a "broken registry" test — which is exactly what happened, and the backoff
 * then made the assertion fail for the right reason about the wrong thing.
 */
function wrapRegistry(
  registry: MemoryRegistryDriver,
  overrides: Partial<Record<string, unknown>>,
): MemoryRegistryDriver {
  return {
    capabilities: registry.capabilities.bind(registry),
    get: registry.get.bind(registry),
    create: registry.create.bind(registry),
    compareAndSwap: registry.compareAndSwap.bind(registry),
    list: registry.list.bind(registry),
    delete: registry.delete.bind(registry),
    ...overrides,
  } as unknown as MemoryRegistryDriver;
}

function harness(rngValue = 0.5) {
  const c = controllable();
  const registry = new MemoryRegistryDriver({ now: c.clock.now });
  const warm = new MemoryWarmDriver();
  const cold = new MemoryColdDriver();
  const store = new CloudRoaring({ warm, cold, registry, clock: c.clock as never });
  const deps: LifecycleDeps & { rng?: { next: () => number } } = {
    warm,
    cold,
    registry,
    clock: c.clock as never,
    codec: roaringCodec,
    rng: { next: () => rngValue },
  };
  return { c, store, deps, registry };
}

describe('engine loop — runOnce', () => {
  it('runs exactly one cycle and resolves, with no timer involved', async () => {
    const { deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1' });

    const result = await loop.runOnce();

    expect(result.errors).toEqual([]);
    expect(loop.status().cyclesCompleted).toBe(1);
    expect(loop.status().running).toBe(false);
  });
});

describe('engine loop — status is alarmable', () => {
  it('is unhealthy before the first cycle: a process that has not completed one has not proved it can', () => {
    const { deps } = harness();
    expect(createEngineLoop(deps, { owner: 'w1' }).status().healthy).toBe(false);
  });

  it('becomes healthy after a cycle and unhealthy once it goes stale', async () => {
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000, staleAfterMs: 5000 });

    await loop.runOnce();
    expect(loop.status().healthy).toBe(true);

    c.advance(4999);
    expect(loop.status().healthy).toBe(true);
    c.advance(2);
    expect(loop.status().healthy).toBe(false); // the loop stopped doing work — the alarm condition
  });

  it('holding zero partitions is HEALTHY — it is what every worker beyond the first does', async () => {
    const { deps } = harness();
    const holder = createEngineLoop(deps, { owner: 'holder' });
    await holder.runOnce(); // takes the only partition

    const idle = createEngineLoop(deps, { owner: 'idle' });
    await idle.runOnce();

    expect(idle.status().partitionsHeld).toEqual([]);
    expect(idle.status().healthy).toBe(true);
    expect(idle.status().lastErrors).toEqual([]);
  });

  it('reports the scan used, so an operator can see the repair pass happen', async () => {
    const { deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1' });
    await loop.runOnce();
    expect(loop.status().lastScan).toBe('fleet'); // cycle 1 always repairs
  });
});

describe('engine loop — stop cannot deadlock', () => {
  it('a stop while a cycle is in flight resolves and releases leases', async () => {
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000 });
    const started = loop.start();
    await c.settle(); // let the first cycle settle

    const result = await loop.stop({ timeoutMs: 5000 });

    expect(result.drained).toBe(true);
    expect(result.released).toEqual([0]);
    await started;
    expect(loop.status().running).toBe(false);
  });

  it('a stop against a cycle that NEVER settles resolves at the timeout, reporting undrained', async () => {
    // The failure the audit named: nothing is cancellable, so an unconditional await here would be a deadlock
    // dressed as a graceful shutdown. `drained: false` is how the caller learns work was abandoned.
    const { c, deps } = harness();
    const hung = {
      ...deps,
      registry: { ...deps.registry, list: () => neverEnding() },
    } as LifecycleDeps;
    const loop = createEngineLoop(hung, { owner: 'w1', intervalMs: 1000 });
    void loop.start();
    await Promise.resolve();

    const stopPromise = loop.stop({ timeoutMs: 3000 });
    await c.fire(3000); // the stop timeout elapses; the cycle is still hanging
    const result = await stopPromise;

    expect(result.drained).toBe(false);
  });

  it('is idempotent — a second signal must not start a second shutdown', async () => {
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1' });
    void loop.start();
    await c.settle();

    const [a, b] = await Promise.all([loop.stop(), loop.stop()]);
    expect(a).toBe(b); // the same settled result, not two shutdowns
  });

  it('refuses a second start', async () => {
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1' });
    void loop.start();
    await c.settle();
    await expect(loop.start()).rejects.toThrow(ValidationError);
    await loop.stop();
  });
});

describe('engine loop — the sleep is wakeable', () => {
  it('a stop mid-interval does not wait out the interval', async () => {
    // The arithmetic that matters: a SIGTERM one second into a 30 s interval must not burn 29 s of a 30 s
    // termination grace period.
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 30_000, jitter: 0 });
    const started = loop.start();
    await c.settle(); // first cycle done; the loop is now sleeping and has NOT been released

    expect(c.sleepsRequested().length).toBeGreaterThan(0); // it really is asleep

    const before = c.now();
    await loop.stop({ timeoutMs: 5000 });
    await started;

    expect(c.now() - before).toBe(0); // no clock advance was needed to get out
  });
});

describe('engine loop — backoff and jitter', () => {
  it('doubles the wait while cycles keep failing, and caps it', async () => {
    const { c, deps } = harness(0.5); // jitterFactor(f) === 1 at rng 0.5
    const broken = {
      ...deps,
      registry: {
        ...deps.registry,
        list: () => {
          throw new Error('backend down');
        },
      },
    } as unknown as LifecycleDeps & { rng?: { next: () => number } };
    const loop = createEngineLoop(broken, {
      owner: 'w1',
      intervalMs: 1000,
      maxIntervalMs: 4000,
      jitter: 0,
    });

    void loop.start();
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await c.settle();
      waits.push(c.sleepsRequested()[0] ?? -1);
      await c.release();
    }
    await loop.stop();

    // 1 failure → 2×, 2 → 4×, then capped at maxIntervalMs.
    expect(waits).toEqual([2000, 4000, 4000]);
    expect(loop.status().consecutiveFailedCycles).toBeGreaterThan(1);
    expect(loop.status().healthy).toBe(true); // it is still SETTLING cycles — failure is a separate signal
  });

  it('a clean cycle resets the backoff', async () => {
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000, jitter: 0 });
    void loop.start();
    await c.settle();
    expect(loop.status().consecutiveFailedCycles).toBe(0);
    expect(c.sleepsRequested()[0]).toBe(1000); // the plain interval, not a backed-off one
    await loop.stop();
  });

  it('jitters the interval, so replicas do not stay in phase', async () => {
    const low = harness(0);
    const high = harness(0.999);
    const a = createEngineLoop(low.deps, { owner: 'a', intervalMs: 1000, jitter: 0.1 });
    const b = createEngineLoop(high.deps, { owner: 'b', intervalMs: 1000, jitter: 0.1 });

    void a.start();
    void b.start();
    await low.c.settle();
    await high.c.settle();

    expect(low.c.sleepsRequested()[0]).not.toBe(high.c.sleepsRequested()[0]);
    await a.stop();
    await b.stop();
  });

  // NOT COVERED, and recorded rather than glossed: that the FIRST sleep is jittered by the whole interval
  // rather than by the configured fraction. Two attempts failed to observe it — a fractional first sleep still
  // differs between replicas (900 vs 1100), so the obvious test passes either way; and with rng 0 full jitter
  // produces a 0 ms target, which registers no sleep at all and so leaves nothing to measure. The behaviour is
  // deliberate (see the comment at the `jitterFactor` call) and it matters most for a simultaneous rollout,
  // which is precisely the scenario a unit test cannot stage. Worth revisiting with a multi-replica harness.

  it('jitter: 0 means none at all — an operator asking for determinism gets it', async () => {
    const { c, deps } = harness(0);
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000, jitter: 0 });
    void loop.start();
    await c.settle();
    expect(c.sleepsRequested()[0]).toBe(1000);
    await loop.stop();
  });

  it('subtracts the cycle duration, so a slow cycle does not compound the schedule', async () => {
    const { c, deps } = harness();
    // Every enumeration during the cycle burns 100 ms of the 1000 ms interval, so the following sleep must be
    // shorter than the interval. Without the subtraction the schedule slips by the cycle duration, every cycle,
    // forever — and the lease protocol's own `sinceLastCycleMs` alarm is what eventually fires.
    const slow = {
      ...deps,
      registry: wrapRegistry(deps.registry as MemoryRegistryDriver, {
        list: (ns?: string) => {
          c.bump(100);
          return (deps.registry as MemoryRegistryDriver).list(ns);
        },
      }),
    } as unknown as LifecycleDeps & { rng?: { next: () => number } };
    const loop = createEngineLoop(slow, { owner: 'w1', intervalMs: 1000, jitter: 0 });

    void loop.start();
    await c.settle();

    const requested = c.sleepsRequested()[0] ?? -1;
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThan(1000); // the cycle's own elapsed time was deducted
    await loop.stop();
  });
});

describe('engine loop — the health window tracks the backoff', () => {
  it('a backed-off but alive worker stays HEALTHY — a fixed window would flap and restart the pod', async () => {
    // Found by review, not by a gate. The backoff climbs to maxIntervalMs (15× the interval by default) while
    // `staleAfterMs` defaulted to 4× it — so from the SECOND consecutive failure onward, one brief throttle,
    // `healthy` went false between cycles. Wired to a liveness probe that is a restart loop during an outage:
    // exactly the thrash the backoff exists to prevent, and each restart also discards the backoff.
    const { c, deps } = harness(0.5);
    const broken = wrapRegistry(deps.registry as MemoryRegistryDriver, {
      list: () => {
        throw new Error('backend down');
      },
    });
    const loop = createEngineLoop({ ...deps, registry: broken } as LifecycleDeps, {
      owner: 'w1',
      intervalMs: 1000,
      maxIntervalMs: 60_000,
      jitter: 0,
      // default staleAfterMs === 4 × interval === 4000
    });

    void loop.start();
    for (let i = 0; i < 3; i++) {
      await c.settle();
      await c.release();
    }
    await c.settle();
    expect(loop.status().consecutiveFailedCycles).toBeGreaterThanOrEqual(3);

    // Well past the 4000 floor, well inside what the loop is currently promising.
    c.advance(5000);
    expect(loop.status().healthy).toBe(true);
    // And the operator can SEE the widened window rather than having to infer it.
    expect(loop.status().staleAfterMs).toBeGreaterThan(5000);

    await loop.stop();
  });

  it('the configured floor still wins when it is the larger of the two', async () => {
    const { deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000, staleAfterMs: 5000 });

    await loop.runOnce();

    // Clean cycle ⇒ 2 × interval === 2000, so the floor governs. Widening must never *narrow* the window.
    expect(loop.status().staleAfterMs).toBe(5000);
  });
});

describe('engine loop — a loop is single-use', () => {
  it('start() after stop() throws, instead of running a loop that stop() can no longer stop', async () => {
    // The hole: `stopped` is memoised for idempotence and was never cleared, so a restarted loop's second
    // `stop()` returned the FIRST stop's settled result — while the loop kept cycling, holding leases and
    // sweeping, reporting itself stopped. A restriction beats a silent lie; constructing another loop is free.
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000 });
    void loop.start();
    await c.settle();
    await loop.stop();

    await expect(loop.start()).rejects.toThrow(ValidationError);
    await expect(loop.start()).rejects.toThrow(/single-use/);
    expect(() => loop.runOnce()).toThrow(/single-use/);
  });

  it('runOnce() refuses to overlap a cycle, naming the cause', async () => {
    // Two cycles on one loop share LifecycleState: the later one's lease view and repair-cadence counter
    // overwrite the earlier's. The data is safe either way (every mutation underneath is a conditional write),
    // but a scheduler firing faster than a cycle takes deserves to be told, not to get a confused counter.
    const { deps } = harness();
    const slow = wrapRegistry(deps.registry as MemoryRegistryDriver, {
      list: () => neverEnding(),
    });
    const loop = createEngineLoop({ ...deps, registry: slow } as LifecycleDeps, { owner: 'w1' });

    void loop.runOnce();
    await Promise.resolve();

    expect(() => loop.runOnce()).toThrow(/already running/);
  });

  it('runOnce() refuses while start() is looping, even between cycles', async () => {
    // `inFlight` is empty while the loop sleeps, so guarding on it alone would let a runOnce slip through and
    // overwrite the schedule's state underneath it.
    const { c, deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 30_000, jitter: 0 });
    void loop.start();
    await c.settle(); // sleeping between cycles: nothing is in flight

    expect(() => loop.runOnce()).toThrow(/start\(\) is looping/);

    await loop.stop();
  });
});

describe('engine loop — an injected clock that rejects', () => {
  it('counts a rejected sleep as elapsed instead of hanging the loop forever', async () => {
    // `clock` is the caller's. A rejection from `sleep` left the interval promise pending forever: the loop
    // silently dead while the process stayed alive — the one failure mode this module exists to prevent.
    const registry = new MemoryRegistryDriver({ now: () => T0 });
    const deps = {
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdDriver(),
      registry,
      clock: { now: () => T0, sleep: () => Promise.reject(new Error('clock is broken')) },
      codec: roaringCodec,
    } as unknown as LifecycleDeps;
    const loop = createEngineLoop(deps, { owner: 'w1', intervalMs: 1000, jitter: 0 });

    void loop.start();
    for (let i = 0; i < 60; i++) await Promise.resolve();

    expect(loop.status().cyclesCompleted).toBeGreaterThan(1); // it kept going

    // And `stop()` resolves rather than rejecting — a rejected stop would be memoised, so every later stop
    // rejects too and the leases are never released.
    await expect(loop.stop({ timeoutMs: 1000 })).resolves.toMatchObject({ released: [] });
  });
});

describe('engine loop — validation', () => {
  it('refuses a nonsense interval, ceiling or jitter', () => {
    const { deps } = harness();
    expect(() => createEngineLoop(deps, { owner: 'w', intervalMs: 0 })).toThrow(ValidationError);
    expect(() =>
      createEngineLoop(deps, { owner: 'w', intervalMs: 1000, maxIntervalMs: 500 }),
    ).toThrow(ValidationError);
    expect(() => createEngineLoop(deps, { owner: 'w', jitter: 2 })).toThrow(ValidationError);
  });

  it('constructing the loop starts nothing, so it is safe at module scope', () => {
    const { deps } = harness();
    const loop = createEngineLoop(deps, { owner: 'w' });
    expect(loop.status().running).toBe(false);
    expect(loop.status().cyclesCompleted).toBe(0);
  });

  it('the default interval is a stated number', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(60_000);
  });
});

/** An enumeration that never yields and never ends — a black-holed driver call. */
function neverEnding(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<never>(() => undefined),
    }),
  } as unknown as AsyncIterable<never>;
}
