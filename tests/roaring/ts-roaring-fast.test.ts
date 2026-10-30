import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { bulkLoadCrbmGeneration } from '@/core/bulk-load';
import { prepareLoadInput } from '@/core/load-input';
import type { DecodedLoadInput } from '@/core/load-input';
import { MemoryStorageDriver } from '@/drivers/memory';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import { testEntropy } from '../helpers/entropy';
import { prng } from '../helpers/roaring-oracle';

/**
 * The TypeScript codec's fast paths, held to a plain `Set`: every pair of container kinds through every in-place
 * combine, ids added and removed in bulk across many keys, a decoded bitmap whose small containers share storage, an
 * iterator that is a class, and `encodeChunks` serializing lazily from a snapshot, through the bulk-load path.
 */
const serializeCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/ts-roaring/wire', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/ts-roaring/wire')>();
  return {
    ...original,
    serializeContainers: (...args: Parameters<typeof original.serializeContainers>) => {
      serializeCalls.count++;
      return original.serializeContainers(...args);
    },
  };
});

const CAP = 1 << 26;
type Shape = 'sparse' | 'dense' | 'run' | 'tiny';

/** Ascending distinct remainders of one chunk, of the shape. */
function lows(shape: Shape, seed: number): number[] {
  const next = prng(seed);
  const out = new Set<number>();
  if (shape === 'run') {
    let at = Math.floor(next() * 500);
    for (let r = 0; r < 1 + Math.floor(next() * 200) && at < 65_536; r++) {
      const len = 1 + Math.floor(next() * (next() < 0.2 ? 3_000 : 200));
      for (let i = 0; i < len && at + i < 65_536; i++) out.add(at + i);
      at += len + 1 + Math.floor(next() * 300);
    }
  } else {
    const count =
      shape === 'sparse'
        ? 1 + Math.floor(next() * 3_000)
        : shape === 'tiny'
          ? 1 + Math.floor(next() * 40)
          : 4_200 + Math.floor(next() * 50_000);
    while (out.size < count) out.add(Math.floor(next() * 65_536));
  }
  return [...out].sort((a, b) => a - b);
}

/** The ids as a bitmap whose containers are as the shape says: a run shape is decoded from run bytes, so it stays runs. */
function build(ids: number[], asRuns: boolean): CodecBitmap {
  const made = tsRoaringCodec.fromValues(ids);
  if (!asRuns) return made;
  made.optimize?.();
  return tsRoaringCodec.safeDeserialize(made.serialize(), CAP);
}

const SHAPES: Shape[] = ['sparse', 'dense', 'run', 'tiny'];

describe('every pair of container kinds, through every in-place combine, equals the set algebra', () => {
  // Budget 6 s (the default is 5 s): the slowest measured time was 2.0 s, on a Node 24 CI runner. Rule: that time times
  // three, rounded up to the next whole second.
  it(
    'and, or and andNot of one chunk against another, which is left alone',
    { timeout: 6000 },
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...SHAPES),
          fc.constantFrom(...SHAPES),
          fc.integer({ min: 1, max: 2 ** 30 }),
          (sa, sb, seed) => {
            const a = lows(sa, seed);
            const b = lows(sb, seed + 7);
            const inB = new Set(b);
            const inA = new Set(a);
            const want = {
              andInPlace: a.filter((v) => inB.has(v)),
              orInPlace: [...new Set([...a, ...b])].sort((x, y) => x - y),
              andNotInPlace: a.filter((v) => !inB.has(v)),
            } as const;
            for (const op of ['andInPlace', 'orInPlace', 'andNotInPlace'] as const) {
              const x = build(a, sa === 'run');
              const y = build(b, sb === 'run');
              x[op](y);
              expect([...x], `${op} ${sa}/${sb}`).toEqual(want[op]);
              expect(x.size).toBe(want[op].length);
              expect([...y], `${op} ${sa}/${sb}: operand`).toEqual(b);
              expect(inA.size).toBe(a.length);
            }
          },
        ),
        { numRuns: 60 },
      );
    },
  );

  it('a skewed pair (a few values against thousands) gallops to the same answer', () => {
    const big = lows('sparse', 5).concat(Array.from({ length: 900 }, (_, i) => 60_000 + i));
    const bigIds = [...new Set(big)].sort((p, q) => p - q);
    const small = [bigIds[3] as number, bigIds[400] as number, 7, 64_999].sort((p, q) => p - q);
    const x = build(small, false);
    x.andInPlace(build(bigIds, false));
    expect([...x]).toEqual(small.filter((v) => bigIds.includes(v)));
    const y = build(small, false);
    y.andNotInPlace(build(bigIds, false));
    expect([...y]).toEqual(small.filter((v) => !bigIds.includes(v)));
  });
});

describe('ids added and removed in bulk across many keys', () => {
  it('addMany of unsorted ids, with duplicates, into keys held and keys new, then removeMany, match a Set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 ** 32 - 1 }), { maxLength: 400 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 200 }),
        fc.array(fc.integer({ min: 0, max: 2 ** 32 - 1 }), { maxLength: 400 }),
        (first, keys, second) => {
          const dense = keys.flatMap((k, i) => [k * 65_536 + ((i * 37) % 65_536), k * 65_536 + 5]);
          const bitmap = tsRoaringCodec.fromValues(first);
          const model = new Set(first);
          bitmap.addMany(dense);
          for (const v of dense) model.add(v);
          bitmap.addMany(Uint32Array.from(second).sort());
          for (const v of second) model.add(v);
          expect(bitmap.size).toBe(model.size);
          expect([...bitmap]).toEqual([...model].sort((x, y) => x - y));
          const gone = [...first.slice(0, 50), ...dense.slice(0, 80), 2 ** 32 - 1, -1, 1.5];
          bitmap.removeMany(gone);
          for (const v of gone) model.delete(v);
          expect(bitmap.size).toBe(model.size);
          expect([...bitmap]).toEqual([...model].sort((x, y) => x - y));
          for (const v of model) expect(bitmap.has(v)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('takes a typed array without changing it, even when it is out of order', () => {
    const given = Uint32Array.of(70_000, 5, 5, 3);
    const bitmap = tsRoaringCodec.empty();
    bitmap.addMany(given);
    expect([...given]).toEqual([70_000, 5, 5, 3]);
    expect([...bitmap]).toEqual([3, 5, 70_000]);
  });
});

describe('a decoded bitmap keeps its containers apart', () => {
  it('changing one of several small containers leaves the others, and the bytes it came from, alone', () => {
    const source = tsRoaringCodec.empty();
    for (const key of [0, 1, 2, 3, 4]) {
      source.addMany(Array.from({ length: 300 }, (_, i) => key * 65_536 + 7 * i));
    }
    source.addMany(Array.from({ length: 5_000 }, (_, i) => 6 * 65_536 + 3 * i));
    source.addMany(Array.from({ length: 1_000 }, (_, i) => 7 * 65_536 + 20_000 + i));
    source.optimize?.();
    const bytes = source.serialize();
    const kept = bytes.slice();
    const decoded = tsRoaringCodec.safeDeserialize(bytes, CAP);
    decoded.add(1 * 65_536 + 1);
    decoded.remove(2 * 65_536);
    decoded.add(6 * 65_536 + 1);
    const expected = new Set(source);
    expected.add(1 * 65_536 + 1);
    expected.delete(2 * 65_536);
    expected.add(6 * 65_536 + 1);
    expect([...decoded]).toEqual([...expected].sort((a, b) => a - b));
    expect(bytes).toEqual(kept);
    expect([...tsRoaringCodec.safeDeserialize(bytes, CAP)]).toEqual([...source]);
  });
});

describe('iteration', () => {
  it('is a class with its own state, not a generator, and independent iterators do not disturb one another', () => {
    const bitmap = tsRoaringCodec.fromValues([1, 2, 70_000, 70_001, 200_000]);
    const one = bitmap[Symbol.iterator]();
    expect(Object.prototype.toString.call(one)).not.toBe('[object Generator]');
    const two = bitmap[Symbol.iterator]();
    expect(one.next()).toEqual({ done: false, value: 1 });
    expect(two.next()).toEqual({ done: false, value: 1 });
    expect([...one]).toEqual([2, 70_000, 70_001, 200_000]);
    expect(one.next()).toEqual({ done: true, value: undefined });
    expect([...two]).toEqual([2, 70_000, 70_001, 200_000]);
  });

  it('walks array, bitset and run containers to the ids toUint32Array gives', () => {
    for (const shape of SHAPES) {
      const ids = lows(shape, 11).map((v) => 3 * 65_536 + v);
      for (const asRuns of [false, true]) {
        const bitmap = build(ids, asRuns);
        expect([...bitmap], `${shape} ${asRuns}`).toEqual(ids);
        expect([...(bitmap.toUint32Array?.() ?? [])]).toEqual(ids);
      }
    }
  });
});

describe('encodeChunks cuts lazily from a snapshot', () => {
  it('serializes nothing until a chunk is asked for, and a change made meanwhile does not reach the chunks', () => {
    const ids = [
      ...Array.from({ length: 5_000 }, (_, i) => 2 * i),
      ...Array.from({ length: 300 }, (_, i) => 65_536 + 3 * i),
      ...Array.from({ length: 2_000 }, (_, i) => 3 * 65_536 + 100 + i),
    ];
    const bitmap = tsRoaringCodec.fromValues(ids);
    const before = serializeCalls.count;
    const chunks = bitmap.encodeChunks!();
    expect(serializeCalls.count).toBe(before);
    const iterator = chunks[Symbol.iterator]();
    const first = iterator.next().value;
    expect(serializeCalls.count).toBe(before + 1);
    bitmap.add(1);
    bitmap.remove(0);
    bitmap.add(65_536 + 1);
    bitmap.remove(3 * 65_536 + 100);
    bitmap.addMany([9 * 65_536]);
    bitmap.removeMany([2, 4, 6]);
    const rest = [
      ...(function* () {
        for (let r = iterator.next(); r.done !== true; r = iterator.next()) yield r.value;
      })(),
    ];
    const all = [first, ...rest];
    const reference = tsRoaringCodec.fromValues(ids);
    const want = [...reference.encodeChunks!()];
    expect(all.map((c) => c.chunkKey)).toEqual(want.map((c) => c.chunkKey));
    all.forEach((c, i) => {
      expect(c.payload).toEqual((want[i] as { payload: Uint8Array }).payload);
      expect(c.cardinality).toBe((want[i] as { cardinality: number }).cardinality);
    });
  });

  it('lets the periodic yield of a bulk load split the cut again, with the bitmap changed at each yield', async () => {
    const chunkCount = 3_000;
    const ids = Array.from({ length: chunkCount }, (_, k) => k * 65_536 + 9);
    const bitmap = tsRoaringCodec.fromValues(ids);
    const decoded = prepareLoadInput({ bitmap }, tsRoaringCodec) as DecodedLoadInput;
    const seen: number[] = [];
    const base = serializeCalls.count;
    const clock = {
      now: () => 0,
      sleep: async (): Promise<void> => {},
      yieldNow: async (): Promise<void> => {
        seen.push(serializeCalls.count - base);
        bitmap.add(5_000 * 65_536 + seen.length);
        await Promise.resolve();
      },
    };
    const storage = new MemoryStorageDriver();
    const written = await bulkLoadCrbmGeneration(
      storage,
      { segment: 'seg', namespace: 'ns', generation: 0 } as never,
      decoded,
      { codec: tsRoaringCodec, entropy: testEntropy, clock },
    );
    expect(written.cardinality).toBe(chunkCount);
    expect(written.chunkCount).toBe(chunkCount);
    // Yields come from inside the cut, with some chunks serialized and some not: more than the two whole-bitmap pauses,
    // and at least one with the cut part-way through.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.some((n) => n > 0 && n < chunkCount)).toBe(true);
  });
});
