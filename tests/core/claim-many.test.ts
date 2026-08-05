import {
  CloudRoaring,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { IWarmDriver, SegmentRef } from '@/index';

/**
 * `claimMany` — the durable analogue of Redis `SETBIT` returning the prior bit.
 *
 * It exists because `has()` then `add()` cannot express exactly-once: two workers both read absent and both
 * proceed. What makes this version worth having rather than a literal `SETBIT` port is the batching — a Warm write
 * rewrites a whole 64K-id chunk bitmap, so per-id claiming is the most expensive way to use this library. The
 * cost test at the bottom pins that, because it is the reason for the API's shape.
 */

const SEG: SegmentRef = { namespace: 'dedup', segment: 'wave-1' };

function world(warm: IWarmDriver = new MemoryWarmDriver()) {
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  const store = new CloudRoaring({ warm, cold, registry, retry: false });
  return {
    cold,
    warm,
    registry,
    store,
    seg: store.segment(SEG.segment, { namespace: SEG.namespace }),
  };
}

describe('claimMany', () => {
  it('returns only the ids that were not already present', async () => {
    const w = world();
    expect((await w.seg.claimMany([1, 2, 3])).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // Second pass: all three are now present, so none are newly claimed — and the set is unchanged.
    expect(await w.seg.claimMany([1, 2, 3])).toEqual([]);
    expect((await w.seg.claimMany([2, 3, 4])).sort((a, b) => a - b)).toEqual([4]);
    expect(await w.seg.count()).toBe(4);
  });

  it('adds what it claims, so a claim is durable not advisory', async () => {
    const w = world();
    await w.seg.claimMany([10, 70_000]);
    await expect(w.seg.has(10)).resolves.toBe(true);
    await expect(w.seg.has(70_000)).resolves.toBe(true);
  });

  it('spans chunk boundaries', async () => {
    // Ids land in different 64K chunks, which are independent OCC rows — the fan-out must not lose any.
    const w = world();
    const ids = [1, 65_535, 65_536, 131_072, 9_000_000];
    expect((await w.seg.claimMany(ids)).sort((a, b) => a - b)).toEqual(
      [...ids].sort((a, b) => a - b),
    );
    expect(await w.seg.count()).toBe(ids.length);
  });

  it('does NOT re-claim an id already folded into a Cold generation', async () => {
    // THE correctness trap. Checking the Warm delta's `adds` alone would report id 1 as newly claimed, because
    // after a compaction the Warm row is gone and the id lives only in Cold. That would silently break
    // exactly-once on any segment that has ever been compacted — i.e. every long-lived one. The presence test
    // has to be the full effective set, `(cold ∪ adds) \ removes`.
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });
    // Nothing in Warm at all — the ids are cold-only.
    let warmRows = 0;
    for await (const _r of w.warm.listChunks(SEG)) {
      void _r;
      warmRows += 1;
    }
    expect(warmRows).toBe(0);

    expect(await w.seg.claimMany([1, 2, 3])).toEqual([]);
    expect((await w.seg.claimMany([3, 4])).sort((a, b) => a - b)).toEqual([4]);
  });

  it('treats a removed id as claimable again', async () => {
    // `remove` is a first-class tombstone, so the effective set no longer holds the id — and a claim must agree
    // with `has()`.
    const w = world();
    await w.seg.claimMany([5]);
    await w.seg.remove(5);
    await expect(w.seg.has(5)).resolves.toBe(false);
    expect(await w.seg.claimMany([5])).toEqual([5]);
  });

  it('treats an id removed from a COLD generation as claimable again', async () => {
    // The test above does NOT prove `removes` is honoured, and a mutation run is what showed it: `applyAdd`/
    // `applyRemove` keep `adds` and `removes` disjoint (invariant I1), so for a warm-only id "not in adds" and
    // "in removes" are the same observation and `(cold ∪ adds)` gets the right answer by accident.
    //
    // `removes` is only load-bearing when the id lives in COLD and was then tombstoned: Cold still has it, `adds`
    // does not, and only subtracting `removes` reveals that it is gone. Without this case, dropping the
    // `\ removes` term passes the whole suite.
    const w = world();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [7, 8], {
      registry: w.registry,
    });
    await w.seg.remove(7); // tombstone over a cold id
    await expect(w.seg.has(7)).resolves.toBe(false);

    expect(await w.seg.claimMany([7])).toEqual([7]); // claimable, because it is no longer present
    expect(await w.seg.claimMany([8])).toEqual([]); // ...and 8, untouched in Cold, is still present
  });

  it('gives exactly one winner per id under a real concurrent race', async () => {
    // The guarantee that justifies the method existing. Ten workers claim the same 50 ids at once; each id must
    // be won by exactly one of them. Same chunk on purpose — that is where the OCC row is contended.
    const w = world();
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const results = await Promise.all(Array.from({ length: 10 }, () => w.seg.claimMany(ids)));

    const all = results.flat();
    expect(all.sort((a, b) => a - b)).toEqual(ids); // every id claimed exactly once, none lost, none doubled
    expect(new Set(all).size).toBe(ids.length);
    expect(await w.seg.count()).toBe(ids.length);
  });

  it('is safe to re-run after a partial failure — already-claimed ids come back as not-new', async () => {
    const w = world();
    const first = await w.seg.claimMany([1, 2, 3]);
    expect(first).toHaveLength(3);
    const rerun = await w.seg.claimMany([1, 2, 3, 4]);
    expect(rerun).toEqual([4]); // idempotent for the overlap
  });

  it('accepts an empty batch without touching the backend', async () => {
    const w = world();
    expect(await w.seg.claimMany([])).toEqual([]);
    let rows = 0;
    for await (const _r of w.warm.listChunks(SEG)) {
      void _r;
      rows += 1;
    }
    expect(rows).toBe(0);
  });

  it('costs one write per chunk, not one per id — the reason it takes a batch', async () => {
    // This is a COST assertion, and it is load-bearing: the whole argument for `claimMany(ids)` over a per-id
    // `claim(id)` is that a Warm write rewrites an entire chunk bitmap. If this regresses to per-id writes the
    // method has lost its reason to exist, while still passing every functional test above.
    let writes = 0;
    const base = new MemoryWarmDriver();
    const counting = new Proxy(base, {
      get(t, p) {
        if (p === 'putConditional') {
          const real = Reflect.get(t, p, t) as (...a: never[]) => Promise<unknown>;
          return (...args: never[]) => {
            writes += 1;
            return real.call(t, ...args);
          };
        }
        const v = Reflect.get(t, p, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as IWarmDriver;

    const w = world(counting);
    // 3,000 ids inside ONE 64K chunk.
    await w.seg.claimMany(Array.from({ length: 3_000 }, (_, i) => i * 20));
    expect(writes).toBe(1);
    expect(await w.seg.count()).toBe(3_000);
  });
});
