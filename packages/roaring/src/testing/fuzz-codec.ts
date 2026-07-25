/**
 * Internal surface for the coverage-guided fuzz harness (test-strategy T3), CODEC half.
 *
 * Only the concrete bitmap codec lives here — the core half (`CrbmReader`, the non-public `parseIndex`,
 * `BufferReader`, `CloudRoaringError`, `DEFAULT_MAX_PAYLOAD_BYTES`) is built from `@cloudbitmaps/core`'s own
 * `src/testing/fuzz-core.ts` to `fuzz/build/fuzz-core.js`. Splitting it this way keeps BOTH published barrels
 * free of test-only exports: neither package widened its public API to feed the fuzzer.
 */
export { SafeBitmap } from '../roaring-codec';
