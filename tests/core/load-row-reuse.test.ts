import { randomBytes } from 'node:crypto';
import { loadSegment, type LoadOptions } from '@/core/load';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { aadFor } from '@/core/crypto';
import { dropSegment } from '@/core/erasure';
import { ValidationError } from '@/core/errors';
import { rollbackSegment } from '@/core/rollback';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
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
    // One read before the publish, none in it; the collection pass reads twice more (before and after its listing).
    expect(calls.get).toBe(3);
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
    // The other writer publishes 4 (an orphan holds 3), so this load's own number 3 is free to write.
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

  it('a drop that lands meanwhile is never published over: the row stays destroyed', async () => {
    const w = world();
    await threeLoads(w);
    const r = await loadSegment(
      SEG,
      streaming([42], async () => {
        await dropSegment(SEG, w.deps, { confirmSegment: SEG.segment });
      }),
      w.deps,
      { keep: 9 },
    );
    expect(r.published).toBe(false);
    const row = (await w.registry.get(SEG))!;
    expect(row.status).toBe('destroyed');
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
