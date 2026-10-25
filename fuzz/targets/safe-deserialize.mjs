import { isCloudRoaringError, DEFAULT_MAX_BITMAP_BYTES } from '../build/fuzz-core.js';
import { tsRoaringCodec, assertConsistentDecode, checkPublicDoor } from '../build/fuzz-codec.js';

/*
 * Coverage-guided fuzz target: the TypeScript Roaring codec's safe deserializer, the decoder a store runs when it is
 * built on `tsRoaringCodec` (the store's default). It feeds adversarial bytes straight to `safeDeserialize` (no CRC gate) and asserts the
 * contract: a self-consistent bitmap OR a typed CloudRoaring error (matched by the
 * cross-bundle brand predicate), never an uncaught `RangeError`/`TypeError`, unbounded allocation, a hang, or a decode
 * `assertConsistentDecode` fails: one that iterates out of order, or whose `size` or `has` disagrees with what it
 * iterates.
 *
 * Everything the bytes reach here is instrumented JavaScript: the shared structural check
 * (`portable/layout.ts`) and then this codec's own `decodeContainers` (the slab, the aliasing of a body in place, the
 * run containers), so guidance covers the whole decode and not only which bytes are refused. Each input is decoded
 * twice, with and without `{ whole: true }` (the trailing-bytes refusal), and the two must agree on the set.
 *
 * A second leg feeds each input through the public door, `RoaringBitmap.deserialize`, the same decode behind core's
 * `decodeSerialized` with a detached copy of the storage: it must accept exactly what the codec accepts as one whole
 * bitmap (an empty buffer excepted, which it refuses), what it accepts must be self-consistent and read back through
 * `serialize` then `deserialize` as an equal bitmap, and anything else must be a `ValidationError`.
 *
 * jazzer contract: export `fuzz(data: Buffer)`; an uncaught throw is a finding, and its reproducer is written under
 * fuzz/crashes/.
 */
export function fuzz(data) {
  try {
    checkPublicDoor(data);
    // Walk every value of what was accepted, so a bad-but-accepted decode surfaces. The walk is bounded to avoid a
    // false finding: a run-heavy bitmap is tiny on disk yet can expand to billions of ids.
    const loose = tsRoaringCodec.safeDeserialize(data, DEFAULT_MAX_BITMAP_BYTES);
    assertConsistentDecode(loose);
    let whole;
    try {
      whole = tsRoaringCodec.safeDeserialize(data, DEFAULT_MAX_BITMAP_BYTES, { whole: true });
    } catch (err) {
      if (isCloudRoaringError(err)) return; // trailing bytes refused: the contract
      throw err;
    }
    assertConsistentDecode(whole);
    if (whole.size !== loose.size) {
      throw new Error(`whole decode holds ${whole.size} values, the loose one ${loose.size}`);
    }
  } catch (err) {
    if (isCloudRoaringError(err)) return; // typed rejection is the contract — not a finding
    throw err; // anything else escaped the boundary → a real finding
  }
}
