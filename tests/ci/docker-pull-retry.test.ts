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

  it('the CI workflow uses the same one implementation, not a fourth copy', () => {
    // The inlined loop was the original; keeping it would mean the rule drifting in two places at once.
    const wf = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const runs = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .map((s) => s.run ?? '');
    const pulling = runs.filter((r) => /docker pull|docker compose config --images/.test(r));
    expect(pulling.length).toBeGreaterThan(0);
    for (const r of pulling) {
      expect(r, 'a CI step pulls images without the shared helper').toContain('docker-pull.sh');
    }
  });
});
