import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, compositeActionFiles, jobs, readYaml, type Job } from '../helpers/workflows';

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
// Hence the shape of the assertions: a command that can pull goes through the shared helper and runs the image by
// the name the helper gives, and a compose command that starts containers is told never to pull, since the helper
// made its images local a step before.
const HELPER = 'scripts/lib/docker-pull.sh';

/**
 * The commands in a shell text: line continuations joined, full-line comments dropped, then split at line ends and
 * at `&&`, `||`, `;` and `|`, with a trailing `# comment` cut. Crude, and enough to find the `docker` commands in a
 * script or a step.
 */
function commands(sh: string): string[] {
  return sh
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .flatMap((line) => line.split(/&&|\|\||;|\|/))
    .map((c) => c.replace(/\s#\s.*$/, '').trim())
    .filter((c) => c !== '');
}

/** Docker's global flags that take a value: its command is the first word past them. */
const DOCKER_FLAG_WITH_VALUE =
  /^(?:-c|--context|-H|--host|--config|-l|--log-level|--tlscacert|--tlscert|--tlskey)$/;
/** Compose's global flags that take a value: its subcommand is the first word past them. */
const COMPOSE_FLAG_WITH_VALUE =
  /^(?:-f|--file|-p|--project-name|--project-directory|--profile|--env-file|--ansi|--progress|--parallel)$/;
const NEVER_PULLS = /\s--pull(?:\s+|=)["']?never["']?(?=\s|$)/;

/** The first two words of a command after `start`, past flags, and the values of the flags `withValue` names. */
function words(command: string, start: RegExp, withValue: RegExp): string[] {
  const all = (start.exec(command)?.[1] ?? '').trim().split(/\s+/);
  const found: string[] = [];
  for (let i = 0; i < all.length && found.length < 2; i++) {
    const w = all[i] ?? '';
    if (withValue.test(w)) i++;
    else if (w !== '' && !w.startsWith('-')) found.push(w);
  }
  return found;
}

/**
 * What a docker command asks of a registry, bare or under `container`, `image` or `buildx`: `pull` for a pull; `run`
 * for `run` and `create`, which pull a missing image implicitly; `build` for a build, which pulls its base image; and
 * `compose` for compose, read apart. A message that names docker, from `echo` or `printf`, asks nothing.
 */
function dockerKind(command: string): 'pull' | 'run' | 'build' | 'compose' | undefined {
  if (/^(?:echo|printf)\b/.test(command)) return undefined;
  const [first, second] = words(command, /(?:^|[\s(])docker\s+(.*)$/, DOCKER_FLAG_WITH_VALUE);
  const verb = first === 'container' || first === 'image' || first === 'buildx' ? second : first;
  if (verb === 'pull') return 'pull';
  if (verb === 'run' || verb === 'create') return 'run';
  if (verb === 'build') return 'build';
  return first === 'compose' ? 'compose' : undefined;
}

/** The subcommand of a `docker compose` command, past its global flags and their values. */
function composeSubcommand(command: string): string | undefined {
  return words(command, /\bdocker\s+compose\b(.*)$/, COMPOSE_FLAG_WITH_VALUE)[0];
}

/** What is wrong with a shell text, one entry per command at fault. */
function problems(sh: string): string[] {
  const code = commands(sh);
  const usesHelper =
    code.some((c) => /^(?:\.|source)\s.*docker-pull\.sh\b/.test(c)) &&
    code.some((c) => /\bdocker_pull_with_backoff\b/.test(c));
  // The variables that hold a name to run an image by: a copy loaded from the cache runs by its local name alone.
  const runNames = [...sh.matchAll(/\b([A-Za-z_]\w*)="?\$\(docker_image_run_name\b/g)].map(
    (m) => m[1] ?? '',
  );
  const byRunName = (c: string) =>
    /\$\(docker_image_run_name\b/.test(c) ||
    runNames.some((v) => new RegExp(`\\$\\{?${v}\\b`).test(c));
  const found: string[] = [];
  // The local name exists only once the pull has made the image local: taken before it, a digest's run name is the
  // digest, which a loaded copy does not answer to.
  const pulledAt = code.findIndex((c) => /\bdocker_pull_with_backoff\b/.test(c));
  code.forEach((c, i) => {
    if (pulledAt >= 0 && i < pulledAt && /\$\(docker_image_run_name\b/.test(c)) {
      found.push(`takes a run name before the pull that makes the image local: ${c}`);
    }
  });
  for (const c of code) {
    const kind = dockerKind(c);
    const sub = kind === 'compose' ? composeSubcommand(c) : undefined;
    if (sub === 'up' || sub === 'run' || sub === 'create') {
      if (!NEVER_PULLS.test(c)) found.push(`starts compose without --pull never: ${c}`);
    } else if (sub === 'pull') {
      found.push(`pulls through compose, which nothing retries: ${c}`);
    } else if (kind === 'build' || sub === 'build') {
      found.push(`builds, and pulls the base image with nothing to retry it: ${c}`);
    } else if (kind === 'pull' || kind === 'run' || (sub === 'config' && /\s--images\b/.test(c))) {
      // `config --images` fed the pull loop CI once had inline.
      if (!usesHelper) found.push(`pulls without the shared helper: ${c}`);
      else if (kind === 'run' && !byRunName(c)) {
        found.push(`runs an image by a name docker_image_run_name did not give: ${c}`);
      }
    }
  }
  return found;
}

/** Every shell script a job can run: under `scripts/` at any depth, and beside a composite action. */
function shellScripts(root = ROOT): string[] {
  const under = (dir: string) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
          .map((f) => f.replace(/\\/g, '/'))
          .filter((f) => f.endsWith('.sh'))
          .map((f) => `${dir}/${f}`)
      : [];
  // The helper itself is the one place a bare pull belongs.
  return [...under('scripts'), ...under('.github/actions')].filter((f) => f !== HELPER).sort();
}

interface ActionMeta {
  runs?: { using?: string; image?: string; steps?: unknown[] };
}

/** What in one job the runner pulls itself, or a step runs, with no helper behind it. */
function jobProblems(where: string, job: Job): string[] {
  const found: string[] = [];
  if (job.services !== undefined || job.container !== undefined) {
    found.push(`${where}: the runner pulls its services or container itself`);
  }
  for (const step of job.steps ?? []) {
    const name = `${where} › ${step.name ?? step.id ?? step.uses ?? '(unnamed step)'}`;
    if (step.uses?.startsWith('docker://')) found.push(`${name}: the runner pulls ${step.uses}`);
    for (const p of problems(step.run ?? '')) found.push(`${name}: ${p}`);
  }
  return found;
}

/** Whether an action runs in a container, which the runner pulls or builds itself. */
function actionProblems(file: string, meta: ActionMeta): string[] {
  return meta.runs?.using === 'docker'
    ? [`${file}: the runner pulls or builds its image itself`]
    : [];
}

describe('registry throttling is absorbed everywhere a container is started', () => {
  it('the shared helper exists and fails loudly rather than swallowing a real error', () => {
    const src = readFileSync(join(ROOT, HELPER), 'utf8');
    expect(src).toContain('docker_pull_with_backoff()');
    // A retry loop that hides a typo'd tag is worse than no retry: on the last attempt it must re-run the pull
    // with output so the registry's actual message reaches the log, then return non-zero.
    expect(src).toMatch(/return 1/);
    expect(src).toMatch(/docker_pull_attempt "\$img" >&2/);
    // Waited out, not sent to the background, where the next attempt would not wait for it.
    expect(src).toMatch(/^[ \t]*sleep \$\(\(attempt \* 10\)\)[ \t]*$/m);
  });

  it('reads commands, not text: each pulling form is caught, and its look-alikes are not', () => {
    const helped = `. ${HELPER}\ndocker_pull_with_backoff "$IMAGE"\nRUN_IMAGE="$(docker_image_run_name "$IMAGE")"`;
    for (const sh of [
      'docker run --rm alpine true',
      'docker container run alpine',
      'docker create alpine',
      'docker container create alpine',
      'docker --context default run alpine',
      'docker pull alpine',
      'docker image pull alpine',
      'for img in $(docker compose config --images); do :; done',
    ]) {
      expect(problems(sh), sh).toHaveLength(1);
      expect(problems(`${helped}\n${sh.replace(/alpine/, '"$RUN_IMAGE"')}`), sh).toEqual([]);
    }
    // Through the helper, an image is run by the name docker_image_run_name gives: by any other, a copy the cache
    // loaded under its local name alone is not found, and the image is pulled again with no retry.
    expect(problems(`${helped}\ndocker run --rm "$IMAGE" true`)).toHaveLength(1);
    expect(problems(`${helped}\ndocker run --rm busybox:1.36 true`)).toHaveLength(1);
    for (const sh of [
      'docker compose up -d',
      'docker compose -f docker-compose.yml -f "$RUNNER_TEMP/o.yml" up -d --wait',
      'docker compose -p x run svc',
      'docker compose create',
      'docker compose -f a.yml \\\n  up -d',
      'docker compose up -d --pull never && docker compose -f b.yml up -d',
      'docker compose pull',
      'docker compose build',
      'docker build .',
      'docker buildx build .',
      'docker image build .',
      'docker compose up -d --pull always',
      'docker compose up -d --pull missing',
      'docker compose --profile ci up -d',
      'docker -H tcp://127.0.0.1:2375 run --rm "$IMAGE" true',
    ]) {
      expect(problems(`${helped}\n${sh}`), sh).toHaveLength(1);
    }
    // A run by the name docker_image_run_name gives, however the name is written.
    expect(problems(`${helped}\ndocker run --rm "$(docker_image_run_name "$IMAGE")" true`)).toEqual(
      [],
    );
    expect(
      problems(
        `. ${HELPER}\ndocker_pull_with_backoff "$IMAGE"\nRUN=$(docker_image_run_name "$IMAGE")\ndocker run "$RUN"`,
      ),
    ).toEqual([]);
    expect(
      problems(`${helped}\ndocker -H tcp://127.0.0.1:2375 run --rm "$RUN_IMAGE" true`),
    ).toEqual([]);
    for (const sh of [
      'docker compose up -d --pull never --wait',
      'docker compose up -d --pull=never',
      'docker compose up -d --pull="never"',
      'docker compose down -v',
      'docker compose logs > run.log',
      'docker compose ps -a || echo "no backend came up"',
      'docker compose config --services',
      'docker image inspect alpine',
      'docker image inspect alpine # then docker run it',
      'docker container ls',
      'docker save -o f.tar alpine',
      'docker load -q -i f.tar',
      'docker tag a b',
      '# docker run alpine, in a comment',
      'echo "docker-pull: using the copy"',
      'echo "run: docker run alpine"',
    ]) {
      expect(problems(sh), sh).toEqual([]);
    }
    // Sourcing the helper is not enough without the call, and the call is not enough without the source.
    const runs = 'RUN_IMAGE="$(docker_image_run_name x)"\ndocker run "$RUN_IMAGE"';
    const unhelped = ['pulls without the shared helper: docker run "$RUN_IMAGE"'];
    expect(problems(`. ${HELPER}\n${runs}`)).toEqual(unhelped);
    expect(problems(`# . ${HELPER}\ndocker_pull_with_backoff x\n${runs}`)).toEqual(unhelped);
    expect(problems(`. ${HELPER}\ndocker_pull_with_backoff x\n${runs}`)).toEqual([]);
    expect(
      problems(
        `. ${HELPER}\nRUN_IMAGE="$(docker_image_run_name x)"\ndocker_pull_with_backoff x\ndocker run "$RUN_IMAGE"`,
      ),
    ).toEqual([
      'takes a run name before the pull that makes the image local: RUN_IMAGE="$(docker_image_run_name x)"',
    ]);
  });

  it('sweeps scripts at any depth under scripts/ and beside a composite action, but not the helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'pull-gate-'));
    try {
      for (const f of [
        'scripts/a.sh',
        'scripts/sub/b.sh',
        'scripts/lib/docker-pull.sh',
        'scripts/README.md',
        '.github/actions/x/run.sh',
      ]) {
        mkdirSync(join(root, dirname(f)), { recursive: true });
        writeFileSync(join(root, f), '');
      }
      expect(shellScripts(root)).toEqual([
        '.github/actions/x/run.sh',
        'scripts/a.sh',
        'scripts/sub/b.sh',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds scripts that run containers, so a rename cannot make this suite vacuous', () => {
    const running = shellScripts().filter((f) =>
      commands(readFileSync(join(ROOT, f), 'utf8')).some((c) => dockerKind(c) === 'run'),
    );
    expect(running).toEqual(
      expect.arrayContaining([
        'scripts/build-lambda-layer.sh',
        'scripts/lambda-smoke.sh',
        'scripts/rss-gate.sh',
      ]),
    );
  });

  it.each(shellScripts())(
    '%s pulls only through the helper, runs by its name, and never pulls through compose',
    (file) => {
      expect(problems(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
    },
  );

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
    // 4. It read `run:` text only. A job's `services:` or `container:`, a `uses: docker://` step and a composite
    //    action that runs in a container are pulled by the runner itself, where no helper and no cache can reach.
    const offenders = [
      ...jobs().flatMap(({ where, job }) => jobProblems(where, job)),
      ...compositeActionFiles().flatMap((file) => actionProblems(file, readYaml<ActionMeta>(file))),
    ];
    const reading = jobs()
      .flatMap(({ job }) => job.steps ?? [])
      .filter((s) => /\bdocker\s/.test(s.run ?? ''));
    expect(reading.length, 'no workflow step runs docker — has the shape changed?').toBeGreaterThan(
      0,
    );
    expect(offenders).toEqual([]);
  });

  it('reads a job and an action the way the runner does, and flags what the runner pulls itself', () => {
    expect(jobProblems('j', { steps: [{ run: 'pnpm test' }] })).toEqual([]);
    expect(jobProblems('j', { services: { redis: { image: 'redis:7' } }, steps: [] })).toHaveLength(
      1,
    );
    expect(jobProblems('j', { container: 'node:22', steps: [] })).toHaveLength(1);
    expect(jobProblems('j', { steps: [{ uses: 'docker://alpine:3' }] })).toHaveLength(1);
    expect(jobProblems('j', { steps: [{ run: 'docker run --rm alpine true' }] })).toHaveLength(1);
    expect(actionProblems('a', { runs: { using: 'composite', steps: [] } })).toEqual([]);
    expect(
      actionProblems('a', { runs: { using: 'docker', image: 'docker://alpine:3' } }),
    ).toHaveLength(1);
    expect(actionProblems('a', { runs: { using: 'docker', image: 'Dockerfile' } })).toHaveLength(1);
  });
});
