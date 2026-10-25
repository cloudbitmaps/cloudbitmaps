import fc from 'fast-check';
import { RoaringBitmap32 } from 'roaring';
import { describe, expect, it, vi } from 'vitest';
import { RoaringBitmap, ValidationError } from '@/index';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { buildSet, crOf, relatedTo, setSpec } from './roaring-oracle';

/**
 * The public counting methods of `RoaringBitmap`, held to CRoaring through the `roaring` package's public API, to the
 * identities between each count and its returning form, to their refusals, and to "no operand changes". The same suite
 * runs once with the counts answered by the kernels and once with them answered by building the combination, so the
 * switch between the two routes cannot change an answer.
 */
const TOP = 0xffff_ffff;
const HALF = 2 ** 31;
const EDGES = [0, 1, 4_095, 4_096, 65_535, 65_536, 65_537, HALF - 1, HALF, HALF + 1, TOP - 1, TOP];

const CORPUS: ReadonlyArray<readonly [string, number[]]> = [
  ['empty', []],
  ['one id at 0', [0]],
  ['one id at 2^31', [HALF]],
  ['one id at 0xFFFFFFFF', [TOP]],
  ['the edges', [...EDGES].sort((a, b) => a - b)],
  ['a full container', Array.from({ length: 65_536 }, (_, i) => i)],
  ['a full top container', Array.from({ length: 65_536 }, (_, i) => TOP - i).reverse()],
  [
    'runs across the 2^31 line',
    [...Array.from({ length: 3_000 }, (_, i) => HALF - 1_500 + i), TOP - 2, TOP - 1, TOP],
  ],
  ['a bitset at the boundary', Array.from({ length: 4_097 }, (_, i) => i * 3)],
  ['an array at the boundary', Array.from({ length: 4_096 }, (_, i) => i * 3)],
  ['a subset of the array', Array.from({ length: 1_000 }, (_, i) => i * 3)],
];

const COUNTS = ['andCardinality', 'orCardinality', 'xorCardinality', 'andNotCardinality'] as const;
const PREDICATES = ['intersects', 'isSubset', 'isEqual'] as const;
const ALL = [...COUNTS, ...PREDICATES] as const;

/** What CRoaring answers for `method` on two id lists. */
function oracle(
  method: (typeof ALL)[number],
  a: readonly number[],
  b: readonly number[],
): number | boolean {
  const x: RoaringBitmap32 = crOf(a);
  const y: RoaringBitmap32 = crOf(b);
  return x[method](y);
}

function snapshot(bitmap: RoaringBitmap): number[] {
  return Array.from(bitmap.toUint32Array());
}

/** Registers the suite under `title`; `route` names the route the caller has configured, and the suite proves it took. */
export function describeCounts(title: string, route: 'kernels' | 'derived'): void {
  describe(title, () => {
    it('the configured route is the one taken', () => {
      const build = vi.spyOn(TsBitmap, 'and');
      const a = new RoaringBitmap([1, 2, 3]);
      const b = new RoaringBitmap([2, 3, 4]);
      for (const method of COUNTS) a[method](b);
      a.intersects(b);
      const built = build.mock.calls.length;
      a.isSubset(b);
      a.isEqual(b);
      const after = build.mock.calls.length;
      build.mockRestore();
      expect(built, 'combinations built by the five family methods').toBe(
        route === 'derived' ? 2 : 0,
      );
      expect(after, 'isSubset and isEqual build nothing').toBe(built);
    });

    const pairs = CORPUS.flatMap(([an, a]) =>
      CORPUS.map(([bn, b]) => [`${an} against ${bn}`, a, b] as const),
    );

    it.each(pairs)('%s agrees with CRoaring and changes neither operand', (_n, a, b) => {
      const left = new RoaringBitmap(a);
      const right = new RoaringBitmap(b);
      for (const method of ALL) {
        expect(left[method](right), `${method}`).toBe(oracle(method, a, b));
        expect(right[method](left), `${method}, operands swapped`).toBe(oracle(method, b, a));
      }
      expect(snapshot(left)).toEqual(Array.from(crOf(a).toUint32Array()));
      expect(snapshot(right)).toEqual(Array.from(crOf(b).toUint32Array()));
    });

    it('a bitmap against itself, and against a clone of itself', () => {
      for (const [, ids] of CORPUS) {
        const a = new RoaringBitmap(ids);
        for (const same of [a, a.clone(), new RoaringBitmap(ids)]) {
          expect(a.andCardinality(same)).toBe(ids.length);
          expect(a.orCardinality(same)).toBe(ids.length);
          expect(a.xorCardinality(same)).toBe(0);
          expect(a.andNotCardinality(same)).toBe(0);
          expect(a.intersects(same)).toBe(ids.length > 0);
          expect(a.isSubset(same)).toBe(true);
          expect(a.isEqual(same)).toBe(true);
        }
      }
    });

    it('isEqual is by membership, not by container kind or bytes', () => {
      const ids = Array.from({ length: 3_000 }, (_, i) => 70_000 + i);
      const plain = new RoaringBitmap(ids);
      const runs = new RoaringBitmap(ids);
      expect(runs.runOptimize()).toBe(true);
      expect(plain.serialize()).not.toEqual(runs.serialize());
      expect(plain.isEqual(runs)).toBe(true);
      expect(runs.isEqual(plain)).toBe(true);
      expect(plain.isSubset(runs) && runs.isSubset(plain)).toBe(true);
      runs.add(5);
      expect(plain.isEqual(runs)).toBe(false);
      expect(plain.isSubset(runs)).toBe(true);
      expect(runs.isSubset(plain)).toBe(false);
    });

    it('an empty bitmap: a subset of everything, equal only to the empty one, intersecting nothing', () => {
      const empty = new RoaringBitmap();
      const some = new RoaringBitmap([0, TOP]);
      expect(empty.isSubset(some)).toBe(true);
      expect(some.isSubset(empty)).toBe(false);
      expect(empty.isSubset(empty)).toBe(true);
      expect(empty.isEqual(new RoaringBitmap())).toBe(true);
      expect(empty.isEqual(some)).toBe(false);
      expect(empty.intersects(some)).toBe(false);
      expect(some.intersects(empty)).toBe(false);
    });

    const RUNS = { numRuns: 25 };
    const mode = fc.constantFrom('subset', 'superset', 'shift', 'copy', 'stranger');
    const salt = fc.integer({ min: 0, max: 0x7fffffff });
    const pair = fc.tuple(setSpec(4), mode, salt, setSpec(3)).map(([spec, m, s, other]) => {
      const a = buildSet(spec);
      return { a, b: relatedTo(a, m, s, buildSet(other)) };
    });

    it('random sets of container shapes agree with CRoaring', () => {
      fc.assert(
        fc.property(pair, ({ a, b }) => {
          const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
          for (const method of ALL) {
            expect(A[method](B), method).toBe(oracle(method, a, b));
            expect(B[method](A), `${method}, swapped`).toBe(oracle(method, b, a));
          }
        }),
        RUNS,
      );
    });

    it('each count equals the size of its returning form, and the predicates their identities', () => {
      fc.assert(
        fc.property(pair, ({ a, b }) => {
          const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
          expect(A.andCardinality(B)).toBe(RoaringBitmap.and(A, B).size);
          expect(A.orCardinality(B)).toBe(RoaringBitmap.or(A, B).size);
          expect(A.xorCardinality(B)).toBe(RoaringBitmap.xor(A, B).size);
          expect(A.andNotCardinality(B)).toBe(RoaringBitmap.andNot(A, B).size);
          expect(A.intersects(B)).toBe(A.andCardinality(B) > 0);
          expect(A.isSubset(B)).toBe(RoaringBitmap.andNot(A, B).isEmpty);
          expect(A.isEqual(B)).toBe(A.isSubset(B) && B.isSubset(A));
          expect(A.isEqual(B)).toBe(B.isEqual(A));
          expect(A.isEqual(B)).toBe(a.length === b.length && a.every((id, i) => id === b[i]));
          expect(A.orCardinality(B)).toBe(A.size + B.size - A.andCardinality(B));
          expect(A.andCardinality(B)).toBe(B.andCardinality(A));
        }),
        RUNS,
      );
    });

    it('no count or comparison changes either operand, nor a clone made before it', () => {
      fc.assert(
        fc.property(pair, ({ a, b }) => {
          const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
          const [copyA, copyB] = [A.clone(), B.clone()];
          for (const method of ALL) {
            A[method](B);
            B[method](A);
            A[method](A);
          }
          expect(snapshot(A)).toEqual(a);
          expect(snapshot(B)).toEqual(b);
          // The operands still take writes that reach nobody else.
          A.add(7).remove(a[0] ?? 0);
          expect(snapshot(copyA)).toEqual(a);
          expect(snapshot(copyB)).toEqual(b);
        }),
        { numRuns: 15 },
      );
    });

    describe('refusals', () => {
      const duck = Object.assign(Object.create(null) as object, {
        size: 1,
        has: () => true,
        [Symbol.iterator]: function* () {
          yield 1;
        },
      }) as unknown as RoaringBitmap;
      const strangers: unknown[] = [
        duck,
        crOf([1]),
        { size: 1 },
        null,
        undefined,
        5,
        [1],
        new Set([1]),
      ];

      it.each(ALL)(
        '%s refuses a non-bitmap with a value-free ValidationError and changes nothing',
        (method) => {
          const mine = new RoaringBitmap([1, 70_000]);
          for (const other of strangers) {
            const call = () => (mine[method] as (o: unknown) => unknown)(other);
            expect(call).toThrow(ValidationError);
            expect(call).toThrow(/another RoaringBitmap of this copy/);
          }
          expect(mine.toArray()).toEqual([1, 70_000]);
        },
      );
    });
  });
}
