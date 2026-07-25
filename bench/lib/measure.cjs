/*
 * Shared measurement primitives for the load / calibration harnesses.
 *
 * Extracted so the LocalStack numbers (`pnpm load`) and the real-AWS numbers (`pnpm calibrate:aws`) are
 * produced by the SAME latency maths and the SAME cost maths. Two harnesses with their own private copies of
 * `costOf` would drift, and we publish both — the LocalStack run as the reproducible-anywhere figure and the
 * AWS run as the calibrated one. A divergence between them has to mean the *cloud* differed, never that the
 * arithmetic did.
 */
'use strict';

function int(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Percentiles (ms) from a latency sample, plus throughput over the wall-clock window.
 *
 * A percentile the sample cannot support is `null`, not a number. With n < 1000, `p999` degenerates to `max`
 * (`floor(0.999·n)` = `n-1`), so a 20-op phase would otherwise print p99, p999 and max as three "statistics"
 * derived from one observation — which reads as far more evidence than it is.
 */
function stats(latencies, wallMs) {
  const s = latencies.slice().sort((a, b) => a - b);
  const at = (p) => {
    // Need at least one observation in the tail beyond the percentile for it to mean anything.
    if (s.length === 0 || s.length * (1 - p / 100) < 1) return null;
    return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] || 0, 2);
  };
  return {
    ops: s.length,
    opsPerSec: round(s.length / (wallMs / 1000), 0),
    p50: at(50),
    p99: at(99),
    p999: at(99.9),
    max: s.length === 0 ? null : round(s[s.length - 1], 2),
  };
}

/** Format a possibly-unsupported percentile for a console line. */
const pct = (v) => (v === null ? '—' : `${v}ms`);

/** Run `total` tasks with a bounded concurrency window, timing each; returns the latency sample + wall time. */
/**
 * Run `total` tasks with a bounded concurrency window, timing each.
 *
 * `onProgress(done)` is called every `progressEvery` completions and may THROW to abort the run — that is how
 * the calibration harness enforces its spend ceiling *inside* a phase. Checking only between phases left the
 * one phase with an unbounded op count (WRITE, because each OCC retry round issues another read + write) as a
 * single unchecked window.
 */
async function drive(total, taskFor, concurrency, { onProgress, progressEvery = 256 } = {}) {
  const latencies = [];
  let next = 0;
  let done = 0;
  const wall = process.hrtime.bigint();
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const t0 = process.hrtime.bigint();
      await taskFor(i);
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      done += 1;
      if (onProgress !== undefined && done % progressEvery === 0) onProgress(done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { latencies, wallMs: Number(process.hrtime.bigint() - wall) / 1e6 };
}

// DynamoDB capacity units derived from the AVERAGE op size (totalBytes/n), then × n — exact only when every op
// shares a unit-count (true for these uniform workloads). A size-varied workload would need per-op tracking to
// bill each request's own rounding, which an aggregate meter can't do; treat it as a close approximation there.
// `calibrate-aws.cjs` sidesteps this entirely by reading DynamoDB's OWN `ConsumedCapacity` off the responses.
function readUnits(slot, p) {
  const perOpKiB = slot.n ? slot.bytes / slot.n / 1024 : 0;
  const units =
    Math.max(1, Math.ceil(perOpKiB / p.warm.readUnitKiB)) * (p.warm.stronglyConsistent ? 1 : 0.5);
  return units * slot.n;
}

function writeUnits(slot, p) {
  const perOpKiB = slot.n ? slot.bytes / slot.n / 1024 : 0;
  return Math.max(1, Math.ceil(perOpKiB / p.warm.writeUnitKiB)) * slot.n;
}

/**
 * Apply the published pricing to MEASURED op counts → the $ this exact op-mix costs at AWS on-demand.
 *
 * `tally` slots are `{ n, bytes }`. Optional slots, supplied only by a harness that meters at the SDK layer:
 *   - `cold.put`  — S3 PUT/POST/COPY, priced at `putPerMillion` (**12.5× a GET** at us-east-1 on-demand, so
 *                   omitting it materially under-reports any ingest-heavy workload).
 *   - `cold.list` — LIST is billed at the PUT rate, not the GET rate.
 *   - `warm.units` — `{ read, write }` capacity units read straight off DynamoDB's `ConsumedCapacity`. When
 *                    present these are used verbatim instead of the size-derived estimate above, because they
 *                    are what AWS actually bills.
 */
function costOf(tally, pricing) {
  const n = (k) => tally[k]?.n ?? 0;
  const s3GetUSD = (n('cold.get') / 1e6) * pricing.cold.getPerMillion;
  // S3 bills LIST at the PUT/COPY/POST rate.
  const s3PutUSD = ((n('cold.put') + n('cold.list')) / 1e6) * pricing.cold.putPerMillion;

  const measured = tally['warm.units'];
  const rUnits = measured
    ? measured.read
    : n('warm.read') === 0
      ? 0
      : readUnits(tally['warm.read'], pricing);
  const wUnits = measured
    ? measured.write
    : n('warm.write') === 0
      ? 0
      : writeUnits(tally['warm.write'], pricing);

  const dynamoReadUSD = (rUnits / 1e6) * pricing.warm.rruPerMillion;
  const dynamoWriteUSD = (wUnits / 1e6) * pricing.warm.wruPerMillion;

  return {
    s3GetUSD,
    s3PutUSD,
    dynamoReadUSD,
    dynamoWriteUSD,
    capacityUnits: {
      read: rUnits,
      write: wUnits,
      source: measured ? 'ConsumedCapacity' : 'size-derived',
    },
    totalUSD: s3GetUSD + s3PutUSD + dynamoReadUSD + dynamoWriteUSD,
  };
}

// `readUnits`/`writeUnits` are deliberately NOT exported — they are `costOf`'s internals.
module.exports = { int, round, stats, pct, drive, costOf };
