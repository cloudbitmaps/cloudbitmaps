import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * shapes these scripts could get wrong (a `load` without `-i`, a tag named by digest, a `compose` read with no `-f`);
 * a `sleep` that returns at once; a `date` that names one month; and a `timeout` that can stall a pull. So each path
 * runs with no network and no daemon: which copy is used, when the registry is asked, what is saved, and what is
 * dropped. A later run starts on a fresh runner, as CI's do, holding only what the save before it kept.
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
    [ -n "$STUB_FAIL_SAVE" ] && [[ "$4" == *"$STUB_FAIL_SAVE"* ]] && exit 1
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

const STUB_TIMEOUT = String.raw`#!/usr/bin/env bash
shift
for f in $STUB_STALL; do
  for a; do
    if [ "$a" = "$f" ]; then echo "$*" >>"$STUB/stalls"; exit 124; fi
  done
done
exec "$@"
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
  /**
   * Run a composite action's `run:` with the flags the runner gives a `shell: bash` step. It runs on this host's bash,
   * which is 3.2 on macOS where the runner's is 5, so a step must not lean on what the two do differently.
   */
  runAsStep: (script: string, env?: Record<string, string>) => Ran;
  calls: () => string[];
  pulls: () => string[];
  /** The pulls the stand-in `timeout` stalled. */
  stalls: () => string[];
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
  // `timeout` as coreutils has it, except that a pull of an image named in STUB_STALL stalls: 124, as on a timeout.
  writeFileSync(join(bin, 'timeout'), STUB_TIMEOUT);
  for (const tool of ['docker', 'sleep', 'date', 'timeout']) chmodSync(join(bin, tool), 0o755);
  const cache = join(dir, 'cache');
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    STUB: dir,
  };
  for (const name of [
    'DOCKER_IMAGE_CACHE',
    'DOCKER_IMAGE_CACHE_HIT',
    'GITHUB_ACTIONS',
    'ImageOS',
  ]) {
    delete base[name];
  }
  const bash = (args: string[], env: Record<string, string>): Ran => {
    const r = spawnSync('bash', args, { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
  };
  const run = (script: string, env: Record<string, string> = {}): Ran => bash(['-c', script], env);
  const runAsStep = (script: string, env: Record<string, string> = {}): Ran =>
    bash(['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], env);
  const calls = () =>
    existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
  const resetCalls = () => {
    rmSync(join(dir, 'calls'), { force: true });
    rmSync(join(dir, 'pull-count'), { force: true });
    rmSync(join(dir, 'stalls'), { force: true });
  };
  const freshRunner = () => {
    // What this run's save would keep: the prune runs, and a cache it calls not worth saving is not saved, so the next
    // run restores none of it. (The next run on an exact hit would get the entry it restored; no test runs one next.)
    if (existsSync(cache) && run(PRUNE, { DOCKER_IMAGE_CACHE: cache }).stdout !== 'true\n') {
      rmSync(cache, { recursive: true, force: true });
    }
    rmSync(join(dir, 'images'), { recursive: true, force: true });
    mkdirSync(join(dir, 'images'));
    resetCalls();
  };
  return {
    dir,
    cache,
    run,
    runAsStep,
    calls,
    pulls: () => calls().filter((c) => c.startsWith('pull')),
    stalls: () =>
      existsSync(join(dir, 'stalls'))
        ? readFileSync(join(dir, 'stalls'), 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
    resetCalls,
    freshRunner,
    has: (name) => existsSync(join(dir, 'images', name.replace(/[/:@]/g, '_'))),
  };
}

const TAG = 'fsouza/fake-gcs-server:1.52.2';
const DIGEST = 'cgr.dev/chainguard/minio@sha256:abc';
/** The part of a cache name that is the image, computed here rather than by the helper under test. */
const idOf = (image: string) => createHash('sha256').update(image).digest('hex').slice(0, 16);
const localName = (image: string) => `cloud-roaring-ci.invalid/cache:${idOf(image)}`;
const tarOf = (w: World, image: string) => join(w.cache, `${idOf(image)}.tar`);
const pull = (image: string) => `. ${HELPER} && docker_pull_with_backoff '${image}'`;
const PRUNE = `. ${HELPER} && docker_image_cache_prune`;
const prune = PRUNE;
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

  it('pulls again when the copy it has cannot be loaded, and keeps the pull in its place', () => {
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
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_SAVE: idOf(TAG) });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`pulled ${TAG}, but could not keep it in the cache`);
    expect(existsSync(tarOf(w, TAG))).toBe(false);
  });

  it('keeps the older copy when a pulled image cannot be kept, and saves nothing that lacks an image', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    expect(w.run(pull(TAG), { ...OLDER(), STUB_FAIL_SAVE: idOf(TAG) }).code).toBe(0);
    // The copy last month's entry held is whole, and stands in for the one this run could not keep.
    expect(w.run(prune, CACHE()).stdout).toBe('true\n');
    expect(readFileSync(tarOf(w, TAG), 'utf8')).toBe(localName(TAG));
    // With no copy of it kept before, the cache lacks the image, so it is not worth saving, whatever else it holds.
    const v = world();
    try {
      v.run(pull(DIGEST), { DOCKER_IMAGE_CACHE: v.cache });
      expect(
        v.run(pull(TAG), { DOCKER_IMAGE_CACHE: v.cache, STUB_FAIL_SAVE: idOf(TAG) }).code,
      ).toBe(0);
      expect(v.run(prune, { DOCKER_IMAGE_CACHE: v.cache }).stdout).toBe('false\n');
    } finally {
      rmSync(v.dir, { recursive: true, force: true });
    }
  });

  it("retries under the callers' `set -euo pipefail`, which a failed attempt must not end", () => {
    const r = w.run(`set -euo pipefail; ${pull(TAG)}; echo pulled`, {
      ...CACHE(),
      STUB_FAIL_FIRST: '2',
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`ok ${TAG} (attempt 3)`);
    expect(r.out).toContain('pulled');
  });

  it('falls back at once on a pull that stalls when a copy is kept, rather than wait out the job', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), { ...OLDER(), STUB_STALL: TAG, GITHUB_ACTIONS: 'true' });
    expect(r.code, r.out).toBe(0);
    expect(w.stalls()).toHaveLength(1);
    expect(r.out).toContain(`the pull of ${TAG} stalled`);
    expect(r.out).toContain(
      `::warning title=A registry refused a container image::using the copy of ${TAG} `,
    );
    expect(w.has(TAG)).toBe(true);
  });

  it('bounds no pull by hand, where one slow layer can outlast the bound', () => {
    const r = w.run(pull(TAG), { STUB_STALL: TAG });
    expect(r.code, r.out).toBe(0);
    expect(w.stalls()).toEqual([]);
  });

  it('retries a stall like any failure when no copy is kept, and then fails', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_STALL: TAG });
    expect(r.code).toBe(1);
    expect(w.stalls()).toHaveLength(6); // five tries, then the loud one
  });

  it('says so when a copy the cache kept does not load', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), 'corrupt');
    const r = w.run(pull(TAG), THIS_MONTH());
    expect(r.out).toContain(`the copy of ${TAG} the cache kept did not load; pulling it`);
  });

  it('drops what this run did not use before the cache is saved, and prints on stdout whether anything is left', () => {
    w.run(pull(TAG), CACHE());
    // Unused files that sort before and after the one in use, so the order the prune reads them in does not matter.
    writeFileSync(join(w.cache, '0000000000000000.tar'), 'an image re-pinned away');
    writeFileSync(join(w.cache, 'ffffffffffffffff.tar'), 'another');
    writeFileSync(`${tarOf(w, TAG)}.part`, 'a save cut short');
    const kept = w.run(prune, CACHE());
    expect(kept.stdout).toBe('true\n');
    expect(existsSync(join(w.cache, '0000000000000000.tar'))).toBe(false);
    expect(existsSync(join(w.cache, 'ffffffffffffffff.tar'))).toBe(false);
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

  describe("the composite actions' own shell, run with the runner's flags", () => {
    type Action = { runs: { steps: Step[] } };
    const RESTORE = readYaml<Action>('.github/actions/docker-images-restore/action.yml').runs.steps;
    const SAVE = readYaml<Action>('.github/actions/docker-images-save/action.yml').runs.steps;
    const keyStep = RESTORE.find((s) => s.id === 'key');
    const restoreStep = RESTORE.find((s) => s.id === 'restore');
    const olderStep = RESTORE.find((s) => s.id === 'older');
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
      const r = w.runAsStep(keyStep?.run ?? 'exit 99', {
        NAME: 'integration',
        FILES: 'f00d',
        ImageOS: 'ubuntu24',
        GITHUB_OUTPUT: out,
      });
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(join(w.dir, 'date-calls'), 'utf8')).toBe('-u +%Y-%m\n');
      expect(readFileSync(out, 'utf8')).toBe(
        'key=docker-images-integration-ubuntu24-2026-09-f00d\n',
      );
      // The exact key first, in this branch and then the base branch, and an older entry of the job's only if neither
      // has it: found by the prefix the key begins with. Every input the restores take, so nothing else changes what
      // they fetch (`lookup-only`, say, which fetches nothing).
      expect(restoreStep?.if).toBeUndefined();
      expect(restoreStep?.with).toEqual({
        path: '${{ runner.temp }}/docker-images',
        key: '${{ steps.key.outputs.key }}',
      });
      expect(olderStep?.if).toBe("steps.restore.outputs.cache-hit != 'true'");
      expect(olderStep?.with).toEqual({
        path: '${{ runner.temp }}/docker-images',
        key: '${{ steps.key.outputs.key }}',
        'restore-keys': 'docker-images-${{ inputs.name }}-',
      });
      expect(filled(olderStep?.with?.['restore-keys'] ?? '', '')).toBe(
        'docker-images-integration-',
      );
    });

    it('refuses a name that is not lowercase letters, digits and dashes', () => {
      for (const bad of ['Lambda', 'a b', 'x-', '-x', 'a"; touch /tmp/p; "', '']) {
        const r = w.runAsStep(keyStep?.run ?? 'exit 99', {
          NAME: bad,
          FILES: 'f00d',
          GITHUB_OUTPUT: join(w.dir, 'out'),
        });
        expect(r.code, bad).toBe(1);
      }
    });

    it('hands the helper the cache it restored, and the helper then loads a tag without asking', () => {
      const temp = join(w.dir, 'runner-temp');
      expect(envStep?.env).toEqual({
        HIT: '${{ steps.restore.outputs.cache-hit }}',
        KEY: '${{ steps.key.outputs.key }}',
      });
      /** What the step writes to GITHUB_ENV, for a restore that set `cache-hit` to `hit`. */
      const exported = (hit: string) => {
        const ghEnv = join(w.dir, `github-env-${hit || 'unset'}`);
        const r = w.runAsStep(envStep?.run ?? 'exit 99', {
          HIT: hit,
          KEY: 'docker-images-integration-2026-09-f00d',
          RUNNER_TEMP: temp,
          GITHUB_ENV: ghEnv,
        });
        expect(r.code, r.out).toBe(0);
        return Object.fromEntries(
          readFileSync(ghEnv, 'utf8')
            .trim()
            .split('\n')
            .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
        ) as Record<string, string>;
      };
      // The restore's own answer passes through as it is: `true` on an exact hit, `false` on an older entry, and
      // nothing on a miss, which must not read as a hit.
      for (const hit of ['false', '']) expect(exported(hit).DOCKER_IMAGE_CACHE_HIT).toBe(hit);
      const env = exported('true');
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
      writeFileSync(join(w.cache, 'ffffffffffffffff.tar'), 'an image re-pinned away');
      const out = join(w.dir, 'github-output');
      const step = () =>
        w.runAsStep(pruneStep?.run ?? 'exit 99', { ...CACHE(), GITHUB_OUTPUT: out });
      expect(step().code).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('kept=true\n');
      expect(existsSync(join(w.cache, 'ffffffffffffffff.tar'))).toBe(false); // the step prunes as well as says
      rmSync(out);
      expect(step().code).toBe(0); // a run that used nothing
      expect(readFileSync(out, 'utf8')).toBe('kept=false\n');
    });
  });
});

describe('every CI job that pulls an image keeps it in the cache', () => {
  const scripts = packageScripts();
  /** A script at any depth under `scripts/` that pulls through the helper, the helper itself aside. */
  const pullingScript = (file: string) =>
    /^scripts\/(?:[\w.-]+\/)*[\w.-]+\.sh$/.test(file) &&
    file !== 'scripts/lib/docker-pull.sh' &&
    existsSync(join(ROOT, file)) &&
    /\bdocker_pull_with_backoff\s+["$]/.test(readFileSync(join(ROOT, file), 'utf8'));
  /** The scripts a shell text runs: by path, `./path` or `bash [flags] path`, or through `pnpm [flags] [run] <name>`. */
  const scriptsIn = (run: string, depth = 0): string[] => {
    const found = [
      ...run.matchAll(/(?:^|[\s;&|(])(?:\.\/)?(scripts\/(?:[\w.-]+\/)*[\w.-]+\.sh)\b/g),
    ].map((m) => m[1] ?? '');
    if (depth < 3) {
      for (const m of run.matchAll(/\bpnpm\s+(?:-{1,2}[\w-]+\s+)*(?:run\s+)?([\w:-]+)/g)) {
        found.push(...scriptsIn(scripts[m[1] ?? ''] ?? '', depth + 1));
      }
    }
    return found;
  };
  const pulling = jobs()
    .map(({ where, job }) => {
      const steps = job.steps ?? [];
      const at = steps.flatMap((s, i) => {
        const script = scriptsIn(s.run ?? '').find(pullingScript);
        return script === undefined ? [] : [{ i, script, run: s.run ?? '' }];
      });
      return { where, job, steps, at };
    })
    .filter((j) => j.at.length > 0);
  const restoreOf = (steps: Step[]) =>
    steps.findIndex((s) => s.uses === './.github/actions/docker-images-restore');

  it('finds the jobs, derived from every workflow, so a rename cannot make this vacuous', () => {
    expect(pulling.map((j) => j.where)).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml › integration',
        '.github/workflows/ci.yml › lambda-smoke',
        '.github/workflows/ci.yml › rss-gate',
      ]),
    );
  });

  it('reads how a step runs a script: by path, through bash or pnpm, with their flags, at any depth', () => {
    expect(scriptsIn('./scripts/lambda-smoke.sh')).toEqual(['scripts/lambda-smoke.sh']);
    expect(scriptsIn('bash -e scripts/ci/pull.sh')).toEqual(['scripts/ci/pull.sh']);
    expect(scriptsIn('pnpm --silent lambda-smoke')).toEqual(['scripts/lambda-smoke.sh']);
    expect(scriptsIn('pnpm -s run rss-gate')).toEqual(['scripts/rss-gate.sh']);
    expect(scriptsIn('pnpm install --frozen-lockfile')).toEqual([]);
  });

  it.each(pulling.map((j) => [j.where, j] as const))(
    '%s restores before its first pull, and saves after its last, once it has every image',
    (_where, { job, steps, at }) => {
      const restore = restoreOf(steps);
      const save = steps.findIndex((s) => s.uses === './.github/actions/docker-images-save');
      const first = at[0];
      const last = at.at(-1);
      expect(restore).toBeGreaterThanOrEqual(0);
      expect(restore).toBeLessThan(first?.i ?? -1);
      // A restore that runs only sometimes leaves the other runs pulling with no copy behind them.
      expect(steps[restore]?.if).toBeUndefined();
      expect(save).toBeGreaterThan(last?.i ?? Infinity);
      // The key hashes the file that names the images, which must exist: a missing one drops out of the hash, and a
      // re-pin would then change no key.
      const files = steps[restore]?.with?.files ?? '';
      expect(files).toBe(
        first?.script === 'scripts/ci-backend-images.sh' ? 'docker-compose.yml' : first?.script,
      );
      expect(existsSync(join(ROOT, files))).toBe(true);
      // A saved key is never written again, so what the first save of a month holds is what the month has. So the
      // save runs only when every step before it passed: the job then has every image, each has passed the tests,
      // and a run that failed, or was cancelled, part-way keeps nothing.
      expect(steps[save]?.if).toBeUndefined();
      // And it is the last step, but for a cleanup that runs whatever happened: a step after it could fail once the
      // month's entry was saved.
      for (const later of steps.slice(save + 1)) {
        expect(
          later.if ?? '',
          `${later.name ?? later.run ?? later.uses} runs after the save`,
        ).toMatch(/\balways\(\)/);
      }
      const tests = steps.findIndex((s) => /\bpnpm (?:run )?test:integration\b/.test(s.run ?? ''));
      if (first?.script === 'scripts/ci-backend-images.sh') expect(save).toBeGreaterThan(tests);
      // The legs of a matrix run at once and would race to save one key, each with its own images: each keeps its own.
      if (job.strategy?.matrix !== undefined) {
        expect(steps[restore]?.with?.name ?? '').toContain('${{ matrix.');
      }
    },
  );

  it('keys each job apart: an older entry is found by the name and a dash, so no name begins another', () => {
    const names = pulling.map((j) => j.steps[restoreOf(j.steps)]?.with?.name ?? '');
    expect(new Set(names).size).toBe(names.length);
    for (const a of names) {
      for (const b of names) {
        if (a !== b) expect(b.startsWith(`${a}-`), `${a} begins ${b}`).toBe(false);
      }
    }
  });

  it('starts the backends on the override the images step wrote, and on nothing else', () => {
    const j = pulling.find((x) => x.at.some((p) => p.script === 'scripts/ci-backend-images.sh'));
    const arg = /scripts\/ci-backend-images\.sh\s+(\S+)/.exec(j?.at[0]?.run ?? '')?.[1] ?? '<none>';
    const up = j?.steps.find((s) => /\bdocker\s+compose\b.*\sup\b/.test(s.run ?? ''))?.run ?? '';
    const files = [...up.matchAll(/\s(?:-f|--file)[\s=]+(\S+)/g)].map((m) => m[1]);
    expect(files).toEqual(['docker-compose.yml', arg]);
  });
});
