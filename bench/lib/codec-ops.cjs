/*
 * The per-operation cells of the codec, one call at a time on one chunk or on one many-container bitmap, apart from the
 * harness that pairs them (`bench/ts-codec-paired.cjs --ops`), so another paired bench (the counting kernels) can
 * import the same cells and the same timer. The codec is a parameter: a cell never names a package, only the codec seam
 * (`fromValues`, `safeDeserialize` and the bitmap's own methods).
 *
 * WHAT A CELL IS
 *
 *   { name, unit, cold, make(codec) -> () => result }
 *
 * `make` does the setup (outside the timing) and returns the timed call. `unit` is the number of operations one call
 * stands for (a probe loop of 256 reads is reported per read). A `cold` cell is timed once, on the first call of a
 * fresh process, with no warm-up: the cost the first reads of a cold start pay, and the only place the changed decode
 * path shows when the store's cache holds decoded bitmaps and a warm read never decodes. Every other cell is warmed by
 * time and then timed in batches.
 *
 * THE CELLS (shapes: `dense` a bitset, `sparse` an array, `run` runs, `many` 128 containers of the three kinds)
 *
 *   has, count     256 reads per call, reported per read
 *   decode         `safeDeserialize` of the stored bytes: dense, sparse, run and many
 *   decode first   the same call, first call of a fresh process, nothing warmed
 *   serialize, iterate, toUint32      on dense, sparse, run and many
 *   optimize, clone, build, addMany, removeMany    on dense, sparse and run
 *   and, or, andNot    the in-place combine of a clone of one operand with another, on six operand pairs
 *
 * The stored bytes come from the native codec (`storedBytesOf`), so every subject decodes the same bytes whatever it
 * writes itself; ids are regenerated from seeds, so they are the same in every process. `digest` reduces a call's
 * result to a string so a harness can fail the run when two subjects disagree.
 *
 * Pure but for the clock the timer reads: wall-clock, machine-dependent, recorded and never asserted.
 */
'use strict';

const { Buffer } = require('node:buffer');
const { prng, randomLows, runLows, lowsOf } = require('./codec-data.cjs');

/** The hard size cap every decode passes, as the store does. */
const CAP = 1 << 26;
/** Probes per `has` and `count` call. */
const PROBES = 256;
/** Containers in the many-container bitmap. */
const MANY_CONTAINERS = 128;

/** The ids of one chunk of a shape (values below 65,536, ascending). */
function lowsOfShape(shape, seed) {
  const next = prng(seed);
  if (shape === 'dense') return randomLows(next, 32768);
  if (shape === 'sparse') return randomLows(next, 1000);
  if (shape === 'run') return runLows(next);
  if (shape === 'tiny') return randomLows(next, 64);
  if (shape === 'quarter') return randomLows(next, 4000);
  throw new Error(`no shape ${JSON.stringify(shape)}`);
}

/** The ids of the many-container bitmap: containers of the three kinds in turn, keys 0, 3, 6, ... */
function manyIds(seed) {
  const out = [];
  for (let i = 0; i < MANY_CONTAINERS; i++) {
    const next = prng(seed * 1000 + i);
    const kind = ['dense', 'sparse', 'runs'][i % 3];
    const lows = kind === 'dense' ? randomLows(next, 5000) : lowsOf(kind, next);
    for (const low of lows) out.push(i * 3 * 65536 + low);
  }
  return out;
}

/** Every input of a shape name: `{ ids, other }`, the ids of two different chunks of the shape. */
function idsOfShape(shape) {
  if (shape === 'many') return { ids: manyIds(11), other: manyIds(22) };
  return { ids: lowsOfShape(shape, 11), other: lowsOfShape(shape, 22) };
}

/** The shapes the cells use. */
const SHAPES = ['dense', 'sparse', 'run', 'tiny', 'quarter', 'many'];
const SINGLES = ['dense', 'sparse', 'run'];
const PAIRS = [
  ['dense/dense', 'dense', 'dense'],
  ['sparse/sparse', 'sparse', 'sparse'],
  ['run/run', 'run', 'run'],
  ['sparse/dense', 'sparse', 'dense'],
  ['run/dense', 'run', 'dense'],
  ['skew 64/4000', 'tiny', 'quarter'],
];

/**
 * The stored bytes of every shape, for both id sets, as `native` (a codec with `fromValues`, whose bitmap has
 * `optimize` and `serialize`) writes them: `{ dense: Uint8Array, 'dense other': Uint8Array, ... }`.
 */
function storedBytesOf(native) {
  const out = {};
  for (const shape of SHAPES) {
    const { ids, other } = idsOfShape(shape);
    for (const [key, list] of [
      [shape, ids],
      [`${shape} other`, other],
    ]) {
      const bitmap = native.fromValues(list);
      bitmap.optimize();
      out[key] = bitmap.serialize();
    }
  }
  return out;
}

/** The stored bytes as plain JSON text, for a child process to read (`storedBytesFromJson` is its inverse). */
function storedBytesToJson(bytes) {
  const out = {};
  for (const [k, v] of Object.entries(bytes)) out[k] = Buffer.from(v).toString('base64');
  return JSON.stringify(out);
}

function storedBytesFromJson(text) {
  const out = {};
  for (const [k, v] of Object.entries(JSON.parse(text)))
    out[k] = new Uint8Array(Buffer.from(v, 'base64'));
  return out;
}

/** Every cell, from the stored bytes of `storedBytesOf`. */
function opCells(bytes) {
  const list = [];
  const data = {};
  for (const shape of SHAPES) data[shape] = idsOfShape(shape);
  const more = lowsOfShape('sparse', 33);
  const decoded = (codec, key) => codec.safeDeserialize(bytes[key], CAP);
  const probesOf = (shape) => {
    const { ids } = data[shape];
    return Array.from({ length: PROBES }, (_, i) =>
      i % 2 === 0 ? ids[(i * 7) % ids.length] : ((i * 251 + 3) & 0xffff) >>> 0,
    );
  };
  for (const shape of [...SINGLES, 'many']) {
    const probes = probesOf(shape);
    list.push({
      name: `has ${shape}`,
      unit: PROBES,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => {
          let n = 0;
          for (let i = 0; i < PROBES; i++) if (bm.has(probes[i])) n++;
          return n;
        };
      },
    });
    list.push({ name: `decode ${shape}`, make: (c) => () => decoded(c, shape) });
    list.push({
      name: `decode first ${shape}`,
      cold: true,
      make: (c) => () => decoded(c, shape),
    });
    list.push({
      name: `serialize ${shape}`,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => bm.serialize();
      },
    });
    list.push({
      name: `iterate ${shape}`,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => {
          let s = 0;
          for (const v of bm) s = (s + v) >>> 0;
          return s;
        };
      },
    });
    list.push({
      name: `toUint32 ${shape}`,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => bm.toUint32Array();
      },
    });
  }
  for (const shape of SINGLES) {
    const { ids } = data[shape];
    const gone = ids.filter((_, i) => i % 4 === 0).slice(0, 1000);
    list.push({
      name: `optimize ${shape}`,
      make: (c) => {
        const bm = c.fromValues(ids);
        return () => {
          const x = bm.clone();
          x.optimize();
          return x;
        };
      },
    });
    list.push({
      name: `count ${shape}`,
      unit: PROBES,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => {
          let n = 0;
          for (let i = 0; i < PROBES; i++) n += bm.size;
          return n;
        };
      },
    });
    list.push({
      name: `clone ${shape}`,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => bm.clone();
      },
    });
    list.push({ name: `build ${shape}`, make: (c) => () => c.fromValues(ids) });
    list.push({
      name: `addMany ${shape}`,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => {
          const x = bm.clone();
          x.addMany(more);
          return x;
        };
      },
    });
    list.push({
      name: `removeMany ${shape}`,
      make: (c) => {
        const bm = decoded(c, shape);
        return () => {
          const x = bm.clone();
          x.removeMany(gone);
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
          const a = decoded(c, sa);
          const b = decoded(c, sb === sa ? `${sb} other` : sb);
          return () => {
            const x = a.clone();
            x[call](b);
            return x;
          };
        },
      });
    }
  }
  return list.map((cell) => ({ unit: 1, cold: false, ...cell }));
}

/** A hash of a typed array's words, for `digest`. */
function hashWords(words) {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619) >>> 0;
  return `${words.length}:${h}`;
}

/** A call's result as a string two subjects can be compared by: numbers as text, bytes and bitmaps by a hash. */
function digest(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array || value instanceof Uint32Array) return hashWords(value);
  if (value !== null && typeof value === 'object' && typeof value.toUint32Array === 'function') {
    return hashWords(value.toUint32Array());
  }
  return String(value);
}

const nowNs = () => Number(process.hrtime.bigint());
/** The CPU time this process has used, user and system, in nanoseconds (the clock counts microseconds). */
const cpuNs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) * 1e3;
};
/** Every result lands here, reachable from `globalThis`, so no call is dead code. */
const keep = new Array(16).fill(0);
globalThis.__codecOpsKeep = keep;

/**
 * The warmed figure of a call, in nanoseconds per operation: warm by time (`warmMs`), size a batch to about `sampleMs`,
 * and time one batch. A harness calls it once per subject per round; the pairing is the harness's.
 */
function measureSteady(fn, unit = 1, options = {}) {
  return measureSteadyCpu(fn, unit, options).ns;
}

/** `measureSteady`, with the CPU nanoseconds per operation over the same timed batch: `{ ns, cpuNs }`. */
function measureSteadyCpu(fn, unit = 1, { warmMs = 300, sampleMs = 8 } = {}) {
  const end = nowNs() + warmMs * 1e6;
  let reps = 1;
  for (;;) {
    const t0 = nowNs();
    for (let i = 0; i < reps; i++) keep[i & 15] = fn();
    const spent = nowNs() - t0;
    if (spent < sampleMs * 1e6 * 0.5) {
      reps *= 2;
    } else if (nowNs() >= end) {
      reps = Math.max(1, Math.round((reps * sampleMs * 1e6) / Math.max(spent, 1)));
      break;
    }
  }
  const t0 = nowNs();
  const c0 = cpuNs();
  for (let i = 0; i < reps; i++) keep[i & 15] = fn();
  const cpu = cpuNs() - c0;
  return { ns: (nowNs() - t0) / reps / unit, cpuNs: cpu / reps / unit };
}

/** The time of the first call, in nanoseconds, nothing warmed. */
function measureCold(fn) {
  return measureColdCpu(fn).ns;
}

/** `measureCold`, with the CPU nanoseconds of the same call: `{ ns, cpuNs }`. */
function measureColdCpu(fn) {
  const t0 = nowNs();
  const c0 = cpuNs();
  keep[0] = fn();
  const cpu = cpuNs() - c0;
  return { ns: nowNs() - t0, cpuNs: cpu };
}

module.exports = {
  CAP,
  SHAPES,
  PAIRS,
  storedBytesOf,
  storedBytesToJson,
  storedBytesFromJson,
  opCells,
  digest,
  measureSteady,
  measureSteadyCpu,
  measureCold,
  measureColdCpu,
};
