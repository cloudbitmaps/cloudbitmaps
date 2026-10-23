import fc from 'fast-check';
import { loadSegment } from '@/core/load';
import type { IKeystore } from '@/core/crypto';
import type { LoadResult } from '@/core/load';
import type { GenerationMetadata, SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { storeCodec } from '../helpers/store-codec';
import { CounterNonceAead } from '../helpers/crbm-extension';
import { counterEntropy } from '../helpers/entropy';

// Many random cases, and a shrink after a failure, can outrun the default 5 s limit on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Property: a sorted load writes the object an unsorted load of the same ids writes, byte for byte, under the same
 * write identity: the same generation number, metadata, key and entropy. Both drive one writer with the same chunks in
 * the same order, each chunk's payload decided by its members alone (the codec's `optimize()` is canonical), so the
 * sink sees the same writes.
 *
 * The unsorted side gets the same ids shuffled; the sorted side gets them ascending, repeats kept, from a sync or an
 * async source. Encrypted segments too, under a keystore whose AEAD takes a counter nonce, so the seals repeat. The
 * shapes are the ones where a chunk's containers can come out differently: sparse sets over the whole id space, dense
 * chunks either side of the 4,096 array/bitset line, runs, the run/array tie, and chunk keys and values at the
 * boundaries. Compared by the `sha256` of each object and by the whole result, never by the bytes themselves.
 */
const CHUNK = 65_536;
const SEG: SegmentRef = { namespace: 'ns', segment: 'p' };

const sparse = fc.uniqueArray(fc.nat({ max: 2 ** 32 - 1 }), { maxLength: 300 });

const dense = fc
  .record({
    chunk: fc.integer({ min: 0, max: 3 }),
    lows: fc.uniqueArray(fc.integer({ min: 0, max: CHUNK - 1 }), {
      minLength: 4_000,
      maxLength: 4_200,
    }),
  })
  .map(({ chunk, lows }) => lows.map((l) => chunk * CHUNK + l));

const range = (start: number, length: number): number[] =>
  Array.from({ length }, (_, i) => start + i);

const runs = fc
  .array(fc.tuple(fc.nat({ max: 2 ** 32 - 1 - 500 }), fc.integer({ min: 1, max: 400 })), {
    maxLength: 30,
  })
  .map((rs) => rs.flatMap(([start, length]) => range(start, length)));

/** A chunk of `2r + 1` values in `r` runs: run and array encodings the same size. */
const ties = fc
  .array(fc.tuple(fc.integer({ min: 0, max: CHUNK - 1 }), fc.integer({ min: 1, max: 12 })), {
    minLength: 1,
    maxLength: 6,
  })
  .map((chunks) =>
    chunks.flatMap(([chunk, r]) => {
      const out: number[] = [];
      let start = chunk * CHUNK + 3;
      for (let i = 0; i < r; i++) {
        const length = i === r - 1 ? 3 : 2;
        out.push(...range(start, length));
        start += length + 2;
      }
      return out;
    }),
  );

const boundary = fc
  .array(
    fc.record({
      chunk: fc.constantFrom(0, 1, CHUNK - 1),
      cardinality: fc.constantFrom(1, 2, 4_096, 4_097, CHUNK - 1, CHUNK),
      from: fc.constantFrom('bottom', 'top', 'spread'),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((parts) =>
    parts.flatMap(({ chunk, cardinality, from }) => {
      const base = chunk * CHUNK;
      if (from === 'bottom') return range(base, cardinality);
      if (from === 'top') return range(base + CHUNK - cardinality, cardinality);
      const step = Math.max(1, Math.floor(CHUNK / cardinality));
      return Array.from({ length: cardinality }, (_, i) => base + ((i * step) % CHUNK));
    }),
  );

/** A set, with some of its ids repeated, and an order to shuffle it in. */
const anyLoad = fc.record({
  ids: fc.oneof(sparse, dense, runs, ties, boundary),
  repeats: fc.array(fc.nat(), { maxLength: 20 }),
  seed: fc.integer(),
  async: fc.boolean(),
  encrypted: fc.boolean(),
  metadata: fc.option(
    fc.dictionary(
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.oneof(fc.string({ maxLength: 8 }), fc.integer()),
      {
        maxKeys: 3,
      },
    ),
    { nil: undefined },
  ),
});

/** `ids` in an order a seeded generator chooses: a Fisher-Yates shuffle over a linear congruential sequence. */
function shuffled(ids: readonly number[], seed: number): number[] {
  const out = [...ids];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const KEY = new Uint8Array(32).fill(7);

/** A keystore whose data key seals under a counter nonce, so two loads started alike seal alike. */
function counterKeystore(): IKeystore {
  return {
    createDek: async () => ({
      wrapped: [{ keyId: 'k', wrapped: 'test-only' }],
      aead: new CounterNonceAead(KEY),
    }),
    openDek: async () => new CounterNonceAead(KEY),
  };
}

async function load(
  input: Iterable<number> | AsyncIterable<number>,
  options: { sorted: boolean; encrypted: boolean; metadata?: GenerationMetadata },
): Promise<LoadResult> {
  const deps = {
    storage: new MemoryStorageDriver(),
    registry: new MemoryRegistryDriver(),
    entropy: counterEntropy(),
    codec: storeCodec,
    ...(options.encrypted ? { keystore: counterKeystore() } : {}),
  };
  return loadSegment(SEG, input, deps, {
    allowEmpty: true,
    sorted: options.sorted,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });
}

async function* streamOf(ids: readonly number[]): AsyncGenerator<number> {
  for (const id of ids) yield id;
}

describe('a sorted load writes the bytes an unsorted load of the same ids writes', () => {
  it('for every shape, encrypted or not, from a sync or an async source', async () => {
    await fc.assert(
      fc.asyncProperty(anyLoad, async ({ ids, repeats, seed, async, encrypted, metadata }) => {
        const withRepeats = [
          ...ids,
          ...repeats.filter(() => ids.length > 0).map((r) => ids[r % ids.length]!),
        ];
        const ascending = [...withRepeats].sort((a, b) => a - b);
        const unsorted = await load(shuffled(withRepeats, seed), {
          sorted: false,
          encrypted,
          metadata,
        });
        const sorted = await load(async ? streamOf(ascending) : ascending, {
          sorted: true,
          encrypted,
          metadata,
        });
        expect(sorted.sha256).toBe(unsorted.sha256);
        expect(sorted).toEqual(unsorted);
      }),
      { numRuns: 80 },
    );
  });

  it('for an empty set, and for one id at each end of the id space', async () => {
    for (const ids of [[], [0], [2 ** 32 - 1], [0, 2 ** 32 - 1]]) {
      for (const encrypted of [false, true]) {
        const unsorted = await load([...ids].reverse(), { sorted: false, encrypted });
        const sorted = await load(ids, { sorted: true, encrypted });
        expect(sorted.sha256).toBe(unsorted.sha256);
        expect(sorted).toEqual(unsorted);
      }
    }
  });
});
