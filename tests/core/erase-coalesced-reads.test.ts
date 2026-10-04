import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishGeneration } from '@/core/crbm-storage-source';
import { CrbmReader } from '@/core/crbm/reader';
import { CrbmWriter } from '@/core/crbm/writer';
import { eraseIdFromSegment } from '@/core/erase-id';
import { joinId } from '@/core/bit-route';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IStorageDriver } from '@/core/ports';
import { CloudRoaring, MemoryStorage } from '@/index';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { InProcessKeystore } from '@/drivers/crypto';
import { openGenerationReader, writeCrbmGeneration } from '@/core/crbm-storage-source';
import { collect } from '../helpers/loaded';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { Gate, Watched, tick } from '../helpers/live-buffers';
import { expectSameBytes } from '../helpers/chunk-stream';

/**
 * The erasure rewrite reads the generation it rewrites through the reader's coalesced chunk stream: neighbouring
 * chunks share one range request, the stream holds at most 32 ranges, and everything else about the rewrite (what it
 * writes, how it publishes, the receipt, the collection) is as it was.
 */
const SEG = { segment: 's' };
const KIB = 1024;
const READ_AHEAD = 32;

interface Counts {
  /** Every payload range read the driver served, the one for the target chunk and the verification reads included. */
  ranges: number;
  inflight: number;
  peak: number;
}

/** A storage that counts and times what it serves, and can park, fail or watch each range read. */
function instrument(
  inner: IStorageDriver,
  hooks: {
    before?: (nth: number) => Promise<void> | void;
    after?: (bytes: Uint8Array) => Uint8Array;
  } = {},
): { storage: IStorageDriver; counts: Counts } {
  const counts: Counts = { ranges: 0, inflight: 0, peak: 0 };
  const storage: IStorageDriver = {
    capabilities: () => inner.capabilities(),
    getRange: async (key: GenKey, offset, length) => {
      const nth = ++counts.ranges;
      counts.inflight++;
      counts.peak = Math.max(counts.peak, counts.inflight);
      try {
        await hooks.before?.(nth);
        const bytes = await inner.getRange(key, offset, length);
        return hooks.after?.(bytes) ?? bytes;
      } finally {
        counts.inflight--;
      }
    },
    getTail: (key, max) => inner.getTail(key, max),
    putImmutable: (key, fn) => inner.putImmutable(key, fn),
    list: (ref) => inner.list(ref),
    delete: (key) => inner.delete(key),
  };
  return { storage, counts };
}

/** The `request`-marked items a stream yields: one per range request it made. */
function countStreamRanges(): { ranges: () => number; keys: () => number[][] } {
  const real = CrbmReader.prototype.readChunks;
  let ranges = 0;
  const keys: number[][] = [];
  vi.spyOn(CrbmReader.prototype, 'readChunks').mockImplementation(function (
    this: CrbmReader,
    k,
    options,
  ) {
    keys.push([...k]);
    const stream = real.call(this, k, options);
    const next = stream.next.bind(stream);
    stream.next = async () => {
      const step = await next();
      if (step.done !== true && step.value.request !== undefined) ranges++;
      return step;
    };
    return stream;
  });
  return { ranges: () => ranges, keys: () => keys };
}

afterEach(() => vi.restoreAllMocks());

/** A well-formed bitmap of about 8 KiB serialized (4,096 values), distinct per chunk. */
const typical = (k: number): SafeBitmap =>
  SafeBitmap.fromValues(Array.from({ length: 4096 }, (_, i) => (i * 16 + (k % 16) + 1) % 65_536));

async function packed(n: number, bitmaps: (k: number) => SafeBitmap = typical) {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  await writeCrbmGeneration(
    storage,
    { ...SEG, generation: 0 },
    Array.from({ length: n }, (_, k) => ({ chunkKey: k, bitmap: bitmaps(k) })),
  );
  await publishGeneration(registry, { ...SEG, generation: 0 });
  return { storage, registry };
}

const eraseFrom = (
  w: { storage: IStorageDriver; registry: MemoryRegistryDriver },
  id: number,
  deps: object = {},
) => eraseIdFromSegment(SEG, id, { ...w, codec: roaringCodec, ...deps });

/** Every chunk of the current generation, by key, through a reader. */
async function chunksOf(
  w: { storage: IStorageDriver; registry: MemoryRegistryDriver },
  keystore?: InProcessKeystore,
): Promise<Map<number, Uint8Array>> {
  const store = new CloudRoaring({
    ...(keystore === undefined ? {} : { encryption: { keystore } }),
    storage: brandAsBackend({ storage: w.storage, registry: w.registry }),
    cache: { genTtlMs: 0 },
  });
  const ids = await collect(store.segment('s').iterate());
  const byChunk = new Map<number, number[]>();
  for (const id of ids) byChunk.set(id >>> 16, [...(byChunk.get(id >>> 16) ?? []), id & 0xffff]);
  return new Map(
    [...byChunk].map(([k, values]) => [k, SafeBitmap.fromValues(values).serialize()] as const),
  );
}

describe('request counts of an erasure', () => {
  it.each([
    { chunks: 100, expected: 1 },
    { chunks: 2000, expected: 16 },
  ])(
    'a segment of $chunks packed chunks of about 8 KiB is read in $expected range requests, not $chunks',
    async ({ chunks, expected }) => {
      const w = await packed(chunks);
      const { storage, counts } = instrument(w.storage);
      const seen = countStreamRanges();
      const res = await eraseFrom({ ...w, storage }, joinId(chunks >> 1, ((chunks >> 1) % 16) + 1));
      expect(res).toMatchObject({ erased: true });
      // The stream's own requests: every chunk but the target's, in a few ranges.
      expect(seen.ranges()).toBe(expected);
      expect(seen.keys()).toHaveLength(1);
      expect(seen.keys()[0]).toHaveLength(chunks - 1);
      // Whole call, the target's read and the verification pass included: far below one request per chunk.
      expect(counts.ranges).toBeLessThan(chunks / 2 + 8);
    },
  );

  it('reads a segment of 2,000 tiny chunks in one range request', async () => {
    const w = await packed(2000, (k) => SafeBitmap.fromValues([1 + (k % 7), 100]));
    const seen = countStreamRanges();
    await eraseFrom(w, joinId(1000, 1 + (1000 % 7)));
    expect(seen.ranges()).toBe(1);
  });
});

describe('what the rewrite writes', () => {
  /** The per-chunk path: every chunk through `getChunk`, one at a time, the id removed, written as one generation. */
  async function reference(
    w: { storage: IStorageDriver; registry: MemoryRegistryDriver },
    id: number,
    keystore?: InProcessKeystore,
  ): Promise<Map<number, Uint8Array>> {
    const reader = await openGenerationReader(w.storage, { ...SEG, generation: 0 }, undefined);
    void keystore;
    const out = new Map<number, Uint8Array>();
    for (const k of [...reader.chunkKeys()].sort((a, b) => a - b)) {
      const bitmap = roaringCodec.safeDeserialize((await reader.getChunk(k))!, 1 << 20);
      if (k === id >>> 16) bitmap.remove(id & 0xffff);
      if (!bitmap.isEmpty) out.set(k, bitmap.serialize());
    }
    return out;
  }

  const sparse = (k: number): SafeBitmap =>
    k % 9 === 4 ? SafeBitmap.fromValues([77]) : SafeBitmap.fromValues([1 + k, 2 + k, 900 + k]);

  it.each([
    { name: 'an id in the middle of a chunk', id: joinId(14, 2 + 14) },
    { name: 'the first chunk', id: joinId(0, 1) },
    { name: 'the last chunk', id: joinId(39, 40) },
    { name: 'the only id of a chunk, which is removed', id: joinId(4, 77) },
  ])(
    '$name: gone from the new generation, every other chunk equal to the per-chunk path',
    async ({ id }) => {
      const w = await packed(40, sparse);
      const want = await reference(w, id);
      const res = await eraseFrom(w, id);
      expect(res).toMatchObject({ erased: true, generation: 1 });
      const got = await chunksOf(w);
      expect([...got.keys()]).toEqual([...want.keys()]);
      for (const [k, bytes] of want) expectSameBytes(got.get(k), bytes);
      expect((await w.registry.get(SEG))!.currentGen).toBe(1);
    },
  );

  it('removes a chunk whose last id is erased, and carries the others', async () => {
    const w = await packed(12, sparse);
    await eraseFrom(w, joinId(4, 77));
    const reader = await openGenerationReader(w.storage, { ...SEG, generation: 1 }, undefined);
    expect([...reader.chunkKeys()].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('writes nothing for an id that is in no chunk', async () => {
    const w = await packed(30, sparse);
    const seen = countStreamRanges();
    const res = await eraseFrom(w, joinId(7, 60_000)); // chunk 7 exists; the value does not
    expect(res).toMatchObject({ erased: false });
    const absentChunk = await eraseFrom(w, joinId(900, 1));
    expect(absentChunk).toMatchObject({ erased: false });
    expect(seen.ranges()).toBe(0);
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('rewrites an encrypted segment to the same chunks as the per-chunk path', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const ids = Array.from({ length: 50 }, (_, k) => [joinId(k, 1 + k), joinId(k, 500 + k)]).flat();
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, ids, { registry, keystore });
    const w = { storage, registry };
    const seen = countStreamRanges();
    const res = await eraseFrom(w, joinId(25, 26), { keystore });
    expect(res).toMatchObject({ erased: true });
    expect(seen.ranges()).toBeGreaterThan(0);
    const got = await chunksOf(w, keystore);
    expect(got.size).toBe(50);
    const want = ids.filter((id) => id !== joinId(25, 26));
    const store = new CloudRoaring({
      encryption: { keystore },
      storage: brandAsBackend(w),
      cache: { genTtlMs: 0 },
    });
    expect(await collect(store.segment('s').iterate())).toEqual(want);
  });

  it('erases a subject from several segments through one stream each', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    const id = 9;
    for (const ns of ['a', 'b', 'c']) {
      for (const seg of ['x', 'y']) {
        await store.load(
          { namespace: ns, segment: seg },
          Array.from({ length: 300 }, (_, i) => joinId(i, i === 100 ? id : 20 + (i % 5))),
        );
      }
    }
    const seen = countStreamRanges();
    const ledger = await store.eraseSubject(joinId(100, id), { allNamespaces: true });
    expect(ledger.erasedFrom.filter((e) => e.erased)).toHaveLength(6);
    expect(seen.keys()).toHaveLength(6);
    for (const keys of seen.keys()) expect(keys).toHaveLength(299);
    for (const ns of ['a', 'b', 'c']) {
      for (const seg of ['x', 'y']) {
        const ids = await collect(store.segment(seg, { namespace: ns }).iterate());
        expect(ids).toHaveLength(299);
        expect(ids).not.toContain(joinId(100, id));
      }
    }
  });
});

/** A segment of `n` chunks of `size` bytes each, valid on disk but not decodable by the real codec: see `stub`. */
async function wide(n: number, size = 300 * KIB) {
  const inner = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const key = { ...SEG, generation: 0 };
  await inner.putImmutable(key, async (sink) => {
    const writer = new CrbmWriter(sink, { generation: 0 });
    for (let k = 0; k < n; k++) {
      const payload = new Uint8Array(size);
      payload[0] = k & 0xff;
      payload[1] = k >> 8;
      await writer.addChunk(k, payload, 2);
    }
    await writer.finish();
  });
  await publishGeneration(registry, key);
  return { inner, registry };
}

/** Decodes any payload as the two values its chunk holds, so a payload can be as large as the test needs. */
const stub = (counter?: { decodes: number }) => ({
  ...roaringCodec,
  safeDeserialize: (b: Uint8Array) => {
    if (counter) counter.decodes++;
    return SafeBitmap.fromValues([1 + (b[0]! | (b[1]! << 8)), 2]);
  },
});

describe('the stream holds ranges, not chunks', () => {
  it('keeps at most 32 range requests open ahead of the writer, and more than one', async () => {
    const w = await wide(240); // 3 chunks to a range: about 80 ranges
    const { storage, counts } = instrument(w.inner, { before: () => tick(2) });
    const res = await eraseFrom({ storage, registry: w.registry }, joinId(0, 1), { codec: stub() });
    expect(res).toMatchObject({ erased: true });
    expect(counts.peak).toBeGreaterThan(1);
    expect(counts.peak).toBeLessThanOrEqual(READ_AHEAD);
  });

  it('opens the window at full width at once', async () => {
    const w = await wide(240);
    const parked: Array<() => void> = [];
    const { storage, counts } = instrument(w.inner, {
      before: (nth) => (nth === 1 ? undefined : new Promise<void>((r) => parked.push(r))),
    });
    const done = eraseFrom({ storage, registry: w.registry }, joinId(0, 1), { codec: stub() });
    await vi.waitFor(() => expect(parked.length).toBe(READ_AHEAD));
    await tick(30);
    expect(parked.length).toBe(READ_AHEAD);
    expect(counts.inflight).toBe(READ_AHEAD + 0);
    while (counts.inflight > 0 || parked.length > 0) {
      parked.splice(0).forEach((r) => r());
      await tick(2);
    }
    await done;
  });

  it('decodes a chunk only as the writer reaches it, not as its range lands', async () => {
    const w = await wide(120);
    const decodes = { decodes: 0 };
    const parked: Array<() => void> = [];
    const { storage, counts } = instrument(w.inner, {
      before: (nth) => (nth === 1 ? undefined : new Promise<void>((r) => parked.push(r))),
    });
    const done = eraseFrom({ storage, registry: w.registry }, joinId(0, 1), {
      codec: stub(decodes),
    });
    await vi.waitFor(() => expect(parked.length).toBeGreaterThan(3));
    const atTarget = decodes.decodes;
    // Every range ahead lands except the first in key order, which the writer waits on.
    const first = parked.shift()!;
    parked.splice(0).forEach((r) => r());
    await tick(30);
    expect(decodes.decodes).toBe(atTarget);
    first();
    while (counts.inflight > 0 || parked.length > 0) {
      parked.splice(0).forEach((r) => r());
      await tick(2);
    }
    await done;
  });

  it('holds at most 32 ranges of 1 MiB chunks while the writer is slow', async () => {
    const w = await wide(200, KIB * KIB - 28); // one chunk to a range: the hostile layout
    const ranges = new Watched();
    const gate = new Gate();
    const { storage } = instrument(w.inner, {
      after: (bytes) => ranges.track(bytes.slice()), // a copy: the memory driver hands out views of one buffer
    });
    // Every range read after the target's parks once it has allocated its buffer: the writer is waiting on the first
    // of them, and the stream has opened as much as it will.
    let reads = 0;
    const gated: IStorageDriver = {
      ...storage,
      getRange: async (key, offset, length) => {
        const nth = ++reads;
        const bytes = await storage.getRange(key, offset, length);
        if (nth > 1) await gate.wait();
        return bytes;
      },
    };
    gate.close();
    const done = eraseFrom({ storage: gated, registry: w.registry }, joinId(0, 1), {
      codec: stub(),
    });
    await tick(100);
    const held = await ranges.live();
    gate.open();
    await done;
    expect(held).toBeGreaterThan(READ_AHEAD - 2);
    expect(held).toBeLessThanOrEqual(READ_AHEAD + 1); // the stream's ranges, and the target's chunk read before it
  }, 60_000);

  it('raises a range failing mid-read: nothing is published, nothing unhandled, nothing more is sent', async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      const w = await wide(240);
      const { storage, counts } = instrument(w.inner, {
        before: async (nth) => {
          await tick(nth === 5 ? 2 : 20);
          if (nth === 5) throw new Error('range failed');
        },
      });
      await expect(
        eraseFrom({ storage, registry: w.registry }, joinId(0, 1), { codec: stub() }),
      ).rejects.toThrow('range failed');
      const issued = counts.ranges;
      await tick(120);
      expect(counts.ranges).toBe(issued); // nothing more went out after the failure
      expect(counts.ranges).toBeLessThan(40);
      expect(unhandled).toEqual([]);
      expect((await w.registry.get(SEG))!.currentGen).toBe(0);
      const gens: number[] = [];
      for await (const k of w.inner.list(SEG)) gens.push(k.generation);
      expect(gens).toEqual([0]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });
});

describe('one generation', () => {
  it('a publish landing mid-read leaves the rewrite on the generation it opened, and its fenced publish refuses', async () => {
    const w = await packed(400);
    let landed = false;
    const { storage } = instrument(w.storage, {
      before: async (nth) => {
        if (nth === 3 && !landed) {
          landed = true;
          const ids = Array.from({ length: 400 }, (_, k) => joinId(k, 5));
          await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 2 }, ids, {
            registry: w.registry,
          });
        }
      },
    });
    const seen = countStreamRanges();
    const res = await eraseFrom({ storage, registry: w.registry }, joinId(200, 1 + (200 % 16)));
    expect(landed).toBe(true);
    expect(res).toMatchObject({ erased: false });
    expect(res).toMatchObject({ reason: 'superseded' });
    expect(seen.keys()).toHaveLength(1); // one stream, on the one reader
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
  });
});

describe('every chunk of the stream passes the checks of a read of it alone', () => {
  const flipOnStream = (nthFrom: number) => {
    let n = 0;
    return (bytes: Uint8Array): Uint8Array => {
      if (++n < nthFrom) return bytes;
      const copy = bytes.slice();
      copy[copy.length >> 1]! ^= 0xff;
      return copy;
    };
  };

  it('refuses a chunk whose bytes fail the index checksum, and publishes nothing', async () => {
    const w = await packed(40);
    // The first read is the target's own; the second is the stream's single range.
    const { storage } = instrument(w.storage, { after: flipOnStream(2) });
    await expect(eraseFrom({ storage, registry: w.registry }, joinId(0, 1))).rejects.toThrow(
      /checksum|CRC|corrupt/i,
    );
    expect((await w.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('refuses a chunk that fails authentication on an encrypted segment, and publishes nothing', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const ids = Array.from({ length: 40 }, (_, k) => joinId(k, 1 + k));
    await bulkLoadCrbmGeneration(storage, { ...SEG, generation: 0 }, ids, { registry, keystore });
    const tampered = instrument(storage, { after: flipOnStream(2) });
    await expect(
      eraseFrom({ storage: tampered.storage, registry }, joinId(0, 1), { keystore }),
    ).rejects.toThrow();
    expect((await registry.get(SEG))!.currentGen).toBe(0);
  });
});
