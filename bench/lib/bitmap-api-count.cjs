/*
 * The count kernels' decision, as the count kernels' own bench states it. The bitmap bench does not recompute whether
 * the count kernels beat build-then-count: `node bench/count-kernels.cjs --gate` judges its record and ends with one
 * line, `RESULT kept`, `RESULT derived` or `RESULT invalid` (and a reason after a colon). This module reads that line.
 * A run that prints no such line (a checkout whose count bench does not state one) is `unavailable`, and a decision
 * that is not `kept` or `derived` decides nothing, so a caller treats it as a refusal.
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** The decision a gate's output states: `kept`, `derived`, `invalid`, or `unavailable` when no RESULT line is last. */
function parseResult(output) {
  const lines = String(output)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const last = lines[lines.length - 1] ?? '';
  const m = /^RESULT (kept|derived|invalid)\b/.exec(last);
  return m === null ? 'unavailable' : m[1];
}

/** Runs the count bench's gate over its record in `root` and returns its decision (see `parseResult`). */
function readResult(root) {
  const ran = spawnSync(
    process.execPath,
    [path.join(root, 'bench', 'count-kernels.cjs'), '--gate'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, COUNT_RESULTS: '' },
      timeout: 120000,
    },
  );
  return ran.error === undefined ? parseResult(ran.stdout) : 'unavailable';
}

module.exports = { parseResult, readResult };
