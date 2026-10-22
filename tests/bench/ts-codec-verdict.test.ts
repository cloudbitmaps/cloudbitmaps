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
type ReadsPart = {
  commit: string;
  treeClean: boolean;
  startedAt: string;
  endedAt: string;
  attributionFailures: string[];
  cells: {
    dataset: string;
    op: string;
    inProcess: ReadBasis;
    perProcess: ReadBasis;
  }[];
};
type Doc = {
  rules: { minRounds: number; roundFields: string[]; orders: number[][] };
  commit: string;
  treeClean: boolean;
  startedAt: string;
  endedAt: string;
  nativeSmallestFirst: {
    vsShipped: ReadsPart;
    tsVsSmallestFirstNative: ReadsPart;
  };
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

type Retake = {
  dataset: string;
  op: string;
  basis: 'inProcess' | 'perProcess';
  firstTakeVsNative: number;
  firstTakeControl: number;
  retakeVsNative: number;
  retakeControl: number;
  retakeLoadMax: number;
};
type RetakeBasis = ReadBasis & { firstTake?: ReadBasis };
type RetakeDoc = {
  reads: {
    readsRetaken: { cells: Retake[] };
    cells: { dataset: string; op: string; inProcess: RetakeBasis; perProcess: RetakeBasis }[];
  };
};
const LOAD_LIMIT = 6;
const four = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * What is wrong with the re-take bookkeeping of a results file, as a list of sentences (empty when it holds): the list
 * of re-takes names exactly the bases that carry a first take; each first take is the figures its own rounds give, and
 * a base was re-taken exactly when its first take had a control outside the band or a peak load of 6 or more; the
 * figures the list gives for both takes are the ones in the cell and in its first take; and no kept round ran at a
 * load of 6 or more.
 */
function retakeProblems(d: RetakeDoc): string[] {
  const out: string[] = [];
  const listed = new Map(
    d.reads.readsRetaken.cells.map((r) => [`${r.dataset} ${r.op} ${r.basis}`, r] as const),
  );
  if (listed.size !== d.reads.readsRetaken.cells.length) out.push('a base is listed twice');
  const carrying = new Set<string>();
  for (const c of d.reads.cells)
    for (const basis of ['inProcess', 'perProcess'] as const) {
      const key = `${c.dataset} ${c.op} ${basis}`;
      const kept = c[basis];
      const first = kept.firstTake;
      for (const r of kept.rounds)
        if ((r[4] ?? Number.NaN) >= LOAD_LIMIT)
          out.push(`${key}: a kept round ran at load ${r[4]}`);
      if (first === undefined) {
        if (Math.abs(kept.controlVsNative) > verdict.CONTROL_BAND || kept.loadMax >= LOAD_LIMIT)
          out.push(`${key}: control or load called for a re-take, and there is none`);
        continue;
      }
      carrying.add(key);
      const again = summarise(first.rounds);
      if (
        four(again.typescriptVsNative) !== first.typescriptVsNative ||
        four(again.controlVsNative) !== first.controlVsNative
      )
        out.push(`${key}: the first take is not what its rounds give`);
      if (Math.abs(first.controlVsNative) <= verdict.CONTROL_BAND && first.loadMax < LOAD_LIMIT)
        out.push(`${key}: re-taken although its first take had a control in band and a low load`);
      const r = listed.get(key);
      if (r === undefined) {
        out.push(`${key}: carries a first take and is not listed`);
        continue;
      }
      if (
        r.firstTakeVsNative !== first.typescriptVsNative ||
        r.firstTakeControl !== first.controlVsNative
      )
        out.push(`${key}: the list's first take is not the cell's`);
      if (
        r.retakeVsNative !== kept.typescriptVsNative ||
        r.retakeControl !== kept.controlVsNative ||
        r.retakeLoadMax !== kept.loadMax
      )
        out.push(`${key}: the list's re-take is not the cell's figures`);
    }
  for (const key of listed.keys())
    if (!carrying.has(key)) out.push(`${key}: listed and carries no first take`);
  return out;
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

  it('places every part of the run in time, on one commit and a clean tree, inside the run', () => {
    const parts: [
      string,
      { commit: string; treeClean?: boolean; startedAt: string; endedAt: string },
    ][] = [
      ['reads', doc.reads as never],
      ['write', doc.write as never],
      ['memory', doc.memory as never],
      ['startup', doc.startup as never],
      ['vsShipped', doc.nativeSmallestFirst.vsShipped],
      ['tsVsSmallestFirstNative', doc.nativeSmallestFirst.tsVsSmallestFirstNative],
    ];
    expect(doc.treeClean).toBe(true);
    for (const [name, p] of parts) {
      expect(p.commit, name).toBe(doc.commit);
      if (p.treeClean !== undefined) expect(p.treeClean, name).toBe(true);
      expect(Date.parse(p.startedAt), name).toBeGreaterThanOrEqual(Date.parse(doc.startedAt));
      expect(Date.parse(p.endedAt), name).toBeLessThanOrEqual(Date.parse(doc.endedAt));
      expect(Date.parse(p.startedAt), name).toBeLessThan(Date.parse(p.endedAt));
    }
  });

  it('holds the re-take bookkeeping, and fails on a planted mismatch of each kind', () => {
    const real = doc as unknown as RetakeDoc;
    expect(real.reads.readsRetaken.cells.length).toBeGreaterThan(0);
    expect(retakeProblems(real)).toEqual([]);

    const plant = (edit: (d: RetakeDoc) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(real)) as RetakeDoc;
      edit(copy);
      return retakeProblems(copy);
    };
    const firstCarrying = (d: RetakeDoc): RetakeBasis => {
      for (const c of d.reads.cells)
        for (const b of ['inProcess', 'perProcess'] as const)
          if (c[b].firstTake !== undefined) return c[b];
      throw new Error('no re-taken base');
    };
    // a listed re-take with no first take kept in its cell
    expect(
      plant((d) => {
        delete firstCarrying(d).firstTake;
      }).join('\n'),
    ).toMatch(/listed and carries no first take/);
    // the list's re-take figure differs from the cell's
    expect(
      plant((d) => {
        d.reads.readsRetaken.cells[0]!.retakeVsNative += 0.01;
      }).join('\n'),
    ).toMatch(/list's re-take is not the cell's/);
    // a first take whose figure is not what its rounds give
    expect(
      plant((d) => {
        firstCarrying(d).firstTake!.typescriptVsNative += 0.01;
      }).join('\n'),
    ).toMatch(/first take is not what its rounds give/);
    // a kept round at a load of 6 or more
    expect(
      plant((d) => {
        firstCarrying(d).rounds[0]![4] = 7;
      }).join('\n'),
    ).toMatch(/a kept round ran at load 7/);
    // a cell with a control out of band and no re-take
    expect(
      plant((d) => {
        const c = d.reads.cells.find((x) => x.perProcess.firstTake === undefined)!;
        c.perProcess.controlVsNative = 0.05;
      }).join('\n'),
    ).toMatch(/called for a re-take, and there is none/);
    // a re-take of a base whose first take needed none
    expect(
      plant((d) => {
        const b = firstCarrying(d);
        b.firstTake!.controlVsNative = 0;
        b.firstTake!.loadMax = 1;
      }).join('\n'),
    ).toMatch(/re-taken although/);
  });

  it('names in the report the Node the run used', () => {
    const node = (doc as unknown as { node: string }).node;
    expect(node).toMatch(/^v\d+\.\d+\.\d+$/);
    const report = readFileSync(join(ROOT, 'bench', 'ts-codec-comparison.md'), 'utf8');
    expect(report).toContain(`Node ${node}`);
  });

  it('has the smallest-first sections’ cells recomputed from their rounds, in both ways, with agreeing answers', () => {
    for (const section of Object.values(doc.nativeSmallestFirst).filter(
      (x): x is ReadsPart => typeof x === 'object' && 'cells' in x,
    )) {
      expect(section.attributionFailures).toEqual([]);
      expect(section.cells.map((c) => `${c.dataset} ${c.op}`)).toEqual([
        'mixed intersect2',
        'mixed intersect4',
        'spread8k intersect2',
        'spread8k intersect4',
      ]);
      for (const c of section.cells)
        for (const basis of ['inProcess', 'perProcess'] as const) {
          expectDerived(c[basis], 0, verdictOf);
          expect(c[basis].rounds.length, `${c.dataset} ${c.op}`).toBeGreaterThanOrEqual(MIN_ROUNDS);
          expect(c[basis].answersAgree).toBe(true);
        }
    }
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
    // The smallest-first table: the order's effect on the native codec (paired in one run of three subjects) and the
    // TypeScript codec against the smallest-first native (paired in the other run), both ways.
    const ms2 = (ns: number) => `${(ns / 1e6).toFixed(2)} ms`;
    const fair = doc.nativeSmallestFirst;
    for (const c of fair.vsShipped.cells)
      for (const [basis, label] of [
        ['perProcess', 'per-process'],
        ['inProcess', 'in-process'],
      ] as const) {
        const name = `${c.dataset} \`${c.op}\`, ${label}`;
        const row = rows.find((r) => r[0] === name && r.length === 5);
        expect(row, name).toBeDefined();
        const other = fair.tsVsSmallestFirstNative.cells.find(
          (x) => x.dataset === c.dataset && x.op === c.op,
        )!;
        expect(row!.slice(1), name).toEqual([
          ms2(c[basis].nativeMedian),
          ms2(c[basis].typescriptMedian),
          `${ts(c[basis])} (${control(c[basis])})`,
          `${ts(other[basis])} (${control(other[basis])})`,
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
