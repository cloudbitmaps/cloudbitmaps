import fc from 'fast-check';
import { collect, loadedStore } from './helpers/loaded';

/**
 * Property tests against a `Set` oracle (I2, V4, V5). Every generation here is written through the real load
 * path (`bulkLoadCrbmGeneration` + publish), so the properties hold over the shape production actually stores:
 * a published `.crbm` generation, read back chunk by chunk.
 *
 * The oracle is a plain `Set` — deliberately the dumbest possible model of "a segment is a set of u32". Any
 * divergence (a dropped chunk, a mis-routed remainder, a stale generation, an exclude applied at the wrong
 * key) shows up as a mismatch against it.
 */

// IDs spanning ~5 chunks so multi-chunk routing is exercised.
const ID = fc.integer({ min: 0, max: 300_000 });
const idSet = fc.uniqueArray(ID, { maxLength: 40 });

/**
 * The ids where chunk routing is most likely to be wrong: the first and last remainder of a chunk, the first
 * remainder of the next one, and the top of the u32 range. Drawn from explicitly, because a uniform integer
 * generator effectively never produces them.
 */
const BOUNDARY = [0, 1, 65_534, 65_535, 65_536, 65_537, 131_071, 131_072, 4_294_967_295];

/**
 * Operands drawn from ONE shared universe, which is what makes the set-algebra properties mean anything.
 *
 * Generating each operand independently from `fc.integer({ max: 300_000 })` is the obvious spelling and it is
 * close to useless here: measured over the real 100-run configuration, **one** run in a hundred produced a
 * non-empty `a ∩ b`, none produced identical operands, none produced an `exclude` that removed everything, and
 * none touched a chunk boundary. So the intersect and exclude assertions were comparing `[]` against `[]`
 * almost every run — a mis-routed remainder or a suppression applied at the wrong key would have been seen
 * about once per hundred runs, and shrinking would have walked straight back off it.
 *
 * Drawing three subsets of a small shared universe fixes the overlap by construction: subsets of the same
 * handful of ids intersect often, sometimes coincide, and sometimes nest. {@link REACH} keeps it honest — a
 * generator that stops reaching those shapes fails a test instead of quietly weakening every property below it.
 */
const universe = fc.uniqueArray(
  fc.oneof(
    { weight: 3, arbitrary: ID },
    { weight: 2, arbitrary: fc.constantFrom(...BOUNDARY) },
    // A tight cluster, so several ids share one chunk and the intra-chunk bit math is exercised too.
    { weight: 2, arbitrary: fc.integer({ min: 65_500, max: 65_600 }) },
  ),
  { minLength: 1, maxLength: 24 },
);

/** Three subsets of one universe: `a`, `b`, and a suppression list. */
const operands = universe.chain((u) => fc.tuple(fc.subarray(u), fc.subarray(u), fc.subarray(u)));

/** The oracle's answer shape: distinct ids, ascending — exactly what every read path promises. */
const asc = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);

/** A clock whose time only moves when the test says so, so a generation TTL is a decision, not a race. */
function fakeClock(): { now: () => number; sleep: () => Promise<void>; advance: () => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: () => void (t += 1) };
}

/**
 * The generator's own test. Every property below is only as strong as the shapes this reaches, and that reach
 * was silently near-zero once already — so it is asserted rather than assumed, on the same sample size the
 * properties run at.
 */
describe('the operand generator actually reaches the interesting shapes', () => {
  it('produces overlap, coincidence, nesting, boundary ids and total suppression', () => {
    const sample = fc.sample(operands, { numRuns: 200, seed: 1 });
    const reach = { overlap: 0, identical: 0, disjoint: 0, boundary: 0, excludesAll: 0, nested: 0 };
    for (const [a, b, sup] of sample) {
      const A = new Set(a);
      const B = new Set(b);
      const S = new Set(sup);
      const inter = [...A].filter((x) => B.has(x));
      if (inter.length > 0) reach.overlap += 1;
      if (A.size > 0 && A.size === B.size && [...A].every((x) => B.has(x))) reach.identical += 1;
      if (A.size > 0 && B.size > 0 && inter.length === 0) reach.disjoint += 1;
      if ([...A, ...B].some((x) => BOUNDARY.includes(x))) reach.boundary += 1;
      if (A.size > 0 && [...A].every((x) => S.has(x))) reach.excludesAll += 1;
      if (A.size > 0 && A.size < B.size && [...A].every((x) => B.has(x))) reach.nested += 1;
    }
    // Deliberately loose floors: this asserts the generator is not degenerate, not that it hits a quota. The
    // pre-fix generator scored 1 / 0 / — / 0 / 0 / 0 on these six over the same sample size.
    expect(reach.overlap).toBeGreaterThan(40);
    expect(reach.identical).toBeGreaterThan(2);
    expect(reach.disjoint).toBeGreaterThan(2);
    expect(reach.boundary).toBeGreaterThan(20);
    expect(reach.excludesAll).toBeGreaterThan(2);
    expect(reach.nested).toBeGreaterThan(5);
  });
});

describe('loaded segment vs Set oracle (I2, V4, V5)', () => {
  it('has / count / iterate match the loaded set', async () => {
    await fc.assert(
      fc.asyncProperty(idSet, async (ids) => {
        const { store } = await loadedStore({ s: ids });
        const oracle = new Set(ids);
        const seg = store.segment('s');

        expect(await seg.count()).toBe(oracle.size);
        expect(await collect(seg.iterate())).toEqual(asc(ids));
        // has() is two-sided: true for members, false for non-members.
        for (const id of asc(ids).slice(0, 5)) expect(await seg.has(id)).toBe(true);
        for (const id of [7, 99_999, 200_001, 300_000]) {
          expect(await seg.has(id)).toBe(oracle.has(id));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('intersect / union / andNot match the set algebra, excludes included', async () => {
    await fc.assert(
      fc.asyncProperty(operands, async ([aIds, bIds, supIds]) => {
        const { store } = await loadedStore({ a: aIds, b: bIds, sup: supIds });
        const A = new Set(aIds);
        const B = new Set(bIds);
        const S = new Set(supIds);
        const a = store.segment('a');
        const b = store.segment('b');
        const sup = store.segment('sup');

        expect(await collect(a.intersect([b]))).toEqual(asc([...A].filter((x) => B.has(x))));
        expect(await collect(a.union([b]))).toEqual(asc([...A, ...B]));
        expect(await collect(a.andNot([sup]))).toEqual(asc([...A].filter((x) => !S.has(x))));
        // `exclude` folds suppression into the same chunk-aligned pass — the result must be identical to
        // computing the combine and subtracting afterwards.
        expect(await collect(a.intersect([b], { exclude: [sup] }))).toEqual(
          asc([...A].filter((x) => B.has(x) && !S.has(x))),
        );
        expect(await collect(a.union([b], { exclude: [sup] }))).toEqual(
          asc([...A, ...B].filter((x) => !S.has(x))),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('a new generation replaces the old set — readers see the reload, not a merge', async () => {
    await fc.assert(
      fc.asyncProperty(idSet, idSet, async (first, second) => {
        // A reload is only *visible* once the reader's pinned generation snapshot ages out, so the TTL and the
        // clock that drives it are part of the property.
        const clock = fakeClock();
        const { store, load } = await loadedStore({ s: first }, { clock, coldGenTtlMs: 1 });
        const seg = store.segment('s');
        expect(await collect(seg.iterate())).toEqual(asc(first)); // pins generation 0

        await load('s', second); // generation 1
        clock.advance();

        expect(await collect(seg.iterate())).toEqual(asc(second));
        expect(await seg.count()).toBe(new Set(second).size);
        // Ids that lived only in the superseded generation are gone: a load replaces, it never merges.
        const dropped = asc([...new Set(first)].filter((x) => !new Set(second).has(x)));
        for (const id of dropped.slice(0, 5)) expect(await seg.has(id)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
