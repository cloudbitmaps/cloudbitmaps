import {
  MIN_EXPIRES_AT_MS,
  ValidationError,
  type Clock,
  type IdStream,
  type Segment,
} from '@/index';
import { CloudRoaring, CrbmStorageChunkSource } from '@/index';
import type { IRegistryDriver, IStorageDriver } from '@/index';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * **An exclusion past its `expiresAt` is refused, in every shape of combine.**
 *
 * An exclusion is a suppression or opt-out list. Read as empty, as an expired operand is, it would silently stop
 * excluding and the ids it exists to remove would come back. So a combine given an expired exclusion throws
 * `ValidationError` naming it, before any request is made: `andNot`, and `exclude` on `intersect` and `union`,
 * live and pinned, whole and range-read, per-id and `.batches()`. This table holds every shape to that rule, and
 * holds a live exclusion to a model that knows nothing about the shortcuts: a plain set algebra.
 *
 * Every other rule is where it was: an expired `self` or include operand is empty or dropped, an absent operand is
 * refused unless `allowAbsentOperands` is set, and the `*Into` verbs throw on any expired handle.
 */

const DEADLINE = MIN_EXPIRES_AT_MS + 1_000;
const IDS = { a: [1, 2, 3, 70_000], b: [2, 3, 4, 70_000], gone: [9], x1: [2, 70_000], x2: [3] };
const RANGE = { after: 2, through: 70_000 };
const RANGES: { after?: number; through?: number }[] = [{}, RANGE];

function fakeClock(): Clock & { set: (ms: number) => void } {
  let t = MIN_EXPIRES_AT_MS;
  return {
    now: () => t,
    sleep: () => Promise.resolve(),
    set: (ms) => {
      t = ms;
    },
  };
}

type Ids = readonly number[];
const minus = (from: Ids, ...drop: Ids[]): number[] =>
  from.filter((id) => !drop.some((d) => d.includes(id)));

interface Ctx {
  a: Segment;
  b: Segment;
  /** An include operand whose deadline has passed. */
  gone: Segment;
  ex: Segment[];
  opts: { after?: number; through?: number };
}

/** A shape: how the combine is spelled, and what it yields when `drop` is what the live exclusions hold. */
interface Shape {
  name: string;
  run: (c: Ctx) => IdStream;
  model: (drop: Ids) => number[];
}

const SHAPES: Shape[] = [
  {
    name: 'intersect',
    run: (c) => c.a.intersect([c.b], { ...c.opts, exclude: c.ex }),
    model: (drop) =>
      minus(
        IDS.a.filter((id) => IDS.b.includes(id)),
        drop,
      ),
  },
  {
    name: 'union',
    run: (c) => c.a.union([c.b], { ...c.opts, exclude: c.ex }),
    model: (drop) =>
      minus(
        [...new Set([...IDS.a, ...IDS.b])].sort((p, q) => p - q),
        drop,
      ),
  },
  {
    name: 'union, the other operand expired',
    run: (c) => c.a.union([c.gone], { ...c.opts, exclude: c.ex }),
    model: (drop) => minus(IDS.a, drop),
  },
  {
    name: 'union, self expired',
    run: (c) => c.gone.union([c.b], { ...c.opts, exclude: c.ex }),
    model: (drop) => minus(IDS.b, drop),
  },
  {
    name: 'union of one',
    run: (c) => c.a.union([], { ...c.opts, exclude: c.ex }),
    model: (drop) => minus(IDS.a, drop),
  },
  {
    name: 'intersect, an include operand expired',
    run: (c) => c.a.intersect([c.gone], { ...c.opts, exclude: c.ex }),
    model: () => [],
  },
  {
    name: 'andNot',
    run: (c) => c.a.andNot(c.ex, c.opts),
    model: (drop) => minus(IDS.a, drop),
  },
];

const STALE = /exclusions have expired/;

/** A store whose storage and registry count every call made on them, over the same segments. */
async function counted(pinned: boolean) {
  const clock = fakeClock();
  const seed = await loadedStore(IDS, { cache: { genTtlMs: 0 }, seams: { clock } });
  const calls: string[] = [];
  const recording = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, p, rx) {
        const v = Reflect.get(t, p, rx) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls.push(String(p));
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  const storage: IStorageDriver = recording(seed.backend.storage);
  const registry: IRegistryDriver = recording(seed.backend.registry);
  const store = new CloudRoaring({
    storage: new CrbmStorageChunkSource(storage, { registry }),
    cache: { genTtlMs: 0 },
    seams: { clock },
  });
  const handle = async (name: string, expiresAt?: number) => {
    const seg = store.segment(name, expiresAt === undefined ? {} : { expiresAt });
    return pinned ? seg.pin() : seg;
  };
  return { clock, store, handle, calls };
}

async function world(pinned: boolean) {
  const w = await counted(pinned);
  return {
    ...w,
    handle: w.handle as (name: keyof typeof IDS, expiresAt?: number) => Promise<Segment>,
  };
}

type Kind = 'live' | 'expired' | 'both expired' | 'one of two expired';
const KINDS: { kind: Kind; ex: ('x1' | 'x2')[]; expired: ('x1' | 'x2')[] }[] = [
  { kind: 'live', ex: ['x1'], expired: [] },
  { kind: 'expired', ex: ['x1'], expired: ['x1'] },
  { kind: 'both expired', ex: ['x1', 'x2'], expired: ['x1', 'x2'] },
  { kind: 'one of two expired', ex: ['x1', 'x2'], expired: ['x1'] },
];

describe.each([false, true])('an expired exclusion is refused, pinned: %s', (pinned) => {
  describe.each(SHAPES)('$name', (shape) => {
    describe.each(RANGES)('range %j', (range) => {
      it.each(KINDS)('$kind', async ({ ex, expired }) => {
        const w = await world(pinned);
        const a = await w.handle('a');
        const b = await w.handle('b');
        const gone = await w.handle('gone', DEADLINE);
        const handles = await Promise.all(
          ex.map((n) => w.handle(n, expired.includes(n) ? DEADLINE : DEADLINE * 2)),
        );
        w.clock.set(DEADLINE + 1); // `gone` and every expired exclusion are past it; the rest are not
        w.calls.length = 0;

        const ctx = { a, b, gone, ex: handles, opts: range };
        if (expired.length === 0) {
          const inRange = (id: number) =>
            (range.after === undefined || id > range.after) &&
            (range.through === undefined || id <= range.through);
          const live = ex.map((n) => IDS[n]).flat();
          expect(await collect(shape.run(ctx))).toEqual(shape.model(live).filter(inRange));
          return;
        }
        const message = new RegExp(`exclusions have expired — ${expired.join(', ')}\\.`);
        await expect(collect(shape.run(ctx))).rejects.toThrow(ValidationError);
        await expect(collect(shape.run(ctx))).rejects.toThrow(message);
        await expect(
          (async () => {
            for await (const batch of shape.run(ctx).batches()) void batch;
          })(),
        ).rejects.toThrow(message);
        expect(w.calls).toEqual([]); // before any request
      });
    });
  });
});

describe('an expired exclusion naming an absent segment is refused as expired, not as absent', () => {
  it.each(SHAPES)('$name', async (shape) => {
    const w = await world(false);
    const ghost = w.store.segment('no-such-list', { expiresAt: DEADLINE });
    const a = await w.handle('a');
    const b = await w.handle('b');
    const gone = await w.handle('gone', DEADLINE);
    w.clock.set(DEADLINE + 1);
    const err = await collect(shape.run({ a, b, gone, ex: [ghost], opts: {} })).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(STALE);
    expect((err as Error).message).not.toMatch(/does not exist/);
  });
});

describe('an expired exclusion is refused ahead of the expired-operand shortcuts', () => {
  it('on an expired self, an expired include operand, and an absent one', async () => {
    const w = await world(false);
    const a = await w.handle('a');
    const gone = await w.handle('gone', DEADLINE);
    const stale = await w.handle('x1', DEADLINE);
    const absent = w.store.segment('not-loaded');
    w.clock.set(DEADLINE + 1);
    for (const read of [
      () => gone.intersect([a], { exclude: [stale] }),
      () => a.intersect([gone], { exclude: [stale] }),
      () => gone.andNot([stale]),
      () => gone.union([gone], { exclude: [stale] }),
      () => a.union([absent], { exclude: [stale] }),
      () => a.intersect([absent], { exclude: [stale], allowAbsentOperands: true }),
      () => a.union([absent], { exclude: [stale], allowAbsentOperands: true }),
    ]) {
      await expect(collect(read())).rejects.toThrow(STALE);
    }
  });
});

describe('an expired operand reads exactly as before, beside a live exclusion', () => {
  it('is empty on an intersect, dropped from a union, and an expired self is empty or replaced', async () => {
    const w = await world(false);
    const a = await w.handle('a');
    const b = await w.handle('b');
    const gone = await w.handle('gone', DEADLINE);
    const x2 = await w.handle('x2');
    w.clock.set(DEADLINE + 1);
    expect(await collect(a.intersect([gone], { exclude: [x2] }))).toEqual([]);
    expect(await collect(a.union([gone], { exclude: [x2] }))).toEqual([1, 2, 70_000]);
    expect(await collect(gone.union([b], { exclude: [x2] }))).toEqual([2, 4, 70_000]);
    expect(await collect(gone.andNot([x2]))).toEqual([]);
    expect(await collect(a.union([gone]))).toEqual(IDS.a);
    expect(await collect(a.intersect([gone]))).toEqual([]);
    expect(await gone.count()).toBe(0);
  });
});

describe('an exclusion that has not expired still works', () => {
  it('whose deadline is ahead of the clock', async () => {
    const w = await world(false);
    const a = await w.handle('a');
    const b = await w.handle('b');
    const x1 = await w.handle('x1', DEADLINE * 2);
    w.clock.set(DEADLINE + 1);
    expect(await collect(a.andNot([x1]))).toEqual([1, 3]);
    expect(await collect(a.intersect([b], { exclude: [x1] }))).toEqual([3]);
    expect(await collect(a.union([b], { exclude: [x1] }))).toEqual([1, 3, 4]);
  });
});

describe('the refusal names each expired exclusion once, namespace-qualified', () => {
  it('lists the expired ones only', async () => {
    const w = await world(false);
    const a = await w.handle('a');
    const live = w.store.segment('x2', { expiresAt: DEADLINE * 2 });
    const x1 = w.store.segment('x1', { expiresAt: DEADLINE });
    const other = w.store.segment('x1', { namespace: 'acme', expiresAt: DEADLINE });
    w.clock.set(DEADLINE + 1);
    const err = await collect(a.andNot([x1, live, x1, other])).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe(
      'andNot: refusing to read while these exclusions have expired — x1, acme/x1. ' +
        'An expired exclusion would subtract nothing, so the result would include the ids it was passed to remove. ' +
        "Renew the exclusion's `expiresAt`, open it without one, or leave it out of the call.",
    );
  });
});

describe('the check is made when the combine is called, not per chunk', () => {
  it('a stream already reading when its exclusion expires finishes', async () => {
    const w = await world(false);
    const a = await w.handle('a');
    const x1 = await w.handle('x1', DEADLINE);
    const stream = a.andNot([x1]);
    const it = stream[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
    w.clock.set(DEADLINE + 1);
    const rest: number[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
    expect(rest).toEqual([3]);
    await expect(collect(a.andNot([x1]))).rejects.toThrow(STALE);
  });
});

describe('an expired exclusion is checked before the pin-consistency check', () => {
  /** The only pinned handle is the exclusion, and it names the segment `self` reads live. */
  const run = async (expiresAt: number | undefined, after: number) => {
    const w = await world(false);
    const a = w.store.segment('a');
    const b = w.store.segment('b');
    const pinnedA = await w.store.segment('a', expiresAt === undefined ? {} : { expiresAt }).pin();
    w.clock.set(after);
    return { a, b, pinnedA };
  };

  it.each(['intersect', 'union'] as const)(
    '%s: a live pin of the same segment is still refused as a pin mismatch',
    async (verb) => {
      const { a, b, pinnedA } = await run(undefined, DEADLINE + 1);
      const err = await collect(a[verb]([b], { exclude: [pinnedA] })).catch(
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).not.toMatch(STALE);
    },
  );

  it.each(['intersect', 'union'] as const)(
    '%s: an expired pin is refused as expired',
    async (verb) => {
      const { a, b, pinnedA } = await run(DEADLINE, DEADLINE + 1);
      await expect(collect(a[verb]([b], { exclude: [pinnedA] }))).rejects.toThrow(STALE);
    },
  );
});

describe('the *Into verbs refuse an expired exclusion and leave the destination alone', () => {
  it.each(['intersectInto', 'unionInto', 'andNotInto'] as const)('%s', async (verb) => {
    const w = await world(false);
    const a = w.store.segment('a');
    const b = w.store.segment('b');
    const dest = w.store.segment('dest');
    const stale = w.store.segment('x1', { expiresAt: DEADLINE });
    w.clock.set(DEADLINE + 1);
    const go =
      verb === 'andNotInto'
        ? a.andNotInto(dest, [stale])
        : a[verb](dest, [b], { exclude: [stale] });
    const err = await go.catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(
      /refusing to publish a generation while these handles have expired/,
    );
    expect(await dest.count()).toBe(0);
  });
});
