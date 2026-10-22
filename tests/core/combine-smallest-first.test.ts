/**
 * For a codec that asks for it (`intersectSmallestFirst`), the intersect of three or more operands takes each chunk smallest first: the accumulator is a clone of the smallest
 * operand's chunk and the others meet it in ascending cardinality, equal sizes in operand order. The answer does not
 * depend on the order; what does is how much work the running result costs, and a chunk that comes out empty ends the
 * walk. A recording codec over plain sets shows the order, and the same sets give the answer a plain set gives.
 */
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { SegmentEngine } from '@/core/engine';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import { collect } from '../helpers/loaded';

/** What the engine did to the accumulator: the size of what each `andInPlace` took, and of what the clone was taken from. */
const log: { cloned: number[]; anded: number[]; andNotted: number[] } = {
  cloned: [],
  anded: [],
  andNotted: [],
};

class SetBitmap implements CodecBitmap {
  constructor(readonly s: Set<number> = new Set()) {}
  serialize(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([...this.s]));
  }
  add(v: number): void {
    this.s.add(v);
  }
  addMany(vs: Iterable<number>): void {
    for (const v of vs) this.s.add(v);
  }
  remove(v: number): void {
    this.s.delete(v);
  }
  removeMany(vs: Iterable<number>): void {
    for (const v of vs) this.s.delete(v);
  }
  has(v: number): boolean {
    return this.s.has(v);
  }
  get size(): number {
    return this.s.size;
  }
  get isEmpty(): boolean {
    return this.s.size === 0;
  }
  clone(): CodecBitmap {
    log.cloned.push(this.s.size);
    return new SetBitmap(new Set(this.s));
  }
  orInPlace(other: CodecBitmap): void {
    for (const v of (other as SetBitmap).s) this.s.add(v);
  }
  andNotInPlace(other: CodecBitmap): void {
    log.andNotted.push((other as SetBitmap).s.size);
    for (const v of (other as SetBitmap).s) this.s.delete(v);
  }
  andInPlace(other: CodecBitmap): void {
    const o = (other as SetBitmap).s;
    log.anded.push(o.size);
    for (const v of [...this.s]) if (!o.has(v)) this.s.delete(v);
  }
  *[Symbol.iterator](): IterableIterator<number> {
    yield* [...this.s].sort((a, b) => a - b);
  }
  toArray(): number[] {
    return [...this.s].sort((a, b) => a - b);
  }
}

const plainCodec: CodecInterface = {
  empty: () => new SetBitmap(),
  fromValues: (vs) => new SetBitmap(new Set(vs)),
  safeDeserialize: (bytes) =>
    new SetBitmap(new Set(JSON.parse(new TextDecoder().decode(bytes)) as number[])),
};
/** The same codec, asking for the smallest-first order. */
const setCodec: CodecInterface = { ...plainCodec, intersectSmallestFirst: true };

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

function engineOf(
  segments: Record<string, number[]>,
  codec: CodecInterface = setCodec,
): SegmentEngine {
  const storage = new MemoryStorageChunkSource();
  for (const [segment, rems] of Object.entries(segments))
    storage.seed({ segment, chunkKey: 0 }, setCodec.fromValues(rems).serialize());
  return new SegmentEngine({ storage, codec });
}

const refs = (...names: string[]) => names.map((segment) => ({ segment }));

beforeEach(() => {
  log.cloned.length = 0;
  log.anded.length = 0;
  log.andNotted.length = 0;
});

describe('a union is never reordered, even by a codec that asks', () => {
  it('clones the first operand', async () => {
    const sets = { a: range(0, 30), b: range(10, 13), c: range(5, 15) };
    const out = await collect(engineOf(sets).union(refs('a', 'b', 'c')));
    expect(out).toEqual(range(0, 30));
    expect(log.cloned).toEqual([30]);
  });
});

describe('a codec that does not ask keeps the operand order', () => {
  it('clones the first operand and meets the others as given, with the same answer', async () => {
    const sets = { a: range(0, 30), b: range(10, 13), c: range(5, 15), d: range(8, 28) };
    const out = await collect(engineOf(sets, plainCodec).intersect(refs('a', 'b', 'c', 'd')));
    expect(out).toEqual([10, 11, 12]);
    expect(log.cloned).toEqual([30]);
    expect(log.anded).toEqual([3, 10, 20]);
  });
});

describe('an intersect of three or more takes a chunk smallest first', () => {
  const sets = {
    a: range(0, 30),
    b: range(10, 13),
    c: range(5, 15),
    d: range(8, 28),
  };

  it('clones the smallest and meets the others in ascending size, with the same answer', async () => {
    const engine = engineOf(sets);
    const out = await collect(engine.intersect(refs('a', 'b', 'c', 'd')));
    expect(out).toEqual([10, 11, 12]);
    expect(log.cloned).toEqual([3]);
    expect(log.anded).toEqual([10, 20, 30]);
  });

  it('gives the same answer in every operand order', async () => {
    const names = ['a', 'b', 'c', 'd'];
    const orders = [names, [...names].reverse(), ['c', 'd', 'a', 'b'], ['d', 'a', 'c', 'b']];
    for (const order of orders) {
      const out = await collect(engineOf(sets).intersect(refs(...order)));
      expect(out, order.join('')).toEqual([10, 11, 12]);
      expect(log.cloned.at(-1), order.join('')).toBe(3);
    }
  });

  it('keeps equal sizes in operand order (the first of equals is the one cloned)', async () => {
    const engine = engineOf({ a: range(0, 5), b: range(0, 5), c: range(0, 5), d: range(0, 2) });
    expect(await collect(engine.intersect(refs('a', 'b', 'c')))).toEqual([0, 1, 2, 3, 4]);
    expect(log.cloned).toEqual([5]);
    expect(log.anded).toEqual([5, 5]);
  });

  it('stops at the first empty result: a disjoint smallest operand leaves the others unread', async () => {
    const engine = engineOf({ a: range(0, 30), b: [100], c: range(5, 15), d: range(8, 28) });
    expect(await collect(engine.intersect(refs('a', 'b', 'c', 'd')))).toEqual([]);
    expect(log.cloned).toEqual([1]);
    expect(log.anded).toEqual([10]);
  });

  it('leaves two operands in the order given, and folds an exclude in after the intersect', async () => {
    const engine = engineOf({ ...sets, x: [11] });
    expect(await collect(engine.intersect(refs('a', 'b')))).toEqual([10, 11, 12]);
    expect(log.cloned).toEqual([30]);
    expect(log.anded).toEqual([3]);
    log.cloned.length = 0;
    log.anded.length = 0;
    const out = await collect(engine.intersect(refs('a', 'c', 'd'), { exclude: refs('x') }));
    expect(out).toEqual(range(8, 15).filter((v) => v !== 11));
    expect(log.cloned).toEqual([10]);
    expect(log.anded).toEqual([20, 30]);
    expect(log.andNotted).toEqual([1]);
  });
});
