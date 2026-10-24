/*
 * The rule that judges a paired before-and-after comparison (`bench/ts-codec-paired.cjs`), apart from the instrument
 * that takes the samples, so a test can fire it at its boundaries and recompute the committed figures from their
 * rounds (`tests/bench/ts-codec-paired-verdict.test.ts`). Pure: no clock, no process, no file.
 *
 * A round is `[orderIndex, base, head, control, load]`, the layout `codec-verdict.cjs` summarises: the figure of the
 * codec at the base commit, at the head, and at the base commit a second time (the A/A control), whatever order the
 * three ran in. `summarise` gives `typescriptVsNative` (the head against the base, the median of the per-round ratios
 * minus one) and `controlVsNative` (the control against the base), with their quartiles.
 *
 * The bar is measured in each run, not assumed: a head is within the run's noise when its median difference lies
 * inside the band the control's own differences show, and a cell the control cannot resolve is inconclusive, never a
 * pass.
 */
'use strict';

/** A control whose median differs from the base by more than this has seen the machine move: the cell resolves nothing. */
const CONTROL_LIMIT = 0.03;
/** The narrowest band the head may sit inside, so a control that happened to be very quiet is not a bar of zero. */
const BAND_FLOOR = 0.01;
/** Slack for the floating-point error of a ratio that is exactly on a boundary. */
const EPSILON = 1e-12;

const WITHIN = 'within the control band';
const SLOWER = 'slower than the control band';
const FASTER = 'faster than the control band';
const INCONCLUSIVE = 'inconclusive';
const MALFORMED = 'malformed';

/**
 * The half-width of the band around the control's median: half the control's interquartile range of per-round
 * differences, and at least `BAND_FLOOR`.
 */
function bandOf(controlQuartiles) {
  return Math.max(BAND_FLOOR, (controlQuartiles[1] - controlQuartiles[0]) / 2);
}

/**
 * The verdict of a cell from the head's median difference, the control's median difference and the control's
 * quartiles (all fractions).
 */
function pairedVerdictOf(headMedian, controlMedian, controlQuartiles) {
  if (
    !Number.isFinite(headMedian) ||
    !Number.isFinite(controlMedian) ||
    controlQuartiles.length !== 2 ||
    !controlQuartiles.every(Number.isFinite)
  ) {
    return MALFORMED;
  }
  if (Math.abs(controlMedian) > CONTROL_LIMIT + EPSILON) return INCONCLUSIVE;
  const band = bandOf(controlQuartiles);
  if (headMedian > controlMedian + band + EPSILON) return SLOWER;
  if (headMedian < controlMedian - band - EPSILON) return FASTER;
  return WITHIN;
}

/** The worst of a list of verdicts: malformed, then slower, then inconclusive, then faster, then within. */
function worstPaired(verdicts) {
  if (verdicts.length === 0) return MALFORMED;
  for (const v of [MALFORMED, SLOWER, INCONCLUSIVE, FASTER]) if (verdicts.includes(v)) return v;
  return WITHIN;
}

module.exports = {
  CONTROL_LIMIT,
  BAND_FLOOR,
  WITHIN,
  SLOWER,
  FASTER,
  INCONCLUSIVE,
  MALFORMED,
  bandOf,
  pairedVerdictOf,
  worstPaired,
};
