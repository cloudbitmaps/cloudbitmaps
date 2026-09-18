import { collect, loadedStore } from '../helpers/loaded';

/**
 * **An empty combine must not silently replace the destination.**
 *
 * WHY THIS FILE EXISTS. `load()` has refused to publish an empty generation over a non-empty one since it
 * shipped, because an empty result is far more often an upstream failure than an intent and is
 * indistinguishable from success once it lands. The `*Into` verbs write generations of a destination through
 * exactly the same protocol and had **no such guard**: `a.intersectInto(dest, [b])` where the intersection
 * came out empty wiped `dest` and reported a fresh generation number, reachable without passing any option.
 *
 * The narrow case where an operand had EXPIRED was already refused (`materialize-expiry-guard.test.ts`).
 * This is the general one: a typo'd operand, an `exclude` that swallowed everything, an operand that has not
 * loaded yet — every shape that produces an empty result on live handles.
 *
 * The verbs now route through `loadSegment`, so what is pinned here is not just "empty is refused" but that
 * the whole guard came with it: the plausibility bounds, the reported (not thrown) refusal, and — the part
 * that is easy to get wrong — that a refusal leaves the destination's PREVIOUS generation readable.
 */
describe('the *Into verbs refuse an implausible result instead of publishing it', () => {
  it('refuses an empty intersection over a non-empty destination, and dest still reads', async () => {
    const { store } = await loadedStore({ a: [1, 2, 3], b: [7, 8, 9], dest: [100, 200] });
    const res = await store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')]);

    expect(res.published).toBe(false);
    expect(res.reason).toBe('empty');
    expect(res.cardinality).toBe(0);
    expect(res.cardinalityBefore).toBe(2);
    // The destination is untouched — this is the assertion the whole guard exists for.
    expect(await collect(store.segment('dest').iterate())).toEqual([100, 200]);
    expect(await store.segment('dest').count()).toBe(2);
  });

  it('allows the empty write when emptying the destination is the point', async () => {
    const { store } = await loadedStore({ a: [1, 2, 3], b: [7, 8, 9], dest: [100, 200] });
    const res = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')], { allowEmpty: true });

    expect(res.published).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(await collect(store.segment('dest').iterate())).toEqual([]);
  });

  it('publishes an empty result into a destination that was already empty', async () => {
    // Nothing is lost, so there is nothing to protect: the guard compares against what `dest` HELD.
    const { store } = await loadedStore({ a: [1, 2, 3], b: [7, 8, 9] });
    const res = await store
      .segment('a')
      .intersectInto(store.segment('fresh'), [store.segment('b')]);
    expect(res.published).toBe(true);
    expect(res.cardinalityBefore).toBeNull();
  });

  it('honours minCardinality, and reports what the destination held', async () => {
    const { store } = await loadedStore({ a: [1, 2, 3, 4], b: [3, 4], dest: [1, 2, 3, 4, 5] });
    const res = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')], { guard: { minCardinality: 3 } });

    expect(res.published).toBe(false);
    expect(res.reason).toBe('min-cardinality');
    expect(res.cardinality).toBe(2); // the result WAS computed — it is the publish that was refused
    expect(res.cardinalityBefore).toBe(5);
    expect(await store.segment('dest').count()).toBe(5);
  });

  it('honours minRetained against the destination, not against the operands', async () => {
    const { store } = await loadedStore({
      a: [1, 2, 3, 4],
      b: [3, 4],
      dest: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    const res = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')], { guard: { minRetained: 0.5 } });

    expect(res.published).toBe(false);
    expect(res.reason).toBe('min-retained');
    expect(res.cardinalityBefore).toBe(8); // 2 of 8 survives — below the half the bound demands
  });

  it('publishes normally when the result is plausible', async () => {
    const { store } = await loadedStore({ a: [1, 2, 3, 4], b: [3, 4], dest: [9] });
    const res = await store
      .segment('a')
      .intersectInto(store.segment('dest'), [store.segment('b')], { guard: { minCardinality: 2 } });

    expect(res.published).toBe(true);
    expect(res.cardinality).toBe(2);
    expect(await collect(store.segment('dest').iterate())).toEqual([3, 4]);
  });

  it('guards unionInto and andNotInto too, not only intersectInto', async () => {
    // All three go through one `materialize`, but a reader should not have to know that to trust it.
    const { store } = await loadedStore({ a: [1, 2], b: [1, 2], dest: [100] });

    // `a \ b` is empty.
    const andNot = await store.segment('a').andNotInto(store.segment('dest'), [store.segment('b')]);
    expect(andNot.published).toBe(false);
    expect(andNot.reason).toBe('empty');
    expect(await store.segment('dest').count()).toBe(1);

    // A union of live operands cannot be empty, so use the bound to force the refusal.
    const union = await store
      .segment('a')
      .unionInto(store.segment('dest'), [store.segment('b')], { guard: { minCardinality: 99 } });
    expect(union.published).toBe(false);
    expect(union.reason).toBe('min-cardinality');
    expect(await store.segment('dest').count()).toBe(1);
  });

  it('a refused materialisation leaves no generation above the destination pointer', async () => {
    // The object is written before the guard judges it, so a refusal has to reclaim it. Otherwise every
    // refused combine leaks an object that collection never looks at (it sits ABOVE `currentGen`).
    const { store, storage, registry } = await loadedStore({
      a: [1, 2, 3],
      b: [7, 8, 9],
      dest: [100],
    });
    const ref = { segment: 'dest' };
    const before = await registry.get(ref);

    await store.segment('a').intersectInto(store.segment('dest'), [store.segment('b')]);

    const after = await registry.get(ref);
    expect(after?.currentGen).toBe(before?.currentGen); // the pointer did not move
    for await (const key of storage.list(ref)) {
      expect(
        key.generation,
        `generation ${key.generation} was left above the pointer by a refused materialisation`,
      ).toBeLessThanOrEqual(after?.currentGen ?? -1);
    }
  });
});
