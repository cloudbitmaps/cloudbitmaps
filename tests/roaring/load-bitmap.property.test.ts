import fc from 'fast-check';
import roaring from 'roaring';
import { CloudRoaring, MemoryStorage } from '@/index';
import type { LoadInput, LoadResult } from '@/index';

/**
 * Property: the same set loaded as ids, as `{ bitmap }`, as `{ serialized }` and as a bare `RoaringBitmap32`
 * writes byte-identical `.crbm` objects and returns equal results.
 *
 * The shapes are the ones where a bitmap's containers can disagree with the ones a load from ids builds: sparse
 * sets over the whole id space, dense chunks either side of the 4,096 array/bitset line, runs, the run/array tie
 * (a chunk of `2 × runs + 1` values, built from ranges so it starts as a run), chunk keys and values at the
 * boundaries, results of `and` / `or` / `andNot` / `xor` over run-optimized operands, and sets that went through
 * a serialize and deserialize.
 */
const { RoaringBitmap32 } = roaring;
type Bitmap = InstanceType<typeof RoaringBitmap32>;
const CHUNK = 65_536;

const sparse = fc
  .uniqueArray(fc.nat({ max: 2 ** 32 - 1 }), { maxLength: 300 })
  .map((ids) => new RoaringBitmap32(ids));

const dense = fc
  .record({
    chunk: fc.integer({ min: 0, max: 3 }),
    lows: fc.uniqueArray(fc.integer({ min: 0, max: CHUNK - 1 }), {
      minLength: 4_000,
      maxLength: 4_200,
    }),
  })
  .map(({ chunk, lows }) => new RoaringBitmap32(lows.map((l) => chunk * CHUNK + l)));

const runs = fc
  .array(fc.tuple(fc.nat({ max: 2 ** 32 - 1 - 500 }), fc.integer({ min: 1, max: 400 })), {
    maxLength: 30,
  })
  .map((rs) => {
    const b = new RoaringBitmap32();
    for (const [start, length] of rs) b.addRange(start, start + length);
    return b;
  });

/** A chunk of `2r + 1` values in `r` runs: run and array encodings the same size. */
const ties = fc
  .array(fc.tuple(fc.integer({ min: 0, max: CHUNK - 1 }), fc.integer({ min: 1, max: 12 })), {
    minLength: 1,
    maxLength: 6,
  })
  .map((chunks) => {
    const b = new RoaringBitmap32();
    for (const [chunk, r] of chunks) {
      let start = chunk * CHUNK + 3;
      // r - 1 runs of 2 and one of 3: 2r + 1 values, each run 2 apart from the next.
      for (let i = 0; i < r; i++) {
        const length = i === r - 1 ? 3 : 2;
        b.addRange(start, start + length);
        start += length + 2;
      }
    }
    return b;
  });

const boundary = fc
  .array(
    fc.record({
      chunk: fc.constantFrom(0, 1, CHUNK - 1),
      cardinality: fc.constantFrom(1, 2, 4_096, 4_097, CHUNK - 1, CHUNK),
      from: fc.constantFrom('bottom', 'top', 'spread'),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((parts) => {
    const b = new RoaringBitmap32();
    for (const { chunk, cardinality, from } of parts) {
      const base = chunk * CHUNK;
      if (from === 'bottom') b.addRange(base, base + cardinality);
      else if (from === 'top') b.addRange(base + CHUNK - cardinality, base + CHUNK);
      else {
        const step = Math.max(1, Math.floor(CHUNK / cardinality));
        const lows = Array.from({ length: cardinality }, (_, i) => (i * step) % CHUNK);
        b.addMany(lows.map((l) => base + l));
      }
    }
    return b;
  });

const leaf = fc.oneof(sparse, dense, runs, ties, boundary);

const op = fc
  .record({
    a: leaf,
    b: leaf,
    how: fc.constantFrom('and', 'or', 'andNot', 'xor'),
  })
  .map(({ a, b, how }) => {
    a.runOptimize();
    b.runOptimize();
    return RoaringBitmap32[how as 'and' | 'or' | 'andNot' | 'xor'](a, b);
  });

const deserialized = fc.oneof(leaf, op).map((b) => {
  b.runOptimize();
  return RoaringBitmap32.deserialize(b.serialize('portable'), 'portable');
});

const anySet: fc.Arbitrary<Bitmap> = fc.oneof(leaf, op, deserialized);

async function load(input: LoadInput): Promise<{ result: LoadResult; bytes: string }> {
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend });
  const ref = { segment: 'p' };
  // `allowEmpty`, so an empty set is written rather than refused: the property is about the bytes.
  const result = await store.load(ref, input, { allowEmpty: true });
  const tail = await backend.storage.getTail({ ...ref, generation: result.generation }, 1 << 30);
  return { result, bytes: Buffer.from(tail.bytes).toString('hex') };
}

describe('a set loaded from any input writes the bytes its ids write', () => {
  it('ids, { bitmap }, { serialized } (as given and run-optimized) and a bare bitmap agree', async () => {
    await fc.assert(
      fc.asyncProperty(anySet, async (bitmap) => {
        const ids = await load(bitmap.toArray());
        expect(ids.result.cardinality).toBe(bitmap.size);
        const asGiven = bitmap.serialize('portable');
        const optimized = bitmap.clone();
        optimized.runOptimize();
        for (const input of [
          { bitmap },
          { serialized: asGiven },
          { serialized: optimized.serialize('portable') },
          bitmap,
        ] as LoadInput[]) {
          const other = await load(input);
          expect(other.result).toEqual(ids.result);
          expect(other.bytes).toBe(ids.bytes);
        }
      }),
      { numRuns: 60 },
    );
  });
});
