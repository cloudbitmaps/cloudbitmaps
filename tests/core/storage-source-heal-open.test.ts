import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  CrbmStorageChunkSource,
  IntegrityError,
  eraseIdFromSegment,
  LocalFsStorageDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  createBackend,
} from '@/index';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import type { IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef } from '@/index';

const SEG: SegmentRef = { segment: 's' };

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-heal-open-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const freshStorage = (): LocalFsStorageDriver => new LocalFsStorageDriver(join(root, `d${n++}`));

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

describe('CrbmStorageChunkSource heals a generation swept before the reader opens', () => {
  it('getChunk does not surface NotFoundError when the resolved generation is gone by open time', async () => {
    const storage = freshStorage();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: inner,
      });
      await storage.delete({ ...SEG, generation: 0 });
    });

    const source = new CrbmStorageChunkSource(storage, { registry });
    const healed = await source.getChunk({ segment: 's', chunkKey: 0 });
    expect(healed).not.toBeNull();
    // Not merely "it did not throw": the bytes must be generation 1's, which holds the extra id.
    expect(SafeBitmap.safeDeserialize(healed!, 1 << 20).toArray()).toEqual([1, 2, 3]);
  });

  it('currentGeneration does not surface NotFoundError in the same race', async () => {
    const storage = freshStorage();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: inner,
      });
      await storage.delete({ ...SEG, generation: 0 });
    });

    const source = new CrbmStorageChunkSource(storage, { registry });
    await expect(source.currentGeneration(SEG)).resolves.toBe(1);
  });

  it('currentVersion, which the engine calls before every read, heals the same race', async () => {
    const storage = freshStorage();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: inner,
      });
      await storage.delete({ ...SEG, generation: 0 });
    });

    const source = new CrbmStorageChunkSource(storage, { registry });
    // Generation 1's version, of the one incarnation there is: `<generation>:<row token>`.
    await expect(source.currentVersion(SEG)).resolves.toMatch(/^1:/);
  });

  it('pinGeneration, which pin() makes, heals it too, and pins the generation current once the swept one is gone', async () => {
    const storage = freshStorage();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: inner,
      });
      await storage.delete({ ...SEG, generation: 0 });
    });

    const source = new CrbmStorageChunkSource(storage, { registry });
    await expect(source.pinGeneration(SEG)).resolves.toMatchObject({
      generation: 1,
      version: expect.stringMatching(/^1:/),
    });
  });

  it('so a cold has() racing a publish and a keep: 0 sweep answers, rather than failing the read', async () => {
    const storage = freshStorage();
    const inner = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry: inner });

    const registry = sweepingRegistry(inner, async () => {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [1, 2, 3], {
        registry: inner,
      });
      await storage.delete({ ...SEG, generation: 0 });
    });

    const store = new CloudRoaring({ storage: createBackend({ storage, registry }) });
    await expect(store.segment('s').has(3)).resolves.toBe(true); // generation 1 holds it
  });
});

/**
 * A driver + registry pair that counts the round trips a single call spends. The heal's doc-comment calls the
 * retry "bounded to exactly two resolve-and-open round trips", and that is a cost contract rather than a
 * detail: the retry re-reads the **registry**, the shared throttle-prone resource, and an N-way `intersect`
 * pays it per operand. Nothing gated it — raising the bound to 1,000 left all 1,483 tests green.
 */
function counting(storage: LocalFsStorageDriver, registry: MemoryRegistryDriver) {
  const calls = { regGet: 0, getTail: 0 };
  const countedStorage: IStorageDriver = {
    capabilities: () => storage.capabilities(),
    getTail: (k, m) => {
      calls.getTail++;
      return storage.getTail(k, m);
    },
    getRange: (k, o, l) => storage.getRange(k, o, l),
    delete: (k) => storage.delete(k),
    list: (ref) => storage.list(ref),
    putImmutable: (k, fn) => storage.putImmutable(k, fn),
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
  return { calls, storage: countedStorage, registry: countedRegistry };
}

/** The pointer names a generation whose object is gone for good — the forbidden `missing-storage-generation` state. */
async function tornSegment(): Promise<ReturnType<typeof counting>> {
  const storage = freshStorage();
  const registry = new MemoryRegistryDriver();
  await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry });
  await storage.delete({ ...SEG, generation: 0 });
  return counting(storage, registry);
}

describe('the heal is bounded to exactly two resolve-and-open round trips', () => {
  it('getChunk against a permanently absent generation: two attempts, then propagate', async () => {
    const c = await tornSegment();
    const source = new CrbmStorageChunkSource(c.storage, { registry: c.registry });
    await expect(source.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow(
      /no such generation/,
    );
    expect(c.calls).toEqual({ regGet: 2, getTail: 2 });
  });

  it('currentGeneration against a permanently absent generation: two attempts, then propagate', async () => {
    const c = await tornSegment();
    const source = new CrbmStorageChunkSource(c.storage, { registry: c.registry });
    await expect(source.currentGeneration(SEG)).rejects.toThrow(/no such generation/);
    expect(c.calls).toEqual({ regGet: 2, getTail: 2 });
  });

  it('currentVersion against a permanently absent generation: two attempts, then propagate', async () => {
    const c = await tornSegment();
    const source = new CrbmStorageChunkSource(c.storage, { registry: c.registry });
    await expect(source.currentVersion(SEG)).rejects.toThrow(/no such generation/);
    expect(c.calls).toEqual({ regGet: 2, getTail: 2 });
  });

  it('pinGeneration against a permanently absent generation: two attempts, then propagate', async () => {
    const c = await tornSegment();
    const source = new CrbmStorageChunkSource(c.storage, { registry: c.registry });
    await expect(source.pinGeneration(SEG)).rejects.toThrow(/no such generation/);
    expect(c.calls).toEqual({ regGet: 2, getTail: 2 });
  });

  it('an error that is NOT NotFound propagates on the first attempt, unretried', async () => {
    // The widened `try` now encloses the registry read and the reader open, so it could have swallowed faults
    // that have nothing to do with a swept generation. Only `NotFoundError` may be retried.
    const storage = freshStorage();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [1, 2], { registry });
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

    const source = new CrbmStorageChunkSource(storage, { registry: faulting });
    await expect(source.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow(
      'registry unavailable',
    );
    expect(regGet).toBe(1); // not 2: a generic fault is not a swept generation
    // And the version lookup every read begins with keeps to the same rule.
    const fresh = new CrbmStorageChunkSource(storage, { registry: faulting });
    await expect(fresh.currentVersion(SEG)).rejects.toThrow('registry unavailable');
    expect(regGet).toBe(2);
  });
});

describe("a generation's footer must name the generation it is stored as", () => {
  /** Generation `from`'s bytes written again under generation `to`, as a copy under the wrong key would be. */
  async function misfiled(from: number, to: number) {
    const storage = freshStorage();
    const registry = new MemoryRegistryDriver();
    for (let g = 0; g <= Math.max(from, to); g++) {
      if (g !== to) {
        await bulkLoadCrbmGeneration(storage, { ...SEG, generation: g }, [1, 2, g + 10], {
          registry,
        });
      }
    }
    const tail = await storage.getTail({ ...SEG, generation: from }, 1 << 20);
    await storage.putImmutable({ ...SEG, generation: to }, async (sink) => {
      await sink.write(tail.bytes);
    });
    await registry.compareAndSwap(SEG, (await registry.get(SEG))!.token, { currentGen: to });
    return { storage, registry };
  }

  it.each([
    [0, 1],
    [2, 1],
  ])(
    'refuses a read of generation %s stored as %s, whichever way they differ',
    async (from, to) => {
      const { storage, registry } = await misfiled(from, to);
      const source = new CrbmStorageChunkSource(storage, { registry });
      await expect(source.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow(IntegrityError);
      await expect(source.getChunk({ segment: 's', chunkKey: 0 })).rejects.toThrow(
        new RegExp(`generation ${to}: its footer says generation ${from}`),
      );
    },
  );

  it('refuses it on the write paths too: an erasure does not rewrite from a misfiled generation', async () => {
    const { storage, registry } = await misfiled(0, 1);
    await expect(
      eraseIdFromSegment(SEG, 1, { storage, registry, codec: roaringCodec }),
    ).rejects.toThrow(IntegrityError);
    expect((await registry.get(SEG))!.currentGen).toBe(1); // nothing was published
  });
});
