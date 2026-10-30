/*
 * Engine bench for the TypeScript codec — the store's own operations, through `CloudRoaring`, with the native codec
 * and the TypeScript codec compared two ways. It is the hot-path, write-path, memory and start-up half of the
 * comparison the decision on switching codecs rests on; `bench/ts-codec.cjs` is the per-operation half (one
 * operation on one chunk). The report is `bench/ts-codec-comparison.md`; the evidence behind it, every round of every
 * figure, is `bench/ts-codec-comparison-results.json`.
 *
 * WHAT IS MEASURED
 *
 *   reads    `seg.has`, `seg.count()`, a full `iterate()`, `intersect` of two and of four operands, and `andNot`, on a
 *            `CloudRoaring` store over `MemoryStorage` with a cache large enough to hold every chunk, warmed by time
 *            (300 ms of calls per store before timing). Six data sets: `dense` (a bitset in every chunk), `sparse`
 *            (arrays), `runs`, `mixed` (the three kinds in turn), `spread` (about a million ids over 62,500 chunks
 *            of 16 ids, the largest load this comparison times; point and scan reads only, because a combine
 *            of it takes seconds) and `spread8k` (the same shape over 8,192 chunks, every op). Each cell is measured
 *            twice, see below.
 *   write    a bulk `load` of 1,000,000 ids over 62,500 chunks, an `eraseSubject` of one id (the rewrite of that
 *            generation), and an `exportSegments` of the result, each on a fresh store per round, with a garbage
 *            collection before each timed call. It refuses to run unless `--expose-gc` is on.
 *   startup  the time to load each codec's module in a fresh process, and a fresh process's first `load` of two
 *            segments, first 1,000 and next 1,000 `has` calls, a first `iterate` and a first `intersect`: V8 warm-up,
 *            a cold row kept apart from the warmed figures. The facade bundle that the cold row runs loads the native
 *            addon in the TypeScript run too (before its timers start), so the TypeScript cold row is not "a process
 *            without the addon"; that is what a switch of the codec inside today's package would ship.
 *   memory   heap plus external memory, and resident-set growth, of a chunk cache holding every chunk of a data set,
 *            each codec in its own fresh process, the order alternating between repeats, seven repeats, the median
 *            and the range. Both codecs show a heap-plus-external figure; the figure to read is the difference
 *            between them, row by row, not either codec's absolute number (the native codec's is near zero only on the
 *            8,192-chunk set, and why it is not zero elsewhere is not measured). The resident-set growth includes
 *            memory V8's counters cannot see, and it is unreliable (it moves with the allocator, and a resident delta
 *            can read below the heap growth it contains): an order of magnitude, not a measurement.
 *
 * HOW A COMPARISON IS JUDGED
 *
 * A round times the same call for three subjects: `native` (A), `typescript`, and `native` again (the A/A control,
 * B), in an order that rotates through the six permutations, so a drift in the machine reaches each of them alike. The
 * result of a round is two paired differences: `typescript / native - 1` and `control / native - 1`. A cell reports the
 * median of each over at least 31 rounds, with the quartiles, and the rounds themselves. Every read cell is measured
 * in two ways:
 *
 *   in-process   the three subjects are three stores in ONE process, over one backend, each built under a different
 *                setting of the store package's internal codec switch. It is the cheapest control and the one with
 *                the most rounds per minute. Its limit: core's call sites (`deps.codec.*`, the combine code) see both
 *                the native wrapper and the TypeScript bitmap in the same process, which production (one codec) never
 *                has, so they are polymorphic here and monomorphic there; and the V8 heap carries the TypeScript
 *                store's whole decoded cache while the native store runs, which adds marking work to every store's
 *                garbage collections. The A/A control shares both effects with the native store and cannot reveal
 *                them.
 *   per-process  the three subjects are three FRESH processes, one codec each (native, TypeScript, and a second
 *                native process as the control), each running every op of the data set once per round; the order of
 *                the processes rotates through the permutations. Call sites see one codec and the heap holds one
 *                store, as in production. Its limit: a fresh process's own variance (layout, JIT timing) is in each
 *                figure, so the control's band is wider than in-process, which is what the control is for. Both
 *                native processes and the TypeScript one load the segments themselves with their own codec; the
 *                facade bundle loads the native addon in every process.
 *
 * The verdict is computed from the two medians of a basis and nothing else:
 *
 *   - the control's median is within +-2%  -> the instrument resolved a difference that size, and the cell is
 *     `within the 5% bar` when the TypeScript median is at most +5%, and `over the 5% bar` when it is above;
 *   - otherwise                              -> `inconclusive`: the machine moved more than the bar can see.
 *
 * The cell's verdict is the PER-PROCESS one, because it is the figure that looks like production (one codec in the
 * process, monomorphic call sites, no foreign heap); the in-process figures are the cross-check, and the report says
 * where the two differ. The rule is `bench/lib/codec-verdict.cjs`, fired at its boundaries by
 * `tests/bench/ts-codec-verdict.test.ts`, which also recomputes every committed median and verdict from the rounds.
 *
 * A figure is taken only while the 1-minute load average is under 6 (a cell, or a round of processes, waits, then
 * refuses), and each round carries the load at its end. Beside the medians the file keeps the codec-call counts of the
 * stores that were timed (a store must have used the codec it was built for; `count` is expected to make none), and
 * the storage calls made during the timed rounds, in-process and per-process alike (a warm cache makes none of the
 * object reads; a counter that has never seen a call proves nothing, so a cold store's calls are counted once as the
 * control). The file also records, for the whole run and for each part, its start and end time, the commit and whether
 * the tree was clean when it started, so an overlap with other work on the machine can be placed in time.
 *
 * `--check` times nothing a threshold reads: it runs every part once at a tiny scale (reads in both ways, the write path,
 * start-up and the memory pass, whose output it parses) and fails only if the output is malformed, the codecs disagree on
 * an answer, a store did not use the codec it was built for, or the codecs wrote different bytes. Nothing here ever
 * compares a duration with a bound in `--check`.
 *
 * HONESTY BOUNDARY
 *
 * Wall-clock and machine-dependent: recorded, not asserted. The in-process figures share a process (polymorphic call
 * sites, one heap: above); the per-process figures share a machine, not a process. The native addon's boundary
 * crossings and the TypeScript codec's allocation both show up in the figures. `count` is answered from the generation's
 * index without decoding a chunk, so the two codecs cannot differ on it, and `has` is dominated by an awaited call per
 * probe (about a microsecond), so a codec several times slower on the probe alone would still land within the bar of the
 * whole call: both rows have little or no power on the codec, and the report says so beside the figure. The write path
 * is in-process only.
 *
 *   node --expose-gc bench/ts-codec-engine.cjs [--reads|--reads-in-process|--reads-per-process|--write|--startup|
 *                                               --memory|--all] [--only=<text>]
 *   node bench/ts-codec-engine.cjs --check
 *
 * `--all` writes `bench/ts-codec-comparison-results.json`. The other modes print their rows as JSON. `--reads` runs both
 * ways, `--reads-in-process` and `--reads-per-process` one; `--only=<text>` keeps the cells whose "<data set> <op>"
 * contains the text (`--only=<a>|<b>` keeps those containing either). `--all` also measures the native codec with the
 * smallest-first intersect order, on the intersect cells of the mixed and spread8k sets, and writes it under
 * `nativeSmallestFirst`. `--check-scale` and every `--child-*` flag are this script's own, used when it runs itself in a
 * fresh process. The environment:
 *
 *   TS_ENGINE_RESULTS    the file `--all` writes, instead of `bench/ts-codec-comparison-results.json`.
 *   TS_ENGINE_ROUNDS     the rounds of a read cell, in-process and per-process (31 or more; fewer is raised to 31).
 *   TS_ENGINE_TRACE      any value: each cell's progress on standard error.
 *   TS_ENGINE_FAIRNESS   `1`: the second subject of every cell is the native codec with the smallest-first order (set by
 *                        `--all` for the child that takes `nativeSmallestFirst.vsShipped`).
 *   TS_ENGINE_NATIVE_SMALLEST_FIRST
 *                        `1`: every native subject asks for the smallest-first order (a knob of `bench/lib/codec-engine.cjs`;
 *                        set by `--all` for `nativeSmallestFirst.tsVsSmallestFirstNative`).
 *   TS_ENGINE_ANY_LOAD   `1` turns the load gate off (a machine that is never quiet); the file records `anyLoad: true`
 *                        in its rules, so a figure taken that way is never mistaken for a gated one.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { engineWith, evaluate, bundleText } = require('./lib/codec-engine.cjs');
const { idsOf } = require('./lib/codec-data.cjs');
const workFolder = require('./lib/work-folder.cjs');
const { treeState } = require('./lib/tree-state.cjs');
const {
  BAR,
  CONTROL_BAND,
  MIN_ROUNDS,
  median,
  worstOf,
  writeVerdictOf,
  signedWorst,
  cellFrom,
} = require('./lib/codec-verdict.cjs');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = process.env.TS_ENGINE_RESULTS
  ? path.resolve(process.env.TS_ENGINE_RESULTS)
  : path.join(ROOT, 'bench/ts-codec-comparison-results.json');
const MAX_LOAD = 6;
const ANY_LOAD = process.env.TS_ENGINE_ANY_LOAD === '1';
const CHECK = process.argv.includes('--check') || process.argv.includes('--check-scale');
const ROUNDS = CHECK ? 3 : Math.max(MIN_ROUNDS, Number(process.env.TS_ENGINE_ROUNDS) || MIN_ROUNDS);
const PROCESS_ROUNDS = CHECK ? 2 : ROUNDS;
const WARM_MS = CHECK ? 0 : 300;
const SAMPLE_MS = CHECK ? 0 : 25;
const WRITE_ROUNDS = CHECK ? 2 : MIN_ROUNDS;
const STARTUP_RUNS = CHECK ? 1 : MIN_ROUNDS;
const IMPORT_RUNS = CHECK ? 1 : MIN_ROUNDS;
const MEMORY_REPEATS = CHECK ? 1 : 7;
const CHUNK_SCALE = CHECK
  ? { dense: 2, sparse: 4, runs: 2, mixed: 3, spread: 200, spread8k: 100 }
  : { dense: 32, sparse: 256, runs: 128, mixed: 128, spread: 62500, spread8k: 8192 };
const MEMORY_SCALE = CHECK
  ? { dense: 2, sparse: 4, runs: 4, mixed: 6, spread8k: 100 }
  : { dense: 64, sparse: 256, runs: 256, mixed: 192, spread8k: 8192 };
const WRITE_CHUNKS = CHECK ? 300 : 62500;
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread', 'spread8k'];
const OPS = ['has', 'count', 'iterate', 'intersect2', 'intersect4', 'andNot'];
/** The 62,500-chunk set takes seconds per combine, so it is timed on the point and scan reads only; the combines run on 8,192 chunks of the same shape. */
const opsOfDataset = (dataset) => (dataset === 'spread' ? OPS.slice(0, 3) : OPS);
const NODE_ARGS = ['--expose-gc'];
const ROUND_FIELDS = ['order', 'native', 'typescript', 'control', 'load'];

/** Whether `--only=<a>|<b>` keeps the cell labelled "<data set> <op>": any of its `|`-separated texts is in the label. */
const wanted = (only, label) => !only || only.split('|').some((text) => label.includes(text));

const now = () => Number(process.hrtime.bigint());
const load1 = () => os.loadavg()[0];
const twoDecimals = (x) => +x.toFixed(2);

/** The compact JSON of a result: arrays of plain values on one line, so a round is one line of the file. */
function compactJson(doc) {
  return JSON.stringify(doc, null, 2).replace(/\[\s*([^[\]{}]*?)\s*\]/g, (m, inner) =>
    inner === '' ? '[]' : `[${inner.replace(/\s*\n\s*/g, ' ')}]`,
  );
}

// ---- the three subjects -------------------------------------------------------------------------------------------

// The fairness measurement (`TS_ENGINE_FAIRNESS=1`, set by `--all` for its own child) swaps the second subject: the native
// codec asking for the smallest-first intersect order, against native as shipped and a second native as the control.
const FAIRNESS = process.env.TS_ENGINE_FAIRNESS === '1';
const VARIANTS = [
  { key: 'native', codec: 'native' },
  FAIRNESS
    ? { key: 'nativeSmallestFirst', codec: 'native', smallestFirst: true }
    : { key: 'typescript', codec: 'typescript' },
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

const smallestFirstCodecs = new WeakMap();
/** The native codec with the smallest-first order switched on, as its own object: the shipped native codec is untouched. */
function smallestFirstNative(engine) {
  if (!smallestFirstCodecs.has(engine))
    smallestFirstCodecs.set(
      engine,
      Object.assign(Object.create(engine.roaringCodec), { intersectSmallestFirst: true }),
    );
  return smallestFirstCodecs.get(engine);
}

/** A store over `backend` built while the switch is on `codec`; its engine keeps that codec for its reads. */
function storeOn(engine, backend, codec, cache, smallestFirst = false) {
  engine.setFlagshipCodec(
    codec === 'typescript'
      ? engine.tsRoaringCodec
      : smallestFirst
        ? smallestFirstNative(engine)
        : engine.roaringCodec,
  );
  return new engine.roaring.CloudRoaring({
    storage: backend,
    cache: { maxChunks: 70000, genTtlMs: 3_600_000, ...cache },
  });
}

const segmentNames = (dataset) => ['a', 'b', 'c', 'd'].map((n) => `${dataset}-${n}`);

/** Loads the four segments of a data set through a store, and returns the ids of each. */
async function loadSegments(loader, dataset) {
  const idLists = [];
  for (const [i, name] of segmentNames(dataset).entries()) {
    const ids = idsOf(dataset, i, CHUNK_SCALE);
    idLists.push(ids);
    const result = await loader.load({ segment: name }, ids, { sorted: true });
    if (!result.published) throw new Error(`load of ${name} was not published`);
  }
  return idLists;
}

/** Segments of one data set, loaded once by a native store, and the three stores that will read them. */
async function prepare(engine, dataset) {
  const backend = new engine.roaring.MemoryStorage();
  const idLists = await loadSegments(storeOn(engine, backend, 'native'), dataset);
  const names = segmentNames(dataset);
  const stores = VARIANTS.map((v) => {
    const store = storeOn(engine, backend, v.codec, undefined, v.smallestFirst === true);
    return { v, store, seg: names.map((n) => store.segment(n)) };
  });
  return { engine, stores, idLists, backend };
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

/** Every call the backend's two drivers receive, counted per method until `stop()` puts the methods back. */
function countStorage(backend) {
  const counts = {};
  const restore = [];
  for (const [part, driver] of [
    ['storage', backend.storage],
    ['registry', backend.registry],
  ]) {
    const names = new Set();
    for (let o = driver; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o))
      for (const n of Object.getOwnPropertyNames(o))
        if (n !== 'constructor' && typeof driver[n] === 'function') names.add(n);
    for (const n of names) {
      const fn = driver[n];
      const own = Object.hasOwn(driver, n);
      driver[n] = function (...args) {
        counts[`${part}.${n}`] = (counts[`${part}.${n}`] ?? 0) + 1;
        return fn.apply(this, args);
      };
      restore.push(() => {
        if (own) driver[n] = fn;
        else delete driver[n];
      });
    }
  }
  return {
    counts,
    stop: () => restore.forEach((r) => r()),
  };
}

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

// ---- reads, in one process ----------------------------------------------------------------------------------------

/** One cell: the three stores' rounds interleaved, the paired differences and the verdict. */
async function measureCell(prepared, dataset, op, fnOf) {
  const trace = (m) =>
    process.env.TS_ENGINE_TRACE &&
    console.error(`${(now() / 1e9).toFixed(1)} ${dataset} ${op} ${m}`);
  trace('start');
  waitForQuietMachine();
  const { stores, engine, backend } = prepared;
  const answers = [];
  for (const s of stores) answers.push(await fnOf(s.seg));
  const agree = answers.every((a) => a === answers[0]);
  trace('answers');
  const reps = [];
  for (const s of stores) reps.push(await calibrate(() => fnOf(s.seg)));
  trace(`calibrated ${reps}`);
  const loadStart = load1();
  let load = loadStart;
  const rounds = [];
  const counter = countStorage(backend);
  try {
    for (let r = 0; r < ROUNDS; r++) {
      const sample = [0, 0, 0];
      for (const i of ORDERS[r % 6])
        sample[i] = await timeCalls(() => fnOf(stores[i].seg), reps[i]);
      load = Math.max(load, load1());
      rounds.push([r % 6, ...sample, twoDecimals(load)]);
    }
  } finally {
    counter.stop();
  }
  // The stores that were timed, counted once more, untimed: each must have used the codec it was built for. Their
  // caches are dropped first, because a warm read calls methods of the cached bitmaps and none of the codec's own
  // functions, so the decode (and the combine) is what shows which codec a store holds.
  const codecCalls = [];
  for (const s of stores) {
    for (const name of segmentNames(dataset)) s.store.invalidate({ segment: name });
    const counts = await attribution(engine, () => fnOf(s.seg));
    codecCalls.push({ store: s.v.key, codec: s.v.codec, ...counts });
  }
  return {
    ...cellFrom(
      rounds.map((r) => [r[0], +r[1].toFixed(0), +r[2].toFixed(0), +r[3].toFixed(0), r[4]]),
    ),
    answersAgree: agree,
    loadStart: twoDecimals(loadStart),
    loadMax: twoDecimals(load),
    timedStorageCalls: counter.counts,
    codecCalls,
  };
}

/** Every op of one data set, in this process (`--child-reads=<dataset>`). */
async function readsChild(dataset, only) {
  const engine = engineOf('native');
  const prepared = await prepare(engine, dataset);
  const ops = opsOf(prepared.idLists);
  // The control for the storage counter: a cold store's first read must be seen by it, or a zero means nothing.
  const cold = countStorage(prepared.backend);
  try {
    const fresh = storeOn(engine, prepared.backend, 'native');
    await ops.iterate(segmentNames(dataset).map((n) => fresh.segment(n)));
  } finally {
    cold.stop();
  }
  const coldStorageCalls = Object.values(cold.counts).reduce((p, q) => p + q, 0);
  if (coldStorageCalls === 0)
    throw new Error(`${dataset}: the storage counter saw no call of a cold read`);
  const cells = [];
  for (const op of opsOfDataset(dataset)) {
    if (!wanted(only, `${dataset} ${op}`)) continue;
    cells.push({ dataset, op, ...(await measureCell(prepared, dataset, op, ops[op])) });
  }
  return { cells, coldStorageCalls };
}

/** The codec attribution's failures: a TypeScript subject that ran a native call, or a native one that ran a TypeScript one. */
function attributionFailures(used) {
  const wrong = used
    .filter((u) => (u.codec === 'typescript' ? u.native > 0 : u.typescript > 0))
    .map((u) => `${u.label}: native ${u.native}, typescript ${u.typescript}`);
  const tsUsed = FAIRNESS || used.some((u) => u.codec === 'typescript' && u.typescript > 0);
  const nativeUsed = used.some((u) => u.codec === 'native' && u.native > 0);
  if (!tsUsed) wrong.push('the typescript subject never ran the typescript codec');
  if (!nativeUsed) wrong.push('the native subjects never ran the native codec');
  return wrong;
}

/** The warm cache's failures: an object read, a listing or any other storage call during a timed round, either way. */
function warmFailures(cells) {
  return cells.flatMap((c) =>
    ['inProcess', 'perProcess']
      .filter(
        (b) => c[b] && Object.keys(c[b].timedStorageCalls).some((k) => k.startsWith('storage.')),
      )
      .map(
        (b) =>
          `${c.dataset} ${c.op} (${b}): storage calls in timed rounds ${JSON.stringify(c[b].timedStorageCalls)}`,
      ),
  );
}

// ---- reads, one codec per process ---------------------------------------------------------------------------------

/** Every op of one data set, in a process that has only one codec (`--child-proc=<codec>:<dataset>`). */
async function procChild(codec, dataset, only, smallestFirst) {
  const engine = engineOf(codec);
  const backend = new engine.roaring.MemoryStorage();
  // The data is always written by the shipped native codec's order (a load does not use the intersect order).
  const idLists = await loadSegments(storeOn(engine, backend, codec), dataset);
  const store = storeOn(engine, backend, codec, undefined, smallestFirst);
  const segs = segmentNames(dataset).map((n) => store.segment(n));
  const ops = opsOf(idLists);
  global.gc();
  const out = {};
  for (const op of opsOfDataset(dataset)) {
    if (!wanted(only, `${dataset} ${op}`)) continue;
    const fn = () => ops[op](segs);
    const answer = await fn();
    const reps = await calibrate(fn);
    const counter = countStorage(backend);
    let ns;
    try {
      ns = await timeCalls(fn, reps);
    } finally {
      counter.stop();
    }
    out[op] = { ns: +ns.toFixed(0), answer, timedStorageCalls: counter.counts };
  }
  for (const op of Object.keys(out)) {
    // Cold again, so the decode and the combine are what the count sees (a warm read calls no codec function).
    for (const name of segmentNames(dataset)) store.invalidate({ segment: name });
    const counts = await attribution(engine, () => ops[op](segs));
    out[op].codecCalls = counts;
  }
  return { codec, dataset, ops: out };
}

/**
 * Every read cell, one codec per process: per data set and round, three fresh processes in a rotating order
 * (native, TypeScript, a second native one as the control), each timing every op once.
 */
function perProcessMeasure(only) {
  const cells = [];
  const used = [];
  for (const dataset of DATASETS) {
    const ops = opsOfDataset(dataset).filter((op) => wanted(only, `${dataset} ${op}`));
    if (ops.length === 0) continue;
    const rounds = Object.fromEntries(ops.map((op) => [op, []]));
    const agree = Object.fromEntries(ops.map((op) => [op, true]));
    const codecCalls = Object.fromEntries(ops.map((op) => [op, null]));
    const storageCalls = Object.fromEntries(ops.map((op) => [op, {}]));
    let loadStart = Infinity;
    let loadMax = 0;
    for (let r = 0; r < PROCESS_ROUNDS; r++) {
      waitForQuietMachine();
      const start = load1();
      loadStart = Math.min(loadStart, start);
      const outs = [null, null, null];
      for (const i of ORDERS[r % 6])
        outs[i] = JSON.parse(
          spawnLast([
            `--child-proc=${VARIANTS[i].codec}:${dataset}${VARIANTS[i].smallestFirst ? ':smallest-first' : ''}`,
            ...(only ? [`--only=${only}`] : []),
          ]),
        );
      const load = Math.max(start, load1());
      loadMax = Math.max(loadMax, load);
      for (const op of ops) {
        rounds[op].push([
          r % 6,
          outs[0].ops[op].ns,
          outs[1].ops[op].ns,
          outs[2].ops[op].ns,
          twoDecimals(load),
        ]);
        if (!outs.every((o) => o.ops[op].answer === outs[0].ops[op].answer)) agree[op] = false;
        for (const o of outs)
          for (const [k, n] of Object.entries(o.ops[op].timedStorageCalls))
            storageCalls[op][k] = (storageCalls[op][k] ?? 0) + n;
        const calls = outs.map((o, i) => ({
          store: VARIANTS[i].key,
          codec: VARIANTS[i].codec,
          ...o.ops[op].codecCalls,
        }));
        if (r === 0) codecCalls[op] = calls;
        for (const c of calls) used.push({ label: `${dataset} ${op} process ${c.store}`, ...c });
      }
    }
    for (const op of ops)
      cells.push({
        dataset,
        op,
        ...cellFrom(rounds[op]),
        answersAgree: agree[op],
        loadStart: twoDecimals(loadStart),
        loadMax: twoDecimals(loadMax),
        timedStorageCalls: storageCalls[op],
        codecCalls: codecCalls[op],
      });
  }
  return { cells, failures: attributionFailures(used) };
}

// ---- reads: both ways, merged -------------------------------------------------------------------------------------

function inProcessMeasure(only) {
  const cells = [];
  const used = [];
  let coldStorageCalls = 0;
  for (const dataset of DATASETS) {
    const out = JSON.parse(
      spawnLast([`--child-reads=${dataset}`, ...(only ? [`--only=${only}`] : [])]),
    );
    cells.push(...out.cells);
    coldStorageCalls += out.coldStorageCalls;
    for (const c of out.cells)
      for (const k of c.codecCalls)
        used.push({ label: `${c.dataset} ${c.op} store ${k.store}`, ...k });
  }
  return { cells, failures: attributionFailures(used), coldStorageCalls };
}

const basisOf = (cells) => ({
  verdict: worstOf(cells.map((c) => c.verdict)),
  worstTypescriptVsNative: +Math.max(...cells.map((c) => c.typescriptVsNative)).toFixed(4),
  worstControl: signedWorst(cells.map((c) => c.controlVsNative)),
});

function readsMeasure(only, { inProcess = true, perProcess = true } = {}) {
  const a = inProcess ? inProcessMeasure(only) : null;
  const b = perProcess ? perProcessMeasure(only) : null;
  const cells = [];
  for (const dataset of DATASETS)
    for (const op of opsOfDataset(dataset)) {
      const x = a?.cells.find((c) => c.dataset === dataset && c.op === op);
      const y = b?.cells.find((c) => c.dataset === dataset && c.op === op);
      if (!x && !y) continue;
      const strip = (cell) =>
        Object.fromEntries(Object.entries(cell).filter(([k]) => k !== 'dataset' && k !== 'op'));
      cells.push({
        dataset,
        op,
        verdict: (y ?? x).verdict,
        verdictBasis: y ? 'per-process' : 'in-process',
        ...(x ? { inProcess: strip(x) } : {}),
        ...(y ? { perProcess: strip(y) } : {}),
      });
    }
  const perOp = OPS.map((op) => {
    const mine = cells.filter((c) => c.op === op);
    return {
      op,
      cells: mine.length,
      verdict: worstOf(mine.map((c) => c.verdict)),
      ...(a ? { inProcess: basisOf(mine.map((c) => c.inProcess)) } : {}),
      ...(b ? { perProcess: basisOf(mine.map((c) => c.perProcess)) } : {}),
    };
  }).filter((r) => r.cells > 0);
  const failures = [...(a?.failures ?? []), ...(b?.failures ?? []), ...warmFailures(cells)];
  return {
    cells,
    perOp,
    attributionFailures: failures,
    coldStorageCalls: a?.coldStorageCalls ?? null,
    load: twoDecimals(load1()),
  };
}

// ---- the write path -----------------------------------------------------------------------------------------------

async function writeRound(engine, codec, ids) {
  const backend = new engine.roaring.MemoryStorage();
  const store = storeOn(engine, backend, codec);
  // A collection before each timed call, in the same place for every codec, so no call pays for the last one's garbage.
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
  global.gc();
  t0 = now();
  await store.exportSegments(sink);
  const exportNs = now() - t0;
  return { loadNs, eraseNs, exportNs, exportSha: hash.digest('hex'), bytes };
}

async function writeMeasure() {
  if (typeof global.gc !== 'function')
    throw new Error(
      'the write path is timed with a collection before each call: run with node --expose-gc',
    );
  waitForQuietMachine();
  const engine = engineOf('native');
  const ids = idsOf('spread', 0, { spread: WRITE_CHUNKS });
  const rounds = [];
  const digests = new Set();
  const loadStart = load1();
  let load = loadStart;
  for (let r = 0; r < WRITE_ROUNDS; r++) {
    const sample = [null, null, null];
    for (const i of ORDERS[r % 6]) {
      sample[i] = await writeRound(engine, VARIANTS[i].codec, ids);
      digests.add(sample[i].exportSha);
    }
    load = Math.max(load, load1());
    rounds.push({ order: r % 6, sample, load: twoDecimals(load) });
  }
  const rows = ['loadNs', 'eraseNs', 'exportNs'].map((field) => ({
    op: field.replace('Ns', ''),
    ...cellFrom(
      rounds.map((r) => [
        r.order,
        r.sample[0][field],
        r.sample[1][field],
        r.sample[2][field],
        r.load,
      ]),
      0,
      writeVerdictOf,
    ),
  }));
  // The stored object carries a creation time, so its own hash differs run to run; the export of the ids does not.
  const sameBytes = digests.size === 1;
  return {
    ids: ids.length,
    chunks: WRITE_CHUNKS,
    gcExposed: true,
    rows,
    sameBytes,
    loadStart: twoDecimals(loadStart),
    loadMax: twoDecimals(load),
  };
}

// ---- memory -------------------------------------------------------------------------------------------------------

/** A cache holding every chunk of a data set, in a fresh process (`--child-memory=<codec>:<dataset>`). */
async function memoryChild(codec, dataset) {
  const engine = engineOf(codec);
  const backend = new engine.roaring.MemoryStorage();
  const store = storeOn(engine, backend, codec);
  const ids = idsOf(dataset, 0, MEMORY_SCALE);
  await store.load({ segment: 'm' }, ids, { sorted: true });
  const chunkKeys = [...new Set(ids.map((id) => id >>> 16))];
  const reader = storeOn(engine, backend, codec);
  const seg = reader.segment('m');
  await seg.count();
  global.gc();
  global.gc();
  const before = process.memoryUsage();
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

const spread = (xs) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });

function memoryMeasure() {
  waitForQuietMachine();
  const loadStart = load1();
  const samples = {};
  for (let r = 0; r < MEMORY_REPEATS; r++) {
    for (const dataset of Object.keys(MEMORY_SCALE)) {
      for (const codec of r % 2 === 0 ? ['native', 'typescript'] : ['typescript', 'native']) {
        const row = JSON.parse(spawnLast([`--child-memory=${codec}:${dataset}`]));
        const slot = (samples[`${dataset}/${codec}`] ??= { chunks: row.chunks, rows: [] });
        slot.rows.push([row.heapExternalPerChunk, row.rssPerChunk]);
      }
    }
  }
  const rows = Object.keys(MEMORY_SCALE).map((dataset) => {
    const figures = (codec) => {
      const { chunks, rows: r } = samples[`${dataset}/${codec}`];
      return {
        chunks,
        heapExternal: spread(r.map((x) => x[0])),
        rss: spread(r.map((x) => x[1])),
        rssBelowHeap: r.filter((x) => x[1] < x[0]).length,
        samples: r,
      };
    };
    return { dataset, native: figures('native'), typescript: figures('typescript') };
  });
  return {
    repeats: MEMORY_REPEATS,
    sampleFields: ['heapExternalPerChunk', 'rssPerChunk'],
    order: 'native first on even repeats, TypeScript first on odd ones',
    rows,
    loadStart: twoDecimals(loadStart),
    loadMax: twoDecimals(Math.max(loadStart, load1())),
  };
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
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, bundleText({ root: ROOT, entry: exportLine, sourcefile: `${name}.ts` }));
  return file;
}

function startupMeasure() {
  waitForQuietMachine();
  const dir = workFolder.make(os.tmpdir(), 'ts-codec-engine-');
  try {
    const files = [
      moduleBundle(
        dir,
        'native',
        `export { roaringCodec } from ${JSON.stringify(path.join(ROOT, 'tests/helpers/native-codec'))};`,
      ),
      moduleBundle(dir, 'typescript', `export { tsRoaringCodec } from './src/ts-roaring/bitmap';`),
    ];
    const loadStart = load1();
    // Per run, the three subjects (native, TypeScript, native again as the control) in a rotating order of fresh processes.
    const imports = [];
    for (let i = 0; i < IMPORT_RUNS; i++) {
      const ms = [0, 0, 0];
      for (const v of ORDERS[i % 6])
        ms[v] = JSON.parse(
          spawnLast([`--child-import=${files[VARIANTS[v].codec === 'native' ? 0 : 1]}`]),
        ).ms;
      imports.push([i % 6, ...ms, twoDecimals(load1())]);
    }
    const cold = [];
    for (let i = 0; i < STARTUP_RUNS; i++) {
      const out = [null, null, null];
      for (const v of ORDERS[i % 6])
        out[v] = JSON.parse(spawnLast([`--child-cold=${VARIANTS[v].codec}`]));
      cold.push({ order: i % 6, out, load: twoDecimals(load1()) });
    }
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
      moduleLoadMs: { runs: IMPORT_RUNS, ...cellFrom(imports, 3, null) },
      coldProcess: {
        runs: STARTUP_RUNS,
        fields: Object.fromEntries(
          fields.map((f) => [
            f,
            cellFrom(
              cold.map((c) => [c.order, c.out[0][f], c.out[1][f], c.out[2][f], c.load]),
              3,
              null,
            ),
          ]),
        ),
      },
      loadStart: twoDecimals(loadStart),
      loadMax: twoDecimals(Math.max(loadStart, load1())),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- orchestration ------------------------------------------------------------------------------------------------

/** Runs this script in a child process with `args` and returns the last line of its output. */
function spawnLast(args, env = {}) {
  return execFileSync(
    process.execPath,
    [...NODE_ARGS, __filename, ...(CHECK ? ['--check-scale'] : []), ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 1 << 28,
    },
  )
    .trim()
    .split('\n')
    .pop();
}

/** The cells the fairness measurement covers: the intersects of the mixed set and of the spread set that has them. */
const FAIRNESS_CELLS = 'mixed intersect|spread8k intersect';

/**
 * The reads of `FAIRNESS_CELLS` in a child process of their own, with `env` set for it and everything it starts. With
 * `TS_ENGINE_FAIRNESS=1` the three subjects are native as shipped, native with the smallest-first order and a second
 * native as the control (the column the file names `typescript` is then the smallest-first native); with
 * `TS_ENGINE_NATIVE_SMALLEST_FIRST=1` they are native and the control both on that order against the TypeScript codec.
 */
const fairnessViaChild = (env) =>
  JSON.parse(spawnLast(['--child-section', `--only=${FAIRNESS_CELLS}`], env));

/** What the fairness section of the file says its subjects are, so a reader of the file need not read this script. */
const FAIRNESS_NOTE =
  'Cells of the mixed and spread8k intersects, measured both ways like every read cell. vsShipped: the subjects are native as shipped (the `native` column), native with the smallest-first operand order (the column named `typescript`, which here is that native codec) and a second native as shipped (the control); its typescriptVsNative is therefore the effect of the order on the native codec, paired round by round. tsVsSmallestFirstNative: the subjects are native with the smallest-first order, the TypeScript codec and a second smallest-first native (the control).';

const fairnessPart = () => ({
  note: FAIRNESS_NOTE,
  cells: FAIRNESS_CELLS,
  vsShipped: part(() => fairnessViaChild({ TS_ENGINE_FAIRNESS: '1' })),
  tsVsSmallestFirstNative: part(() => fairnessViaChild({ TS_ENGINE_NATIVE_SMALLEST_FIRST: '1' })),
});

/** The write path, in a fresh process of its own, so the parent needs no `--expose-gc` and no heap of its own in the figures. */
const writeViaChild = () => JSON.parse(spawnLast(['--child-write']));

function environment() {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: git('rev-parse', 'HEAD') ?? 'unknown',
    // Whether the tree was the commit's own when the figures were taken (the shared rule: this file's results alone are not a change).
    treeClean: treeState({ root: ROOT, record: RESULTS }).tree === 'clean',
    node: process.version,
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    platform: `${process.platform} ${process.arch}`,
  };
}

/** The commit and tree state now, and the time: what a part of a run records about where and when it started. */
function stamp() {
  const { commit, treeClean } = environment();
  return { startedAt: new Date().toISOString(), commit, treeClean };
}

/** `fn`'s output with its start time, commit and tree state, and its end time, so a part can be placed in time. */
function part(fn) {
  const first = stamp();
  const out = fn();
  return { ...first, ...out, endedAt: new Date().toISOString() };
}

const finiteAll = (o, fields) => fields.every((f) => Number.isFinite(o[f]));

/** The output's shape, for `--check`: every cell present and finite, every codec in agreement, every part parsed. */
function wellFormed(doc) {
  const bad = [];
  for (const dataset of DATASETS)
    for (const op of opsOfDataset(dataset))
      if (!doc.reads.cells.some((c) => c.dataset === dataset && c.op === op))
        bad.push(`missing cell ${dataset} ${op}`);
  for (const c of doc.reads.cells) {
    for (const basis of ['inProcess', 'perProcess']) {
      const x = c[basis];
      if (!x) {
        bad.push(`${c.dataset} ${c.op}: no ${basis} figures`);
        continue;
      }
      if (!x.answersAgree) bad.push(`the codecs disagree on ${c.dataset} ${c.op} (${basis})`);
      if (
        !finiteAll(x, [
          'nativeMedian',
          'typescriptMedian',
          'controlMedian',
          'typescriptVsNative',
          'controlVsNative',
          'loadMax',
        ])
      )
        bad.push(`${c.dataset} ${c.op}: a ${basis} figure is not a number`);
      if (x.verdict === 'malformed' || !x.rounds?.length)
        bad.push(`${c.dataset} ${c.op}: no ${basis} verdict`);
    }
    if (c.verdict === 'malformed') bad.push(`${c.dataset} ${c.op}: no verdict`);
  }
  for (const c of doc.reads.cells)
    if (typeof c.perProcess?.timedStorageCalls !== 'object')
      bad.push(`${c.dataset} ${c.op}: no per-process storage-call count`);
  for (const k of ['vsShipped', 'tsVsSmallestFirstNative']) {
    const f = doc.nativeSmallestFirst[k];
    if (!f.startedAt || !f.endedAt || !f.commit) bad.push(`${k}: no start and end time or commit`);
    if (f.cells.length === 0 || f.attributionFailures.length > 0)
      bad.push(`${k}: no cells, or a wrong codec: ${f.attributionFailures.join('; ')}`);
    for (const c of f.cells)
      for (const basis of ['inProcess', 'perProcess'])
        if (!c[basis]?.answersAgree || !Number.isFinite(c[basis].typescriptVsNative))
          bad.push(`${k} ${c.dataset} ${c.op} (${basis}): disagreeing answers or no figure`);
  }
  for (const k of ['reads', 'write', 'startup', 'memory'])
    if (!doc[k].startedAt || !doc[k].endedAt || !doc[k].commit)
      bad.push(`${k}: no start and end time or commit`);
  bad.push(...doc.reads.attributionFailures.map((f) => `wrong codec or cold cache: ${f}`));
  if (!(doc.reads.coldStorageCalls > 0)) bad.push('the storage counter saw no cold call');
  if (doc.write.rows.length !== 3 || doc.write.rows.some((r) => r.verdict === 'malformed'))
    bad.push('write rows malformed');
  if (!doc.write.sameBytes) bad.push('the codecs wrote different bytes');
  if (!doc.write.gcExposed) bad.push('the write path ran without a collection');
  if (!Number.isFinite(doc.startup.moduleLoadMs.nativeMedian)) bad.push('module load missing');
  for (const f of ['loadMs', 'first1000HasMs'])
    if (!doc.startup.coldProcess.fields[f]?.rounds?.length) bad.push(`cold row ${f} missing`);
  if (doc.memory.rows.length !== Object.keys(MEMORY_SCALE).length) bad.push('memory rows missing');
  for (const r of doc.memory.rows)
    for (const k of ['native', 'typescript'])
      if (
        !(r[k].chunks > 0) ||
        !finiteAll(r[k].heapExternal, ['median', 'min', 'max']) ||
        !finiteAll(r[k].rss, ['median', 'min', 'max'])
      )
        bad.push(`memory row ${r.dataset}/${k} is not a number`);
  return bad;
}

async function main() {
  const arg = (name) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (arg('child-reads')) {
    console.log(JSON.stringify(await readsChild(arg('child-reads'), arg('only'))));
  } else if (arg('child-proc')) {
    const [codec, dataset, order] = arg('child-proc').split(':');
    console.log(
      JSON.stringify(await procChild(codec, dataset, arg('only'), order === 'smallest-first')),
    );
  } else if (arg('child-memory')) {
    const [codec, dataset] = arg('child-memory').split(':');
    console.log(JSON.stringify(await memoryChild(codec, dataset)));
  } else if (arg('child-cold')) {
    console.log(JSON.stringify(await coldChild(arg('child-cold'))));
  } else if (arg('child-import')) {
    console.log(JSON.stringify(importChild(arg('child-import'))));
  } else if (process.argv.includes('--child-write')) {
    console.log(JSON.stringify(await writeMeasure()));
  } else if (process.argv.includes('--child-section')) {
    console.log(JSON.stringify(readsMeasure(arg('only'))));
  } else if (CHECK) {
    const doc = {
      reads: part(() => readsMeasure()),
      nativeSmallestFirst: fairnessPart(),
      write: part(writeViaChild),
      startup: part(startupMeasure),
      memory: part(memoryMeasure),
    };
    const bad = wellFormed(doc);
    if (bad.length > 0) {
      console.error(`ts-codec engine bench: ${bad.join('; ')}`);
      process.exit(1);
    }
    console.log(
      `ts-codec engine bench: ${doc.reads.cells.length} read cells (in-process and per-process), the write path, start-up and memory ran, output well formed`,
    );
  } else if (process.argv.includes('--write')) {
    console.log(JSON.stringify(writeViaChild(), null, 2));
  } else if (process.argv.includes('--startup')) {
    console.log(JSON.stringify(startupMeasure(), null, 2));
  } else if (process.argv.includes('--memory')) {
    console.log(JSON.stringify(memoryMeasure(), null, 2));
  } else if (process.argv.includes('--all')) {
    const doc = {
      note: 'Wall-clock and machine-dependent: recorded, not asserted. Every round of every figure is kept (roundFields says what each column of a round is); the medians, quartiles and verdicts beside them are computed from the rounds by bench/lib/codec-verdict.cjs, and tests/bench/ts-codec-verdict.test.ts recomputes them. A cell is measured in-process (three stores in one process) and per-process (three fresh processes, one codec each); its verdict is the per-process one.',
      ...environment(),
      startedAt: new Date().toISOString(),
      rules: {
        rounds: ROUNDS,
        processRounds: PROCESS_ROUNDS,
        writeRounds: WRITE_ROUNDS,
        importRuns: IMPORT_RUNS,
        coldRuns: STARTUP_RUNS,
        memoryRepeats: MEMORY_REPEATS,
        bar: BAR,
        controlBand: CONTROL_BAND,
        minRounds: MIN_ROUNDS,
        maxLoad: MAX_LOAD,
        ...(ANY_LOAD ? { anyLoad: true } : {}),
        roundFields: ROUND_FIELDS,
        orders: ORDERS,
        subjects: VARIANTS.map((v) => `${v.key} (${v.codec} codec)`),
        quartiles: 'the element at index floor(q * n) of the sorted paired differences',
        verdictBasis: 'per-process',
      },
      reads: part(() => readsMeasure()),
      nativeSmallestFirst: fairnessPart(),
      write: part(writeViaChild),
      memory: part(memoryMeasure),
      startup: part(startupMeasure),
    };
    doc.endedAt = new Date().toISOString();
    fs.writeFileSync(RESULTS, `${compactJson(doc)}\n`);
    console.log(`wrote ${path.relative(ROOT, RESULTS)}`);
  } else if (process.argv.includes('--reads-in-process')) {
    console.log(JSON.stringify(readsMeasure(arg('only'), { perProcess: false }), null, 2));
  } else if (process.argv.includes('--reads-per-process')) {
    console.log(JSON.stringify(readsMeasure(arg('only'), { inProcess: false }), null, 2));
  } else {
    console.log(JSON.stringify(readsMeasure(arg('only')), null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
