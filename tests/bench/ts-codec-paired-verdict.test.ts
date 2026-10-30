import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
  slept?: Round[];
  verdict: string;
  headInterval: number[];
  [field: string]: unknown;
};
type Pass = {
  pass: number;
  schema?: number;
  unit?: string;
  rule?: string;
  sleepRule?: { factor: number; maxOnCpu: number };
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
  SLEEP_MAX_ON_CPU: number;
  sleptFigure: (
    wall: number,
    medianWall: number,
    cpu: number,
    rule?: { factor: number; maxOnCpu: number },
  ) => boolean;
  sleepEvidence: (
    figureRows: number[][][],
    cpuRows: number[][][],
  ) => { cell: number; subject: string; wall: number; cpu: number }[][];
  collectRounds: (options: {
    want: number;
    takeOne: (order: number) => TakenRound;
    triplesOf: (samples: number[]) => number[][];
    cpuOf: (samples: number[]) => number[][];
    checkSleep?: boolean;
    keepByLoad?: (round: TakenRound) => boolean;
    limit?: number;
  }) => { kept: TakenRound[]; discarded: TakenRound[]; slept: TakenRound[] };
};
type TakenRound = {
  order: number;
  start: number;
  end: number;
  samples: number[];
  evidence?: { cell: number; subject: string; wall: number; cpu: number }[];
};
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
    const ms: Round[] = ns.map((r) => [
      r[0]!,
      ...r.slice(1, 4).map((x) => rule.nsToMs(x)),
      r[4]!,
      r[5]!,
    ]);
    const old = rule.cellOf(ns, 0);
    const now = rule.cellOf(ms, 6);
    expect(now.verdict).toBe(old.verdict);
    expect(now.headInterval).toEqual(old.headInterval);
    expect(now.headVsReference).toBe(old.headVsReference);
    expect(now.controlVsBase).toBe(old.controlVsBase);
    expect(now.baseMedian).toBe(rule.nsToMs(old.baseMedian as number));
    expect(now.headMedian).toBe(rule.nsToMs(old.headMedian as number));
    expect(judge(ms).verdict).toBe(judge(ns).verdict);
    expect(judge(ms).headInterval[1]!).toBeCloseTo(judge(ns).headInterval[1]!, 12);
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

/** A deterministic stream of numbers in [0, 1), so a planted case is the same on every run. */
function stream(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** `n` rows of one cell, each `[base, head, control]` at 100, with `plant` (round:subject, subject 0..2) set. */
function flatRows(plant: Record<string, number> = {}, n = 31): number[][][] {
  return Array.from({ length: n }, (_, i) => [[0, 1, 2].map((s) => plant[`${i}:${s}`] ?? 100)]);
}
/** The CPU figures of `rows`: each a `share` of its wall figure, unless `cpu` names one (round:subject). */
function cpuRowsOf(
  rows: number[][][],
  share: number,
  cpu: Record<string, number> = {},
): number[][][] {
  return rows.map((row, i) => row.map((t) => t.map((x, s) => cpu[`${i}:${s}`] ?? x * share)));
}
const slept = (rows: number[][][], cpuRows: number[][][]): number[] =>
  rule.sleepEvidence(rows, cpuRows).flatMap((e, i) => (e.length > 0 ? [i] : []));

describe('the sleep rule', () => {
  it('needs a figure more than 100 times its subject median and less than half of its wall time on CPU', () => {
    expect(rule.SLEEP_FACTOR).toBe(100);
    expect(rule.SLEEP_MAX_ON_CPU).toBe(0.5);
  });

  it('keeps a figure exactly 100 times the median and sets aside one just above it, for each subject, when no CPU was used', () => {
    for (const subject of [0, 1, 2]) {
      const at = flatRows({ [`7:${subject}`]: 10000 });
      expect(slept(at, cpuRowsOf(at, 0)), `subject ${subject} at 100x`).toEqual([]);
      const above = flatRows({ [`7:${subject}`]: 10000.001 });
      expect(slept(above, cpuRowsOf(above, 0)), `subject ${subject} above 100x`).toEqual([7]);
    }
  });

  it('keeps a figure that was exactly half on CPU and sets aside one just under half', () => {
    for (const subject of [0, 1, 2]) {
      const rows = flatRows({ [`7:${subject}`]: 20000 });
      expect(
        slept(rows, cpuRowsOf(rows, 1, { [`7:${subject}`]: 10000 })),
        `half, ${subject}`,
      ).toEqual([]);
      expect(
        slept(rows, cpuRowsOf(rows, 1, { [`7:${subject}`]: 9999.99 })),
        `under, ${subject}`,
      ).toEqual([7]);
    }
  });

  it('records, for a slept round, the cell, the subject, the wall figure and the CPU figure', () => {
    const rows = flatRows({ '3:1': 1e6 });
    const evidence = rule.sleepEvidence(rows, cpuRowsOf(rows, 0.01));
    expect(evidence[3]).toEqual([{ cell: 0, subject: 'head', wall: 1e6, cpu: 1e4 }]);
    expect(evidence.filter((e) => e.length > 0)).toHaveLength(1);
  });

  it('sets aside planted sleeps on random subjects when the CPU stayed flat, and nothing else', () => {
    const random = stream(7);
    const plant: Record<string, number> = {};
    const planted: number[] = [];
    for (let i = 2; i < 31; i += 6) {
      const subject = Math.floor(random() * 3);
      plant[`${i}:${subject}`] = 1e6 * (1 + random());
      planted.push(i);
    }
    const rows = flatRows(plant);
    expect(slept(rows, cpuRowsOf(rows, 0.001))).toEqual(planted);
  });

  it('does not set aside a slow round whose CPU tracked its wall time, at any size', () => {
    const rows = flatRows({ '4:1': 1500, '9:2': 1e6, '11:0': 1e9 });
    expect(slept(rows, cpuRowsOf(rows, 0.98))).toEqual([]);
    expect(slept(rows, cpuRowsOf(rows, 1.4))).toEqual([]);
  });

  it('judges each subject against its own median, so a slow subject is not a sleeping one', () => {
    const rows = flatRows().map(() => [[100, 9000, 100]]);
    expect(slept(rows, cpuRowsOf(rows, 0))).toEqual([]);
  });

  it('sets a round aside when any one cell of it slept', () => {
    const rows = Array.from({ length: 31 }, () => [
      [10, 10, 10],
      [20, 20, 20],
    ]);
    rows[5]![1] = [20, 20, 2001];
    const cpu = cpuRowsOf(rows, 0);
    expect(slept(rows, cpu)).toEqual([5]);
    expect(rule.sleepEvidence(rows, cpu)[5]).toEqual([
      { cell: 1, subject: 'control', wall: 2001, cpu: 0 },
    ]);
    rows[5]![1] = [20, 20, 2000];
    expect(slept(rows, cpuRowsOf(rows, 0))).toEqual([]);
  });

  /** A feed of taken rounds: base and control at 100 with noise of `noise`, the head at 100 or `slow` times it. */
  function feedOf(options: {
    n: number;
    share: number;
    slow: number;
    noise: number;
    seed: number;
  }): TakenRound[] {
    const random = stream(options.seed);
    const wiggle = (): number => 100 * (1 + options.noise * (2 * random() - 1));
    return Array.from({ length: options.n }, (_, i) => {
      const base = wiggle();
      const head = wiggle() * (random() < options.share ? options.slow : 1);
      const control = wiggle();
      return {
        order: i % 6,
        start: 1,
        end: 2,
        samples: [base, head, control],
      };
    });
  }
  const collect = (feed: TakenRound[], want: number, checkSleep = true) => {
    let next = 0;
    return rule.collectRounds({
      want,
      takeOne: () => feed[next++]!,
      triplesOf: (samples) => [samples],
      cpuOf: (samples) => [samples.map((x) => x * 0.5)],
      checkSleep,
    });
  };

  it('keeps a head that is 15 times slower in some rounds, with its CPU tracking its wall time, and the cell is not within the bar', () => {
    // Twelve of 31 rounds with a slow head: the rule that set them aside read this cell as within the bar.
    const plant: Record<string, number> = {};
    for (let i = 0; i < 12; i++) plant[`${i * 2}:2`] = 1500;
    const rows = flatRounds(plant);
    let next = 0;
    const out = rule.collectRounds({
      want: 31,
      takeOne: () => {
        const r = rows[next++]!;
        return { order: r[0]!, start: r[4]!, end: r[5]!, samples: [r[1]!, r[2]!, r[3]!] };
      },
      triplesOf: (samples) => [samples],
      cpuOf: (samples) => [samples.map((x) => x * 0.98)],
    });
    expect(out.slept).toEqual([]);
    expect(out.kept).toHaveLength(31);
    expect(next).toBe(31);
    const verdict = rule.cellOf(out.kept.map((r) => [r.order, ...r.samples, 1, 2])).verdict;
    expect(verdict).not.toBe(WITHIN);
    expect(verdict).toBe(INCONCLUSIVE);
  });

  it('does not set aside a round of a head that is 15 times slower in a fifth or a third of its rounds, base and control at 3% noise', () => {
    for (const share of [0.2, 0.35]) {
      const feed = feedOf({ n: 61, share, slow: 15, noise: 0.03, seed: 11 });
      let next = 0;
      const out = rule.collectRounds({
        want: 61,
        takeOne: () => feed[next++]!,
        triplesOf: (samples) => [samples],
        cpuOf: (samples) => [samples],
      });
      expect(out.slept, `share ${share}`).toEqual([]);
      expect(out.kept, `share ${share}`).toHaveLength(61);
      expect(next).toBe(61);
    }
    const third = feedOf({ n: 61, share: 0.35, slow: 15, noise: 0.03, seed: 11 });
    expect(rule.cellOf(third.map((r) => [r.order, ...r.samples, 1, 2])).verdict).not.toBe(WITHIN);
  });

  it('sets aside the same rounds when the machine was asleep (CPU flat), every one of them on the head', () => {
    const feed = feedOf({ n: 120, share: 0.2, slow: 15000, noise: 0.03, seed: 11 });
    let next = 0;
    const out = rule.collectRounds({
      want: 61,
      takeOne: () => feed[next++]!,
      triplesOf: (samples) => [samples],
      cpuOf: (samples) => [samples.map((x) => x * 0.0001)],
      limit: 100,
    });
    expect(out.slept.length).toBeGreaterThan(5);
    expect(out.slept.every((r) => r.evidence!.every((e) => e.subject === 'head'))).toBe(true);
  });

  it('takes a replacement for a slept round, counts it, and keeps the rounds it wants', () => {
    const feed = feedOf({ n: 40, share: 0, slow: 1, noise: 0, seed: 1 });
    feed[2]!.samples[0] = 1e6;
    let next = 0;
    const out = rule.collectRounds({
      want: 31,
      takeOne: () => feed[next++]!,
      triplesOf: (samples) => [samples],
      cpuOf: (samples) => [samples.map((x) => (x === 1e6 ? 1 : x))],
    });
    expect(out.kept).toHaveLength(31);
    expect(out.slept).toHaveLength(1);
    expect(out.slept[0]!.samples[0]).toBe(1e6);
    expect(out.slept[0]!.evidence).toEqual([{ cell: 0, subject: 'base', wall: 1e6, cpu: 1 }]);
    expect(next).toBe(32);
    expect(out.discarded).toEqual([]);
  });

  it('counts a load discard apart from a slept round, and gives up when too many rounds sleep', () => {
    let n = 0;
    const out = rule.collectRounds({
      want: 5,
      takeOne: () => ({ order: 0, start: 1, end: n++ === 1 ? 9 : 2, samples: [1, 1, 1] }),
      triplesOf: (samples) => [samples],
      cpuOf: (samples) => [samples],
      keepByLoad: (r) => r.end < 6,
    });
    expect(out.discarded).toHaveLength(1);
    expect(out.slept).toHaveLength(0);
    let t = 0;
    expect(() =>
      rule.collectRounds({
        want: 6,
        limit: 1,
        takeOne: () => ({ order: 0, start: 1, end: 2, samples: [t++ % 4 === 0 ? 1e6 : 1, 1, 1] }),
        triplesOf: (samples) => [samples],
        cpuOf: (samples) => [samples.map(() => 0)],
      }),
    ).toThrow(/slept/);
  });

  it('is not applied when switched off (a tiny-scale run)', () => {
    const feed = feedOf({ n: 3, share: 0, slow: 1, noise: 0, seed: 1 });
    feed[1]!.samples[0] = 1e9;
    const out = collect(feed, 3, false);
    expect(out.kept).toHaveLength(3);
    expect(out.slept).toEqual([]);
  });
});

describe('the sleep rule against a stopped process', () => {
  /** A child that spins until it has used `spinMs` of CPU, then prints its wall and CPU milliseconds. */
  const SPIN = [
    'const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e3; };',
    'const t0 = process.hrtime.bigint(); const c0 = cpu();',
    "console.log('started');",
    'while (cpu() - c0 < Number(process.argv[1])) {}',
    'console.log(JSON.stringify({ wall: Number(process.hrtime.bigint() - t0) / 1e6, cpu: cpu() - c0 }));',
  ].join('\n');
  // Every child started here is continued and then killed after each test, so an interrupted or failed run never
  // leaves a stopped process behind (a stopped process does not notice that its parent is gone).
  const children = new Set<ReturnType<typeof spawn>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  afterEach(() => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const child of children) {
      child.kill('SIGCONT');
      child.kill('SIGKILL');
    }
    children.clear();
  });
  const run = (spinMs: number, stopMs: number): Promise<{ wall: number; cpu: number }> =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ['-e', SPIN, String(spinMs)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      children.add(child);
      let out = '';
      let stopped = false;
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (stopMs > 0 && !stopped && out.includes('started')) {
          stopped = true;
          timers.add(
            setTimeout(() => {
              child.kill('SIGSTOP');
              timers.add(setTimeout(() => child.kill('SIGCONT'), stopMs));
            }, 100),
          );
        }
      });
      child.on('error', reject);
      child.on('close', () => {
        const line = out.trim().split('\n').pop()!;
        resolveRun(JSON.parse(line) as { wall: number; cpu: number });
      });
    });

  it.skipIf(process.platform === 'win32')(
    'a process stopped for two seconds mid-span: wall advances, CPU does not, and the figure is slept',
    async () => {
      const got = await run(400, 2000);
      expect(got.wall).toBeGreaterThan(2000);
      expect(got.cpu).toBeLessThan(0.5 * got.wall);
      expect(rule.sleptFigure(got.wall, 10, got.cpu)).toBe(true);
    },
    20000,
  );

  it.skipIf(process.platform === 'win32')(
    'a span with no stop: CPU tracks wall, and a figure over 100 times a small median is not slept',
    async () => {
      let best = { wall: 0, cpu: 0 };
      // The share is the machine's to give; the best of three keeps a busy runner from deciding the test.
      for (let attempt = 0; attempt < 3 && best.cpu < 0.5 * best.wall + 1e-9; attempt++) {
        const got = await run(450, 0);
        if (attempt === 0 || got.cpu / got.wall > best.cpu / best.wall) best = got;
      }
      expect(best.cpu).toBeGreaterThan(0.5 * best.wall);
      expect(best.wall).toBeGreaterThan(100 * 3);
      expect(rule.sleptFigure(best.wall, 3, best.cpu)).toBe(false);
    },
    20000,
  );
});

/** A pass with one read cell: 31 flat rounds and the given slept rows (the import cell holds none). */
function passWithSlept(
  sleptRows: unknown[][],
  extra: Partial<Pass> = {},
  cellExtra: Partial<Cell> = {},
): Pass {
  const cell: Cell = {
    dataset: 'dense',
    op: 'op0',
    answersAgree: true,
    verdict: WITHIN,
    headInterval: [0, 0.0321],
    rounds: flatRounds(),
    slept: sleptRows as Round[],
    ...cellExtra,
  };
  return passOf([], { reads: [cell], sleepRule: { factor: 100, maxOnCpu: 0.5 }, ...extra });
}
const headSleep = (order: number, evidence?: unknown): unknown[] => [
  order,
  100,
  1e6,
  100,
  1,
  2,
  evidence ?? [{ cell: 'dense op0', subject: 'head', wall: 1e6, cpu: 10 }],
];
const baseSleep = (order: number): unknown[] => [
  order,
  1e6,
  100,
  100,
  1,
  2,
  [{ cell: 'dense op0', subject: 'base', wall: 1e6, cpu: 10 }],
];
describe('the gate and slept rounds', () => {
  const problemsOf = (
    rows: unknown[][],
    extra: Partial<Pass> = {},
    cellExtra: Partial<Cell> = {},
  ) => rule.gateProblems([passWithSlept(rows, extra, cellExtra)]);

  it('passes a recorded slept round whose evidence holds against the cell', () => {
    expect(problemsOf([headSleep(0)])).toEqual([]);
  });

  it('refuses a slept round recorded with no evidence, or with an empty list', () => {
    for (const row of [[0, 100, 1e6, 100, 1, 2], headSleep(0, [])]) {
      expect(problemsOf([row]), JSON.stringify(row)).toEqual([
        expect.stringContaining('has no evidence'),
      ]);
    }
  });

  it('refuses evidence whose CPU is half the wall time or more, or whose wall is not over 100 times the median', () => {
    const half = headSleep(0, [{ cell: 'dense op0', subject: 'head', wall: 1e6, cpu: 5e5 }]);
    expect(problemsOf([half])).toEqual([
      expect.stringContaining('head in dense op0 is not a sleep'),
    ]);
    const near = [
      0,
      100,
      9000,
      100,
      1,
      2,
      [{ cell: 'dense op0', subject: 'head', wall: 9000, cpu: 1 }],
    ];
    expect(problemsOf([near])).toEqual([expect.stringContaining('is not a sleep')]);
  });

  it('refuses evidence that names a figure the record does not hold (another wall, a subject, a cell)', () => {
    for (const evidence of [
      [{ cell: 'dense op0', subject: 'head', wall: 2e6, cpu: 10 }],
      [{ cell: 'dense op0', subject: 'base', wall: 1e6, cpu: 10 }],
      [{ cell: 'dense nowhere', subject: 'head', wall: 1e6, cpu: 10 }],
      [{ cell: 'dense op0', subject: 'tail', wall: 1e6, cpu: 10 }],
    ]) {
      expect(problemsOf([headSleep(0, evidence)]), JSON.stringify(evidence)).toEqual([
        expect.stringContaining('names a slept figure the record does not hold'),
      ]);
    }
  });

  it('refuses slept rounds in a pass that records no sleep rule, or a weaker one', () => {
    for (const sleepRule of [
      undefined,
      { factor: 10, maxOnCpu: 0.5 },
      { factor: 100, maxOnCpu: 0.9 },
    ]) {
      expect(problemsOf([headSleep(0)], { sleepRule }), JSON.stringify(sleepRule)).toEqual([
        expect.stringContaining('slept rounds are recorded without a sleep rule'),
      ]);
    }
  });

  it('refuses a cell whose slept rounds fall on the head twice and more often than on the base and the control, unless it is explained', () => {
    const rows = [headSleep(0), headSleep(1)];
    expect(problemsOf(rows)).toEqual([
      expect.stringContaining('2 slept rounds on the head against 0 on the base and the control'),
    ]);
    expect(problemsOf(rows, {}, { explained: 'the head was rebuilt mid-run' })).toEqual([]);
  });

  it('leaves a cell alone whose slept rounds fall on the head once, or on the head no more often than on the others', () => {
    expect(problemsOf([headSleep(0), baseSleep(1)])).toEqual([]);
    expect(problemsOf([headSleep(0), headSleep(1), baseSleep(2), baseSleep(3)])).toEqual([]);
    expect(problemsOf([baseSleep(0), baseSleep(1), headSleep(2)])).toEqual([]);
  });

  it('reads a pass with no sleep rule as stored: its kept rounds are not trimmed, and a stored slower still fails', () => {
    const spiked = flatRounds(
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i * 2}:2`, 1e8])),
    );
    const stored = rule.cellOf(spiked, 6);
    expect(stored.verdict).toBe(INCONCLUSIVE);
    const cell = { ...stored, dataset: 'dense', op: 'op0', answersAgree: true };
    // As stored the cell is open: it needs the note that quotes its bound, and is not read as within.
    expect(rule.gateProblems([passOf([], { reads: [cell] })])).toEqual([
      expect.stringContaining('dense op0 is inconclusive'),
    ]);
    const slower = passOf([SLOWER], {}, { rounds: spiked });
    expect(rule.gateProblems([slower])).toEqual([expect.stringContaining('conclusively slower')]);
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

  it('reads the tree fields of each pass: a clean pass with paths and a dirty one with unsorted paths are refused, a named dirty pass and an old one are not', () => {
    const withTree = (fields: Record<string, unknown>) =>
      rule
        .gateProblems([
          passOf([WITHIN], {
            environment: { rounds: 31, tree: 'clean', base: '', head: '', ...fields },
          }),
        ])
        .join('\n');
    expect(withTree({ tree: 'clean', dirtyPaths: ['a'], dirtyTotal: 1 })).toContain(
      'a clean tree records dirty paths',
    );
    expect(withTree({ tree: 'dirty', dirtyPaths: ['b', 'a'], dirtyTotal: 2 })).toContain(
      'not sorted and distinct',
    );
    expect(withTree({ tree: 'dirty', dirtyPaths: ['a', 'b'], dirtyTotal: 2 })).toBe('');
    expect(withTree({ tree: 'dirty' })).toBe('');
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
  const record = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { passes?: Pass[] })
    : null;
  // A missing record, or one with no list of passes, fails each test that reads it, with a message that says so: none of
  // them skips.
  const held = (): Pass[] => {
    expect(record, 'the committed record is missing').not.toBeNull();
    expect(Array.isArray(record!.passes), 'the committed record has no `passes` list').toBe(true);
    return record!.passes!;
  };
  const cellsOf = (p: Pass): Cell[] => [...p.reads, ...(p.write ?? []), ...(p.ops ?? [])];

  it('keeps every pass, numbered from 1 without a gap, each with its time and commits', () => {
    expect(held().length).toBeGreaterThan(0);
    held().forEach((p, i) => {
      expect(p.pass, `pass ${i + 1}`).toBe(i + 1);
      expect(Number.isNaN(Date.parse(p.started))).toBe(false);
      expect(p.environment.base).toMatch(/^[0-9a-f]{40}$/);
      expect(p.environment.head).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  it('recomputes every median, interval and verdict of every pass from its rounds, by the rule the pass records', () => {
    for (const doc of held()) {
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
          const left = new Set(['rounds', 'discarded', 'slept', 'dataset', 'op', 'answersAgree']);
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
  });

  it('holds slept rounds only in a pass that records its sleep rule, each with the evidence the rule asks for (only the sixth pass holds one)', () => {
    const found: string[] = [];
    for (const doc of held()) {
      const cells = [...cellsOf(doc), ...(doc.import ? [doc.import.moduleLoadMs] : [])];
      for (const c of cells) {
        const name = `pass ${doc.pass} ${c.dataset ?? 'import'} ${c.op ?? ''}`.trim();
        if (c.slept === undefined) continue;
        found.push(name);
        expect(doc.sleepRule, name).toEqual({ factor: 100, maxOnCpu: 0.5 });
        for (const row of c.slept) {
          expect(row, name).toHaveLength(7);
          const evidence = row[6] as unknown as { wall: number; cpu: number }[];
          expect(evidence.length, name).toBeGreaterThan(0);
          for (const e of evidence) expect(e.cpu, name).toBeLessThan(0.5 * e.wall);
        }
      }
    }
    // The one slept round on file is in pass 6, in every cell of the mixed data set; no earlier pass holds one.
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((n) => !n.startsWith('pass 6 '))).toEqual([]);
  });

  // Held with no exemption, and not skippable: a missing or empty record fails, and every pass, the earliest too, names
  // a clean tree.
  it('holds every pass to a clean tree at full strength, with no exemption', () => {
    expect(held().length, 'the committed record holds no pass').toBeGreaterThan(0);
    const notClean = held().flatMap((p, i) => (p.environment.tree === 'clean' ? [] : [i + 1]));
    expect(notClean, 'passes (numbered from 1) not recorded on a clean tree').toEqual([]);
    for (const doc of held())
      expect(doc.environment.rounds).toBeGreaterThanOrEqual(codec.MIN_ROUNDS);
  });

  it('passes the gate over every pass: no slower is erased, no load rule is broken, no open cell goes unquoted', () => {
    // The first pass was judged by the earlier rule; the gate asks for a last pass of the current rule, which the
    // re-take on the final code supplies. Until it is appended that one message is the only one allowed.
    const problems = rule
      .gateProblems(held())
      .filter((p) => !p.includes('judged by the earlier rule'));
    expect(problems).toEqual([]);
  });
});
