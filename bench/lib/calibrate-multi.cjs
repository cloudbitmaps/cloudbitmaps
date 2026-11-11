'use strict';
/*
 * The multi suite's stages, run by `bench/calibrate-aws.cjs --suite multi`.
 *
 * As the large suite's, the harness hands this module what a stage is built from (its meter, its discard ledger, its
 * loader, its ceiling check), so a multi stage is held to exactly what every other one is: every request metered, every
 * timed sample run through the ledger, the ceiling checked after each send, the content of each read checked exactly. What a
 * stage may cost, and what it is expected to cost, are in `calibrate-multi-stages.cjs`; the workload and the counts are in
 * `multi-counts.cjs`. A read is drained a chunk at a time (`calibrate-reads.cjs`).
 *
 * Each sample is one cold call on a fresh store, of the first `k` operands of a pool: `intersect` (a stream, drained) in
 * the `multiIntersect` stage and `intersectCount` in `multiCount`. What a sample records beyond its time is what the
 * suite is about: the requests by kind and the bytes read, against the bytes of the k objects.
 */
const { firstLoadRequests } = require('./calibrate-stages.cjs');
const { drain, exact, readHelpers } = require('./calibrate-reads.cjs');
const { partsOf } = require('./calibrate-large-stages.cjs');
const { MULTI_STAGES, operandSegment, planMultiPool } = require('./calibrate-multi-stages.cjs');

/** The `k` operands of a shape on `store`: the first `k` of its pool. */
const operandsOf = (s, store) =>
  Array.from({ length: s.k }, (_, i) => store.segment(operandSegment(s.pool, i)));

/** What each stage runs on a shape: the call, and the check that holds what it returned to the exact content. */
const VERBS = {
  multiIntersect: {
    method: 'intersect',
    expected: (s) => s.counts.intersect,
    run: (s, store) => {
      const [first, ...rest] = operandsOf(s, store);
      return drain(first.intersect(rest));
    },
    check: (s, got) => exact(`${s.name}: intersect`, got, s.content),
  },
  multiCount: {
    method: 'intersectCount',
    expected: (s) => s.counts.count,
    run: (s, store) => {
      const [first, ...rest] = operandsOf(s, store);
      return first.intersectCount(rest);
    },
    check: (s, got) => {
      if (got !== s.content.count) {
        throw new Error(
          `${s.name}: intersectCount returned ${got}; expected exactly ${s.content.count}. ` +
            'A count that is not exact must not produce a latency figure.',
        );
      }
    },
  },
};

/**
 * Run the multi suite's stages in order. `ctx` is the harness's: `stage`, `sample`, `load`, `perLoad`, `summarise`, `snap`,
 * `startDepth`, `depthOf`, `checkCeiling`, `msSince`, `median`, `spreadOf`, `timedStore`, `log`, and the `plan` (`reads`,
 * `pools`, `shapes`).
 */
async function runMultiSuite(ctx) {
  const { stage, load, perLoad, summarise, checkCeiling, median, log, plan } = ctx;
  const { coldRead, describe } = readHelpers(ctx);

  await stage('multiLoad', {
    run: async () => {
      const loads = [];
      for (const pool of plan.pools) {
        const layout = planMultiPool(pool.name);
        for (let i = 0; i < pool.operands; i += 1) {
          await load(operandSegment(pool.name, i), layout.idsOf(i), pool.idsPerOperand, loads);
        }
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
      log(`multiLoad: ${single.length} single-part, ${multi.length} multipart`);
      return {
        via: 'store.load()',
        singlePart: summarise(single),
        multipart: summarise(multi),
        perLoad: perLoad(loads),
        expected,
      };
    },
  });

  for (const stageName of MULTI_STAGES.filter((n) => n !== 'multiLoad')) {
    const verb = VERBS[stageName];
    await stage(stageName, {
      run: async () => {
        const perShape = [];
        for (const s of plan.shapes) {
          const shape = { ...s, content: plan.pools.find((p) => p.name === s.pool).expected };
          const reads = [];
          for (let i = 0; i < plan.reads; i += 1) {
            reads.push(
              await coldRead(
                `${verb.method} of ${s.name}`,
                i,
                (store) => verb.run(shape, store),
                (got) => verb.check(shape, got),
              ),
            );
            checkCeiling();
          }
          const head = {
            shape: s.name,
            group: s.group,
            pool: s.pool,
            k: s.k,
            objectBytes: s.objectBytes,
          };
          if (reads.length === 0) {
            perShape.push({ ...head, runs: 0 });
            continue;
          }
          const want = verb.expected(s);
          const d = {
            ...describe(reads, want.gets),
            tailBytesPerCall: median(reads.map((r) => r.tailBytes)),
            pointerBytesPerCall: median(reads.map((r) => r.pointerBytes)),
            bytesReadPerCall: median(reads.map((r) => r.chunkBytes + r.tailBytes + r.pointerBytes)),
            expectedRangeReads: want.range,
            expectedRangeBytes: want.rangeBytes,
            bound: s.bound,
            // Each sample's own requests and in-flight depth.
            perSample: reads.map((r, i) => ({
              sample: i,
              ms: r.ms,
              get: r.gets,
              rangeReads: r.chunkReads,
              rangeBytes: r.chunkBytes,
              tailReads: r.tailReads,
              tailBytes: r.tailBytes,
              pointerReads: r.pointerReads,
              pointerBytes: r.pointerBytes,
              noObjectReads: r.noObjectReads,
              peakInFlight: r.peakInFlight,
              meanInFlight: r.meanInFlight,
            })),
          };
          log(
            `  ${s.name}: ${d.runs} cold ${verb.method}, all exact — p50 ${d.p50ms.toFixed(1)} ms, p99 ${d.p99ms.toFixed(1)} ms; ` +
              `median ${d.medianGets} GETs, ${d.bytesReadPerCall} of ${s.objectBytes} object bytes`,
          );
          perShape.push({ ...head, ...d });
        }
        return { shapes: perShape };
      },
    });
  }
}

/**
 * The projection-only report of the multi suite: the layouts, each shape's counted requests and bound, then each stage's
 * bound and exact expected requests, the discards and the fixed requests, and the totals priced. `price` turns a
 * `{ put, get }` into dollars.
 */
function projectionLines({ plan, bounds, expected, discardBound, costliestSample, ops, price }) {
  const lines = [];
  const pad = (v, w) => String(v).padStart(w);
  const how = (b) => (partsOf(b) === 0 ? 'one PUT' : `${partsOf(b)} parts`);
  for (const p of plan.pools) {
    lines.push(
      `  pool ${p.name.padEnd(4)} ${p.operands} operands of ${p.idsPerOperand} ids (${p.chunksPerOperand} chunks, ${p.sharedChunks} in common, stride ${p.stride}), ` +
        `${p.operandBytes.map((b) => `${b} B`).join(', ')} (${p.operandBytes.map(how).join(', ')})` +
        (p.kind === 'nearMiss'
          ? `; ${p.operands} bands of ${p.bandChunks} chunks, band j held by every operand but j`
          : ''),
    );
  }
  lines.push(
    `  reads        ${plan.reads} uncached intersect and ${plan.reads} uncached intersectCount per shape, each on a store that has read nothing`,
  );
  lines.push(
    `  ${'shape'.padEnd(12)} ${'k'.padStart(2)} ${'counted GET'.padStart(11)} ${'ranges'.padStart(7)} ${'bytes read'.padStart(11)} ${'object bytes'.padStart(13)} ${'bound GET'.padStart(10)}`,
  );
  for (const s of plan.shapes) {
    const c = s.counts.intersect;
    lines.push(
      `  ${s.name.padEnd(12)} ${pad(s.k, 2)} ${pad(c.gets, 11)} ${pad(c.range, 7)} ${pad(c.rangeBytes, 11)} ${pad(s.objectBytes, 13)} ${pad(s.bound, 10)}`,
    );
  }
  lines.push(
    `  ${''.padEnd(16)} ${'bound PUT'.padStart(9)} ${'bound GET'.padStart(10)}  ${'expected PUT'.padStart(12)} ${'expected GET'.padStart(12)}`,
  );
  for (const name of MULTI_STAGES) {
    lines.push(
      `  ${name.padEnd(16)} ${pad(bounds[name].put, 9)} ${pad(bounds[name].get, 10)}  ${pad(expected[name].put, 12)} ${pad(expected[name].get, 12)}`,
    );
  }
  lines.push(
    `  ${'discards'.padEnd(16)} ${pad(discardBound.put, 9)} ${pad(discardBound.get, 10)}  up to ${plan.discards.perRun} samples run again after a transient fault, each at most the costliest sample's ${costliestSample}`,
  );
  lines.push(
    `  ${'fixed'.padEnd(16)} ${pad(plan.fixedPuts, 9)} ${pad(plan.fixedGets, 10)}  bucket, probe, round-trip samples, teardown`,
  );
  const spent = Object.values(expected).reduce(
    (a, e) => ({ put: a.put + e.put, get: a.get + e.get }),
    { put: 0, get: 0 },
  );
  lines.push(
    `  projected    ${ops.put} PUT-class, ${ops.get} GET-class — an upper bound, checked after the run`,
  );
  lines.push(
    `  projected $  ${price(ops).toFixed(6)} (the bound); the exact expected requests are ${spent.put} PUT-class and ${spent.get} GET-class, $${price(spent).toFixed(6)}`,
  );
  return lines;
}

module.exports = { runMultiSuite, projectionLines };
