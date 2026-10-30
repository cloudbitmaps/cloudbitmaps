import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TsBitmap, tsRoaringCodec } from '@/ts-roaring/bitmap';

/**
 * The cells of the counting-kernels bench (`bench/lib/count-cells.cjs`): every group and operation is there, a count and
 * the build it is timed against give one answer on every cell, each cell times the call it is named for, the decision
 * (`decisionOf`) is one for the family and fails closed on a record that is not whole, the script's gate prints one
 * result line with its own exit status, `--check` fails when the head does not time the count, and the committed record
 * (`bench/count-kernels-results.json`), when it is committed, is held to the paired rule and its gate. Nothing here
 * times anything against a bound.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Op = { count: () => unknown; build: () => unknown };
type Group = { name: string; ops: string[]; ids: (small: boolean) => [number[], number[]] };
type Verdicted = {
  dataset: string;
  op: string;
  verdict: string;
  headVsReference: number;
  rounds: number[][];
};
type Cell = {
  dataset: string;
  op: string;
  verdict: string;
  answersAgree: boolean;
  rounds: number[][];
  headInterval: number[];
  headVsReference: number;
  controlVsBase: number;
};
type Pass = {
  rule: string;
  subjects: Record<string, string>;
  environment: { rounds: number; smoke?: boolean };
  ops: Cell[];
};
type Decision = {
  status: 'kept' | 'derived' | 'invalid';
  problems: string[];
  stoppedBy: Array<{ cell: string; verdict: string }>;
  recorded: Array<{ cell: string; verdict: string }>;
};
const cells = require_('./lib/count-cells.cjs') as {
  ALL_OPS: string[];
  DISJOINT_OPS: string[];
  DATASETS: string[];
  JUDGED_OP: string;
  EXIT: Record<string, number>;
  groups: () => Group[];
  stored: (codec: unknown, ids: number[]) => TsBitmap;
  operationsOf: (codec: unknown, ids: [number[], number[]]) => Record<string, Op>;
  cellNames: () => string[];
  decisionOf: (
    passes: Pass[],
    options?: { rule?: string; problemsOf?: (passes: Pass[]) => string[] },
  ) => Decision;
};
const rule = require_('./lib/paired-verdict.cjs') as {
  RULE: string;
  FASTER: string;
  WITHIN: string;
  SLOWER: string;
  INCONCLUSIVE: string;
  cellOf: (
    rounds: number[][],
    places: number,
  ) => { verdict: string; headVsReference: number; headInterval: number[] };
  gateProblems: (passes: unknown[], options?: { verdicts?: boolean }) => string[];
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

  it('time the and count, intersects, a true and a false isSubset and isEqual, and no derived count', () => {
    expect(cells.ALL_OPS).toEqual([
      'andCardinality',
      'intersects',
      'isSubsetTrue',
      'isSubsetFalse',
      'isEqual',
    ]);
    for (const g of cells.groups()) {
      expect(g.ops).toEqual(g.name.startsWith('disjoint') ? cells.DISJOINT_OPS : cells.ALL_OPS);
    }
    expect(cells.cellNames()).toContain('spread8k intersects');
    expect(cells.cellNames()).toContain('disjoint sparse intersects');
    expect(
      cells.cellNames().some((n) => /orCardinality|xorCardinality|andNotCardinality/.test(n)),
    ).toBe(false);
    expect(new Set(cells.cellNames()).size).toBe(cells.cellNames().length);
  });

  // Budget 14 s: it builds and counts every cell at both scales. Measured: 2.7 s on a developer machine, 4.7 s on the
  // release job's runner in a single full run. Rule: the slowest measured time (release runner or developer machine)
  // times three, rounded up to the next whole second.
  it('give the count and the build one answer on every cell, and the answer the cell is named for, at both scales', () => {
    for (const small of [true, false]) {
      for (const g of cells.groups()) {
        const ops = cells.operationsOf(tsRoaringCodec, g.ids(small));
        for (const op of g.ops) {
          const cell = ops[op] as Op;
          expect(cell.count(), `${g.name} ${op} (small ${small})`).toEqual(cell.build());
        }
        if (g.ops.includes('isSubsetTrue')) expect((ops.isSubsetTrue as Op).count()).toBe(true);
        if (g.ops.includes('isSubsetFalse')) expect((ops.isSubsetFalse as Op).count()).toBe(false);
        if (g.ops.includes('isEqual')) expect((ops.isEqual as Op).count()).toBe(true);
        if (g.name.startsWith('disjoint')) {
          expect((ops.intersects as Op).count()).toBe(false);
          expect((ops.andCardinality as Op).count()).toBe(0);
        }
      }
    }
  }, 14_000);

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
});

/** What each cell hands the bitmap method it times: the receiver and the argument of every call, recorded. */
function callsOf(method: 'isSubset' | 'isEqual', run: () => unknown) {
  const spy = vi.spyOn(TsBitmap.prototype, method);
  try {
    const result = run();
    return {
      result,
      calls: spy.mock.calls.map((args, i) => ({
        self: spy.mock.contexts[i] as TsBitmap,
        arg: args[0] as TsBitmap,
      })),
    };
  } finally {
    spy.mockRestore();
  }
}

describe('each cell times the call it is named for', () => {
  const opsOf = (g: Group, small: boolean) => cells.operationsOf(tsRoaringCodec, g.ids(small));
  const withIsSubset = cells.groups().filter((g) => g.ops.includes('isSubsetFalse'));

  it('isSubsetFalse asks the smaller bitmap about the larger, a full walk that the size check does not answer', () => {
    let unequal = 0;
    for (const small of [true, false]) {
      for (const g of withIsSubset) {
        const [a, b] = g.ids(small).map((ids) => cells.stored(tsRoaringCodec, ids)) as [
          TsBitmap,
          TsBitmap,
        ];
        const ops = opsOf(g, small);
        const { result, calls } = callsOf('isSubset', () => (ops.isSubsetFalse as Op).count());
        expect(result, g.name).toBe(false);
        expect(calls.length, g.name).toBe(1);
        const [{ self, arg }] = calls as [{ self: TsBitmap; arg: TsBitmap }];
        expect(
          self.size,
          `${g.name} (small ${small}): the receiver is not the larger`,
        ).toBeLessThanOrEqual(arg.size);
        expect(self, g.name).not.toBe(arg);
        if (a.size !== b.size) unequal++;
        if (a.size !== b.size) expect(self.size, g.name).toBeLessThan(arg.size);
      }
    }
    expect(unequal).toBeGreaterThan(0);
  }, 60_000);

  it('isSubsetTrue asks A about the union of A and B, which is not A itself', () => {
    for (const small of [true, false]) {
      for (const g of withIsSubset) {
        const ops = opsOf(g, small);
        const { result, calls } = callsOf('isSubset', () => (ops.isSubsetTrue as Op).count());
        expect(result, g.name).toBe(true);
        const [{ self, arg }] = calls as [{ self: TsBitmap; arg: TsBitmap }];
        expect(arg, g.name).not.toBe(self);
        expect(arg.size, g.name).toBeGreaterThanOrEqual(self.size);
        expect(arg.andCardinality(self), g.name).toBe(self.size);
      }
    }
  }, 60_000);

  it('isEqual compares A with a second decode of A, a different object', () => {
    for (const small of [true, false]) {
      for (const g of withIsSubset) {
        const ops = opsOf(g, small);
        const { result, calls } = callsOf('isEqual', () => (ops.isEqual as Op).count());
        expect(result, g.name).toBe(true);
        const [{ self, arg }] = calls as [{ self: TsBitmap; arg: TsBitmap }];
        expect(arg, g.name).not.toBe(self);
        expect(arg.size, g.name).toBe(self.size);
      }
    }
  }, 60_000);
});

describe('the decision', () => {
  const cell = (dataset: string, op: string, verdict: string, extra: Partial<Cell> = {}): Cell => ({
    dataset,
    op,
    verdict,
    answersAgree: true,
    rounds: Array.from({ length: 31 }, () => [0, 1, 1, 1, 1, 1]),
    headInterval: [-0.5, -0.4],
    headVsReference: -0.5,
    controlVsBase: 0,
    ...extra,
  });
  const names = () => cells.groups().flatMap((g) => g.ops.map((op) => ({ dataset: g.name, op })));
  /** A whole pass in which every cell has `verdict`, except as `overrides` says (`"<group> <op>"` to a verdict). */
  const wholePass = (verdict: string, overrides: Record<string, string> = {}): Pass => ({
    rule: rule.RULE,
    subjects: { base: 'build', head: 'count', control: 'build again' },
    environment: { rounds: 31 },
    ops: names().map(({ dataset, op }) =>
      cell(dataset, op, overrides[`${dataset} ${op}`] ?? verdict),
    ),
  });
  const decide = (passes: Pass[]) => cells.decisionOf(passes, { rule: rule.RULE });

  /** The medians of the count against the build, per `"<group> andCardinality"`; the others keep the default. */
  const withMedians = (verdict: string, medians: Record<string, number>): Pass => {
    const pass = wholePass(verdict);
    for (const c of pass.ops) {
      const m = medians[`${c.dataset} ${c.op}`];
      if (m !== undefined) c.headVsReference = m;
    }
    return pass;
  };

  it('keeps the family when the count beats the build on every group, whatever the control and the interval say', () => {
    for (const verdict of [rule.FASTER, rule.WITHIN, rule.INCONCLUSIVE]) {
      const d = decide([wholePass(verdict)]);
      expect(d, verdict).toEqual({
        status: 'kept',
        problems: [],
        stoppedBy: [],
        recorded: expect.any(Array),
      });
    }
    expect(decide([wholePass(rule.FASTER)]).recorded.length).toBe(
      cells.cellNames().length - cells.groups().length,
    );
  });

  it('keeps the family on the smallest gap on record, a median just below zero', () => {
    expect(
      decide([withMedians(rule.INCONCLUSIVE, { 'sparse andCardinality': -0.0001 })]).status,
    ).toBe('kept');
  });

  it('derives the family when one andCardinality group has a median at or above zero, naming the cell', () => {
    for (const median of [0, 0.0001, 0.3]) {
      const d = decide([withMedians(rule.FASTER, { 'sparse andCardinality': median })]);
      expect(d.status, String(median)).toBe('derived');
      expect(d.problems).toEqual([]);
      expect(d.stoppedBy).toEqual([
        { cell: 'sparse andCardinality', verdict: rule.FASTER, median },
      ]);
    }
  });

  it('is invalid when an andCardinality cell has no median', () => {
    const d = decide([withMedians(rule.FASTER, { 'sparse andCardinality': Number.NaN })]);
    expect(d.status).toBe('invalid');
    expect(d.problems.join('\n')).toMatch(/sparse andCardinality: no median/);
  });

  it('judges andCardinality alone: a recorded cell that is slower does not derive the family', () => {
    for (const op of ['intersects', 'isSubsetTrue', 'isSubsetFalse', 'isEqual']) {
      const d = decide([wholePass(rule.FASTER, { [`runs ${op}`]: rule.SLOWER })]);
      expect(d.status, op).toBe('kept');
      expect(d.recorded).toContainEqual({ cell: `runs ${op}`, verdict: rule.SLOWER });
    }
  });

  it('is decided by the last pass alone', () => {
    const losing = withMedians(rule.FASTER, { 'runs andCardinality': 0.1 });
    expect(decide([losing, wholePass(rule.FASTER)]).status).toBe('kept');
    expect(decide([wholePass(rule.FASTER), losing]).status).toBe('derived');
  });

  it('is invalid, never kept, on a record that does not hold every cell of every group', () => {
    const whole = wholePass(rule.FASTER);
    const without = (drop: (c: Cell) => boolean): Pass => ({
      ...whole,
      ops: whole.ops.filter((c) => !drop(c)),
    });
    const partials: Array<[string, Pass]> = [
      ['one cell only', without((c) => `${c.dataset} ${c.op}` !== 'dense andCardinality')],
      ['one group missing', without((c) => c.dataset === 'tiny/runs')],
      ['one operation missing', without((c) => c.op === 'isEqual')],
      ['a disjoint group missing', without((c) => c.dataset === 'disjoint sparse')],
      [
        'the judged cell of one group missing',
        without((c) => c.dataset === 'mixed' && c.op === 'andCardinality'),
      ],
    ];
    for (const [label, pass] of partials) {
      const d = decide([pass]);
      expect(d.status, label).toBe('invalid');
      expect(d.problems.join('\n'), label).toMatch(/has no cell/);
    }
  });

  it('is invalid on a cell no group has', () => {
    const pass = wholePass(rule.FASTER);
    pass.ops.push(cell('dense', 'orCardinality', rule.FASTER));
    expect(decide([pass]).status).toBe('invalid');
  });

  it("is invalid when a cell's answers disagree, it has no verdict, or it has too few rounds", () => {
    const bad: Array<[string, Partial<Cell>]> = [
      ['answers disagree', { answersAgree: false }],
      ['no verdict', { verdict: 'malformed' }],
      ['too few rounds', { rounds: [[0, 1, 1, 1, 1, 1]] }],
    ];
    for (const [label, change] of bad) {
      const pass = wholePass(rule.FASTER);
      pass.ops[3] = { ...(pass.ops[3] as Cell), ...change };
      expect(decide([pass]).status, label).toBe('invalid');
    }
  });

  it('is invalid for a smoke pass, no pass, another rule, or subjects that are not build, count, build again', () => {
    const smoke = wholePass(rule.FASTER);
    smoke.environment.smoke = true;
    expect(decide([smoke]).status).toBe('invalid');
    expect(decide([]).status).toBe('invalid');
    expect(decide([{ ...wholePass(rule.FASTER), rule: 'older-rule' }]).status).toBe('invalid');
    for (const subjects of [
      { base: 'build', head: 'build', control: 'build again' },
      { base: 'count', head: 'build', control: 'build again' },
    ]) {
      expect(decide([{ ...wholePass(rule.FASTER), subjects }]).status).toBe('invalid');
    }
  });

  it('is invalid when the paired gate refuses a pass, and says what it refused', () => {
    const d = cells.decisionOf([wholePass(rule.FASTER)], {
      rule: rule.RULE,
      problemsOf: () => ['pass 1: a round was kept at a high load'],
    });
    expect(d.status).toBe('invalid');
    expect(d.problems).toContain('pass 1: a round was kept at a high load');
  });

  it('exits with a status of its own for kept, derived and invalid', () => {
    expect(cells.EXIT).toEqual({ kept: 0, derived: 3, invalid: 4 });
  });
});

/** Runs the script's `--gate` over a record written to a scratch file: its exit status and its output. */
function gateOf(record: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'count-gate-'));
  try {
    const file = join(dir, 'results.json');
    writeFileSync(file, JSON.stringify(record));
    const run = spawnSync(process.execPath, [join(ROOT, 'bench', 'count-kernels.cjs'), '--gate'], {
      cwd: ROOT,
      env: { ...process.env, COUNT_RESULTS: file },
      encoding: 'utf8',
    });
    return { code: run.status, out: run.stdout + run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the script's gate", () => {
  const record = (
    verdictOf: (dataset: string, op: string) => string,
    keep: (c: Cell) => boolean = () => true,
    medianOf: (dataset: string, op: string) => number = () => -0.5,
  ) => ({
    passes: [
      {
        pass: 1,
        schema: 2,
        rule: rule.RULE,
        subjects: { base: 'build', head: 'count', control: 'build again' },
        environment: { rounds: 31, anyLoad: false, smoke: false },
        ops: cells
          .groups()
          .flatMap((g) =>
            g.ops.map((op) => ({
              dataset: g.name,
              op,
              verdict: verdictOf(g.name, op),
              answersAgree: true,
              rounds: Array.from({ length: 31 }, () => [0, 1, 1, 1, 1, 1]),
              headInterval: [-0.5, -0.4],
              headVsReference: medianOf(g.name, op),
              controlVsBase: 0,
            })),
          )
          .filter(keep),
      },
    ],
  });

  it('prints one result line and exits 0 when the family is kept', () => {
    const { code, out } = gateOf(record(() => rule.FASTER));
    expect(code).toBe(0);
    expect(out.match(/^RESULT /gm)).toEqual(['RESULT ']);
    expect(out).toMatch(/^RESULT kept: /m);
  });

  it('prints kept and exits 0 when every median beats the build, though a control or an interval is inconclusive', () => {
    const { code, out } = gateOf(
      record((d, op) =>
        d === 'mixed' && op === 'andCardinality' ? rule.INCONCLUSIVE : rule.FASTER,
      ),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^RESULT kept: /m);
  });

  it('prints one result line naming the cell and exits 3 when one group does not beat the build', () => {
    const { code, out } = gateOf(
      record(
        () => rule.FASTER,
        () => true,
        (d, op) => (d === 'runs' && op === 'andCardinality' ? 0.2 : -0.5),
      ),
    );
    expect(code).toBe(3);
    expect(out.match(/^RESULT /gm)?.length).toBe(1);
    expect(out).toMatch(/^RESULT derived: .*runs andCardinality/m);
  });

  it('exits 4 on a partial record, even when every cell it holds is faster', () => {
    const { code, out } = gateOf(
      record(
        () => rule.FASTER,
        (c) => c.dataset === 'dense',
      ),
    );
    expect(code).toBe(4);
    expect(out).toMatch(/^RESULT invalid: /m);
    expect(out).not.toMatch(/^RESULT kept/m);
  });

  it("exits 4 when a cell's answers disagree", () => {
    const r = record(() => rule.FASTER);
    (r.passes[0] as { ops: Cell[] }).ops[0]!.answersAgree = false;
    const { code, out } = gateOf(r);
    expect(code).toBe(4);
    expect(out).toMatch(/different answers/);
  });

  it('exits 4 on a pass that is not whole, even when every median beats the build', () => {
    const { code, out } = gateOf(
      record(
        () => rule.INCONCLUSIVE,
        (c) => c.dataset !== 'runs',
      ),
    );
    expect(code).toBe(4);
    expect(out).toMatch(/^RESULT invalid: /m);
  });

  it('exits 4 on a record with no pass', () => {
    expect(gateOf({ passes: [] }).code).toBe(4);
  });
});

describe('--check asserts that the head times the count', () => {
  /** Runs the script's `--check` with its `VARIANTS` replaced by `variants` (its children are the unchanged script). */
  function checkWith(variants: string): Promise<{ code: number | null; out: string }> {
    const script = join(ROOT, 'bench', 'count-kernels.cjs');
    const loader = [
      "const Module = require('node:module'), fs = require('node:fs'), path = require('node:path');",
      'const file = process.argv[1];',
      "const original = \"const VARIANTS = ['build', 'count', 'build'];\";",
      "const text = fs.readFileSync(file, 'utf8');",
      "if (!text.includes(original)) throw new Error('VARIANTS not found');",
      'const m = new Module(file);',
      'm.filename = file;',
      'm.paths = Module._nodeModulePaths(path.dirname(file));',
      "m._compile(text.replace(original, 'const VARIANTS = ' + process.env.TEST_VARIANTS + ';'), file);",
    ].join('\n');
    return new Promise((done) => {
      const child = spawn(process.execPath, ['--expose-gc', '-e', loader, script, '--check'], {
        cwd: ROOT,
        env: { ...process.env, TEST_VARIANTS: variants },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, out });
      });
    });
  }

  it('passes with the build, the count and the build again', async () => {
    const run = await checkWith("['build', 'count', 'build']");
    expect(run.out).toContain('count-kernels --check: ok');
    expect(run.code).toBe(0);
  }, 130_000);

  it('fails when the count is never timed', async () => {
    const run = await checkWith("['build', 'build', 'build']");
    expect(run.code).not.toBe(0);
    expect(run.out).toMatch(/timed the build, not the count/);
  }, 130_000);
});

describe('the committed count record', () => {
  const file = join(ROOT, 'bench', 'count-kernels-results.json');
  const passes: Array<Pass & { pass: number }> = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { passes: never[] }).passes
    : [];

  it.skipIf(passes.length === 0)('is recomputed from its rounds, is whole, and decides', () => {
    expect(rule.gateProblems(passes, { verdicts: false })).toEqual([]);
    expect(cells.decisionOf(passes, { rule: rule.RULE }).status).not.toBe('invalid');
    for (const p of passes) {
      for (const c of p.ops as unknown as Verdicted[]) {
        const recomputed = rule.cellOf(c.rounds, 7);
        const where = `pass ${p.pass} ${c.dataset} ${c.op}`;
        expect(recomputed.verdict, where).toBe(c.verdict);
        expect(recomputed.headVsReference, `${where}: stored median`).toBe(c.headVsReference);
      }
    }
  });
});
