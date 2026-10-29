import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap } from '@/index';
import { MAX_SERIALIZED_LOAD_BYTES } from '@/core/load-input';
import { TsBitmap } from '@/ts-roaring/bitmap';
import { DETACHED_SLAB_BYTES } from '@/ts-roaring/wire';

/**
 * A decoded bitmap keeps nothing of its input. The codec reads a bitset in place over its private copy of the input, and
 * the arrays and runs of a many-container decode share one slab, so a long-lived bitmap decoded from a large buffer
 * and then reduced to a small filter would hold the whole buffer for a few kilobytes of ids. The public door decodes
 * detached: a bitset owns its array and arrays and runs sit on slabs of at most 64 KB, so the copy is garbage when the
 * call returns and a surviving container keeps at most one slab.
 */
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** External memory (typed-array backing stores) after a full collection, in bytes. */
function externalBytes(): number {
  for (let i = 0; i < 4; i++) gc();
  return process.memoryUsage().arrayBuffers;
}

const CONTAINERS = 1_500;
const PER_CONTAINER = 6_000; // above 4,096: every container is a bitset of 8,192 bytes
const MB = 1024 * 1024;

/** The ids of one container, all of them: the filter that keeps that bitset whole while every other container goes. */
const KEEP = Array.from({ length: PER_CONTAINER }, (_, i) => 5 * 65_536 + i * 7);

/** Portable bytes of a bitmap of `CONTAINERS` bitsets, about 12 MB, and the id kept by the filter that follows. */
function bigBytes(): Uint8Array {
  const ids = new Uint32Array(CONTAINERS * PER_CONTAINER);
  for (let k = 0; k < CONTAINERS; k++) {
    for (let i = 0; i < PER_CONTAINER; i++) ids[k * PER_CONTAINER + i] = k * 65_536 + i * 7;
  }
  return new RoaringBitmap(ids).serialize();
}

/** Builds the input, decodes it, and returns the bitmap: the input is unreachable from the caller's frame. */
function decodeThenDropInput<T>(
  decode: (bytes: Uint8Array) => T,
  make: () => Uint8Array = bigBytes,
): { kept: T; inputBytes: number } {
  const bytes = make();
  return { kept: decode(bytes), inputBytes: bytes.byteLength };
}

describe('a decoded bitmap does not pin its input', () => {
  it('the public door: reduced to one container, it holds the kilobytes of that container, not the buffer', () => {
    const base = externalBytes();
    const { kept, inputBytes } = decodeThenDropInput((bytes) => RoaringBitmap.deserialize(bytes));
    expect(inputBytes).toBeGreaterThan(10 * MB);
    kept.andInPlace(new RoaringBitmap(KEEP));
    expect(kept.size).toBe(PER_CONTAINER);
    const retained = externalBytes() - base;
    expect(retained, `retained ${retained} bytes of a ${inputBytes}-byte input`).toBeLessThan(MB);
  });

  it('the store’s decode, which aliases, does pin it (the control: the same measurement sees what it must)', () => {
    const base = externalBytes();
    const { kept, inputBytes } = decodeThenDropInput((bytes) =>
      TsBitmap.safeDeserialize(bytes, MAX_SERIALIZED_LOAD_BYTES, { whole: true }),
    );
    kept.andInPlace(TsBitmap.fromValues(KEEP));
    expect(kept.size).toBe(PER_CONTAINER);
    const retained = externalBytes() - base;
    expect(
      retained,
      'an aliasing decode keeps its private copy while a bitset of it is held',
    ).toBeGreaterThan(inputBytes / 2);
  });
});

/**
 * Many small containers, which the codec's own decode would keep on one shared slab: 20,000 arrays of 200 scattered
 * ids, and 20,000 containers of 30 short runs that `runOptimize` turns into run containers. A bitmap reduced by AND
 * rebuilds these containers and could not show a slab, so the reduction here removes every other container, which
 * leaves the survivor as it was decoded.
 */
const SMALL = 20_000;
const SURVIVOR = 7_777;

/** The ids of both lists, ascending, in one typed array (a spread of millions of ids would overflow the stack). */
function merged(a: number[], b: number[]): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out.sort();
}

const shapes: ReadonlyArray<[string, (key: number, out: number[]) => void, boolean]> = [
  [
    'array',
    (key, out) => {
      for (let i = 0; i < 200; i++) out.push(key * 65_536 + i * 11);
    },
    false,
  ],
  [
    'run',
    (key, out) => {
      for (let r = 0; r < 30; r++) for (let i = 0; i < 8; i++) out.push(key * 65_536 + r * 20 + i);
    },
    true,
  ],
];

describe('a decoded bitmap of many small containers does not pin its input either', () => {
  it.each(shapes)(
    'the public door, %s containers: reduced by removing the others, it holds its own container',
    (_name, fill, optimize) => {
      const ids: number[] = [];
      const others: number[] = [];
      for (let key = 0; key < SMALL; key++) fill(key, key === SURVIVOR ? ids : others);
      const all = new RoaringBitmap(merged(ids, others));
      if (optimize) all.runOptimize();
      const gone = new RoaringBitmap(others);

      for (const reduce of [
        (b: RoaringBitmap) => b.andNotInPlace(gone),
        (b: RoaringBitmap) => b.removeMany(gone),
        (b: RoaringBitmap) => b.removeMany(others),
      ]) {
        const base = externalBytes();
        const { kept, inputBytes } = decodeThenDropInput(
          (bytes) => RoaringBitmap.deserialize(bytes),
          () => all.serialize(),
        );
        expect(inputBytes).toBeGreaterThan(2 * MB);
        reduce(kept);
        expect(kept.size).toBe(ids.length);
        const retained = externalBytes() - base;
        expect(retained, `retained ${retained} bytes of a ${inputBytes}-byte input`).toBeLessThan(
          MB / 2,
        );
      }
    },
  );

  it.each(shapes)(
    'the public door, %s containers: the survivor keeps its slab, at the 64 KB bound and not the bitmap',
    (_name, fill, optimize) => {
      const ids: number[] = [];
      const others: number[] = [];
      for (let key = 0; key < SMALL; key++) fill(key, key === SURVIVOR ? ids : others);
      const all = new RoaringBitmap(merged(ids, others));
      if (optimize) all.runOptimize();
      const base = externalBytes();
      const { kept, inputBytes } = decodeThenDropInput(
        (bytes) => RoaringBitmap.deserialize(bytes),
        () => all.serialize(),
      );
      kept.removeMany(others);
      expect(kept.size).toBe(ids.length);
      const retained = externalBytes() - base;
      // One slab at most stays, the bound plus slack for the small objects around it; the input is more than thirty
      // slabs. The slab's size itself is pinned in detached-slab.test.ts.
      expect(retained, `retained ${retained} bytes`).toBeLessThanOrEqual(
        DETACHED_SLAB_BYTES + 16 * 1024,
      );
      expect(inputBytes).toBeGreaterThan(30 * DETACHED_SLAB_BYTES);
    },
  );

  it.each(shapes)(
    'the store’s decode, %s containers, which shares a slab, does pin it (the control)',
    (_name, fill, optimize) => {
      const ids: number[] = [];
      const others: number[] = [];
      for (let key = 0; key < SMALL; key++) fill(key, key === SURVIVOR ? ids : others);
      const all = new RoaringBitmap(merged(ids, others));
      if (optimize) all.runOptimize();
      const base = externalBytes();
      const { kept, inputBytes } = decodeThenDropInput(
        (bytes) => TsBitmap.safeDeserialize(bytes, MAX_SERIALIZED_LOAD_BYTES, { whole: true }),
        () => all.serialize(),
      );
      kept.andNotInPlace(TsBitmap.fromValues(new Uint32Array(others).sort()));
      const retained = externalBytes() - base;
      expect(
        retained,
        'a shared slab stays whole while one container of it is held',
      ).toBeGreaterThan(inputBytes / 2);
    },
  );
});
