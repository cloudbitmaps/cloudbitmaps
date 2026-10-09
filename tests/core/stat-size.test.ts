import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import type {
  ChunkRef,
  GenerationSummary,
  IRegistryDriver,
  IStorageDriver,
  SegmentRef,
  SegmentSize,
  StorageChunkSource,
} from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { TransientError } from '@/core/errors';
import { segmentKey } from '@/core/keys';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import type { PinnedAt } from '@/core/pinned-storage-source';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, CrbmStorageChunkSource, LocalFsStorage, MemoryStorage } from '@/index';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { counting } from '../helpers/counting';

/**
 * `stat()` reports `sizeBytes`: the bytes of the object of the generation it describes, from that object's footer and
 * index, with no payload read. It is null for a segment with no generation and on a source that cannot say, a pin
 * reports its own generation's, and the four fields come from one opened generation, so the size is never another
 * generation's.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

/** Ids spread over `chunks` chunks, so two loads of different widths make objects of different sizes. */
const ids = (chunks: number): number[] =>
  Array.from({ length: chunks * 50 }, (_, i) => (i % chunks) * 65_536 + Math.floor(i / chunks));

/** The calls a counted driver saw that reach the service: `capabilities()` is answered locally. */
const requests = (calls: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(calls).filter(([name]) => name !== 'capabilities'));

/** The size `getTail` reports for one generation's object: what the bucket holds, read without the reader. */
async function objectBytes(storage: IStorageDriver, generation: number): Promise<number> {
  return (await storage.getTail({ ...SEG, generation }, 0)).size;
}

const keystore = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

describe('stat().sizeBytes', () => {
  it.each([
    ['cleartext', undefined],
    ['encrypted', keystore()],
  ] as const)(
    "is the current generation's object, byte for byte, and moves with each load: %s",
    async (_, ks) => {
      const backend = new MemoryStorage();
      const store = new CloudRoaring({
        storage: backend,
        retry: false,
        ...(ks === undefined ? {} : { encryption: { keystore: ks } }),
      });
      await store.load(SEG, ids(1), { keep: 9 });
      const seg = store.segment('s', { namespace: 'ns' });
      const first = await seg.stat();
      expect(first).toEqual({
        generation: 0,
        cardinality: 50,
        sizeBytes: await objectBytes(backend.storage, 0),
      });

      await store.load(SEG, ids(4), { keep: 9 });
      const second = await seg.stat();
      expect(second.generation).toBe(1);
      expect(second.sizeBytes).toBe(await objectBytes(backend.storage, 1));
      expect(second.sizeBytes).not.toBe(first.sizeBytes);
    },
  );

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
      expect((await store.segment('s', { namespace: 'ns' }).stat()).sizeBytes).toBe(onDisk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is null for a segment with no generation', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage(), retry: false });
    expect(await store.segment('never', { namespace: 'ns' }).stat()).toEqual({
      generation: null,
      cardinality: 0,
      sizeBytes: null,
    });
    // A row with a policy and no data is a segment with no generation too.
    await store.setRetention({ namespace: 'ns', segment: 'policy-only' }, { expiresAt: 4e12 });
    expect((await store.segment('policy-only', { namespace: 'ns' }).stat()).sizeBytes).toBeNull();
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
      sizeBytes: await objectBytes(backend.storage, 0),
    });
    expect((await seg.stat()).sizeBytes).toBe(await objectBytes(backend.storage, 1));

    // A pin of a segment with no generation has none to measure.
    const empty = await store.segment('none', { namespace: 'ns' }).pin();
    expect(await empty.stat()).toEqual({ generation: null, cardinality: 0, sizeBytes: null });
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
      sizeBytes: null,
    });

    class Sized extends ChunksOnly {
      async sizeOf(): Promise<SegmentSize | null> {
        return { sizeBytes: 123 };
      }
    }
    const sized = new CloudRoaring({ storage: new Sized() });
    expect((await sized.segment('x').stat()).sizeBytes).toBe(123);
  });

  it('takes the summary and `sizeOf` on a source with a summary and no `stat`', async () => {
    const chunk = new Uint8Array([58, 48, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 7, 0]);
    const sizeOf = vi.fn(async (): Promise<SegmentSize | null> => ({ sizeBytes: 55 }));
    let summary: GenerationSummary | null = { generation: 3, cardinality: 7 };
    class Summarised implements StorageChunkSource {
      async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
        return ref.chunkKey === 0 ? chunk : null;
      }
      async listChunkKeys(): Promise<number[]> {
        return [0];
      }
      async summary(): Promise<GenerationSummary | null> {
        return summary;
      }
      sizeOf = sizeOf;
    }
    const store = new CloudRoaring({ storage: new Summarised() });
    expect(await store.segment('x').stat()).toEqual({
      generation: 3,
      cardinality: 7,
      sizeBytes: 55,
    });

    // A size the source cannot give is null, never 0.
    sizeOf.mockResolvedValueOnce(null);
    expect(await store.segment('x').stat()).toEqual({
      generation: 3,
      cardinality: 7,
      sizeBytes: null,
    });

    // No generation: nothing to measure, and `sizeOf` is not asked.
    summary = null;
    sizeOf.mockClear();
    expect(await store.segment('x').stat()).toEqual({
      generation: null,
      cardinality: 0,
      sizeBytes: null,
    });
    expect(sizeOf).not.toHaveBeenCalled();
  });

  it('asks the source for the pinned generation on a pinned segment, and for the live one otherwise', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, ids(1), { registry });
    const source = new CrbmStorageChunkSource(storage, { registry });
    const pin = (await source.pinGeneration(SEG))!;
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 1 }, ids(4), { registry });
    const stat = vi.spyOn(source, 'stat');
    const statAt = vi.spyOn(source, 'statAt');
    const other: SegmentRef = { namespace: 'ns', segment: 'other' };
    const wrapper = new PinnedStorageChunkSource(
      source,
      new Map<string, PinnedAt>([
        [segmentKey(SEG), pin],
        [segmentKey(other), { generation: null, version: null }],
      ]),
    );

    expect(await wrapper.stat(SEG)).toMatchObject({
      generation: 0,
      sizeBytes: await objectBytes(storage, 0),
    });
    expect(statAt).toHaveBeenCalledTimes(1);
    expect(statAt.mock.calls[0]!.slice(0, 2)).toEqual([SEG, 0]);
    expect(stat).not.toHaveBeenCalled();

    // A pin of no generation asks nothing.
    expect(await wrapper.stat(other)).toBeNull();
    expect(statAt).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalled();

    // An unpinned segment is read live.
    expect(await wrapper.stat({ namespace: 'ns', segment: 'live' })).toBeNull();
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('reads the row alone when cold, its size from the summary, and nothing warm', async () => {
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
    expect((await seg.stat()).sizeBytes).toBe(await objectBytes(backend.storage, 0));
    expect(requests(calls)).toEqual({});
    expect(requests(rowCalls)).toEqual({ get: 1 });
    for (const k of Object.keys(rowCalls)) delete rowCalls[k];
    await seg.stat();
    await seg.count();
    expect(requests(calls)).toEqual({});
    expect(requests(rowCalls)).toEqual({});
  });

  it('with no summary on the row, reads the footer and index once when cold and nothing while the generation is open; no payload', async () => {
    const backend = new MemoryStorage();
    await new CloudRoaring({ storage: backend, retry: false }).load(SEG, ids(4));
    const row = (await backend.registry.get(SEG))!;
    await backend.registry.compareAndSwap(SEG, row.token, { summary: undefined });
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
    // One row read and one tail read of the object, and nothing else: no range read, so no chunk's payload.
    expect(requests(calls)).toEqual({ getTail: 1 });
    expect(requests(rowCalls)).toEqual({ get: 1 });
    for (const k of Object.keys(calls)) delete calls[k];
    for (const k of Object.keys(rowCalls)) delete rowCalls[k];
    await seg.stat();
    await seg.count();
    expect(requests(calls)).toEqual({});
    expect(requests(rowCalls)).toEqual({});
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
      sizeBytes: await objectBytes(backend.storage, 0),
    });
    expect(raced).toBe(true);
  });

  it('is the size of the generation the rest describes on a store that retries, too', async () => {
    // The retry wrapper forwards `stat`: without it the engine would take the summary and the size from two
    // resolutions, and this race would put generation 1's size beside generation 0's count.
    const backend = new MemoryStorage();
    const writer = new CloudRoaring({ storage: backend, retry: false });
    await writer.load(SEG, ids(1), { keep: 9 });
    let t = 0;
    const clock = { now: () => t, sleep: async () => {} };
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
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      seams: { clock },
    });
    expect(await reader.segment('s', { namespace: 'ns' }).stat()).toEqual({
      generation: 0,
      cardinality: 50,
      sizeBytes: await objectBytes(backend.storage, 0),
    });
    expect(raced).toBe(true);
  });

  it('is retried with the rest of a stat on a store that retries', async () => {
    const backend = new MemoryStorage();
    await new CloudRoaring({ storage: backend, retry: false }).load(SEG, ids(1));
    // A row with no summary, so the stat opens the object for its size.
    const row = (await backend.registry.get(SEG))!;
    await backend.registry.compareAndSwap(SEG, row.token, { summary: undefined });
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
    expect((await store.segment('s', { namespace: 'ns' }).stat()).sizeBytes).toBe(
      await objectBytes(backend.storage, 0),
    );
    expect(failNextTail).toBe(false);
  });
});
