import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  LocalFsColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  publishGeneration,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import type { GenKey, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-reg-cold-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const freshCold = (): LocalFsColdDriver => new LocalFsColdDriver(join(root, `d${n++}`));
const count = (source: CrbmColdChunkSource): Promise<number> =>
  new CloudRoaring({ warm: new MemoryWarmDriver(), cold: source }).segment('s').count();

describe('registry-aware CrbmColdChunkSource (Phase 4c)', () => {
  it('resolves currentGen via the registry (no list-scan) and bulk-load publishes it', async () => {
    const cold = freshCold();
    const registry = new MemoryRegistryDriver();
    // bulk-load gen 0 AND publish it to the registry in one call.
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], { registry });

    expect((await registry.get(SEG))!.currentGen).toBe(0);
    const source = new CrbmColdChunkSource(cold, { registry });
    expect(await count(source)).toBe(3);
  });

  it('a registry-aware source returns empty when there is no registry row', async () => {
    const cold = freshCold();
    // A generation exists on disk, but the registry has no row → registry-aware source reads it as empty
    // (the registry is authoritative; nothing has published a currentGen).
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3]); // no registry passed
    const source = new CrbmColdChunkSource(cold, { registry: new MemoryRegistryDriver() });
    expect(await count(source)).toBe(0);
  });

  it('falls back to the list-scan when no registry is provided', async () => {
    const cold = freshCold();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3]);
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);
    const source = new CrbmColdChunkSource(cold); // no registry → max-generation list-scan
    expect(await count(source)).toBe(5); // highest generation
  });

  it('serves the registry-pinned generation even if a higher one exists on disk', async () => {
    const cold = freshCold();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2, 3], { registry });
    // Write a newer generation on disk but DON'T publish it — registry-aware reads stay on gen 0.
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3, 4, 5]);
    expect(await count(new CrbmColdChunkSource(cold, { registry }))).toBe(3); // pinned to published gen 0
    // Now publish gen 1; a FRESH source picks it up (pinned per source lifetime).
    await publishGeneration(registry, { ...SEG, generation: 1 });
    expect(await count(new CrbmColdChunkSource(cold, { registry }))).toBe(5);
  });

  it('publishGeneration is forward-only (a stale publish never regresses currentGen)', async () => {
    const registry = new MemoryRegistryDriver();
    const gen = (g: number): GenKey => ({ ...SEG, generation: g });
    await publishGeneration(registry, gen(2));
    expect((await registry.get(SEG))!.currentGen).toBe(2);
    await publishGeneration(registry, gen(1)); // older — must be a no-op
    expect((await registry.get(SEG))!.currentGen).toBe(2);

    // Equal re-publish is a TRUE no-op — no write occurs (token unchanged), guarding the `>=` boundary.
    const before = (await registry.get(SEG))!.token;
    await publishGeneration(registry, gen(2));
    expect((await registry.get(SEG))!.token).toBe(before);

    await publishGeneration(registry, gen(5)); // newer — advances
    expect((await registry.get(SEG))!.currentGen).toBe(5);
  });

  it('self-heals when GC sweeps the exact generation a reader pinned mid-read (I5, no torn read)', async () => {
    const cold = freshCold();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2], { registry });

    // A long-lived source pins gen 0 (resolved on first read).
    const source = new CrbmColdChunkSource(cold, { registry });
    const first = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(first!, 1 << 20).toArray()).toEqual([1, 2]);

    // A compaction commits gen 1 and GC sweeps gen 0 — the exact object this source still points at.
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3], { registry });
    await cold.delete({ ...SEG, generation: 0 });

    // The next read against the (now-vanished) pinned gen 0 must NOT throw: it re-resolves to gen 1.
    const healed = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(SafeBitmap.safeDeserialize(healed!, 1 << 20).toArray()).toEqual([1, 2, 3]);
    expect((await source.listChunkKeys({ segment: 's' })).sort((a, b) => a - b)).toEqual([0]);
  });
});
