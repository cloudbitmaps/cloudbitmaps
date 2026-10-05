import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BudgetExceededError,
  CloudRoaring,
  CountingMetricsSink,
  IntegrityError,
  ValidationError,
} from '@/index';
import type { IdStream, Segment } from '@/index';
import { RoaringBitmap32, SerializationFormat } from 'roaring';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `.batches()` on a streaming read: the same ids as the per-id stream, one `Uint32Array` per chunk. The per-id
 * stream is the oracle for every read, so anything the two disagree on is a defect in one of them.
 */

async function batchesOf(stream: IdStream): Promise<Uint32Array[]> {
  const out: Uint32Array[] = [];
  for await (const ids of stream.batches()) out.push(ids);
  return out;
}

/** The first element, then out of the loop: what a `break` after one does. */
async function firstOf<T>(stream: AsyncIterable<T>): Promise<T | undefined> {
  for await (const item of stream) return item;
  return undefined;
}

const flatten = (batches: Uint32Array[]): number[] => batches.flatMap((b) => [...b]);

/** What every batch read must satisfy on its own, whatever it is compared with. */
function expectWellFormed(batches: Uint32Array[]): void {
  let previous = -1;
  for (const b of batches) {
    expect(b).toBeInstanceOf(Uint32Array);
    expect(b.length).toBeGreaterThan(0); // an empty chunk yields nothing
    expect(b.length).toBeLessThanOrEqual(65_536);
    for (const id of b) {
      expect(id).toBeGreaterThan(previous); // ascending within and across batches
      previous = id;
    }
  }
}

const KEY_HIGH = 40_000 * 65_536; // a chunk key past 32767, where `<< 16` wraps negative
const U32_MAX = 4_294_967_295;

// Ids drawn where routing breaks: first/last remainder of a chunk, keys past 32767, the top of the u32 range.
const ID = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 300_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: U32_MAX }) },
  { weight: 2, arbitrary: fc.integer({ min: U32_MAX - 70_000, max: U32_MAX }) },
  { weight: 2, arbitrary: fc.integer({ min: 32_767 * 65_536 - 5, max: 32_769 * 65_536 + 5 }) },
  { weight: 2, arbitrary: fc.constantFrom(0, 65_535, 65_536, 131_071, 131_072, U32_MAX) },
);
const universe = fc.uniqueArray(ID, { minLength: 1, maxLength: 60 });
const operands = universe.chain((u) => fc.tuple(fc.subarray(u), fc.subarray(u), fc.subarray(u)));
const range = fc.record(
  { after: fc.option(ID, { nil: undefined }), through: fc.option(ID, { nil: undefined }) },
  { requiredKeys: [] },
);

async function world(a: number[], b: number[], c: number[]) {
  const w = await loadedStore({ a, b, c });
  return { ...w, a: w.store.segment('a'), b: w.store.segment('b'), c: w.store.segment('c') };
}

/** One read of `read`, both ways, on two stores over the same data so neither warms the other's cache. */
async function bothWays(
  w: Awaited<ReturnType<typeof world>>,
  read: (s: { a: Segment; b: Segment; c: Segment }) => IdStream,
) {
  const open = () => {
    const metrics = new CountingMetricsSink();
    const store = new CloudRoaring({
      storage: w.backend,
      metrics,
      cache: { genTtlMs: 0 },
    });
    return { metrics, s: { a: store.segment('a'), b: store.segment('b'), c: store.segment('c') } };
  };
  const one = open();
  const two = open();
  const perId = await collect(read(one.s));
  const batches = await batchesOf(read(two.s));
  return {
    perId,
    batches,
    idGets: one.metrics.snapshot().storage.gets,
    batchGets: two.metrics.snapshot().storage.gets,
  };
}

describe('batches() flattens to exactly the per-id stream', () => {
  const verbs: Array<[string, (s: { a: Segment; b: Segment; c: Segment }, r: object) => IdStream]> =
    [
      ['iterate', (s, r) => s.a.iterate(r)],
      ['intersect', (s, r) => s.a.intersect([s.b], r)],
      ['intersect with exclude', (s, r) => s.a.intersect([s.b], { ...r, exclude: [s.c] })],
      ['union', (s, r) => s.a.union([s.b], r)],
      ['union with exclude', (s, r) => s.a.union([s.b], { ...r, exclude: [s.c] })],
      ['andNot', (s, r) => s.a.andNot([s.b, s.c], r)],
    ];

  for (const [name, read] of verbs) {
    it(`${name}: same ids, ascending, no empty arrays, same requests (ranged or not)`, async () => {
      await fc.assert(
        fc.asyncProperty(operands, range, async ([a, b, c], r) => {
          const w = await world(a, b, c);
          for (const ranged of [{}, r]) {
            const got = await bothWays(w, (s) => read(s, ranged));
            expect(flatten(got.batches)).toEqual(got.perId);
            expectWellFormed(got.batches);
            expect(got.batchGets).toBe(got.idGets);
          }
        }),
        { numRuns: 40 },
      );
    });
  }

  it('a pinned handle reads its pinned generation, both ways, and `.batches()` agrees', async () => {
    await fc.assert(
      fc.asyncProperty(operands, range, async ([a, b, c], r) => {
        const w = await world(a, b, c);
        const pinned = await w.a.pin();
        await w.load('a', [...a, 123_456]); // a later generation the pin must not see
        const fresh = new CloudRoaring({ storage: w.backend, cache: { genTtlMs: 0 } });
        const pa = await fresh.segment('a').pin();
        await w.load('a', [7]);
        for (const read of [
          (s: Segment) => s.iterate(r),
          (s: Segment) => s.union([w.b], r),
          (s: Segment) => s.andNot([w.b, w.c], r),
          (s: Segment) => s.intersect([w.b], r),
        ]) {
          for (const handle of [pinned, pa]) {
            const batches = await batchesOf(read(handle));
            expect(flatten(batches)).toEqual(await collect(read(handle)));
            expectWellFormed(batches);
          }
        }
      }),
      { numRuns: 25 },
    );
  });

  it('keeps ids past 32767 chunks and at the top of the u32 range', async () => {
    const ids = [
      0,
      65_535,
      2 ** 31,
      2 ** 31 + 1,
      KEY_HIGH,
      KEY_HIGH + 65_535,
      U32_MAX - 1,
      U32_MAX,
    ];
    const { store } = await loadedStore({ s: ids });
    const seg = store.segment('s');
    const all = await batchesOf(seg.iterate());
    expect(flatten(all)).toEqual(ids);
    expect(all.map((b) => b.length)).toEqual([2, 2, 2, 2]);
    // The range cuts the lower edge chunk down to its top id and the upper edge chunk to its first.
    const cut = await batchesOf(seg.iterate({ after: KEY_HIGH, through: U32_MAX - 1 }));
    expect(cut.map((b) => [...b])).toEqual([[KEY_HIGH + 65_535], [U32_MAX - 1]]);
  });

  it('a chunk the range empties yields no array', async () => {
    const { store } = await loadedStore({ s: [1, 2, 70_000, 140_000] });
    const got = await batchesOf(store.segment('s').iterate({ after: 2, through: 140_000 - 1 }));
    expect(flatten(got)).toEqual([70_000]);
    // Chunk 0 lies on the lower edge but holds nothing in the range: no empty array for it.
    expect(got).toHaveLength(1);
  });

  it('each batch is the caller own: changing one changes nothing a later read sees', async () => {
    const { store } = await loadedStore({ s: [1, 2, 3, 70_000] });
    const seg = store.segment('s');
    for await (const ids of seg.iterate().batches()) ids.fill(0);
    expect(await collect(seg.iterate())).toEqual([1, 2, 3, 70_000]);
    for await (const ids of seg.union([seg]).batches()) ids.fill(0);
    expect(await collect(seg.union([seg]))).toEqual([1, 2, 3, 70_000]);
  });
});

describe('the per-id stream is the generator it was in 0.13.0', () => {
  const MANY = Array.from({ length: 6 }, (_, k) => k * 65_536 + 1);

  async function reads() {
    const metrics = new CountingMetricsSink();
    const { store } = await loadedStore({ s: MANY, t: [1] }, { metrics, cache: { genTtlMs: 0 } });
    const s = store.segment('s');
    const t = store.segment('t');
    const all: Array<[string, () => IdStream]> = [
      ['iterate', () => s.iterate()],
      ['ranged iterate', () => s.iterate({ after: 0 })],
      ['intersect', () => s.intersect([s])],
      ['union', () => s.union([t])],
      ['andNot', () => s.andNot([t])],
    ];
    return { metrics, all };
  }

  it('is its own iterator and has next, return and throw', async () => {
    const { all } = await reads();
    for (const [name, make] of all) {
      const stream = make() as unknown as AsyncGenerator<number>;
      expect(stream[Symbol.asyncIterator](), name).toBe(stream);
      for (const m of ['next', 'return', 'throw'] as const) {
        expect(typeof stream[m], `${name}.${m}`).toBe('function');
      }
      expect(Object.prototype.toString.call(stream), name).toBe('[object AsyncGenerator]');
    }
  });

  it('next() walks the ids, return() ends it, throw() rejects and ends it', async () => {
    const { all } = await reads();
    for (const [name, make] of all) {
      const g = make() as unknown as AsyncGenerator<number>;
      const first = await g.next();
      expect(first.done, name).toBe(false);
      expect(await g.return(undefined), name).toEqual({ value: undefined, done: true });
      expect(await g.next(), name).toEqual({ value: undefined, done: true });

      const h = make() as unknown as AsyncGenerator<number>;
      await h.next();
      await expect(h.throw(new Error('boom')), name).rejects.toThrow('boom');
      expect((await h.next()).done, name).toBe(true);
    }
  });

  it('is single-use: a second for-await over it yields nothing', async () => {
    const { all } = await reads();
    for (const [name, make] of all) {
      const stream = make();
      expect((await collect(stream)).length, name).toBeGreaterThan(0);
      expect(await collect(stream), name).toEqual([]);
    }
  });

  it('creating it reads nothing, and batches() is a separate read that starts when called', async () => {
    const { metrics, all } = await reads();
    for (const [name, make] of all) {
      metrics.reset?.();
      const before = metrics.snapshot().storage.gets;
      const stream = make();
      const it = stream.batches()[Symbol.asyncIterator]();
      expect(metrics.snapshot().storage.gets, name).toBe(before);
      await it.next();
      // The per-id stream was never pulled, yet batches() read; and after a full per-id read batches() still reads.
      const perId = await collect(stream);
      const again = flatten(await batchesOf(stream));
      expect(again, name).toEqual(perId);
      await it.return?.();
    }
  });

  it('expired and failing results are as in 0.13.0 for the per-id path, plus batches()', async () => {
    const { store } = await loadedStore({ s: [1, 2] });
    const dead = store.segment('s', { expiresAt: 1_700_000_000_000 }); // long past, on the system clock
    const empty = dead.iterate();
    expect(await collect(empty)).toEqual([]);
    expect(await collect(empty)).toEqual([]); // a shared, re-iterable empty stream
    expect(await batchesOf(empty)).toEqual([]);
    const bad = store.segment('s').intersect([]);
    await expect(collect(bad)).resolves.toEqual([1, 2]); // an empty operand list is just this segment
    const failing = store.segment('s').iterate({ after: -1 });
    await expect(collect(failing)).rejects.toBeInstanceOf(ValidationError);
    await expect(batchesOf(failing)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('a batches() iterator driven by hand', () => {
  it('return() stops the read, and later next() is done', async () => {
    const ids = Array.from({ length: 200 }, (_, k) => k * 65_536 + 1);
    const metrics = new CountingMetricsSink();
    const { store } = await loadedStore({ s: ids }, { metrics, cache: { genTtlMs: 0 } });
    const it = store.segment('s').iterate().batches()[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await it.return?.();
    expect((await it.next()).done).toBe(true);
    const gets = metrics.snapshot().storage.gets;
    expect(gets).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(metrics.snapshot().storage.gets).toBe(gets); // nothing further is started
  });
});

describe('each batch owns exactly its ids', () => {
  it('has its own buffer, edge chunks included', async () => {
    const { store } = await loadedStore({
      s: [1, 2, 3, 70_000, 70_001, 140_000, 140_001, 140_002],
    });
    const seg = store.segment('s');
    const reads = [
      seg.iterate(),
      seg.iterate({ after: 1, through: 140_001 }), // both edges cut
      seg.union([seg], { after: 2, through: 140_000 }),
      seg.andNot([store.segment('s')], { allowAbsentOperands: true, after: 0 }),
    ];
    for (const read of reads) {
      for await (const b of read.batches()) {
        expect(b.byteOffset).toBe(0);
        expect(b.buffer.byteLength).toBe(b.length * 4);
      }
    }
  });
});

describe('a chunk the index lists but the source cannot produce', () => {
  it('is skipped, not a stop: later chunks still arrive, as in the per-id stream', async () => {
    class Listing extends MemoryStorageChunkSource {
      override async listChunkKeys(ref: Parameters<MemoryStorageChunkSource['listChunkKeys']>[0]) {
        return [...(await super.listChunkKeys(ref)), 2]; // key 2 has no bytes
      }
    }
    const storage = new Listing();
    const bytes = (v: number[]) => new RoaringBitmap32(v).serialize(SerializationFormat.portable);
    storage.seed({ segment: 's', chunkKey: 1 }, bytes([1, 2]));
    storage.seed({ segment: 's', chunkKey: 3 }, bytes([5]));
    const store = new CloudRoaring({ storage });
    const s = store.segment('s');
    const reads = [
      () => s.iterate(),
      () => s.union([s]),
      () => s.intersect([s]),
      () => s.iterate({ after: 0 }),
    ];
    for (const read of reads) {
      const batches = await batchesOf(read());
      expect(flatten(batches)).toEqual(await collect(read()));
      expect(flatten(batches)).toEqual([65_537, 65_538, 3 * 65_536 + 5]);
    }
  });
});

describe('batches() stops where the per-id stream stops', () => {
  it('break after the first array stops the read, with the requests of breaking after the first id', async () => {
    const ids = Array.from({ length: 200 }, (_, k) => k * 65_536 + 1);
    const w = await loadedStore({ s: ids, o: [5] });
    const stores = () => {
      const metrics = new CountingMetricsSink();
      const store = new CloudRoaring({ storage: w.backend, metrics, cache: { genTtlMs: 0 } });
      return { metrics, s: store.segment('s'), o: store.segment('o') };
    };
    const reads: Array<[string, (x: ReturnType<typeof stores>) => IdStream]> = [
      ['iterate', (x) => x.s.iterate()],
      ['ranged iterate', (x) => x.s.iterate({ after: 100 })],
      ['union', (x) => x.s.union([x.o])],
      ['andNot', (x) => x.s.andNot([x.o])],
      ['intersect', (x) => x.s.intersect([x.s])],
    ];
    for (const [name, read] of reads) {
      const a = stores();
      await firstOf(read(a));
      const b = stores();
      await firstOf(read(b).batches());
      const full = stores();
      await collect(read(full));
      const stopped = b.metrics.snapshot().storage.gets;
      expect(stopped, name).toBe(a.metrics.snapshot().storage.gets);
      // These chunks are small, so the whole segment is a range or two and breaking cannot save a request; that a
      // break stops a stream's reads is held by the reader's own tests, with ranges enough to stop between.
      expect(stopped, name).toBeLessThanOrEqual(full.metrics.snapshot().storage.gets);
    }
  });

  it('a throw out of the loop body ends the read too', async () => {
    const ids = Array.from({ length: 200 }, (_, k) => k * 65_536 + 1);
    const metrics = new CountingMetricsSink();
    const { store } = await loadedStore({ s: ids }, { metrics, cache: { genTtlMs: 0 } });
    await expect(
      (async () => {
        for await (const ids of store.segment('s').iterate().batches()) {
          if (ids.length > 0) throw new Error('stop');
        }
      })(),
    ).rejects.toThrow('stop');
    expect(metrics.snapshot().storage.gets).toBeLessThan(200);
  });
});

describe('batches() fails and refuses exactly as the per-id stream does', () => {
  it('the same refusal, at the first read, for a bad range, a budget, an empty combine and an absent operand', async () => {
    const { store } = await loadedStore({ s: [1, 70_000, 140_000], t: [1] });
    const s = store.segment('s');
    const ghost = store.segment('nobody-loaded-this');
    const cases: Array<[string, () => IdStream, new (...a: never[]) => Error]> = [
      ['bad range', () => s.iterate({ after: -1 }), ValidationError],
      [
        'bad range in a combine',
        () => s.union([store.segment('t')], { through: 1.5 }),
        ValidationError,
      ],
      [
        'budget on union',
        () => s.union([store.segment('t')], { budget: { maxRequests: 1 } }),
        BudgetExceededError,
      ],
      ['empty intersect', () => s.intersect([], { concurrency: 0 }), ValidationError],
      ['absent operand', () => s.andNot([ghost]), ValidationError],
    ];
    for (const [name, make, type] of cases) {
      const perId = await collect(make()).catch((e: unknown) => e);
      const batch = await batchesOf(make()).catch((e: unknown) => e);
      expect(perId, name).toBeInstanceOf(type);
      expect(batch, name).toBeInstanceOf(type);
      expect((batch as Error).message, name).toBe((perId as Error).message);
    }
  });

  it('a store budget refuses iterate before any chunk is fetched, both ways', async () => {
    const w = await loadedStore({ s: [1, 70_000, 140_000] });
    const metrics = new CountingMetricsSink();
    const store = new CloudRoaring({ storage: w.backend, metrics, budget: { maxRequests: 2 } });
    const seg = store.segment('s');
    await expect(collect(seg.iterate())).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(batchesOf(seg.iterate())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(metrics.snapshot().storage.gets).toBe(0);
  });

  it('a corrupt chunk (a value past 16 bits) is refused on the batch path too', async () => {
    const storage = new MemoryStorageChunkSource();
    storage.seed(
      { segment: 'bad', chunkKey: 3 },
      new RoaringBitmap32([1, 70_000]).serialize(SerializationFormat.portable),
    );
    storage.seed(
      { segment: 'ok', chunkKey: 3 },
      new RoaringBitmap32([1, 2]).serialize(SerializationFormat.portable),
    );
    const store = new CloudRoaring({ storage });
    const bad = store.segment('bad');
    await expect(batchesOf(bad.iterate())).rejects.toBeInstanceOf(IntegrityError);
    await expect(batchesOf(bad.intersect([store.segment('ok')]))).rejects.toBeInstanceOf(
      IntegrityError,
    );
    await expect(batchesOf(bad.union([]))).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('expiry reads the same on both', () => {
  const T0 = 1_754_000_000_000;
  const DAY = 86_400_000;
  function harness() {
    let t = T0;
    const clock = { now: () => t, sleep: () => Promise.resolve() };
    return { clock, advance: (ms: number) => (t += ms) };
  }

  it('an expired handle or operand behaves as in the per-id stream', async () => {
    const h = harness();
    const { backend, store } = await loadedStore(
      { a: [1, 70_000, 140_000], b: [70_000, 140_000], c: [140_000] },
      { seams: { clock: h.clock }, cache: { genTtlMs: 0 } },
    );
    void backend;
    const live = store.segment('a');
    const dying = (name: string) => store.segment(name, { expiresAt: T0 + DAY });
    h.advance(DAY);
    const cases: Array<() => IdStream> = [
      () => dying('a').iterate(),
      () => dying('a').union([store.segment('b')]),
      () => live.union([dying('b')]),
      () => live.union([dying('b')], { exclude: [store.segment('c')] }),
      () => live.intersect([dying('b')]),
      () => dying('a').union([store.segment('b')], { exclude: [store.segment('c')] }),
    ];
    for (const [i, make] of cases.entries()) {
      const batches = await batchesOf(make());
      expect(flatten(batches), `case ${i}`).toEqual(await collect(make()));
      expectWellFormed(batches);
    }
  });
});

describe('the result stays an AsyncIterable<number>', () => {
  it('is assignable to AsyncIterable<number> and names batches()', async () => {
    const { store } = await loadedStore({ s: [1, 2, 3], t: [2] });
    const s = store.segment('s');
    const t = store.segment('t');
    expectTypeOf(s.iterate()).toExtend<AsyncIterable<number>>();
    expectTypeOf(s.intersect([t])).toExtend<AsyncIterable<number>>();
    expectTypeOf(s.union([t])).toExtend<AsyncIterable<number>>();
    expectTypeOf(s.andNot([t])).toExtend<AsyncIterable<number>>();
    expectTypeOf<IdStream['batches']>().returns.toEqualTypeOf<AsyncIterable<Uint32Array>>();
    const asIterable: AsyncIterable<number> = s.iterate(); // no caller that took one breaks
    expect(await collect(asIterable)).toEqual([1, 2, 3]);
    // And an `*Into` that takes one still does.
    await s.andNotInto(store.segment('out'), [t]);
    expect(await collect(store.segment('out').iterate())).toEqual([1, 3]);
  });
});
