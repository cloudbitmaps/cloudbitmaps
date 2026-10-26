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

/** The ids `from` up to but not including `to`. */
function span(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

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
  ['two long runs', [...span(100, 3_100), ...span(8_000, 9_000)]],
  ['a run apart from those', span(20_000, 22_000)],
  ['a run across the first two', span(5_000, 9_000)],
  ['many short runs', Array.from({ length: 100 }, (_, r) => span(r * 200, r * 200 + 50)).flat()],
  ['a bitset away from the runs', Array.from({ length: 5_000 }, (_, i) => 30_000 + i * 2)],
];

const COUNTS = ['andCardinality', 'orCardinality', 'xorCardinality', 'andNotCardinality'] as const;
const PREDICATES = ['intersects', 'isSubset', 'isEqual'] as const;
const ALL = [...COUNTS, ...PREDICATES] as const;

/** The static a derived route builds for each family method; `isSubset` and `isEqual` build nothing. */
const BUILDS = {
  andCardinality: 'and',
  orCardinality: 'or',
  xorCardinality: 'xor',
  andNotCardinality: 'andNot',
  intersects: 'and',
} as const;
const STATICS = ['and', 'or', 'xor', 'andNot'] as const;

/** Corpus entries that hold at least one run container once `runOptimize` has run. */
const RUN_NAMES = new Set([
  'a full container',
  'a full top container',
  'runs across the 2^31 line',
  'two long runs',
  'a run apart from those',
  'a run across the first two',
  'many short runs',
]);

/** A bitmap of `ids`, with its containers run-optimised when `runs` is true. */
function make(ids: readonly number[], runs: boolean): RoaringBitmap {
  const bitmap = new RoaringBitmap(ids);
  if (runs) bitmap.runOptimize();
  return bitmap;
}

/** Which operand holds run containers: neither, the first, the second, both. */
const VARIANTS: ReadonlyArray<readonly [boolean, boolean]> = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

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
    it.each(ALL)('%s takes the configured route', (method) => {
      const statics = STATICS.map((name) => [name, vi.spyOn(TsBitmap, name)] as const);
      const kernel = vi.spyOn(TsBitmap.prototype, method);
      try {
        const a = new RoaringBitmap([1, 2, 3]);
        const b = new RoaringBitmap([2, 3, 4]);
        a[method](b);
        const built = statics.filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
        const builds = BUILDS[method as keyof typeof BUILDS];
        if (route === 'derived' && builds !== undefined) {
          expect(built, `${method} builds ${builds} and nothing else`).toEqual([builds]);
          expect(kernel, `${method} does not call its kernel`).not.toHaveBeenCalled();
        } else {
          expect(built, `${method} builds no combination`).toEqual([]);
          expect(kernel, `${method} calls its kernel`).toHaveBeenCalled();
        }
      } finally {
        for (const [, spy] of statics) spy.mockRestore();
        kernel.mockRestore();
      }
    });

    it('container kinds: the run corpus entries hold run containers once optimised, the plain ones do not', () => {
      const RUN_COOKIE = 12_347;
      const cookie = (bm: RoaringBitmap): number => {
        const bytes = bm.serialize();
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
      };
      for (const [name, ids] of CORPUS) {
        if (ids.length === 0) continue;
        const runs = make(ids, true);
        const plain = make(ids, false);
        expect(cookie(plain), `${name}, plain`).not.toBe(RUN_COOKIE);
        if (RUN_NAMES.has(name)) expect(cookie(runs), `${name}, optimised`).toBe(RUN_COOKIE);
      }
    });

    const pairs = CORPUS.flatMap(([an, a]) =>
      CORPUS.map(([bn, b]) => [`${an} against ${bn}`, a, b] as const),
    );

    it.each(pairs)('%s agrees with CRoaring and changes neither operand', (_n, a, b) => {
      for (const [leftRuns, rightRuns] of VARIANTS) {
        const where = `runs in (${leftRuns}, ${rightRuns})`;
        const left = make(a, leftRuns);
        const right = make(b, rightRuns);
        for (const method of ALL) {
          expect(left[method](right), `${method}, ${where}`).toBe(oracle(method, a, b));
          expect(right[method](left), `${method}, swapped, ${where}`).toBe(oracle(method, b, a));
        }
        expect(snapshot(left), where).toEqual(Array.from(crOf(a).toUint32Array()));
        expect(snapshot(right), where).toEqual(Array.from(crOf(b).toUint32Array()));
      }
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
          for (const [leftRuns, rightRuns] of VARIANTS) {
            const [A, B] = [make(a, leftRuns), make(b, rightRuns)];
            for (const method of ALL) {
              expect(A[method](B), method).toBe(oracle(method, a, b));
              expect(B[method](A), `${method}, swapped`).toBe(oracle(method, b, a));
            }
          }
        }),
        RUNS,
      );
    });

    it('each count equals the size of its returning form, and the predicates their identities', () => {
      fc.assert(
        fc.property(pair, ({ a, b }) => {
          const [A, B] = [make(a, true), make(b, true)];
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
