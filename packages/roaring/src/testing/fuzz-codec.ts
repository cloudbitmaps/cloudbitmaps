/**
 * Internal surface for the coverage-guided fuzz harness, CODEC half.
 *
 * The store's bitmap decoder (the TypeScript codec's), and the one property the harness holds every decode it accepts to. The core half
 * (`CrbmReader`, the non-public `parseIndex`, `BufferReader`, `CloudRoaringError`, `DEFAULT_MAX_PAYLOAD_BYTES`, `DEFAULT_MAX_BITMAP_BYTES`) is
 * built from `@cloudbitmaps/core`'s own `src/testing/fuzz-core.ts` to `fuzz/build/fuzz-core.js`. Splitting it this
 * way keeps the published entries of both packages free of test-only exports: neither widened its public API to
 * feed the fuzzer.
 */
import { IntegrityError, MAX_SERIALIZED_LOAD_BYTES, ValidationError } from '@cloudbitmaps/core';
import { RoaringBitmap } from '../bitmap';
import { tsRoaringCodec } from '../ts-roaring/bitmap';

/** The public class, whose one decode door the harness feeds the same bytes as the store's decoder. */
export { RoaringBitmap };

/** The byte-driven operation sequence of the `bitmap-ops` target. */
export { runBitmapOps } from './fuzz-bitmap-ops';

/** What {@link assertConsistentDecode} reads of a bitmap: the codec's bitmap and the public class both have it. */
interface Decoded extends Iterable<number> {
  readonly size: number;
  has(value: number): boolean;
}

/** The store's decoder: its `safeDeserialize` is a size cap, the structural check, then the decode, and a typed error for anything else. */
export { tsRoaringCodec };

/**
 * What an accepted decode must be: it iterates strictly ascending, `size` is the number of values it iterates, and
 * `has` confirms what it iterates. Throws a plain `Error` otherwise, which the fuzz targets and the corpus replay
 * report as a finding.
 *
 * Memory safety alone does not see a structurally broken bitmap. Bytes with containers or values out of order, or
 * a cardinality that disagrees with the bits, decode into memory that behaves until an operation trusts one of the
 * broken invariants, so a contract of "no crash" passes them. This fails them. It is bounded like the
 * materialization it replaces, because a valid run-heavy bitmap is tiny on disk and can hold billions of ids, and it
 * asks `has` of the first 4,096 values only, which is enough to reach every container a small input can hold.
 */
export function assertConsistentDecode(bm: Decoded): void {
  if (bm.size > 1_000_000) return;
  let previous = -1;
  let seen = 0;
  for (const value of bm) {
    if (value <= previous) throw new Error(`decode iterates ${value} after ${previous}`);
    if (++seen > bm.size) throw new Error(`decode iterates more values than its size, ${bm.size}`);
    if (seen <= 4_096 && !bm.has(value))
      throw new Error(`decode iterates ${value}, has() denies it`);
    previous = value;
  }
  if (seen !== bm.size) throw new Error(`decode's size is ${bm.size}, it iterates ${seen} values`);
}

/**
 * The public door's side of the decode contract, for the `safe-deserialize` target and the reproducer replay: bytes go
 * through `RoaringBitmap.deserialize`, which is the same decode behind core's `decodeSerialized`. It accepts exactly
 * what the codec accepts as one whole bitmap, except the empty buffer; what it accepts is self-consistent and reads
 * back, through `serialize` and `deserialize`, as an equal bitmap; and everything else it refuses with a
 * `ValidationError`, never another error.
 */
export function checkPublicDoor(data: Uint8Array): void {
  let codecAccepts = data.byteLength > 0;
  let codecSize = 0;
  try {
    codecSize = tsRoaringCodec.safeDeserialize(data, DOOR_CAP, { whole: true }).size;
  } catch (err) {
    if (!(err instanceof IntegrityError)) throw err;
    codecAccepts = false;
  }
  let door: RoaringBitmap;
  try {
    door = RoaringBitmap.deserialize(data);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    if (codecAccepts)
      throw new Error('the public door refused bytes the codec accepts as one bitmap', {
        cause: err,
      });
    return;
  }
  if (!codecAccepts)
    throw new Error('the public door accepted bytes the codec refuses, or an empty buffer');
  // Past the first decode every throw is a finding: a typed error here (a refused round trip, say) must not be
  // mistaken, by a caller that tolerates the door's refusals, for the door refusing bad bytes.
  try {
    assertConsistentDecode(door);
    if (door.size !== codecSize)
      throw new Error(`the door holds ${door.size} values, the codec ${codecSize}`);
    const back = RoaringBitmap.deserialize(door.serialize());
    if (back.size !== door.size) throw new Error('serialize then deserialize changes the size');
    if (door.size > 1_000_000) return;
    assertConsistentDecode(back);
    const a = door.toUint32Array();
    const b = back.toUint32Array();
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`serialize then deserialize changes value ${i}`);
    }
    if (door.minimum() !== a[0] || door.maximum() !== a.at(-1)) {
      throw new Error('minimum or maximum disagrees with the values');
    }
  } catch (err) {
    throw new Error(`the public door's result misbehaved: ${String(err)}`, { cause: err });
  }
}

/** The decode cap the targets run under: the one every decode has. */
const DOOR_CAP = MAX_SERIALIZED_LOAD_BYTES;
