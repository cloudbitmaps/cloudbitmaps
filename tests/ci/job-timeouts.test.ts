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
      jobs?: Record<string, { 'timeout-minutes'?: number; uses?: string }>;
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
      expect(
        JOBS.filter((j) => j.file === file).length,
        `${file} contributed no jobs — it failed to parse, or the shape changed`,
      ).toBeGreaterThan(0);
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
    // A bound longer than a couple of hours is the default wearing a number, and one under a minute will
    // flake on a cold runner.
    expect(timeout as number).toBeGreaterThanOrEqual(5);
    expect(timeout as number).toBeLessThanOrEqual(120);
  });
});
