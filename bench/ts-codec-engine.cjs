/*
 * Engine bench for the TypeScript codec — the store's own operations, through `CloudRoaring`, with the native codec
 * and the TypeScript codec side by side in one process. It is the hot-path, write-path, memory and start-up half of
 * the comparison the decision on switching codecs rests on; `bench/ts-codec.cjs` is the per-operation half (one
 * operation on one chunk). The report is `bench/ts-codec-comparison.md`; the raw figures are
 * `bench/ts-codec-comparison-results.json`.
 *
 * WHAT IS MEASURED
 *
 *   reads    `seg.has`, `seg.count()`, a full `iterate()`, `intersect` of two and of four operands, and `andNot`, on a
 *            `CloudRoaring` store over `MemoryStorage` with a cache large enough to hold every chunk, warmed by time
 *            (300 ms of calls per store before timing). Five data sets: `dense` (a bitset in every chunk), `sparse`
 *            (arrays), `runs`, `mixed` (the three kinds in turn) and `spread` (about a million ids over 62,500 chunks
 *            of 16 ids, the shape of the largest load the research used). Each data set runs in its own process, so
 *            the TypeScript codec's inline caches see one workload.
 *   write    a bulk `load` of 1,000,000 ids over 62,500 chunks, an `eraseSubject` of one id (the rewrite of that
 *            generation), and an `exportSegments` of the result, each on a fresh store per round.
 *   startup  the time to load each codec's module in a fresh process, and a fresh process's first 1,000 and next 1,000
 *            `has` calls, a first `iterate` and a first `intersect`: V8 warm-up, a cold row kept apart from the
 *            warmed figures.
 *   memory   heap plus external memory, and resident-set growth, of a chunk cache holding every chunk of a data set,
 *            by codec, each in a fresh process (and `bench/ts-codec.cjs --memory` for the bytes a decoded chunk holds,
 *            by kind). The native codec's own allocations are invisible to V8's counters; its resident-set growth is
 *            the figure that includes them.
 *
 * HOW A COMPARISON IS JUDGED
 *
 * Three stores share one backend, each built under a different setting of the store package's internal codec switch:
 * `native` (A), `typescript`, and `native` again (the A/A control, B). Every round times the same call on all three,
 * in an order that rotates through the six permutations, so a drift in the machine reaches each of them alike. The
 * result of a round is two paired differences: `typescript / native - 1`, and `A/A control / native - 1`. A cell
 * reports the median of each over at least 31 rounds. The verdict is computed from the two medians and nothing else:
 *
 *   - the control's median is within +-2%  -> the instrument resolved a difference that size, and the cell is
 *     `within the 5% bar` when the TypeScript median is at most +5%, and `over the 5% bar` when it is above;
 *   - otherwise                              -> `inconclusive`: the machine moved more than the bar can see.
 *
 * A figure is taken only while the 1-minute load average is under 6 (a cell waits, then refuses), and each carries the
 * highest load seen during it. `--check` times nothing that a threshold reads: it runs every cell once at a tiny
 * scale and fails only if the output is malformed or the codecs disagree on an answer, or a store did not use the codec
 * it was built for. Nothing here ever compares a duration with a bound in `--check`.
 *
 * HONESTY BOUNDARY
 *
 * Wall-clock and machine-dependent: recorded, not asserted. The three stores share a process, so the native addon's
 * boundary crossings and the TypeScript codec's allocation both show up in the figures. `count` may be answered from
 * the generation's index without decoding a chunk, in which case the two codecs cannot differ on it, and the report
 * says so beside the figure rather than counting it as evidence about the codec.
 *
 *   node --expose-gc bench/ts-codec-engine.cjs [--reads|--write|--startup|--memory|--all] [--only=<text>]
 *   node bench/ts-codec-engine.cjs --check
 *
 * `--all` writes `bench/ts-codec-comparison-results.json` (`TS_ENGINE_RESULTS` redirects it). The other modes print
 * their rows as JSON. `TS_ENGINE_ROUNDS` sets the rounds of a reads cell (31 or more for a figure the gate reads).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { engineWith, evaluate } = require('./lib/codec-engine.cjs');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = process.env.TS_ENGINE_RESULTS
  ? path.resolve(process.env.TS_ENGINE_RESULTS)
  : path.join(ROOT, 'bench/ts-codec-comparison-results.json');
const MAX_LOAD = 6;
const BAR = 0.05;
const CONTROL_BAND = 0.02;
const MIN_ROUNDS = 31;
const CHECK = process.argv.includes('--check') || process.argv.includes('--check-scale');
const ROUNDS = CHECK ? 3 : Math.max(MIN_ROUNDS, Number(process.env.TS_ENGINE_ROUNDS) || MIN_ROUNDS);
const WARM_MS = CHECK ? 0 : 300;
const SAMPLE_MS = CHECK ? 0 : 25;
const WRITE_ROUNDS = CHECK ? 2 : 15;
const STARTUP_RUNS = CHECK ? 1 : 11;
const IMPORT_RUNS = CHECK ? 1 : 15;
const CHUNK_SCALE = CHECK
  ? { dense: 2, sparse: 4, runs: 2, mixed: 3, spread: 200 }
  : { dense: 32, sparse: 256, runs: 128, mixed: 128, spread: 62500 };
const WRITE_CHUNKS = CHECK ? 300 : 62500;
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread'];
const OPS = ['has', 'count', 'iterate', 'intersect2', 'intersect4', 'andNot'];
const NODE_ARGS = ['--expose-gc'];

const now = () => Number(process.hrtime.bigint());
const median = (xs) => {
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
};
const load1 = () => os.loadavg()[0];

// ---- the verdict, from two medians --------------------------------------------------------------------------------

/** The cell's verdict, computed from the TypeScript median and the A/A control's median (both as fractions). */
function verdictOf(tsMedian, controlMedian) {
  if (!Number.isFinite(tsMedian) || !Number.isFinite(controlMedian)) return 'malformed';
  if (Math.abs(controlMedian) > CONTROL_BAND) return 'inconclusive';
  return tsMedian <= BAR ? 'within the 5% bar' : 'over the 5% bar';
}

/** One op's verdict over its cells: the worst of them (over, then inconclusive, then within). */
function worstOf(verdicts) {
  for (const v of ['malformed', 'over the 5% bar', 'inconclusive'])
    if (verdicts.includes(v)) return v;
  return 'within the 5% bar';
}

/** The write path's verdict: no slower, by the same control. */
function writeVerdictOf(tsMedian, controlMedian) {
  if (!Number.isFinite(tsMedian) || !Number.isFinite(controlMedian)) return 'malformed';
  if (Math.abs(controlMedian) > CONTROL_BAND) return 'inconclusive';
  if (tsMedian < -CONTROL_BAND) return 'faster';
  return tsMedian <= CONTROL_BAND ? 'no slower (within the control band)' : 'slower';
}

// ---- data ---------------------------------------------------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLows(next, count) {
  const seen = new Set();
  while (seen.size < count) seen.add(Math.floor(next() * 65536));
  return Array.from(seen).sort((x, y) => x - y);
}

function runLows(next) {
  const out = [];
  let at = Math.floor(next() * 50);
  for (let r = 0; r < 150 && at <= 65535; r++) {
    const len = 100 + Math.floor(next() * 201);
    for (let k = 0; k < len && at + k < 65536; k++) out.push(at + k);
    at += len + 50 + Math.floor(next() * 150);
  }
  return out;
}

/** The lows of one chunk of the given kind. */
function lowsOf(kind, next) {
  if (kind === 'dense') return randomLows(next, 32768);
  if (kind === 'sparse') return randomLows(next, 1000);
  if (kind === 'spread') return randomLows(next, 16);
  return runLows(next);
}

/** The ids of segment `which` (0 to 3) of a data set: the same chunk keys in every segment, different ids in each. */
function idsOf(dataset, which, scale = CHUNK_SCALE) {
  const chunks = scale[dataset];
  const keys = [];
  if (dataset === 'spread') {
    const pick = prng(7);
    const all = Array.from({ length: 65536 }, (_, i) => i);
    for (let i = 0; i < chunks; i++) {
      const j = i + Math.floor(pick() * (65536 - i));
      [all[i], all[j]] = [all[j], all[i]];
    }
    keys.push(...all.slice(0, chunks).sort((x, y) => x - y));
  } else {
    for (let i = 0; i < chunks; i++) keys.push(i * 3);
  }
  const kinds = ['dense', 'sparse', 'runs'];
  const ids = [];
  keys.forEach((key, i) => {
    const kind = dataset === 'mixed' ? kinds[(i + which) % 3] : dataset;
    const next = prng(1000 * (which + 1) + i + 1);
    for (const low of lowsOf(kind, next)) ids.push(key * 65536 + low);
  });
  return ids;
}

// ---- the three stores ---------------------------------------------------------------------------------------------

const VARIANTS = [
  { key: 'native', codec: 'native' },
  { key: 'typescript', codec: 'typescript' },
  { key: 'control', codec: 'native' },
];
const ORDERS = [
  [0, 1, 2],
  [2, 1, 0],
  [1, 2, 0],
  [0, 2, 1],
  [2, 0, 1],
  [1, 0, 2],
];

const keep = new Array(16).fill(0);
globalThis.__tsEngineKeep = keep;

function engineOf(codec) {
  return engineWith(codec, { root: ROOT });
}

/** A store over `backend` built while the switch is on `codec`; its engine keeps that codec for its reads. */
function storeOn(engine, backend, codec, cache) {
  engine.setFlagshipCodec(codec === 'typescript' ? engine.tsRoaringCodec : engine.roaringCodec);
  return new engine.roaring.CloudRoaring({
    storage: backend,
    cache: { maxChunks: 70000, genTtlMs: 3_600_000, ...cache },
  });
}

/** Segments of one data set, loaded once by a native store, and the three stores that will read them. */
async function prepare(engine, dataset) {
  const backend = new engine.roaring.MemoryStorage();
  const loader = storeOn(engine, backend, 'native');
  const names = ['a', 'b', 'c', 'd'].map((n) => `${dataset}-${n}`);
  const idLists = [];
  for (let i = 0; i < 4; i++) {
    const ids = idsOf(dataset, i);
    idLists.push(ids);
    const result = await loader.load({ segment: names[i] }, ids, { sorted: true });
    if (!result.published) throw new Error(`load of ${names[i]} was not published`);
  }
  const stores = VARIANTS.map((v) => {
    const store = storeOn(engine, backend, v.codec);
    return { v, store, seg: names.map((n) => store.segment(n)) };
  });
  return { stores, idLists, backend };
}

/** Every call of the cell, as a function of one store's four segments, and the probes `has` uses. */
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

/** Which codec a store's call used: every function of both codecs counted for the duration of `run`. */
async function attribution(engine, run) {
  const counts = { native: 0, typescript: 0 };
  const restore = [];
  for (const [name, codec] of [
    ['native', engine.roaringCodec],
    ['typescript', engine.tsRoaringCodec],
  ]) {
    for (const [method, fn] of Object.entries({ ...codec })) {
      if (typeof fn !== 'function') continue;
      codec[method] = function (...args) {
        counts[name]++;
        return fn.apply(this, args);
      };
      restore.push(() => {
        codec[method] = fn;
      });
    }
  }
  try {
    await run();
  } finally {
    restore.forEach((r) => r());
  }
  return counts;
}

function waitForQuietMachine() {
  if (CHECK || process.env.TS_ENGINE_ANY_LOAD === '1') return;
  for (let waited = 0; load1() >= MAX_LOAD; waited += 20) {
    if (waited >= 600) {
      console.error(`load ${load1().toFixed(2)} stays at or above ${MAX_LOAD}: not measuring`);
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
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

/** One cell: the three stores' rounds interleaved, the paired differences and the verdict. */
async function measureCell(prepared, dataset, op, fnOf) {
  waitForQuietMachine();
  const { stores } = prepared;
  const answers = [];
  for (const s of stores) answers.push(await fnOf(s.seg));
  const agree = answers.every((a) => a === answers[0]);
  const reps = [];
  for (const s of stores) reps.push(await calibrate(() => fnOf(s.seg)));
  let load = load1();
  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    const sample = [0, 0, 0];
    for (const i of ORDERS[r % 6]) sample[i] = await timeCalls(() => fnOf(stores[i].seg), reps[i]);
    rounds.push(sample);
    load = Math.max(load, load1());
  }
  const diffs = rounds.map((s) => s[1] / s[0] - 1);
  const controls = rounds.map((s) => s[2] / s[0] - 1);
  const tsMedian = median(diffs);
  const controlMedian = median(controls);
  return {
    dataset,
    op,
    rounds: ROUNDS,
    nativeNs: +median(rounds.map((s) => s[0])).toFixed(0),
    typescriptNs: +median(rounds.map((s) => s[1])).toFixed(0),
    typescriptVsNative: +tsMedian.toFixed(4),
    controlVsNative: +controlMedian.toFixed(4),
    verdict: verdictOf(tsMedian, controlMedian),
    answersAgree: agree,
    load: +load.toFixed(2),
  };
}

/** Every op of one data set, in this process (`--child-reads=<dataset>`). */
async function readsChild(dataset, only) {
  const engine = engineOf('native');
  const prepared = await prepare(engine, dataset);
  const ops = opsOf(prepared.idLists);
  const cells = [];
  const used = [];
  for (const op of OPS) {
    if (only && !`${dataset} ${op}`.includes(only)) continue;
    cells.push(await measureCell(prepared, dataset, op, ops[op]));
    // One pass per store with the codecs' functions counted: a store must have used the codec it was built for.
    for (const s of prepared.stores) {
      // A fresh store, so its cache is cold and the call decodes.
      const fresh = storeOn(engine, prepared.backend, s.v.codec);
      const segs = ['a', 'b', 'c', 'd'].map((n) => fresh.segment(`${dataset}-${n}`));
      const counts = await attribution(engine, () => ops[op](segs));
      used.push({ op, store: s.v.key, codec: s.v.codec, counts });
    }
  }
  return { cells, used };
}

/** The codec attribution's failures: a TypeScript store that ran a native call, or a native store that ran a TypeScript one. */
function attributionFailures(used) {
  const wrong = used
    .filter((u) => (u.codec === 'typescript' ? u.counts.native > 0 : u.counts.typescript > 0))
    .map((u) => `${u.op}/${u.store}: native ${u.counts.native}, typescript ${u.counts.typescript}`);
  const tsUsed = used.some((u) => u.codec === 'typescript' && u.counts.typescript > 0);
  const nativeUsed = used.some((u) => u.codec === 'native' && u.counts.native > 0);
  if (!tsUsed) wrong.push('the typescript store never ran the typescript codec');
  if (!nativeUsed) wrong.push('the native stores never ran the native codec');
  return wrong;
}

// ---- the write path -----------------------------------------------------------------------------------------------

async function writeRound(engine, codec, ids) {
  const backend = new engine.roaring.MemoryStorage();
  const store = storeOn(engine, backend, codec);
  if (global.gc) global.gc();
  let t0 = now();
  const loaded = await store.load({ segment: 'w' }, ids, { sorted: true });
  const loadNs = now() - t0;
  if (!loaded.published) throw new Error('the write-path load was not published');
  const victim = ids[ids.length >> 1];
  t0 = now();
  const erased = await store.eraseSubject(victim, { allNamespaces: true });
  const eraseNs = now() - t0;
  if (!JSON.stringify(erased).includes('"erased":true'))
    throw new Error('the erasure did not erase');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const sink = {
    open: () => ({
      write: (b) => {
        hash.update(b);
        bytes += b.length;
      },
      close: () => {},
    }),
  };
  t0 = now();
  await store.exportSegments(sink);
  const exportNs = now() - t0;
  return { loadNs, eraseNs, exportNs, exportSha: hash.digest('hex'), bytes };
}

async function writeMeasure() {
  waitForQuietMachine();
  const engine = engineOf('native');
  const ids = idsOf('spread', 0, { spread: WRITE_CHUNKS });
  let load = load1();
  const rounds = [];
  const digests = new Set();
  for (let r = 0; r < WRITE_ROUNDS; r++) {
    const sample = [null, null, null];
    for (const i of ORDERS[r % 6]) {
      sample[i] = await writeRound(engine, VARIANTS[i].codec, ids);
      digests.add(sample[i].exportSha);
    }
    rounds.push(sample);
    load = Math.max(load, load1());
  }
  const rows = ['loadNs', 'eraseNs', 'exportNs'].map((field) => {
    const tsMedian = median(rounds.map((s) => s[1][field] / s[0][field] - 1));
    const controlMedian = median(rounds.map((s) => s[2][field] / s[0][field] - 1));
    return {
      op: field.replace('Ns', ''),
      rounds: WRITE_ROUNDS,
      nativeMs: +(median(rounds.map((s) => s[0][field])) / 1e6).toFixed(1),
      typescriptMs: +(median(rounds.map((s) => s[1][field])) / 1e6).toFixed(1),
      typescriptVsNative: +tsMedian.toFixed(4),
      controlVsNative: +controlMedian.toFixed(4),
      verdict: writeVerdictOf(tsMedian, controlMedian),
    };
  });
  // The stored object carries a creation time, so its own hash differs run to run; the export of the ids does not.
  const sameBytes = digests.size === 1;
  return { ids: ids.length, chunks: WRITE_CHUNKS, rows, sameBytes, load: +load.toFixed(2) };
}

// ---- memory -------------------------------------------------------------------------------------------------------

/** A cache holding every chunk of a data set, in a fresh process (`--child-memory=<codec>:<dataset>`). */
async function memoryChild(codec, dataset) {
  const engine = engineOf(codec);
  const backend = new engine.roaring.MemoryStorage();
  const store = storeOn(engine, backend, codec);
  const ids = idsOf(dataset, 0);
  await store.load({ segment: 'm' }, ids, { sorted: true });
  const reader = storeOn(engine, backend, codec);
  const seg = reader.segment('m');
  await seg.count();
  global.gc();
  global.gc();
  const before = process.memoryUsage();
  const chunkKeys = [...new Set(ids.map((id) => id >>> 16))];
  for (const key of chunkKeys) await seg.has(key * 65536);
  global.gc();
  global.gc();
  const after = process.memoryUsage();
  const n = chunkKeys.length;
  return {
    codec,
    dataset,
    chunks: n,
    heapExternalPerChunk: Math.round(
      (after.heapUsed + after.external - before.heapUsed - before.external) / n,
    ),
    rssPerChunk: Math.round((after.rss - before.rss) / n),
  };
}

function memoryMeasure() {
  const rows = [];
  for (const dataset of ['spread', 'mixed']) {
    for (const codec of ['native', 'typescript']) {
      rows.push(JSON.parse(spawnLast([`--child-memory=${codec}:${dataset}`])));
    }
  }
  const perKind = execFileSync(
    process.execPath,
    [...NODE_ARGS, path.join(__dirname, 'ts-codec.cjs'), '--memory', '--only=clone dense'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((l) => /^(dense|sparse|run)\t\d+/.test(l))
    .map((l) => {
      const [kind, nHeap, tHeap, nRss, tRss] = l.split('\t');
      return {
        kind,
        nativeHeapExternal: +nHeap,
        typescriptHeapExternal: +tHeap,
        nativeRss: +nRss,
        typescriptRss: +tRss,
      };
    });
  return { rows, perKind, load: +load1().toFixed(2) };
}

// ---- start-up -----------------------------------------------------------------------------------------------------

/** A fresh process's first operations on a cold store (`--child-cold=<codec>`). */
async function coldChild(codec) {
  const engine = engineOf(codec);
  const backend = new engine.roaring.MemoryStorage();
  const loader = storeOn(engine, backend, codec);
  const scale = CHECK ? { mixed: 3 } : { mixed: 128 };
  const a = idsOf('mixed', 0, scale);
  const b = idsOf('mixed', 1, scale);
  let t0 = now();
  await loader.load({ segment: 'a' }, a, { sorted: true });
  await loader.load({ segment: 'b' }, b, { sorted: true });
  const loadMs = (now() - t0) / 1e6;
  const store = storeOn(engine, backend, codec);
  const sa = store.segment('a');
  const sb = store.segment('b');
  const each = [];
  for (let i = 0; i < 2000; i++) {
    const id = i % 2 === 0 ? a[(i * 7919) % a.length] : (a[(i * 104729) % a.length] ^ 1) >>> 0;
    t0 = now();
    await sa.has(id);
    each.push(now() - t0);
  }
  const sum = (xs) => xs.reduce((p, q) => p + q, 0);
  t0 = now();
  let n = 0;
  for await (const id of sa.iterate()) n += id & 1;
  const iterateMs = (now() - t0) / 1e6;
  t0 = now();
  for await (const id of sa.intersect([sb])) n += id & 1;
  const intersectMs = (now() - t0) / 1e6;
  keep[0] = n;
  return {
    codec,
    loadMs: +loadMs.toFixed(2),
    firstHasUs: +(each[0] / 1e3).toFixed(1),
    first10HasMs: +(sum(each.slice(0, 10)) / 1e6).toFixed(3),
    first1000HasMs: +(sum(each.slice(0, 1000)) / 1e6).toFixed(2),
    next1000HasMs: +(sum(each.slice(1000)) / 1e6).toFixed(2),
    firstIterateMs: +iterateMs.toFixed(2),
    firstIntersectMs: +intersectMs.toFixed(2),
  };
}

/** The time to evaluate one codec's module in a fresh process (`--child-import=<file>`). */
function importChild(file) {
  const text = fs.readFileSync(file, 'utf8');
  const t0 = now();
  const mod = evaluate(text, ROOT);
  const ms = (now() - t0) / 1e6;
  keep[0] = mod;
  return { ms: +ms.toFixed(3) };
}

function moduleBundle(dir, name, exportLine) {
  const { buildSync } = require('esbuild');
  const rr = path.join(ROOT, 'packages/roaring');
  const out = buildSync({
    stdin: { contents: exportLine, resolveDir: rr, sourcefile: `${name}.ts`, loader: 'ts' },
    tsconfig: path.join(rr, 'tsconfig.json'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    packages: 'external',
    minify: false,
    write: false,
    logLevel: 'error',
  });
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, out.outputFiles[0].text);
  return file;
}

function startupMeasure() {
  waitForQuietMachine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-codec-engine-'));
  try {
    const files = {
      native: moduleBundle(dir, 'native', `export { roaringCodec } from './src/roaring-codec';`),
      typescript: moduleBundle(
        dir,
        'typescript',
        `export { tsRoaringCodec } from './src/ts-roaring/bitmap';`,
      ),
    };
    const imports = { native: [], typescript: [] };
    for (let i = 0; i < IMPORT_RUNS; i++)
      for (const k of i % 2 === 0 ? ['native', 'typescript'] : ['typescript', 'native'])
        imports[k].push(JSON.parse(spawnLast([`--child-import=${files[k]}`])).ms);
    const cold = { native: [], typescript: [] };
    for (let i = 0; i < STARTUP_RUNS; i++)
      for (const k of i % 2 === 0 ? ['native', 'typescript'] : ['typescript', 'native'])
        cold[k].push(JSON.parse(spawnLast([`--child-cold=${k}`])));
    const med = (rows, f) => +median(rows.map((r) => r[f])).toFixed(3);
    const fields = [
      'loadMs',
      'firstHasUs',
      'first10HasMs',
      'first1000HasMs',
      'next1000HasMs',
      'firstIterateMs',
      'firstIntersectMs',
    ];
    return {
      moduleLoadMs: {
        runs: IMPORT_RUNS,
        native: +median(imports.native).toFixed(3),
        typescript: +median(imports.typescript).toFixed(3),
      },
      coldProcess: {
        runs: STARTUP_RUNS,
        native: Object.fromEntries(fields.map((f) => [f, med(cold.native, f)])),
        typescript: Object.fromEntries(fields.map((f) => [f, med(cold.typescript, f)])),
      },
      load: +load1().toFixed(2),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- orchestration ------------------------------------------------------------------------------------------------

/** Runs this script in a child process with `args` and returns the last line of its output. */
function spawnLast(args) {
  return execFileSync(
    process.execPath,
    [...NODE_ARGS, __filename, ...(CHECK ? ['--check-scale'] : []), ...args],
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

function readsMeasure(only) {
  const cells = [];
  const used = [];
  for (const dataset of DATASETS) {
    const out = JSON.parse(
      spawnLast([`--child-reads=${dataset}`, ...(only ? [`--only=${only}`] : [])]),
    );
    cells.push(...out.cells);
    used.push(...out.used);
  }
  const perOp = OPS.map((op) => {
    const mine = cells.filter((c) => c.op === op);
    return {
      op,
      cells: mine.length,
      verdict: worstOf(mine.map((c) => c.verdict)),
      worstTypescriptVsNative: +Math.max(...mine.map((c) => c.typescriptVsNative)).toFixed(4),
      worstControl: +Math.max(...mine.map((c) => Math.abs(c.controlVsNative))).toFixed(4),
    };
  }).filter((r) => r.cells > 0);
  return {
    cells,
    perOp,
    attributionFailures: attributionFailures(used),
    load: +load1().toFixed(2),
  };
}

function environment() {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // not a git checkout
  }
  return {
    commit,
    node: process.version,
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    platform: `${process.platform} ${process.arch}`,
  };
}

/** The output's shape, for `--check`: every cell present and finite, every codec in agreement. */
function wellFormed(doc) {
  const bad = [];
  for (const dataset of DATASETS)
    for (const op of OPS)
      if (!doc.reads.cells.some((c) => c.dataset === dataset && c.op === op))
        bad.push(`missing cell ${dataset} ${op}`);
  for (const c of doc.reads.cells) {
    if (!c.answersAgree) bad.push(`the codecs disagree on ${c.dataset} ${c.op}`);
    for (const f of ['nativeNs', 'typescriptNs', 'typescriptVsNative', 'controlVsNative', 'load'])
      if (!Number.isFinite(c[f])) bad.push(`${c.dataset} ${c.op}: ${f} is not a number`);
    if (c.verdict === 'malformed') bad.push(`${c.dataset} ${c.op}: no verdict`);
  }
  bad.push(...doc.reads.attributionFailures.map((f) => `wrong codec: ${f}`));
  if (doc.write.rows.length !== 3 || doc.write.rows.some((r) => r.verdict === 'malformed'))
    bad.push('write rows malformed');
  if (!doc.write.sameBytes) bad.push('the codecs wrote different bytes');
  for (const k of ['native', 'typescript']) {
    if (!Number.isFinite(doc.startup.moduleLoadMs[k])) bad.push(`module load of ${k} missing`);
    if (!Number.isFinite(doc.startup.coldProcess[k].first1000HasMs))
      bad.push(`cold row of ${k} missing`);
  }
  return bad;
}

async function main() {
  const arg = (name) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (arg('child-reads')) {
    console.log(JSON.stringify(await readsChild(arg('child-reads'), arg('only'))));
  } else if (arg('child-memory')) {
    const [codec, dataset] = arg('child-memory').split(':');
    console.log(JSON.stringify(await memoryChild(codec, dataset)));
  } else if (arg('child-cold')) {
    console.log(JSON.stringify(await coldChild(arg('child-cold'))));
  } else if (arg('child-import')) {
    console.log(JSON.stringify(importChild(arg('child-import'))));
  } else if (CHECK) {
    const doc = { reads: readsMeasure(), write: await writeMeasure(), startup: startupMeasure() };
    const bad = wellFormed(doc);
    if (bad.length > 0) {
      console.error(`ts-codec engine bench: ${bad.join('; ')}`);
      process.exit(1);
    }
    console.log(
      `ts-codec engine bench: ${doc.reads.cells.length} read cells, the write path and start-up ran, output well formed`,
    );
  } else if (process.argv.includes('--write')) {
    console.log(JSON.stringify(await writeMeasure(), null, 2));
  } else if (process.argv.includes('--startup')) {
    console.log(JSON.stringify(startupMeasure(), null, 2));
  } else if (process.argv.includes('--memory')) {
    console.log(JSON.stringify(memoryMeasure(), null, 2));
  } else if (process.argv.includes('--all')) {
    const doc = {
      note: 'Wall-clock and machine-dependent: recorded, not asserted. Medians of paired, interleaved rounds; the verdict of a cell is computed from the TypeScript median and the A/A control median.',
      ...environment(),
      rules: { rounds: ROUNDS, bar: BAR, controlBand: CONTROL_BAND, maxLoad: MAX_LOAD },
      reads: readsMeasure(),
      write: await writeMeasure(),
      memory: memoryMeasure(),
      startup: startupMeasure(),
    };
    fs.writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, RESULTS)}`);
  } else {
    console.log(JSON.stringify(readsMeasure(arg('only')), null, 2));
  }
}

module.exports = { verdictOf, worstOf, writeVerdictOf };
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
