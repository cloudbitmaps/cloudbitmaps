/*
 * The public bitmap class against the pinned `roaring` package: every cell of the class's API that exists today, timed
 * for `RoaringBitmap` (imported from `@cloudbitmaps/roaring`), for the `roaring` package it is compared with, and where
 * there is one for the codec's own call (the cost of the shell), in a process of its own each, rotated through the
 * orders within one run, with the class run a second time as an A/A control.
 *
 * WHAT IS MEASURED (`bench/lib/bitmap-api-cells.cjs` lists every cell; the data sets are the engine bench's: dense,
 * sparse, runs, mixed and spread8k)
 *
 *   build      a constructor from an array, from a `Uint32Array`, `addMany`, and 100,000 per-id `add`s
 *   has        256 reads per call, reported per read
 *   combine    `and`, `or`, `xor`, `andNot`, returning a new bitmap, and in place (a clone, then the combine)
 *   write      the first operand's next write after a returning `or`, `xor` or `andNot`, each repetition on a freshly
 *              decoded operand, only the write timed (a returning combine flags the containers it keeps by reference)
 *   bytes      `serialize`, `deserialize` (the class's capped, checked decode against native's own), `runOptimize`
 *   export     iteration, `toUint32Array`, `toArray`
 *   orMany     8 and 64 bitmaps
 *   clone      `clone`, and a clone then a write that lands in every container
 *   cold       the first call of a fresh process, nothing warmed: `deserialize`, a build, an `and`, on `mixed`
 *   load       `store.load(ref, { bitmap })` against the serialize and the checked decode it makes, from the built
 *              package (one subject, so no A/A control; the share of a load the round trip is is the figure)
 *
 * The count cells (`andCardinality`, `orCardinality`, `isSubset`, `isEqual`, `intersects`) are in the steady part; the
 * route the class's count switch selects is read from the built package and recorded in the pass's environment.
 *
 * HOW A FIGURE IS READ (`bench/lib/bitmap-api-verdict.cjs` says it in full). A round times a cell for four subjects,
 * `native`, `ours`, `ours` again (the control) and the codec's own, each in a process of its own, in an order that
 * rotates. A cell reports the median over the rounds of `ours / native` with the distribution-free 95% interval of that
 * median, and the median of `control / ours - 1`, which must lie within 2% or the cell resolves nothing and the table
 * marks it. The stop rule is in that file and does not change after a measurement.
 *
 * THE LOAD RULE and THE SLEEP RULE are the codec's paired bench's, from `bench/lib/paired-verdict.cjs`: the 1-minute load
 * is recorded at the start and end of every round; the machine is waited for before a round, and a round that ends at a
 * load of 6 or more is set aside under the cell's `discarded` and taken again; a round with a figure over 100 times
 * its subject's median and under half of its wall time on CPU is set aside under `slept`. In the record the
 * subject names of a slept round's evidence are the paired bench's: `base` is the other subject of the pseudo-cell
 * (the `roaring` package, or the codec's bitmap in a cell named `... (internal)`), `head` is `ours`.
 *
 * Every subject must give the same answer for a cell, or the run fails.
 *
 * `--check` runs everything once at a tiny scale and fails only if the output is malformed or the subjects disagree;
 * it compares no duration with any bound. `--all` takes the full measurement and appends a pass to
 * `bench/bitmap-api-results.json` (`BITMAP_API_RESULTS` names another file); a pass is never replaced. `--steady`,
 * `--cold` and `--load` run one part; `--only=<text>` keeps the steady cells whose "<data set> <cell>" contains the text
 * (`a|b` keeps either). `BITMAP_API_SMOKE=1` takes a few rounds at a tiny scale through the whole pipeline and needs
 * `BITMAP_API_RESULTS` to name a scratch file; the gate refuses a smoke pass. `BITMAP_API_ROUNDS` (at least 31 for a
 * real pass), `BITMAP_API_ANY_LOAD=1` (turns the load rule off, and the pass records it) and `BITMAP_API_RETAKES` (whole
 * passes taken again while a control is out of band, default 2) are the other knobs. `--gate` applies the gate to the
 * results file without measuring.
 *
 * The expected time of `--all` on the maintainer's machine: about 4 seconds per subject-process for each data set
 * (the warm-up and the sampling of about 26 cells), four subjects, 31 rounds, five data sets, so about 70 minutes,
 * plus the cold cells and the load part, plus the rounds the load and sleep rules set aside.
 *
 * Needs `pnpm build` first (the class is imported from the built package). Wall-clock and machine-dependent: recorded,
 * never asserted.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { bundleText, evaluate } = require('./lib/codec-engine.cjs');
const { idsOf } = require('./lib/codec-data.cjs');
const { MIN_ROUNDS } = require('./lib/codec-verdict.cjs');
const verdict = require('./lib/bitmap-api-verdict.cjs');
const cellsLib = require('./lib/bitmap-api-cells.cjs');

const { MAX_LOAD, RULE, UNIT, median, nsToMs, figurePlaces, keepRound, collectRounds } = verdict;
const { DATASETS, COLD_DATASET } = cellsLib;

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
const SMOKE = process.env.BITMAP_API_SMOKE === '1';
/** A tiny-scale run: nothing it measures is evidence. */
const SMALL = CHECK || SMOKE;
const ANY_LOAD = process.env.BITMAP_API_ANY_LOAD === '1';
const RESULTS = process.env.BITMAP_API_RESULTS
  ? path.resolve(process.env.BITMAP_API_RESULTS)
  : path.join(__dirname, 'bitmap-api-results.json');
const ROUNDS = CHECK
  ? 2
  : SMOKE
    ? Math.max(2, Number(process.env.BITMAP_API_ROUNDS) || 3)
    : Math.max(MIN_ROUNDS, Number(process.env.BITMAP_API_ROUNDS) || MIN_ROUNDS);
const WARM_MS = SMALL ? 0 : 100;
const SAMPLE_MS = SMALL ? 0 : 8;
/** Subjects in the order of a round's figures: the `roaring` package, the class, the class again, the codec's own. */
const SUBJECT_NAMES = ['native', 'ours', 'control', 'internal'];
/** The orders a round's four subjects run in; each subject takes every position about as often over six rounds. */
const ORDERS = [
  [0, 1, 2, 3],
  [3, 2, 1, 0],
  [1, 3, 0, 2],
  [2, 0, 3, 1],
  [0, 3, 1, 2],
  [2, 1, 3, 0],
];

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

// ---- the subjects ---------------------------------------------------------------------------------------------------

/** The uniform surface of a subject, in a process that holds only that subject (`work` is the prepared folder). */
async function apiOf(subject, work) {
  if (subject === 'native') {
    return cellsLib.nativeApi(createRequire(path.join(ROOT, 'package.json'))('roaring'));
  }
  if (subject === 'internal') {
    const engine = evaluate(fs.readFileSync(path.join(work, 'internal.cjs'), 'utf8'), ROOT);
    return cellsLib.internalApi(engine.tsRoaringCodec);
  }
  const mod = await import('@cloudbitmaps/roaring');
  return cellsLib.oursApi(mod.RoaringBitmap);
}

/** The folder the children read: the stored bytes of every data set, and the codec's own bitmap as one bundle. */
function prepare() {
  const dir = fs.mkdtempSync(
    path.join(process.env.BITMAP_API_WORKDIR ?? os.tmpdir(), 'bitmap-api-'),
  );
  const nativeModule = createRequire(path.join(ROOT, 'package.json'))('roaring');
  fs.writeFileSync(
    path.join(dir, 'inputs.json'),
    cellsLib.bytesToJson(cellsLib.storedBytesOf(nativeModule, SMALL)),
  );
  fs.writeFileSync(
    path.join(dir, 'internal.cjs'),
    bundleText({
      root: ROOT,
      entry: `export { tsRoaringCodec } from './src/ts-roaring/bitmap';`,
      sourcefile: 'bitmap-api-internal-entry.ts',
    }),
  );
  return dir;
}

const bytesIn = (work) =>
  cellsLib.bytesFromJson(fs.readFileSync(path.join(work, 'inputs.json'), 'utf8'));

/** Every steady cell of one data set on one subject (`--child=<subject>:<dataset> --work=<dir>`). */
async function steadyChild(subject, dataset, work, only) {
  const api = await apiOf(subject === 'control' ? 'ours' : subject, work);
  const data = cellsLib.dataOf(dataset, SMALL, bytesIn(work));
  global.gc();
  const out = {};
  for (const cell of cellsLib.cellsOf(data)) {
    if (!wanted(only, `${dataset} ${cell.name}`) || !cellsLib.runsOn(cell, api)) continue;
    out[cell.name] = cellsLib.timeCell(cell, api, { warmMs: WARM_MS, sampleMs: SAMPLE_MS });
  }
  return { dataset, cells: out };
}

/** One cold cell on one subject, the first call of this process (`--child-cold=<subject>:<cell> --work=<dir>`). */
async function coldChild(subject, name, work) {
  const api = await apiOf(subject === 'control' ? 'ours' : subject, work);
  const data = cellsLib.dataOf(COLD_DATASET, SMALL, bytesIn(work));
  const cell = cellsLib.coldCellsOf(data).find((c) => c.name === name);
  if (cell === undefined) throw new Error(`no cold cell ${JSON.stringify(name)}`);
  return cellsLib.timeCold(cell, api);
}

// ---- orchestration --------------------------------------------------------------------------------------------------

/** Runs this script in a child process with `args` and returns the last line of its output. */
function spawnLast(args) {
  return execFileSync(
    process.execPath,
    ['--expose-gc', __filename, ...(CHECK ? ['--check'] : []), ...args],
    {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1 << 28,
    },
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
 * Takes `ROUNDS` kept rounds of `runRound(subjectIndex)`. `triplesOf(samples)` gives, for each (pseudo-)cell, its
 * `[other, ours, control]` wall figures and `cpuOf(samples)` the CPU figures of the same spans; `samples` is
 * `[native, ours, control, internal]` outputs (`null` where a subject ran nothing). The rules are the paired bench's.
 */
function takeRounds(runRound, triplesOf, cpuOf) {
  try {
    return collectRounds({
      want: ROUNDS,
      triplesOf,
      cpuOf,
      checkSleep: !SMALL,
      keepByLoad: (round) => SMALL || keepRound(round.end, ANY_LOAD),
      takeOne: (order) => {
        waitForQuietMachine();
        const start = twoDecimals(load1());
        const sample = [null, null, null, null];
        for (const i of ORDERS[order]) sample[i] = runRound(i);
        return { order, start, end: twoDecimals(load1()), samples: sample };
      },
    });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
}

/**
 * The steady cells of one data set as measured by `take`: for each cell the names of its pseudo-cells (the cell
 * against the `roaring` package, and, where the codec has a counterpart, `<cell> (internal)`).
 */
function pseudoCells(cells, samples) {
  const out = [];
  for (const c of cells) {
    out.push({ cell: c.name, other: 0, name: c.name });
    if (samples === undefined || samples[3]?.cells?.[c.name] !== undefined) {
      if (c.who.includes('internal'))
        out.push({ cell: c.name, other: 3, name: `${c.name} (internal)` });
    }
  }
  return out;
}

/** A row of a cell: `[order, native, ours, control, internal|null, loadAtStart, loadAtEnd]` in milliseconds. */
function rowOf(r, figure, toMs) {
  const [native, ours, control, internal] = figure(r.samples).map((x) =>
    x === null ? null : toMs(x),
  );
  return [r.order, native, ours, control, internal, r.start, r.end];
}

/** The cell of a taken set of rounds, with its discarded and slept rounds. */
function recordCell(taken, figure, kind, names, base) {
  const decimals = kind === 'tenth' ? 1 : 0;
  const toMs = (x) => nsToMs(x, decimals);
  const kept = taken.kept.map((r) => rowOf(r, figure, toMs));
  const discarded = taken.discarded.map((r) => rowOf(r, figure, toMs));
  const slept = taken.slept.map((r) => [
    ...rowOf(r, figure, toMs),
    r.evidence.map((e) => ({
      cell: names[e.cell],
      subject: e.subject,
      wall: toMs(e.wall),
      cpu: toMs(e.cpu),
    })),
  ]);
  return {
    ...base,
    ...verdict.cellOf(kept, figurePlaces(kind, UNIT)),
    ...(discarded.length > 0 ? { discarded } : {}),
    ...(slept.length > 0 ? { slept } : {}),
  };
}

function steadyMeasure(work, only) {
  const out = [];
  for (const dataset of DATASETS) {
    const cells = cellsLib
      .cellsOf({ some: [], small: SMALL })
      .filter((c) => wanted(only, `${dataset} ${c.name}`));
    if (cells.length === 0) continue;
    const pseudo = pseudoCells(cells);
    const figureOf = (samples, p, field) =>
      [0, 1, 2, 3].map((i) => samples[i]?.cells?.[p.cell]?.[field] ?? null);
    const triples = (field) => (samples) =>
      pseudo.map((p) => {
        const f = figureOf(samples, p, field);
        return [f[p.other], f[1], f[2]];
      });
    const taken = takeRounds(
      (i) =>
        JSON.parse(
          spawnLast([
            `--child=${SUBJECT_NAMES[i]}:${dataset}`,
            `--work=${work}`,
            ...(only ? [`--only=${only}`] : []),
          ]),
        ),
      triples('ns'),
      triples('cpuNs'),
    );
    const everything = [...taken.kept, ...taken.discarded, ...taken.slept];
    for (const c of cells) {
      const answers = everything.flatMap((r) =>
        r.samples.map((s) => s?.cells?.[c.name]?.answer).filter((a) => a !== undefined),
      );
      const names = pseudo.map((p) => p.name);
      const internal = pseudo.some((p) => p.cell === c.name && p.other === 3);
      out.push(
        recordCell(
          taken,
          (s) =>
            [0, 1, 2, internal ? 3 : null].map((i) => (i === null ? null : s[i].cells[c.name].ns)),
          'tenth',
          names,
          {
            dataset,
            op: c.name,
            method: c.method,
            group: c.group,
            answersAgree: allEqual(answers),
          },
        ),
      );
    }
  }
  return out;
}

function coldMeasure(work, only) {
  const data = cellsLib.dataOf(COLD_DATASET, SMALL, bytesIn(work));
  const names = cellsLib
    .coldCellsOf(data)
    .map((c) => c.name)
    .filter((n) => wanted(only, `cold ${n}`));
  if (names.length === 0) return [];
  const at = (s, n, field) => s?.[n]?.[field] ?? null;
  const taken = takeRounds(
    (i) =>
      Object.fromEntries(
        names.map((n) => [
          n,
          JSON.parse(spawnLast([`--child-cold=${SUBJECT_NAMES[i]}:${n}`, `--work=${work}`])),
        ]),
      ),
    (samples) =>
      names.map((n) => [at(samples[0], n, 'ns'), at(samples[1], n, 'ns'), at(samples[2], n, 'ns')]),
    (samples) =>
      names.map((n) => [
        at(samples[0], n, 'cpuNs'),
        at(samples[1], n, 'cpuNs'),
        at(samples[2], n, 'cpuNs'),
      ]),
  );
  const everything = [...taken.kept, ...taken.discarded, ...taken.slept];
  return names.map((n) =>
    recordCell(taken, (s) => [0, 1, 2, 3].map((i) => at(s[i], n, 'ns')), 'whole', names, {
      dataset: 'cold',
      op: n,
      method: cellsLib.coldCellsOf(data).find((c) => c.name === n).method,
      group: 'cold',
      answersAgree: allEqual(everything.flatMap((r) => r.samples.map((s) => at(s, n, 'answer')))),
    }),
  );
}

/**
 * `store.load(ref, { bitmap })` against the serialize and the checked decode a load of a bitmap makes, through the
 * built package, in one process. One subject, so the round has no control: each round times a load, a `serialize` and
 * a `RoaringBitmap.deserialize` of the same bitmap, and the figure is the share `(serialize + decode) / load`.
 */
async function loadMeasure(only) {
  const mod = await import('@cloudbitmaps/roaring');
  const { RoaringBitmap, CloudRoaring, MemoryStorage } = mod;
  const out = [];
  for (const dataset of DATASETS) {
    if (!wanted(only, `load ${dataset}`)) continue;
    const ids = idsOf(dataset, 0, SMALL ? cellsLib.TINY : cellsLib.SCALE);
    const bitmap = new RoaringBitmap(ids);
    bitmap.runOptimize();
    const timeOnce = async (n) => {
      const store = new CloudRoaring({ storage: new MemoryStorage() });
      global.gc();
      let t0 = process.hrtime.bigint();
      const result = await store.load({ segment: `round-${n}` }, { bitmap });
      const load = Number(process.hrtime.bigint() - t0);
      if (!result.published) throw new Error('the load was not published');
      global.gc();
      t0 = process.hrtime.bigint();
      const bytes = bitmap.serialize();
      const serialize = Number(process.hrtime.bigint() - t0);
      t0 = process.hrtime.bigint();
      const back = RoaringBitmap.deserialize(bytes);
      const decode = Number(process.hrtime.bigint() - t0);
      if (back.size !== bitmap.size) throw new Error('the round trip changed the bitmap');
      return [load, serialize, decode];
    };
    for (let n = 0; n < (SMALL ? 1 : 3); n++) await timeOnce(-1 - n);
    const kept = [];
    const discarded = [];
    for (let n = 0; kept.length < ROUNDS; n++) {
      waitForQuietMachine();
      const start = twoDecimals(load1());
      const [load, serialize, decode] = await timeOnce(n);
      const end = twoDecimals(load1());
      const row = [nsToMs(load, 0), nsToMs(serialize, 0), nsToMs(decode, 0), start, end];
      if (SMALL || keepRound(end, ANY_LOAD)) kept.push(row);
      else if (discarded.push(row) > 2 * ROUNDS) {
        console.error('too many load-part rounds ended at a high load: not measuring');
        process.exit(2);
      }
    }
    const share = kept.map((r) => (r[1] + r[2]) / r[0]);
    const shareInterval = verdict.medianInterval(share);
    out.push({
      dataset,
      loadMedian: median(kept.map((r) => r[0])),
      serializeMedian: median(kept.map((r) => r[1])),
      decodeMedian: median(kept.map((r) => r[2])),
      roundTripShare: +median(share).toFixed(4),
      roundTripShareInterval: [shareInterval.lower, shareInterval.upper].map((x) => +x.toFixed(4)),
      rounds: kept,
      ...(discarded.length > 0 ? { discarded } : {}),
    });
  }
  return out;
}

/**
 * The route the built class takes for its four cardinalities and `intersects`, read from the built switch: `kernels`
 * (the count kernels) or `build-then-count`. Fails closed: a build with no switch, or one this cannot read, stops the run.
 */
function countRoute() {
  const file = path.join(ROOT, 'packages', 'roaring', 'dist', 'count-route.js');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const m = /COUNT_BY_KERNELS\s*=\s*(true|false)\b/.exec(text);
  if (m === null) {
    throw new Error(`${file}: no COUNT_BY_KERNELS switch to read: run pnpm build first`);
  }
  return m[1] === 'true' ? 'kernels' : 'build-then-count';
}

function environment() {
  let tree = 'unknown';
  try {
    tree = git('status', '--porcelain').length === 0 ? 'clean' : 'dirty';
  } catch {
    /* recorded as unknown */
  }
  let roaring = 'unknown';
  try {
    roaring = createRequire(path.join(ROOT, 'package.json'))('roaring/package.json').version;
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
    roaring,
    countRoute: countRoute(),
    anyLoad: ANY_LOAD,
    smoke: SMOKE,
    rounds: ROUNDS,
    maxLoad: MAX_LOAD,
  };
}

/** What stops a pass from being written: a malformed cell, disagreeing subjects, too few rounds. */
function wellFormed(doc) {
  const problems = [];
  for (const c of verdict.cellsOfPass(doc)) {
    const name = verdict.cellName(c);
    if (c.malformed) problems.push(`${name}: malformed rounds`);
    if (c.answersAgree !== true) problems.push(`${name}: the subjects gave different answers`);
    if (!Array.isArray(c.rounds) || c.rounds.length < ROUNDS)
      problems.push(`${name}: too few rounds`);
  }
  if (doc.cells !== undefined && doc.cells.length === 0) problems.push('no steady cells');
  return problems;
}

function applyGate() {
  const file = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const problems = verdict.gateProblems(file.passes);
  for (const p of problems) console.log(`gate: ${p}`);
  if (problems.length === 0) console.log(`gate: ${RESULTS}: every pass is clear`);
  return problems.length > 0 ? 4 : 0;
}

async function takePass(run, only) {
  const doc = {
    schema: 1,
    unit: UNIT,
    rule: RULE,
    environment: environment(),
    started: new Date().toISOString(),
  };
  doc.environment.loadAtStart = twoDecimals(load1());
  const work = run('steady') || run('cold') ? prepare() : undefined;
  try {
    if (run('steady')) doc.cells = steadyMeasure(work, only);
    if (run('cold')) doc.cold = coldMeasure(work, only);
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
  if (run('load')) doc.loadRoundTrip = await loadMeasure(only);
  doc.finished = new Date().toISOString();
  doc.environment.loadAtEnd = twoDecimals(load1());
  const cells = verdict.cellsOfPass(doc).filter((c) => !c.malformed);
  doc.load = {
    maxLoadAtEnd: Math.max(0, ...cells.flatMap((c) => c.rounds.map((r) => r[6]))),
    discardedRounds: Math.max(0, ...cells.map((c) => (c.discarded ?? []).length)),
    sleptRounds: Math.max(0, ...cells.map((c) => (c.slept ?? []).length)),
  };
  doc.outOfBand = cells.filter((c) => !c.controlInBand).map(verdict.cellName);
  return doc;
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
  for (const c of verdict.cellsOfPass(doc)) {
    if (c.malformed) continue;
    const [lo, hi] = c.vsNativeInterval;
    console.log(
      `${verdict.cellName(c)}: ${c.vsNative.toFixed(2)}x native [${lo.toFixed(2)}, ${hi.toFixed(2)}]${
        c.vsInternal === undefined ? '' : `, ${c.vsInternal.toFixed(2)}x internal`
      }, control ${(c.controlVsOurs * 100).toFixed(1)}%${c.controlInBand ? '' : ' (OUT OF BAND)'}`,
    );
  }
  for (const l of doc.loadRoundTrip ?? []) {
    console.log(
      `load ${l.dataset}: the round trip is ${(l.roundTripShare * 100).toFixed(1)}% of a load of a bitmap`,
    );
  }
  const { maxLoadAtEnd, discardedRounds, sleptRounds } = doc.load;
  console.log(
    `pass ${doc.pass ?? '-'}: kept rounds ended at a load of at most ${maxLoadAtEnd.toFixed(2)}; ${discardedRounds} round(s) discarded at ${MAX_LOAD} or more; ${sleptRounds} round(s) discarded as slept${doc.environment.anyLoad ? ' (the load rule was OFF for this pass)' : ''}${doc.environment.smoke ? ' (SMOKE: nothing here is evidence)' : ''}`,
  );
}

async function main() {
  const only = arg('only');
  if (arg('child')) {
    const [subject, dataset] = arg('child').split(':');
    console.log(JSON.stringify(await steadyChild(subject, dataset, arg('work'), only)));
    return;
  }
  if (arg('child-cold')) {
    const spec = arg('child-cold');
    const at = spec.indexOf(':');
    console.log(
      JSON.stringify(await coldChild(spec.slice(0, at), spec.slice(at + 1), arg('work'))),
    );
    return;
  }
  if (process.argv.includes('--gate')) {
    process.exitCode = applyGate();
    return;
  }
  if (SMOKE && !process.env.BITMAP_API_RESULTS) {
    console.error('BITMAP_API_SMOKE=1 needs BITMAP_API_RESULTS to name a scratch file');
    process.exit(2);
  }
  if (typeof global.gc !== 'function') {
    console.error('run with node --expose-gc');
    process.exit(2);
  }
  const parts = ['steady', 'cold', 'load'].filter((p) => process.argv.includes(`--${p}`));
  const everything = process.argv.includes('--all') || CHECK || parts.length === 0;
  const run = (p) => everything || parts.includes(p);
  const retakes = SMALL ? 0 : Number(process.env.BITMAP_API_RETAKES ?? 2);
  const passes = [];
  for (let n = 0; n <= retakes; n++) {
    const doc = await takePass(run, only);
    const problems = wellFormed(doc);
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    passes.push(doc);
    if (CHECK) break;
    appendPass(doc);
    printPass(doc);
    // A pass with a control out of band is recorded and taken again; the earlier reading stays.
    if (doc.outOfBand.length === 0) break;
  }
  if (CHECK) {
    console.log(
      `bitmap-api --check: ok (${verdict.cellsOfPass(passes[0]).length} cells, ${(passes[0].loadRoundTrip ?? []).length} load rows, ${ROUNDS} rounds each)`,
    );
    return;
  }
  console.log(`passes taken: ${passes.length}; appended to ${RESULTS}`);
  process.exitCode = applyGate();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
