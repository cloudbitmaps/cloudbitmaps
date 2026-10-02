'use strict';
/*
 * The calibration run's stages, and what each is allowed to cost.
 *
 * One table names every stage the harness runs and one function bounds each stage's requests, so the pre-flight
 * projection, the run's end-of-run check and the tests all read the same list. A stage the harness runs that is not
 * in the table fails its test, and so does a name in the table the harness never runs: a stage nobody projected
 * would spend money the ceiling never saw.
 *
 * Two quantities per stage, kept apart:
 *   the BOUND     the most requests the stage can make, losing races and all: what the ceiling is checked against
 *                 before anything is created, and what the finished run is held to.
 *   the EXPECTED  the exact requests the engine makes when nothing races it, from the layout alone: what a rehearsal
 *                 and a real run are compared against. A real run that differs has found something.
 * Every figure here comes from a request count a test pins: tests/bench/calibrate-guards.test.ts counts a load's,
 * tests/bench/calibrate-stages.test.ts counts each read stage's against the real engine, and a rehearsal against
 * MinIO counts the whole harness on S3's request shape.
 */
const { projectOps } = require('./calibrate-guards.cjs');

/** Every stage, in the order the harness runs them. */
const STAGES = Object.freeze([
  'load',
  'intersect',
  'spread',
  'sweep',
  'warm',
  'pointReads',
  'andNot',
]);

/**
 * How many shared chunks the engine keeps in flight at once, `DEFAULT_INTERSECT_CONCURRENCY` in the engine, each read
 * from both operands: so 2 x this many requests are in flight, and a cold intersect is expected to be this many
 * requests deep per window of chunks. A test reads the number out of the engine's source.
 */
const ENGINE_WINDOW = 8;

/** The depth the engine is expected to make a cold intersect of `k` shared chunks: a pointer, a tail, then windows. */
const modelRounds = (k) => 2 + Math.ceil(k / ENGINE_WINDOW);

/** The sweep over how many chunks two segments share, when none is asked for: k and how many intersects at each. */
const DEFAULT_SWEEP = Object.freeze([
  Object.freeze({ k: 1_000, intersects: 10 }),
  Object.freeze({ k: 2_000, intersects: 5 }),
]);

/**
 * Parse `CR_CALIBRATE_SWEEP`: `1000:10,2000:5` is ten intersects at a thousand shared chunks and five at two
 * thousand. Unset or empty is the default; `none` is no sweep. Anything else malformed is refused, since a sweep that
 * silently dropped an entry would measure less than it says.
 */
function parseSweep(raw) {
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SWEEP.map((e) => ({ ...e }));
  if (String(raw).trim() === 'none') return [];
  const seen = new Set();
  return String(raw)
    .split(',')
    .map((entry) => {
      const m = /^\s*(\d+):(\d+)\s*$/.exec(entry);
      const k = m === null ? 0 : Number(m[1]);
      const intersects = m === null ? 0 : Number(m[2]);
      if (
        !Number.isSafeInteger(k) ||
        k < 1 ||
        !Number.isSafeInteger(intersects) ||
        intersects < 1
      ) {
        throw new Error(
          `CR_CALIBRATE_SWEEP entry "${entry.trim()}" is not <shared chunks>:<intersects>, both positive integers, ` +
            'such as 1000:10 (or the whole value `none`)',
        );
      }
      if (seen.has(k)) throw new Error(`CR_CALIBRATE_SWEEP names ${k} shared chunks twice`);
      seen.add(k);
      return { k, intersects };
    });
}

/**
 * A cold intersect of two operands that share `k` chunks: each operand's pointer, its tail read, and `k` chunk reads.
 * The expected count is exact while each index fits the tail read.
 */
const coldIntersectGets = (k) => 4 + 2 * k;
/** The same, bounded: a third GET an operand for an index longer than the tail read. */
const coldIntersectBound = (k) => 2 * (3 + k);

/**
 * The most each stage can request, from the workload `w`, and the total with the run's fixed requests.
 *
 *   w.loads            { segments, largeSegments, partsBound }       the load stage
 *   w.intersect        { reads, sharedChunks }                       cold intersects, calibration layout
 *   w.spread           { segments, reads, sharedChunks }             cold intersects, spread layout
 *   w.sweep            { segments, entries: [{ k, intersects }] }    each entry has `segments` loaded of its own
 *   w.warm             { segments, sharedChunks }                    one priming pass over `segments` segments
 *   w.pointReads       { segments, sharedChunks }                    `count()`, then `has()` per chunk, open and first read
 *   w.andNot           { calls, excludes, includeChunks, sharedChunks }
 *   w.discards         { perRun, perStage }                          the samples a run may discard (`calibrate-samples.cjs`)
 *   w.retryBound, w.fixedPuts, w.fixedGets
 *
 * Beside the stages, `discards`: what the samples a run may discard can cost, each at the bound of the most expensive
 * sample the run makes. A discarded sample was billed, and a stage's bound is for the samples it keeps, so without this
 * a run that discarded a sample could spend past a projection that said it was safe.
 */
function projectStages(w) {
  const retryBound = w.retryBound;
  const loads = (segments, large = 0, parts = 0) =>
    projectOps({
      loads: segments,
      largeLoads: large,
      partsPerLargeLoad: parts,
      reads: 0,
      chunksPerRead: 0,
      retryBound,
    });
  const add = (a, b) => ({ put: a.put + b.put, get: a.get + b.get });
  const stages = {};

  stages.load = loads(w.loads.segments, w.loads.largeSegments, w.loads.partsBound);

  const reads = (n, k) => ({ put: 0, get: n * coldIntersectBound(k) });
  stages.intersect = reads(w.intersect.reads, w.intersect.sharedChunks);

  stages.spread = add(loads(w.spread.segments), reads(w.spread.reads, w.spread.sharedChunks));

  stages.sweep = w.sweep.entries.reduce(
    (acc, e) => add(add(acc, loads(w.sweep.segments)), reads(e.intersects, e.k)),
    { put: 0, get: 0 },
  );

  // The priming pass reads each segment once, cold; the timed intersects after it are held to none.
  stages.warm = {
    put: 0,
    get: w.warm.segments * (3 + w.warm.sharedChunks),
  };

  // A `count()` opening each segment (a pointer, a tail, one more for an index longer than the tail), a `has()` of every
  // shared chunk on those open segments (one chunk read each), and a `has()` of every shared chunk as the first read of
  // a store of its own (a pointer, a tail, a chunk, and the one more). The warm repeats are held to none.
  const sc = w.pointReads.segments * w.pointReads.sharedChunks;
  stages.pointReads = { put: 0, get: 3 * w.pointReads.segments + 5 * sc };

  stages.andNot = { put: 0, get: w.andNot.calls * andNotCallBound(w.andNot) };

  const perRun = w.discards?.perRun;
  if (!Number.isInteger(perRun) || perRun < 0) {
    throw new Error(`discards.perRun must be a non-negative integer, got ${perRun}`);
  }
  const costliestSample = Math.max(...Object.values(sampleBounds(w)));
  const discards = { put: 0, get: perRun * costliestSample };

  const put = Object.values(stages).reduce((n, s) => n + s.put, 0) + w.fixedPuts + discards.put;
  const getSum = Object.values(stages).reduce((n, s) => n + s.get, 0) + w.fixedGets + discards.get;
  // Reads are projected at least as high as writes, as `projectOps` does: every write path reads before it writes.
  return { stages, discards, costliestSample, total: { put, get: Math.max(getSum, put) } };
}

/** One `andNot` call: every operand opened, every chunk of the include operand read, each exclude where it overlaps. */
const andNotCallBound = (a) => (1 + a.excludes) * 3 + a.includeChunks + a.excludes * a.sharedChunks;

/**
 * The most one sample of each stage can request, from the workload `w`: what a sample discarded after a transient fault
 * can have cost. A sample that fails stops before it finishes, so it requests no more than one that finishes; the
 * chunk reads it still has in flight when it fails are among the ones a finished sample makes. Loads are not samples
 * (`calibrate-samples.cjs` says why), and a stage that runs no sample has none.
 */
function sampleBounds(w) {
  const cold = (reads, k) => (reads > 0 ? coldIntersectBound(k) : 0);
  const p = w.pointReads;
  return {
    load: 0,
    intersect: cold(w.intersect.reads, w.intersect.sharedChunks),
    spread: cold(w.spread.reads, w.spread.sharedChunks),
    sweep: Math.max(0, ...w.sweep.entries.map((e) => coldIntersectBound(e.k))),
    // The priming pass is one sample: a fault anywhere in it runs the whole pass again, on a fresh store.
    warm: w.warm.segments * (3 + w.warm.sharedChunks),
    // A first has() is the dearest: a pointer, a tail, one more for an index longer than the tail, and a chunk. A first
    // count() is the first three, and a has() on an open segment is the chunk alone.
    pointReads: p.segments === 0 ? 0 : p.sharedChunks > 0 ? 4 : 3,
    andNot: w.andNot.calls > 0 ? andNotCallBound(w.andNot) : 0,
  };
}

/**
 * The exact GET-class requests each read stage makes when nothing races it and each index fits the tail read. The
 * load stage is not here: its requests depend on the object's size (the parts of a multipart upload), so a run
 * records them per load.
 */
function expectedReads(w) {
  const a = w.andNot;
  return {
    intersect: w.intersect.reads * coldIntersectGets(w.intersect.sharedChunks),
    spread: w.spread.reads * coldIntersectGets(w.spread.sharedChunks),
    sweep: w.sweep.entries.reduce((n, e) => n + e.intersects * coldIntersectGets(e.k), 0),
    // Each segment once: a pointer, a tail and the shared chunks. The timed warm intersects make none.
    warm: w.warm.segments * (2 + w.warm.sharedChunks),
    // `count()` opens a segment: a pointer and a tail. A `has()` on an open segment is one chunk read, and the first
    // `has()` on a store of its own is a pointer, a tail and a chunk.
    pointReads: 2 * w.pointReads.segments + 4 * w.pointReads.segments * w.pointReads.sharedChunks,
    andNot: a.calls * (2 * (1 + a.excludes) + a.includeChunks + a.excludes * a.sharedChunks),
  };
}

/**
 * What one `store.load()` of a segment's first generation bills, counted by a test against the real registry
 * protocol: the object and the pointer are PUT-class, and the load lists nothing, since there is no generation yet
 * for its collection to take; the pointer is read three times (it found no row, so it reads again after its ids, and
 * the create reads once more) and the generation number checked once, a HeadObject. A multipart object is a create,
 * its parts and a complete in place of the single PUT.
 */
const FIRST_LOAD = Object.freeze({ put: 2, get: 4 });
const firstLoadRequests = (parts) =>
  parts === 0 ? { ...FIRST_LOAD } : { put: FIRST_LOAD.put + 1 + parts, get: FIRST_LOAD.get };

module.exports = {
  STAGES,
  ENGINE_WINDOW,
  modelRounds,
  DEFAULT_SWEEP,
  parseSweep,
  coldIntersectGets,
  coldIntersectBound,
  projectStages,
  sampleBounds,
  expectedReads,
  FIRST_LOAD,
  firstLoadRequests,
};
