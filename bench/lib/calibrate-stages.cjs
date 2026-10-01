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
const STAGES = Object.freeze(['load', 'intersect', 'spread', 'sweep']);

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
 *   w.retryBound, w.fixedPuts, w.fixedGets
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

  const put = Object.values(stages).reduce((n, s) => n + s.put, 0) + w.fixedPuts;
  const getSum = Object.values(stages).reduce((n, s) => n + s.get, 0) + w.fixedGets;
  // Reads are projected at least as high as writes, as `projectOps` does: every write path reads before it writes.
  return { stages, total: { put, get: Math.max(getSum, put) } };
}

/**
 * The exact GET-class requests each read stage makes when nothing races it and each index fits the tail read. The
 * load stage is not here: its requests depend on the object's size (the parts of a multipart upload), so a run
 * records them per load.
 */
function expectedReads(w) {
  return {
    intersect: w.intersect.reads * coldIntersectGets(w.intersect.sharedChunks),
    spread: w.spread.reads * coldIntersectGets(w.spread.sharedChunks),
    sweep: w.sweep.entries.reduce((n, e) => n + e.intersects * coldIntersectGets(e.k), 0),
  };
}

/**
 * What one `store.load()` of a segment's first generation bills, counted by a test against the real registry
 * protocol: the object, two listings and the pointer are PUT-class, the pointer is read seven times. A multipart
 * object is a create, its parts and a complete in place of the single PUT.
 */
const FIRST_LOAD = Object.freeze({ put: 4, get: 7 });
const firstLoadRequests = (parts) =>
  parts === 0 ? { ...FIRST_LOAD } : { put: FIRST_LOAD.put + 1 + parts, get: FIRST_LOAD.get };

module.exports = {
  STAGES,
  DEFAULT_SWEEP,
  parseSweep,
  coldIntersectGets,
  coldIntersectBound,
  projectStages,
  expectedReads,
  FIRST_LOAD,
  firstLoadRequests,
};
