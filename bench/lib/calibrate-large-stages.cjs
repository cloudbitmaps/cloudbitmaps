'use strict';
/*
 * The large suite: combines on operands of about 10^6, 5 x 10^6 and 10^7 ids, and what each stage is allowed to cost.
 *
 * It is a separate suite (`--suite large`) with its own table of stages, its own bound and its own expected counts, so
 * the default suite's stages, projection and evidence are untouched. It follows the default suite's design, the BOUND
 * and the EXPECTED kept apart (`calibrate-stages.cjs` says what each is):
 *
 *   the BOUND     the most requests a stage can make, checked against the ceiling before anything is created.
 *   the EXPECTED  the exact requests the engine makes when nothing races it, counted by running the engine over the
 *                 in-memory backend on the same layouts (`large-counts.cjs`). The operands' loads are a first load's
 *                 requests on S3's shape; an `*Into` is the in-memory count as it stands, since publishing a
 *                 materialised result makes no check of its generation number.
 *
 * What each size is: two operand segments of about 1,500 chunks, 20 % of their ids shared, laid out by `planLayout` at
 * the stride that gives that many chunks. Each is loaded once through `store.load()`; then, per size, `R` uncached
 * intersects, unions and andNots, and `I` of each `*Into` verb onto a destination of its own.
 *
 * What it does not measure: one storage class in one region, bitset-only and array-only containers (no runs), cold
 * reads on fresh stores, one client, one task. Latencies from different CloudShell sessions are not comparable.
 */
const { planLayout, projectOps, CHUNK_SPAN } = require('./calibrate-guards.cjs');
const { firstLoadRequests } = require('./calibrate-stages.cjs');

/** Every stage of the large suite, in the order the harness runs them. */
const LARGE_STAGES = Object.freeze([
  'largeLoad',
  'largeIntersect',
  'largeUnion',
  'largeAndNot',
  'largeInto',
]);

/** The ids an operand segment holds, from the shapes the suite measures. */
const LARGE_SIZES = Object.freeze([1_000_000, 5_000_000, 10_000_000]);
/** The chunks an operand spans, about: the stride is chosen to give this many, whatever the ids. */
const LARGE_CHUNKS = 1_500;
/** The share of an operand's ids the two operands have in common. */
const LARGE_OVERLAP = 0.2;
/** The default number of uncached reads of each kind per size, and of each `*Into` per size. */
const DEFAULT_LARGE_READS = 40;
const DEFAULT_LARGE_INTOS = 5;

/**
 * The stride, in ids, that spreads `n` ids over about {@link LARGE_CHUNKS} chunks: 98, 19 and 9 for the three sizes.
 */
const largeStride = (n) => Math.floor((LARGE_CHUNKS * CHUNK_SPAN) / n);

/** The layout of the two operands of size `n`. */
function planLargeLayout(n) {
  return planLayout({
    segments: 2,
    idsPerSegment: n,
    overlap: LARGE_OVERLAP,
    stride: largeStride(n),
  });
}

/**
 * The exact content of each read, from the layout: the ids of operand 0 and 1 are `shared` common ids and `priv` of
 * their own each. Checked to stay under 2^53, as the layout checks its own sums, since a sum past it would not be exact.
 */
function largeExpectedContent(layout) {
  const own0 = layout.ownSums[0];
  const own1 = layout.ownSums[1];
  const unionSum = layout.expected.sum + own0 + own1;
  if (!Number.isSafeInteger(unionSum)) {
    throw new Error(
      'the expected union sum exceeds 2^53 — the exact-content check would be unsound',
    );
  }
  return {
    intersect: layout.expected,
    union: { count: layout.shared + 2 * layout.priv, sum: unionSum },
    andNot: { count: layout.priv, sum: own0 },
  };
}

/*
 * The S3 driver's multipart rule, and the engine's range-coalescing rule.
 *
 * Both are literal copies: the harness runs where the library's source is not, and neither is exported from a package.
 * `tests/bench/calibrate-large.test.ts` reads each out of the source and fails if a copy has drifted.
 */
/** The S3 driver's part size: an object under this many bytes is one PUT, one of this many or more a multipart upload. */
const PART_BYTES = 8 * 1024 * 1024;
/** The most unneeded bytes the engine reads between two needed chunks of one range request. */
const MAX_COALESCE_GAP_BYTES = 256 * 1024;
/** The most bytes the engine makes one range request span, unless it holds a single chunk. */
const MAX_COALESCED_READ_BYTES = 1024 * 1024;
/**
 * The most bytes one stored chunk can take in this suite: a bitset container is 8 KiB, and a chunk's header and
 * checksum are a few bytes beside it. The range bound below needs a chunk to be small beside the gap.
 */
const MAX_CHUNK_BYTES = 8 * 1024 + 64;

/** How many parts a multipart upload of `bytes` bytes makes; 0 for an object that is one PUT. */
const partsOf = (bytes) => (bytes >= PART_BYTES ? Math.ceil(bytes / PART_BYTES) : 0);

/**
 * The most range requests one read of an object of `bytes` bytes makes, however its needed chunks are laid out.
 *
 * Two neighbouring range requests either have more than the gap between them, or would together span more than the
 * read cap: and a chunk is far smaller than the difference between the two, so in both cases the second starts more
 * than the gap after the first. `n` requests start more than `n - 1` gaps apart within the object, so
 * `n <= ceil(bytes / gap)`; one more is allowed for the footer's own read. A property test holds the engine to it
 * over random layouts, and to a tightened copy of it failing.
 */
const rangeCap = (bytes) => Math.ceil(bytes / MAX_COALESCE_GAP_BYTES) + 1;

/**
 * One cold read of an operand pair at the worst: a pointer, a tail, one more for an index longer than the tail, and a
 * request for each chunk-range the engine can make, which is no more than the chunks it needs or the range cap.
 */
const operandBound = (chunks, cap) => 3 + Math.min(chunks, cap);

/** The most GET-class requests one cold read of each verb makes, of operands of `bytes` bytes. */
function readBounds(size) {
  const bytes = Math.max(...size.operandBytes);
  const cap = rangeCap(bytes);
  const chunks = size.chunksPerSegment;
  const shared = size.sharedChunks;
  return {
    // Each operand's index, and the ranges of the shared chunks of each.
    intersect: 2 * operandBound(shared, cap),
    // Every chunk of both operands.
    union: 2 * operandBound(chunks, cap),
    // The include's every chunk, and the exclude's where it overlaps.
    andNot: operandBound(chunks, cap) + operandBound(shared, cap),
  };
}

/** The most bytes the output of each `*Into` can take: a union holds at most both operands' chunks. */
function outputBounds(size) {
  const bytes = Math.max(...size.operandBytes);
  // A fixed allowance covers the object's index and footer.
  const slack = 64 * 1024;
  return {
    intersectInto: bytes + slack,
    unionInto: 2 * bytes + slack,
    andNotInto: bytes + slack,
  };
}

/** The verb each `*Into` reads with. */
const INTO_READS = Object.freeze({
  intersectInto: 'intersect',
  unionInto: 'union',
  andNotInto: 'andNot',
});

/**
 * The most a load of a segment can request, of an object of at most `bytes` bytes: the default suite's bound for a
 * load, `projectOps`, with the parts the object can need.
 */
function loadBound(bytes, retryBound) {
  const parts = partsOf(bytes);
  return projectOps({
    loads: parts === 0 ? 1 : 0,
    largeLoads: parts === 0 ? 0 : 1,
    // One part more than the size needs, as the default suite allows for its large segments.
    partsPerLargeLoad: parts === 0 ? 0 : parts + 1,
    reads: 0,
    chunksPerRead: 0,
    retryBound,
  });
}

/**
 * The most each stage can request, from the workload `w`, and the total with the run's fixed requests.
 *
 *   w.sizes      [{ n, chunksPerSegment, sharedChunks, operandBytes: [a, b] }]
 *   w.reads      uncached reads of each kind per size
 *   w.intos      each `*Into` per size
 *   w.discards   { perRun, perStage }: the samples a run may discard (`calibrate-samples.cjs`)
 *   w.retryBound, w.fixedPuts, w.fixedGets
 *
 * `discards` is what the samples a run may discard can cost, each at the costliest sample's bound, as the default
 * suite's is.
 */
function projectLarge(w) {
  const add = (a, b) => ({ put: a.put + b.put, get: a.get + b.get });
  const none = { put: 0, get: 0 };
  const stages = Object.fromEntries(LARGE_STAGES.map((name) => [name, { ...none }]));
  let costliest = 0;
  // The PUT-class requests the costliest `*Into` sample can have sent when a fault discards it part-way: the load of its
  // output, a create, its parts and a complete, or the pointer's write.
  let costliestPut = 0;
  for (const size of w.sizes) {
    for (const bytes of size.operandBytes) {
      stages.largeLoad = add(stages.largeLoad, loadBound(bytes, w.retryBound));
    }
    const reads = readBounds(size);
    for (const [verb, gets] of Object.entries({
      largeIntersect: reads.intersect,
      largeUnion: reads.union,
      largeAndNot: reads.andNot,
    })) {
      if (w.reads > 0) {
        stages[verb] = add(stages[verb], { put: 0, get: w.reads * gets });
        costliest = Math.max(costliest, gets);
      }
    }
    if (w.intos > 0) {
      const out = outputBounds(size);
      for (const [verb, read] of Object.entries(INTO_READS)) {
        const load = loadBound(out[verb], w.retryBound);
        const call = { put: load.put, get: load.get + reads[read] };
        stages.largeInto = add(stages.largeInto, {
          put: w.intos * call.put,
          get: w.intos * call.get,
        });
        costliest = Math.max(costliest, call.get);
        costliestPut = Math.max(costliestPut, call.put);
      }
    }
  }
  const perRun = w.discards?.perRun;
  if (!Number.isInteger(perRun) || perRun < 0) {
    throw new Error(`discards.perRun must be a non-negative integer, got ${perRun}`);
  }
  const discards = { put: perRun * costliestPut, get: perRun * costliest };
  const put = Object.values(stages).reduce((n, s) => n + s.put, 0) + w.fixedPuts + discards.put;
  const getSum = Object.values(stages).reduce((n, s) => n + s.get, 0) + w.fixedGets + discards.get;
  // Reads are projected at least as high as writes, as the default suite does: every write path reads before it writes.
  return {
    stages,
    discards,
    costliestSample: costliest,
    total: { put, get: Math.max(getSum, put) },
  };
}

/**
 * The exact requests each stage makes when nothing races it, from the counts the engine made on the same layouts:
 * `w.sizes[i].counts` is `countSize`'s answer. Each is `{ put, get }`.
 */
function expectedLarge(w) {
  const none = () => ({ put: 0, get: 0 });
  const stages = Object.fromEntries(LARGE_STAGES.map((name) => [name, none()]));
  for (const size of w.sizes) {
    const c = size.counts;
    for (const bytes of c.operandBytes) {
      const r = firstLoadRequests(partsOf(bytes));
      stages.largeLoad.put += r.put;
      stages.largeLoad.get += r.get;
    }
    stages.largeIntersect.get += w.reads * c.reads.intersect.gets;
    stages.largeUnion.get += w.reads * c.reads.union.gets;
    stages.largeAndNot.get += w.reads * c.reads.andNot.gets;
    for (const calls of Object.values(c.into)) {
      for (const call of calls.slice(0, w.intos)) {
        stages.largeInto.put += call.put;
        stages.largeInto.get += call.get;
      }
    }
  }
  return stages;
}

/**
 * Parse the large suite's two knobs: `CR_CALIBRATE_LARGE_READS` (uncached reads of each kind per size) and
 * `CR_CALIBRATE_LARGE_INTOS` (each `*Into` per size). A non-negative integer; unset or empty is the default.
 */
function resolveLargeKnobs(env) {
  const one = (raw, fallback, label) => {
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`${label} is "${raw}"; expected a non-negative integer`);
    }
    return n;
  };
  return {
    reads: one(env.CR_CALIBRATE_LARGE_READS, DEFAULT_LARGE_READS, 'CR_CALIBRATE_LARGE_READS'),
    intos: one(env.CR_CALIBRATE_LARGE_INTOS, DEFAULT_LARGE_INTOS, 'CR_CALIBRATE_LARGE_INTOS'),
  };
}

/**
 * Which suite a run is: `--suite large` or `CR_CALIBRATE_SUITE=large`, and the default suite otherwise. Both naming
 * different suites, or a suite that does not exist, is refused, since a run that measured another suite than the one
 * asked for would write evidence under the wrong name.
 */
function resolveSuite(argv, env) {
  return suiteFrom(argv, env).suite;
}

/** Which suite a run is and where it was named: `{ suite, source }`, the source `--suite`, `CR_CALIBRATE_SUITE` or `default`. */
function suiteFrom(argv, env) {
  const SUITES = ['default', 'large'];
  const at = argv.indexOf('--suite');
  let fromArg;
  if (at !== -1) {
    fromArg = argv[at + 1];
    if (fromArg === undefined || fromArg.startsWith('--')) {
      throw new Error(`--suite needs a name: one of ${SUITES.join(', ')}`);
    }
  }
  const raw = env.CR_CALIBRATE_SUITE;
  const fromEnv = raw === undefined || String(raw).trim() === '' ? undefined : String(raw).trim();
  for (const [where, name] of [
    ['--suite', fromArg],
    ['CR_CALIBRATE_SUITE', fromEnv],
  ]) {
    if (name !== undefined && !SUITES.includes(name)) {
      throw new Error(`${where} is "${name}"; the suites are ${SUITES.join(', ')}`);
    }
  }
  if (fromArg !== undefined && fromEnv !== undefined && fromArg !== fromEnv) {
    throw new Error(`--suite ${fromArg} and CR_CALIBRATE_SUITE=${fromEnv} name different suites`);
  }
  if (fromArg !== undefined) return { suite: fromArg, source: '--suite' };
  if (fromEnv !== undefined) return { suite: fromEnv, source: 'CR_CALIBRATE_SUITE' };
  return { suite: 'default', source: 'default' };
}

/**
 * The default suite's workload settings, which the large suite does not read. Setting one under `--suite large` is
 * refused: a run that ignored it would measure something other than the setting says.
 */
const DEFAULT_SUITE_KNOBS = Object.freeze([
  'CR_CALIBRATE_SEGMENTS',
  'CR_CALIBRATE_IDS',
  'CR_CALIBRATE_READS',
  'CR_CALIBRATE_SPREAD_SEGMENTS',
  'CR_CALIBRATE_SPREAD_READS',
  'CR_CALIBRATE_SWEEP',
  'CR_CALIBRATE_SWEEP_SEGMENTS',
  'CR_CALIBRATE_POINT_SEGMENTS',
  'CR_CALIBRATE_ANDNOT_CALLS',
  'CR_CALIBRATE_ANDNOT_EXCLUDES',
  'CR_CALIBRATE_LARGE',
]);

/** Refuse a default-suite setting made for a large-suite run. */
function refuseDefaultKnobs(env) {
  const set = DEFAULT_SUITE_KNOBS.filter(
    (k) => env[k] !== undefined && String(env[k]).trim() !== '',
  );
  if (set.length > 0) {
    throw new Error(
      `${set.join(', ')} set the default suite's workload, which --suite large does not read; unset ` +
        `${set.length === 1 ? 'it' : 'them'}, or set CR_CALIBRATE_LARGE_READS and CR_CALIBRATE_LARGE_INTOS`,
    );
  }
}

/**
 * Refuse a workload that teardown could not remove: every object version the suite leaves must fit the first listing
 * teardown reads (a page of 1,000). Each operand leaves a generation and its pointer's version, and each `*Into`
 * destination leaves a generation and a pointer version for every call, since the destination keeps every generation.
 * A third version a call is counted for a delete marker, which a versioned bucket keeps for an object a collection
 * removes, so the count holds whatever window a destination is kept at.
 */
function checkLargeWorkload({ sizes, intos }) {
  const versions = sizes * 2 * 2 + sizes * 3 * intos * 3;
  if (versions > 900) {
    throw new Error(
      `the large suite would leave about ${versions} object versions, more than teardown's first listing of 1,000 ` +
        'reaches; lower CR_CALIBRATE_LARGE_INTOS',
    );
  }
}

/**
 * The count a stage's kept requests are held to, in both classes: `kept` and `expected` are `{ put, get }`. Returns one
 * entry for each class that differs, `{ class, kept, expected }`, and none for a stage that made exactly the requests the
 * engine is expected to.
 */
function countMisses(kept, expected) {
  const out = [];
  for (const [name, key] of [
    ['PUT-class', 'put'],
    ['GET-class', 'get'],
  ]) {
    if (kept[key] !== expected[key])
      out.push({ class: name, kept: kept[key], expected: expected[key] });
  }
  return out;
}

/**
 * Hold a large stage to its counts and say so: each class that differs is recorded in `results.expectedMissed` and
 * reported through `report`. Returns the misses, so a caller can count them.
 */
function recordCountMisses(results, name, kept, expected, report) {
  const misses = countMisses(kept, expected);
  for (const m of misses) {
    (results.expectedMissed ??= []).push(
      `${name}: ${m.kept} ${m.class} kept, expected ${m.expected}`,
    );
    report(
      `calibrate: EXPECTED COUNT MISSED — ${name}'s kept samples made ${m.kept} ${m.class} requests, ` +
        `the engine is expected to make ${m.expected}`,
    );
  }
  return misses;
}

/**
 * What an installed engine's source says of the constants the suite keeps copies of: the coalescing gap, the read cap
 * and the S3 part size, read out of the text of `@cloudbitmaps/core`'s and `@cloudbitmaps/s3`'s own entry files (or of
 * the TypeScript they are built from). A constant not found, or not a plain arithmetic expression, is `null`.
 */
function constantsIn(coreText, s3Text) {
  const find = (text, name) => {
    const m = new RegExp(`(?:var|const|let) ${name}\\d*(?:: number)? = ([^;]+);`).exec(text);
    return m === null ? null : m[1].trim();
  };
  const evaluate = (expr, text) => {
    if (expr === null) return null;
    // A name stands for another constant of the same file: the read cap is the decode cap.
    const named = /^[A-Za-z_]\w*$/.test(expr) ? evaluate(find(text, expr), text) : expr;
    if (typeof named === 'number') return named;
    if (named === null || !/^[\d\s*+()<]+$/.test(named)) return null;
    const n = Function(`"use strict"; return (${named});`)();
    return Number.isFinite(n) ? n : null;
  };
  return {
    MAX_COALESCE_GAP_BYTES: evaluate(find(coreText, 'MAX_COALESCE_GAP_BYTES'), coreText),
    MAX_COALESCED_READ_BYTES: evaluate(find(coreText, 'MAX_COALESCED_READ_BYTES'), coreText),
    PART_BYTES: evaluate(find(s3Text, 'S3_PART_BYTES'), s3Text),
  };
}

/**
 * Refuse to run the large suite against an engine whose constants are not the ones this suite's bound was derived with.
 * A run from CloudShell measures the published packages, which may be another release than this clone's source, and
 * a different gap, read cap or part size would make the pre-flight bound wrong; one that cannot be read is refused too.
 */
function checkEngineConstants(found) {
  const copies = {
    MAX_COALESCE_GAP_BYTES,
    MAX_COALESCED_READ_BYTES,
    PART_BYTES,
  };
  const wrong = Object.entries(copies).filter(([name, value]) => found[name] !== value);
  if (wrong.length > 0) {
    throw new Error(
      `the installed engine's ${wrong
        .map(
          ([name]) =>
            `${name} is ${found[name] === null || found[name] === undefined ? 'unreadable' : found[name]}`,
        )
        .join(', ')}, where the large suite's bound was derived with ${wrong
        .map(([, value]) => value)
        .join(
          ', ',
        )}; a release with other constants would bound a read wrongly. Measure a release whose constants ` +
        'these are, or run the default suite',
    );
  }
}

/**
 * The memory and disk the suite needs to start, in MiB. The harness holds no operand on disk and streams ids from a
 * generator into the load; the 10^7-id load peaked at 336 MB resident with its input array alive, which the suite
 * does not build (measured on a laptop). The floors are that figure with room, and the disk's is what the install of
 * the published packages and the SDK takes.
 */
const LARGE_MIN_MEMORY_MB = 768;
const LARGE_MIN_DISK_MB = 256;

/**
 * Refuse to start below the floors. `have` is `{ memoryMB, diskMB }`, each a number or `null` when the machine could not
 * say, which is refused too: a floor that cannot be read cannot be met. `floors` may only raise them.
 */
function checkResources(have, floors = {}) {
  const memory = Math.max(floors.memoryMB ?? 0, LARGE_MIN_MEMORY_MB);
  const disk = Math.max(floors.diskMB ?? 0, LARGE_MIN_DISK_MB);
  const problems = [];
  if (typeof have.memoryMB !== 'number' || !(have.memoryMB >= memory)) {
    problems.push(
      `${have.memoryMB === null ? 'unknown' : `${Math.floor(have.memoryMB)} MiB`} of memory available, the large suite ` +
        `needs ${memory} MiB`,
    );
  }
  if (typeof have.diskMB !== 'number' || !(have.diskMB >= disk)) {
    problems.push(
      `${have.diskMB === null ? 'unknown' : `${Math.floor(have.diskMB)} MiB`} of disk free in the home directory, the ` +
        `large suite needs ${disk} MiB`,
    );
  }
  if (problems.length > 0) throw new Error(`${problems.join('; ')} — refusing to start`);
  return { memory, disk };
}

/** Raise a floor from the environment: a positive number of MiB, refused below the built-in floor. */
function resolveFloors(env) {
  const one = (raw, minimum, label) => {
    if (raw === undefined || String(raw).trim() === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < minimum) {
      throw new Error(`${label} is "${raw}"; it may only raise the floor, which is ${minimum} MiB`);
    }
    return n;
  };
  return {
    memoryMB: one(
      env.CR_CALIBRATE_LARGE_MIN_MEMORY_MB,
      LARGE_MIN_MEMORY_MB,
      'CR_CALIBRATE_LARGE_MIN_MEMORY_MB',
    ),
    diskMB: one(
      env.CR_CALIBRATE_LARGE_MIN_DISK_MB,
      LARGE_MIN_DISK_MB,
      'CR_CALIBRATE_LARGE_MIN_DISK_MB',
    ),
  };
}

module.exports = {
  LARGE_STAGES,
  LARGE_SIZES,
  LARGE_CHUNKS,
  LARGE_OVERLAP,
  DEFAULT_LARGE_READS,
  DEFAULT_LARGE_INTOS,
  largeStride,
  planLargeLayout,
  largeExpectedContent,
  PART_BYTES,
  MAX_COALESCE_GAP_BYTES,
  MAX_COALESCED_READ_BYTES,
  MAX_CHUNK_BYTES,
  partsOf,
  rangeCap,
  INTO_READS,
  readBounds,
  outputBounds,
  loadBound,
  projectLarge,
  expectedLarge,
  resolveLargeKnobs,
  resolveSuite,
  suiteFrom,
  DEFAULT_SUITE_KNOBS,
  refuseDefaultKnobs,
  checkLargeWorkload,
  countMisses,
  recordCountMisses,
  constantsIn,
  checkEngineConstants,
  LARGE_MIN_MEMORY_MB,
  LARGE_MIN_DISK_MB,
  checkResources,
  resolveFloors,
};
