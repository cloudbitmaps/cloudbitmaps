/*
 * The cells of the public bitmap class's bench (`bench/bitmap-api.cjs`) and the three subjects they run on, apart from
 * the harness that pairs them, so the cells can be read, and tested, without a clock or a process.
 *
 * THE SUBJECTS (each in a process of its own)
 *
 *   native    the pinned `roaring` package (`RoaringBitmap32`), through its documented API.
 *   ours      `RoaringBitmap`, imported from `@cloudbitmaps/roaring` (the built package).
 *   internal  the codec's own bitmap (`TsBitmap`) behind the codec seam, which is what the store calls. A cell `ours`
 *             runs that the codec has no counterpart for is not run on it.
 *
 * `ours` is run a second time as the A/A control. A cell is `{ name, method, group, who, unit, make, custom }`:
 * `make(api)` does the setup, outside the timing, and returns the timed call; `custom(api)` is a cell whose setup
 * cannot be shared between calls and so times each repetition itself. `who` lists the subjects the cell runs on.
 *
 * THE DATA. Every subject's operands are the stored bytes of the same two bitmaps (`bytesA`, `bytesB`, written by the
 * native codec with its runs optimized, as the store writes them) decoded by that subject's own decoder, so all three
 * work on the same containers; the build cells start from the ids, regenerated from seeds in every process.
 *
 * THE COUNT CELLS. `andCardinality` and `orCardinality` run on all three subjects: `native` and `ours` call the method,
 * and `internal` is build-then-count, the codec's own combine followed by `size`, so that figure is what the kernels
 * are held against. `ours` runs whichever route the class's count switch selects (the pass records which). `isSubset`,
 * `isEqual` and `intersects` have no codec counterpart. `isSubset` asks whether the intersection of the two operands is
 * inside the first, and `isEqual` whether the first operand equals a copy of itself: both answer `true`, which is the
 * full-scan case, with no early exit. `intersects` takes the two stored bitmaps as they are.
 */
'use strict';

const { Buffer } = require('node:buffer');
const { idsOf } = require('./codec-data.cjs');
const { measureSteadyCpu, measureColdCpu } = require('./codec-ops.cjs');

/** The hard size cap a decode passes, as the store does. */
const CAP = 1 << 26;
/** Reads per `has` call. */
const PROBES = 256;
/** Ids a per-id `add` cell adds. */
const ADD_IDS = 100_000;
/** Repetitions of a custom cell (after three untimed ones); the cell's figure is their median. */
const CUSTOM_REPS = 11;
const DATASETS = ['dense', 'sparse', 'runs', 'mixed', 'spread8k'];
/** Chunks of a data set, as the engine bench's scale for the combines. */
const SCALE = { dense: 32, sparse: 256, runs: 128, mixed: 128, spread8k: 8192 };
/** The tiny scale of `--check`. */
const TINY = { dense: 2, sparse: 4, runs: 2, mixed: 3, spread8k: 100 };
/** The bitmaps of an `orMany` cell are smaller, since there are up to 64 of them. */
const MANY_SCALE = { dense: 4, sparse: 32, runs: 16, mixed: 24, spread8k: 512 };
const MANY_TINY = { dense: 1, sparse: 2, runs: 1, mixed: 2, spread8k: 20 };
const SUBJECTS = ['native', 'ours', 'internal'];
/** The data set the cold cells use. */
const COLD_DATASET = 'mixed';

// ---- the subjects ---------------------------------------------------------------------------------------------------

/** The uniform surface a cell calls; a missing member means the subject has no counterpart. */
function nativeApi(nativeModule) {
  const { RoaringBitmap32: R, SerializationFormat, DeserializationFormat } = nativeModule;
  return {
    name: 'native',
    from: (list) => new R(list),
    empty: () => new R(),
    add: (b, id) => b.add(id),
    addMany: (b, list) => b.addMany(list),
    has: (b, id) => b.has(id),
    clone: (b) => b.clone(),
    combine: (op, a, b) => R[op](a, b),
    inPlace: (op, a, b) => a[`${op}InPlace`](b),
    optimize: (b) => b.runOptimize(),
    serialize: (b) => b.serialize(SerializationFormat.portable),
    deserialize: (bytes) =>
      R.deserialize(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length),
        DeserializationFormat.portable,
      ),
    iterate: (b) => {
      let s = 0;
      for (const v of b) s = (s + v) >>> 0;
      return s;
    },
    toUint32: (b) => b.toUint32Array(),
    toArray: (b) => b.toArray(),
    orMany: (list) => R.orMany(list),
    count: (op, a, b) => a[`${op}Cardinality`](b),
    subset: (a, b) => a.isSubset(b),
    equal: (a, b) => a.isEqual(b),
    intersects: (a, b) => a.intersects(b),
  };
}

function oursApi(RoaringBitmap) {
  const R = RoaringBitmap;
  return {
    name: 'ours',
    from: (list) => new R(list),
    empty: () => new R(),
    add: (b, id) => b.add(id),
    addMany: (b, list) => b.addMany(list),
    has: (b, id) => b.has(id),
    clone: (b) => b.clone(),
    combine: (op, a, b) => R[op](a, b),
    inPlace: (op, a, b) => a[`${op}InPlace`](b),
    optimize: (b) => b.runOptimize(),
    serialize: (b) => b.serialize(),
    deserialize: (bytes) => R.deserialize(bytes),
    iterate: (b) => {
      let s = 0;
      for (const v of b) s = (s + v) >>> 0;
      return s;
    },
    toUint32: (b) => b.toUint32Array(),
    toArray: (b) => b.toArray(),
    orMany: (list) => R.orMany(list),
    count: (op, a, b) => a[`${op}Cardinality`](b),
    subset: (a, b) => a.isSubset(b),
    equal: (a, b) => a.isEqual(b),
    intersects: (a, b) => a.intersects(b),
  };
}

function internalApi(codec) {
  return {
    name: 'internal',
    from: (list) => codec.fromValues(list),
    empty: () => codec.empty(),
    add: (b, id) => b.add(id),
    addMany: (b, list) => b.addMany(list),
    has: (b, id) => b.has(id),
    clone: (b) => b.clone(),
    combine: (op, a, b) => a.constructor[op](a, b),
    // The codec's bitmap has no `xorInPlace`: the class derives it.
    inPlace: (op, a, b) => {
      if (op === 'xor') return undefined;
      a[`${op}InPlace`](b);
      return a;
    },
    hasInPlace: (op) => op !== 'xor',
    optimize: (b) => b.optimize(),
    serialize: (b) => b.serialize(),
    deserialize: (bytes) => codec.safeDeserialize(bytes, CAP),
    iterate: (b) => {
      let s = 0;
      for (const v of b) s = (s + v) >>> 0;
      return s;
    },
    toUint32: (b) => b.toUint32Array(),
    toArray: (b) => b.toArray(),
    orMany: undefined,
    // Build-then-count: the combine, then its size.
    count: (op, a, b) => a.constructor[op](a, b).size,
    subset: undefined,
    equal: undefined,
    intersects: undefined,
  };
}

// ---- the data -------------------------------------------------------------------------------------------------------

/** A hash of a typed array's words, for `digest`. */
function hashWords(words) {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619) >>> 0;
  return `${words.length}:${h}`;
}

/**
 * A call's result as a string two subjects can be compared by: a number or boolean as itself, a list of ids by its
 * hash, a bitmap by the hash of its ids, and the bytes of a serialization by the hash of the bytes themselves.
 */
function digest(api, value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return hashWords(Uint32Array.from(value));
  if (value instanceof Uint32Array) return hashWords(value);
  // Bytes are compared as bytes: two subjects that wrote different bytes for one bitmap disagree, even when each
  // subject's own decoder would read its own bytes back to the same ids.
  if (value instanceof Uint8Array) return hashWords(value);
  return hashWords(api.toUint32(value));
}

/** The first id of every chunk of a data set, with bit 0 flipped: one write that lands in every container. */
function batchOf(ids) {
  const out = [];
  let key = -1;
  for (const id of ids) {
    if (id >>> 16 !== key) {
      key = id >>> 16;
      out.push((id ^ 1) >>> 0);
    }
  }
  return Uint32Array.from(out);
}

/** The inputs of a data set that every cell reads: ids, the same as a typed array, the stored bytes, probes, a batch. */
function dataOf(dataset, small, bytes) {
  const scale = small ? TINY : SCALE;
  const ids = idsOf(dataset, 0, scale);
  const probes = Array.from({ length: PROBES }, (_, i) =>
    i % 2 === 0 ? ids[(i * 7919) % ids.length] : (ids[(i * 104729) % ids.length] ^ 1) >>> 0,
  );
  return {
    dataset,
    small,
    ids,
    typed: Uint32Array.from(ids),
    some: ids.slice(0, ADD_IDS),
    probes,
    batch: batchOf(ids),
    bytesA: bytes[`${dataset} a`],
    bytesB: bytes[`${dataset} b`],
  };
}

/** The ids the stored bytes are made from, per data set: bitmaps `a` and `b` (`idsOf` segments 0 and 1). */
function storedIds(dataset, small) {
  const scale = small ? TINY : SCALE;
  return { a: idsOf(dataset, 0, scale), b: idsOf(dataset, 1, scale) };
}

/** The stored bytes of every data set, as the native codec writes them: runs optimized, portable. */
function storedBytesOf(nativeModule, small, datasets = DATASETS) {
  const api = nativeApi(nativeModule);
  const out = {};
  for (const dataset of datasets) {
    const { a, b } = storedIds(dataset, small);
    for (const [key, list] of [
      ['a', a],
      ['b', b],
    ]) {
      const bm = api.from(list);
      api.optimize(bm);
      out[`${dataset} ${key}`] = new Uint8Array(api.serialize(bm));
    }
  }
  return out;
}

function bytesToJson(bytes) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(bytes).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
    ),
  );
}

function bytesFromJson(text) {
  return Object.fromEntries(
    Object.entries(JSON.parse(text)).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]),
  );
}

// ---- the cells ------------------------------------------------------------------------------------------------------

const ALL = ['native', 'ours', 'internal'];
const NATIVE_OURS = ['native', 'ours'];

/** The median of a list of numbers: the upper middle one. */
function medianOf(xs) {
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
}

/** A collection before a timed span, where the process was started with `--expose-gc`. */
const collect = () => {
  if (typeof global.gc === 'function') global.gc();
};

const nowNs = () => Number(process.hrtime.bigint());
const cpuNs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) * 1e3;
};

/**
 * The steady cells of a data set. `method` names the public method (or methods) the cell measures, which is what the
 * stop rule that no method ships above ten times native is read against; `group` is the set of cells the words "close
 * to native" would describe.
 */
function cellsOf(data) {
  const cells = [];
  const add = (cell) => cells.push({ unit: 1, who: ALL, custom: undefined, ...cell });
  const operands = (api) => [api.deserialize(data.bytesA), api.deserialize(data.bytesB)];

  add({
    name: 'build array',
    method: 'new RoaringBitmap(array)',
    group: 'build',
    make: (api) => () => api.from(data.ids),
  });
  add({
    name: 'build Uint32Array',
    method: 'new RoaringBitmap(Uint32Array)',
    group: 'build',
    make: (api) => () => api.from(data.typed),
  });
  add({
    name: 'build addMany',
    method: 'addMany',
    group: 'build',
    make: (api) => () => {
      const b = api.empty();
      api.addMany(b, data.typed);
      return b;
    },
  });
  add({
    name: 'build add per id',
    method: 'add',
    group: 'build',
    unit: data.some.length,
    make: (api) => () => {
      const b = api.empty();
      for (let i = 0; i < data.some.length; i++) api.add(b, data.some[i]);
      return b;
    },
  });
  add({
    name: 'has',
    method: 'has',
    group: 'has',
    unit: PROBES,
    make: (api) => {
      const [a] = operands(api);
      return () => {
        let n = 0;
        for (let i = 0; i < PROBES; i++) if (api.has(a, data.probes[i])) n++;
        return n;
      };
    },
  });
  for (const op of ['and', 'or', 'xor', 'andNot']) {
    add({
      name: `${op} returning`,
      method: `RoaringBitmap.${op}`,
      group: 'combine returning',
      make: (api) => {
        const [a, b] = operands(api);
        return () => api.combine(op, a, b);
      },
    });
  }
  for (const op of ['and', 'or', 'xor', 'andNot']) {
    add({
      name: `${op} in place`,
      method: `${op}InPlace`,
      group: 'combine in place',
      who: op === 'xor' ? NATIVE_OURS : ALL,
      make: (api) => {
        const [a, b] = operands(api);
        return () => {
          const x = api.clone(a);
          api.inPlace(op, x, b);
          return x;
        };
      },
    });
  }
  add({
    name: 'serialize',
    method: 'serialize',
    group: 'serialize',
    make: (api) => {
      const [a] = operands(api);
      return () => api.serialize(a);
    },
  });
  add({
    name: 'deserialize',
    method: 'RoaringBitmap.deserialize',
    group: 'serialize',
    make: (api) => () => api.deserialize(data.bytesA),
  });
  add({
    name: 'runOptimize',
    method: 'runOptimize',
    group: 'serialize',
    make: (api) => {
      const [a] = operands(api);
      return () => {
        const x = api.clone(a);
        api.optimize(x);
        return x;
      };
    },
  });
  add({
    name: 'iterate',
    method: 'iteration',
    group: 'export',
    make: (api) => {
      const [a] = operands(api);
      return () => api.iterate(a);
    },
  });
  add({
    name: 'toUint32Array',
    method: 'toUint32Array',
    group: 'export',
    make: (api) => {
      const [a] = operands(api);
      return () => api.toUint32(a);
    },
  });
  add({
    name: 'toArray',
    method: 'toArray',
    group: 'export',
    make: (api) => {
      const [a] = operands(api);
      return () => api.toArray(a);
    },
  });
  for (const n of [8, 64]) {
    add({
      name: `orMany ${n}`,
      method: 'RoaringBitmap.orMany',
      group: 'orMany',
      who: NATIVE_OURS,
      make: (api) => {
        const scale = data.small ? MANY_TINY : MANY_SCALE;
        const list = [];
        for (let w = 0; w < n; w++) list.push(api.from(idsOf(data.dataset, 2 + w, scale)));
        return () => api.orMany(list);
      },
    });
  }
  add({
    name: 'clone',
    method: 'clone',
    group: 'clone',
    make: (api) => {
      const [a] = operands(api);
      return () => api.clone(a);
    },
  });
  add({
    name: 'clone then write',
    method: 'clone',
    group: 'clone',
    make: (api) => {
      const [a] = operands(api);
      return () => {
        const x = api.clone(a);
        api.addMany(x, data.batch);
        return x;
      };
    },
  });
  for (const op of ['and', 'or']) {
    add({
      name: `${op}Cardinality`,
      method: `${op}Cardinality`,
      group: 'count',
      make: (api) => {
        const [a, b] = operands(api);
        return () => api.count(op, a, b);
      },
    });
  }
  add({
    name: 'isSubset',
    method: 'isSubset',
    group: 'compare',
    who: NATIVE_OURS,
    make: (api) => {
      const [a, b] = operands(api);
      const inside = api.combine('and', a, b);
      return () => api.subset(inside, a);
    },
  });
  add({
    name: 'isEqual',
    method: 'isEqual',
    group: 'compare',
    who: NATIVE_OURS,
    make: (api) => {
      const [a] = operands(api);
      const copy = api.clone(a);
      return () => api.equal(a, copy);
    },
  });
  // The stored pair shares containers, so this answers `true` at the first shared one: the early-exit case.
  add({
    name: 'intersects overlapping',
    method: 'intersects',
    group: 'count',
    who: NATIVE_OURS,
    make: (api) => {
      const [a, b] = operands(api);
      return () => api.intersects(a, b);
    },
  });
  // The second operand without the first's ids shares every container key with it and no id: the answer is `false`,
  // and the call cannot end before it has walked every key.
  add({
    name: 'intersects disjoint',
    method: 'intersects',
    group: 'count',
    who: NATIVE_OURS,
    make: (api) => {
      const [a, b] = operands(api);
      const apart = api.combine('andNot', b, a);
      return () => api.intersects(a, apart);
    },
  });
  // The first operand's next write after a combine that returns a new bitmap. A returning `or`, `xor` or `andNot`
  // flags the containers of `a` it keeps by reference, so the next write to one copies it once; the internal subject
  // has no combine here, which makes its figure the same write on a bitmap nothing has flagged. Each repetition decodes
  // a fresh `a` (the flag is never cleared) and times only the write.
  for (const op of ['or', 'xor', 'andNot']) {
    add({
      name: `write after ${op}`,
      method: `RoaringBitmap.${op}`,
      group: 'write after combine',
      custom: (api) => {
        const b = api.deserialize(data.bytesB);
        const answers = [];
        const wall = [];
        const cpu = [];
        for (let rep = 0; rep < 3 + CUSTOM_REPS; rep++) {
          const a = api.deserialize(data.bytesA);
          if (api.name !== 'internal') api.combine(op, a, b);
          collect();
          const c0 = cpuNs();
          const t0 = nowNs();
          api.addMany(a, data.batch);
          const dt = nowNs() - t0;
          const dc = cpuNs() - c0;
          if (rep >= 3) {
            wall.push(dt);
            cpu.push(dc);
          }
          answers[0] = a;
        }
        return { ns: medianOf(wall), cpuNs: medianOf(cpu), answer: digest(api, answers[0]) };
      },
    });
  }
  return cells;
}

/**
 * Every cell the full run takes, as a list, so that a record can be checked against it: the steady cells (each with
 * whether the codec has a counterpart, `internal`), the cold cells and the data sets of the load part. One source: the
 * bench takes these cells and the gate asks a pass for exactly these.
 */
function inventory() {
  const steady = cellsOf({ some: [], small: true }).map((c) => ({
    op: c.name,
    method: c.method,
    group: c.group,
    internal: c.who.includes('internal') && !/^xor in place$/.test(c.name),
  }));
  const cold = coldCellsOf({ small: true }).map((c) => ({
    op: c.name,
    method: c.method,
    group: c.group,
    internal: c.who.includes('internal'),
  }));
  return { datasets: DATASETS.slice(), steady, cold, load: DATASETS.slice() };
}

/** The cold cells: the first call of a fresh process, nothing warmed, on the `mixed` data set. */
function coldCellsOf(data) {
  const operands = (api) => [api.deserialize(data.bytesA), api.deserialize(data.bytesB)];
  return [
    {
      name: 'first deserialize',
      method: 'RoaringBitmap.deserialize',
      group: 'cold',
      who: ALL,
      make: (api) => () => api.deserialize(data.bytesA),
    },
    {
      name: 'first build',
      method: 'new RoaringBitmap(array)',
      group: 'cold',
      who: ALL,
      make: (api) => () => api.from(data.ids),
    },
    {
      name: 'first and',
      method: 'RoaringBitmap.and',
      group: 'cold',
      who: ALL,
      make: (api) => {
        const [a, b] = operands(api);
        return () => api.combine('and', a, b);
      },
    },
  ];
}

/** Whether a cell runs on a subject: it lists it, and the subject has what the cell calls. */
function runsOn(cell, api) {
  if (!cell.who.includes(api.name)) return false;
  if (api.name === 'internal' && /^xor in place$/.test(cell.name)) return false;
  return true;
}

/** Times one steady cell on one subject: `{ ns, cpuNs, answer }`. */
function timeCell(cell, api, { warmMs, sampleMs }) {
  if (cell.custom !== undefined) return cell.custom(api);
  const fn = cell.make(api);
  const answer = digest(api, fn());
  collect();
  const timed = measureSteadyCpu(fn, cell.unit, { warmMs, sampleMs });
  return { ns: +timed.ns.toFixed(1), cpuNs: +timed.cpuNs.toFixed(1), answer };
}

/** Times one cold cell on one subject, once. */
function timeCold(cell, api) {
  const fn = cell.make(api);
  const timed = measureColdCpu(fn);
  return { ns: timed.ns, cpuNs: +timed.cpuNs.toFixed(0), answer: digest(api, fn()) };
}

module.exports = {
  CAP,
  DATASETS,
  SUBJECTS,
  COLD_DATASET,
  SCALE,
  TINY,
  nativeApi,
  oursApi,
  internalApi,
  digest,
  dataOf,
  storedBytesOf,
  bytesToJson,
  bytesFromJson,
  cellsOf,
  coldCellsOf,
  inventory,
  runsOn,
  timeCell,
  timeCold,
};
