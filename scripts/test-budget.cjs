#!/usr/bin/env node
'use strict';
// `node scripts/test-budget.cjs [report]`: fails when a test, or a hook, used more than half of its time budget.
//
// WHY. A test that runs close to its budget fails on a slow runner and passes on the next run: three timing failures in
// one day were tests that ran at most a few times faster than vitest's 5 s default, which none of them had set
// explicitly. Reading the share of every test on every run turns that into a failure on the pull request that makes a
// test slow, with the test named, instead of an unrelated run that goes red later.
//
// The report comes from `scripts/test-budget-reporter.mjs`, which CI adds to the one `pnpm test` run it already makes
// (the default report is `node_modules/.cache/test-budget.json`; `TEST_BUDGET_REPORT` or the argument names another). A test is
// judged against the timeout in force for it, its explicit one or the configured default; a suite's or file's
// beforeAll and afterAll hooks, together, against the configured hook timeout. It fails, naming each offender with its duration, budget and share, when duration > 0.5 x budget.
//
// THE FIX it asks for is the repository's budget rule: an explicit budget is the slowest measured time x 3, rounded up,
// and never below vitest's default (a test whose time scales with load gets 15 s); or make the test faster. A budget
// of three times the slowest time puts the share at a third, under the half this check allows.
//
// Exit 0: every entry is within half of its budget. 1: at least one is over. 2: the report is missing, unreadable,
// malformed or empty, so nothing was judged (the check fails closed: a run that wrote no report is not a pass).
//
// KNOWN LIMITS.
//   - Timing varies by runner. The half is the margin: a test at 40 % on one runner can be at 80 % on a slower one, and
//     a test that is only sometimes slow (a cold cache, a busy runner) can pass this check and still fail a run. Such a
//     test needs its budget set by the rule above, from its slowest time seen in CI, not from the run that passed.
//   - A test's time includes its beforeEach and afterEach hooks, and a suite's beforeAll and afterAll hooks are judged
//     together against one hook budget; both are stricter than the timeouts they stand for (see the reporter), and a
//     hook given its own timeout is judged against the configured one.
//   - It judges what ran. A test skipped on this machine (it needs a built package, say) is not timed.
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;
const SHARE = 0.5;
const FIX =
  "Fix: set an explicit budget of the slowest measured time x 3, rounded up and never below vitest's default (15 s " +
  'for a test whose time scales with load), or make the test faster.';

/** Parses a report's text, throwing an Error that says why it cannot be judged. */
function parseReport(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`the report is not valid JSON (${e.message})`, { cause: e });
  }
  if (!doc || typeof doc !== 'object' || doc.schema !== SCHEMA) {
    throw new Error(`the report does not carry schema ${SCHEMA}`);
  }
  if (!Array.isArray(doc.entries) || doc.entries.length === 0 || !(doc.tests > 0)) {
    throw new Error('the report holds no test, so nothing was judged');
  }
  for (const [i, e] of doc.entries.entries()) {
    const ok =
      e &&
      (e.kind === 'test' || e.kind === 'hook') &&
      typeof e.name === 'string' &&
      typeof e.file === 'string' &&
      Number.isFinite(e.duration) &&
      e.duration >= 0 &&
      Number.isFinite(e.budget) &&
      e.budget > 0;
    if (!ok) throw new Error(`entry ${i} of the report is malformed`);
  }
  return doc;
}

/** The entries of a parsed report that used more than half of their budget, slowest share first. */
function offenders(doc) {
  return doc.entries
    .filter((e) => e.duration > SHARE * e.budget)
    .map((e) => ({ ...e, share: e.duration / e.budget }))
    .sort((a, b) => b.share - a.share);
}

/** One line for an offender. */
function describe(e) {
  const what = e.kind === 'hook' ? `${e.hook} hook of ${e.name}` : e.name;
  return `${e.file}: ${what}: ${e.duration} ms of a ${e.budget} ms budget (${Math.round(e.share * 100)} %)`;
}

function main(argv) {
  const file = path.resolve(
    argv[0] ||
      process.env.TEST_BUDGET_REPORT ||
      path.join(__dirname, '..', 'node_modules', '.cache', 'test-budget.json'),
  );
  let doc;
  try {
    doc = parseReport(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`test-budget: cannot judge ${file}: ${e.message}`);
    return 2;
  }
  const over = offenders(doc);
  if (over.length === 0) {
    console.log(`test-budget: ${doc.tests} tests, no test or hook over half its budget`);
    return 0;
  }
  console.error(`test-budget: ${over.length} used more than half of their time budget:`);
  for (const e of over) console.error(`  ${describe(e)}`);
  console.error(FIX);
  return 1;
}

module.exports = { parseReport, offenders, describe, SHARE, SCHEMA };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
