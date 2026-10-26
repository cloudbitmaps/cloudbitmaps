import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Guards the SHAPE of the release workflow, which is a safety property and not a style preference.
//
// The shape can break with every other check green. `NPM_CONFIG_PROVENANCE: true` appears TWICE in the file,
// once under the dry-run step and once under the real one, so an edit anchored on it can land a job
// (`github-release`, say) BETWEEN the two publish steps, and YAML then re-parents `Publish (real)` into it.
//
// Nothing else catches it. The file still parses, the job names are still right, and a shallow check that
// lists job names and permissions passes. The failure appears only on a real tag: `github-release` has no
// pnpm, so a publish step inside it dies with `pnpm: command not found` — after the release object has been
// created for a version that never reaches npm. Exactly the state `needs: publish` exists to prevent,
// defeated by the step living in the wrong job.
//
// So the assertions below are about job MEMBERSHIP and PERMISSIONS, not the presence of strings.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  if?: string;
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
  env?: Record<string, unknown>;
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
    // The shape described at the top: `Publish (real)` re-parented into github-release.
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
    // Read at the job level alone, `job('publish').permissions?.contents` is `undefined`, because the publish
    // job declares no job-level block — so `.not.toBe('write')` passes without inspecting anything, and a
    // `contents: write` added at the WORKFLOW level, which the publish job inherits, leaves it green: the
    // exact opposite of its purpose. Permissions resolve job-level first, falling back to workflow-level, so
    // the assertion must too.
    expect(effectivePermissions('publish').contents).not.toBe('write');
    expect(effectivePermissions('github-release').contents).toBe('write');
    // The publish job's whole justification is that it holds the OIDC token and nothing else.
    expect(effectivePermissions('publish')['id-token']).toBe('write');
  });

  it('keeps the human approval gate wired to the publish job', () => {
    // `environment: release` is the single line that makes a publish require a reviewer, and RELEASING.md
    // says of that approval that "nothing reaches npm before it". Deleting it fails SILENTLY: every other
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
    // The failure mode described at the top: a job holding a pnpm step without pnpm/action-setup.
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

  it('verifies the native oracle binary it installs before any test loads it', () => {
    const runs = job('publish').steps.map((s) => s.run ?? '');
    const iInstall = runs.findIndex((r) => /^pnpm install\b/.test(r));
    const iVerify = runs.findIndex((r) =>
      /^node scripts\/verify-roaring-prebuilt\.cjs --strict$/.test(r),
    );
    const iTest = runs.findIndex((r) => /^pnpm test$/.test(r));
    expect(iInstall, 'the install step is missing').toBeGreaterThan(-1);
    expect(iVerify, 'the strict checksum step is missing').toBeGreaterThan(iInstall);
    expect(iVerify).toBeLessThan(iTest);
  });

  it('runs EVERY recoverable precondition before the irreversible step', () => {
    // The ordering rule this file exists to defend, stated once for all of them: an npm publish cannot be
    // undone outside a 72-hour window, so anything that can still be FIXED has to fail first. The
    // release-notes check is the most instructive — the notes are extracted in `github-release`, which by
    // construction runs after the publish, so without a precondition here a missing CHANGELOG section is only
    // ever discovered once nothing can be done about it. That is the shape described at the top, a GitHub
    // Release for a version that never published, pointing the other way.
    const names = stepNames(job('publish'));
    const iReal = names.indexOf('Publish (real)');
    expect(iReal).toBeGreaterThan(-1);
    for (const precondition of [
      'Require release notes to exist before publishing',
      'Leak-scan the packed tarballs',
      'node scripts/audit.cjs',
      'Verify tag matches every package version',
      'Refuse to "publish" a still-private package',
      'Refuse to publish an unbootstrapped name or a version already on the registry',
    ]) {
      const i = names.indexOf(precondition);
      expect(i, `"${precondition}" is missing from the publish job`).toBeGreaterThan(-1);
      expect(i, `"${precondition}" must run before Publish (real)`).toBeLessThan(iReal);
    }
  });

  it('probes the registry before publishing, for both partial-release shapes', () => {
    // Both failures produce a PARTIAL release of a lockstep family, and neither shows up in the log: a name
    // with no Trusted Publisher cannot be published by this tokenless workflow at all (it would publish the
    // packages that DO exist, then fail), and a version already on the registry is SKIPPED by pnpm with
    // exit 0, so the run goes green having published nothing for that package. Both are read-only probes,
    // so they belong ahead of the irreversible step rather than in a runbook.
    const step = job('publish').steps.find(
      (s) =>
        s.name === 'Refuse to publish an unbootstrapped name or a version already on the registry',
    );
    expect(step, 'the registry precondition is missing').toBeDefined();
    // Two different checks; asserting only one would let the other be deleted silently.
    expect(step?.run).toMatch(/npm view "\$NAME" version/);
    expect(step?.run).toMatch(/npm view "\$NAME@\$VER" version/);
    // It must cover the dispatch path too — that is the one the tag guard is documented as skipping.
    const cond = String((step as unknown as { if?: string }).if ?? '');
    expect(cond).toContain("github.event_name == 'push'");
    expect(cond).toContain('!inputs.dryRun');
  });

  it('audits dependencies on the release commit, not just on a green main', () => {
    // The audit is the ONE gate whose verdict changes with no commit: an advisory published after main went
    // green makes this exact tree newly-vulnerable. Re-running lint/test/build on the release commit while
    // trusting a days-old audit would leave precisely that hole open.
    expect(job('publish').steps.some((s) => (s.run ?? '').includes('scripts/audit.cjs'))).toBe(
      true,
    );
  });

  it('checks out the whole history, because the suite it runs reads the history of a file', () => {
    // `calibration-reports` proves each committed calibration evidence file was written once and never edited,
    // which reads the file's history out of git, and a shallow checkout carries none. It fails loudly rather
    // than passing vacuously, so this job, which re-runs the complete gate, checks out as `ci.yml` does.
    const checkout = job('publish').steps.find((s) => (s.uses ?? '').includes('actions/checkout'));
    expect(checkout, 'the publish job no longer checks out').toBeDefined();
    expect(
      (checkout as unknown as { with?: { 'fetch-depth'?: number } }).with?.['fetch-depth'],
      'release.yml must check out with fetch-depth: 0 — a shallow clone has no history, and the suite this ' +
        'job runs includes a gate that reads it',
    ).toBe(0);
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
    // Opposite of the CI workflow on purpose. Cancelling a build is free; cancelling a release part-way
    // through leaves npm holding a half-published family that cannot be unpublished.
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    expect(wf.concurrency?.group).toBeTruthy();
  });

  it('guards the packages/* glob against matching nothing', () => {
    // An unmatched glob expands to the LITERAL string in bash, so the loop would run once on a path that does
    // not exist rather than zero times — a rename of packages/ would turn both guards into theatre.
    for (const name of [
      'Verify tag matches every package version',
      'Refuse to "publish" a still-private package',
      'Refuse to publish an unbootstrapped name or a version already on the registry',
    ]) {
      const run = job('publish').steps.find((s) => s.name === name)?.run ?? '';
      expect(run, `${name} must set nullglob`).toContain('shopt -s nullglob');
      expect(run, `${name} must assert the match count`).toMatch(/\$\{#pkgs\[@\]\}/);
      // The COMPARISON specifically, not just a mention: the error message also interpolates the variable,
      // so a `toContain` over the whole block stays green when the `-lt` compares against a literal.
      expect(run, `${name} must compare the count against EXPECTED_PACKAGES`).toMatch(
        /-lt\s+"\$EXPECTED_PACKAGES"/,
      );
    }
  });

  describe('a real publish runs only from a version tag', () => {
    type Ctx = { event: 'push' | 'workflow_dispatch'; ref: string; dryRun: boolean };
    const tagPush: Ctx = { event: 'push', ref: 'refs/tags/v1.2.3', dryRun: false };
    const tagDispatchReal: Ctx = {
      event: 'workflow_dispatch',
      ref: 'refs/tags/v1.2.3',
      dryRun: false,
    };
    const tagDispatchDry: Ctx = {
      event: 'workflow_dispatch',
      ref: 'refs/tags/v1.2.3',
      dryRun: true,
    };
    const branchDispatchReal: Ctx = {
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      dryRun: false,
    };
    const branchDispatchDry: Ctx = {
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      dryRun: true,
    };
    const allContexts = [
      tagPush,
      tagDispatchReal,
      tagDispatchDry,
      branchDispatchReal,
      branchDispatchDry,
    ];

    /** Evaluate a step's `if:` for one trigger. The grammar is the small one this workflow uses; anything else throws. */
    function runs(step: Step, ctx: Ctx): boolean {
      if (step.if === undefined) return true;
      const expr = String(step.if);
      const js = expr.replace(
        /startsWith\(\s*github\.ref\s*,\s*('[^']*')\s*\)/g,
        'ref.startsWith($1)',
      );
      const rest = js
        .replace(/ref\.startsWith\('[^']*'\)/g, '')
        .replace(/github\.event_name|inputs\.dryRun|'[^']*'|==|&&|\|\||!|[()\s]/g, '');
      if (rest !== '') throw new Error(`unsupported if expression: ${expr}`);
      const fn = new Function(
        'ref',
        'github',
        'inputs',
        `return Boolean(${js.replace(/github\.ref/g, 'ref')});`,
      ) as (ref: string, github: object, inputs: object) => boolean;
      return fn(ctx.ref, { event_name: ctx.event }, { dryRun: ctx.dryRun });
    }
    const named = (n: string): Step => {
      const s = job('publish').steps.find((x) => x.name === n);
      if (!s) throw new Error(`the publish job has no step "${n}"`);
      return s;
    };

    it('runs every publish-capable step only on a tag ref', () => {
      // A step is publish-capable when it publishes for real (a `publish` command without --dry-run) or is
      // one of the guards that exist only for a real publish. The job holds `id-token: write`, so these are
      // the steps that can use it to publish.
      const capable = job('publish').steps.filter(
        (s) =>
          (/^(pnpm|npm)\b.*\bpublish\b/.test(s.run ?? '') && !/--dry-run/.test(s.run ?? '')) ||
          s.name === 'Refuse to "publish" a still-private package' ||
          s.name ===
            'Refuse to publish an unbootstrapped name or a version already on the registry',
      );
      expect(capable.map((s) => s.name)).toContain('Publish (real)');
      for (const step of capable) {
        for (const ctx of allContexts) {
          if (!ctx.ref.startsWith('refs/tags/v')) {
            expect(
              runs(step, ctx),
              `"${step.name}" must not run on ${ctx.ref} (${ctx.event})`,
            ).toBe(false);
          }
        }
      }
    });

    it('publishes for real on a tag push or a tag dispatch with dryRun=false, never on a dry run', () => {
      const real = named('Publish (real)');
      expect(runs(real, tagPush)).toBe(true);
      expect(runs(real, tagDispatchReal)).toBe(true);
      expect(runs(real, tagDispatchDry)).toBe(false);
      expect(runs(real, branchDispatchReal)).toBe(false);
      expect(runs(real, branchDispatchDry)).toBe(false);
    });

    it('runs the tag/version check on every tag ref, including a dispatch with dryRun=false', () => {
      const check = named('Verify tag matches every package version');
      for (const ctx of [tagPush, tagDispatchReal, tagDispatchDry])
        expect(runs(check, ctx)).toBe(true);
      for (const ctx of [branchDispatchReal, branchDispatchDry])
        expect(runs(check, ctx)).toBe(false);
    });

    it('fails a branch dispatch with dryRun=false before checkout, install and build', () => {
      const steps = job('publish').steps;
      const failing = steps.findIndex(
        (s) =>
          /\bexit 1\b/.test(s.run ?? '') &&
          runs(s, branchDispatchReal) &&
          !allContexts.filter((c) => c !== branchDispatchReal).some((c) => runs(s, c)),
      );
      expect(failing, 'no step fails a branch dispatch with dryRun=false').toBeGreaterThan(-1);
      const firstWork = steps.findIndex((s) => s.uses !== undefined || /^pnpm /.test(s.run ?? ''));
      expect(failing).toBeLessThan(firstWork);
    });

    it('still dry-runs from a branch, with the guard quiet', () => {
      const dry = named('Publish (dry-run)');
      expect(runs(dry, branchDispatchDry)).toBe(true);
      expect(runs(dry, tagDispatchDry)).toBe(true);
      expect(runs(dry, branchDispatchReal)).toBe(false);
      expect(runs(dry, tagPush)).toBe(false);
      // Nothing that fails a run starts on a dry run from a branch.
      for (const s of job('publish').steps.filter(
        (x) => /\bexit 1\b/.test(x.run ?? '') && x.if !== undefined && /dryRun/.test(x.if),
      )) {
        expect(
          runs(s, branchDispatchDry),
          `"${s.name}" must not run on a dry run from a branch`,
        ).toBe(false);
      }
    });

    it('passes no event text into a run script', () => {
      for (const s of Object.values(wf.jobs).flatMap((j) => j.steps)) {
        expect(s.run ?? '').not.toMatch(/\$\{\{\s*github\.event\./);
      }
    });
  });

  it('expects as many package manifests as the workspace actually has', () => {
    // A hardcoded count goes stale when a package is added: a count of `2` in a six-package workspace passes
    // a tag that ships core and roaring and silently leaves the driver packages and the tools behind — a PARTIAL
    // publish of a family that releases in lockstep, which is the one npm state that cannot be undone. The
    // number is a policy claim about the workspace, and nothing in the workflow can see the workspace, so the
    // comparison has to happen here.
    const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true }).filter(
      (e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'package.json')),
    );
    expect(packages.length).toBeGreaterThan(1);
    expect(Number(wf.env?.EXPECTED_PACKAGES)).toBe(packages.length);
  });
});
