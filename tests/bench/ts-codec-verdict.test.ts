import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rule that turns the engine bench's paired samples into a verdict (`bench/lib/codec-verdict.cjs`), held at its
 * boundaries, and the committed evidence (`bench/ts-codec-comparison-results.json`) held to it: every median, quartile
 * and verdict in the file is recomputed from the rounds beside it, and every figure of every table of the report, its
 * module-load sentence and its per-kind memory differences are looked up in the file (the other figures in its prose are
 * not). Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Round = number[];
type Summary = {
  nativeMedian: number;
  typescriptMedian: number;
  controlMedian: number;
  typescriptVsNative: number;
  controlVsNative: number;
  typescriptQuartiles: number[];
  controlQuartiles: number[];
  verdictInputs: number[];
};
const verdict = require_('./lib/codec-verdict.cjs') as {
  BAR: number;
  CONTROL_BAND: number;
  MIN_ROUNDS: number;
  median: (xs: number[]) => number;
  quartile: (xs: number[], q: number) => number;
  verdictOf: (ts: number, control: number) => string;
  worstOf: (vs: string[]) => string;
  writeVerdictOf: (ts: number, control: number) => string;
  signedWorst: (xs: number[]) => number;
  summarise: (rounds: Round[], places?: number) => Summary;
  cellFrom: (
    rounds: Round[],
    places?: number,
    v?: ((ts: number, control: number) => string) | null,
  ) => Record<string, unknown> & { rounds: Round[]; verdict?: string };
};
const {
  verdictOf,
  worstOf,
  writeVerdictOf,
  summarise,
  cellFrom,
  median,
  quartile,
  signedWorst,
  MIN_ROUNDS,
} = verdict;

const WITHIN = 'within the 5% bar';
const OVER = 'over the 5% bar';
const INCONCLUSIVE = 'inconclusive';

describe('the verdict rule', () => {
  it('holds the A/A control to exactly +-2%: on the line resolves, past it is inconclusive', () => {
    expect(verdictOf(0, 0.02)).toBe(WITHIN);
    expect(verdictOf(0, -0.02)).toBe(WITHIN);
    expect(verdictOf(0, 0.0201)).toBe(INCONCLUSIVE);
    expect(verdictOf(0, -0.0201)).toBe(INCONCLUSIVE);
    // A control out of band hides a TypeScript figure of any size, in either direction.
    expect(verdictOf(0.5, 0.03)).toBe(INCONCLUSIVE);
    expect(verdictOf(-0.5, -0.03)).toBe(INCONCLUSIVE);
  });

  it('holds the TypeScript median to exactly +5%: on the line is within, past it is over', () => {
    expect(verdictOf(0.05, 0)).toBe(WITHIN);
    expect(verdictOf(0.0501, 0)).toBe(OVER);
    expect(verdictOf(-0.3, 0)).toBe(WITHIN);
    // The same line reached by division, where 105 / 100 - 1 is a hair above 0.05 in floating point.
    expect(105 / 100 - 1).toBeGreaterThan(0.05);
    expect(verdictOf(105 / 100 - 1, 0)).toBe(WITHIN);
    expect(verdictOf(0, 102 / 100 - 1)).toBe(WITHIN);
  });

  it('calls a figure that is not a number malformed, never a pass', () => {
    expect(verdictOf(Number.NaN, 0)).toBe('malformed');
    expect(verdictOf(0, Number.NaN)).toBe('malformed');
    expect(verdictOf(Number.POSITIVE_INFINITY, 0)).toBe('malformed');
    expect(writeVerdictOf(Number.NaN, 0)).toBe('malformed');
    expect(verdictOf(median([]), 0)).toBe('malformed');
    expect(cellFrom([]).verdict).toBe('malformed');
  });

  it('takes the worst of an op’s cells: malformed, then over, then inconclusive, then within, and none is malformed', () => {
    expect(worstOf([WITHIN, WITHIN])).toBe(WITHIN);
    expect(worstOf([WITHIN, INCONCLUSIVE])).toBe(INCONCLUSIVE);
    expect(worstOf([INCONCLUSIVE, OVER, WITHIN])).toBe(OVER);
    expect(worstOf([OVER, 'malformed'])).toBe('malformed');
    expect(worstOf([])).toBe('malformed');
  });

  it('judges the write path by the same control: faster below -2%, no slower to +2%, slower above', () => {
    expect(writeVerdictOf(-0.0201, 0)).toBe('faster');
    expect(writeVerdictOf(-0.02, 0)).toBe('no slower (within the control band)');
    expect(writeVerdictOf(0.02, 0)).toBe('no slower (within the control band)');
    expect(writeVerdictOf(0.0201, 0)).toBe('slower');
    expect(writeVerdictOf(-0.5, 0.03)).toBe(INCONCLUSIVE);
  });

  it('computes medians, quartiles and the signed worst by the stated rules', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(quartile([1, 2, 3, 4, 5, 6, 7, 8], 0.25)).toBe(3);
    expect(quartile([1, 2, 3, 4, 5, 6, 7, 8], 0.75)).toBe(7);
    expect(signedWorst([0.01, -0.03, 0.02])).toBe(-0.03);
    expect(signedWorst([])).toBeNaN();
    // Rounds are [order, native, typescript, control, load]; the paired differences are taken round by round.
    const s = summarise(
      [
        [0, 100, 110, 100, 1],
        [1, 200, 200, 202, 1],
        [2, 100, 90, 99, 1],
      ],
      0,
    );
    expect(s.typescriptVsNative).toBe(0);
    expect(s.controlVsNative).toBe(0);
    expect(s.nativeMedian).toBe(100);
    expect(s.typescriptMedian).toBe(110);
  });
});

type Cell = Summary & { rounds: Round[]; verdict?: string };
type ReadBasis = Cell & { verdict: string; answersAgree: boolean; loadMax: number };
type Spread = { median: number; min: number; max: number };
type MemoryFigures = {
  chunks: number;
  heapExternal: Spread;
  rss: Spread;
  rssBelowHeap: number;
  samples: number[][];
};
type Doc = {
  rules: { minRounds: number; roundFields: string[]; orders: number[][] };
  commit: string;
  reads: {
    attributionFailures: string[];
    cells: {
      dataset: string;
      op: string;
      verdict: string;
      inProcess: ReadBasis;
      perProcess: ReadBasis;
    }[];
    perOp: {
      op: string;
      verdict: string;
      inProcess: { verdict: string; worstControl: number };
      perProcess: { verdict: string; worstControl: number };
    }[];
  };
  write: { sameBytes: boolean; gcExposed: boolean; rows: (Cell & { op: string })[] };
  startup: {
    moduleLoadMs: Cell;
    coldProcess: { fields: Record<string, Cell> };
  };
  memory: {
    repeats: number;
    rows: {
      dataset: string;
      native: MemoryFigures;
      typescript: MemoryFigures;
    }[];
  };
};
const doc = JSON.parse(
  readFileSync(join(ROOT, 'bench', 'ts-codec-comparison-results.json'), 'utf8'),
) as Doc;

/** The stored figures of a cell are the ones its own rounds give. */
function expectDerived(
  cell: Cell,
  places: number,
  rule: ((a: number, b: number) => string) | null,
) {
  const again = cellFrom(cell.rounds, places, rule);
  // The file is JSON, which writes -0 as 0, so the figures derived from the rounds go through it too.
  expect({ ...cell, rounds: [] }).toMatchObject(
    JSON.parse(JSON.stringify({ ...again, rounds: [] })) as object,
  );
}

describe('the committed evidence', () => {
  it('rests every gate figure on at least 31 rounds', () => {
    expect(doc.rules.minRounds).toBe(MIN_ROUNDS);
    for (const c of doc.reads.cells)
      for (const b of [c.inProcess, c.perProcess])
        expect(b.rounds.length, `${c.dataset} ${c.op}`).toBeGreaterThanOrEqual(MIN_ROUNDS);
    for (const r of doc.write.rows)
      expect(r.rounds.length, r.op).toBeGreaterThanOrEqual(MIN_ROUNDS);
    for (const r of doc.write.rows.flatMap((x) => x.rounds))
      expect(r).toHaveLength(doc.rules.roundFields.length);
  });

  it('has every read cell’s medians, quartiles and verdict recomputed from its rounds, in both ways', () => {
    for (const c of doc.reads.cells)
      for (const basis of ['inProcess', 'perProcess'] as const) {
        expectDerived(c[basis], 0, verdictOf);
        const [ts = Number.NaN, control = Number.NaN] = summarise(c[basis].rounds).verdictInputs;
        expect(c[basis].verdict).toBe(verdictOf(ts, control));
      }
  });

  it('uses the per-process verdict for a cell, and the worst of the cells for an op', () => {
    for (const c of doc.reads.cells)
      expect(c.verdict, `${c.dataset} ${c.op}`).toBe(c.perProcess.verdict);
    for (const o of doc.reads.perOp) {
      const mine = doc.reads.cells.filter((c) => c.op === o.op);
      expect(o.verdict).toBe(worstOf(mine.map((c) => c.perProcess.verdict)));
      expect(o.perProcess.verdict).toBe(worstOf(mine.map((c) => c.perProcess.verdict)));
      expect(o.inProcess.verdict).toBe(worstOf(mine.map((c) => c.inProcess.verdict)));
      expect(o.perProcess.worstControl).toBe(
        signedWorst(mine.map((c) => c.perProcess.controlVsNative)),
      );
    }
  });

  it('records no wrong codec, no disagreeing answer and a write path of identical bytes', () => {
    expect(doc.reads.attributionFailures).toEqual([]);
    for (const c of doc.reads.cells)
      for (const b of [c.inProcess, c.perProcess]) expect(b.answersAgree).toBe(true);
    expect(doc.write.sameBytes).toBe(true);
    expect(doc.write.gcExposed).toBe(true);
  });

  it('has the write rows, the start-up rows and the memory medians recomputed from their samples', () => {
    for (const r of doc.write.rows) expectDerived(r, 0, writeVerdictOf);
    expectDerived(doc.startup.moduleLoadMs, 3, null);
    for (const f of Object.values(doc.startup.coldProcess.fields)) expectDerived(f, 3, null);
    for (const m of doc.memory.rows)
      for (const k of ['native', 'typescript'] as const)
        expect(m[k].heapExternal.median).toBe(median(m[k].samples.map((s) => s[0]!)));
  });

  it('records the commit the figures were taken on', () => {
    expect(doc.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('has every figure of the report’s tables, the module-load sentence and the memory differences in the file', () => {
    const report = readFileSync(join(ROOT, 'bench', 'ts-codec-comparison.md'), 'utf8');
    const rows = report
      .split('\n')
      .filter((l) => l.startsWith('|'))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    // Printed from the rounds' own medians, not from the four-place ratios stored beside them, so a figure is rounded once.
    const pct = (x: number) => `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)}%`;
    const ratios = (cell: { rounds: Round[] }) =>
      summarise(cell.rounds).verdictInputs as [number, number];
    const ts = (cell: { rounds: Round[] }) => pct(ratios(cell)[0]);
    const control = (cell: { rounds: Round[] }) => pct(ratios(cell)[1]);
    const time = (ns: number) =>
      ns < 1e6 ? `${(ns / 1e3).toFixed(1)} us` : `${(ns / 1e6).toFixed(1)} ms`;
    for (const c of doc.reads.cells) {
      const row = rows.find((r) => r[0] === c.dataset && r[1] === c.op && r.length > 8);
      expect(row, `${c.dataset} ${c.op}`).toBeDefined();
      expect(row!.slice(2), `${c.dataset} ${c.op}`).toEqual([
        time(c.perProcess.nativeMedian),
        time(c.perProcess.typescriptMedian),
        ts(c.perProcess),
        control(c.perProcess),
        c.perProcess.verdict,
        ts(c.inProcess),
        control(c.inProcess),
        c.inProcess.verdict,
        String(c.perProcess.loadMax),
      ]);
    }
    for (const o of doc.reads.perOp) {
      const row = rows.find((r) => r[0] === o.op && r.length === 8);
      expect(row, o.op).toBeDefined();
      const mine = doc.reads.cells.filter((c) => c.op === o.op);
      const worst = (b: 'perProcess' | 'inProcess') => [
        pct(Math.max(...mine.map((c) => ratios(c[b])[0]))),
        pct(signedWorst(mine.map((c) => ratios(c[b])[1]))),
        o[b].verdict,
      ];
      expect(row!.slice(1), o.op).toEqual([
        String(mine.length),
        ...worst('perProcess'),
        ...worst('inProcess'),
      ]);
    }
    for (const w of doc.write.rows) {
      const row = rows.find((r) => r[0] === w.op && r.length === 6);
      expect(row, w.op).toBeDefined();
      expect(row!.slice(1), w.op).toEqual([
        time(w.nativeMedian),
        time(w.typescriptMedian),
        ts(w),
        control(w),
        w.verdict,
      ]);
    }
    for (const [name, f] of Object.entries(doc.startup.coldProcess.fields)) {
      const row = rows.find((r) => r[0] === name && r.length === 5);
      expect(row, name).toBeDefined();
      expect(row!.slice(1), name).toEqual([
        String(f.nativeMedian),
        String(f.typescriptMedian),
        ts(f),
        control(f),
      ]);
    }
    for (const m of doc.memory.rows)
      for (const k of ['native', 'typescript'] as const) {
        const row = rows.find((r) => r[0] === m.dataset && r[2] === k && r.length === 6);
        expect(row, `${m.dataset} ${k}`).toBeDefined();
        const x = m[k];
        const span = (f: { median: number; min: number; max: number }) =>
          `${f.median} (${f.min} to ${f.max})`;
        expect(row!.slice(1), `${m.dataset} ${k}`).toEqual([
          String(x.chunks),
          k,
          span(x.heapExternal),
          span(x.rss),
          `${x.rssBelowHeap} of ${doc.memory.repeats}`,
        ]);
      }
    // The prose is wrapped, so a sentence is looked up with its line breaks as single spaces.
    const prose = report.replace(/\s+/g, ' ');
    const mod = doc.startup.moduleLoadMs;
    const ms = (x: number) => `${x.toFixed(1)} ms`;
    for (const figure of [
      ms(mod.nativeMedian),
      ms(mod.typescriptMedian),
      `(${pct(ratios(mod)[0])}; the control, native again, ${control(mod)})`,
    ])
      expect(prose, 'module load').toContain(figure);
    // The memory text names the difference between the codecs, per kind, and the one row whose resident ranges do not overlap.
    const grouped = (n: number) => n.toLocaleString('en-US');
    for (const m of doc.memory.rows) {
      const diff = m.typescript.heapExternal.median - m.native.heapExternal.median;
      expect(prose, `memory difference ${m.dataset}`).toContain(`${m.dataset} ${grouped(diff)}`);
      const ratio = (m.typescript.rss.median / m.native.rss.median).toFixed(2);
      expect(prose, `memory ratio ${m.dataset}`).toContain(`${m.dataset} ${ratio}`);
      const disjoint =
        m.typescript.rss.max < m.native.rss.min || m.native.rss.max < m.typescript.rss.min;
      expect(disjoint, `resident ranges of ${m.dataset}`).toBe(m.dataset === 'spread8k');
    }
  });
});
