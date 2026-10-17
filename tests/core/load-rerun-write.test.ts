import roaring from 'roaring';
import type { BlobSink } from '@/core/blob';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, TransientError } from '@/core/errors';
import { loadSegment, loadSegmentChunks } from '@/core/load';
import { type GenKey, type IStorageDriver, type SegmentRef, brandAsBackend } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counterEntropy, withoutWriteIdentity } from '../helpers/entropy';

/**
 * The storage port lets a driver run `write` again after a failed attempt, as long as it commits only the last run's
 * bytes. No shipped driver does, so this is a driver of that kind: once armed, the first run of each object fails at
 * its fourth sink write, and the driver then runs `write` again into the sink it commits.
 *
 * A load whose chunks are in memory (ids, a bitmap, a combine's chunks) writes the whole object again on the second
 * run and records that run: the same bytes as a load under a driver that ran once, but for the write identity each run
 * draws, the same count and the same members. A write that streams its chunks, a sorted load or an erasure's rewrite,
 * reads them once, so its second run throws `IntegrityError` and nothing is committed.
 */

const { RoaringBitmap32 } = roaring;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const CHUNK = 65_536;
/** Twelve chunks, so an object takes more than four sink writes and the first run fails part way. */
const IDS = Array.from({ length: 12 }, (_, c) => [
  c * CHUNK + 1,
  c * CHUNK + 7,
  c * CHUNK + 300,
]).flat();

class RerunsAfterFailure extends MemoryStorageDriver {
  armed = false;
  runs = 0;

  override async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    if (!this.armed) return super.putImmutable(key, write);
    let writes = 0;
    this.runs++;
    await write({
      write: async () => {
        if (++writes === 4) throw new TransientError('the connection dropped');
      },
    }).catch(() => undefined);
    this.runs++;
    return super.putImmutable(key, write);
  }
}

function world() {
  const storage = new RerunsAfterFailure();
  const registry = new MemoryRegistryDriver();
  storage.armed = true;
  return {
    storage,
    registry,
    deps: { storage, registry, entropy: counterEntropy(), codec: roaringCodec },
  };
}

/** The object a load wrote, as hex, with the write identity each run draws masked. */
async function objectHex(storage: IStorageDriver, generation: number): Promise<string> {
  const tail = await storage.getTail({ ...SEG, generation }, 1 << 20);
  return Buffer.from(withoutWriteIdentity(tail.bytes)).toString('hex');
}

/** The same load under a driver that runs `write` once. */
async function once(input: Parameters<typeof loadSegment>[1]): Promise<string> {
  const storage = new MemoryStorageDriver();
  const deps = {
    storage,
    registry: new MemoryRegistryDriver(),
    entropy: counterEntropy(),
    codec: roaringCodec,
  };
  const r = await loadSegment(SEG, input, deps);
  return objectHex(storage, r.generation);
}

async function* async(ids: readonly number[]): AsyncGenerator<number> {
  for (const id of ids) yield id;
}

describe('a driver that runs write again after a failed attempt', () => {
  it.each<[string, () => Parameters<typeof loadSegment>[1]]>([
    ['unsorted ids', () => [...IDS].reverse()],
    ['an async source of ids', () => async(IDS)],
    ['{ bitmap }', () => ({ bitmap: new RoaringBitmap32(IDS) })],
    ['{ serialized }', () => ({ serialized: new RoaringBitmap32(IDS).serialize('portable') })],
  ])(
    'gets the whole object again from a load of %s, and the load records that run',
    async (_, input) => {
      const w = world();
      const r = await loadSegment(SEG, input(), w.deps);
      expect(w.storage.runs).toBe(2);
      expect(r).toMatchObject({ published: true, cardinality: IDS.length, chunkCount: 12 });
      expect(await objectHex(w.storage, r.generation)).toBe(await once(input()));
    },
  );

  it("gets the whole object again from a combine's chunks", async () => {
    const w = world();
    async function* chunks() {
      for (let c = 0; c < 12; c++)
        yield { chunkKey: c, bitmap: roaringCodec.fromValues([1, 7, 300]) };
    }
    const r = await loadSegmentChunks(SEG, chunks(), w.deps);
    expect(w.storage.runs).toBe(2);
    expect(r).toMatchObject({ published: true, cardinality: IDS.length, chunkCount: 12 });
    expect(await objectHex(w.storage, r.generation)).toBe(await once(IDS));
  });

  it('serves the right count and members through the store', async () => {
    const w = world();
    const store = new CloudRoaring({
      storage: brandAsBackend({ storage: w.storage, registry: w.registry }),
    });
    await store.load({ segment: 's', namespace: 'ns' }, [...IDS].reverse());
    const seg = store.segment('s', { namespace: 'ns' });
    expect(await seg.count()).toBe(IDS.length);
    expect(await seg.has(IDS[0]!)).toBe(true);
    expect(await seg.has(IDS.at(-1)!)).toBe(true);
    expect(await seg.has(2)).toBe(false);
  });

  it('throws IntegrityError from a sorted load, which reads its ids once, and commits nothing', async () => {
    const w = world();
    const err = await loadSegment(SEG, IDS, w.deps, { sorted: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect((err as Error).message).toMatch(/ran the write of s\.0 again/);
    expect(w.storage.runs).toBe(2);
    const listed: GenKey[] = [];
    for await (const k of w.storage.list(SEG)) listed.push(k);
    expect(listed).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it("throws IntegrityError from an erasure's rewrite, which streams its chunks, and leaves the segment as it was", async () => {
    const w = world();
    w.storage.armed = false;
    await loadSegment(SEG, IDS, w.deps);
    const before = await w.registry.get(SEG);
    w.storage.armed = true;
    const err = await eraseIdFromSegment(SEG, IDS[4]!, w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(await w.registry.get(SEG)).toEqual(before);
    const listed: number[] = [];
    for await (const k of w.storage.list(SEG)) listed.push(k.generation);
    expect(listed).toEqual([0]);
  });
});
