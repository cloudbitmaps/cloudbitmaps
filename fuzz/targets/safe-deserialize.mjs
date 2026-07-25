import { isCloudRoaringError, DEFAULT_MAX_PAYLOAD_BYTES } from '../build/fuzz-core.js';
import { SafeBitmap } from '../build/fuzz-codec.js';

/*
 * Coverage-guided fuzz target: the NATIVE CRoaring "portable" deserializer — the C/C++ attack surface behind
 * every cold read. CloudRoaring's safety story at the untrusted-bytes boundary is "safe-deserialize + a hard
 * size cap" (invariant 5 / finding S1). This target feeds adversarial bytes straight to `safeDeserialize` (no
 * CRC gate) and asserts the contract: a usable bitmap OR a typed CloudRoaring error (matched by the cross-bundle brand predicate) — never a native crash,
 * an uncaught `RangeError`/`TypeError`, unbounded allocation, or a hang.
 *
 * The deserializer is a thin JS wrapper into native code, so libFuzzer's *coverage* signal is limited here
 * (native C++ isn't instrumentable from Node) — this is high-throughput **black-box** fuzzing of the native
 * boundary, the standard way to fuzz a native addon from JS. The `crbm-index` target is where JS-level
 * coverage guidance does its work.
 *
 * jazzer contract: export `fuzz(data: Buffer)`; an uncaught throw (or a native abort libFuzzer traps) is a
 * finding, and its reproducer is written under fuzz/crashes/.
 */
export function fuzz(data) {
  try {
    const bm = SafeBitmap.safeDeserialize(data, DEFAULT_MAX_PAYLOAD_BYTES);
    // Force materialization so a bad-but-accepted decode surfaces (`has(0)` would short-circuit and validate
    // almost nothing). `size` is a bounded sum over the decoded containers; `toArray()` walks every value but
    // is bounded here to avoid a *false* finding — a run-container-heavy bitmap is tiny on disk yet can expand
    // to billions of ids, so an unguarded toArray could OOM (trip rss_limit) or throw RangeError on a valid input.
    if (bm.size <= 1_000_000) bm.toArray();
  } catch (err) {
    if (isCloudRoaringError(err)) return; // typed rejection is the contract — not a finding
    throw err; // anything else escaped the boundary → a real finding
  }
}
