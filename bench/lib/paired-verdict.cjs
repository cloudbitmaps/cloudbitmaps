/*
 * The rule that judges a paired before-and-after comparison (`bench/ts-codec-paired.cjs`), apart from the instrument
 * that takes the samples, so a test can fire it at its boundaries and recompute the committed figures from their
 * rounds (`tests/bench/ts-codec-paired-verdict.test.ts`). Pure: no clock, no process, no file.
 *
 * A round is `[orderIndex, base, head, control, loadAtStart, loadAtEnd]`: the figure of the code at the base commit, at
 * the head, and at the base commit a second time (the A/A control), whatever order the three ran in, and the 1-minute
 * load average when the round began and when it ended. The rule is `median-interval-v2`:
 *
 *   - Per round, the head is compared with the mean of the base and the control, `d = head / mean(base, control) - 1`.
 *     The control is a second sample of the base, so the reference carries half the variance of the base alone.
 *   - The interval is the distribution-free interval of the median of `d`: the order statistics `k` and `n + 1 - k`,
 *     with `k` the largest that keeps the binomial coverage at 95% or more (31 rounds: `k = 10`, 97.1%). It draws no
 *     random numbers, so the same rounds always give the same interval.
 *   - Instrument check: the median of `control / base - 1` must lie within +-2%. A cell that fails it is inconclusive,
 *     whatever the head shows.
 *   - The bar is fixed at 2%, before any measurement it judges: `within` when the interval's upper end is at most the
 *     bar, `slower` when its lower end is above it, `faster` when its upper end is below minus the bar, `inconclusive`
 *     otherwise. The bar is a parameter of `judge` so another comparison (the count kernels against a build) can judge
 *     by its own, but a comparison states it before it measures.
 *
 * UNIT. Every duration a pass records (a round's three figures, a cell's medians) is milliseconds with enough decimals
 * to keep the instrument's own resolution: six for a figure the harness measures in whole nanoseconds, seven for one it
 * measures to a tenth of a nanosecond (the per-operation cells). The decimal point keeps any integer run of the record
 * short (no run of twelve digits can occur for any plausible duration). A pass recorded before that carries no `unit`
 * and holds nanoseconds, with no decimals (a tenth of a nanosecond in the per-operation cells); `figurePlaces` gives the
 * places each form is rounded to, and the ratios the rule derives do not depend on the unit.
 *
 * Rounds of the first pass in the committed results file were judged by the earlier rule (the head's median against a
 * band of half the control's interquartile range); `legacyVerdictOf` keeps it so that file can still be recomputed.
 */
'use strict';

/** The A/A control's median difference from the base must lie within this, as a fraction, or the cell resolves nothing. */
const CONTROL_BAND = 0.02;
/** The bar the head is held to, as a fraction. */
const TOLERANCE = 0.02;
/** The coverage the median's interval keeps, at least. */
const COVERAGE = 0.95;
/** A round that ends at or above this 1-minute load average is not kept: it is taken again. */
const MAX_LOAD = 6;
/** The unit a pass records its durations in; a pass that records none holds nanoseconds. */
const UNIT = 'ms';
/** The name each pass records for the rule that judged it. */
const RULE = 'median-interval-v2';
/** Slack for the floating-point error of a ratio that is exactly on a boundary. */
const EPSILON = 1e-12;

const WITHIN = 'within the bar';
const SLOWER = 'slower than the bar';
const FASTER = 'faster than the bar';
const INCONCLUSIVE = 'inconclusive';
const MALFORMED = 'malformed';

const LEGACY = {
  WITHIN: 'within the control band',
  SLOWER: 'slower than the control band',
  FASTER: 'faster than the control band',
};
const KIND = new Map([
  [WITHIN, 'within'],
  [SLOWER, 'slower'],
  [FASTER, 'faster'],
  [LEGACY.WITHIN, 'within'],
  [LEGACY.SLOWER, 'slower'],
  [LEGACY.FASTER, 'faster'],
  [INCONCLUSIVE, 'inconclusive'],
  [MALFORMED, 'malformed'],
]);

/**
 * A duration of `ns` nanoseconds (an integer, or a multiple of `10 ** -decimals` when `decimals` is given) as
 * milliseconds, divided exactly: the digits are moved six places by text, so nothing is rounded and the result is the
 * double nearest to the exact decimal.
 */
function nsToMs(ns, decimals = 0) {
  const text = Number(ns).toFixed(decimals);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new RangeError(`not a duration in nanoseconds: ${ns}`);
  const places = 6 + decimals;
  const padded = text.replace('.', '').padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places);
  const fraction = padded.slice(padded.length - places).replace(/0+$/, '');
  return Number(fraction === '' ? whole : `${whole}.${fraction}`);
}

/**
 * The places a stored duration is rounded to: `kind` is `whole` (measured in whole nanoseconds), `tenth` (to a tenth of
 * a nanosecond) or `import` (measured in milliseconds, three places), and `unit` is the pass's `unit`.
 */
function figurePlaces(kind, unit) {
  if (kind === 'import') return 3;
  const base = kind === 'tenth' ? 1 : 0;
  return unit === UNIT ? base + 6 : base;
}

/** The median of a list: the upper middle one of an even count, NaN for an empty list. */
function median(xs) {
  if (xs.length === 0) return Number.NaN;
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
}

/** `P(X <= k)` for `X` binomial with `n` trials and probability 1/2, by the sum of its exact terms (in logs). */
function binomialCdfHalf(n, k) {
  if (k < 0) return 0;
  const logFactorial = [0];
  for (let i = 1; i <= n; i++) logFactorial.push(logFactorial[i - 1] + Math.log(i));
  let total = 0;
  for (let i = 0; i <= Math.min(k, n); i++) {
    total += Math.exp(logFactorial[n] - logFactorial[i] - logFactorial[n - i] - n * Math.LN2);
  }
  return Math.min(1, total);
}

/**
 * The distribution-free interval of the median of `values`: the `k`-th smallest to the `k`-th largest, with `k` the
 * largest whose coverage (`1 - 2 * P(Binomial(n, 1/2) <= k - 1)`) is at least `coverage`. With too few values for any
 * `k` to reach it the interval is unbounded, so a verdict drawn from it is inconclusive. Returns
 * `{ lower, upper, k, coverage }`.
 */
function medianInterval(values, coverage = COVERAGE) {
  const n = values.length;
  let k = 0;
  let reached = 0;
  for (let j = 1; j <= n >> 1; j++) {
    const c = 1 - 2 * binomialCdfHalf(n, j - 1);
    if (c + EPSILON < coverage) break;
    k = j;
    reached = c;
  }
  if (k === 0) {
    return { lower: Number.NEGATIVE_INFINITY, upper: Number.POSITIVE_INFINITY, k, coverage: 0 };
  }
  const s = values.slice().sort((p, q) => p - q);
  return { lower: s[k - 1], upper: s[n - k], k, coverage: reached };
}

/** The per-round figures a verdict is drawn from: the head against the reference, and the control against the base. */
function differencesOf(rounds) {
  return {
    head: rounds.map((r) => r[2] / ((r[1] + r[3]) / 2) - 1),
    headVsBase: rounds.map((r) => r[2] / r[1] - 1),
    control: rounds.map((r) => r[3] / r[1] - 1),
  };
}

/**
 * The verdict of a cell and what it rests on, from its rounds: `{ verdict, headVsReference, headInterval,
 * controlVsBase }` (fractions). A round that is not four finite positive figures makes the cell malformed.
 */
function judge(rounds, tolerance = TOLERANCE) {
  const ok =
    Array.isArray(rounds) &&
    rounds.length > 0 &&
    rounds.every(
      (r) => Array.isArray(r) && [1, 2, 3].every((i) => Number.isFinite(r[i]) && r[i] > 0),
    );
  if (!ok) {
    return {
      verdict: MALFORMED,
      headVsReference: Number.NaN,
      headInterval: [Number.NaN, Number.NaN],
      controlVsBase: Number.NaN,
    };
  }
  const d = differencesOf(rounds);
  const interval = medianInterval(d.head);
  const controlVsBase = median(d.control);
  const out = {
    headVsReference: median(d.head),
    headInterval: [interval.lower, interval.upper],
    controlVsBase,
  };
  if (Math.abs(controlVsBase) > CONTROL_BAND + EPSILON) return { verdict: INCONCLUSIVE, ...out };
  if (interval.upper < -tolerance - EPSILON) return { verdict: FASTER, ...out };
  if (interval.upper <= tolerance + EPSILON) return { verdict: WITHIN, ...out };
  if (interval.lower > tolerance + EPSILON) return { verdict: SLOWER, ...out };
  return { verdict: INCONCLUSIVE, ...out };
}

/**
 * A cell's figures from its rounds, as a pass of schema 2 stores them: the medians of the three figures, the head and
 * the control against the base, the head against the reference with its interval, and the verdict. Ratios are rounded
 * to four places and figures to `places`; the rounds are kept whole, so everything here can be recomputed from them.
 */
function cellOf(rounds, places = 0, tolerance = TOLERANCE) {
  const round = (x, p) => +x.toFixed(p);
  const col = (i) => median(rounds.map((r) => r[i]));
  const j = judge(rounds, tolerance);
  const d = differencesOf(rounds);
  return {
    baseMedian: round(col(1), places),
    headMedian: round(col(2), places),
    controlMedian: round(col(3), places),
    headVsBase: round(median(d.headVsBase), 4),
    controlVsBase: round(j.controlVsBase, 4),
    headVsReference: round(j.headVsReference, 4),
    headInterval: j.headInterval.map((x) => round(x, 4)),
    verdict: j.verdict,
    rounds,
  };
}

/** The earlier rule's half-width: half the control's interquartile range of per-round differences, at least 1%. */
function legacyBandOf(controlQuartiles) {
  return Math.max(0.01, (controlQuartiles[1] - controlQuartiles[0]) / 2);
}

/** The earlier rule, kept to recompute the passes recorded under it (a pass that names no rule). */
function legacyVerdictOf(headMedian, controlMedian, controlQuartiles) {
  if (
    !Number.isFinite(headMedian) ||
    !Number.isFinite(controlMedian) ||
    controlQuartiles.length !== 2 ||
    !controlQuartiles.every(Number.isFinite)
  ) {
    return MALFORMED;
  }
  if (Math.abs(controlMedian) > 0.03 + EPSILON) return INCONCLUSIVE;
  const band = legacyBandOf(controlQuartiles);
  if (headMedian > controlMedian + band + EPSILON) return LEGACY.SLOWER;
  if (headMedian < controlMedian - band - EPSILON) return LEGACY.FASTER;
  return LEGACY.WITHIN;
}

/** The worst of a list of verdicts: malformed, then slower, then inconclusive, then faster, then within. */
function worstPaired(verdicts) {
  if (verdicts.length === 0) return MALFORMED;
  const kinds = verdicts.map((v) => KIND.get(v) ?? 'malformed');
  for (const k of ['malformed', 'slower', 'inconclusive', 'faster']) {
    const at = kinds.indexOf(k);
    if (at >= 0) return verdicts[at];
  }
  return verdicts[0];
}

/** What a verdict string means: `within`, `slower`, `faster`, `inconclusive` or `malformed`. */
const kindOf = (verdict) => KIND.get(verdict) ?? 'malformed';

/** The name a cell goes by in a pass's notes: its data set and operation. */
const cellName = (c) => `${c.dataset ?? 'import'} ${c.op ?? ''}`.trim();

/** The cells a pass's verdict covers: the reads, the write path and the per-operation cells. Not the import. */
const gatedCellsOf = (pass) => [...(pass.reads ?? []), ...(pass.write ?? []), ...(pass.ops ?? [])];

/** The percentage an interval's upper end names, as a pass's `unresolved` note must quote it: `+3.2%`. */
const boundText = (upper) =>
  Number.isFinite(upper) ? `${upper >= 0 ? '+' : ''}${(upper * 100).toFixed(1)}%` : 'unbounded';

/** Whether a round that ended at `loadAtEnd` is kept: under `MAX_LOAD`, or with the load rule turned off. */
const keepRound = (loadAtEnd, anyLoad = false) => anyLoad || loadAtEnd < MAX_LOAD;

/**
 * What stops a list of passes from being published, as a list of messages (empty when nothing does). The gate reads
 * every pass, so a later green pass never erases an earlier conclusive "slower":
 *
 *   - a cell judged `slower` in any pass fails, unless that pass carries an `explained` note;
 *   - a smoke pass (a tiny-scale run of the pipeline) fails;
 *   - a round that is kept although it ended at a load of `MAX_LOAD` or more fails, unless the pass records `anyLoad`;
 *   - the last pass must have been judged by the current rule (a pass that names none was judged by the earlier one);
 *   - a cell still `inconclusive` in the last pass needs an entry for it in that pass's `unresolved` notes that quotes
 *     its bound (what its interval cannot rule out), so it is published with that bound and never called within.
 */
function gateProblems(passes) {
  const problems = [];
  passes.forEach((pass, i) => {
    const label = `pass ${pass.pass ?? i + 1}`;
    if (pass.environment?.smoke) problems.push(`${label}: a smoke pass is no evidence`);
    for (const c of gatedCellsOf(pass)) {
      if (kindOf(c.verdict) === 'slower' && !pass.explained) {
        problems.push(
          `${label}: ${cellName(c)} is conclusively slower and the pass has no "explained" note`,
        );
      }
      if (pass.rule === RULE && !pass.environment?.anyLoad) {
        for (const r of c.rounds ?? []) {
          if (!keepRound(r[5])) {
            problems.push(`${label}: ${cellName(c)} kept a round that ended at load ${r[5]}`);
            break;
          }
        }
      }
    }
  });
  const last = passes[passes.length - 1];
  if (last === undefined) return ['no pass is recorded'];
  if (last.rule !== RULE) {
    problems.push(
      `the last pass (${last.pass ?? passes.length}) was judged by the earlier rule, not ${RULE}`,
    );
    return problems;
  }
  for (const c of gatedCellsOf(last)) {
    if (kindOf(c.verdict) !== 'inconclusive') continue;
    const note = last.unresolved?.[cellName(c)];
    const bound = boundText(c.headInterval?.[1]);
    if (typeof note !== 'string' || !note.includes(bound)) {
      problems.push(
        `last pass: ${cellName(c)} is inconclusive and has no "unresolved" note that quotes its bound ${bound}`,
      );
    }
  }
  return problems;
}

module.exports = {
  CONTROL_BAND,
  TOLERANCE,
  COVERAGE,
  MAX_LOAD,
  RULE,
  UNIT,
  WITHIN,
  SLOWER,
  FASTER,
  INCONCLUSIVE,
  MALFORMED,
  LEGACY,
  nsToMs,
  figurePlaces,
  median,
  medianInterval,
  differencesOf,
  judge,
  cellOf,
  legacyBandOf,
  legacyVerdictOf,
  worstPaired,
  kindOf,
  cellName,
  gatedCellsOf,
  boundText,
  keepRound,
  gateProblems,
};
