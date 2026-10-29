import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  completePass,
  copyOf,
  cellOfPass,
  roundsOf,
  verdict as gate,
  withRounds,
  type Pass,
  type Round,
} from '../helpers/bitmap-api-pass';

/**
 * The rule that reads a pass of the public bitmap class's bench (`bench/lib/bitmap-api-verdict.cjs`), held at its
 * boundaries: the A/A control's band, the ratio to native and its interval, the groups stop rule 2 may call close, the
 * methods stop rule 3 stops (the cold rows included), the decision of the count kernels' own bench, and the gate over
 * the record: each way a pass can be refused is fired at a planted pass, and a clean pass and its look-alikes are not.
 * Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

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
  countKernelsRule?: unknown;
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

describe("stop rule 1 is the count kernels' own bench, read and never recomputed", () => {
  it("has no reading of this bench's own count cells as the decision", () => {
    expect(verdict.countKernelsRule).toBeUndefined();
  });
});

const COUNT = { countResult: 'kept' };

describe('the gate over the record', () => {
  const clean = () => completePass();
  const problems = (pass: Pass, opts: { countResult?: string } = COUNT) =>
    gate.gateProblems([pass], opts).join('\n');

  it('accepts a complete pass', () => {
    expect(gate.gateProblems([clean()], COUNT)).toEqual([]);
    expect(gate.isComplete(clean())).toBe(true);
    expect(gate.gateProblems([])).toEqual([]);
  });

  it('reads the tree fields: a clean pass with paths, a dirty one with unsorted paths are refused, a named dirty pass and an old one are not', () => {
    const withTree = (fields: Record<string, unknown>) => {
      const pass = clean();
      Object.assign(pass.environment, fields);
      return gate.gateProblems([pass], COUNT).join('\n');
    };
    expect(withTree({ tree: 'clean', dirtyPaths: ['a'], dirtyTotal: 1 })).toContain(
      'a clean tree records dirty paths',
    );
    expect(withTree({ tree: 'dirty', dirtyPaths: ['b', 'a'], dirtyTotal: 2 })).toContain(
      'not sorted and distinct',
    );
    expect(withTree({ tree: 'dirty', dirtyPaths: ['a', 'b'], dirtyTotal: 2 })).toBe('');
    expect(withTree({ tree: 'dirty' })).toBe('');
  });

  it('reads the processes a cold sample took: absent is one, five at full scale, and a record that disagrees is refused', () => {
    const pass = clean();
    expect(gate.coldProcessesOf(pass)).toBe(1);
    expect(gate.coldProcessesOf({ environment: { coldProcesses: 5 } })).toBe(5);
    pass.environment.coldProcesses = 5;
    expect(gate.gateProblems([pass], COUNT)).toEqual([]);
    const one = clean();
    one.environment.coldProcesses = 1;
    expect(problems(one)).toContain(
      'records 1 fresh processes a cold sample, but a full pass takes 5',
    );
    const three = clean();
    three.environment.coldProcesses = 3;
    expect(problems(three)).toContain('records 3 fresh processes');
    const smoke = clean();
    smoke.environment.smoke = true;
    smoke.environment.coldProcesses = 5;
    expect(problems(smoke)).toContain('but a smoke pass takes 1');
  });

  it('refuses a smoke pass, disagreeing subjects, a pass read by another rule, a malformed cell', () => {
    const smoke = clean();
    smoke.environment.smoke = true;
    expect(problems(smoke)).toContain('smoke pass');
    const disagree = clean();
    cellOfPass(disagree, 'dense has').answersAgree = false;
    expect(problems(disagree)).toContain('dense has: the subjects gave different answers');
    const old = clean();
    old.rule = 'old';
    expect(problems(old)).toContain('not bitmap-api-v1');
    const bad = clean();
    cellOfPass(bad, 'dense has').rounds[3] = [3, 0, 1, 1, null, 1, 1];
    expect(problems(bad)).toContain('dense has: malformed rounds');
  });

  describe('the load rule', () => {
    it('refuses a round kept at load 6, and lets 5.99 stand', () => {
      const late = clean();
      const cell = cellOfPass(late, 'dense has');
      cell.rounds[0]![6] = 6;
      expect(problems(late)).toContain('kept a round that ended at load 6');
      const edge = clean();
      const e = cellOfPass(edge, 'dense has');
      e.rounds[0]![6] = 5.99;
      edge.load = gate.loadFiguresOf(edge);
      expect(gate.gateProblems([edge], COUNT)).toEqual([]);
    });

    it('refuses a round set aside at a load under 6, and a pass that turned the rule off', () => {
      const early = clean();
      cellOfPass(early, 'dense has').discarded = [[0, 10, 15, 15, 12, 1, 2]];
      early.load = gate.loadFiguresOf(early);
      expect(problems(early)).toContain('set aside a round that ended at load 2, under 6');
      const off = clean();
      off.environment.anyLoad = true;
      expect(problems(off)).toContain('the load rule was turned off');
      const set = clean();
      cellOfPass(set, 'dense has').discarded = [[0, 10, 15, 15, 12, 1, 9]];
      set.load = gate.loadFiguresOf(set);
      expect(gate.gateProblems([set], COUNT)).toEqual([]);
    });

    it('holds the load part to it too', () => {
      const late = clean();
      late.loadRoundTrip[0]!.rounds[0]![4] = 40;
      expect(problems(late)).toContain('load dense kept a round that ended at load 40');
    });
  });

  describe('the round floor', () => {
    it("refuses a cell of 30 rounds, a pass that records fewer than 31, and a count that is not the rounds'", () => {
      const few = clean();
      withRounds(
        cellOfPass(few, 'dense has'),
        roundsOf(30, { native: 10, ours: 15, control: 15, internal: 12 }),
      );
      expect(problems(few)).toContain('dense has holds 30 rounds, fewer than 31');
      const records = clean();
      records.environment.rounds = 30;
      expect(problems(records)).toContain('records 30 rounds, fewer than 31');
      const lies = clean();
      lies.environment.rounds = 99;
      expect(problems(lies)).toContain('records 99 rounds a figure, the rounds hold 31');
      const fewLoad = clean();
      fewLoad.loadRoundTrip[1]!.rounds.length = 12;
      expect(problems(fewLoad)).toContain('load sparse holds 12 rounds');
    });
  });

  describe('the sleep rule', () => {
    /** A pass whose `dense has` set aside rounds of the class that slept, with the evidence of each. */
    const slept = (count: number, cpu = 10, wall = 3000) => {
      const pass = clean();
      const cell = cellOfPass(pass, 'dense has');
      cell.slept = Array.from({ length: count }, (_, i) => [
        i,
        10,
        wall,
        15,
        12,
        1,
        1,
        [{ cell: 'dense has', subject: 'head', wall, cpu }],
      ]);
      pass.load = gate.loadFiguresOf(pass);
      return pass;
    };

    it('accepts one slept round of the class with evidence that holds', () => {
      expect(gate.gateProblems([slept(1)], COUNT)).toEqual([]);
    });

    it("refuses a pass that records no sleep rule, or one weaker than the paired bench's", () => {
      const none = slept(1);
      delete none.sleepRule;
      expect(problems(none)).toContain("records no sleep rule as strict as the paired bench's");
      const weak = slept(1);
      weak.sleepRule = { factor: 1, maxOnCpu: 1 };
      expect(problems(weak)).toContain('records no sleep rule as strict');
      const clear = clean();
      delete clear.sleepRule;
      expect(problems(clear)).toContain('records no sleep rule');
    });

    it('refuses a slept round with no evidence, with a figure the record does not hold, or that is not a sleep', () => {
      const bare = slept(1);
      cellOfPass(bare, 'dense has').slept![0]!.pop();
      expect(problems(bare)).toContain('has no evidence');
      const invented = slept(1);
      (cellOfPass(invented, 'dense has').slept![0]![7] as Array<{ wall: number }>)[0]!.wall = 2999;
      expect(problems(invented)).toContain('names a slept figure the record does not hold');
      const awake = slept(1, 2900);
      expect(problems(awake)).toContain('is not a sleep');
      const quick = slept(1, 10, 1000);
      expect(problems(quick)).toContain('is not a sleep');
    });

    it('refuses a cell whose slept rounds fall on the class twice, more than on the others', () => {
      expect(problems(slept(2))).toContain('2 slept rounds on the head against 0');
      const explained = slept(2);
      cellOfPass(explained, 'dense has').explained = 'the machine slept twice';
      expect(gate.gateProblems([explained], COUNT)).toEqual([]);
    });

    it('holds the load part to it: a slept span with no evidence', () => {
      const pass = clean();
      pass.loadRoundTrip[0]!.slept = [[10, 2000, 3, 1, 1]];
      pass.load = gate.loadFiguresOf(pass);
      expect(problems(pass)).toContain('has no evidence');
    });
  });

  describe('the count decision and the route the build ran', () => {
    it("refuses a missing or unknown route, a missing decision, and a route that is not the decision's", () => {
      const missing = clean();
      delete missing.environment.countRoute;
      expect(problems(missing)).toContain('the route the build ran is not recorded');
      const unknown = clean();
      unknown.environment.countRoute = 'foo';
      expect(problems(unknown)).toContain('is unknown ("foo")');
      const noResult = clean();
      delete noResult.environment.countResult;
      expect(problems(noResult)).toContain('records no count decision');
      const wrong = clean();
      wrong.environment.countResult = 'derived';
      expect(problems(wrong)).toContain(
        'the class ran kernels and the count decision it was taken under is derived',
      );
      const other = completePass({}, { countRoute: 'build-then-count', countResult: 'kept' });
      expect(problems(other)).toContain('the class ran build-then-count');
    });

    it('accepts each route under its own decision', () => {
      const derived = completePass({}, { countRoute: 'build-then-count', countResult: 'derived' });
      expect(gate.gateProblems([derived], { countResult: 'derived' })).toEqual([]);
    });

    it('refuses a last complete pass taken under a decision the record no longer gives, or one that decides nothing', () => {
      expect(problems(clean(), { countResult: 'derived' })).toContain('now says derived');
      expect(problems(clean(), { countResult: 'invalid' })).toContain(
        'decides nothing (RESULT invalid)',
      );
      expect(problems(clean(), { countResult: 'unavailable' })).toContain('decides nothing');
      expect(gate.gateProblems([clean()])).toEqual([]);
    });

    it("does not take this bench's own count cells as the decision: a class that loses to build-then-count does not change it", () => {
      const losing = completePass(
        Object.fromEntries(
          ['dense', 'sparse', 'runs', 'mixed', 'spread8k'].map((d) => [
            `${d} andCardinality`,
            { ours: 30, internal: 10 },
          ]),
        ),
      );
      expect(gate.gateProblems([losing], COUNT)).toEqual([]);
    });
  });

  describe('a pass is complete only with every cell of the full run', () => {
    it('refuses an unmarked pass that lacks a cell, a cold cell, a load row, or holds one twice', () => {
      const lacks = clean();
      lacks.cells = lacks.cells.filter((c) => !(c.dataset === 'runs' && c.op === 'andCardinality'));
      expect(problems(lacks)).toContain('runs andCardinality: missing');
      const noCold = clean();
      noCold.cold = noCold.cold.slice(1);
      expect(problems(noCold)).toContain('cold first deserialize: missing');
      const noLoad = clean();
      noLoad.loadRoundTrip = noLoad.loadRoundTrip.slice(1);
      expect(problems(noLoad)).toContain('load dense: missing');
      const twice = clean();
      twice.cells.push(copyOf(twice.cells[0]!));
      expect(problems(twice)).toContain('held 2 times');
      const lost = clean();
      delete lost.cells[0]!.vsInternal;
      lost.cells[0]!.rounds = lost.cells[0]!.rounds.map((r) => [
        r[0]!,
        r[1]!,
        r[2]!,
        r[3]!,
        null,
        r[5]!,
        r[6]!,
      ]);
      expect(problems(lost)).toContain('no codec figure');
    });

    it('treats a pass marked partial as kept and never the one the table is judged on', () => {
      const partial = clean();
      partial.cells = partial.cells.filter((c) => c.op === 'has');
      partial.partial = '--only=has';
      expect(gate.gateProblems([partial])).toEqual([]);
      expect(gate.isComplete(partial)).toBe(false);
      const full = clean();
      expect(gate.passOfRecord({ passes: [full, partial] })).toBe(full);
      expect(gate.passOfRecord({ passes: [partial] })).toBeUndefined();
      expect(gate.passOfRecord({ passes: [] })).toBeUndefined();
      const smoke = clean();
      smoke.environment.smoke = true;
      expect(gate.passOfRecord({ passes: [smoke] })).toBeUndefined();
    });

    it('refuses to publish from a record whose passes are all partial, with its own exit code', () => {
      const partial = clean();
      partial.partial = 'no load part';
      delete (partial as { loadRoundTrip?: unknown }).loadRoundTrip;
      partial.load = gate.loadFiguresOf(partial);
      expect(gate.EXIT.partial).not.toBe(gate.EXIT.problems);
      expect(gate.gateExit([partial])).toBe(gate.EXIT.partial);
      expect(gate.gateExit([clean(), partial], COUNT)).toBe(gate.EXIT.ok);
      expect(gate.gateExit([])).toBe(gate.EXIT.ok);
      const lies = clean();
      lies.environment.countRoute = 'foo';
      expect(gate.gateExit([lies], COUNT)).toBe(gate.EXIT.problems);
    });

    it('needs a partial mark to say what it left out', () => {
      const blank = clean();
      blank.partial = '';
      expect(problems(blank)).toContain('a partial mark must say what the pass left out');
    });
  });

  describe('what a pass stores is what its rounds give', () => {
    it('refuses a hand-typed ratio, interval, control, load row figure, load summary', () => {
      const typed = clean();
      cellOfPass(typed, 'dense has').vsNative = 1.1;
      expect(problems(typed)).toContain(
        'dense has: stored vsNative 1.1 is not what the rounds give (1.5)',
      );
      const band = clean();
      cellOfPass(band, 'dense has').controlInBand = false;
      expect(problems(band)).toContain('stored controlInBand');
      const share = clean();
      share.loadRoundTrip[0]!.roundTripShare = 0.02;
      expect(problems(share)).toContain('load dense: stored roundTripShare 0.02');
      const summary = clean();
      summary.load = { maxLoadAtEnd: 0.5, discardedRounds: 0, sleptRounds: 0 };
      expect(problems(summary)).toContain('the stored load summary is not what the rounds give');
    });
  });

  it('reads every pass, so a later clean one does not erase an earlier fault', () => {
    const bad = clean();
    cellOfPass(bad, 'dense has').answersAgree = false;
    const later = clean();
    later.pass = 2;
    expect(gate.gateProblems([bad, later], COUNT).join('\n')).toContain('pass 1');
  });
});

describe('the rules read every row: the cold rows are a group of their own', () => {
  const cold = (vs: number, inBand = true, op = 'first deserialize'): Partial<Cell> => ({
    dataset: 'cold',
    op,
    method: 'RoaringBitmap.deserialize',
    group: 'cold',
    vsNative: vs,
    controlInBand: inBand,
  });

  it('keeps the cold group from being close beyond 3 times, and names the method beyond 10', () => {
    expect(verdict.groupsOf([cold(3)])[0]!.close).toBe(true);
    expect(verdict.groupsOf([cold(3.5)])[0]!.close).toBe(false);
    expect(verdict.groupsOf([cold(1, false)])[0]!.close).toBe(false);
    expect(verdict.overShipBar([cold(20)]).map((o) => [o.method, o.cell])).toEqual([
      ['RoaringBitmap.deserialize', 'cold first deserialize'],
    ]);
  });

  it('reads them from the pass: a cold row at 20 times names its method in the rules', () => {
    const pass = completePass({
      'cold first deserialize': { native: 10, ours: 200, internal: 12 },
    });
    const rows = gate.fresh(pass);
    const cells = [...rows.cells, ...rows.cold] as unknown as Array<Partial<Cell>>;
    expect(verdict.overShipBar(cells).map((o) => o.cell)).toContain('cold first deserialize');
    expect(verdict.groupsOf(cells).find((g) => g.group === 'cold')!.close).toBe(false);
  });
});

describe('the round and load figures a table prints', () => {
  it('come from the rounds, not from a stored field', () => {
    const pass = completePass();
    pass.load = { maxLoadAtEnd: 0.5, discardedRounds: 0, sleptRounds: 0 };
    pass.environment.rounds = 99;
    expect(gate.loadFiguresOf(pass).maxLoadAtEnd).toBe(1);
    expect(gate.roundCountOf(pass)).toBe(31);
    expect(gate.fresh(pass).loadRoundTrip[0]!.roundTripShare).toBe(0.5);
  });
});
