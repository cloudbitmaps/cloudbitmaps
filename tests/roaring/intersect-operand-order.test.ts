import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';

/**
 * An intersect of three or four operands through the store, on the codec the running project has in force (the suites
 * run once on each): chunks of mixed container kinds (a bitset, a sparse array, runs), every order of the operands, a
 * key some operands hold and others do not, a chunk that comes out empty at the second and at the third step, and a
 * result at the array/bitset boundary. Each answer is a plain set's; afterwards every operand reads back as it was
 * loaded, because the accumulator is a clone and no operand may be written.
 */
const KEYS = [0, 1, 2, 3, 5, 8];
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

/** The remainders of one chunk of `kind`, shaped by `which` so that each operand differs but they overlap. */
function lows(kind: 'dense' | 'sparse' | 'runs' | 'all', which: number): number[] {
  if (kind === 'dense') return range(0, 65_536).filter((v) => (v + which) % 3 !== 0);
  if (kind === 'sparse') return range(0, 65_536).filter((v) => v % (190 + which) === 0);
  if (kind === 'all') return range(0, 65_536);
  const out: number[] = [];
  for (let r = 0; r < 60; r++)
    out.push(...range(r * 1_000 + which * 7, r * 1_000 + 300 + which * 7));
  return out;
}

const KINDS = ['dense', 'sparse', 'runs'] as const;
const idsOf = (which: number, only?: number[]): number[] => {
  const out: number[] = [];
  for (const key of only ?? KEYS) {
    const kind = KINDS[(key + which) % 3] as (typeof KINDS)[number];
    for (const low of lows(kind, which)) out.push(key * 65_536 + low);
  }
  return out;
};

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

async function collect(stream: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of stream) out.push(id);
  return out;
}

async function setup(sets: number[][]) {
  const store = new CloudRoaring({ storage: new MemoryStorage() });
  for (const [i, ids] of sets.entries()) {
    await store.load({ segment: `s${i}` }, ids, { sorted: true });
  }
  return { store, seg: sets.map((_, i) => store.segment(`s${i}`)) };
}

const and = (sets: number[][], order: number[]) => {
  const rest = order.slice(1).map((i) => new Set(sets[i]));
  return (sets[order[0] as number] as number[]).filter((v) => rest.every((s) => s.has(v)));
};

describe("the store's intersect of three or more operands", () => {
  it('gives the plain set answer in every operand order, over mixed chunks, and leaves the operands as loaded', async () => {
    const sets = [0, 1, 2, 3].map((w) => idsOf(w));
    const { seg } = await setup(sets);
    for (const order of permutations([0, 1, 2, 3])) {
      const [first, ...others] = order.map((i) => seg[i]!);
      const got = await collect(first!.intersect(others));
      expect(got, order.join('')).toEqual(and(sets, order));
    }
    for (const order of permutations([0, 1, 2])) {
      const [first, ...others] = order.map((i) => seg[i]!);
      expect(await collect(first!.intersect(others)), order.join('')).toEqual(and(sets, order));
    }
    for (const [i, s] of seg.entries())
      expect(await collect(s!.iterate()), `operand ${i}`).toEqual(sets[i]);
  });

  it('a key only some operands hold drops out, and a chunk that empties at the second or third step ends there', async () => {
    const sets = [
      idsOf(0),
      idsOf(1, [0, 1, 2, 3]),
      idsOf(2, [1, 2, 3, 5]),
      // key 3 of this operand is disjoint from the others' key 3 (a single value none of them holds)
      [...idsOf(3, [1, 2]), 3 * 65_536 + 1, ...idsOf(3, [5])],
    ];
    const { seg } = await setup(sets);
    for (const order of permutations([0, 1, 2, 3])) {
      const [first, ...others] = order.map((i) => seg[i]!);
      expect(await collect(first!.intersect(others)), order.join('')).toEqual(and(sets, order));
    }
  });

  it('the same operand twice, and a result of 4,096 and of 4,097 values', async () => {
    const chunk = (n: number) => range(65_536, 65_536 + n);
    for (const want of [4_096, 4_097]) {
      const sets = [chunk(30_000), chunk(want + 500), chunk(60_000), chunk(want)];
      const { seg } = await setup(sets);
      const out = await collect(seg[0]!.intersect([seg[1]!, seg[2]!, seg[3]!]));
      expect(out, `result ${want}`).toEqual(sets[3]);
      expect(await collect(seg[2]!.intersect([seg[0]!, seg[0]!, seg[3]!]))).toEqual(sets[3]);
    }
  });
});
