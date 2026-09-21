import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Every workflow job declares a timeout.
 *
 * WHY THIS EXISTS. GitHub's default is **360 minutes**. A job that hangs — a container that never becomes
 * ready, a registry fetch with no socket timeout, a fuzz target stuck in a loop — therefore burns six hours
 * of runner time before anyone learns anything, and on a matrix it burns that per leg. Nothing about that is
 * visible while jobs are healthy, which is why all eleven were unbounded without anyone noticing.
 *
 * The values are sized to observed durations (roughly 10x), not to the default, so a slow or oversubscribed
 * runner never trips one. The fuzz job is the deliberate exception: its weekly soak budgets 3600s per target,
 * so it is sized to the work rather than to its siblings.
 *
 * This checks only that a bound EXISTS. Whether it is the right number is a judgement a test cannot make —
 * but "someone chose one" is exactly the property that decays silently when a new job is copy-pasted in.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, '.github', 'workflows');

const JOBS = readdirSync(DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .flatMap((file) => {
    const doc = parse(readFileSync(join(DIR, file), 'utf8')) as {
      jobs?: Record<string, { 'timeout-minutes'?: number; uses?: string; environment?: unknown }>;
    };
    return Object.entries(doc.jobs ?? {}).map(([name, job]) => ({ file, name, job }));
  });

describe('every workflow job is time-bounded', () => {
  it('found the workflows, and every one of them contributes a job', () => {
    // Per-FILE rather than a repo-wide count: a magic number sized to today reds this gate the day a job is
    // legitimately retired, for a reason that has nothing to do with timeouts. What actually needs proving is
    // that no workflow silently dropped out of the sweep.
    const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const parsed = JOBS.filter((j) => j.file === file).length;
      expect(
        parsed,
        `${file} contributed no jobs — it failed to parse, or the shape changed`,
      ).toBeGreaterThan(0);
      // Cross-check the PARSED job count against the number of `runs-on:` lines, which is indentation-
      // INDEPENDENT and so survives the failure this is aimed at. A job re-parented underneath another one
      // leaves the file valid YAML, shrinks the sweep, and keeps its own `runs-on:` exactly where it was —
      // so the counts diverge and this fires. (Counting top-level `jobs:` children textually does NOT work:
      // re-parenting re-indents them, so the textual count falls in step with the parsed one and the
      // mismatch disappears.) A legitimately RETIRED job removes its `runs-on:` too, so the counts stay
      // equal and the gate correctly stays quiet — which is the whole reason this is not a fixed number.
      //
      // Not hypothetical: tests/ci/release-workflow.test.ts documents a real edit that re-parented a job
      // under another, and nothing noticed until a tag push.
      const text = readFileSync(join(DIR, file), 'utf8');
      const runsOn = (text.match(/^\s*runs-on:/gm) ?? []).length;
      const runnerJobs = JOBS.filter((j) => j.file === file && j.job.uses === undefined).length;
      expect(
        runnerJobs,
        `${file} has ${runsOn} \`runs-on:\` line(s) but parses to ${runnerJobs} runner job(s) — a job was ` +
          'probably re-parented under another one, which leaves the file valid YAML and silently shrinks ' +
          'this sweep.',
      ).toBe(runsOn);
    }
  });

  it.each(JOBS.map((j) => [`${j.file} / ${j.name}`, j] as const))('%s', (_label, { job }) => {
    // A `uses:` job calls a reusable workflow, which carries its own timeout; there is nothing to set here.
    if (job.uses !== undefined) return;
    const timeout = job['timeout-minutes'];
    expect(
      timeout,
      "declares no timeout-minutes, so it inherits GitHub's 360-minute default. A hang would burn six " +
        "hours per leg before failing. Pick a bound from the job's observed duration.",
    ).toBeDefined();
    expect(typeof timeout).toBe('number');
    // A bound under a few minutes will flake on a cold runner.
    expect(timeout as number).toBeGreaterThanOrEqual(5);
    // The upper bound does NOT apply to a job gated on a deployment environment. Such a job waits for a human
    // reviewer before it runs — a 104.8-minute wait has happened on this repo — and it is not settled whether
    // that waiting window consumes the timeout. Capping those at two hours would risk killing a release mid
    // publish to enforce a tidy number, which is the wrong trade by a wide margin. They still must DECLARE a
    // bound; they are just allowed to choose a long one on purpose.
    if (job.environment === undefined) expect(timeout as number).toBeLessThanOrEqual(120);
  });
});
