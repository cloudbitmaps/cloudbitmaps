import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import roaring from 'roaring';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { CloudRoaringOptions, LoadInput, LoadResult, PortableBitmap } from '@/index';
import { bulkLoadCrbmGeneration, openGenerationReader } from '@/core/crbm-storage-source';
import { prepareLoadInput } from '@/core/load-input';
import type { DecodedLoadInput } from '@/core/load-input';
import { MemoryStorageDriver } from '@/drivers/memory';
import { aadFor } from '@/core/crypto';
import { InProcessKeystore } from '@/drivers/crypto';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { checkPortableLayout, containerPayloads } from '@/portable/layout';
import { IntegrityError } from '@/core/errors';
import { bitsetOf, craftPortable } from '../helpers/portable-bytes';
import type { CodecBitmap, CodecInterface } from '@/core/codec';
import { loadSegment } from '@/core/load';
import { MemoryRegistryDriver } from '@/drivers/memory';

/**
 * A load from a bitmap writes the generation the same ids write, byte for byte.
 *
 * `tests/golden/v1.0-load.crbm` is the object `store.load()` wrote from the ids below on `main` before bitmap
 * inputs existed. Every input must reproduce it, which proves two things at once: the bitmap path writes what the
 * id path writes, and making `optimize()` canonical moved no id load's bytes.
 */
const { RoaringBitmap32 } = roaring;
const GOLDEN = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../golden/v1.0-load.crbm', import.meta.url))),
);
const at = (chunk: number, low: number): number => chunk * 65_536 + low;
/** An array, a 4,097-value bitset, a run, two run/array ties, a full chunk, and the top of the id space. */
const IDS = [
  ...[1, 10, 100, 65_535].map((v) => at(0, v)),
  ...Array.from({ length: 4_097 }, (_, i) => at(1, 2 * i)),
  ...Array.from({ length: 1_000 }, (_, i) => at(2, i)),
  ...[5, 6, 7].map((v) => at(3, v)),
  ...[10, 11, 12, 20, 21].map((v) => at(4, v)),
  ...Array.from({ length: 65_536 }, (_, i) => at(7, i)),
  ...[65_534, 65_535].map((v) => at(65_535, v)),
];

/** The same set built from ranges, so its containers start as runs, ties included. */
function fromRanges(): InstanceType<typeof RoaringBitmap32> {
  const b = new RoaringBitmap32([1, 10, 100, 65_535].map((v) => at(0, v)));
  b.addMany(Array.from({ length: 4_097 }, (_, i) => at(1, 2 * i)));
  b.addRange(at(2, 0), at(2, 1_000));
  b.addRange(at(3, 5), at(3, 8));
  b.addRange(at(4, 10), at(4, 13));
  b.addRange(at(4, 20), at(4, 22));
  b.addRange(at(7, 0), at(8, 0));
  b.addRange(at(65_535, 65_534), 2 ** 32);
  return b;
}

const SEG = { segment: 'golden' };

async function loadAndRead(
  input: LoadInput,
  options: Omit<CloudRoaringOptions, 'storage'> = {},
): Promise<{ result: LoadResult; bytes: Uint8Array; backend: MemoryStorage }> {
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ ...options, storage: backend });
  const result = await store.load(SEG, input);
  const tail = await backend.storage.getTail({ ...SEG, generation: result.generation }, 1 << 30);
  return { result, bytes: tail.bytes, backend };
}

const INPUTS: Array<[string, () => LoadInput]> = [
  ['ids', () => IDS],
  ['ids as a Uint32Array', () => Uint32Array.from(IDS)],
  ['{ bitmap } built from ids', () => ({ bitmap: new RoaringBitmap32(IDS) })],
  ['{ bitmap } built from ranges', () => ({ bitmap: fromRanges() })],
  [
    '{ serialized } of a bitmap built from ranges',
    () => ({ serialized: fromRanges().serialize('portable') }),
  ],
  [
    '{ serialized } after runOptimize()',
    () => {
      const b = fromRanges();
      b.runOptimize();
      return { serialized: b.serialize('portable') };
    },
  ],
  ['a bare RoaringBitmap32 passed as ids', () => fromRanges()],
];

describe('every input reproduces the id load written on main, byte for byte', () => {
  it.each(INPUTS)('%s', async (_, input) => {
    const { result, bytes } = await loadAndRead(input());
    expect(Buffer.from(bytes).toString('hex')).toBe(Buffer.from(GOLDEN).toString('hex'));
    expect(result).toMatchObject({
      generation: 0,
      published: true,
      size: GOLDEN.length,
      chunkCount: 7,
      cardinality: IDS.length,
    });
  });

  it('the inputs carry run containers at the ties, which is what the golden is checking', () => {
    // Without this, the golden could pass for a bitmap path that never met a tie.
    const b = fromRanges();
    b.runOptimize();
    expect(b.statistics().runContainers).toBeGreaterThanOrEqual(4);
    const ids = new RoaringBitmap32(IDS);
    ids.runOptimize();
    expect(ids.statistics().runContainers).toBe(2); // the run and the full chunk; the ties stay arrays
  });
});

describe('optimize() is canonical, and moves no chunk built from ids', () => {
  /** A chunk as the id path builds it: from values, then a second batch, as a flush boundary does. */
  function idChunk(values: number[]): InstanceType<typeof RoaringBitmap32> {
    const half = values.length >> 1;
    const b = new RoaringBitmap32(values.slice(0, half));
    b.addMany(values.slice(half));
    return b;
  }

  it.each([
    ['one value', [7]],
    ['the 3-in-1 tie', [5, 6, 7]],
    ['the 5-in-2 tie', [10, 11, 12, 20, 21]],
    ['4,096 values', Array.from({ length: 4_096 }, (_, i) => 3 * i)],
    ['4,097 values', Array.from({ length: 4_097 }, (_, i) => 3 * i)],
    ['a long run', Array.from({ length: 5_000 }, (_, i) => i + 100)],
    ['a full chunk', Array.from({ length: 65_536 }, (_, i) => i)],
  ])(
    '%s: the old runOptimize() alone and the canonical optimize() write the same bytes',
    (_, values) => {
      const before = idChunk(values);
      before.runOptimize();
      const after = SafeBitmap.fromValues([]);
      after.addMany(values);
      after.optimize();
      expect(Buffer.from(after.serialize()).equals(before.serialize('portable'))).toBe(true);
    },
  );

  it('at a tie, a run container is re-encoded as the array a load from ids writes, 7 bytes larger', () => {
    // The one place the bytes move: a chunk that reached the writer as a run at a tie, which only a rewrite of a
    // stored chunk (erasure) could hand it before bitmap inputs. Same set, other bytes. The two containers are
    // the same 6 bytes; the payload around them is not, because a one-container bitmap under the run cookie has
    // a 9-byte header and one under the plain cookie a 16-byte header.
    const stored = new RoaringBitmap32();
    stored.addRange(5, 8);
    stored.runOptimize();
    const old = stored.serialize('portable');
    const canonical = SafeBitmap.safeDeserialize(old, 1 << 20);
    canonical.optimize();
    const now = canonical.serialize();
    expect(Buffer.from(now).equals(old)).toBe(false);
    expect(now.length).toBe(old.length + 7);
    expect(canonical.toArray()).toEqual([5, 6, 7]);
    expect(Buffer.from(now).equals(SafeBitmap.fromValues([5, 6, 7]).serialize())).toBe(true);
  });
});

describe('encodeChunks(): each chunk exactly as fromValues → optimize → serialize gives it', () => {
  it('on the golden set built from ranges', () => {
    const bitmap = SafeBitmap.safeDeserialize(fromRanges().serialize('portable'), 1 << 30);
    const chunks = [...bitmap.encodeChunks()];
    const byChunk = new Map<number, number[]>();
    for (const id of IDS) {
      const key = Math.floor(id / 65_536);
      const list = byChunk.get(key) ?? [];
      list.push(id % 65_536);
      byChunk.set(key, list);
    }
    expect(chunks.map((c) => c.chunkKey)).toEqual([...byChunk.keys()].sort((a, b) => a - b));
    for (const c of chunks) {
      const expected = roaringCodec.fromValues(byChunk.get(c.chunkKey)!);
      expected.optimize?.();
      expect(c.cardinality).toBe(expected.size);
      expect(Buffer.from(c.payload).equals(Buffer.from(expected.serialize()))).toBe(true);
    }
  });

  it('the empty bitmap has no chunks', () => {
    expect([...SafeBitmap.empty().encodeChunks()]).toEqual([]);
  });

  it('cuts lazily, one container per step, so a writer can yield between them', () => {
    const bitmap = SafeBitmap.safeDeserialize(fromRanges().serialize('portable'), 1 << 30);
    const chunks = bitmap.encodeChunks();
    expect(Object.prototype.toString.call(chunks)).toBe('[object Generator]');
    const iterator = chunks[Symbol.iterator]();
    expect(iterator.next().value).toMatchObject({ chunkKey: 0, cardinality: 4 });
  });

  it('cuts lazily: bytes that end after the first of three containers yield it, then refuse the second', () => {
    // A cut that built every payload on its first step would refuse on that step instead.
    const whole = craftPortable([
      { key: 0, kind: 'array', values: [7] },
      { key: 1, kind: 'array', values: [8] },
      { key: 2, kind: 'array', values: [9] },
    ]);
    const firstBodyEnds = 8 + 3 * 4 + 3 * 4 + 2; // cookie and count, the two headers, one u16 value
    const iterator = containerPayloads(whole.subarray(0, firstBodyEnds));
    expect(iterator.next().value).toMatchObject({ chunkKey: 0, cardinality: 1 });
    expect(() => iterator.next()).toThrow(IntegrityError);
  });
});

describe('the cut re-checks every container it copies', () => {
  // The bytes it cuts are the native serializer's, of a bitmap decoded from bytes that passed the structural check.
  // A buffer another thread was still writing during the call can decode into a bitmap the check never saw, whose
  // own serialization is then inconsistent: each container must hold what its header says, or nothing is written.
  const good = { key: 0, kind: 'array', values: [1, 2] } as const;
  it.each([
    ['an array out of order', { key: 1, kind: 'array', values: [5, 4] } as const],
    ['an array with a duplicate', { key: 1, kind: 'array', values: [4, 4] } as const],
    [
      'a bitset whose header overstates its bits',
      {
        key: 1,
        kind: 'bitset',
        bits: bitsetOf(Array.from({ length: 5_000 }, (_, i) => 2 * i)),
        cardinality: 5_001,
      },
    ] as const,
    [
      'overlapping runs',
      {
        key: 1,
        kind: 'run',
        runs: [
          [0, 9],
          [5, 9],
        ],
      } as const,
    ],
    [
      'a run past the end of its container',
      { key: 1, kind: 'run', runs: [[65_530, 9]], cardinality: 6 } as const,
    ],
    [
      'runs that cover other than the header says',
      { key: 1, kind: 'run', runs: [[0, 9]], cardinality: 4 } as const,
    ],
    ['a key out of order', { key: 0, kind: 'array', values: [3] } as const],
  ])('%s → IntegrityError at that container, after the ones before it', (_, bad) => {
    const iterator = containerPayloads(craftPortable([good, bad as never]));
    expect(iterator.next().value).toMatchObject({ chunkKey: 0, cardinality: 2 });
    expect(() => iterator.next()).toThrow(IntegrityError);
  });

  it('a load whose decode saw bytes the check did not throws IntegrityError and publishes nothing', async () => {
    // The race, made deterministic: this codec checks the bytes it is given, then decodes a copy whose bitset has
    // had bits cleared, as a threadpool write landing between the check and the decode would leave it.
    const ids = Array.from({ length: 32_768 }, (_, i) => at(5, 2 * i));
    const serialized = new RoaringBitmap32(ids).serialize('portable');
    const racing: CodecInterface = {
      ...roaringCodec,
      safeDeserialize: (bytes, max, options) => {
        roaringCodec.safeDeserialize(bytes, max, options); // passes: these are the bytes as they were
        const changed = new Uint8Array(bytes);
        changed.fill(0, changed.length - 64); // 256 bits of the bitset's body gone, its header unchanged
        expect(() => checkPortableLayout(changed)).toThrow(IntegrityError);
        const decoded = RoaringBitmap32.deserialize(changed, 'portable');
        return new (SafeBitmap as unknown as new (b: unknown) => CodecBitmap)(decoded);
      },
    };
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const err = await loadSegment(SEG, { serialized }, { storage, registry, codec: racing }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntegrityError);
    expect(await registry.get(SEG)).toBeNull();
    const objects: number[] = [];
    for await (const k of storage.list(SEG)) objects.push(k.generation);
    expect(objects).toEqual([]);
  });
});

describe('an encrypted load from a bitmap stores what the id load stores, under fresh nonces', () => {
  it('same index and decrypted payloads; the ciphertexts differ', async () => {
    const keys = { k1: randomBytes(32) };
    const options = (): Omit<CloudRoaringOptions, 'storage'> => ({
      encryption: { keystore: new InProcessKeystore({ keys, activeKeyId: 'k1' }) },
    });
    const byIds = await loadAndRead(IDS, options());
    const byBitmap = await loadAndRead({ bitmap: fromRanges() }, options());
    const { sha256: a, ...restIds } = byIds.result;
    const { sha256: b, ...restBitmap } = byBitmap.result;
    expect(restBitmap).toEqual(restIds);
    expect(a).not.toBe(b);

    const payloads = async (w: typeof byIds): Promise<Map<number, string>> => {
      const row = await w.backend.registry.get(SEG);
      const aead = await new InProcessKeystore({ keys, activeKeyId: 'k1' }).openDek(
        row!.wrappedDeks!,
      );
      const crypto = { aead, aadFor: (scope: never) => aadFor(SEG, 0, scope) };
      const reader = await openGenerationReader(
        w.backend.storage,
        { ...SEG, generation: 0 },
        crypto,
      );
      const out = new Map<number, string>();
      for (const key of reader.chunkKeys()) {
        out.set(
          key,
          `${reader.cardinalities().get(key)}:${Buffer.from((await reader.getChunk(key))!).toString('hex')}`,
        );
      }
      return out;
    };
    expect(await payloads(byBitmap)).toEqual(await payloads(byIds));
  });
});

describe('the facade: { bitmap } is typed by shape, and a bare RoaringBitmap32 takes the bitmap path', () => {
  it("roaring's RoaringBitmap32 satisfies PortableBitmap (a type-level check)", () => {
    const bitmap: PortableBitmap = new RoaringBitmap32([1]);
    const input: LoadInput = { bitmap };
    expect(input).toBeDefined();
  });

  it('a bare RoaringBitmap32 is serialized once and never iterated', async () => {
    const bitmap = fromRanges();
    const serialize = vi.spyOn(bitmap, 'serialize');
    const iterate = vi.spyOn(bitmap, Symbol.iterator);
    const { bytes } = await loadAndRead(bitmap);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(iterate).not.toHaveBeenCalled();
    expect(Buffer.from(bytes).equals(Buffer.from(GOLDEN))).toBe(true);
  });

  it('a RoaringBitmap32 from another copy of roaring is loaded as the ids it iterates', async () => {
    // A look-alike class: iterable, with serialize, but not this package's RoaringBitmap32.
    class Elsewhere {
      constructor(private readonly ids: number[]) {}
      serialize(): Uint8Array {
        throw new Error('not called: a bare bitmap of another class is ids');
      }
      [Symbol.iterator](): Iterator<number> {
        return this.ids[Symbol.iterator]();
      }
    }
    const { bytes } = await loadAndRead(new Elsewhere(IDS));
    expect(Buffer.from(bytes).equals(Buffer.from(GOLDEN))).toBe(true);
  });
});

describe('run containers of every size, and the run cookie at 40,000 and 65,536 containers', () => {
  /** `runs` runs of three values in one chunk, one value apart: a run container up to 2,047 runs, a bitset past. */
  function chunkOfRuns(chunk: number, runs: number): InstanceType<typeof RoaringBitmap32> {
    const b = new RoaringBitmap32();
    for (let r = 0; r < runs; r++) b.addRange(at(chunk, 4 * r), at(chunk, 4 * r + 3));
    return b;
  }
  /** One id in each of `containers` chunks, and a run in chunk 0, so the bitmap carries the run cookie. */
  function manyContainers(containers: number): InstanceType<typeof RoaringBitmap32> {
    const b = new RoaringBitmap32(
      Array.from({ length: containers - 1 }, (_, i) => at(i + 1, i % 65_536)),
    );
    b.addRange(at(0, 10), at(0, 500));
    return b;
  }

  it.each<[string, () => InstanceType<typeof RoaringBitmap32>, string]>([
    ['2 runs', () => chunkOfRuns(3, 2), 'run'],
    ['3 runs', () => chunkOfRuns(3, 3), 'run'],
    ['300 runs, a run count past one byte', () => chunkOfRuns(3, 300), 'run'],
    ['2,047 runs, the largest run container', () => chunkOfRuns(3, 2_047), 'run'],
    ['2,048 runs, where the bitset is smaller', () => chunkOfRuns(3, 2_048), 'bitset'],
    ['40,000 containers under the run cookie', () => manyContainers(40_000), 'run'],
    ['65,536 containers under the run cookie', () => manyContainers(65_536), 'run'],
  ])('%s: every input writes the id load', async (_, build, kind) => {
    const shape = build();
    shape.runOptimize();
    const stats = shape.statistics();
    expect(kind === 'run' ? stats.runContainers : stats.bitsetContainers).toBeGreaterThanOrEqual(1);
    const byIds = await loadAndRead(shape.toArray());
    for (const input of [
      { bitmap: build() },
      { serialized: build().serialize('portable') },
      { serialized: shape.serialize('portable') },
    ] as LoadInput[]) {
      const other = await loadAndRead(input);
      expect(other.result).toEqual(byIds.result);
      expect(Buffer.from(other.bytes).equals(Buffer.from(byIds.bytes))).toBe(true);
    }
  });
});

describe('store.load serializes a { bitmap } at the call, before anything is awaited', () => {
  it.each<[string, (b: InstanceType<typeof RoaringBitmap32>) => LoadInput]>([
    ['{ bitmap }', (b) => ({ bitmap: b })],
    ['a bare RoaringBitmap32', (b) => b],
  ])('%s changed right after the call is loaded as it was', async (_, as) => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
    const bitmap = new RoaringBitmap32([1, 2, 3]);
    const pending = store.load(SEG, as(bitmap)); // not awaited
    bitmap.add(4);
    bitmap.remove(1);
    expect(await pending).toMatchObject({ published: true, cardinality: 3 });
    const ids: number[] = [];
    for await (const id of store.segment(SEG.segment).iterate()) ids.push(id);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('a bitmap load reports the fingerprint of the object it wrote', () => {
  it.each<[string, LoadInput]>([
    ['{ serialized }', { serialized: fromRanges().serialize('portable') }],
    ['{ bitmap }', { bitmap: fromRanges() }],
  ])('%s', async (_, input) => {
    // A refused load deletes its object only once the footer proves it its own, by this fingerprint.
    const storage = new MemoryStorageDriver();
    const key = { ...SEG, generation: 0 };
    const decoded = prepareLoadInput(input, roaringCodec) as DecodedLoadInput;
    const written = await bulkLoadCrbmGeneration(storage, key, decoded, { codec: roaringCodec });
    const reader = await openGenerationReader(storage, key, undefined);
    expect(written.fingerprint).toBe(reader.fingerprint);
  });

  it('and a refused { serialized } load deletes that object', async () => {
    const backend = new MemoryStorage();
    const store = new CloudRoaring({ storage: backend });
    await store.load(SEG, [1, 2, 3, 4]);
    const refused = await store.load(
      SEG,
      { serialized: new RoaringBitmap32([1]).serialize('portable') },
      { guard: { minCardinality: 2 } },
    );
    expect(refused).toMatchObject({ published: false, reason: 'min-cardinality', generation: 1 });
    const left: number[] = [];
    for await (const k of backend.storage.list(SEG)) left.push(k.generation);
    expect(left).toEqual([0]);
  });
});

describe('an erasure that leaves a tie writes what a load of the erased set writes', () => {
  it('the rewrite of a run chunk down to a tie stores the array, byte for byte as a fresh load', async () => {
    // {0,1,2,3,10,11} is two runs, stored as a run container; erasing 3 leaves {0,1,2,10,11}, five values in two
    // runs: a tie, which the canonical encoding stores as the array a load from ids writes.
    const erased = [0, 1, 2, 10, 11, at(7, 5), at(7, 6), at(7, 7)];
    const a = new MemoryStorage();
    const storeA = new CloudRoaring({ storage: a });
    await storeA.load(SEG, [...erased, 3]);
    const res = await storeA.eraseSubject(3, { allNamespaces: true });
    expect(res.erasedFrom).toHaveLength(1);
    const b = new MemoryStorage();
    const storeB = new CloudRoaring({ storage: b });
    await storeB.load(SEG, [99]);
    await storeB.load(SEG, erased);
    const rowA = await a.registry.get(SEG);
    const rowB = await b.registry.get(SEG);
    expect(rowA?.currentGen).toBe(rowB?.currentGen);
    const g = rowA!.currentGen!;
    const bytesA = (await a.storage.getTail({ ...SEG, generation: g }, 1 << 30)).bytes;
    const bytesB = (await b.storage.getTail({ ...SEG, generation: g }, 1 << 30)).bytes;
    expect(Buffer.from(bytesA).equals(Buffer.from(bytesB))).toBe(true);
  });
});
