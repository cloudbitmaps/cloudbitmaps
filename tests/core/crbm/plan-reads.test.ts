import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IntegrityError } from '@/core/errors';
import {
  MAX_COALESCED_READ_BYTES,
  MAX_COALESCE_GAP_BYTES,
  planChunkReads as planLazily,
} from '@/core/crbm/plan-reads';
import type { ChunkExtent, ChunkRegion, PlannedRead } from '@/core/crbm/plan-reads';
import { planAllAtOnce } from '../../helpers/plan-reference';

/** The plan taken to its end. */
const planChunkReads = (
  extents: Iterable<ChunkExtent>,
  region: ChunkRegion,
): readonly PlannedRead[] => [...planLazily(extents, region)];

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
  it('refuses an offset or length that is not a safe integer', () => {
    const region = { start: 8, end: 1_000_000 };
    for (const bad of [Number.NaN, 10.5, -1, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => planChunkReads([{ key: 0, offset: bad, length: 10 }], region)).toThrow(
        IntegrityError,
      );
      expect(() => planChunkReads([{ key: 0, offset: 100, length: bad }], region)).toThrow(
        IntegrityError,
      );
    }
  });

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
    expect(() => planChunkReads([{ key: 0, offset: 7, length: 10 }], region)).toThrow(
      'a chunk is not inside the chunk region, in order; re-load from source or roll back',
    );
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

describe('the lazy planner against the plan made all at once', () => {
  type Outcome = { reads: readonly PlannedRead[] } | { error: string };
  const run = (f: () => readonly PlannedRead[]): Outcome => {
    try {
      return { reads: f() };
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
      return { error: (e as Error).message };
    }
  };

  /** Valid layouts, and ones with one extent made wrong in each way the planner refuses. */
  const extentLists = shapes.chain((shape) => {
    const { extents } = layout(shape);
    if (extents.length === 0) return fc.constant(extents);
    return fc.oneof(
      { weight: 3, arbitrary: fc.constant(extents) },
      {
        weight: 2,
        arbitrary: fc
          .tuple(
            fc.integer({ min: 0, max: extents.length - 1 }),
            fc.constantFrom(
              'overlap',
              'zero',
              'fraction',
              'nan',
              'unsafe',
              'past-end',
              'before-start',
            ),
          )
          .map(([at, how]) => {
            const bad = extents.map((e) => ({ ...e }));
            const e = bad[at]!;
            const previousEnd = at === 0 ? REGION.start : bad[at - 1]!.offset + bad[at - 1]!.length;
            if (how === 'overlap') e.offset = previousEnd - 1;
            else if (how === 'zero') e.length = 0;
            else if (how === 'fraction') e.offset = e.offset + 0.5;
            else if (how === 'nan') e.length = Number.NaN;
            else if (how === 'unsafe') e.offset = 2 ** 53;
            else if (how === 'past-end') e.length = REGION.end;
            else e.offset = REGION.start - 1;
            return bad;
          }),
      },
    );
  });

  it('makes exactly the reads, in order, or raises exactly the error, for any extents', () => {
    fc.assert(
      fc.property(extentLists, (extents) => {
        expect(run(() => planChunkReads(extents, REGION))).toEqual(
          run(() => planAllAtOnce(extents, REGION)),
        );
      }),
      { numRuns: 4000 },
    );
  });

  it('hands out every read ahead of a bad extent, and never a read that covers one', () => {
    fc.assert(
      fc.property(extentLists, (extents) => {
        const handed: PlannedRead[] = [];
        try {
          for (const read of planLazily(extents, REGION)) handed.push(read);
        } catch {
          // The reads handed out before the refusal are held to the checks below.
        }
        const refused = run(() => planAllAtOnce(extents, REGION));
        if ('reads' in refused) {
          expect(handed).toEqual(refused.reads);
          return;
        }
        // A refused list: no handed read holds an extent the all-at-once planner would have refused, and those
        // that were handed out are the plan of the extents before the refused one, less the read the refused one
        // would have closed.
        let good = 0;
        for (; good < extents.length; good++) {
          if (!('reads' in run(() => planAllAtOnce(extents.slice(0, good + 1), REGION)))) break;
        }
        const covered = handed.flatMap((r) => r.chunks);
        expect(covered.length).toBeLessThanOrEqual(good);
        expect(covered).toEqual(extents.slice(0, covered.length));
        const before = planAllAtOnce(extents.slice(0, good), REGION);
        expect(handed).toEqual(before.slice(0, handed.length));
      }),
      { numRuns: 2000 },
    );
  });

  it('pulls only the extents the reads taken cover, and one more', () => {
    fc.assert(
      fc.property(shapes, fc.integer({ min: 0, max: 6 }), (shape, taken) => {
        const { extents } = layout(shape);
        let pulled = 0;
        const counted = (function* () {
          for (const e of extents) {
            pulled += 1;
            yield e;
          }
        })();
        const walk = planLazily(counted, REGION);
        const all = planAllAtOnce(extents, REGION);
        const got: PlannedRead[] = [];
        for (let i = 0; i < taken; i++) {
          const step = walk.next();
          if (step.done === true) break;
          got.push(step.value);
        }
        expect(got).toEqual(all.slice(0, got.length));
        const covered = got.reduce((n, r) => n + r.chunks.length, 0);
        expect(pulled).toBeLessThanOrEqual(Math.min(extents.length, covered + 1));
        expect(pulled).toBeGreaterThanOrEqual(covered);
      }),
      { numRuns: 1000 },
    );
  });
});
