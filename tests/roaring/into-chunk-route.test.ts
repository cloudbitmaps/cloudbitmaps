import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { BudgetExceededError } from '@/index';
import type { SegmentRef } from '@/index';
import type { SegmentEngine } from '@/core/engine';
import { collect } from '../helpers/loaded';
import {
  DEST,
  bothRoutes,
  makeWorld,
  merged,
  observe,
  operands,
  span,
} from '../helpers/into-routes';
import type { Bitmap, Call, Observed, Verb, World, WorldOptions } from '../helpers/into-routes';

/**
 * `intersectInto`, `unionInto` and `andNotInto` write the combine's chunks straight into the new generation, where the
 * ids of the combine could be streamed into the load instead. The two routes must be the same to anyone watching:
 * the same generation (byte for byte when it is cleartext), the same requests, events and audit trail, the same
 * return and the same refusals. Every case here runs the call twice, on two identical stores, once by each route
 * (`tests/helpers/into-routes.ts`), and compares everything either one did.
 */
vi.setConfig({ testTimeout: 60_000 });

const META = { source: 'test', run: 7 };

const CALLS: Array<[string, Call]> = [
  ['intersect', { verb: 'intersect', others: ['b'] }],
  ['intersect with an exclude', { verb: 'intersect', others: ['b'], options: { exclude: ['c'] } }],
  [
    'intersect over a range that cuts two chunks',
    { verb: 'intersect', others: ['b'], options: { after: 40_000, through: 260_000 } },
  ],
  ['union', { verb: 'union', others: ['b', 'c'] }],
  ['union with an exclude', { verb: 'union', others: ['b'], options: { exclude: ['c'] } }],
  [
    'union over a range',
    { verb: 'union', others: ['b'], options: { after: 65_535, through: 300_000 } },
  ],
  ['andNot', { verb: 'andNot', others: ['b', 'c'] }],
  [
    'andNot over a range',
    { verb: 'andNot', others: ['b'], options: { after: 100, through: 400_000 } },
  ],
];

function expectSameRoutes(chunks: Observed, ids: Observed): void {
  expect(chunks.outcome).toEqual(ids.outcome);
  expect(chunks.objects).toEqual(ids.objects);
  expect(chunks.pointer).toEqual(ids.pointer);
  expect(chunks.requests).toEqual(ids.requests);
  expect(chunks.events).toEqual(ids.events);
  expect(chunks.audit).toEqual(ids.audit);
}

const build =
  (options: WorldOptions = {}) =>
  () =>
    makeWorld(options);

describe('the generation an *Into writes is the one the id route writes, byte for byte', () => {
  describe.each(CALLS)('%s', (_, call) => {
    it('into a destination that does not exist', async () => {
      const { chunks, ids } = await bothRoutes(call, build());
      expect('result' in chunks.outcome && chunks.outcome.result.published).toBe(true);
      expect(Object.keys(chunks.objects)).toEqual(['0']);
      expectSameRoutes(chunks, ids);
    });

    it('into a destination that exists', async () => {
      const dest = span(10, 90_000, 2);
      const { chunks, ids } = await bothRoutes(call, build({ dest }));
      expect(Object.keys(chunks.objects)).toEqual(['0', '1']);
      expectSameRoutes(chunks, ids);
    });

    it('with metadata', async () => {
      const withMeta: Call = { ...call, options: { ...call.options, metadata: META } };
      const { chunks, ids } = await bothRoutes(withMeta, build());
      expectSameRoutes(chunks, ids);
    });

    it('encrypted: the same chunks and metadata, decrypted (each seal has its own nonce)', async () => {
      const withMeta: Call = { ...call, options: { ...call.options, metadata: META } };
      const keys = { k1: randomBytes(32) };
      const { chunks, ids } = await bothRoutes(
        withMeta,
        build({ encrypted: true, keys, dest: span(0, 5) }),
      );
      expect(Object.values(chunks.objects)[1]).toContain('"source":"test"');
      expectSameRoutes(chunks, ids);
    });
  });

  it('cleartext objects are compared as whole files, so a stray byte anywhere in the write shows', async () => {
    const { chunks } = await bothRoutes(CALLS[0]![1], build());
    const object = chunks.objects[0]!;
    expect(object.length).toBeGreaterThan(1_000);
    expect(/^[0-9a-f]+$/.test(object)).toBe(true);
  });
});

describe('an empty result', () => {
  const none: Call = { verb: 'intersect', others: ['y'] };
  const data = { a: span(0, 100), y: span(1_000_000, 1_000_100), c: span(0, 3) };

  it('over a destination that holds ids is refused and reported, and the destination is untouched', async () => {
    const { chunks, ids } = await bothRoutes(none, build({ data, dest: span(0, 50) }));
    expect(chunks.outcome).toMatchObject({
      result: { published: false, reason: 'empty', cardinality: 0 },
    });
    expect(Object.keys(chunks.objects)).toEqual(['0']);
    expectSameRoutes(chunks, ids);
  });

  it('with allowEmpty over a destination that holds ids empties it', async () => {
    const call: Call = { ...none, options: { allowEmpty: true } };
    const { chunks, ids } = await bothRoutes(call, build({ data, dest: span(0, 50) }));
    expect(chunks.outcome).toMatchObject({
      result: { published: true, cardinality: 0, chunkCount: 0 },
    });
    expectSameRoutes(chunks, ids);
  });

  it('with allowEmpty over no destination publishes an empty generation', async () => {
    const call: Call = { ...none, options: { allowEmpty: true } };
    const { chunks, ids } = await bothRoutes(call, build({ data }));
    expect(chunks.outcome).toMatchObject({ result: { published: true, cardinality: 0 } });
    expectSameRoutes(chunks, ids);
  });

  it('a range that holds nothing of the result is empty too', async () => {
    const call: Call = {
      verb: 'union',
      others: ['c'],
      options: { after: 5_000_000, through: 6_000_000 },
    };
    const { chunks, ids } = await bothRoutes(call, build({ data, dest: span(0, 50) }));
    expect(chunks.outcome).toMatchObject({ result: { published: false, reason: 'empty' } });
    expectSameRoutes(chunks, ids);
  });
});

describe('the guard judges the result the chunks add up to', () => {
  // The destination holds 100 ids; the intersection of a and b is 60 of them in one chunk.
  const data = { a: span(0, 100), b: span(40, 200), c: span(0, 3) };
  const call = (guard: Call['options']): Call => ({
    verb: 'intersect',
    others: ['b'],
    options: guard,
  });

  it('minRetained is a fraction of what the destination held, and the result is counted from its chunks', async () => {
    const dest = span(0, 100);
    const keeps = await bothRoutes(call({ guard: { minRetained: 0.5 } }), build({ data, dest }));
    expect(keeps.chunks.outcome).toMatchObject({
      result: { published: true, cardinality: 60, cardinalityBefore: 100 },
    });
    expectSameRoutes(keeps.chunks, keeps.ids);

    const refuses = await bothRoutes(call({ guard: { minRetained: 0.7 } }), build({ data, dest }));
    expect(refuses.chunks.outcome).toMatchObject({
      result: { published: false, reason: 'min-retained', cardinality: 60, cardinalityBefore: 100 },
    });
    expectSameRoutes(refuses.chunks, refuses.ids);
  });

  it('minRetained over a result spread across several chunks sums them', async () => {
    const dest = span(0, 400_000, 4); // 100,000 ids
    const wide = { a: span(0, 400_000, 8), b: span(0, 400_000, 4), c: span(0, 3) }; // result: 50,000 ids, six chunks
    const keeps = await bothRoutes(
      call({ guard: { minRetained: 0.5 } }),
      build({ data: wide, dest }),
    );
    expect(keeps.chunks.outcome).toMatchObject({
      result: { published: true, cardinality: 50_000 },
    });
    expectSameRoutes(keeps.chunks, keeps.ids);
    const refuses = await bothRoutes(
      call({ guard: { minRetained: 0.51 } }),
      build({ data: wide, dest }),
    );
    expect(refuses.chunks.outcome).toMatchObject({
      result: { published: false, reason: 'min-retained' },
    });
    expectSameRoutes(refuses.chunks, refuses.ids);
  });

  it('minCardinality', async () => {
    const dest = span(0, 100);
    for (const minCardinality of [60, 61]) {
      const { chunks, ids } = await bothRoutes(
        call({ guard: { minCardinality } }),
        build({ data, dest }),
      );
      expect('result' in chunks.outcome && chunks.outcome.result.published).toBe(
        minCardinality === 60,
      );
      expectSameRoutes(chunks, ids);
    }
  });
});

describe('a refusal and a failure write nothing, as on the id route', () => {
  it.each(['intersect', 'union', 'andNot'] as const)(
    '%s: a budget refusal throws before anything is written, and asks for what the id route asks for',
    async (verb) => {
      const call: Call = {
        verb,
        others: ['b'],
        options: { budget: { maxRequests: 1 } },
      };
      const { chunks, ids } = await bothRoutes(call, build({ dest: span(0, 10) }));
      expect(chunks.outcome).toMatchObject({
        error: expect.stringContaining('BudgetExceededError') as string,
      });
      expect(chunks.requests.some((r) => r.startsWith('storage.putImmutable'))).toBe(false);
      expect(Object.keys(chunks.objects)).toEqual(['0']);
      expect(chunks.pointer).toMatchObject({ currentGen: 0 });
      expectSameRoutes(chunks, ids);
    },
  );

  it('the refusal is the budget error itself', async () => {
    const w = await makeWorld();
    await expect(
      w.store.segment('a').intersectInto(w.store.segment(DEST.segment), [w.store.segment('b')], {
        budget: { maxRequests: 1 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  describe('a read that fails in the middle of the result', () => {
    // 300 chunks of about 10 KB each: several range reads per operand.
    const wide = (): Record<string, Bitmap> => {
      const spread = (offset: number): Bitmap => {
        const out = merged();
        for (let k = 0; k < 300; k++)
          for (let i = 0; i < 5_000; i++) out.add(k * 65_536 + ((i * 13 + offset) % 65_536));
        return out;
      };
      return { a: spread(0), b: spread(0), c: span(0, 3) };
    };

    it.each(['chunks', 'ids'] as const)(
      '%s route: the error reaches the caller and no object or pointer is written',
      async (route) => {
        const w = await makeWorld({ data: wide(), dest: span(0, 10) });
        w.failRangeRead.nth = 3;
        const seen = await observe(w, { verb: 'intersect', others: ['b'] }, route);
        expect(w.failRangeRead.seen).toBeGreaterThanOrEqual(3);
        expect(seen.outcome).toEqual({ error: 'Error: the disk is on fire' });
        expect(seen.requests.some((r) => r.startsWith('storage.putImmutable'))).toBe(false);
        expect(Object.keys(seen.objects)).toEqual(['0']);
        expect(seen.pointer).toMatchObject({ currentGen: 0 });
        expect(seen.audit).toEqual([]);
      },
    );

    it('both routes fail the same way', async () => {
      const failing = async () => {
        const w = await makeWorld({ data: wide(), dest: span(0, 10) });
        w.failRangeRead.nth = 3;
        return w;
      };
      const { chunks, ids } = await bothRoutes({ verb: 'intersect', others: ['b'] }, failing);
      expect(chunks.outcome).toEqual(ids.outcome);
      expect(chunks.objects).toEqual(ids.objects);
      expect(chunks.audit).toEqual(ids.audit);
    });
  });
});

describe('the operands are what they were, and so is the cache', () => {
  const ids = async (w: World, name: string): Promise<number[]> =>
    collect(w.store.segment(name).iterate());

  it.each(CALLS)('%s: a warm cache serves unchanged operands after the call', async (_, call) => {
    const w = await makeWorld({ dest: span(0, 10) });
    const before = { a: await ids(w, 'a'), b: await ids(w, 'b'), c: await ids(w, 'c') }; // fills the chunk cache
    await observe(w, call, 'chunks');
    expect({ a: await ids(w, 'a'), b: await ids(w, 'b'), c: await ids(w, 'c') }).toEqual(before);
    expect(before.a).toEqual([...operands().a!]);
  });

  it.each([
    ['intersectChunks', (e: SegmentEngine, r: SegmentRef[]) => e.intersectChunks(r)],
    ['unionChunks', (e: SegmentEngine, r: SegmentRef[]) => e.unionChunks(r)],
    ['andNotChunks', (e: SegmentEngine, r: SegmentRef[]) => e.andNotChunks(r[0]!, r.slice(1))],
  ])(
    '%s: the bitmaps it yields can be changed without touching what the cache holds',
    async (_, open) => {
      const w = await makeWorld({
        data: { a: span(0, 70_000), b: span(30_000, 140_000), c: span(0, 3) },
      });
      const before = { a: await ids(w, 'a'), b: await ids(w, 'b') }; // both operands' chunks are now cached
      const engine = (w.store as unknown as { engine: SegmentEngine }).engine;
      const refs = ['a', 'b'].map((segment) => ({ segment }));
      let yielded = 0;
      for await (const chunk of open(engine, refs) as AsyncIterable<{
        chunkKey: number;
        bitmap: Bitmap & { clear?: () => void };
      }>) {
        yielded++;
        const bitmap = chunk.bitmap as unknown as {
          addMany(v: number[]): void;
          removeMany(v: number[]): void;
          optimize?: () => void;
        };
        bitmap.addMany([1, 2, 3, 4, 5]);
        bitmap.removeMany([30_001, 30_002, 65_535]);
        bitmap.optimize?.();
      }
      expect(yielded).toBeGreaterThan(0);
      expect({ a: await ids(w, 'a'), b: await ids(w, 'b') }).toEqual(before);
    },
  );
});

describe('the verbs read their combine as chunks, never as ids', () => {
  it.each([
    ['intersect', 'intersectInto'],
    ['union', 'unionInto'],
    ['andNot', 'andNotInto'],
  ] as const)('%s', async (verb, into) => {
    const w = await makeWorld();
    const engine = (w.store as unknown as { engine: Record<string, (...a: never[]) => unknown> })
      .engine;
    const asIds = [vi.spyOn(engine, verb), vi.spyOn(engine, `${verb}Batches`)];
    const asChunks = vi.spyOn(engine, `${verb}Chunks`);
    const a = w.store.segment('a');
    await a[into](w.store.segment(DEST.segment), [w.store.segment('b')]);
    expect(asChunks).toHaveBeenCalledTimes(1);
    for (const spy of asIds) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the load takes the same chunks whichever way the ids would have come', () => {
  const data = (): Record<string, Bitmap> => ({ ...operands() });

  it('the combine is read once, in the same order, so a cold run asks for the same ranges', async () => {
    const { chunks, ids } = await bothRoutes(
      { verb: 'union', others: ['b', 'c'] },
      build({ data: data() }),
    );
    expect(chunks.requests.filter((r) => r.startsWith('storage.getRange')).length).toBeGreaterThan(
      0,
    );
    expect(chunks.requests).toEqual(ids.requests);
    expect(chunks.events).toEqual(ids.events);
  });
});

describe('property: every verb, over random operands and options, writes what the id route writes', () => {
  const idSet = fc.uniqueArray(fc.integer({ min: 0, max: 330_000 }), { maxLength: 1_500 });
  const ranges = fc.array(
    fc.tuple(fc.integer({ min: 0, max: 330_000 }), fc.integer({ min: 1, max: 5_000 })),
    { maxLength: 6 },
  );
  const operand = fc.tuple(idSet, ranges).map(([ids, rs]) => {
    const out = merged();
    out.addMany(ids);
    for (const [lo, n] of rs) out.addRange(lo, lo + n);
    return out;
  });
  const bound = fc.option(fc.integer({ min: 0, max: 330_000 }), { nil: undefined });

  it('is equal on cleartext and on encrypted stores', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          a: operand,
          b: operand,
          c: operand,
          dest: fc.option(operand, { nil: undefined }),
          verb: fc.constantFrom<Verb>('intersect', 'union', 'andNot'),
          exclude: fc.boolean(),
          after: bound,
          through: bound,
          allowEmpty: fc.boolean(),
          metadata: fc.boolean(),
          minRetained: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
          encrypted: fc.boolean(),
        }),
        async (s) => {
          const call: Call = {
            verb: s.verb,
            others: s.verb === 'andNot' ? ['b', 'c'] : s.exclude ? ['b'] : ['b', 'c'],
            options: {
              ...(s.verb !== 'andNot' && s.exclude ? { exclude: ['c'] } : {}),
              ...(s.after === undefined ? {} : { after: s.after }),
              ...(s.through === undefined ? {} : { through: s.through }),
              ...(s.allowEmpty ? { allowEmpty: true } : {}),
              ...(s.metadata ? { metadata: META } : {}),
              ...(s.minRetained === undefined ? {} : { guard: { minRetained: s.minRetained } }),
            },
          };
          const keys = { k1: randomBytes(32) };
          const { chunks, ids } = await bothRoutes(
            call,
            build({
              data: { a: s.a, b: s.b, c: s.c },
              encrypted: s.encrypted,
              keys,
              ...(s.dest === undefined ? {} : { dest: s.dest }),
            }),
          );
          expectSameRoutes(chunks, ids);
        },
      ),
      { numRuns: 60 },
    );
  });
});
