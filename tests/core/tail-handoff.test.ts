/**
 * A cold read of a small generation: its tail read returns the whole object, the reader keeps the chunk region when it is
 * within the reader cache's fair share per reader, and the chunks are served from memory with no request of their own.
 * Every case counts the requests the in-memory backend saw (the registry row, tails and ranges), and reads the bytes
 * back, since a count says nothing about which bytes were served.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudRoaring,
  CrbmStorageChunkSource,
  InProcessKeystore,
  IntegrityError,
  MemoryStorage,
} from '@/index';
import type { SegmentRef } from '@/index';
import { BufferReader } from '@/core/blob';
import { PAYLOAD_START } from '@/core/crbm/format';
import { openCrbmReaderKeeping } from '@/core/crbm/reader';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect, expectSameBytes } from '../helpers/chunk-stream';

const K = 65_536;
/** `chunks` chunks of `perChunk` ids each, every third remainder: an array container of about 2 bytes an id. */
const idsOf = (chunks: number, perChunk: number, from = 0): number[] =>
  Array.from(
    { length: chunks * perChunk },
    (_, i) => (from + Math.floor(i / perChunk)) * K + (i % perChunk) * 3,
  );

const SMALL = idsOf(3, 200); // about 1.2 KB of chunks
const SMALL_B = idsOf(3, 200, 1); // chunks 1 to 3: shares chunks 1 and 2 with SMALL
const OVER_LIMIT = idsOf(20, 5000); // about 200 KB of chunks: inside one 256 KiB tail, over the 64 KiB share
const OVER_TAIL = idsOf(30, 5000); // about 300 KB: more than the tail holds

async function world(
  segments: Record<string, number[]>,
  cache: { readerMax?: number; readerMaxBytes?: number } = {},
) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  for (const [segment, ids] of Object.entries(segments)) {
    await bulkLoadCrbmGeneration(storage, { segment, generation: 0 }, ids, { registry });
  }
  const store = new CloudRoaring({ storage: backend, cache });
  const calls = { registry: 0, tails: 0, ranges: 0 };
  const get = registry.get.bind(registry);
  vi.spyOn(registry, 'get').mockImplementation((ref) => {
    calls.registry++;
    return get(ref);
  });
  const getTail = storage.getTail.bind(storage);
  vi.spyOn(storage, 'getTail').mockImplementation((key, max) => {
    calls.tails++;
    return getTail(key, max);
  });
  const getRange = storage.getRange.bind(storage);
  vi.spyOn(storage, 'getRange').mockImplementation((key, offset, length) => {
    calls.ranges++;
    return getRange(key, offset, length);
  });
  return { backend, storage, registry, store, calls, rawTail: getTail };
}

/** The bytes of chunk region a reader that keeps everything holds for `segments` ids. */
async function regionOf(segmentIds: number[]): Promise<number> {
  const { storage, registry } = new MemoryStorage();
  await bulkLoadCrbmGeneration(storage, { segment: 'probe', generation: 0 }, segmentIds, {
    registry,
  });
  const tail = await storage.getTail({ segment: 'probe', generation: 0 }, 1 << 20);
  const reader = await openCrbmReaderKeeping(new BufferReader(tail.bytes), {}, 1 << 30);
  return reader.retainedBytes - reader.retainedIndexBytes;
}

async function ids(stream: AsyncIterable<number>): Promise<number[]> {
  return collect(stream);
}

describe('a cold read of a small generation', () => {
  it('has(): the registry read and the tail read, and no range read', async () => {
    const { store, calls } = await world({ s: SMALL });
    expect(await store.segment('s').has(K + 3)).toBe(true);
    expect(await store.segment('s').has(K + 4)).toBe(false);
    expect(calls).toEqual({ registry: 1, tails: 1, ranges: 0 });
  });

  it('iterate(): every id, and no range read', async () => {
    const { store, calls } = await world({ s: SMALL });
    expect(await ids(store.segment('s').iterate())).toEqual(SMALL);
    expect(calls.ranges).toBe(0);
    expect(calls.tails).toBe(1);
  });

  it('a cold two-operand intersect of two small segments makes no range read', async () => {
    const { store, calls } = await world({ a: SMALL, b: SMALL_B });
    const want = SMALL.filter((id) => SMALL_B.includes(id));
    expect(want.length).toBeGreaterThan(0);
    expect(await ids(store.segment('a').intersect([store.segment('b')]))).toEqual(want);
    expect(calls.ranges).toBe(0);
    expect(calls.tails).toBe(2);
  });

  it('a generation whose chunk region is over the limit is read by range', async () => {
    const { store, calls } = await world({ s: OVER_LIMIT });
    expect(await store.segment('s').has(3)).toBe(true);
    expect(calls.ranges).toBe(1);
    expect(await ids(store.segment('s').iterate())).toEqual(OVER_LIMIT);
  });

  it('an object larger than the tail is read by range', async () => {
    const { store, calls } = await world({ s: OVER_TAIL });
    expect(await store.segment('s').has(3)).toBe(true);
    expect(calls.ranges).toBeGreaterThanOrEqual(1);
  });

  it('the limit is the byte ceiling over the count ceiling: a byte over it keeps nothing, at it keeps', async () => {
    const region = await regionOf(SMALL);
    expect(region).toBeGreaterThan(0);
    for (const [maxBytes, ranges] of [
      [4 * region, 0],
      [4 * region - 4, 1],
    ] as const) {
      const w = await world({ s: SMALL }, { readerMax: 4, readerMaxBytes: maxBytes });
      expect(await w.store.segment('s').has(3)).toBe(true);
      expect(w.calls.ranges, `maxBytes ${maxBytes}`).toBe(ranges);
    }
  });

  it('the reader cache evicts by bytes once kept chunks are weighed', async () => {
    const seg = (c: number) => idsOf(3, 3000, c * 3);
    // A share of exactly one region, so each keeps its chunks, and a byte ceiling that holds two readers, not three.
    const region = await regionOf(seg(0));
    const { store, calls } = await world(
      { a: seg(0), b: seg(1), c: seg(2) },
      { readerMax: 3, readerMaxBytes: 3 * region + 1 },
    );
    for (const s of ['a', 'b', 'c']) await store.segment(s).has(0);
    expect(calls.tails).toBe(3);
    expect(calls.ranges).toBe(0); // all three kept their chunks
    await store.segment('c').has(0);
    expect(calls.tails).toBe(3); // the newest is resident
    await store.segment('a').has(0);
    expect(calls.tails).toBe(4); // the first was evicted by bytes, though the count ceiling of 3 was not reached
  });

  it('invalidate() drops the reader and its kept bytes: the next read opens again', async () => {
    const { store, calls } = await world({ s: SMALL });
    await store.segment('s').has(3);
    await store.segment('s').has(3);
    expect(calls).toEqual({ registry: 1, tails: 1, ranges: 0 });
    store.invalidate({ segment: 's' });
    expect(await store.segment('s').has(3)).toBe(true);
    expect(calls).toEqual({ registry: 2, tails: 2, ranges: 0 });
  });

  it('a pinned small segment is read from the bytes its open kept', async () => {
    const { store, calls } = await world({ s: SMALL });
    const pinned = await store.segment('s').pin();
    expect(await pinned.has(K + 3)).toBe(true);
    expect(await ids(pinned.iterate())).toEqual(SMALL);
    expect(calls.ranges).toBe(0);
    store.invalidate({ segment: 's' });
    expect(await ids(pinned.iterate())).toEqual(SMALL);
    expect(calls.ranges).toBe(0);
  });

  it('a corrupted chunk byte in a small object is an IntegrityError', async () => {
    const { store, storage, rawTail } = await world({ s: SMALL });
    vi.spyOn(storage, 'getTail').mockImplementation(async (key, max) => {
      const got = await rawTail(key, max);
      got.bytes[PAYLOAD_START + 5]! ^= 0xff; // a byte of the first chunk
      return got;
    });
    await expect(store.segment('s').has(3)).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('the storage chunk source over a small generation', () => {
  const REF: SegmentRef = { segment: 's' };
  const make = async (keystore?: InProcessKeystore, options: { limitBytes?: number } = {}) => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, SMALL, { registry, keystore });
    const source = new CrbmStorageChunkSource(storage, {
      registry,
      keystore,
      ...(options.limitBytes === undefined
        ? {}
        : { maxOpenSegments: 1, maxOpenIndexBytes: options.limitBytes }),
    });
    const ranges: number[] = [];
    const getRange = storage.getRange.bind(storage);
    vi.spyOn(storage, 'getRange').mockImplementation((key, offset, length) => {
      ranges.push(length);
      return getRange(key, offset, length);
    });
    return { source, ranges };
  };

  it('getChunks sends no request and calls no onRequest, in key order, and getChunk agrees', async () => {
    const { source, ranges } = await make();
    const requests: unknown[] = [];
    const items = await collect(
      source.getChunks!(REF, [0, 1, 2, 7], { onRequest: (r) => requests.push(r) }),
    );
    expect(items.map((i) => i.key)).toEqual([0, 1, 2, 7]);
    expect(items[3]!.bytes).toBeNull();
    for (const item of items.slice(0, 3)) {
      expectSameBytes(item.bytes, await source.getChunk({ ...REF, chunkKey: item.key }));
    }
    expect(ranges).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('a write to a returned chunk changes nothing of the next read', async () => {
    const { source } = await make();
    const first = (await source.getChunk({ ...REF, chunkKey: 1 }))!;
    const want = first.slice();
    first.fill(0xee);
    expectSameBytes(await source.getChunk({ ...REF, chunkKey: 1 }), want);
    const [item] = await collect(source.getChunks!(REF, [2]));
    const wantTwo = item!.bytes!.slice();
    item!.bytes!.fill(0xee);
    expectSameBytes((await collect(source.getChunks!(REF, [2])))[0]!.bytes, wantTwo);
  });

  it('reads an encrypted small segment correctly, with no range request', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const { source, ranges } = await make(keystore);
    const plain = await make();
    for (const key of [0, 1, 2]) {
      const sealed = await source.getChunk({ ...REF, chunkKey: key });
      expectSameBytes(sealed, await plain.source.getChunk({ ...REF, chunkKey: key }));
    }
    expect(ranges).toEqual([]);
    expect(plain.ranges).toEqual([]);
  });

  it('serves a kept chunk of the one generation it opened, as a chunk-cache hit does, though the object is swept', async () => {
    const backend = new MemoryStorage();
    const { storage, registry } = backend;
    await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, SMALL, { registry });
    const source = new CrbmStorageChunkSource(storage, { registry });
    const before = await collect(source.getChunks!(REF, [0, 1, 2]));
    await storage.delete({ ...REF, generation: 0 });
    const after = await collect(source.getChunks!(REF, [0, 1, 2]));
    expect(after.map((i) => i.version)).toEqual(before.map((i) => i.version));
    for (const [i, item] of after.entries()) expectSameBytes(item.bytes, before[i]!.bytes);
    expectSameBytes(await source.getChunk({ ...REF, chunkKey: 1 }), before[1]!.bytes);
  });

  it('keeps nothing when the share is below the chunk region, and reads ranges', async () => {
    const { source, ranges } = await make(undefined, { limitBytes: 100 });
    await source.getChunk({ ...REF, chunkKey: 1 });
    await collect(source.getChunks!(REF, [0, 2]));
    expect(ranges.length).toBe(2);
  });
});
