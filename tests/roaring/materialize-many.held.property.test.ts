/**
 * Each output of a call with held operands is, byte for byte, the generation the same operands stored would publish:
 * random trees (nesting up to 12) over operands of every shape, each operand stored, held or fed at random and all three
 * mixed in one call, with a range that cuts two chunks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Expr, MaterializeManyOutput } from '@/index';
import { batchWorld, bitmapOf, range } from '../helpers/batch-world';
import { feedOf, lcg, recordsOf } from '../helpers/combine-feed';

const at = (chunk: number, values: number[]): number[] => values.map((v) => chunk * 65_536 + v);
const POOL: Record<string, number[]> = {
  empty: [],
  dense: [...at(1, range(0, 9000)), ...at(2, range(100, 8000))],
  runs: [...at(1, range(2000, 40000)), ...at(2, [...range(0, 300), ...range(5000, 5300)])],
  sparse: [...at(1, range(0, 60000, 997)), ...at(3, range(7, 60000, 1999))],
  full: at(2, range(0, 65_536)),
  edges: [...at(0, range(0, 50, 3)), ...at(65_535, range(0, 40, 5))],
};
const NAMES = Object.keys(POOL);
type Kind = 'stored' | 'held' | 'fed';

const trees = new Map<number, fc.Arbitrary<Expr>>();
const tree = (depth: number): fc.Arbitrary<Expr> => {
  let t = trees.get(depth);
  if (t === undefined) {
    const leaf = fc.constantFrom(...NAMES);
    t =
      depth === 0
        ? leaf
        : (() => {
            const kids = (min: number) =>
              fc
                .tuple(
                  tree(depth - 1),
                  fc.array(fc.oneof(leaf, tree(Math.min(depth - 1, 1))), {
                    minLength: min - 1,
                    maxLength: 2,
                  }),
                )
                .map(([spine, rest]) => [spine, ...rest]);
            return fc.oneof(
              leaf,
              kids(1).map((and) => ({ and })),
              kids(1).map((or) => ({ or })),
              kids(2).map((andNot) => ({ andNot })),
            );
          })();
    trees.set(depth, t);
  }
  return t;
};

describe('a call with held operands is byte for byte the same operands stored', () => {
  it('over random trees of depth up to 12, with operands stored, held or fed at random', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 12 }).chain(tree), { minLength: 2, maxLength: 6 }),
        fc.array(fc.constantFrom<Kind>('stored', 'held', 'fed'), {
          minLength: NAMES.length,
          maxLength: NAMES.length,
        }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.option(
          fc.record({
            after: fc.integer({ min: 65_536 + 100, max: 2 * 65_536 }),
            through: fc.integer({ min: 2 * 65_536 + 1, max: 3 * 65_536 + 70_000 }),
          }),
          { nil: undefined },
        ),
        async (exprs, kinds, seed, cut) => {
          const w = await batchWorld(POOL);
          const s = (n: string) => w.store.segment(n);
          const mk = (prefix: string): MaterializeManyOutput[] =>
            exprs.map((expr, i) => ({ dest: s(`${prefix}${i}`), expr }));
          const stored = await w.store.materializeMany({
            operands: Object.fromEntries(NAMES.map((n) => [n, s(n)])),
            outputs: mk('s'),
            keep: 1,
            ...cut,
          });
          const kindOf = (n: string): Kind => kinds[NAMES.indexOf(n)]!;
          const operands: Record<
            string,
            ReturnType<typeof s> | Awaited<ReturnType<typeof w.store.memory>>
          > = {};
          for (const n of NAMES) {
            if (kindOf(n) === 'stored') operands[n] = s(n);
            // The held form takes the ids in three spellings, as a load does.
            else if (kindOf(n) === 'held') {
              const ids = POOL[n]!;
              operands[n] = await w.store.memory(
                seed % 3 === 0
                  ? Uint32Array.from(ids)
                  : seed % 3 === 1
                    ? ids
                    : { bitmap: bitmapOf(ids) },
              );
            }
          }
          const fedNames = NAMES.filter((n) => kindOf(n) === 'fed');
          const fed = Object.fromEntries(fedNames.map((n) => [n, POOL[n]!]));
          const empties = NAMES.filter((n) => kindOf(n) !== 'stored' && POOL[n]!.length === 0);
          const run = await w.store.materializeMany({
            operands,
            ...(fedNames.length === 0
              ? {}
              : {
                  feed: {
                    names: fedNames,
                    records: feedOf(recordsOf(fed, lcg(seed))),
                    counts: Object.fromEntries(fedNames.map((n) => [n, POOL[n]!.length])),
                  },
                }),
            mayBeEmpty: empties,
            maxBufferedBytes: 64 * 1024 * 1024,
            outputs: mk('h'),
            keep: 1,
            ...cut,
          });
          expect(run.outputs.map((o) => o.published)).toEqual(
            stored.outputs.map((o) => o.published),
          );
          for (let i = 0; i < exprs.length; i++) {
            if (!stored.outputs[i]!.published) continue;
            expect(await w.hex(`h${i}`, 0)).toBe(await w.hex(`s${i}`, 0));
          }
        },
      ),
      { numRuns: 15 },
    );
  }, 180_000);
});
