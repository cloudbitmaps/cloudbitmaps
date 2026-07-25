/**
 * Internal surface for the coverage-guided fuzz harness (test-strategy T3), CORE half.
 *
 * Exposes the untrusted-bytes entry points the fuzz targets drive — including `parseIndex`, which is
 * deliberately **NOT public API**. Built by a dedicated `tsup` entry to the git-ignored repo-root `fuzz/build/`,
 * so it never enters `dist/` or the published package. Keeping it here (rather than widening
 * `packages/core/src/index.ts`) is the point: a test harness must not expand the published surface.
 * The codec half lives in the flavor package (`packages/roaring/src/testing/fuzz-codec.ts`), because a concrete
 * bitmap codec is exactly what core does not have.
 */
export { CrbmReader, parseIndex } from '../core/crbm/reader';
export { BufferReader } from '../core/blob';
// Export the BRAND PREDICATE, not just the class: the harness is two bundles (core internals here, the codec in
// the flavor's `fuzz-codec.js`), so each has its own copy of the error classes and `instanceof` across them is
// false — the cross-bundle identity trap of DECISIONS #52. `isCloudRoaringError` matches a `Symbol.for` brand and
// is therefore copy-independent; fuzz targets MUST use it to classify a typed rejection.
export { CloudRoaringError, isCloudRoaringError } from '../core/errors';
export { DEFAULT_MAX_PAYLOAD_BYTES } from '../core/crbm/format';
