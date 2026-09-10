import { BudgetExceededError, CloudRoaring, MemoryColdChunkSource, type Clock } from '@/index';
import type { ChunkRef, ColdChunkSource, SegmentRef } from '@/core/ports';
import { joinId, splitId } from '@/core/bit-route';
import { collect, loadedStore, seedSegment } from '../helpers/loaded';

// `union` / `andNot` / `intersect({ exclude })` — the composable set ops.
//
// The request was "lazy andNotInto / unionInto so suppression composes without materializing". Shipping only
// those two names would NOT have delivered it: `andNotInto(dest, s)` applied after `intersectInto(tmp, [a, b])`
// still writes `tmp` as a generation of its own. Suppression has to fold into the intersect pass, which is why
// `exclude` exists.
//
// Two properties carry this file, and neither is "the ids are right":
//
//   1. **`exclude` reads a suppression segment only where the result survives.** That is the entire cost
//      argument — a 61,000-chunk global opt-out list must not be read in full to filter a narrow audience.
//   2. **Union reads everything.** No skipping is possible; asserting it pins the honest cost model rather
//      than letting a future "optimization" quietly return wrong answers.
//
// Correctness is checked against `Set` oracles throughout, since these are set operations and the oracle is
// trivially right.

/** Counts the (segment, chunkKey) pairs actually fetched from cold, so chunk-skipping is observable. */
class CountingCold implements ColdChunkSource {
  fetched: string[] = [];
  readonly inner = new MemoryColdChunkSource();
  getChunk = (ref: ChunkRef): Promise<Uint8Array | null> => {
    this.fetched.push(`${ref.segment}#${ref.chunkKey}`);
    return this.inner.getChunk(ref);
  };
  listChunkKeys = (ref: SegmentRef): Promise<number[]> => this.inner.listChunkKeys(ref);
  fetchedFor(segment: string): number {
    return this.fetched.filter((f) => f.startsWith(`${segment}#`)).length;
  }
}

/** A store over a counting source; `seed` writes a segment's chunks exactly as a `.crbm` generation holds them. */
function harness(): {
  cold: CountingCold;
  store: CloudRoaring;
  seed: (segment: string, ids: number[]) => void;
} {
  const cold = new CountingCold();
  const store = new CloudRoaring({ cold });
  return { cold, store, seed: (segment, ids) => void seedSegment(cold.inner, segment, ids) };
}

function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

/** Spread ids over `chunks` distinct chunk keys so the key-set arithmetic is the thing under test. */
const spread = (chunks: readonly number[], per = 3): number[] =>
  chunks.flatMap((c) => Array.from({ length: per }, (_, i) => joinId(c, i + 1)));

describe('union / andNot / intersect(exclude)', () => {
  it('union matches the Set union and streams ascending', async () => {
    const { store, seed } = harness();
    const idsA = spread([1, 2, 3]);
    const idsB = spread([3, 4, 5]);
    seed('a', idsA);
    seed('b', idsB);

    const got = await collect(store.segment('a').union([store.segment('b')]));
    expect(got).toEqual([...new Set([...idsA, ...idsB])].sort((x, y) => x - y));
    expect([...got].sort((x, y) => x - y)).toEqual(got); // ascending, like every other read
  });

  it('andNot matches Set difference, including a full wipe', async () => {
    const { store, seed } = harness();
    const idsA = spread([1, 2, 3]);
    seed('a', idsA);
    seed('s', idsA.slice(0, 4));
    seed('superset', idsA);
    const a = store.segment('a');
    expect(await collect(a.andNot([store.segment('s')]))).toEqual(idsA.slice(4));

    // Subtracting a superset must yield nothing rather than, say, the un-subtracted input.
    expect(await collect(a.andNot([store.segment('superset')]))).toEqual([]);
  });

  it('subtracts several suppression lists at once', async () => {
    const { store, seed } = harness();
    const idsA = spread([1, 2, 3, 4]);
    seed('a', idsA);
    seed(
      's1',
      idsA.filter((_, i) => i % 3 === 0),
    );
    seed(
      's2',
      idsA.filter((_, i) => i % 3 === 1),
    );
    const expected = idsA.filter((_, i) => i % 3 === 2);
    expect(
      await collect(store.segment('a').andNot([store.segment('s1'), store.segment('s2')])),
    ).toEqual(expected);
  });

  it('intersect(exclude) applies suppression in the SAME pass', async () => {
    // The behaviour the whole feature exists for: (a ∩ b) \ s with no intermediate segment.
    const { store, seed } = harness();
    const shared = spread([2, 3]);
    seed('a', [...spread([1]), ...shared]);
    seed('b', [...spread([4]), ...shared]);
    seed('s', shared.slice(0, 2));
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    expect(await collect(a.intersect([b], { exclude: [s] }))).toEqual(shared.slice(2));
  });

  it('never fetches a suppression chunk at a key that list does not hold — the cost argument', async () => {
    // THE COST TEST, and getting it right took two attempts. The first version used a *wide* suppression list
    // against a *narrow* audience and asserted "few fetches for s" — which passes no matter what the code
    // does, because the loop only ever visits surviving keys anyway. It could not tell the implementations
    // apart, and a mutation run proved it: removing the presence filter left it green.
    //
    // The property that actually belongs to the filter is the inverse shape: a **wide audience** against a
    // **narrow** suppression list. Every surviving key is visited, and at all but one of them `s` holds
    // nothing — so a fetch there is pure waste. That is the thing worth asserting.
    const { cold, store, seed } = harness();
    const wide = Array.from({ length: 40 }, (_, i) => i + 1);
    seed('a', spread(wide));
    seed('b', spread(wide));
    seed('s', spread([1])); // holds exactly ONE of the 40 surviving keys
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];

    await collect(a.intersect([b], { exclude: [s] }));
    // Positive control first: the counter is live and every surviving key really was visited.
    expect(cold.fetchedFor('a')).toBe(40);
    expect(cold.fetchedFor('b')).toBe(40);
    // The claim: `s` is touched at the one key it holds, not at all 40.
    expect(cold.fetchedFor('s')).toBe(1);
  });

  it('never lets an exclude introduce a key the includes do not have', async () => {
    // An exclude can only subtract. If candidate keys were drawn from the excludes too, the engine would fetch
    // chunks no include contributes to — pure waste.
    //
    // The RESULT cannot show this: under mode 'all' the `operands.every(...)` filter is a second independent
    // guard, and even a wrongly-admitted key returns null from an empty AND. Adding exclude keys to
    // `candidates` therefore leaves the ids unchanged and only costs money — so this asserts on FETCHES.
    const { cold, store, seed } = harness();
    seed('a', spread([1]));
    seed('b', spread([1]));
    seed('s', spread([2, 3, 4])); // disjoint from the result entirely
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];

    expect(await collect(a.intersect([b], { exclude: [s] }))).toEqual(spread([1]));
    expect(cold.fetchedFor('a')).toBe(1); // positive control: the counter is live
    expect(cold.fetchedFor('s')).toBe(0); // the claim: a disjoint suppression list is never touched
  });

  it('applies exclude on the UNION path too — the mode with no chunk-skipping', async () => {
    // `union` accepts `exclude` and nothing exercised it. It is also the mode where a wrongly-admitted exclude
    // key WOULD change the result, since 'any' has no second guard to catch it.
    const { cold, store, seed } = harness();
    seed('a', spread([1, 2]));
    seed('b', spread([3]));
    seed('s', [...spread([2]), ...spread([9])]); // overlaps key 2; key 9 is in neither include
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];

    expect(await collect(a.union([b], { exclude: [s] }))).toEqual(spread([1, 3]));
    expect(cold.fetchedFor('s')).toBe(1); // only key 2 — never key 9, which no include holds
  });

  it('union reads every chunk of every operand — the cost model it publishes', async () => {
    // The file header calls this one of the two properties it exists to pin. Union cannot prune: an id in ANY
    // operand belongs to the result, so every operand is read at every key it holds.
    const { cold, store, seed } = harness();
    seed('a', spread([1, 2, 3])); // 3 keys
    seed('b', spread([3, 4])); // 2 keys, overlapping on one

    await collect(store.segment('a').union([store.segment('b')]));
    expect(cold.fetchedFor('a')).toBe(3);
    expect(cold.fetchedFor('b')).toBe(2);
  });

  it('union is budgeted like intersect, so a wide one is refused rather than billed', async () => {
    // Union cannot skip a single chunk, which makes it the one composite that can quietly get expensive. The
    // budget is the control, and `budget: false` is the deliberate opt-out.
    const { store, seed } = harness();
    seed('a', spread([1, 2, 3, 4, 5]));
    seed('b', spread([6, 7, 8, 9, 10]));
    const a = store.segment('a');
    const b = store.segment('b');
    await expect(collect(a.union([b], { budget: { maxRequests: 3 } }))).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    await expect(collect(a.union([b], { budget: false }))).resolves.toHaveLength(30);
  });

  it('does not charge the budget for suppression chunks it never reads', async () => {
    // The mirror of the cost test, on the budget axis. Counting excludes as always-present would refuse work
    // that costs nothing — which would make the cheap path unusable for exactly the callers it was built for.
    const { store, seed } = harness();
    seed('a', spread([1]));
    seed('b', spread([1]));
    seed('s', spread(Array.from({ length: 50 }, (_, i) => i + 10))); // no overlap with key 1
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    // One surviving key x two includes = 2 units. The 50 untouched suppression chunks must not be charged.
    await expect(collect(a.intersect([b], { exclude: [s] }))).resolves.toEqual(spread([1]));
    await expect(
      collect(a.intersect([b], { exclude: [s], budget: { maxRequests: 2 } })),
    ).resolves.toEqual(spread([1]));
  });

  it('rejects the degenerate operand lists', async () => {
    const { store } = harness();
    await expect(collect(store.segment('a').andNot([]))).rejects.toThrow(/andNot requires/);
  });

  it('keeps every id inside its own chunk, and re-reads identically — operands are not consumed', async () => {
    // REWRITTEN. The first version asserted `joinId(splitId(id)) === id` — an algebraic identity of
    // `bit-route` that holds for every u32 no matter what the engine did — and then compared `union()` to
    // `union()`. It had zero live assertions: replacing `union`'s body with an empty generator left it green.
    //
    // What it should check is that the output IS the expected set, and that the chunk keys present are
    // exactly the ones written — that is what a cross-chunk bleed would disturb.
    const { store, seed } = harness();
    const ids = spread([100, 200, 300], 5);
    seed('a', ids);
    seed('b', ids);
    const a = store.segment('a');
    const b = store.segment('b');

    const first = await collect(a.union([b]));
    expect(first).toEqual(ids); // the actual set, not a self-comparison
    expect([...new Set(first.map((id) => splitId(id).chunkKey))].sort((x, y) => x - y)).toEqual([
      100, 200, 300,
    ]);
    // `combineChunk` ORs into a clone of the first operand's chunk, so a second read must be unaffected.
    expect(await collect(a.union([b]))).toEqual(ids);
  });
});

describe('*Into — each op materializes a NEW GENERATION of its destination', () => {
  it('unionInto / andNotInto / intersectInto(exclude) write exactly what the streamed read yields', async () => {
    const { store, registry } = await loadedStore({
      a: spread([1, 2]),
      b: spread([2, 3]),
      s: spread([2]),
    });
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];

    const u = await a.unionInto(store.segment('u'), [b]);
    expect(u).toMatchObject({
      generation: 0,
      cardinality: spread([1, 2, 3]).length,
      chunkCount: 3,
    });
    expect(await collect(store.segment('u').iterate())).toEqual(await collect(a.union([b])));

    const d = await a.andNotInto(store.segment('d'), [s]);
    expect(d).toMatchObject({ generation: 0, cardinality: 3, chunkCount: 1 });
    expect(await collect(store.segment('d').iterate())).toEqual(spread([1]));

    const i = await a.intersectInto(store.segment('i'), [b], { exclude: [s] });
    // (a ∩ b) is chunk 2, which s suppresses entirely — an empty result is still a published generation.
    expect(i).toMatchObject({ generation: 0, cardinality: 0, chunkCount: 0 });
    expect(await store.segment('i').count()).toBe(0);
    expect((await registry.get({ segment: 'i' }))!.currentGen).toBe(0);
  });

  it('the two-step (materialize, then subtract) and the one-pass exclude agree', async () => {
    const shared = spread([2, 3]);
    const { store } = await loadedStore({
      a: [...spread([1]), ...shared],
      b: [...spread([4]), ...shared],
      s: shared.slice(0, 2),
    });
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    const onePass = await collect(a.intersect([b], { exclude: [s] }));
    expect(onePass).toEqual(shared.slice(2));
    // ...and the same answer the two-step version produces — which costs an intermediate generation.
    await a.intersectInto(store.segment('tmp'), [b]);
    expect(await collect(store.segment('tmp').andNot([s]))).toEqual(onePass);
  });

  it('the destination is REPLACED — a prior generation of it does not survive a unionInto', async () => {
    const clock = fakeClock();
    const { store, registry } = await loadedStore(
      { a: spread([1]), b: spread([2]), dest: spread([9]) },
      { clock, coldGenTtlMs: 1 },
    );
    const dest = store.segment('dest');
    expect(await dest.count()).toBe(3); // its own generation 0

    const result = await store.segment('a').unionInto(dest, [store.segment('b')]);
    expect(result.generation).toBe(1);
    expect((await registry.get({ segment: 'dest' }))!.currentGen).toBe(1);

    clock.advance(1); // the reader's generation snapshot refreshes after coldGenTtlMs
    expect(await collect(dest.iterate())).toEqual(spread([1, 2])); // chunk 9 is gone — nothing was merged
    expect(await dest.count()).toBe(6);
  });
});
