import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  MemoryWarmDriver,
  LocalFsColdDriver,
  LocalFsWarmDriver,
  CrbmColdChunkSource,
  writeCrbmGeneration,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { splitId } from '@/core/bit-route';

/**
 * End-to-end: the Phase-1 engine reading a real on-disk `.crbm` Cold generation through
 * `CrbmColdChunkSource` → `LocalFsColdDriver`, with live Warm tombstones merged over it. Exercises the
 * whole 2b stack and proves the engine is unchanged — it just has a persistent Cold tier now.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-e2e-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seededStore(ids: number[]): Promise<CloudRoaring> {
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
  return new CloudRoaring({ warm: new MemoryWarmDriver(), cold: new CrbmColdChunkSource(cold) });
}

async function members(seg: ReturnType<CloudRoaring['segment']>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of seg.iterate()) out.push(id);
  return out;
}

describe('engine over LocalFs cold (.crbm)', () => {
  it('reads a cold-only segment across multiple chunks', async () => {
    const ids = [1, 2, 3, 70_000, 0xffff_ffff];
    const seg = (await seededStore(ids)).segment('seg');
    expect(await seg.count()).toBe(5);
    expect(await members(seg)).toEqual([...ids].sort((a, b) => a - b));
    expect(await seg.has(70_000)).toBe(true);
    expect(await seg.has(42)).toBe(false);
  });

  it('is consistent under the HOT cache: a store pins its generation, a fresh store sees the newer one', async () => {
    // Regression for the cache-staleness hazard: the engine caches decoded Cold chunks without a
    // generation, so the cold source MUST present an immutable (pinned) view per store lifetime.
    const cold = new LocalFsColdDriver(root);
    await writeCrbmGeneration(cold, { segment: 'seg', generation: 1 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1]) },
    ]);
    const store1 = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(cold),
    });
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
    const seg2 = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(cold),
    }).segment('seg');
    expect(await seg2.has(70_000)).toBe(true);
  });

  it('persists engine writes across instances (LocalFs Warm + Cold on disk)', async () => {
    const cold = new LocalFsColdDriver(root);
    await writeCrbmGeneration(cold, { segment: 'seg', generation: 1 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
    ]);
    const fresh = (): ReturnType<CloudRoaring['segment']> =>
      new CloudRoaring({
        warm: new LocalFsWarmDriver(root),
        cold: new CrbmColdChunkSource(cold),
      }).segment('seg');

    const seg = fresh();
    await seg.add(100); // Warm-only add
    await seg.remove(2); // tombstone a cold member

    // A brand-new engine over the same on-disk dirs sees the persisted Warm state merged with Cold.
    const reopened = fresh();
    expect(await reopened.has(100)).toBe(true);
    expect(await reopened.has(2)).toBe(false);
    expect(await reopened.count()).toBe(3); // {1, 3, 100}
    expect(await members(reopened)).toEqual([1, 3, 100]);
  });

  it('converges under concurrent engine writes to the same chunk (OCC retry, no lost update)', async () => {
    const store = new CloudRoaring({
      warm: new LocalFsWarmDriver(root),
      cold: new CrbmColdChunkSource(new LocalFsColdDriver(root)),
    });
    const seg = store.segment('seg');
    // 10 ids in the same chunk (chunkKey 0) added concurrently → the engine's bounded OCC retry loop
    // over the persistent Warm driver must serialize them with no lost update.
    const ids = Array.from({ length: 10 }, (_v, i) => i + 1);
    await Promise.all(ids.map((id) => seg.add(id)));
    expect(await seg.count()).toBe(10);
    expect(await members(seg)).toEqual(ids);
  });

  it('merges live Warm tombstones over the on-disk Cold tier', async () => {
    const seg = (await seededStore([1, 2, 3])).segment('seg');
    await seg.remove(2); // tombstone a cold member
    await seg.add(100); // add a brand-new id (Warm only)

    expect(await seg.has(2)).toBe(false);
    expect(await seg.has(1)).toBe(true);
    expect(await seg.has(100)).toBe(true);
    expect(await seg.count()).toBe(3); // {1, 3, 100}
    expect(await members(seg)).toEqual([1, 3, 100]);
  });
});
