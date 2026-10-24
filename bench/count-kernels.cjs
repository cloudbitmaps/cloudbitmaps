/*
 * Counting kernels bench: the codec's count-without-building operations against the work they replace, and the codec's
 * hot paths against the codec at the base commit, in one paired run with an A/A control.
 *
 * TWO PARTS
 *
 *   count     `andCardinality` against building the intersection and taking its size (`clone`, `andInPlace`, `size`),
 *             on the six operand pairs of `ts-codec.cjs` and on two multi-chunk pairs. A count operation is kept only
 *             if it is faster on every pair. `intersects`, `isSubset` and `isEqual` are timed as well, against the
 *             same build-then-size.
 *   hot       `has`, `size`, iteration, `and` and `andNot` (the codec's own in-place combines, which the store's
 *             `has`, `count`, `iterate` and `intersect` call) on the same shapes, for three subjects of one run: the
 *             codec at the base commit, the codec at this commit, and the base codec a second time as the A/A control.
 *
 * HOW. Each cell runs in its own child process. The subjects' rounds are interleaved in one process, in an order that
 * rotates each round; a hot cell is run three times with the subjects in other slots (a subject that always sits in the
 * first slot can differ from the others for reasons of the harness alone), and its ratios are the medians of the three; a round times a batch of about 8 ms after a 300 ms warm-up. A cell
 * reports the median of 31 rounds per subject, the head against base ratio and the A/A ratio. The band is the A/A
 * ratio's distance from 1 in the same run, never narrower than 2% (a control that happens to land within 0.1% is luck, not
 * a measurement of 0.1%): a head ratio outside `1 +- band` is out of band, and a band wider than 2% means the run was
 * noisy (another process was running) and the cell is to be taken again. A figure is taken only while the 1-minute load average is under 6.
 *
 * The base codec is the `packages/roaring/src` of another commit, copied to `<dir>/src` (`git archive origin/main
 * packages/roaring/src`, then move it to `<dir>/src`) and named by `COUNT_BENCH_BASE=<dir>`. Wall-clock and
 * machine-dependent: recorded, not asserted. `--check` times nothing: it runs every cell once and fails if the counting
 * answers differ from building the result.
 *
 *   node bench/count-kernels.cjs [--only=<text>]          both parts (needs COUNT_BENCH_BASE for `hot`)
 *   node bench/count-kernels.cjs --check
 */
'use strict';

const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ROUNDS = 31;
const ROUND_MS = 8;
const WARM_MS = 300;
const MAX_LOAD = 6;
const REPEATS = 5;
const CAP = 1 << 26;
const BASE = process.env.COUNT_BENCH_BASE ? path.resolve(process.env.COUNT_BENCH_BASE) : undefined;

/** The TypeScript codec, bundled from `<dir>/src` (or this checkout's), as a CommonJS module. */
function loadCodec(dir) {
  const { buildSync } = require('esbuild');
  const rr = path.join(ROOT, 'packages/roaring');
  const entry = path.join(dir ? path.resolve(dir) : rr, 'src/ts-roaring/bitmap');
  const out = buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(entry)};\n`,
      resolveDir: rr,
      sourcefile: 'count-kernels-entry.ts',
      loader: 'ts',
    },
    tsconfig: path.join(rr, 'tsconfig.json'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    packages: 'external',
    write: false,
    logLevel: 'error',
  });
  const mod = { exports: {} };
  const req = createRequire(path.join(rr, 'package.json'));
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

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

function randomLows(seed, count) {
  const next = prng(seed);
  const seen = new Set();
  while (seen.size < count) seen.add(Math.floor(next() * 65536));
  return Array.from(seen).sort((x, y) => x - y);
}

function runLows(seed, runs) {
  const next = prng(seed);
  const out = [];
  let at = Math.floor(next() * 50);
  for (let r = 0; r < runs; r++) {
    const len = 100 + Math.floor(next() * 201);
    for (let k = 0; k < len && at + k < 65536; k++) out.push(at + k);
    at += len + 50 + Math.floor(next() * 150);
    if (at > 65535) break;
  }
  return out;
}

const SHAPES = {
  dense: (seed) => randomLows(seed, 32768),
  sparse: (seed) => randomLows(seed, 1000),
  run: (seed) => runLows(seed, 150),
  tiny: (seed) => randomLows(seed, 64),
  quarter: (seed) => randomLows(seed, 4000),
};
const PAIRS = [
  ['dense/dense', 'dense', 'dense'],
  ['sparse/sparse', 'sparse', 'sparse'],
  ['run/run', 'run', 'run'],
  ['sparse/dense', 'sparse', 'dense'],
  ['run/dense', 'run', 'dense'],
  ['skew 64/4000', 'tiny', 'quarter'],
];
const SINGLES = ['dense', 'sparse', 'run'];

/** Ids over `keys` chunks starting at chunk 0 (every `step`th), each chunk the shape's remainders. */
function spread(shape, seed, keys, step) {
  const out = [];
  for (let k = 0; k < keys; k++) {
    for (const low of SHAPES[shape](seed + k)) out.push(k * step * 65536 + low);
  }
  return out;
}

/** A stored bitmap of `ids` (optimized, so runs are runs), decoded: what a store reads. */
function stored(codec, ids) {
  const seam = codec.tsRoaringCodec;
  const b = seam.fromValues(ids);
  b.optimize();
  return seam.safeDeserialize(b.serialize(), CAP);
}

/** The operand pairs of the count part, as id lists. */
function countData() {
  const out = PAIRS.map(([label, sa, sb]) => ({ label, a: SHAPES[sa](11), b: SHAPES[sb](22) }));
  out.push({
    label: 'mixed 32 chunks',
    a: spread('sparse', 5, 32, 1),
    b: spread('sparse', 6, 32, 1),
  });
  out.push({ label: 'runs 32 chunks', a: spread('run', 5, 32, 1), b: spread('run', 6, 32, 1) });
  return out;
}

function countCells() {
  const cells = [];
  for (const d of countData()) {
    const build = (codec) => {
      const a = stored(codec, d.a);
      const b = stored(codec, d.b);
      const s2 = stored(codec, d.a);
      return {
        a,
        b,
        a2: s2,
        build: () => {
          const x = a.clone();
          x.andInPlace(b);
          return x.size;
        },
        buildSelf: () => {
          const x = a.clone();
          x.andInPlace(s2);
          return x.size;
        },
      };
    };
    for (const [name, call, same] of [
      ['andCardinality', (s) => s.a.andCardinality(s.b), (s) => s.build()],
      ['orCardinality', (s) => s.a.orCardinality(s.b), (s) => s.a.size + s.b.size - s.build()],
      ['intersects', (s) => s.a.intersects(s.b), (s) => s.build() > 0],
      ['isSubset', (s) => s.a.isSubset(s.b), (s) => s.build() === s.a.size],
      [
        'isEqual',
        (s) => s.a.isEqual(s.a2),
        (s) => s.buildSelf() === s.a.size && s.a2.size === s.a.size,
      ],
    ]) {
      cells.push({
        name: `${name} ${d.label}`,
        count: true,
        make: (codec, variant) => {
          const s = build(codec);
          return variant === 'count' ? () => call(s) : () => same(s);
        },
        answers: (codec) => {
          const s = build(codec);
          return [call(s), same(s)];
        },
      });
    }
  }
  return cells;
}

function hotCells() {
  const cells = [];
  for (const shape of SINGLES) {
    const ids = SHAPES[shape](11);
    const probes = Array.from({ length: 256 }, (_, i) =>
      i % 2 === 0 ? ids[(i * 7) % ids.length] : (i * 251 + 3) & 0xffff,
    );
    cells.push({
      name: `has ${shape}`,
      unit: 256,
      make: (c) => {
        const bm = stored(c, ids);
        return () => {
          let n = 0;
          for (let i = 0; i < 256; i++) if (bm.has(probes[i])) n++;
          return n;
        };
      },
    });
    cells.push({
      name: `count ${shape}`,
      unit: 256,
      make: (c) => {
        // Eight bitmaps read in turn, so the loop is not folded into one load.
        const held = Array.from({ length: 8 }, (_, k) => stored(c, ids.slice(0, ids.length - k)));
        return () => {
          let n = 0;
          for (let i = 0; i < 256; i++) n += held[i & 7].size;
          return n;
        };
      },
    });
    cells.push({
      name: `iterate ${shape}`,
      make: (c) => {
        const bm = stored(c, ids);
        return () => {
          let s = 0;
          for (const v of bm) s += v;
          return s;
        };
      },
    });
  }
  for (const [label, sa, sb] of PAIRS) {
    for (const [op, call] of [
      ['and', 'andInPlace'],
      ['andNot', 'andNotInPlace'],
    ]) {
      cells.push({
        name: `${op} ${label}`,
        make: (c) => {
          const a = stored(c, SHAPES[sa](11));
          const b = stored(c, SHAPES[sb](22));
          return () => {
            const x = a.clone();
            x[call](b);
            return x;
          };
        },
      });
    }
  }
  return cells;
}

const now = () => Number(process.hrtime.bigint());
const keep = new Array(16).fill(0);
globalThis.__countKernelsKeep = keep;

function calibrate(fn) {
  const warmEnd = now() + WARM_MS * 1e6;
  let reps = 1;
  let spent = 0;
  while (now() < warmEnd || spent < ROUND_MS * 1e6 * 0.5) {
    const t0 = now();
    for (let i = 0; i < reps; i++) keep[i & 15] = fn();
    spent = now() - t0;
    if (spent < ROUND_MS * 1e6 * 0.5) reps *= 2;
    else if (now() >= warmEnd) break;
  }
  return Math.max(1, Math.round((reps * ROUND_MS * 1e6) / Math.max(spent, 1)));
}

function timeBatch(fn, reps) {
  const t0 = now();
  for (let i = 0; i < reps; i++) keep[i & 15] = fn();
  return (now() - t0) / reps;
}

const median = (xs) => xs.slice().sort((p, q) => p - q)[xs.length >> 1];

function waitForQuietMachine() {
  for (let waited = 0; ; waited += 20) {
    if (os.loadavg()[0] < MAX_LOAD) return;
    if (waited >= 600) {
      console.error(
        `load ${os.loadavg()[0].toFixed(2)} stays at or above ${MAX_LOAD}: not measuring`,
      );
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
}

/** The rounds of several subjects, interleaved, the order rotating each round. Returns each subject's median per unit. */
function rotate(subjects, unit) {
  waitForQuietMachine();
  let load = os.loadavg()[0];
  const reps = subjects.map((s) => calibrate(s.fn));
  const samples = subjects.map(() => []);
  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < subjects.length; k++) {
      const i = (k + r) % subjects.length;
      samples[i].push(timeBatch(subjects[i].fn, reps[i]));
    }
  }
  load = Math.max(load, os.loadavg()[0]);
  return { medians: samples.map((s) => median(s) / unit), load };
}

function measureCount(cell) {
  const codec = loadCodec();
  const { medians, load } = rotate(
    [
      { fn: cell.make(codec, 'build') },
      { fn: cell.make(codec, 'count') },
      { fn: cell.make(codec, 'build') },
    ],
    1,
  );
  const [build, count, control] = medians;
  return {
    cell: cell.name,
    buildNs: +build.toFixed(1),
    countNs: +count.toFixed(1),
    countOverBuild: +(count / build).toFixed(3),
    controlOverBuild: +(control / build).toFixed(3),
    load: +load.toFixed(2),
  };
}

/** One subject of a hot cell in this process: the median ns per unit over `ROUNDS` timed batches, after the warm-up. */
function measureSubject(cell, role) {
  const codec = role === 'head' ? loadCodec() : loadCodec(BASE);
  const { medians, load } = rotate([{ fn: cell.make(codec) }], cell.unit || 1);
  return { ns: medians[0], load };
}

/**
 * A hot cell: each subject in a process of its own (so the call sites in the timed code see one codec's classes, as
 * in production), the three taken in an order that rotates through `REPEATS` repeats; a subject's figure is the median
 * of its processes' medians. Interleaving three codecs in one process was tried first and abandoned: the call sites
 * became polymorphic and the subject warmed first was faster than an identical copy of itself.
 */
function measureHot(cell, spawn) {
  const roles = ['base', 'head', 'aa'];
  const got = { base: [], head: [], aa: [] };
  let load = 0;
  for (let rep = 0; rep < REPEATS; rep++) {
    for (let k = 0; k < 3; k++) {
      const role = roles[(k + rep) % 3];
      const r = spawn(cell.name, role);
      got[role].push(r.ns);
      load = Math.max(load, r.load);
    }
  }
  const ratios = (role) => got[role].map((v, n) => v / got.base[n]);
  const base = median(got.base);
  const h = median(got.head) / base;
  const a = median(got.aa) / base;
  const band = Math.abs(a - 1);
  return {
    cell: cell.name,
    baseNs: +base.toFixed(1),
    headNs: +median(got.head).toFixed(1),
    headOverBase: +h.toFixed(3),
    aaOverBase: +a.toFixed(3),
    band: +band.toFixed(3),
    headOverBaseByRepeat: ratios('head').map((v) => +v.toFixed(3)),
    aaOverBaseByRepeat: ratios('aa').map((v) => +v.toFixed(3)),
    verdict:
      band > 0.02
        ? 'noisy: take again'
        : Math.abs(h - 1) <= Math.max(band, 0.02)
          ? 'in band'
          : 'OUT OF BAND',
    load: +load.toFixed(2),
  };
}

function check() {
  const codec = loadCodec();
  for (const cell of countCells()) {
    const [got, want] = cell.answers(codec);
    if (got !== want) throw new Error(`${cell.name}: counting says ${got}, building says ${want}`);
    for (const variant of ['count', 'build']) cell.make(codec, variant)();
  }
  if (BASE)
    for (const cell of hotCells()) for (const c of [loadCodec(BASE), loadCodec()]) cell.make(c)();
  console.log('count-kernels: every cell ran and the counting answers match building the result');
}

function main() {
  const arg = (name) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (process.argv.includes('--check')) return check();
  const childCount = arg('child-count');
  const childHot = arg('child-hot');
  const role = arg('role');
  if (childCount) {
    console.log(JSON.stringify(measureCount(countCells().find((c) => c.name === childCount))));
    return;
  }
  if (childHot) {
    console.log(
      JSON.stringify(
        measureSubject(
          hotCells().find((c) => c.name === childHot),
          role,
        ),
      ),
    );
    return;
  }
  const only = arg('only');
  const child = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [__filename, ...args], { encoding: 'utf8', env: process.env })
        .trim()
        .split('\n')
        .pop(),
    );
  const emit = (row) => {
    console.log(JSON.stringify(row));
    return row;
  };
  for (const c of countCells().filter((x) => !only || x.name.includes(only))) {
    emit(child([`--child-count=${c.name}`]));
  }
  if (!BASE) {
    console.log('COUNT_BENCH_BASE is not set: the hot-path part was skipped');
    return;
  }
  for (const c of hotCells().filter((x) => !only || x.name.includes(only))) {
    emit(measureHot(c, (name, r) => child([`--child-hot=${name}`, `--role=${r}`])));
  }
}

main();
