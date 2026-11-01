import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The benchmarks page prints the requests and bytes of the count methods, and the figures are the ones
 * `bench/combine-counts.cjs` counted into `bench/combine-counts-results.json` (`pnpm bench:combine-counts:check` holds
 * that file to the engine). Nothing here recounts: this holds the page to the file, so a figure retyped by hand, or a
 * file counted again and not the page, fails here. It holds the page's two tables whole (header, every row, and no row
 * beyond the record's), the shapes sentence, the chunk sizes, the spread layout's saving, the stop rule and its verdict,
 * and the counted figures that the reading guide and the counting playbook quote.
 *
 * KNOWN LIMIT. Sentences are held by the figures they quote, not by their wording.
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
interface Cell {
  layout: string;
  op: string;
  count: Figures;
  recipe: Figures;
  into: Figures;
  agree: boolean;
}
interface Shape {
  id: string;
  operands: number;
  idsPerOperand: number;
  chunksPerOperand: number;
  sharedChunks: number;
  idsPerChunk: number;
  cells: Cell[];
}
interface Record_ {
  stopRule: string;
  shapes: Shape[];
  verdict: { pass: boolean };
}
const read = (...rel: string[]): string => readFileSync(join(ROOT, ...rel), 'utf8');
const record = JSON.parse(read('bench', 'combine-counts-results.json')) as Record_;
const page = read('docs', 'benchmarks.md');
const flat = (s: string): string => s.replace(/[\s>]+/g, ' ');
const fmt = (n: number): string => n.toLocaleString('en-US');

const sectionOf = (text: string): string => {
  const start = text.indexOf('## Counting a combine');
  if (start < 0) return '';
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
const section = sectionOf(page);

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
const HEADER =
  '| Operands (ids) | Count method | Count: requests | Count: range / tail / pointer | Count: bytes read | Recipe: requests | Recipe: bytes read | `*Into`: requests | `*Into`: bytes read | `*Into`: bytes written |';
const SEPARATOR = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

const rowOf = (shape: string, c: Cell): string => {
  const label = SHAPES[shape];
  if (label === undefined)
    throw new Error(`the record has a shape "${shape}" this test has no label for`);
  const { count, recipe, into } = c;
  return `| ${label} | ${OPS[c.op]} | ${fmt(count.requests)} | ${count.getRange} / ${count.getTail} / ${count.pointerReads} | ${fmt(count.bytesRead)} | ${fmt(recipe.requests)} | ${fmt(recipe.bytesRead)} | ${fmt(into.requests)} | ${fmt(into.bytesRead)} | ${fmt(into.bytesWritten)} |`;
};

/** The table after a layout's title: its lines up to the first one that is not a table line. */
const tableOf = (text: string, layout: string): string[] => {
  const title = `**${layout[0]!.toUpperCase()}${layout.slice(1)} layout**`;
  const from = text.indexOf(title);
  if (from < 0) return [];
  const rows: string[] = [];
  let started = false;
  for (const line of text.slice(from).split('\n').slice(1)) {
    if (line.startsWith('|')) {
      started = true;
      rows.push(line);
    } else if (started) break;
  }
  return rows;
};

/** What differs between the benchmarks page text and the record, one line each; empty when they agree. */
const tableProblems = (text: string, rec: Record_): string[] => {
  const out: string[] = [];
  for (const layout of ['packed', 'spread']) {
    const rows = tableOf(sectionOf(text), layout);
    const expected = rec.shapes.flatMap((s) =>
      s.cells.filter((c) => c.layout === layout).map((c) => rowOf(s.id, c)),
    );
    if (rows[0] !== HEADER) out.push(`${layout}: the header row is not the expected one`);
    if (rows[1] !== SEPARATOR) out.push(`${layout}: the separator row is not the expected one`);
    const body = rows.slice(2);
    if (body.length !== expected.length) {
      out.push(`${layout}: ${body.length} rows, the record has ${expected.length} cells`);
    }
    expected.forEach((row, i) => {
      if (body[i] !== row) out.push(`${layout} row ${i + 1}: page "${body[i]}", record "${row}"`);
    });
  }
  return out;
};

const twoOperand = record.shapes.filter((s) => s.operands === 2);
const many = record.shapes.filter((s) => s.operands > 2);
const cell = (id: string, layout: string, op: string): Cell =>
  record.shapes.find((s) => s.id === id)!.cells.find((c) => c.layout === layout && c.op === op)!;

describe('the count methods on the benchmarks page', () => {
  it('has the section', () => {
    expect(section.length).toBeGreaterThan(1_000);
  });

  it('prints every cell of the record as a table row, per layout, under the expected header', () => {
    expect(tableProblems(page, record)).toEqual([]);
  });

  it('names a shape id of the record it has no label for', () => {
    const odd = { ...record, shapes: [{ ...record.shapes[0]!, id: 'zz9' }] };
    expect(() => tableProblems(page, odd)).toThrow(/"zz9"/);
  });

  it('fails on a changed cell, a changed header and an added row of the page text', () => {
    const cellOfPage = rowOf('500k', cell('500k', 'packed', 'intersect'));
    expect(page).toContain(cellOfPage);
    const changed = page.replace(cellOfPage, cellOfPage.replace('627,488', '627,489'));
    expect(tableProblems(changed, record)).not.toEqual([]);
    expect(tableProblems(page.replace('| Count method |', '| Method |'), record)).not.toEqual([]);
    const last = rowOf('union31', cell('union31', 'spread', 'union'));
    expect(tableProblems(page.replace(last, `${last}\n${last}`), record)).not.toEqual([]);
  });

  it('describes the shapes as the record has them', () => {
    const sizes = twoOperand.map((s) => fmt(s.idsPerOperand));
    const list = `${sizes.slice(0, -1).join(', ')} and ${sizes.at(-1)}`;
    const first = record.shapes[0]!;
    expect(new Set(record.shapes.map((s) => s.sharedChunks)).size).toBe(1);
    expect(new Set(record.shapes.map((s) => s.chunksPerOperand)).size).toBe(1);
    expect(many).toHaveLength(1);
    const m = many[0]!;
    const approx = fmt(Math.round(first.chunksPerOperand / 100) * 100);
    expect(flat(section)).toContain(
      `two operands of ${list} ids over about ${approx} chunks each, sharing ${first.sharedChunks} of them, and a union of ${m.operands} operands of ${fmt(m.idsPerOperand)} ids on the same chunks`,
    );
    const perChunk = record.shapes.map((s) => s.idsPerChunk);
    expect(flat(section)).toContain(
      `over chunks of ${fmt(Math.min(...perChunk))} ids (the 500,000-id shapes, the calibration's own layout) to ${fmt(Math.max(...perChunk))} ids (the 10,000,000-id shape)`,
    );
    expect(record.shapes.find((s) => s.idsPerChunk === Math.min(...perChunk))!.idsPerOperand).toBe(
      500_000,
    );
    expect(record.shapes.find((s) => s.idsPerChunk === Math.max(...perChunk))!.idsPerOperand).toBe(
      10_000_000,
    );
  });

  it('says all three ways agreed only where every cell agreed', () => {
    const cells = record.shapes.flatMap((s) => s.cells);
    expect(cells.every((c) => c.agree === true)).toBe(true);
    expect(flat(section)).toContain('All three ways returned the same answer on every cell.');
  });

  it('gives the spread layout’s saving as the record has it', () => {
    const range = (op: string): { low: string; top: number } => {
      const savings = record.shapes
        .filter((s) => s.cells.some((x) => x.layout === 'spread' && x.op === op))
        .map((s) => {
          const c = cell(s.id, 'spread', op);
          return {
            id: s.id,
            ops: s.idsPerOperand,
            pct: (100 * (c.recipe.bytesRead - c.count.bytesRead)) / c.recipe.bytesRead,
          };
        });
      const most = savings.reduce((a, b) => (b.pct > a.pct ? b : a));
      const least = savings.reduce((a, b) => (b.pct < a.pct ? b : a));
      expect(most.id, op).toBe('10M');
      expect(least.ops, op).toBe(500_000);
      expect(
        savings.filter((s) => s.ops === 500_000).every((s) => s.pct < 1),
        op,
      ).toBe(true);
      return { low: 'under 1', top: Math.round(most.pct) };
    };
    const union = range('union');
    const andNot = range('andNot');
    expect(flat(section)).toContain(
      `a union's count reads from ${union.low}% (the 500,000-id shapes) to ${union.top}% (the 10,000,000-id shape) fewer bytes than its recipe, and a difference's count from ${andNot.low}% (the 500,000-id shape) to ${andNot.top}% (the 10,000,000-id shape)`,
    );
    expect(flat(read('docs', 'guide', 'reading.md'))).toContain(
      `a union's saving runs from ${union.low}% (500,000 ids) to ${union.top}% (10,000,000 ids) of the bytes and a difference's to ${andNot.top}%`,
    );
    for (const s of twoOperand) {
      for (const layout of ['packed', 'spread']) {
        const c = cell(s.id, layout, 'intersect');
        expect(c.count.bytesRead, `${s.id} ${layout}`).toBe(c.recipe.bytesRead);
      }
    }
    expect(flat(section)).toContain(
      'an intersect reads the same bytes as its recipe on both layouts',
    );
  });

  it('quotes the stop rule as the record states it, and its verdict', () => {
    const rule = record.stopRule.replace(
      /^The count ships only if it/,
      'the count ships only if it',
    );
    expect(flat(section)).toContain(
      flat(rule.replace(/ The Into run is reported, not judged\.$/, '')),
    );
    expect(record.verdict.pass).toBe(true);
    expect(section).toContain('**Verdict: every cell passed.**');
  });
});

describe('the counted figures in the guides', () => {
  const reading = flat(read('docs', 'guide', 'reading.md'));
  const counting = flat(read('docs', 'playbooks', 'counting.md'));
  const small = record.shapes.find((s) => s.id === '500k')!;
  const big = record.shapes.find((s) => s.id === '10M')!;
  const wide = many[0]!;
  const packed = (id: string, op: string): Cell => cell(id, 'packed', op);

  it('reading.md quotes the shapes and the byte counts', () => {
    const u = packed('500k', 'union');
    const d = packed('500k', 'andNot');
    const b = packed('10M', 'union');
    const w = packed(wide.id, 'union');
    expect(reading).toContain(
      `two operands of ${fmt(small.idsPerOperand)} ids sharing ${small.sharedChunks} of ${fmt(small.chunksPerOperand)} chunks reading ${fmt(u.count.bytesRead)} bytes for a union or a difference where the stream read ${fmt(u.recipe.bytesRead)} and ${fmt(d.recipe.bytesRead)}`,
    );
    expect(d.count.bytesRead).toBe(u.count.bytesRead);
    expect(reading).toContain(
      `two of ${fmt(big.idsPerOperand)} ids making ${b.count.requests} requests and reading ${fmt(b.count.bytesRead)} bytes where the stream made ${b.recipe.requests} and read ${fmt(b.recipe.bytesRead)} for the union`,
    );
    expect(reading).toContain(
      `A ${wide.operands}-operand union of ${fmt(wide.idsPerOperand)}-id operands reads ${fmt(w.count.bytesRead)} bytes against ${fmt(w.recipe.bytesRead)} and makes the same ${w.count.requests} requests`,
    );
    expect(w.recipe.requests).toBe(w.count.requests);
  });

  it('counting.md quotes the union of two 10,000,000-id segments', () => {
    const b = packed('10M', 'union');
    expect(counting).toContain(
      `a union of two ${fmt(big.idsPerOperand)}-id segments on the packed layout made ${b.count.requests} requests and read ${fmt(b.count.bytesRead)} bytes where its stream made ${b.recipe.requests} and read ${fmt(b.recipe.bytesRead)}`,
    );
  });

  it('counting.md quotes the shared chunks of the in-region run it links, from that run’s evidence', () => {
    const runId = /the-in-region-run--run-(\d{4}-\d{2}-\d{2}-[0-9a-f]{5})/.exec(counting)?.[1];
    expect(runId).toBeDefined();
    const run = JSON.parse(read('bench', 'calibration', `${runId}.json`)) as {
      workload: { chunksPerSegment: number; sharedChunks: number };
    };
    expect(counting).toContain(
      `share ${run.workload.sharedChunks} of their ${fmt(run.workload.chunksPerSegment)} chunks`,
    );
  });
});
