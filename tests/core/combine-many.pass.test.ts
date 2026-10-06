/**
 * The pass of a batch combine, held to account against sources that record what they are asked and sources that lie:
 * request counts, pruning, the memory ledger, the checks on untrusted bytes, leases, the window of reads in flight, and
 * the order of groups and publishes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileCombineMany, runCombineMany } from '@/core/combine-many';
import type { CombineExpr, CombineManyOperand } from '@/core/combine-many';
import { BudgetExceededError, IntegrityError, LeaseExpiredError } from '@/core/errors';
import type { ChunkRead, ReadChunksOptions, SegmentRef, StorageChunkSource } from '@/core/ports';
import { roaringCodec, SafeBitmap } from '@/roaring-codec';
import { StreamChunkSource } from '../helpers/stream-chunk-source';
import { collecting, request, runBatch, seed } from '../helpers/combine-many';
import type { Published } from '../helpers/combine-many';
import { joinId } from '@/core/bit-route';

const clock = { now: () => 0, sleep: async () => {} };
const ids = (chunks: readonly number[], per = 3): number[] =>
  chunks.flatMap((c) => Array.from({ length: per }, (_, i) => joinId(c, i + 1)));
const ok = (o: { ok: boolean }): Published => {
  expect(o.ok).toBe(true);
  return (o as unknown as { value: Published }).value;
};
const bytesOf = (values: number[]): Uint8Array => SafeBitmap.fromValues(values).serialize();

/** A source over a table of chunk bytes per segment: what a test needs when the source must lie or fail. */
class TableSource implements StorageChunkSource {
  readonly opens: Array<{ segment: string; keys: readonly number[] }> = [];
  inFlight = 0;
  peak = 0;
  /** What `listChunkKeys` answers, when it differs from the table's keys. */
  listed: Record<string, number[]> = {};
  /** What `cardinalities` answers, when it should lie. */
  cards: ((segment: string, key: number) => number) | undefined;
  /** Hold every range request for a macrotask, so concurrent ones overlap. */
  slow = false;
  events: string[] = [];

  constructor(readonly table: Record<string, Record<number, Uint8Array | null>>) {}

  getChunk(): Promise<Uint8Array | null> {
    return Promise.reject(new Error('getChunk is not used by a batch'));
  }

  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return Promise.resolve(
      this.listed[ref.segment] ?? Object.keys(this.table[ref.segment] ?? {}).map(Number),
    );
  }

  cardinalities(ref: SegmentRef): Promise<ReadonlyMap<number, number> | null> {
    if (this.cards === undefined) return Promise.resolve(null);
    const cards = this.cards;
    return Promise.resolve(
      new Map(
        (this.listed[ref.segment] ?? Object.keys(this.table[ref.segment] ?? {}).map(Number)).map(
          (k) => [k, cards(ref.segment, k)],
        ),
      ),
    );
  }

  async *getChunks(
    ref: SegmentRef,
    keys: readonly number[],
    options?: ReadChunksOptions,
  ): AsyncGenerator<ChunkRead> {
    this.opens.push({ segment: ref.segment, keys });
    this.events.push(`open ${ref.segment}`);
    for (const key of keys) {
      const request = async (): Promise<Uint8Array | null> => {
        this.inFlight++;
        this.peak = Math.max(this.peak, this.inFlight);
        if (this.slow) await new Promise<void>((r) => setImmediate(r));
        this.inFlight--;
        return this.table[ref.segment]?.[key] ?? null;
      };
      const bytes = await (options?.retry ? options.retry(request) : request());
      options?.onRequest?.({ bytes: bytes?.length ?? 0, ms: 0 });
      yield { key, bytes, version: null };
    }
  }
}

const operandsOf = (
  names: string[],
  extra: Partial<CombineManyOperand> = {},
): CombineManyOperand[] => names.map((name) => ({ name, ref: { segment: name }, ...extra }));

async function run(
  source: StorageChunkSource,
  names: string[],
  specs: Array<{ expr: CombineExpr; exclude?: CombineExpr[] }>,
  extra: Parameters<typeof request>[2] = {},
  publishHook?: () => Promise<void> | void,
) {
  const outputs = specs.map((s) => {
    const base = collecting(s);
    return publishHook === undefined
      ? base
      : {
          ...base,
          publish: async (...a: Parameters<typeof base.publish>) => {
            await publishHook();
            return base.publish(...a);
          },
        };
  });
  return runCombineMany(
    compileCombineMany({
      operands: operandsOf(names),
      outputs,
      keep: 1,
      maxBufferedBytes: 256 << 20,
      publishConcurrency: 8,
      concurrency: 1,
      allowAbsentOperands: true,
      ...extra,
    }),
    { source, codec: roaringCodec, clock },
  );
}

describe('request counts', () => {
  it('opens each operand once per group and reads each of its needed chunks once', async () => {
    const sets = { a: ids([1, 2, 3, 4, 5]), b: ids([2, 3, 4, 5, 6]), c: ids([4, 5, 9]) };
    const specs = Array.from({ length: 30 }, (_, i) => ({
      expr: i % 2 === 0 ? { and: ['a', 'b'] } : { or: ['b', 'c'] },
    }));
    const { run: r, setup } = await runBatch(sets, specs);
    expect(r.stats.groups).toBe(1);
    const opened = setup.source.opened.map((s) => s.segment).sort();
    expect(opened).toEqual(['a', 'b', 'c']);
    // and(a,b) needs 2..5 of both; or(b,c) needs all of b and c.
    expect(r.stats.operands.a!.chunkReads).toBe(4);
    expect(r.stats.operands.b!.chunkReads).toBe(5);
    expect(r.stats.operands.c!.chunkReads).toBe(3);
    expect(r.stats.requests.chunkReads).toBe(12);
    expect(r.stats.budget).toMatchObject({ planned: 12, used: 12 });
    expect(r.stats.budget.maxRequests).toBe(12 * 2 + 1000);
  });

  it('re-reads an operand once per group, never more than the groups that use it', async () => {
    const sets = { a: ids([1, 2, 3]), b: ids([1, 2, 3]) };
    const specs = Array.from({ length: 40 }, () => ({ expr: { and: ['a', 'b'] } }));
    const { run: r, setup } = await runBatch(sets, specs, { maxBufferedBytes: 120_000 });
    expect(r.stats.groups).toBeGreaterThan(1);
    for (const name of ['a', 'b']) {
      expect(setup.source.opened.filter((s) => s.segment === name)).toHaveLength(r.stats.groups);
    }
    r.outputs.forEach((o) => expect(ok(o).ids).toEqual(ids([1, 2, 3])));
    expect(r.stats.memory.highWaterBytes).toBeLessThanOrEqual(120_000);
  });

  it('starts the next group only after the previous group settled its publishes', async () => {
    const sets = { a: ids([1, 2, 3]), b: ids([1, 2, 3]) };
    const setup = seed(sets);
    const events: string[] = [];
    const base = setup.source.getChunks.bind(setup.source);
    setup.source.getChunks = (ref, keys, options) => {
      events.push(`open ${ref.segment}`);
      return base(ref, keys, options);
    };
    const outputs = Array.from({ length: 40 }, () => {
      const o = collecting({ expr: { and: ['a', 'b'] } });
      return {
        ...o,
        publish: async (...a: Parameters<typeof o.publish>) => {
          const r = await o.publish(...a);
          await new Promise<void>((res) => setImmediate(res));
          events.push('settled');
          return r;
        },
      };
    });
    const r = await runCombineMany(
      compileCombineMany(request(setup, outputs, { maxBufferedBytes: 120_000 })),
      { source: setup.source, codec: roaringCodec, clock },
    );
    expect(r.stats.groups).toBeGreaterThan(1);
    // Two operands open per group: between one group's opens and the next's, every publish of the first has settled.
    const perGroup = new Map<number, number>();
    for (const o of r.stats.outputs) perGroup.set(o.group!, (perGroup.get(o.group!) ?? 0) + 1);
    let settled = 0;
    let opens = 0;
    for (const e of events) {
      if (e === 'settled') settled++;
      else if (++opens % 2 === 1 && opens > 1) {
        const finished = [...perGroup.entries()]
          .filter(([g]) => g < (opens - 1) / 2)
          .reduce((n, [, c]) => n + c, 0);
        expect(settled).toBe(finished);
      }
    }
  });
});

describe('pruning, counted', () => {
  const sets = {
    a: ids([1, 2, 3, 4]),
    b: ids([3, 4, 5, 6]),
    x: ids(Array.from({ length: 60 }, (_, i) => i + 1)),
    far: ids([40, 41]),
  };
  const opened = (src: StreamChunkSource, name: string) =>
    src.opened.filter((s) => s.segment === name).flatMap((s) => [...s.keys]);

  it('and reads the intersection of keys, or the union, andNot the left keys, an exclude only where it overlaps', async () => {
    const one = async (expr: CombineExpr, exclude?: CombineExpr[]) =>
      runBatch(sets, [{ expr, ...(exclude ? { exclude } : {}) }]);
    let r = await one({ and: ['a', 'b'] });
    expect(opened(r.setup.source, 'a')).toEqual([3, 4]);
    expect(opened(r.setup.source, 'b')).toEqual([3, 4]);
    r = await one({ or: ['a', 'b'] });
    expect(opened(r.setup.source, 'a')).toEqual([1, 2, 3, 4]);
    expect(opened(r.setup.source, 'b')).toEqual([3, 4, 5, 6]);
    r = await one({ andNot: ['a', 'b'] });
    expect(opened(r.setup.source, 'a')).toEqual([1, 2, 3, 4]);
    expect(opened(r.setup.source, 'b')).toEqual([3, 4]);
    r = await one('a', ['x']);
    // a 60-chunk exclude is read at the 4 keys the output can hold, not at its own 60
    expect(opened(r.setup.source, 'x')).toEqual([1, 2, 3, 4]);
    expect(r.run.stats.chunks.pruned).toBe(56);
    r = await one({ and: ['a', 'far'] });
    expect(r.setup.source.opened).toEqual([]);
    expect(ok(r.run.outputs[0]!).ids).toEqual([]);
  });

  it('fetches what an independent model of the demand rules says, over random trees', async () => {
    const names = Object.keys(sets);
    const keysOf = (n: string): Set<number> =>
      new Set(
        Object.keys(sets).includes(n)
          ? [...new Set((sets as Record<string, number[]>)[n]!.map((v) => v >>> 16))]
          : [],
      );
    const S = (e: CombineExpr): Set<number> => {
      if (typeof e === 'string') return keysOf(e);
      if ('and' in e) return e.and.map(S).reduce((x, y) => new Set([...x].filter((k) => y.has(k))));
      if ('or' in e) return e.or.map(S).reduce((x, y) => new Set([...x, ...y]));
      return S(e.andNot[0]!);
    };
    const demand = (e: CombineExpr, d: Set<number>, into: Map<string, Set<number>>): void => {
      const here = new Set([...d].filter((k) => S(e).has(k)));
      if (typeof e === 'string') {
        const set = into.get(e) ?? new Set<number>();
        here.forEach((k) => set.add(k));
        into.set(e, set);
      } else
        for (const kid of 'and' in e ? e.and : 'or' in e ? e.or : e.andNot) demand(kid, here, into);
    };
    const tree = (depth: number): fc.Arbitrary<CombineExpr> =>
      depth === 0
        ? fc.constantFrom(...names)
        : fc.oneof(
            fc.constantFrom(...names),
            fc.array(tree(depth - 1), { minLength: 1, maxLength: 3 }).map((and) => ({ and })),
            fc.array(tree(depth - 1), { minLength: 1, maxLength: 3 }).map((or) => ({ or })),
            fc.array(tree(depth - 1), { minLength: 2, maxLength: 3 }).map((andNot) => ({ andNot })),
          );
    await fc.assert(
      fc.asyncProperty(tree(4), async (expr) => {
        const { setup } = await runBatch(sets, [{ expr }]);
        const want = new Map<string, Set<number>>();
        demand(expr, S(expr), want);
        for (const name of names) {
          const got = new Set(opened(setup.source, name));
          expect([...got].sort((x, y) => x - y)).toEqual(
            [...(want.get(name) ?? [])].sort((x, y) => x - y),
          );
        }
      }),
      { numRuns: 80 },
    );
  });

  it('a range prunes every operand to the chunks it overlaps', async () => {
    const r = await runBatch(sets, [{ expr: { or: ['a', 'b'] } }], {
      after: 2 * 65_536 + 5,
      through: 4 * 65_536,
    });
    expect(opened(r.setup.source, 'a')).toEqual([2, 3, 4]);
    expect(opened(r.setup.source, 'b')).toEqual([3, 4]);
    const empty = await runBatch(sets, [{ expr: 'a' }], { after: 100, through: 100 });
    expect(empty.setup.source.opened).toEqual([]);
    expect(ok(empty.run.outputs[0]!).ids).toEqual([]);
  });
});

describe('untrusted bytes: each fails the outputs that read the operand and nothing else', () => {
  const good = bytesOf([1, 2, 3]);
  const table = (bad: Record<number, Uint8Array | null>) =>
    new TableSource({ good: { 1: good, 2: good }, bad, other: { 1: good, 2: good } });
  const specs = [
    { expr: { and: ['good', 'bad'] } },
    { expr: { or: ['good', 'other'] } },
    { expr: 'bad', exclude: ['good'] },
  ];

  const cases: Array<[string, () => TableSource, new (...a: never[]) => Error, RegExp]> = [
    [
      'a corrupt chunk',
      () => table({ 1: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]), 2: good }),
      IntegrityError,
      /./,
    ],
    [
      'an out-of-range payload',
      () => table({ 1: bytesOf([70_000]), 2: good }),
      IntegrityError,
      /outside the 16-bit/,
    ],
    [
      'a listed key with no bytes',
      () => table({ 1: null, 2: good }),
      IntegrityError,
      /holds no bytes/,
    ],
  ];
  it.each(cases)('%s', async (_name, build, error, message) => {
    const r = await run(build(), ['good', 'bad', 'other'], specs);
    for (const i of [0, 2]) {
      const out = r.outputs[i]!;
      expect(out.ok).toBe(false);
      expect((out as { error: unknown }).error).toBeInstanceOf(error);
      expect((out as { error: Error }).error.message).toMatch(message);
    }
    expect(ok(r.outputs[1]!).keys).toEqual([1, 2]);
  });

  it('a listed key twice', async () => {
    const source = table({ 1: good, 2: good });
    source.listed.bad = [1, 1, 2];
    const r = await run(source, ['good', 'bad', 'other'], specs);
    expect((r.outputs[0] as { error: Error }).error).toBeInstanceOf(IntegrityError);
    expect((r.outputs[0] as { error: Error }).error.message).toMatch(/listed twice/);
    ok(r.outputs[1]!);
  });

  it('a key outside the 16-bit range', async () => {
    const source = table({ 1: good, 2: good });
    source.listed.bad = [1, 70_000];
    const r = await run(source, ['good', 'bad', 'other'], specs);
    expect((r.outputs[0] as { error: Error }).error).toBeInstanceOf(IntegrityError);
    ok(r.outputs[1]!);
  });

  it('a cardinality outside a chunk', async () => {
    const source = table({ 1: good, 2: good });
    source.cards = (segment) => (segment === 'bad' ? 70_000 : 3);
    const r = await run(source, ['good', 'bad', 'other'], specs);
    expect((r.outputs[0] as { error: Error }).error).toBeInstanceOf(IntegrityError);
    ok(r.outputs[1]!);
  });

  it('an exclude with a hole is a failure, never a subtraction of nothing', async () => {
    const source = table({});
    source.table.optout = { 1: null };
    const r = await run(source, ['good', 'optout'], [{ expr: 'good', exclude: ['optout'] }]);
    expect(r.outputs[0]!.ok).toBe(false);
  });
});

describe('the memory ledger', () => {
  /** Big chunks whose index says each holds one id. */
  const big = () => bytesOf(Array.from({ length: 20_000 }, (_, i) => i * 3));
  const liar = () => {
    const source = new TableSource({
      a: Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [k, big()])),
    });
    source.cards = () => 1;
    return source;
  };

  it('never passes maxBufferedBytes even when the index understates every chunk', async () => {
    const limit = 600_000;
    const r = await run(
      liar(),
      ['a'],
      Array.from({ length: 40 }, () => ({ expr: 'a' })),
      {
        maxBufferedBytes: limit,
      },
    );
    expect(r.stats.memory.highWaterBytes).toBeLessThanOrEqual(limit);
    expect(r.stats.groups).toBeGreaterThan(1);
    r.outputs.forEach((o) => expect(ok(o).ids).toHaveLength(6 * 20_000));
  });

  it('an output that cannot fit alone has BudgetExceededError, and the others publish', async () => {
    const source = liar();
    source.table.small = { 0: bytesOf([1, 2, 3]) };
    const r = await run(source, ['a', 'small'], [{ expr: 'a' }, { expr: 'small' }], {
      maxBufferedBytes: 40_000,
    });
    expect((r.outputs[0] as { error: Error }).error).toBeInstanceOf(BudgetExceededError);
    expect(ok(r.outputs[1]!).ids).toEqual([1, 2, 3]);
    expect(r.stats.memory.highWaterBytes).toBeLessThanOrEqual(40_000);
  });

  it('refuses at the plan an output whose own bound exceeds the budget, naming the minimum', async () => {
    const source = new TableSource({ a: Object.fromEntries([0, 1, 2].map((k) => [k, big()])) });
    const r = await run(source, ['a'], [{ expr: 'a' }], { maxBufferedBytes: 10_000 });
    expect((r.outputs[0] as { error: Error }).error.message).toMatch(
      /raise maxBufferedBytes to at least \d+/,
    );
    expect(source.opens).toEqual([]);
  });

  it('publishes at most publishConcurrency outputs at once', async () => {
    let now = 0;
    let peak = 0;
    const sets = { a: ids([1, 2]) };
    const r = await runBatch(
      sets,
      Array.from({ length: 30 }, () => ({ expr: 'a' })),
      { publishConcurrency: 3 },
    );
    void r;
    const source = new StreamChunkSource();
    seed(sets, source);
    const outputs = Array.from({ length: 30 }, () => ({
      ...collecting({ expr: 'a' }),
      publish: async () => {
        now++;
        peak = Math.max(peak, now);
        await new Promise<void>((res) => setImmediate(res));
        now--;
        return { ids: [], keys: [] };
      },
    }));
    await runCombineMany(
      compileCombineMany(
        request(seed(sets, source), outputs, { publishConcurrency: 3, allowAbsentOperands: true }),
      ),
      { source, codec: roaringCodec, clock },
    );
    expect(peak).toBe(3);
  });
});

describe('the window of reads in flight', () => {
  it('holds every range request of every operand inside one window', async () => {
    const names = Array.from({ length: 200 }, (_, i) => `op${i}`);
    const source = new TableSource(
      Object.fromEntries(names.map((n) => [n, { 1: bytesOf([1]), 2: bytesOf([2]) }])),
    );
    source.slow = true;
    const r = await run(source, names, [{ expr: { or: names } }]);
    expect(ok(r.outputs[0]!).keys).toEqual([1, 2]);
    expect(source.peak).toBeLessThanOrEqual(64);
    expect(source.peak).toBeGreaterThan(8);
    expect(r.stats.maxRangesInFlight).toBe(source.peak);
  });
});

describe('leases and deadlines, per key', () => {
  it('a lapse mid-pass fails only the outputs that read the operand, and never reads empty', async () => {
    const sets = { a: ids([1, 2, 3, 4, 5, 6]), b: ids([1, 2, 3, 4, 5, 6]) };
    const setup = seed(sets);
    let calls = 0;
    const operands: CombineManyOperand[] = [
      setup.operands[0]!,
      {
        ...setup.operands[1]!,
        check: () => {
          if (++calls === 3) throw new LeaseExpiredError('lapsed', 0, 'expired');
        },
      },
    ];
    const outputs = [{ expr: { and: ['a', 'b'] } }, { expr: 'a' }].map(collecting);
    const r = await runCombineMany(compileCombineMany({ ...request(setup, outputs), operands }), {
      source: setup.source,
      codec: roaringCodec,
      clock,
    });
    expect((r.outputs[0] as { error: unknown }).error).toBeInstanceOf(LeaseExpiredError);
    expect(ok(r.outputs[1]!).ids).toEqual(sets.a);
    expect(calls).toBe(3);
  });
});

describe('the exclude re-check', () => {
  it('refuses the outputs that exclude an operand whose generation moved, reads it once per group', async () => {
    const sets = { a: ids([1]), b: ids([1]), opt: ids([1]) };
    const setup = seed(sets);
    let reads = 0;
    const operands = setup.operands.map((o) =>
      o.name === 'opt'
        ? { ...o, pinnedGeneration: 3, currentGeneration: async () => (reads++, 4) }
        : { ...o, pinnedGeneration: 0, currentGeneration: async () => (reads++, 0) },
    );
    const outputs = [
      { expr: 'a', exclude: ['opt'] },
      { expr: 'b', exclude: ['a'] },
      { expr: { andNot: ['a', 'opt'] } },
    ].map(collecting);
    const r = await runCombineMany(compileCombineMany({ ...request(setup, outputs), operands }), {
      source: setup.source,
      codec: roaringCodec,
      clock,
    });
    expect((r.outputs[0] as { error: Error }).error.name).toBe('StaleOperandError');
    ok(r.outputs[1]!);
    ok(r.outputs[2]!);
    expect(reads).toBe(2);
    expect(r.stats.requests.registryReads).toBe(2);
    expect(r.stats.operands.opt).toMatchObject({ pinnedGeneration: 3, endGeneration: 4 });
  });

  it('an exclude that cannot be re-checked is not assumed unchanged', async () => {
    const setup = seed({ a: ids([1]), opt: ids([1]) });
    const operands = setup.operands.map((o) =>
      o.name === 'opt'
        ? {
            ...o,
            pinnedGeneration: 0,
            currentGeneration: () => Promise.reject(new Error('registry down')),
          }
        : o,
    );
    const r = await runCombineMany(
      compileCombineMany({
        ...request(setup, [collecting({ expr: 'a', exclude: ['opt'] })]),
        operands,
      }),
      { source: setup.source, codec: roaringCodec, clock },
    );
    expect((r.outputs[0] as { error: Error }).error.message).toBe('registry down');
  });
});

describe('budgets and absent operands', () => {
  it('throws before any chunk is read when the plan exceeds an explicit budget', async () => {
    const setup = seed({ a: ids([1, 2, 3]) });
    await expect(
      runCombineMany(
        compileCombineMany(
          request(setup, [collecting({ expr: 'a' })], { budget: { maxRequests: 2 } }),
        ),
        { source: setup.source, codec: roaringCodec, clock },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(setup.source.opened).toEqual([]);
  });

  it('lifts the limit with budget null', async () => {
    const setup = seed({ a: ids([1, 2, 3]) });
    const r = await runCombineMany(
      compileCombineMany(request(setup, [collecting({ expr: 'a' })], { budget: null })),
      { source: setup.source, codec: roaringCodec, clock },
    );
    expect(r.stats.budget.maxRequests).toBeNull();
  });
});
