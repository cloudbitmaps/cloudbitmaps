import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap } from '@/index';
import { MAX_SERIALIZED_LOAD_BYTES } from '@/core/load-input';
import { TsBitmap } from '@/ts-roaring/bitmap';

/**
 * A decoded bitmap keeps nothing of its input. The codec reads a bitset in place over its private copy of the input, and
 * the arrays and runs of a many-container decode share one slab, so a long-lived bitmap decoded from a large buffer
 * and then reduced to a small filter would hold the whole buffer for a few kilobytes of ids. The public door decodes
 * detached: every container owns its storage, so the copy is garbage when the call returns.
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
function decodeThenDropInput<T>(decode: (bytes: Uint8Array) => T): { kept: T; inputBytes: number } {
  const bytes = bigBytes();
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
