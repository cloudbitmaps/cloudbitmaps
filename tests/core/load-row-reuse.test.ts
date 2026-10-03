import { randomBytes } from 'node:crypto';
import { loadSegment, type LoadOptions } from '@/core/load';
import { openGenerationReader, publishGeneration } from '@/core/crbm-storage-source';
import { aadFor } from '@/core/crypto';
import { destroySegment, dropSegment } from '@/core/erasure';
import { KeyUnavailableError, TransientError, ValidationError } from '@/core/errors';
import { setSegmentRetention } from '@/core/retention';
import { rollbackSegment } from '@/core/rollback';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * A load reads the segment's row once and decides everything from that read: the guard's "before", the number it
 * takes, the write's destroyed check and DEK, and the publish's first attempt. These pin that each fence on that
 * row still refuses what it refused when the row was read again later: whatever lands after the load's one read
 * (here, while its ids are still streaming) makes the publish lose, and the load reports it rather than landing
 * on a stale read.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}

async function idsOf(storage: IStorageDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(storage, { ...SEG, generation }, undefined);
  const out: number[] = [];
  for (const chunkKey of reader.chunkKeys()) {
    const bytes = await reader.getChunk(chunkKey);
    if (bytes === null) continue;
    for (const r of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray()) {
      out.push((chunkKey << 16) + r);
    }
  }
  return out.sort((a, b) => a - b);
}

async function generations(storage: IStorageDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const k of storage.list(SEG)) out.push(k.generation);
  return out.sort((a, b) => a - b);
}

/** `ids`, with `meanwhile` run after the first one: after the load read its row, before it writes and publishes. */
async function* streaming(ids: number[], meanwhile: () => Promise<void>): AsyncIterable<number> {
  const [head, ...rest] = ids;
  if (head !== undefined) yield head;
  await meanwhile();
  yield* rest;
}

/** A segment at generation 2, its generations 0 and 1 kept. */
async function threeLoads(w: ReturnType<typeof world>): Promise<void> {
  for (const ids of [[1], [1, 2], [1, 2, 3]]) await loadSegment(SEG, ids, w.deps, { keep: 9 });
}

describe('a load reuses the row it read, and every fence on that row still holds', () => {
  it('reads the row once before the publish: the write and the publish decide from that read', async () => {
    const w = world();
    await threeLoads(w);
    const calls: Record<string, number> = {};
    const registry = counting<IRegistryDriver>(w.registry, calls);
    const r = await loadSegment(SEG, [1, 2, 3, 4], { ...w.deps, registry }, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
    // One read before the publish, none in it. A keep of 9 has nothing to collect at generation 3, so the load
    // reads the row no more than that.
    expect(calls.get).toBe(1);
    expect(calls.compareAndSwap).toBe(1);
  });

  it.each<[string, LoadOptions]>([
    ['a guarded load', {}],
    ['an unguarded load', { allowEmpty: true }],
  ])(
    '%s that a concurrent publish overtakes reports superseded, and the winner stays current',
    async (_, opts) => {
      const w = world();
      await threeLoads(w);
      const r = await loadSegment(
        SEG,
        streaming([9, 10], async () => {
          await loadSegment(SEG, [1, 2, 3, 4, 5], w.deps, { keep: 9 }); // generation 3
        }),
        w.deps,
        { keep: 9, ...opts },
      );
      // It took 3 too, from its own row read; write-once refused it, or the row's token did.
      expect(r.published).toBe(false);
      expect(r.reason).toBe('superseded');
      const row = (await w.registry.get(SEG))!;
      expect(row.currentGen).toBe(3);
      expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4, 5]);
    },
  );

  it('a concurrent publish at another number still makes the publish lose on the token', async () => {
    const w = world();
    await threeLoads(w);
    // The other writer writes and publishes 4 directly, so this load's own number 3 stays free to write, and only
    // the row's token can refuse its publish.
    const r = await loadSegment(
      SEG,
      streaming([9, 10], async () => {
        await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 4 }, [4], {
          registry: w.registry,
        });
      }),
      w.deps,
      { keep: 9, allowEmpty: true },
    );
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect((await w.registry.get(SEG))!.currentGen).toBe(4);
    // The row changed, so its object stays (below the pointer, for collection), never deleted by number.
    expect(await generations(w.storage)).toContain(3);
  });

  it('a purge and re-create of the name refuses the publish and leaves the new incarnation alone', async () => {
    const w = world();
    await threeLoads(w);
    const r = await loadSegment(
      SEG,
      streaming([42], async () => {
        // Retire the segment and reuse the name until the new incarnation's pointer passes this load's number.
        for (const g of await generations(w.storage))
          await w.storage.delete({ ...SEG, generation: g });
        await w.registry.delete(SEG);
        for (const ids of [[10], [11], [12], [13], [14]]) {
          await loadSegment(SEG, ids, w.deps, { keep: 9 });
        }
      }),
      w.deps,
      { keep: 9 },
    );
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(4); // the new incarnation's own pointer
    expect(await idsOf(w.storage, 4)).toEqual([14]);
    expect(await idsOf(w.storage, 3)).toEqual([13]); // its generation 3, not this load's
  });

  it('a rollback that moves the pointer down refuses the publish, and the pointer stays where it was rolled to', async () => {
    const w = world();
    await threeLoads(w);
    const r = await loadSegment(
      SEG,
      streaming([42], async () => {
        await rollbackSegment(SEG, 0, w.deps);
      }),
      w.deps,
      { keep: 9, allowEmpty: true },
    );
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('a drop that lands meanwhile is never published over, and the late object it wrote is deleted', async () => {
    const w = world();
    await threeLoads(w);
    let dropped: Awaited<ReturnType<typeof dropSegment>> | undefined;
    const r = await loadSegment(
      SEG,
      streaming([42], async () => {
        dropped = await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
      }),
      w.deps,
      { keep: 9 },
    );
    expect(dropped?.generationsRemaining).toEqual([]);
    // The load wrote generation 3 after the drop's sweeps, from the row it read before the drop; the token refused
    // its publish, and the refusal deleted the object, since every generation of a destroyed segment is garbage.
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');
    expect(await generations(w.storage)).toEqual([]);
  });

  it('a shred that lands meanwhile refuses an encrypted load before its key is unwrapped or anything written', async () => {
    const w = world();
    const inner = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    let shredded = false;
    let opensAfterShred = 0;
    const keystore = new Proxy(inner, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (p === 'openDek' && shredded) opensAfterShred += 1;
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    const deps = { ...w.deps, keystore };
    for (const ids of [[1], [1, 2]]) await loadSegment(SEG, ids, deps, { keep: 9 });
    await expect(
      loadSegment(
        SEG,
        streaming([42, 43], async () => {
          await destroySegment(SEG, { registry: w.registry }, { confirmSegment: SEG.segment });
          shredded = true;
        }),
        deps,
        { keep: 9 },
      ),
    ).rejects.toThrow(/destroyed/);
    expect(opensAfterShred).toBe(0);
    expect(await generations(w.storage)).toEqual([0, 1]); // a shred leaves the objects; the load added none
  });

  it('an unguarded first load that a drop overtakes is refused at the publish', async () => {
    const w = world();
    // An earlier load that crashed before its first publish: objects and no row, so the drop fences the name.
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [7]);
    await expect(
      loadSegment(
        SEG,
        streaming([42], async () => {
          const dropped = await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
          expect(dropped.dropped).toBe(true); // no row: it created a destroyed one
        }),
        w.deps,
        { allowEmpty: true },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');
    // It found no row, so it read the row again after its ids, saw the tombstone and wrote nothing.
    expect(await generations(w.storage)).toEqual([]);
  });

  it('a name re-created at the same pointer value is refused by the token alone', async () => {
    const w = world();
    await threeLoads(w); // generation 2 current; this load takes 3
    const r = await loadSegment(
      SEG,
      streaming([42], async () => {
        // Retire the name and re-create it until its new pointer is 2 again: the number this load read.
        for (const g of await generations(w.storage))
          await w.storage.delete({ ...SEG, generation: g });
        await w.registry.delete(SEG);
        for (const ids of [[10], [11], [12]]) await loadSegment(SEG, ids, w.deps, { keep: 9 });
      }),
      w.deps,
      { keep: 9 },
    );
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(2);
    expect(await idsOf(w.storage, 2)).toEqual([12]);
  });

  it('an unguarded first load with no keystore never publishes cleartext onto a row another writer created encrypted', async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    let reads = 0;
    const registry = new Proxy(w.registry, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
          // Right after this load read "no row": another writer's whole first load, encrypted.
          if (p === 'get' && reads++ === 0) await loadSegment(SEG, [7, 8], { ...w.deps, keystore });
          return out;
        };
      },
    });
    await expect(
      loadSegment(SEG, [1, 2, 3], { ...w.deps, registry }, { allowEmpty: true }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(0); // the other writer's, still current
    expect(await generations(w.storage)).toEqual([0]); // refused before it wrote
  });

  it('a cleartext object is not published onto a row that became encrypted while it was being written', async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    // Another writer's encrypted object 0 is in the bucket, not yet published.
    const other = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [7, 8], {
      registry: w.registry,
      keystore,
      publish: false,
    });
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'putImmutable') return value;
        return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
          const out = await w.storage.putImmutable(...args);
          // This load's cleartext object has landed; the other writer now publishes its encrypted 0.
          await publishGeneration(
            w.registry,
            { ...SEG, generation: 0 },
            { wrappedDeks: other.wrappedDeks },
          );
          return out;
        };
      },
    });
    await expect(
      loadSegment(SEG, [1, 2, 3], { ...w.deps, storage: racing }, { allowEmpty: true }),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    // The refusal is definite, so the cleartext object is reclaimed: the encrypted segment's bucket holds only its own.
    expect(await generations(w.storage)).toEqual([0]);
  });

  it.each([
    ['with no keystore', false],
    ['with a keystore', true],
  ])(
    'a cleartext load %s, overtaken by a drop, a purge and an encrypted re-creation, leaves no cleartext object behind',
    async (_, wired) => {
      const w = world();
      const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
      await threeLoads(w); // a cleartext segment at generation 2
      const r = await loadSegment(
        SEG,
        streaming([42, 43], async () => {
          await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
          await w.registry.delete(SEG); // the tombstone purged
          await loadSegment(SEG, [7], { ...w.deps, keystore }); // the name re-created, encrypted
        }),
        wired ? { ...w.deps, keystore } : w.deps,
        { keep: 9 },
      );
      // It wrote generation 3 from the cleartext row it read, and the token refused its publish.
      expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
      const row = (await w.registry.get(SEG))!;
      expect(row.wrappedDeks?.length).toBeGreaterThan(0);
      // Only the new incarnation's encrypted generation is left, and nothing in the bucket opens without its key.
      expect(await generations(w.storage)).toEqual([0]);
      await expect(
        openGenerationReader(w.storage, { ...SEG, generation: 0 }, undefined),
      ).rejects.toThrow();
    },
  );

  it('a publish that fails without a definite answer keeps its object, which may still be published', async () => {
    const w = world();
    await threeLoads(w);
    // The compare-and-swap lands and its response is lost: the outcome is unknown to the load.
    const lossy = new Proxy(w.registry, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'compareAndSwap') return value;
        return async (...args: Parameters<MemoryRegistryDriver['compareAndSwap']>) => {
          await w.registry.compareAndSwap(...args);
          throw new TransientError('connection reset after the write');
        };
      },
    });
    await expect(
      loadSegment(SEG, [1, 2, 3, 4], { ...w.deps, registry: lossy }, { keep: 9 }),
    ).rejects.toBeInstanceOf(TransientError);
    // The write landed, so the pointer names generation 3, and its object is still there.
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  it('a publish still in flight when it reports a fault finds its object there when it lands', async () => {
    const w = world();
    await threeLoads(w);
    // The compare-and-swap times out on the client and lands at the store afterwards, with the row unchanged
    // meanwhile: the case a delete on an ambiguous outcome would turn into a pointer over a missing object.
    let late: Parameters<MemoryRegistryDriver['compareAndSwap']> | undefined;
    const slow = new Proxy(w.registry, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'compareAndSwap') return value;
        return (...args: Parameters<MemoryRegistryDriver['compareAndSwap']>) => {
          late = args;
          return Promise.reject(new TransientError('timed out; the request may still land'));
        };
      },
    });
    await expect(
      loadSegment(SEG, [1, 2, 3, 4], { ...w.deps, registry: slow }, { keep: 9 }),
    ).rejects.toBeInstanceOf(TransientError);
    await w.registry.compareAndSwap(...late!); // it lands
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
    expect(await idsOf(w.storage, 3)).toEqual([1, 2, 3, 4]);
  });

  /** `storage`, running `after` once, right after the first object put lands. */
  const afterFirstPut = (storage: IStorageDriver, after: () => Promise<void>): IStorageDriver => {
    let fired = false;
    return new Proxy(storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'putImmutable') return value;
        return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
          const out = await storage.putImmutable(...args);
          if (!fired) {
            fired = true;
            await after();
          }
          return out;
        };
      },
    }) as IStorageDriver;
  };

  it("leaves a re-created encrypted incarnation's object at the number this load wrote", async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    await loadSegment(SEG, [1], w.deps); // cleartext, generation 0; this load takes 1
    const racing = afterFirstPut(w.storage, async () => {
      // This load's object 1 has landed. The name is dropped (its objects deleted, 1 included), purged, and
      // re-created encrypted, whose second load writes ITS generation 1.
      await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
      await w.registry.delete(SEG);
      await loadSegment(SEG, [7], { ...w.deps, keystore });
      await loadSegment(SEG, [7, 8], { ...w.deps, keystore });
    });
    const r = await loadSegment(SEG, [42], { ...w.deps, storage: racing });
    expect(r).toMatchObject({ generation: 1, published: false, reason: 'superseded' });
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    // The new incarnation's live generation is still there, and still reads.
    const aead = await keystore.openDek(row.wrappedDeks!);
    const reader = await openGenerationReader(
      w.storage,
      { ...SEG, generation: 1 },
      {
        aead,
        aadFor: (scope) => aadFor(SEG, 1, scope),
      },
    );
    expect(reader.count()).toBe(2);
  });

  it("leaves a rowless loader's object at the number this load wrote, after a purge", async () => {
    const w = world();
    // A row with no pointer yet, so this load takes 0.
    await setSegmentRetention(
      SEG,
      { registry: w.registry },
      { expiresAt: Date.now() + 86_400_000 },
    );
    let other: Awaited<ReturnType<typeof bulkLoadCrbmGeneration>> | undefined;
    const racing = afterFirstPut(w.storage, async () => {
      // This load's 0 has landed. The name is dropped and purged; a new loader writes its own 0, not yet published.
      await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
      await w.registry.delete(SEG);
      other = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [5, 6, 7], {
        registry: w.registry,
        publish: false,
      });
    });
    const r = await loadSegment(SEG, [42], { ...w.deps, storage: racing });
    expect(r).toMatchObject({ generation: 0, published: false, reason: 'superseded' });
    expect(other).toBeDefined();
    // The other loader's object survived this load's refusal, so its publish lands on an object.
    expect(await idsOf(w.storage, 0)).toEqual([5, 6, 7]);
    expect(await publishGeneration(w.registry, { ...SEG, generation: 0 })).toBe(true);
  });

  it('keeps its object when the read that would prove it its own fails', async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    await threeLoads(w); // cleartext, generation 2; this load takes 3
    let armed = false;
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) =>
          armed && key.generation === 3
            ? Promise.reject(new TransientError('503 SlowDown'))
            : w.storage.getTail(key, maxBytes);
      },
    }) as IStorageDriver;
    const r = await loadSegment(
      SEG,
      streaming([42, 43], async () => {
        await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
        await w.registry.delete(SEG);
        await loadSegment(SEG, [7], { ...w.deps, keystore }); // re-created encrypted, at 0
        armed = true; // the footer read of this load's 3 will fail
      }),
      { ...w.deps, storage: flaky },
      { keep: 9 },
    );
    expect(r).toMatchObject({ generation: 3, published: false, reason: 'superseded' });
    // Not proved its own, so not deleted: an orphan above the new pointer is the better failure.
    expect(await generations(w.storage)).toEqual([0, 3]);
  });

  it('a keystore first load that another writer publishes ahead of during its write is told to re-run', async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { ...w.deps, keystore };
    // Another writer's encrypted object 0 is in the bucket, not yet published, so this load takes 1; it finds no
    // row after its ids and mints a key, and the other writer publishes 0 while this load writes.
    const other = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 0 }, [7, 8], {
      registry: w.registry,
      keystore,
      publish: false,
    });
    const racing = afterFirstPut(w.storage, async () => {
      await publishGeneration(
        w.registry,
        { ...SEG, generation: 0 },
        { wrappedDeks: other.wrappedDeks },
      );
    });
    await expect(
      loadSegment(SEG, [1, 2, 3], { ...deps, storage: racing }, { allowEmpty: true }),
    ).rejects.toThrow(/re-run the write/);
    // The refusal came before its compare-and-swap: the other writer's generation is current, under its key. This
    // load's object is encrypted under a key nothing stored, so no reader can open it; it is kept, as an orphan.
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
    expect(await generations(w.storage)).toEqual([0, 1]);
  });

  it('an unguarded first load refused by a drop at its publish deletes its object', async () => {
    const w = world();
    let fired = false;
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'putImmutable') return value;
        return async (...args: Parameters<IStorageDriver['putImmutable']>) => {
          if (!fired) {
            fired = true;
            // After this load read the row again (none): another load creates it, and a drop tombstones it.
            await loadSegment(SEG, [7], w.deps);
            await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
          }
          return w.storage.putImmutable(...args);
        };
      },
    }) as IStorageDriver;
    await expect(
      loadSegment(SEG, [1, 2], { ...w.deps, storage: racing }, { allowEmpty: true }),
    ).rejects.toThrow(/destroyed/);
    expect((await w.registry.get(SEG))!.status).toBe('destroyed');
    expect(await generations(w.storage)).toEqual([]);
  });

  it("a keystore load that another keystore writer overtakes on a new name publishes under that writer's key", async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { ...w.deps, keystore };
    let reads = 0;
    const registry = new Proxy(w.registry, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
          if (p === 'get' && reads++ === 0) await loadSegment(SEG, [7, 8], deps);
          return out;
        };
      },
    });
    const r = await loadSegment(SEG, [1, 2, 3], { ...deps, registry }, { allowEmpty: true });
    expect(r).toMatchObject({ generation: 1, published: true });
    const row = (await w.registry.get(SEG))!;
    expect(row.currentGen).toBe(1);
    const aead = await keystore.openDek(row.wrappedDeks!);
    const reader = await openGenerationReader(
      w.storage,
      { ...SEG, generation: 1 },
      {
        aead,
        aadFor: (scope) => aadFor(SEG, 1, scope),
      },
    );
    expect(reader.count()).toBe(3);
  });

  it('a segment already destroyed when the load reads its row is refused before anything is written', async () => {
    const w = world();
    await threeLoads(w);
    await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
    const before = await generations(w.storage);
    await expect(loadSegment(SEG, [1], w.deps)).rejects.toThrow(/destroyed/);
    expect(await generations(w.storage)).toEqual(before);
  });

  it("an encrypted segment's load reuses the DEK on the row it read", async () => {
    const w = world();
    const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
    const deps = { ...w.deps, keystore };
    await loadSegment(SEG, [1], deps);
    const wrapped = (await w.registry.get(SEG))!.wrappedDeks;
    const r = await loadSegment(SEG, [1, 2], deps);
    expect(r).toMatchObject({ generation: 1, published: true });
    expect((await w.registry.get(SEG))!.wrappedDeks).toEqual(wrapped); // no new key minted
    const aead = await keystore.openDek(wrapped!);
    const reader = await openGenerationReader(
      w.storage,
      { ...SEG, generation: 1 },
      {
        aead,
        aadFor: (scope) => aadFor(SEG, 1, scope),
      },
    );
    expect(reader.count()).toBe(2);
  });
});

describe('publishGeneration with the row its caller read', () => {
  it('never answers "already current" from that row: only a fresh read can show the pointer there', async () => {
    const w = world();
    await threeLoads(w); // generation 2 is current
    const stale = (await w.registry.get(SEG))!;
    await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }); // generation 3 lands after the caller's read
    // A row naming the very generation being published would make "already current" true of the row, not the segment.
    const published = await publishGeneration(
      w.registry,
      { ...SEG, generation: 2 },
      { row: stale },
    );
    expect(published).toBe(false); // the segment is at 3: forward-only refuses 2
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
  });

  it("writes only under that row's own fence: a row that changed since makes the first attempt lose", async () => {
    const w = world();
    await threeLoads(w);
    const stale = (await w.registry.get(SEG))!;
    await loadSegment(SEG, [1, 2, 3, 4], w.deps, { keep: 9 }); // generation 3
    await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 5 }, [5]);
    const calls: Record<string, number> = {};
    const registry = counting<IRegistryDriver>(w.registry, calls);
    const published = await publishGeneration(
      registry,
      { ...SEG, generation: 5 },
      { row: stale, expectToken: stale.token },
    );
    expect(published).toBe(false);
    // The stale token's compare-and-swap lost, and the second attempt read the row and found the token moved.
    expect(calls.compareAndSwap).toBe(1);
    expect(calls.get).toBe(1);
    expect((await w.registry.get(SEG))!.currentGen).toBe(3);
  });
});
