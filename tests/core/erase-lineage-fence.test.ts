import { eraseIdFromSegment } from '@/core/erase-id';
import { openGenerationReader, publishGeneration } from '@/core/crbm-cold-source';
import { dropSegment } from '@/core/erasure';
import { MemoryColdDriver, MemoryRegistryDriver, bulkLoadCrbmGeneration } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import type { IColdDriver, SegmentRef } from '@/index';

/**
 * A generation number identifies a generation only **within one incarnation of a name**. `nextGeneration`
 * returns `max(currentGen, highest object) + 1`, so it restarts at `0` once the registry row is purged and the
 * bucket is empty — and a retired, re-created name then presents a different segment at the same `currentGen`.
 *
 * `expectFrom` compares that number, so it matched across incarnations: the erasure rewrite published
 * incarnation 1's content over incarnation 2, collected the live objects with its `keep: 0` sweep, and returned
 * `erased: true`. A successful Art. 17 receipt for an operation that destroyed the live segment.
 *
 * The row's OCC token is the identity that survives a delete: the port contract says a later `create` gets "a
 * fresh, greater token", and every driver is conformance-tested on it.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 's' };

async function idsIn(cold: MemoryColdDriver, generation: number): Promise<number[]> {
  const reader = await openGenerationReader(cold, { ...REF, generation }, undefined);
  const out: number[] = [];
  for (const ck of reader.chunkKeys()) {
    const bytes = await reader.getChunk(ck);
    if (bytes === null) continue;
    for (const v of roaringCodec.safeDeserialize(bytes, 1 << 20).toArray())
      out.push(v + ck * 65536);
  }
  return out.sort((a, b) => a - b);
}

/** Retire the name and re-create it mid-rewrite, once, right after the first chunk read. */
function reincarnateAfterFirstRead(
  real: MemoryColdDriver,
  registry: MemoryRegistryDriver,
  ids: readonly number[],
): IColdDriver {
  let fired = false;
  return {
    capabilities: () => real.capabilities(),
    getTail: (k, m) => real.getTail(k, m),
    delete: (k) => real.delete(k),
    list: (r) => real.list(r),
    putImmutable: (k, fn) => real.putImmutable(k, fn),
    getRange: async (k, o, l) => {
      const out = await real.getRange(k, o, l);
      if (!fired) {
        fired = true;
        await dropSegment(REF, { cold: real, registry }, { confirmSegment: 's' });
        await registry.delete(REF); // what the retention sweep does to a reclaimed tombstone
        await bulkLoadCrbmGeneration(real, { ...REF, generation: 0 }, ids, { registry });
      }
      return out;
    },
  };
}

describe('a derived publish is fenced on the row, not just the pointer value', () => {
  it('an erasure cannot republish a retired incarnation over the live segment', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const wrapped = reincarnateAfterFirstRead(cold, registry, [7, 8, 9]);
    const res = await eraseIdFromSegment(REF, 2, { cold: wrapped, registry, codec: roaringCodec });

    // The rewrite was derived from a segment that no longer exists. It must NOT claim an erasure.
    expect(res.erased).toBe(false);
    expect(res.reason).toBe('superseded');
    expect(res.collected).toEqual([]); // and it must not have swept the live incarnation's objects

    // The live segment is untouched: incarnation 2's ids, whole.
    const live = (await registry.get(REF))!;
    expect(live.currentGen).toBe(0);
    expect(await idsIn(cold, 0)).toEqual([7, 8, 9]);
  });

  it('the reincarnation lands before the verify — reported, not thrown', async () => {
    // Here our own object is swept by the reincarnation's `dropSegment`, so the verify read misses. Without a
    // lineage check on the row re-read, the pointer still reads `from` and the miss propagates as a bare
    // `NotFoundError` — the unactionable face this module stopped presenting.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    let ourObjectWritten = false;
    let fired = false;
    const wrapped: IColdDriver = {
      capabilities: () => cold.capabilities(),
      getRange: (k, o, l) => cold.getRange(k, o, l),
      delete: (k) => cold.delete(k),
      list: (r) => cold.list(r),
      putImmutable: async (k, fn) => {
        const res = await cold.putImmutable(k, fn);
        ourObjectWritten = true;
        return res;
      },
      getTail: async (k, m) => {
        if (ourObjectWritten && !fired) {
          fired = true; // the verify's read: re-create the name first, taking our object with it
          await dropSegment(REF, { cold, registry }, { confirmSegment: 's' });
          await registry.delete(REF);
          await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [7, 8, 9], { registry });
        }
        return cold.getTail(k, m);
      },
    };

    const res = await eraseIdFromSegment(REF, 2, {
      cold: wrapped,
      registry,
      codec: roaringCodec,
    }).catch((e: Error) => `threw ${e.name}: ${e.message}`);

    expect(res).toMatchObject({ erased: false, reason: 'superseded' });
    expect(await idsIn(cold, 0)).toEqual([7, 8, 9]);
  });

  it('the reincarnation lands after a SUCCESSFUL verify — only the publish fence is left', async () => {
    // Layered on purpose: the pre-verify row read and the catch's row re-read both report this race earlier
    // and more cheaply. This interleaving slips past both — the verify completes against our own object, and
    // the name is re-created only on the registry read the publish itself makes — so the assertion below
    // rests on `expectToken` alone. It is the guarantee; the other two are optimisations.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    let ourObjectWritten = false;
    let verifyDone = false;
    let fired = false;
    const wrappedCold: IColdDriver = {
      capabilities: () => cold.capabilities(),
      getRange: (k, o, l) => cold.getRange(k, o, l),
      delete: (k) => cold.delete(k),
      list: (r) => cold.list(r),
      putImmutable: async (k, fn) => {
        const res = await cold.putImmutable(k, fn);
        ourObjectWritten = true;
        return res;
      },
      getTail: async (k, m) => {
        const res = await cold.getTail(k, m);
        if (ourObjectWritten) verifyDone = true; // the only tail read after our write is the verify's
        return res;
      },
    };
    const wrappedRegistry = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop !== 'get') return Reflect.get(target, prop, receiver) as unknown;
        return async (ref: SegmentRef) => {
          if (verifyDone && !fired) {
            fired = true; // the publish's own row read: re-create the name just before it looks
            await dropSegment(REF, { cold, registry }, { confirmSegment: 's' });
            await registry.delete(REF);
            await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [7, 8, 9], { registry });
          }
          return registry.get(ref);
        };
      },
    }) as unknown as MemoryRegistryDriver;

    const res = await eraseIdFromSegment(REF, 2, {
      cold: wrappedCold,
      registry: wrappedRegistry,
      codec: roaringCodec,
    }).catch((e: Error) => `threw ${e.name}: ${e.message}`);

    expect(res).toMatchObject({ erased: false, reason: 'superseded' });
    expect((await registry.get(REF))!.currentGen).toBe(0);
    expect(await idsIn(cold, 0)).toEqual([7, 8, 9]); // the live incarnation, whole
  });

  it('`expectToken` refuses a publish onto a re-created row at the same pointer value', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    const before = (await registry.get(REF))!;

    await cold.delete({ ...REF, generation: 0 }); // full retirement: objects gone…
    await registry.delete(REF); // …and the row purged, so the name is free
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [7, 8, 9], { registry });
    const after = (await registry.get(REF))!;
    expect(after.currentGen).toBe(before.currentGen); // the pointer VALUE is identical…
    expect(after.token).not.toBe(before.token); // …the row is not

    const landed = await publishGeneration(
      registry,
      { ...REF, generation: 1 },
      { expectFrom: before.currentGen!, expectToken: before.token },
    );
    expect(landed).toBe(false);
    expect((await registry.get(REF))!.currentGen).toBe(0); // pointer untouched
  });

  it('`expectFrom` alone still lands on the same row — the ordinary fenced publish', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });
    const row = (await registry.get(REF))!;

    expect(
      await publishGeneration(
        registry,
        { ...REF, generation: 1 },
        { expectFrom: 0, expectToken: row.token },
      ),
    ).toBe(true);
    expect((await registry.get(REF))!.currentGen).toBe(1);
  });

  it('an ordinary erasure on a stable segment is unaffected', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    const res = await eraseIdFromSegment(REF, 2, { cold, registry, codec: roaringCodec });
    expect(res).toMatchObject({ erased: true, fromGeneration: 0, generation: 1 });
    expect(res.collected).toEqual([0]);
    expect(await idsIn(cold, 1)).toEqual([1, 3]);
  });
});
