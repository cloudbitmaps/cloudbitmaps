'use strict';
/*
 * The batch suite: one refresh-shaped `store.materializeMany` call, and what each stage is allowed to cost.
 *
 * It is a suite of its own (`--suite batch`), with its own stages, bound, expected counts and evidence directory, so the
 * default suite's and the large suite's projections and evidence are untouched. It keeps their design, the BOUND and the
 * EXPECTED kept apart (`calibrate-stages.cjs` says what each is):
 *
 *   the EXPECTED  the exact requests the engine makes when nothing races it, counted by running the same call over the
 *                 in-memory backend on the same operands and outputs (`batch-counts.cjs`). The operands' loads are a
 *                 first load's requests on S3's shape.
 *   the BOUND     the most requests a stage can make, checked against the ceiling before anything is created. The
 *                 number of groups a call runs in, which sets how often each operand is read, is the engine's to decide
 *                 from the sizes of what it holds, so the bound is the counted requests of a sample with headroom
 *                 (`BOUND_HEADROOM`), not a structural cap; a sample that exceeds it fails the run's end-of-run check.
 *
 * The shape is the `refresh` of `bench/materialize-many-counts.cjs`: 100 stored operands of 200,000 ids and 1,000
 * outputs, each a tree of one or two levels of `and`, `or` and `andNot` with the same opt-out operand excluded, built by
 * the same seeded generator. The stages are `batchLoad`, the 100 operands each through `store.load()`, and `batch`, one
 * `materializeMany` call of the 1,000 outputs per sample, on a store that has read nothing, onto destinations no earlier
 * sample wrote. The `target` shape of that file (operands of 3,000,000 ids, about 5 GB written a sample) is not run: it
 * is too big for CloudShell.
 */
const { loadBound, releaseCore } = require('./calibrate-large-stages.cjs');
const { firstLoadRequests } = require('./calibrate-stages.cjs');
const { partsOf } = require('./calibrate-large-stages.cjs');

/** Every stage of the batch suite, in the order the harness runs them. */
const BATCH_STAGES = Object.freeze(['batchLoad', 'batch']);

/** The shapes the suite can run; `refresh` is the one a run measures, `small` is the rehearsal's. */
const BATCH_SHAPES = Object.freeze({
  refresh: Object.freeze({ operands: 100, outputs: 1_000, idsPerOperand: 200_000 }),
  small: Object.freeze({ operands: 20, outputs: 100, idsPerOperand: 100_000 }),
});
const DEFAULT_BATCH_SHAPE = 'refresh';
/** The default number of cold `materializeMany` calls: each is a thousand outputs, about $0.01 at list prices. */
const DEFAULT_BATCH_SAMPLES = 3;

/**
 * The first release that has `store.materializeMany`, with the `stats.groups` and `budget` option the stage uses, all of
 * which shipped together.
 */
const MATERIALIZE_MANY_SINCE = '0.18.0';

/**
 * How many times the counted requests of a sample the bound allows, as a fraction: 3 / 2. The engine regroups the
 * outputs by the sizes of what it holds, which is the same on S3 and in memory, but a bound that asked for no headroom
 * would fail a run on any difference in grouping.
 */
const BOUND_HEADROOM = Object.freeze({ num: 3, den: 2 });

/**
 * The most object versions a run of the default shape may leave in the bucket, which teardown has to list and delete.
 * Each destination leaves its object and its pointer's row, and a third for a delete marker, which a versioned bucket
 * keeps for the object of an output the call refused and removed; each operand leaves an object and a pointer. The
 * samples a run may discard are counted at a full sample each, since a discarded sample's destinations stay.
 */
function versionsOf({ operands, outputs, samples, discardedSamples }) {
  return (samples + discardedSamples) * outputs * 3 + operands * 2;
}

/**
 * The memory the suite needs to start, in MiB: the call holds up to 256 MiB of resident bytes by its own count, and process
 * memory has been measured at 1.6 to 5 times that; the floor is the count's own peak resident set size (823 MiB for the default shape's in-memory count, measured on a laptop,
 * with every operand and destination held in memory, which a run on S3 does not), with room.
 */
const BATCH_MIN_MEMORY_MB = 1_280;

/** The most samples a stage may discard, which the batch stage's destinations are counted for (`calibrate-samples.cjs`). */
const DISCARDED_SAMPLES = 2;
/** The versions the largest workload the suite accepts leaves: the default shape at the default samples. */
const BATCH_MAX_VERSIONS = versionsOf({
  ...BATCH_SHAPES[DEFAULT_BATCH_SHAPE],
  samples: DEFAULT_BATCH_SAMPLES,
  discardedSamples: DISCARDED_SAMPLES,
});

/**
 * Parse the suite's two knobs: `CR_CALIBRATE_BATCH_SHAPE` (`refresh` or `small`) and `CR_CALIBRATE_BATCH_SAMPLES` (cold
 * calls, a non-negative integer). Unset or empty is the default.
 */
function resolveBatchKnobs(env) {
  const raw = env.CR_CALIBRATE_BATCH_SHAPE;
  const shape =
    raw === undefined || String(raw).trim() === '' ? DEFAULT_BATCH_SHAPE : String(raw).trim();
  if (!Object.hasOwn(BATCH_SHAPES, shape)) {
    throw new Error(
      `CR_CALIBRATE_BATCH_SHAPE is "${raw}"; the shapes are ${Object.keys(BATCH_SHAPES).join(' and ')}`,
    );
  }
  const rawSamples = env.CR_CALIBRATE_BATCH_SAMPLES;
  let samples = DEFAULT_BATCH_SAMPLES;
  if (rawSamples !== undefined && String(rawSamples).trim() !== '') {
    samples = Number(rawSamples);
    if (!Number.isInteger(samples) || samples < 0) {
      throw new Error(
        `CR_CALIBRATE_BATCH_SAMPLES is "${rawSamples}"; expected a non-negative integer`,
      );
    }
  }
  return { shape, samples };
}

/** The knobs only the batch suite reads: a run of another suite that sets one is refused, since it would ignore it. */
const BATCH_SUITE_KNOBS = Object.freeze(['CR_CALIBRATE_BATCH_SHAPE', 'CR_CALIBRATE_BATCH_SAMPLES']);

/** Refuse a batch-suite setting made for a run of another suite. */
function refuseBatchKnobs(env, suite) {
  const set = BATCH_SUITE_KNOBS.filter((k) => env[k] !== undefined && String(env[k]).trim() !== '');
  if (set.length > 0) {
    throw new Error(
      `${set.join(', ')} size the batch suite, which --suite ${suite} does not read; unset ` +
        `${set.length === 1 ? 'it' : 'them'}, or run --suite batch`,
    );
  }
}

/** The large suite's two knobs, which the batch suite does not read. */
const LARGE_SUITE_KNOBS = Object.freeze(['CR_CALIBRATE_LARGE_READS', 'CR_CALIBRATE_LARGE_INTOS']);

/** Refuse a setting of another suite under `--suite batch`, each one by name. */
function refuseOtherSuiteKnobs(env, defaultKnobs) {
  const set = [...defaultKnobs, ...LARGE_SUITE_KNOBS].filter(
    (k) => env[k] !== undefined && String(env[k]).trim() !== '',
  );
  if (set.length > 0) {
    throw new Error(
      `${set.join(', ')} size another suite, which --suite batch does not read; unset ` +
        `${set.length === 1 ? 'it' : 'them'}, or set CR_CALIBRATE_BATCH_SHAPE and CR_CALIBRATE_BATCH_SAMPLES`,
    );
  }
}

/**
 * Refuse a workload whose object versions teardown's passes could not reach. `shape` is a name in {@link BATCH_SHAPES}.
 * The knobs can only make the workload smaller than the default's, which teardown's limits are sized for.
 */
function checkBatchWorkload({ shape, samples }) {
  const s = BATCH_SHAPES[shape];
  const versions = versionsOf({ ...s, samples, discardedSamples: DISCARDED_SAMPLES });
  if (versions > BATCH_MAX_VERSIONS) {
    throw new Error(
      `the batch suite would leave about ${versions} object versions, more than the ${BATCH_MAX_VERSIONS} teardown is ` +
        `sized for; lower CR_CALIBRATE_BATCH_SAMPLES to ${DEFAULT_BATCH_SAMPLES} or fewer`,
    );
  }
}

/** Whether an installed release has `materializeMany`; one that is not a plain `major.minor.patch` is shown to have none. */
function hasMaterializeMany(version) {
  const have = releaseCore(version);
  const need = releaseCore(MATERIALIZE_MANY_SINCE);
  if (have === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** Refuse an installed release that has no `materializeMany`, naming the release that has it. */
function checkMaterializeMany(version) {
  if (!hasMaterializeMany(version)) {
    throw new Error(
      `the installed @cloudbitmaps/roaring is ${releaseCore(version) === null ? `"${version}", which is not a version` : version}, ` +
        `and a release below ${MATERIALIZE_MANY_SINCE} has no materializeMany, which the batch stage measures; ` +
        `${MATERIALIZE_MANY_SINCE} is the first release that does. Nothing was created. Install it, or run from the ` +
        `${MATERIALIZE_MANY_SINCE} release.`,
    );
  }
}

/** A counted figure with the bound's headroom, rounded up. */
const withHeadroom = (n) => Math.ceil((n * BOUND_HEADROOM.num) / BOUND_HEADROOM.den);

/**
 * The most a stage can request, from the workload `w`, and the total with the run's fixed requests.
 *
 *   w.operands, w.outputs   the shape
 *   w.operandBytes          the stored object of each operand
 *   w.samples               cold `materializeMany` calls
 *   w.counts                `countBatch`'s answer: `batch.put` and `batch.get` are a sample's counted requests
 *   w.discards              { perRun, perStage }
 *   w.retryBound, w.fixedPuts, w.fixedGets
 *
 * Only the batch stage can discard a sample, so the allowance is the fewer of a run's and a stage's, each at the costliest
 * sample's bound, whatever it had sent when a fault stopped it.
 */
function projectBatch(w) {
  const stages = { batchLoad: { put: 0, get: 0 }, batch: { put: 0, get: 0 } };
  for (const bytes of w.operandBytes) {
    const b = loadBound(bytes, w.retryBound);
    stages.batchLoad = { put: stages.batchLoad.put + b.put, get: stages.batchLoad.get + b.get };
  }
  const sample = { put: withHeadroom(w.counts.batch.put), get: withHeadroom(w.counts.batch.get) };
  if (w.samples > 0) stages.batch = { put: w.samples * sample.put, get: w.samples * sample.get };
  const { perRun, perStage } = w.discards ?? {};
  if (!Number.isInteger(perRun) || perRun < 0) {
    throw new Error(`discards.perRun must be a non-negative integer, got ${perRun}`);
  }
  const allowed = Math.min(perRun, perStage ?? perRun);
  const costliest = w.samples > 0 ? sample : { put: 0, get: 0 };
  const discards = { put: allowed * costliest.put, get: allowed * costliest.get };
  const put = stages.batchLoad.put + stages.batch.put + w.fixedPuts + discards.put;
  const getSum = stages.batchLoad.get + stages.batch.get + w.fixedGets + discards.get;
  return {
    stages,
    discards,
    costliestSample: costliest.get,
    total: { put, get: Math.max(getSum, put) },
  };
}

/**
 * The exact requests each stage makes when nothing races it: the operands' loads are a first load each on S3's shape, and
 * the batch is `w.samples` times the counted requests of one call.
 */
function expectedBatch(w) {
  const stages = { batchLoad: { put: 0, get: 0 }, batch: { put: 0, get: 0 } };
  for (const bytes of w.operandBytes) {
    const r = firstLoadRequests(partsOf(bytes));
    stages.batchLoad.put += r.put;
    stages.batchLoad.get += r.get;
  }
  stages.batch = { put: w.samples * w.counts.batch.put, get: w.samples * w.counts.batch.get };
  return stages;
}

/**
 * Hold a call's per-output results to the engine's in-memory ones. `got` is `run.outputs` of the call, `want` the counted
 * `outputs` (`{ published, cardinality }` or `{ published: false, reason }`). An output that came back with an error is
 * thrown as one, with its error as the cause, so a transient fault is discarded as the harness discards one anywhere; any
 * other difference throws, since a call whose outputs are not the engine's must not produce a latency figure.
 */
function checkOutputs(got, want) {
  if (got.length !== want.length) {
    throw new Error(`materializeMany returned ${got.length} outputs; expected ${want.length}`);
  }
  for (let i = 0; i < want.length; i += 1) {
    const g = got[i];
    const w = want[i];
    if (g.error !== undefined) {
      throw new Error(`materializeMany output ${i} failed: ${g.error.message}`, { cause: g.error });
    }
    if (g.published !== w.published) {
      throw new Error(
        `materializeMany output ${i} ${g.published ? 'published' : `was refused (${g.reason})`}; the engine's own ` +
          `count in memory ${w.published ? 'publishes it' : `refuses it (${w.reason})`}. A call that is not exact must not produce a latency figure.`,
      );
    }
    if (w.published ? g.cardinality !== w.cardinality : g.reason !== w.reason) {
      throw new Error(
        w.published
          ? `materializeMany output ${i} holds ${g.cardinality} ids; expected exactly ${w.cardinality}, the engine's count in memory. ` +
              'A count that is not exact must not produce a latency figure.'
          : `materializeMany output ${i} was refused for ${g.reason}; expected ${w.reason}.`,
      );
    }
  }
}

module.exports = {
  BATCH_STAGES,
  BATCH_SHAPES,
  DEFAULT_BATCH_SHAPE,
  DEFAULT_BATCH_SAMPLES,
  MATERIALIZE_MANY_SINCE,
  BOUND_HEADROOM,
  DISCARDED_SAMPLES,
  BATCH_MIN_MEMORY_MB,
  BATCH_MAX_VERSIONS,
  versionsOf,
  resolveBatchKnobs,
  BATCH_SUITE_KNOBS,
  refuseBatchKnobs,
  LARGE_SUITE_KNOBS,
  refuseOtherSuiteKnobs,
  checkBatchWorkload,
  hasMaterializeMany,
  checkMaterializeMany,
  withHeadroom,
  projectBatch,
  expectedBatch,
  checkOutputs,
};
