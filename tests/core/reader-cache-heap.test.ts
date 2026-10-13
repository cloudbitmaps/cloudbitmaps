import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { CrbmStorageChunkSource } from '@/index';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * The reader cache's byte bound must not under-count the heap its readers retain. The cache evicts on the weight it
 * is told, so a weight that leaves out each reader's fixed objects (the snapshot, the reader, its typed arrays,
 * closures and promises) lets a fleet of small segments hold far more than `maxOpenIndexBytes` says.
 *
 * This seeds many one-chunk segments, collects, opens every one through a source whose caches are large enough to
 * keep them all, collects again, and divides the heap that stayed by the count. The counted weight per reader must
 * be at least MIN_RATIO of that and at most MAX_RATIO of it, so the constant neither under-counts nor wastes the
 * budget. Collections repeat until the heap stops shrinking, and the ratios leave room for the engine's own
 * variation between versions.
 */
const SEGMENTS = 2_000;
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.6;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as (options?: { type: 'major'; execution: 'sync' }) => void;

function heapUsed(): number {
  let last = Infinity;
  for (let i = 0; i < 12; i++) {
    gc({ type: 'major', execution: 'sync' });
    const stats = getHeapStatistics();
    const now = stats.used_heap_size + stats.external_memory;
    if (Math.abs(last - now) < 4 * 1024) return now;
    last = now;
  }
  return last;
}

interface Inside {
  snapshots: { weightBytes: number };
}

describe('the reader cache weight versus the heap its readers retain', () => {
  it.each([[false], [true]])(
    `counts between ${MIN_RATIO} and ${MAX_RATIO} of the heap a tiny reader retains, encrypted %s`,
    async (encrypted) => {
      const registry = new MemoryRegistryDriver({ now: () => 0 });
      const storage = new MemoryStorageDriver();
      const refs = Array.from({ length: SEGMENTS }, (_, i) => ({ segment: `seg-${i}` }));
      const keystore = encrypted
        ? new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' })
        : undefined;
      for (const ref of refs) {
        await bulkLoadCrbmGeneration(storage, { ...ref, generation: 0 }, [1, 2], {
          registry,
          ...(keystore === undefined ? {} : { keystore }),
        });
      }
      const source = new CrbmStorageChunkSource(storage, {
        registry,
        ...(keystore === undefined ? {} : { keystore }),
        maxOpenSegments: SEGMENTS * 2,
        maxOpenIndexBytes: 1 << 30,
      });
      const before = heapUsed();
      for (const ref of refs) {
        await source.listChunkKeys(ref);
        // A busy process allocates from a slab of Node's shared buffer pool (8 KiB on Node 22, 64 KiB on recent Node 24) between opens, so a key kept as a view on the
        // pool pins the slab it was taken from: advance the pool by that much.
        for (let i = 0; i < 64; i++) Buffer.allocUnsafe(1024);
      }
      const after = heapUsed();
      const retained = (after - before) / SEGMENTS;
      const counted = (source as unknown as Inside).snapshots.weightBytes / SEGMENTS;
      const ratio = counted / retained;
      const why = `counted ${counted} B, retained ${retained} B a reader`;
      expect(ratio, why).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(ratio, why).toBeLessThanOrEqual(MAX_RATIO);
    },
  );
});
