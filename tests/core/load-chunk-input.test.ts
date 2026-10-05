import { loadSegment, loadSegmentChunks } from '@/core/load';
import type { LoadInput } from '@/core/load-input';
import { ValidationError } from '@/core/errors';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import roaring from 'roaring';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

/**
 * The input a flavor gives a load for a combine's result, through `loadSegmentChunks`: its chunks as bitmaps, in place
 * of ids. The load writes them as it writes the chunks of ids, and checks each as it checks an id: the key
 * a u16 and above the one before, the values 16-bit, an empty chunk left out. Anything it refuses it refuses before it
 * has written an object or moved the pointer.
 */
const { RoaringBitmap32 } = roaring;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

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
    const byChunks = await loadSegmentChunks(SEG, of(...chunks), b.deps);
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
    const byChunks = await loadSegmentChunks(
      SEG,
      of(chunk(0, 3, 4), chunk(1), chunk(2), chunk(3, 0, 65_535), chunk(9, 9)),
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
      const err = await loadSegmentChunks(SEG, of(...bad), w.deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(w.puts).toEqual([]);
      expect(await w.registry.get(SEG)).toBeNull();
    }
  });

  it('refuses a chunk holding a value above 65,535, which no remainder can be', async () => {
    const w = world();
    const wide = { chunkKey: 0, bitmap: roaringCodec.fromValues([1, 70_000]) };
    const err = await loadSegmentChunks(
      SEG,
      of(chunk(0, 1), { ...wide, chunkKey: 1 }),
      w.deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('16-bit');
    expect(w.puts).toEqual([]);
  });

  it('refuses what is not an async iterable of chunks', async () => {
    for (const bad of [[chunk(0, 1)], 5, null, { next: () => ({}) }]) {
      const w = world();
      await expect(
        loadSegmentChunks(SEG, bad as unknown as AsyncIterable<never>, w.deps),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(w.puts).toEqual([]);
    }
  });

  it('writes nothing when the source fails part-way', async () => {
    const w = world();
    async function* failing(): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
      yield chunk(0, 1);
      throw new Error('the source failed');
    }
    await expect(loadSegmentChunks(SEG, failing(), w.deps)).rejects.toThrow('the source failed');
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
    const input = lazy();
    expect(started).toBe(false);
    const done = loadSegmentChunks(SEG, input, w.deps);
    expect(started).toBe(false);
    await done;
    expect(started).toBe(true);
  });
});

describe('only bitmaps the codec made are written', () => {
  const foreign: Array<[string, unknown]> = [
    [
      'a plain object shaped like a bitmap',
      { isEmpty: false, size: 1, serialize: () => new Uint8Array([1]), maximum: () => 0 },
    ],
    [
      'a bitmap whose serialization is garbage',
      { isEmpty: false, size: 3, serialize: () => new Uint8Array(5), maximum: () => 2 },
    ],
    [
      'a bitmap that lies about its size',
      { isEmpty: false, size: 7, serialize: () => new Uint8Array([1]), maximum: () => 2 },
    ],
    [
      'a bitmap with no maximum()',
      { isEmpty: false, size: 2, serialize: () => new Uint8Array([1]) },
    ],
    ["roaring's own bitmap, which is not the codec's", new RoaringBitmap32([1, 2])],
    ['no bitmap at all', undefined],
  ];
  it.each(foreign)('%s is refused before anything is written', async (_, bitmap) => {
    const w = world();
    const err = await loadSegmentChunks(
      SEG,
      of(chunk(0, 1), { chunkKey: 1, bitmap: bitmap as CodecBitmap }),
      w.deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('codec made');
    expect(w.puts).toEqual([]);
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('a null chunk is a ValidationError, not a TypeError', async () => {
    const w = world();
    await expect(
      loadSegmentChunks(
        SEG,
        of(null as unknown as { chunkKey: number; bitmap: CodecBitmap }),
        w.deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(w.puts).toEqual([]);
  });

  it('a chunk whose bitmap changes between reads is checked and written as one value', async () => {
    const w = world();
    const real = roaringCodec.fromValues([1]);
    const fake = {
      isEmpty: false,
      size: 999,
      serialize: () => new Uint8Array(3),
      maximum: () => 2,
    };
    let reads = 0;
    const shifty = {
      chunkKey: 0,
      get bitmap(): CodecBitmap {
        reads += 1;
        return (reads === 1 ? real : fake) as CodecBitmap;
      },
    };
    const result = await loadSegmentChunks(SEG, of(shifty), w.deps);
    expect(reads).toBe(1);
    expect(result.cardinality).toBe(1);
  });

  it('a bitmap changed after it was handed over is refused where it is written', async () => {
    const w = world();
    const first = chunk(0, 1);
    async function* changing(): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
      yield first;
      first.bitmap.add(70_000);
      yield chunk(1, 1);
    }
    const err = await loadSegmentChunks(SEG, changing(), w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('16-bit');
    expect(await w.registry.get(SEG)).toBeNull();
  });

  it('a codec that cannot vouch for its bitmaps has every chunk refused', async () => {
    const w = world();
    const mute: CodecInterface = { ...roaringCodec, owns: undefined };
    const err = await loadSegmentChunks(SEG, of(chunk(0, 1)), { ...w.deps, codec: mute }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(w.puts).toEqual([]);
  });
});

describe('the public loads take ids or a bitmap, never chunks', () => {
  const branded = (): LoadInput =>
    ({ [Symbol.for('cloudbitmaps.load-input.chunks')]: of(chunk(0, 1)) }) as unknown as LoadInput;

  it('loadSegment refuses it as an object that is none of the three inputs, before any request', async () => {
    const w = world();
    const err = await loadSegment(SEG, branded(), w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('takes ids');
    expect(w.puts).toEqual([]);
  });
});
