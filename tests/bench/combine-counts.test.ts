import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The record of the combine count's bench (`bench/combine-counts-results.json`): the requests and bytes of counting a
 * combine by the engine's count, by streaming it and by an `*Into` into a scratch segment. `pnpm
 * bench:combine-counts:check` in CI holds the file to what the engine makes; this holds what must be true of any such
 * record: the shapes are all present, every total is its parts, the stop rule's verdict is stored and is the one the
 * rule gives from the figures, and the layouts are what they say. It needs no build.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const bench = require_(join(ROOT, 'bench', 'combine-counts.cjs')) as {
  judge: (
    layout: string,
    op: string,
    count: Figures,
    recipe: Figures,
  ) => { fewerBytesRequired: boolean; requestsOk: boolean; bytesOk: boolean; pass: boolean };
  operandKeys: (n: number, j: number, layout: string) => number[];
  STOP_RULE: string;
};

interface Figures {
  result: number;
  requests: number;
  getRange: number;
  getTail: number;
  pointerReads: number;
  requestsWritten: number;
  bytesRead: number;
  bytesWritten: number;
}
interface Cell {
  layout: 'packed' | 'spread';
  op: 'intersect' | 'union' | 'andNot';
  count: Figures;
  recipe: Figures;
  into: Figures;
  agree: boolean;
  verdict: ReturnType<typeof bench.judge>;
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
const record = JSON.parse(
  readFileSync(join(ROOT, 'bench', 'combine-counts-results.json'), 'utf8'),
) as {
  stopRule: string;
  shapes: Shape[];
  verdict: { pass: boolean; failing: string[] };
};
const cells = record.shapes.flatMap((s) => s.cells.map((c) => ({ shape: s, cell: c })));
const label = (s: Shape, c: Cell) => `${s.id}/${c.layout}/${c.op}`;

describe('bench/combine-counts-results.json', () => {
  it('has the shapes, each on both layouts and every op it names', () => {
    expect(record.shapes.map((s) => s.id)).toEqual(['500k', '1M', '5M', '10M', 'union31']);
    for (const s of record.shapes) {
      const ops = s.id === 'union31' ? ['union'] : ['intersect', 'union', 'andNot'];
      expect(
        s.cells.map((c) => `${c.layout}/${c.op}`),
        s.id,
      ).toEqual(['packed', 'spread'].flatMap((l) => ops.map((o) => `${l}/${o}`)));
      expect(s.chunksPerOperand).toBe(1_999);
      expect(s.sharedChunks).toBe(100);
    }
    expect(record.shapes.map((s) => [s.operands, s.idsPerOperand])).toEqual([
      [2, 500_000],
      [2, 1_000_000],
      [2, 5_000_000],
      [2, 10_000_000],
      [31, 500_000],
    ]);
  });

  it('holds every figure to its parts: the requests are the calls, and the three ways agree on the answer', () => {
    for (const { shape, cell } of cells) {
      for (const way of ['count', 'recipe', 'into'] as const) {
        const f = cell[way];
        expect(f.requests, `${label(shape, cell)} ${way}`).toBeGreaterThanOrEqual(
          f.getRange + f.getTail + f.pointerReads + f.requestsWritten,
        );
        expect(Number.isInteger(f.bytesRead) && f.bytesRead >= 0, label(shape, cell)).toBe(true);
      }
      // A read-only way writes nothing; the Into run writes its scratch object.
      expect(cell.count.requestsWritten, label(shape, cell)).toBe(0);
      expect(cell.recipe.requestsWritten, label(shape, cell)).toBe(0);
      expect(cell.into.requestsWritten, label(shape, cell)).toBeGreaterThan(0);
      expect(cell.into.bytesWritten, label(shape, cell)).toBeGreaterThan(0);
      expect(cell.agree, label(shape, cell)).toBe(true);
      expect(cell.count.result, label(shape, cell)).toBe(cell.recipe.result);
      expect(cell.into.result, label(shape, cell)).toBe(cell.recipe.result);
    }
  });

  it('counts what the layout makes: the answer is the operands’ arithmetic', () => {
    for (const { shape, cell } of cells) {
      const own = shape.chunksPerOperand - shape.sharedChunks;
      const perChunk = shape.idsPerChunk;
      const expected = {
        intersect: shape.sharedChunks * perChunk,
        union: (shape.sharedChunks + shape.operands * own) * perChunk,
        andNot: own * perChunk,
      }[cell.op];
      expect(cell.recipe.result, label(shape, cell)).toBe(expected);
    }
  });

  it('stores the stop rule and the verdict the rule gives from the figures, per cell and overall', () => {
    expect(record.stopRule).toBe(bench.STOP_RULE);
    const failing: string[] = [];
    for (const { shape, cell } of cells) {
      expect(cell.verdict, label(shape, cell)).toEqual(
        bench.judge(cell.layout, cell.op, cell.count, cell.recipe),
      );
      if (!cell.verdict.pass) failing.push(label(shape, cell));
    }
    expect(record.verdict).toEqual({ pass: failing.length === 0, failing });
  });
});

describe('the stop rule (judge)', () => {
  const f = (requests: number, bytesRead: number): Figures => ({
    result: 0,
    requests,
    getRange: 0,
    getTail: 0,
    pointerReads: 0,
    requestsWritten: 0,
    bytesRead,
    bytesWritten: 0,
  });

  it('refuses more requests than the recipe, on any cell', () => {
    for (const layout of ['packed', 'spread']) {
      for (const op of ['intersect', 'union', 'andNot']) {
        expect(bench.judge(layout, op, f(11, 1), f(10, 100)).pass, `${layout}/${op}`).toBe(false);
        expect(bench.judge(layout, op, f(10, 1), f(10, 100)).requestsOk, `${layout}/${op}`).toBe(
          true,
        );
      }
    }
  });

  it('wants strictly fewer bytes on union and andNot packed, and no more everywhere else', () => {
    expect(bench.judge('packed', 'union', f(5, 100), f(5, 100)).pass).toBe(false);
    expect(bench.judge('packed', 'andNot', f(5, 100), f(5, 100)).pass).toBe(false);
    expect(bench.judge('packed', 'union', f(5, 99), f(5, 100)).pass).toBe(true);
    expect(bench.judge('packed', 'andNot', f(5, 99), f(5, 100)).pass).toBe(true);
    // The look-alikes: intersect packed and every spread cell pass on equal bytes, and fail on more.
    for (const [layout, op] of [
      ['packed', 'intersect'],
      ['spread', 'intersect'],
      ['spread', 'union'],
      ['spread', 'andNot'],
    ] as const) {
      expect(bench.judge(layout, op, f(5, 100), f(5, 100)).pass, `${layout}/${op}`).toBe(true);
      expect(bench.judge(layout, op, f(5, 101), f(5, 100)).pass, `${layout}/${op}`).toBe(false);
    }
  });
});

describe('the layouts', () => {
  const span = (keys: number[]) => new Set(keys);

  it('share exactly the first hundred chunks in every operand and keep every other chunk to one operand', () => {
    for (const layout of ['packed', 'spread']) {
      const n = 31;
      const keys = Array.from({ length: n }, (_, j) => bench.operandKeys(n, j, layout));
      for (const k of keys) {
        expect(k).toHaveLength(1_999);
        expect(k).toEqual([...k].sort((a, b) => a - b));
        expect(Math.max(...k)).toBeLessThan(65_536);
      }
      const seen = new Map<number, number>();
      for (const k of keys) for (const key of span(k)) seen.set(key, (seen.get(key) ?? 0) + 1);
      const shared = [...seen.values()].filter((v) => v > 1);
      expect(shared, layout).toHaveLength(100);
      expect(shared.every((v) => v === n)).toBe(true);
    }
  });

  it('put the shared chunks first when packed and apart when spread', () => {
    const packed = bench.operandKeys(2, 0, 'packed');
    const spread = bench.operandKeys(2, 0, 'spread');
    expect(packed.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(spread.slice(0, 100)).not.toEqual(packed.slice(0, 100));
  });
});
