import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Every lockfile in the repo is covered by a Dependabot entry.
 *
 * WHY THIS EXISTS. `pnpm-workspace.yaml` lists `packages/*`, so `fuzz/` — which installs with
 * `--ignore-workspace` and carries its own `pnpm-lock.yaml` — is outside the root dependency graph entirely.
 * Dependabot's npm entry was `directory: /`, which does not reach it, so `@jazzer.js/core` was never bumped
 * by anything. The one corner of the repo whose job is finding memory-safety bugs was the corner running the
 * oldest dependencies, and nothing said so.
 *
 * The rule is derived from what is on disk rather than from a list someone maintains: find the lockfiles, and
 * require a Dependabot directory for each. A future `bench/` or `examples/` with its own install is covered
 * the day it lands, which is the only version of this check worth having.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Tracked lockfiles, as directories relative to the repo root (`/` for the root one). */
const LOCKFILE_DIRS = execFileSync('git', ['ls-files', '*pnpm-lock.yaml', 'pnpm-lock.yaml'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .map((f) => {
    const dir = dirname(f);
    return dir === '.' ? '/' : `/${dir}`;
  });

const config = parse(readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as {
  updates?: { 'package-ecosystem'?: string; directory?: string; directories?: string[] }[];
};

const NPM_DIRS = new Set(
  (config.updates ?? [])
    .filter((u) => u['package-ecosystem'] === 'npm')
    .flatMap((u) => u.directories ?? (u.directory === undefined ? [] : [u.directory])),
);

describe('dependabot covers every install in the repo', () => {
  it('found lockfiles and dependabot entries (an empty sweep would prove nothing)', () => {
    expect(LOCKFILE_DIRS.length).toBeGreaterThanOrEqual(2);
    expect(LOCKFILE_DIRS).toContain('/');
    expect(NPM_DIRS.size).toBeGreaterThanOrEqual(1);
  });

  it.each(LOCKFILE_DIRS)('%s', (dir) => {
    expect(
      NPM_DIRS.has(dir),
      `${dir === '/' ? '/' : dir + '/'}pnpm-lock.yaml exists but no dependabot npm entry names "${dir}" ` +
        `(entries: ${[...NPM_DIRS].join(', ')}). An install nothing updates is an install running the ` +
        'oldest dependencies in the repo, silently.',
    ).toBe(true);
  });
});
