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
 * short (no run of twelve digits can occur in a duration). A pass recorded before that carries no `unit`
 * and holds nanoseconds, with no decimals (a tenth of a nanosecond in the per-operation cells); `figurePlaces` gives the
 * places each form is rounded to, and the ratios the rule derives do not depend on the unit.
 *
 * THE SLEEP RULE. A machine that sleeps in the middle of a round gives a duration of minutes for a call of
 * milliseconds. A sleeping machine and a slow head look alike in wall time and differ in CPU time: a slow head burns
 * CPU for the whole of its slow round, a sleeping machine does not. So a subject's figure in a round counts as slept
 * only when BOTH hold: it is more than `SLEEP_FACTOR` (100) times that subject's median in the cell, AND less than
 * `SLEEP_MAX_ON_CPU` (half) of its wall time was on CPU (`process.cpuUsage()` deltas that bracket the same timed span, in the
 * child that times it: the CPU read comes before the wall start and after the wall end, so the wall span holds no CPU
 * read, and each child makes one untimed CPU read before its first span). A round with a slept figure in any cell is not kept: it is stored under the cell's `slept`, with
 * the evidence (for each slept figure its cell, subject, wall figure and CPU figure), and another round is taken in its
 * place, as for the load rule.
 *
 * Why these numbers, from the committed record: the largest ordinary round on record is 11.95 times its cell's median
 * (the first pass, `sparse count`, the control, `rounds[8]`, the ninth round), and the second and third passes reach 5.1
 * times; every sleep on record is at least 1,116 times its median and hit the base, the head and the control alike. A
 * factor alone cannot tell a sleep from a head that is slow in some rounds (a factor of ten alone set aside a head 15
 * times slower in a third of its rounds, and any factor alone sets aside a head slower than it), so the CPU condition is
 * what separates them; the factor then only has to clear the ordinary rounds, and 100 is 8.4 times the largest.
 *
 * Backstop: the gate refuses a cell whose slept rounds fall on the head two or more times and more often than on the
 * base and the control together, unless the cell carries an `explained` note, because a sleep does not pick a subject.
 * A refusal means the cell is taken again. The backstop has a limit: one head-only round that is off CPU is set aside
 * without a refusal, because it needs two. That is accepted: a single off-CPU head round over 100 times the median is a
 * sleep or a deschedule far more often than a slowdown, and a second one refuses the cell.
 *
 * A pass records the rule it was taken under (`sleepRule: { factor, maxOnCpu }`), and only a pass that records it is
 * read by it. A pass without it carries no CPU figures and is read exactly as stored: its kept rounds are not trimmed
 * when it is read (they were judged when measured), so the first three recorded passes, taken before the rule, keep the
 * verdicts and intervals they were stored with.
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
/** A figure is slept only when it is more than this many times its subject's median in the cell... */
const SLEEP_FACTOR = 100;
/** ...and less than this fraction of its wall time was on CPU. */
const SLEEP_MAX_ON_CPU = 0.5;
/** The subjects of a round, in the order of its figures. */
const SUBJECTS = ['base', 'head', 'control'];
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

/**
 * Whether one figure slept: more than `factor` times its subject's median in the cell (`medianWall`), and less than
 * `maxOnCpu` of its wall time on CPU. Both bounds are exclusive: a figure exactly at either is awake.
 */
function sleptFigure(
  wall,
  medianWall,
  cpu,
  rule = { factor: SLEEP_FACTOR, maxOnCpu: SLEEP_MAX_ON_CPU },
) {
  return wall > rule.factor * medianWall && cpu < rule.maxOnCpu * wall;
}

/**
 * Which rounds slept, and why. `figureRows[i]` is the list of cells' `[base, head, control]` wall figures of round `i`
 * and `cpuRows[i]` the CPU figures of the same spans, in the same unit; a figure slept as `sleptFigure` says, against
 * the median of that subject's figures in that cell over all the rounds. Returns, per round, the list of its slept
 * figures as `{ cell, subject, wall, cpu }` (`cell` an index into the round's cells): empty when the round did not sleep.
 */
function sleepEvidence(figureRows, cpuRows) {
  const cells = figureRows.length === 0 ? 0 : figureRows[0].length;
  const medians = [];
  for (let c = 0; c < cells; c++) {
    medians.push([0, 1, 2].map((s) => median(figureRows.map((row) => row[c][s]))));
  }
  return figureRows.map((row, i) => {
    const found = [];
    row.forEach((triple, c) =>
      triple.forEach((wall, s) => {
        const cpu = cpuRows[i][c][s];
        if (sleptFigure(wall, medians[c][s], cpu)) {
          found.push({ cell: c, subject: SUBJECTS[s], wall, cpu });
        }
      }),
    );
    return found;
  });
}

/**
 * Takes rounds until `want` of them are kept. `takeOne(order)` takes one round (`{ order, start, end, samples }`),
 * `triplesOf(samples)` gives the `[base, head, control]` wall figure of each cell in it and `cpuOf(samples)` the CPU
 * figures of the same spans. A round that `keepByLoad` refuses is set aside (`discarded`); a kept round with a slept
 * figure (see `sleepEvidence`), judged against every round taken so far, is set aside as well (`slept`, each with its
 * `evidence`) and taken again. With `checkSleep` false no round is marked as slept. Throws a `RangeError` when more
 * than `limit` rounds (default twice `want`) were set aside for either reason, so a machine that never settles stops
 * the run. Returns `{ kept, discarded, slept }`.
 */
function collectRounds({
  want,
  takeOne,
  triplesOf,
  cpuOf,
  checkSleep = true,
  keepByLoad = () => true,
  limit = 2 * want,
}) {
  const pool = [];
  const discarded = [];
  for (;;) {
    const settled = settlePool(pool, { triplesOf, cpuOf, checkSleep });
    if (settled.kept.length >= want) return { kept: settled.kept, discarded, slept: settled.slept };
    if (settled.slept.length > limit)
      throw new RangeError(`${settled.slept.length} rounds slept: not measuring`);
    const round = takeOne(settled.kept.length % 6);
    admit(round, { pool, discarded, keepByLoad, limit });
  }
}

/** `collectRounds` for a `takeOne` that returns a promise (a round that awaits); the rules are the same code. */
async function collectRoundsAsync({
  want,
  takeOne,
  triplesOf,
  cpuOf,
  checkSleep = true,
  keepByLoad = () => true,
  limit = 2 * want,
}) {
  const pool = [];
  const discarded = [];
  for (;;) {
    const settled = settlePool(pool, { triplesOf, cpuOf, checkSleep });
    if (settled.kept.length >= want) return { kept: settled.kept, discarded, slept: settled.slept };
    if (settled.slept.length > limit)
      throw new RangeError(`${settled.slept.length} rounds slept: not measuring`);
    admit(await takeOne(settled.kept.length % 6), { pool, discarded, keepByLoad, limit });
  }
}

/** The pool's rounds judged against the evidence of sleep: `{ kept, slept }`, each slept round with its `evidence`. */
function settlePool(pool, { triplesOf, cpuOf, checkSleep }) {
  const evidence = checkSleep
    ? sleepEvidence(
        pool.map((r) => triplesOf(r.samples)),
        pool.map((r) => cpuOf(r.samples)),
      )
    : pool.map(() => []);
  return {
    kept: pool.filter((_, i) => evidence[i].length === 0),
    slept: pool.flatMap((r, i) =>
      evidence[i].length > 0 ? [{ ...r, evidence: evidence[i] }] : [],
    ),
  };
}

/** Puts a taken round in the pool, or sets it aside for its load; throws once too many were set aside. */
function admit(round, { pool, discarded, keepByLoad, limit }) {
  if (keepByLoad(round)) {
    pool.push(round);
    return true;
  }
  discarded.push(round);
  if (discarded.length > limit) {
    throw new RangeError(
      `${discarded.length} rounds ended at a load of ${MAX_LOAD} or more: not measuring`,
    );
  }
  return false;
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

/** Every cell of a pass that holds rounds: the gated cells and the import time. */
const allCellsOf = (pass) => [
  ...gatedCellsOf(pass),
  ...(pass.import?.moduleLoadMs ? [pass.import.moduleLoadMs] : []),
];

/**
 * What stops the slept rounds of a pass from being read. Only a pass that records its `sleepRule` (and a rule no weaker
 * than the current one) may hold slept rounds. Each recorded slept round must carry its evidence, and every item of it
 * must hold against the record: the named cell holds a slept round with that wall figure for that subject, the figure is
 * more than the rule's factor times that subject's median over the cell's kept and slept rounds, and less than the rule's
 * share of it was on CPU. A cell whose slept rounds fall on the head two or more times, and more often than on the base
 * and the control together, is refused unless it carries an `explained` note.
 */
function sleptProblems(label, pass) {
  const cells = allCellsOf(pass);
  const holding = cells.filter((c) => (c.slept ?? []).length > 0);
  if (holding.length === 0) return [];
  const rule = pass.sleepRule;
  if (
    rule === undefined ||
    !(rule.factor >= SLEEP_FACTOR) ||
    !(rule.maxOnCpu <= SLEEP_MAX_ON_CPU)
  ) {
    return [
      `${label}: slept rounds are recorded without a sleep rule that judged them (factor at least ${SLEEP_FACTOR}, at most ${SLEEP_MAX_ON_CPU} of the wall time on CPU)`,
    ];
  }
  const problems = [];
  const byName = new Map(cells.map((c) => [cellName(c), c]));
  for (const c of holding) {
    let onHead = 0;
    let onOthers = 0;
    for (const row of c.slept) {
      const evidence = row[6];
      const at = `${label}: ${cellName(c)} slept round [${row.slice(0, 6).join(', ')}]`;
      if (!Array.isArray(evidence) || evidence.length === 0) {
        problems.push(`${at} has no evidence`);
        continue;
      }
      for (const e of evidence) {
        const s = SUBJECTS.indexOf(e?.subject);
        const target = byName.get(e?.cell);
        const sameRound = (r) => r[0] === row[0] && r[4] === row[4] && r[5] === row[5];
        const figures = (list) => (list ?? []).map((r) => r[1 + s]);
        if (
          s < 0 ||
          target === undefined ||
          !(target.slept ?? []).some((r) => sameRound(r) && r[1 + s] === e.wall)
        ) {
          problems.push(`${at} names a slept figure the record does not hold`);
        } else if (
          !sleptFigure(
            e.wall,
            median([...figures(target.rounds), ...figures(target.slept)]),
            e.cpu,
            rule,
          )
        ) {
          problems.push(
            `${at}: ${e.subject} in ${e.cell} is not a sleep (wall ${e.wall} ms, CPU ${e.cpu} ms)`,
          );
        }
      }
      if (evidence.some((e) => e?.subject === 'head')) onHead++;
      if (evidence.some((e) => e?.subject === 'base' || e?.subject === 'control')) onOthers++;
    }
    if (onHead >= 2 && onHead > onOthers && !c.explained) {
      problems.push(
        `${label}: ${cellName(c)} has ${onHead} slept rounds on the head against ${onOthers} on the base and the control: take the cell again, or explain it`,
      );
    }
  }
  return problems;
}

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
 *
 * `{ verdicts: false }` leaves out the first and the last of these, for a bench whose own rule turns a cell's verdict into
 * a decision (a slower or inconclusive cell is then a result, not a failure to explain).
 */
function gateProblems(passes, { verdicts = true } = {}) {
  const problems = [];
  passes.forEach((pass, i) => {
    const label = `pass ${pass.pass ?? i + 1}`;
    if (pass.environment?.smoke) problems.push(`${label}: a smoke pass is no evidence`);
    for (const c of gatedCellsOf(pass)) {
      if (verdicts && kindOf(c.verdict) === 'slower' && !pass.explained) {
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
    problems.push(...sleptProblems(label, pass));
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
    if (!verdicts || kindOf(c.verdict) !== 'inconclusive') continue;
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

/**
 * Ends the process once what it printed has been written, with `code` (or the status already set). A bench process is
 * done when its pass is written: a handle left open by a helper it started must not keep it alive.
 */
function exitWhenDone(code = process.exitCode ?? 0) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

module.exports = {
  exitWhenDone,
  CONTROL_BAND,
  TOLERANCE,
  COVERAGE,
  MAX_LOAD,
  RULE,
  SLEEP_FACTOR,
  SLEEP_MAX_ON_CPU,
  SUBJECTS,
  sleptFigure,
  sleepEvidence,
  collectRounds,
  collectRoundsAsync,
  sleptProblems,
  allCellsOf,
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
