import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rule that judges the paired before-and-after bench (`bench/lib/paired-verdict.cjs`), held at its boundaries, the
 * gate that reads every pass, and the committed evidence (`bench/ts-codec-paired-results.json`), when it is committed,
 * held to the rule each pass records: every median, interval and verdict in the file is recomputed from the rounds
 * beside it. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

/** `[order, base, head, control, loadAtStart, loadAtEnd]`, or the first recorded pass's layout, which has one load at the end. */
type Round = number[];
type Cell = {
  dataset?: string;
  op?: string;
  answersAgree: boolean;
  rounds: Round[];
  discarded?: Round[];
  verdict: string;
  headInterval: number[];
  [field: string]: unknown;
};
type Pass = {
  pass: number;
  schema?: number;
  unit?: string;
  rule?: string;
  explained?: string;
  unresolved?: Record<string, string>;
  reads: Cell[];
  write?: Cell[];
  ops?: Cell[];
  import?: { runs: number; moduleLoadMs: Cell };
  verdict: string;
  started: string;
  environment: {
    rounds: number;
    tree: string;
    base: string;
    head: string;
    anyLoad?: boolean;
    smoke?: boolean;
  };
};
type Interval = { lower: number; upper: number; k: number; coverage: number };
const rule = require_('./lib/paired-verdict.cjs') as {
  CONTROL_BAND: number;
  TOLERANCE: number;
  MAX_LOAD: number;
  RULE: string;
  WITHIN: string;
  SLOWER: string;
  FASTER: string;
  INCONCLUSIVE: string;
  MALFORMED: string;
  LEGACY: { WITHIN: string; SLOWER: string; FASTER: string };
  medianInterval: (values: number[], coverage?: number) => Interval;
  differencesOf: (rounds: Round[]) => { head: number[]; headVsBase: number[]; control: number[] };
  judge: (
    rounds: Round[],
    tolerance?: number,
  ) => { verdict: string; headVsReference: number; headInterval: number[]; controlVsBase: number };
  cellOf: (rounds: Round[], places?: number, tolerance?: number) => Cell;
  UNIT: string;
  nsToMs: (ns: number, decimals?: number) => number;
  figurePlaces: (kind: 'whole' | 'tenth' | 'import', unit?: string) => number;
  legacyBandOf: (q: number[]) => number;
  legacyVerdictOf: (head: number, control: number, q: number[]) => string;
  worstPaired: (vs: string[]) => string;
  kindOf: (v: string) => string;
  boundText: (upper: number | null) => string;
  keepRound: (loadAtEnd: number, anyLoad?: boolean) => boolean;
  gateProblems: (passes: unknown[]) => string[];
  SLEEP_FACTOR: number;
  sleepHits: (figureRows: number[][][]) => boolean[];
  awakeRounds: (rounds: Round[]) => Round[];
  collectRounds: (options: {
    want: number;
    takeOne: (order: number) => TakenRound;
    triplesOf: (samples: number[]) => number[][];
    checkSleep?: boolean;
    keepByLoad?: (round: TakenRound) => boolean;
    limit?: number;
  }) => { kept: TakenRound[]; discarded: TakenRound[]; slept: TakenRound[] };
  effectiveOf: (cell: Cell) => { verdict: string; headInterval: number[] };
};
type TakenRound = { order: number; start: number; end: number; samples: number[] };
const codec = require_('./lib/codec-verdict.cjs') as {
  MIN_ROUNDS: number;
  summarise: (rounds: Round[], places?: number) => Record<string, number | number[]>;
};
const { WITHIN, SLOWER, FASTER, INCONCLUSIVE, MALFORMED, judge, medianInterval, worstPaired } =
  rule;

/** 31 rounds whose head, as a fraction over the reference (base and control both 100), is each of `heads`. */
function roundsOfHeads(heads: number[], control = 100): Round[] {
  return heads.map((d, i) => [i % 6, 100, 100 * (1 + d), control, 1, 1]);
}
/** 31 head differences whose interval at the rule's coverage is exactly [lower, upper] (k = 10 of 31). */
function headsWithInterval(lower: number, upper: number): number[] {
  return [
    ...new Array<number>(9).fill(lower - 0.03),
    lower,
    ...new Array<number>(11).fill((lower + upper) / 2),
    upper,
    ...new Array<number>(9).fill(upper + 0.03),
  ];
}

describe('the median interval', () => {
  it('is the 10th smallest to the 10th largest of 31 values, at 97.06% coverage', () => {
    const values = Array.from({ length: 31 }, (_, i) => i + 1);
    const got = medianInterval(values.slice().reverse());
    expect([got.lower, got.upper, got.k]).toEqual([10, 22, 10]);
    expect(got.coverage).toBeCloseTo(0.971, 3);
  });

  it('takes the largest k that keeps 95%: 61 rounds give k = 23, and a stricter coverage a smaller k', () => {
    const values = Array.from({ length: 61 }, (_, i) => i + 1);
    const got = medianInterval(values);
    expect([got.lower, got.upper, got.k]).toEqual([23, 39, 23]);
    expect(got.coverage).toBeCloseTo(0.9604, 4);
    expect(medianInterval(values, 0.97).k).toBeLessThan(23);
  });

  it('is unbounded when no rank reaches the coverage, so a verdict drawn from it cannot pass', () => {
    const got = medianInterval([1, 2, 3, 4, 5]);
    expect(got.lower).toBe(Number.NEGATIVE_INFINITY);
    expect(got.upper).toBe(Number.POSITIVE_INFINITY);
    expect(judge(roundsOfHeads([0, 0, 0, 0, 0])).verdict).toBe(INCONCLUSIVE);
  });
});

describe('the paired verdict rule', () => {
  it('calls a head that is the base within the bar', () => {
    const got = judge(roundsOfHeads(new Array<number>(31).fill(0)));
    expect(got.verdict).toBe(WITHIN);
    expect(got.headInterval).toEqual([0, 0]);
  });

  it('compares the head with the mean of the base and the control', () => {
    const d = rule.differencesOf([[0, 100, 102, 104, 1, 1]]);
    expect(d.head[0]).toBeCloseTo(0, 12);
    expect(d.headVsBase[0]).toBeCloseTo(0.02, 12);
    expect(d.control[0]).toBeCloseTo(0.04, 12);
  });

  it('is within when the interval ends exactly at the bar, and open just above it', () => {
    expect(judge(roundsOfHeads(headsWithInterval(-0.01, 0.02))).verdict).toBe(WITHIN);
    expect(judge(roundsOfHeads(headsWithInterval(-0.01, 0.0201))).verdict).toBe(INCONCLUSIVE);
  });

  it('is inconclusive for an interval of [-1%, +2.5%]: it cannot rule out a 2.5% tax', () => {
    const got = judge(roundsOfHeads(headsWithInterval(-0.01, 0.025)));
    expect(got.verdict).toBe(INCONCLUSIVE);
    expect(got.headInterval[0]).toBeCloseTo(-0.01, 9);
    expect(got.headInterval[1]).toBeCloseTo(0.025, 9);
  });

  it('is slower only when the whole interval is above the bar', () => {
    expect(judge(roundsOfHeads(headsWithInterval(0.0201, 0.04))).verdict).toBe(SLOWER);
    expect(judge(roundsOfHeads(headsWithInterval(0.02, 0.04))).verdict).toBe(INCONCLUSIVE);
  });

  it('is faster only when the whole interval is below minus the bar', () => {
    expect(judge(roundsOfHeads(headsWithInterval(-0.05, -0.0201))).verdict).toBe(FASTER);
    expect(judge(roundsOfHeads(headsWithInterval(-0.05, -0.02))).verdict).toBe(WITHIN);
  });

  it('does not call a head at +6% within when the control is noisy (interquartile range 15% either way)', () => {
    // Control rounds scatter from -15% to +15% around the base, with a median of 0: the instrument passes its check,
    // and the head at +6% of the base is lost in the reference's noise. The earlier rule widened its band to fit.
    const rounds: Round[] = Array.from({ length: 31 }, (_, i) => {
      const control = 100 * (1 + (i - 15) * 0.01);
      return [i % 6, 100, 106, control, 1, 1];
    });
    const got = judge(rounds);
    expect(got.verdict).not.toBe(WITHIN);
    expect(rule.legacyVerdictOf(0.06, 0, [-0.15, 0.15])).toBe(rule.LEGACY.WITHIN);
  });

  it('takes the control as an instrument check: a median past +-2% makes the cell inconclusive', () => {
    const calm = new Array<number>(31).fill(0);
    expect(judge(roundsOfHeads(calm, 102)).verdict).toBe(WITHIN);
    expect(judge(roundsOfHeads(calm, 102.01)).verdict).toBe(INCONCLUSIVE);
    expect(judge(roundsOfHeads(calm, 97.99)).verdict).toBe(INCONCLUSIVE);
    expect(judge(roundsOfHeads(new Array<number>(31).fill(-0.5), 103)).verdict).toBe(INCONCLUSIVE);
  });

  it('calls a figure that is not a positive number, or no rounds, malformed, never a pass', () => {
    const ok = roundsOfHeads(new Array<number>(31).fill(0));
    expect(judge(ok.map((r, i) => (i === 3 ? [0, 100, Number.NaN, 100, 1, 1] : r))).verdict).toBe(
      MALFORMED,
    );
    expect(judge(ok.map((r, i) => (i === 3 ? [0, 0, 100, 100, 1, 1] : r))).verdict).toBe(MALFORMED);
    expect(judge([]).verdict).toBe(MALFORMED);
  });

  it('keeps the rounds whole and the figures it derives in the cell, the unbounded ends as they are', () => {
    const rounds = roundsOfHeads(headsWithInterval(-0.01, 0.01));
    const cell = rule.cellOf(rounds);
    expect(cell.rounds).toBe(rounds);
    expect(cell).toMatchObject({
      baseMedian: 100,
      controlMedian: 100,
      headInterval: [-0.01, 0.01],
      verdict: WITHIN,
    });
  });

  it('takes the worst of a list over both rules wording: malformed, slower, inconclusive, faster, within', () => {
    expect(worstPaired([WITHIN, WITHIN])).toBe(WITHIN);
    expect(worstPaired([WITHIN, FASTER])).toBe(FASTER);
    expect(worstPaired([FASTER, INCONCLUSIVE])).toBe(INCONCLUSIVE);
    expect(worstPaired([INCONCLUSIVE, SLOWER, WITHIN])).toBe(SLOWER);
    expect(worstPaired([rule.LEGACY.WITHIN, rule.LEGACY.SLOWER, INCONCLUSIVE])).toBe(
      rule.LEGACY.SLOWER,
    );
    expect(worstPaired([SLOWER, MALFORMED])).toBe(MALFORMED);
    expect(worstPaired([])).toBe(MALFORMED);
    expect(rule.kindOf('anything else')).toBe('malformed');
  });
});

describe('the earlier rule, kept to recompute the first pass', () => {
  const QUIET = [-0.004, 0.004];
  it('puts the head inside, above or below a band of half the control interquartile range, at least 1%', () => {
    expect(rule.legacyBandOf([-0.004, 0.004])).toBe(0.01);
    expect(rule.legacyBandOf([-0.03, 0.03])).toBe(0.03);
    expect(rule.legacyVerdictOf(0.01, 0, QUIET)).toBe(rule.LEGACY.WITHIN);
    expect(rule.legacyVerdictOf(0.0101, 0, QUIET)).toBe(rule.LEGACY.SLOWER);
    expect(rule.legacyVerdictOf(-0.0101, 0, QUIET)).toBe(rule.LEGACY.FASTER);
    expect(rule.legacyVerdictOf(0, 0.0301, QUIET)).toBe(INCONCLUSIVE);
    expect(rule.legacyVerdictOf(Number.NaN, 0, QUIET)).toBe(MALFORMED);
    expect(rule.legacyVerdictOf(0, 0, [])).toBe(MALFORMED);
  });
});

describe('the unit of a record', () => {
  it('divides nanoseconds by a million exactly, by moving the digits', () => {
    expect(rule.nsToMs(491533)).toBe(0.491533);
    expect(rule.nsToMs(1063148 * 1e6 + 369958)).toBe(1063148.369958);
    expect(rule.nsToMs(110419750)).toBe(110.41975);
    expect(rule.nsToMs(1)).toBe(0.000001);
    expect(rule.nsToMs(0)).toBe(0);
    expect(rule.nsToMs(1000000)).toBe(1);
    expect(rule.nsToMs(12.3, 1)).toBe(0.0000123);
    expect(rule.nsToMs(5, 1)).toBe(0.000005);
    expect(() => rule.nsToMs(-1)).toThrow(RangeError);
    expect(() => rule.nsToMs(Number.NaN)).toThrow(RangeError);
  });
  it('leaves no run of twelve digits in a duration of up to a thousand seconds, nor a day', () => {
    const digits = (x: number): string => JSON.stringify(rule.nsToMs(x));
    for (const ns of [1e12 - 1, 1e12, 864e11, 123456789 * 1e6 + 12345]) {
      expect(digits(ns), String(ns)).not.toMatch(/\d{12}/);
    }
    expect(JSON.stringify(rule.nsToMs(123456789 * 1e3 + 12.3, 1))).not.toMatch(/\d{12}/);
  });
  it('rounds a stored duration to six places, seven for a tenth of a nanosecond, and three for the import', () => {
    expect(rule.figurePlaces('whole', rule.UNIT)).toBe(6);
    expect(rule.figurePlaces('tenth', rule.UNIT)).toBe(7);
    expect(rule.figurePlaces('import', rule.UNIT)).toBe(3);
    expect(rule.figurePlaces('whole')).toBe(0);
    expect(rule.figurePlaces('tenth')).toBe(1);
    expect(rule.figurePlaces('import')).toBe(3);
  });
  it('gives the same figures and verdict whether the rounds are read in nanoseconds or in milliseconds', () => {
    const ns: Round[] = [];
    for (let i = 0; i < 31; i++) {
      const base = 480000 + ((i * 7919) % 5000);
      ns.push([i % 6, base, base + ((i * 104729) % 3000), base + ((i * 31) % 2000), 1, 2]);
    }
    const ms = ns.map((r) => [r[0], ...r.slice(1, 4).map((x) => rule.nsToMs(x)), r[4], r[5]]);
    const old = rule.cellOf(ns, 0);
    const now = rule.cellOf(ms, 6);
    expect(now.verdict).toBe(old.verdict);
    expect(now.headInterval).toEqual(old.headInterval);
    expect(now.headVsReference).toBe(old.headVsReference);
    expect(now.controlVsBase).toBe(old.controlVsBase);
    expect(now.baseMedian).toBe(rule.nsToMs(old.baseMedian as number));
    expect(now.headMedian).toBe(rule.nsToMs(old.headMedian as number));
    expect(judge(ms).verdict).toBe(judge(ns).verdict);
    expect(judge(ms).headInterval[1]).toBeCloseTo(judge(ns).headInterval[1], 12);
  });
});

/** 31 rounds of the three figures, each 100 ms, with `plant` (round index, subject 1..3) set to the given figure. */
function flatRounds(plant: Record<string, number> = {}, n = 31): Round[] {
  return Array.from({ length: n }, (_, i) => {
    const r = [i % 6, 100, 100, 100, 1, 2];
    for (const subject of [1, 2, 3]) r[subject] = plant[`${i}:${subject}`] ?? 100;
    return r;
  });
}

describe('the sleep rule', () => {
  it('is ten times the median of that subject in the cell', () => {
    expect(rule.SLEEP_FACTOR).toBe(10);
  });
  it('keeps a round whose figure is exactly ten times the median and sets aside one just above it, for each subject', () => {
    for (const subject of [1, 2, 3]) {
      const at = rule.awakeRounds(flatRounds({ [`7:${subject}`]: 1000 }));
      expect(at, `subject ${subject} at 10x`).toHaveLength(31);
      const above = rule.awakeRounds(flatRounds({ [`7:${subject}`]: 1000.001 }));
      expect(above, `subject ${subject} above 10x`).toHaveLength(30);
      expect(above.some((r) => r[0] === 7 && r[subject] === 1000.001)).toBe(false);
    }
  });
  it('sets aside a planted sleep-hit round whole, whichever subject slept, and leaves the other rounds as they were', () => {
    const rounds = flatRounds({ '3:2': 1e6, '20:1': 5e5 });
    const awake = rule.awakeRounds(rounds);
    expect(awake).toHaveLength(29);
    expect(awake).toEqual(rounds.filter((_, i) => i !== 3 && i !== 20));
  });
  it('does not touch an ordinary slow round (five times the median), nor a cell with no outlier', () => {
    expect(rule.awakeRounds(flatRounds({ '4:2': 500, '9:3': 499 }))).toHaveLength(31);
    expect(rule.awakeRounds(flatRounds())).toHaveLength(31);
  });
  it('judges each subject against its own median, so a slow subject is not a sleeping one', () => {
    const rounds = flatRounds().map((r) => [r[0], 100, 900, 100, 1, 2]);
    expect(rule.awakeRounds(rounds)).toHaveLength(31);
  });
  it('sets a round aside when any one cell of it slept', () => {
    const rows = Array.from({ length: 31 }, () => [
      [10, 10, 10],
      [20, 20, 20],
    ]);
    rows[5]![1] = [20, 20, 201];
    const hits = rule.sleepHits(rows);
    expect(hits.filter(Boolean)).toHaveLength(1);
    expect(hits[5]).toBe(true);
    rows[5]![1] = [20, 20, 200];
    expect(rule.sleepHits(rows).some(Boolean)).toBe(false);
  });
  it('takes a replacement for a slept round, counts it, and keeps the rounds it wants', () => {
    const feed = flatRounds({ '2:1': 1e9 }, 40).map((r, i) => ({
      order: r[0]!,
      start: 1,
      end: 2,
      samples: [r[1]!, r[2]!, r[3]!],
      i,
    }));
    let next = 0;
    const out = rule.collectRounds({
      want: 31,
      takeOne: () => feed[next++]!,
      triplesOf: (samples) => [samples],
    });
    expect(out.kept).toHaveLength(31);
    expect(out.slept).toHaveLength(1);
    expect(out.slept[0]!.samples[0]).toBe(1e9);
    expect(next).toBe(32);
    expect(out.discarded).toEqual([]);
  });
  it('counts a load discard apart from a slept round, and gives up when too many rounds sleep', () => {
    let n = 0;
    const out = rule.collectRounds({
      want: 5,
      takeOne: () => ({ order: 0, start: 1, end: n++ === 1 ? 9 : 2, samples: [1, 1, 1] }),
      triplesOf: (samples) => [samples],
      keepByLoad: (r) => r.end < 6,
    });
    expect(out.discarded).toHaveLength(1);
    expect(out.slept).toHaveLength(0);
    let t = 0;
    expect(() =>
      rule.collectRounds({
        want: 6,
        limit: 1,
        takeOne: () => ({ order: 0, start: 1, end: 2, samples: [t++ % 4 === 0 ? 1e9 : 1, 1, 1] }),
        triplesOf: (samples) => [samples],
      }),
    ).toThrow(/slept/);
  });
  it('is not applied when switched off (a tiny-scale run)', () => {
    const feed = flatRounds({ '1:1': 1e9 }, 3).map((r) => ({
      order: r[0]!,
      start: 1,
      end: 2,
      samples: [r[1]!, r[2]!, r[3]!],
    }));
    let next = 0;
    const out = rule.collectRounds({
      want: 3,
      takeOne: () => feed[next++]!,
      triplesOf: (samples) => [samples],
      checkSleep: false,
    });
    expect(out.kept).toHaveLength(3);
    expect(out.slept).toEqual([]);
  });
  it('reads a recorded cell without its slept rounds: twelve slept heads leave it within, not open', () => {
    const plant: Record<string, number> = {};
    for (let i = 0; i < 12; i++) plant[`${i * 2}:2`] = 1e8;
    const rounds = flatRounds(plant);
    const stored = rule.cellOf(rounds, 6);
    expect(stored.verdict).toBe(INCONCLUSIVE);
    const cell = { ...stored, dataset: 'dense', op: 'has', answersAgree: true };
    expect(rule.effectiveOf(cell).verdict).toBe(WITHIN);
    expect(rule.effectiveOf({ ...cell, rounds: flatRounds() }).verdict).toBe(stored.verdict);
    const pass = passOf([], { reads: [cell] });
    expect(rule.gateProblems([pass])).toEqual([]);
    const unread = passOf([], { reads: [{ ...cell, rounds: [[0, 100, 100, 100, 1, 2]] }] });
    expect(rule.gateProblems([unread])).toEqual([
      expect.stringContaining('dense has is inconclusive'),
    ]);
  });
});

describe('the load rule', () => {
  it('keeps a round that ends under 6 and sets aside one that ends at 6 or more', () => {
    expect(rule.keepRound(5.99)).toBe(true);
    expect(rule.keepRound(6)).toBe(false);
    expect(rule.keepRound(8.65)).toBe(false);
  });
  it('keeps every round when the rule is turned off', () => {
    expect(rule.keepRound(8.65, true)).toBe(true);
  });
});

/** A pass of schema 2 with cells of the given verdicts; the cells' rounds are real, so the gate can read their loads. */
function passOf(
  verdicts: string[],
  extra: Partial<Pass> = {},
  cellExtra: Partial<Cell> = {},
  pass = 1,
): Pass {
  const cell = (verdict: string, i: number): Cell => ({
    dataset: 'dense',
    op: `op${i}`,
    answersAgree: true,
    verdict,
    headInterval: [0.0, 0.0321],
    rounds: [[0, 100, 100, 100, 1, 2]],
    ...cellExtra,
  });
  return {
    pass,
    schema: 2,
    rule: rule.RULE,
    reads: verdicts.map(cell),
    write: [],
    import: { runs: 0, moduleLoadMs: cell(WITHIN, 99) },
    verdict: '',
    started: '',
    environment: { rounds: 31, tree: 'clean', base: '', head: '' },
    ...extra,
  };
}

describe('the gate', () => {
  it('passes when every cell is within', () => {
    expect(rule.gateProblems([passOf([WITHIN, FASTER])])).toEqual([]);
  });

  it('fails on a conclusive slower in the only pass', () => {
    expect(rule.gateProblems([passOf([WITHIN, SLOWER])])).toEqual([
      'pass 1: dense op1 is conclusively slower and the pass has no "explained" note',
    ]);
  });

  it('fails on a slower in pass 1 even when a green pass 2 follows: a re-take never erases it', () => {
    const problems = rule.gateProblems([passOf([SLOWER]), passOf([WITHIN], {}, {}, 2)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pass 1');
  });

  it('lets a slower stand when its pass carries an explained note', () => {
    expect(rule.gateProblems([passOf([SLOWER], { explained: 'the base was rebuilt' })])).toEqual(
      [],
    );
  });

  it('reads the per-operation and write cells as it reads the reads, and not the import cell', () => {
    const ops = passOf([WITHIN]);
    ops.ops = [{ ...ops.reads[0]!, dataset: 'ops', op: 'decode first dense', verdict: SLOWER }];
    expect(rule.gateProblems([ops])).toEqual([
      'pass 1: ops decode first dense is conclusively slower and the pass has no "explained" note',
    ]);
    const write = passOf([WITHIN]);
    write.write = [{ ...write.reads[0]!, op: 'erase', verdict: SLOWER }];
    expect(rule.gateProblems([write])).toHaveLength(1);
    const imp = passOf([WITHIN]);
    imp.import!.moduleLoadMs.verdict = SLOWER;
    expect(rule.gateProblems([imp])).toEqual([]);
  });

  it('fails a cell left inconclusive in the last pass unless a note quotes its bound', () => {
    const open = passOf([INCONCLUSIVE]);
    expect(rule.gateProblems([open])).toEqual([
      'last pass: dense op0 is inconclusive and has no "unresolved" note that quotes its bound +3.2%',
    ]);
    const wrong = passOf([INCONCLUSIVE], { unresolved: { 'dense op0': 'cannot rule out +9.9%' } });
    expect(rule.gateProblems([wrong])).toHaveLength(1);
    const right = passOf([INCONCLUSIVE], {
      unresolved: { 'dense op0': 'cannot rule out up to +3.2%' },
    });
    expect(rule.gateProblems([right])).toEqual([]);
  });

  it('does not ask an earlier pass for a note: only the last pass has to be resolved', () => {
    expect(rule.gateProblems([passOf([INCONCLUSIVE]), passOf([WITHIN], {}, {}, 2)])).toEqual([]);
  });

  it('needs the last pass judged by the current rule', () => {
    const old = passOf([WITHIN], { rule: undefined, schema: undefined });
    expect(rule.gateProblems([old])).toEqual([
      expect.stringContaining('judged by the earlier rule'),
    ]);
  });

  it('fails a kept round that ended at a load of 6 or more, unless the pass turned the rule off', () => {
    const loaded = passOf([WITHIN], {}, { rounds: [[0, 100, 100, 100, 1, 6]] });
    expect(rule.gateProblems([loaded])).toEqual([
      'pass 1: dense op0 kept a round that ended at load 6',
    ]);
    const just = passOf([WITHIN], {}, { rounds: [[0, 100, 100, 100, 1, 5.99]] });
    expect(rule.gateProblems([just])).toEqual([]);
    const off = passOf(
      [WITHIN],
      { environment: { rounds: 31, tree: 'clean', base: '', head: '', anyLoad: true } },
      { rounds: [[0, 100, 100, 100, 1, 9]] },
    );
    expect(rule.gateProblems([off])).toEqual([]);
  });

  it('refuses a smoke pass, and a record with no pass', () => {
    const smoke = passOf([WITHIN], {
      environment: { rounds: 3, tree: 'clean', base: '', head: '', smoke: true },
    });
    expect(rule.gateProblems([smoke])).toEqual(['pass 1: a smoke pass is no evidence']);
    expect(rule.gateProblems([])).toEqual(['no pass is recorded']);
  });

  it('quotes a bound it cannot give as unbounded', () => {
    expect(rule.boundText(0.0321)).toBe('+3.2%');
    expect(rule.boundText(-0.004)).toBe('-0.4%');
    expect(rule.boundText(null)).toBe('unbounded');
    expect(rule.boundText(Number.POSITIVE_INFINITY)).toBe('unbounded');
  });
});

describe('the committed paired results', () => {
  const file = join(ROOT, 'bench', 'ts-codec-paired-results.json');
  const passes = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { passes: Pass[] }).passes
    : null;
  const cellsOf = (p: Pass): Cell[] => [...p.reads, ...(p.write ?? []), ...(p.ops ?? [])];

  it.skipIf(passes === null)(
    'keeps every pass, numbered from 1 without a gap, each with its time and commits',
    () => {
      expect(passes!.length).toBeGreaterThan(0);
      passes!.forEach((p, i) => {
        expect(p.pass, `pass ${i + 1}`).toBe(i + 1);
        expect(Number.isNaN(Date.parse(p.started))).toBe(false);
        expect(p.environment.base).toMatch(/^[0-9a-f]{40}$/);
        expect(p.environment.head).toMatch(/^[0-9a-f]{40}$/);
      });
    },
  );

  it.skipIf(passes === null)(
    'recomputes every median, interval and verdict of every pass from its rounds, by the rule the pass records',
    () => {
      for (const doc of passes!) {
        const cells = [...cellsOf(doc), ...(doc.import ? [doc.import.moduleLoadMs] : [])];
        expect(cells.length).toBeGreaterThan(10);
        for (const c of cells) {
          const name = `pass ${doc.pass} ${c.dataset ?? 'import'} ${c.op ?? ''}`;
          expect(c.rounds.length, name).toBeGreaterThanOrEqual(codec.MIN_ROUNDS);
          if (doc.rule === undefined) {
            const s = codec.summarise(c.rounds, 0);
            expect(c.typescriptVsNative, name).toBe(s.typescriptVsNative);
            expect(c.controlVsNative, name).toBe(s.controlVsNative);
            expect(c.verdict, name).toBe(
              rule.legacyVerdictOf(
                s.typescriptVsNative as number,
                s.controlVsNative as number,
                s.controlQuartiles as number[],
              ),
            );
          } else {
            expect(doc.rule, name).toBe(rule.RULE);
            const kind =
              c === doc.import?.moduleLoadMs ? 'import' : c.dataset === 'ops' ? 'tenth' : 'whole';
            const places = rule.figurePlaces(kind, doc.unit);
            const left = new Set(['rounds', 'discarded', 'dataset', 'op', 'answersAgree']);
            const figures = Object.fromEntries(Object.entries(c).filter(([k]) => !left.has(k)));
            // Through JSON, as the file holds it: a recomputed -0 is stored as 0.
            const fresh = JSON.parse(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(rule.cellOf(c.rounds, places)).filter(([k]) => k !== 'rounds'),
                ),
              ),
            ) as Record<string, unknown>;
            expect(figures, name).toEqual(fresh);
            for (const r of c.rounds) expect(r, name).toHaveLength(6);
          }
        }
        for (const c of cellsOf(doc)) expect(c.answersAgree).toBe(true);
        expect(doc.verdict).toBe(worstPaired(cellsOf(doc).map((c) => c.verdict)));
      }
    },
  );

  it.skipIf(passes === null)(
    'holds slept rounds only where a pass was recorded before the sleep rule, and reading it without them changes no verdict',
    () => {
      const found: string[] = [];
      for (const doc of passes!) {
        if (doc.rule !== rule.RULE) continue;
        const cells = [...cellsOf(doc), ...(doc.import ? [doc.import.moduleLoadMs] : [])];
        for (const c of cells) {
          const slept = c.rounds.length - rule.awakeRounds(c.rounds).length;
          if (slept > 0) found.push(`pass ${doc.pass} ${c.dataset} ${c.op}: ${slept}`);
          expect(rule.effectiveOf(c).verdict, `pass ${doc.pass} ${c.dataset} ${c.op}`).toBe(
            c.verdict,
          );
        }
      }
      expect(found).toEqual(['pass 2 runs iterate: 4']);
    },
  );

  it.skipIf(passes === null)('was taken on a clean tree at full strength', () => {
    for (const doc of passes!) {
      expect(doc.environment.tree).toBe('clean');
      expect(doc.environment.rounds).toBeGreaterThanOrEqual(codec.MIN_ROUNDS);
    }
  });

  it.skipIf(passes === null)(
    'passes the gate over every pass: no slower is erased, no load rule is broken, no open cell goes unquoted',
    () => {
      // The first pass was judged by the earlier rule; the gate asks for a last pass of the current rule, which the
      // re-take on the final code supplies. Until it is appended that one message is the only one allowed.
      const problems = rule
        .gateProblems(passes!)
        .filter((p) => !p.includes('judged by the earlier rule'));
      expect(problems).toEqual([]);
    },
  );
});
