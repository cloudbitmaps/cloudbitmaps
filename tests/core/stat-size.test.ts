import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChunkRef,
  IRegistryDriver,
  IStorageDriver,
  SegmentRef,
  SegmentSize,
  StorageChunkSource,
} from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { TransientError } from '@/core/errors';
import { CloudRoaring, LocalFsStorage, MemoryStorage } from '@/index';
import { counting } from '../helpers/counting';

/**
 * `stat()` reports `size`: the bytes of the object of the generation it describes, from that object's footer and
 * index, with no payload read. It is null for a segment with no generation and on a source that cannot say, a pin
 * reports its own generation's, and the four fields come from one opened generation, so the size is never another
 * generation's.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

/** Ids spread over `chunks` chunks, so two loads of different widths make objects of different sizes. */
const ids = (chunks: number): number[] =>
  Array.from({ length: chunks * 50 }, (_, i) => (i % chunks) * 65_536 + Math.floor(i / chunks));

/** The size `getTail` reports for one generation's object: what the bucket holds, read without the reader. */
async function objectBytes(storage: IStorageDriver, generation: number): Promise<number> {
  return (await storage.getTail({ ...SEG, generation }, 0)).size;
}

describe('stat().size', () => {
  it("is the current generation's object, byte for byte, and moves with each load", async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false });
    await store.load(SEG, ids(1), { keep: 9 });
    const seg = store.segment('s', { namespace: 'ns' });
    const first = await seg.stat();
    expect(first).toEqual({
      generation: 0,
      cardinality: 50,
      size: await objectBytes(backend.storage, 0),
    });

    await store.load(SEG, ids(4), { keep: 9 });
    const second = await seg.stat();
    expect(second.generation).toBe(1);
    expect(second.size).toBe(await objectBytes(backend.storage, 1));
    expect(second.size).not.toBe(first.size);
  });

  it('is the file on disk, on the local-filesystem backend', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cbm-stat-size-'));
    try {
      const store = new CloudRoaring({ storage: new LocalFsStorage(root), retry: false });
      await store.load(SEG, ids(3));
      const files = (readdirSync(join(root, 'storage'), { recursive: true }) as string[]).filter(
        (f) => f.endsWith('.crbm'),
      );
      expect(files).toHaveLength(1);
      const onDisk = statSync(join(root, 'storage', files[0]!)).size;
      expect((await store.segment('s', { namespace: 'ns' }).stat()).size).toBe(onDisk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is null for a segment with no generation', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage(), retry: false });
    expect(await store.segment('never', { namespace: 'ns' }).stat()).toEqual({
      generation: null,
      cardinality: 0,
      size: null,
    });
    // A row with a policy and no data is a segment with no generation too.
    await store.setRetention({ namespace: 'ns', segment: 'policy-only' }, { expiresAt: 4e12 });
    expect((await store.segment('policy-only', { namespace: 'ns' }).stat()).size).toBeNull();
  });

  it("is the pinned generation's on a pinned handle, whatever the live handle has moved to", async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, retry: false });
    await store.load(SEG, ids(1), { keep: 9 });
    const seg = store.segment('s', { namespace: 'ns' });
    const pinned = await seg.pin();
    await store.load(SEG, ids(4), { keep: 9 });
    store.invalidate(SEG);
    expect(await pinned.stat()).toEqual({
      generation: 0,
      cardinality: 50,
      size: await objectBytes(backend.storage, 0),
    });
    expect((await seg.stat()).size).toBe(await objectBytes(backend.storage, 1));

    // A pin of a segment with no generation has none to measure.
    const empty = await store.segment('none', { namespace: 'ns' }).pin();
    expect(await empty.stat()).toEqual({ generation: null, cardinality: 0, size: null });
  });

  it('is null on a source that cannot report a size, and what `sizeOf` says on one that can', async () => {
    const chunk = new Uint8Array([58, 48, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 7, 0]);
    /** A source with chunks and nothing else: no `stat`, no `summary`, no `sizeOf`. */
    class ChunksOnly implements StorageChunkSource {
      async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
        return ref.chunkKey === 0 ? chunk : null;
      }
      async listChunkKeys(): Promise<number[]> {
        return [0];
      }
    }
    const bare = new CloudRoaring({ storage: new ChunksOnly() });
    expect(await bare.segment('x').stat()).toEqual({
      generation: null,
      cardinality: 1,
      size: null,
    });

    class Sized extends ChunksOnly {
      async sizeOf(): Promise<SegmentSize | null> {
        return { sizeBytes: 123 };
      }
    }
    const sized = new CloudRoaring({ storage: new Sized() });
    expect((await sized.segment('x').stat()).size).toBe(123);
  });

  it('reads the footer and index once when cold and nothing while the generation is open; no payload', async () => {
    const backend = new MemoryStorage();
    await new CloudRoaring({ storage: backend, retry: false }).load(SEG, ids(4));
    const calls: Record<string, number> = {};
    const rowCalls: Record<string, number> = {};
    const reader = new CloudRoaring({
      storage: brandAsBackend({
        storage: counting<IStorageDriver>(backend.storage, calls),
        registry: counting<IRegistryDriver>(backend.registry, rowCalls),
      }),
      retry: false,
    });
    const seg = reader.segment('s', { namespace: 'ns' });
    await seg.stat();
    // One row read and one tail read of the object; no range read, so no chunk's payload.
    expect({
      rows: rowCalls.get ?? 0,
      tails: calls.getTail ?? 0,
      ranges: calls.getRange ?? 0,
    }).toEqual({
      rows: 1,
      tails: 1,
      ranges: 0,
    });
    for (const k of Object.keys(calls)) delete calls[k];
    for (const k of Object.keys(rowCalls)) delete rowCalls[k];
    await seg.stat();
    await seg.count();
    expect({
      rows: rowCalls.get ?? 0,
      tails: calls.getTail ?? 0,
      ranges: calls.getRange ?? 0,
    }).toEqual({
      rows: 0,
      tails: 0,
      ranges: 0,
    });
  });

  it('is the size of the generation the rest describes, when a load lands while it resolves', async () => {
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend, retry: false });
    await writer.load(SEG, ids(1), { keep: 9 });
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
    // The first row read answers generation 0, and before it returns a wider load publishes generation 1 and the
    // pointer's TTL lapses: anything that resolved the segment a second time would now find generation 1.
    let raced = false;
    const registry: IRegistryDriver = Object.create(backend.registry, {
      get: {
        value: async (ref: SegmentRef) => {
          const row = await backend.registry.get(ref);
          if (!raced) {
            raced = true;
            await writer.load(SEG, ids(4), { keep: 9 });
            t += 60_000;
          }
          return row;
        },
      },
    });
    const reader = new CloudRoaring({
      storage: brandAsBackend({ storage: backend.storage, registry }),
      retry: false,
      seams: { clock },
    });
    expect(await reader.segment('s', { namespace: 'ns' }).stat()).toEqual({
      generation: 0,
      cardinality: 50,
      size: await objectBytes(backend.storage, 0),
    });
    expect(raced).toBe(true);
  });

  it('is retried with the rest of a stat on a store that retries', async () => {
    const backend = new MemoryStorage();
    await new CloudRoaring({ storage: backend, retry: false }).load(SEG, ids(1));
    let failNextTail = true;
    const flaky: IStorageDriver = Object.create(backend.storage, {
      getTail: {
        value: (key: Parameters<IStorageDriver['getTail']>[0], maxBytes: number) => {
          if (failNextTail) {
            failNextTail = false;
            return Promise.reject(new TransientError('blip'));
          }
          return backend.storage.getTail(key, maxBytes);
        },
      },
    });
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: flaky, registry: backend.registry }),
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });
    expect((await store.segment('s', { namespace: 'ns' }).stat()).size).toBe(
      await objectBytes(backend.storage, 0),
    );
    expect(failNextTail).toBe(false);
  });
});
