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
//
// The workflow is two jobs on purpose: `verify` runs every dependency's code and holds no publish identity, and
// `publish` holds `id-token: write` and runs nothing from the repo. Most of what is asserted below is one of
// the two halves of that split.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
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
/** The index of the step with this name in a job, failing loudly when it is missing. */
function at(jobName: string, stepName: string): number {
  const i = stepNames(job(jobName)).indexOf(stepName);
  expect(i, `"${stepName}" is missing from the ${jobName} job`).toBeGreaterThan(-1);
  return i;
}
/** A step of either job that does the work, by name. */
function stepOf(stepName: string): Step {
  const found = [...job('verify').steps, ...job('publish').steps].find((s) => s.name === stepName);
  if (!found) throw new Error(`neither job has a step "${stepName}"`);
  return found;
}
const NPM_EXACT = 'Install the exact npm for Trusted Publishing';

describe('release workflow shape', () => {
  it('has exactly the three jobs: verify, then publish, then github-release', () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(['github-release', 'publish', 'verify']);
    expect(job('publish').needs).toBe('verify');
    expect(job('github-release').needs).toBe('publish');
    expect(job('verify').needs).toBeUndefined();
  });

  it('publishes ONLY from the publish job', () => {
    // The shape described at the top: `Publish (real)` re-parented into github-release.
    expect(hasStep(job('publish'), 'Publish (real)')).toBe(true);
    expect(hasStep(job('publish'), 'Publish (dry-run)')).toBe(true);
    expect(hasStep(job('github-release'), 'Publish (real)')).toBe(false);

    const publishesElsewhere = Object.entries(wf.jobs)
      .filter(([name]) => name !== 'publish')
      .flatMap(([name, job]) => job.steps.map((s) => [name, s.run ?? ''] as const))
      .filter(([, run]) => /\b(pnpm|npm|yarn|npx)\b[\s\S]*\bpublish\b/.test(run));
    expect(publishesElsewhere).toEqual([]);
  });

  it('keeps contents:write off the job that publishes — EFFECTIVE, not just job-level', () => {
    // Read at the job level alone, `job('publish').permissions?.contents` is `undefined`, because the publish
    // job declares no job-level block — so `.not.toBe('write')` passes without inspecting anything, and a
    // `contents: write` added at the WORKFLOW level, which the publish job inherits, leaves it green: the
    // exact opposite of its purpose. Permissions resolve job-level first, falling back to workflow-level, so
    // the assertion must too.
    expect(effectivePermissions('publish').contents).not.toBe('write');
    expect(effectivePermissions('verify').contents).not.toBe('write');
    expect(effectivePermissions('github-release').contents).toBe('write');
    // The publish job's whole justification is that it holds the OIDC token and nothing else.
    expect(effectivePermissions('publish')['id-token']).toBe('write');
  });

  it('grants id-token: write to the publish job alone, and not at the top level', () => {
    // The point of the split. A top-level `id-token: write` is inherited by every job without a block of its
    // own, so the job that installs and runs every dependency would be able to mint the token again; and a
    // job-level block on `verify` or `github-release` would do the same. Read EFFECTIVE permissions, as above.
    expect(wf.permissions?.['id-token']).toBeUndefined();
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const name of Object.keys(wf.jobs)) {
      const grants = effectivePermissions(name)['id-token'];
      if (name === 'publish') expect(grants).toBe('write');
      else expect(grants, `${name} must not hold id-token`).toBeUndefined();
    }
    expect(job('verify').permissions).toEqual({ contents: 'read' });
    expect(job('publish').permissions).toEqual({ 'id-token': 'write', contents: 'read' });
  });

  it('keeps the job that holds the publish identity free of dependency code', () => {
    // `publish` holds `id-token: write`, so anything it runs can publish as this repo. Nothing from the repo's
    // dependency tree may run there: no checkout (so no repo scripts or lockfile), no package manager, no
    // script from the repo, no cache restore. It may run the runner's tools, pinned actions, the one exact npm
    // and inline shell, and `node` only on a script given on its own standard input. Known limit: an action it
    // `uses` is trusted code by SHA, and the allow-list below is what a new one has to be added to.
    const steps = job('publish').steps;
    const allowedUses = ['actions/download-artifact', 'actions/setup-node'];
    for (const s of steps) {
      if (s.uses !== undefined) {
        expect(
          allowedUses.some((a) => s.uses?.startsWith(`${a}@`)),
          `publish uses ${s.uses}`,
        ).toBe(true);
        expect(s.with?.cache, `${s.uses} restores a cache in the publish job`).toBeUndefined();
        expect(s.with?.['package-manager-cache']).not.toBe(true);
      }
      const run = s.run ?? '';
      expect(run, `"${s.name}" runs a package manager`).not.toMatch(
        /(^|[\s;&|(])(pnpm|yarn|npx|corepack|bun)(\s|$)/,
      );
      expect(run, `"${s.name}" runs a repo script`).not.toMatch(/(^|[\s;&|(])\.{0,2}\/?scripts\//);
      expect(run, `"${s.name}" runs a repo file`).not.toMatch(/(^|\s)(\.\/|\.\.\/)\S/);
      // `node` only reading its program from stdin (`node - <<'EOF'`), never a file.
      for (const m of run.matchAll(/(^|[\s;&|(])node(\s+\S+)?/g)) {
        expect(m[2]?.trim(), `"${s.name}" runs node on something other than stdin`).toBe('-');
      }
      // The only `npm` that installs anything is the exact-version step.
      for (const line of run
        .split('\n')
        .filter((l) => /\bnpm\s+(i|install|ci|add|exec|run)\b/.test(l))) {
        expect(s.name, `"${line.trim()}"`).toBe(NPM_EXACT);
      }
    }
  });

  it('pins every action to a full commit SHA', () => {
    const uses = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.uses ?? ''));
    expect(uses.filter((u) => u !== '').length).toBeGreaterThan(4);
    for (const u of uses.filter((x) => x !== '')) {
      expect(u, `${u} is not pinned to a 40-hex commit`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
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
    // Both guards are in `verify`, which `publish` needs: a failed guard stops the run before the reviewer is
    // asked, and before the publish job exists.
    expect(job('publish').needs).toBe('verify');
    at('verify', 'Verify tag matches every package version');
    at('verify', 'Refuse to "publish" a still-private package');
    at('publish', 'Publish (real)');
    const names = stepNames(job('verify'));
    const iUpload = names.findIndex((n) => n.startsWith('actions/upload-artifact'));
    expect(names.indexOf('Verify tag matches every package version')).toBeLessThan(iUpload);
    expect(names.indexOf('Refuse to "publish" a still-private package')).toBeLessThan(iUpload);
  });

  it('verifies the native oracle binary it installs before any test loads it', () => {
    const runs = job('verify').steps.map((s) => s.run ?? '');
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
    // In `verify`, ahead of the step that uploads what `publish` will publish: so a failure of any of them
    // happens before the approval prompt and before the publish job exists.
    const verifyNames = stepNames(job('verify'));
    const iUpload = verifyNames.findIndex((n) => n.startsWith('actions/upload-artifact'));
    expect(iUpload, 'verify does not upload the tarballs').toBeGreaterThan(-1);
    for (const precondition of [
      'Require release notes to exist before publishing',
      'Leak-scan the packed tarballs',
      'node scripts/audit.cjs',
      'Verify tag matches every package version',
      'Refuse to "publish" a still-private package',
    ]) {
      const i = verifyNames.indexOf(precondition);
      expect(i, `"${precondition}" is missing from the verify job`).toBeGreaterThan(-1);
      expect(i, `"${precondition}" must run before the upload`).toBeLessThan(iUpload);
    }
    // In `publish`, ahead of the first publish: the registry probes and the checks of what was downloaded.
    const names = stepNames(job('publish'));
    const firstPublish = Math.min(
      names.indexOf('Publish (dry-run)'),
      names.indexOf('Publish (real)'),
    );
    for (const precondition of [
      'Check the tarball checksums',
      'Check the tarball set and work out the publish order',
      'Refuse to publish an unbootstrapped name or a version already on the registry',
    ]) {
      const i = names.indexOf(precondition);
      expect(i, `"${precondition}" is missing from the publish job`).toBeGreaterThan(-1);
      expect(i, `"${precondition}" must run before the first publish`).toBeLessThan(firstPublish);
    }
  });

  it('probes the registry before publishing, for both partial-release shapes', () => {
    // Both failures produce a PARTIAL release of a lockstep family, and neither shows up in the log: a name
    // with no Trusted Publisher cannot be published by this tokenless workflow at all (it would publish the
    // packages that DO exist, then fail), and a version already on the registry is rejected by npm part-way
    // through the family, after the packages before it have gone out. Both are read-only probes,
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
    expect(job('verify').steps.some((s) => (s.run ?? '').includes('scripts/audit.cjs'))).toBe(true);
  });

  it('checks out the whole history, because the suite it runs reads the history of a file', () => {
    // `calibration-reports` proves each committed calibration evidence file was written once and never edited,
    // which reads the file's history out of git, and a shallow checkout carries none. It fails loudly rather
    // than passing vacuously, so this job, which re-runs the complete gate, checks out as `ci.yml` does.
    const checkout = job('verify').steps.find((s) => (s.uses ?? '').includes('actions/checkout'));
    expect(checkout, 'the verify job no longer checks out').toBeDefined();
    expect(
      (checkout as unknown as { with?: { 'fetch-depth'?: number } }).with?.['fetch-depth'],
      'release.yml must check out with fetch-depth: 0 — a shallow clone has no history, and the suite the ' +
        'verify job runs includes a gate that reads it',
    ).toBe(0);
  });

  it('scans the packed tarballs, which is the only artifact the other leak-scan modes cannot see', () => {
    // dist/ is gitignored, so neither the tracked-file nor the history enumeration covers the bytes a consumer
    // actually downloads — and sourcemaps carry every src comment verbatim via sourcesContent.
    const step = stepOf('Leak-scan the packed tarballs');
    expect(step.run).toContain('leak-scan-tarballs');
    // No `if:` — a dry run exists to prove the pipeline, so it must exercise the gates rather than skip them.
    expect((step as unknown as { if?: string }).if).toBeUndefined();
    // It scans the files that are uploaded, not a second pack of the same sources.
    expect(step.run).toMatch(/--from "\$RUNNER_TEMP\/release-tarballs"/);
  });

  it('packs once, scans those files, checksums them, and only then uploads them', () => {
    const iPack = at('verify', 'Pack every package to a tarball');
    const iScan = at('verify', 'Leak-scan the packed tarballs');
    const iSums = at('verify', 'Record the tarball checksums');
    const iUpload = stepNames(job('verify')).findIndex((n) =>
      n.startsWith('actions/upload-artifact'),
    );
    expect(iPack).toBeLessThan(iScan);
    expect(iScan).toBeLessThan(iSums);
    expect(iSums).toBeLessThan(iUpload);
    expect(stepOf('Record the tarball checksums').run).toContain('SHA256SUMS');
    // The approver reads the names and sums on the run's summary page.
    expect(stepOf('Record the tarball checksums').run).toContain('GITHUB_STEP_SUMMARY');
    const upload = job('verify').steps[iUpload];
    expect(upload?.with?.name).toBe('release-tarballs');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    // A re-run of every job replaces the artifact instead of failing on its name.
    expect(upload?.with?.overwrite).toBe(true);
    expect(Number(upload?.with?.['retention-days'])).toBeGreaterThan(0);
    expect(Number(upload?.with?.['retention-days'])).toBeLessThanOrEqual(14);
    const download = job('publish').steps.find((s) =>
      (s.uses ?? '').startsWith('actions/download-artifact'),
    );
    expect(download?.with?.name).toBe('release-tarballs');
  });

  it('checks the artifact against its sums before anything else uses it', () => {
    // The checksums are the first thing `publish` does with the files: before the registry probes, the
    // tarball-set check (which opens them), and either publish.
    const names = stepNames(job('publish'));
    const iDownload = names.findIndex((n) => n.startsWith('actions/download-artifact'));
    const iSums = at('publish', 'Check the tarball checksums');
    expect(iSums).toBe(iDownload + 1);
    const run = stepOf('Check the tarball checksums').run ?? '';
    expect(run).toMatch(/sha256sum --check --strict SHA256SUMS/);
    // No tarball may sit in the directory without a sum, or it would be published unchecked.
    expect(run).toMatch(/!= "\$present"/);
    for (const later of [
      'Check the tarball set and work out the publish order',
      'Refuse to publish an unbootstrapped name or a version already on the registry',
      'Publish (dry-run)',
      'Publish (real)',
    ]) {
      expect(iSums, `the sums must be checked before "${later}"`).toBeLessThan(
        at('publish', later),
      );
    }
  });

  it('publishes each tarball by file, with provenance, in the order worked out from the tarballs', () => {
    for (const name of ['Publish (dry-run)', 'Publish (real)']) {
      const step = stepOf(name);
      expect(step.run, name).toMatch(
        /npm publish "\$RUNNER_TEMP\/release-tarballs\/\$FILE" --provenance --access public/,
      );
      expect(step.run, name).toContain('publish-order.tsv');
      expect(step.env?.NPM_CONFIG_PROVENANCE, name).toBe(true);
    }
    expect(stepOf('Publish (dry-run)').run).toContain('--dry-run');
    // npm refuses a dry run of a version already on the registry, so the dry run skips such a tarball.
    const dry = stepOf('Publish (dry-run)').run ?? '';
    expect(dry).toMatch(/if npm view "\$NAME@\$VER" version >\/dev\/null 2>&1; then/);
    expect(dry).toContain('already on the registry');
    expect(dry).toMatch(/continue\s+fi\s+npm publish/);
    expect(stepOf('Publish (real)').run).not.toContain('--dry-run');
    // The set check counts against EXPECTED_PACKAGES and writes the order; it must see missing and extra files.
    const set = stepOf('Check the tarball set and work out the publish order').run ?? '';
    expect(set).toContain('EXPECTED_PACKAGES');
    expect(set).toMatch(/files\.length !== expected/);
    expect(set).toContain('writeFileSync');
  });

  it('bounds each job on purpose: a short verify, and the long wait only on publish', () => {
    expect(job('verify')['timeout-minutes']).toBe(60);
    expect(job('publish')['timeout-minutes']).toBe(360);
    expect(job('verify').environment).toBeUndefined();
  });

  it('installs npm at one exact version, at or above what Trusted Publishing needs', () => {
    // A range or a tag makes the npm that runs beside the publish identity whatever shipped that morning.
    // It is a deliberate, reviewed edit of this one line (RELEASING.md says how).
    const step = stepOf(NPM_EXACT);
    expect(job('publish').steps).toContain(step);
    const m = /^npm install -g npm@(\d+)\.(\d+)\.(\d+)$/.exec((step.run ?? '').trim());
    expect(m, `not an exact npm version: ${step.run}`).not.toBeNull();
    const [major, minor, patch] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
    const atLeast = major !== 11 ? major > 11 : minor * 1000 + patch >= 5001;
    expect(atLeast, 'below npm 11.5.1, which Trusted Publishing needs').toBe(true);
    expect(step.run).not.toMatch(/[\^~<>*]|latest|\bnext\b|\bx\b/);
    // And no other step in either job installs an npm by a range.
    for (const s of [...job('verify').steps, ...job('publish').steps]) {
      if (s !== step) expect(s.run ?? '').not.toMatch(/npm@/);
    }
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
      'Pack every package to a tarball',
    ]) {
      const run = job('verify').steps.find((s) => s.name === name)?.run ?? '';
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
    // A tag that is not a version tag: loosening a condition from `refs/tags/v` to any tag must go red.
    const nonVersionTagContexts: Ctx[] = ['refs/tags/foo', 'refs/tags/release-1'].map((ref) => ({
      event: 'workflow_dispatch',
      ref,
      dryRun: false,
    }));
    const badRefContexts = [branchDispatchReal, ...nonVersionTagContexts];
    const allContexts = [
      tagPush,
      tagDispatchReal,
      tagDispatchDry,
      branchDispatchDry,
      ...badRefContexts,
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
    const named = (n: string): Step => stepOf(n);
    const allSteps = () => [...job('verify').steps, ...job('publish').steps];

    it('runs every publish-capable step only on a tag ref', () => {
      // A step is publish-capable when it publishes for real (a `publish` command of pnpm, npm, yarn or npx,
      // on one line or several, or an action named for publishing, without --dry-run) or is one of the guards
      // that exist only for a real publish. The job holds `id-token: write`, so these are the steps that can
      // use it to publish. Known limit: a publish done through a script or an action not named for it is not
      // found by this detector.
      const capable = allSteps().filter(
        (s) =>
          ((/\b(pnpm|npm|yarn|npx)\b[\s\S]*\bpublish\b/.test(s.run ?? '') ||
            /publish/i.test(s.uses ?? '')) &&
            !/--dry-run/.test(s.run ?? '')) ||
          s.name === 'Refuse to "publish" a still-private package' ||
          s.name ===
            'Refuse to publish an unbootstrapped name or a version already on the registry',
      );
      expect(capable.map((s) => s.name)).toContain('Publish (real)');
      for (const step of capable) {
        for (const ctx of allContexts) {
          if (!ctx.ref.startsWith('refs/tags/v')) {
            // Covers a branch and a tag that is not a version tag.
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
      expect(runs(real, branchDispatchDry)).toBe(false);
      for (const ctx of badRefContexts) expect(runs(real, ctx), ctx.ref).toBe(false);
    });

    it('runs the tag/version check on every tag ref, including a dispatch with dryRun=false', () => {
      const check = named('Verify tag matches every package version');
      for (const ctx of [tagPush, tagDispatchReal, tagDispatchDry])
        expect(runs(check, ctx)).toBe(true);
      for (const ctx of [branchDispatchDry, ...badRefContexts])
        expect(runs(check, ctx)).toBe(false);
    });

    it('checks the release notes on every version tag ref and on no other ref', () => {
      const notes = named('Require release notes to exist before publishing');
      for (const ctx of [tagPush, tagDispatchReal, tagDispatchDry])
        expect(runs(notes, ctx)).toBe(true);
      for (const ctx of [branchDispatchDry, ...badRefContexts])
        expect(runs(notes, ctx)).toBe(false);
    });

    it('fails a dispatch with dryRun=false off a version tag before checkout, install and build', () => {
      const steps = job('verify').steps;
      const failing = steps.findIndex(
        (s) =>
          /\bexit 1\b/.test(s.run ?? '') &&
          badRefContexts.every((c) => runs(s, c)) &&
          !allContexts.filter((c) => !badRefContexts.includes(c)).some((c) => runs(s, c)),
      );
      expect(failing, 'no step fails a dispatch with dryRun=false off a tag').toBeGreaterThan(-1);
      // It must really stop the run: a failing step that may continue lets the later steps start.
      expect(
        (steps[failing] as unknown as { 'continue-on-error'?: unknown })['continue-on-error'],
      ).toBeUndefined();
      const firstWork = steps.findIndex((s) => s.uses !== undefined || /^pnpm /.test(s.run ?? ''));
      expect(failing).toBeLessThan(firstWork);
    });

    it('still dry-runs from a branch, with the guard quiet', () => {
      const dry = named('Publish (dry-run)');
      expect(runs(dry, branchDispatchDry)).toBe(true);
      expect(runs(dry, tagDispatchDry)).toBe(true);
      expect(runs(dry, branchDispatchReal)).toBe(false);
      expect(runs(dry, tagPush)).toBe(false);
      // Nothing that is gated and fails a run starts on a dry run from a branch.
      for (const s of allSteps().filter(
        (x) => /\bexit 1\b/.test(x.run ?? '') && x.if !== undefined,
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
