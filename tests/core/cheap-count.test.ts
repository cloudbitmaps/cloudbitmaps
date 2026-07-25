import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryWarmDriver,
  MemoryColdDriver,
  MemoryColdChunkSource,
  CrbmColdChunkSource,
  writeCrbmGeneration,
  SafeBitmap,
  type ColdChunkSource,
} from '@/index';
import { joinId } from '@/core/bit-route';

/**
 * Cheap count (Phase 5c PR-2): `count()` sums per-chunk cardinality straight from the `.crbm` index for
 * warm-delta-free chunks — zero payload reads — and merges only the dirty (Warm-delta) chunks. A Cold source
 * with no index (the in-memory source) falls back to fetching + merging every chunk, still correct.
 */

async function drain(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
}

/** A store over a real `.crbm` (MemoryColdDriver + CrbmColdChunkSource) seeded with per-chunk remainders. */
async function crbmStore(
  segment: string,
  chunks: { chunkKey: number; remainders: number[] }[],
): Promise<{ store: CloudRoaring; metrics: CountingMetricsSink }> {
  const driver = new MemoryColdDriver();
  await writeCrbmGeneration(
    driver,
    { segment, generation: 0 },
    chunks.map((c) => ({ chunkKey: c.chunkKey, bitmap: SafeBitmap.fromValues(c.remainders) })),
  );
  const metrics = new CountingMetricsSink();
  const store = new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: new CrbmColdChunkSource(driver),
    metrics,
  });
  return { store, metrics };
}

describe('cheap count (Phase 5c PR-2)', () => {
  it('a warm-delta-free segment counts from the index with zero payload reads', async () => {
    const { store, metrics } = await crbmStore('s', [
      { chunkKey: 0, remainders: [1, 2, 3] },
      { chunkKey: 5, remainders: [10, 20, 30, 40] },
    ]);
    const n = await store.segment('s').count();
    const snap = metrics.snapshot();
    expect(n).toBe(7); // 3 + 4, summed from the index
    expect(snap.cold.gets).toBe(0); // the headline: counting fetched nothing
  });

  it('a Warm add on one chunk fetches only that chunk; clean chunks still come from the index', async () => {
    const { store, metrics } = await crbmStore('s', [
      { chunkKey: 0, remainders: [1, 2, 3] },
      { chunkKey: 5, remainders: [10, 20] },
    ]);
    const seg = store.segment('s');
    await seg.add(joinId(0, 99)); // a new id in chunk 0 → chunk 0 is now dirty
    metrics.reset();
    const n = await seg.count();
    expect(n).toBe(6); // (3 + 1) + 2
    expect(metrics.snapshot().cold.gets).toBe(1); // only the dirty chunk 0 fetched
  });

  it('a Warm add of an id already in Cold does not double-count (merge dedups)', async () => {
    const { store } = await crbmStore('s', [{ chunkKey: 0, remainders: [1, 2, 3] }]);
    const seg = store.segment('s');
    await seg.add(joinId(0, 2)); // already present in Cold
    expect(await seg.count()).toBe(3);
  });

  it('a Warm remove (tombstone) lowers the count and merges only that chunk', async () => {
    const { store, metrics } = await crbmStore('s', [
      { chunkKey: 0, remainders: [1, 2, 3] },
      { chunkKey: 5, remainders: [10, 20] },
    ]);
    const seg = store.segment('s');
    await seg.remove(joinId(0, 1)); // remove an id present in Cold chunk 0
    metrics.reset();
    const n = await seg.count();
    expect(n).toBe(4); // (3 - 1) + 2
    expect(metrics.snapshot().cold.gets).toBe(1);
  });

  it('counts a Warm-only chunk (no Cold generation for it) alongside clean Cold chunks', async () => {
    const { store } = await crbmStore('s', [
      { chunkKey: 0, remainders: [1, 2, 3] },
      { chunkKey: 5, remainders: [10, 20] },
    ]);
    const seg = store.segment('s');
    await seg.add(joinId(7, 5)); // chunk 7 exists only in Warm
    expect(await seg.count()).toBe(6); // 3 + 2 + 1
  });

  it('count() equals iterate() length across mixed tiers (oracle cross-check)', async () => {
    const { store } = await crbmStore('s', [
      { chunkKey: 0, remainders: [1, 2, 3] },
      { chunkKey: 2, remainders: [7, 8] },
    ]);
    const seg = store.segment('s');
    await seg.add(joinId(0, 50));
    await seg.remove(joinId(2, 7));
    await seg.add(joinId(9, 1));
    expect(await seg.count()).toBe((await drain(seg.iterate())).length);
  });

  it('falls back correctly for a Cold source without the cardinality capability', async () => {
    const cold = new MemoryColdChunkSource(); // no `.crbm` index → no cardinalities()
    expect((cold as ColdChunkSource).cardinalities).toBeUndefined();
    cold.seed({ segment: 's', chunkKey: 0 }, SafeBitmap.fromValues([1, 2, 3]).serialize());
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    const seg = store.segment('s');
    await seg.add(joinId(0, 9));
    expect(await seg.count()).toBe(4); // 3 + 1, via the fetch-and-merge fallback
  });

  it('CrbmColdChunkSource.cardinalities reflects the index, and is null with no generation', async () => {
    const driver = new MemoryColdDriver();
    const cold = new CrbmColdChunkSource(driver);
    expect(await cold.cardinalities({ segment: 'missing' })).toBeNull();
    await writeCrbmGeneration(driver, { segment: 's', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
      { chunkKey: 5, bitmap: SafeBitmap.fromValues([10, 20]) },
    ]);
    const cards = await cold.cardinalities({ segment: 's' });
    expect(cards).not.toBeNull();
    expect(cards!.get(0)).toBe(3);
    expect(cards!.get(5)).toBe(2);
    expect([...cards!.keys()].sort((a, b) => a - b)).toEqual([0, 5]);
  });
});
