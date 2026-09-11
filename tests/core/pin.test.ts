import { gcOrphanGenerations } from '@/core/generation-gc';
import { NotFoundError } from '@/core/errors';
import {
  CloudRoaring,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
} from '@/index';
import type { SegmentRef } from '@/index';
import { collect, loadedStore, seedSegment } from '../helpers/loaded';

/**
 * `pin()` — a snapshot of one segment at one generation.
 *
 * An ordinary handle re-resolves `currentGen` on a short TTL, which is right for a point query and wrong for a
 * job that has to describe a single instant: a send, an export, a reconciliation. Without a pin the second
 * half of such a job can read a different set than the first, and nothing in the result says so.
 *
 * These tests are built around the case that distinguishes a pin from the existing TTL behaviour: a publish
 * landing **while the handle is in use**. The TTL makes that "usually stale, sometimes fresh" — a pin makes it
 * "always the generation you pinned", which is the difference between a cache and a guarantee.
 */

const SEG: SegmentRef = { segment: 'audience' };

/** A second store over the same drivers — the honest model of a different reader, with its own TTL state. */
function reader(w: Awaited<ReturnType<typeof loadedStore>>): CloudRoaring {
  return new CloudRoaring({ cold: w.cold, registry: w.registry, coldGenTtlMs: 0 });
}

describe('pin() — a snapshot that a publish cannot move', () => {
  it('reports the generation it settled on', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    const snap = await reader(w).segment(SEG.segment).pin();
    expect(snap.generation).toBe(0);
  });

  it('a load during a pinned read changes nothing the reader sees', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    const snap = await reader(w).segment(SEG.segment).pin();

    expect(await snap.count()).toBe(3);
    await w.load(SEG, [1, 2, 3, 4, 5, 6, 7]); // a publish, mid-job

    // Every read verb still describes the pinned instant.
    expect(await snap.count()).toBe(3);
    expect(await snap.has(7)).toBe(false);
    expect((await collect(snap.iterate())).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(snap.generation).toBe(0);
  });

  it('holds across MANY publishes, not just one TTL window', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]);
    const snap = await reader(w).segment(SEG.segment).pin();
    for (let i = 2; i <= 6; i++) await w.load(SEG, [1, i]);
    expect(await snap.count()).toBe(1);
    expect(snap.generation).toBe(0);
  });

  it('re-pinning the unpinned handle observes the new generation', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    const store = reader(w);
    const first = await store.segment(SEG.segment).pin();
    await w.load(SEG, [1, 2, 3, 4]);

    const second = await store.segment(SEG.segment).pin();
    expect(second.generation).toBe(1);
    expect(await second.count()).toBe(4);
    expect(await first.count()).toBe(3); // the earlier snapshot is untouched by the newer one
  });

  it('pinning a pinned handle is the same snapshot', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1, 2]);
    const snap = await reader(w).segment(SEG.segment).pin();
    await w.load(SEG, [1, 2, 3]);
    const again = await snap.pin();
    expect(again).toBe(snap);
    expect(again.generation).toBe(0);
    expect(await again.count()).toBe(2);
  });

  it('an unpinned handle over the same store DOES move on — the pin is the difference', async () => {
    // The control. Without this, every assertion above would also pass if `pin()` did nothing and the store
    // simply never refreshed.
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    const snap = await reader(w).segment(SEG.segment).pin();
    await w.load(SEG, [1, 2, 3, 4]);

    expect(await reader(w).segment(SEG.segment).count()).toBe(4); // a fresh reader sees the publish
    expect(await snap.count()).toBe(3); // the snapshot does not
  });
});

describe('pin() — a segment with no generation', () => {
  it('pins to null and stays empty even after a load lands', async () => {
    // A snapshot of "nothing yet" is a real answer. Adopting the first generation to appear would make one
    // handle describe two different instants, which is the thing a pin exists to rule out.
    const w = await loadedStore();
    const snap = await reader(w).segment(SEG.segment).pin();
    expect(snap.generation).toBeNull();
    expect(await snap.count()).toBe(0);

    await w.load(SEG, [1, 2, 3]);
    expect(await snap.count()).toBe(0);
    expect(await snap.has(1)).toBe(false);
    expect(snap.generation).toBeNull();
  });
});

describe('pin() — a pin is not a lock', () => {
  it('fails loudly when its generation is swept, rather than healing onto a different one', async () => {
    // An unpinned read heals forward here: it catches the NotFound, re-resolves and serves the current
    // generation. A pinned read must NOT — silently serving a different generation is exactly what the caller
    // pinned to prevent, and it would be invisible in the result.
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    const snap = await reader(w).segment(SEG.segment).pin();
    expect(await snap.count()).toBe(3);

    await w.load(SEG, [9]);
    expect(
      await gcOrphanGenerations(SEG, { cold: w.cold, registry: w.registry }, { keep: 0 }),
    ).toEqual([0]);

    await expect(collect(snap.iterate())).rejects.toThrow(NotFoundError);
  });

  it('a grace window wide enough for the job keeps it readable', async () => {
    // The other half of the same story, and the reason `keep`/`minAgeMs` exist: sizing the window is how a pin
    // is made to survive.
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    const snap = await reader(w).segment(SEG.segment).pin();
    await w.load(SEG, [9]);
    expect(
      await gcOrphanGenerations(SEG, { cold: w.cold, registry: w.registry }, { keep: 1 }),
    ).toEqual([]);
    expect(await snap.count()).toBe(3);
  });
});

describe('pin() — a source with no generations', () => {
  it('is already its own snapshot: pin succeeds with a null generation', async () => {
    // A seeded in-memory source cannot move underneath a reader, so refusing to pin it would be a false
    // distinction — the caller gets the guarantee they asked for either way.
    const cold = new MemoryColdChunkSource();
    seedSegment(cold, SEG.segment, [1, 2, 3]);
    const snap = await new CloudRoaring({ cold }).segment(SEG.segment).pin();
    expect(snap.generation).toBeNull();
    expect(await snap.count()).toBe(3);
  });
});

describe('pin() — cache and cost', () => {
  it('shares the HOT cache with an unpinned read of the SAME generation', async () => {
    // The pinned source reports its pinned number as `currentGeneration`, and the engine keys its chunk cache
    // by that. So a pinned read reuses chunks an unpinned read already decoded, instead of paying for them
    // again and doubling the memory ceiling the store was configured with. Asserted by counting fetches at the
    // driver: a source reporting the wrong generation here would key a second, colliding set of entries.
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);
    let fetches = 0;
    const counting = new Proxy(w.cold, {
      get(target, prop, rx) {
        if (prop === 'getRange') {
          return (...args: unknown[]) => {
            fetches++;
            return (target.getRange as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, rx) as unknown;
      },
    });
    const store = new CloudRoaring({ cold: counting, registry: w.registry, coldGenTtlMs: 0 });

    await store.segment(SEG.segment).has(1); // decodes chunk 0 at generation 0
    const afterFirst = fetches;
    expect(afterFirst).toBeGreaterThan(0);

    const snap = await store.segment(SEG.segment).pin();
    expect(snap.generation).toBe(0);
    expect(await snap.has(1)).toBe(true); // same generation, same chunk → served from the cache
    expect(fetches).toBe(afterFirst);
  });

  it('resolves the registry ONCE, however many reads the snapshot serves', async () => {
    // The point is a stable answer, but the reason it is cheap is that a pin collapses N pointer resolutions
    // into one. A regression here (re-resolving per read) would keep every assertion above passing.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    let gets = 0;
    const counting = new Proxy(registry, {
      get(target, prop, rx) {
        if (prop === 'get') {
          return async (ref: SegmentRef) => {
            gets++;
            return registry.get(ref);
          };
        }
        return Reflect.get(target, prop, rx) as unknown;
      },
    });
    const w = await loadedStore();
    await w.load(SEG, [1, 2, 3]);

    const store = new CloudRoaring({
      cold: w.cold,
      registry: counting as unknown as MemoryRegistryDriver,
      coldGenTtlMs: 1,
      // Force the TTL to expire between reads, so an unpinned source would re-resolve on every call.
      clock: { now: () => Date.now() + gets * 10_000, sleep: async () => {} },
    });
    void cold;
    const snap = await store.segment(SEG.segment).pin();
    const after = gets;
    await snap.count();
    await snap.has(1);
    await collect(snap.iterate());
    expect(gets).toBe(after); // not one resolution more, despite a TTL that expires every call
  });
});
