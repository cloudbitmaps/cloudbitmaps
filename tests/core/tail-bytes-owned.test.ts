/**
 * A driver may answer a tail read with a Node `Buffer`, whose `slice` is a view of the driver's memory rather than a
 * copy. A reader that keeps a small generation's chunk region must hold bytes of its own all the same: when the driver
 * reuses or overwrites the buffer it answered with, the chunks served from memory stay the ones the object holds.
 */
import { describe, expect, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { GenKey, TailRead } from '@/core/ports';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { collect } from '../helpers/chunk-stream';

const K = 65_536;
/** Three chunks of 200 ids: a chunk region far under the 64 KiB a reader keeps by default. */
const IDS = Array.from({ length: 600 }, (_, i) => Math.floor(i / 200) * K + (i % 200) * 3);

/** A memory backend whose tail reads answer with a `Buffer` view into a larger pool it keeps, as a pooling driver might. */
async function bufferAnsweringWorld() {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  await bulkLoadCrbmGeneration(storage, { segment: 's', generation: 0 }, IDS, { registry });
  const pools: Buffer[] = [];
  const answered: Uint8Array[] = [];
  const calls = { tails: 0, ranges: 0 };
  const getTail = storage.getTail.bind(storage);
  vi.spyOn(storage, 'getTail').mockImplementation(async (key: GenKey, max: number) => {
    calls.tails++;
    const tail: TailRead = await getTail(key, max);
    const pool = Buffer.alloc(tail.bytes.length + 4096);
    pool.set(tail.bytes, 1024);
    pools.push(pool);
    const bytes = pool.subarray(1024, 1024 + tail.bytes.length);
    answered.push(bytes);
    return { ...tail, bytes };
  });
  const getRange = storage.getRange.bind(storage);
  vi.spyOn(storage, 'getRange').mockImplementation((key, offset, length) => {
    calls.ranges++;
    return getRange(key, offset, length);
  });
  const store = new CloudRoaring({ storage: backend });
  return { store, pools, answered, calls };
}

describe('a tail answered as a Node Buffer', () => {
  it('is what the driver hands back: a Buffer whose slice shares its memory', async () => {
    const { store, answered } = await bufferAnsweringWorld();
    expect(await store.segment('s').has(K + 3)).toBe(true);
    const [bytes] = answered;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    const view = bytes!.slice(0, 4);
    expect(view.buffer).toBe(bytes!.buffer);
  });

  it('leaves the reader its own chunk bytes: overwriting the driver buffer changes no read', async () => {
    const { store, pools, calls } = await bufferAnsweringWorld();
    const seg = store.segment('s');
    // The open: one tail read, the whole object, and the chunk region kept.
    expect(await seg.has(K + 3)).toBe(true);
    expect(calls).toEqual({ tails: 1, ranges: 0 });
    // The driver reuses its memory.
    for (const pool of pools) pool.fill(0xff);
    // Every chunk is still served from memory, whole and checksum-clean.
    expect(await collect(seg.iterate())).toEqual(IDS);
    expect(await seg.has(2 * K + 597)).toBe(true);
    expect(await seg.has(2 * K + 598)).toBe(false);
    expect(calls).toEqual({ tails: 1, ranges: 0 });
  });
});
