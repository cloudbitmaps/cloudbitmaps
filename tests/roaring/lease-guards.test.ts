import { CloudRoaring, LeaseExpiredError, MemoryStorage } from '@/index';
import { guardIdIterable, guardItems } from '@/lease-guards';

/**
 * The checks a stream makes of a lease: before its first pull, and each time it reads a chunk. They take any async
 * iterable, so a stream of another shape is wrapped by the same function.
 */

async function* idsOf(...ids: number[]): AsyncGenerator<number> {
  yield* ids;
}
const ended = (): void => {
  throw new LeaseExpiredError('ended', 1, 'expired');
};
const drain = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const v of it) out.push(v);
  return out;
};

describe('guardIdIterable', () => {
  it('checks before the first pull, so an empty stream past its lease throws and never ends empty', async () => {
    let calls = 0;
    const g = guardIdIterable(idsOf(), () => {
      calls += 1;
      ended();
    });
    await expect(drain(g)).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(calls).toBe(1);
  });

  it('checks again each time the ids move into a chunk, and not between ids of one chunk', async () => {
    let checks = 0;
    const g = guardIdIterable(idsOf(1, 2, 3, 65_536, 65_537, 131_072), () => void (checks += 1));
    expect(await drain(g)).toEqual([1, 2, 3, 65_536, 65_537, 131_072]);
    expect(checks).toBe(1 + 3); // before the first pull, then one for each of three chunks
  });

  it('a lease that ends mid-stream throws at the next chunk, and ends the source stream', async () => {
    let live = true;
    let closed = false;
    async function* source(): AsyncGenerator<number> {
      try {
        yield* [1, 2, 65_536];
      } finally {
        closed = true;
      }
    }
    const it = guardIdIterable(source(), () => {
      if (!live) ended();
    })[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
    live = false;
    expect((await it.next()).value).toBe(2);
    await expect(it.next()).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(closed).toBe(true);
  });

  it('leaving a live stream early ends the source', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<number> {
      try {
        yield* [1, 2, 3];
      } finally {
        closed = true;
      }
    }
    for await (const v of guardIdIterable(source(), () => undefined)) {
      expect(v).toBe(1);
      break;
    }
    expect(closed).toBe(true);
  });
});

describe('guardItems', () => {
  it('checks before the first pull, and before each item', async () => {
    let checks = 0;
    const g = guardItems(idsOf(1, 2), () => void (checks += 1));
    expect(await drain(g)).toEqual([1, 2]);
    expect(checks).toBe(3);
  });

  it('throws on an empty stream whose lease has ended', async () => {
    await expect(drain(guardItems(idsOf(), ended))).rejects.toBeInstanceOf(LeaseExpiredError);
  });
});

/** A source that records how it ended, so a test sees what a guard released. */
function watched(ids: number[]) {
  const seen = { closed: false, caught: undefined as unknown };
  async function* source(): AsyncGenerator<number> {
    try {
      for (const id of ids) {
        try {
          yield id;
        } catch (err) {
          seen.caught = err;
          throw err;
        }
      }
    } finally {
      seen.closed = true;
    }
  }
  return { seen, source };
}

describe("a guarded stream is an iterator of its own, as the engine's generator is", () => {
  it.each([
    ['guardIdIterable', (s: AsyncIterable<number>) => guardIdIterable(s, () => undefined)],
    ['guardItems', (s: AsyncIterable<number>) => guardItems(s, () => undefined)],
  ])('%s: next, return and throw are functions, and iterating it gives it back', (_n, guard) => {
    const g = guard(idsOf(1)) as unknown as AsyncGenerator<number>;
    expect(typeof g.next).toBe('function');
    expect(typeof g.return).toBe('function');
    expect(typeof g.throw).toBe('function');
    expect(g[Symbol.asyncIterator]()).toBe(g);
  });

  it('is single-use: a second for-await over it yields nothing', async () => {
    const g = guardIdIterable(idsOf(1, 2), () => undefined);
    expect(await drain(g)).toEqual([1, 2]);
    expect(await drain(g)).toEqual([]);
  });

  it('next() drives it by hand, to the end', async () => {
    const g = guardIdIterable(idsOf(7), () => undefined) as unknown as AsyncGenerator<number>;
    expect(await g.next()).toEqual({ done: false, value: 7 });
    expect(await g.next()).toEqual({ done: true, value: undefined });
    expect(await g.next()).toEqual({ done: true, value: undefined });
  });

  it.each([
    ['guardIdIterable', guardIdIterable],
    ['guardItems', guardItems],
  ])('%s: return() ends the source and the stream stays ended', async (_n, guard) => {
    const { seen, source } = watched([1, 2, 3]);
    const g = guard(source(), () => undefined) as unknown as AsyncGenerator<number>;
    expect((await g.next()).value).toBe(1);
    expect(await g.return(undefined)).toEqual({ done: true, value: undefined });
    expect(seen.closed).toBe(true);
    expect((await g.next()).done).toBe(true);
  });

  it.each([
    ['guardIdIterable', guardIdIterable],
    ['guardItems', guardItems],
  ])('%s: return() before the first pull ends the source', async (_n, guard) => {
    let returned = 0;
    const bare: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: 1 }),
        return: () => {
          returned += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const g = guard(bare, () => undefined) as unknown as AsyncGenerator<number>;
    await g.return(undefined);
    expect(returned).toBe(1);
    expect((await g.next()).done).toBe(true);
  });

  it.each([
    ['guardIdIterable', guardIdIterable],
    ['guardItems', guardItems],
  ])(
    '%s: throw() reaches the source, ends it, rejects with the error, and ends the stream',
    async (_n, guard) => {
      const { seen, source } = watched([1, 2, 3]);
      const g = guard(source(), () => undefined) as unknown as AsyncGenerator<number>;
      await g.next();
      const boom = new Error('boom');
      await expect(g.throw(boom)).rejects.toBe(boom);
      expect(seen.caught).toBe(boom);
      expect(seen.closed).toBe(true);
      expect((await g.next()).done).toBe(true);
    },
  );

  it('throw() on a source with no throw() still ends it and rejects with the error', async () => {
    let closed = false;
    const bare: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: 1 }),
        return: () => {
          closed = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const g = guardIdIterable(bare, () => undefined) as unknown as AsyncGenerator<number>;
    const boom = new Error('boom');
    await expect(g.throw(boom)).rejects.toBe(boom);
    expect(closed).toBe(true);
  });

  it('throw() on a source that handles the error hands on what it yields next, as the source would unguarded', async () => {
    async function* recovering(): AsyncGenerator<number> {
      try {
        yield 1;
      } catch {
        yield 99;
        yield 100;
      }
    }
    const g = guardItems(recovering(), () => undefined) as unknown as AsyncGenerator<number>;
    await g.next();
    expect(await g.throw(new Error('boom'))).toEqual({ done: false, value: 99 });
    expect(await g.next()).toEqual({ done: false, value: 100 });
  });

  it('a lease that ends mid-stream ends the stream for good: later pulls are done, not another throw', async () => {
    let live = true;
    const { seen, source } = watched([1, 65_536, 131_072]);
    const g = guardIdIterable(source(), () => {
      if (!live) ended();
    }) as unknown as AsyncGenerator<number>;
    await g.next();
    live = false;
    await expect(g.next()).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(seen.closed).toBe(true);
    expect((await g.next()).done).toBe(true);
  });

  it('guardItems: a lease that ends mid-stream throws at the next item and ends the source', async () => {
    let live = true;
    const { seen, source } = watched([1, 2]);
    const g = guardItems(source(), () => {
      if (!live) ended();
    })[Symbol.asyncIterator]();
    await g.next();
    live = false;
    await expect(g.next()).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(seen.closed).toBe(true);
  });
});

describe('a leased handle and an unleased one have one shape', () => {
  const T0 = 2_000_000_000_000;
  async function handles() {
    const state = { t: T0 };
    const memory = new MemoryStorage();
    const store = new CloudRoaring({
      storage: memory,
      seams: { clock: { now: () => state.t, sleep: () => Promise.resolve() } },
      cache: { genTtlMs: 0 },
    });
    const ref = { namespace: 'ns', segment: 's' };
    await store.load(ref, [1, 2, 3, 65_536, 131_072, 131_073]);
    const live = store.segment('s', { namespace: 'ns' });
    const unleased = await live.pin();
    const leased = await live.pin({ leaseUntil: state.t + 60_000 });
    return { state, live, unleased, leased };
  }
  const SHAPE = ['next', 'return', 'throw'] as const;

  it('iterate() has next, return, throw, batches and itself as its iterator, leased or not', async () => {
    const { live, unleased, leased } = await handles();
    for (const seg of [live, unleased, leased]) {
      const s = seg.iterate() as unknown as AsyncGenerator<number> & { batches: unknown };
      for (const m of SHAPE) expect(typeof s[m]).toBe('function');
      expect(typeof s.batches).toBe('function');
      expect(s[Symbol.asyncIterator]()).toBe(s);
    }
  });

  it('every IdStream-returning verb of a leased handle has the same shape', async () => {
    const { leased, unleased } = await handles();
    const other = unleased;
    for (const make of [
      (s: typeof leased) => s.iterate(),
      (s: typeof leased) => s.intersect([other]),
      (s: typeof leased) => s.union([other]),
      (s: typeof leased) => s.andNot([other]),
    ]) {
      const a = make(unleased) as unknown as Record<string, unknown>;
      const b = make(leased) as unknown as Record<string, unknown>;
      for (const m of [...SHAPE, 'batches'] as const) {
        expect(typeof b[m]).toBe('function');
        expect(typeof b[m]).toBe(typeof a[m]);
      }
      expect(typeof b[Symbol.asyncIterator as never]).toBe('function');
    }
  });

  it('everyNth() of a leased handle is driven by next, return and throw', async () => {
    const { leased } = await handles();
    const s = leased.everyNth(2) as unknown as AsyncGenerator<number>;
    for (const m of SHAPE) expect(typeof s[m]).toBe('function');
    expect((await s.next()).value).toBe(2);
    await s.return(undefined);
    expect((await s.next()).done).toBe(true);
  });

  it('stream.next() by hand on a leased handle reads the ids, and throws LeaseExpiredError once the lease ends', async () => {
    const { leased, state } = await handles();
    const s = leased.iterate() as unknown as AsyncGenerator<number>;
    expect((await s.next()).value).toBe(1);
    state.t += 61_000;
    await expect(s.next()).resolves.toMatchObject({ value: 2 }); // the chunk it is on
    await expect(s.next()).resolves.toMatchObject({ value: 3 });
    await expect(s.next()).rejects.toBeInstanceOf(LeaseExpiredError);
    expect((await s.next()).done).toBe(true);
  });

  it("return() and throw() on a leased handle's stream end the read, as on an unleased one", async () => {
    const { leased, unleased } = await handles();
    for (const seg of [unleased, leased]) {
      const s = seg.iterate() as unknown as AsyncGenerator<number>;
      await s.next();
      expect((await s.return(undefined)).done).toBe(true);
      expect((await s.next()).done).toBe(true);
      const t = seg.iterate() as unknown as AsyncGenerator<number>;
      await t.next();
      const boom = new Error('boom');
      await expect(t.throw(boom)).rejects.toBe(boom);
      expect((await t.next()).done).toBe(true);
    }
  });
});
