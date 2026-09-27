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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The images CI runs are kept in the Actions cache, so that a registry which refuses or throttles a pull fails a run
 * only when no copy is kept. It was needed twice in one week of September 2026: quay.io began refusing anonymous pulls
 * of MinIO and failed the integration job on `main` and on every PR for two days, and public.ecr.aws answered `Data
 * limit exceeded` to the RSS gate's `node:22`.
 *
 * These drive scripts/lib/docker-pull.sh and scripts/ci-backend-images.sh against a stand-in `docker` that records
 * what it was asked and keeps its "images" as files, and a `sleep` that returns at once, so each path is exercised
 * with no network and no daemon: which copy is used, when the registry is asked, what is saved, and what is dropped.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = join(ROOT, 'scripts/lib/docker-pull.sh');

/** A `docker` that answers from files under $STUB: an image is present when a file names it. */
const STUB_DOCKER = String.raw`#!/usr/bin/env bash
echo "$*" >>"$STUB/calls"
present() { printf '%s' "$1" | tr '/:@' '___'; }
case "$1" in
  pull)
    for ref; do :; done
    for f in $STUB_FAIL_PULLS; do
      if [ "$f" = "$ref" ]; then echo "toomanyrequests: Data limit exceeded" >&2; exit 1; fi
    done
    touch "$STUB/images/$(present "$ref")"
    exit 0 ;;
  tag)
    [ -e "$STUB/images/$(present "$2")" ] || exit 1
    touch "$STUB/images/$(present "$3")"
    exit 0 ;;
  save)
    [ -e "$STUB/images/$(present "$4")" ] || exit 1
    printf '%s' "$4" >"$3"
    exit 0 ;;
  load)
    name="$(cat "$4")"
    [ "$name" = corrupt ] && exit 1
    touch "$STUB/images/$(present "$name")"
    exit 0 ;;
  image)
    [ -e "$STUB/images/$(present "$3")" ] && exit 0
    exit 1 ;;
  compose)
    if [ "$*" = "compose config --services" ]; then printf 'minio\nfake-gcs\n'; exit 0; fi
    printf '{"services":{"minio":{"image":"cgr.dev/chainguard/minio@sha256:abc"},"fake-gcs":{"image":"fsouza/fake-gcs-server:1.52.2"}}}'
    exit 0 ;;
esac
exit 2
`;

interface World {
  dir: string;
  cache: string;
  /** Run bash with the stand-ins first on PATH; `env` adds to the environment. */
  run: (script: string, env?: Record<string, string>) => { code: number; out: string };
  calls: () => string[];
  resetCalls: () => void;
  file: (image: string) => string;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'docker-image-cache-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(bin, 'docker'), STUB_DOCKER);
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const cache = join(dir, 'cache');
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    STUB: dir,
  };
  delete base.DOCKER_IMAGE_CACHE;
  delete base.DOCKER_IMAGE_CACHE_HIT;
  const run = (script: string, env: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['-c', script], {
      cwd: ROOT,
      env: { ...base, ...env },
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const calls = () =>
    existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
  const resetCalls = () => rmSync(join(dir, 'calls'), { force: true });
  const file = (image: string) => {
    const id = execFileSync(
      'bash',
      ['-c', `printf '%s' "$1" | sha256sum | cut -c1-16`, '_', image],
      {
        encoding: 'utf8',
      },
    ).trim();
    return join(cache, `${id}.tar`);
  };
  return { dir, cache, run, calls, resetCalls, file };
}

const TAG = 'fsouza/fake-gcs-server:1.52.2';
const DIGEST = 'cgr.dev/chainguard/minio@sha256:abc';
const pull = (image: string) => `. ${HELPER} && docker_pull_with_backoff '${image}'`;

describe('an image CI runs is kept in the Actions cache, and a registry is asked only when it must be', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => {
    rmSync(w.dir, { recursive: true, force: true });
  });

  it('pulls as before, and keeps nothing, with no cache set', () => {
    expect(w.run(pull(TAG)).code).toBe(0);
    expect(w.calls()).toEqual([`pull -q ${TAG}`]);
    expect(existsSync(w.cache)).toBe(false);
  });

  it('pulls an image the cache lacks, and keeps it under its local name', () => {
    expect(w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache }).code).toBe(0);
    const calls = w.calls();
    expect(calls[0]).toBe(`pull -q ${TAG}`);
    expect(
      calls.some((c) =>
        /^tag fsouza\/fake-gcs-server:1\.52\.2 cloud-roaring-ci\/cache:[0-9a-f]{16}$/.test(c),
      ),
    ).toBe(true);
    expect(readFileSync(w.file(TAG), 'utf8')).toMatch(/^cloud-roaring-ci\/cache:[0-9a-f]{16}$/);
  });

  it("uses a tag's copy without asking the registry when the cache is this month's", () => {
    w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache });
    w.resetCalls();
    const r = w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache, DOCKER_IMAGE_CACHE_HIT: 'true' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`${TAG} from the cache`);
    expect(w.calls().filter((c) => c.startsWith('pull'))).toEqual([]);
    // The tag is given back, so `docker run <tag>` finds it.
    expect(
      w.calls().some((c) => c.startsWith('tag cloud-roaring-ci/cache:') && c.endsWith(` ${TAG}`)),
    ).toBe(true);
  });

  it("pulls a tag again when the cache is an older month's, and keeps the new copy", () => {
    w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache });
    w.resetCalls();
    expect(
      w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache, DOCKER_IMAGE_CACHE_HIT: 'false' }).code,
    ).toBe(0);
    expect(w.calls()[0]).toBe(`pull -q ${TAG}`);
    expect(w.calls().some((c) => c.startsWith('save '))).toBe(true);
  });

  it('uses the copy an earlier run kept when every pull is refused, and says so', () => {
    w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache });
    w.resetCalls();
    const r = w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache, STUB_FAIL_PULLS: TAG });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Data limit exceeded'); // the registry's own error is still in the log
    expect(r.out).toContain(`using the copy of ${TAG} the cache kept from an earlier run`);
    expect(w.calls().filter((c) => c.startsWith('pull'))).toHaveLength(6); // five tries, then the loud one
  });

  it('fails as before when every pull is refused and no copy is kept', () => {
    const r = w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache, STUB_FAIL_PULLS: TAG });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAILED after 5 attempts: ${TAG}`);
  });

  it('uses an image named by digest from the cache without asking the registry, whatever the month', () => {
    w.run(pull(DIGEST), { DOCKER_IMAGE_CACHE: w.cache });
    w.resetCalls();
    const r = w.run(pull(DIGEST), { DOCKER_IMAGE_CACHE: w.cache, DOCKER_IMAGE_CACHE_HIT: 'false' });
    expect(r.code, r.out).toBe(0);
    expect(w.calls().filter((c) => c.startsWith('pull'))).toEqual([]);
    // A digest cannot be given back as a tag: the caller runs the local name.
    expect(w.calls().filter((c) => c.startsWith('tag'))).toEqual([]);
  });

  it('pulls again when the copy it has cannot be loaded', () => {
    mkdirSync(w.cache, { recursive: true });
    writeFileSync(w.file(TAG), 'corrupt');
    const r = w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache, DOCKER_IMAGE_CACHE_HIT: 'true' });
    expect(r.code, r.out).toBe(0);
    expect(w.calls().some((c) => c === `pull -q ${TAG}`)).toBe(true);
    expect(readFileSync(w.file(TAG), 'utf8')).not.toBe('corrupt');
  });

  it('drops what this run did not use before the cache is saved, and says whether anything is left', () => {
    w.run(pull(TAG), { DOCKER_IMAGE_CACHE: w.cache });
    writeFileSync(join(w.cache, '0000000000000000.tar'), 'an image re-pinned away');
    const kept = w.run(`. ${HELPER} && docker_image_cache_prune`, { DOCKER_IMAGE_CACHE: w.cache });
    expect(kept.out.trim()).toBe('true');
    expect(existsSync(join(w.cache, '0000000000000000.tar'))).toBe(false);
    expect(existsSync(w.file(TAG))).toBe(true);
    // A run that used nothing leaves nothing to save.
    const none = w.run(`. ${HELPER} && docker_image_cache_prune`, { DOCKER_IMAGE_CACHE: w.cache });
    expect(none.out.trim()).toBe('false');
  });

  it('runs each backend on the local name its image is kept under, and on the image itself with no cache', () => {
    const override = join(w.dir, 'override.yml');
    const script = `scripts/ci-backend-images.sh '${override}'`;
    expect(w.run(script, { DOCKER_IMAGE_CACHE: w.cache }).code).toBe(0);
    const cached = parse(readFileSync(override, 'utf8')) as {
      services: Record<string, { image: string }>;
    };
    expect(cached.services.minio?.image).toMatch(/^cloud-roaring-ci\/cache:[0-9a-f]{16}$/);
    expect(cached.services['fake-gcs']?.image).toMatch(/^cloud-roaring-ci\/cache:[0-9a-f]{16}$/);
    expect(w.run(script).code).toBe(0);
    const bare = parse(readFileSync(override, 'utf8')) as {
      services: Record<string, { image: string }>;
    };
    expect(bare.services.minio?.image).toBe(DIGEST);
    expect(bare.services['fake-gcs']?.image).toBe(TAG);
  });

  it('fails the step when one image cannot be had, and still readies the others', () => {
    const override = join(w.dir, 'override.yml');
    const r = w.run(`scripts/ci-backend-images.sh '${override}'`, {
      DOCKER_IMAGE_CACHE: w.cache,
      STUB_FAIL_PULLS: DIGEST,
    });
    expect(r.code).toBe(1);
    const got = parse(readFileSync(override, 'utf8')) as {
      services: Record<string, { image: string }>;
    };
    expect(Object.keys(got.services)).toEqual(['fake-gcs']);
  });
});

describe('every CI job that pulls an image keeps it in the cache', () => {
  const wf = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: { uses?: string; run?: string; if?: string }[] }>;
  };
  /** Steps that pull: a script that calls the shared helper, or the backends' script. */
  const PULLING =
    /pnpm (?:rss-gate|lambda-smoke|build-lambda-layer)\b|scripts\/ci-backend-images\.sh/;
  const jobs = Object.entries(wf.jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => PULLING.test(s.run ?? '')),
  );

  it('finds the jobs, so a rename cannot make this vacuous', () => {
    expect(jobs.map(([name]) => name).sort()).toEqual([
      'integration',
      'lambda-layer',
      'lambda-smoke',
      'rss-gate',
    ]);
  });

  it.each(jobs)(
    '%s restores the cache before it pulls, and saves it after, whatever happened',
    (_name, job) => {
      const steps = job.steps ?? [];
      const restore = steps.findIndex((s) => s.uses === './.github/actions/docker-images-restore');
      const pulls = steps.findIndex((s) => PULLING.test(s.run ?? ''));
      const save = steps.findIndex((s) => s.uses === './.github/actions/docker-images-save');
      expect(restore).toBeGreaterThanOrEqual(0);
      expect(restore).toBeLessThan(pulls);
      expect(save).toBeGreaterThan(pulls);
      expect(steps[save]?.if).toBe('always()');
    },
  );

  it("keys each job apart, so one job never restores another's images", () => {
    const names = jobs.map(([, job]) => {
      const step = (job.steps ?? []).find(
        (s) => s.uses === './.github/actions/docker-images-restore',
      ) as {
        with?: { name?: string };
      };
      return step.with?.name;
    });
    expect(new Set(names).size).toBe(names.length);
  });
});
