/*
 * TypeScript codec micro-bench — one operation at a time on one chunk, the TypeScript Roaring codec against the native
 * one (CRoaring through `roaring`), the before/after instrument for speed work on `packages/roaring/src/ts-roaring/`.
 *
 * WHY THIS EXISTS
 *
 * The store reads and combines chunks of up to 65,536 ids, each a one-container bitmap. A change to the TypeScript
 * codec has to be judged on those operations, in one process, against the native codec, or "faster" is a guess. This
 * file measures each operation of the codec seam on three chunk shapes and puts the two codecs side by side. It is not
 * the engine bench: it does not time `has`, `count`, `iterate` or `intersect` through the store.
 *
 * WHAT IS MEASURED
 *
 * Median nanoseconds per call over interleaved rounds (native, TypeScript, native, ...), after a warm-up that runs for
 * a fixed time, not a fixed count. Each round times a batch sized to about 8 ms. Operations:
 *
 *   has          256 probes of the chunk, half present, per probe
 *   decode       `safeDeserialize` of the chunk's stored bytes
 *   serialize    the decoded bitmap's portable bytes
 *   iterate      every value through `for...of`, per call
 *   toUint32     `toUint32Array()`, per call (the native codec's own call, where it has one)
 *   optimize     `optimize()` of a bitmap built from ids (a clone of it, so each call has the work to do)
 *   count        `size`
 *   clone        `clone()`
 *   build        `fromValues` of the chunk's ids
 *   addMany      1,000 more ids into a clone of the chunk
 *   and, or, andNot   the combine of a clone of one operand with another (the in-place call), per pair
 *
 * A combine's figure includes the clone it needs, which the `clone` row gives. Shapes: `dense` (32,768 ids of 65,536,
 * a bitset), `sparse` (1,000 ids, an array) and `run` (150 runs of 100 to 300 ids, stored as runs); and for the
 * combines the pairs dense/dense, sparse/sparse, run/run, sparse/dense, run/dense and a skewed pair (64 ids against
 * 4,000).
 *
 * `--memory` adds the bytes each decoded chunk holds, by kind: 20,000 chunks decoded and held, heap plus external
 * memory after a forced collection (the TypeScript codec's whole footprint) and the resident-set growth for both. It
 * needs `node --expose-gc`.
 *
 * HONESTY BOUNDARY
 *
 * Wall-clock and machine-dependent: recorded, not asserted. A figure is taken only while the 1-minute load average is
 * under 6 (the run waits, then refuses), and each carries the highest load seen during its cell. Medians of 11 rounds
 * on a warmed process are not a confidence interval. The two codecs share one process, so the native one's boundary
 * crossings and the TypeScript one's allocation both show up in the figures; neither is subtracted.
 *
 * `--only=<text>` runs the cells whose names contain the text (`--only=iterate`, `--only=and `). Run: `pnpm bench:ts-codec` (builds nothing: it bundles the codec sources itself). `TS_CODEC_INJECT=1` also writes
 * bench/ts-codec-results.json. `pnpm bench:ts-codec:check` (`--check`) measures nothing: it runs every operation once
 * on both codecs and fails if their answers differ, or if a cell of the table is missing.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'bench/ts-codec-results.json');
const ROUNDS = 11;
const ROUND_MS = 8;
const WARM_MS = 60;
const MAX_LOAD = 6;
const CAP = 1 << 26;

/** The two codecs, bundled from source (the TypeScript codec is not in any built entry). */
function loadCodecs() {
  const { buildSync } = require('esbuild');
  const rr = path.join(ROOT, 'packages/roaring');
  const out = buildSync({
    stdin: {
      contents:
        `export { roaringCodec } from './src/roaring-codec';\n` +
        `export { tsRoaringCodec } from './src/ts-roaring/bitmap';\n`,
      resolveDir: rr,
      sourcefile: 'ts-codec-bench-entry.ts',
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
  return { native: mod.exports.roaringCodec, ts: mod.exports.tsRoaringCodec };
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

/** `count` distinct ascending values below 65,536. */
function randomLows(seed, count) {
  const next = prng(seed);
  const seen = new Set();
  while (seen.size < count) seen.add(Math.floor(next() * 65536));
  return Array.from(seen).sort((x, y) => x - y);
}

/** `runs` runs of 100 to 300 values, ascending, from `seed`. */
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

/** The stored bytes of a chunk, as the native codec writes them. */
function storedBytes(native, ids) {
  const b = native.fromValues(ids);
  b.optimize();
  return b.serialize();
}

/** Every cell, as `{ name, make(codec, input) -> () => unknown }`: `make` does the setup and returns the timed call. */
function cells(codecs) {
  const list = [];
  const data = {};
  for (const name of Object.keys(SHAPES)) {
    const a = SHAPES[name](11);
    const b = SHAPES[name](22);
    data[name] = {
      ids: a,
      other: b,
      bytes: storedBytes(codecs.native, a),
      otherBytes: storedBytes(codecs.native, b),
    };
  }
  const more = randomLows(33, 1000);
  for (const shape of SINGLES) {
    const d = data[shape];
    const decoded = (c) => c.safeDeserialize(d.bytes, CAP);
    const probes = Array.from({ length: 256 }, (_, i) =>
      i % 2 === 0 ? d.ids[(i * 7) % d.ids.length] : (i * 251 + 3) & 0xffff,
    );
    list.push({
      name: `has ${shape}`,
      unit: 256,
      make: (c) => {
        const bm = decoded(c);
        return () => {
          let n = 0;
          for (let i = 0; i < 256; i++) if (bm.has(probes[i])) n++;
          return n;
        };
      },
    });
    list.push({ name: `decode ${shape}`, make: (c) => () => decoded(c) });
    list.push({
      name: `serialize ${shape}`,
      make: (c) => {
        const bm = decoded(c);
        return () => bm.serialize();
      },
    });
    list.push({
      name: `iterate ${shape}`,
      make: (c) => {
        const bm = decoded(c);
        return () => {
          let s = 0;
          for (const v of bm) s += v;
          return s;
        };
      },
    });
    list.push({
      name: `toUint32 ${shape}`,
      make: (c) => {
        const bm = decoded(c);
        return () => bm.toUint32Array();
      },
    });
    list.push({
      name: `optimize ${shape}`,
      make: (c) => {
        const bm = c.fromValues(d.ids);
        return () => {
          const x = bm.clone();
          x.optimize();
          return x;
        };
      },
    });
    list.push({
      name: `count ${shape}`,
      make: (c) => {
        const bm = decoded(c);
        return () => bm.size;
      },
    });
    list.push({
      name: `clone ${shape}`,
      make: (c) => {
        const bm = decoded(c);
        return () => bm.clone();
      },
    });
    list.push({ name: `build ${shape}`, make: (c) => () => c.fromValues(d.ids) });
    list.push({
      name: `addMany ${shape}`,
      make: (c) => {
        const bm = decoded(c);
        return () => {
          const x = bm.clone();
          x.addMany(more);
          return x;
        };
      },
    });
  }
  for (const [label, sa, sb] of PAIRS) {
    for (const [op, call] of [
      ['and', 'andInPlace'],
      ['or', 'orInPlace'],
      ['andNot', 'andNotInPlace'],
    ]) {
      list.push({
        name: `${op} ${label}`,
        make: (c) => {
          const a = c.safeDeserialize(data[sa].bytes, CAP);
          const b = c.safeDeserialize(data[sb].bytes, CAP);
          return () => {
            const x = a.clone();
            x[call](b);
            return x;
          };
        },
      });
    }
  }
  return list;
}

const now = () => Number(process.hrtime.bigint());

/** The batch size that makes one timed round about `ROUND_MS`, found after a warm-up that runs for `WARM_MS`. */
function calibrate(fn) {
  const warmEnd = now() + WARM_MS * 1e6;
  let reps = 1;
  let spent = 0;
  while (now() < warmEnd || spent < ROUND_MS * 1e6 * 0.5) {
    const t0 = now();
    for (let i = 0; i < reps; i++) fn();
    spent = now() - t0;
    if (spent < ROUND_MS * 1e6 * 0.5) reps *= 2;
    else if (now() >= warmEnd) break;
  }
  return Math.max(1, Math.round((reps * ROUND_MS * 1e6) / Math.max(spent, 1)));
}

function timeBatch(fn, reps) {
  const t0 = now();
  for (let i = 0; i < reps; i++) fn();
  return (now() - t0) / reps;
}

const median = (xs) => {
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
};

function waitForQuietMachine() {
  for (let waited = 0; ; waited += 20) {
    if (os.loadavg()[0] < MAX_LOAD) return;
    if (process.env.TS_CODEC_ANY_LOAD === '1') return;
    if (waited >= 600) {
      console.error(
        `load ${os.loadavg()[0].toFixed(2)} stays at or above ${MAX_LOAD}: not measuring`,
      );
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
}

function measure(codecs, list) {
  const rows = [];
  for (const cell of list) {
    waitForQuietMachine();
    let load = os.loadavg()[0];
    const fns = { native: cell.make(codecs.native), ts: cell.make(codecs.ts) };
    const reps = { native: calibrate(fns.native), ts: calibrate(fns.ts) };
    const samples = { native: [], ts: [] };
    for (let r = 0; r < ROUNDS; r++) {
      samples.native.push(timeBatch(fns.native, reps.native));
      samples.ts.push(timeBatch(fns.ts, reps.ts));
    }
    load = Math.max(load, os.loadavg()[0]);
    const unit = cell.unit || 1;
    const n = median(samples.native) / unit;
    const t = median(samples.ts) / unit;
    rows.push({
      cell: cell.name,
      nativeNs: +n.toFixed(1),
      tsNs: +t.toFixed(1),
      ratio: +(t / n).toFixed(2),
      load: +load.toFixed(2),
    });
  }
  return rows;
}

/** Bytes each decoded chunk holds, by kind, after a forced collection. */
function memory(codecs) {
  if (typeof global.gc !== 'function') throw new Error('--memory needs node --expose-gc');
  const N = 20000;
  const rows = [];
  for (const shape of SINGLES) {
    const bytes = storedBytes(codecs.native, SHAPES[shape](11));
    const entry = { kind: shape };
    for (const name of ['native', 'ts']) {
      global.gc();
      global.gc();
      const before = process.memoryUsage();
      const held = new Array(N);
      for (let i = 0; i < N; i++) held[i] = codecs[name].safeDeserialize(bytes, CAP);
      global.gc();
      global.gc();
      const after = process.memoryUsage();
      entry[`${name}HeapExternal`] = Math.round(
        (after.heapUsed + after.external - before.heapUsed - before.external) / N,
      );
      entry[`${name}Rss`] = Math.round((after.rss - before.rss) / N);
      held.length = 0;
    }
    rows.push(entry);
  }
  return rows;
}

function sameAnswer(a, b) {
  if (a instanceof Uint8Array || a instanceof Uint32Array)
    return (
      Buffer.compare(
        Buffer.from(a.buffer, a.byteOffset, a.byteLength),
        Buffer.from(b.buffer, b.byteOffset, b.byteLength),
      ) === 0
    );
  // A bitmap: the same ids. Which container kind holds them is not an answer (a native combine can leave a run).
  if (a !== null && typeof a === 'object' && typeof a.toArray === 'function')
    return (
      a.size === b.size &&
      Buffer.compare(
        Buffer.from(Uint32Array.from(a).buffer),
        Buffer.from(Uint32Array.from(b).buffer),
      ) === 0
    );
  return a === b;
}

/** Every operation once on both codecs; their answers must agree. Measures nothing. */
function check(codecs, list) {
  const bad = [];
  for (const cell of list) {
    const x = cell.make(codecs.native)();
    const y = cell.make(codecs.ts)();
    if (!sameAnswer(x, y)) bad.push(cell.name);
  }
  if (list.length !== 48) bad.push(`${list.length} cells, not 48`);
  return bad;
}

function fmt(ns) {
  return ns >= 1e5
    ? `${(ns / 1000).toFixed(0)} us`
    : ns >= 1e3
      ? `${(ns / 1000).toFixed(1)} us`
      : `${ns.toFixed(0)} ns`;
}

function main() {
  const codecs = loadCodecs();
  const only = process.argv.find((a) => a.startsWith('--only='));
  const all = cells(codecs);
  const list = only ? all.filter((c) => c.name.includes(only.slice(7))) : all;
  if (process.argv.includes('--check')) {
    const bad = check(codecs, list);
    if (bad.length > 0) {
      console.error(`ts-codec bench: the codecs disagree or a cell is missing: ${bad.join(', ')}`);
      process.exit(1);
    }
    console.log(`ts-codec bench: ${list.length} cells, both codecs agree`);
    return;
  }
  const loadBefore = os.loadavg()[0];
  const rows = measure(codecs, list);
  const mem = process.argv.includes('--memory') ? memory(codecs) : undefined;
  const head = ['cell', 'native', 'typescript', 'ts/native', 'load'];
  console.log(head.join('\t'));
  for (const r of rows)
    console.log([r.cell, fmt(r.nativeNs), fmt(r.tsNs), r.ratio, r.load].join('\t'));
  if (mem) {
    console.log(
      '\nbytes per decoded chunk\tnative heap+external\tts heap+external\tnative rss\tts rss',
    );
    for (const m of mem)
      console.log(
        [m.kind, m.nativeHeapExternal, m.tsHeapExternal, m.nativeRss, m.tsRss].join('\t'),
      );
  }
  if (process.env.TS_CODEC_INJECT === '1') {
    let commit = 'unknown';
    try {
      commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // not a git checkout
    }
    const doc = {
      note: 'Wall-clock and machine-dependent: recorded, not asserted. Medians of interleaved rounds, ns per call; ratio is typescript over native.',
      cpu: os.cpus()[0].model,
      node: process.version,
      commit,
      loadBefore: +loadBefore.toFixed(2),
      loadAfter: +os.loadavg()[0].toFixed(2),
      rows,
      ...(mem ? { bytesPerDecodedChunk: mem } : {}),
    };
    fs.writeFileSync(RESULTS, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

main();
