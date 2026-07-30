/**
 * Proves the bitmap-codec seam: `SegmentEngine` is genuinely codec-AGNOSTIC — it works with a
 * codec that has nothing to do with roaring. This is the real guard the seam is worth cutting: if the engine
 * had leaked a roaring-specific assumption, this non-roaring codec would break it.
 *
 * `SetCodec` is a deliberately naive `CodecInterface` over a plain JS `Set<number>` (serialize = JSON). It is
 * NOT a real codec (no compression, not the `bitset`/`soaring` we'll ship) — just enough to exercise every
 * operation the engine calls through the interface: construct, (de)serialize with a size cap, the set algebra
 * for tier-merge (`orInPlace`/`andNotInPlace`/`andInPlace`), membership, count, ascending iteration.
 */
import { SegmentEngine } from '@/core/engine';
import { MemoryWarmDriver, MemoryColdChunkSource } from '@/index';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import { IntegrityError } from '@/core/errors';

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

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('bitmap-codec seam: the engine runs on a non-roaring codec', () => {
  const seg = { segment: 'a' } as const;

  it('add / has / remove / count / iterate all work through an injected SetCodec', async () => {
    const engine = new SegmentEngine({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      codec: setCodec,
    });
    await engine.add(seg, 5);
    await engine.add(seg, 70_000); // spans a second 16-bit chunk
    await engine.addMany(seg, [1, 2, 3]);
    await engine.remove(seg, 2);

    expect(await engine.has(seg, 5)).toBe(true);
    expect(await engine.has(seg, 2)).toBe(false);
    expect(await engine.count(seg)).toBe(4);
    expect(await collect(engine.iterate(seg))).toEqual([1, 3, 5, 70_000]);
  });

  it('tier-merges a cold base under a warm delta — the (cold ∪ adds) \\ removes path via the codec', async () => {
    const cold = new MemoryColdChunkSource();
    // Seed chunk 0 (ids 10,20,30) with SetCodec-serialized bytes — the engine must decode them via the codec.
    cold.seed({ ...seg, chunkKey: 0 }, setCodec.fromValues([10, 20, 30]).serialize());
    const engine = new SegmentEngine({ warm: new MemoryWarmDriver(), cold, codec: setCodec });

    await engine.add(seg, 40); // warm add
    await engine.remove(seg, 20); // warm tombstone over the cold base
    expect(await collect(engine.iterate(seg))).toEqual([10, 30, 40]);
    expect(await engine.count(seg)).toBe(3);
  });

  it('chunk-skipping intersect works through the codec (crown jewel, codec-agnostic)', async () => {
    const cold = new MemoryColdChunkSource();
    cold.seed({ segment: 'a', chunkKey: 0 }, setCodec.fromValues([1, 2, 3]).serialize());
    cold.seed({ segment: 'b', chunkKey: 0 }, setCodec.fromValues([2, 3, 4]).serialize());
    const engine = new SegmentEngine({ warm: new MemoryWarmDriver(), cold, codec: setCodec });
    expect(await collect(engine.intersect([{ segment: 'a' }, { segment: 'b' }]))).toEqual([2, 3]);
  });
});
