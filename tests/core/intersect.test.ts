import fc from 'fast-check';
import { CloudRoaring, MemoryColdChunkSource, type Clock } from '@/index';
import { roaringCodec, SafeBitmap } from '@/roaring-codec';
import { SegmentEngine } from '@/core/engine';
import { joinId } from '@/core/bit-route';
import { ValidationError } from '@/core/errors';
import type { ChunkRef, ColdChunkSource, SegmentRef } from '@/core/ports';
import { collect, loadedStore, seedSegment } from '../helpers/loaded';

/**
 * A ColdChunkSource that records every getChunk call — to prove chunk-skipping (non-overlapping keys are never
 * fetched). Delegates to an in-memory source; seed it through `inner`.
 */
class CountingCold implements ColdChunkSource {
  readonly inner = new MemoryColdChunkSource();
  readonly fetched: string[] = [];

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.fetched.push(`${ref.namespace ?? '/'}|${ref.segment}|${ref.chunkKey}`);
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
}

/** A store over a counting source; `seed` writes a segment's chunks exactly as a `.crbm` generation holds them. */
function harness(): {
  cold: CountingCold;
  store: CloudRoaring;
  seed: (segment: string, ids: number[]) => void;
} {
  const cold = new CountingCold();
  const store = new CloudRoaring({ cold });
  return { cold, store, seed: (segment, ids) => void seedSegment(cold.inner, segment, ids) };
}

function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

describe('chunk-skipping intersection', () => {
  it('returns the set-intersection, ascending', async () => {
    const { store, seed } = harness();
    seed('a', [1, 2, 3, 100, 200_000]);
    seed('b', [2, 3, 4, 200_000, 999]);
    expect(await collect(store.segment('a').intersect([store.segment('b')]))).toEqual([
      2, 3, 200_000,
    ]);
  });

  it('is commutative', async () => {
    const { store, seed } = harness();
    seed('a', [1, 2, 3, 70_000]);
    seed('b', [3, 70_000, 4]);
    const a = store.segment('a');
    const b = store.segment('b');
    expect(await collect(a.intersect([b]))).toEqual(await collect(b.intersect([a])));
  });

  it('NEVER fetches chunks for non-overlapping keys (the core saving)', async () => {
    const { cold, store, seed } = harness();
    // Chunk keys: a = {0, 5, 12}; b = {0, 9, 12}; common = {0, 12}.
    seed('a', [joinId(0, 1), joinId(0, 2), joinId(5, 1), joinId(12, 7)]);
    seed('b', [joinId(0, 2), joinId(0, 3), joinId(9, 1), joinId(12, 8)]);

    await collect(store.segment('a').intersect([store.segment('b')]));

    // Exact fetched set: ONLY the common keys {0,12} of BOTH operands — no non-overlapping key (5/9) and
    // no operand×key over-fetch. Pinning the exact set (not just "no 5/9") is what makes this a real bar.
    expect(new Set(cold.fetched)).toEqual(new Set(['/|a|0', '/|a|12', '/|b|0', '/|b|12']));
  });

  it('returns ∅ with zero payload fetches when no keys overlap', async () => {
    const { cold, store, seed } = harness();
    seed('a', [joinId(1, 1)]);
    seed('b', [joinId(2, 1)]);
    expect(await collect(store.segment('a').intersect([store.segment('b')]))).toEqual([]);
    expect(cold.fetched).toEqual([]); // index maps aligned; no chunk bytes downloaded
  });

  it('intersects three or more segments', async () => {
    const { store, seed } = harness();
    seed('a', [1, 2, 3, 4, 5]);
    seed('b', [2, 3, 4, 5]);
    seed('c', [3, 4, 5, 6]);
    const [a, b, c] = [store.segment('a'), store.segment('b'), store.segment('c')];
    expect(await collect(a.intersect([b, c]))).toEqual([3, 4, 5]);
  });

  it('intersect with no others yields the segment itself', async () => {
    const { store, seed } = harness();
    seed('a', [1, 2, 3, 70_000]);
    expect(await collect(store.segment('a').intersect([]))).toEqual([1, 2, 3, 70_000]);
  });

  it('gives the same result regardless of the concurrency window', async () => {
    const { store, seed } = harness();
    // ids spanning several chunks so the window matters
    const idsA = Array.from({ length: 400 }, (_v, i) => i * 700);
    const idsB = idsA.filter((_v, i) => i % 2 === 0);
    seed('a', idsA);
    seed('b', idsB);
    const a = store.segment('a');
    const b = store.segment('b');
    const c1 = await collect(a.intersect([b], { concurrency: 1 }));
    const c8 = await collect(a.intersect([b], { concurrency: 8 }));
    const c64 = await collect(a.intersect([b], { concurrency: 64 }));
    expect(c1).toEqual(idsB);
    expect(c8).toEqual(c1);
    expect(c64).toEqual(c1);
  });

  it('intersecting a segment with itself yields the segment (self-intersection)', async () => {
    const { store, seed } = harness();
    seed('a', [1, 3, 500, 70_000]);
    const a = store.segment('a');
    expect(await collect(a.intersect([a]))).toEqual([1, 3, 500, 70_000]);
  });

  // Boundary: the crown-jewel path at the top of the id space. Membership is proven at 0xFFFFFFFF elsewhere,
  // but intersect (joinId masking + assertChunkKeyInRange's `< 65536` edge + ascending merge across the full
  // span) was only sampled below chunk key 4 — a regression at the ceiling would have had no test.
  it('intersects at the maximum chunk-key span (id 0xFFFFFFFF, chunk 65535)', async () => {
    const { store, seed } = harness();
    const TOP = joinId(65_535, 65_535); // = 0xFFFF_FFFF, the u32 ceiling
    expect(TOP).toBe(0xffff_ffff);
    // Common in chunk 0 (id 1) and the top chunk (id TOP); b also has a non-overlapping id in the top chunk.
    seed('a', [joinId(0, 1), TOP]);
    seed('b', [joinId(0, 1), TOP, joinId(65_535, 1)]);
    // Correct set-intersection, ascending, spanning chunk 0 → chunk 65535 with the id at the very ceiling.
    expect(await collect(store.segment('a').intersect([store.segment('b')]))).toEqual([
      joinId(0, 1),
      TOP,
    ]);
  });

  // Boundary: a chunk key present in BOTH operands' indexes, but whose payload decodes to nothing in one of them
  // → combineChunk must yield null and be skipped, NOT produce a phantom id. The `.crbm` writer never stores an
  // empty chunk, so this is a hand-seeded (or foreign) object — still bytes read back from a tier, so still
  // handled. Proving the chunk WAS fetched (index keys aligned) pins the empty-chunk short-circuit rather than
  // an accidental index-level skip.
  it('drops a common chunk whose payload is empty in one operand (fetched, then skipped)', async () => {
    const { cold, store, seed } = harness();
    cold.inner.seed({ segment: 'a', chunkKey: 3 }, SafeBitmap.fromValues([]).serialize()); // listed, empty
    seed('b', [joinId(3, 10)]); // b shares chunk key 3
    expect(await collect(store.segment('a').intersect([store.segment('b')]))).toEqual([]); // no phantom id
    // The common chunk WAS fetched on both operands (keys aligned) — the drop is the empty-payload
    // short-circuit, not index-level chunk-skipping.
    expect(new Set(cold.fetched)).toEqual(new Set(['/|a|3', '/|b|3']));
  });

  it('does not mutate the operands / poison the cache (andInPlace safety)', async () => {
    const { store, seed } = harness();
    seed('a', [1, 2, 3]);
    seed('b', [2, 3, 4]);
    const a = store.segment('a');
    const b = store.segment('b');
    await collect(a.intersect([b])); // populates the HOT cache + runs andInPlace on fetched chunks
    // Operands must be unchanged afterward, and a second intersect must give the same result —
    // proving the in-place AND never mutated a cached/shared Cold bitmap.
    expect(await collect(a.iterate())).toEqual([1, 2, 3]);
    expect(await collect(b.iterate())).toEqual([2, 3, 4]);
    expect(await collect(a.intersect([b]))).toEqual([2, 3]);
  });

  it('rejects an empty operand list and a bad concurrency at the engine boundary', async () => {
    const engine = new SegmentEngine({ codec: roaringCodec, cold: new MemoryColdChunkSource() });
    // The public Segment.intersect always includes `this`; exercise the engine guards directly.
    await expect(
      collect(engine.intersect([{ segment: 's' }, { segment: 't' }], { concurrency: NaN })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      collect(engine.intersect([{ segment: 's' }], { concurrency: 0 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(collect(engine.intersect([]))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('intersectInto — the result is a NEW GENERATION of the destination', () => {
  it("materializes the intersection as the destination's generation 0 and reads it back", async () => {
    const { store, registry } = await loadedStore({
      a: [1, 2, 3, 70_000, 200_000],
      b: [2, 3, 200_000],
    });
    const result = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')]);
    expect(result).toEqual({
      generation: 0,
      cardinality: 3,
      chunkCount: 2, // {2, 3} share chunk 0; 200_000 is chunk 3
      size: expect.any(Number),
    });
    expect(result.size).toBeGreaterThan(0);
    expect((await registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
    const dest = store.segment('dest');
    expect(await collect(dest.iterate())).toEqual([2, 3, 200_000]);
    expect(await dest.count()).toBe(3);
  });

  it('REPLACES the destination — its previous contents are superseded, not added to', async () => {
    const clock = fakeClock();
    const { store, registry } = await loadedStore(
      { a: [1, 2, 3], b: [2, 3, 4], dest: [999, 70_000] },
      { clock, coldGenTtlMs: 1 },
    );
    const dest = store.segment('dest');
    expect(await collect(dest.iterate())).toEqual([999, 70_000]); // dest's own generation 0, readable first

    const result = await store.segment('a').intersectInto(dest, [store.segment('b')]);
    expect(result.generation).toBe(1);
    expect((await registry.get({ segment: 'dest' }))!.currentGen).toBe(1);

    clock.advance(1); // the reader's generation snapshot refreshes after coldGenTtlMs
    expect(await collect(dest.iterate())).toEqual([2, 3]); // 999 / 70_000 are gone: nothing was merged
    expect(await dest.has(999)).toBe(false);
    expect(await dest.count()).toBe(2);
  });

  it('an empty result publishes an empty generation (the destination reads as empty)', async () => {
    const { store, registry } = await loadedStore({ a: [1, 2], b: [70_000] });
    const result = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')]);
    expect(result).toMatchObject({ generation: 0, cardinality: 0, chunkCount: 0 });
    expect((await registry.get({ segment: 'dest' }))!.currentGen).toBe(0);
    expect(await store.segment('dest').count()).toBe(0);
    expect(await collect(store.segment('dest').iterate())).toEqual([]);
  });

  it('honours exclude and concurrency on the materialized path too', async () => {
    const { store } = await loadedStore({ a: [1, 2, 3, 70_000], b: [2, 3, 70_000], x: [3] });
    const result = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')], {
        exclude: [store.segment('x')],
        concurrency: 1,
      });
    expect(result.cardinality).toBe(2);
    expect(await collect(store.segment('dest').iterate())).toEqual([2, 70_000]);
  });
});

describe('intersection vs Set oracle (property)', () => {
  const ID = fc.integer({ min: 0, max: 300_000 });
  const BOUNDARY = [0, 1, 65_534, 65_535, 65_536, 65_537, 131_071, 131_072, 4_294_967_295];

  /**
   * Four subsets of ONE shared universe, plus the chunk-boundary ids explicitly.
   *
   * Three independent `fc.array(ID)` draws — the previous spelling — almost never overlap: measured over 200
   * samples, exactly **one** produced a non-empty two-way intersection and none touched a chunk boundary, so a
   * three-way intersection was effectively always empty and this property was asserting `[] === []`. Subsets of
   * a shared universe overlap by construction (92 of 200 two-way, 114 touching a boundary). The generator's
   * reach is asserted in `tests/engine.property.test.ts`, which uses the same construction.
   */
  const universe = fc.uniqueArray(
    fc.oneof(
      { weight: 3, arbitrary: ID },
      { weight: 2, arbitrary: fc.constantFrom(...BOUNDARY) },
      { weight: 2, arbitrary: fc.integer({ min: 65_500, max: 65_600 }) },
    ),
    { minLength: 1, maxLength: 24 },
  );
  const quad = universe.chain((u) =>
    fc.tuple(fc.subarray(u), fc.subarray(u), fc.subarray(u), fc.subarray(u)),
  );

  it('matches Set-intersection (minus an exclude) across random seeded segments and windows', async () => {
    await fc.assert(
      fc.asyncProperty(
        quad, // a, b, c and a suppression segment — all subsets of one universe
        fc.integer({ min: 1, max: 12 }), // randomized concurrency window
        async ([ca, cb, cc, cx], concurrency) => {
          const { store, seed } = harness();
          seed('a', ca);
          seed('b', cb);
          seed('c', cc);
          seed('x', cx);
          const [a, b, c, x] = ['a', 'b', 'c', 'x'].map((n) => store.segment(n)) as [
            ReturnType<CloudRoaring['segment']>,
            ReturnType<CloudRoaring['segment']>,
            ReturnType<CloudRoaring['segment']>,
            ReturnType<CloudRoaring['segment']>,
          ];
          const ob = new Set(cb);
          const oc = new Set(cc);
          const ox = new Set(cx);

          const want = [...new Set(ca)].filter((v) => ob.has(v) && oc.has(v)).sort((p, q) => p - q);
          expect(await collect(a.intersect([b, c], { concurrency }))).toEqual(want);
          expect(await collect(a.intersect([b, c], { exclude: [x], concurrency }))).toEqual(
            want.filter((v) => !ox.has(v)),
          );
        },
      ),
      { numRuns: 150 },
    );
  });
});
