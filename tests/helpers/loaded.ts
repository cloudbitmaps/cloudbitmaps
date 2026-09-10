/**
 * Shared fixtures for the loaded store — every test that needs "a segment holding these ids" builds it here, so
 * the suite has one definition of how data gets into a segment (the same way it does in production: a
 * generation).
 *
 * Two shapes, for two kinds of test:
 *
 *  - {@link seedSegment} — populate a `MemoryColdChunkSource` chunk-by-chunk. No `.crbm`, no registry: the
 *    engine's routing/combine logic under test with nothing else in the way.
 *  - {@link loadedStore} / {@link load} — a real `CloudRoaring` over `MemoryColdDriver` + `MemoryRegistryDriver`,
 *    every segment written through `bulkLoadCrbmGeneration` and published. This is the production path end to
 *    end, and the fixture for anything that touches generations, the registry, or the lifecycle helpers.
 */
import {
  CloudRoaring,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  splitId,
} from '@/index';
import type { BulkLoadResult, CloudRoaringOptions, IKeystore, SegmentRef } from '@/index';
import { SafeBitmap } from '@/roaring-codec';

/** Normalise a segment name or ref to a ref. */
export function asRef(seg: string | SegmentRef): SegmentRef {
  return typeof seg === 'string' ? { segment: seg } : seg;
}

/**
 * Seed `ids` into `cold` for `seg`, grouped by chunk — each chunk's bytes are a serialized roaring bitmap of the
 * remainders, exactly what a `.crbm` chunk holds. Returns the chunk keys written, ascending.
 */
export function seedSegment(
  cold: MemoryColdChunkSource,
  seg: string | SegmentRef,
  ids: Iterable<number>,
): number[] {
  const ref = asRef(seg);
  const byChunk = new Map<number, number[]>();
  for (const id of ids) {
    const { chunkKey, remainder } = splitId(id);
    const bucket = byChunk.get(chunkKey);
    if (bucket) bucket.push(remainder);
    else byChunk.set(chunkKey, [remainder]);
  }
  const keys = [...byChunk.keys()].sort((a, b) => a - b);
  for (const chunkKey of keys) {
    cold.seed({ ...ref, chunkKey }, SafeBitmap.fromValues(byChunk.get(chunkKey)!).serialize());
  }
  return keys;
}

/** A `CloudRoaring` over a fresh `MemoryColdChunkSource`, with `segments` seeded chunk-by-chunk. */
export function seededStore(
  segments: Record<string, Iterable<number>> = {},
  options: Omit<CloudRoaringOptions, 'cold'> = {},
): { store: CloudRoaring; cold: MemoryColdChunkSource } {
  const cold = new MemoryColdChunkSource();
  for (const [name, ids] of Object.entries(segments)) seedSegment(cold, name, ids);
  return { store: new CloudRoaring({ ...options, cold }), cold };
}

export interface LoadedStore {
  readonly store: CloudRoaring;
  readonly cold: MemoryColdDriver;
  readonly registry: MemoryRegistryDriver;
  /** Load `ids` as the next generation of `seg` and publish it — the production write path. */
  load(
    seg: string | SegmentRef,
    ids: Iterable<number> | AsyncIterable<number>,
  ): Promise<BulkLoadResult>;
}

/**
 * A `CloudRoaring` over `MemoryColdDriver` + `MemoryRegistryDriver`, with every entry of `segments` loaded as
 * generation 0 through `bulkLoadCrbmGeneration` (+ publish). `load()` writes further generations.
 *
 * **`coldGenTtlMs` defaults to `0` ("pin the generation for this store's lifetime") when the caller passes
 * neither a `clock` nor a `coldGenTtlMs`,** and that default is what keeps these fixtures deterministic. Left
 * alone, the store would take its real defaults — a `SystemClock` and a 2,000 ms refresh TTL — so whether a
 * re-load became visible to an already-reading store would depend on how much *wall clock* elapsed between two
 * lines of a unit test: normally the stale generation, but the fresh one if the machine happened to pause. That
 * is a flake, not a test.
 *
 * So, to observe a re-load, do one of these deliberately:
 *   · construct a **second** store over the same `cold` + `registry` (the honest model of a different reader), or
 *   · pass `{ clock, coldGenTtlMs: 1 }` and advance the clock, which exercises the refresh path itself.
 */
export async function loadedStore(
  segments: Record<string, Iterable<number>> = {},
  options: Omit<CloudRoaringOptions, 'cold' | 'registry'> & { keystore?: IKeystore } = {},
): Promise<LoadedStore> {
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  const pinned = options.clock === undefined && options.coldGenTtlMs === undefined;
  const store = new CloudRoaring({
    ...(pinned ? { coldGenTtlMs: 0 } : {}),
    ...options,
    cold,
    registry,
  });
  const load: LoadedStore['load'] = async (seg, ids) => {
    const ref = asRef(seg);
    const record = await registry.get(ref);
    let generation = record?.currentGen ?? -1;
    for await (const key of cold.list(ref))
      if (key.generation > generation) generation = key.generation;
    return bulkLoadCrbmGeneration(cold, { ...ref, generation: generation + 1 }, ids, {
      registry,
      keystore: options.keystore,
      requireEncryption: options.requireEncryption,
    });
  };
  for (const [name, ids] of Object.entries(segments)) await load(name, ids);
  return { store, cold, registry, load };
}

/** Drain an async iterable of ids into an array. */
export async function collect(ids: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of ids) out.push(id);
  return out;
}
