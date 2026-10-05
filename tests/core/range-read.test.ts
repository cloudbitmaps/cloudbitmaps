/**
 * The range read: `iterate({ after, through })`, and the same two options on every combine, yield the ids in
 * `(after, through]` and fetch only the chunks the range spans.
 *
 * Built for keyset paging over a large pinned segment, where each page resumes after the last id it has: without
 * a range, every page walks from the first id. So each case below is checked three ways: the ids (exactly the
 * full read filtered to the range), the reads (only the chunks in range are fetched), and the budget (charged by
 * those chunks alone). Every case runs on a live handle and on a pinned one, which read through different sources.
 */
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkReads } from '../helpers/chunk-reads';
import { CloudRoaring, CountingMetricsSink, MemoryStorage } from '@/index';
import type { CloudRoaringOptions, IdRange, Segment } from '@/index';
import { BudgetExceededError, IntegrityError, NotFoundError, ValidationError } from '@/core/errors';
import { roaringCodec } from '@/roaring-codec';
import { collect, seedSegment } from '../helpers/loaded';
import { SafeBitmap } from '@/roaring-codec';
import { SegmentEngine } from '@cloudbitmaps/core';
import { brandAsBackend } from '@/core/ports';

/** The chunks each read asked the reader for: coalescing makes the request count smaller than the chunk count. */
const reads = chunkReads();
beforeEach(reads.start);
afterEach(reads.stop);

const K = 65_536;
const U32_MAX = 0xffff_ffff;

/** Ids at and around every chunk edge in chunks 0–4, then a gap (chunks 5 and 6), then chunk 7. */
const IDS = [
  ...[0, 1, 2, 3, 4].flatMap((k) => [0, 1, 2, 100, K - 2, K - 1].map((r) => k * K + r)),
  7 * K + 5,
  7 * K + 6,
];

/** What a range read must yield: the full read, filtered. */
const within = (ids: readonly number[], after?: number, through?: number): number[] =>
  ids
    .filter((id) => (after === undefined || id > after) && (through === undefined || id <= through))
    .sort((a, b) => a - b);

/**
 * The segment's chunks the range overlaps: what a range read fetches. An edge chunk is fetched even when none of its
 * ids turn out to be in range, because only its bytes can say; a chunk wholly outside the range is never fetched.
 */
const chunksIn = (ids: readonly number[], after?: number, through?: number): number => {
  const lo = after === undefined ? 0 : after + 1;
  const hi = through ?? U32_MAX;
  if (lo > hi) return 0;
  const keys = new Set(ids.map((id) => Math.floor(id / K)));
  return [...keys].filter((k) => k >= Math.floor(lo / K) && k <= Math.floor(hi / K)).length;
};

async function world(segments: Record<string, readonly number[]> = { a: IDS }) {
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  for (const [segment, ids] of Object.entries(segments)) await store.load({ segment }, ids);
  /** A second store over the same data, with a cold cache and its own counters. */
  const fresh = (options: Omit<CloudRoaringOptions, 'storage'> = {}) => {
    const metrics = new CountingMetricsSink();
    return {
      store: new CloudRoaring({ cache: { genTtlMs: 0 }, ...options, storage: backend, metrics }),
      metrics,
    };
  };
  return { backend, store, fresh };
}

/** The handle two ways: live, and pinned at the generation just loaded. */
async function handles(store: CloudRoaring, name: string): Promise<Array<[string, Segment]>> {
  return [
    ['live', store.segment(name)],
    ['pinned', await store.segment(name).pin()],
  ];
}

const CASES: Array<[string, number | undefined, number | undefined]> = [
  ['inside one chunk', K + 1, K + 100],
  ['a single id', K - 1, K],
  ['across several chunks', 50, 3 * K + 5],
  ['through the last id of a chunk', 10, K - 1],
  ['through the second-last id of a chunk', 10, K - 2],
  ['through the first id of the next', 10, K],
  ['through the second id of the next', 10, K + 1],
  ['after the last id of a chunk', K - 1, 2 * K + 2],
  ['after the first id of a chunk', K, 2 * K + 2],
  ['after the second id of a chunk', K + 1, 2 * K + 2],
  ['after left out', undefined, 2 * K + 1],
  ['through left out', 2 * K + 1, undefined],
  ['both left out', undefined, undefined],
  ['spanning the gap', 4 * K + 100, 7 * K + 5],
  ['only the gap', 5 * K, 7 * K],
  ['past the largest id', 8 * K, undefined],
  ['after equal to through', 2 * K, 2 * K],
  ['after above through', 3 * K, 2 * K],
  ['after at the largest possible id', U32_MAX, undefined],
  ['the whole id space', 0, U32_MAX],
];

describe('iterate({ after, through }) yields exactly (after, through], ascending', () => {
  for (const [name, after, through] of CASES) {
    it(name, async () => {
      const w = await world();
      for (const [kind, seg] of await handles(w.store, 'a')) {
        expect(await collect(seg.iterate({ after, through })), kind).toEqual(
          within(IDS, after, through),
        );
      }
    });
  }

  it('an empty options object is the full read', async () => {
    const w = await world();
    expect(await collect(w.store.segment('a').iterate({}))).toEqual(IDS);
  });
});

describe('a range read fetches only the chunks the range spans', () => {
  for (const [name, after, through] of CASES) {
    it(name, async () => {
      const w = await world();
      for (const kind of ['live', 'pinned'] as const) {
        const { store } = w.fresh();
        const seg = kind === 'live' ? store.segment('a') : await store.segment('a').pin();
        reads.reset();
        await collect(seg.iterate({ after, through }));
        expect(reads.total(), kind).toBe(chunksIn(IDS, after, through));
      }
    });
  }

  it('an empty range reads nothing at all, not even the index', async () => {
    const w = await world();
    let reads = 0;
    const counted = new Proxy(w.backend.storage, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (prop === 'getRange' || prop === 'getTail') reads += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: counted, registry: w.backend.registry }),
      cache: { genTtlMs: 0 },
    });
    expect(await collect(store.segment('a').iterate({ after: 2 * K, through: 2 * K }))).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe('the budget is charged by the chunks in range', () => {
  it('a range over two chunks fits a budget of two that the full read exceeds', async () => {
    const w = await world();
    const { store } = w.fresh({ budget: { maxRequests: 2 } });
    for (const seg of [store.segment('a'), await store.segment('a').pin()]) {
      await expect(collect(seg.iterate())).rejects.toThrow(BudgetExceededError);
      expect(await collect(seg.iterate({ after: K - 1, through: 2 * K + 100 }))).toEqual(
        within(IDS, K - 1, 2 * K + 100),
      );
      await expect(collect(seg.iterate({ after: K - 1, through: 3 * K }))).rejects.toThrow(
        BudgetExceededError,
      );
    }
  });
});

describe('a combine is charged by the chunks in range, on every operand', () => {
  it('an intersect over two shared chunks fits a budget of four that the full intersect exceeds', async () => {
    const w = await world({ a: IDS, b: IDS });
    const { store } = w.fresh({ budget: { maxRequests: 4 } });
    const a = store.segment('a');
    const b = store.segment('b');
    await expect(collect(a.intersect([b]))).rejects.toThrow(BudgetExceededError); // 6 keys × 2 operands
    const range = { after: K - 1, through: 2 * K + 100 }; // keys 1 and 2, in both operands: 4 reads
    expect(await collect(a.intersect([b], range))).toEqual(within(IDS, K - 1, 2 * K + 100));
    await expect(collect(a.intersect([b], { after: K - 1, through: 3 * K }))).rejects.toThrow(
      BudgetExceededError,
    );
  });
});

describe('a bad bound throws ValidationError when the stream is first read', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['a negative after', { after: -1 }],
    ['a fractional after', { after: 1.5 }],
    ['a NaN through', { through: Number.NaN }],
    ['a through past the largest id', { through: U32_MAX + 1 }],
    ['an infinite after', { after: Number.POSITIVE_INFINITY }],
    ['a string through', { through: '5' }],
  ];
  for (const [name, range] of BAD) {
    it(name, async () => {
      const w = await world({ a: IDS, b: IDS });
      const a = w.store.segment('a');
      const b = w.store.segment('b');
      const bad = range as IdRange;
      const reads = [
        () => a.iterate(bad),
        () => a.intersect([b], bad),
        () => a.union([b], bad),
        () => a.andNot([b], bad),
      ];
      for (const read of reads) {
        const stream = read(); // the call itself does not throw: refusals surface on iteration
        await expect(collect(stream)).rejects.toThrow(ValidationError);
      }
    });
  }
});

/** Fixtures for the combine checks: `b` holds half of `a` and one chunk of its own, `s` excludes a few ids. */
const A = IDS;
const B = [...IDS.filter((_, i) => i % 2 === 0), 6 * K + 1];
const S = [1, K + 100, 3 * K - 2, 7 * K + 6];

describe('every combine takes the range, on every operand and every exclude', () => {
  const RANGES: Array<[number | undefined, number | undefined]> = [
    [K + 1, 3 * K + 5],
    [undefined, 2 * K],
    [2 * K + 1, undefined],
    [4 * K + 100, 7 * K + 5],
    [3 * K, 3 * K],
  ];

  it('intersect, union and andNot, with and without exclude, equal the full combine filtered', async () => {
    const w = await world({ a: A, b: B, s: S });
    const a = w.store.segment('a');
    const b = w.store.segment('b');
    const s = w.store.segment('s');
    for (const [after, through] of RANGES) {
      const range = { after, through };
      const combos: Array<[string, (o: IdRange) => AsyncIterable<number>]> = [
        ['intersect', (o) => a.intersect([b], o)],
        ['intersect, exclude', (o) => a.intersect([b], { ...o, exclude: [s] })],
        ['union', (o) => a.union([b], o)],
        ['union, exclude', (o) => a.union([b], { ...o, exclude: [s] })],
        ['andNot', (o) => a.andNot([s], o)],
      ];
      for (const [name, run] of combos) {
        const full = await collect(run({}));
        expect(await collect(run(range)), `${name} ${after}..${through}`).toEqual(
          within(full, after, through),
        );
      }
    }
  });

  it('fetches only in-range chunks of every operand and exclude', async () => {
    const w = await world({ a: A, b: B, s: S });
    const { store, metrics } = w.fresh();
    const [after, through] = [K + 1, 3 * K + 5];
    reads.reset();
    await collect(
      store.segment('a').intersect([store.segment('b')], {
        after,
        through,
        exclude: [store.segment('s')],
      }),
    );
    // Keys 1, 2 and 3 are in both includes; the exclude holds keys 1 and 2 of them. Nothing outside is fetched.
    expect(reads.total()).toBe(3 + 3 + 2);
    expect(metrics.snapshot().intersect.fetchedChunks).toBe(3);
  });

  it('reads a pinned operand at its pin, inside the range', async () => {
    const w = await world({ a: A, b: B });
    const snap = await w.store.segment('b').pin();
    await w.store.load({ segment: 'b' }, [K + 2, 2 * K + 100]); // the world moves on
    const range = { after: K, through: 3 * K };
    expect(await collect(w.store.segment('a').intersect([snap], range))).toEqual(
      within(
        A.filter((id) => B.includes(id)),
        K,
        3 * K,
      ),
    );
  });

  it('an operand with data only outside the range is not refused as absent; a missing one still is', async () => {
    const w = await world({ a: A, far: [7 * K + 5] });
    const a = w.store.segment('a');
    const range = { after: K, through: 2 * K };
    expect(await collect(a.andNot([w.store.segment('far')], range))).toEqual(within(A, K, 2 * K));
    await expect(collect(a.andNot([w.store.segment('never-loaded')], range))).rejects.toThrow(
      ValidationError,
    );
  });

  it('an operand with data only outside the range costs no existence check', async () => {
    const w = await world({ a: A, far: [7 * K + 5] });
    let rowReads = 0;
    const registry = new Proxy(w.backend.registry, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (prop === 'get') rowReads += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: w.backend.storage, registry }),
      cache: { genTtlMs: 0 },
    });
    const a = store.segment('a');
    const far = store.segment('far');
    await collect(a.andNot([far])); // opens both readers, so their pointers are not read again
    rowReads = 0;
    await collect(a.andNot([far], { after: K, through: 2 * K }));
    // `far` holds nothing in range, but it is a segment with data: it is not a suspect absent operand.
    expect(rowReads).toBe(0);
  });

  it('the *Into verbs write the range into their destination', async () => {
    const w = await world({ a: A, b: B, s: S });
    const a = w.store.segment('a');
    const dest = w.store.segment('dest');
    const range = { after: K + 1, through: 3 * K + 5 };
    await a.intersectInto(dest, [w.store.segment('b')], range);
    expect(await collect(dest.iterate())).toEqual(
      within(
        A.filter((id) => B.includes(id)),
        K + 1,
        3 * K + 5,
      ),
    );
    await a.unionInto(dest, [w.store.segment('b')], range);
    expect(await collect(dest.iterate())).toEqual(
      within([...new Set([...A, ...B])], K + 1, 3 * K + 5),
    );
    await a.andNotInto(dest, [w.store.segment('s')], range);
    expect(await collect(dest.iterate())).toEqual(
      within(
        A.filter((id) => !S.includes(id)),
        K + 1,
        3 * K + 5,
      ),
    );
  });
});

describe('the shortcuts for expired operands keep the range', () => {
  const DAY = 86_400_000;
  const T0 = 1_754_000_000_000;

  async function expiring() {
    let t = T0;
    const clock = { now: () => t, sleep: () => Promise.resolve() };
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 }, seams: { clock } });
    await store.load({ segment: 'a' }, IDS);
    await store.load({ segment: 'gone' }, [K + 1]);
    await store.load({ segment: 's' }, [K + 2]);
    return { store, expire: () => (t += 2 * DAY) };
  }

  it('a union whose every other operand expired is a range read of this one', async () => {
    const w = await expiring();
    const gone = w.store.segment('gone', { expiresAt: T0 + DAY });
    w.expire();
    const range = { after: K, through: 2 * K + 1 };
    expect(await collect(w.store.segment('a').union([gone], range))).toEqual(
      within(IDS, K, 2 * K + 1),
    );
    expect(
      await collect(
        w.store.segment('a').union([gone], { ...range, exclude: [w.store.segment('s')] }),
      ),
    ).toEqual(within(IDS, K, 2 * K + 1).filter((id) => id !== K + 2));
  });

  it('a union routed through an andNot whose excludes all expired is refused, range or not', async () => {
    const w = await expiring();
    const gone = w.store.segment('gone', { expiresAt: T0 + DAY });
    const staleOptOut = w.store.segment('s', { expiresAt: T0 + DAY });
    w.expire();
    const range = { after: K, through: 2 * K + 1 };
    await expect(
      collect(w.store.segment('a').union([gone], { ...range, exclude: [staleOptOut] })),
    ).rejects.toThrow(ValidationError);
  });

  it('an andNot whose every exclude expired is refused, range or not', async () => {
    const w = await expiring();
    const gone = w.store.segment('gone', { expiresAt: T0 + DAY });
    w.expire();
    await expect(
      collect(w.store.segment('a').andNot([gone], { after: K, through: 2 * K + 1 })),
    ).rejects.toThrow(ValidationError);
  });
});

describe('a range is read from any object that holds it, once, when the read is called', () => {
  class Page {
    get after(): number {
      return K;
    }
    get through(): number {
      return 2 * K + 1;
    }
  }
  const inherited = (): IdRange => Object.create({ after: K, through: 2 * K + 1 }) as IdRange;

  it('a getter or an inherited bound is honoured by every verb, the *Into verbs included', async () => {
    const w = await world({ a: IDS, b: IDS, s: [K + 2] });
    const a = w.store.segment('a');
    const b = w.store.segment('b');
    const s = w.store.segment('s');
    const want = within(IDS, K, 2 * K + 1);
    for (const range of [new Page(), inherited()]) {
      expect(await collect(a.iterate(range))).toEqual(want);
      expect(await collect(a.intersect([b], range))).toEqual(want);
      expect(await collect(a.union([b], range))).toEqual(want);
      expect(await collect(a.andNot([s], range))).toEqual(want.filter((id) => id !== K + 2));
      const dest = w.store.segment('dest');
      await a.intersectInto(dest, [b], range);
      expect(await collect(dest.iterate())).toEqual(want);
    }
  });

  it('every verb reads its range when it is called, not when the stream is first read', async () => {
    const w = await world({ a: IDS, b: IDS });
    const a = w.store.segment('a');
    const b = w.store.segment('b');
    const range = { after: K, through: 2 * K + 1 };
    const streams = [
      a.iterate(range),
      a.intersect([b], range),
      a.union([b], range),
      a.andNot([b], range),
    ];
    range.after = 0;
    range.through = 1;
    const want = within(IDS, K, 2 * K + 1);
    expect(await collect(streams[0]!)).toEqual(want);
    expect(await collect(streams[1]!)).toEqual(want);
    expect(await collect(streams[2]!)).toEqual(want);
    expect(await collect(streams[3]!)).toEqual([]);
  });

  it('a Symbol bound is refused with ValidationError, not a TypeError from the message', async () => {
    const w = await world();
    await expect(
      collect(w.store.segment('a').iterate({ after: Symbol('x') } as unknown as IdRange)),
    ).rejects.toThrow(ValidationError);
  });

  it('null options read the whole segment on every verb', async () => {
    const w = await world({ a: IDS, b: IDS });
    const a = w.store.segment('a');
    const b = w.store.segment('b');
    const none = null as unknown as undefined;
    expect(await collect(a.iterate(none))).toEqual(IDS);
    expect(await collect(a.intersect([b], none))).toEqual(IDS);
    expect(await collect(a.union([b], none))).toEqual(IDS);
    expect(await collect(a.andNot([b], none))).toEqual([]);
  });
});

describe("the expired-operand shortcuts keep the call's own budget", () => {
  const DAY = 86_400_000;
  const T0 = 1_754_000_000_000;

  it('a per-op budget, tighter or lifted, applies to a union whose other operands expired', async () => {
    let t = T0;
    const clock = { now: () => t, sleep: () => Promise.resolve() };
    const store = new CloudRoaring({
      storage: new MemoryStorage(),
      cache: { genTtlMs: 0 },
      seams: { clock },
      budget: { maxRequests: 2 },
    });
    await store.load({ segment: 'a' }, IDS); // six chunks
    await store.load({ segment: 'gone' }, [1]);
    const a = store.segment('a');
    const gone = store.segment('gone', { expiresAt: T0 + DAY });
    t += 2 * DAY;
    // The store's budget of 2 refuses a six-chunk read; `budget: false` on the call lifts it, as on any combine.
    expect(await collect(a.union([gone], { budget: false }))).toEqual(IDS);
    // …and a bad `concurrency` is refused there too.
    await expect(collect(a.union([gone], { concurrency: 0 }))).rejects.toThrow(ValidationError);
  });
});

describe('a pin keeps its guarantees under a range', () => {
  it('a pinned range read of a collected generation throws NotFoundError, not the next generation', async () => {
    const w = await world();
    const snap = await w.store.segment('a').pin();
    await w.store.load({ segment: 'a' }, [K + 3], { keep: 0 }); // collects the pinned generation
    await expect(collect(snap.iterate({ after: K, through: 2 * K }))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('the last page of a keyset walk over a collected pin throws too, rather than reading as the end of the data', async () => {
    const w = await world();
    const snap = await w.store.segment('a').pin();
    await w.store.load({ segment: 'a' }, [K + 3], { keep: 0 });
    await expect(collect(snap.iterate({ after: 8 * K }))).rejects.toThrow(NotFoundError);
  });

  it('an empty range on a collected pin reads nothing, so it answers empty rather than failing', async () => {
    const w = await world();
    const snap = await w.store.segment('a').pin();
    await w.store.load({ segment: 'a' }, [K + 3], { keep: 0 });
    expect(await collect(snap.iterate({ after: 2 * K, through: 2 * K }))).toEqual([]);
  });
});

describe('union, andNot and excludes fetch, and are charged, only in range — live and pinned', () => {
  const range = { after: K + 1, through: 3 * K + 5 }; // keys 1..3
  type Run = (h: (n: string) => Promise<Segment>, o: IdRange) => Promise<AsyncIterable<number>>;
  const CASES: Array<[string, Run, number]> = [
    ['union', async (h, o) => (await h('a')).union([await h('b')], o), 3 + 3],
    [
      'union, exclude',
      async (h, o) => (await h('a')).union([await h('b')], { ...o, exclude: [await h('s')] }),
      3 + 3 + 2,
    ],
    [
      'intersect, exclude',
      async (h, o) => (await h('a')).intersect([await h('b')], { ...o, exclude: [await h('s')] }),
      3 + 3 + 2,
    ],
    ['andNot', async (h, o) => (await h('a')).andNot([await h('s')], o), 3 + 2],
  ];
  for (const [name, run, gets] of CASES) {
    for (const kind of ['live', 'pinned'] as const) {
      it(`${name}, ${kind}`, async () => {
        const w = await world({ a: A, b: B, s: S });
        const handle = (st: CloudRoaring) => (n: string) =>
          kind === 'live' ? Promise.resolve(st.segment(n)) : st.segment(n).pin();
        const { store } = w.fresh();
        const stream = await run(handle(store), range);
        reads.reset();
        await collect(stream);
        expect(reads.total()).toBe(gets);
        const exact = w.fresh({ budget: { maxRequests: gets } }).store;
        await expect(collect(await run(handle(exact), {}))).rejects.toThrow(BudgetExceededError);
        await collect(await run(handle(exact), range)); // exactly the in-range reads fit
        const short = w.fresh({ budget: { maxRequests: gets - 1 } }).store;
        await expect(collect(await run(handle(short), range))).rejects.toThrow(BudgetExceededError);
      });
    }
  }
});

describe('the intersect metric counts only keys inside the range', () => {
  it('fetchedChunks and skippedChunks', async () => {
    const w = await world({ a: A, b: B, s: S });
    const { store, metrics } = w.fresh();
    const range = { after: K + 1, through: 3 * K + 5 };
    await collect(store.segment('a').intersect([store.segment('s')], range));
    expect(metrics.snapshot().intersect).toMatchObject({ fetchedChunks: 2, skippedChunks: 1 });
    metrics.reset();
    await collect(
      store
        .segment('a')
        .intersect([store.segment('b')], { ...range, exclude: [store.segment('s')] }),
    );
    expect(metrics.snapshot().intersect).toMatchObject({ fetchedChunks: 3, skippedChunks: 0 });
  });
});

describe('one-id ranges, and union edges held only by a later include', () => {
  it('a one-id range yields exactly that id, live and pinned', async () => {
    const w = await world({ a: A });
    for (const seg of [w.store.segment('a'), await w.store.segment('a').pin()]) {
      expect(await collect(seg.iterate({ after: K - 2, through: K - 1 }))).toEqual([K - 1]);
      expect(await collect(seg.iterate({ after: K - 1, through: K }))).toEqual([K]);
      expect(await collect(seg.iterate({ after: K, through: K + 1 }))).toEqual([K + 1]);
    }
  });
  it('union trims an edge chunk that the first include lacks', async () => {
    const w = await world({ a: A, b: B, s: S });
    const [a, b, s] = ['a', 'b', 's'].map((n) => w.store.segment(n)) as [Segment, Segment, Segment];
    expect(await collect(a.union([b], { after: 6 * K + 1, through: 7 * K + 5 }))).toEqual([
      7 * K + 5,
    ]);
    expect(await collect(a.union([b], { after: 6 * K, through: 6 * K + 1 }))).toEqual([6 * K + 1]);
    expect(await collect(s.union([a], { after: 3 * K + 1, through: 4 * K + 5 }))).toEqual(
      within(A, 3 * K + 1, 4 * K + 5),
    );
  });
});

describe('the remaining expired-operand shortcuts keep the range', () => {
  const DAY = 86_400_000;
  const T0 = 1_754_000_000_000;
  it('this handle expired; some operands expired', async () => {
    let t = T0;
    const clock = { now: () => t, sleep: () => Promise.resolve() };
    const store = new CloudRoaring({
      storage: new MemoryStorage(),
      cache: { genTtlMs: 0 },
      seams: { clock },
    });
    await store.load({ segment: 'a' }, IDS);
    await store.load({ segment: 'gone' }, [K + 1]);
    await store.load({ segment: 's' }, [K + 2]);
    const expiredA = store.segment('a', { expiresAt: T0 + DAY });
    const gone = store.segment('gone', { expiresAt: T0 + DAY });
    t += 2 * DAY;
    const a = store.segment('a');
    const s = store.segment('s');
    const range = { after: K, through: 2 * K + 1 };
    const want = within(IDS, K, 2 * K + 1);
    expect(await collect(expiredA.union([a], range))).toEqual(want);
    expect(await collect(a.union([gone, s], range))).toEqual(want);
    expect(await collect(a.andNot([s], range))).toEqual(want.filter((id) => id !== K + 2));
  });
});

describe('every combine reads each pinned operand and exclude at its pin, at the chunk edges', () => {
  it('intersect, union and andNot, with pinned and mixed operands and pinned excludes', async () => {
    const w = await world({ a: A, b: B, s: S });
    const pa = await w.store.segment('a').pin();
    const pb = await w.store.segment('b').pin();
    const ps = await w.store.segment('s').pin();
    const aNow = [K - 1, K, K + 1, 2 * K - 1, 2 * K, 2 * K + 1];
    const bNow = [K, K + 2, 2 * K];
    const sNow = [K, K + 2, 2 * K - 2];
    await w.store.load({ segment: 'a' }, aNow); // the world moves on, inside every range below
    await w.store.load({ segment: 'b' }, bNow);
    await w.store.load({ segment: 's' }, sNow);
    const lb = w.store.segment('b');
    const AB = A.filter((id) => B.includes(id));
    const AuB = [...new Set([...A, ...B])];
    for (const [after, through] of [
      [K - 1, 2 * K],
      [K, 2 * K + 1],
      [K + 1, 2 * K - 1],
    ] as const) {
      const r = { after, through };
      const cases: Array<[string, AsyncIterable<number>, number[]]> = [
        ['intersect', pa.intersect([pb], r), AB],
        [
          'intersect, pinned exclude',
          pa.intersect([pb], { ...r, exclude: [ps] }),
          AB.filter((id) => !S.includes(id)),
        ],
        [
          'live ∩ pinned, pinned exclude',
          lb.intersect([pa], { ...r, exclude: [ps] }),
          bNow.filter((id) => A.includes(id) && !S.includes(id)),
        ],
        ['union', pa.union([pb], r), AuB],
        [
          'union, pinned exclude',
          pa.union([pb], { ...r, exclude: [ps] }),
          AuB.filter((id) => !S.includes(id)),
        ],
        [
          'live ∪ pinned, pinned exclude',
          lb.union([pa], { ...r, exclude: [ps] }),
          [...new Set([...bNow, ...A])].filter((id) => !S.includes(id)),
        ],
        ['andNot', pa.andNot([ps], r), A.filter((id) => !S.includes(id))],
        ['live andNot pinned', lb.andNot([ps], r), bNow.filter((id) => !S.includes(id))],
      ];
      for (const [name, stream, full] of cases) {
        expect(await collect(stream), `${name} (${after}, ${through}]`).toEqual(
          within(full, after, through),
        );
      }
    }
  });
});

describe('an empty range reads nothing, on every verb, live and pinned', () => {
  it('no storage call and no registry call, with a positive control', async () => {
    const w = await world({ a: IDS, b: IDS });
    let calls = 0;
    const counting = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const value: unknown = Reflect.get(t, prop, receiver);
          if (typeof value !== 'function' || prop === 'capabilities') return value;
          return (...args: unknown[]) => {
            calls += 1;
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const store = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting(w.backend.storage),
        registry: counting(w.backend.registry),
      }),
      cache: { genTtlMs: 0 },
    });
    const a = store.segment('a');
    const b = store.segment('b');
    const pa = await a.pin();
    const empty = { after: 2 * K, through: 2 * K };
    calls = 0;
    for (const stream of [
      a.iterate(empty),
      pa.iterate(empty),
      a.intersect([b], empty),
      pa.intersect([b], { ...empty, exclude: [b] }),
      a.union([b], { ...empty, exclude: [b] }),
      a.andNot([b], empty),
    ]) {
      expect(await collect(stream)).toEqual([]);
    }
    expect(calls).toBe(0);
    await collect(a.iterate({ after: 2 * K, through: 2 * K + 1 }));
    expect(calls).toBeGreaterThan(0); // the same counters see a one-id read
  });
});

describe('andNot reads its range when it is called', () => {
  it('with an exclude that leaves ids in range', async () => {
    const w = await world({ a: IDS, s: [K + 2] });
    const range = { after: K, through: 2 * K + 1 };
    const stream = w.store.segment('a').andNot([w.store.segment('s')], range);
    range.after = 0;
    range.through = 1;
    expect(await collect(stream)).toEqual(within(IDS, K, 2 * K + 1).filter((id) => id !== K + 2));
  });
});

describe('property: a range read is the full read filtered to the range', () => {
  const ID = fc.oneof(
    fc.integer({ min: 0, max: 5 * K }),
    fc.integer({ min: 0, max: 5 }).map((k) => k * K), // the first id of a chunk
    fc.integer({ min: 1, max: 5 }).map((k) => k * K - 1), // the last id of a chunk
  );
  const BOUND = fc.option(ID, { nil: undefined });

  it('for iterate, intersect and andNot', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(ID, { minLength: 1, maxLength: 60 }),
        fc.uniqueArray(ID, { minLength: 1, maxLength: 60 }),
        BOUND,
        BOUND,
        async (a, b, after, through) => {
          const w = await world({ a, b });
          const sa = w.store.segment('a');
          const sb = w.store.segment('b');
          const range = { after, through };
          expect(await collect(sa.iterate(range))).toEqual(within(a, after, through));
          expect(await collect(sa.intersect([sb], range))).toEqual(
            within(
              a.filter((id) => b.includes(id)),
              after,
              through,
            ),
          );
          expect(await collect(sa.andNot([sb], range))).toEqual(
            within(
              a.filter((id) => !b.includes(id)),
              after,
              through,
            ),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('an index is untrusted', () => {
  it('a chunk key listed twice is refused, rather than read and yielded twice', async () => {
    const storage = new MemoryStorageChunkSource();
    storage.seed({ segment: 'a', chunkKey: 1 }, SafeBitmap.fromValues([5]).serialize());
    const twice: typeof storage.listChunkKeys = async (ref) => [
      ...(await storage.listChunkKeys(ref)),
      1,
    ];
    const store = new CloudRoaring({
      storage: Object.assign(Object.create(storage), { listChunkKeys: twice }),
    });
    await expect(collect(store.segment('a').iterate())).rejects.toThrow(IntegrityError);
    await expect(collect(store.segment('a').iterate({ after: 0 }))).rejects.toThrow(IntegrityError);
  });
});

describe("the engine's own range read, which the facade reaches only with a bound", () => {
  // The facade reads a segment with no range when it is given none, so only a direct engine call reaches the range
  // path with an empty range. `SegmentEngine` and `IdRange` are exported, so that call is public.
  it('an empty range is the whole id space: the first and the last possible id, and no chunk trimmed', async () => {
    const storage = new MemoryStorageChunkSource();
    const ids = [0, 1, K - 1, K, U32_MAX - K, U32_MAX - 1, U32_MAX];
    seedSegment(storage, 'a', ids);
    const engine = new SegmentEngine({ storage, codec: roaringCodec });
    expect(await collect(engine.iterate({ segment: 'a' }, {}))).toEqual(ids);
    expect(
      await collect(engine.iterate({ segment: 'a' }, { after: undefined, through: undefined })),
    ).toEqual(ids);
  });
});
