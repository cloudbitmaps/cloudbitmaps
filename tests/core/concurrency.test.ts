import { boundedAll, mapWithConcurrency } from '@/core/concurrency';
import { ValidationError } from '@/core/errors';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Later items finish first (descending delays), yet results come back in input order.
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await wait(ms);
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 4, async (x) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(1);
      inFlight -= 1;
      return x;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // sanity: the pool actually overlapped work
    expect(out).toEqual(items);
  });

  it('rejects with the first error and stops scheduling new work', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
        started.push(x);
        if (x === 2) throw new Error('boom');
        await wait(1);
        return x;
      }),
    ).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6); // stopped early — did not fan out over every item
  });

  it('rejects a non-positive or non-integer limit', async () => {
    await expect(mapWithConcurrency([1], 0, async (x) => x)).rejects.toThrow(ValidationError);
    await expect(mapWithConcurrency([1], -1, async (x) => x)).rejects.toThrow(ValidationError);
    await expect(mapWithConcurrency([1], 1.5, async (x) => x)).rejects.toThrow(ValidationError);
  });

  it('returns [] for no items (and never invokes fn)', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async (x) => {
      calls += 1;
      return x;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('boundedAll', () => {
  /** Calls that settle only when the test says, counting how many are in flight. */
  function gate() {
    const pending = new Map<
      number,
      { resolve: (v: number) => void; reject: (e: unknown) => void }
    >();
    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const fn = (x: number): Promise<number> => {
      started.push(x);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<number>((resolve, reject) => pending.set(x, { resolve, reject })).finally(
        () => (inFlight -= 1),
      );
    };
    const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
    return { fn, pending, started, tick, peak: () => peak, inFlight: () => inFlight };
  }

  it('answers in input order whatever the completion order, at most `limit` at once', async () => {
    const g = gate();
    const items = Array.from({ length: 10 }, (_, i) => i);
    const all = boundedAll(items, 3, g.fn);
    while (g.pending.size > 0 || g.started.length < items.length) {
      await g.tick();
      // Settle what is in flight, the latest started first.
      for (const x of [...g.pending.keys()].reverse()) {
        g.pending.get(x)!.resolve(x * 2);
        g.pending.delete(x);
      }
    }
    expect(await all).toEqual(items.map((x) => x * 2));
    expect(g.peak()).toBe(3);
  });

  it('rejects with the first failure at once, before the calls in flight settle, and starts no more', async () => {
    const g = gate();
    const all = boundedAll([0, 1, 2, 3, 4, 5], 2, g.fn);
    const settled = all.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await g.tick();
    expect(g.started).toEqual([0, 1]);
    const boom = new Error('boom');
    g.pending.get(1)!.reject(boom);
    expect(await settled).toBe(boom);
    // Call 0 is still in flight: the rejection did not wait for it.
    expect(g.inFlight()).toBe(1);
    g.pending.get(0)!.resolve(0);
    await g.tick();
    expect(g.started).toEqual([0, 1]);
  });

  it('is Promise.all when every item fits: all at once, and the first failure at once', async () => {
    const g = gate();
    const settled = boundedAll([0, 1, 2], 3, g.fn).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(g.started).toEqual([0, 1, 2]);
    await g.tick();
    const boom = new Error('boom');
    g.pending.get(2)!.reject(boom);
    expect(await settled).toBe(boom);
    expect(g.inFlight()).toBe(2);
    expect(await boundedAll([1, 2], 2, async (x) => x * 3)).toEqual([3, 6]);
  });

  it('settles a fan-out that fits in as many turns of the microtask queue as Promise.all', async () => {
    const turns = async (p: Promise<unknown>): Promise<number> => {
      let done = false;
      void p.then(() => (done = true));
      let n = 0;
      while (!done) {
        await null;
        n += 1;
      }
      return n;
    };
    const read = async (x: number): Promise<number> => x;
    const items = Array.from({ length: 16 }, (_, i) => i);
    expect(await turns(boundedAll(items, 16, read))).toBe(
      await turns(Promise.all(items.map(read))),
    );
  });

  it('takes a call that throws as it is made as its failure', async () => {
    const started: number[] = [];
    const boom = new Error('thrown');
    for (const limit of [2, 3]) {
      started.length = 0;
      await expect(
        boundedAll([0, 1, 2], limit, (x) => {
          started.push(x);
          if (x === 0) throw boom;
          return Promise.resolve(x);
        }),
      ).rejects.toBe(boom);
      expect(started).toEqual([0]);
    }
  });

  it('leaves no call it made unhandled when a later call throws as it is made', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = new Error('rejected later');
      const boom = new Error('thrown');
      await expect(
        boundedAll([0, 1, 2], 3, (x) => {
          if (x === 0) return wait(5).then(() => Promise.reject(late));
          if (x === 1) throw boom;
          return Promise.resolve(x);
        }),
      ).rejects.toBe(boom);
      await wait(30);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects a non-positive or non-integer limit, and answers [] for no items', async () => {
    await expect(boundedAll([1], 0, async (x) => x)).rejects.toThrow(ValidationError);
    await expect(boundedAll([1], 1.5, async (x) => x)).rejects.toThrow(ValidationError);
    expect(await boundedAll([], 4, async (x: number) => x)).toEqual([]);
  });
});
