import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The check that fails a test or hook using more than half of its time budget (`scripts/test-budget.cjs`), and the
 * reporter that feeds it (`scripts/test-budget-reporter.mjs`).
 *
 * Two layers. The judge is tried on reports written by hand, each way it can refuse and the look-alikes it must not.
 * The reporter is tried against the real vitest the lockfile pins: one run of planted tests under a 1 s test timeout and
 * a 1 s hook timeout, whose real report is judged, so what the reporter writes and what the judge reads are held to each
 * other on the real tool. `fixtures/test-budget-report.json` is a real report of that run, kept so the judge's reading
 * of the tool's real output is checked without a run, and a test fails when a fresh run no longer matches its shape.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'test-budget.cjs');
const REPORTER = join(ROOT, 'scripts', 'test-budget-reporter.mjs');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'test-budget-report.json');
const judge = createRequire(import.meta.url)(SCRIPT) as {
  parseReport: (text: string) => { entries: Entry[]; tests: number };
  offenders: (doc: { entries: Entry[] }) => (Entry & { share: number })[];
  watched: (doc: { entries: Entry[] }) => (Entry & { share: number })[];
  describe: (e: Entry & { share: number }) => string;
};

type Entry = {
  kind: 'test' | 'hook';
  hook?: string;
  name: string;
  file: string;
  duration: number;
  budget: number;
};

const entry = (over: Partial<Entry> = {}): Entry => ({
  kind: 'test',
  name: 'a test',
  file: 'tests/a.test.ts',
  duration: 100,
  budget: 5000,
  ...over,
});
const report = (entries: Entry[], over: Record<string, unknown> = {}) => {
  const timed = entries.filter((e) => e.kind === 'test').length;
  // A report of hooks alone stands for one more test, that has no limit.
  const tests = timed || 1;
  return JSON.stringify({
    schema: 1,
    tests,
    skipped: 0,
    untimed: tests - timed,
    expected: { tests, skipped: 0 },
    entries,
    ...over,
  });
};
const run = (file: string) =>
  spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', env: { ...process.env } });

describe('the judge, on reports written by hand', () => {
  let dir: string;
  beforeAll(() => {
    mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });
    dir = mkdtempSync(join(ROOT, 'node_modules', '.cache', 'budget-judge-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const judged = (text: string) => {
    const file = join(dir, 'report.json');
    writeFileSync(file, text);
    return run(file);
  };

  it('passes tests under half of their budget, including one exactly at half', () => {
    const r = judged(
      report([
        entry({ duration: 2499 }),
        entry({ duration: 2500 }),
        entry({ duration: 14000, budget: 30000 }),
        entry({ kind: 'hook', hook: 'beforeAll', duration: 4000, budget: 10000 }),
      ]),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('no test or hook over half its budget');
  });

  it('fails a test over half of its budget, naming it with its duration, budget and the fix', () => {
    const r = judged(report([entry({ name: 'slow one', duration: 2501 })]));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slow one: 2501 ms of a 5000 ms budget (50 %)');
    expect(r.stderr).toContain('slowest measured time x 3');
  });

  it('fails a hook over half of the hook budget, and judges an explicit budget by its own size', () => {
    const hook = judged(
      report([entry({ kind: 'hook', hook: 'afterAll', duration: 5001, budget: 10000 })]),
    );
    expect(hook.status).toBe(1);
    expect(hook.stderr).toContain('afterAll hook of a test');
    const explicit = judged(report([entry({ duration: 8000, budget: 15000 })]));
    expect(explicit.status).toBe(1);
  });

  it('fails closed when the report does not match the counts of vitest it carries', () => {
    const two = [entry(), entry({ name: 'b' })];
    // The reporter lost an entry; vitest ran 3 tests.
    const lost = judged(report(two, { tests: 3, expected: { tests: 3, skipped: 0 } }));
    expect(lost.status).toBe(2);
    expect(lost.stderr).toContain('does not match the run');
    // The reporter counted 2 run; vitest counted 3.
    const fewer = judged(report(two, { expected: { tests: 3, skipped: 0 } }));
    expect(fewer.status).toBe(2);
    // Skipped counts disagree.
    expect(judged(report(two, { skipped: 1 })).status).toBe(2);
    // An unjudged (no limit) test is counted, so it does not look like a lost entry.
    const untimed = judged(
      report(two, { tests: 3, untimed: 1, expected: { tests: 3, skipped: 0 } }),
    );
    expect(untimed.status, untimed.stderr).toBe(0);
    expect(untimed.stdout).toContain('1 unjudged');
    expect(judged(report(two)).status).toBe(0);
  });

  it('prints every entry at or above 35 % of its budget on a passing run too, largest first', () => {
    const r = judged(
      report([
        entry({ name: 'at 34 pct', file: 'tests/q.test.ts', duration: 1700 }),
        entry({ name: 'at 35 pct', file: 'tests/b.test.ts', duration: 1750 }),
        entry({ name: 'at 49 pct', file: 'tests/a.test.ts', duration: 2470 }),
        entry({ kind: 'hook', hook: 'afterAll', name: 'a hook', duration: 4000, budget: 10000 }),
      ]),
    );
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('  '));
    expect(lines).toEqual([
      '  tests/a.test.ts: at 49 pct: 2470 ms of a 5000 ms budget (49 %)',
      '  tests/a.test.ts: afterAll hook of a hook: 4000 ms of a 10000 ms budget (40 %)',
      '  tests/b.test.ts: at 35 pct: 1750 ms of a 5000 ms budget (35 %)',
    ]);
    expect(judge.watched(judge.parseReport(report([entry({ duration: 100 })]))).length).toBe(0);
  });

  it('lists every offender, the largest share first', () => {
    const doc = judge.parseReport(
      report([
        entry({ name: 'b', duration: 3000 }),
        entry({ name: 'ok', duration: 10 }),
        entry({ name: 'a', duration: 4000 }),
      ]),
    );
    expect(judge.offenders(doc).map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('fails closed: a missing, empty, unreadable, malformed or wrong-schema report is exit 2, not a pass', () => {
    const missing = run(join(dir, 'nothing-here.json'));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('cannot judge');
    for (const text of [
      '',
      'not json',
      '{}',
      report([entry()], { schema: 2 }),
      report([], { tests: 0 }),
      report([{ ...entry(), budget: 0 }]),
      report([{ ...entry(), duration: 'slow' as unknown as number }]),
      report([{ ...entry(), kind: 'suite' as unknown as 'test' }]),
      report([entry()], { expected: undefined }),
    ]) {
      expect(judged(text).status, text).toBe(2);
    }
  });
});

// Budget 17 s for each test of this block (the default is 5 s): the first one to run starts the real vitest over the planted
// tests, which took 5.4 s on the CI runner and 3 s on a developer machine. Rule: the slowest measured time times three,
// rounded up to the next whole second. The run is started by the first test that asks for it, not by a `beforeAll`,
// because the check judges a hook against the configured hook timeout and cannot see a hook's own.
describe('the reporter, against the real vitest', { timeout: 17_000 }, () => {
  // The planted tests and hooks, under a 1 s test timeout and a 1 s hook timeout (half is 500 ms).
  const PLANT = `
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('default budget, quick', async () => { await sleep(20); });
test('default budget, past half', async () => { await sleep(700); });
test('explicit budget, under half', { timeout: 4000 }, async () => { await sleep(700); });
test('explicit budget, past half', { timeout: 2000 }, async () => { await sleep(1200); });
test('no limit', { timeout: 0 }, async () => { await sleep(700); });
test.skip('skipped', async () => { await sleep(5000); });
describe('slow hooks', () => {
  beforeAll(async () => { await sleep(400); });
  afterAll(async () => { await sleep(300); });
  test('quick body', async () => { await sleep(20); });
});
describe('quick hooks', () => {
  beforeAll(async () => { await sleep(20); });
  afterAll(async () => { await sleep(20); });
  test('quick body too', async () => { await sleep(20); });
});
describe('slow each-hook', () => {
  beforeEach(async () => { await sleep(700); });
  test('quick body', async () => { await sleep(20); });
});
describe('inherited budget', { timeout: 6000 }, () => {
  test('describe-level, under half', async () => { await sleep(800); });
});
`;
  // A file that sets its own test timeout, as many files of this repository do; the 800 ms test is under half of 3 s
  // and over half of the 1 s configured default, so a reading of the default would fail it.
  const PLANT_SETCONFIG = `
import { test, vi } from 'vitest';
vi.setConfig({ testTimeout: 3000 });
test('file-level, under half', async () => { await new Promise((r) => setTimeout(r, 800)); });
`;
  let dir: string;
  let real: { entries: Entry[]; tests: number };
  let judged: ReturnType<typeof run>;

  let started: Promise<void> | undefined;
  const ready = (): Promise<void> => (started ??= start());
  const start = async (): Promise<void> => {
    mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });
    dir = mkdtempSync(join(ROOT, 'node_modules', '.cache', 'budget-real-'));
    writeFileSync(join(dir, 'planted.test.mjs'), PLANT);
    writeFileSync(join(dir, 'setconfig.test.mjs'), PLANT_SETCONFIG);
    writeFileSync(
      join(dir, 'vitest.config.mjs'),
      'export default { test: { testTimeout: 1000, hookTimeout: 1000, include: ["*.test.mjs"] } };\n',
    );
    const out = spawnSync(
      process.execPath,
      [VITEST, 'run', '--root', dir, `--reporter=${REPORTER}`, '--maxWorkers=1'],
      { encoding: 'utf8', env: { ...process.env, TEST_BUDGET_REPORT: join(dir, 'out.json') } },
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    real = judge.parseReport(readFileSync(join(dir, 'out.json'), 'utf8'));
    judged = run(join(dir, 'out.json'));
  };
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const find = (name: string, hook?: string) =>
    real.entries.find((e) => (e.name === name || e.name.endsWith(` ${name}`)) && e.hook === hook);

  it('records each test with the budget in force: the configured default, or its own explicit one', async () => {
    await ready();
    expect(find('default budget, quick')?.budget).toBe(1000);
    expect(find('explicit budget, under half')?.budget).toBe(4000);
    expect(find('explicit budget, past half')?.budget).toBe(2000);
    expect(find('file-level, under half')?.budget).toBe(3000);
    expect(find('inherited budget > describe-level, under half')?.budget).toBe(6000);
    expect(real.tests).toBe(10);
    expect(real.entries.some((e) => e.name === 'no limit')).toBe(false);
    expect(real.entries.some((e) => e.name.includes('skipped'))).toBe(false);
  });

  it('records the hooks of a suite against the hook timeout, and only for a suite that has hooks', async () => {
    await ready();
    const slow = find('slow hooks', 'beforeAll and afterAll');
    expect(slow?.budget).toBe(1000);
    expect(slow?.duration).toBeGreaterThanOrEqual(690);
    expect(slow?.duration).toBeLessThan(1500);
    expect(find('quick hooks', 'beforeAll and afterAll')?.duration).toBeLessThan(500);
    expect(real.entries.filter((e) => e.kind === 'hook').length).toBe(2);
  });

  it('counts the each-hook of a test in the test, which vitest does not report apart', async () => {
    await ready();
    expect(find('slow each-hook > quick body')?.duration).toBeGreaterThanOrEqual(700);
  });

  it('fails the planted tests that sleep past half of their budget, and the slow hooks', async () => {
    await ready();
    expect(judged.status, judged.stdout).toBe(1);
    expect(judged.stderr).toContain('default budget, past half');
    expect(judged.stderr).toContain('explicit budget, past half');
    expect(judged.stderr).toContain('beforeAll and afterAll hook of slow hooks');
    expect(judged.stderr).toContain('slow each-hook > quick body');
  });

  it('passes a test with an explicit budget that it uses under half of, quick tests and quick hooks', async () => {
    await ready();
    expect(judged.stderr).not.toContain('explicit budget, under half');
    expect(judged.stderr).not.toContain('file-level, under half');
    expect(judged.stderr).not.toContain('describe-level, under half');
    expect(judged.stderr).not.toContain('default budget, quick');
    expect(judged.stderr).not.toContain('quick hooks');
    expect(judged.stderr).not.toContain('quick body too');
  });

  it('writes the shape the committed real report has', async () => {
    await ready();
    const committed = judge.parseReport(readFileSync(FIXTURE, 'utf8'));
    const shape = (doc: { entries: Entry[] }) =>
      doc.entries.map((e) => [e.kind, e.hook ?? '', e.name, e.file, e.budget]).sort();
    expect(shape(real)).toEqual(shape(committed));
  });
});

describe('the committed real report', () => {
  it('is judged as the planted run was: those that sleep past half fail, the rest do not', () => {
    const doc = judge.parseReport(readFileSync(FIXTURE, 'utf8'));
    const names = judge.offenders(doc).map((e) => `${e.hook ?? ''} ${e.name}`.trim());
    expect(names.sort()).toEqual(
      [
        'default budget, past half',
        'explicit budget, past half',
        'beforeAll and afterAll slow hooks',
        'slow each-hook > quick body',
      ].sort(),
    );
  });
});

describe('where it runs', () => {
  it('wires the reporter into the one `pnpm test` run of the CI test job, and the judge after it, with no second run', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const lines = ci.split('\n');
    const run = lines.findIndex((l) =>
      /^\s+- run: pnpm test --reporter=default --reporter=\.\/scripts\/test-budget-reporter\.mjs\s*$/.test(
        l,
      ),
    );
    expect(run, 'the pnpm test step carries the reporter').toBeGreaterThan(0);
    expect(lines.filter((l) => /- run: pnpm test(\s|$)/.test(l)).length).toBe(1);
    expect(ci).toMatch(/- run: node scripts\/test-budget\.cjs\s*$/m);
  });

  it('is not in the release workflow', () => {
    const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(release).not.toContain('test-budget');
  });
});
