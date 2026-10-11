import { CloudRoaring, LeaseExpiredError, MemoryStorage } from '@/index';
import { guardIdIterable, guardIds, guardItems } from '@/lease-guards';

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
  ])(
    '%s: next, return and throw are functions, and iterating it gives it back',
    async (_n, guard) => {
      const g = guard(idsOf(1)) as unknown as AsyncGenerator<number>;
      expect(typeof g.next).toBe('function');
      expect(await g.next()).toEqual({ done: false, value: 1 });
      expect(typeof g.return).toBe('function');
      expect(typeof g.throw).toBe('function');
      expect(g[Symbol.asyncIterator]()).toBe(g);
    },
  );

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

  it('throw() on a source that handles the error hands on what it yields next, checked like any pull', async () => {
    async function* recovering(): AsyncGenerator<number> {
      try {
        yield 1;
      } catch {
        yield 99;
        yield 100;
      }
    }
    let live = true;
    const check = (): void => {
      if (!live) ended();
    };
    const g = guardItems(recovering(), check) as unknown as AsyncGenerator<number>;
    await g.next();
    expect(await g.throw(new Error('boom'))).toEqual({ done: false, value: 99 });
    expect(await g.next()).toEqual({ done: false, value: 100 });

    const h = guardItems(recovering(), check) as unknown as AsyncGenerator<number>;
    await h.next();
    live = false;
    await expect(h.throw(new Error('boom'))).rejects.toBeInstanceOf(LeaseExpiredError);
    expect((await h.next()).done).toBe(true);
  });

  it('return(value) gives the value back, and hands it to the source', async () => {
    let got: unknown = 'unset';
    const bare: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: 1 }),
        return: (v?: unknown) => {
          got = v;
          return Promise.resolve({ done: true, value: v });
        },
      }),
    };
    const g = guardItems(bare, () => undefined) as unknown as AsyncGenerator<number, number>;
    expect(await g.return(42)).toEqual({ done: true, value: 42 });
    expect(got).toBe(42);
  });

  it("a result handed out is the caller's: changing one changes no later result", async () => {
    const g = guardItems(idsOf(1), () => undefined) as unknown as AsyncGenerator<number>;
    const r = (await g.return(undefined)) as { value: unknown };
    r.value = 'mutated';
    expect(await g.next()).toEqual({ done: true, value: undefined });
    const h = guardItems(idsOf(1), () => undefined) as unknown as AsyncGenerator<number>;
    expect(await h.return(undefined)).toEqual({ done: true, value: undefined });
  });

  it('throw() before the first pull ends the stream: a later next() is done, as on a generator', async () => {
    const boom = new Error('boom');
    for (const guard of [guardIdIterable, guardItems]) {
      const g = guard(idsOf(1), ended) as unknown as AsyncGenerator<number>;
      await expect(g.throw(boom)).rejects.toBe(boom);
      expect((await g.next()).done).toBe(true);
    }
  });

  it('a pull in flight when return() is called settles done, not with the item the source had for it', async () => {
    for (const guard of [guardIdIterable, guardItems]) {
      const g = guard(idsOf(1, 2, 3), () => undefined) as unknown as AsyncGenerator<number>;
      await g.next();
      const pull = g.next();
      await g.return(undefined);
      expect((await pull).done).toBe(true);
    }
  });

  it('pulls made without awaiting serve nothing of a chunk whose check failed', async () => {
    let live = true;
    const g = guardIdIterable(idsOf(1, 65_536, 65_537, 65_538), () => {
      if (!live) ended();
    }) as unknown as AsyncGenerator<number>;
    await g.next();
    live = false;
    const pulls = await Promise.allSettled([g.next(), g.next(), g.next(), g.next()]);
    for (const p of pulls) {
      if (p.status === 'fulfilled') expect(p.value.done).toBe(true);
      else expect(p.reason).toBeInstanceOf(LeaseExpiredError);
    }
    expect(pulls.some((p) => p.status === 'fulfilled' && p.value.done === false)).toBe(false);
    expect(pulls[0]?.status).toBe('rejected');
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
  /** Three ids in the first chunk, then one in each of two more. */
  const IDS = [1, 2, 3, 65_536, 131_072, 131_073];
  async function handles() {
    const state = { t: T0 };
    const memory = new MemoryStorage();
    const store = new CloudRoaring({
      storage: memory,
      seams: { clock: { now: () => state.t, sleep: () => Promise.resolve() } },
      cache: { genTtlMs: 0 },
    });
    const ref = { namespace: 'ns', segment: 's' };
    await store.load(ref, IDS);
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
      const pull = async (x: Record<string, unknown>) => {
        const per = await (x as unknown as AsyncGenerator<number>).next();
        const bat = await (x.batches as () => AsyncGenerator<Uint32Array>)().next();
        return [per.value, Array.from((bat.value ?? []) as Uint32Array)];
      };
      expect(await pull(b)).toEqual(await pull(a));
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

  it('overlapping next() calls across the lease ending, and after release(), serve nothing of a later chunk', async () => {
    for (const how of ['expiry', 'release'] as const) {
      const { leased, state } = await handles();
      const s = leased.iterate() as unknown as AsyncGenerator<number>;
      for (const want of [1, 2, 3]) expect((await s.next()).value).toBe(want);
      if (how === 'expiry') state.t += 61_000;
      else await leased.release();
      const pulls = await Promise.allSettled([s.next(), s.next(), s.next(), s.next()]);
      expect(pulls.some((p) => p.status === 'fulfilled' && p.value.done === false)).toBe(false);
      expect(pulls[0]?.status).toBe('rejected');
    }
  });

  it('a refused read has the stream shape too, and its next() rejects with the refusal', async () => {
    const { live, unleased, leased, state } = await handles();
    state.t += 61_000;
    const refused: Array<[string, () => unknown, new (...a: never[]) => Error, boolean]> = [
      ['iterate past its lease', () => leased.iterate(), LeaseExpiredError, true],
      ['intersect past its lease', () => leased.intersect([unleased]), LeaseExpiredError, true],
      ['union past its lease', () => leased.union([unleased]), LeaseExpiredError, true],
      ['andNot past its lease', () => leased.andNot([unleased]), LeaseExpiredError, true],
      ['everyNth past its lease', () => leased.everyNth(2), LeaseExpiredError, false],
      ['iterate with an unknown key', () => unleased.iterate({ bogus: 1 } as never), Error, true],
      [
        'intersect with an unknown key',
        () => unleased.intersect([live], { bogus: 1 } as never),
        Error,
        true,
      ],
      [
        'union with an unknown key',
        () => unleased.union([live], { bogus: 1 } as never),
        Error,
        true,
      ],
      [
        'andNot with an unknown key',
        () => unleased.andNot([live], { bogus: 1 } as never),
        Error,
        true,
      ],
      ['everyNth on a live handle', () => live.everyNth(2), Error, false],
    ];
    for (const [name, make, type, hasBatches] of refused) {
      const s = make() as unknown as AsyncGenerator<number> & { batches?: () => AsyncGenerator };
      for (const m of SHAPE) expect(typeof s[m], name).toBe('function');
      expect(s[Symbol.asyncIterator](), name).toBe(s);
      expect(typeof s.batches, name).toBe(hasBatches ? 'function' : 'undefined');
      await expect(s.next(), name).rejects.toBeInstanceOf(type);
      expect((await s.next()).done, name).toBe(true);
      if (hasBatches) {
        const b = s.batches!();
        for (const m of SHAPE) expect(typeof b[m], name).toBe('function');
        await expect(b.next(), name).rejects.toBeInstanceOf(type);
      }
    }
  });

  it('stream.next() by hand on a leased handle reads the ids, and throws LeaseExpiredError once the lease ends', async () => {
    const { leased, state } = await handles();
    const s = leased.iterate() as unknown as AsyncGenerator<number>;
    expect(new Set(IDS.slice(0, 3).map((id) => id >>> 16)).size).toBe(1);
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

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/** A hand-rolled iterator: never done on its own, counts its calls, and a slow return. */
function bare(opts: { returnDelayMs?: number; throwRejects?: boolean } = {}) {
  const calls = { next: 0, ret: 0, retDone: false };
  const src: AsyncIterable<number> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        calls.next += 1;
        return Promise.resolve({ done: false, value: calls.next });
      },
      return: async () => {
        calls.ret += 1;
        await tick(opts.returnDelayMs ?? 0);
        calls.retDone = true;
        return { done: true as const, value: 'from-source' as unknown as undefined };
      },
      ...(opts.throwRejects ? { throw: (e: unknown) => Promise.reject(e) } : {}),
    }),
  };
  return { calls, src };
}

describe('the guard, held against what a reordering or a shortcut would break', () => {
  // A chunk is checked once, wherever its ids fall inside the 65,536 range.
  it('checks once per 65,536-id chunk, even when the ids of a chunk span both halves of it', async () => {
    let checks = 0;
    const g = guardIdIterable(
      (async function* () {
        yield* [0, 32_767, 32_768, 65_535, 65_536];
      })(),
      () => void (checks += 1),
    );
    for await (const _ of g) void _;
    expect(checks).toBe(1 + 2); // before the first pull, then chunk 0 and chunk 1
  });

  // return() waits for the source.
  it('return() resolves only once the source has finished returning', async () => {
    const { calls, src } = bare({ returnDelayMs: 20 });
    const g = guardItems(src, () => undefined);
    await g.next();
    await g.return();
    expect(calls.retDone).toBe(true);
  });

  // The stream is over as soon as return() is called: a pull that overlaps return() must not reach the source.
  it('a next() issued while return() is in flight is done and never pulls the source', async () => {
    const { calls, src } = bare({ returnDelayMs: 20 });
    const g = guardItems(src, () => undefined);
    await g.next();
    const pulled = calls.next;
    const ret = g.return();
    const late = await g.next();
    await ret;
    expect(late.done).toBe(true);
    expect(calls.next).toBe(pulled);
  });

  // The first check is claimed before the first pull: overlapping first next() calls check once, not twice.
  it('overlapping next() calls check before the first pull once, then once per item', async () => {
    let checks = 0;
    const slow: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () => {
            await tick();
            return i < 2 ? { done: false, value: i++ } : { done: true, value: undefined };
          },
        };
      },
    };
    const g = guardItems(slow, () => void (checks += 1));
    const rs = await Promise.all([g.next(), g.next(), g.next()]);
    expect(rs.map((r) => r.done)).toEqual([false, false, true]);
    expect(checks).toBe(1 + 2);
  });

  // The stream is over after a failed check even when the source is not itself sticky.
  it.each(['first pull', 'mid-stream'])(
    'after a failed check on the %s, later pulls are done and the source is not pulled again',
    async (when) => {
      const { calls, src } = bare();
      let n = 0;
      const g = guardItems(src, () => {
        n += 1;
        if (when === 'first pull' ? n === 1 : n === 3) ended();
      });
      if (when === 'mid-stream') await g.next();
      await expect(g.next()).rejects.toBeInstanceOf(LeaseExpiredError);
      const pulled = calls.next;
      expect((await g.next()).done).toBe(true);
      expect(calls.next).toBe(pulled);
      expect(calls.ret).toBe(1);
    },
  );

  // return() reports done with no value, as its type says, whatever the source's return carries.
  it('return() resolves { done: true, value: undefined }, not the source return result', async () => {
    const { src } = bare();
    const g = guardIdIterable(src, () => undefined);
    await g.next();
    expect(await g.return()).toEqual({ done: true, value: undefined });
  });

  // batches() is a separate, lazy, guarded read per call.
  describe('guardIds().batches()', () => {
    function ids() {
      const log = { batchCalls: 0, checks: 0 };
      const inner = {
        async *[Symbol.asyncIterator]() {
          yield 1;
        },
        batches() {
          log.batchCalls += 1;
          return (async function* () {
            yield new Uint32Array([1, 2]);
          })();
        },
      };
      const s = guardIds(inner, () => void (log.checks += 1));
      return { log, s };
    }
    it('does not open the engine batches until called, and each call is a fresh stream', async () => {
      const { log, s } = ids();
      expect(log.batchCalls).toBe(0);
      const a = s.batches();
      const b = s.batches();
      expect(a).not.toBe(b);
      expect(log.batchCalls).toBe(2);
      expect((await a.next()).value).toEqual(new Uint32Array([1, 2]));
      expect((await b.next()).value).toEqual(new Uint32Array([1, 2])); // b not spent by a
    });
    it('reading the per-id stream does not use up or end the batches stream', async () => {
      const { s } = ids();
      for await (const _ of s) void _;
      const batches: Uint32Array[] = [];
      for await (const b of s.batches()) batches.push(b);
      expect(batches).toHaveLength(1);
    });
    it('a lease that ends fails batches() even when the per-id stream is over', async () => {
      let live = true;
      const { s } = (() => {
        const inner = {
          async *[Symbol.asyncIterator]() {
            yield 1;
          },
          batches: () =>
            (async function* () {
              yield new Uint32Array([1]);
              yield new Uint32Array([2]);
            })(),
        };
        return { s: guardIds(inner, () => void (live || ended())) };
      })();
      for await (const _ of s) void _;
      const b = s.batches();
      await b.next();
      live = false;
      await expect(b.next()).rejects.toBeInstanceOf(LeaseExpiredError);
    });
  });

  // Not a mutant: throw() on a source whose throw() rejects must leave the guard over, as stop() does.
  it('after throw() rejects from a source that has throw(), the stream is over', async () => {
    const { calls, src } = bare({ throwRejects: true });
    const g = guardItems(src, () => undefined);
    await g.next();
    await expect(g.throw(new Error('boom'))).rejects.toThrow('boom');
    const pulled = calls.next;
    expect((await g.next()).done).toBe(true);
    expect(calls.next).toBe(pulled);
  });

  // Not a mutant: the done result is a fresh object per call, as a generator's is, so a caller cannot poison it.
  it('the done results of finished streams are not one shared object', async () => {
    const a = guardItems((async function* () {})(), () => undefined);
    const b = guardItems((async function* () {})(), () => undefined);
    await a.return();
    await b.return();
    const ra = (await a.next()) as { value: unknown };
    ra.value = 'poison';
    expect(((await b.next()) as { value: unknown }).value).toBeUndefined();
  });
});
