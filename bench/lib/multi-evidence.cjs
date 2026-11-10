'use strict';
/*
 * The gate on the multi suite's evidence: what makes a results file under `bench/calibration/multi/` a finished, exact run.
 *
 * Nothing derives a figure from a multi run yet, so this is the check its committed files are held to
 * (`tests/bench/calibrate-multi.test.ts` reads every file in the directory through it). It reads each stage's kept requests
 * the way the harness does (`keptRequests`: a discarded sample's requests are billed and stay in the stage, and are out of
 * what it is held to), holds them to the requests the plan expected in both classes (`countMisses`, the function the harness
 * records a miss with), and refuses a run the harness itself marked: not finished, interrupted, a count missed, the
 * projection exceeded, no bill. Each shape of a read stage is held too: its reads all exact, as many as the workload asked
 * for, each of the expected requests, and no more than the bound.
 */
const { MULTI_STAGES } = require('./calibrate-multi-stages.cjs');
const { keptRequests } = require('./calibrate-samples.cjs');
const { countMisses } = require('./calibrate-large-stages.cjs');

/** The counts a read stage holds each shape to: the stage and the counted verb it ran. */
const COUNTED = Object.freeze({ multiIntersect: 'intersect', multiCount: 'count' });

/** Why one shape's entry of a read stage is not usable: one message each. */
function shapeProblems(name, entry, shape, reads) {
  const out = [];
  const at = `${name} ${entry.shape}`;
  if (shape === undefined) return [`${at} is not a shape of the workload`];
  const want = shape.counts?.[COUNTED[name]];
  if (entry.runs !== reads) out.push(`${at} ran ${entry.runs} reads, the workload asked for ${reads}`);
  if (entry.runs === 0) return out;
  if (entry.exact !== true) out.push(`${at} is not marked exact`);
  if (entry.offExpected !== 0) {
    out.push(`${at} had ${entry.offExpected} reads that made other than the expected requests`);
  }
  if (want === undefined || entry.expectedGets !== want.gets) {
    out.push(`${at} expects ${entry.expectedGets} GET-class, the workload's count is ${want?.gets}`);
  }
  if (entry.medianGets > shape.bound) {
    out.push(`${at} made a median ${entry.medianGets} GET-class, over its bound ${shape.bound}`);
  }
  for (const s of entry.perSample ?? []) {
    const kinds = s.rangeReads + s.tailReads + s.pointerReads + s.noObjectReads;
    if (!(Number.isFinite(kinds) && kinds === s.get)) {
      out.push(
        `${at} sample ${s.sample}: its ${s.get} GET-class are ${s.rangeReads} range, ${s.tailReads} tail and ` +
          `${s.pointerReads} pointer reads and ${s.noObjectReads} that returned no object, which make ${kinds}`,
      );
    }
    if (!Number.isInteger(s.peakInFlight) || s.peakInFlight < 1 || !(s.meanInFlight >= 0)) {
      out.push(`${at} sample ${s.sample} has no usable peakInFlight or meanInFlight`);
    }
  }
  if ((entry.perSample ?? []).length !== entry.runs) {
    out.push(`${at} records ${(entry.perSample ?? []).length} samples for ${entry.runs} reads`);
  }
  return out;
}

/**
 * Why a results file is not a finished, exact run of the multi suite: one message each, none for a run that is. A
 * rehearsal's file (`rehearsal: true`) carries no bill, since a rehearsal bills nothing.
 */
function multiRunProblems(run, { rehearsal = false } = {}) {
  const out = [];
  if (run.suite !== 'multi') out.push('not a run of the multi suite');
  if (run.partial !== false) out.push('partial');
  if (run.interrupted === true) out.push('interrupted');
  if (run.error !== undefined) out.push('the run failed');
  if (run.expectedMissed !== undefined) out.push('an expected count was missed');
  if (run.projectionExceeded !== undefined) out.push('the projection was exceeded');
  const w = run.workload ?? {};
  if (!Number.isInteger(w.reads)) out.push('the workload records no read count');
  for (const name of MULTI_STAGES) {
    const phase = run.phases?.[name];
    if (phase === undefined) {
      out.push(`${name} did not run`);
      continue;
    }
    const want = w.expected?.[name];
    if (want === undefined || phase.requests === undefined) {
      out.push(`${name} records no requests or no expected requests`);
      continue;
    }
    const kept = keptRequests({ requests: phase.requests, discarded: phase.discarded ?? [] });
    for (const m of countMisses(kept, want)) {
      out.push(`${name} kept ${m.kept} ${m.class}, expected ${m.expected}`);
    }
    if (name === 'multiLoad') continue;
    const entries = phase.shapes ?? [];
    for (const shape of w.shapes ?? []) {
      if (!entries.some((e) => e.shape === shape.name)) out.push(`${name} has no ${shape.name}`);
    }
    for (const entry of entries) {
      const shape = (w.shapes ?? []).find((s) => s.name === entry.shape);
      out.push(...shapeProblems(name, entry, shape, w.reads));
    }
  }
  if (!rehearsal && run.cost === undefined) out.push('no bill');
  return out;
}

module.exports = { multiRunProblems };
