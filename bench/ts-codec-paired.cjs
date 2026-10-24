/*
 * Paired before-and-after bench for a change under `packages/roaring/src/ts-roaring/`: the store's hot paths and write
 * path with the codec of a base commit, the codec of the working tree, and the base codec a second time as an A/A
 * control, rotated within one run, one subject per process. Two separate runs of an hour each cannot resolve a
 * difference that small (their own noise is the size of the bar), so the comparison is paired and the band it is held
 * to is measured in each run from the control, not assumed.
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
 *   import   the time to import `packages/roaring/dist/bitmap.js` against `packages/roaring/dist/index.js` (the
 *            built entries), each in a fresh process, with the main entry a second time as the control, and the bytes
 *            of an esbuild bundle (minified, and gzipped) of a one-line importer of the class from each entry.
 *            Needs `pnpm build` first; `--no-import` leaves it out.
 *
 * HOW A COMPARISON IS JUDGED
 *
 * A round times the same call for three subjects: `base` (the codec at the base commit), `head` (this tree's) and
 * `control` (the base again), each in a process of its own, in an order that rotates through the six permutations.
 * A cell reports the median of at least 31 paired differences (`head / base - 1` and `control / base - 1`) with their
 * quartiles and every round, and a verdict from `bench/lib/paired-verdict.cjs`: the head is within the band the
 * control's own differences show, or slower or faster than it, or the cell is inconclusive because the control moved
 * more than 3% (the machine was busy; re-run, never publish). A figure is taken only while the 1-minute load average
 * is under 6, and every round carries the load. Every subject must give the same answer for a cell, or the run fails.
 *
 * The base is the merge base of `origin/main` and HEAD unless `PAIRED_BASE` names a commit. Its `packages/` are
 * extracted with `git archive` into a work folder (`PAIRED_WORKDIR`, default the system's temporary folder) and
 * bundled with esbuild; nothing in the working tree is touched.
 *
 * `--check` runs everything once at a tiny scale and fails only if the output is malformed or the subjects disagree;
 * it compares no duration with any bound. `--all` takes the full measurement (about an hour on an idle machine) and
 * writes `bench/ts-codec-paired-results.json` (`PAIRED_RESULTS` names another file). `--reads`, `--write` and
 * `--import` run one part; `--only=<text>` keeps the read cells whose "<data set> <op>" contains the text.
 * Environment: `PAIRED_ROUNDS` (at least 31), `PAIRED_ANY_LOAD=1` (turns the load gate off and records it).
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
const { MIN_ROUNDS, cellFrom } = require('./lib/codec-verdict.cjs');
const { pairedVerdictOf, worstPaired, MALFORMED } = require('./lib/paired-verdict.cjs');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
const RESULTS = process.env.PAIRED_RESULTS
  ? path.resolve(process.env.PAIRED_RESULTS)
  : path.join(__dirname, 'ts-codec-paired-results.json');
const MAX_LOAD = 6;
const ANY_LOAD = process.env.PAIRED_ANY_LOAD === '1';
const ROUNDS = CHECK ? 2 : Math.max(MIN_ROUNDS, Number(process.env.PAIRED_ROUNDS) || MIN_ROUNDS);
const WARM_MS = CHECK ? 0 : 300;
const SAMPLE_MS = CHECK ? 0 : 25;
const CHUNK_SCALE = CHECK
  ? { dense: 2, sparse: 4, runs: 2, mixed: 3, spread8k: 100 }
  : { dense: 32, sparse: 256, runs: 128, mixed: 128, spread8k: 8192 };
const WRITE_CHUNKS = CHECK ? 300 : 62500;
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];
const OPS = ['has', 'count', 'iterate', 'intersect2', 'intersect4', 'andNot'];
const SUBJECTS = ['base', 'head', 'control'];
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
  if (CHECK || ANY_LOAD) return;
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

async function timeCalls(fn, reps) {
  const t0 = now();
  for (let i = 0; i < reps; i++) keep[i & 15] = await fn();
  return (now() - t0) / reps;
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
  const out = {};
  for (const op of OPS) {
    if (!wanted(only, `${dataset} ${op}`)) continue;
    const fn = () => ops[op](segs);
    const answer = await fn();
    const reps = await calibrate(fn);
    out[op] = { ns: +(await timeCalls(fn, reps)).toFixed(0), answer };
  }
  return { dataset, ops: out };
}

/** A load and an erasure's rewrite of the 62,500-chunk set, after one untimed round (`--child-write=<bundle>`). */
async function writeChild(file) {
  const engine = engineOf(file);
  const ids = idsOf('spread8k', 0, { spread8k: WRITE_CHUNKS });
  let timed;
  for (let round = 0; round < 2; round++) {
    const store = newStore(engine, new engine.roaring.MemoryStorage());
    global.gc();
    let t0 = now();
    const loaded = await store.load({ segment: 'w' }, ids, { sorted: true });
    const loadNs = now() - t0;
    if (!loaded.published) throw new Error('the write-path load was not published');
    const victim = ids[ids.length >> 1];
    global.gc();
    t0 = now();
    const erased = await store.eraseSubject(victim, { allNamespaces: true });
    const eraseNs = now() - t0;
    if (!JSON.stringify(erased).includes('"erased":true')) throw new Error('nothing was erased');
    timed = { load: loadNs, erase: eraseNs, answer: `${ids.length}:${victim}` };
  }
  return timed;
}

/** The time to import one built entry in a fresh process (`--child-import=<file>`). */
async function importChild(file) {
  const url = require('node:url').pathToFileURL(file).href;
  const t0 = now();
  keep[0] = await import(url);
  return { ms: +((now() - t0) / 1e6).toFixed(3) };
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
function prepareSubjects() {
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
  return { dir, baseSha, files: [files.base, files.head, files.base] };
}

function allEqual(answers) {
  return answers.every((a) => a === answers[0]);
}

function readsMeasure(subjects, only) {
  const cells = [];
  for (const dataset of DATASETS) {
    const rounds = {};
    const answers = {};
    for (let r = 0; r < ROUNDS; r++) {
      waitForQuietMachine();
      const sample = [null, null, null];
      for (const i of ORDERS[r % 6]) {
        sample[i] = JSON.parse(
          spawnLast([
            `--child-reads=${subjects.files[i]}:${dataset}`,
            ...(only ? [`--only=${only}`] : []),
          ]),
        );
      }
      const load = twoDecimals(load1());
      for (const op of Object.keys(sample[0].ops)) {
        (rounds[op] ??= []).push([
          r % 6,
          sample[0].ops[op].ns,
          sample[1].ops[op].ns,
          sample[2].ops[op].ns,
          load,
        ]);
        (answers[op] ??= []).push(...sample.map((s) => s.ops[op].answer));
      }
    }
    for (const op of Object.keys(rounds)) {
      cells.push({ dataset, op, answersAgree: allEqual(answers[op]), ...pairedCell(rounds[op]) });
    }
  }
  return cells;
}

function pairedCell(rounds, places = 0) {
  const cell = cellFrom(rounds, places, null);
  return {
    ...cell,
    verdict: pairedVerdictOf(cell.typescriptVsNative, cell.controlVsNative, cell.controlQuartiles),
  };
}

function writeMeasure(subjects) {
  const rounds = { load: [], erase: [] };
  const answers = [];
  for (let r = 0; r < ROUNDS; r++) {
    waitForQuietMachine();
    const sample = [null, null, null];
    for (const i of ORDERS[r % 6])
      sample[i] = JSON.parse(spawnLast([`--child-write=${subjects.files[i]}`]));
    const load = twoDecimals(load1());
    for (const field of Object.keys(rounds))
      rounds[field].push([r % 6, sample[0][field], sample[1][field], sample[2][field], load]);
    answers.push(...sample.map((s) => s.answer));
  }
  return Object.entries(rounds).map(([op, rs]) => ({
    dataset: `spread ${WRITE_CHUNKS} chunks`,
    op,
    answersAgree: allEqual(answers),
    ...pairedCell(rs),
  }));
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

function importMeasure() {
  const dist = path.join(ROOT, 'packages/roaring/dist');
  const files = [
    path.join(dist, 'index.js'),
    path.join(dist, 'bitmap.js'),
    path.join(dist, 'index.js'),
  ];
  for (const f of files)
    if (!fs.existsSync(f)) throw new Error(`${f} is missing: run pnpm build first`);
  const rounds = [];
  const runs = CHECK ? 2 : MIN_ROUNDS;
  for (let r = 0; r < runs; r++) {
    waitForQuietMachine();
    const ms = [0, 0, 0];
    for (const i of ORDERS[r % 6]) ms[i] = JSON.parse(spawnLast([`--child-import=${files[i]}`])).ms;
    rounds.push([r % 6, ...ms, twoDecimals(load1())]);
  }
  // Round layout here is [order, main entry, ./bitmap, main entry again]: the "head" column is the ./bitmap entry.
  return {
    runs,
    moduleLoadMs: pairedCell(rounds, 3),
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
    rounds: ROUNDS,
  };
}

function wellFormed(doc) {
  const problems = [];
  const cells = [...(doc.reads ?? []), ...(doc.write ?? [])];
  for (const c of cells) {
    const name = `${c.dataset} ${c.op}`;
    if (c.answersAgree !== true) problems.push(`${name}: the subjects gave different answers`);
    if (c.verdict === MALFORMED) problems.push(`${name}: no verdict`);
    if (!Array.isArray(c.rounds) || c.rounds.length < ROUNDS)
      problems.push(`${name}: too few rounds`);
  }
  if (doc.reads !== undefined && doc.reads.length === 0) problems.push('no read cells');
  if (doc.import !== undefined && doc.import.moduleLoadMs.verdict === MALFORMED)
    problems.push('the import time has no verdict');
  return problems;
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
  const parts = ['reads', 'write', 'import'].filter((p) => process.argv.includes(`--${p}`));
  const everything = process.argv.includes('--all') || CHECK || parts.length === 0;
  const run = (p) =>
    everything ? !(p === 'import' && process.argv.includes('--no-import')) : parts.includes(p);
  if (typeof global.gc !== 'function') {
    console.error('run with node --expose-gc');
    process.exit(2);
  }
  const doc = { environment: environment(), started: new Date().toISOString() };
  let subjects;
  if (run('reads') || run('write')) {
    subjects = prepareSubjects();
    doc.environment.base = subjects.baseSha;
  }
  try {
    if (run('reads')) doc.reads = readsMeasure(subjects, only);
    if (run('write')) doc.write = writeMeasure(subjects);
  } finally {
    if (subjects) fs.rmSync(subjects.dir, { recursive: true, force: true });
  }
  if (run('import')) doc.import = importMeasure();
  doc.finished = new Date().toISOString();
  const verdicts = [...(doc.reads ?? []), ...(doc.write ?? [])].map((c) => c.verdict);
  doc.verdict = verdicts.length > 0 ? worstPaired(verdicts) : undefined;
  const problems = wellFormed(doc);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  if (CHECK) {
    console.log(`ts-codec-paired --check: ok (${verdicts.length} cells, ${ROUNDS} rounds each)`);
    return;
  }
  fs.writeFileSync(RESULTS, `${JSON.stringify(doc)}\n`);
  for (const c of [...(doc.reads ?? []), ...(doc.write ?? [])]) {
    console.log(
      `${c.dataset} ${c.op}: head ${(c.typescriptVsNative * 100).toFixed(1)}%, control ${(c.controlVsNative * 100).toFixed(1)}% (${c.verdict})`,
    );
  }
  console.log(`worst: ${doc.verdict}; wrote ${RESULTS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
