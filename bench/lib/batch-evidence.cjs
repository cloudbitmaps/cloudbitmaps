'use strict';
/*
 * The gate on the batch suite's evidence: what makes a results file under `bench/calibration/batch/` a finished, exact run.
 *
 * The default suite's figures are derived from its evidence by `calibration-figures.cjs`; nothing derives a figure from a
 * batch run yet, so this is the check its committed files are held to (`tests/bench/calibrate-batch.test.ts` reads every
 * file in the directory through it). It reads each stage's kept requests the way the harness does (`keptRequests`: a
 * discarded sample's requests are billed and stay in the stage, and are out of what it is held to), holds them to the
 * requests the plan expected in both classes (`countMisses`, the function the harness records a miss with), and refuses a
 * run the harness itself marked: not finished, interrupted, a count missed, the projection exceeded, no bill.
 */
const { BATCH_STAGES } = require('./calibrate-batch-stages.cjs');
const { keptRequests } = require('./calibrate-samples.cjs');
const { countMisses } = require('./calibrate-large-stages.cjs');
const { MAX_PUBLISH_CONCURRENCY } = require('./calibrate-batch-stages.cjs');

/**
 * The two runs committed before the evidence recorded the call's settings, the per-call depth and the GET-class that
 * returned no object. Their files are never edited, so the absence of those fields in these two, and only these, reads as
 * "not passed": the library's defaults. A file of any other run that lacks them is refused.
 */
const RUNS_BEFORE_SETTINGS = Object.freeze(['2026-11-03-78516', '2026-11-08-b12e6']);

/** The settings a run's `materializeMany` call was made with: each the value passed, or `null` for the library's default. */
function settingsOf(run) {
  const w = run.workload ?? {};
  return {
    publishConcurrency: w.publishConcurrency ?? null,
    concurrency: w.concurrency ?? null,
    maxBufferedBytes: w.maxBufferedBytes ?? null,
  };
}

/** Why the call's settings recorded in a run are not usable: one message each. Absent is allowed only for the two early runs. */
function settingsProblems(run) {
  const out = [];
  const w = run.workload ?? {};
  const early = RUNS_BEFORE_SETTINGS.includes(run.runId);
  if (!early && !Number.isInteger(w.samples)) out.push('the workload records no sample count');
  for (const [name, max] of [
    ['publishConcurrency', MAX_PUBLISH_CONCURRENCY],
    ['concurrency', Number.MAX_SAFE_INTEGER],
    ['maxBufferedBytes', Number.MAX_SAFE_INTEGER],
  ]) {
    if (w[name] === undefined) {
      if (!early) out.push(`the workload does not record ${name} (null when not passed)`);
    } else if (w[name] !== null && !(Number.isInteger(w[name]) && w[name] >= 1 && w[name] <= max)) {
      out.push(
        `the workload's ${name} is ${JSON.stringify(w[name])}, not null or an integer from 1 to ${max}`,
      );
    }
  }
  return out;
}

/** Why a sample's depth and unfiled reads are not usable: one message each. Absent is allowed only for the two early runs. */
function sampleProblems(run, sample) {
  const out = [];
  const early = RUNS_BEFORE_SETTINGS.includes(run.runId);
  const at = `batch sample ${sample.sample}`;
  const fields = ['peakInFlight', 'meanInFlight', 'noObjectReads'];
  if (fields.every((f) => sample[f] === undefined)) {
    if (!early) out.push(`${at} records no peakInFlight, meanInFlight or noObjectReads`);
    return out;
  }
  for (const f of fields) {
    if (!(Number.isFinite(sample[f]) && sample[f] >= 0)) out.push(`${at} has no usable ${f}`);
  }
  if (!Number.isInteger(sample.peakInFlight) || sample.peakInFlight < 1) {
    out.push(`${at} has a peakInFlight that is not a whole number of at least 1`);
  }
  const kinds = sample.rangeReads + sample.tailReads + sample.pointerReads + sample.noObjectReads;
  if (Number.isFinite(kinds) && kinds !== sample.get) {
    out.push(
      `${at}: its ${sample.get} GET-class are ${sample.rangeReads} range, ${sample.tailReads} tail and ` +
        `${sample.pointerReads} pointer reads and ${sample.noObjectReads} that returned no object, which make ${kinds}`,
    );
  }
  return out;
}

/**
 * Why a results file is not a finished, exact run of the batch suite: one message each, none for a run that is. A
 * rehearsal's file (`rehearsal: true`) carries no bill, since a rehearsal bills nothing.
 */
function batchRunProblems(run, { rehearsal = false } = {}) {
  const out = [];
  if (run.suite !== 'batch') out.push('not a run of the batch suite');
  if (run.partial !== false) out.push('partial');
  if (run.interrupted === true) out.push('interrupted');
  if (run.error !== undefined) out.push('the run failed');
  if (run.expectedMissed !== undefined) out.push('an expected count was missed');
  if (run.projectionExceeded !== undefined) out.push('the projection was exceeded');
  out.push(...settingsProblems(run));
  for (const name of BATCH_STAGES) {
    const phase = run.phases?.[name];
    if (phase === undefined) {
      out.push(`${name} did not run`);
      continue;
    }
    const want = run.workload?.expected?.[name];
    if (want === undefined || phase.requests === undefined) {
      out.push(`${name} records no requests or no expected requests`);
      continue;
    }
    const kept = keptRequests({ requests: phase.requests, discarded: phase.discarded ?? [] });
    for (const m of countMisses(kept, want)) {
      out.push(`${name} kept ${m.kept} ${m.class}, expected ${m.expected}`);
    }
    // Each sample of the batch stage holds its own counts too: the call's and its read-backs'.
    for (const sample of name === 'batch' ? (phase.perSample ?? []) : []) {
      out.push(...sampleProblems(run, sample));
      const got = { put: sample.put, get: sample.get };
      const rb = { put: sample.readBackPut, get: sample.readBackGet };
      for (const m of countMisses(got, { put: sample.expectedPut, get: sample.expectedGet })) {
        out.push(`batch sample ${sample.sample} made ${m.kept} ${m.class}, expected ${m.expected}`);
      }
      for (const m of countMisses(rb, {
        put: sample.expectedReadBackPut,
        get: sample.expectedReadBackGet,
      })) {
        out.push(
          `batch sample ${sample.sample} read back with ${m.kept} ${m.class}, expected ${m.expected}`,
        );
      }
    }
  }
  if (!rehearsal && run.cost === undefined) out.push('no bill');
  return out;
}

module.exports = { batchRunProblems, settingsOf, RUNS_BEFORE_SETTINGS };
