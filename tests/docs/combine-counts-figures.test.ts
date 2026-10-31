import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The benchmarks page prints the requests and bytes of the count methods, and the figures are the ones
 * `bench/combine-counts.cjs` counted into `bench/combine-counts-results.json` (`pnpm bench:combine-counts:check` holds
 * that file to the engine). Nothing here recounts: this holds the page's two tables to the file, row for row, so a
 * figure retyped by hand, or a file counted again and not the page, fails here.
 *
 * KNOWN LIMIT. It reads the tables and the stop rule, not the sentences around them.
 */
const ROOT = join(__dirname, '..', '..');
interface Figures {
  requests: number;
  getRange: number;
  getTail: number;
  pointerReads: number;
  bytesRead: number;
  bytesWritten: number;
}
interface Record_ {
  stopRule: string;
  shapes: {
    id: string;
    cells: { layout: string; op: string; count: Figures; recipe: Figures; into: Figures }[];
  }[];
  verdict: { pass: boolean };
}
const record = JSON.parse(
  readFileSync(join(ROOT, 'bench', 'combine-counts-results.json'), 'utf8'),
) as Record_;
const page = readFileSync(join(ROOT, 'docs', 'benchmarks.md'), 'utf8');
const start = page.indexOf('## Counting a combine');
const section = page.slice(start, page.indexOf('\n## ', start + 1));

const fmt = (n: number): string => n.toLocaleString('en-US');
const SHAPES: Record<string, string> = {
  '500k': '2 × 500,000',
  '1M': '2 × 1,000,000',
  '5M': '2 × 5,000,000',
  '10M': '2 × 10,000,000',
  union31: '31 × 500,000',
};
const OPS: Record<string, string> = {
  intersect: '`intersectCount`',
  union: '`unionCount`',
  andNot: '`andNotCount`',
};
const rowOf = (shape: string, op: string, c: Figures, r: Figures, i: Figures): string =>
  `| ${SHAPES[shape]} | ${OPS[op]} | ${fmt(c.requests)} | ${c.getRange} / ${c.getTail} / ${c.pointerReads} | ${fmt(c.bytesRead)} | ${fmt(r.requests)} | ${fmt(r.bytesRead)} | ${fmt(i.requests)} | ${fmt(i.bytesRead)} | ${fmt(i.bytesWritten)} |`;

describe('the count methods on the benchmarks page', () => {
  it('has the section', () => {
    expect(start).toBeGreaterThan(0);
    expect(section.length).toBeGreaterThan(1_000);
  });

  it('prints every cell of the record as a table row, per layout', () => {
    for (const layout of ['packed', 'spread']) {
      const from = section.indexOf(`**${layout[0]!.toUpperCase()}${layout.slice(1)} layout**`);
      expect(from, layout).toBeGreaterThan(0);
      const rows = section
        .slice(from)
        .split('\n')
        .filter((l) => l.startsWith('| ') && !l.startsWith('| Operands') && !l.startsWith('| ---'))
        .slice(0, 13);
      const expected = record.shapes.flatMap((s) =>
        s.cells
          .filter((c) => c.layout === layout)
          .map((c) => rowOf(s.id, c.op, c.count, c.recipe, c.into)),
      );
      expect(rows, layout).toEqual(expected);
    }
  });

  it('quotes the stop rule as the record states it, and its verdict', () => {
    const flat = (s: string): string => s.replace(/[\s>]+/g, ' ');
    const rule = record.stopRule.replace(/^The count ships only if it/, 'the count ships only if it');
    expect(flat(section)).toContain(flat(rule.replace(/ The Into run is reported, not judged\.$/, '')));
    expect(record.verdict.pass).toBe(true);
    expect(section).toContain('**Verdict: every cell passed.**');
  });

  it('catches a figure that is not the record’s', () => {
    const c = record.shapes[0]!.cells[0]!;
    const wrong = rowOf('500k', 'intersect', { ...c.count, bytesRead: c.count.bytesRead + 1 }, c.recipe, c.into);
    expect(section).not.toContain(wrong);
    expect(section).toContain(rowOf('500k', 'intersect', c.count, c.recipe, c.into));
  });
});
