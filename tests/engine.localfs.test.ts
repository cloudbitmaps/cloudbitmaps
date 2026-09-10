import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
  CrbmColdChunkSource,
  bulkLoadCrbmGeneration,
  writeCrbmGeneration,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { splitId } from '@/core/bit-route';
import { collect } from './helpers/loaded';

/**
 * End-to-end: the engine reading a real on-disk `.crbm` generation through `CrbmColdChunkSource` →
 * `LocalFsColdDriver`, with the registry pointer on disk too. Exercises the whole persistent stack and proves
 * the engine is unchanged — it just has a persistent cold tier and a persistent pointer now.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-e2e-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One `.crbm` generation on disk, written the pre-grouped way, read through a generation-pinning source. */
async function loadedFsStore(ids: number[]): Promise<CloudRoaring> {
  const cold = new LocalFsColdDriver(root);
  // Group ids into per-chunk bitmaps and write one Cold generation.
  const byChunk = new Map<number, SafeBitmap>();
  for (const id of ids) {
    const { chunkKey, remainder } = splitId(id);
    let bitmap = byChunk.get(chunkKey);
    if (bitmap === undefined) {
      bitmap = SafeBitmap.empty();
      byChunk.set(chunkKey, bitmap);
    }
    bitmap.add(remainder);
  }
  await writeCrbmGeneration(
    cold,
    { segment: 'seg', generation: 1 },
    [...byChunk].map(([chunkKey, bitmap]) => ({ chunkKey, bitmap })),
  );
  return new CloudRoaring({ cold: new CrbmColdChunkSource(cold) });
}

describe('engine over LocalFs cold (.crbm)', () => {
  it('reads a loaded segment across multiple chunks', async () => {
    const ids = [1, 2, 3, 70_000, 0xffff_ffff];
    const seg = (await loadedFsStore(ids)).segment('seg');
    expect(await seg.count()).toBe(5);
    expect(await collect(seg.iterate())).toEqual([...ids].sort((a, b) => a - b));
    expect(await seg.has(70_000)).toBe(true);
    expect(await seg.has(42)).toBe(false);
  });

  it('is consistent under the HOT cache: a store pins its generation, a fresh store sees the newer one', async () => {
    // Regression for the cache-staleness hazard: the engine caches decoded Cold chunks keyed by generation,
    // so the cold source MUST present an immutable (pinned) view for as long as its snapshot is pinned.
    const cold = new LocalFsColdDriver(root);
    await writeCrbmGeneration(cold, { segment: 'seg', generation: 1 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) },
    ]);
    const store1 = new CloudRoaring({ cold: new CrbmColdChunkSource(cold) });
    const seg1 = store1.segment('seg');
    expect(await seg1.has(1)).toBe(true); // touches chunk 0 only

    // A newer generation adds id 70_000, which lives in a *different* chunk (chunkKey 1) that store1 has
    // never read — so the engine's HOT cache cannot mask a pinning regression here.
    await writeCrbmGeneration(cold, { segment: 'seg', generation: 2 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) },
      { chunkKey: 1, bitmap: SafeBitmap.fromValues([70_000 & 0xffff]) },
    ]);
    // store1 is pinned to gen 1: chunk 1 doesn't exist there, so the new id is absent. If the source
    // re-resolved to gen 2, this would wrongly be true → the assertion guards the pin.
    expect(await seg1.has(70_000)).toBe(false);
    // A fresh store reads gen 2 and sees it.
    const seg2 = new CloudRoaring({ cold: new CrbmColdChunkSource(cold) }).segment('seg');
    expect(await seg2.has(70_000)).toBe(true);
  });

  it('a published generation persists across store instances (cold + registry both on disk)', async () => {
    // The production wiring: raw driver + registry, so the store wraps its own `.crbm` source and resolves
    // `currentGen` from the on-disk pointer rather than a directory scan.
    const cold = new LocalFsColdDriver(root);
    const registry = new LocalFsRegistryDriver(root);
    const fresh = (): CloudRoaring => new CloudRoaring({ cold, registry });

    await bulkLoadCrbmGeneration(cold, { segment: 'seg', generation: 0 }, [1, 2, 3, 100], {
      registry,
    });

    // A brand-new store over the same directories sees the published generation — nothing is held in RAM.
    const reopened = fresh().segment('seg');
    expect(await reopened.count()).toBe(4);
    expect(await collect(reopened.iterate())).toEqual([1, 2, 3, 100]);
    expect(await reopened.has(2)).toBe(true);
  });

  it('a second load supersedes the first on disk — a fresh store reads only the new generation', async () => {
    const cold = new LocalFsColdDriver(root);
    const registry = new LocalFsRegistryDriver(root);
    await bulkLoadCrbmGeneration(cold, { segment: 'seg', generation: 0 }, [1, 2, 3], { registry });
    // Generation 1 drops id 2 and adds id 70_000 (a different chunk, so no cached chunk can mask it).
    await bulkLoadCrbmGeneration(cold, { segment: 'seg', generation: 1 }, [1, 3, 70_000], {
      registry,
    });

    const seg = new CloudRoaring({ cold, registry }).segment('seg');
    expect(await collect(seg.iterate())).toEqual([1, 3, 70_000]);
    expect(await seg.has(2)).toBe(false); // superseded, not merged: a load replaces the set
    expect(await seg.count()).toBe(3);
  });
});
