import { chunkRefKey, segmentPrefix } from '@/core/keys';
import type { ChunkRef, SegmentRef, SegmentSize, StorageChunkSource } from '@/core/ports';
import { validateChunkRef, validateSegmentRef } from '@/core/validate';

/**
 * A `StorageChunkSource` a test seeds chunk by chunk: no `.crbm`, no registry, no generations. It stores the
 * bytes it is handed, so the engine's safe-deserialize and size-cap paths still run over them.
 *
 * It is a test double and not a shipped backend: a store built on it is cleartext and read-only, and the loaded
 * store's write path (`store.load`, the `*Into` verbs, erasure) needs a backend. Tests that exercise the
 * engine's read path in isolation use it; everything else loads into a `MemoryStorage`.
 */
export class MemoryStorageChunkSource implements StorageChunkSource {
  private readonly chunks = new Map<string, Uint8Array>();

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    validateChunkRef(ref);
    return this.chunks.get(chunkRefKey(ref)) ?? null;
  }

  async listChunkKeys(ref: SegmentRef): Promise<number[]> {
    validateSegmentRef(ref);
    const prefix = segmentPrefix(ref);
    const keys: number[] = [];
    for (const key of this.chunks.keys()) {
      if (key.startsWith(prefix)) keys.push(Number(key.slice(prefix.length)));
    }
    return keys;
  }

  async sizeOf(ref: SegmentRef): Promise<SegmentSize | null> {
    validateSegmentRef(ref);
    const prefix = segmentPrefix(ref);
    let sizeBytes = 0;
    let found = false;
    for (const [key, bytes] of this.chunks) {
      if (!key.startsWith(prefix)) continue;
      found = true;
      sizeBytes += bytes.length;
    }
    return found ? { sizeBytes } : null;
  }

  /** Populate the stored bytes for a chunk directly, bypassing the `.crbm` format. */
  seed(ref: ChunkRef, bytes: Uint8Array): void {
    validateChunkRef(ref); // symmetric with the validated read path
    this.chunks.set(chunkRefKey(ref), bytes);
  }
}
