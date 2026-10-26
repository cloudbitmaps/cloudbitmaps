import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * A complete pass of the public bitmap class's bench, built from the cell inventory the full run takes, for the tests of
 * its verdict and its generated table: every steady cell on every data set, the three cold cells and a load row per data
 * set, every figure a constant the caller can override per cell.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

export type Round = Array<number | null>;
export type Cell = Record<string, unknown> & {
  dataset: string;
  op: string;
  method: string;
  group: string;
  rounds: Round[];
  slept?: unknown[][];
  discarded?: Round[];
};
export type LoadRow = Record<string, unknown> & { dataset: string; rounds: number[][] };
export type Pass = Record<string, unknown> & {
  environment: Record<string, unknown>;
  cells: Cell[];
  cold: Cell[];
  loadRoundTrip: LoadRow[];
  load: Record<string, number>;
};
export type File = { passes: Pass[] };

type Inventory = {
  datasets: string[];
  steady: Array<{ op: string; method: string; group: string; internal: boolean }>;
  cold: Array<{ op: string; method: string; group: string; internal: boolean }>;
  load: string[];
};
export const cells = require_('./lib/bitmap-api-cells.cjs') as { inventory: () => Inventory };
export const verdict = require_('./lib/bitmap-api-verdict.cjs') as {
  cellOf: (rounds: Round[], places?: number) => Record<string, unknown>;
  loadRowOf: (rounds: number[][]) => Record<string, unknown>;
  loadFiguresOf: (pass: unknown) => Record<string, number>;
  inventoryProblems: (pass: unknown) => string[];
  isComplete: (pass: unknown) => boolean;
  passOfRecord: (file: { passes: unknown[] }) => Pass | undefined;
  gateProblems: (passes: unknown[], opts?: { countResult?: string }) => string[];
  gateExit: (passes: unknown[], opts?: { countResult?: string }) => number;
  fresh: (pass: unknown) => Pass;
  roundCountOf: (pass: unknown) => number;
  EXIT: { ok: number; problems: number; partial: number };
  MIN_ROUNDS: number;
  RULE: string;
};

/** The figures of one cell: native, class, control (the class by default) and the codec's (when it has one). */
export type Figures = { native?: number; ours?: number; control?: number; internal?: number };

export const roundsOf = (
  n: number,
  f: { native: number; ours: number; control: number; internal: number | null },
) =>
  Array.from(
    { length: n },
    (_, i) => [i % 6, f.native, f.ours, f.control, f.internal, 1, 1] as Round,
  );

/**
 * A complete pass. `figures` maps `"<data set> <op>"` (cold rows `"cold <op>"`) to the figures that differ from the
 * defaults (native 10, class 15, control as the class, codec 12).
 */
export function completePass(
  figures: Record<string, Figures> = {},
  env: Record<string, unknown> = {},
): Pass {
  const inv = cells.inventory();
  const make = (dataset: string, c: Inventory['steady'][number]): Cell => {
    const f = figures[`${dataset} ${c.op}`] ?? {};
    const ours = f.ours ?? 15;
    const rounds = roundsOf(31, {
      native: f.native ?? 10,
      ours,
      control: f.control ?? ours,
      internal: c.internal ? (f.internal ?? 12) : null,
    });
    return {
      dataset,
      op: c.op,
      method: c.method,
      group: c.group,
      answersAgree: true,
      ...verdict.cellOf(rounds, 7),
      rounds,
    } as Cell;
  };
  const steady = inv.datasets.flatMap((d) => inv.steady.map((c) => make(d, c)));
  const cold = inv.cold.map((c) => make('cold', c));
  const loadRoundTrip = inv.load.map((dataset) => {
    const rounds = Array.from({ length: 31 }, () => [10, 2, 3, 1, 1]);
    return { dataset, ...verdict.loadRowOf(rounds), rounds } as LoadRow;
  });
  const pass = {
    schema: 1,
    unit: 'ms',
    rule: verdict.RULE,
    sleepRule: { factor: 100, maxOnCpu: 0.5 },
    pass: 1,
    environment: {
      node: 'v24.99.0',
      platform: 'darwin arm64',
      cpu: 'Test CPU',
      cores: 8,
      head: 'abcdef0123456789abcdef0123456789abcdef01',
      tree: 'clean',
      roaring: '2.7.0',
      countRoute: 'kernels',
      countResult: 'kept',
      anyLoad: false,
      smoke: false,
      rounds: 31,
      maxLoad: 6,
      ...env,
    },
    started: '2026-10-26T10:00:00.000Z',
    cells: steady,
    cold,
    loadRoundTrip,
    load: {},
  } as Pass;
  pass.load = verdict.loadFiguresOf(pass);
  return pass;
}

/** A deep copy, so a test can plant a lie in it. */
export const copyOf = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Sets the stored figures of a cell from new rounds, as a pass that recorded them would have. */
export function withRounds(cell: Cell, rounds: Round[]): void {
  Object.assign(cell, verdict.cellOf(rounds, 7), { rounds });
}

/** The cell of a pass by `"<data set> <op>"`. */
export function cellOfPass(pass: Pass, name: string): Cell {
  const found = [...pass.cells, ...pass.cold].find((c) => `${c.dataset} ${c.op}` === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
}
