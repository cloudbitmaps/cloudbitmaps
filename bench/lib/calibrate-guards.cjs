'use strict';
/*
 * The guards that stand between `pnpm calibrate:aws` and someone's cloud bill.
 *
 * These are pure functions with no I/O, for one reason: every one of them was a BUG in the harness this
 * replaces, and the only way to keep a guard honest is to be able to plant its defect in a test and watch it
 * fail. The harness that ran the July 2026 calibration was deleted with the warm tier, and its regression
 * suite went with it — so these are rebuilt from the recorded post-mortem rather than from memory.
 *
 * Read `RELEASING.md` for the release pipeline's guards; this file is the money-spending equivalent.
 */

/** The typed phrase `--run` demands. Long and unguessable on purpose: a typo must not spend money. */
const CONFIRM_PHRASE = 'yes-spend-money';

/**
 * Parse the spend ceiling.
 *
 * THE BUG THIS EXISTS FOR: the ceiling used to be `Number(process.env.CR_CALIBRATE_MAX_USD)` compared with
 * `total > max`. `Number('abc')` is `NaN`, and **every comparison against NaN is false** — so a malformed
 * ceiling did not fail loudly, it silently deleted the bound on a script whose whole job is spending money.
 * Zero and negative are rejected too: both are almost certainly a mistake, and "spend nothing" is what the
 * default dry run is for.
 */
function parseCeiling(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('CR_CALIBRATE_MAX_USD is required for --run: set a spend ceiling in dollars');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `CR_CALIBRATE_MAX_USD is "${raw}", which is not a finite number. Refusing to run: a NaN ceiling ` +
        'compares false against every total and would silently remove the bound.',
    );
  }
  if (n <= 0) {
    throw new Error(`CR_CALIBRATE_MAX_USD is ${n}; a ceiling must be greater than zero`);
  }
  return n;
}

/**
 * Resolve a workload size from the environment.
 *
 * THE BUG THIS EXISTS FOR: the old helper mapped a falsy value to the default, so `CR_CALIBRATE_WRITES=0` —
 * what someone shrinking a run to almost nothing would set — handed back the FULL default instead of zero.
 * Explicit zero must mean zero.
 */
function resolveSize(raw, fallback, label) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} is "${raw}"; expected a non-negative integer`);
  }
  return n;
}

/**
 * Decide whether a probe result means "this resource does not exist".
 *
 * THE BUG THIS EXISTS FOR, and it is the most dangerous one in the file. `HeadBucket` answers **403, not
 * 404**, for a bucket you own but cannot `ListBucket`. Reading 403 as "absent" would be catastrophic in
 * `us-east-1`, where `CreateBucket` on a bucket you ALREADY OWN returns **200 OK** rather than an error: the
 * run would proceed into a real bucket of yours and then **delete it on teardown**.
 *
 * So only a genuine not-found counts as absent. Anything else — 403, a throttle, a timeout, a network error —
 * is "cannot prove it is absent", which must abort rather than create.
 */
function probeMeansAbsent(err) {
  if (err === undefined || err === null) return false; // the call succeeded: it exists
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? err?.Code ?? '';
  if (status === 404) return true;
  if (name === 'NotFound' || name === 'NoSuchBucket') return true;
  return false;
}

/**
 * Project the worst-case op count for a phase, as a real upper bound.
 *
 * THE BUG THIS EXISTS FOR: two earlier projections were not bounds. One multiplied writes by 2, leaving the
 * measured count within a single request of the projection; the other gave READS a smaller multiplier than
 * writes, so the read slot always breached first — and it was triggered by setting concurrency above the
 * segment count, which is exactly what someone does to make a run *cheaper*.
 *
 * A projection that the run can exceed is not a ceiling, it is a guess with a ceiling's name on it. Reads are
 * projected at least as high as writes because every write path in this engine reads before it writes.
 */
function projectOps({ loads, reads, chunksPerRead, retryBound }) {
  if (!Number.isInteger(retryBound) || retryBound < 1) {
    throw new Error(`retryBound must be a positive integer, got ${retryBound}`);
  }
  // Each load: the generation PUT, plus a registry GET to resolve and a conditional PUT to advance — and the
  // advance can lose the compare-and-swap and retry, up to the engine's own bound.
  const putPerLoad = 1 + retryBound;
  const getPerLoad = 1 + retryBound;
  const put = loads * putPerLoad;
  // Each read: a registry GET to resolve the current generation, then one GET per chunk it must fetch.
  const getForReads = reads * (1 + chunksPerRead);
  const get = Math.max(loads * getPerLoad + getForReads, put);
  return { put, get };
}

/**
 * Has the run breached its ceiling?
 *
 * Called at phase boundaries AND inside the unbounded phase, because a phase-boundary-only check leaves the
 * one phase whose op count is not known in advance completely unchecked — which is the phase that can run
 * away.
 */
function breached(spentUSD, ceilingUSD) {
  // Written as `>=` rather than `>`: landing exactly on the ceiling is already the ceiling.
  return spentUSD >= ceilingUSD;
}

module.exports = {
  CONFIRM_PHRASE,
  parseCeiling,
  resolveSize,
  probeMeansAbsent,
  projectOps,
  breached,
};
