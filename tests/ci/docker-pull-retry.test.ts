import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, jobs } from '../helpers/workflows';

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
// Hence the shape of the assertions: a command that can pull goes through the shared helper, and a compose
// command that starts containers is told never to pull, since the helper made its images local a step before.
const HELPER = 'scripts/lib/docker-pull.sh';

/**
 * The commands in a shell text: line continuations joined, full-line comments dropped, then split at line ends and
 * at `&&`, `||`, `;` and `|`. Crude, and enough to find the `docker` commands in a script or a step.
 */
function commands(sh: string): string[] {
  return sh
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .flatMap((line) => line.split(/&&|\|\||;|\|/))
    .map((c) => c.trim())
    .filter((c) => c !== '');
}

/** `docker pull`, and what pulls a missing image implicitly: `run` and `create`, bare or under `container`. */
const DOCKER_PULLS = /\bdocker\s+(?:(?:container\s+)?(?:run|create)|(?:image\s+)?pull)\b/;
/** Compose's global flags that take a value: its subcommand is the first word past them. */
const COMPOSE_FLAG_WITH_VALUE =
  /^(?:-f|--file|-p|--project-name|--project-directory|--profile|--env-file|--ansi|--progress|--parallel)$/;
const NEVER_PULLS = /\s--pull(?:\s+|=)["']?never["']?(?=\s|$)/;

/** The subcommand of a `docker compose` command, past its global flags and their values. */
function composeSubcommand(command: string): string | undefined {
  const words = (/\bdocker\s+compose\b(.*)$/.exec(command)?.[1] ?? '').trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (COMPOSE_FLAG_WITH_VALUE.test(word)) i++;
    else if (word !== '' && !word.startsWith('-')) return word;
  }
  return undefined;
}

/** What is wrong with a shell text, one entry per command at fault. */
function problems(sh: string): string[] {
  const code = commands(sh);
  const usesHelper =
    code.some((c) => /^(?:\.|source)\s.*docker-pull\.sh\b/.test(c)) &&
    code.some((c) => /\bdocker_pull_with_backoff\b/.test(c));
  const found: string[] = [];
  for (const c of code) {
    const sub = /\bdocker\s+compose\b/.test(c) ? composeSubcommand(c) : undefined;
    if (sub === 'up' || sub === 'run' || sub === 'create') {
      if (!NEVER_PULLS.test(c)) found.push(`starts compose without --pull never: ${c}`);
    } else if (sub === 'pull') {
      found.push(`pulls through compose, which nothing retries: ${c}`);
    } else if (
      (sub === 'config' && /\s--images\b/.test(c)) ||
      (sub === undefined && DOCKER_PULLS.test(c))
    ) {
      // `config --images` fed the pull loop CI once had inline.
      if (!usesHelper) found.push(`pulls without the shared helper: ${c}`);
    }
  }
  return found;
}

/** Every shell script a job can run: under `scripts/` at any depth, and beside a composite action. */
function shellScripts(): string[] {
  const under = (dir: string) =>
    existsSync(join(ROOT, dir))
      ? readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.sh'))
          .map((f) => `${dir}/${f}`)
      : [];
  // The helper itself is the one place a bare pull belongs.
  return [...under('scripts'), ...under('.github/actions')].filter((f) => f !== HELPER).sort();
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

  it('reads commands, not text: each pulling form is caught, and its look-alikes are not', () => {
    for (const sh of [
      'docker run --rm alpine true',
      'docker container run alpine',
      'docker create alpine',
      'docker container create alpine',
      'docker pull alpine',
      'docker image pull alpine',
      'for img in $(docker compose config --images); do :; done',
    ]) {
      expect(problems(sh), sh).toHaveLength(1);
      expect(problems(`. ${HELPER}\ndocker_pull_with_backoff "$IMAGE"\n${sh}`), sh).toEqual([]);
    }
    for (const sh of [
      'docker compose up -d',
      'docker compose -f docker-compose.yml -f "$RUNNER_TEMP/o.yml" up -d --wait',
      'docker compose -p x run svc',
      'docker compose create',
      'docker compose -f a.yml \\\n  up -d',
      'docker compose up -d --pull never && docker compose -f b.yml up -d',
      'docker compose pull',
    ]) {
      expect(problems(sh), sh).toHaveLength(1);
    }
    for (const sh of [
      'docker compose up -d --pull never --wait',
      'docker compose up -d --pull=never',
      'docker compose up -d --pull="never"',
      'docker compose down -v',
      'docker compose logs > run.log',
      'docker compose ps -a || echo "no backend came up"',
      'docker compose config --services',
      'docker image inspect alpine',
      'docker container ls',
      'docker save -o f.tar alpine',
      'docker load -q -i f.tar',
      'docker tag a b',
      '# docker run alpine, in a comment',
      'echo "docker-pull: using the copy"',
    ]) {
      expect(problems(sh), sh).toEqual([]);
    }
    // Sourcing the helper is not enough without the call, and the call is not enough without the source.
    expect(problems(`. ${HELPER}\ndocker run alpine`)).toHaveLength(1);
    expect(
      problems('# . scripts/lib/docker-pull.sh\ndocker_pull_with_backoff x\ndocker run x'),
    ).toHaveLength(1);
  });

  it('finds scripts that run containers, so a rename cannot make this suite vacuous', () => {
    const running = shellScripts().filter((f) =>
      commands(readFileSync(join(ROOT, f), 'utf8')).some((c) => DOCKER_PULLS.test(c)),
    );
    expect(running).toEqual(
      expect.arrayContaining([
        'scripts/build-lambda-layer.sh',
        'scripts/lambda-smoke.sh',
        'scripts/rss-gate.sh',
      ]),
    );
  });

  it.each(shellScripts())('%s pulls only through the helper, and never through compose', (file) => {
    expect(problems(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });

  it('every workflow uses the same one implementation, not a fourth copy', () => {
    // FOUR corrections to what this used to check. The first two each let a real defect through.
    //
    // 1. It matched `docker pull` and `docker compose config --images` — EXPLICIT pulls, which is the
    //    opposite of this file's own stated rationale. The trap named at the top is that `docker run` pulls
    //    IMPLICITLY on a cache miss, and that was the one verb not looked for. A `docker run` step added to
    //    ci.yml's integration job passed.
    // 2. It read `ci.yml` alone. `release.yml` and `fuzz-nightly.yml` could pull unprotected, and an
    //    explicit unguarded `docker pull` in fuzz-nightly passed the whole suite. `runtime-version-policy.test.ts`
    //    had to be widened to "EVERY workflow" for the same reason. Composite actions are read here too, since
    //    their steps run in the jobs that use them.
    // 3. It passed `docker compose up` unread, and compose pulls a missing image implicitly: the same trap in
    //    compose's form. A step that starts compose runs on images a step before it made local through the
    //    helper, so it has to say `--pull never`, which makes an image that is not local a failure rather than a
    //    pull that nothing retries.
    // 4. It read `run:` text only. A job's `services:` or `container:`, and a `uses: docker://` step, are
    //    pulled by the runner itself, where no helper and no cache can reach.
    const offenders: string[] = [];
    let reading = 0;
    for (const { where, job } of jobs()) {
      if (job.services !== undefined || job.container !== undefined) {
        offenders.push(`${where}: the runner pulls its services or container itself`);
      }
      for (const step of job.steps ?? []) {
        const name = `${where} › ${step.name ?? step.id ?? step.uses ?? '(unnamed step)'}`;
        if (step.uses?.startsWith('docker://'))
          offenders.push(`${name}: the runner pulls ${step.uses}`);
        const run = step.run ?? '';
        if (/\bdocker\s/.test(run)) reading += 1;
        for (const p of problems(run)) offenders.push(`${name}: ${p}`);
      }
    }
    expect(reading, 'no workflow step runs docker — has the shape changed?').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
