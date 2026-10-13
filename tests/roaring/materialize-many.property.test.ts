/**
 * Each output of a batch is, byte for byte, the generation its ids would load: random trees over operands of every
 * shape, in one group and in many, with a range that cuts two chunks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Expr, MaterializeManyOutput } from '@/index';
import { batchWorld, bitmapOf, range } from '../helpers/batch-world';
import type { Bitmap } from '../helpers/batch-world';

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
const native: Record<string, Bitmap> = Object.fromEntries(
  Object.entries(POOL).map(([k, v]) => [k, bitmapOf(v)]),
);

const evalNative = (e: Expr): Bitmap => {
  if (typeof e === 'string') return bitmapOf(native[e]!.toArray());
  if ('and' in e) return e.and.map(evalNative).reduce((a, b) => (a.andInPlace(b), a));
  if ('or' in e) return e.or.map(evalNative).reduce((a, b) => (a.orInPlace(b), a));
  return e.andNot.map(evalNative).reduce((a, b) => (a.andNotInPlace(b), a));
};

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

describe('materializeMany is byte for byte what the ids would load', () => {
  it('over random trees, in one group and in many', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 8 }).chain(tree), { minLength: 3, maxLength: 7 }),
        fc.option(
          fc.record({
            after: fc.integer({ min: 65_536 + 100, max: 2 * 65_536 }),
            through: fc.integer({ min: 2 * 65_536 + 1, max: 3 * 65_536 + 70_000 }),
          }),
          { nil: undefined },
        ),
        async (exprs, cut) => {
          const w = await batchWorld(POOL);
          const s = (n: string) => w.store.segment(n);
          const operands = Object.fromEntries(NAMES.map((n) => [n, s(n)]));
          const mk = (prefix: string): MaterializeManyOutput[] =>
            exprs.map((expr, i) => ({ dest: s(`${prefix}${i}`), expr }));
          const one = await w.store.materializeMany({
            operands,
            outputs: mk('one'),
            keep: 1,
            ...cut,
          });
          const many = await w.store.materializeMany({
            operands,
            outputs: mk('many'),
            keep: 1,
            maxBufferedBytes: 1_200_000,
            ...cut,
          });
          expect(many.outputs.map((o) => o.published)).toEqual(one.outputs.map((o) => o.published));
          for (let i = 0; i < exprs.length; i++) {
            let want = evalNative(exprs[i]!).toArray();
            if (cut) want = want.filter((id) => id > cut.after && id <= cut.through);
            // the reference: the same ids loaded, where the result is not empty
            if (want.length === 0) {
              expect(one.outputs[i]).toMatchObject({ published: true });
              continue;
            }
            await w.load(`ref${i}`, want);
            const ref = await w.hex(`ref${i}`, 0);
            expect(one.outputs[i]).toMatchObject({ published: true, generation: 0 });
            expect(await w.hex(`one${i}`, 0)).toBe(ref);
            expect(await w.hex(`many${i}`, 0)).toBe(ref);
          }
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});
