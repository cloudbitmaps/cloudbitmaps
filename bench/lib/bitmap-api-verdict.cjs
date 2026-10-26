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
 *   1. The count kernels ship only if they beat build-then-count in the count kernels' own bench
 *      (`bench/count-kernels.cjs`). That decision is that bench's, read here and never recomputed: the last line of
 *      `node bench/count-kernels.cjs --gate` is `RESULT kept`, `RESULT derived` or `RESULT invalid`. A pass records the
 *      route the build ran (`environment.countRoute`) and the decision it was taken under (`environment.countResult`),
 *      and the gate refuses a pass whose route is missing, unknown or not the decision's (kept: `kernels`; derived:
 *      `build-then-count`), and a last complete pass taken under a decision the record no longer gives. This bench's own
 *      `andCardinality` cells are its figures against native and against build-then-count, not that decision.
 *   2. "Close to native" means within `CLOSE_BAR` (3) times native on every cell of the group the words describe, every
 *      row of the table included (the cold rows are a group of their own).
 *   3. A public method whose median is more than `SHIP_BAR` (10) times native on any data set, a cold row included,
 *      does not ship in this release unless the maintainer decides otherwise, having seen the table.
 *   4. The first-page claim never says "faster"; it is not a figure of this bench.
 *
 * THE TABLE IS THE GATE'S. A figure the table prints is recomputed from the rounds beside it (`fresh`, `loadFiguresOf`,
 * `loadRowOf`, `roundCountOf`), never copied from a field a pass stored, and the gate refuses a pass whose stored fields
 * differ from the rounds. The gate holds a pass to everything the paired bench's holds one to: the load rule (a kept
 * round ended under `MAX_LOAD`, a set-aside round ended at or over it, and the rule was not turned off), the round floor
 * (`MIN_ROUNDS`), and the sleep rule (the pass records `sleepRule`, and every slept round carries evidence that holds
 * against the record, with the head-side backstop, all by the paired bench's own `sleptProblems`). A pass is complete
 * when it is not a smoke pass, carries no `partial` mark and holds every cell the full run takes
 * (`bitmap-api-cells.cjs`, `inventory`); only the last complete pass is the one the table and rules 2 and 3 are judged
 * on, and a record with passes and none of them complete has nothing to publish (`EXIT.partial`).
 */
'use strict';

const paired = require('./paired-verdict.cjs');
const cellsLib = require('./bitmap-api-cells.cjs');
const { MIN_ROUNDS } = require('./codec-verdict.cjs');

const { median, medianInterval, MAX_LOAD, keepRound, collectRounds } = paired;

/** The exit codes of the gate: nothing stops the record, the gate stops it, or the record holds no complete pass. */
const EXIT = { ok: 0, problems: 4, partial: 5 };
/** The route the class ran for each decision of the count kernels' own bench. */
const ROUTE_OF_RESULT = { kept: 'kernels', derived: 'build-then-count' };

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

/** Whether a stored load-part round is five finite figures. */
const wellFormedLoadRound = (r) => Array.isArray(r) && r.length === 5 && r.every(Number.isFinite);

/**
 * A load row's figures from its kept rounds `[load, serialize, decode, loadAtStart, loadAtEnd]` (milliseconds): the
 * medians, and the share of a load the round trip is, `(serialize + decode) / load` per round, with its interval.
 */
function loadRowOf(rounds) {
  const share = rounds.map((r) => (r[1] + r[2]) / r[0]);
  const interval = medianInterval(share);
  return {
    loadMedian: median(rounds.map((r) => r[0])),
    serializeMedian: median(rounds.map((r) => r[1])),
    decodeMedian: median(rounds.map((r) => r[2])),
    roundTripShare: +median(share).toFixed(4),
    roundTripShareInterval: [interval.lower, interval.upper].map((x) => +x.toFixed(4)),
  };
}

/**
 * A pass whose every printed figure comes from its rounds: the cells recomputed (`recompute`, the identity of a cell
 * kept), and the load rows' figures recomputed (`loadRowOf`).
 */
function fresh(pass) {
  const again = (list) =>
    (list ?? []).map((c) => (c.malformed ? c : { ...c, ...cellOf(c.rounds, 7), rounds: c.rounds }));
  return {
    ...pass,
    ...(pass.cells === undefined ? {} : { cells: again(pass.cells) }),
    ...(pass.cold === undefined ? {} : { cold: again(pass.cold) }),
    ...(pass.loadRoundTrip === undefined
      ? {}
      : {
          loadRoundTrip: pass.loadRoundTrip.map((l) =>
            Array.isArray(l.rounds) && l.rounds.length > 0 && l.rounds.every(wellFormedLoadRound)
              ? { ...l, ...loadRowOf(l.rounds) }
              : l,
          ),
        }),
  };
}

/** Every list of kept rounds a pass holds: the steady and cold cells' and the load rows'. */
const keptRoundLists = (pass) => [
  ...cellsOfPass(pass).map((c) => c.rounds ?? []),
  ...(pass.loadRoundTrip ?? []).map((l) => l.rounds ?? []),
];

/** How many rounds a figure of the pass rests on: the fewest kept rounds in any cell or load row. */
function roundCountOf(pass) {
  const lengths = keptRoundLists(pass).map((l) => l.length);
  return lengths.length === 0 ? 0 : Math.min(...lengths);
}

/**
 * What a pass says of its load, from its rounds: the highest load a kept round ended at, and the most rounds any cell
 * or load row set aside at `MAX_LOAD` or more and as slept.
 */
function loadFiguresOf(pass) {
  const cells = cellsOfPass(pass);
  const loads = pass.loadRoundTrip ?? [];
  return {
    maxLoadAtEnd: Math.max(
      0,
      ...cells.flatMap((c) => (c.rounds ?? []).map((r) => r[6])),
      ...loads.flatMap((l) => (l.rounds ?? []).map((r) => r[4])),
    ),
    discardedRounds: Math.max(
      0,
      ...cells.map((c) => (c.discarded ?? []).length),
      ...loads.map((l) => (l.discarded ?? []).length),
    ),
    sleptRounds: Math.max(
      0,
      ...cells.map((c) => (c.slept ?? []).length),
      ...loads.map((l) => (l.slept ?? []).length),
    ),
  };
}

/**
 * The rounds set aside at a load of `MAX_LOAD` or more: how many in all, on how many figures (a cell, a cold row or a
 * load row), and the most any one figure set aside. Apart from `loadFiguresOf`, whose shape a pass stores.
 */
function discardedOf(pass) {
  const counts = [...cellsOfPass(pass), ...(pass.loadRoundTrip ?? [])]
    .map((c) => (c.discarded ?? []).length)
    .filter((n) => n > 0);
  return {
    total: counts.reduce((a, b) => a + b, 0),
    figures: counts.length,
    most: Math.max(0, ...counts),
  };
}

const heldTimes = (n) => (n === 0 ? 'missing' : `held ${n} times`);

/**
 * What a pass lacks of the full run, as messages: every steady cell on every data set (with the codec's figure where the
 * codec has a counterpart), every cold cell, every load row, each exactly once and well formed.
 */
function inventoryProblems(pass) {
  const want = cellsLib.inventory();
  const problems = [];
  const present = (list, dataset, op) =>
    (list ?? []).filter((c) => c.dataset === dataset && c.op === op);
  for (const dataset of want.datasets) {
    for (const cell of want.steady) {
      const found = present(pass.cells, dataset, cell.op);
      const name = `${dataset} ${cell.op}`;
      if (found.length !== 1) {
        problems.push(`${name}: ${heldTimes(found.length)}`);
        continue;
      }
      const [c] = found;
      if (c.malformed) problems.push(`${name}: malformed rounds`);
      else if (hasInternal(c.rounds) !== cell.internal)
        problems.push(
          `${name}: ${cell.internal ? 'no codec figure' : 'a codec figure it should not have'}`,
        );
      if (c.method !== cell.method || c.group !== cell.group)
        problems.push(`${name}: is not the method and group the full run gives it`);
    }
  }
  for (const cell of want.cold) {
    const found = present(pass.cold, 'cold', cell.op);
    if (found.length !== 1) problems.push(`cold ${cell.op}: ${heldTimes(found.length)}`);
    else if (found[0].malformed) problems.push(`cold ${cell.op}: malformed rounds`);
    else if (hasInternal(found[0].rounds) !== cell.internal)
      problems.push(`cold ${cell.op}: no codec figure`);
  }
  const known = new Set(want.steady.map((c) => c.op));
  for (const c of pass.cells ?? [])
    if (!want.datasets.includes(c.dataset) || !known.has(c.op))
      problems.push(`${cellName(c)}: not a cell of the full run`);
  const coldKnown = new Set(want.cold.map((c) => c.op));
  for (const c of pass.cold ?? [])
    if (c.dataset !== 'cold' || !coldKnown.has(c.op))
      problems.push(`${cellName(c)}: not a cold cell of the full run`);
  for (const dataset of want.load) {
    const found = (pass.loadRoundTrip ?? []).filter((l) => l.dataset === dataset);
    if (found.length !== 1) problems.push(`load ${dataset}: ${heldTimes(found.length)}`);
  }
  for (const l of pass.loadRoundTrip ?? [])
    if (!want.load.includes(l.dataset))
      problems.push(`load ${l.dataset}: not a load row of the full run`);
  return problems;
}

/** Whether a pass is one the table may be judged on: not smoke, not marked partial, every cell of the full run. */
const isComplete = (pass) =>
  !pass.environment?.smoke && !pass.partial && inventoryProblems(pass).length === 0;

/** The pass the docs read: the last complete one; `undefined` while the record holds none. */
function passOfRecord(file) {
  const passes = (file.passes ?? []).filter(isComplete);
  return passes[passes.length - 1];
}

/** The pass's cells as the paired bench's rule reads them, for `sleptProblems`: one pseudo-cell per subject pair. */
function pairedViewOf(pass) {
  const view = [];
  const rowsOf = (rows, pick, withEvidence) =>
    (Array.isArray(rows) ? rows : []).map((r) => [
      r[0],
      r[pick],
      r[2],
      r[3],
      r[5],
      r[6],
      ...(withEvidence && r.length > 7 ? [r[7]] : []),
    ]);
  for (const c of cellsOfPass(pass)) {
    if (c.malformed) continue;
    const picks = [[c.op, 1]];
    if (hasInternal(c.rounds)) picks.push([`${c.op} (internal)`, 4]);
    for (const [op, pick] of picks) {
      view.push({
        dataset: c.dataset,
        op,
        rounds: rowsOf(c.rounds, pick, false),
        slept: rowsOf(c.slept, pick, true),
        ...(c.explained ? { explained: c.explained } : {}),
      });
    }
  }
  // A load row has one subject; its three spans take the subjects' places (load, serialize, decode).
  const spansOf = (rows, withEvidence) =>
    (Array.isArray(rows) ? rows : []).map((r) => [
      0,
      r[0],
      r[1],
      r[2],
      r[3],
      r[4],
      ...(withEvidence && r.length > 5 ? [r[5]] : []),
    ]);
  for (const l of pass.loadRoundTrip ?? []) {
    view.push({
      dataset: 'load',
      op: l.dataset,
      rounds: spansOf(l.rounds, false),
      slept: spansOf(l.slept, true),
      ...(l.explained ? { explained: l.explained } : {}),
    });
  }
  return view;
}

/** What stops the slept rounds of a pass from being read, by the paired bench's own function. */
function sleepProblems(label, pass) {
  const rule = pass.sleepRule;
  if (
    rule === undefined ||
    !(rule.factor >= paired.SLEEP_FACTOR) ||
    !(rule.maxOnCpu <= paired.SLEEP_MAX_ON_CPU)
  ) {
    return [
      `${label}: the pass records no sleep rule as strict as the paired bench's (factor at least ${paired.SLEEP_FACTOR}, at most ${paired.SLEEP_MAX_ON_CPU} of the wall time on CPU)`,
    ];
  }
  return [...new Set(paired.sleptProblems(label, { sleepRule: rule, ops: pairedViewOf(pass) }))];
}

/** The route and the count decision a pass records, against each other and, for the last complete pass, the record's. */
function routeProblems(label, pass, live, last) {
  const e = pass.environment ?? {};
  const problems = [];
  const routeKnown = Object.values(ROUTE_OF_RESULT).includes(e.countRoute);
  if (!routeKnown) {
    problems.push(
      `${label}: the route the build ran is ${e.countRoute === undefined ? 'not recorded' : `unknown (${JSON.stringify(e.countRoute)})`}`,
    );
  }
  if (ROUTE_OF_RESULT[e.countResult] === undefined) {
    problems.push(
      `${label}: the pass records no count decision (kept or derived), found ${JSON.stringify(e.countResult ?? null)}`,
    );
  } else if (routeKnown && ROUTE_OF_RESULT[e.countResult] !== e.countRoute) {
    problems.push(
      `${label}: the class ran ${e.countRoute} and the count decision it was taken under is ${e.countResult}`,
    );
  }
  if (last && live !== undefined) {
    if (ROUTE_OF_RESULT[live] === undefined) {
      problems.push(`${label}: the count kernels' record decides nothing (RESULT ${live})`);
    } else if (e.countResult !== live) {
      problems.push(
        `${label}: taken when the count kernels' record said ${e.countResult}, which now says ${live}`,
      );
    } else if (ROUTE_OF_RESULT[live] !== e.countRoute) {
      problems.push(
        `${label}: the class ran ${e.countRoute} and the count kernels' record says ${live}`,
      );
    }
  }
  return problems;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What stops one pass from being read, apart from its inventory, route and sleep rule. */
function passProblems(label, pass) {
  const problems = [];
  const e = pass.environment ?? {};
  if (e.smoke) problems.push(`${label}: a smoke pass is no evidence`);
  if (e.anyLoad) problems.push(`${label}: the load rule was turned off for this pass`);
  if (pass.partial !== undefined && (typeof pass.partial !== 'string' || pass.partial === ''))
    problems.push(`${label}: a partial mark must say what the pass left out`);
  const rounds = roundCountOf(pass);
  if (!(e.rounds >= MIN_ROUNDS))
    problems.push(`${label}: the pass records ${e.rounds} rounds, fewer than ${MIN_ROUNDS}`);
  else if (rounds > 0 && e.rounds !== rounds)
    problems.push(
      `${label}: the pass records ${e.rounds} rounds a figure, the rounds hold ${rounds}`,
    );
  const checkRounds = (name, list, endAt, discarded) => {
    if (list.length < MIN_ROUNDS)
      problems.push(`${label}: ${name} holds ${list.length} rounds, fewer than ${MIN_ROUNDS}`);
    const late = list.find((r) => !keepRound(r[endAt]));
    if (late !== undefined)
      problems.push(`${label}: ${name} kept a round that ended at load ${late[endAt]}`);
    for (const r of discarded ?? [])
      if (keepRound(r[endAt]))
        problems.push(
          `${label}: ${name} set aside a round that ended at load ${r[endAt]}, under ${MAX_LOAD}`,
        );
  };
  const differs = (name, key, stored, again) =>
    problems.push(
      `${label}: ${name}: stored ${key} ${JSON.stringify(stored)} is not what the rounds give (${JSON.stringify(again)})`,
    );
  for (const c of cellsOfPass(pass)) {
    const name = cellName(c);
    if (c.malformed) {
      problems.push(`${label}: ${name}: malformed rounds`);
      continue;
    }
    if (c.answersAgree !== true)
      problems.push(`${label}: ${name}: the subjects gave different answers`);
    const again = cellOf(c.rounds, 7);
    if (again.malformed) {
      problems.push(`${label}: ${name}: malformed rounds`);
      continue;
    }
    checkRounds(name, c.rounds, 6, c.discarded);
    for (const key of [
      'vsNative',
      'vsNativeInterval',
      'controlVsOurs',
      'controlInBand',
      'vsInternal',
      'vsInternalInterval',
    ]) {
      if (!same(c[key], again[key])) differs(name, key, c[key], again[key]);
    }
  }
  for (const l of pass.loadRoundTrip ?? []) {
    const name = `load ${l.dataset}`;
    if (!Array.isArray(l.rounds) || l.rounds.length === 0 || !l.rounds.every(wellFormedLoadRound)) {
      problems.push(`${label}: ${name}: malformed rounds`);
      continue;
    }
    checkRounds(name, l.rounds, 4, l.discarded);
    const again = loadRowOf(l.rounds);
    for (const key of Object.keys(again)) {
      if (!same(l[key], again[key])) differs(name, key, l[key], again[key]);
    }
  }
  if (pass.load !== undefined && !same(pass.load, loadFiguresOf(pass)))
    problems.push(`${label}: the stored load summary is not what the rounds give`);
  return problems;
}

/**
 * What stops a list of passes from being published, as messages (empty when nothing does). The gate reads every pass
 * and is at least as strict as everything the table prints: see the header. `opts.countResult` is the count kernels'
 * record's decision (`kept`, `derived` or `invalid`) read live; when given, the last complete pass must have been taken
 * under it. The last pass must have been read by the current rule.
 */
function gateProblems(passes, opts = {}) {
  const problems = [];
  const lastComplete = passes.map(isComplete).lastIndexOf(true);
  passes.forEach((pass, i) => {
    const label = `pass ${pass.pass ?? i + 1}`;
    problems.push(...passProblems(label, pass), ...sleepProblems(label, pass));
    if (pass.partial === undefined && !pass.environment?.smoke) {
      problems.push(...inventoryProblems(pass).map((p) => `${label}: ${p}`));
      problems.push(...routeProblems(label, pass, opts.countResult, i === lastComplete));
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

/** The gate's exit code over a record: a problem stops it; passes with none complete leave nothing to publish. */
function gateExit(passes, opts = {}) {
  if (gateProblems(passes, opts).length > 0) return EXIT.problems;
  if (passes.length > 0 && !passes.some(isComplete)) return EXIT.partial;
  return EXIT.ok;
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
  fresh,
  loadRowOf,
  roundCountOf,
  loadFiguresOf,
  discardedOf,
  inventoryProblems,
  isComplete,
  passOfRecord,
  gateProblems,
  gateExit,
  EXIT,
  ROUTE_OF_RESULT,
  MIN_ROUNDS,
};
