import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import roaring from 'roaring';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { CloudRoaringOptions, LoadInput, LoadResult, PortableBitmap } from '@/index';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { aadFor } from '@/core/crypto';
import { InProcessKeystore } from '@/drivers/crypto';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';

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
