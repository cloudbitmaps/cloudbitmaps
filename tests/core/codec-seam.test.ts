/**
 * Proves the bitmap-codec seam: `SegmentEngine` is genuinely codec-AGNOSTIC — it works with a
 * codec that has nothing to do with roaring. This is the real guard the seam is worth cutting: if the engine
 * had leaked a roaring-specific assumption, this non-roaring codec would break it.
 *
 * `SetCodec` is a deliberately naive `CodecInterface` over a plain JS `Set<number>` (serialize = JSON). It is
 * NOT a real codec (no compression, not the `bitset`/`soaring` we'll ship) — just enough to exercise every
 * operation the engine calls through the interface: construct, deserialize under a size cap, membership,
 * count, ascending iteration, and the set algebra the combines run on (`clone`/`andInPlace`/`orInPlace`/
 * `andNotInPlace`).
 *
 * Generations are seeded as bytes the codec under test produced — a chunk of a generation is exactly "what
 * this codec's `serialize()` wrote", so seeding is the whole write side of the seam.
 */
import { SegmentEngine } from '@/core/engine';
import { MemoryColdChunkSource } from '@/index';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import { IntegrityError } from '@/core/errors';
import { collect } from '../helpers/loaded';

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
    return new SetBitmap(new Set(this.s));
  }
  orInPlace(other: CodecBitmap): void {
    for (const v of (other as SetBitmap).s) this.s.add(v);
  }
  andNotInPlace(other: CodecBitmap): void {
    for (const v of (other as SetBitmap).s) this.s.delete(v);
  }
  andInPlace(other: CodecBitmap): void {
    const o = (other as SetBitmap).s;
    for (const v of [...this.s]) if (!o.has(v)) this.s.delete(v);
  }
  *[Symbol.iterator](): IterableIterator<number> {
    yield* [...this.s].sort((a, b) => a - b);
  }
  toArray(): number[] {
    return [...this.s].sort((a, b) => a - b);
  }
}

const setCodec: CodecInterface = {
  empty: () => new SetBitmap(),
  fromValues: (vs) => new SetBitmap(new Set(vs)),
  safeDeserialize: (bytes, maxBytes) => {
    if (bytes.length > maxBytes)
      throw new IntegrityError(`over cap: ${bytes.length} > ${maxBytes}`);
    return new SetBitmap(new Set(JSON.parse(new TextDecoder().decode(bytes)) as number[]));
  },
};

/** Seed one chunk of a segment with bytes the codec under test produced (remainders, as a chunk holds). */
function seed(
  cold: MemoryColdChunkSource,
  segment: string,
  chunkKey: number,
  rems: number[],
): void {
  cold.seed({ segment, chunkKey }, setCodec.fromValues(rems).serialize());
}

describe('bitmap-codec seam: the engine runs on a non-roaring codec', () => {
  const seg = { segment: 'a' } as const;

  it('has / count / iterate all work through an injected SetCodec', async () => {
    const cold = new MemoryColdChunkSource();
    seed(cold, 'a', 0, [1, 3, 5]);
    seed(cold, 'a', 1, [70_000 & 0xffff]); // spans a second 16-bit chunk
    const engine = new SegmentEngine({ cold, codec: setCodec });

    expect(await engine.has(seg, 5)).toBe(true);
    expect(await engine.has(seg, 2)).toBe(false);
    expect(await engine.count(seg)).toBe(4);
    expect(await collect(engine.iterate(seg))).toEqual([1, 3, 5, 70_000]);
  });

  it('runs the combine set algebra through the codec — union, andNot, and a folded-in exclude', async () => {
    // Every in-place op the engine calls is exercised here: `orInPlace` (union), `andInPlace` (intersect),
    // `andNotInPlace` (the exclude/andNot fold), over a `clone()` of the first operand's cached chunk.
    const cold = new MemoryColdChunkSource();
    seed(cold, 'a', 0, [10, 20, 30]);
    seed(cold, 'b', 0, [20, 30, 40]);
    seed(cold, 'sup', 0, [30]);
    const engine = new SegmentEngine({ cold, codec: setCodec });
    const a = { segment: 'a' };
    const b = { segment: 'b' };
    const sup = { segment: 'sup' };

    expect(await collect(engine.union([a, b]))).toEqual([10, 20, 30, 40]);
    expect(await collect(engine.andNot(a, [sup]))).toEqual([10, 20]);
    expect(await collect(engine.intersect([a, b], { exclude: [sup] }))).toEqual([20]);
  });

  it('chunk-skipping intersect works through the codec (crown jewel, codec-agnostic)', async () => {
    const cold = new MemoryColdChunkSource();
    seed(cold, 'a', 0, [1, 2, 3]);
    seed(cold, 'b', 0, [2, 3, 4]);
    const engine = new SegmentEngine({ cold, codec: setCodec });
    expect(await collect(engine.intersect([{ segment: 'a' }, { segment: 'b' }]))).toEqual([2, 3]);
  });

  it('the size cap is the codec’s to enforce, and the engine hands it down', async () => {
    // The engine never decodes bytes itself, so the untrusted-input cap (invariant 5) is only real if
    // `maxBitmapBytes` actually reaches `safeDeserialize`. A 1-byte cap makes any real chunk fail.
    const cold = new MemoryColdChunkSource();
    seed(cold, 'a', 0, [1, 2, 3]);
    const engine = new SegmentEngine({ cold, codec: setCodec, maxBitmapBytes: 1 });
    await expect(engine.has(seg, 1)).rejects.toThrow(IntegrityError);
  });
});
