import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Guards the SHAPE of the release workflow, which is a safety property and not a style preference.
//
// This exists because a real edit silently broke it. Adding the `github-release` job used a Python
// `replace(anchor, ..., 1)` whose anchor — `NPM_CONFIG_PROVENANCE: true` — appears TWICE in the file, once
// under the dry-run step and once under the real one. The replacement hit the first, so the new job was
// inserted BETWEEN the two publish steps, and YAML re-parented `Publish (real)` into `github-release`.
//
// Nothing caught it. The file still parsed, the job names were still right, and a shallow check that listed
// job names and permissions passed. The failure only appeared on a real tag: `github-release` has no pnpm, so
// the publish step died with `pnpm: command not found` — after the release object had already been created for
// a version that never reached npm. Exactly the state `needs: publish` exists to prevent, defeated by the step
// living in the wrong job.
//
// So the assertions below are about job MEMBERSHIP and PERMISSIONS, not the presence of strings.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
}

const wf = parse(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};

/** Fetch a job by name, failing loudly if it vanished — a missing job is itself a regression. */
function job(name: string): Job {
  const j = wf.jobs[name];
  if (!j) throw new Error(`release.yml has no "${name}" job`);
  return j;
}
const stepNames = (j: Job) => j.steps.map((s) => s.name ?? s.uses ?? s.run ?? '');
const hasStep = (j: Job, name: string) => stepNames(j).some((n) => n === name);

describe('release workflow shape', () => {
  it('has exactly the two jobs, and github-release depends on publish', () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(['github-release', 'publish']);
    expect(job('github-release').needs).toBe('publish');
  });

  it('publishes ONLY from the publish job', () => {
    // The precise regression: `Publish (real)` ended up in github-release.
    expect(hasStep(job('publish'), 'Publish (real)')).toBe(true);
    expect(hasStep(job('publish'), 'Publish (dry-run)')).toBe(true);
    expect(hasStep(job('github-release'), 'Publish (real)')).toBe(false);

    const publishesElsewhere = Object.entries(wf.jobs)
      .filter(([name]) => name !== 'publish')
      .flatMap(([name, job]) => job.steps.map((s) => [name, s.run ?? ''] as const))
      .filter(([, run]) => /\bpublish\b/.test(run) && !/gh release/.test(run));
    expect(publishesElsewhere).toEqual([]);
  });

  it('keeps contents:write off the job that publishes', () => {
    // SECURITY.md promises the publish job carries only the OIDC token. If that stops being true the
    // statement in the docs becomes false, which is worse than never having claimed it.
    expect(job('publish').permissions?.contents).not.toBe('write');
    expect(job('github-release').permissions?.contents).toBe('write');
  });

  it('every job that runs pnpm also installs pnpm', () => {
    // The actual failure mode: a job inherited a pnpm step without pnpm/action-setup.
    for (const [name, job] of Object.entries(wf.jobs)) {
      const usesPnpm = job.steps.some((s) => /(^|\s)pnpm\s/.test(s.run ?? ''));
      if (!usesPnpm) continue;
      const setsUpPnpm = job.steps.some((s) => (s.uses ?? '').startsWith('pnpm/action-setup'));
      expect(setsUpPnpm, `job "${name}" runs pnpm without pnpm/action-setup`).toBe(true);
    }
  });

  it('gates the real publish on a tag push or an explicit non-dry-run dispatch', () => {
    const real = job('publish').steps.find((s) => s.name === 'Publish (real)');
    expect(real?.run).toMatch(/--provenance/);
    // Guards that a dispatch cannot publish while dryRun is still true.
    expect(String((real as unknown as { if: string }).if)).toContain("github.event_name == 'push'");
    expect(String((real as unknown as { if: string }).if)).toContain('!inputs.dryRun');
  });

  it('keeps the tag/version and still-private guards ahead of publishing', () => {
    const names = stepNames(job('publish'));
    const iTag = names.indexOf('Verify tag matches every package version');
    const iPriv = names.indexOf('Refuse to "publish" a still-private package');
    const iReal = names.indexOf('Publish (real)');
    expect(iTag).toBeGreaterThan(-1);
    expect(iPriv).toBeGreaterThan(-1);
    expect(iTag).toBeLessThan(iReal);
    expect(iPriv).toBeLessThan(iReal);
  });
});
