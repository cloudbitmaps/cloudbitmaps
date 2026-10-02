import roaring from 'roaring';
import { loadSegment } from '@/core/load';
import { MAX_SERIALIZED_LOAD_BYTES } from '@/core/load-input';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import { ValidationError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { craftPortable } from '../helpers/portable-bytes';

/**
 * What core's load accepts besides ids: `{ serialized }` (portable Roaring bytes) and `{ bitmap }` (anything that
 * serializes to them), and the one input it refuses outright, a byte array passed as ids.
 *
 * Every refusal here happens before the first round trip, so each case counts the calls the load made on its
 * drivers and expects none.
 */
const { RoaringBitmap32 } = roaring;
const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

/** Count every method call made on a driver. */
function counted<T extends object>(target: T): { driver: T; calls: string[] } {
  const calls: string[] = [];
  const driver = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { driver, calls };
}

function world(codec: CodecInterface = roaringCodec) {
  const storage = counted<IStorageDriver>(new MemoryStorageDriver());
  const registry = counted<IRegistryDriver>(new MemoryRegistryDriver());
  return {
    storage: storage.driver,
    registry: registry.driver,
    calls: () => [...storage.calls, ...registry.calls],
    deps: { storage: storage.driver, registry: registry.driver, codec },
  };
}

async function wholeObject(storage: IStorageDriver, generation: number): Promise<Uint8Array> {
  const tail = await storage.getTail({ ...SEG, generation }, 1 << 30);
  return tail.bytes;
}

const IDS = [0, 1, 2, 65_535, 65_536, 70_000, 2 ** 31, 2 ** 32 - 1];

describe('a byte array passed as ids is refused, not loaded byte by byte', () => {
  it.each([
    ['Uint8Array', new Uint8Array([58, 48, 0, 0])],
    ['Buffer', Buffer.from([1, 2, 3])],
    ['Uint8ClampedArray', new Uint8ClampedArray([1, 2, 3])],
    ['a portable serialization itself', new RoaringBitmap32([1, 2, 3]).serialize('portable')],
  ])(
    '%s → ValidationError naming { serialized } and Uint32Array, before any request',
    async (_, bytes) => {
      const w = world();
      const err = await loadSegment(SEG, bytes as Iterable<number>, w.deps).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain('{ serialized }');
      expect((err as Error).message).toContain('Uint32Array');
      expect(w.calls()).toEqual([]);
    },
  );

  it.each([
    ['Uint16Array', new Uint16Array([1, 2, 65_535])],
    ['Uint32Array', new Uint32Array(IDS)],
    ['Int32Array', new Int32Array([1, 2, 3])],
    ['Float64Array', new Float64Array([1, 2, 2 ** 32 - 1])],
  ])('%s stays ids', async (_, ids) => {
    const w = world();
    const r = await loadSegment(SEG, ids, w.deps);
    expect(r).toMatchObject({ published: true, cardinality: new Set(ids).size });
  });
});

describe('{ serialized }: portable Roaring bytes, checked before anything is read or written', () => {
  it('loads the set the bytes hold, with the same object and result as the ids', async () => {
    const a = world();
    const b = world();
    const byIds = await loadSegment(SEG, IDS, a.deps);
    const bySerialized = await loadSegment(
      SEG,
      { serialized: new RoaringBitmap32(IDS).serialize('portable') },
      b.deps,
    );
    expect(bySerialized).toEqual(byIds);
    expect(await wholeObject(b.storage, 0)).toEqual(await wholeObject(a.storage, 0));
  });

  it('the empty bitmap, as 8 bytes or as none, is an empty load (refused over a non-empty segment)', async () => {
    for (const serialized of [new RoaringBitmap32().serialize('portable'), new Uint8Array(0)]) {
      const w = world();
      expect(await loadSegment(SEG, { serialized }, w.deps)).toMatchObject({
        published: true,
        cardinality: 0,
        chunkCount: 0,
      });
      await loadSegment(SEG, [5], w.deps);
      expect(await loadSegment(SEG, { serialized }, w.deps)).toMatchObject({
        published: false,
        reason: 'empty',
      });
    }
  });

  it.each([
    [
      'containers out of order',
      craftPortable([
        { key: 1, kind: 'array', values: [1] },
        { key: 0, kind: 'array', values: [1] },
      ]),
    ],
    ['values out of order', craftPortable([{ key: 0, kind: 'array', values: [3, 2] }])],
    ['a truncated buffer', new RoaringBitmap32([1, 2, 3]).serialize('portable').subarray(0, 10)],
    ['an unknown cookie', new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0])],
  ])('%s → ValidationError, and nothing is read or written', async (_, serialized) => {
    const w = world();
    const err = await loadSegment(SEG, { serialized }, w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/portable roaring/i);
    expect(w.calls()).toEqual([]);
  });

  it.each([
    ['an ArrayBuffer', new ArrayBuffer(8)],
    ['a number array', [58, 48, 0, 0]],
    ['a Uint16Array', new Uint16Array(4)],
    ['undefined', undefined],
  ])('serialized as %s → ValidationError', async (_, serialized) => {
    const w = world();
    const input = { serialized } as unknown as { serialized: Uint8Array };
    await expect(loadSegment(SEG, input, w.deps)).rejects.toThrow(ValidationError);
    expect(w.calls()).toEqual([]);
  });

  it('bytes over the largest canonical 32-bit bitmap → ValidationError that says to runOptimize()', async () => {
    const w = world();
    // Never touched, so the pages stay unbacked: the size is refused before a byte is read.
    const serialized = new Uint8Array(new ArrayBuffer(MAX_SERIALIZED_LOAD_BYTES + 1));
    const err = await loadSegment(SEG, { serialized }, w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('runOptimize()');
    expect(w.calls()).toEqual([]);
  });
});

describe('{ bitmap }: sugar for { serialized: bitmap.serialize("portable") }', () => {
  it('serializes once, at the call, so a later change to the bitmap is not loaded', async () => {
    const w = world();
    const bitmap = new RoaringBitmap32([1, 2, 3]);
    const serialize = vi.spyOn(bitmap, 'serialize');
    const pending = loadSegment(SEG, { bitmap }, w.deps);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith('portable');
    bitmap.add(4);
    expect(await pending).toMatchObject({ published: true, cardinality: 3 });
  });

  it('a bitmap whose bytes are not portable Roaring is refused like bad bytes', async () => {
    const w = world();
    const bitmap = { serialize: () => new Uint8Array([1, 2, 3, 4, 5]) };
    const err = await loadSegment(SEG, { bitmap }, w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(w.calls()).toEqual([]);
  });

  it.each([
    ['no serialize method', {}],
    ['serialize returns no bytes', { serialize: () => [1, 2, 3] }],
  ])('a bitmap with %s → ValidationError', async (_, bitmap) => {
    const w = world();
    const input = { bitmap } as unknown as { bitmap: { serialize(f: 'portable'): Uint8Array } };
    await expect(loadSegment(SEG, input, w.deps)).rejects.toThrow(ValidationError);
    expect(w.calls()).toEqual([]);
  });

  it("the bitmap's own error propagates unchanged", async () => {
    const w = world();
    const boom = new Error('caller bitmap is disposed');
    const bitmap = {
      serialize: (): Uint8Array => {
        throw boom;
      },
    };
    await expect(loadSegment(SEG, { bitmap }, w.deps)).rejects.toBe(boom);
    expect(w.calls()).toEqual([]);
  });
});

describe('an input that is none of the three is refused', () => {
  it.each([
    ['both wrappers at once', { bitmap: new RoaringBitmap32([1]), serialized: new Uint8Array(0) }],
    ['a misspelled wrapper', { serialised: new Uint8Array(0) }],
    ['a wrapper with an extra key', { serialized: new Uint8Array(0), keep: 0 }],
    ['an empty object', {}],
    ['a number', 7],
    ['null', null],
  ])('%s → ValidationError, before any request', async (_, input) => {
    const w = world();
    await expect(loadSegment(SEG, input as unknown as Iterable<number>, w.deps)).rejects.toThrow(
      ValidationError,
    );
    expect(w.calls()).toEqual([]);
  });
});

describe('a codec without encodeChunks loads a bitmap input through its ids', () => {
  it('and writes the same object as the ids would', async () => {
    const withoutEncode: CodecInterface = {
      ...roaringCodec,
      safeDeserialize: (bytes, max) => {
        const bitmap = roaringCodec.safeDeserialize(bytes, max);
        return new Proxy(bitmap, {
          get: (t, prop) => (prop === 'encodeChunks' ? undefined : Reflect.get(t, prop, t)),
        }) as CodecBitmap;
      },
    };
    const a = world();
    const b = world(withoutEncode);
    const byIds = await loadSegment(SEG, IDS, a.deps);
    const byBitmap = await loadSegment(SEG, { bitmap: new RoaringBitmap32(IDS) }, b.deps);
    expect(byBitmap).toEqual(byIds);
    expect(await wholeObject(b.storage, 0)).toEqual(await wholeObject(a.storage, 0));
  });
});
