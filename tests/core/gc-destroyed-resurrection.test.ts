import { gcOrphanGenerations, nextGeneration } from '@/core/generation-gc';
import {
  MemoryColdDriver,
  MemoryRegistryDriver,
  WriteConflictError,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { GenKey, IColdDriver, SegmentRef } from '@/index';

/**
 * A row read before the listing, acted on after it — on both of `gcOrphanGenerations`' branches.
 *
 * The row comes from a read *before* `cold.list()`, and the deletes happen *after* it. That window is seconds
 * wide on S3, where the listing is paginated, and every step of the sequence is an ordinary in-repo path: the
 * retention sweep purges tombstone rows, and nothing stops a loader re-creating a segment by that name
 * afterwards. Both branches can then delete an object the live pointer names — the forbidden
 * `missing-cold-generation` state, which the grace window cannot prevent because it is not a question of age.
 *
 * - On a **tombstone**, every enumerated generation is deleted, `currentGen` included (correct in itself: a
 *   tombstoned segment resolves no generation for any reader). A segment re-created mid-pass therefore loses
 *   the object its new pointer names. Fenced by comparing the row's **token**, because a generation number is
 *   not an identity — a re-created name can wear the very `currentGen` the tombstone held.
 * - On the **ordinary** branch, deleting strictly below the pointer is only safe while the pointer moves
 *   forward, which it does within one incarnation. `nextGeneration` restarts at 0 once a row is purged and the
 *   bucket emptied, so a re-created name wears a *lower* pointer and `g < current` selects its live object.
 *   Fenced by taking the **lower** of the pointers read before and after the listing.
 *
 * A pass that cannot prove it is still the same incarnation throws `WriteConflictError`, rather than returning
 * an empty list that would be indistinguishable from "there was nothing to collect".
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

async function generations(cold: IColdDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const key of cold.list(SEG)) out.push(key.generation);
  return out.sort((a, b) => a - b);
}

/**
 * A cold driver whose `list()` runs `during` after yielding its first key — the window under test.
 *
 * `yielded` records what the listing actually enumerated. Every test here races an object into the bucket
 * mid-listing and then asserts what GC did with it, which is only meaningful if the listing SAW it — and
 * whether it does is a property of the driver, not of the test: `MemoryColdDriver.list` walks a live `Map`
 * iterator, so a key inserted mid-iteration is still yielded. Snapshot that iterator (a defensible change, and
 * arguably the more S3-like behaviour for a single page) and these tests would go green against code with no
 * fence at all. Asserting `yielded` keeps the precondition owned by the test instead of inherited from a driver
 * it does not control.
 */
function coldWithRaceDuringList(
  inner: MemoryColdDriver,
  during: () => Promise<void>,
  yielded: number[] = [],
): IColdDriver {
  return new Proxy(inner, {
    get(target, prop, rx) {
      if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
      return async function* (ref: SegmentRef): AsyncIterable<GenKey> {
        let fired = false;
        for await (const key of inner.list(ref)) {
          yielded.push(key.generation);
          yield key;
          if (!fired) {
            fired = true;
            await during();
          }
        }
      };
    },
  }) as IColdDriver;
}

describe('gcOrphanGenerations — a segment resurrected while GC is listing', () => {
  it('does not delete the new generation of a segment recreated mid-pass', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };

    await load([1]); // gen 0
    await load([1, 2]); // gen 1
    const tomb = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, tomb.token, { status: 'destroyed' });

    // The resurrection, fired after GC has read the tombstone and started listing: the sweep purges the row,
    // then a loader re-creates the segment and publishes a new generation.
    const resurrect = async (): Promise<void> => {
      const row = await registry.get(SEG);
      if (row !== null) await registry.delete(SEG);
      await load([7, 8, 9]);
    };

    const yielded: number[] = [];
    await expect(
      gcOrphanGenerations(SEG, {
        cold: coldWithRaceDuringList(cold, resurrect, yielded),
        registry,
      }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    const row = await registry.get(SEG);
    // Setup precondition, not an assertion about GC: the resurrection really did land an active row…
    expect(row?.status).toBe('active');
    // …and the listing really did enumerate the generation it published. Without this the test could pass
    // because GC never saw the new object, which proves nothing about the fence.
    expect(yielded).toContain(row!.currentGen!);
    // The object the live pointer names must still exist. Without the fence GC deletes every generation it
    // enumerated — including the one published during the listing — leaving `missing-cold-generation`.
    expect(await generations(cold)).toContain(row!.currentGen!);
  });

  it('refuses on a re-created incarnation wearing the SAME generation number', async () => {
    // The fence compares TOKENS, and that is load-bearing rather than incidental: a generation number is not an
    // identity. `nextGeneration` restarts at 0 once a row is purged and the bucket emptied, so a re-created
    // segment can wear the very `currentGen` the tombstone carried. A fence that compared `currentGen` would
    // see no change here and delete the new incarnation's live object; only the token tells them apart.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]); // gen 0
    await load([1, 2]); // gen 1 — the tombstone carries currentGen 1
    const tomb = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, tomb.token, { status: 'destroyed' });
    const destroyed = (await registry.get(SEG))!;
    expect(destroyed.currentGen).toBe(1);

    // Re-created at the SAME pointer the tombstone held — only the token differs.
    const recreate = async (): Promise<void> => {
      await registry.delete(SEG);
      await registry.create(SEG, { currentGen: 1, status: 'active' });
    };

    await expect(
      gcOrphanGenerations(SEG, { cold: coldWithRaceDuringList(cold, recreate), registry }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    const row = (await registry.get(SEG))!;
    expect(row.currentGen).toBe(destroyed.currentGen); // identical pointer…
    expect(row.token).not.toBe(destroyed.token); // …different incarnation
    expect(await generations(cold)).toEqual([0, 1]); // and nothing was collected
  });

  it('ORDINARY branch: refuses to delete the live object of a re-created incarnation', async () => {
    // The mirror of the case above, on the branch that used to be declared exempt. The old argument was "it
    // deletes strictly below the pointer it read, and the pointer only moves forward" — true within ONE
    // incarnation. Purge-and-recreate makes the pointer go BACKWARDS, and `g < current` then selects the new
    // incarnation's live object. Every step is an ordinary in-repo path, and `keep: 0` is what the erasure
    // rewrite passes.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    for (let i = 0; i <= 5; i++) await load([i]); // gens 0..5, current = 5
    expect((await registry.get(SEG))!.currentGen).toBe(5);

    // Fires after GC has read `current = 5` and started listing: the segment is retired, the bucket swept, the
    // tombstone row purged by the sweep, and then a loader re-creates the name — restarting at generation 0.
    const retireAndRecreate = async (): Promise<void> => {
      for (const g of await generations(cold)) await cold.delete({ ...SEG, generation: g });
      await registry.delete(SEG);
      await load([99]);
    };

    const yielded: number[] = [];
    const deleted = await gcOrphanGenerations(
      SEG,
      { cold: coldWithRaceDuringList(cold, retireAndRecreate, yielded), registry },
      { keep: 0 },
    );

    const row = (await registry.get(SEG))!;
    expect(row.status).toBe('active');
    expect(row.currentGen).toBe(0); // the pointer regressed — a different segment wearing the same name
    expect(yielded).toContain(0); // the listing really did enumerate the new incarnation's object
    expect(deleted).not.toContain(0);
    expect(await generations(cold)).toContain(0);
  });

  it('refuses when the tombstone row is purged mid-pass, even before anything is recreated', async () => {
    // The sweep purges tombstone rows on its own schedule, so "row gone" is reachable without a
    // resurrection. Purged-and-idle is indistinguishable from purged-and-about-to-be-recreated, and the top
    // of `gcOrphanGenerations` already declines to act without an authoritative row — so this must refuse
    // rather than treat a missing row as permission.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]);
    await load([1, 2]);
    const rec = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });

    const purge = async (): Promise<void> => {
      const row = await registry.get(SEG);
      if (row !== null) await registry.delete(SEG);
    };

    await expect(
      gcOrphanGenerations(SEG, { cold: coldWithRaceDuringList(cold, purge), registry }),
    ).rejects.toBeInstanceOf(WriteConflictError);
    expect(await generations(cold)).toEqual([0, 1]);
  });

  it('an ORDINARY pass still collects when a publish lands mid-listing', async () => {
    // The other half of the ordinary branch's contract. It DOES re-read — it has to, per the test above — but
    // it reconciles rather than refuses: the cutoff is the LOWER of the two pointers, so a publish landing
    // mid-listing moves the pointer FORWARD and changes nothing. Refusing on any token change instead would
    // make routine GC refuse whenever a load lands during a listing, which on a busy segment is most of the
    // time. This is the test that says so.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]); // gen 0
    await load([1, 2]); // gen 1
    await load([1, 2, 3]); // gen 2 — current

    const publishDuring = async (): Promise<void> => {
      await load([4]); // gen 3 lands while GC is listing
    };

    const yielded: number[] = [];
    const deleted = await gcOrphanGenerations(
      SEG,
      { cold: coldWithRaceDuringList(cold, publishDuring, yielded), registry },
      { keep: 0 },
    );
    expect(yielded).toContain(3); // the mid-pass publish was enumerated — the control is not vacuous
    // Generations below the pointer GC read (2) are collected; the one published mid-pass is untouched. A
    // FORWARD publish must not narrow the cutoff, or routine GC would refuse on every busy segment.
    expect([...deleted].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await generations(cold)).toEqual([2, 3]);
  });

  it('refuses when the incarnation changes DURING the delete loop, not just the listing', async () => {
    // Re-reading the row after the listing proves the segment was intact at one INSTANT. The deletes are one
    // round trip each, so the exposure is the whole loop — and the ordinary branch deletes newest-first, which
    // puts a restarted incarnation's generation 0 last, the worst possible ordering. Here the row is perfectly
    // consistent across the listing and every check up to the first delete; the retirement lands after it.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    for (let i = 0; i <= 5; i++) await load([i]); // gens 0..5, current = 5

    // Fire once, after the FIRST cold.delete has landed.
    let fired = false;
    const coldWithRaceDuringDeletes = new Proxy(cold, {
      get(target, prop, rx) {
        if (prop !== 'delete') return Reflect.get(target, prop, rx) as unknown;
        return async (key: { namespace?: string; segment: string; generation: number }) => {
          await cold.delete(key);
          if (fired) return;
          fired = true;
          for (const g of await generations(cold)) await cold.delete({ ...SEG, generation: g });
          await registry.delete(SEG); // the sweep purges the tombstone row
          await load([99]); // a loader re-creates the name — nextGeneration restarts at 0
        };
      },
    }) as IColdDriver;

    await expect(
      gcOrphanGenerations(SEG, { cold: coldWithRaceDuringDeletes, registry }, { keep: 0 }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    const row = (await registry.get(SEG))!;
    expect(row.currentGen).toBe(0);
    // The new incarnation's live object survived: without the per-delete check the loop would have carried on
    // down its queue and taken generation 0 last.
    expect(await generations(cold)).toContain(0);
  });

  it('a listing that yields a generation twice does not eat the grace window', async () => {
    // `keep` is a count of generations, not of listing entries. A paginated listing that spans a
    // purge-and-recreate can enumerate the same number twice — the objects are re-created under the numbers
    // just swept — and a duplicate would then consume the one keep slot and evict a generation that is still
    // inside the grace window. That matters beyond storage: a pinned read does not heal forward, it fails, so
    // `keep` is sized against the longest pinned job.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]); // gen 0
    await load([1, 2]); // gen 1 — the grace window
    await load([1, 2, 3]); // gen 2 — current

    const doubleListing = new Proxy(cold, {
      get(target, prop, rx) {
        if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
        return async function* (ref: SegmentRef): AsyncIterable<GenKey> {
          for await (const key of cold.list(ref)) {
            yield key;
            yield key; // the same object, seen twice
          }
        };
      },
    }) as IColdDriver;

    const deleted = await gcOrphanGenerations(SEG, { cold: doubleListing, registry }, { keep: 1 });
    expect(deleted).toEqual([0]); // only the one outside the window
    expect(await generations(cold)).toEqual([1, 2]); // the grace window survived
  });

  it('TOMBSTONE branch: refuses when the incarnation changes during the delete loop', async () => {
    // The mirror of the ordinary-branch loop test, on the branch that deletes at and above `currentGen`. This
    // branch deletes ASCENDING, so a restarted incarnation's low generations land INSIDE the queue still being
    // walked — the pass would carry on and delete objects that now belong to a live segment.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    for (let i = 0; i <= 5; i++) await load([i]); // gens 0..5
    const rec = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });

    // After the first delete: another collector finishes the job and the sweep purges the row, then a loader
    // re-creates the name. `nextGeneration` restarts at 0, so the new generations reuse numbers still queued.
    let fired = false;
    const coldWithRaceDuringDeletes = new Proxy(cold, {
      get(target, prop, rx) {
        if (prop !== 'delete') return Reflect.get(target, prop, rx) as unknown;
        return async (key: { namespace?: string; segment: string; generation: number }) => {
          await cold.delete(key);
          if (fired) return;
          fired = true;
          for (const g of await generations(cold)) await cold.delete({ ...SEG, generation: g });
          await registry.delete(SEG);
          await load([7]); // gen 0
          await load([8]); // gen 1
          await load([9]); // gen 2 — current
        };
      },
    }) as IColdDriver;

    await expect(
      gcOrphanGenerations(SEG, { cold: coldWithRaceDuringDeletes, registry }),
    ).rejects.toBeInstanceOf(WriteConflictError);

    const row = (await registry.get(SEG))!;
    expect(row.status).toBe('active');
    expect(row.currentGen).toBe(2);
    // The live pointer's object survived: without the per-delete token check the ascending queue walks straight
    // through the new incarnation's generations and empties the bucket under an active row.
    expect(await generations(cold)).toContain(2);
  });

  it('still collects everything on a tombstone that stays a tombstone', async () => {
    // The control. The fence must not cost the destroyed branch its whole purpose, which is that these
    // objects are billed forever and nothing else in the library would ever collect them.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const load = async (ids: number[]) => {
      const generation = await nextGeneration(SEG, { cold, registry });
      await bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    };
    await load([1]);
    await load([1, 2]);
    const rec = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });

    expect([...(await gcOrphanGenerations(SEG, { cold, registry }))].sort((a, b) => a - b)).toEqual(
      [0, 1],
    );
    expect(await generations(cold)).toEqual([]);
  });
});
