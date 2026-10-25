/*
 * Counting kernels against building: for each counting operation of the TypeScript codec's bitmap (`andCardinality`,
 * `orCardinality`, `andNotCardinality`, `xorCardinality`, `intersects`, `isSubset`, `isEqual`), the time of the count
 * beside the time of the work it replaces (build the combination with the in-place operations and take its size), on
 * every operand pair of `bench/lib/count-cells.cjs`. It answers one question: is each count faster than building? The
 * stop rule, fixed before any measurement, is that a count is kept only if it is on every group (`decisionsOf`).
 *
 * It does NOT judge whether a change slowed the store's hot paths. That is `bench/ts-codec-paired.cjs`, the paired
 * harness, run against the same commit (`--reads`, `--write` and the per-operation cells with `--ops`): this bench
 * shares its rule and nothing else about the question.
 *
 * HOW A CELL IS JUDGED. It is the paired rule of `bench/lib/paired-verdict.cjs` with different subjects: `base` is the
 * build, `head` the count and `control` the build again. A round times the same call once for each of the three, each in
 * a process of its own (so the timed call sites see one function, as the store's do), in an order that rotates through
 * the six permutations; 31 rounds. Per round the count is compared with the mean of the two builds; the cell reports the
 * distribution-free 95% interval of the median of those differences and is `faster than the bar` when its upper end is
 * below -2%, `within` when its upper end is at most +2% and it is not faster, `slower` when its lower end is above +2%,
 * and `inconclusive` otherwise, or whenever the second build's median differs from the first by more than 2%. The
 * load rule (a round that ends at a 1-minute load of 6 or more is not kept) and the sleep rule (a figure over 100 times
 * its median with under half of its wall time on CPU is not kept) are the paired harness's, applied by the same code.
 *
 * THE RECORD is `bench/count-kernels-results.json`: every pass, appended, never replaced, each with every round of every
 * cell (`[order, build, count, build again, loadAtStart, loadAtEnd]`, the figures in milliseconds), the rounds set aside,
 * the medians, intervals and verdicts, the commit, the tree's state, the Node version and the machine. A pass with an
 * inconclusive cell is taken again (`COUNT_RETAKES`, default 2); the earlier pass stays. `--gate` applies the paired
 * gate to the file and prints the decision per operation. A conclusive `slower` stops the gate until the pass carries an
 * `explained` note (the operation is routed to building); an operation that is not `faster` on every group is not kept.
 *
 *   node --expose-gc bench/count-kernels.cjs                  every group, appended to the results file
 *   node --expose-gc bench/count-kernels.cjs --only=<a>|<b>   the cells whose "<group> <operation>" contains either text
 *   node --expose-gc bench/count-kernels.cjs --gate           judge the results file, measure nothing
 *   node --expose-gc bench/count-kernels.cjs --check          every cell once at a tiny scale: times no duration against any bound
 *
 * Environment: `COUNT_RESULTS` (the file to append to), `COUNT_ROUNDS` (at least 31), `COUNT_RETAKES`,
 * `COUNT_ANY_LOAD=1` (turns the load rule off; the pass records it), `COUNT_SMOKE=1` (3 rounds at a tiny scale through the
 * whole pipeline into the scratch file `COUNT_RESULTS` names; the gate refuses such a pass).
 *
 * Wall-clock and machine-dependent: recorded, never asserted.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundleText, evaluate } = require('./lib/codec-engine.cjs');
const { MIN_ROUNDS } = require('./lib/codec-verdict.cjs');
const { measureSteadyCpu, digest } = require('./lib/codec-ops.cjs');
const {
  MAX_LOAD,
  RULE,
  TOLERANCE,
  MALFORMED,
  UNIT,
  nsToMs,
  figurePlaces,
  cellOf,
  worstPaired,
  kindOf,
  cellName,
  gateProblems,
  keepRound,
  collectRounds,
  SLEEP_FACTOR,
  SLEEP_MAX_ON_CPU,
} = require('./lib/paired-verdict.cjs');
const cells = require('./lib/count-cells.cjs');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
const SMOKE = process.env.COUNT_SMOKE === '1';
const SMALL = CHECK || SMOKE;
const ANY_LOAD = process.env.COUNT_ANY_LOAD === '1';
const RESULTS = process.env.COUNT_RESULTS
  ? path.resolve(process.env.COUNT_RESULTS)
  : path.join(__dirname, 'count-kernels-results.json');
const ROUNDS = CHECK
  ? 2
  : SMOKE
    ? 3
    : Math.max(MIN_ROUNDS, Number(process.env.COUNT_ROUNDS) || MIN_ROUNDS);
const WARM_MS = SMALL ? 0 : 300;
const SAMPLE_MS = SMALL ? 0 : 8;
/** Which function each subject of a round times: the build, the count, and the build again as the control. */
const VARIANTS = ['build', 'count', 'build'];
const ORDERS = [
  [0, 1, 2],
  [2, 1, 0],
  [1, 2, 0],
  [0, 2, 1],
  [2, 0, 1],
  [1, 0, 2],
];
const ENTRY = `export { tsRoaringCodec } from './src/ts-roaring/bitmap';`;

const load1 = () => os.loadavg()[0];
const twoDecimals = (x) => +x.toFixed(2);

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}
const wanted = (only, label) =>
  only === undefined || only.split('|').some((t) => label.includes(t));

function waitForQuietMachine() {
  if (SMALL || ANY_LOAD) return;
  for (let waited = 0; load1() >= MAX_LOAD; waited += 20) {
    if (waited >= 600) {
      console.error(`load ${load1().toFixed(2)} stays at or above ${MAX_LOAD}: not measuring`);
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
}

// ---- the subject ---------------------------------------------------------------------------------------------------

/** Every cell of one group, in a process that times one variant (`--child=<bundle>:<group>:<variant>`). */
function child(file, groupName, variant, only) {
  const codec = evaluate(fs.readFileSync(file, 'utf8'), ROOT).tsRoaringCodec;
  const group = cells.groups().find((g) => g.name === groupName);
  const operations = cells.operationsOf(codec, group.ids(SMALL));
  global.gc();
  const out = {};
  for (const op of group.ops) {
    if (!wanted(only, cellName({ dataset: groupName, op }))) continue;
    const fn = operations[op][variant];
    const answer = digest(fn());
    const timed = measureSteadyCpu(fn, 1, { warmMs: WARM_MS, sampleMs: SAMPLE_MS });
    out[op] = { ns: +timed.ns.toFixed(1), cpuNs: +timed.cpuNs.toFixed(1), answer };
  }
  return { group: groupName, ops: out };
}

// ---- orchestration -------------------------------------------------------------------------------------------------

function spawnLast(args) {
  return execFileSync(
    process.execPath,
    ['--expose-gc', __filename, ...(CHECK ? ['--check'] : []), ...args],
    { encoding: 'utf8', env: process.env, maxBuffer: 1 << 28 },
  )
    .trim()
    .split('\n')
    .pop();
}

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

const allEqual = (answers) => answers.every((a) => a === answers[0]);

/**
 * Takes `ROUNDS` kept rounds of `runRound(i)`, which returns subject `i`'s output (0 the build, 1 the count, 2 the build
 * again). A round that ended at `MAX_LOAD` or more, or that holds a slept figure, is set aside and taken again (the rules
 * of `bench/lib/paired-verdict.cjs`); the machine is waited for before every round. A tiny-scale run applies neither rule
 * but still requires every child to report CPU figures. Returns `{ kept, discarded, slept }`.
 */
function takeRounds(runRound, triplesOf, cpuOf) {
  const checkedCpuOf = (samples) => {
    const cpu = cpuOf(samples);
    if (!cpu.every((cell) => cell.every((x) => Number.isFinite(x) && x >= 0))) {
      throw new Error('a subject reported no CPU figure for a span it timed');
    }
    return cpu;
  };
  try {
    return collectRounds({
      want: ROUNDS,
      triplesOf,
      cpuOf: checkedCpuOf,
      checkSleep: !SMALL,
      keepByLoad: (round) => SMALL || keepRound(round.end, ANY_LOAD),
      takeOne: (order) => {
        waitForQuietMachine();
        const start = twoDecimals(load1());
        const sample = [null, null, null];
        for (const i of ORDERS[order]) sample[i] = runRound(i);
        const round = { order, start, end: twoDecimals(load1()), samples: sample };
        checkedCpuOf(round.samples);
        return round;
      },
    });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
}

const rowsOf = (list, figure, toMs) =>
  list.map((r) => {
    const [b, h, c] = figure(r.samples).map(toMs);
    return [r.order, b, h, c, r.start, r.end];
  });

/** A cell from its kept, discarded and slept rounds, in the form a pass stores (milliseconds, a tenth of a nanosecond). */
function pairedCell(taken, figure, names) {
  const toMs = (x) => nsToMs(x, 1);
  const cell = cellOf(rowsOf(taken.kept, figure, toMs), figurePlaces('tenth', UNIT));
  const discarded = rowsOf(taken.discarded, figure, toMs);
  const slept = taken.slept.map((r) => [
    ...rowsOf([r], figure, toMs)[0],
    r.evidence.map((e) => ({
      cell: names[e.cell],
      subject: e.subject,
      wall: toMs(e.wall),
      cpu: toMs(e.cpu),
    })),
  ]);
  return {
    ...cell,
    ...(discarded.length > 0 ? { discarded } : {}),
    ...(slept.length > 0 ? { slept } : {}),
  };
}

function measureGroups(file, only) {
  const out = [];
  for (const group of cells.groups()) {
    const opNames = group.ops.filter((op) => wanted(only, cellName({ dataset: group.name, op })));
    if (opNames.length === 0) continue;
    const taken = takeRounds(
      (i) =>
        JSON.parse(
          spawnLast([
            `--child=${file}:${group.name}:${VARIANTS[i]}`,
            ...(only ? [`--only=${only}`] : []),
          ]),
        ),
      (samples) => opNames.map((op) => samples.map((x) => x.ops[op].ns)),
      (samples) => opNames.map((op) => samples.map((x) => x.ops[op].cpuNs)),
    );
    const all = [...taken.kept, ...taken.discarded, ...taken.slept];
    for (const op of opNames) {
      out.push({
        dataset: group.name,
        op,
        // The build and the count must give one answer for the cell, in every round.
        answersAgree: allEqual(all.flatMap((r) => r.samples.map((s) => s.ops[op].answer))),
        ...pairedCell(
          taken,
          (s) => s.map((x) => x.ops[op].ns),
          opNames.map((o) => cellName({ dataset: group.name, op: o })),
        ),
      });
    }
  }
  return out;
}

function environment() {
  let tree = 'unknown';
  try {
    tree = git('status', '--porcelain').length === 0 ? 'clean' : 'dirty';
  } catch {
    /* recorded as unknown */
  }
  return {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    head: git('rev-parse', 'HEAD'),
    tree,
    anyLoad: ANY_LOAD,
    smoke: SMOKE,
    rounds: ROUNDS,
    maxLoad: MAX_LOAD,
  };
}

function wellFormed(doc) {
  const problems = [];
  for (const c of doc.ops) {
    const name = cellName(c);
    if (c.answersAgree !== true)
      problems.push(`${name}: the count and the build gave different answers`);
    if (c.verdict === MALFORMED) problems.push(`${name}: no verdict`);
    if (!Array.isArray(c.rounds) || c.rounds.length < ROUNDS)
      problems.push(`${name}: too few rounds`);
  }
  if (doc.ops.length === 0) problems.push('no cells');
  return problems;
}

function readResults() {
  const file = fs.existsSync(RESULTS)
    ? JSON.parse(fs.readFileSync(RESULTS, 'utf8'))
    : { passes: [] };
  if (!Array.isArray(file.passes)) throw new Error(`${RESULTS} is not a list of passes`);
  return file;
}

/** Adds a pass to the results file, which keeps every earlier pass: a re-take never hides the first reading. */
function appendPass(doc) {
  const file = readResults();
  doc.pass = file.passes.length + 1;
  file.passes.push(doc);
  fs.writeFileSync(RESULTS, `${JSON.stringify(file)}\n`);
}

function printPass(doc) {
  for (const c of doc.ops) {
    const [lo, hi] = c.headInterval;
    console.log(
      `${cellName(c)}: count ${(c.headVsReference * 100).toFixed(1)}% of build [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}], second build ${(c.controlVsBase * 100).toFixed(1)}% (${c.verdict})`,
    );
  }
  const { maxLoadAtEnd, discardedRounds, sleptRounds } = doc.load;
  console.log(
    `pass ${doc.pass ?? 'check'} worst: ${doc.verdict}; kept rounds ended at a load of at most ${maxLoadAtEnd.toFixed(2)}; ${discardedRounds} round(s) discarded at ${MAX_LOAD} or more; ${sleptRounds} round(s) discarded as slept${doc.environment.anyLoad ? ' (the load rule was OFF for this pass)' : ''}${doc.environment.smoke ? ' (SMOKE: nothing here is evidence)' : ''}`,
  );
}

/** The gate over every pass, and the stop rule's decision for each operation. Returns the exit code. */
function applyGate() {
  const file = readResults();
  const problems = gateProblems(file.passes);
  for (const p of problems) console.log(`gate: ${p}`);
  if (problems.length === 0) console.log(`gate: ${RESULTS}: every pass is clear`);
  for (const d of cells.decisionsOf(file.passes)) {
    console.log(
      d.kept
        ? `keep ${d.op}: faster than building on every group`
        : `NOT KEPT ${d.op}: ${d.stoppedBy.map((s) => `${s.cell} (${s.verdict})`).join('; ')}`,
    );
  }
  if (problems.some((p) => p.includes('conclusively slower'))) return 3;
  return problems.length > 0 ? 4 : 0;
}

/** One pass, as a document with its time, commits, machine and loads. */
function takePass(file, only) {
  const doc = {
    schema: 2,
    unit: UNIT,
    rule: RULE,
    sleepRule: { factor: SLEEP_FACTOR, maxOnCpu: SLEEP_MAX_ON_CPU },
    tolerance: TOLERANCE,
    subjects: { base: 'build', head: 'count', control: 'build again' },
    environment: environment(),
    started: new Date().toISOString(),
  };
  doc.environment.loadAtStart = twoDecimals(load1());
  doc.ops = measureGroups(file, only);
  doc.finished = new Date().toISOString();
  doc.environment.loadAtEnd = twoDecimals(load1());
  doc.load = {
    maxLoadAtEnd: Math.max(0, ...doc.ops.flatMap((c) => c.rounds.map((r) => r[5]))),
    discardedRounds: Math.max(0, ...doc.ops.map((c) => (c.discarded ?? []).length)),
    sleptRounds: Math.max(0, ...doc.ops.map((c) => (c.slept ?? []).length)),
  };
  doc.verdict = worstPaired(doc.ops.map((c) => c.verdict));
  return doc;
}

function main() {
  const only = arg('only');
  if (arg('child')) {
    const spec = arg('child');
    const [rest, variant] = [
      spec.slice(0, spec.lastIndexOf(':')),
      spec.slice(spec.lastIndexOf(':') + 1),
    ];
    const file = rest.slice(0, rest.lastIndexOf(':'));
    const group = rest.slice(rest.lastIndexOf(':') + 1);
    console.log(JSON.stringify(child(file, group, variant, only)));
    return;
  }
  if (process.argv.includes('--gate')) {
    process.exitCode = applyGate();
    return;
  }
  if (SMOKE && !process.env.COUNT_RESULTS) {
    console.error('COUNT_SMOKE=1 needs COUNT_RESULTS to name a scratch file');
    process.exit(2);
  }
  if (typeof global.gc !== 'function') {
    console.error('run with node --expose-gc');
    process.exit(2);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-kernels-'));
  try {
    const file = path.join(dir, 'head.cjs');
    fs.writeFileSync(file, bundleText({ root: ROOT, entry: ENTRY, sourcefile: 'count-entry.ts' }));
    const retakes = SMALL ? 0 : Number(process.env.COUNT_RETAKES ?? 2);
    for (let n = 0; n <= retakes; n++) {
      const doc = takePass(file, only);
      const problems = wellFormed(doc);
      if (problems.length > 0) {
        console.error(problems.join('\n'));
        process.exit(1);
      }
      if (CHECK) {
        console.log(`count-kernels --check: ok (${doc.ops.length} cells, ${ROUNDS} rounds each)`);
        return;
      }
      appendPass(doc);
      printPass(doc);
      // A pass with a cell the rule could not resolve is recorded and taken again; the earlier reading stays.
      if (!doc.ops.some((c) => kindOf(c.verdict) === 'inconclusive')) break;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exitCode = applyGate();
}

main();
