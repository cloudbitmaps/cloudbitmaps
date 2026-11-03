'use strict';
/*
 * The batch suite's stages, run by `bench/calibrate-aws.cjs --suite batch`.
 *
 * As the large suite's, the harness hands this module what a stage is built from (its meter, its discard ledger, its
 * loader, its ceiling check), so a batch stage is held to exactly what every other one is: every request metered, every
 * timed sample run through the ledger, the ceiling checked after each send. What a stage may cost, and what it is expected
 * to cost, are in `calibrate-batch-stages.cjs`; the workload and the counts are in `batch-counts.cjs`.
 */
const { firstLoadRequests } = require('./calibrate-stages.cjs');
const { checkOutputs, checkReadBack } = require('./calibrate-batch-stages.cjs');
const { batchOperands, batchSpecs, readBackCounts } = require('./batch-counts.cjs');

/** The segment an operand is stored as. */
const operandSegment = (i) => `batch-op${i}`;
/** The destination of output `i` of one attempt at sample `g`: no attempt shares a name with another. */
const destSegment = (g, attempt, i) => `batch-s${g}-a${attempt}-o${i}`;

/**
 * Run the batch suite's stages in order. `ctx` is the harness's: `stage`, `sample`, `load`, `perLoad`, `summarise`, `snap`,
 * `startDepth`, `depthOf`, `checkCeiling`, `msSince`, `median`, `spreadOf`, `timedStore`, `log`, the `plan` (`shape`,
 * `samples`, `operands`, `outputs`, `counts`) and `recordMissed`, which records an expected count a call missed.
 */
async function runBatchSuite(ctx) {
  const {
    stage,
    sample,
    load,
    perLoad,
    summarise,
    snap,
    startDepth,
    depthOf,
    checkCeiling,
    msSince,
    median,
    spreadOf,
    timedStore,
    log,
    plan,
    recordMissed,
  } = ctx;

  await stage('batchLoad', {
    run: async () => {
      const loads = [];
      for (const { index, ids } of batchOperands(plan.shape)) {
        await load(operandSegment(index), ids, ids.length, loads);
      }
      const expected = loads.reduce(
        (acc, l) => {
          const r = firstLoadRequests(l.multipart ? l.parts : 0);
          return { put: acc.put + r.put, get: acc.get + r.get };
        },
        { put: 0, get: 0 },
      );
      const single = loads.filter((l) => !l.multipart);
      const multi = loads.filter((l) => l.multipart);
      log(`batchLoad: ${single.length} single-part, ${multi.length} multipart`);
      return {
        via: 'store.load()',
        singlePart: summarise(single),
        multipart: summarise(multi),
        perLoad: perLoad(loads),
        expected,
      };
    },
  });

  await stage('batch', {
    run: async () => {
      const specs = batchSpecs(plan.shape);
      const want = plan.counts.batch;
      const wantReadBack = plan.counts.readBack;
      const calls = [];
      for (let g = 0; g < plan.samples; g += 1) {
        // A sample a transient fault discards runs again from the start on fresh destination names: what the failed
        // attempt published stays, and must not be what the next one finds.
        let attempt = 0;
        const call = await sample('materializeMany', g, async () => {
          const a = attempt;
          attempt += 1;
          const store = timedStore();
          const operands = Object.fromEntries(
            Array.from({ length: plan.operands }, (_, i) => [
              `op${i}`,
              store.segment(operandSegment(i)),
            ]),
          );
          const outputs = specs.map((spec, i) => ({
            dest: store.segment(destSegment(g, a, i)),
            ...spec,
          }));
          const before = snap();
          startDepth();
          const t0 = process.hrtime.bigint();
          const run = await store.materializeMany({ operands, outputs, keep: 12, budget: false });
          const ms = msSince(t0);
          const after = snap();
          const depth = depthOf(before, after, ms);
          checkOutputs(run.outputs, want.outputs);
          // Untimed, on a store that has read nothing: what each published output holds, read back from where the call put
          // it and held, with the call's own answer, to the size set arithmetic over the generator's ids gives.
          const reader = timedStore();
          const readBack = await readBackCounts(run.outputs, (i) =>
            reader.segment(destSegment(g, a, i)),
          );
          const checked = snap();
          checkReadBack(
            readBack,
            plan.counts.sizes,
            run.outputs.map((o) => o.published),
          );
          return {
            ms,
            outputsPerSec: run.outputs.length / (ms / 1000),
            groups: run.stats?.groups ?? null,
            published: run.outputs.filter((o) => o.published).length,
            put: after.put - before.put,
            get: after.get - before.get,
            chunkReads: after.rangeN - before.rangeN,
            chunkBytes: after.rangeBytes - before.rangeBytes,
            tailReads: after.suffixN - before.suffixN,
            tailBytes: after.suffixBytes - before.suffixBytes,
            pointerReads: after.wholeN - before.wholeN,
            pointerBytes: after.wholeBytes - before.wholeBytes,
            uploadBytes: after.up - before.up,
            downloadBytes: after.down - before.down,
            readBackPut: checked.put - after.put,
            readBackGet: checked.get - after.get,
            ...depth,
          };
        });
        checkCeiling();
        calls.push(call);
      }
      const perSample = calls.map((c, g) => {
        if (c.put !== want.put || c.get !== want.get) {
          recordMissed(
            `materializeMany sample ${g}: ${c.put} PUT-class and ${c.get} GET-class, expected ${want.put} and ${want.get}`,
          );
        }
        if (c.readBackPut !== wantReadBack.put || c.readBackGet !== wantReadBack.get) {
          recordMissed(
            `read-back of sample ${g}: ${c.readBackPut} PUT-class and ${c.readBackGet} GET-class, expected ${wantReadBack.put} and ${wantReadBack.get}`,
          );
        }
        return {
          sample: g,
          ms: c.ms,
          outputsPerSec: c.outputsPerSec,
          groups: c.groups,
          published: c.published,
          put: c.put,
          get: c.get,
          expectedPut: want.put,
          expectedGet: want.get,
          readBackPut: c.readBackPut,
          readBackGet: c.readBackGet,
          expectedReadBackPut: wantReadBack.put,
          expectedReadBackGet: wantReadBack.get,
          rangeReads: c.chunkReads,
          rangeBytes: c.chunkBytes,
          tailReads: c.tailReads,
          tailBytes: c.tailBytes,
          pointerReads: c.pointerReads,
          pointerBytes: c.pointerBytes,
          bytesRead: c.chunkBytes + c.tailBytes + c.pointerBytes,
          bytesWritten: c.uploadBytes,
        };
      });
      if (calls.length > 0) {
        log(
          `  ${plan.outputs} outputs: ${calls.length} cold calls, all exact — median ${median(calls.map((c) => c.ms)).toFixed(0)} ms, ` +
            `${median(calls.map((c) => c.groups))} groups, ${calls[0].get} GET-class and ${calls[0].put} PUT-class, then ${calls[0].readBackGet} GET-class to read the outputs back`,
        );
      }
      return {
        operands: plan.operands,
        outputs: plan.outputs,
        runs: calls.length,
        expectedGroups: want.groups,
        expectedPublished: want.published,
        ...(calls.length === 0 ? {} : spreadOf(calls.map((c) => c.ms))),
        ...(calls.length === 0
          ? {}
          : { medianOutputsPerSec: median(calls.map((c) => c.outputsPerSec)) }),
        medianPeakInFlight: median(calls.map((c) => c.peakInFlight)),
        medianMeanInFlight: median(calls.map((c) => c.meanInFlight)),
        medianRounds: median(calls.map((c) => c.rounds)),
        perSample,
      };
    },
  });
}

/**
 * The projection-only report of the batch suite: the shape, each stage's bound and exact expected requests, the discards and
 * the fixed requests, and the totals priced. `price` turns a `{ put, get }` into dollars.
 */
function projectionLines({ plan, bounds, expected, discardBound, costliestSample, ops, price }) {
  const lines = [];
  const pad = (v, w) => String(v).padStart(w);
  const b = plan.counts.batch;
  lines.push(
    `  shape        ${plan.shape}: ${plan.operands} operands of ${plan.idsPerOperand} ids, ${plan.outputs} outputs ` +
      `(${b.published} published, ${b.refused} refused by the engine's own count), each sample one cold materializeMany ` +
      `in ${b.groups} groups: ${b.get} GET-class and ${b.put} PUT-class, and ${plan.counts.readBack.get} GET-class to read the outputs back`,
  );
  lines.push(`  samples      ${plan.samples} cold calls, each on destinations of its own`);
  lines.push(
    `  ${''.padEnd(12)} ${'bound PUT'.padStart(9)} ${'bound GET'.padStart(10)}  ${'expected PUT'.padStart(12)} ${'expected GET'.padStart(12)}`,
  );
  for (const name of Object.keys(bounds)) {
    lines.push(
      `  ${name.padEnd(12)} ${pad(bounds[name].put, 9)} ${pad(bounds[name].get, 10)}  ${pad(expected[name].put, 12)} ${pad(expected[name].get, 12)}`,
    );
  }
  lines.push(
    `  ${'discards'.padEnd(12)} ${pad(discardBound.put, 9)} ${pad(discardBound.get, 10)}  up to ${plan.discards.perStage} samples run again after a transient fault, each at most the costliest sample's ${costliestSample} GET-class`,
  );
  lines.push(
    `  ${'fixed'.padEnd(12)} ${pad(plan.fixedPuts, 9)} ${pad(plan.fixedGets, 10)}  bucket, probe, round-trip samples, teardown`,
  );
  const spent = Object.values(expected).reduce(
    (a, e) => ({ put: a.put + e.put, get: a.get + e.get }),
    { put: 0, get: 0 },
  );
  lines.push(
    `  projected    ${ops.put} PUT-class, ${ops.get} GET-class — an estimate (the counted sample at 1.5 times), not a cap`,
  );
  lines.push(
    `  projected $  ${price(ops).toFixed(6)} (the estimate); the exact expected requests are ${spent.put} PUT-class and ${spent.get} GET-class, $${price(spent).toFixed(6)}`,
  );
  lines.push(
    '  ceiling      the run’s CR_CALIBRATE_MAX_USD, checked before every request: a call that makes more than estimated stops there and tears down',
  );
  return lines;
}

module.exports = { runBatchSuite, projectionLines, operandSegment, destSegment };
