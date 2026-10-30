import {
  BudgetExceededError,
  CloudRoaring,
  LeaseExpiredError,
  MemoryStorage,
  NotFoundError,
  ValidationError,
  errorKind,
  type Segment,
} from '@/index';
import type { SegmentEngine } from '@/core/engine';

/**
 * `intersectCount`, `unionCount` and `andNotCount` on a segment: each returns the length of what its stream yields,
 * equals the engine's count, takes the streams' options, refuses what the streams refuse, and answers for a pinned
 * generation and a leased handle.
 */

const T0 = 2_000_000_000_000;
const HOUR = 3_600_000;

/** `per` ids in each of the chunks `keys`. */
const idsIn = (keys: readonly number[], per = 40): number[] =>
  keys.flatMap((k) => Array.from({ length: per }, (_, i) => k * 65_536 + i * 3 + (k % 3)));
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

const A = idsIn(range(0, 12));
const B = idsIn([...range(8, 16)], 25);
const C = idsIn(range(30, 36));
const D = A.filter((_, i) => i % 7 === 0);

type Handle = Segment;
type Counts = (a: Handle, others: Handle[], o?: object) => Promise<number>;

const drainLength = async (stream: AsyncIterable<Uint32Array> | AsyncIterable<number>) => {
  let n = 0;
  for await (const x of stream) n += typeof x === 'number' ? 1 : x.length;
  return n;
};

async function world() {
  const state = { t: T0 };
  const clock = { now: () => state.t, sleep: () => Promise.resolve() };
  const memory = new MemoryStorage();
  const store = new CloudRoaring({ storage: memory, seams: { clock }, cache: { genTtlMs: 0 } });
  for (const [name, ids] of Object.entries({ a: A, b: B, c: C, d: D })) {
    await store.load({ segment: name }, ids);
  }
  const seg = (n: string) => store.segment(n);
  const engine = (store as unknown as { engine: SegmentEngine }).engine;
  return { state, memory, store, seg, engine, a: seg('a'), b: seg('b'), c: seg('c'), d: seg('d') };
}

const setOf = (ids: readonly number[]) => new Set(ids);
const inter = (x: readonly number[], y: readonly number[]) => x.filter((i) => setOf(y).has(i));
const minus = (x: readonly number[], y: readonly number[]) => x.filter((i) => !setOf(y).has(i));
const union = (...xs: (readonly number[])[]) => setOf(xs.flat()).size;

describe('each count is the length of its stream and the engine count', () => {
  it('intersectCount', async () => {
    const w = await world();
    const expected = inter(A, B).length;
    expect(expected).toBeGreaterThan(0);
    expect(await w.a.intersectCount([w.b])).toBe(expected);
    expect(await drainLength(w.a.intersect([w.b]))).toBe(expected);
    expect(
      await w.engine.combineCount([{ segment: 'a' }, { segment: 'b' }], [], 'all', 'intersect'),
    ).toBe(expected);
    expect(await w.a.intersectCount([w.b, w.d])).toBe(inter(inter(A, B), D).length);
    expect(await w.a.intersectCount([w.c])).toBe(0);
    expect(await w.a.intersectCount([w.a])).toBe(A.length);
  });

  it('unionCount', async () => {
    const w = await world();
    expect(await w.a.unionCount([w.b])).toBe(union(A, B));
    expect(await drainLength(w.a.union([w.b]))).toBe(union(A, B));
    expect(
      await w.engine.combineCount([{ segment: 'a' }, { segment: 'b' }], [], 'any', 'union'),
    ).toBe(union(A, B));
    expect(await w.a.unionCount([w.b, w.c])).toBe(union(A, B, C));
    expect(await w.a.unionCount([w.c])).toBe(A.length + C.length);
  });

  it('andNotCount', async () => {
    const w = await world();
    const expected = minus(A, B).length;
    expect(await w.a.andNotCount([w.b])).toBe(expected);
    expect(await drainLength(w.a.andNot([w.b]))).toBe(expected);
    expect(
      await w.engine.combineCount([{ segment: 'a' }], [{ segment: 'b' }], 'all', 'andNot'),
    ).toBe(expected);
    expect(await w.a.andNotCount([w.b, w.d])).toBe(minus(minus(A, B), D).length);
    expect(await w.a.andNotCount([w.c])).toBe(A.length);
    expect(await w.a.andNotCount([w.a])).toBe(0);
  });

  it('an empty list: unionCount and andNotCount are count(), intersectCount is refused', async () => {
    const w = await world();
    expect(await w.a.unionCount([])).toBe(A.length);
    expect(await w.a.unionCount([])).toBe(await w.a.count());
    expect(await w.a.andNotCount([])).toBe(await w.a.count());
    const err = await w.a.intersectCount([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/^intersectCount requires at least one segment/);
    await expect(drainLength(w.a.intersect([]))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the options', () => {
  it('after and through bound each count as they bound the stream', async () => {
    const w = await world();
    const bounds = [
      { after: 3 * 65_536 },
      { through: 9 * 65_536 + 50 },
      { after: 2 * 65_536 + 10, through: 10 * 65_536 + 20 },
      { after: 20 * 65_536, through: 40 * 65_536 },
      { after: 5, through: 5 },
    ];
    for (const o of bounds) {
      expect(await w.a.intersectCount([w.b], o)).toBe(await drainLength(w.a.intersect([w.b], o)));
      expect(await w.a.unionCount([w.b, w.c], o)).toBe(await drainLength(w.a.union([w.b, w.c], o)));
      expect(await w.a.andNotCount([w.b], o)).toBe(await drainLength(w.a.andNot([w.b], o)));
    }
  });

  it('exclude subtracts on intersectCount and unionCount', async () => {
    const w = await world();
    expect(await w.a.intersectCount([w.b], { exclude: [w.d] })).toBe(minus(inter(A, B), D).length);
    expect(await w.a.unionCount([w.b], { exclude: [w.d] })).toBe(
      setOf(minus([...A, ...B], D)).size,
    );
  });

  it('concurrency changes nothing about the figure, and a bad one is refused', async () => {
    const w = await world();
    for (const concurrency of [1, 2, 7, 64]) {
      expect(await w.a.unionCount([w.b, w.c], { concurrency })).toBe(union(A, B, C));
      expect(await w.a.andNotCount([w.b], { concurrency })).toBe(minus(A, B).length);
    }
    await expect(w.a.unionCount([w.b], { concurrency: 0 })).rejects.toThrow(
      /unionCount: concurrency must be an integer of at least 1; got 0/,
    );
  });

  it('budget refuses a count that would exceed it, and false lifts it', async () => {
    const w = await world();
    await expect(w.a.intersectCount([w.b], { budget: { maxRequests: 1 } })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(await w.a.intersectCount([w.b], { budget: false })).toBe(inter(A, B).length);
  });

  it('the write options, and exclude on andNotCount, are refused before any request', async () => {
    const w = await world();
    const calls: Record<string, Counts> = {
      intersectCount: (a, o, opt) => a.intersectCount(o, opt),
      unionCount: (a, o, opt) => a.unionCount(o, opt),
      andNotCount: (a, o, opt) => a.andNotCount(o, opt),
    };
    for (const [name, call] of Object.entries(calls)) {
      for (const bad of [{ allowEmpty: true }, { keep: 1 }, { metadata: {} }, { zz: 1 }]) {
        const err = await call(w.a, [w.b], bad).catch((e: unknown) => e);
        expect(err, `${name} ${JSON.stringify(bad)}`).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toMatch(new RegExp(`^${name}: unknown option`));
      }
    }
    const err = await w.a.andNotCount([w.b], { exclude: [w.d] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    await expect(w.a.unionCount([w.b], 5 as never)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('absent operands', () => {
  it('are refused as the streams refuse them, and counted as empty with allowAbsentOperands', async () => {
    const w = await world();
    const typo = w.seg('typo');
    for (const run of [
      () => w.a.intersectCount([typo]),
      () => w.a.unionCount([typo]),
      () => w.a.andNotCount([typo]),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(drainLength(w.a.union([typo]))).rejects.toBeInstanceOf(ValidationError);
    expect(await w.a.intersectCount([typo], { allowAbsentOperands: true })).toBe(0);
    expect(await w.a.unionCount([typo], { allowAbsentOperands: true })).toBe(A.length);
    expect(await w.a.andNotCount([typo], { allowAbsentOperands: true })).toBe(A.length);
    await expect(typo.unionCount([])).rejects.toBeInstanceOf(ValidationError);
    expect(await typo.unionCount([], { allowAbsentOperands: true })).toBe(0);
  });
});

describe('a pinned handle', () => {
  it('counts the generation it pinned, after a later load', async () => {
    const w = await world();
    const pinA = await w.a.pin();
    const pinB = await w.b.pin();
    await w.store.load({ segment: 'a' }, [1, 2, 3]);
    await w.store.load({ segment: 'b' }, [1]);
    expect(await pinA.intersectCount([pinB])).toBe(inter(A, B).length);
    expect(await pinA.unionCount([pinB])).toBe(union(A, B));
    expect(await pinA.andNotCount([pinB])).toBe(minus(A, B).length);
    expect(await pinA.unionCount([])).toBe(A.length);
    expect(await w.a.unionCount([])).toBe(3);
  });

  it('refuses one segment held at two generations, as the streams do', async () => {
    const w = await world();
    const pinA = await w.a.pin();
    await w.store.load({ segment: 'a' }, [1, 2, 3]);
    const err = await pinA.unionCount([w.a]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    await expect(drainLength(pinA.union([w.a]))).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails with NotFoundError when an erasure deleted what it pinned', async () => {
    const w = await world();
    const pinA = await w.a.pin();
    await w.store.load({ segment: 'a' }, [1]);
    await w.memory.storage.delete({ segment: 'a', generation: pinA.pinnedAt!.generation! });
    await expect(pinA.unionCount([w.b])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a leased handle', () => {
  const leased = async (w: Awaited<ReturnType<typeof world>>, name = 'a') =>
    w.seg(name).pin({ leaseUntil: w.state.t + HOUR });

  it('counts while the lease is live, as receiver, operand and exclude', async () => {
    const w = await world();
    const l = await leased(w);
    expect(await l.unionCount([w.b])).toBe(union(A, B));
    expect(await w.b.intersectCount([l])).toBe(inter(A, B).length);
    expect(await w.b.andNotCount([l])).toBe(minus(B, A).length);
    expect(await w.c.unionCount([w.b], { exclude: [l] })).toBe(setOf(minus([...C, ...B], A)).size);
    expect(await l.unionCount([])).toBe(A.length);
  });

  it('throws LeaseExpiredError once the lease has ended, at every site, before any request', async () => {
    const w = await world();
    const l = await leased(w);
    w.state.t += HOUR;
    const sites: Array<() => Promise<number>> = [
      () => l.intersectCount([w.b]),
      () => l.unionCount([w.b]),
      () => l.unionCount([]),
      () => l.andNotCount([w.b]),
      () => w.b.intersectCount([l]),
      () => w.b.unionCount([l]),
      () => w.b.andNotCount([l]),
      () => w.b.intersectCount([w.c], { exclude: [l] }),
      () => w.b.unionCount([w.c], { exclude: [l] }),
    ];
    for (const run of sites) {
      expect(errorKind(await run().catch((e: unknown) => e))).toBe('LeaseExpiredError');
    }
    const err = await l.unionCount([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseExpiredError);
  });

  it('a lease ending mid-count stops it with LeaseExpiredError', async () => {
    const w = await world();
    const big = idsIn(range(0, 300), 3);
    await w.store.load({ segment: 'big1' }, big);
    await w.store.load({ segment: 'big2' }, big);
    const l = await w.seg('big1').pin({ leaseUntil: w.state.t + HOUR });
    const real = w.memory.storage.getRange.bind(w.memory.storage);
    let reads = 0;
    w.memory.storage.getRange = ((...a: Parameters<typeof real>) => {
      reads += 1;
      if (reads === 2) w.state.t += HOUR;
      return real(...a);
    }) as typeof w.memory.storage.getRange;
    for (const run of [
      () => l.intersectCount([w.seg('big2')], { concurrency: 1 }),
      () => l.unionCount([w.seg('big2')], { concurrency: 1 }),
    ]) {
      reads = 0;
      w.state.t = T0;
      const err = await run().catch((e: unknown) => e);
      expect(reads).toBeGreaterThan(1);
      expect(errorKind(err)).toBe('LeaseExpiredError');
    }
    w.memory.storage.getRange = real;
  });
});

describe('the count methods are on the handles beside the streams', () => {
  it('each is an async method returning a number', async () => {
    const w = await world();
    for (const m of ['intersectCount', 'unionCount', 'andNotCount'] as const) {
      const r = w.a[m]([w.b]);
      expect(r).toBeInstanceOf(Promise);
      expect(typeof (await r)).toBe('number');
    }
  });
});
