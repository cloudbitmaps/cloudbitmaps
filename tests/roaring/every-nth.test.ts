import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoaringBitmap32, SerializationFormat } from 'roaring';
import {
  BudgetExceededError,
  CloudRoaring,
  IntegrityError,
  NotFoundError,
  UnsupportedError,
  ValidationError,
} from '@/index';
import type { IdRange, Segment } from '@/index';
import { gcOrphanGenerations } from '@/core/generation-gc';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { chunkReads } from '../helpers/chunk-reads';
import { writeCrbm } from '../helpers/crbm-extension';
import { collect, loadedStore } from '../helpers/loaded';

/**
 * `everyNth` on a pinned handle: the ids at ranks n, 2n, 3n … of the ids in `(after, through]`. A walk of the same
 * ids is the oracle for every case, and the chunk reads are counted at the reader, since a coalesced stream makes few
 * requests for many chunks.
 */

const CHUNK = 65_536;
const U32_MAX = 4_294_967_295;

/** The oracle: a walk of the ids in range, keeping every nth. */
function walked(ids: readonly number[], n: number, range: IdRange = {}): number[] {
  const lo = range.after === undefined ? 0 : range.after + 1;
  const hi = range.through ?? U32_MAX;
  const inRange = [...new Set(ids)].sort((a, b) => a - b).filter((id) => id >= lo && id <= hi);
  return inRange.filter((_, i) => (i + 1) % n === 0);
}

/** Pseudo-random ids from a seed: the same set on every run. */
function scatter(count: number, span: number, seed: number): number[] {
  let x = seed;
  const out = new Set<number>();
  while (out.size < count) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    out.add(x % span);
  }
  return [...out].sort((a, b) => a - b);
}

async function pinned(ids: readonly number[]) {
  const w = await loadedStore({ s: ids });
  return { ...w, seg: await w.store.segment('s').pin() };
}

const read = (seg: Segment, n: number, range?: IdRange) => collect(seg.everyNth(n, range));

// Four shapes, scaled to run fast: sparse over many chunks, dense, a few chunks, three chunks.
const SHAPES: Record<string, number[]> = {
  'A sparse, one id in about 1,000 chunks': scatter(1_500, 1_000 * CHUNK, 7),
  'B dense, over four chunks': Array.from({ length: 4 * CHUNK }, (_, i) => i),
  'C 5,000 ids over five chunks': scatter(5_000, 5 * CHUNK, 11),
  'D 300 ids over three chunks': scatter(300, 3 * CHUNK, 13),
};

describe('everyNth equals a walk', () => {
  for (const [name, ids] of Object.entries(SHAPES)) {
    it(`${name}: for n of 1, 7, 100, count and past count`, async () => {
      const { seg } = await pinned(ids);
      for (const n of [1, 7, 100, ids.length, ids.length + 1]) {
        expect(await read(seg, n), `n = ${n}`).toEqual(walked(ids, n));
      }
    });
  }

  it('with `after` and `through` inside a chunk, on a chunk boundary and on an absent chunk', async () => {
    const ids = [
      ...scatter(400, 3 * CHUNK, 3),
      ...scatter(400, CHUNK, 5).map((i) => i + 6 * CHUNK),
    ];
    const { seg } = await pinned(ids);
    const bounds = [
      0,
      1,
      5,
      CHUNK - 1,
      CHUNK,
      CHUNK + 1,
      2 * CHUNK - 1,
      3 * CHUNK,
      4 * CHUNK + 9,
      5 * CHUNK - 1,
      5 * CHUNK,
      6 * CHUNK - 1,
      6 * CHUNK,
      6 * CHUNK + 50,
      7 * CHUNK - 1,
      7 * CHUNK,
      U32_MAX,
    ];
    for (const after of [undefined, ...bounds]) {
      for (const through of [undefined, ...bounds]) {
        for (const n of [1, 3, 50]) {
          expect(await read(seg, n, { after, through }), `${after}..${through} n=${n}`).toEqual(
            walked(ids, n, { after, through }),
          );
        }
      }
    }
  });

  it('`after` at or past `through` yields nothing and reads no chunk', async () => {
    const reads = chunkReads();
    reads.start();
    try {
      const { seg } = await pinned(SHAPES['C 5,000 ids over five chunks']!);
      reads.reset();
      expect(await read(seg, 1, { after: 70_000, through: 70_000 })).toEqual([]);
      expect(await read(seg, 1, { after: 90_000, through: 70_000 })).toEqual([]);
      expect(reads.total()).toBe(0);
    } finally {
      reads.stop();
    }
  });

  it('a segment with no generation, and an id range with no ids, yield nothing', async () => {
    const { store, seg } = await pinned([5, 6, 7]);
    expect(await collect((await store.segment('nobody').pin()).everyNth(1))).toEqual([]);
    expect(await read(seg, 1, { after: 7 })).toEqual([]);
  });

  it('holds on random sets, with random bounds and n (property)', async () => {
    const id = fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 300_000 }) },
      { weight: 2, arbitrary: fc.integer({ min: 0, max: U32_MAX }) },
      { weight: 2, arbitrary: fc.integer({ min: U32_MAX - 70_000, max: U32_MAX }) },
      { weight: 2, arbitrary: fc.constantFrom(0, 65_535, 65_536, 131_071, 131_072, U32_MAX) },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(id, { minLength: 1, maxLength: 80 }),
        fc.integer({ min: 1, max: 20 }),
        fc.option(id, { nil: undefined }),
        fc.option(id, { nil: undefined }),
        async (ids, n, after, through) => {
          const { seg } = await pinned(ids);
          expect(await read(seg, n, { after, through })).toEqual(
            walked(ids, n, { after, through }),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('everyNth refuses what it cannot answer', () => {
  it('n that is not a positive integer throws ValidationError at the first read', async () => {
    const { seg } = await pinned([1, 2, 3]);
    for (const n of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, '3' as unknown as number]) {
      await expect(read(seg, n), String(n)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('a bad bound throws ValidationError', async () => {
    const { seg } = await pinned([1, 2, 3]);
    await expect(read(seg, 1, { after: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(read(seg, 1, { through: 1.5 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('a live handle is refused with UnsupportedError, at the first read', async () => {
    const { store } = await pinned([1, 2, 3]);
    const live = store.segment('s');
    const stream = live.everyNth(1); // refusing is not a throw at the call
    await expect(collect(stream)).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('a pinned read after a sweep throws NotFoundError, as the other pinned reads do', async () => {
    // Over the tail read, so the pin's reader does not hold the object and a chunk has to be fetched.
    const ids = scatter(240_000, 600 * CHUNK, 21);
    const { storage, registry, seg } = await pinned(ids);
    await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 1 }, [9], { registry });
    await gcOrphanGenerations({ segment: 's' }, { storage, registry }, { keep: 0 });
    await expect(collect(seg.iterate())).rejects.toBeInstanceOf(NotFoundError);
    await expect(read(seg, 1000)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('everyNth reads at most one chunk per boundary', () => {
  const reads = chunkReads();
  beforeEach(() => reads.start());
  afterEach(() => reads.stop());

  /** The distinct chunks that hold an id of the oracle's answer. */
  const chunksHolding = (answer: number[]): number[] => [
    ...new Set(answer.map((id) => Math.floor(id / CHUNK))),
  ];

  /** Every chunk key asked for, across streams and single reads. */
  const asked = (): number[] => [...reads.streams.flat(), ...reads.singles];

  it('reads only the chunks that hold a boundary, each once, in one coalesced stream', async () => {
    // 40 chunks of 50 ids: a boundary every 100th id lands in every second chunk.
    const ids = Array.from({ length: 40 }, (_, c) =>
      Array.from({ length: 50 }, (_, i) => c * CHUNK + i * 3),
    ).flat();
    const { seg } = await pinned(ids);
    reads.reset();
    const got = await read(seg, 100);
    expect(got).toEqual(walked(ids, 100));
    const holding = chunksHolding(got);
    expect(holding).toHaveLength(20);
    expect(asked()).toEqual(holding); // each once, ascending, and no other chunk
    expect(reads.streams).toHaveLength(1);
    expect(reads.singles).toEqual([]);
    expect(reads.total()).toBeLessThanOrEqual(got.length);
  });

  it('several boundaries in one chunk read it once', async () => {
    const ids = Array.from({ length: 3 * CHUNK }, (_, i) => i); // dense, three chunks
    const { seg } = await pinned(ids);
    reads.reset();
    const got = await read(seg, 1000);
    expect(got).toHaveLength(196);
    expect(asked()).toEqual([0, 1, 2]);
  });

  it('a range that cuts its first chunk reads it once, and no chunk past `through`', async () => {
    const ids = Array.from({ length: 6 * CHUNK }, (_, i) => i);
    const { seg } = await pinned(ids);
    reads.reset();
    const range = { after: CHUNK + 100, through: 3 * CHUNK + 10 };
    expect(await read(seg, 20_000, range)).toEqual(walked(ids, 20_000, range));
    const keys = asked();
    expect(new Set(keys).size).toBe(keys.length); // none twice
    expect(Math.max(...keys)).toBeLessThanOrEqual(3);
    expect(Math.min(...keys)).toBeGreaterThanOrEqual(1);
  });

  it('no chunk is read when n is past the count', async () => {
    const { seg } = await pinned(SHAPES['D 300 ids over three chunks']!);
    reads.reset();
    expect(await read(seg, 301)).toEqual([]);
    expect(reads.total()).toBe(0);
  });

  it('charges the per-op budget once per chunk read, before the first fetch', async () => {
    const ids = Array.from({ length: 5 }, (_, c) =>
      Array.from({ length: 10 }, (_, i) => c * CHUNK + i),
    ).flat(); // five chunks, a boundary in each at n = 10
    const w = await loadedStore({ s: ids }, { budget: { maxRequests: 5 } });
    const seg = await w.store.segment('s').pin();
    reads.reset();
    expect(await read(seg, 10)).toHaveLength(5);
    expect(reads.total()).toBe(5);

    const tight = new CloudRoaring({ storage: w.backend, budget: { maxRequests: 4 } });
    const tightSeg = await tight.segment('s').pin();
    reads.reset();
    await expect(read(tightSeg, 10)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(reads.total()).toBe(0); // refused before any fetch

    // A boundary-free chunk is not charged: n = 25 puts two boundaries in two chunks.
    expect(await read(tightSeg, 25)).toHaveLength(2);
    // And a per-call budget on the engine is the store's: the loose store has room for all five.
    expect(await read(seg, 1)).toHaveLength(50);
  });

  it('charges the chunk that cuts a range as well', async () => {
    const ids = Array.from({ length: 4 }, (_, c) =>
      Array.from({ length: 10 }, (_, i) => c * CHUNK + i),
    ).flat();
    const w = await loadedStore({ s: ids });
    const at = { after: 3 }; // inside chunk 0, which then holds 6 ids: boundaries at n = 6 in chunks 0, 1, 2 ...
    const ok = new CloudRoaring({ storage: w.backend, budget: { maxRequests: 4 } });
    expect(await read(await ok.segment('s').pin(), 6, at)).toEqual(walked(ids, 6, at));
    const tight = new CloudRoaring({ storage: w.backend, budget: { maxRequests: 3 } });
    reads.reset();
    await expect(read(await tight.segment('s').pin(), 6, at)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });
});

describe('everyNth checks what the index promised (invariant 5)', () => {
  /** A segment whose generation 1 holds three ids in a chunk whose index says `claimed`. */
  async function crafted(claimed: number) {
    const w = await loadedStore({ s: [1] });
    const payload = new RoaringBitmap32([4, 5, 6]).serialize(SerializationFormat.portable);
    const bytes = await writeCrbm([{ chunkKey: 0, payload, cardinality: claimed }], {
      generation: 1,
    });
    await w.storage.putImmutable({ segment: 's', generation: 1 }, async (out) => out.write(bytes));
    const row = (await w.registry.get({ segment: 's' }))!;
    await w.registry.compareAndSwap({ segment: 's' }, row.token, { currentGen: 1 });
    return w;
  }

  it('a chunk that holds fewer ids than its index says throws IntegrityError', async () => {
    const w = await crafted(5);
    const seg = await w.store.segment('s').pin();
    await expect(read(seg, 1)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('a chunk that holds more ids than its index says throws IntegrityError', async () => {
    const w = await crafted(2);
    const seg = await w.store.segment('s').pin();
    await expect(read(seg, 1)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('the chunk that cuts a range is checked too', async () => {
    const w = await crafted(5);
    const seg = await w.store.segment('s').pin();
    await expect(read(seg, 1, { after: 4 })).rejects.toBeInstanceOf(IntegrityError);
  });

  it('a chunk that agrees with its index reads', async () => {
    const w = await crafted(3);
    const seg = await w.store.segment('s').pin();
    expect(await read(seg, 2)).toEqual([5]);
  });
});
