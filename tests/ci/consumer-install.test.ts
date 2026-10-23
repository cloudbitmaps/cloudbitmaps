import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Holds the consumer install in place: a pull request job that packs the six packages and installs the tarballs
// into a clean project, and the same step in the release before anything is published.
//
// Neither can be seen to be missing. Every other check passes without them, because none of the others reads a
// tarball: the workspace links packages in place, so a file missing from `files` or a `workspace:*` left in a
// manifest breaks nothing until a user installs. A job deleted or demoted to `continue-on-error` leaves CI green.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
}
interface Job {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  strategy?: { matrix?: { node?: number[] }; 'fail-fast'?: boolean };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const load = (file: string) =>
  parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as Workflow;
const ci = load('ci.yml');
const release = load('release.yml');
const SCRIPT = 'node scripts/consumer-install.cjs';

describe('the consumer install runs in CI', () => {
  const job = ci.jobs['consumer-install'];

  it('is a job of the workflow that runs on pull requests', () => {
    expect(job, 'ci.yml has no consumer-install job').toBeDefined();
    expect(Object.keys(ci.on)).toContain('pull_request');
  });

  it('runs the script on Linux, on Node 22 and 24, and cannot be made advisory', () => {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.strategy?.matrix?.node).toEqual([22, 24]);
    expect(job['continue-on-error']).toBeUndefined();
    const step = job.steps.find((s) => s.run === SCRIPT);
    expect(step, `no step runs "${SCRIPT}"`).toBeDefined();
    expect(step?.if, 'the step must run on every pull request').toBeUndefined();
  });

  it('installs pnpm and the dependencies before it, and stays inside a time bound', () => {
    const names = job.steps.map((s) => s.uses ?? s.run ?? '');
    const iScript = names.indexOf(SCRIPT);
    expect(names.findIndex((n) => n.startsWith('pnpm/action-setup'))).toBeLessThan(iScript);
    expect(names.indexOf('pnpm install --frozen-lockfile')).toBeGreaterThan(-1);
    expect(names.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(iScript);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(20);
  });
});

describe('the consumer install runs before a release publishes', () => {
  const steps = release.jobs['publish'].steps;
  const names = steps.map((s) => s.name ?? s.uses ?? s.run ?? '');
  const NAME = 'Install the packed packages as a consumer';

  it('has the step, with no condition, so a dry run exercises it too', () => {
    const step = steps.find((s) => s.name === NAME);
    expect(step?.run).toBe(SCRIPT);
    expect(step?.if).toBeUndefined();
  });

  it('runs after the workspace checks and before either publish', () => {
    const i = names.indexOf(NAME);
    expect(i).toBeGreaterThan(names.indexOf('pnpm build'));
    expect(i).toBeLessThan(names.indexOf('Publish (dry-run)'));
    expect(i).toBeLessThan(names.indexOf('Publish (real)'));
  });
});
