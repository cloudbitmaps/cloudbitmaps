import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IntegrityError } from '@/core/errors';
import {
  MAX_COALESCED_READ_BYTES,
  MAX_COALESCE_GAP_BYTES,
  planChunkReads,
} from '@/core/crbm/plan-reads';
import type { ChunkExtent, ChunkRegion } from '@/core/crbm/plan-reads';

const G = MAX_COALESCE_GAP_BYTES;
const M = MAX_COALESCED_READ_BYTES;
const REGION: ChunkRegion = { start: 8, end: 40 * 1024 * 1024 };

/** Chunks laid out from the region start: each `[gap before, length]` pair places one, keys ascending. */
const layout = (shape: readonly (readonly [number, number])[], start = REGION.start) => {
  const extents: ChunkExtent[] = [];
  let at = start;
  shape.forEach(([gap, length], key) => {
    at += gap;
    extents.push({ key, offset: at, length });
    at += length;
  });
  return { extents, end: at };
};

const shapes = fc.array(
  fc.tuple(
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 2_000 }) },
      { weight: 3, arbitrary: fc.integer({ min: G - 2, max: G + 2 }) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 * G }) },
    ),
    fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 1, max: 50_000 }) },
      { weight: 2, arbitrary: fc.integer({ min: M / 4 - 2, max: M / 2 + 2 }) },
      { weight: 1, arbitrary: fc.integer({ min: M - 2, max: M + 2 }) },
      { weight: 1, arbitrary: fc.integer({ min: M, max: 3 * M }) },
    ),
  ),
  { maxLength: 40 },
);

describe('planChunkReads: properties', () => {
  it('covers every needed chunk exactly once, in object order', () => {
    fc.assert(
      fc.property(shapes, (shape) => {
        const { extents } = layout(shape);
        const reads = planChunkReads(extents, REGION);
        expect(reads.flatMap((r) => r.chunks)).toEqual(extents);
      }),
    );
  });

  it('plans reads that are ascending, disjoint, inside the chunk region, and exactly span their chunks', () => {
    fc.assert(
      fc.property(shapes, (shape) => {
        const { extents } = layout(shape);
        let previousEnd = REGION.start;
        for (const read of planChunkReads(extents, REGION)) {
          expect(read.offset).toBeGreaterThanOrEqual(previousEnd);
          expect(read.offset + read.length).toBeLessThanOrEqual(REGION.end);
          const first = read.chunks[0]!;
          const last = read.chunks[read.chunks.length - 1]!;
          expect(read.offset).toBe(first.offset);
          expect(read.offset + read.length).toBe(last.offset + last.length);
          previousEnd = read.offset + read.length;
        }
      }),
    );
  });

  it('never leaves more than 256 KiB between two chunks of one read, nor reads past 1 MiB for more than one chunk', () => {
    fc.assert(
      fc.property(shapes, (shape) => {
        const { extents } = layout(shape);
        for (const read of planChunkReads(extents, REGION)) {
          for (let i = 1; i < read.chunks.length; i++) {
            const gap =
              read.chunks[i]!.offset - (read.chunks[i - 1]!.offset + read.chunks[i - 1]!.length);
            expect(gap).toBeLessThanOrEqual(G);
          }
          if (read.chunks.length > 1) expect(read.length).toBeLessThanOrEqual(M);
        }
      }),
    );
  });

  it('is greedy: it splits only where the next chunk could not join', () => {
    fc.assert(
      fc.property(shapes, (shape) => {
        const { extents } = layout(shape);
        const reads = planChunkReads(extents, REGION);
        for (let i = 1; i < reads.length; i++) {
          const before = reads[i - 1]!;
          const next = reads[i]!.chunks[0]!;
          const gap = next.offset - (before.offset + before.length);
          const joined = next.offset + next.length - before.offset;
          expect(gap > G || joined > M).toBe(true);
        }
      }),
    );
  });
});

describe('planChunkReads: cases', () => {
  it('plans nothing for no chunks', () => {
    expect(planChunkReads([], REGION)).toEqual([]);
  });

  it('reads a single chunk as exactly its bytes, whatever its size', () => {
    for (const length of [1, 1_000, M, M + 1, 5 * M]) {
      const extent = { key: 9, offset: 500, length };
      expect(planChunkReads([extent], REGION)).toEqual([{ offset: 500, length, chunks: [extent] }]);
    }
  });

  it('merges across a gap of exactly 256 KiB and splits across one byte more', () => {
    const at = (gap: number) =>
      layout([
        [0, 100],
        [gap, 100],
      ]).extents;
    expect(planChunkReads(at(G), REGION)).toHaveLength(1);
    expect(planChunkReads(at(G + 1), REGION)).toHaveLength(2);
  });

  it('merges up to exactly 1 MiB and splits one byte past it', () => {
    const at = (length: number) =>
      layout([
        [0, length],
        [0, M - length],
      ]).extents;
    expect(planChunkReads(at(M / 2), REGION)).toHaveLength(1);
    expect(planChunkReads(at(M / 2), REGION)[0]!.length).toBe(M);
    const over = layout([
      [0, M / 2],
      [0, M / 2 + 1],
    ]).extents;
    expect(planChunkReads(over, REGION)).toHaveLength(2);
  });

  it('keeps an oversize chunk alone and lets the chunks around it start their own reads', () => {
    const { extents } = layout([
      [0, 100],
      [0, 2 * M],
      [0, 100],
      [0, 100],
    ]);
    const reads = planChunkReads(extents, REGION);
    expect(reads.map((r) => r.chunks.map((c) => c.key))).toEqual([[0], [1], [2, 3]]);
  });

  it('refuses a chunk outside the chunk region, out of order, or overlapping the one before', () => {
    const region = { start: 8, end: 1_000 };
    expect(() => planChunkReads([{ key: 0, offset: 7, length: 10 }], region)).toThrow(
      IntegrityError,
    );
    expect(() => planChunkReads([{ key: 0, offset: 995, length: 6 }], region)).toThrow(
      IntegrityError,
    );
    expect(planChunkReads([{ key: 0, offset: 990, length: 10 }], region)).toHaveLength(1);
    expect(() =>
      planChunkReads(
        [
          { key: 0, offset: 100, length: 50 },
          { key: 1, offset: 120, length: 50 },
        ],
        region,
      ),
    ).toThrow(IntegrityError);
    expect(() =>
      planChunkReads(
        [
          { key: 0, offset: 200, length: 50 },
          { key: 1, offset: 100, length: 50 },
        ],
        region,
      ),
    ).toThrow(IntegrityError);
    expect(() => planChunkReads([{ key: 0, offset: 100, length: 0 }], region)).toThrow(
      IntegrityError,
    );
  });
});
