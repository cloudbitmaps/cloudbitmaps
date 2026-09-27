import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT, jobs, packageScripts, readYaml, type Step } from '../helpers/workflows';

/**
 * The images CI runs are kept in the Actions cache, so that a registry which refuses or throttles a pull fails a run
 * only when no copy is kept. It was needed twice in one week of September 2026: quay.io began refusing anonymous pulls
 * of MinIO and failed the integration job on `main` and on every PR for two days, and public.ecr.aws answered `Data
 * limit exceeded` to the RSS gate's `node:22`.
 *
 * These drive scripts/lib/docker-pull.sh, scripts/ci-backend-images.sh and the two composite actions' own shell
 * against a stand-in `docker` that records what it was asked, keeps its "images" as files, and refuses the argument
 * shapes real Docker refuses; a `sleep` that returns at once; and a `date` that names one month. So each path runs
 * with no network and no daemon: which copy is used, when the registry is asked, what is saved, and what is dropped.
 * A later run starts on a fresh runner, as CI's do, holding only what the cache restored.
 */
const HELPER = join(ROOT, 'scripts/lib/docker-pull.sh');

/** A `docker` that answers from files under $STUB: an image is present when a file names it. */
const STUB_DOCKER = String.raw`#!/usr/bin/env bash
echo "$*" >>"$STUB/calls"
present() { printf '%s' "$1" | tr '/:@' '___'; }
case "$1" in
  pull)
    if [ "$2" = -q ]; then ref="$3"; quiet=1; else ref="$2"; quiet=; fi
    [ -n "$ref" ] || exit 2
    n=0; [ -f "$STUB/pull-count" ] && n="$(cat "$STUB/pull-count")"; n=$((n + 1)); echo "$n" >"$STUB/pull-count"
    if [ -n "$STUB_FAIL_FIRST" ] && [ "$n" -le "$STUB_FAIL_FIRST" ]; then echo "toomanyrequests: Rate exceeded" >&2; exit 1; fi
    for f in $STUB_FAIL_PULLS; do
      if [ "$f" = "$ref" ]; then echo "toomanyrequests: Data limit exceeded" >&2; exit 1; fi
    done
    if [ -n "$quiet" ]; then
      for f in $STUB_FAIL_QUIET_PULLS; do
        if [ "$f" = "$ref" ]; then echo "toomanyrequests: Rate exceeded" >&2; exit 1; fi
      done
    fi
    touch "$STUB/images/$(present "$ref")"
    exit 0 ;;
  tag)
    case "$3" in *@sha256:*) echo "refusing to create a tag with a digest reference" >&2; exit 1 ;; esac
    [ -e "$STUB/images/$(present "$2")" ] || exit 1
    touch "$STUB/images/$(present "$3")"
    exit 0 ;;
  save)
    [ "$2" = -o ] || exit 2
    [ -n "$STUB_FAIL_SAVE" ] && exit 1
    [ -e "$STUB/images/$(present "$4")" ] || exit 1
    printf '%s' "$4" >"$3"
    exit 0 ;;
  load)
    [ "$2" = -q ] && [ "$3" = -i ] && [ -f "$4" ] || exit 1
    name="$(cat "$4")"
    [ "$name" = corrupt ] && exit 1
    touch "$STUB/images/$(present "$name")"
    exit 0 ;;
  image)
    [ "$2" = inspect ] || exit 2
    [ -e "$STUB/images/$(present "$3")" ] && exit 0
    exit 1 ;;
  compose)
    [ "$2" = -f ] && [ "$4 $5 $6" = "config --format json" ] || exit 2
    if [ -n "$STUB_COMPOSE_JSON" ]; then printf '%s' "$STUB_COMPOSE_JSON"; exit 0; fi
    printf '{"services":{"minio":{"image":"cgr.dev/chainguard/minio@sha256:abc"},"fake-gcs":{"image":"fsouza/fake-gcs-server:1.52.2"}}}'
    exit 0 ;;
esac
exit 2
`;

interface Ran {
  code: number;
  /** stdout alone: what a `$(…)` in the caller would read. */
  stdout: string;
  /** stdout and stderr, for what the log says. */
  out: string;
}

interface World {
  dir: string;
  cache: string;
  /** Run bash with the stand-ins first on PATH; `env` adds to the environment. */
  run: (script: string, env?: Record<string, string>) => Ran;
  calls: () => string[];
  pulls: () => string[];
  resetCalls: () => void;
  /** A new runner, as each CI job gets: no images at all, and only what the cache restored. */
  freshRunner: () => void;
  /** Whether the stand-in holds an image under `name`. */
  has: (name: string) => boolean;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'docker-image-cache-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(bin, 'docker'), STUB_DOCKER);
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(
    join(bin, 'date'),
    '#!/usr/bin/env bash\necho "$*" >>"$STUB/date-calls"\necho 2026-09\n',
  );
  for (const tool of ['docker', 'sleep', 'date']) chmodSync(join(bin, tool), 0o755);
  const cache = join(dir, 'cache');
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    STUB: dir,
  };
  for (const name of ['DOCKER_IMAGE_CACHE', 'DOCKER_IMAGE_CACHE_HIT', 'GITHUB_ACTIONS'])
    delete base[name];
  const run = (script: string, env: Record<string, string> = {}): Ran => {
    const r = spawnSync('bash', ['-c', script], {
      cwd: ROOT,
      env: { ...base, ...env },
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
  };
  const calls = () =>
    existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
  const resetCalls = () => {
    rmSync(join(dir, 'calls'), { force: true });
    rmSync(join(dir, 'pull-count'), { force: true });
  };
  const freshRunner = () => {
    rmSync(join(dir, 'images'), { recursive: true, force: true });
    mkdirSync(join(dir, 'images'));
    // The cache CI saved never holds this run's bookkeeping: the prune deletes it before a save.
    rmSync(join(cache, '.used'), { force: true });
    resetCalls();
  };
  return {
    dir,
    cache,
    run,
    calls,
    pulls: () => calls().filter((c) => c.startsWith('pull')),
    resetCalls,
    freshRunner,
    has: (name) => existsSync(join(dir, 'images', name.replace(/[/:@]/g, '_'))),
  };
}

const TAG = 'fsouza/fake-gcs-server:1.52.2';
const DIGEST = 'cgr.dev/chainguard/minio@sha256:abc';
/** The part of a cache name that is the image, computed here rather than by the helper under test. */
const idOf = (image: string) =>
  execFileSync('bash', ['-c', `printf '%s' "$1" | sha256sum | cut -c1-16`, '_', image], {
    encoding: 'utf8',
  }).trim();
const localName = (image: string) => `cloud-roaring-ci.invalid/cache:${idOf(image)}`;
const tarOf = (w: World, image: string) => join(w.cache, `${idOf(image)}.tar`);
const pull = (image: string) => `. ${HELPER} && docker_pull_with_backoff '${image}'`;
const prune = `. ${HELPER} && docker_image_cache_prune`;
const overrideOf = (file: string) =>
  (parse(readFileSync(file, 'utf8')) as { services: Record<string, { image: string }> }).services;

describe('an image CI runs is kept in the Actions cache, and a registry is asked only when it must be', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => {
    rmSync(w.dir, { recursive: true, force: true });
  });
  const CACHE = () => ({ DOCKER_IMAGE_CACHE: w.cache });
  const THIS_MONTH = () => ({ DOCKER_IMAGE_CACHE: w.cache, DOCKER_IMAGE_CACHE_HIT: 'true' });
  const OLDER = () => ({ DOCKER_IMAGE_CACHE: w.cache, DOCKER_IMAGE_CACHE_HIT: 'false' });

  it('pulls as before, and keeps nothing, with no cache set', () => {
    expect(w.run(pull(TAG)).code).toBe(0);
    expect(w.calls()).toEqual([`pull -q ${TAG}`]);
    expect(existsSync(w.cache)).toBe(false);
  });

  it('pulls an image the cache lacks, and keeps it under its local name', () => {
    expect(w.run(pull(TAG), CACHE()).code).toBe(0);
    expect(w.calls()).toContain(`tag ${TAG} ${localName(TAG)}`);
    expect(readFileSync(tarOf(w, TAG), 'utf8')).toBe(localName(TAG));
  });

  it('keeps an image it pulled only after a throttle cleared', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_FIRST: '2' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`ok ${TAG} (attempt 3)`);
    expect(readFileSync(tarOf(w, TAG), 'utf8')).toBe(localName(TAG));
  });

  it("loads a tag's copy on a fresh runner without asking the registry, when the cache is this month's", () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), THIS_MONTH());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`${TAG} from the cache`);
    expect(w.pulls()).toEqual([]);
    // The copy came out of the tar, and its tag is given back, so `docker run <tag>` finds it.
    expect(w.calls()).toContain(`load -q -i ${tarOf(w, TAG)}`);
    expect(w.has(TAG)).toBe(true);
  });

  it("pulls a tag again when the cache is an older month's, and keeps the new copy", () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    expect(w.run(pull(TAG), OLDER()).code).toBe(0);
    expect(w.pulls()).toEqual([`pull -q ${TAG}`]);
    expect(w.calls().some((c) => c.startsWith('save '))).toBe(true);
  });

  it('asks for an image named by digest once a month, and loads its copy the rest of the month', () => {
    w.run(pull(DIGEST), CACHE());
    w.freshRunner();
    // An older month's entry: the registry is asked whether it still serves the digest.
    expect(w.run(pull(DIGEST), OLDER()).code).toBe(0);
    expect(w.pulls()).toEqual([`pull -q ${DIGEST}`]);
    w.freshRunner();
    // This month's: the copy is loaded, and the registry is not asked.
    const r = w.run(pull(DIGEST), THIS_MONTH());
    expect(r.code, r.out).toBe(0);
    expect(w.pulls()).toEqual([]);
    expect(w.has(localName(DIGEST))).toBe(true);
    // A digest cannot be given back as a tag: the caller runs the local name.
    expect(w.calls().filter((c) => c.startsWith('tag'))).toEqual([]);
  });

  it('falls back on the copy a refused pull finds, says so, and keeps it for the next run', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), { ...OLDER(), STUB_FAIL_PULLS: TAG });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Data limit exceeded'); // the registry's own error is still in the log
    expect(r.out).toContain(`using the copy of ${TAG} the cache kept from an earlier run`);
    expect(r.out).not.toContain('::warning');
    expect(w.pulls()).toHaveLength(6); // five tries, then the loud one
    expect(w.has(TAG)).toBe(true);
    // The copy it fell back on is what this run used, so the prune keeps it for the month's entry.
    expect(w.run(prune, CACHE()).stdout).toBe('true\n');
    expect(existsSync(tarOf(w, TAG))).toBe(true);
  });

  it('warns the run when a copy stands in for a refused pull, so a green run does not hide it', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_PULLS: TAG, GITHUB_ACTIONS: 'true' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(
      `::warning title=A registry refused a container image::using the copy of ${TAG} `,
    );
  });

  it('keeps what the last, loud pull got, and loads no older copy over it', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_QUIET_PULLS: TAG });
    expect(r.code, r.out).toBe(0);
    const calls = w.calls();
    expect(w.pulls()).toHaveLength(6);
    expect(calls.indexOf(`pull ${TAG}`)).toBeLessThan(
      calls.findIndex((c) => c.startsWith('save ')),
    );
    expect(calls.some((c) => c.startsWith('load '))).toBe(false);
    expect(r.out).not.toContain('the cache kept from an earlier run');
  });

  it('succeeds when only the last, loud pull does, with no copy kept', () => {
    const r = w.run(pull(TAG), { STUB_FAIL_QUIET_PULLS: TAG });
    expect(r.code, r.out).toBe(0);
    expect(w.calls().at(-1)).toBe(`pull ${TAG}`);
  });

  it('fails as before when every pull is refused and no copy is kept', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_PULLS: TAG });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAILED after 5 attempts: ${TAG}`);
  });

  it('pulls again when the copy it has cannot be loaded, and replaces it', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), 'corrupt');
    const r = w.run(pull(TAG), THIS_MONTH());
    expect(r.code, r.out).toBe(0);
    expect(w.pulls()).toEqual([`pull -q ${TAG}`]);
    expect(readFileSync(tarOf(w, TAG), 'utf8')).toBe(localName(TAG));
  });

  it('pulls again when the copy loads under a name other than its local one', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, DIGEST), 'cloud-roaring-ci.invalid/cache:ffffffffffffffff');
    const r = w.run(pull(DIGEST), THIS_MONTH());
    expect(r.code, r.out).toBe(0);
    expect(w.pulls()).toEqual([`pull -q ${DIGEST}`]);
  });

  it('still succeeds when a pulled image cannot be kept, and says so', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_SAVE: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`pulled ${TAG}, but could not keep it in the cache`);
    expect(existsSync(tarOf(w, TAG))).toBe(false);
  });

  it('drops what this run did not use before the cache is saved, and prints on stdout whether anything is left', () => {
    w.run(pull(TAG), CACHE());
    writeFileSync(join(w.cache, '0000000000000000.tar'), 'an image re-pinned away');
    writeFileSync(`${tarOf(w, TAG)}.part`, 'a save cut short');
    const kept = w.run(prune, CACHE());
    expect(kept.stdout).toBe('true\n');
    expect(existsSync(join(w.cache, '0000000000000000.tar'))).toBe(false);
    expect(existsSync(`${tarOf(w, TAG)}.part`)).toBe(false);
    expect(existsSync(join(w.cache, '.used'))).toBe(false);
    expect(existsSync(tarOf(w, TAG))).toBe(true);
    // A run that used nothing leaves nothing to save.
    expect(w.run(prune, CACHE()).stdout).toBe('false\n');
  });

  it('runs an image named by digest by its local name once a copy is loaded, and by the image with no cache', () => {
    const runName = (env: Record<string, string>) =>
      w.run(`${pull(DIGEST)} >/dev/null 2>&1 && docker_image_run_name '${DIGEST}'`, env).stdout;
    w.run(pull(DIGEST), CACHE());
    w.freshRunner();
    expect(runName(THIS_MONTH())).toBe(localName(DIGEST));
    expect(runName({})).toBe(DIGEST);
  });

  describe('scripts/ci-backend-images.sh', () => {
    const script = () => `scripts/ci-backend-images.sh '${join(w.dir, 'override.yml')}'`;
    const override = () => overrideOf(join(w.dir, 'override.yml'));

    it('runs each backend on the local name its own image is kept under, and on the image itself with no cache', () => {
      expect(w.run(script(), CACHE()).code).toBe(0);
      expect(override()).toEqual({
        minio: { image: localName(DIGEST) },
        'fake-gcs': { image: localName(TAG) },
      });
      w.freshRunner();
      expect(w.run(script()).code).toBe(0);
      expect(override()).toEqual({ minio: { image: DIGEST }, 'fake-gcs': { image: TAG } });
    });

    it('readies every backend from the cache on a fresh runner, asking no registry', () => {
      w.run(script(), CACHE());
      w.freshRunner();
      const r = w.run(script(), THIS_MONTH());
      expect(r.code, r.out).toBe(0);
      expect(w.pulls()).toEqual([]);
      expect(override().minio?.image).toBe(localName(DIGEST));
      expect(w.has(localName(DIGEST))).toBe(true);
      expect(w.has(TAG)).toBe(true);
    });

    it('runs a backend on the image itself when its copy could not be kept', () => {
      writeFileSync(join(w.dir, 'a-file'), '');
      const r = w.run(script(), { DOCKER_IMAGE_CACHE: join(w.dir, 'a-file', 'cache') });
      expect(r.code, r.out).toBe(0);
      expect(override()).toEqual({ minio: { image: DIGEST }, 'fake-gcs': { image: TAG } });
    });

    it('reads docker-compose.yml alone, as ci.yml starts it', () => {
      expect(w.run(script()).code).toBe(0);
      expect(w.calls().filter((c) => c.startsWith('compose'))).toEqual([
        `compose -f ${ROOT}/docker-compose.yml config --format json`,
      ]);
    });

    it('fails when the compose file declares no services, rather than write an override compose refuses', () => {
      const r = w.run(script(), { STUB_COMPOSE_JSON: '{"services":{}}' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('declares no services');
    });

    it('fails the step for a service that declares no image, and still readies the others', () => {
      const r = w.run(script(), {
        STUB_COMPOSE_JSON: `{"services":{"minio":{"build":"."},"fake-gcs":{"image":"${TAG}"}}}`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain('service minio declares no image');
      expect(override()).toEqual({ 'fake-gcs': { image: TAG } });
    });

    it('fails the step when one image cannot be had, and still readies the others', () => {
      const r = w.run(script(), { ...CACHE(), STUB_FAIL_PULLS: DIGEST });
      expect(r.code).toBe(1);
      expect(override()).toEqual({ 'fake-gcs': { image: localName(TAG) } });
    });
  });

  describe('the composite actions, run as CI runs them', () => {
    type Action = { runs: { steps: Step[] } };
    const RESTORE = readYaml<Action>('.github/actions/docker-images-restore/action.yml').runs.steps;
    const SAVE = readYaml<Action>('.github/actions/docker-images-save/action.yml').runs.steps;
    const keyStep = RESTORE.find((s) => s.id === 'key');
    const restoreStep = RESTORE.find((s) => s.id === 'restore');
    const envStep = RESTORE.find((s) => s.id === undefined && s.run !== undefined);
    const pruneStep = SAVE.find((s) => s.id === 'prune');
    const saveStep = SAVE.find((s) => s.uses?.startsWith('actions/cache/save@'));
    /** An expression the runner would fill in, as it would fill it in for the integration job. */
    const filled = (text: string, temp: string) =>
      text.replaceAll('${{ inputs.name }}', 'integration').replaceAll('${{ runner.temp }}', temp);

    it('builds the key from the job, the month and a hash of the files and the helper, passed to the shell as data', () => {
      expect(keyStep?.env?.FILES).toBe(
        "${{ hashFiles(inputs.files, 'scripts/lib/docker-pull.sh') }}",
      );
      expect(keyStep?.env?.NAME).toBe('${{ inputs.name }}');
      expect(keyStep?.run).not.toContain('${{');
      const out = join(w.dir, 'github-output');
      const r = w.run(keyStep?.run ?? 'exit 99', {
        NAME: 'integration',
        FILES: 'f00d',
        GITHUB_OUTPUT: out,
      });
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(join(w.dir, 'date-calls'), 'utf8')).toBe('-u +%Y-%m\n');
      expect(readFileSync(out, 'utf8')).toBe('key=docker-images-integration-2026-09-f00d\n');
      // An older entry for the same job is found by the prefix the key begins with.
      expect(filled(restoreStep?.with?.['restore-keys'] ?? '', '')).toBe(
        'docker-images-integration-',
      );
      expect(restoreStep?.with?.key).toBe('${{ steps.key.outputs.key }}');
    });

    it('refuses a name that is not lowercase letters, digits and dashes', () => {
      for (const bad of ['Lambda', 'a b', 'x-', '-x', 'a"; touch /tmp/p; "', '']) {
        const r = w.run(keyStep?.run ?? 'exit 99', {
          NAME: bad,
          FILES: 'f00d',
          GITHUB_OUTPUT: join(w.dir, 'out'),
        });
        expect(r.code, bad).toBe(1);
      }
    });

    it('hands the helper the cache it restored, and the helper then loads a tag without asking', () => {
      const temp = join(w.dir, 'runner-temp');
      const ghEnv = join(w.dir, 'github-env');
      const r = w.run(envStep?.run ?? 'exit 99', {
        HIT: 'true',
        KEY: 'docker-images-integration-2026-09-f00d',
        RUNNER_TEMP: temp,
        GITHUB_ENV: ghEnv,
      });
      expect(r.code, r.out).toBe(0);
      expect(envStep?.env).toEqual({
        HIT: '${{ steps.restore.outputs.cache-hit }}',
        KEY: '${{ steps.key.outputs.key }}',
      });
      const env = Object.fromEntries(
        readFileSync(ghEnv, 'utf8')
          .trim()
          .split('\n')
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      ) as Record<string, string>;
      expect(env).toEqual({
        DOCKER_IMAGE_CACHE: filled(restoreStep?.with?.path ?? '', temp),
        DOCKER_IMAGE_CACHE_HIT: 'true',
        DOCKER_IMAGE_CACHE_KEY: 'docker-images-integration-2026-09-f00d',
      });
      w.run(pull(TAG), { DOCKER_IMAGE_CACHE: env.DOCKER_IMAGE_CACHE ?? '' });
      w.freshRunner();
      expect(w.run(pull(TAG), env).code).toBe(0);
      expect(w.pulls()).toEqual([]);
    });

    it('saves what the run used, where it was restored from, under the key it was restored for', () => {
      expect(pruneStep?.if).toBe(
        "env.DOCKER_IMAGE_CACHE != '' && env.DOCKER_IMAGE_CACHE_HIT != 'true'",
      );
      expect(saveStep?.if).toBe("steps.prune.outputs.kept == 'true'");
      expect(saveStep?.with?.path).toBe(restoreStep?.with?.path);
      expect(saveStep?.with?.key).toBe('${{ env.DOCKER_IMAGE_CACHE_KEY }}');
      w.run(pull(TAG), CACHE());
      const out = join(w.dir, 'github-output');
      expect(w.run(pruneStep?.run ?? 'exit 99', { ...CACHE(), GITHUB_OUTPUT: out }).code).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('kept=true\n');
    });
  });
});

describe('every CI job that pulls an image keeps it in the cache', () => {
  const scripts = packageScripts();
  /** The top-level scripts that pull through the helper. */
  const pullingScript = (file: string) =>
    /^scripts\/[\w.-]+\.sh$/.test(file) &&
    existsSync(join(ROOT, file)) &&
    readFileSync(join(ROOT, file), 'utf8').includes('docker_pull_with_backoff "');
  /** The script a step runs, directly or through `pnpm <name>`, when it is one that pulls. */
  const scriptOf = (run: string): string | undefined => {
    const direct = /(?:^|\s)(?:bash\s+)?(scripts\/[\w.-]+\.sh)\b/.exec(run)?.[1];
    const viaPnpm = /\bpnpm\s+(?:run\s+)?([\w:-]+)/.exec(run)?.[1];
    const script = direct ?? /(scripts\/[\w.-]+\.sh)\b/.exec(scripts[viaPnpm ?? ''] ?? '')?.[1];
    return script !== undefined && pullingScript(script) ? script : undefined;
  };
  const pulling = jobs()
    .map(({ where, job }) => {
      const steps = job.steps ?? [];
      const at = steps.flatMap((s, i) => {
        const script = scriptOf(s.run ?? '');
        return script === undefined ? [] : [{ i, script, run: s.run ?? '' }];
      });
      return { where, steps, at };
    })
    .filter((j) => j.at.length > 0);

  it('finds the jobs, derived from every workflow, so a rename cannot make this vacuous', () => {
    expect(pulling.map((j) => j.where).sort()).toEqual([
      '.github/workflows/ci.yml › integration',
      '.github/workflows/ci.yml › lambda-layer',
      '.github/workflows/ci.yml › lambda-smoke',
      '.github/workflows/ci.yml › rss-gate',
    ]);
  });

  it.each(pulling.map((j) => [j.where, j] as const))(
    '%s restores before its first pull, and saves after its last, once it has every image',
    (_where, { steps, at }) => {
      const restore = steps.findIndex((s) => s.uses === './.github/actions/docker-images-restore');
      const save = steps.findIndex((s) => s.uses === './.github/actions/docker-images-save');
      const first = at[0];
      const last = at.at(-1);
      expect(restore).toBeGreaterThanOrEqual(0);
      expect(restore).toBeLessThan(first?.i ?? -1);
      expect(save).toBeGreaterThan(last?.i ?? Infinity);
      // The key hashes the file that names the images, which must exist: `hashFiles` of a missing file is empty,
      // and a re-pin would then change no key.
      const files = steps[restore]?.with?.files ?? '';
      expect(files).toBe(
        first?.script === 'scripts/ci-backend-images.sh' ? 'docker-compose.yml' : first?.script,
      );
      expect(existsSync(join(ROOT, files))).toBe(true);
      // A saved key is never written again, so what the first save of a month holds is what the month has. The
      // backends' step pulls three images and can fail, or be cancelled, with some of them: the save waits on it.
      // A job whose one image is pulled by the step that then runs its tests saves whatever the tests did.
      if (first?.script === 'scripts/ci-backend-images.sh') {
        const id = steps[first.i]?.id;
        expect(id).toBeDefined();
        expect(save).toBe(first.i + 1);
        expect(steps[save]?.if).toBe(`steps.${id ?? ''}.outcome == 'success'`);
      } else {
        expect(steps[save]?.if).toBe('always()');
      }
    },
  );

  it('keys each job apart: an older entry is found by the name and a dash, so no name begins another', () => {
    const names = pulling.map(
      (j) =>
        j.steps.find((s) => s.uses === './.github/actions/docker-images-restore')?.with?.name ?? '',
    );
    expect(new Set(names).size).toBe(names.length);
    for (const a of names) {
      for (const b of names) {
        if (a !== b) expect(b.startsWith(`${a}-`), `${a} begins ${b}`).toBe(false);
      }
    }
  });

  it('starts the backends on the override the images step wrote', () => {
    const j = pulling.find((x) => x.at.some((p) => p.script === 'scripts/ci-backend-images.sh'));
    const arg = /scripts\/ci-backend-images\.sh\s+(\S+)/.exec(j?.at[0]?.run ?? '')?.[1] ?? '<none>';
    const up = j?.steps.find((s) => /\bdocker\s+compose\b.*\sup\b/.test(s.run ?? ''))?.run ?? '';
    expect(up).toContain(`docker compose -f docker-compose.yml -f ${arg} up`);
  });
});
