/**
 * A fed call against the same operands stored, over random expression trees (nesting up to 12), over operands of every
 * shape a chunk can take, with each operand fed or stored at random and the keys of the feed cut across records at
 * random boundaries, with and without a range that cuts two chunks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CombineExpr } from '@/core/combine-many';
import { nativeOutput, runBatch, toNative } from '../helpers/combine-many';
import type { OutputSpec, Published } from '../helpers/combine-many';
import { lcg, runFed } from '../helpers/combine-feed';

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

/** Which operands are fed: any subset, none and all included. */
const fedSet = fc.subarray(NAMES);

function split(fedNames: string[]) {
  const stored: Record<string, number[]> = {};
  const fed: Record<string, number[]> = {};
  for (const name of NAMES) (fedNames.includes(name) ? fed : stored)[name] = POOL[name]!;
  return { stored, fed };
}

describe('a fed call against native Roaring and against the same operands stored', () => {
  it('matches over random trees of depth up to 12, with operands fed or stored at random', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(output, { minLength: 1, maxLength: 8 }),
        fedSet.filter((f) => f.length > 0),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (specs, fedNames, seed) => {
          const { stored, fed } = split(fedNames);
          const got = await runFed(specs, {
            stored,
            fed,
            rng: lcg(seed),
            mayBeEmpty: fedNames.filter((n) => POOL[n]!.length === 0),
          });
          const want = await runBatch(POOL, specs);
          expect(got.run.outputs).toEqual(want.run.outputs);
          got.run.outputs.forEach((out, i) => {
            expect((out as { ok: true; value: Published }).value.ids).toEqual(
              nativeOutput(specs[i]!, native).toArray(),
            );
          });
        },
      ),
      { numRuns: 60 },
    );
  }, 180_000);

  it('matches under a range that cuts two chunks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(output, { minLength: 1, maxLength: 8 }),
        fedSet.filter((f) => f.length > 0),
        fc.integer({ min: 3 * 65_536 + 100, max: 4 * 65_536 }),
        fc.integer({ min: 4 * 65_536 + 1, max: 9 * 65_536 + 70_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (specs, fedNames, after, through, seed) => {
          const { stored, fed } = split(fedNames);
          const got = await runFed(specs, {
            stored,
            fed,
            rng: lcg(seed),
            mayBeEmpty: fedNames.filter((n) => POOL[n]!.length === 0),
            extra: { after, through },
          });
          const want = await runBatch(POOL, specs, { after, through });
          expect(got.run.outputs).toEqual(want.run.outputs);
        },
      ),
      { numRuns: 30 },
    );
  }, 180_000);
});
