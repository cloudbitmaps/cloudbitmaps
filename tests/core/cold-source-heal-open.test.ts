import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CrbmColdChunkSource,
  LocalFsColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { IRegistryDriver, RegistryRecord, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-heal-open-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const freshCold = (): LocalFsColdDriver => new LocalFsColdDriver(join(root, `d${n++}`));

/**
 * A registry that answers "generation 0 is current" and, in the same breath, lets a publish + sweep land —
 * so the caller opens a generation that no longer exists. This is the gap between resolving `currentGen` and
 * opening its object: two backend round trips with a network hop between them, and `keep: 0` (what every id
 * erasure passes) makes the sweep land microseconds after the publish.
 */
function sweepingRegistry(
  inner: MemoryRegistryDriver,
  sweep: () => Promise<void>,
): IRegistryDriver {
  let armed = true;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
      return async (ref: SegmentRef): Promise<RegistryRecord | null> => {
        const rec = await inner.get(ref);
        if (armed && rec?.currentGen === 0) {
          armed = false;
          await sweep(); // gen 1 published and gen 0 deleted, while we are about to return "gen 0"
        }
        return rec;
      };
    },
  }) as unknown as IRegistryDriver;
}

describe('CrbmColdChunkSource heals a generation swept before the reader opens', () => {
  it('getChunk does not surface NotFoundError when the resolved generation is gone by open time', async () => {
    const cold = freshCold();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3], { registry: inner });
      await cold.delete({ ...SEG, generation: 0 });
    });

    const source = new CrbmColdChunkSource(cold, { registry });
    await expect(source.getChunk({ segment: 's', chunkKey: 0 })).resolves.not.toBeNull();
  });

  it('currentGeneration does not surface NotFoundError in the same race', async () => {
    const cold = freshCold();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 1 }, [1, 2, 3], { registry: inner });
      await cold.delete({ ...SEG, generation: 0 });
    });

    const source = new CrbmColdChunkSource(cold, { registry });
    await expect(source.currentGeneration(SEG)).resolves.toBe(1);
  });
});
