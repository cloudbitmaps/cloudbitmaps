/**
 * One lifecycle cycle — the unit the engine repeats.
 *
 * Everything here runs on a fake clock, which is the point of putting the loop in `core/`: a background job
 * nobody watches is exactly the kind of code where "it worked when I ran it" is not evidence, and a timer-based
 * design could only be tested by waiting.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPAIR_EVERY,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  dueBucket,
  dueIndexRef,
  emptyLifecycleState,
  roaringCodec,
  runLifecycleCycle,
  type LifecycleDeps,
  type LifecycleState,
  type SegmentRef,
} from '@/index';
import { CloudRoaring } from '@/index';
import { ValidationError } from '@/core/errors';

const DAY = 86_400_000;
const T0 = 1_754_000_000_000;

function harness() {
  let t = T0;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const registry = new MemoryRegistryDriver({ now: clock.now });
  const warm = new MemoryWarmDriver();
  const cold = new MemoryColdDriver();
  const store = new CloudRoaring({ warm, cold, registry, clock });
  const deps: LifecycleDeps = { warm, cold, registry, clock, codec: roaringCodec };
  return { store, deps, registry, clock, advance: (ms: number) => (t += ms) };
}

/** One worker, carrying its state across cycles exactly as the engine will. */
class Worker {
  state: LifecycleState = emptyLifecycleState();
  constructor(
    private readonly owner: string,
    private readonly deps: LifecycleDeps,
    private readonly options: Record<string, unknown> = {},
  ) {}
  async cycle() {
    const result = await runLifecycleCycle(this.state, this.deps, {
      owner: this.owner,
      ...this.options,
    });
    this.state = result.state;
    return result;
  }
}

async function seed(store: CloudRoaring, segment: string, expiresAt?: number): Promise<SegmentRef> {
  const ref: SegmentRef = { segment };
  await store.segment(segment).addMany([1, 2, 3]);
  if (expiresAt !== undefined) await store.setRetention(ref, { expiresAt });
  return ref;
}

describe('lifecycle cycle — the phases', () => {
  it('retires what expired and reports the slice it worked', async () => {
    const { store, deps } = harness();
    await seed(store, 'expired', T0 - DAY);
    await seed(store, 'alive', T0 + 90 * DAY);

    const result = await new Worker('w1', deps).cycle();

    expect(result.errors).toEqual([]);
    expect(result.partitionsHeld).toEqual([0]);
    expect(result.retention?.retired).toBe(1);
    expect(await store.segment('expired').count()).toBe(0);
    expect(await store.segment('alive').count()).toBe(3);
  });

  it('a worker holding no partitions does no work rather than duplicating another worker s', async () => {
    const { store, deps } = harness();
    await seed(store, 'expired', T0 - DAY);

    const holder = new Worker('holder', deps);
    await holder.cycle(); // takes the only partition

    const idle = await new Worker('idle', deps).cycle();

    expect(idle.partitionsHeld).toEqual([]);
    expect(idle.retention).toBeUndefined();
    expect(idle.compaction).toBeUndefined();
    expect(idle.errors).toEqual([]); // holding nothing is not a fault
  });

  it('honours per-loop opt-out', async () => {
    const { store, deps } = harness();
    await seed(store, 'expired', T0 - DAY);

    const result = await new Worker('w1', deps, {
      retention: { enabled: false },
      compaction: { enabled: false },
    }).cycle();

    expect(result.retention).toBeUndefined();
    expect(result.compaction).toBeUndefined();
    expect(await store.segment('expired').count()).toBe(3); // untouched
  });
});

describe('lifecycle cycle — fast most cycles, complete sometimes', () => {
  it('repairs on the first cycle, because a fresh process knows nothing', async () => {
    const { deps } = harness();
    expect((await new Worker('w1', deps).cycle()).scan).toBe('fleet');
  });

  it('then runs the fast index scan until the repair cadence comes round', async () => {
    const { deps } = harness();
    const w = new Worker('w1', deps, { retention: { repairEvery: 4 } });

    const scans: string[] = [];
    for (let i = 0; i < 9; i++) scans.push((await w.cycle()).scan);

    //          cycle: 1        2        3        4         5        6        7        8         9
    expect(scans).toEqual([
      'fleet',
      'index',
      'index',
      'fleet',
      'index',
      'index',
      'index',
      'fleet',
      'index',
    ]);
  });

  it('the repair pass catches a policy the fast path cannot see', async () => {
    // The pair in one test: an unpointed policy is invisible to `index` and retired by `fleet`. If this ever
    // stops holding, the engine silently stops retiring a whole class of segment.
    const { store, deps, registry } = harness();
    const expiresAt = T0 - DAY;
    const ref = await seed(store, 'unpointed', expiresAt);
    await registry.delete(dueIndexRef(dueBucket(expiresAt), ref));

    const w = new Worker('w1', deps, { retention: { repairEvery: 3 } });
    await w.cycle(); // cycle 1 — fleet, but let us prove the index path alone would miss it
    expect(await store.segment('unpointed').count()).toBe(0);

    // …and again from scratch, with the first cycle forced onto the index path.
    const second = harness();
    const ref2 = await seed(second.store, 'unpointed', expiresAt);
    await second.registry.delete(dueIndexRef(dueBucket(expiresAt), ref2));
    const w2 = new Worker('w2', second.deps, { retention: { repairEvery: 1_000_000 } });
    await w2.cycle(); // cycle 1 is always fleet…
    const fresh = harness();
    const ref3 = await seed(fresh.store, 'unpointed', expiresAt);
    await fresh.registry.delete(dueIndexRef(dueBucket(expiresAt), ref3));
    const w3 = new Worker('w3', fresh.deps, { retention: { repairEvery: 1_000_000 } });
    w3.state = { ...emptyLifecycleState(), cycle: 5 }; // …so start past it
    const indexOnly = await w3.cycle();
    expect(indexOnly.scan).toBe('index');
    expect(indexOnly.retention?.retired).toBe(0);
    expect(await fresh.store.segment('unpointed').count()).toBe(3); // still there — the repair pass owns it
  });

  it('the cycle counter survives in the returned state, so a repair is not forced every restart', async () => {
    const { deps } = harness();
    const w = new Worker('w1', deps, { retention: { repairEvery: 3 } });
    await w.cycle();
    expect(w.state.cycle).toBe(1);
    await w.cycle();
    expect(w.state.cycle).toBe(2);
  });
});

describe('lifecycle cycle — a phase fault never stops the cycle', () => {
  it('a retention failure still lets compaction run, and is reported', async () => {
    // Isolating the two phases needs care: they both enumerate the registry, so breaking `list` outright breaks
    // both. On a fast cycle retention reads ONLY the due namespaces, which is the seam — break those and
    // compaction's unscoped discovery is untouched.
    const { store, deps, registry } = harness();
    await seed(store, 'seg', T0 - DAY);
    const realList = registry.list.bind(registry);
    registry.list = (namespace?: string) => {
      if (namespace?.startsWith('cbm.due.') === true) throw new Error('registry unavailable');
      return realList(namespace);
    };

    const w = new Worker('w1', deps, { retention: { repairEvery: 1_000_000 } });
    w.state = { ...emptyLifecycleState(), cycle: 5 }; // past the first cycle, so the fast path is used
    const result = await w.cycle();

    expect(result.scan).toBe('index');
    expect(result.errors.map((e) => e.phase)).toEqual(['retention']);
    expect(result.compaction).toBeDefined(); // the next phase still ran
    expect(result.state.cycle).toBe(6); // …and the cycle still completed
  });

  it('an empty `errors` array is the healthy state', async () => {
    const { store, deps } = harness();
    await seed(store, 'seg');
    expect((await new Worker('w1', deps).cycle()).errors).toEqual([]);
  });
});

describe('lifecycle cycle — fails loudly on a wiring error', () => {
  it('refuses to run without a registry rather than silently skipping every loop', async () => {
    const { deps } = harness();
    const noRegistry = { ...deps, registry: undefined } as unknown as LifecycleDeps;
    await expect(
      runLifecycleCycle(emptyLifecycleState(), noRegistry, { owner: 'w' }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an empty owner and a nonsense repair cadence', async () => {
    const { deps } = harness();
    await expect(runLifecycleCycle(emptyLifecycleState(), deps, { owner: '' })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      runLifecycleCycle(emptyLifecycleState(), deps, { owner: 'w', retention: { repairEvery: 0 } }),
    ).rejects.toThrow(ValidationError);
  });

  it('the default repair cadence is a stated number, not an accident', () => {
    expect(DEFAULT_REPAIR_EVERY).toBe(24);
  });
});

describe('lifecycle cycle — N processes', () => {
  it('two workers converge on disjoint slices and stay there', async () => {
    const { store, deps } = harness();
    for (let i = 0; i < 4; i++) await seed(store, `seg-${i}`, T0 - DAY);

    const a = new Worker('a', deps, { partitions: 4 });
    const b = new Worker('b', deps, { partitions: 4 });

    // Let the fleet converge first. Mid-rebalance the two beliefs CAN overlap for up to one cycle — a steal
    // takes a live lease and the victim learns at its next renew (property 2), which the lease protocol
    // documents and the CAS at the resource is what actually prevents two workers committing. Asserting during
    // convergence would be asserting something the protocol deliberately does not promise.
    for (let round = 0; round < 8; round++) {
      await a.cycle();
      await b.cycle();
    }

    const ra = await a.cycle();
    const rb = await b.cycle();

    expect(ra.partitionsHeld.filter((p) => rb.partitionsHeld.includes(p))).toEqual([]);
    expect(ra.partitionsHeld).toHaveLength(2); // ceil(4/2), fairly split
    expect(rb.partitionsHeld).toHaveLength(2);
    expect([...ra.errors, ...rb.errors]).toEqual([]);
  });
});
