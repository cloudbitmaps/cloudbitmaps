import { openGenerationReader } from '@/core/crbm-open';
import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';
import { testEntropy } from '../helpers/entropy';
import { setSegmentRetention } from '@/core/retention';

/**
 * An erasure that found the id refuses every load that read the row before it began, whichever generation held it.
 *
 *   load L     reads the row (pointer P, token T) ............................ writes its object, CAS on T
 *   erasure                       begins, searches, collects, answers erased: true
 *
 * When the only holder is an object below the pointer that the row's ledger never named (a crashed load's object),
 * the erasure owes the ledger no prune, yet it still renews the row's token, so the load's swap on T is refused and
 * the id it carries from its own input is not published. Cases A and B are that; C and D are the two paths that
 * already wrote the row (a holder above the pointer, a holder the ledger names), and E counts the registry writes.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The storage, with each object write held until `mayWrite` resolves. */
function heldWrites(storage: IStorageDriver, mayWrite: Promise<void>): IStorageDriver {
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'putImmutable') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        await mayWrite;
        return await (fn.apply(t, a) as Promise<unknown>);
      };
    },
  });
}

/** The registry, telling `read` once its first row read has answered. */
function firstRead(registry: IRegistryDriver, read: () => void): IRegistryDriver {
  let first = true;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'get') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const row = await (fn.apply(t, a) as Promise<unknown>);
        if (first) {
          first = false;
          read();
        }
        return row;
      };
    },
  });
}

/** The storage, deleting `generation` from the bucket right after the first read of its chunks: a racing collector. */
function collectedAfterRead(storage: IStorageDriver, generation: number): IStorageDriver {
  let done = false;
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'getRange') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const out = await (fn.apply(t, a) as Promise<unknown>);
        if (!done && (a[0] as { generation: number }).generation === generation) {
          done = true;
          await storage.delete({ ...SEG, generation });
        }
        return out;
      };
    },
  });
}

/** The registry, running `act` once, right after the `nth` read answers: another writer landing mid-call. */
function afterRead(
  registry: IRegistryDriver,
  nth: number,
  act: () => Promise<void>,
): IRegistryDriver {
  let n = 0;
  return new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (p !== 'get') return (...a: unknown[]) => fn.apply(t, a);
      return async (...a: unknown[]) => {
        const row = await (fn.apply(t, a) as Promise<unknown>);
        n += 1;
        if (n === nth) await act();
        return row;
      };
    },
  });
}

/** The ids of the generation the row names (cleartext), or `null` with no pointer or no object. */
async function served(
  storage: IStorageDriver,
  registry: IRegistryDriver,
): Promise<number[] | null> {
  const row = await registry.get(SEG);
  if (row === null || row.currentGen === null) return null;
  let reader: Awaited<ReturnType<typeof openGenerationReader>>;
  try {
    reader = await openGenerationReader(storage, { ...SEG, generation: row.currentGen }, undefined);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray())
      out.push((chunkKey << 16) + r);
  }
  return out.sort((a, b) => a - b);
}

/**
 * A load of `ids` that reads the row, then the erasure of `id` runs to its answer, then the load's object write goes
 * through. Returns what each answered and what the row serves after.
 */
async function race(
  storage: MemoryStorageDriver,
  registry: MemoryRegistryDriver,
  ids: number[],
  id: number,
  eraseStorage: IStorageDriver = storage,
  eraseRegistry: IRegistryDriver = registry,
) {
  const readRow = deferred();
  const mayWrite = deferred();
  const load = loadSegment(SEG, ids, {
    storage: heldWrites(storage, mayWrite.promise),
    registry: firstRead(registry, readRow.resolve),
    entropy: testEntropy,
    codec: roaringCodec,
  });
  await readRow.promise; // the load has read the row: the erasure begins after every load's read
  const erased = await eraseIdFromSegment(SEG, id, {
    storage: eraseStorage,
    registry: eraseRegistry,
    entropy: testEntropy,
    codec: roaringCodec,
  });
  mayWrite.resolve(); // the load's object lands after the erasure's last look at the bucket
  const loaded = await load;
  return { erased, loaded, served: await served(storage, registry) };
}

describe('an erasure that answers erased: true, and a load that read the row before it began', () => {
  it('A: the only holder is an object below the pointer the ledger never named, which the erasure collects', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7], {
      registry,
      publish: false,
    }); // crashed
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [5], { registry }); // pointer 1, ledger [1]
    const before = (await registry.get(SEG))!;
    expect(before.currentGen).toBe(1);
    expect(before.knownGens?.map((e) => e.generation)).toEqual([1]);

    const { erased, loaded, served: ids } = await race(storage, registry, [7, 5, 3, 4], 7);
    expect(erased).toMatchObject({ erased: true, fromGeneration: 0, collected: [0] });
    expect(loaded).toMatchObject({ published: false, reason: 'superseded' });
    expect(ids).toEqual([5]);
  });

  it('B: as the property run had it, a racing collector takes that holder after the erasure read it', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7], {
      registry,
      publish: false,
    });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [5], { registry });

    const {
      erased,
      loaded,
      served: ids,
    } = await race(storage, registry, [7, 5, 3, 4], 7, collectedAfterRead(storage, 0));
    expect(erased).toMatchObject({ erased: true, fromGeneration: 0, collected: [] });
    expect(loaded).toMatchObject({ published: false, reason: 'superseded' });
    expect(ids).toEqual([5]);
  });

  it('C (control): a holder above the pointer is deleted under a renewal, which refuses the load', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [5], { registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [7], {
      registry,
      publish: false,
    });

    const { erased, loaded, served: ids } = await race(storage, registry, [7, 5, 3, 4], 7);
    expect(erased).toMatchObject({ erased: true, collected: [1] });
    expect(loaded).toMatchObject({ published: false, reason: 'superseded' });
    expect(ids).toEqual([5]);
  });

  it('D (control): a holder below the pointer that the ledger names is pruned by a write, which refuses the load', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7], { registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [5], { registry });
    expect((await registry.get(SEG))!.knownGens?.map((e) => e.generation)).toEqual([0, 1]);

    const { erased, loaded, served: ids } = await race(storage, registry, [7, 5, 3, 4], 7);
    expect(erased).toMatchObject({ erased: true, collected: [0] });
    expect(loaded).toMatchObject({ published: false, reason: 'superseded' });
    expect(ids).toEqual([5]);
  });

  it('E: the renewal is the one registry write the erasure adds on the path that owed none', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7], {
      registry,
      publish: false,
    });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [5], { registry });
    const counts: Record<string, number> = {};
    const before = (await registry.get(SEG))!;

    await eraseIdFromSegment(SEG, 7, {
      storage,
      registry: counting(registry, counts),
      entropy: testEntropy,
      codec: roaringCodec,
    });

    const after = (await registry.get(SEG))!;
    expect(counts.compareAndSwap).toBe(1);
    expect(after.currentGen).toBe(before.currentGen);
    expect(after.pointerId).not.toBe(before.pointerId);
    expect(after.knownGens).toEqual(before.knownGens);
  });

  it('F: another writer changed a field but the leases since the call began, which refuses the load; the erasure adds no write', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [7], {
      registry,
      publish: false,
    });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [5], { registry });
    const counts: Record<string, number> = {};
    // A write of the row's retention lands after the erasure read the row: not a lease, so it moves the token.
    const mid = afterRead(counting(registry, counts), 1, async () => {
      await setSegmentRetention(SEG, { registry }, { expiresAt: Date.now() + 86_400_000 });
    });

    const {
      erased,
      loaded,
      served: ids,
    } = await race(storage, registry, [7, 5, 3, 4], 7, storage, mid);
    expect(erased).toMatchObject({ erased: true, fromGeneration: 0 });
    expect(loaded).toMatchObject({ published: false, reason: 'superseded' });
    expect(ids).toEqual([5]);
    expect(counts.compareAndSwap ?? 0).toBe(0);
  });

  it('G: a load moved the pointer past the holder since the call began, which refuses the load; the erasure adds no write', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, [5], { registry });
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, [7], {
      registry,
      publish: false,
    });
    const counts: Record<string, number> = {};
    // Another writer publishes generation 2, above the holder, after the erasure read the row: the pointer passes it.
    const mid = afterRead(counting(registry, counts), 1, async () => {
      await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 2 }, [5, 6], { registry });
    });

    const {
      erased,
      loaded,
      served: ids,
    } = await race(storage, registry, [7, 5, 3, 4], 7, storage, mid);
    expect(erased).toMatchObject({ erased: true });
    expect(loaded).toMatchObject({ published: false, reason: 'superseded' });
    expect(ids).toEqual([5, 6]);
    expect(counts.compareAndSwap ?? 0).toBe(0);
  });
});
