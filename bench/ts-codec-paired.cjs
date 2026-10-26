/*
 * Paired before-and-after bench for a change under `packages/roaring/src/ts-roaring/`: the store's hot paths and write
 * path with the codec of a base commit, the codec of the working tree, and the base codec a second time as an A/A
 * control, rotated within one run, one subject per process. Two separate runs of an hour each cannot resolve a
 * difference that small (their own noise is the size of the bar), so the comparison is paired, with the instrument's own
 * noise measured in each run by the control and checked against a fixed bound.
 *
 * WHAT IS MEASURED
 *
 *   reads    `seg.has`, `seg.count()`, a full `iterate()`, `intersect` of two and of four operands and `andNot`, through
 *            `CloudRoaring` over `MemoryStorage` with a cache that holds every chunk, warmed by time, on the data sets
 *            of the engine bench (`bench/lib/codec-data.cjs`): dense, sparse, runs, mixed and spread8k (a million ids
 *            over 62,500 chunks is the write set below, so the combines are timed on 8,192 chunks of that shape).
 *   write    a bulk `load` of 1,000,000 ids over 62,500 chunks and an `eraseSubject` of one id (the rewrite of that
 *            generation), each timed in a fresh process after one untimed round of the same two calls, with a
 *            collection before each timed call.
 *   ops      the codec's own operations, one call at a time and apart from the store (`bench/lib/codec-ops.cjs`, which
 *            another paired bench can import): `has`, `decode` (warm, and `decode first`, the first call of a fresh
 *            process, which is the cold decode path the store's warm read cells never reach, because its cache holds
 *            decoded bitmaps), `serialize`, `iterate`, `toUint32`, `optimize`, `count`, `clone`, `build`, `addMany`,
 *            `removeMany`, and `and`, `or`, `andNot` on six operand pairs, on dense, sparse and run chunks and on a
 *            128-container bitmap. Cells are named `ops <operation> <shape>`.
 *   import   the time to import `packages/roaring/dist/bitmap.js` against `packages/roaring/dist/index.js` (the
 *            built entries), each in a fresh process, with the main entry a second time as the control, and the bytes
 *            of an esbuild bundle (minified, and gzipped) of a one-line importer of the class from each entry.
 *            Needs `pnpm build` first; `--no-import` leaves it out.
 *
 * HOW A COMPARISON IS JUDGED
 *
 * A round times the same call for three subjects: `base` (the code at the base commit), `head` (this tree's) and
 * `control` (the base again), each in a process of its own, in an order that rotates through the six permutations.
 * A round is `[order, base, head, control, loadAtStart, loadAtEnd]`, the three figures in milliseconds with the decimals
 * that keep the instrument's resolution (a pass records `"unit": "ms"`; see `bench/lib/paired-verdict.cjs`). Rule `median-interval-v2`
 * (`bench/lib/paired-verdict.cjs`, which says it in full): per round the head is compared with the mean of the base and
 * the control; the cell reports the distribution-free 95% interval of the median of those differences, and is `within`
 * when the interval's upper end is at most 2%, `slower` when its lower end is above 2%, `faster` when its upper end is
 * below -2%, and `inconclusive` otherwise, or whenever the control's median differs from the base by more than 2% (the
 * machine moved; re-run, never publish). The 2% is fixed before a measurement and never changed after.
 *
 * THE GATE reads every pass of the results file, not the last: a cell judged `slower` in any pass fails unless that pass
 * carries an `explained` note, so a green re-take never erases it. A cell still `inconclusive` in the last pass needs an
 * entry in that pass's `unresolved` notes, keyed by the cell's name (`<data set> <op>`), that quotes its bound (the
 * interval's upper end, such as `+3.2%`): it is published with that bound and never called within. `--gate` applies the
 * gate to the results file without measuring; a run applies it after its last pass (exit 3: a conclusive "slower"; exit
 * 4: a cell left open or another failure of the record).
 *
 * THE LOAD RULE. The 1-minute load average is recorded at the start and at the end of every round (`loadAtStart`,
 * `loadAtEnd`). The machine is waited for before a round, and a round that ends at a load of 6 or more is not kept: it
 * is stored under the cell's `discarded` and the round is taken again, so a kept round never ended at a load of 6 or
 * more (`PAIRED_ANY_LOAD=1` turns the rule off, and the pass records it). A pass's `load` gives the highest load a kept
 * round ended at and the number of rounds discarded.
 *
 * THE SLEEP RULE. A machine that sleeps during a round turns a call of milliseconds into one of minutes, and a head that is
 * really slow in some rounds looks the same in wall time; they differ in CPU time, because a slow head burns CPU and a
 * sleeping machine does not. Every child therefore times each span twice, wall (`process.hrtime`) and CPU
 * (`process.cpuUsage()` deltas bracketing the same span). A subject's figure in a round counts as slept only when it is more
 * than 100 times that subject's median in the cell AND less than half of its wall time was on CPU. A round with a slept
 * figure in any cell is stored under the cell's `slept` with that evidence (cell, subject, wall figure, CPU figure), taken
 * again, and counted (a pass's `load.sleptRounds`, and the summary line it prints). The pass records the rule it was taken
 * under (`sleepRule: { factor: 100, maxOnCpu: 0.5 }`); the gate re-checks every recorded slept round against it, and
 * refuses a cell whose slept rounds fall on the head two or more times and more often than on the base and the control
 * together unless the cell carries an `explained` note. The reasons for the numbers are in `bench/lib/paired-verdict.cjs`.
 * A pass recorded before the rule has no `sleepRule` and is read as stored. A tiny-scale run applies neither this rule nor
 * the load rule.
 *
 * Every subject must give the same answer for a cell, or the run fails.
 *
 * The base is the merge base of `origin/main` and HEAD unless `PAIRED_BASE` names a commit. Its `packages/` are
 * extracted with `git archive` into a work folder (`PAIRED_WORKDIR`, default the system's temporary folder) and
 * bundled with esbuild; nothing in the working tree is touched.
 *
 * `--check` runs everything once at a tiny scale and fails only if the output is malformed or the subjects disagree;
 * it compares no duration with any bound. `--all` takes the full measurement and writes
 * `bench/ts-codec-paired-results.json` (`PAIRED_RESULTS` names another file). `--reads`, `--write`, `--ops` and
 * `--import` run one part; `--only=<text>` keeps the read cells whose "<data set> <op>" contains the text (`a|b` keeps
 * either), `--only-ops=<text>` the same for the per-operation cells. `--all` is the reads, the write path, the
 * per-operation cells and the import time. Environment: `PAIRED_ROUNDS` (at least 31), `PAIRED_ANY_LOAD=1`,
 * `PAIRED_SMOKE=1` (a few rounds at a tiny scale through the whole pipeline, writing a pass that the gate refuses; it
 * needs `PAIRED_RESULTS` to name a scratch file).
 *
 * Wall-clock and machine-dependent: recorded, never asserted.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { bundleText, evaluate } = require('./lib/codec-engine.cjs');
const { idsOf } = require('./lib/codec-data.cjs');
const { MIN_ROUNDS } = require('./lib/codec-verdict.cjs');
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
  gatedCellsOf,
  gateProblems,
  keepRound,
  collectRounds,
  SLEEP_FACTOR,
  SLEEP_MAX_ON_CPU,
  exitWhenDone,
} = require('./lib/paired-verdict.cjs');
const ops = require('./lib/codec-ops.cjs');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
const RESULTS = process.env.PAIRED_RESULTS
  ? path.resolve(process.env.PAIRED_RESULTS)
  : path.join(__dirname, 'ts-codec-paired-results.json');
const SMOKE = process.env.PAIRED_SMOKE === '1';
/** A tiny-scale run: nothing it measures is evidence. */
const SMALL = CHECK || SMOKE;
const ANY_LOAD = process.env.PAIRED_ANY_LOAD === '1';
const ROUNDS = CHECK
  ? 2
  : SMOKE
    ? Math.max(2, Number(process.env.PAIRED_ROUNDS) || 3)
    : Math.max(MIN_ROUNDS, Number(process.env.PAIRED_ROUNDS) || MIN_ROUNDS);
const WARM_MS = SMALL ? 0 : 300;
const SAMPLE_MS = SMALL ? 0 : 25;
const CHUNK_SCALE = SMALL
  ? { dense: 2, sparse: 4, runs: 2, mixed: 3, spread8k: 100 }
  : { dense: 32, sparse: 256, runs: 128, mixed: 128, spread8k: 8192 };
const WRITE_CHUNKS = SMALL ? 300 : 62500;
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];
const OPS = ['has', 'count', 'iterate', 'intersect2', 'intersect4', 'andNot'];
const ORDERS = [
  [0, 1, 2],
  [2, 1, 0],
  [1, 2, 0],
  [0, 2, 1],
  [2, 0, 1],
  [1, 0, 2],
];
const ENTRY = [
  `export * as roaring from './src/index';`,
  `export { setFlagshipCodec } from './src/roaring-codec';`,
  `export { tsRoaringCodec } from './src/ts-roaring/bitmap';`,
].join('\n');

const now = () => Number(process.hrtime.bigint());
/** The CPU time this process has used, user and system, in nanoseconds (the clock counts microseconds). */
const cpuNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) * 1e3;
};
/** The first CPU read of a process is slow: each child makes one untimed call before its first timed span. */
const warmCpuClock = () => {
  cpuNow();
  cpuNow();
};
const load1 = () => os.loadavg()[0];
const twoDecimals = (x) => +x.toFixed(2);
const keep = new Array(16).fill(0);

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

// ---- the subjects --------------------------------------------------------------------------------------------------

/** The engine of a bundle file, with the TypeScript codec in force. */
function engineOf(file) {
  const engine = evaluate(fs.readFileSync(file, 'utf8'), ROOT);
  engine.setFlagshipCodec(engine.tsRoaringCodec);
  return engine;
}

const segmentNames = (dataset) => ['a', 'b', 'c', 'd'].map((n) => `${dataset}-${n}`);

function newStore(engine, backend) {
  return new engine.roaring.CloudRoaring({
    storage: backend,
    cache: { maxChunks: 70000, genTtlMs: 3_600_000 },
  });
}

async function loadSegments(store, dataset) {
  const idLists = [];
  for (const [i, name] of segmentNames(dataset).entries()) {
    const ids = idsOf(dataset, i, CHUNK_SCALE);
    idLists.push(ids);
    const result = await store.load({ segment: name }, ids, { sorted: true });
    if (!result.published) throw new Error(`load of ${name} was not published`);
  }
  return idLists;
}

/** Every call of a cell as a function of the four segments of a data set. */
function opsOf(idLists) {
  const ids = idLists[0];
  const probes = [];
  for (let i = 0; i < 512; i++)
    probes.push(
      i % 2 === 0 ? ids[(i * 7919) % ids.length] : (ids[(i * 104729) % ids.length] ^ 1) >>> 0,
    );
  const drain = async (stream) => {
    let n = 0;
    let x = 0;
    for await (const id of stream) {
      n++;
      x = (x + id) >>> 0;
    }
    return `${n}:${x}`;
  };
  return {
    has: async ([a]) => {
      let n = 0;
      for (let i = 0; i < probes.length; i++) if (await a.has(probes[i])) n++;
      return String(n);
    },
    count: async ([a]) => String(await a.count()),
    iterate: ([a]) => drain(a.iterate()),
    intersect2: ([a, b]) => drain(a.intersect([b])),
    intersect4: ([a, b, c, d]) => drain(a.intersect([b, c, d])),
    andNot: ([a, b]) => drain(a.andNot([b])),
  };
}

/** The wall and CPU nanoseconds per call of `reps` calls of `fn`, timed over one span. */
async function timeCalls(fn, reps) {
  const c0 = cpuNow();
  const t0 = now();
  for (let i = 0; i < reps; i++) keep[i & 15] = await fn();
  const wall = now() - t0;
  const cpu = cpuNow() - c0;
  return { ns: wall / reps, cpuNs: cpu / reps };
}

/** Warm by time, then the batch size that makes one timed sample about `SAMPLE_MS`. */
async function calibrate(fn) {
  const end = now() + WARM_MS * 1e6;
  let calls = 0;
  let spent;
  do {
    const t0 = now();
    keep[calls & 15] = await fn();
    spent = now() - t0;
    calls++;
  } while (now() < end);
  return Math.max(1, Math.round((SAMPLE_MS * 1e6) / Math.max(spent, 1)));
}

/** Every op of one data set in a process that holds one subject (`--child-reads=<bundle>:<dataset>`). */
async function readsChild(file, dataset, only) {
  const engine = engineOf(file);
  const backend = new engine.roaring.MemoryStorage();
  const idLists = await loadSegments(newStore(engine, backend), dataset);
  const store = newStore(engine, backend);
  const segs = segmentNames(dataset).map((n) => store.segment(n));
  const ops = opsOf(idLists);
  global.gc();
  warmCpuClock();
  const out = {};
  for (const op of OPS) {
    if (!wanted(only, `${dataset} ${op}`)) continue;
    const fn = () => ops[op](segs);
    const answer = await fn();
    const reps = await calibrate(fn);
    const timed = await timeCalls(fn, reps);
    out[op] = { ns: +timed.ns.toFixed(0), cpuNs: +timed.cpuNs.toFixed(0), answer };
  }
  return { dataset, ops: out };
}

/** A load and an erasure's rewrite of the 62,500-chunk set, after one untimed round (`--child-write=<bundle>`). */
async function writeChild(file) {
  const engine = engineOf(file);
  const ids = idsOf('spread8k', 0, { spread8k: WRITE_CHUNKS });
  warmCpuClock();
  let timed;
  for (let round = 0; round < 2; round++) {
    const store = newStore(engine, new engine.roaring.MemoryStorage());
    global.gc();
    let c0 = cpuNow();
    let t0 = now();
    const loaded = await store.load({ segment: 'w' }, ids, { sorted: true });
    const loadNs = now() - t0;
    const loadCpuNs = cpuNow() - c0;
    if (!loaded.published) throw new Error('the write-path load was not published');
    const victim = ids[ids.length >> 1];
    global.gc();
    c0 = cpuNow();
    t0 = now();
    const erased = await store.eraseSubject(victim, { allNamespaces: true });
    const eraseNs = now() - t0;
    const eraseCpuNs = cpuNow() - c0;
    if (!JSON.stringify(erased).includes('"erased":true')) throw new Error('nothing was erased');
    timed = {
      load: loadNs,
      erase: eraseNs,
      loadCpu: loadCpuNs,
      eraseCpu: eraseCpuNs,
      answer: `${ids.length}:${victim}`,
    };
  }
  return timed;
}

/** The time to import one built entry in a fresh process (`--child-import=<file>`). */
async function importChild(file) {
  const url = require('node:url').pathToFileURL(file).href;
  warmCpuClock();
  const c0 = cpuNow();
  const t0 = now();
  keep[0] = await import(url);
  const wall = now() - t0;
  const cpu = cpuNow() - c0;
  return { ms: +(wall / 1e6).toFixed(3), cpuMs: +(cpu / 1e6).toFixed(3) };
}

/** The codec of a subject bundle: the TypeScript codec the bundle exports. */
const codecOf = (file) => evaluate(fs.readFileSync(file, 'utf8'), ROOT).tsRoaringCodec;

const opsInputs = () =>
  ops.opCells(ops.storedBytesFromJson(fs.readFileSync(process.env.PAIRED_OPS_INPUTS, 'utf8')));

/** The warmed per-operation cells, in a process that holds one subject (`--child-ops=<bundle>`). */
function opsChild(file, onlyOps) {
  const codec = codecOf(file);
  warmCpuClock();
  const out = {};
  for (const cell of opsInputs()) {
    if (cell.cold || (onlyOps !== undefined && !onlyOps.split('|').includes(cell.name))) continue;
    const fn = cell.make(codec);
    const answer = ops.digest(fn());
    global.gc();
    const timed = ops.measureSteadyCpu(fn, cell.unit, { warmMs: WARM_MS, sampleMs: SMALL ? 0 : 8 });
    out[cell.name] = { ns: +timed.ns.toFixed(1), cpuNs: +timed.cpuNs.toFixed(1), answer };
  }
  return out;
}

/** The first call of one cold cell, in a fresh process (`--child-ops-cold=<bundle> --cell=<name>`). */
function opsColdChild(file, name) {
  const cell = opsInputs().find((c) => c.cold && c.name === name);
  if (cell === undefined) throw new Error(`no cold cell ${JSON.stringify(name)}`);
  const fn = cell.make(codecOf(file));
  const timed = ops.measureColdCpu(fn);
  return { ns: timed.ns, cpuNs: +timed.cpuNs.toFixed(0), answer: ops.digest(fn()) };
}

// ---- orchestration -------------------------------------------------------------------------------------------------

/** Runs this script in a child process with `args` and returns the last line of its output. */
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

/** The bundles of the base commit and of this tree, in a work folder; the base's sources come from `git archive`. */
function prepareSubjects(withOps = false) {
  const base = process.env.PAIRED_BASE ?? git('merge-base', 'origin/main', 'HEAD');
  const baseSha = git('rev-parse', `${base}^{commit}`);
  const dir = fs.mkdtempSync(
    path.join(process.env.PAIRED_WORKDIR ?? os.tmpdir(), 'ts-codec-paired-'),
  );
  const baseRoot = path.join(dir, 'base');
  fs.mkdirSync(baseRoot);
  const archive = execFileSync(
    'git',
    ['-C', ROOT, 'archive', baseSha, 'packages', 'tsconfig.base.json', 'tsconfig.json'],
    {
      maxBuffer: 1 << 30,
    },
  );
  execFileSync('tar', ['-x', '-C', baseRoot], { input: archive });
  const files = {
    base: path.join(dir, 'base.cjs'),
    head: path.join(dir, 'head.cjs'),
  };
  fs.writeFileSync(
    files.base,
    bundleText({ root: baseRoot, entry: ENTRY, sourcefile: 'base-entry.ts' }),
  );
  fs.writeFileSync(
    files.head,
    bundleText({ root: ROOT, entry: ENTRY, sourcefile: 'head-entry.ts' }),
  );
  const opsFile = path.join(dir, 'ops-inputs.json');
  if (withOps) fs.writeFileSync(opsFile, ops.storedBytesToJson(ops.storedBytesOf(nativeCodec())));
  return { dir, baseSha, opsInputs: opsFile, files: [files.base, files.head, files.base] };
}

function allEqual(answers) {
  return answers.every((a) => a === answers[0]);
}

/**
 * Takes `ROUNDS` kept rounds of `runRound(i)`, which returns subject `i`'s output (0 base, 1 head, 2 control).
 * `triplesOf(samples)` gives the `[base, head, control]` wall figure of each cell the round measured and `cpuOf(samples)`
 * the CPU figures of the same spans. Each round records the load before and after; a round that ended at `MAX_LOAD` or
 * more is set aside and taken again, and so is a round with a slept figure (more than 100 times its subject's median in
 * its cell, with less than half of its wall time on CPU: the machine slept; see `bench/lib/paired-verdict.cjs`). The
 * machine is waited for before every round. A tiny-scale run applies neither rule, but still requires every child to
 * report its CPU figures. Returns `{ kept, discarded, slept }`, each a list of `{ order, start, end, samples }` (a slept
 * round also carries its `evidence`).
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

/**
 * `[order, base, head, control, loadAtStart, loadAtEnd]` of each round, from `figure(samples) -> [b, h, c]` in the
 * unit `toMs` converts to milliseconds.
 */
const rowsOf = (list, figure, toMs) =>
  list.map((r) => {
    const [b, h, c] = figure(r.samples).map(toMs);
    return [r.order, b, h, c, r.start, r.end];
  });

/**
 * A cell from its kept, discarded and slept rounds. `kind` says how the figure is measured: `whole` nanoseconds, `tenth`
 * (a tenth of a nanosecond) or `import` (already milliseconds); the cell stores milliseconds. `names` are the names of the
 * cells a round measured, in the order of `triplesOf`, so a slept round's evidence names its cell as the gate finds it.
 * A slept row is a round's six figures and then its evidence: `{ cell, subject, wall, cpu }` for each slept figure.
 */
function pairedCell(taken, figure, kind, names) {
  const decimals = kind === 'tenth' ? 1 : 0;
  const toMs = kind === 'import' ? (x) => x : (x) => nsToMs(x, decimals);
  const cell = cellOf(rowsOf(taken.kept, figure, toMs), figurePlaces(kind, UNIT));
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

function readsMeasure(subjects, only) {
  const cells = [];
  for (const dataset of DATASETS) {
    const opNames = OPS.filter((op) => wanted(only, `${dataset} ${op}`));
    const taken = takeRounds(
      (i) =>
        JSON.parse(
          spawnLast([
            `--child-reads=${subjects.files[i]}:${dataset}`,
            ...(only ? [`--only=${only}`] : []),
          ]),
        ),
      (samples) => opNames.map((op) => samples.map((x) => x.ops[op].ns)),
      (samples) => opNames.map((op) => samples.map((x) => x.ops[op].cpuNs)),
    );
    for (const op of opNames) {
      const answers = [...taken.kept, ...taken.discarded, ...taken.slept].flatMap((r) =>
        r.samples.map((s) => s.ops[op].answer),
      );
      cells.push({
        dataset,
        op,
        answersAgree: allEqual(answers),
        ...pairedCell(
          taken,
          (s) => s.map((x) => x.ops[op].ns),
          'whole',
          opNames.map((o) => cellName({ dataset, op: o })),
        ),
      });
    }
  }
  return cells;
}

function writeMeasure(subjects) {
  const taken = takeRounds(
    (i) => JSON.parse(spawnLast([`--child-write=${subjects.files[i]}`])),
    (samples) => ['load', 'erase'].map((op) => samples.map((x) => x[op])),
    (samples) => ['load', 'erase'].map((op) => samples.map((x) => x[`${op}Cpu`])),
  );
  const answers = [...taken.kept, ...taken.discarded, ...taken.slept].flatMap((r) =>
    r.samples.map((s) => s.answer),
  );
  return ['load', 'erase'].map((op) => ({
    dataset: `spread ${WRITE_CHUNKS} chunks`,
    op,
    answersAgree: allEqual(answers),
    ...pairedCell(
      taken,
      (s) => s.map((x) => x[op]),
      'whole',
      ['load', 'erase'].map((o) => cellName({ dataset: `spread ${WRITE_CHUNKS} chunks`, op: o })),
    ),
  }));
}

/** The per-operation cells of `bench/lib/codec-ops.cjs`, each as a cell named `ops <operation> <shape>`. */
function opsMeasure(subjects, onlyOps) {
  const cells = ops.opCells({});
  const steady = cells
    .filter((c) => !c.cold && wanted(onlyOps, `ops ${c.name}`))
    .map((c) => c.name);
  const cold = cells.filter((c) => c.cold && wanted(onlyOps, `ops ${c.name}`)).map((c) => c.name);
  if (steady.length + cold.length === 0) throw new Error('--only-ops keeps no per-operation cell');
  process.env.PAIRED_OPS_INPUTS = subjects.opsInputs;
  const at = (x, name) => x.steady[name] ?? x.cold[name];
  const taken = takeRounds(
    (i) => ({
      steady:
        steady.length === 0
          ? {}
          : JSON.parse(
              spawnLast([`--child-ops=${subjects.files[i]}`, `--only-ops=${steady.join('|')}`]),
            ),
      cold: Object.fromEntries(
        cold.map((name) => [
          name,
          JSON.parse(spawnLast([`--child-ops-cold=${subjects.files[i]}`, `--cell=${name}`])),
        ]),
      ),
    }),
    (samples) => [...steady, ...cold].map((name) => samples.map((x) => at(x, name).ns)),
    (samples) => [...steady, ...cold].map((name) => samples.map((x) => at(x, name).cpuNs)),
  );
  const names = [...steady, ...cold].map((name) => cellName({ dataset: 'ops', op: name }));
  const all = [...taken.kept, ...taken.discarded, ...taken.slept];
  return [...steady, ...cold].map((name) => {
    return {
      dataset: 'ops',
      op: name,
      answersAgree: allEqual(all.flatMap((r) => r.samples.map((x) => at(x, name).answer))),
      ...pairedCell(taken, (s) => s.map((x) => at(x, name).ns), 'tenth', names),
    };
  });
}

/** The native codec of this checkout, which writes the stored bytes every subject decodes. */
function nativeCodec() {
  const text = bundleText({
    root: ROOT,
    entry: `export { roaringCodec } from ${JSON.stringify(path.join(ROOT, 'tests/helpers/native-codec'))};`,
    sourcefile: 'native-entry.ts',
  });
  return evaluate(text, ROOT).roaringCodec;
}

/** The bytes of a minified esbuild bundle of a one-line importer of `RoaringBitmap` from a built entry. */
function bundleBytes(entryFile) {
  const { buildSync } = require('esbuild');
  const out = buildSync({
    stdin: {
      contents: `export { RoaringBitmap } from ${JSON.stringify(entryFile)};`,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    minify: true,
    write: false,
    logLevel: 'error',
  }).outputFiles[0].contents;
  return { bytes: out.length, gzipBytes: zlib.gzipSync(out).length };
}

/** The import time of the built `./bitmap` entry against the main entry; informational, outside the hot-path verdict. */
function importMeasure() {
  const dist = path.join(ROOT, 'packages/roaring/dist');
  const files = [
    path.join(dist, 'index.js'),
    path.join(dist, 'bitmap.js'),
    path.join(dist, 'index.js'),
  ];
  for (const f of files)
    if (!fs.existsSync(f)) throw new Error(`${f} is missing: run pnpm build first`);
  // Round layout here is [order, main entry, ./bitmap, main entry again]: the "head" column is the ./bitmap entry.
  const taken = takeRounds(
    (i) => JSON.parse(spawnLast([`--child-import=${files[i]}`])),
    (samples) => [samples.map((x) => x.ms)],
    (samples) => [samples.map((x) => x.cpuMs)],
  );
  return {
    runs: ROUNDS,
    informational: true,
    moduleLoadMs: pairedCell(taken, (s) => s.map((x) => x.ms), 'import', ['import']),
    bundle: { mainEntry: bundleBytes(files[0]), bitmapEntry: bundleBytes(files[1]) },
  };
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
  for (const c of gatedCellsOf(doc)) {
    const name = cellName(c);
    if (c.answersAgree !== true) problems.push(`${name}: the subjects gave different answers`);
    if (c.verdict === MALFORMED) problems.push(`${name}: no verdict`);
    if (!Array.isArray(c.rounds) || c.rounds.length < ROUNDS)
      problems.push(`${name}: too few rounds`);
  }
  if (doc.reads !== undefined && doc.reads.length === 0) problems.push('no read cells');
  if (doc.ops !== undefined && doc.ops.length === 0) problems.push('no per-operation cells');
  if (doc.import !== undefined && doc.import.moduleLoadMs.verdict === MALFORMED)
    problems.push('the import time has no verdict');
  return problems;
}

/** Applies the gate to every pass in the results file; prints what stops it and returns the exit code. */
function applyGate() {
  const file = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const problems = gateProblems(file.passes);
  for (const p of problems) console.log(`gate: ${p}`);
  if (problems.length === 0) console.log(`gate: ${RESULTS}: every pass is clear`);
  if (problems.some((p) => p.includes('conclusively slower'))) return 3;
  return problems.length > 0 ? 4 : 0;
}

async function main() {
  const only = arg('only');
  if (arg('child-reads')) {
    const spec = arg('child-reads');
    const file = spec.slice(0, spec.lastIndexOf(':'));
    const dataset = spec.slice(spec.lastIndexOf(':') + 1);
    console.log(JSON.stringify(await readsChild(file, dataset, only)));
    return;
  }
  if (arg('child-write')) {
    console.log(JSON.stringify(await writeChild(arg('child-write'))));
    return;
  }
  if (arg('child-import')) {
    console.log(JSON.stringify(await importChild(arg('child-import'))));
    return;
  }
  if (arg('child-ops')) {
    console.log(JSON.stringify(opsChild(arg('child-ops'), arg('only-ops'))));
    return;
  }
  if (arg('child-ops-cold')) {
    console.log(JSON.stringify(opsColdChild(arg('child-ops-cold'), arg('cell'))));
    return;
  }
  if (process.argv.includes('--gate')) {
    process.exitCode = applyGate();
    return;
  }
  if (SMOKE && !process.env.PAIRED_RESULTS) {
    console.error('PAIRED_SMOKE=1 needs PAIRED_RESULTS to name a scratch file');
    process.exit(2);
  }
  const parts = ['reads', 'write', 'ops', 'import'].filter((p) => process.argv.includes(`--${p}`));
  const everything = process.argv.includes('--all') || CHECK || parts.length === 0;
  const run = (p) =>
    everything ? !(p === 'import' && process.argv.includes('--no-import')) : parts.includes(p);
  if (typeof global.gc !== 'function') {
    console.error('run with node --expose-gc');
    process.exit(2);
  }
  const retakes = SMALL ? 0 : Number(process.env.PAIRED_RETAKES ?? 2);
  const passes = [];
  for (let n = 0; n <= retakes; n++) {
    const doc = takePass(run, only, arg('only-ops'));
    doc.pass = n + 1;
    const problems = wellFormed(doc);
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    passes.push(doc);
    if (CHECK) break;
    doc.pass = nextPassNumber();
    appendPass(doc);
    printPass(doc);
    // A pass with a cell the rule could not resolve is recorded and taken again; the earlier reading stays.
    if (!gatedCellsOf(doc).some((c) => kindOf(c.verdict) === 'inconclusive')) break;
  }
  if (CHECK) {
    console.log(
      `ts-codec-paired --check: ok (${gatedCellsOf(passes[0]).length} cells, ${ROUNDS} rounds each)`,
    );
    return;
  }
  console.log(`passes taken: ${passes.length}; appended to ${RESULTS}`);
  process.exitCode = applyGate();
  if (process.exitCode !== 0) {
    console.log(
      'the gate stops this record: a "slower" blocks the merge until it is explained or fixed (an `explained` note on its pass), and a cell still inconclusive is published only with its bound (an `unresolved` note on the last pass)',
    );
  }
}

/** One pass: the parts asked for, once, as a document with its time, commits, machine and loads. */
function takePass(run, only, onlyOps) {
  const doc = {
    schema: 2,
    unit: UNIT,
    rule: RULE,
    sleepRule: { factor: SLEEP_FACTOR, maxOnCpu: SLEEP_MAX_ON_CPU },
    tolerance: TOLERANCE,
    environment: environment(),
    started: new Date().toISOString(),
  };
  doc.environment.loadAtStart = twoDecimals(load1());
  let subjects;
  if (run('reads') || run('write') || run('ops')) {
    subjects = prepareSubjects(run('ops'));
    doc.environment.base = subjects.baseSha;
  }
  try {
    if (run('reads')) doc.reads = readsMeasure(subjects, only);
    if (run('write')) doc.write = writeMeasure(subjects);
    if (run('ops')) doc.ops = opsMeasure(subjects, onlyOps);
  } finally {
    if (subjects) fs.rmSync(subjects.dir, { recursive: true, force: true });
  }
  if (run('import')) doc.import = importMeasure();
  doc.finished = new Date().toISOString();
  doc.environment.loadAtEnd = twoDecimals(load1());
  const cells = [...gatedCellsOf(doc), ...(doc.import ? [doc.import.moduleLoadMs] : [])];
  doc.load = {
    maxLoadAtEnd: Math.max(0, ...cells.flatMap((c) => c.rounds.map((r) => r[5]))),
    discardedRounds: Math.max(0, ...cells.map((c) => (c.discarded ?? []).length)),
    sleptRounds: Math.max(0, ...cells.map((c) => (c.slept ?? []).length)),
  };
  const verdicts = gatedCellsOf(doc).map((c) => c.verdict);
  doc.verdict = verdicts.length > 0 ? worstPaired(verdicts) : undefined;
  return doc;
}

function readResults() {
  const file = fs.existsSync(RESULTS)
    ? JSON.parse(fs.readFileSync(RESULTS, 'utf8'))
    : { passes: [] };
  if (!Array.isArray(file.passes)) throw new Error(`${RESULTS} is not a list of passes`);
  return file;
}

const nextPassNumber = () => readResults().passes.length + 1;

/** Adds a pass to the results file, which keeps every earlier pass: a re-take never hides the first reading. */
function appendPass(doc) {
  const file = readResults();
  file.passes.push(doc);
  fs.writeFileSync(RESULTS, `${JSON.stringify(file)}\n`);
}

function printPass(doc) {
  for (const c of gatedCellsOf(doc)) {
    const [lo, hi] = c.headInterval;
    console.log(
      `${cellName(c)}: head ${(c.headVsReference * 100).toFixed(1)}% [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}], control ${(c.controlVsBase * 100).toFixed(1)}% (${c.verdict})`,
    );
  }
  const { maxLoadAtEnd, discardedRounds, sleptRounds } = doc.load;
  console.log(
    `pass ${doc.pass} worst: ${doc.verdict}; kept rounds ended at a load of at most ${maxLoadAtEnd.toFixed(2)}; ${discardedRounds} round(s) discarded at ${MAX_LOAD} or more; ${sleptRounds} round(s) discarded as slept (a figure over ${SLEEP_FACTOR} times its median with under half of its wall time on CPU)${doc.environment.anyLoad ? ' (the load rule was OFF for this pass)' : ''}${doc.environment.smoke ? ' (SMOKE: nothing here is evidence)' : ''}`,
  );
}

main().then(
  () => exitWhenDone(),
  (err) => {
    console.error(err);
    exitWhenDone(1);
  },
);
