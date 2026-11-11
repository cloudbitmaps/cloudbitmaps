'use strict';
/*
 * The read helpers the large and multi suites share: draining a stream a chunk at a time, holding a read to its exact
 * content, and one uncached read timed on a store that has read nothing.
 *
 * A read is drained a chunk at a time (`batches()`): an operand holds up to 18 million ids, and one `await` per id would
 * make the event loop, and not the object store, what a stage times. Every id is still counted and summed.
 */

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

/** Throw unless a drained read (`got`) is exactly `want` (`{ count, sum }`): a read that is not exact makes no latency figure. */
const exact = (what, got, want) => {
  if (got.n !== want.count || got.sum !== want.sum) {
    throw new Error(
      `${what} returned ${got.n} ids (sum ${got.sum}); expected exactly ${want.count} (sum ${want.sum}). ` +
        'A read that is not exact must not produce a latency figure.',
    );
  }
};

/**
 * The two helpers that need the harness's pieces. `ctx` holds `sample`, `timedStore`, `snap`, `startDepth`, `msSince`,
 * `depthOf`, `spreadOf` and `median`.
 *
 * `coldRead(of, index, run, check)` is one uncached read: a fresh store, so no cache can answer it; `check` throws if what
 * `run` returned is not exact. `describe(reads, expectedGets)` summarises the reads of one shape.
 */
function readHelpers(ctx) {
  const { sample, timedStore, snap, startDepth, msSince, depthOf, spreadOf, median } = ctx;

  const coldRead = (of, index, run, check) =>
    sample(of, index, async () => {
      const store = timedStore();
      const before = snap();
      startDepth();
      const t0 = process.hrtime.bigint();
      const got = await run(store);
      const ms = msSince(t0);
      const after = snap();
      check(got);
      return {
        ms,
        got,
        gets: after.get - before.get,
        chunkReads: after.rangeN - before.rangeN,
        chunkBytes: after.rangeBytes - before.rangeBytes,
        tailReads: after.suffixN - before.suffixN,
        tailBytes: after.suffixBytes - before.suffixBytes,
        pointerReads: after.wholeN - before.wholeN,
        pointerBytes: after.wholeBytes - before.wholeBytes,
        noObjectReads: after.noObject - before.noObject,
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

  return { coldRead, describe };
}

module.exports = { drain, exact, readHelpers };
