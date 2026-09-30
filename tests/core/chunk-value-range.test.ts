import { publishGeneration, writeCrbmGeneration } from '@/core/crbm-storage-source';
import { MemoryStorageChunkSource } from '../helpers/memory-chunk-source';
import { RoaringBitmap32, SerializationFormat } from 'roaring';
import {
  CloudRoaring,
  createBackend,
  IntegrityError,
  MemoryStorageDriver,
  MemoryRegistryDriver,
} from '@/index';
import { eraseIdFromSegment } from '@/core/erase-id';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { joinId, MAX_REMAINDER } from '@/core/bit-route';
import { collect } from '../helpers/loaded';
import { craftPortable, type CraftedContainer } from '../helpers/portable-bytes';
import type { CodecBitmap } from '@/core/codec';

// A chunk payload holds REMAINDERS — 16-bit offsets within one chunk. Nothing upstream enforces that: the
// byte/length caps bound size, and CRC/AEAD only prove the bytes are the bytes that were written, which anyone
// able to write the bucket satisfies by construction. Unchecked, a value >= 65536 reaches `joinId`, which masks
// it and emits a FABRICATED id in a different chunk's id space — indistinguishable from real data, inflating
// count() and creating spurious intersect matches. Invariant 5 says every byte read back from storage is
// untrusted, so the chunk decode checks "well-formed" rather than assuming it.
//
// NOTE ON PLACEMENT. The check does not belong in `SafeBitmap.safeDeserialize`: that is the codec's GENERAL
// entry point, also used for full-segment exports where u32 values are entirely legitimate. The 16-bit rule
// belongs where a payload is interpreted AS A CHUNK: `SegmentEngine`'s storage-chunk decode
// (`assertChunkPayloadInRange`), and the erasure rewrite's decode of each chunk it carries into a new generation
// (`assertRemaindersInRange` in `erase-id.ts`).
const CAP = 1 << 20;

/** A chunk payload carrying an illegal (>16-bit) value, bypassing every writer guard the way corrupt bytes do. */
function forgeChunk(values: number[]): Uint8Array {
  return new RoaringBitmap32(values).serialize(SerializationFormat.portable);
}

/** A store whose segment `s` has one seeded chunk, at `chunkKey`, holding exactly `values`. */
function storeWithChunk(chunkKey: number, values: number[]): CloudRoaring {
  const storage = new MemoryStorageChunkSource();
  storage.seed({ segment: 's', chunkKey }, forgeChunk(values));
  return new CloudRoaring({ storage });
}

describe('chunk payload value range', () => {
  it('rejects a storage chunk holding a value past the remainder range, on every read path', async () => {
    const seg = storeWithChunk(3, [1, 2, 70_000]).segment('s');
    // Every verb that decodes a chunk must refuse it — a read that answered from one path and threw from
    // another would let a fabricated id reach a caller intermittently.
    await expect(seg.has(joinId(3, 1))).rejects.toBeInstanceOf(IntegrityError);
    await expect(seg.has(joinId(3, 1))).rejects.toThrow(/70000/);
    await expect(seg.count()).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(seg.iterate())).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses it inside a combine too, where the fabricated id would become a spurious match', async () => {
    const storage = new MemoryStorageChunkSource();
    storage.seed({ segment: 'bad', chunkKey: 3 }, forgeChunk([1, 70_000]));
    storage.seed({ segment: 'ok', chunkKey: 3 }, forgeChunk([1, 2]));
    const store = new CloudRoaring({ storage });
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
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const SEG = { segment: 's' };
    await writeCrbmGeneration(storage, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2]) }, // clean: the chunk holding the erased id
      { chunkKey: 1, bitmap: SafeBitmap.fromValues([70_000]) }, // corrupt: carried through by the rewrite
    ]);
    await publishGeneration(registry, { ...SEG, generation: 0 });
    const deps = { storage, registry, codec: roaringCodec };

    await expect(eraseIdFromSegment(SEG, joinId(0, 1), deps)).rejects.toBeInstanceOf(
      IntegrityError,
    );
    // Nothing was published, so the corruption was not propagated and the pointer still names generation 0.
    expect((await registry.get(SEG))!.currentGen).toBe(0);
  });

  it('checks the chunk it is about to rewrite, not only the ones it copies', async () => {
    // The other half: the target chunk is decoded in the main body rather than in the pass-through generator, so
    // it needs the same check — and it is the chunk most likely to be corrupt, since it is the one being edited.
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const SEG = { segment: 's' };
    await writeCrbmGeneration(storage, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 70_000]) },
    ]);
    await publishGeneration(registry, { ...SEG, generation: 0 });

    await expect(
      eraseIdFromSegment(SEG, joinId(0, 1), { storage, registry, codec: roaringCodec }),
    ).rejects.toThrow(/70000/);
    expect((await registry.get(SEG))!.currentGen).toBe(0);
  });

  it('leaves the general codec entry point free to hold u32 values', () => {
    // Exports serialize a whole segment's ids, which legitimately exceed 16 bits. The check must NOT live here
    // — this assertion fails if it does.
    const big = new RoaringBitmap32([100_000, 4_000_000_000]).serialize(
      SerializationFormat.portable,
    );
    expect(() => roaringCodec.safeDeserialize(big, CAP)).not.toThrow();
    expect(roaringCodec.safeDeserialize(big, CAP).toArray()).toEqual([100_000, 4_000_000_000]);
  });

  it('documents the fabrication an unchecked value produces', () => {
    // Why it matters, concretely: unchecked, the bad value does not error downstream — it becomes a real-looking
    // id belonging to a different chunk.
    expect(joinId(3, 70_000)).toBe(joinId(3, 70_000 & MAX_REMAINDER));
    expect(joinId(3, 70_000)).not.toBe(70_000);
  });
});

// The range check above reads `maximum()`, which roaring answers from the LAST container. That is only the
// largest value while the containers are in key order and each one is well formed, and the native deserializer
// checks neither. Unchecked, a payload listing container 1 before container 0 passes the range check with the
// value from container 0, and a read then yields container 1's values masked into this chunk: ids the chunk does
// not hold, which `has()` denies. These tests hold every read path to refusing that payload.
describe('chunk payload structure', () => {
  const OUT_OF_ORDER: readonly CraftedContainer[] = [
    { key: 1, kind: 'array', values: [5] },
    { key: 0, kind: 'array', values: [7] },
  ];

  /** A store whose segments each hold one seeded chunk, at `chunkKey`, of exactly `bytes`. */
  function storeWith(chunks: Record<string, Uint8Array>, chunkKey: number): CloudRoaring {
    const storage = new MemoryStorageChunkSource();
    for (const [segment, bytes] of Object.entries(chunks)) {
      storage.seed({ segment, chunkKey }, bytes);
    }
    return new CloudRoaring({ storage });
  }

  it('refuses a chunk whose containers are out of order, on every read path', async () => {
    const store = storeWith({ bad: craftPortable(OUT_OF_ORDER), ok: forgeChunk([5, 7]) }, 9);
    const bad = store.segment('bad');
    const ok = store.segment('ok');
    // Unchecked, `iterate` yields joinId(9, 5) — container 1's value 65541, masked — and `has` of that id says
    // false, so the read and the membership test disagree about the same segment.
    await expect(bad.has(joinId(9, 7))).rejects.toBeInstanceOf(IntegrityError);
    await expect(bad.count()).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(bad.iterate())).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      collect(bad.iterate({ after: joinId(9, 0), through: joinId(9, 6) })),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(bad.intersect([ok]))).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(ok.union([bad]))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses a chunk whose run container has no runs before anything iterates it', async () => {
    // Unchecked, iterating this one, or intersecting with it, crashes the process. `has` is the one verb that
    // does not, and it is refused too: the refusal is at the decode, which every verb shares.
    const bytes = craftPortable([{ key: 0, kind: 'run', runs: [], cardinality: 1 }]);
    await expect(storeWith({ s: bytes }, 0).segment('s').has(0)).rejects.toBeInstanceOf(
      IntegrityError,
    );
  });

  it('refuses to carry an out-of-order chunk into a new generation during an erasure', async () => {
    // Unchecked, the rewrite decodes the chunk, re-encodes it as it is, and `verifyGeneration` passes it: chunk
    // keys and cardinality both match. The call reports `erased: true` over a new generation that carries the
    // corruption forward.
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const SEG = { segment: 's' };
    const crafted = craftPortable(OUT_OF_ORDER);
    // A bitmap that serializes to the crafted bytes, which is how the bytes reach a real `.crbm` past every
    // writer guard, the way a hostile or corrupt object would.
    const forged = { isEmpty: false, size: 2, serialize: () => crafted } as unknown as CodecBitmap;
    await writeCrbmGeneration(storage, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2]) },
      { chunkKey: 1, bitmap: forged },
    ]);
    await publishGeneration(registry, { ...SEG, generation: 0 });

    await expect(
      eraseIdFromSegment(SEG, joinId(0, 1), { storage, registry, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect((await registry.get(SEG))!.currentGen).toBe(0);
  });
  /** A real `.crbm` generation, published, whose chunk 1 holds `crafted` under valid checksums. */
  async function storeWithForgedGeneration(crafted: Uint8Array): Promise<CloudRoaring> {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const SEG = { segment: 's' };
    const forged = { isEmpty: false, size: 2, serialize: () => crafted } as unknown as CodecBitmap;
    await writeCrbmGeneration(storage, { ...SEG, generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2]) },
      { chunkKey: 1, bitmap: forged },
    ]);
    await publishGeneration(registry, { ...SEG, generation: 0 });
    return new CloudRoaring({ storage: createBackend({ storage, registry }), retry: false });
  }

  it('refuses it on a pinned read and in an export, the two paths that do not go through a plain read', async () => {
    const store = await storeWithForgedGeneration(craftPortable(OUT_OF_ORDER));
    const pinned = await store.segment('s').pin();
    await expect(pinned.has(joinId(1, 7))).rejects.toBeInstanceOf(IntegrityError);
    await expect(collect(pinned.iterate())).rejects.toBeInstanceOf(IntegrityError);

    for (const format of ['roaring', 'ndjson'] as const) {
      const opened: string[] = [];
      const aborted: string[] = [];
      const manifest = await store.exportSegments(
        {
          open: (ref) => {
            opened.push(ref.segment);
            return {
              write: () => undefined,
              close: () => undefined,
              abort: () => void aborted.push(ref.segment),
            };
          },
        },
        { format },
      );
      // The segment is recorded as failed, and no file is left standing for it.
      expect(manifest.failed.map((f) => f.segment)).toEqual(['s']);
      expect(manifest.segments).toEqual([]);
      expect(aborted).toEqual(opened);
    }
  });

  it('checks a chunk once per fetch: not per id, and not again on a cache hit', async () => {
    const storage = new MemoryStorageChunkSource();
    storage.seed({ segment: 's', chunkKey: 0 }, forgeChunk([1, 2, 3, 4]));
    const store = new CloudRoaring({ storage });
    const seg = store.segment('s');
    const spy = vi.spyOn(SafeBitmap, 'safeDeserialize');
    try {
      for (const id of [1, 2, 3, 4, 5]) await seg.has(id);
      await seg.count();
      await collect(seg.iterate());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
