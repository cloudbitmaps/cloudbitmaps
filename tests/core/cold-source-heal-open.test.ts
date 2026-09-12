import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CrbmColdChunkSource,
  LocalFsColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import type { IColdDriver, IRegistryDriver, RegistryRecord, SegmentRef } from '@/index';

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
    const healed = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(healed).not.toBeNull();
    // Not merely "it did not throw": the bytes must be generation 1's, which holds the extra id.
    expect(SafeBitmap.safeDeserialize(healed!, 1 << 20).toArray()).toEqual([1, 2, 3]);
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

/**
 * A driver + registry pair that counts the round trips a single call spends. The heal's doc-comment calls the
 * retry "bounded to exactly two resolve-and-open round trips", and that is a cost contract rather than a
 * detail: the retry re-reads the **registry**, the shared throttle-prone resource, and an N-way `intersect`
 * pays it per operand. Nothing gated it — raising the bound to 1,000 left all 1,483 tests green.
 */
function counting(cold: LocalFsColdDriver, registry: MemoryRegistryDriver) {
  const calls = { regGet: 0, getTail: 0 };
  const countedCold: IColdDriver = {
    capabilities: () => cold.capabilities(),
    getTail: (k, m) => {
      calls.getTail++;
      return cold.getTail(k, m);
    },
    getRange: (k, o, l) => cold.getRange(k, o, l),
    delete: (k) => cold.delete(k),
    list: (ref) => cold.list(ref),
    putImmutable: (k, fn) => cold.putImmutable(k, fn),
  };
  const countedRegistry = new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
      return async (ref: SegmentRef): Promise<RegistryRecord | null> => {
        calls.regGet++;
        return registry.get(ref);
      };
    },
  }) as unknown as IRegistryDriver;
  return { calls, cold: countedCold, registry: countedRegistry };
}

/** The pointer names a generation whose object is gone for good — the forbidden `missing-cold-generation` state. */
async function tornSegment(): Promise<ReturnType<typeof counting>> {
  const cold = freshCold();
  const registry = new MemoryRegistryDriver();
  await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2], { registry });
  await cold.delete({ ...SEG, generation: 0 });
  return counting(cold, registry);
}

describe('the heal is bounded to exactly two resolve-and-open round trips', () => {
  it('getChunk against a permanently absent generation: two attempts, then propagate', async () => {
    const c = await tornSegment();
    const source = new CrbmColdChunkSource(c.cold, { registry: c.registry });
    await expect(source.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow(
      /no such generation/,
    );
    expect(c.calls).toEqual({ regGet: 2, getTail: 2 });
  });

  it('currentGeneration against a permanently absent generation: two attempts, then propagate', async () => {
    const c = await tornSegment();
    const source = new CrbmColdChunkSource(c.cold, { registry: c.registry });
    await expect(source.currentGeneration(SEG)).rejects.toThrow(/no such generation/);
    expect(c.calls).toEqual({ regGet: 2, getTail: 2 });
  });

  it('an error that is NOT NotFound propagates on the first attempt, unretried', async () => {
    // The widened `try` now encloses the registry read and the reader open, so it could have swallowed faults
    // that have nothing to do with a swept generation. Only `NotFoundError` may be retried.
    const cold = freshCold();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1, 2], { registry });
    let regGet = 0;
    const faulting = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
        return async (): Promise<RegistryRecord | null> => {
          regGet++;
          throw new Error('registry unavailable');
        };
      },
    }) as unknown as IRegistryDriver;

    const source = new CrbmColdChunkSource(cold, { registry: faulting });
    await expect(source.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow(
      'registry unavailable',
    );
    expect(regGet).toBe(1); // not 2: a generic fault is not a swept generation
  });
});
