'use strict';
/*
 * The large suite's stages, run by `bench/calibrate-aws.cjs --suite large`.
 *
 * The harness hands this module what a stage is built from (its meter, its discard ledger, its loader, its ceiling
 * check) so a large stage is held to exactly what a default one is: every request metered, every timed sample run
 * through the ledger, the ceiling checked after each send, the content of each read checked exactly. What a stage may
 * cost, and what it is expected to cost, are in `calibrate-large-stages.cjs`.
 *
 * A read is drained a chunk at a time (`batches()`): an operand holds up to 18 million ids, and one `await` per id
 * would make the event loop, and not the object store, what the stage times. Every id is still counted and summed.
 */
const { layoutIds } = require('./calibrate-guards.cjs');
const { firstLoadRequests } = require('./calibrate-stages.cjs');
const {
  largeExpectedContent,
  INTO_READS,
  partsOf,
  rangeCap,
  LARGE_STAGES,
} = require('./calibrate-large-stages.cjs');

/** The segment names a size's two operands go by. */
const operandName = (n, i) => `large-${n}-${i}`;
/** The destination segment of one `*Into` verb at size `n`: every call of the verb loads onto it. */
const destName = (n, verb) => `large-${n}-${verb}`;

/**
 * Run the large suite's stages in order. `ctx` is the harness's: `stage`, `sample`, `load`, `perLoad`, `summarise`,
 * `snap`, `startDepth`, `depthOf`, `checkCeiling`, `msSince`, `median`, `spreadOf`, `timedStore`, `log`, the `plan`
 * (`reads`, `intos`, `sizes: [{ n, layout, counts, ... }]`) and `recordMissed`, which records an expected count a call missed.
 */
async function runLargeSuite(ctx) {
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
  const sizes = plan.sizes.map((s) => ({ ...s, content: largeExpectedContent(s.layout) }));

  await stage('largeLoad', {
    run: async () => {
      const loads = [];
      for (const s of sizes) {
        for (let i = 0; i < 2; i += 1) {
          await load(
            operandName(s.n, i),
            layoutIds(s.layout, i),
            s.layout.shared + s.layout.priv,
            loads,
          );
        }
      }
      // What the engine is expected to make for these loads, each by its own parts.
      const expected = loads.reduce(
        (acc, l) => {
          const r = firstLoadRequests(l.multipart ? l.parts : 0);
          return { put: acc.put + r.put, get: acc.get + r.get };
        },
        { put: 0, get: 0 },
      );
      const single = loads.filter((l) => !l.multipart);
      const multi = loads.filter((l) => l.multipart);
      log(`largeLoad: ${single.length} single-part, ${multi.length} multipart`);
      return {
        via: 'store.load()',
        singlePart: summarise(single),
        multipart: summarise(multi),
        perLoad: perLoad(loads),
        expected,
      };
    },
  });

  /** Drain a read a chunk at a time: how many ids, and their sum. */
  const drain = async (stream) => {
    let n = 0;
    let sum = 0;
    for await (const ids of stream.batches()) {
      n += ids.length;
      for (let i = 0; i < ids.length; i += 1) sum += ids[i];
    }
    return { n, sum };
  };
  const exact = (what, got, want) => {
    if (got.n !== want.count || got.sum !== want.sum) {
      throw new Error(
        `${what} returned ${got.n} ids (sum ${got.sum}); expected exactly ${want.count} (sum ${want.sum}). ` +
          'A read that is not exact must not produce a latency figure.',
      );
    }
  };

  /** One uncached read: a fresh store, so no cache can answer it. */
  const coldRead = (of, index, run, want, what) =>
    sample(of, index, async () => {
      const store = timedStore();
      const before = snap();
      startDepth();
      const t0 = process.hrtime.bigint();
      const got = await run(store);
      const ms = msSince(t0);
      const after = snap();
      exact(what, got, want);
      return {
        ms,
        gets: after.get - before.get,
        chunkReads: after.rangeN - before.rangeN,
        chunkBytes: after.rangeBytes - before.rangeBytes,
        tailReads: after.suffixN - before.suffixN,
        pointerReads: after.wholeN - before.wholeN,
        ...depthOf(before, after, ms),
      };
    });

  const describe = (reads, expectedGets) => ({
    runs: reads.length,
    cold: true,
    exact: true,
    ...spreadOf(reads.map((r) => r.ms)),
    medianGets: median(reads.map((r) => r.gets)),
    expectedGets,
    // Reads whose request count was not the one the engine is expected to make: zero unless a read found something.
    offExpected: reads.filter((r) => r.gets !== expectedGets).length,
    chunkReadsPerCall: median(reads.map((r) => r.chunkReads)),
    chunkBytesPerCall: median(reads.map((r) => r.chunkBytes)),
    tailReadsPerCall: median(reads.map((r) => r.tailReads)),
    pointerReadsPerCall: median(reads.map((r) => r.pointerReads)),
    medianPeakInFlight: median(reads.map((r) => r.peakInFlight)),
    medianMeanInFlight: median(reads.map((r) => r.meanInFlight)),
    medianRounds: median(reads.map((r) => r.rounds)),
  });

  const verbs = {
    largeIntersect: {
      kind: 'intersect',
      run: (s, store) =>
        store.segment(operandName(s.n, 0)).intersect([store.segment(operandName(s.n, 1))]),
    },
    largeUnion: {
      kind: 'union',
      run: (s, store) =>
        store.segment(operandName(s.n, 0)).union([store.segment(operandName(s.n, 1))]),
    },
    largeAndNot: {
      kind: 'andNot',
      run: (s, store) =>
        store.segment(operandName(s.n, 0)).andNot([store.segment(operandName(s.n, 1))]),
    },
  };
  for (const [name, verb] of Object.entries(verbs)) {
    await stage(name, {
      run: async () => {
        const perSize = [];
        for (const s of sizes) {
          const of = `${verb.kind} of ${s.n} ids`;
          const reads = [];
          for (let i = 0; i < plan.reads; i += 1) {
            reads.push(
              await coldRead(
                of,
                i,
                async (store) => drain(verb.run(s, store)),
                s.content[verb.kind],
                `${verb.kind} of ${s.n} ids`,
              ),
            );
            checkCeiling();
          }
          if (reads.length === 0) {
            perSize.push({ n: s.n, runs: 0 });
            continue;
          }
          const d = describe(reads, s.counts.reads[verb.kind].gets);
          log(
            `  ${s.n} ids: ${d.runs} cold, all exact — p50 ${d.p50ms.toFixed(1)} ms, p99 ${d.p99ms.toFixed(1)} ms; ` +
              `median ${d.medianGets} GETs`,
          );
          perSize.push({
            n: s.n,
            chunksPerSegment: s.layout.chunksPerSegment,
            sharedChunks: s.layout.sharedChunks,
            ...d,
          });
        }
        return { sizes: perSize };
      },
    });
  }

  await stage('largeInto', {
    run: async () => {
      const perSize = [];
      for (const s of sizes) {
        const entry = { n: s.n, verbs: {} };
        for (const verb of Object.keys(INTO_READS)) {
          const want = s.content[INTO_READS[verb]];
          const calls = [];
          for (let g = 0; g < plan.intos; g += 1) {
            // One sample: a transient fault discards it, and it runs again on a fresh store. Every call loads onto one
            // destination, so the first is a first load and the rest are not.
            const call = await sample(`${verb} of ${s.n} ids`, g, async () => {
              const store = timedStore();
              const before = snap();
              startDepth();
              const t0 = process.hrtime.bigint();
              const include = store.segment(operandName(s.n, 0));
              const result = await include[verb](store.segment(destName(s.n, verb)), [
                store.segment(operandName(s.n, 1)),
              ]);
              const ms = msSince(t0);
              const after = snap();
              if (!result.published) {
                throw new Error(`${verb} of ${s.n} ids was refused: ${result.reason}`);
              }
              if (result.cardinality !== want.count) {
                throw new Error(
                  `${verb} of ${s.n} ids wrote ${result.cardinality} ids; expected exactly ${want.count}. ` +
                    'A write that is not exact must not produce a latency figure.',
                );
              }
              return {
                ms,
                generation: result.generation,
                objectBytes: result.size,
                put: after.put - before.put,
                get: after.get - before.get,
                parts: after.parts - before.parts,
                uploadBytes: after.up - before.up,
                downloadBytes: after.down - before.down,
                ...depthOf(before, after, ms),
              };
            });
            checkCeiling();
            calls.push(call);
          }
          // Each call held to its own expected requests: the first is a first load and the rest are not.
          const expected = s.counts.into[verb];
          const perCall = calls.map((c, g) => {
            const want1 = expected[g];
            if (c.put !== want1.put || c.get !== want1.get) {
              recordMissed(
                `${verb} of ${s.n} ids, call ${g}: ${c.put} PUT-class and ${c.get} GET-class, expected ` +
                  `${want1.put} and ${want1.get}`,
              );
            }
            return {
              call: g,
              kind: g === 0 ? 'first' : 'repeat',
              ms: c.ms,
              generation: c.generation,
              objectBytes: c.objectBytes,
              parts: c.parts,
              put: c.put,
              get: c.get,
              expectedPut: want1.put,
              expectedGet: want1.get,
            };
          });
          if (calls.length > 0) {
            log(
              `  ${verb} ${s.n} ids: ${calls.length} calls, median ${median(calls.map((c) => c.ms)).toFixed(1)} ms, ` +
                `${calls[0].objectBytes} byte output in ${partsOf(calls[0].objectBytes) === 0 ? 'one PUT' : `${partsOf(calls[0].objectBytes)} parts`}`,
            );
          }
          entry.verbs[verb] = {
            runs: calls.length,
            ...(calls.length === 0 ? {} : spreadOf(calls.map((c) => c.ms))),
            medianPeakInFlight: median(calls.map((c) => c.peakInFlight)),
            medianMeanInFlight: median(calls.map((c) => c.meanInFlight)),
            medianRounds: median(calls.map((c) => c.rounds)),
            perCall,
          };
        }
        perSize.push(entry);
      }
      return { sizes: perSize };
    },
  });
}

/**
 * The projection-only report of the large suite: the layouts, then each stage's bound and exact expected requests, the
 * discards and the fixed requests, and the totals priced. `price` turns a `{ put, get }` into dollars.
 */
function projectionLines({ plan, bounds, expected, discardBound, costliestSample, ops, price }) {
  const lines = [];
  const pad = (v, w) => String(v).padStart(w);
  for (const s of plan.sizes) {
    lines.push(
      `  size ${String(s.n).padStart(8)} ids: 2 operands of ${s.layout.chunksPerSegment} chunks, ${s.layout.sharedChunks} shared, ` +
        `stride ${s.layout.stride}, ${s.operandBytes.map((b) => `${b} B`).join(' and ')} ` +
        `(${s.operandBytes.map((b) => (partsOf(b) === 0 ? 'one PUT' : `${partsOf(b)} parts`)).join(', ')}), ` +
        `at most ${rangeCap(Math.max(...s.operandBytes))} range requests an operand`,
    );
  }
  lines.push(
    `  reads        ${plan.reads} uncached of each kind per size; ${plan.intos} of each *Into per size`,
  );
  lines.push(
    `  ${''.padEnd(16)} ${'bound PUT'.padStart(9)} ${'bound GET'.padStart(10)}  ${'expected PUT'.padStart(12)} ${'expected GET'.padStart(12)}`,
  );
  for (const name of LARGE_STAGES) {
    const b = bounds[name];
    const e = expected[name];
    lines.push(
      `  ${name.padEnd(16)} ${pad(b.put, 9)} ${pad(b.get, 10)}  ${pad(e.put, 12)} ${pad(e.get, 12)}`,
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

module.exports = { runLargeSuite, projectionLines, operandName, destName };
