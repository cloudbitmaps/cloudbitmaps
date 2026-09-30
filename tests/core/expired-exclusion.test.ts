import { MIN_EXPIRES_AT_MS, ValidationError, type Clock, type Segment } from '@/index';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * **An expired exclusion excludes nothing, in every shape of combine.**
 *
 * Expiry is a read rule: past its deadline a handle reads as gone. As an *exclusion*, gone means it subtracts
 * nothing. The rule used to hold for `andNot` and for a `union` whose operands had all expired, and not for
 * `intersect` or an ordinary `union`, which handed the expired handle to the engine and subtracted its ids. This
 * table holds every shape to the one rule, live and pinned, whole and range-read, against a model that knows
 * nothing about the shortcuts: a plain set algebra over the ids each case says are live.
 *
 * Every other rule is held where it was: an expired `self` or include operand is empty, and an absent operand is
 * refused unless `allowAbsentOperands` is set. The `*Into` verbs still throw on any expired handle, an exclusion
 * included, rather than publish a generation the exclusion did not shape.
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
  run: (c: Ctx) => AsyncIterable<number>;
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

type Kind = 'live' | 'expired' | 'both expired' | 'one of two expired';
const KINDS: { kind: Kind; ex: ('x1' | 'x2')[]; expired: ('x1' | 'x2')[] }[] = [
  { kind: 'live', ex: ['x1'], expired: [] },
  { kind: 'expired', ex: ['x1'], expired: ['x1'] },
  { kind: 'both expired', ex: ['x1', 'x2'], expired: ['x1', 'x2'] },
  { kind: 'one of two expired', ex: ['x1', 'x2'], expired: ['x1'] },
];

async function world(pinned: boolean) {
  const clock = fakeClock();
  const { store } = await loadedStore(IDS, { cache: { genTtlMs: 0 }, seams: { clock } });
  const handle = async (name: keyof typeof IDS, expiresAt?: number) => {
    const seg = store.segment(name, expiresAt === undefined ? {} : { expiresAt });
    return pinned ? seg.pin() : seg;
  };
  return { clock, store, handle };
}

describe.each([false, true])('an expired exclusion excludes nothing, pinned: %s', (pinned) => {
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

        const live = ex.filter((n) => !expired.includes(n)).map((n) => IDS[n]);
        const got = await collect(shape.run({ a, b, gone, ex: handles, opts: range }));
        const inRange = (id: number) =>
          (range.after === undefined || id > range.after) &&
          (range.through === undefined || id <= range.through);
        expect(got).toEqual(shape.model(live.flat()).filter(inRange));
      });
    });
  });
});

describe('an expired exclusion naming an absent segment is not refused as absent', () => {
  it.each(SHAPES.filter((s) => !s.name.includes('expired')))('$name', async (shape) => {
    const w = await world(false);
    const ghost = w.store.segment('no-such-list', { expiresAt: DEADLINE });
    const a = await w.handle('a');
    const b = await w.handle('b');
    const gone = await w.handle('gone', DEADLINE);
    w.clock.set(DEADLINE + 1);
    const ctx = { a, b, gone, ex: [ghost], opts: {} };
    expect(await collect(shape.run(ctx))).toEqual(shape.model([]));
  });
});

describe('an expired exclusion beside an absent include operand', () => {
  /** What each shape does with an absent include operand is unchanged: refused, or empty where none is read. */
  const cases: [
    string,
    (c: Ctx, absent: Segment, allow?: boolean) => AsyncIterable<number>,
    number[],
  ][] = [
    [
      'intersect',
      (c, absent, allow) => c.a.intersect([absent], { exclude: c.ex, allowAbsentOperands: allow }),
      [],
    ],
    [
      'union',
      (c, absent, allow) => c.a.union([absent], { exclude: c.ex, allowAbsentOperands: allow }),
      IDS.a,
    ],
    [
      'andNot (absent self)',
      (c, absent, allow) => absent.andNot(c.ex, { allowAbsentOperands: allow }),
      [],
    ],
  ];

  it.each(cases)('%s: refused, exactly as without the exclusion', async (_name, run) => {
    const w = await world(false);
    const absent = w.store.segment('not-loaded');
    const ex = [w.store.segment('x1', { expiresAt: DEADLINE })];
    w.clock.set(DEADLINE + 1);
    const c = { a: w.store.segment('a'), b: w.store.segment('b'), gone: absent, ex, opts: {} };
    await expect(collect(run(c, absent))).rejects.toThrow(/does not exist/);
  });

  it.each(cases)(
    '%s: with allowAbsentOperands, the exclusion subtracts nothing',
    async (_name, run, want) => {
      const w = await world(false);
      const absent = w.store.segment('not-loaded');
      const ex = [w.store.segment('x1', { expiresAt: DEADLINE })];
      w.clock.set(DEADLINE + 1);
      const c = { a: w.store.segment('a'), b: w.store.segment('b'), gone: absent, ex, opts: {} };
      expect(await collect(run(c, absent, true))).toEqual(want);
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
    await expect(go).rejects.toBeInstanceOf(ValidationError);
    expect(await dest.count()).toBe(0);
  });
});
