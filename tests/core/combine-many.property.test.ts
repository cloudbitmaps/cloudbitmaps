/**
 * The batch combine against native Roaring over random expression trees (nesting up to 12), over operands of every shape
 * a chunk can take, with and without a range that cuts two chunks, in one group and in many.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CombineExpr } from '@/core/combine-many';
import { nativeOutput, runBatch, toNative } from '../helpers/combine-many';
import type { OutputSpec, Published } from '../helpers/combine-many';

const range = (lo: number, hi: number, step = 1): number[] => {
  const out: number[] = [];
  for (let v = lo; v < hi; v += step) out.push(v);
  return out;
};
const at = (chunk: number, values: number[]): number[] => values.map((v) => chunk * 65_536 + v);

/** Operands in every shape: empty, dense, run-heavy, sparse, one full chunk, and chunks at both ends of the key space. */
const POOL: Record<string, number[]> = {
  empty: [],
  dense: [...at(3, range(0, 9000)), ...at(4, range(100, 8000)), ...at(9, range(0, 5000, 2))],
  runs: [
    ...at(3, range(2000, 40000)),
    ...at(4, [...range(0, 300), ...range(5000, 5300)]),
    ...at(9, range(0, 20)),
  ],
  sparse: [
    ...at(3, range(0, 60000, 997)),
    ...at(5, range(7, 60000, 1999)),
    ...at(9, range(1, 60000, 4001)),
  ],
  full: at(4, range(0, 65_536)),
  first: [...at(0, range(0, 50, 3)), ...at(3, range(0, 3000, 7))],
  last: [...at(65_535, range(0, 40, 5)), ...at(9, range(0, 9000, 3)), ...at(4, range(9, 70, 2))],
  mid: [
    ...at(3, range(0, 65_536, 5)),
    ...at(9, range(0, 65_536, 3)),
    ...at(4, range(0, 65_536, 2)),
  ],
};
const NAMES = Object.keys(POOL);

const trees = new Map<number, fc.Arbitrary<CombineExpr>>();
function tree(depth: number): fc.Arbitrary<CombineExpr> {
  let t = trees.get(depth);
  if (t === undefined) trees.set(depth, (t = build(depth)));
  return t;
}

function build(depth: number): fc.Arbitrary<CombineExpr> {
  const leaf = fc.constantFrom(...NAMES);
  if (depth === 0) return leaf;
  // Mostly a spine with a short side branch, so depth reaches 12 without the node count exploding.
  const kids = (min: number): fc.Arbitrary<CombineExpr[]> =>
    fc
      .tuple(
        tree(depth - 1),
        fc.array(fc.oneof(leaf, tree(Math.min(depth - 1, 2))), {
          minLength: min - 1,
          maxLength: 2,
        }),
      )
      .map(([spine, rest]) => [spine, ...rest]);
  return fc.oneof(
    { weight: 1, arbitrary: leaf },
    { weight: 3, arbitrary: kids(1).map((and) => ({ and })) },
    { weight: 3, arbitrary: kids(1).map((or) => ({ or })) },
    { weight: 3, arbitrary: kids(2).map((andNot) => ({ andNot })) },
  );
}

const output: fc.Arbitrary<OutputSpec> = fc
  .tuple(
    fc.integer({ min: 0, max: 12 }).chain((d) => tree(d)),
    fc.option(fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 2 }), {
      nil: undefined,
    }),
  )
  .map(([expr, exclude]) => ({ expr, ...(exclude === undefined ? {} : { exclude }) }));

const native = Object.fromEntries(Object.entries(POOL).map(([k, v]) => [k, toNative(v)]));

function expectMatches(
  specs: OutputSpec[],
  run: Awaited<ReturnType<typeof runBatch>>['run'],
  cut?: [number, number],
) {
  run.outputs.forEach((out, i) => {
    expect(out.ok).toBe(true);
    let want = nativeOutput(specs[i]!, native).toArray();
    if (cut) want = want.filter((id) => id > cut[0] && id <= cut[1]);
    expect((out as { ok: true; value: Published }).value.ids).toEqual(want);
  });
}

describe('batch combine against native Roaring', () => {
  it('matches over random trees of depth up to 12, in one group', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(output, { minLength: 1, maxLength: 8 }), async (specs) => {
        const { run } = await runBatch(POOL, specs);
        expectMatches(specs, run);
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it('matches in many groups, and under a range that cuts two chunks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(output, { minLength: 4, maxLength: 12 }),
        fc.integer({ min: 3 * 65_536 + 100, max: 4 * 65_536 }),
        fc.integer({ min: 4 * 65_536 + 1, max: 9 * 65_536 + 70_000 }),
        async (specs, after, through) => {
          const grouped = await runBatch(POOL, specs, {
            after,
            through,
            maxBufferedBytes: 1_500_000,
          });
          expectMatches(specs, grouped.run, [after, through]);
          const whole = await runBatch(POOL, specs, { after, through });
          expect(grouped.run.outputs).toEqual(whole.run.outputs);
        },
      ),
      { numRuns: 20 },
    );
  }, 120_000);
});
