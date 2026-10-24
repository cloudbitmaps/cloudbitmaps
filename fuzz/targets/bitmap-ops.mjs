import { isCloudRoaringError } from '../build/fuzz-core.js';
import { runBitmapOps } from '../build/fuzz-codec.js';

/*
 * Coverage-guided fuzz target: the public bitmap class's operations on bitmaps that came out of a decode. An input is
 * `[u16 n][n bytes of a portable bitmap][operation bytes...]`: the bitmap bytes go through `RoaringBitmap.deserialize`
 * (what it accepts is the starting set, what it refuses starts an empty one), and each operation byte then picks a
 * public method and its arguments, so guidance reaches the kernels through the shapes only a decode produces: run
 * containers, a slab of small containers, a bitset read in place. Every answer is held to a plain `Set`, a refused
 * call must leave the bitmap as it was, and a clone and its original must change apart (see
 * `packages/roaring/src/testing/fuzz-bitmap-ops.ts`).
 *
 * A typed CloudRoaring error that escapes is not a finding (the contract for bytes the door refuses); anything else
 * that escapes, a wrong answer included, is. The reproducer of a finding is written under fuzz/crashes/ and, once
 * minimized and fixed, committed to tests/core/crbm/fuzz-corpus/bitmap-ops/, which the normal suite replays.
 *
 * jazzer contract: export `fuzz(data: Buffer)`; an uncaught throw is a finding.
 */
export function fuzz(data) {
  try {
    runBitmapOps(data);
  } catch (err) {
    if (isCloudRoaringError(err)) return;
    throw err;
  }
}
