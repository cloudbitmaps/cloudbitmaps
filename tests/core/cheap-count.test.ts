import {
  CountingMetricsSink,
  CrbmStorageChunkSource,
  MemoryStorageDriver,
  writeCrbmGeneration,
  SafeBitmap,
  type Clock,
  type StorageChunkSource,
} from '@/index';
import { joinId } from '@/core/bit-route';
import { collect, loadedStore, seededStore } from '../helpers/loaded';

/**
 * Cheap count: `count()` sums per-chunk cardinality straight from the `.crbm` index — zero payload reads on a
 * loaded segment, whatever its size. A Storage source with no index (the in-memory source) falls back to fetching
 * every chunk, still correct.
 */

function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

const IDS = [joinId(0, 1), joinId(0, 2), joinId(0, 3), joinId(5, 10), joinId(5, 20), joinId(5, 30)];

describe('cheap count', () => {
  it('a loaded segment counts from the .crbm index with zero payload reads', async () => {
    const metrics = new CountingMetricsSink();
    const { store } = await loadedStore({ s: IDS }, { metrics });
    const n = await store.segment('s').count();
    const snap = metrics.snapshot();
    expect(n).toBe(6); // 3 + 3, summed from the index
    expect(snap.storage.gets).toBe(0); // the headline: counting fetched nothing
    expect(snap.ops.count.count).toBe(1);
  });

  it('a reload changes the count — still with zero payload reads', async () => {
    const clock = fakeClock();
    const metrics = new CountingMetricsSink();
    const { store, load } = await loadedStore(
      { s: IDS },
      {
        metrics,
        cache: { genTtlMs: 1 },
        seams: { clock },
      },
    );
    const seg = store.segment('s');
    expect(await seg.count()).toBe(6);

    await load('s', [joinId(0, 1), joinId(7, 5)]); // generation 1: a smaller set, one new chunk
    clock.advance(1);
    expect(await seg.count()).toBe(2);
    expect(metrics.snapshot().storage.gets).toBe(0); // the new generation's index, not its payloads
  });

  it('a segment with no generation counts 0 with zero reads', async () => {
    const metrics = new CountingMetricsSink();
    const { store } = await loadedStore({}, { metrics });
    expect(await store.segment('never-loaded').count()).toBe(0);
    expect(metrics.snapshot().storage.gets).toBe(0);
  });

  it('count() equals iterate() length (oracle cross-check)', async () => {
    const { store } = await loadedStore({ s: [...IDS, joinId(2, 7), joinId(2, 8), joinId(9, 1)] });
    const seg = store.segment('s');
    expect(await seg.count()).toBe((await collect(seg.iterate())).length);
  });

  it('falls back correctly for a Storage source without the cardinality capability', async () => {
    const metrics = new CountingMetricsSink();
    // The in-memory source has no `.crbm` index → no cardinalities(); count() fetches every chunk instead.
    const { store, storage } = seededStore(
      { s: [joinId(0, 1), joinId(0, 2), joinId(0, 3), joinId(2, 9)] },
      {
        metrics,
      },
    );
    expect((storage as StorageChunkSource).cardinalities).toBeUndefined();
    expect(await store.segment('s').count()).toBe(4);
    expect(metrics.snapshot().storage.gets).toBe(2); // one fetch per chunk on the fallback path
  });

  it('CrbmStorageChunkSource.cardinalities reflects the index, and is null with no generation', async () => {
    const driver = new MemoryStorageDriver();
    const storage = new CrbmStorageChunkSource(driver);
    expect(await storage.cardinalities({ segment: 'missing' })).toBeNull();
    await writeCrbmGeneration(driver, { segment: 's', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
      { chunkKey: 5, bitmap: SafeBitmap.fromValues([10, 20]) },
    ]);
    const cards = await storage.cardinalities({ segment: 's' });
    expect(cards).not.toBeNull();
    expect(cards!.get(0)).toBe(3);
    expect(cards!.get(5)).toBe(2);
    expect([...cards!.keys()].sort((a, b) => a - b)).toEqual([0, 5]);
  });
});
