import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TsBitmap, tsRoaringCodec } from '@/ts-roaring/bitmap';

/**
 * The cells of the counting-kernels bench (`bench/lib/count-cells.cjs`): every group and operation is there, a count and
 * the build it is timed against give one answer on every cell, the stop rule keeps an operation only when it is faster on
 * every group, and the committed record (`bench/count-kernels-results.json`), when it is committed, is held to the paired
 * rule and its gate. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Op = { count: () => unknown; build: () => unknown };
type Group = { name: string; ops: string[]; ids: (small: boolean) => [number[], number[]] };
type Verdicted = { dataset: string; op: string; verdict: string; rounds: number[][] };
const cells = require_('./lib/count-cells.cjs') as {
  ALL_OPS: string[];
  DISJOINT_OPS: string[];
  DATASETS: string[];
  groups: () => Group[];
  operationsOf: (codec: unknown, ids: [number[], number[]]) => Record<string, Op>;
  cellNames: () => string[];
  decisionsOf: (
    passes: Array<{ ops: Array<{ dataset: string; op: string; verdict: string }> }>,
  ) => Array<{ op: string; kept: boolean; stoppedBy: Array<{ cell: string; verdict: string }> }>;
};
const rule = require_('./lib/paired-verdict.cjs') as {
  FASTER: string;
  WITHIN: string;
  SLOWER: string;
  INCONCLUSIVE: string;
  cellOf: (rounds: number[][], places: number) => { verdict: string; headInterval: number[] };
  gateProblems: (passes: unknown[]) => string[];
};

describe('the cells', () => {
  it('cover the five data sets of the engine bench, a tiny-against-runs pair and the disjoint pairs', () => {
    const names = cells.groups().map((g) => g.name);
    expect(names).toEqual([
      ...cells.DATASETS,
      'tiny/runs',
      'disjoint 1000 interleaved',
      'disjoint sparse',
    ]);
    expect(cells.DATASETS).toEqual(['dense', 'sparse', 'runs', 'mixed', 'spread8k']);
  });

  it('time the and, or, xor and andNot counts, intersects, a true and a false isSubset and isEqual', () => {
    expect(cells.ALL_OPS).toEqual([
      'andCardinality',
      'orCardinality',
      'andNotCardinality',
      'xorCardinality',
      'intersects',
      'isSubsetTrue',
      'isSubsetFalse',
      'isEqual',
    ]);
    for (const g of cells.groups()) {
      expect(g.ops).toEqual(g.name.startsWith('disjoint') ? cells.DISJOINT_OPS : cells.ALL_OPS);
    }
    expect(cells.cellNames()).toContain('spread8k xorCardinality');
    expect(cells.cellNames()).toContain('disjoint sparse intersects');
    expect(new Set(cells.cellNames()).size).toBe(cells.cellNames().length);
  });

  it('give the count and the build one answer on every cell, and the answer the cell is named for', () => {
    for (const g of cells.groups()) {
      const ops = cells.operationsOf(tsRoaringCodec, g.ids(true));
      for (const op of g.ops) {
        const cell = ops[op] as Op;
        expect(cell.count(), `${g.name} ${op}`).toEqual(cell.build());
      }
      if (g.ops.includes('isSubsetTrue')) expect((ops.isSubsetTrue as Op).count()).toBe(true);
      if (g.ops.includes('isEqual')) expect((ops.isEqual as Op).count()).toBe(true);
      if (g.name.startsWith('disjoint')) {
        expect((ops.intersects as Op).count()).toBe(false);
        expect((ops.andCardinality as Op).count()).toBe(0);
      }
    }
  });

  it('hold the pairs to the kinds they are named for', () => {
    const pair = (name: string) =>
      (cells.groups().find((g) => g.name === name) as Group).ids(false);
    const [tiny, runs] = pair('tiny/runs');
    expect(tiny.length).toBe(8);
    expect(runs.length).toBeGreaterThan(16 * 8);
    const [evens, odds] = pair('disjoint 1000 interleaved');
    expect([evens.length, odds.length]).toEqual([1000, 1000]);
    expect(evens.every((v, i) => v === 2 * i) && odds.every((v, i) => v === 2 * i + 1)).toBe(true);
    const [a, b] = pair('disjoint sparse');
    expect(a.length).toBe(b.length);
    const inA = new Set(a);
    expect(b.some((v) => inA.has(v))).toBe(false);
  });

  it('isSubsetFalse never takes the size shortcut', () => {
    for (const name of cells.DATASETS) {
      const [a, b] = (cells.groups().find((g) => g.name === name) as Group).ids(true);
      const x = TsBitmap.fromValues(a);
      const y = TsBitmap.fromValues(b);
      const [lo, hi] = x.size <= y.size ? [x, y] : [y, x];
      expect(lo.size).toBeLessThanOrEqual(hi.size);
      expect(lo.isSubset(hi), name).toBe(false);
    }
  });
});

describe('the stop rule', () => {
  const pass = (verdicts: Record<string, string[]>) => ({
    ops: Object.entries(verdicts).flatMap(([op, list]) =>
      list.map((verdict, i) => ({ dataset: `set${i}`, op, verdict })),
    ),
  });

  it('keeps an operation faster than building on every group', () => {
    const d = cells.decisionsOf([pass({ andCardinality: [rule.FASTER, rule.FASTER] })]);
    expect(d).toEqual([{ op: 'andCardinality', kept: true, stoppedBy: [] }]);
  });

  it('does not keep it for one group that is within the bar, slower or inconclusive, and names the cell', () => {
    for (const verdict of [rule.WITHIN, rule.SLOWER, rule.INCONCLUSIVE]) {
      const [d] = cells.decisionsOf([pass({ intersects: [rule.FASTER, verdict, rule.FASTER] })]);
      expect(d).toEqual({
        op: 'intersects',
        kept: false,
        stoppedBy: [{ cell: 'set1 intersects', verdict }],
      });
    }
  });

  it('is decided by the last pass alone, and by operation', () => {
    const first = pass({ orCardinality: [rule.WITHIN], isEqual: [rule.FASTER] });
    const last = pass({ orCardinality: [rule.FASTER], isEqual: [rule.SLOWER] });
    const d = cells.decisionsOf([first, last]);
    expect(d.find((x) => x.op === 'orCardinality')?.kept).toBe(true);
    expect(d.find((x) => x.op === 'isEqual')?.kept).toBe(false);
  });
});

describe('the committed count record', () => {
  const file = join(ROOT, 'bench', 'count-kernels-results.json');
  const passes: Array<{ ops: Verdicted[]; pass: number; rule: string }> = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { passes: never[] }).passes
    : [];

  it.skipIf(passes.length === 0)('is recomputed from its rounds and passes the gate', () => {
    expect(rule.gateProblems(passes)).toEqual([]);
    for (const p of passes) {
      for (const c of p.ops) {
        expect(rule.cellOf(c.rounds, 7).verdict, `pass ${p.pass} ${c.dataset} ${c.op}`).toBe(
          c.verdict,
        );
      }
    }
  });
});
