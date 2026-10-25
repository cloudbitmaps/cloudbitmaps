/*
 * What a pass of the public bitmap class's bench (`bench/bitmap-api.cjs`) says, from its rounds, apart from the
 * instrument that takes them, so a test can fire it at its boundaries and recompute every committed figure from the
 * rounds beside it. Pure: no clock, no process, no file. The median, the distribution-free interval of the median, the
 * load rule and the sleep rule are the codec's paired bench's (`bench/lib/paired-verdict.cjs`), not written again.
 *
 * A round is `[order, native, ours, control, internal, loadAtStart, loadAtEnd]`: the figure of the pinned `roaring`
 * package, of `RoaringBitmap`, of `RoaringBitmap` a second time (the A/A control) and of the codec's own bitmap (`null`
 * for a cell the codec has no counterpart for), in milliseconds, whatever order the subjects ran in.
 *
 * A cell's figures:
 *
 *   - `vsNative`: the median over the rounds of `ours / native`, with the distribution-free 95% interval of that median
 *     (31 rounds: the 10th smallest to the 10th largest). The ratio is paired within a round, so the machine's drift
 *     between rounds cancels. "Times native" everywhere below means this.
 *   - `controlVsOurs`: the median of `control / ours - 1`. The control is the same code, so it must lie within +-2%
 *     (`CONTROL_BAND`) or the cell resolves nothing: `controlInBand` is false and the table marks the figure.
 *   - `vsInternal` and its interval: the same ratio of `ours / internal`, the cost of the shell over the codec's call.
 *
 * THE STOP RULE (fixed before the first measurement; a number changes only before one, never after):
 *
 *   1. The count kernels ship only if `andCardinality` beats build-then-`size` on every data set (median of the rounds).
 *      Not decided by this pass: the cells wait for the class to have them.
 *   2. "Close to native" means within `CLOSE_BAR` (3) times native on every cell of the group the words describe.
 *   3. A public method whose median is more than `SHIP_BAR` (10) times native on any data set does not ship in this
 *      release unless the maintainer decides otherwise, having seen the table.
 *   4. The first-page claim never says "faster"; it is not a figure of this bench.
 */
'use strict';

const paired = require('./paired-verdict.cjs');

const { median, medianInterval, MAX_LOAD, keepRound, collectRounds } = paired;

/** The A/A control's median must lie within this fraction of `ours`, or the cell resolves nothing. */
const CONTROL_BAND = 0.02;
/** Rule 2: within this many times native. */
const CLOSE_BAR = 3;
/** Rule 3: a method above this many times native on any data set does not ship. */
const SHIP_BAR = 10;
/** The name each pass records for the rule that reads its rounds. */
const RULE = 'bitmap-api-v1';
/** The unit a pass records its durations in. */
const UNIT = 'ms';
/** Slack for the floating-point error of a ratio on a boundary. */
const EPSILON = 1e-12;
/** The phrase rule 2 governs. */
const CLOSE_PHRASE = 'close to native';

/** A round is well formed: four finite positive figures (the codec's may be `null`) and two loads. */
function wellFormedRound(r, withInternal) {
  if (!Array.isArray(r) || r.length !== 7) return false;
  const figures = withInternal ? [1, 2, 3, 4] : [1, 2, 3];
  if (!figures.every((i) => Number.isFinite(r[i]) && r[i] > 0)) return false;
  if (!withInternal && r[4] !== null) return false;
  return Number.isFinite(r[5]) && Number.isFinite(r[6]);
}

/** Whether the cell's rounds carry the codec's figure. */
const hasInternal = (rounds) => rounds.length > 0 && rounds[0][4] !== null;

/**
 * A cell's figures from its rounds. Ratios are rounded to four places and figures to `places`; the rounds are kept
 * whole, so everything stored here can be recomputed from them. A malformed round makes the cell `malformed`.
 */
function cellOf(rounds, places = 6) {
  const withInternal = hasInternal(rounds);
  if (
    !Array.isArray(rounds) ||
    rounds.length === 0 ||
    !rounds.every((r) => wellFormedRound(r, withInternal))
  ) {
    return { malformed: true, rounds };
  }
  const round = (x, p) => +x.toFixed(p);
  const col = (i) => round(median(rounds.map((r) => r[i])), places);
  const native = medianInterval(rounds.map((r) => r[2] / r[1]));
  const controlVsOurs = median(rounds.map((r) => r[3] / r[2] - 1));
  const out = {
    nativeMedian: col(1),
    oursMedian: col(2),
    controlMedian: col(3),
    vsNative: round(median(rounds.map((r) => r[2] / r[1])), 4),
    vsNativeInterval: [round(native.lower, 4), round(native.upper, 4)],
    controlVsOurs: round(controlVsOurs, 4),
    controlInBand: Math.abs(controlVsOurs) <= CONTROL_BAND + EPSILON,
  };
  if (withInternal) {
    const internal = medianInterval(rounds.map((r) => r[2] / r[4]));
    out.internalMedian = col(4);
    out.vsInternal = round(median(rounds.map((r) => r[2] / r[4])), 4);
    out.vsInternalInterval = [round(internal.lower, 4), round(internal.upper, 4)];
  }
  return { ...out, rounds };
}

/** The same figures from a recorded cell's own rounds, to compare with what it stores. */
const recompute = (cell, places = 6) => cellOf(cell.rounds, places);

/**
 * The groups of cells and what rule 2 says of each: `{ group, cells, worst, worstCell, close }` where `worst` is the
 * largest `vsNative` of any cell of any data set in the group, and `close` is whether it is within `CLOSE_BAR`. A cell
 * whose control is out of band counts as unresolved: it keeps its group from being called close.
 */
function groupsOf(cells) {
  const groups = new Map();
  for (const c of cells) {
    const g = groups.get(c.group) ?? {
      group: c.group,
      cells: 0,
      worst: 0,
      worstCell: '',
      unresolved: 0,
    };
    g.cells++;
    if (!c.controlInBand) g.unresolved++;
    if (c.vsNative > g.worst) {
      g.worst = c.vsNative;
      g.worstCell = `${c.dataset} ${c.op}`;
    }
    groups.set(c.group, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    close: g.worst <= CLOSE_BAR + EPSILON && g.unresolved === 0,
  }));
}

/**
 * Rule 3: the public methods with a cell above `SHIP_BAR` times native on any data set, as
 * `[{ method, worst, cell }]`, worst first. A cell whose control is out of band is still read by its figure here: a
 * method is not cleared by an instrument that could not resolve it.
 */
function overShipBar(cells) {
  const worst = new Map();
  for (const c of cells) {
    if (c.vsNative <= SHIP_BAR + EPSILON) continue;
    const seen = worst.get(c.method);
    if (seen === undefined || c.vsNative > seen.worst) {
      worst.set(c.method, { method: c.method, worst: c.vsNative, cell: `${c.dataset} ${c.op}` });
    }
  }
  return [...worst.values()].sort((p, q) => q.worst - p.worst);
}

/** The cells of a pass: the steady cells and the cold ones. */
const cellsOfPass = (pass) => [...(pass.cells ?? []), ...(pass.cold ?? [])];

/** The name a cell goes by in a pass's notes. */
const cellName = (c) => `${c.dataset} ${c.op}`;

/** The pass the docs read: the last one that is not a smoke pass; `undefined` while the record holds none. */
function passOfRecord(file) {
  const passes = (file.passes ?? []).filter((p) => !p.environment?.smoke);
  return passes[passes.length - 1];
}

/**
 * What stops a list of passes from being published, as messages (empty when nothing does). The gate reads every pass:
 * a smoke pass is no evidence; a cell whose subjects gave different answers fails; a round kept at a load of
 * `MAX_LOAD` or more fails unless the pass records that the rule was off; the last pass must have been read by the
 * current rule.
 */
function gateProblems(passes) {
  const problems = [];
  passes.forEach((pass, i) => {
    const label = `pass ${pass.pass ?? i + 1}`;
    if (pass.environment?.smoke) problems.push(`${label}: a smoke pass is no evidence`);
    for (const c of cellsOfPass(pass)) {
      if (c.answersAgree !== true)
        problems.push(`${label}: ${cellName(c)}: the subjects gave different answers`);
      if (!pass.environment?.anyLoad) {
        const late = (c.rounds ?? []).find((r) => !keepRound(r[6]));
        if (late !== undefined)
          problems.push(`${label}: ${cellName(c)} kept a round that ended at load ${late[6]}`);
      }
    }
  });
  const last = passes[passes.length - 1];
  if (last !== undefined && last.rule !== RULE) {
    problems.push(
      `the last pass (${last.pass ?? passes.length}) was read by ${last.rule}, not ${RULE}`,
    );
  }
  return problems;
}

module.exports = {
  CONTROL_BAND,
  CLOSE_BAR,
  SHIP_BAR,
  CLOSE_PHRASE,
  RULE,
  UNIT,
  MAX_LOAD,
  EPSILON,
  median,
  medianInterval,
  keepRound,
  collectRounds,
  nsToMs: paired.nsToMs,
  figurePlaces: paired.figurePlaces,
  hasInternal,
  cellOf,
  recompute,
  groupsOf,
  overShipBar,
  cellsOfPass,
  cellName,
  passOfRecord,
  gateProblems,
};
