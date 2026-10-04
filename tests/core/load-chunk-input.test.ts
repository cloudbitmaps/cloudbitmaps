import { loadSegment } from '@/core/load';
import type { LoadInput } from '@/core/load-input';
import { ValidationError } from '@/core/errors';
import type { CodecBitmap } from '@/core/codec';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

/**
 * The input a flavor gives a load for a combine's result: its chunks as bitmaps, in place of ids, marked with a
 * registered symbol. The load writes them as it writes the chunks of ids, and checks each as it checks an id: the key
 * a u16 and above the one before, the values 16-bit, an empty chunk left out. Anything it refuses it refuses before it
 * has written an object or moved the pointer.
 */
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const BRAND = Symbol.for('cloudbitmaps.load-input.chunks');

const chunk = (
  chunkKey: number,
  ...remainders: number[]
): { chunkKey: number; bitmap: CodecBitmap } => ({
  chunkKey,
  bitmap: roaringCodec.fromValues(remainders),
});

async function* of<T>(...items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const chunksInput = (source: unknown): LoadInput => ({ [BRAND]: source }) as unknown as LoadInput;

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  const puts: string[] = [];
  const put = storage.putImmutable.bind(storage);
  storage.putImmutable = (key, write) => {
    puts.push(`${key.segment}.${key.generation}`);
    return put(key, write);
  };
  return {
    puts,
    storage: storage as IStorageDriver,
    registry: registry as IRegistryDriver,
    deps: {
      storage: storage as IStorageDriver,
      registry: registry as IRegistryDriver,
      codec: roaringCodec,
    },
  };
}

const object = async (storage: IStorageDriver): Promise<string> =>
  Buffer.from((await storage.getTail({ ...SEG, generation: 0 }, 1 << 30)).bytes).toString('hex');

describe('a load of a combine’s chunks', () => {
  const ids = [3, 4, 65_536 + 9, 3 * 65_536, 3 * 65_536 + 65_535];
  const chunks = [chunk(0, 3, 4), chunk(1, 9), chunk(3, 0, 65_535)];

  it('writes the generation, the result and the object the same ids write', async () => {
    const a = world();
    const b = world();
    const byIds = await loadSegment(SEG, ids, a.deps);
    const byChunks = await loadSegment(SEG, chunksInput(of(...chunks)), b.deps);
    expect(byChunks).toEqual(byIds);
    expect(await object(b.storage)).toEqual(await object(a.storage));
  });

  it('leaves out an empty chunk, as no empty chunk is stored', async () => {
    const a = world();
    const b = world();
    const byIds = await loadSegment(
      SEG,
      [3, 4, 3 * 65_536, 3 * 65_536 + 65_535, 9 * 65_536 + 9],
      a.deps,
    );
    const byChunks = await loadSegment(
      SEG,
      chunksInput(of(chunk(0, 3, 4), chunk(1), chunk(2), chunk(3, 0, 65_535), chunk(9, 9))),
      b.deps,
    );
    expect(byChunks).toEqual(byIds);
    expect(byChunks.chunkCount).toBe(3);
    expect(await object(b.storage)).toEqual(await object(a.storage));
  });

  it('refuses a key that is not a u16, or that does not ascend, before writing anything', async () => {
    for (const bad of [
      [chunk(65_536, 1)],
      [chunk(-1, 1)],
      [chunk(1.5, 1)],
      [chunk(Number.NaN, 1)],
      [chunk(2, 1), chunk(1, 1)],
      [chunk(2, 1), chunk(2, 5)],
    ]) {
      const w = world();
      const err = await loadSegment(SEG, chunksInput(of(...bad)), w.deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(w.puts).toEqual([]);
      expect(await w.registry.get(SEG)).toBeNull();
    }
  });

  it('refuses a chunk holding a value above 65,535, which no remainder can be', async () => {
    const w = world();
    const wide = { chunkKey: 0, bitmap: roaringCodec.fromValues([1, 70_000]) };
    const err = await loadSegment(
      SEG,
      chunksInput(of(chunk(0, 1), { ...wide, chunkKey: 1 })),
      w.deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('16-bit');
    expect(w.puts).toEqual([]);
  });

  it('refuses what is not an async iterable of chunks', async () => {
    for (const bad of [[chunk(0, 1)], 5, null, { next: () => ({}) }]) {
      const w = world();
      await expect(loadSegment(SEG, chunksInput(bad), w.deps)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(w.puts).toEqual([]);
    }
  });

  it('writes nothing when the source fails part-way', async () => {
    const w = world();
    async function* failing(): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
      yield chunk(0, 1);
      throw new Error('the source failed');
    }
    await expect(loadSegment(SEG, chunksInput(failing()), w.deps)).rejects.toThrow(
      'the source failed',
    );
    expect(w.puts).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('is not read until the load has made its first request, as ids are not', async () => {
    const w = world();
    let started = false;
    async function* lazy(): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
      started = true;
      yield chunk(0, 1);
    }
    const input = chunksInput(lazy());
    expect(started).toBe(false);
    const done = loadSegment(SEG, input, w.deps);
    expect(started).toBe(false);
    await done;
    expect(started).toBe(true);
  });
});
