import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  LeaseExpiredError,
  NotFoundError,
  StaleOperandError,
  ValidationError,
  WriteConflictError,
  isStaleOperandError,
} from '@/index';
import type { MaterializeManyOutput, MaterializeResult, MetricEvent } from '@/index';
import { batchWorld, bitmapOf, range } from '../helpers/batch-world';

const DATA = {
  a: [...range(0, 70_000), ...range(200_000, 330_000, 7), ...range(500_000, 500_500)],
  b: [...range(30_000, 140_000), ...range(250_000, 300_000, 3), ...range(500_100, 500_200)],
  c: range(0, 400_000, 5),
  optout: range(0, 400_000, 11),
};

const published = (o: unknown): MaterializeResult => {
  const r = o as MaterializeResult;
  expect(r.published).toBe(true);
  return r;
};

describe('store.materializeMany', () => {
  it('publishes each output as the same bytes its *Into, and a load of the same ids, would', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), c: s('c'), optout: s('optout') },
      outputs: [
        { dest: s('d-and'), expr: { and: ['a', 'b'] }, exclude: ['optout'] },
        { dest: s('d-or'), expr: { or: ['a', 'c'] } },
        { dest: s('d-nested'), expr: { and: [{ or: ['a', 'b'] }, 'c'] } },
      ],
      keep: 2,
    });
    run.outputs.forEach((o) => published(o));
    await s('a').intersectInto(s('x-and'), [s('b')], { exclude: [s('optout')] });
    await s('a').unionInto(s('x-or'), [s('c')]);
    const native = bitmapOf(DATA.a);
    native.orInPlace(bitmapOf(DATA.b));
    native.andInPlace(bitmapOf(DATA.c));
    await w.load('x-nested', native.toArray());
    for (const [d, x] of [
      ['d-and', 'x-and'],
      ['d-or', 'x-or'],
      ['d-nested', 'x-nested'],
    ] as const) {
      expect(await w.hex(d, 0)).toBe(await w.hex(x, 0));
      expect(await w.ids(d)).toEqual(await w.ids(x));
    }
    expect(run.stats.groups).toBe(1);
    expect(run.stats.operands.a!).toMatchObject({
      pinned: true,
      pinnedGeneration: 0,
      startGeneration: 0,
    });
    expect(run.stats.budget.used).toBeLessThanOrEqual(run.stats.budget.planned);
  });

  it('one output refused, one losing a race, one erroring: the rest publish, results index-aligned', async () => {
    const w = await batchWorld({ ...DATA, empty: [] });
    await w.load('d-refused', [1, 2, 3]);
    await w.load('d-raced', [9]);
    const s = (n: string) => w.store.segment(n);
    w.hooks.beforeCas = async (seg) => {
      if (seg === 'd-raced') {
        w.hooks.beforeCas = undefined;
        await w.load('d-raced', [8, 9], w.other);
      }
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), empty: s('empty') },
      outputs: [
        { dest: s('d-ok-1'), expr: { and: ['a', 'b'] } },
        { dest: s('d-refused'), expr: { and: ['a', 'empty'] } },
        { dest: s('d-raced'), expr: 'a' },
        { dest: s('d-guard'), expr: { and: ['a', 'b'] }, guard: { minCardinality: 10 ** 9 } },
        { dest: s('d-ok-2'), expr: { andNot: ['a', 'b'] } },
      ],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(run.outputs[1]).toMatchObject({ published: false, reason: 'empty' });
    expect(run.outputs[2]).toMatchObject({
      published: false,
      error: expect.any(WriteConflictError),
    });
    expect(run.outputs[3]).toMatchObject({ published: false, reason: 'min-cardinality' });
    published(run.outputs[4]);
    expect(await w.ids('d-refused')).toEqual([1, 2, 3]);
  });

  it('reads each operand at the generation it had when the call started', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    let hit = false;
    w.hooks.beforeRange = async () => {
      if (hit) return;
      hit = true;
      await w.load('a', [7, 8, 9], w.other);
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b') },
      outputs: [{ dest: s('d'), expr: { or: ['a', 'b'] } }],
      keep: 1,
    });
    published(run.outputs[0]);
    const want = bitmapOf(DATA.a);
    want.orInPlace(bitmapOf(DATA.b));
    expect(await w.ids('d')).toEqual(want.toArray());
    expect(run.stats.operands.a!).toMatchObject({ pinnedGeneration: 0, startGeneration: 0 });
  });

  it('refuses exactly the outputs that subtract a pinned operand that moved, by any spelling', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    let hit = false;
    w.hooks.beforeRange = async () => {
      if (hit) return;
      hit = true;
      await w.load('optout', [1], w.other);
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), optout: s('optout') },
      outputs: [
        { dest: s('d1'), expr: 'a', exclude: ['optout'] },
        { dest: s('d2'), expr: 'b' },
        { dest: s('d3'), expr: { andNot: ['a', 'optout'] } },
        { dest: s('d4'), expr: { and: ['b', { andNot: ['b', { or: ['a', 'optout'] }] }] } },
        { dest: s('d5'), expr: { or: ['a', 'optout'] } },
      ],
      keep: 1,
    });
    for (const i of [0, 2, 3]) {
      const refused = run.outputs[i] as { published: false; error: Error };
      expect(refused.published).toBe(false);
      expect(isStaleOperandError(refused.error)).toBe(true);
      expect(refused.error).toBeInstanceOf(StaleOperandError);
      expect(refused.error).toMatchObject({
        code: 'stale-operand',
        operand: 'optout',
        reason: 'moved',
      });
    }
    published(run.outputs[1]);
    published(run.outputs[4]);
    expect(run.stats.operands.optout).toMatchObject({
      pinnedGeneration: 0,
      endGeneration: 1,
      moved: true,
    });
    expect(await w.backend.registry.get({ segment: 'd1' })).toBeNull();
    expect(await w.backend.registry.get({ segment: 'd3' })).toBeNull();
  });

  it('refuses the outputs that subtract a name deleted and created again, though it is generation 0 again', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    // the re-check's own row read: by then every chunk is read, and the name is replaced under it
    let passed = false;
    w.hooks.beforeRange = () => {
      passed = true;
    };
    w.hooks.beforeRowRead = async (segment) => {
      if (!passed || segment !== 'optout') return;
      w.hooks.beforeRowRead = undefined;
      const ref = { segment: 'optout' };
      await w.backend.registry.delete(ref);
      await w.backend.storage.delete({ ...ref, generation: 0 });
      await w.load('optout', [1, 2, 3], w.other);
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), optout: s('optout') },
      outputs: [
        { dest: s('d1'), expr: 'a', exclude: ['optout'] },
        { dest: s('d2'), expr: 'a' },
      ],
      keep: 1,
    });
    expect((run.outputs[0] as { error: Error }).error).toBeInstanceOf(StaleOperandError);
    published(run.outputs[1]);
    expect(run.stats.operands.optout).toMatchObject({
      pinnedGeneration: 0,
      endGeneration: 0,
      moved: true,
    });
  });

  it('with pin: false an operand read live can move under the call', async () => {
    const w = await batchWorld({ a: range(0, 5), b: range(0, 5) });
    const run = await w.store.materializeMany({
      operands: { a: w.store.segment('a'), b: w.store.segment('b') },
      outputs: [{ dest: w.store.segment('d'), expr: { or: ['a', 'b'] } }],
      keep: 1,
      pin: false,
    });
    published(run.outputs[0]);
    expect(run.stats.operands.a!.pinned).toBe(false);
  });

  it('a lease released mid-pass fails only the outputs that read the operand', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    const leased = await s('c').pin({ leaseUntil: Date.now() + 60_000 });
    let hit = false;
    w.hooks.beforeRange = async () => {
      if (hit) return;
      hit = true;
      await leased.release();
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), c: leased },
      outputs: [
        { dest: s('d1'), expr: { and: ['a', 'c'] } },
        { dest: s('d2'), expr: 'a' },
      ],
      keep: 1,
    });
    const first = run.outputs[0] as { published: false; error: Error };
    expect(first.error).toBeInstanceOf(LeaseExpiredError);
    published(run.outputs[1]);
  });

  it('refuses a released handle before any request', async () => {
    const w = await batchWorld(DATA);
    const leased = await w.store.segment('c').pin({ leaseUntil: Date.now() + 60_000 });
    await leased.release();
    w.calls.storage = w.calls.registry = 0;
    await expect(
      w.store.materializeMany({
        operands: { c: leased },
        outputs: [{ dest: w.store.segment('d'), expr: 'c' }],
        keep: 1,
      }),
    ).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(w.calls.storage + w.calls.registry).toBe(0);
  });

  it('a dest checked again at its publish: a released dest lease fails that output alone', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    await w.load('d1', [1]);
    const dest = await s('d1').pin({ leaseUntil: Date.now() + 60_000 });
    let hit = false;
    w.hooks.beforeRange = async () => {
      if (hit) return;
      hit = true;
      await dest.release();
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a') },
      outputs: [
        { dest, expr: 'a' },
        { dest: s('d2'), expr: 'a' },
      ],
      keep: 1,
    });
    expect((run.outputs[0] as { error: Error }).error).toBeInstanceOf(LeaseExpiredError);
    published(run.outputs[1]);
  });

  describe('validation, with zero driver calls', () => {
    const cases: Array<[string, (w: Awaited<ReturnType<typeof batchWorld>>) => unknown, RegExp]> = [
      [
        'an unknown operand',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('d'), expr: 'q' }],
          keep: 1,
        }),
        /outputs\[0\]\.expr/,
      ],
      [
        'no outputs',
        (w) => ({ operands: { a: w.store.segment('a') }, outputs: [], keep: 1 }),
        /non-empty/,
      ],
      [
        'a dest twice',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [
            { dest: w.store.segment('d'), expr: 'a' },
            { dest: w.store.segment('d'), expr: 'a' },
          ],
          keep: 1,
        }),
        /outputs\[1\]\.dest/,
      ],
      [
        'a dest that is an operand',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('a'), expr: 'a' }],
          keep: 1,
        }),
        /outputs\[0\]\.dest is also an operand/,
      ],
      [
        'a missing keep',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
        }),
        /keep/,
      ],
      [
        'a bad keep',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
          keep: 1.5,
        }),
        /keep/,
      ],
      [
        'a bad number',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
          keep: 1,
          publishConcurrency: 0,
        }),
        /publishConcurrency/,
      ],
      [
        'an unknown option',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
          keep: 1,
          nope: 1,
        }),
        /unknown option/,
      ],
      [
        'an operand that is not a segment',
        (w) => ({
          operands: { a: 'a' },
          outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
          keep: 1,
        }),
        /must be a segment/,
      ],
      [
        'bad metadata',
        (w) => ({
          operands: { a: w.store.segment('a') },
          outputs: [{ dest: w.store.segment('d'), expr: 'a', metadata: { x: { y: 1 } } }],
          keep: 1,
        }),
        /outputs\[0\]\.metadata/,
      ],
    ];
    it.each(cases)('refuses %s', async (_n, build, message) => {
      const w = await batchWorld(DATA);
      const options = build(w) as Parameters<typeof w.store.materializeMany>[0];
      await expect(w.store.materializeMany(options)).rejects.toThrow(message);
      await expect(w.store.materializeMany(options)).rejects.toBeInstanceOf(ValidationError);
      expect(w.calls.storage + w.calls.registry).toBe(0);
    });

    it('refuses an expired handle', async () => {
      const w = await batchWorld(DATA);
      const gone = w.store.segment('a', { expiresAt: Date.now() - 1_000_000 + 2 ** 41 - 2 ** 41 });
      void gone;
      const past = w.store.segment('a', { expiresAt: 1_000_000_000_000 });
      await expect(
        w.store.materializeMany({
          operands: { a: past },
          outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
          keep: 1,
        }),
      ).rejects.toThrow(/expired/);
      expect(w.calls.storage + w.calls.registry).toBe(0);
    });
  });

  it('an operand that names no segment is refused unless allowed', async () => {
    const w = await batchWorld(DATA);
    const options = {
      operands: { a: w.store.segment('a'), ghost: w.store.segment('ghost') },
      outputs: [
        { dest: w.store.segment('d'), expr: { or: ['a', 'ghost'] } },
      ] as MaterializeManyOutput[],
      keep: 1,
    };
    await expect(w.store.materializeMany(options)).rejects.toThrow(/does not exist/);
    const run = await w.store.materializeMany({ ...options, allowAbsentOperands: true });
    published(run.outputs[0]);
  });

  it('a budget the plan exceeds throws before any chunk is read', async () => {
    const w = await batchWorld(DATA);
    await expect(
      w.store.materializeMany({
        operands: { a: w.store.segment('a') },
        outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
        keep: 1,
        budget: { maxRequests: 1 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(w.calls.ranges).toBe(0);
  });

  it('bypasses the chunk cache: it neither fills it nor is served from it', async () => {
    const events: Array<{ kind: string; hit?: boolean }> = [];
    const w = await batchWorld(DATA, { metrics: { onEvent: (e) => events.push(e as never) } });
    const s = (n: string) => w.store.segment(n);
    expect(await s('a').has(5)).toBe(true);
    events.length = 0;
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b') },
      outputs: [{ dest: s('d'), expr: { or: ['a', 'b'] } }],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(events.filter((e) => e.kind === 'cache')).toEqual([]);
    // the chunk a reader warmed is still there, and no chunk of b was cached on its behalf
    w.calls.ranges = 0;
    expect(await s('a').has(5)).toBe(true);
    expect(events.filter((e) => e.kind === 'cache')).toEqual([{ kind: 'cache', hit: true }]);
    expect(w.calls.ranges).toBe(0);
    expect(await s('b').has(31_000)).toBe(true);
    expect(w.calls.ranges).toBeGreaterThan(0);
  });

  it('reports one op event and a storage.get per range request, as a combine does, and no cache or intersect event', async () => {
    const events: MetricEvent[] = [];
    const w = await batchWorld(DATA, { metrics: { onEvent: (e) => events.push(e) } });
    const s = (n: string) => w.store.segment(n);
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), c: s('c') },
      outputs: [
        { dest: s('d1'), expr: { and: ['a', 'b'] } },
        { dest: s('d2'), expr: { or: ['a', 'c'] }, exclude: ['b'] },
      ],
      keep: 1,
    });
    published(run.outputs[0]);
    published(run.outputs[1]);
    expect(events.filter((e) => e.kind === 'op')).toEqual([
      { kind: 'op', name: 'materializeMany', ms: expect.any(Number) as number },
    ]);
    const gets = events.filter(
      (e): e is Extract<MetricEvent, { kind: 'storage.get' }> => e.kind === 'storage.get',
    );
    // One per range request the call sent, the same count and bytes its own stats report, each naming its operand.
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.length).toBe(run.stats.requests.rangeReads);
    expect(gets.reduce((n, e) => n + e.bytes, 0)).toBe(run.stats.requests.rangeBytes);
    expect(new Set(gets.map((e) => e.segment))).toEqual(new Set(['a', 'b', 'c']));
    expect(gets.every((e) => e.namespace === undefined && e.ms >= 0)).toBe(true);
    expect(events.filter((e) => e.kind === 'cache' || e.kind === 'intersect')).toEqual([]);

    // A call that throws after its first request reports its time, and the reads it never sent are not reported.
    events.length = 0;
    await expect(
      w.store.materializeMany({
        operands: { a: s('a'), b: s('b') },
        outputs: [{ dest: s('d5'), expr: { and: ['a', 'b'] } }],
        keep: 1,
        budget: { maxRequests: 1 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(events.filter((e) => e.kind === 'op')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'storage.get')).toEqual([]);

    // A call its input checks refuse sends nothing and reports nothing.
    events.length = 0;
    await expect(
      w.store.materializeMany({
        operands: { a: s('a') },
        outputs: [{ dest: s('d4'), expr: 'nope' }],
        keep: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(events).toEqual([]);
  });

  it('sends the same requests with a metrics sink as with none', async () => {
    const call = async (w: Awaited<ReturnType<typeof batchWorld>>) => {
      const run = await w.store.materializeMany({
        operands: { a: w.store.segment('a'), b: w.store.segment('b') },
        outputs: [{ dest: w.store.segment('d'), expr: { and: ['a', 'b'] } }],
        keep: 1,
      });
      published(run.outputs[0]);
      return run.stats.requests;
    };
    const none = await call(await batchWorld(DATA));
    const watched = await call(await batchWorld(DATA, { metrics: { onEvent: () => undefined } }));
    expect(none.rangeReads).toBeGreaterThan(0);
    expect(watched).toEqual(none);
  });

  it('an id erased before a chunk was read fails the outputs reading the deleted object, loudly', async () => {
    const w = await batchWorld({ a: [1, 2, 3, 70_000], b: [1, 2, 3] });
    const s = (n: string) => w.store.segment(n);
    let hit = false;
    w.hooks.beforeRange = async () => {
      if (hit) return;
      hit = true;
      await w.other.eraseSubject(2, { allNamespaces: true });
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b') },
      outputs: [
        { dest: s('d-a'), expr: 'a' },
        { dest: s('d-b'), expr: 'b' },
      ],
      keep: 1,
    });
    const failures = run.outputs.filter((o) => !o.published);
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect((f as { error: Error }).error).toBeInstanceOf(NotFoundError);
    // what was already in flight when the erasure ran can still be served: one range of each operand, no more
    expect(run.outputs[0]).toMatchObject({ published: false });
    expect(await w.backend.registry.get({ segment: 'd-a' })).toBeNull();
  });

  it('an id erased after the chunks were read can sit in an output the erasure could not reach', async () => {
    const w = await batchWorld({ a: [1, 2, 3, 70_000], b: [1, 2, 3] });
    const s = (n: string) => w.store.segment(n);
    let hit = false;
    w.hooks.beforeCas = async () => {
      if (hit) return;
      hit = true;
      await w.other.eraseSubject(2, { allNamespaces: true });
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b') },
      outputs: [{ dest: s('d-carries'), expr: 'a' }],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(await w.ids('d-carries')).toContain(2);
  });

  it("an erasure that rewrites a destination while the call runs makes that output's publish lose", async () => {
    const w = await batchWorld({ a: [1, 2, 3, 70_000] });
    await w.load('d', [2, 5]);
    const s = (n: string) => w.store.segment(n);
    let hit = false;
    w.hooks.beforeCas = async (seg) => {
      if (hit || seg !== 'd') return;
      hit = true;
      await w.other.eraseSubject(2, { allNamespaces: true });
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a') },
      outputs: [{ dest: s('d'), expr: 'a' }],
      keep: 1,
    });
    expect(run.outputs[0]).toMatchObject({
      published: false,
      error: expect.any(WriteConflictError),
    });
    expect(await w.ids('d')).toEqual([5]);
  });

  describe('the request budget', () => {
    const one = (
      w: Awaited<ReturnType<typeof batchWorld>>,
      budget?: Parameters<typeof w.store.materializeMany>[0]['budget'],
    ) =>
      w.store.materializeMany({
        operands: { a: w.store.segment('a') },
        outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
        keep: 1,
        ...(budget === undefined ? {} : { budget }),
      });

    it('sizes its own from the plan when the store has the library default', async () => {
      const w = await batchWorld(DATA);
      const run = await one(w);
      expect(run.stats.budget.maxRequests).toBe(run.stats.budget.planned * 2 + 1_000);
    });

    it('honours a ceiling the store was built with, before any chunk is read', async () => {
      const w = await batchWorld(DATA, { budget: { maxRequests: 3 } });
      await expect(one(w)).rejects.toBeInstanceOf(BudgetExceededError);
      expect(w.calls.ranges).toBe(0);
      const roomy = await batchWorld(DATA, { budget: { maxRequests: 500_000 } });
      expect((await one(roomy)).stats.budget.maxRequests).toBe(500_000);
    });

    it('lets a call set its own, or lift the limit, over the store', async () => {
      const w = await batchWorld(DATA, { budget: { maxRequests: 3 } });
      expect((await one(w, { maxRequests: 900_000 })).stats.budget.maxRequests).toBe(900_000);
      const lifted = await batchWorld(DATA, { budget: { maxRequests: 3 } });
      expect((await one(lifted, false)).stats.budget.maxRequests).toBeNull();
      const plain = await batchWorld(DATA);
      expect((await one(plain, false)).stats.budget.maxRequests).toBeNull();
    });

    it('lifts the limit for a store built with budget: false', async () => {
      const w = await batchWorld(DATA, { budget: false });
      expect((await one(w)).stats.budget.maxRequests).toBeNull();
    });
  });

  it('reports where every operand began and ended, read live or pinned', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    for (const pin of [true, false]) {
      let hit = false;
      w.hooks.beforeRange = async () => {
        if (hit) return;
        hit = true;
        await w.load('b', [1, 2, 3], w.other);
      };
      const run = await w.store.materializeMany({
        operands: { a: s('a'), b: s('b'), unused: s('c') },
        outputs: [{ dest: s(`d-${pin}`), expr: { or: ['a', 'b'] } }],
        keep: 1,
        pin,
      });
      w.hooks.beforeRange = undefined;
      const gen = (name: string) => run.stats.operands[name]!;
      expect(gen('a')).toMatchObject({ pinned: pin, endGeneration: 0, moved: false });
      expect(gen('b').endGeneration).toBe(
        await w.backend.registry.get({ segment: 'b' }).then((r) => r!.currentGen),
      );
      expect(gen('b').moved).toBe(true);
      expect(gen('unused')).toMatchObject({
        read: false,
        endGeneration: 0,
        moved: pin ? false : undefined,
      });
      if (pin) expect(gen('b')).toMatchObject({ pinnedGeneration: expect.any(Number) });
      else expect(gen('b').pinnedGeneration).toBeUndefined();
      expect(gen('a').startGeneration).toBe(0);
    }
  });

  it('counts the requests it can attribute by class, never more than the drivers saw', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    await w.load('d-refused', [1]);
    w.resetCalls();
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), optout: s('optout'), empty: s('c') },
      outputs: [
        { dest: s('d1'), expr: { and: ['a', 'b'] }, exclude: ['optout'] },
        { dest: s('d2'), expr: { or: ['a', 'b'] } },
        { dest: s('d-refused'), expr: { and: ['a', { andNot: ['a', 'a'] }] } },
      ],
      keep: 1,
    });
    const { requests } = run.stats;
    expect(requests.rangeReads).toBe(w.calls.ranges);
    // the totals count what the call can prove; the opening reads and what a publish reads are not in them
    expect(requests.attributed.get).toBeLessThanOrEqual(
      w.calls.ranges + w.calls.tails + w.calls.rowReads,
    );
    expect(requests.attributed.put).toBeLessThanOrEqual(w.calls.puts + w.calls.rowWrites);
    expect(requests.attributed.put).toBe(2 + 2 + 1);
    expect(requests.attributed.get).toBe(requests.rangeReads + requests.registryReads);
    expect(requests.attributed.get).toBeGreaterThan(requests.rangeReads);
    // three operands were opened, and each output was handed to a publish
    expect(requests.opens).toBe(3);
    expect(requests.publishes).toBe(3);
  });

  describe('the defaults', () => {
    it('keeps 256 MiB resident at most', async () => {
      const w = await batchWorld(DATA);
      const run = await w.store.materializeMany({
        operands: { a: w.store.segment('a') },
        outputs: [{ dest: w.store.segment('d'), expr: 'a' }],
        keep: 1,
      });
      expect(run.stats.memory.maxBufferedBytes).toBe(256 * 1024 * 1024);
    });

    it('publishes 8 outputs at once, and as many as publishConcurrency says', async () => {
      const peaks: number[] = [];
      for (const publishConcurrency of [undefined, 3]) {
        const w = await batchWorld(DATA);
        for (let i = 0; i < 30; i++) await w.load(`d${i}`, [1]);
        let now = 0;
        let peak = 0;
        w.hooks.beforeCas = async () => {
          now++;
          peak = Math.max(peak, now);
          await new Promise<void>((r) => setImmediate(r));
          now--;
        };
        const run = await w.store.materializeMany({
          operands: { a: w.store.segment('c') },
          outputs: Array.from({ length: 30 }, (_, i) => ({
            dest: w.store.segment(`d${i}`),
            expr: 'a',
          })),
          keep: 1,
          ...(publishConcurrency === undefined ? {} : { publishConcurrency }),
        });
        run.outputs.forEach((o) => published(o));
        peaks.push(peak);
      }
      expect(peaks).toEqual([8, 3]);
    });

    it('holds one range ahead per operand, and as many as concurrency says', async () => {
      const wide = Array.from({ length: 200 }, (_, k) =>
        range(0, 65_536, 16).map((v) => k * 65_536 + v),
      ).flat();
      const pick = [0, 40, 80, 120, 160].map((k) => k * 65_536 + 3);
      const peaks: number[] = [];
      for (const concurrency of [undefined, 4]) {
        const w = await batchWorld({ wide, pick });
        const inFlight: Record<string, number> = {};
        let peak = 0;
        w.hooks.beforeRange = async (segment) => {
          inFlight[segment] = (inFlight[segment] ?? 0) + 1;
          if (segment === 'wide') peak = Math.max(peak, inFlight[segment]!);
          await new Promise<void>((r) => setImmediate(r));
          inFlight[segment]!--;
        };
        const run = await w.store.materializeMany({
          operands: { wide: w.store.segment('wide'), pick: w.store.segment('pick') },
          outputs: [{ dest: w.store.segment('d'), expr: { and: ['wide', 'pick'] } }],
          keep: 1,
          ...(concurrency === undefined ? {} : { concurrency }),
        });
        published(run.outputs[0]);
        peaks.push(peak);
      }
      expect(peaks[0]).toBe(1);
      expect(peaks[1]).toBeGreaterThan(1);
    });
  });

  it('refuses an operand that names no segment, for every operand of the call', async () => {
    const w = await batchWorld(DATA);
    const options = (extra: object) => ({
      operands: { a: w.store.segment('a'), ghost: w.store.segment('ghost') },
      outputs: [{ dest: w.store.segment('d'), expr: 'a' as const }],
      keep: 1,
      ...extra,
    });
    await expect(w.store.materializeMany(options({}))).rejects.toBeInstanceOf(ValidationError);
    await expect(w.store.materializeMany(options({}))).rejects.toThrow(/"ghost"/);
    await expect(w.store.materializeMany(options({ after: 5, through: 3 }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    published((await w.store.materializeMany(options({ allowAbsentOperands: true }))).outputs[0]);
  });

  it('refuses the outputs that subtract a generation number taken again by other bytes in the same row', async () => {
    const w = await batchWorld({ ...DATA, optout: [5] });
    await w.load('optout', [5, 7]);
    const s = (n: string) => w.store.segment(n);
    let passed = false;
    w.hooks.beforeRange = () => {
      passed = true;
    };
    w.hooks.beforeRowRead = async (segment) => {
      if (!passed || segment !== 'optout') return;
      w.hooks.beforeRowRead = undefined;
      const ref = { segment: 'optout' };
      // an operator rolls back, the leftover object is deleted, and a load takes the number again, in one row
      await w.other.rollback(ref, 0);
      await w.backend.storage.delete({ ...ref, generation: 1 });
      await w.load('optout', [6], w.other);
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), optout: s('optout') },
      outputs: [
        { dest: s('d1'), expr: 'a', exclude: ['optout'] },
        { dest: s('d2'), expr: 'a' },
      ],
      keep: 1,
    });
    expect((run.outputs[0] as { error: Error }).error).toBeInstanceOf(StaleOperandError);
    published(run.outputs[1]);
    expect(run.stats.operands.optout).toMatchObject({
      pinnedGeneration: 1,
      endGeneration: 1,
      moved: true,
    });
  });

  it('does not take a retention write or a lease on a subtracted operand for a replacement', async () => {
    const w = await batchWorld(DATA);
    const s = (n: string) => w.store.segment(n);
    let passed = false;
    w.hooks.beforeRange = () => {
      passed = true;
    };
    w.hooks.beforeRowRead = async (segment) => {
      if (!passed || segment !== 'optout') return;
      w.hooks.beforeRowRead = undefined;
      await w.other.setRetention({ segment: 'optout' }, { expiresAt: Date.now() + 10 ** 10 });
      await s('optout').pin({ leaseUntil: Date.now() + 60_000 });
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), optout: s('optout') },
      outputs: [{ dest: s('d1'), expr: 'a', exclude: ['optout'] }],
      keep: 1,
    });
    published(run.outputs[0]);
    expect(run.stats.operands.optout).toMatchObject({ moved: false });
  });

  it('reports a live operand purged and reloaded to the same generation number as moved, and one never opened as unknown', async () => {
    const w = await batchWorld(DATA);
    await w.load('b', [1, 2]);
    const s = (n: string) => w.store.segment(n);
    let passed = false;
    w.hooks.beforeRange = () => {
      passed = true;
    };
    w.hooks.beforeRowRead = async (segment) => {
      if (!passed || segment !== 'b') return;
      w.hooks.beforeRowRead = undefined;
      const ref = { segment: 'b' };
      await w.backend.registry.delete(ref);
      for (const generation of [0, 1]) await w.backend.storage.delete({ ...ref, generation });
      await w.load('b', [9], w.other);
      await w.load('b', [8], w.other);
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a'), b: s('b'), unused: s('c') },
      outputs: [{ dest: s('d1'), expr: { or: ['a', 'b'] } }],
      keep: 1,
      pin: false,
    });
    expect(run.stats.operands.b).toMatchObject({
      startGeneration: 1,
      endGeneration: 1,
      moved: true,
    });
    expect(run.stats.operands.a).toMatchObject({ moved: false });
    expect(run.stats.operands.unused!.moved).toBeUndefined();
  });

  it('an erasure of a destination before its publish starts does not stop the publish', async () => {
    const w = await batchWorld({ a: [1, 2, 3, 70_000] });
    await w.load('d', [5, 4_000_000]);
    const s = (n: string) => w.store.segment(n);
    let hit = false;
    w.hooks.beforeRange = async () => {
      if (hit) return;
      hit = true;
      await w.other.eraseSubject(4_000_000, { allNamespaces: true });
    };
    const run = await w.store.materializeMany({
      operands: { a: s('a') },
      outputs: [{ dest: s('d'), expr: 'a' }],
      keep: 1,
    });
    // the erasure rewrote the destination to a new generation, and the publish went on top of it
    expect(published(run.outputs[0]).generation).toBe(2);
    expect(await w.ids('d')).toEqual([1, 2, 3, 70_000]);
  });

  describe('the recipe for the total GET-class requests', () => {
    // attributed.get, plus two reads (a tail and a row) for each operand a pin took or an index opened, plus, for each
    // publish, two reads of an existing destination or three of one with no generation, and one more when it was refused
    const shapes: Array<[boolean, boolean, boolean, boolean, number]> = [];
    for (const pin of [true, false])
      for (const newDest of [true, false])
        for (const refuse of [false, true])
          for (const unused of [false, true])
            for (const n of [1, 3]) shapes.push([pin, newDest, refuse, unused, n]);

    it.each(shapes)(
      'pin %s, new destinations %s, refused %s, unused operand %s, %i outputs',
      async (pin, newDest, refuse, unused, n) => {
        const w = await batchWorld({
          a: range(0, 70_000),
          b: range(30_000, 90_000),
          c: range(5, 10),
        });
        const s = (x: string) => w.store.segment(x);
        for (let i = 0; i < n; i++) if (!newDest) await w.load(`d${i}`, [1]);
        w.resetCalls();
        const operands: Record<string, ReturnType<typeof s>> = { a: s('a'), b: s('b') };
        if (unused) operands.c = s('c');
        const run = await w.store.materializeMany({
          operands,
          outputs: Array.from({ length: n }, (_, i) => ({
            dest: s(`d${i}`),
            expr: refuse ? { andNot: ['a', 'a'] } : { or: ['a', 'b'] },
          })),
          keep: 1,
          pin,
        });
        const { requests } = run.stats;
        const refused = run.outputs.filter((o) => !o.published).length;
        expect(refused).toBe(refuse && !newDest ? n : 0);
        const opened = pin ? Object.keys(operands).length : requests.opens;
        const recipe = requests.attributed.get + 2 * opened + n * (newDest ? 3 : 2) + refused;
        expect(w.calls.ranges + w.calls.tails + w.calls.rowReads).toBe(recipe);
        expect(w.calls.puts + w.calls.rowWrites).toBeGreaterThanOrEqual(requests.attributed.put);
        expect(requests.attributed.put).toBe(w.calls.puts + w.calls.rowWrites);
      },
    );
  });
});
