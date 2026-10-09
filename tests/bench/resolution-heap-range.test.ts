import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The range `bench/sizing.cjs` publishes for the heap a filled resolution cache's entries take, against the bytes the
 * cache counts for them, read from `bench/resolution-heap-results.json`. The harness that writes the file is never run
 * by a gate, so the reader is what stands between a malformed file and the guide: it refuses any file it cannot read a
 * range from, rather than render one.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { heapRange } = createRequire(import.meta.url)(
  join(ROOT, 'bench/lib/resolution-heap-range.cjs'),
) as {
  heapRange(results: unknown): { node: string; low: string; high: string };
};

const shape = (heapPerCounted: unknown) => ({
  shape: 'cleartext, no metadata',
  entries: 8192,
  countedBytesEach: 322,
  heapBytesEach: 415,
  heapPerCounted,
});

describe('the heap range sizing.cjs publishes', () => {
  it('reads the committed results: the Node major version, and the lowest and highest multiple to one decimal', () => {
    const results: unknown = JSON.parse(
      readFileSync(join(ROOT, 'bench/resolution-heap-results.json'), 'utf8'),
    );
    expect(heapRange(results)).toEqual({ node: '24', low: '1.2', high: '1.5' });
  });

  it('takes the lowest and the highest across the shapes, whatever their order', () => {
    expect(heapRange({ node: 'v22.3.0', shapes: [shape(1.53), shape(1.24), shape(1.3)] })).toEqual({
      node: '22',
      low: '1.2',
      high: '1.5',
    });
  });

  it.each([
    ['no Node version', { shapes: [shape(1.3)] }],
    ['a Node version it cannot read', { node: '24', shapes: [shape(1.3)] }],
    ['no shapes', { node: 'v24.18.1', shapes: [] }],
    ['shapes that are not a list', { node: 'v24.18.1', shapes: {} }],
    ['a shape with no multiple', { node: 'v24.18.1', shapes: [shape(1.3), shape(undefined)] }],
    ['a multiple that is not a number', { node: 'v24.18.1', shapes: [shape('1.3')] }],
    ['a multiple that is NaN', { node: 'v24.18.1', shapes: [shape(Number.NaN)] }],
    ['a multiple that is not finite', { node: 'v24.18.1', shapes: [shape(Infinity)] }],
    ['a multiple of zero', { node: 'v24.18.1', shapes: [shape(0)] }],
    ['a negative multiple', { node: 'v24.18.1', shapes: [shape(-1.2)] }],
    ['no file content at all', null],
  ] as const)('refuses %s', (_, results) => {
    expect(() => heapRange(results)).toThrow(/resolution-heap-results\.json/);
  });
});
