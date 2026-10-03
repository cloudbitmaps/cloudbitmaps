/**
 * Internal surface for the coverage-guided fuzz harness, CORE half.
 *
 * Exposes the untrusted-bytes entry points the fuzz targets drive — including `parseIndex` and `parseExtension`,
 * which are deliberately **NOT public API**. Bundled by its own esbuild entry in `scripts/build.mjs` to the git-ignored repo-root `fuzz/build/`,
 * so it never enters `dist/` or the published package. Keeping it here (rather than widening
 * `packages/core/src/index.ts`) is the point: a test harness must not expand the published surface.
 * The codec half lives in the flavor package (`packages/roaring/src/testing/fuzz-codec.ts`), because a concrete
 * bitmap codec is exactly what core does not have.
 */
export { CrbmReader, parseExtension, parseIndex } from '../core/crbm/reader';
// The writer, for the seed corpus's objects with an extension block: a generation with metadata.
export { CrbmWriter } from '../core/crbm/writer';
export { BufferReader, BufferSink } from '../core/blob';
// Export the BRAND PREDICATE, not just the class. The harness is two bundles and they do NOT agree on the
// class object: this one is built from core's own source, so it INLINES the error classes, while the flavor's
// `fuzz-codec.js` imports them from `@cloudbitmaps/core` as an external. So `instanceof` across the two is
// false even though it holds for an ordinary consumer of the published packages — this harness is exactly the
// bundling shape the predicates exist for. `isCloudRoaringError` matches a `Symbol.for` brand and is
// therefore copy-independent; fuzz targets MUST use it to classify a typed rejection.
export { CloudRoaringError, IntegrityError, isCloudRoaringError } from '../core/errors';
export { DEFAULT_MAX_PAYLOAD_BYTES } from '../core/crbm/format';
