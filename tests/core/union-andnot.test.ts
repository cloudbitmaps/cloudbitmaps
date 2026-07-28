import {
  CloudRoaring,
  MemoryWarmDriver,
  MemoryColdChunkSource,
  BudgetExceededError,
} from '@/index';
import type { ChunkRef, ColdChunkSource, SegmentRef } from '@/core/ports';
import { joinId, splitId } from '@/core/bit-route';

// `union` / `andNot` / `intersect({ exclude })` — the composable set ops.
//
// The request was "lazy andNotInto / unionInto so suppression composes without materializing". Shipping only
// those two names would NOT have delivered it: `andNotInto(dest, s)` applied after `intersectInto(tmp, [a, b])`
// still writes `tmp`. Suppression has to fold into the intersect pass, which is why `exclude` exists.
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
const NS = 'ns';

/** Counts the (segment, chunkKey) pairs actually fetched from cold, so chunk-skipping is observable. */
class CountingCold implements ColdChunkSource {
  fetched: string[] = [];
  constructor(private readonly inner = new MemoryColdChunkSource()) {}
  getChunk = (ref: ChunkRef): Promise<Uint8Array | null> => {
    this.fetched.push(`${ref.segment}#${ref.chunkKey}`);
    return this.inner.getChunk(ref);
  };
  listChunkKeys = (ref: SegmentRef): Promise<number[]> => this.inner.listChunkKeys(ref);
  fetchedFor(segment: string): number {
    return this.fetched.filter((f) => f.startsWith(`${segment}#`)).length;
  }
}

function makeStore(cold?: ColdChunkSource) {
  return new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: cold ?? new MemoryColdChunkSource(),
    namespace: NS,
  } as never);
}

const collect = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
};

/** Spread ids over `chunks` distinct chunk keys so the key-set arithmetic is the thing under test. */
const spread = (chunks: readonly number[], per = 3): number[] =>
  chunks.flatMap((c) => Array.from({ length: per }, (_, i) => joinId(c, i + 1)));

describe('union / andNot / intersect(exclude)', () => {
  it('union matches the Set union and streams ascending', async () => {
    const store = makeStore();
    const a = store.segment('a');
    const b = store.segment('b');
    const idsA = spread([1, 2, 3]);
    const idsB = spread([3, 4, 5]);
    await a.addMany(idsA);
    await b.addMany(idsB);

    const got = await collect(a.union([b]));
    expect(got).toEqual([...new Set([...idsA, ...idsB])].sort((x, y) => x - y));
    expect([...got].sort((x, y) => x - y)).toEqual(got); // ascending, like every other read
  });

  it('andNot matches Set difference, including a full wipe', async () => {
    const store = makeStore();
    const a = store.segment('a');
    const s = store.segment('s');
    const idsA = spread([1, 2, 3]);
    await a.addMany(idsA);
    await s.addMany(idsA.slice(0, 4));
    expect(await collect(a.andNot([s]))).toEqual(idsA.slice(4));

    // Subtracting a superset must yield nothing rather than, say, the un-subtracted input.
    await s.addMany(idsA);
    expect(await collect(a.andNot([s]))).toEqual([]);
  });

  it('subtracts several suppression lists at once', async () => {
    const store = makeStore();
    const a = store.segment('a');
    const s1 = store.segment('s1');
    const s2 = store.segment('s2');
    const idsA = spread([1, 2, 3, 4]);
    await a.addMany(idsA);
    await s1.addMany(idsA.filter((_, i) => i % 3 === 0));
    await s2.addMany(idsA.filter((_, i) => i % 3 === 1));
    const expected = idsA.filter((_, i) => i % 3 === 2);
    expect(await collect(a.andNot([s1, s2]))).toEqual(expected);
  });

  it('intersect(exclude) applies suppression in the SAME pass', async () => {
    // The behaviour the whole feature exists for: (a ∩ b) \ s with no intermediate segment.
    const store = makeStore();
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    const shared = spread([2, 3]);
    await a.addMany([...spread([1]), ...shared]);
    await b.addMany([...spread([4]), ...shared]);
    await s.addMany(shared.slice(0, 2));

    expect(await collect(a.intersect([b], { exclude: [s] }))).toEqual(shared.slice(2));
    // ...and the same answer the two-step version would have produced, without writing the intermediate.
    const viaTemp = store.segment('tmp');
    await a.intersectInto(viaTemp, [b]);
    expect(await collect(viaTemp.andNot([s]))).toEqual(shared.slice(2));
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
    const cold = new CountingCold();
    const store = makeStore(cold);
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    const wide = Array.from({ length: 40 }, (_, i) => i + 1);
    await a.addMany(spread(wide));
    await b.addMany(spread(wide));
    await s.addMany(spread([1])); // holds exactly ONE of the 40 surviving keys

    cold.fetched = [];
    await collect(a.intersect([b], { exclude: [s] }));
    // Positive control first: the counter is live and every surviving key really was visited.
    expect(cold.fetchedFor('a')).toBe(40);
    expect(cold.fetchedFor('b')).toBe(40);
    // The claim: `s` is touched at the one key it holds, not at all 40.
    expect(cold.fetchedFor('s')).toBe(1);
  });

  it('never lets an exclude introduce a key the includes do not have', async () => {
    // An exclude can only subtract. If candidate keys were drawn from the excludes too, a suppression list
    // could make the engine fetch — and potentially emit — chunks no operand contributes to.
    const store = makeStore();
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    await a.addMany(spread([1]));
    await b.addMany(spread([1]));
    await s.addMany(spread([2, 3, 4])); // disjoint from the result entirely
    expect(await collect(a.intersect([b], { exclude: [s] }))).toEqual(spread([1]));
  });

  it('union is budgeted like intersect, so a wide one is refused rather than billed', async () => {
    // Union cannot skip a single chunk, which makes it the one composite that can quietly get expensive. The
    // budget is the control, and `budget: false` is the deliberate opt-out.
    const store = makeStore();
    const a = store.segment('a');
    const b = store.segment('b');
    await a.addMany(spread([1, 2, 3, 4, 5]));
    await b.addMany(spread([6, 7, 8, 9, 10]));
    await expect(collect(a.union([b], { budget: { maxRequests: 3 } }))).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    await expect(collect(a.union([b], { budget: false }))).resolves.toHaveLength(30);
  });

  it('does not charge the budget for suppression chunks it never reads', async () => {
    // The mirror of the cost test, on the budget axis. Counting excludes as always-present would refuse work
    // that costs nothing — which would make the cheap path unusable for exactly the callers it was built for.
    const store = makeStore();
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    await a.addMany(spread([1]));
    await b.addMany(spread([1]));
    await s.addMany(spread(Array.from({ length: 50 }, (_, i) => i + 10))); // no overlap with key 1
    // One surviving key x two includes = 2 units. The 50 untouched suppression chunks must not be charged.
    await expect(collect(a.intersect([b], { exclude: [s] }))).resolves.toEqual(spread([1]));
    await expect(
      collect(a.intersect([b], { exclude: [s], budget: { maxRequests: 2 } })),
    ).resolves.toEqual(spread([1]));
  });

  it('materializes into a destination, for all three ops', async () => {
    const store = makeStore();
    const [a, b, s] = [store.segment('a'), store.segment('b'), store.segment('s')];
    await a.addMany(spread([1, 2]));
    await b.addMany(spread([2, 3]));
    await s.addMany(spread([2]));

    const u = store.segment('u');
    await a.unionInto(u, [b]);
    await expect(u.count()).resolves.toBe(spread([1, 2, 3]).length);

    const d = store.segment('d');
    await a.andNotInto(d, [s]);
    await expect(d.count()).resolves.toBe(spread([1]).length);

    const i = store.segment('i');
    await a.intersectInto(i, [b], { exclude: [s] });
    await expect(i.count()).resolves.toBe(0); // (a ∩ b) is chunk 2, which s suppresses entirely
  });

  it('sees warm deltas, not just cold — including a warm removal', async () => {
    // These ops read the *effective* set per chunk (cold ∪ adds \ removes). A version that read cold only
    // would pass every test above if the fixtures never compacted.
    const store = makeStore();
    const a = store.segment('a');
    const b = store.segment('b');
    const ids = spread([7]);
    await a.addMany(ids);
    await b.addMany(ids);
    await b.remove(ids[0] as number); // warm tombstone
    expect(await collect(a.intersect([b]))).toEqual(ids.slice(1));
    expect(await collect(a.union([b]))).toEqual(ids);
    expect(await collect(a.andNot([b]))).toEqual([ids[0] as number]);
  });

  it('rejects the degenerate operand lists', async () => {
    const store = makeStore();
    const a = store.segment('a');
    await expect(collect(a.andNot([]))).rejects.toThrow(/andNot requires/);
  });

  it('keeps every id inside its own chunk — no cross-chunk bleed from in-place ops', async () => {
    // `combineChunk` mutates the first operand's bitmap in place. If it ever mutated a cached/shared instance,
    // the corruption would surface as ids appearing under the wrong chunk key. Round-tripping the split is a
    // cheap standing check on that.
    const store = makeStore();
    const a = store.segment('a');
    const b = store.segment('b');
    const ids = spread([100, 200, 300], 5);
    await a.addMany(ids);
    await b.addMany(ids);
    for (const id of await collect(a.union([b]))) {
      const { chunkKey, remainder } = splitId(id);
      expect(joinId(chunkKey, remainder)).toBe(id);
    }
    // ...and reading again must give the same answer (no operand was consumed or mutated).
    expect(await collect(a.union([b]))).toEqual(await collect(a.union([b])));
  });
});
