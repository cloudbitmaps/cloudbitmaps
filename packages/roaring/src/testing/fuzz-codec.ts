/**
 * Internal surface for the coverage-guided fuzz harness, CODEC half.
 *
 * The concrete bitmap codec, and the one property the harness holds every decode it accepts to. The core half
 * (`CrbmReader`, the non-public `parseIndex`, `BufferReader`, `CloudRoaringError`, `DEFAULT_MAX_PAYLOAD_BYTES`) is
 * built from `@cloudbitmaps/core`'s own `src/testing/fuzz-core.ts` to `fuzz/build/fuzz-core.js`. Splitting it this
 * way keeps the published entries of both packages free of test-only exports: neither widened its public API to
 * feed the fuzzer.
 */
import { SafeBitmap } from '../roaring-codec';

export { SafeBitmap };

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
export function assertConsistentDecode(bm: SafeBitmap): void {
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
