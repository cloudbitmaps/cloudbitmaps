import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { vi } from 'vitest';
import { ROOT, jobs, packageScripts, readYaml, type Job, type Step } from '../helpers/workflows';

/**
 * The images CI runs are kept in the Actions cache, so that a registry which refuses or throttles a pull fails a run
 * only when no copy is kept. Registries do both: quay.io refuses anonymous pulls of MinIO outright, which is why
 * MinIO comes from Chainguard, and public.ecr.aws can answer `Data limit exceeded` to the RSS gate's pull of
 * `node:22`. A refusal like either, with no copy kept, fails every run that needs the image, on `main` and on every
 * PR alike.
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
    # A save that fails leaves nothing at its path: docker writes to a temporary file beside it, and renames it only
    # when done. A save killed part-way leaves that file.
    if [ -n "$STUB_FAIL_SAVE" ] && [[ "$4" == *"$STUB_FAIL_SAVE"* ]]; then
      printf 'partial' >"$(dirname "$3")/.tmp-$(basename "$3")123"; exit 1
    fi
    [ -e "$STUB/images/$(present "$4")" ] || exit 1
    printf '%s' "$4" >"$3"
    exit 0 ;;
  load)
    if [ "$2" = -q ] && [ "$3" = -i ]; then file="$4"; elif [ "$2" = -i ] && [ "$4" = -q ]; then file="$3"; else exit 1; fi
    [ -f "$file" ] || exit 1
    name="$(cat "$file")"
    [ "$name" = corrupt ] || [ "$name" = partial ] && exit 1
    touch "$STUB/images/$(present "$name")"
    echo "Loaded image: $name"
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
echo "$1" >>"$STUB/timeouts"
shift
n="$(wc -l <"$STUB/timeouts" | tr -d ' ')"
for k in $STUB_STALL_AT; do
  if [ "$k" = "$n" ]; then echo "$*" >>"$STUB/stalls"; exit 124; fi
done
for f in $STUB_STALL; do
  for a; do
    if [ "$a" = "$f" ]; then echo "$*" >>"$STUB/stalls"; exit 124; fi
  done
done
for f in $STUB_STALL_LOUD; do
  if [ "$1 $2 $3" = "docker pull $f" ]; then echo "$*" >>"$STUB/stalls"; exit 124; fi
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
  /** The waits the stand-in `sleep` was asked for, in seconds, in order. */
  sleeps: () => string[];
  /** The pulls the stand-in `timeout` stalled. */
  stalls: () => string[];
  resetCalls: () => void;
  /** A new runner, as each CI job gets: no images at all, and only what the save of `cache` would keep. */
  freshRunner: (cache?: string) => void;
  /** Whether the stand-in holds an image under `name`. */
  has: (name: string) => boolean;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'docker-image-cache-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(bin, 'docker'), STUB_DOCKER);
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\necho "$1" >>"$STUB/sleeps"\nexit 0\n');
  writeFileSync(
    join(bin, 'date'),
    '#!/usr/bin/env bash\necho "$*" >>"$STUB/date-calls"\necho 2026-09\n',
  );
  // `timeout` as coreutils has it, except that a pull of an image named in STUB_STALL stalls: 124, as on a timeout.
  // STUB_STALL_LOUD stalls only the last, loud pull, the one run without `-q`, and STUB_STALL_AT the attempts it
  // numbers, counting from 1.
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
    rmSync(join(dir, 'sleeps'), { force: true });
  };
  const freshRunner = (kept = cache) => {
    // What this run's save would keep: the prune runs, and a cache it calls not worth saving is not saved, so the next
    // run restores none of it. (The next run on an exact hit would get the entry it restored; no test runs one next.)
    if (existsSync(kept) && run(PRUNE, { DOCKER_IMAGE_CACHE: kept }).stdout !== 'true\n') {
      rmSync(kept, { recursive: true, force: true });
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
    sleeps: () =>
      existsSync(join(dir, 'sleeps'))
        ? readFileSync(join(dir, 'sleeps'), 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
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
const localName = (image: string) => `cloudbitmaps-ci.invalid/cache:${idOf(image)}`;
const tarOf = (w: World, image: string) => join(w.cache, `${idOf(image)}.tar`);
const pull = (image: string) => `. ${HELPER} && docker_pull_with_backoff '${image}'`;
const PRUNE = `. ${HELPER} && docker_image_cache_prune`;
const prune = PRUNE;
const overrideOf = (file: string) =>
  (parse(readFileSync(file, 'utf8')) as { services: Record<string, { image: string }> }).services;

// Nothing here reads a clock: `sleep`, `date` and `timeout` are stand-ins that return at once, so there is no timer to
// fake. What costs time is the bash processes each case starts, up to a few hundred of them, and on a machine running
// the whole suite that can pass the default 5 s of a case that takes under a second alone. So this file's cases get a
// limit that only a hung script reaches.
vi.setConfig({ testTimeout: 60_000 });

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

  it('pulls from the registry, and keeps nothing, with no cache set', () => {
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
      `::warning title=A registry did not serve a container image::using the copy of ${TAG} `,
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

  it('fails, as a pull with no cache does, when every pull is refused and no copy is kept', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_PULLS: TAG });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAILED after 5 attempts: ${TAG}`);
    expect(r.out).not.toContain('stalled'); // a refusal is not reported as a stall
    expect(w.sleeps()).toEqual(['10', '20', '30', '40']); // a linear backoff, waited out in turn
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
    writeFileSync(tarOf(w, DIGEST), 'cloudbitmaps-ci.invalid/cache:ffffffffffffffff');
    const r = w.run(pull(DIGEST), THIS_MONTH());
    expect(r.code, r.out).toBe(0);
    expect(w.pulls()).toEqual([`pull -q ${DIGEST}`]);
  });

  it("loads a copy saved under an older prefix and this image's own id, without asking the registry", () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, DIGEST), `older-ci.invalid/cache:${idOf(DIGEST)}`);
    const r = w.run(pull(DIGEST), THIS_MONTH());
    expect(r.code, r.out).toBe(0);
    expect(w.pulls()).toEqual([]);
    expect(w.has(localName(DIGEST))).toBe(true);
  });

  it('falls back on a copy saved under an older prefix and its own id, when the registry refuses', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), `older-ci.invalid/cache:${idOf(TAG)}`);
    const r = w.run(pull(TAG), { ...OLDER(), STUB_FAIL_PULLS: TAG });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('using the copy of');
    expect(w.has(TAG)).toBe(true);
  });

  it("still refuses a copy saved under an older prefix and another image's id, and pulls again", () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, DIGEST), `older-ci.invalid/cache:${idOf(TAG)}`);
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

  it("keeps a pull it cannot record as used, says so, and saves nothing, under the callers' `set -e`", () => {
    // One image is recorded. The list then cannot be appended to, as on a full disk, for the second pull alone, and
    // is back by the prune: had the second gone unmarked, the prune would drop its copy and call the rest worth saving.
    expect(w.run(pull(DIGEST), CACHE()).code).toBe(0);
    const used = join(w.cache, '.used');
    const recorded = readFileSync(used, 'utf8');
    rmSync(used);
    mkdirSync(used);
    const r = w.run(`set -euo pipefail; ${pull(TAG)}; echo pulled`, CACHE());
    rmSync(used, { recursive: true });
    writeFileSync(used, recorded);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('pulled');
    expect(r.out).toContain(`could not record that this run used ${idOf(TAG)}.tar`);
    expect(w.run(prune, CACHE()).stdout).toBe('false\n');
  });

  it('drops the temporary file a save cut short left, so no save keeps it', () => {
    expect(w.run(pull(TAG), { ...CACHE(), STUB_FAIL_SAVE: idOf(TAG) }).code).toBe(0);
    expect(readdirSync(w.cache).some((f) => f.startsWith('.tmp-'))).toBe(true);
    expect(w.run(prune, CACHE()).stdout).toBe('false\n');
    expect(readdirSync(w.cache).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('keeps going when neither the pull nor the older copy can be recorded, and saves nothing', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    mkdirSync(join(w.cache, '.used'));
    const r = w.run(`set -euo pipefail; ${pull(TAG)}; echo pulled`, {
      ...OLDER(),
      STUB_FAIL_SAVE: idOf(TAG),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('pulled');
    expect(w.run(prune, CACHE()).stdout).toBe('false\n');
  });

  it('says the registry stalled when only the last, loud pull stalls', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), {
      ...OLDER(),
      STUB_FAIL_QUIET_PULLS: TAG,
      STUB_STALL_LOUD: TAG,
      GITHUB_ACTIONS: 'true',
    });
    expect(r.code, r.out).toBe(0);
    expect(w.stalls()).toHaveLength(1);
    expect(r.out).toContain(
      `::warning title=A registry did not serve a container image::using the copy of ${TAG} the cache kept from an earlier run: the registry stalled`,
    );
  });

  it('says the last pull stalled when it did and no copy is kept', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_FAIL_QUIET_PULLS: TAG, STUB_STALL_LOUD: TAG });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAILED: the last pull of ${TAG} stalled (cut off after 180s)`);
  });

  it('counts stalls in all, not in a row: a stall, a refusal and a stall end the tries at the third attempt', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_STALL_AT: '1 3', STUB_FAIL_PULLS: TAG });
    expect(r.code).toBe(1);
    expect(readFileSync(join(w.dir, 'timeouts'), 'utf8').split('\n').filter(Boolean)).toHaveLength(
      3,
    );
    expect(r.out).toContain(`${TAG} throttled or unavailable (attempt 2/5)`);
    expect(r.out).toContain(`the pull of ${TAG} stalled twice`);
  });

  it('falls back at once on a pull that stalls when a copy is kept, rather than wait out the job', () => {
    w.run(pull(TAG), CACHE());
    w.freshRunner();
    const r = w.run(pull(TAG), { ...OLDER(), STUB_STALL: TAG, GITHUB_ACTIONS: 'true' });
    expect(r.code, r.out).toBe(0);
    expect(w.stalls()).toHaveLength(1);
    expect(r.out).toContain(`the pull of ${TAG} stalled`);
    expect(r.out).toContain(
      `::warning title=A registry did not serve a container image::using the copy of ${TAG} `,
    );
    expect(w.has(TAG)).toBe(true);
  });

  it('bounds no pull by hand, where one slow layer can outlast the bound', () => {
    const r = w.run(pull(TAG), { STUB_STALL: TAG });
    expect(r.code, r.out).toBe(0);
    expect(w.stalls()).toEqual([]);
    expect(existsSync(join(w.dir, 'timeouts'))).toBe(false);
  });

  it('gives up at a second stall when no copy is kept, rather than run out the job, and says why', () => {
    const r = w.run(pull(TAG), { ...CACHE(), STUB_STALL: TAG });
    expect(r.code).toBe(1);
    expect(w.stalls()).toHaveLength(2);
    expect(r.out).toContain(`${TAG} stalled (attempt 1/5)`);
    expect(r.out).toContain(
      `the pull of ${TAG} stalled twice, and no copy the cache kept could stand in`,
    );
    expect(r.out).not.toContain('did not load');
  });

  it('gives up at a second stall when the copy it has does not load', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), 'corrupt');
    const r = w.run(pull(TAG), { ...OLDER(), STUB_STALL: TAG });
    expect(r.code).toBe(1);
    expect(w.stalls()).toHaveLength(2);
    expect(r.out).toContain(`the copy of ${TAG} the cache kept did not load either`);
    // A copy that has failed to load is not tried again at the next stall.
    expect(w.calls().filter((c) => c.startsWith('load'))).toHaveLength(1);
  });

  it('fails when the copy it has does not load and the registry refuses too, and says both', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), 'corrupt');
    const r = w.run(pull(TAG), { ...OLDER(), STUB_FAIL_PULLS: TAG });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAILED after 5 attempts: ${TAG}`);
    expect(r.out).toContain(`the copy of ${TAG} the cache kept did not load either`);
  });

  it('bounds each attempt in CI at 180 s, or at DOCKER_PULL_TIMEOUT', () => {
    const timeouts = () => readFileSync(join(w.dir, 'timeouts'), 'utf8');
    w.run(pull(TAG), CACHE());
    expect(timeouts()).toBe('180\n');
    rmSync(join(w.dir, 'timeouts'));
    w.run(pull(DIGEST), { ...CACHE(), DOCKER_PULL_TIMEOUT: '600' });
    expect(timeouts()).toBe('600\n');
  });

  it('says so when a copy the cache kept does not load', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), 'corrupt');
    const r = w.run(pull(TAG), THIS_MONTH());
    expect(r.out).toContain(`the copy of ${TAG} the cache kept did not load; pulling it`);
  });

  it('does not load a copy again as a fall-back once it has failed to load', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(tarOf(w, TAG), 'corrupt');
    const r = w.run(pull(TAG), { ...THIS_MONTH(), STUB_FAIL_PULLS: TAG });
    expect(r.code).toBe(1);
    expect(w.calls().filter((c) => c.startsWith('load'))).toHaveLength(1);
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
      expect(w.sleeps()).toEqual(['2', '2']); // one backend at a time
      expect(override().minio?.image).toBe(localName(DIGEST));
      expect(w.has(localName(DIGEST))).toBe(true);
      expect(w.has(TAG)).toBe(true);
    });

    it('runs a backend on the image itself when the helper could not name it', () => {
      writeFileSync(join(w.dir, 'a-file'), '');
      const r = w.run(script(), { DOCKER_IMAGE_CACHE: join(w.dir, 'a-file', 'cache') });
      expect(r.code, r.out).toBe(0);
      expect(override()).toEqual({ minio: { image: DIGEST }, 'fake-gcs': { image: TAG } });
    });

    it('runs a backend on its local name when the save of its copy failed after naming it', () => {
      const r = w.run(script(), { ...CACHE(), STUB_FAIL_SAVE: idOf(DIGEST) });
      expect(r.code, r.out).toBe(0);
      expect(override().minio?.image).toBe(localName(DIGEST));
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
      w.freshRunner(env.DOCKER_IMAGE_CACHE);
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
  const RESTORE = './.github/actions/docker-images-restore';
  const SAVE = './.github/actions/docker-images-save';
  const scripts = packageScripts();
  /** Whether a script's text pulls through the helper, whatever its image is written as. */
  const pullsThroughHelper = (text: string) => /\bdocker_pull_with_backoff\s+\S/.test(text);
  /** A repo file's text, or nothing for a file that is not there. */
  const repoFile = (file: string): string | undefined =>
    existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : undefined;
  /**
   * The scripts a shell text runs that pull through the helper, the helper itself aside: each such script it runs,
   * and each one a script it runs runs in turn, three scripts deep, under any directory of `scripts/`. `read` gives a
   * file's text.
   */
  const pullingScriptsIn = (run: string, read = repoFile, depth = 0): string[] =>
    scriptsIn(run).flatMap((file) => {
      const text = file === 'scripts/lib/docker-pull.sh' ? undefined : read(file);
      if (text === undefined) return [];
      if (pullsThroughHelper(text)) return [file];
      return depth < 3 ? pullingScriptsIn(text, read, depth + 1) : [];
    });
  /** The flags of each tool that take a value, so the word after one is not read as the script. */
  const VALUE_FLAGS = {
    pnpm: /^(?:-C|--dir|--filter|-F|--reporter|--loglevel|--workspace-concurrency)$/,
    npm: /^(?:--prefix|-w|--workspace|--loglevel|--userconfig)$/,
  };
  /** The `package.json` script a `pnpm` or `npm` command runs, past its flags and their values, if any. */
  const packageScriptOf = (tool: 'pnpm' | 'npm', args: string): string | undefined => {
    const words = args.trim().split(/\s+/);
    let command: string | undefined;
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? '';
      if (VALUE_FLAGS[tool].test(w)) i++;
      else if (w === '' || w.startsWith('-')) continue;
      else if (command !== undefined) return w;
      else if (w !== 'run' && w !== 'run-script') {
        return tool === 'npm' && !/^(?:test|t|start|stop|restart)$/.test(w) ? undefined : w;
      } else command = w;
    }
    return undefined;
  };
  /**
   * The scripts a shell text runs: a path under `scripts/`, bare or after `./`, a variable (`$GITHUB_WORKSPACE/`) or
   * an expression, and a `package.json` script run through `pnpm` or `npm`, followed to the scripts it runs.
   */
  const scriptsIn = (run: string, depth = 0): string[] => {
    const text = run.replace(/\\\r?\n/g, ' ');
    const found = [
      ...text.matchAll(
        /(?:^|[\s;&|("'=]|\.\/|\$\{?\w+\}?["']?\/|\}\}["']?\/)(scripts\/(?:[\w.-]+\/)*[\w.-]+\.sh)\b/g,
      ),
    ].map((m) => m[1] ?? '');
    if (depth < 3) {
      for (const m of text.matchAll(/\b(pnpm|npm)\s+([^;&|\n]*)/g)) {
        const name = packageScriptOf(m[1] === 'npm' ? 'npm' : 'pnpm', m[2] ?? '');
        if (name !== undefined) found.push(...scriptsIn(scripts[name] ?? '', depth + 1));
      }
    }
    return found;
  };
  const stepName = (s: Step) => s.name ?? s.run ?? s.uses ?? '(unnamed step)';
  /**
   * A condition with its status functions written as the patterns below read them. GitHub reads a function's name in
   * any case, with space before its brackets, so `Always ()` is `always()`.
   */
  const statusOf = (condition: string) =>
    condition.replace(
      /\b(success|failure|always|cancelled)\s*\(\s*\)/gi,
      (_m, name: string) => `${name.toLowerCase()}()`,
    );
  /** A condition that is the default, `success()`, spelled out or left out. */
  const ON_SUCCESS = /^\s*(?:\$\{\{\s*)?success\(\)\s*(?:\}\})?\s*$/;
  /**
   * A save condition that still waits for every step before it. GitHub puts `success() &&` before a condition that
   * names no status function, so `github.ref == 'refs/heads/main'` does; so does `success() && …` with nothing that
   * could let a failure through after it.
   */
  const savesOnlyOnSuccess = (written: string) => {
    const condition = statusOf(written);
    return (
      !/\b(?:success|failure|always|cancelled)\(\)/.test(condition) ||
      ON_SUCCESS.test(condition) ||
      (/^\s*(?:\$\{\{\s*)?success\(\)\s*&&[^|]*$/.test(condition) &&
        !/\b(?:failure|always|cancelled)\(\)/.test(condition))
    );
  };
  /**
   * Whether a step can let the command it runs fail and still pass: an `||` after it, `set +e`, or a shell that does
   * not stop at a failed command. GitHub's `bash` and `sh`, and no `shell:` at all, stop at one.
   */
  const swallows = (step: Step) =>
    /\|\|/.test(step.run ?? '') ||
    /(?:^|[\s;&])set\s+\+e\b/.test(step.run ?? '') ||
    (step.shell !== undefined &&
      !/^\s*(?:bash|sh)\s*$/.test(step.shell) &&
      !/\s-[a-z]*e/.test(step.shell));
  /**
   * A condition under which a step runs on every run whose save runs, or on none: nothing that can skip a test while
   * the save goes ahead.
   */
  const RUNS_WITH_THE_SAVE =
    /^\s*(?:\$\{\{\s*)?(?:success\(\)|always\(\)|!\s*cancelled\(\)|failure\(\)|success\(\)\s*\|\|\s*failure\(\))\s*(?:\}\})?\s*$/;
  /** A condition under which a step also runs after one that failed: a cleanup, which tests no image. */
  const CLEANUP = /\balways\(\)|!\s*cancelled\(\)|\bfailure\(\)/;
  /**
   * What is wrong with how a job keeps its images, one entry per fault. A job that runs no pulling script has none.
   *
   * A saved key is never written again, so what the first save of a month holds is what the month has. So the save
   * runs only when every step before it passed: the job then has every image, and each has passed the tests. Nothing
   * but a cleanup runs after it, and nothing before it may fail without failing the job.
   */
  const problemsOf = (job: Job, read = repoFile): string[] => {
    const steps = job.steps ?? [];
    // A pull written in the workflow has no file of its own for the key to hash, so a re-pin there changes no key.
    const found = steps
      .filter((s) => pullsThroughHelper(s.run ?? ''))
      .map((s) => `pulls in ${stepName(s)} itself: move the pull into a script under scripts/`);
    const at = steps.flatMap((s, i) => {
      const [script] = pullingScriptsIn(s.run ?? '', read);
      return script === undefined ? [] : [{ i, script, run: s.run ?? '' }];
    });
    const first = at[0];
    const last = at.at(-1);
    if (first === undefined || last === undefined) return found;
    const restore = steps.findIndex((s) => s.uses === RESTORE);
    const save = steps.findIndex((s) => s.uses === SAVE);
    if (restore < 0 || restore > first.i) found.push('restores no cache before its first pull');
    // A restore that runs only sometimes leaves the other runs pulling with no copy behind them.
    else if (steps[restore]?.if !== undefined) found.push('restores its cache only sometimes');
    if (save < 0 || save < last.i) found.push('saves no cache after its last pull');
    else {
      const condition = steps[save]?.if;
      if (condition !== undefined && !savesOnlyOnSuccess(condition)) {
        found.push(`saves its cache if ${condition}, which can save after a step failed`);
      }
      for (const between of steps.slice(Math.max(restore, 0) + 1, save)) {
        if (between.if !== undefined && !RUNS_WITH_THE_SAVE.test(statusOf(between.if))) {
          found.push(
            `runs ${stepName(between)} only if ${between.if}, and saves whether or not it ran`,
          );
        }
      }
      for (const later of steps.slice(save + 1)) {
        if (!CLEANUP.test(statusOf(later.if ?? ''))) {
          found.push(`runs ${stepName(later)} after the save`);
        }
      }
      const tests = steps.findIndex((s) =>
        [...(s.run ?? '').matchAll(/\bpnpm\s+([^;&|\n]*)/g)].some(
          (m) => packageScriptOf('pnpm', m[1] ?? '') === 'test:integration',
        ),
      );
      steps.slice(0, save).forEach((earlier, i) => {
        const soft = earlier['continue-on-error'];
        const checked = i === tests || at.some((p) => p.i === i);
        if (
          (soft !== undefined && soft !== false && soft !== 'false') ||
          (checked && swallows(earlier))
        ) {
          found.push(`lets ${stepName(earlier)} fail and still saves`);
        }
      });
      if (first.script === 'scripts/ci-backend-images.sh') {
        if (tests < 0) found.push('runs no tests before its save');
        else if (save < tests) found.push('saves before its tests run');
      }
    }
    // The key hashes the file that names the images, which must exist: a missing one drops out of the hash, and a
    // re-pin would then change no key.
    const files = restore < 0 ? '' : (steps[restore]?.with?.files ?? '');
    const want =
      first.script === 'scripts/ci-backend-images.sh' ? 'docker-compose.yml' : first.script;
    if (restore >= 0 && files !== want) {
      found.push(`hashes ${files || 'no file'}, not ${want}, which names its images`);
    } else if (restore >= 0 && read(files) === undefined) {
      found.push(`hashes ${files}, which does not exist`);
    }
    // The legs of a matrix run at once and would race to save one key, each with its own images.
    if (
      job.strategy?.matrix !== undefined &&
      !(steps[restore]?.with?.name ?? '').includes('${{ matrix.')
    ) {
      found.push('keys every leg of its matrix alike');
    }
    if (first.script === 'scripts/ci-backend-images.sh') {
      const arg = /scripts\/ci-backend-images\.sh\s+(\S+)/.exec(first.run)?.[1] ?? '<none>';
      const up =
        steps
          .map((s) => (s.run ?? '').replace(/\\\r?\n/g, ' '))
          .find((r) => /\bdocker\s+compose\b.*\sup\b/.test(r)) ?? '';
      const composeFiles = [...up.matchAll(/\s(?:-f|--file)[\s=]+(\S+)/g)].map((m) => m[1]);
      if (composeFiles.join(' ') !== `docker-compose.yml ${arg}`) {
        found.push(
          `starts the backends on ${composeFiles.join(' and ') || 'no file'}, not the override`,
        );
      }
    }
    return found;
  };
  /** Pairs of names one of which an older entry's prefix would find the other's under. */
  const prefixClashes = (names: string[]): string[] =>
    names.flatMap((a) =>
      names.filter((b) => a !== b && b.startsWith(`${a}-`)).map((b) => `${a} begins ${b}`),
    );
  const pulling = jobs().filter(({ job }) =>
    (job.steps ?? []).some(
      (s) => pullingScriptsIn(s.run ?? '').length > 0 || pullsThroughHelper(s.run ?? ''),
    ),
  );

  it('finds the jobs, derived from every workflow, so a rename cannot make this vacuous', () => {
    expect(pulling.map((j) => j.where)).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml › integration',
        '.github/workflows/ci.yml › lambda-smoke',
        '.github/workflows/ci.yml › rss-gate',
      ]),
    );
  });

  it('reads how a step runs a script: by path, through bash, pnpm or npm, with their flags, at any depth', () => {
    const cases: [string, string[]][] = [
      ['./scripts/lambda-smoke.sh', ['scripts/lambda-smoke.sh']],
      ['bash -e scripts/ci/pull.sh', ['scripts/ci/pull.sh']],
      ['bash "$GITHUB_WORKSPACE/scripts/lambda-smoke.sh"', ['scripts/lambda-smoke.sh']],
      ['bash ${{ github.workspace }}/scripts/lambda-smoke.sh', ['scripts/lambda-smoke.sh']],
      ['bash "$GITHUB_WORKSPACE"/scripts/rss-gate.sh', ['scripts/rss-gate.sh']],
      ["bash '${{ github.workspace }}'/scripts/rss-gate.sh", ['scripts/rss-gate.sh']],
      ['pnpm --silent lambda-smoke', ['scripts/lambda-smoke.sh']],
      ['pnpm -s run rss-gate', ['scripts/rss-gate.sh']],
      ['pnpm run --silent rss-gate', ['scripts/rss-gate.sh']],
      ['pnpm -C . lambda-smoke', ['scripts/lambda-smoke.sh']],
      ['npm run lambda-smoke', ['scripts/lambda-smoke.sh']],
      ['npm --prefix . run rss-gate', ['scripts/rss-gate.sh']],
      ['pnpm install --frozen-lockfile', []],
      ['npm ci', []],
      ['bench/scripts/rss-gate.sh', []],
    ];
    for (const [run, want] of cases) expect(scriptsIn(run), run).toEqual(want);
    for (const call of ['"$IMAGE"', '$IMAGE', 'alpine:3', "'alpine:3'"]) {
      expect(pullsThroughHelper(`docker_pull_with_backoff ${call}`), call).toBe(true);
    }
    expect(pullsThroughHelper('# docker_pull_with_backoff is sourced below')).toBe(true);
    expect(pullsThroughHelper('docker_pull_with_backoff() {')).toBe(false);
    // A script that runs a pulling script pulls too: the one found is the one that names the images.
    const tree: Record<string, string> = {
      'scripts/ci-gates.sh': 'bash scripts/nested/gates.sh',
      'scripts/nested/gates.sh': 'set -e\n./scripts/rss-gate.sh',
      'scripts/rss-gate.sh':
        '. scripts/lib/docker-pull.sh\ndocker_pull_with_backoff "$STAGE_IMAGE"',
      'scripts/lib/docker-pull.sh': 'docker_pull_with_backoff "$1"',
      'scripts/quiet.sh': 'echo nothing to pull',
    };
    const read = (f: string) => tree[f];
    expect(pullingScriptsIn('scripts/ci-gates.sh', read)).toEqual(['scripts/rss-gate.sh']);
    expect(pullingScriptsIn('bash scripts/quiet.sh && scripts/lib/docker-pull.sh', read)).toEqual(
      [],
    );
  });

  it('reads a job for each way it could keep its images wrongly, and passes the ways that are right', () => {
    const pin = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
    const restore: Step = {
      uses: RESTORE,
      with: { name: 'rss-gate', files: 'scripts/rss-gate.sh' },
    };
    const pull: Step = { run: 'pnpm rss-gate' };
    const save: Step = { uses: SAVE };
    const job = (...steps: Step[]): Job => ({ steps: [{ uses: pin }, ...steps] });
    const right: [string, Job][] = [
      ['as CI has it', job(restore, pull, save)],
      ['a cleanup after the save', job(restore, pull, save, { if: 'always()', run: 'rm -rf x' })],
      [
        'a cleanup unless cancelled',
        job(restore, pull, save, { if: '${{ !cancelled() }}', run: 'x' }),
      ],
      [
        'a cleanup on success or failure',
        job(restore, pull, save, { if: 'success() || failure()', run: 'x' }),
      ],
      ['a log dump on failure', job(restore, pull, save, { if: 'failure()', run: 'x' })],
      ['a cleanup, capitalised', job(restore, pull, save, { if: 'Always()', run: 'x' })],
      ['the pull in bash, named', job(restore, { ...pull, shell: 'bash' }, save)],
      [
        'the pull in a shell that stops',
        job(restore, { ...pull, shell: 'bash --noprofile --norc -eo pipefail {0}' }, save),
      ],
      [
        'an || in a step that neither pulls nor tests',
        job(restore, { run: 'df -h || true' }, pull, save),
      ],
      [
        'a log dump on failure before the save',
        job(restore, pull, { if: 'failure()', run: 'x' }, save),
      ],
      [
        'a save on main alone, which GitHub runs only on success',
        job(restore, pull, { ...save, if: "github.ref == 'refs/heads/main'" }),
      ],
      [
        'a save on success and a push',
        job(restore, pull, { ...save, if: "success() && github.event_name == 'push'" }),
      ],
      ['a save on success, spelled out', job(restore, pull, { ...save, if: 'success()' })],
      [
        'a save on success, as an expression',
        job(restore, pull, { ...save, if: '${{ success() }}' }),
      ],
      [
        'a step allowed to fail after the save',
        job(restore, pull, save, { if: 'always()', run: 'x', 'continue-on-error': true }),
      ],
      [
        'a matrix keyed by its leg',
        {
          ...job(
            {
              ...restore,
              with: { name: 'rss-gate-${{ matrix.node }}', files: 'scripts/rss-gate.sh' },
            },
            pull,
            save,
          ),
          strategy: { matrix: { node: [22, 24] } },
        },
      ],
      ['a job that pulls nothing', job({ run: 'pnpm install --frozen-lockfile' })],
    ];
    for (const [what, j] of right) expect(problemsOf(j), what).toEqual([]);
    const wrong: [string, Job][] = [
      ['no restore', job(pull, save)],
      ['a restore after the pull', job(pull, restore, save)],
      [
        'a restore behind an if',
        job({ ...restore, if: "github.event_name == 'push'" }, pull, save),
      ],
      ['no save', job(restore, pull)],
      ['a save before the pull', job(restore, save, pull)],
      [
        'a pull after the save, run whatever happened',
        job(restore, save, { ...pull, if: 'always()' }),
      ],
      ['a save whatever happened', job(restore, pull, { ...save, if: 'always()' })],
      [
        'a save on success or a push',
        job(restore, pull, { ...save, if: "success() || github.event_name == 'push'" }),
      ],
      ['a save whatever happened, capitalised', job(restore, pull, { ...save, if: 'Always()' })],
      ['a save whatever happened, spaced', job(restore, pull, { ...save, if: 'always ()' })],
      [
        'a save on success or failure, capitalised',
        job(restore, pull, { ...save, if: 'Success() || Failure()' }),
      ],
      [
        'a save on success on main, or on any push',
        job(restore, pull, {
          ...save,
          if: "success() && github.ref == 'refs/heads/main' || github.event_name == 'push'",
        }),
      ],
      ['the pull allowed to fail by ||', job(restore, { run: 'pnpm rss-gate || true' }, save)],
      ['the pull under set +e', job(restore, { run: 'set +e\npnpm rss-gate\necho done' }, save)],
      [
        'the pull in a shell that does not stop',
        job(restore, { run: 'pnpm rss-gate\necho done', shell: 'bash {0}' }, save),
      ],
      [
        'a pull written in the workflow',
        job(
          restore,
          pull,
          { run: '. scripts/lib/docker-pull.sh\ndocker_pull_with_backoff alpine:3' },
          save,
        ),
      ],
      [
        'a step before the save that runs only on a push',
        job(restore, pull, { run: 'pnpm test', if: "github.event_name == 'push'" }, save),
      ],
      ['a step after the save', job(restore, pull, save, { run: 'pnpm test' })],
      ['the pull allowed to fail', job(restore, { ...pull, 'continue-on-error': true }, save)],
      [
        'a test allowed to fail',
        job(restore, pull, { run: 'pnpm test', 'continue-on-error': 'true' }, save),
      ],
      [
        'a hash of another script',
        job(
          { ...restore, with: { name: 'rss-gate', files: 'scripts/lambda-smoke.sh' } },
          pull,
          save,
        ),
      ],
      ['a hash of nothing', job({ uses: RESTORE, with: { name: 'rss-gate' } }, pull, save)],
      [
        'a matrix on one key',
        { ...job(restore, pull, save), strategy: { matrix: { node: [22, 24] } } },
      ],
    ];
    for (const [what, j] of wrong) expect(problemsOf(j), what).toHaveLength(1);
    // A wrapper script that runs a pulling one is a pulling job too, and the key hashes the script that names the
    // images.
    const planted: Record<string, string> = {
      'scripts/ci-gates.sh': 'bash scripts/nested.sh',
      'scripts/nested.sh': 'docker_pull_with_backoff "$X"',
      'scripts/ci-backend-images.sh': 'docker_pull_with_backoff "$image"',
    };
    const read = (f: string): string | undefined => planted[f];
    const wrapped: Step = { run: 'bash scripts/ci-gates.sh' };
    expect(problemsOf(job(wrapped), read)).toEqual([
      'restores no cache before its first pull',
      'saves no cache after its last pull',
    ]);
    const hashed: Step = { uses: RESTORE, with: { name: 'gates', files: 'scripts/nested.sh' } };
    expect(problemsOf(job(hashed, wrapped, save), read)).toEqual([]);
    expect(
      problemsOf(
        job({ ...hashed, with: { name: 'gates', files: 'scripts/ci-gates.sh' } }, wrapped, save),
        read,
      ),
    ).toEqual(['hashes scripts/ci-gates.sh, not scripts/nested.sh, which names its images']);
    // A file the key hashes must exist: a missing one drops out of the hash.
    expect(
      problemsOf(
        job(
          { uses: RESTORE, with: { name: 'integration', files: 'docker-compose.yml' } },
          { run: 'scripts/ci-backend-images.sh "$RUNNER_TEMP/o.yml"' },
          {
            run: 'docker compose -f docker-compose.yml -f "$RUNNER_TEMP/o.yml" up -d --pull never',
          },
          { run: 'pnpm test:integration' },
          save,
        ),
        read,
      ),
    ).toEqual(['hashes docker-compose.yml, which does not exist']);
    const backends: Step = { run: 'scripts/ci-backend-images.sh "$RUNNER_TEMP/o.yml"' };
    const up: Step = {
      run: 'docker compose -f docker-compose.yml -f "$RUNNER_TEMP/o.yml" up -d --pull never',
    };
    const tests: Step = { run: 'pnpm test:integration' };
    const kept: Step = {
      uses: RESTORE,
      with: { name: 'integration', files: 'docker-compose.yml' },
    };
    expect(problemsOf(job(kept, backends, up, tests, save))).toEqual([]);
    expect(
      problemsOf(
        job(
          kept,
          backends,
          {
            run: 'docker compose -f docker-compose.yml \\\n  -f "$RUNNER_TEMP/o.yml" up -d --pull never',
          },
          tests,
          save,
        ),
      ),
      'compose over two lines',
    ).toEqual([]);
    expect(
      problemsOf(job(kept, backends, up, save, tests)),
      'a save before the tests',
    ).toHaveLength(2);
    expect(problemsOf(job(kept, backends, up, save)), 'no tests').toEqual([
      'runs no tests before its save',
    ]);
    expect(
      problemsOf(job(kept, backends, up, { ...tests, if: "github.event_name == 'push'" }, save)),
      'tests only on a push',
    ).toHaveLength(1);
    expect(
      problemsOf(job(kept, backends, up, { run: 'pnpm -s test:integration' }, save)),
      'tests run with a flag',
    ).toEqual([]);
    expect(
      problemsOf(job(kept, backends, up, { run: 'pnpm test:integration || echo failed' }, save)),
      'tests allowed to fail by ||',
    ).toEqual(['lets pnpm test:integration || echo failed fail and still saves']);
    expect(
      problemsOf(job(kept, backends, { run: 'docker compose up -d --pull never' }, tests, save)),
    ).toHaveLength(1);
  });

  it.each(pulling.map((j) => [j.where, j.job] as const))(
    '%s restores before its first pull, and saves after its last, only from a run that passed',
    (_where, job) => {
      expect(problemsOf(job)).toEqual([]);
    },
  );

  it('keys each job apart: an older entry is found by the name and a dash, so no name begins another', () => {
    expect(prefixClashes(['lambda', 'lambda-smoke', 'rss-gate'])).toEqual([
      'lambda begins lambda-smoke',
    ]);
    expect(prefixClashes(['lambda-smoke', 'lambda-layer'])).toEqual([]);
    expect(
      prefixClashes(['rss', 'rssx']),
      'a name and a dash begin another, not a name alone',
    ).toEqual([]);
    const names = pulling.map(
      ({ job }) => (job.steps ?? []).find((s) => s.uses === RESTORE)?.with?.name ?? '',
    );
    expect(new Set(names).size).toBe(names.length);
    expect(prefixClashes(names)).toEqual([]);
  });
});
