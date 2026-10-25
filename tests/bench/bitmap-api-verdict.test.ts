import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rule that reads a pass of the public bitmap class's bench (`bench/lib/bitmap-api-verdict.cjs`), held at its
 * boundaries: the A/A control's band, the ratio to native and its interval, the groups stop rule 2 may call close, the
 * methods stop rule 3 stops, and the gate over the record. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Round = Array<number | null>;
type Cell = {
  dataset: string;
  op: string;
  method: string;
  group: string;
  answersAgree: boolean;
  malformed?: boolean;
  vsNative: number;
  vsNativeInterval: number[];
  controlVsOurs: number;
  controlInBand: boolean;
  vsInternal?: number;
  rounds: Round[];
};
const verdict = require_('./lib/bitmap-api-verdict.cjs') as {
  CONTROL_BAND: number;
  CLOSE_BAR: number;
  SHIP_BAR: number;
  RULE: string;
  cellOf: (rounds: Round[], places?: number) => Cell;
  recompute: (cell: { rounds: Round[] }) => Cell;
  groupsOf: (cells: Array<Partial<Cell>>) => Array<{
    group: string;
    worst: number;
    worstCell: string;
    unresolved: number;
    close: boolean;
  }>;
  overShipBar: (
    cells: Array<Partial<Cell>>,
  ) => Array<{ method: string; worst: number; cell: string }>;
  passOfRecord: (file: { passes: unknown[] }) => unknown;
  gateProblems: (passes: unknown[]) => string[];
};

/** `n` rounds `[order, native, ours, control, internal, start, end]` with the given figures. */
function rounds(
  n: number,
  native: number,
  ours: number,
  control = ours,
  internal: number | null = null,
  end = 1,
) {
  return Array.from(
    { length: n },
    (_, i) => [i % 6, native, ours, control, internal, 1, end] as Round,
  );
}

describe('a cell', () => {
  it('reads the median of ours over native, round by round', () => {
    const c = verdict.cellOf(rounds(31, 10, 25));
    expect(c.vsNative).toBe(2.5);
    expect(c.vsNativeInterval).toEqual([2.5, 2.5]);
    expect(c.controlVsOurs).toBe(0);
    expect(c.controlInBand).toBe(true);
    expect(c.vsInternal).toBeUndefined();
  });

  it('pairs inside a round: a noisy native does not move the ratio of a round to its own native', () => {
    const rs = Array.from({ length: 31 }, (_, i) => {
      const scale = 1 + (i % 5);
      return [i % 6, 10 * scale, 20 * scale, 20 * scale, null, 1, 1] as Round;
    });
    expect(verdict.cellOf(rs).vsNative).toBe(2);
  });

  it('holds the control to exactly +-2% of ours: on the line is in band, past it is not', () => {
    expect(verdict.cellOf(rounds(31, 10, 100, 102)).controlInBand).toBe(true);
    expect(verdict.cellOf(rounds(31, 10, 100, 98)).controlInBand).toBe(true);
    expect(verdict.cellOf(rounds(31, 10, 100, 102.1)).controlInBand).toBe(false);
    expect(verdict.cellOf(rounds(31, 10, 100, 97.9)).controlInBand).toBe(false);
  });

  it('reads the codec figure as a second ratio when every round has one', () => {
    const c = verdict.cellOf(rounds(31, 10, 30, 30, 20));
    expect(c.vsInternal).toBe(1.5);
  });

  it('is malformed for a missing, zero or half-present figure', () => {
    expect(verdict.cellOf([]).malformed).toBe(true);
    expect(verdict.cellOf(rounds(31, 0, 5)).malformed).toBe(true);
    expect(verdict.cellOf([[0, 1, 2, 3, null, 1] as Round]).malformed).toBe(true);
    const half = rounds(31, 10, 25, 25, 12);
    half[3] = [3, 10, 25, 25, null, 1, 1];
    expect(verdict.cellOf(half).malformed).toBe(true);
  });

  it('is recomputed from its rounds, to the same figures', () => {
    const c = verdict.cellOf(rounds(31, 7, 19, 19.2, 11));
    expect(verdict.recompute(c)).toEqual(c);
  });
});

describe('stop rule 2: close to native', () => {
  const cell = (
    group: string,
    vs: number,
    inBand = true,
    dataset = 'dense',
    op = 'x',
  ): Partial<Cell> => ({
    group,
    dataset,
    op,
    vsNative: vs,
    controlInBand: inBand,
  });

  it('allows a group whose worst cell is exactly 3 times native, and not one a hair past it', () => {
    const at = verdict.groupsOf([cell('has', 3), cell('has', 1.2, true, 'sparse')]);
    expect(at[0]!.close).toBe(true);
    expect(at[0]!.worst).toBe(3);
    const past = verdict.groupsOf([cell('has', 3.0001)]);
    expect(past[0]!.close).toBe(false);
  });

  it('judges the whole group: one cell outside keeps every other from the words, and names the cell', () => {
    const g = verdict.groupsOf([
      cell('combine', 1.1),
      cell('combine', 4.2, true, 'runs', 'or returning'),
    ]);
    expect(g[0]!.close).toBe(false);
    expect(g[0]!.worstCell).toBe('runs or returning');
  });

  it('does not call a group close when one of its controls was out of band', () => {
    expect(verdict.groupsOf([cell('clone', 1.0), cell('clone', 0.9, false)])[0]!.close).toBe(false);
  });

  it('keeps groups apart', () => {
    const g = verdict.groupsOf([cell('a', 1), cell('b', 9)]);
    expect(g.map((x) => [x.group, x.close])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('has the bars the design fixed', () => {
    expect(verdict.CLOSE_BAR).toBe(3);
    expect(verdict.SHIP_BAR).toBe(10);
    expect(verdict.CONTROL_BAND).toBe(0.02);
  });
});

describe('stop rule 3: more than 10 times native', () => {
  const cell = (method: string, vs: number, op = 'op'): Partial<Cell> => ({
    method,
    dataset: 'dense',
    op,
    vsNative: vs,
  });

  it('names a method above 10, not one at exactly 10, worst first', () => {
    expect(verdict.overShipBar([cell('a', 10)])).toEqual([]);
    const over = verdict.overShipBar([cell('a', 10.01), cell('b', 30, 'b cell'), cell('a', 11)]);
    expect(over.map((o) => [o.method, o.worst, o.cell])).toEqual([
      ['b', 30, 'dense b cell'],
      ['a', 11, 'dense op'],
    ]);
  });
});

describe('the gate over the record', () => {
  const pass = (over: Record<string, unknown> = {}, cellOver: Record<string, unknown> = {}) => ({
    pass: 1,
    rule: verdict.RULE,
    environment: { smoke: false, anyLoad: false },
    cells: [
      { dataset: 'dense', op: 'has', answersAgree: true, rounds: rounds(31, 10, 20), ...cellOver },
    ],
    ...over,
  });

  it('accepts a clean pass', () => {
    expect(verdict.gateProblems([pass()])).toEqual([]);
  });

  it('refuses a smoke pass, disagreeing subjects, a round kept at load 6 and a pass read by another rule', () => {
    expect(verdict.gateProblems([pass({ environment: { smoke: true } })]).join('\n')).toContain(
      'smoke pass',
    );
    expect(verdict.gateProblems([pass({}, { answersAgree: false })]).join('\n')).toContain(
      'different answers',
    );
    expect(
      verdict.gateProblems([pass({}, { rounds: rounds(31, 10, 20, 20, null, 6) })]).join('\n'),
    ).toContain('kept a round that ended at load 6');
    expect(verdict.gateProblems([pass({ rule: 'old' })]).join('\n')).toContain('not bitmap-api-v1');
  });

  it('lets a round at load 5.99 stand, and a pass that recorded the load rule off', () => {
    expect(
      verdict.gateProblems([pass({}, { rounds: rounds(31, 10, 20, 20, null, 5.99) })]),
    ).toEqual([]);
    expect(
      verdict.gateProblems([
        pass(
          { environment: { smoke: false, anyLoad: true } },
          { rounds: rounds(31, 10, 20, 20, null, 9) },
        ),
      ]),
    ).toEqual([]);
  });

  it('reads every pass, so a later clean one does not erase an earlier fault', () => {
    expect(
      verdict.gateProblems([pass({}, { answersAgree: false }), pass({ pass: 2 })]).join('\n'),
    ).toContain('pass 1');
  });

  it('takes the last pass that is not a smoke pass as the record', () => {
    const a = { pass: 1, environment: { smoke: false } };
    const smoke = { pass: 2, environment: { smoke: true } };
    expect(verdict.passOfRecord({ passes: [a, smoke] })).toBe(a);
    expect(verdict.passOfRecord({ passes: [smoke] })).toBeUndefined();
    expect(verdict.passOfRecord({ passes: [] })).toBeUndefined();
  });
});
