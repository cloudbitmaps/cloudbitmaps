/*
 * The range bench/sizing.cjs publishes for the heap a filled resolution cache's entries take, as a multiple of the
 * bytes the cache counts for them, read from what bench/resolution-heap.cjs recorded. No gate runs that harness, so
 * this reader is what keeps a malformed results file out of the guide: it refuses any file it cannot read a Node
 * version and a positive, finite multiple for every shape from, rather than render a range from what is left.
 */
'use strict';

const FILE = 'bench/resolution-heap-results.json';

/**
 * The Node major version that measured, and the lowest and highest multiple across the shapes, each to one decimal:
 * `{ node: '24', low: '1.2', high: '1.5' }`. Throws, naming the file, on anything else.
 */
function heapRange(results) {
  const node = /^v(\d+)\./.exec(typeof results?.node === 'string' ? results.node : '')?.[1];
  if (node === undefined) throw new Error(`sizing: ${FILE} names no Node version it can read`);
  const shapes = results.shapes;
  if (!Array.isArray(shapes) || shapes.length === 0) {
    throw new Error(`sizing: ${FILE} records no row shape`);
  }
  const multiples = shapes.map((s, i) => {
    const m = s?.heapPerCounted;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
      throw new Error(
        `sizing: ${FILE} shape ${i} has no positive, finite heapPerCounted: ${String(m)}`,
      );
    }
    return m;
  });
  return {
    node,
    low: Math.min(...multiples).toFixed(1),
    high: Math.max(...multiples).toFixed(1),
  };
}

module.exports = { heapRange };
