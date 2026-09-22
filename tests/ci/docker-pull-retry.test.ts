import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Every place that runs a container must absorb a registry throttle. This test exists because the rule was
// implemented in exactly one of the three places that needed it.
//
// The CI integration job learned the lesson first — nine simultaneous pulls against a shared GitHub-runner IP
// provoked Docker Hub's quota, the registry was swapped to AWS's mirror, and that mirror then answered with a
// per-second rate limit — so it grew a serial-pull-with-backoff loop, inlined in the workflow. The two scripts
// that `docker run` an ECR image directly never got it, and the RSS gate consequently died on `main` twice in
// one day with `toomanyrequests: Rate exceeded`, 36 seconds in, having tested nothing.
//
// The trap is that `docker run` pulls IMPLICITLY on a cache miss. There is no pull step to notice missing, so
// "we don't pull here" is never true — the pull happens either way, and only an explicit one can be retried.
// Hence the shape of the assertion: if a file can start a container, it must reference the shared helper.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = 'scripts/lib/docker-pull.sh';

/** Shell scripts under `scripts/` that can start a container. */
function scriptsThatRunContainers(): string[] {
  const dir = join(ROOT, 'scripts');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => /\bdocker\s+run\b/.test(readFileSync(join(dir, f), 'utf8')));
}

/** Every workflow, not just `ci.yml`. */
function workflowFiles(): string[] {
  const dir = join(ROOT, '.github/workflows');
  return readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

describe('registry throttling is absorbed everywhere a container is started', () => {
  it('the shared helper exists and fails loudly rather than swallowing a real error', () => {
    const src = readFileSync(join(ROOT, HELPER), 'utf8');
    expect(src).toContain('docker_pull_with_backoff()');
    // A retry loop that hides a typo'd tag is worse than no retry: on the last attempt it must re-run the pull
    // with output so the registry's actual message reaches the log, then return non-zero.
    expect(src).toMatch(/return 1/);
    expect(src).toMatch(/docker pull "\$img" >&2/);
    expect(src).toMatch(/sleep \$\(\(attempt \* 10\)\)/);
  });

  it('finds scripts to check, so a rename cannot make this suite vacuous', () => {
    expect(scriptsThatRunContainers().length).toBeGreaterThan(0);
  });

  it.each(scriptsThatRunContainers())('scripts/%s pulls with backoff before running', (name) => {
    const src = readFileSync(join(ROOT, 'scripts', name), 'utf8');
    expect(src, `scripts/${name} runs a container without sourcing ${HELPER}`).toContain(
      'docker-pull.sh',
    );
    expect(src, `scripts/${name} sources the helper but never calls it`).toContain(
      'docker_pull_with_backoff',
    );
  });

  it('every workflow uses the same one implementation, not a fourth copy', () => {
    // TWO corrections to what this used to check, both of which let a real defect through.
    //
    // 1. It matched `docker pull` and `docker compose config --images` — EXPLICIT pulls, which is the
    //    opposite of this file's own stated rationale. The trap named at the top is that `docker run` pulls
    //    IMPLICITLY on a cache miss, and that was the one verb not looked for. A `docker run` step added to
    //    ci.yml's integration job passed.
    // 2. It read `ci.yml` alone. `release.yml` and `fuzz-nightly.yml` could pull unprotected, and an
    //    explicit unguarded `docker pull` in fuzz-nightly passed the whole suite.
    //    `runtime-version-policy.test.ts` had to be widened to "EVERY workflow" for the same reason.
    const offenders: string[] = [];
    let starting = 0;
    for (const file of workflowFiles()) {
      const wf = parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) as {
        jobs?: Record<string, { steps?: { name?: string; run?: string }[] }>;
      };
      for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const run = step.run ?? '';
          if (!/docker\s+pull|docker\s+run|docker\s+compose\s+config\s+--images/.test(run))
            continue;
          starting += 1;
          if (!run.includes('docker-pull.sh'))
            offenders.push(`${file} › ${jobName} › ${step.name ?? '(unnamed step)'}`);
        }
      }
    }
    expect(
      starting,
      'no workflow step starts a container — has the shape changed?',
    ).toBeGreaterThan(0);
    expect(
      offenders,
      'these workflow steps start or pull a container without the shared backoff helper',
    ).toEqual([]);
  });
});
