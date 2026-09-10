import { gcOrphanGenerations, nextGeneration } from '@/core/generation-gc';
import { bulkLoadCrbmGeneration } from '@/index';
import type { IColdDriver, SegmentRef } from '@/index';
import { loadedStore } from '../helpers/loaded';

/**
 * Generation bookkeeping for the loaded store: which number the next object takes, and which superseded objects
 * may be collected.
 *
 * Both consult the registry pointer AND the bucket, because they can disagree: a load that wrote its object and
 * crashed before publishing leaves an object above `currentGen`. `nextGeneration` must skip past it (or every
 * retry hits the write-once conflict on the same number), and `gcOrphanGenerations` must never delete anything
 * at or above the pointer, since that object may be a publish about to land.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

async function generations(cold: IColdDriver, ref: SegmentRef): Promise<number[]> {
  const gens: number[] = [];
  for await (const key of cold.list(ref)) gens.push(key.generation);
  return gens.sort((a, b) => a - b);
}

/** An object in the bucket with no publish behind it — what a crashed load leaves. */
const stage = (cold: IColdDriver, generation: number): Promise<unknown> =>
  bulkLoadCrbmGeneration(cold, { ...SEG, generation }, [9]);

const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

describe('nextGeneration', () => {
  it('is 0 for a segment with no row and no objects', async () => {
    const w = await loadedStore();
    expect(await nextGeneration(SEG, w)).toBe(0);
  });

  it('is currentGen + 1, and advances with every load', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]);
    expect(await nextGeneration(SEG, w)).toBe(1);
    await w.load(SEG, [1, 2]);
    expect(await nextGeneration(SEG, w)).toBe(2);
  });

  it('skips past a staged, unpublished object above currentGen', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]); // currentGen 0
    await stage(w.cold, 3);
    expect(await nextGeneration(SEG, w)).toBe(4); // not 1 — that would collide with nothing, but 3 would be shadowed
  });

  it('counts objects even when there is no row at all', async () => {
    const w = await loadedStore();
    await stage(w.cold, 2);
    expect(await nextGeneration(SEG, w)).toBe(3);
  });

  it('treats a null-gen row as no pointer — objects in the bucket still count', async () => {
    const w = await loadedStore();
    await w.registry.create(SEG, { currentGen: null });
    expect(await nextGeneration(SEG, w)).toBe(0);
    await stage(w.cold, 1);
    expect(await nextGeneration(SEG, w)).toBe(2);
  });
});

describe('gcOrphanGenerations', () => {
  it('keeps the newest superseded generation by default (keep: 1) — the grace window for pinned readers', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]);
    await w.load(SEG, [1, 2]);
    await w.load(SEG, [1, 2, 3]); // currentGen 2
    expect(await gcOrphanGenerations(SEG, w)).toEqual([0]);
    expect(await generations(w.cold, SEG)).toEqual([1, 2]);
  });

  it('keep: 0 collects every superseded generation', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]);
    await w.load(SEG, [1, 2]);
    await w.load(SEG, [1, 2, 3]);
    expect(sorted(await gcOrphanGenerations(SEG, w, { keep: 0 }))).toEqual([0, 1]);
    expect(await generations(w.cold, SEG)).toEqual([2]);
  });

  it('a negative keep behaves like 0', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]);
    await w.load(SEG, [1, 2]);
    expect(await gcOrphanGenerations(SEG, w, { keep: -1 })).toEqual([0]);
  });

  it('never touches the current generation or anything above it', async () => {
    // An object above the pointer is either a load about to publish or a crashed load's orphan; the two are
    // indistinguishable here, and deleting the former would race its publish into a dangling pointer.
    const w = await loadedStore();
    await w.load(SEG, [1]);
    await w.load(SEG, [1, 2]); // currentGen 1
    await stage(w.cold, 5);
    expect(await gcOrphanGenerations(SEG, w, { keep: 0 })).toEqual([0]);
    expect(await generations(w.cold, SEG)).toEqual([1, 5]);
  });

  it('a destroyed row collects EVERYTHING — current and above included', async () => {
    // A tombstoned segment resolves no generation, so no reader is or can become pinned to one, and nothing else
    // in the library would ever collect these objects.
    const w = await loadedStore();
    await w.load(SEG, [1]);
    await w.load(SEG, [1, 2]);
    const rec = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });
    await stage(w.cold, 7); // a load that was mid-write when the tombstone landed
    expect(sorted(await gcOrphanGenerations(SEG, w))).toEqual([0, 1, 7]);
    expect(await generations(w.cold, SEG)).toEqual([]);
  });

  it('a null-gen row collects nothing — there is no pointer to be below', async () => {
    const w = await loadedStore();
    await w.registry.create(SEG, { currentGen: null });
    await stage(w.cold, 0);
    expect(await gcOrphanGenerations(SEG, w, { keep: 0 })).toEqual([]);
    expect(await generations(w.cold, SEG)).toEqual([0]);
  });

  it('no row collects nothing — no authoritative pointer, no deletion', async () => {
    const w = await loadedStore();
    await stage(w.cold, 0);
    await stage(w.cold, 1);
    expect(await gcOrphanGenerations(SEG, w, { keep: 0 })).toEqual([]);
    expect(await generations(w.cold, SEG)).toEqual([0, 1]);
  });

  it('returns exactly the generations it deleted', async () => {
    const w = await loadedStore();
    await w.load(SEG, [1]);
    await w.load(SEG, [1, 2]);
    await w.load(SEG, [1, 2, 3]);
    const before = await generations(w.cold, SEG);
    const collected = await gcOrphanGenerations(SEG, w, { keep: 0 });
    const after = await generations(w.cold, SEG);
    expect(sorted(collected)).toEqual(before.filter((g) => !after.includes(g)));
  });
});
