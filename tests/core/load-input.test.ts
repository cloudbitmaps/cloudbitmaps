import { runInNewContext } from 'node:vm';
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

  // Every typed array but the two byte arrays: the number kinds load as ids, and the bigint kinds stay ids too, so
  // each element meets the id check, which refuses a bigint.
  const numberKinds = [
    'Int8Array',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float16Array',
    'Float32Array',
    'Float64Array',
  ].filter((name) => name in globalThis);
  it.each(numberKinds)('%s stays ids', async (name) => {
    const Kind = (globalThis as unknown as Record<string, new (v: number[]) => Iterable<number>>)[
      name
    ]!;
    const ids = new Kind([1, 2, 3, 100]);
    const w = world();
    const r = await loadSegment(SEG, ids, w.deps);
    expect(r).toMatchObject({ published: true, cardinality: 4 });
  });

  it.each(['BigInt64Array', 'BigUint64Array'])(
    '%s stays ids, refused by the id check',
    async (name) => {
      const Kind = (globalThis as unknown as Record<string, new (v: bigint[]) => Iterable<number>>)[
        name
      ]!;
      const w = world();
      const err = await loadSegment(SEG, new Kind([1n, 2n]), w.deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/^id must be an integer/);
    },
  );

  it('a byte array from another realm is refused too, and its bytes load as { serialized }', async () => {
    for (const source of ['new Uint8Array([1, 2, 3])', 'new Uint8ClampedArray([1, 2, 3])']) {
      const w = world();
      const bytes = runInNewContext(source) as Iterable<number>;
      expect(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray).toBe(false);
      await expect(loadSegment(SEG, bytes, w.deps)).rejects.toThrow(/\{ serialized \}/);
      expect(w.calls()).toEqual([]);
    }
    const a = world();
    const b = world();
    const portable = Array.from(new RoaringBitmap32(IDS).serialize('portable'));
    const foreign = runInNewContext(`new Uint8Array(${JSON.stringify(portable)})`) as Uint8Array;
    expect(await loadSegment(SEG, { serialized: foreign }, b.deps)).toEqual(
      await loadSegment(SEG, IDS, a.deps),
    );
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

  it('the cap is the largest a canonical 32-bit bitmap can serialize to, under the run cookie', () => {
    // A 4-byte cookie, 8,192 bytes of run flags, 8 bytes of header for each of the 65,536 containers, and no
    // container over 8,192 bytes: a canonical run container is smaller than the bitset it beats.
    expect(MAX_SERIALIZED_LOAD_BYTES).toBe(4 + 8_192 + 8 * 65_536 + 65_536 * 8_192);
    expect(MAX_SERIALIZED_LOAD_BYTES).toBe(537_403_396);
  });

  /** A codec that records what it was asked to decode and decodes nothing. */
  /** A SharedArrayBuffer by its brand, which a `Symbol.toStringTag` cannot fake. */
  const sabByteLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
  )!.get!;
  function isShared(buffer: ArrayBufferLike): boolean {
    try {
      sabByteLength.call(buffer);
      return true;
    } catch {
      return false;
    }
  }

  function recordingCodec(): {
    codec: CodecInterface;
    calls: Array<{ length: number; max: number; shared: boolean }>;
  } {
    const calls: Array<{ length: number; max: number; shared: boolean }> = [];
    const codec: CodecInterface = {
      ...roaringCodec,
      safeDeserialize: (bytes, max) => {
        calls.push({
          length: bytes.byteLength,
          max,
          shared: isShared(bytes.buffer),
        });
        return roaringCodec.empty();
      },
    };
    return { codec, calls };
  }

  it('bytes exactly at the cap reach the codec, with the cap', async () => {
    const { codec, calls } = recordingCodec();
    const w = world(codec);
    // Never touched, so the pages stay unbacked.
    const serialized = new Uint8Array(new ArrayBuffer(MAX_SERIALIZED_LOAD_BYTES));
    expect(await loadSegment(SEG, { serialized }, w.deps)).toMatchObject({ published: true });
    expect(calls).toEqual([
      { length: MAX_SERIALIZED_LOAD_BYTES, max: MAX_SERIALIZED_LOAD_BYTES, shared: false },
    ]);
  });

  it('one byte over the cap → ValidationError that says to runOptimize(), and the codec never sees it', async () => {
    const { codec, calls } = recordingCodec();
    const w = world(codec);
    const serialized = new Uint8Array(new ArrayBuffer(MAX_SERIALIZED_LOAD_BYTES + 1));
    const err = await loadSegment(SEG, { serialized }, w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('runOptimize()');
    expect(calls).toEqual([]);
    expect(w.calls()).toEqual([]);
  });

  it('bytes after the bitmap are refused: one buffer is one bitmap, and parts are combined first', async () => {
    const a = new RoaringBitmap32([1, 2, 3]).serialize('portable');
    const b = new RoaringBitmap32([70_000, 70_001]).serialize('portable');
    for (const serialized of [
      Buffer.concat([a, b]), // two parts back to back: only the first would have loaded
      Buffer.concat([a, Buffer.from([0])]),
      Buffer.concat([new RoaringBitmap32().serialize('portable'), Buffer.from([1, 2, 3, 4])]),
    ]) {
      const w = world();
      const err = await loadSegment(SEG, { serialized }, w.deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain('orMany');
      expect(w.calls()).toEqual([]);
    }
    const w = world();
    const bitmap = { serialize: () => Buffer.concat([a, b]) };
    await expect(loadSegment(SEG, { bitmap }, w.deps)).rejects.toThrow(ValidationError);
  });

  it('a view at an offset into a larger buffer loads the bytes it views', async () => {
    const portable = new RoaringBitmap32(IDS).serialize('portable');
    const larger = new Uint8Array(portable.length + 20).fill(0xff);
    larger.set(portable, 7);
    const view = larger.subarray(7, 7 + portable.length);
    expect(view.byteOffset).toBe(7);
    const a = world();
    const b = world();
    expect(await loadSegment(SEG, { serialized: view }, b.deps)).toEqual(
      await loadSegment(SEG, IDS, a.deps),
    );
    expect(await wholeObject(b.storage, 0)).toEqual(await wholeObject(a.storage, 0));
  });

  it('bytes in a SharedArrayBuffer reach the codec as a copy no other thread can change', async () => {
    const portable = new RoaringBitmap32(IDS).serialize('portable');
    const shared = new Uint8Array(new SharedArrayBuffer(portable.length));
    shared.set(portable);
    const { codec, calls } = recordingCodec();
    await loadSegment(SEG, { serialized: shared }, world(codec).deps);
    expect(calls).toEqual([
      { length: portable.length, max: MAX_SERIALIZED_LOAD_BYTES, shared: false },
    ]);
    const a = world();
    const b = world();
    expect(await loadSegment(SEG, { serialized: shared }, b.deps)).toEqual(
      await loadSegment(SEG, IDS, a.deps),
    );
  });

  it('a SharedArrayBuffer is known by its brand, not by a tag it can be given', async () => {
    const portable = new RoaringBitmap32(IDS).serialize('portable');
    const disguised = new SharedArrayBuffer(portable.length);
    Object.defineProperty(disguised, Symbol.toStringTag, { value: 'ArrayBuffer' });
    expect(Object.prototype.toString.call(disguised)).toBe('[object ArrayBuffer]');
    const view = new Uint8Array(disguised);
    view.set(portable);
    const { codec, calls } = recordingCodec();
    await loadSegment(SEG, { serialized: view }, world(codec).deps);
    expect(calls.map((c) => c.shared)).toEqual([false]);
  });

  it('a Uint8Array whose byteLength lies is checked over the bytes it really holds', async () => {
    // A subclass's getters are not what the decoder reads, so the check must not read them either.
    class Lying extends Uint8Array {
      override get byteLength(): number {
        return 0;
      }
    }
    const malformed = craftPortable([
      { key: 1, kind: 'array', values: [1] },
      { key: 0, kind: 'array', values: [1] },
    ]);
    const w = world();
    const err = await loadSegment(SEG, { serialized: new Lying(malformed) }, w.deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(w.calls()).toEqual([]);
  });

  it('a detached buffer holds no bytes, and loads as the empty bitmap', async () => {
    const bytes = new RoaringBitmap32([1, 2, 3]).serialize('portable');
    const detached = new Uint8Array(bytes);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(detached.byteLength).toBe(0);
    const w = world();
    expect(await loadSegment(SEG, { serialized: detached }, w.deps)).toMatchObject({
      published: true,
      cardinality: 0,
    });
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

  it('a bitmap that can say its size is refused over the cap before it is serialized', async () => {
    const w = world();
    const serialize = vi.fn(() => new Uint8Array(0));
    const bitmap = {
      getSerializationSizeInBytes: (format: string) =>
        format === 'portable' ? MAX_SERIALIZED_LOAD_BYTES + 1 : 0,
      serialize,
    };
    const err = await loadSegment(SEG, { bitmap }, w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('runOptimize()');
    expect(serialize).not.toHaveBeenCalled();
    expect(w.calls()).toEqual([]);
    // RoaringBitmap32 can, and is asked in the format it is about to be serialized in.
    const real = new RoaringBitmap32([1, 2, 3]);
    const size = vi.spyOn(real, 'getSerializationSizeInBytes');
    await loadSegment(SEG, { bitmap: real }, world().deps);
    expect(size).toHaveBeenCalledWith('portable');
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
