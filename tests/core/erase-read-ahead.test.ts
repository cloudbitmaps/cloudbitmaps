import { afterEach, vi } from 'vitest';
import { publishGeneration, writeCrbmGeneration } from '@/core/crbm-storage-source';
import { CrbmReader } from '@/core/crbm/reader';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError } from '@/core/errors';
import { joinId } from '@/core/bit-route';
import type { CodecBitmap } from '@/core/codec';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IStorageDriver } from '@/core/ports';
import { CloudRoaring, TransientError } from '@/index';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { collect } from '../helpers/loaded';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { InProcessKeystore } from '@/drivers/crypto';
import { randomBytes } from 'node:crypto';

/**
 * The erasure rewrite reads the generation's chunks through a bounded, ordered window rather than one round trip
 * per chunk. These tests hold the reads open so that overlap, the bound on it, and everything the serial loop
 * guaranteed (order, the replaced chunk's absence from the wire, refusal naming the first bad chunk, errors from a
 * failed read, no stray rejection) are observable.
 */
const SEG = { segment: 's' };
const WINDOW = 32;

interface Probe {
  readonly storage: IStorageDriver;
  readonly registry: MemoryRegistryDriver;
  readonly stats: { inflight: number; peak: number; ranges: number; tails: number };
  readonly held: Array<() => void>;
}

/** A segment of `n` chunks (key k holds remainders `[1 + k, 2 + k]`) behind a storage whose reads park on a timer. */
async function probe(
  n: number,
  opts: {
    bitmaps?: (k: number) => CodecBitmap;
    delay?: (offset: number) => number;
    failLength?: number;
    /** The 1-based payload read that fails once with a transient fault. */
    flakyRead?: number;
    /** Every payload read from this 1-based one on fails. */
    failFrom?: number;
    /** Park every payload read until released; they are listed in `held` in the order they were issued. */
    hold?: boolean;
    keystore?: InProcessKeystore;
  } = {},
): Promise<Probe> {
  const inner = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const chunks = Array.from({ length: n }, (_, k) => ({
    chunkKey: k,
    bitmap: opts.bitmaps?.(k) ?? SafeBitmap.fromValues([1 + k, 2 + k]),
  }));
  if (opts.keystore === undefined) {
    await writeCrbmGeneration(inner, { ...SEG, generation: 0 }, chunks);
    await publishGeneration(registry, { ...SEG, generation: 0 });
  } else {
    const ids = chunks.flatMap(({ chunkKey: k }) => [joinId(k, 1 + k), joinId(k, 2 + k)]);
    await bulkLoadCrbmGeneration(inner, { ...SEG, generation: 0 }, ids, {
      registry,
      keystore: opts.keystore,
    });
  }
  const held: Array<() => void> = [];
  const stats = { inflight: 0, peak: 0, ranges: 0, tails: 0 };
  const storage: IStorageDriver = {
    capabilities: () => inner.capabilities(),
    getRange: async (key: GenKey, offset, length) => {
      const nth = ++stats.ranges;
      stats.inflight++;
      stats.peak = Math.max(stats.peak, stats.inflight);
      try {
        if (opts.hold) await new Promise<void>((r) => held.push(r));
        else await new Promise((r) => setTimeout(r, opts.delay?.(offset) ?? 2));
        if (opts.failFrom !== undefined && nth >= opts.failFrom)
          throw new Error('late read failed');
        if (opts.flakyRead === nth) throw new TransientError('throttled');
        if (opts.failLength !== undefined && length === opts.failLength) {
          throw new Error('read failed');
        }
        return await inner.getRange(key, offset, length);
      } finally {
        stats.inflight--;
      }
    },
    getTail: async (key, max) => {
      stats.tails++;
      return inner.getTail(key, max);
    },
    putImmutable: (key, fn) => inner.putImmutable(key, fn),
    list: (ref) => inner.list(ref),
    delete: (key) => inner.delete(key),
  };
  return { storage, registry, stats, held };
}

const erase = (p: Probe, id: number, deps: object = {}) =>
  eraseIdFromSegment(SEG, id, {
    storage: p.storage,
    registry: p.registry,
    codec: roaringCodec,
    ...deps,
  });

/** The ids of the segment's current generation, read through a fresh store over the same objects. */
async function idsOf(p: Probe, keystore?: InProcessKeystore): Promise<number[]> {
  const store = new CloudRoaring({
    ...(keystore === undefined ? {} : { encryption: { keystore } }),
    storage: brandAsBackend({ storage: p.storage, registry: p.registry }),
    cache: { genTtlMs: 0 },
  });
  return collect(store.segment('s').iterate());
}

afterEach(() => vi.restoreAllMocks());

describe('the erasure rewrite reads ahead through a bounded window', () => {
  it('has more than one chunk read in flight, and never more than the window', async () => {
    const p = await probe(100);
    const res = await erase(p, joinId(50, 1 + 50));
    expect(res).toMatchObject({ erased: true });
    expect(p.stats.peak).toBeGreaterThan(1);
    expect(p.stats.peak).toBeLessThanOrEqual(WINDOW);
  });

  it('issues the same requests as one read per chunk: the replaced chunk is read once, never again', async () => {
    const p = await probe(100);
    await erase(p, joinId(50, 1 + 50));
    // One tail read to open the object; one payload read of the target, 99 for the others, and the
    // verification read of the new generation (a tail read and its payload reads).
    const serial = await probe(100, { delay: () => 0 });
    await erase(serial, joinId(50, 1 + 50));
    expect(p.stats.ranges).toBe(serial.stats.ranges);
    expect(p.stats.tails).toBe(serial.stats.tails);
    expect(p.stats.ranges).toBeGreaterThanOrEqual(100); // 99 pass-through reads plus the target
    expect(p.stats.ranges).toBeLessThanOrEqual(102);
  });

  it('writes the chunks in ascending order though reads finish in the opposite order', async () => {
    // Earlier offsets sleep longer, so the window's reads complete newest first.
    const p = await probe(40, { delay: (offset) => Math.max(1, 60 - Math.floor(offset / 8)) });
    const res = await erase(p, joinId(20, 1 + 20));
    expect(res).toMatchObject({ erased: true });
    const expected: number[] = [];
    for (let k = 0; k < 40; k++) {
      for (const r of [1 + k, 2 + k]) if (!(k === 20 && r === 21)) expected.push(joinId(k, r));
    }
    expect(await idsOf(p)).toEqual(expected);
  });

  it('skips a chunk that is listed but absent, and carries the rest', async () => {
    const p = await probe(10);
    const real = CrbmReader.prototype.getChunk;
    vi.spyOn(CrbmReader.prototype, 'getChunk').mockImplementation(async function (
      this: CrbmReader,
      k: number,
    ) {
      return k === 4 ? null : real.call(this, k);
    });
    // Chunk 0 is the target (read by the caller, not the window); chunk 4 is absent from the window.
    await erase(p, joinId(0, 1));
    vi.restoreAllMocks();
    const keys = new Set((await idsOf(p)).map((id) => id >>> 16));
    expect([...keys]).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
  });

  it('puts the replacement in place without reading the replaced chunk through the window', async () => {
    const p = await probe(5);
    const spy = vi.spyOn(CrbmReader.prototype, 'getChunk');
    await erase(p, joinId(2, 1 + 2));
    const read = spy.mock.calls.map(([k]) => k);
    expect(read.filter((k) => k === 2)).toHaveLength(1); // only the caller's own read of the target
    expect(await idsOf(p)).not.toContain(joinId(2, 3));
    expect(await idsOf(p)).toContain(joinId(2, 4));
  });

  it('refuses a chunk holding a value above 65535, naming the first such chunk in key order', async () => {
    // Chunks 6 and 20 are both corrupt; 20 is read ahead before 6 is decoded, but 6 is the one named.
    const p = await probe(30, {
      bitmaps: (k) =>
        k === 6 || k === 20
          ? SafeBitmap.fromValues([1, 70_000 + k])
          : SafeBitmap.fromValues([1 + k]),
    });
    await expect(erase(p, joinId(0, 1))).rejects.toThrow(/chunk 6 payload holds value 70006/);
    expect((await p.registry.get(SEG))!.currentGen).toBe(0);
  });

  it('refuses an undecodable chunk, and the first bad chunk in key order wins whichever kind it is', async () => {
    const garbage = (): CodecBitmap =>
      ({
        isEmpty: false,
        size: 1,
        serialize: () => Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      }) as unknown as CodecBitmap;
    const bitmaps = (bad: number, over: number) => (k: number) =>
      k === bad
        ? garbage()
        : k === over
          ? SafeBitmap.fromValues([1, 70_000])
          : SafeBitmap.fromValues([1 + k]);

    const undecodableFirst = await probe(20, { bitmaps: bitmaps(3, 12) });
    const err = await erase(undecodableFirst, joinId(0, 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/chunk 12 payload holds value/);

    const overFirst = await probe(20, { bitmaps: bitmaps(12, 3) });
    await expect(erase(overFirst, joinId(0, 1))).rejects.toThrow(/chunk 3 payload holds value/);
    await expect(erase(overFirst, joinId(0, 1))).rejects.toBeInstanceOf(IntegrityError);
  });

  it("reads each window chunk through the caller's read retry", async () => {
    const clock = { now: () => 0, sleep: () => Promise.resolve(), yield: () => Promise.resolve() };
    const clean = await probe(20);
    await erase(clean, joinId(0, 1));
    const p = await probe(20, { flakyRead: 8 });
    const res = await erase(p, joinId(0, 1), { readRetry: { clock, rng: { next: () => 0 } } });
    expect(res).toMatchObject({ erased: true });
    // The one failed read is repeated alone: a retry of the whole attempt would repeat every read.
    expect(p.stats.ranges).toBe(clean.stats.ranges + 1);
  });

  it('surfaces a failed read and leaves no unhandled rejection from the reads it never consumed', async () => {
    // Chunks 4 and 8 are the only ones of 400 values, so a read of that length is theirs: both fail, and 8 is read
    // ahead (and fails) before the writer ever reaches 4's error.
    const big = (k: number) =>
      SafeBitmap.fromValues(Array.from({ length: 400 }, (_, i) => i * 3 + k));
    const probeLen = await probe(12, {
      bitmaps: (k) => (k === 4 || k === 8 ? big(k) : SafeBitmap.fromValues([1])),
    });
    const len = await (async () => {
      const lens: number[] = [];
      const orig = probeLen.storage.getRange;
      probeLen.storage.getRange = async (key, o, l) => {
        lens.push(l);
        return orig(key, o, l);
      };
      await erase(probeLen, joinId(0, 1));
      return Math.max(...lens);
    })();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const p = await probe(12, {
        bitmaps: (k) => (k === 4 || k === 8 ? big(k) : SafeBitmap.fromValues([1])),
        failLength: len,
      });
      await expect(erase(p, joinId(0, 1))).rejects.toThrow('read failed');
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('opens the window at full width at once: min(32, chunks - 1) reads before any resolves', async () => {
    for (const n of [20, 60]) {
      const p = await probe(n, { hold: true });
      const done = erase(p, joinId(0, 1));
      await vi.waitFor(() => expect(p.held.length).toBe(1)); // the target chunk's own read
      p.held.shift()!();
      await new Promise((r) => setTimeout(r, 30));
      expect(p.held.length).toBe(Math.min(WINDOW, n - 1));
      while (p.stats.inflight > 0 || p.held.length > 0) {
        p.held.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 5));
      }
      await done;
    }
  });

  it('decodes a chunk only as the writer consumes it, not as its read resolves', async () => {
    let decodes = 0;
    const codec = {
      ...roaringCodec,
      safeDeserialize: (b: Uint8Array, max: number) => {
        decodes++;
        return roaringCodec.safeDeserialize(b, max);
      },
    };
    const p = await probe(40, { hold: true });
    const done = eraseIdFromSegment(SEG, joinId(0, 1), {
      storage: p.storage,
      registry: p.registry,
      codec,
    });
    await vi.waitFor(() => expect(p.held.length).toBe(1));
    p.held.shift()!();
    await vi.waitFor(() => expect(p.held.length).toBe(WINDOW));
    const decodedTarget = decodes; // the target chunk, decoded before the rewrite starts
    // Every read ahead resolves except the first one in key order, which the writer is waiting on.
    const first = p.held.shift()!;
    p.held.splice(0).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 30));
    expect(decodes).toBe(decodedTarget);
    first();
    while (p.stats.inflight > 0 || p.held.length > 0) {
      p.held.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 5));
    }
    await done;
  });

  it('rewrites an encrypted segment exactly, with the reads overlapping', async () => {
    const keystore = new InProcessKeystore({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
    const p = await probe(60, { keystore });
    const res = await erase(p, joinId(30, 31), { keystore });
    expect(res).toMatchObject({ erased: true });
    expect(p.stats.peak).toBeGreaterThan(1);
    expect(p.stats.peak).toBeLessThanOrEqual(WINDOW);
    const expected: number[] = [];
    for (let k = 0; k < 60; k++) {
      for (const r of [1 + k, 2 + k]) if (!(k === 30 && r === 31)) expected.push(joinId(k, r));
    }
    expect(await idsOf(p, keystore)).toEqual(expected);
  });

  it("surfaces the writer's own error when it throws with reads in flight, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      let decodes = 0;
      const codec = {
        ...roaringCodec,
        safeDeserialize: (b: Uint8Array, max: number) => {
          const bitmap = roaringCodec.safeDeserialize(b, max);
          // The target is decode 1; the writer then breaks on the third chunk it is handed.
          return ++decodes === 4
            ? ({
                isEmpty: false,
                size: 1,
                maximum: () => 0,
                serialize: () => {
                  throw new Error('writer broke');
                },
              } as unknown as CodecBitmap)
            : bitmap;
        },
      };
      // Reads from the 10th on fail after the writer has already gone, so their rejections have no consumer.
      const p = await probe(40, { failFrom: 10, delay: () => 25 });
      await expect(erase(p, joinId(0, 1), { codec })).rejects.toThrow('writer broke');
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });
});
