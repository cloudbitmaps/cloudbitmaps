import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, RoaringBitmap } from '@/index';
import type { LoadInput } from '@/index';
import { buildSet, firstDifference, relatedTo, setSpec } from '../helpers/roaring-oracle';
import { zeroEntropy } from '../helpers/entropy';

vi.setConfig({ testTimeout: 120_000 });

/**
 * Properties of the public class that must hold for any set: the laws of the combines it has, what a clone keeps
 * apart, what a decode reads back, what iteration promises, and that a load of a bitmap writes what a load of its ids
 * writes. Sets are drawn from the oracle's container shapes (sparse, boundary, dense, runs, ties, holes) at keys that
 * include 0, 32,767, 32,768 and 65,535, so ids at and above 2^31 and at 0xFFFFFFFF are common.
 */
const RUNS = { numRuns: 20 };
const mode = fc.constantFrom('subset', 'superset', 'shift', 'copy', 'stranger');
const salt = fc.integer({ min: 0, max: 0x7fffffff });

/** Two related sets and a third, as id arrays. */
const triple = fc
  .tuple(setSpec(3), mode, salt, setSpec(2), mode, salt)
  .map(([spec, m1, s1, other, m2, s2]) => {
    const a = buildSet(spec);
    const stranger = buildSet(other);
    return { a, b: relatedTo(a, m1, s1, stranger), c: relatedTo(a, m2, s2, stranger) };
  });

function same(x: RoaringBitmap, y: RoaringBitmap | ArrayLike<number>): void {
  const want = y instanceof RoaringBitmap ? y.toUint32Array() : y;
  const got = x.toUint32Array();
  expect(firstDifference(got, want), `contents differ at ${firstDifference(got, want)}`).toBe(-1);
}

const and = (a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap => a.clone().andInPlace(b);
const or = (a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap => a.clone().orInPlace(b);
const andNot = (a: RoaringBitmap, b: RoaringBitmap): RoaringBitmap => a.clone().andNotInPlace(b);

describe('RoaringBitmap: laws of the combines it has', () => {
  it('and and or are commutative and associative, and absorb', () => {
    fc.assert(
      fc.property(triple, ({ a, b, c }) => {
        const [A, B, C] = [new RoaringBitmap(a), new RoaringBitmap(b), new RoaringBitmap(c)];
        same(and(A, B), and(B, A));
        same(or(A, B), or(B, A));
        same(and(and(A, B), C), and(A, and(B, C)));
        same(or(or(A, B), C), or(A, or(B, C)));
        same(and(A, or(A, B)), A);
        same(or(A, and(A, B)), A);
        same(and(A, A), A);
        same(or(A, A), A);
      }),
      RUNS,
    );
  });

  it('andNot is the difference: A andNot B is A and not B, inside a bounded universe', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
        const universe = or(A, B);
        const notB = andNot(universe, B);
        same(andNot(A, B), and(A, notB));
        same(or(andNot(A, B), and(A, B)), A);
        expect(and(andNot(A, B), B).isEmpty).toBe(true);
        expect(andNot(A, A).isEmpty).toBe(true);
        same(andNot(A, new RoaringBitmap()), A);
      }),
      RUNS,
    );
  });

  it('size follows: |A or B| + |A and B| = |A| + |B|, and |A andNot B| = |A| - |A and B|', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
        expect(or(A, B).size + and(A, B).size).toBe(A.size + B.size);
        expect(andNot(A, B).size).toBe(A.size - and(A, B).size);
      }),
      RUNS,
    );
  });
});

describe('RoaringBitmap: a clone is independent', () => {
  it('under every mutator, in both directions, through several generations of clones', () => {
    fc.assert(
      fc.property(triple, fc.integer({ min: 0, max: 0xffff_ffff }), ({ a, b }, id) => {
        const original = new RoaringBitmap(a);
        const operand = new RoaringBitmap(b);
        const before = Array.from(original.toUint32Array());
        const mutators: Array<(x: RoaringBitmap) => unknown> = [
          (x) => x.add(id),
          (x) => x.addMany([id, 0, 0xffff_ffff]),
          (x) => x.remove(a[0] ?? id),
          (x) => x.removeMany(a.slice(0, 50)),
          (x) => x.clear(),
          (x) => x.andInPlace(operand),
          (x) => x.orInPlace(operand),
          (x) => x.andNotInPlace(operand),
          (x) => x.runOptimize(),
        ];
        for (const mutate of mutators) {
          const gen1 = original.clone();
          const gen2 = gen1.clone();
          const gen3 = gen2.clone();
          mutate(gen2);
          same(original, before);
          same(gen1, before);
          same(gen3, before);
          mutate(original);
          same(gen1, before);
          same(gen3, before);
          // put the original back for the next mutator
          original.clear();
          original.addMany(before);
        }
      }),
      RUNS,
    );
  });

  it('a combine leaves its operand as it was', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const [A, B] = [new RoaringBitmap(a), new RoaringBitmap(b)];
        for (const op of ['andInPlace', 'orInPlace', 'andNotInPlace'] as const) {
          A.clone()[op](B);
          same(B, b);
          same(A, a);
        }
      }),
      RUNS,
    );
  });
});

describe('RoaringBitmap: bytes, iteration and the load', () => {
  it('deserialize(serialize(x)) is x, as written and after runOptimize, and a decoded bitmap changes like any other', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const A = new RoaringBitmap(a);
        const decoded = RoaringBitmap.deserialize(A.serialize());
        same(decoded, A);
        A.runOptimize();
        const optimized = RoaringBitmap.deserialize(A.serialize());
        same(optimized, a);
        same(
          optimized.orInPlace(new RoaringBitmap(b)),
          or(new RoaringBitmap(a), new RoaringBitmap(b)),
        );
        same(
          decoded.andNotInPlace(decoded.clone().removeMany(b)),
          and(new RoaringBitmap(a), new RoaringBitmap(b)),
        );
      }),
      RUNS,
    );
  });

  it('iteration ascends, equals toUint32Array and toArray, and yields each id once', () => {
    fc.assert(
      fc.property(triple, ({ a, b }) => {
        const A = new RoaringBitmap([...b, ...a]);
        const walked = [...A];
        expect(walked.length).toBe(A.size);
        for (let i = 1; i < walked.length; i++) expect(walked[i]! > walked[i - 1]!).toBe(true);
        expect(firstDifference(walked, A.toUint32Array())).toBe(-1);
        expect(firstDifference(A.toArray(), A.toUint32Array())).toBe(-1);
      }),
      RUNS,
    );
  });

  it('has, minimum and maximum agree with the sorted ids', () => {
    fc.assert(
      fc.property(triple, ({ a }) => {
        const A = new RoaringBitmap(a);
        expect(A.minimum()).toBe(a[0]);
        expect(A.maximum()).toBe(a.at(-1));
        for (const id of a.filter((_, i) => i % 331 === 0)) expect(A.has(id)).toBe(true);
        for (const id of a.filter((_, i) => i % 331 === 0)) {
          if (id < 0xffff_ffff && !A.has(id + 1)) expect(A.has(id + 1)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  async function written(input: LoadInput): Promise<Buffer> {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, seams: { entropy: zeroEntropy } });
    const result = await store.load({ segment: 's' }, input, { allowEmpty: true });
    const tail = await backend.storage.getTail(
      { segment: 's', generation: result.generation },
      1 << 30,
    );
    return Buffer.from(tail.bytes);
  }

  it('a load of a RoaringBitmap writes what a load of the same ids writes', async () => {
    await fc.assert(
      fc.asyncProperty(triple, async ({ a }) => {
        const fromIds = await written(a);
        expect((await written(new RoaringBitmap(a))).equals(fromIds)).toBe(true);
        const optimized = new RoaringBitmap(a);
        optimized.runOptimize();
        expect((await written({ bitmap: optimized })).equals(fromIds)).toBe(true);
        expect(
          (await written(RoaringBitmap.deserialize(new RoaringBitmap(a).serialize()))).equals(
            fromIds,
          ),
        ).toBe(true);
      }),
      { numRuns: 8 },
    );
  });
});
