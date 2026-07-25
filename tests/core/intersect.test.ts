import fc from 'fast-check';
import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { SegmentEngine } from '@/core/engine';
import { SafeBitmap } from '@/roaring-codec';
import { splitId, joinId } from '@/core/bit-route';
import { ValidationError } from '@/core/errors';
import type { ChunkRef, ColdChunkSource, SegmentRef } from '@/core/ports';

/** A ColdChunkSource that records every getChunk call — to prove chunk-skipping (non-overlapping keys
 * are never fetched). Delegates to an in-memory source. */
class CountingCold implements ColdChunkSource {
  private readonly inner = new MemoryColdChunkSource();
  readonly fetched: string[] = [];

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.fetched.push(`${ref.namespace ?? '/'}|${ref.segment}|${ref.chunkKey}`);
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
  seedChunk(ref: ChunkRef, ids: number[]): void {
    this.inner.seed(ref, SafeBitmap.fromValues(ids).serialize());
  }
}

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
}

/** Seed a segment's Cold tier from a flat id list, grouped by chunk. */
function seedCold(cold: CountingCold, segment: string, ids: number[]): void {
  const byChunk = new Map<number, number[]>();
  for (const id of ids) {
    const { chunkKey, remainder } = splitId(id);
    (byChunk.get(chunkKey) ?? byChunk.set(chunkKey, []).get(chunkKey)!).push(remainder);
  }
  for (const [chunkKey, rems] of byChunk) cold.seedChunk({ segment, chunkKey }, rems);
}

describe('chunk-skipping intersection (Phase 3a)', () => {
  it('returns the set-intersection, ascending', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3, 100, 200_000]);
    seedCold(cold, 'b', [2, 3, 4, 200_000, 999]);
    const a = store.segment('a');
    const b = store.segment('b');
    expect(await collect(a.intersect([b]))).toEqual([2, 3, 200_000]);
  });

  it('is commutative', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3, 70_000]);
    seedCold(cold, 'b', [3, 70_000, 4]);
    const a = store.segment('a');
    const b = store.segment('b');
    expect(await collect(a.intersect([b]))).toEqual(await collect(b.intersect([a])));
  });

  it('NEVER fetches chunks for non-overlapping keys (the core saving)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    // Chunk keys: a = {0, 5, 12}; b = {0, 9, 12}; common = {0, 12}.
    seedCold(cold, 'a', [joinId(0, 1), joinId(0, 2), joinId(5, 1), joinId(12, 7)]);
    seedCold(cold, 'b', [joinId(0, 2), joinId(0, 3), joinId(9, 1), joinId(12, 8)]);
    const a = store.segment('a');
    const b = store.segment('b');

    await collect(a.intersect([b]));

    // Exact fetched set: ONLY the common keys {0,12} of BOTH operands — no non-overlapping key (5/9) and
    // no operand×key over-fetch. Pinning the exact set (not just "no 5/9") is what makes this a real bar.
    expect(new Set(cold.fetched)).toEqual(new Set(['/|a|0', '/|a|12', '/|b|0', '/|b|12']));
  });

  it('returns ∅ with zero payload fetches when no keys overlap', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [joinId(1, 1)]);
    seedCold(cold, 'b', [joinId(2, 1)]);
    const a = store.segment('a');
    const b = store.segment('b');
    expect(await collect(a.intersect([b]))).toEqual([]);
    expect(cold.fetched).toEqual([]); // index maps aligned; no chunk bytes downloaded
  });

  it('merges tiers on both operands (warm adds + tombstones honored)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3]);
    seedCold(cold, 'b', [2, 3]);
    const a = store.segment('a');
    const b = store.segment('b');
    await a.add(50); // warm-only add on a
    await b.add(50); // warm-only add on b → 50 now in both
    await a.remove(3); // tombstone on a → 3 no longer in a's effective set
    expect(await collect(a.intersect([b]))).toEqual([2, 50]);
  });

  it('intersects a warm-only chunk against a cold-only chunk', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    const a = store.segment('a');
    const b = store.segment('b');
    await a.addMany([7, 8, 9]); // a is entirely warm (no cold seed)
    seedCold(cold, 'b', [8, 9, 10]); // b is entirely cold
    expect(await collect(a.intersect([b]))).toEqual([8, 9]);
  });

  it('intersects three or more segments', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3, 4, 5]);
    seedCold(cold, 'b', [2, 3, 4, 5]);
    seedCold(cold, 'c', [3, 4, 5, 6]);
    const [a, b, c] = [store.segment('a'), store.segment('b'), store.segment('c')];
    expect(await collect(a.intersect([b, c]))).toEqual([3, 4, 5]);
  });

  it('intersect with no others yields the segment itself', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3]);
    await store.segment('a').add(70_000);
    expect(await collect(store.segment('a').intersect([]))).toEqual([1, 2, 3, 70_000]);
  });

  it('gives the same result regardless of the concurrency window', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    // ids spanning several chunks so the window matters
    const idsA = Array.from({ length: 400 }, (_v, i) => i * 700);
    const idsB = idsA.filter((_v, i) => i % 2 === 0);
    seedCold(cold, 'a', idsA);
    seedCold(cold, 'b', idsB);
    const a = store.segment('a');
    const b = store.segment('b');
    const c1 = await collect(a.intersect([b], { concurrency: 1 }));
    const c8 = await collect(a.intersect([b], { concurrency: 8 }));
    const c64 = await collect(a.intersect([b], { concurrency: 64 }));
    expect(c1).toEqual(idsB);
    expect(c8).toEqual(c1);
    expect(c64).toEqual(c1);
  });

  it('materializes into a destination segment (intersectInto)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3, 70_000, 200_000]);
    seedCold(cold, 'b', [2, 3, 200_000]);
    const a = store.segment('a');
    const b = store.segment('b');
    const dest = store.segment('dest');
    await a.intersectInto(dest, [b]);
    expect(await collect(dest.iterate())).toEqual([2, 3, 200_000]);
    expect(await dest.count()).toBe(3);
  });

  it('intersecting a segment with itself yields its effective set (self-intersection)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3, 70_000]);
    const a = store.segment('a');
    await a.add(500);
    await a.remove(2);
    expect(await collect(a.intersect([a]))).toEqual([1, 3, 500, 70_000]);
  });

  // Boundary: the crown-jewel path at the top of the id space. Membership is proven at 0xFFFFFFFF elsewhere,
  // but intersect (joinId masking + assertChunkKeyInRange's `< 65536` edge + ascending merge across the full
  // span) was only sampled below chunk key 4 — a regression at the ceiling would have had no test.
  it('intersects at the maximum chunk-key span (id 0xFFFFFFFF, chunk 65535)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    const TOP = joinId(65_535, 65_535); // = 0xFFFF_FFFF, the u32 ceiling
    expect(TOP).toBe(0xffff_ffff);
    // Common in chunk 0 (id 1) and the top chunk (id TOP); b also has a non-overlapping id in the top chunk.
    seedCold(cold, 'a', [joinId(0, 1), TOP]);
    seedCold(cold, 'b', [joinId(0, 1), TOP, joinId(65_535, 1)]);
    const a = store.segment('a');
    const b = store.segment('b');
    // Correct set-intersection, ascending, spanning chunk 0 → chunk 65535 with the id at the very ceiling.
    expect(await collect(a.intersect([b]))).toEqual([joinId(0, 1), TOP]);
  });

  // Boundary: a chunk key present in BOTH operands' indexes, but fully tombstoned (empty effective set) in one
  // → intersectChunk must yield null and be skipped, NOT produce a phantom id. Proving the chunk was still
  // fetched (index keys aligned) pins the empty-chunk short-circuit rather than an accidental index-level skip.
  it('drops a common chunk whose effective set is empty in one operand (fetched, then skipped)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [joinId(3, 10), joinId(3, 20)]); // a's only chunk is key 3
    seedCold(cold, 'b', [joinId(3, 10)]); // b shares chunk key 3
    const a = store.segment('a');
    const b = store.segment('b');
    await a.remove(joinId(3, 10)); // tombstone every id in a's chunk 3 → effective set empty
    await a.remove(joinId(3, 20));
    expect(await collect(a.intersect([b]))).toEqual([]); // no phantom id from the fully-cancelled chunk
    // The common chunk WAS fetched on both operands (keys aligned) — the drop is the empty-effective-set
    // short-circuit, not index-level chunk-skipping.
    expect(new Set(cold.fetched)).toEqual(new Set(['/|a|3', '/|b|3']));
  });

  it('does not mutate the operands / poison the cache (andInPlace safety)', async () => {
    const cold = new CountingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    seedCold(cold, 'a', [1, 2, 3]);
    seedCold(cold, 'b', [2, 3, 4]);
    const a = store.segment('a');
    const b = store.segment('b');
    await collect(a.intersect([b])); // populates the HOT cache + runs andInPlace on fetched chunks
    // Operands must be unchanged afterward, and a second intersect must give the same result —
    // proving the in-place AND never mutated a cached/shared Cold bitmap.
    expect(await collect(a.iterate())).toEqual([1, 2, 3]);
    expect(await collect(b.iterate())).toEqual([2, 3, 4]);
    expect(await collect(a.intersect([b]))).toEqual([2, 3]);
  });

  it('rejects an empty operand list and a bad concurrency at the engine boundary', async () => {
    const engine = new SegmentEngine({
      codec: roaringCodec,
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
    });
    // The public Segment.intersect always includes `this`; exercise the engine guards directly.
    await expect(
      collect(engine.intersect([{ segment: 's' }, { segment: 't' }], { concurrency: NaN })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      collect(engine.intersect([{ segment: 's' }], { concurrency: 0 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(collect(engine.intersect([]))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('intersection vs Set oracle (property)', () => {
  const ID = fc.integer({ min: 0, max: 300_000 });
  const ids = fc.array(ID, { maxLength: 60 });

  it('matches Set-intersection across random multi-tier segments', async () => {
    const warmIds = fc.array(ID, { maxLength: 15 });
    await fc.assert(
      fc.asyncProperty(
        ids,
        ids,
        ids, // cold seeds for a, b, c
        fc.array(ID, { maxLength: 15 }), // warm adds (applied to all three)
        fc.tuple(warmIds, warmIds, warmIds), // independent warm removes per operand (a, b, c)
        fc.integer({ min: 1, max: 12 }), // randomized concurrency window
        async (ca, cb, cc, warmAdds, [remA, remB, remC], concurrency) => {
          const cold = new CountingCold();
          const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
          seedCold(cold, 'a', ca);
          seedCold(cold, 'b', cb);
          seedCold(cold, 'c', cc);
          const a = store.segment('a');
          const b = store.segment('b');
          const c = store.segment('c');

          const oa = new Set(ca);
          const ob = new Set(cb);
          const oc = new Set(cc);
          for (const id of warmAdds) {
            await a.add(id);
            await b.add(id);
            await c.add(id);
            oa.add(id);
            ob.add(id);
            oc.add(id);
          }
          // Independent removes per operand — so a bug honoring tombstones on only the first operand fails.
          for (const [seg, oracle, rems] of [
            [a, oa, remA],
            [b, ob, remB],
            [c, oc, remC],
          ] as const) {
            for (const id of rems) {
              await seg.remove(id);
              oracle.delete(id);
            }
          }

          const want = [...oa].filter((x) => ob.has(x) && oc.has(x)).sort((x, y) => x - y);
          const got = await collect(a.intersect([b, c], { concurrency }));
          expect(got).toEqual(want);
        },
      ),
      { numRuns: 150 },
    );
  });
});
