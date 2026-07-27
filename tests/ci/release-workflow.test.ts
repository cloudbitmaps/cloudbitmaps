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
  environment?: string;
  'runs-on'?: string;
  steps: Step[];
}

const wf = parse(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};

/** Fetch a job by name, failing loudly if it vanished — a missing job is itself a regression. */
function job(name: string): Job {
  const j = wf.jobs[name];
  if (!j) throw new Error(`release.yml has no "${name}" job`);
  return j;
}
/** Permissions as GitHub actually resolves them: job-level block wins, else the workflow-level one. */
function effectivePermissions(name: string): Record<string, string> {
  return job(name).permissions ?? wf.permissions ?? {};
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

  it('keeps contents:write off the job that publishes — EFFECTIVE, not just job-level', () => {
    // The first version of this test read `job('publish').permissions?.contents`, which is `undefined`
    // because the publish job declares no job-level block — so `.not.toBe('write')` passed without
    // inspecting anything. A `contents: write` added at the WORKFLOW level would be inherited by the
    // publish job and this test would still have been green, which is the exact opposite of its purpose.
    // Permissions resolve job-level first, falling back to workflow-level, so the assertion must too.
    expect(effectivePermissions('publish').contents).not.toBe('write');
    expect(effectivePermissions('github-release').contents).toBe('write');
    // The publish job's whole justification is that it holds the OIDC token and nothing else.
    expect(effectivePermissions('publish')['id-token']).toBe('write');
  });

  it('keeps the human approval gate wired to the publish job', () => {
    // `environment: release` is the single line that makes a publish require a reviewer, and RELEASING.md
    // calls it "the last point at which a release can be stopped". Deleting it fails SILENTLY: every other
    // test stays green, CI is green, and the next tag publishes with no prompt — and a run that never
    // pauses is indistinguishable from one whose reviewer approved quickly. Worse than a red job.
    expect(job('publish').environment).toBe('release');
  });

  it('publishes only from a GitHub-hosted runner, because provenance needs its OIDC identity', () => {
    // A self-hosted runner has no OIDC identity to attest to, so the publish would succeed and silently
    // lose the attestation — RELEASING.md lists exactly this as a symptom.
    expect(job('publish')['runs-on']).toBe('ubuntu-latest');
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

  it('runs EVERY recoverable precondition before the irreversible step', () => {
    // The ordering rule this file exists to defend, stated once for all of them: an npm publish cannot be
    // undone outside a 72-hour window, so anything that can still be FIXED has to fail first. The release-notes
    // check is the newest member and the most instructive — it lives in `github-release`, which by
    // construction runs after the publish, so without a precondition here a missing CHANGELOG section is only
    // ever discovered once nothing can be done about it. That is the same shape as the bug that once created a
    // GitHub Release for a version that never published, just pointing the other way.
    const names = stepNames(job('publish'));
    const iReal = names.indexOf('Publish (real)');
    expect(iReal).toBeGreaterThan(-1);
    for (const precondition of [
      'Require release notes to exist before publishing',
      'Leak-scan the packed tarballs',
      'node scripts/audit.cjs',
      'Verify tag matches every package version',
      'Refuse to "publish" a still-private package',
    ]) {
      const i = names.indexOf(precondition);
      expect(i, `"${precondition}" is missing from the publish job`).toBeGreaterThan(-1);
      expect(i, `"${precondition}" must run before Publish (real)`).toBeLessThan(iReal);
    }
  });

  it('audits dependencies on the release commit, not just on a green main', () => {
    // The audit is the ONE gate whose verdict changes with no commit: an advisory published after main went
    // green makes this exact tree newly-vulnerable. Re-running lint/test/build on the release commit while
    // trusting a days-old audit would leave precisely that hole open.
    expect(job('publish').steps.some((s) => (s.run ?? '').includes('scripts/audit.cjs'))).toBe(
      true,
    );
  });

  it('scans the packed tarballs, which is the only artifact the other leak-scan modes cannot see', () => {
    // dist/ is gitignored, so neither the tracked-file nor the history enumeration covers the bytes a consumer
    // actually downloads — and sourcemaps carry every src comment verbatim via sourcesContent.
    const step = job('publish').steps.find((s) => s.name === 'Leak-scan the packed tarballs');
    expect(step?.run).toContain('leak-scan-tarballs');
    // No `if:` — a dry run exists to prove the pipeline, so it must exercise the gates rather than skip them.
    expect((step as unknown as { if?: string }).if).toBeUndefined();
  });

  it('pins the npm upgrade to a floor instead of tracking @latest', () => {
    // `npm@latest` makes every release depend on whatever npm shipped that morning: a regression upstream
    // becomes a broken release with nothing in our diff to point at.
    const step = job('publish').steps.find((s) => s.name === 'Upgrade npm for Trusted Publishing');
    expect(step?.run).not.toMatch(/npm@latest/);
    // Still at or above the version Trusted Publishing (OIDC) requires.
    expect(step?.run).toMatch(/npm@\^11\.(?:[6-9]|5\.[1-9])/);
  });

  it('never cancels a release in flight', () => {
    // Opposite of the CI workflow on purpose. Cancelling a build is free; cancelling a release between the
    // publish of core and of roaring leaves npm holding a half-published family that cannot be unpublished.
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    expect(wf.concurrency?.group).toBeTruthy();
  });

  it('guards the packages/* glob against matching nothing', () => {
    // An unmatched glob expands to the LITERAL string in bash, so the loop would run once on a path that does
    // not exist rather than zero times — a rename of packages/ would turn both guards into theatre.
    for (const name of [
      'Verify tag matches every package version',
      'Refuse to "publish" a still-private package',
    ]) {
      const run = job('publish').steps.find((s) => s.name === name)?.run ?? '';
      expect(run, `${name} must set nullglob`).toContain('shopt -s nullglob');
      expect(run, `${name} must assert the match count`).toMatch(/\$\{#pkgs\[@\]\}/);
    }
  });
});
