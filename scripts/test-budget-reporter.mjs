// A vitest reporter that records, for every test and every suite's and file's hooks, how long it ran and the budget
// (timeout) it ran under, into a JSON file that `scripts/test-budget.cjs` judges. CI passes it to the one `pnpm test`
// run it already makes: `pnpm test --reporter=default --reporter=./scripts/test-budget-reporter.mjs`.
//
// WHY. A test that runs close to its time budget fails on a slow runner and passes on the next run, and a failure that
// cannot be reproduced is a flake nobody can diagnose. Tests with no explicit budget run under vitest's default, and
// nothing said how near to it they were until one failed. This puts the share on record for every run.
//
// What is recorded, all from the durations the test workers measured (the main process's own notices of a hook's start
// and end reach it in batches, and a hook's elapsed time read from them was off by up to its whole length):
//   - A test: its duration, against `options.timeout`, which is the timeout in force, the explicit one or the
//     configured default.
//   - A suite's or file's `beforeAll` and `afterAll` hooks together: the suite's duration less its direct children's
//     (tests and nested suites), against the configured `hookTimeout`. Recorded for a suite or file that has such a hook.
// Skipped and todo tests are not recorded. The default file is `node_modules/.cache/test-budget.json` (`TEST_BUDGET_REPORT`
// names another): outside the tracked tree, so a text gate that reads every file there never reads test names.
//
// KNOWN LIMITS.
//   - A test's duration includes its `beforeEach` and `afterEach` hooks (vitest's timeout covers the test body alone, and
//     does not report the hooks' time apart), so a test with a slow each-hook is judged more strictly than its timeout
//     requires: speed the hook up, or give the test a budget by the rule.
//   - The all-hooks time is the sum of a suite's `beforeAll` and `afterAll` hooks, judged against one hook budget, so it
//     is also stricter than a single hook's timeout. Tests of a suite that run concurrently overlap, which can hide hook
//     time (the sum of their durations then exceeds the suite's); no suite here runs concurrently.
//   - A hook given its own timeout is judged against the configured `hookTimeout`; vitest does not report a hook's own.
//     A hook with a longer one is judged too strictly. A hook with a shorter one that runs close to it passes unseen
//     unless it is over half of the configured one: move slow hook work into a test, which is read against its own.
//   - A test or hook whose timeout is 0 (no limit) is not recorded (it is counted as untimed).
//   - The report also carries vitest's own counts of tests run and skipped, read from the finished modules; the judge
//     fails when its own counts do not match them.
//   - A test that retries or repeats is judged by the duration vitest reports for it.
//   - The file is deleted when the run starts, so a run that never finishes leaves none, and the judge refuses a run
//     with no report.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const SCHEMA = 1;

const sumOfChildren = (entity) => {
  let total = 0;
  for (const test of entity.children.tests()) total += test.diagnostic()?.duration ?? 0;
  for (const suite of entity.children.suites()) total += suite.task.result?.duration ?? 0;
  return total;
};

export default class TestBudgetReporter {
  constructor() {
    this.entries = [];
    this.tests = 0;
    this.skipped = 0;
    this.untimed = 0;
  }

  onInit(vitest) {
    this.root = vitest.config.root;
    this.file = resolve(
      this.root,
      process.env.TEST_BUDGET_REPORT || 'node_modules/.cache/test-budget.json',
    );
    rmSync(this.file, { force: true });
  }

  onTestCaseResult(test) {
    const state = test.result().state;
    if (state === 'skipped' || state === 'pending') {
      this.skipped += 1;
      return;
    }
    const diagnostic = test.diagnostic();
    if (!diagnostic) return;
    const budget = test.options.timeout ?? test.project.config.testTimeout;
    this.tests += 1;
    // A timeout of 0 turns the limit off: there is no budget to use a share of.
    if (!(budget > 0)) {
      this.untimed += 1;
      return;
    }
    this.entries.push({
      kind: 'test',
      name: test.fullName,
      file: this.relative(test.module.moduleId),
      duration: Math.round(diagnostic.duration),
      budget,
    });
  }

  onTestSuiteResult(suite) {
    this.hooksOf(suite, suite.fullName, suite.module.moduleId);
  }

  onTestModuleEnd(module) {
    this.hooksOf(module, '(file level)', module.moduleId);
  }

  hooksOf(entity, name, moduleId) {
    const result = entity.task.result;
    const hooks = result?.hooks;
    if (!hooks || !('beforeAll' in hooks || 'afterAll' in hooks)) return;
    if (!(entity.project.config.hookTimeout > 0)) return;
    this.entries.push({
      kind: 'hook',
      hook: 'beforeAll and afterAll',
      name,
      file: this.relative(moduleId),
      duration: Math.round(Math.max(0, (result.duration ?? 0) - sumOfChildren(entity))),
      budget: entity.project.config.hookTimeout,
    });
  }

  // `expected` is vitest's own count of the same run, read from the finished modules: the judge fails when what this
  // reporter recorded does not match it, so a reporter that lost entries cannot pass.
  onTestRunEnd(testModules) {
    const expected = { tests: 0, skipped: 0 };
    for (const module of testModules) {
      for (const test of module.children.allTests()) {
        const state = test.result().state;
        if (state === 'skipped' || state === 'pending') expected.skipped += 1;
        else expected.tests += 1;
      }
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          schema: SCHEMA,
          tests: this.tests,
          skipped: this.skipped,
          untimed: this.untimed,
          expected,
          entries: this.entries,
        },
        null,
        1,
      ) + '\n',
    );
  }

  relative(file) {
    return file.startsWith(this.root) ? file.slice(this.root.length).replace(/^[/\\]/, '') : file;
  }
}
