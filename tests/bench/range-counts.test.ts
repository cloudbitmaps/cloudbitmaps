import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The table the cost model reads (`bench/range-counts.json`): the range requests the engine makes of each operand of a
 * cold intersect, by deployment, overlap and layout. The table itself is counted by running the built engine, and
 * `pnpm bench:range-counts:check` in CI holds the file to it; this holds the file's shape and what must be true of any
 * such table, so a count that is wrong in a way the layout cannot explain is refused here, before a build.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type Case = {
  shared: number;
  layout: 'packed' | 'spread';
  rangesPerOperand: number;
  rangeBytesPerOperand: number;
};
const table = JSON.parse(readFileSync(join(ROOT, 'bench', 'range-counts.json'), 'utf8')) as {
  chunksPerSegment: number;
  profiles: Record<string, { segmentBytes: number; chunkBytes: number; coldIntersect: Case[] }>;
  andNot: { getRange: number; getTail: number; pointer: number; excludes: number };
};
const MIB = 1024 * 1024;

describe('bench/range-counts.json', () => {
  it('covers each deployment at 100, 1,000 and 2,000 shared chunks, packed and spread', () => {
    expect(Object.keys(table.profiles)).toEqual(['small', 'medium', 'large']);
    for (const [name, p] of Object.entries(table.profiles)) {
      expect(
        p.coldIntersect.map((c) => `${c.shared}/${c.layout}`),
        name,
      ).toEqual([
        '100/packed',
        '100/spread',
        '1000/packed',
        '1000/spread',
        '2000/packed',
        '2000/spread',
      ]);
    }
  });

  it('never reads fewer bytes than the shared chunks are, nor a range over the 1 MiB ceiling per range', () => {
    for (const [name, p] of Object.entries(table.profiles)) {
      for (const c of p.coldIntersect) {
        const label = `${name} ${c.shared} ${c.layout}`;
        expect(c.rangeBytesPerOperand, label).toBeGreaterThanOrEqual(
          c.shared * p.chunkBytes * 0.99,
        );
        expect(c.rangesPerOperand, label).toBeGreaterThanOrEqual(
          Math.ceil(c.rangeBytesPerOperand / MIB),
        );
        // A range holds one chunk or at most 1 MiB, so the requests are at most the chunks and at least the MiBs.
        expect(c.rangesPerOperand, label).toBeLessThanOrEqual(c.shared);
      }
    }
  });

  it('packed shared chunks never make more ranges than spread ones, and more shared chunks never make fewer', () => {
    for (const [name, p] of Object.entries(table.profiles)) {
      for (const layout of ['packed', 'spread'] as const) {
        const ranges = p.coldIntersect
          .filter((c) => c.layout === layout)
          .map((c) => c.rangesPerOperand);
        expect(
          [...ranges].sort((a, b) => a - b),
          `${name} ${layout}`,
        ).toEqual(ranges);
      }
      for (const shared of [100, 1000, 2000]) {
        const at = (layout: string) =>
          p.coldIntersect.find((c) => c.shared === shared && c.layout === layout)!;
        expect(at('packed').rangesPerOperand, `${name} ${shared}`).toBeLessThanOrEqual(
          at('spread').rangesPerOperand,
        );
      }
    }
  });

  it('is what the calibration shape makes: the 100 shared chunks of the small deployment are one range of each operand', () => {
    const small = table.profiles.small!.coldIntersect;
    expect(small.find((c) => c.shared === 100 && c.layout === 'packed')?.rangesPerOperand).toBe(1);
    // The andNot of the calibration run: an operand's pointer and tail, and one range each, eleven operands.
    expect(table.andNot).toMatchObject({ getRange: 11, getTail: 11, pointer: 11, excludes: 10 });
  });
});
