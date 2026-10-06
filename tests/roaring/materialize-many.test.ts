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
import type { MaterializeManyOutput, MaterializeResult } from '@/index';
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
    expect(run.stats.operands.a).toMatchObject({
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
    expect(run.stats.operands.a).toMatchObject({ pinnedGeneration: 0, startGeneration: 0 });
  });

  it('refuses exactly the outputs that exclude a pinned operand that moved', async () => {
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
      ],
      keep: 1,
    });
    const refused = run.outputs[0] as { published: false; error: Error };
    expect(refused.published).toBe(false);
    expect(isStaleOperandError(refused.error)).toBe(true);
    expect(refused.error).toBeInstanceOf(StaleOperandError);
    expect(refused.error).toMatchObject({
      code: 'stale-operand',
      operand: 'optout',
      reason: 'moved',
    });
    published(run.outputs[1]);
    published(run.outputs[2]);
    expect(run.stats.operands.optout).toMatchObject({ pinnedGeneration: 0, endGeneration: 1 });
    expect(await w.backend.registry.get({ segment: 'd1' })).toBeNull();
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
    expect(run.stats.operands.a.pinned).toBe(false);
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
});
