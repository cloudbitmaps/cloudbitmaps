/*
 * The rule that turns the engine bench's paired samples into a verdict, apart from the instrument that takes them, so a
 * test can fire it at the boundaries and recompute the committed figures from their per-round samples
 * (`tests/bench/ts-codec-verdict.test.ts`). Pure: no clock, no process, no file.
 *
 * A round is `[orderIndex, native, typescript, control, load]`: the three stores' (or processes') figure for one round,
 * in that fixed order whatever order they ran in (`orderIndex` names the permutation that round used), and the 1-minute
 * load average when the round ended. A cell is its rounds plus what is derived from them here.
 */
'use strict';

/** The bar the TypeScript codec is held to: at most this much slower than the native codec, as a fraction. */
const BAR = 0.05;
/** The A/A control must sit within this band for a cell to resolve a difference of the bar's size, as a fraction. */
const CONTROL_BAND = 0.02;
/** The fewest rounds a figure the gate reads may rest on. */
const MIN_ROUNDS = 31;
/** Slack for the floating-point error of a ratio that is exactly on a boundary (`105 / 100 - 1` is not exactly 0.05). */
const EPSILON = 1e-12;

const VERDICT_WITHIN = 'within the 5% bar';
const VERDICT_OVER = 'over the 5% bar';
const VERDICT_INCONCLUSIVE = 'inconclusive';
const VERDICT_MALFORMED = 'malformed';

/** The median of a list of numbers: the upper middle one of an even count, NaN for an empty list. */
function median(xs) {
  if (xs.length === 0) return Number.NaN;
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
}

/** The quartile `q` (0.25 or 0.75) of a list: the element at index `floor(q * n)` of the sorted list, NaN for none. */
function quartile(xs, q) {
  if (xs.length === 0) return Number.NaN;
  const s = xs.slice().sort((p, q2) => p - q2);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** The cell's verdict, from the TypeScript median and the A/A control's median (both as fractions). */
function verdictOf(tsMedian, controlMedian) {
  if (!Number.isFinite(tsMedian) || !Number.isFinite(controlMedian)) return VERDICT_MALFORMED;
  if (Math.abs(controlMedian) > CONTROL_BAND + EPSILON) return VERDICT_INCONCLUSIVE;
  return tsMedian <= BAR + EPSILON ? VERDICT_WITHIN : VERDICT_OVER;
}

/** One op's verdict over its cells: the worst of them (malformed, then over, then inconclusive, then within). */
function worstOf(verdicts) {
  if (verdicts.length === 0) return VERDICT_MALFORMED;
  for (const v of [VERDICT_MALFORMED, VERDICT_OVER, VERDICT_INCONCLUSIVE])
    if (verdicts.includes(v)) return v;
  return VERDICT_WITHIN;
}

/** The write path's verdict: faster, no slower, or slower, by the same control. */
function writeVerdictOf(tsMedian, controlMedian) {
  if (!Number.isFinite(tsMedian) || !Number.isFinite(controlMedian)) return VERDICT_MALFORMED;
  if (Math.abs(controlMedian) > CONTROL_BAND + EPSILON) return VERDICT_INCONCLUSIVE;
  if (tsMedian < -CONTROL_BAND - EPSILON) return 'faster';
  return tsMedian <= CONTROL_BAND + EPSILON ? 'no slower (within the control band)' : 'slower';
}

/** The value of largest magnitude, with its sign; NaN for an empty list. */
function signedWorst(values) {
  return values.length === 0
    ? Number.NaN
    : values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
}

/**
 * Everything a cell's figures are derived from its rounds: the median of each store's figure, the median of the two
 * paired differences (`typescript / native - 1` and `control / native - 1`, round by round) and their quartiles.
 * Ratios are rounded to four places and figures to `places` places, as they are stored.
 */
function summarise(rounds, places = 0) {
  const col = (i) => rounds.map((r) => r[i]);
  const tsDiffs = rounds.map((r) => r[2] / r[1] - 1);
  const controlDiffs = rounds.map((r) => r[3] / r[1] - 1);
  const round = (x, p) => +x.toFixed(p);
  return {
    nativeMedian: round(median(col(1)), places),
    typescriptMedian: round(median(col(2)), places),
    controlMedian: round(median(col(3)), places),
    typescriptVsNative: round(median(tsDiffs), 4),
    controlVsNative: round(median(controlDiffs), 4),
    typescriptQuartiles: [round(quartile(tsDiffs, 0.25), 4), round(quartile(tsDiffs, 0.75), 4)],
    controlQuartiles: [
      round(quartile(controlDiffs, 0.25), 4),
      round(quartile(controlDiffs, 0.75), 4),
    ],
    verdictInputs: [median(tsDiffs), median(controlDiffs)],
  };
}

/**
 * `summarise` without the unrounded inputs, with the verdict by `verdict` (default: the read rule; `null` for a figure
 * no gate reads, which gets none) and the rounds themselves, so the figures can be recomputed from the file.
 */
function cellFrom(rounds, places = 0, verdict = verdictOf) {
  const { verdictInputs, ...figures } = summarise(rounds, places);
  return {
    ...figures,
    ...(verdict === null ? {} : { verdict: verdict(...verdictInputs) }),
    rounds,
  };
}

module.exports = {
  BAR,
  CONTROL_BAND,
  MIN_ROUNDS,
  VERDICT_WITHIN,
  VERDICT_OVER,
  VERDICT_INCONCLUSIVE,
  VERDICT_MALFORMED,
  median,
  quartile,
  verdictOf,
  worstOf,
  writeVerdictOf,
  signedWorst,
  summarise,
  cellFrom,
};
