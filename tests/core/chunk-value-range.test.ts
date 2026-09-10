import { RoaringBitmap32, SerializationFormat } from 'roaring';
import {
  CloudRoaring,
  IntegrityError,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  publishGeneration,
  writeCrbmGeneration,
} from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { joinId, MAX_REMAINDER } from '@/core/bit-route';
import { collect } from '../helpers/loaded';

// A chunk payload holds REMAINDERS — 16-bit offsets within one chunk. Nothing enforced that: the byte/length
// caps bound size, and CRC/AEAD only prove the bytes are the bytes that were written, which anyone able to
// write the bucket satisfies by construction. A value >= 65536 then reached `joinId`, which masks it and
// emitted a FABRICATED id in a different chunk's id space — indistinguishable from real data, inflating
// count() and creating spurious intersect matches. Invariant 5 says every byte read back from storage is
// untrusted; this was the one place "well-formed" was assumed rather than checked.
//
// NOTE ON PLACEMENT. The first attempt put this check inside `SafeBitmap.safeDeserialize` and broke two tests
// immediately: that is the codec's GENERAL entry point, also used for full-segment exports where u32 values
// are entirely legitimate. The 16-bit rule belongs where a payload is interpreted AS A CHUNK — which, now that
// there is one tier, means exactly one place: `SegmentEngine`'s cold-chunk decode (`assertChunkPayloadInRange`).
// The check moved with the tier; the reason it exists did not.
const CAP = 1 << 20;

/** A chunk payload carrying an illegal (>16-bit) value, bypassing every writer guard the way corrupt bytes do. */
function forgeChunk(values: number[]): Uint8Array {
  return new RoaringBitmap32(values).serialize(SerializationFormat.portable);
}

/** A store whose segment `s` has one seeded chunk, at `chunkKey`, holding exactly `values`. */
function storeWithChunk(chunkKey: number, values: number[]): CloudRoaring {
  const cold = new MemoryColdChunkSource();
  cold.seed({ segment: 's', chunkKey }, forgeChunk(values));
  return new CloudRoaring({ cold });
}

describe('chunk payload value range', () => {
  it('rejects a cold chunk holding a value past the remainder range, on every read path', async () => {
    const seg = storeWithChunk(3, [1, 2, 70_000]).segment('s');
    // Every verb that decodes a chunk must refuse it — a read that answered from one path and threw from
    // another is how a fabricated id used to reach a caller intermittently.
    await expect(seg.has(joinId(3, 1))).rejects.toBeInstanceOf(IntegrityError);
    await expect(seg.has(joinId(3, 1))).rejects.toThrow(/70000/);
    await expect(seg.count()).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(seg.iterate())).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses it inside a combine too, where the fabricated id would become a spurious match', async () => {
    const cold = new MemoryColdChunkSource();
    cold.seed({ segment: 'bad', chunkKey: 3 }, forgeChunk([1, 70_000]));
    cold.seed({ segment: 'ok', chunkKey: 3 }, forgeChunk([1, 2]));
    const store = new CloudRoaring({ cold });
    await expect(
      collect(store.segment('bad').intersect([store.segment('ok')])),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it('accepts the boundary value and rejects boundary + 1', async () => {
    await expect(storeWithChunk(0, [MAX_REMAINDER]).segment('s').count()).resolves.toBe(1);
    await expect(
      storeWithChunk(0, [MAX_REMAINDER + 1])
        .segment('s')
        .count(),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses to carry a corrupt chunk into a new generation — the erasure rewrite checks it too', async () => {
    // The rewrite decodes and re-encodes every chunk, so it is a place a bad value can be *copied forward*: the
    // new object would carry the corruption, `verifyGeneration` (chunk keys + cardinality) would not see it, and
    // the call would report `erased: true` over a segment that still cannot be read. Refusing says the useful
    // thing instead — this segment is corrupt — and it costs one `maximum()` call per chunk.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const SEG = { segment: 's' };
    await writeCrbmGeneration(cold, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2]) }, // clean: the chunk holding the erased id
      { chunkKey: 1, bitmap: SafeBitmap.fromValues([70_000]) }, // corrupt: carried through by the rewrite
    ]);
    await publishGeneration(registry, { ...SEG, generation: 0 });
    const deps = { cold, registry, codec: roaringCodec };

    await expect(eraseIdFromSegment(SEG, joinId(0, 1), deps)).rejects.toBeInstanceOf(
      IntegrityError,
    );
    // Nothing was published, so the corruption was not propagated and the pointer still names generation 0.
    expect((await registry.get(SEG))!.currentGen).toBe(0);
  });

  it('checks the chunk it is about to rewrite, not only the ones it copies', async () => {
    // The other half: the target chunk is decoded in the main body rather than in the pass-through generator, so
    // it needs the same check — and it is the chunk most likely to be corrupt, since it is the one being edited.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const SEG = { segment: 's' };
    await writeCrbmGeneration(cold, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 70_000]) },
    ]);
    await publishGeneration(registry, { ...SEG, generation: 0 });

    await expect(
      eraseIdFromSegment(SEG, joinId(0, 1), { cold, registry, codec: roaringCodec }),
    ).rejects.toThrow(/70000/);
    expect((await registry.get(SEG))!.currentGen).toBe(0);
  });

  it('leaves the general codec entry point free to hold u32 values', () => {
    // Exports serialize a whole segment's ids, which legitimately exceed 16 bits. The check must NOT live here
    // — this assertion is what caught the first, wrong placement.
    const big = new RoaringBitmap32([100_000, 4_000_000_000]).serialize(
      SerializationFormat.portable,
    );
    expect(() => roaringCodec.safeDeserialize(big, CAP)).not.toThrow();
    expect(roaringCodec.safeDeserialize(big, CAP).toArray()).toEqual([100_000, 4_000_000_000]);
  });

  it('documents the fabrication that used to result', () => {
    // Why it mattered, concretely: the bad value did not error downstream — it became a real-looking id
    // belonging to a different chunk.
    expect(joinId(3, 70_000)).toBe(joinId(3, 70_000 & MAX_REMAINDER));
    expect(joinId(3, 70_000)).not.toBe(70_000);
  });
});
