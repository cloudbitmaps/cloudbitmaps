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

module.exports = { batchRunProblems };
