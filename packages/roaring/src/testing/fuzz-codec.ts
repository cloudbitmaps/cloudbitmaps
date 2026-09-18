/**
 * Internal surface for the coverage-guided fuzz harness, CODEC half.
 *
 * Only the concrete bitmap codec lives here — the core half (`CrbmReader`, the non-public `parseIndex`,
 * `BufferReader`, `CloudRoaringError`, `DEFAULT_MAX_PAYLOAD_BYTES`) is built from `@cloudbitmaps/core`'s own
 * `src/testing/fuzz-core.ts` to `fuzz/build/fuzz-core.js`. Splitting it this way keeps the published entries
 * of both packages free of test-only exports: neither widened its public API to feed the fuzzer.
 */
export { SafeBitmap } from '../roaring-codec';
