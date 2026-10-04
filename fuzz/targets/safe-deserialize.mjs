import { isCloudRoaringError, DEFAULT_MAX_BITMAP_BYTES } from '../build/fuzz-core.js';
import { SafeBitmap, assertConsistentDecode } from '../build/fuzz-codec.js';

/*
 * Coverage-guided fuzz target: the NATIVE CRoaring "portable" deserializer — the C/C++ attack surface behind
 * every storage read. CloudRoaring's safety story at the untrusted-bytes boundary is "safe-deserialize + a hard
 * size cap" (hard invariant 5). This target feeds adversarial bytes straight to `safeDeserialize` (no
 * CRC gate) and asserts the contract: a self-consistent bitmap OR a typed CloudRoaring error (matched by the
 * cross-bundle brand predicate) — never a native crash, an uncaught `RangeError`/`TypeError`, unbounded allocation,
 * a hang, or a decode `assertConsistentDecode` fails: one that iterates out of order, or whose `size` or `has`
 * disagrees with what it iterates.
 *
 * Coverage guidance reaches the structural check `safeDeserialize` runs first, which is JS inside the instrumented
 * `fuzz/build` bundle, and stops at the native decoder behind it (native C++ isn't instrumentable from Node). So
 * this is coverage-guided fuzzing of which bytes are refused, and high-throughput **black-box** fuzzing of what the
 * native boundary does with the bytes that are not.
 *
 * jazzer contract: export `fuzz(data: Buffer)`; an uncaught throw (or a native abort libFuzzer traps) is a
 * finding, and its reproducer is written under fuzz/crashes/.
 */
export function fuzz(data) {
  try {
    // Walk every value of what was accepted, so a bad-but-accepted decode surfaces (`has(0)` would short-circuit
    // and check almost nothing). The walk is bounded to avoid a *false* finding: a run-container-heavy bitmap is
    // tiny on disk yet can expand to billions of ids.
    assertConsistentDecode(SafeBitmap.safeDeserialize(data, DEFAULT_MAX_BITMAP_BYTES));
  } catch (err) {
    if (isCloudRoaringError(err)) return; // typed rejection is the contract — not a finding
    throw err; // anything else escaped the boundary → a real finding
  }
}
