import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Every lockfile in the repo, and every composite action, is covered by a Dependabot entry.
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

const dirsOf = (ecosystem: string) =>
  new Set(
    (config.updates ?? [])
      .filter((u) => u['package-ecosystem'] === ecosystem)
      .flatMap((u) => u.directories ?? (u.directory === undefined ? [] : [u.directory])),
  );
const NPM_DIRS = dirsOf('npm');
const ACTIONS_DIRS = dirsOf('github-actions');

/**
 * Every directory holding a composite action, as Dependabot names directories.
 *
 * The same gap as `fuzz/`, for actions. A composite action pins the actions it uses, as a workflow does, but the
 * github-actions entry for `/` reads `.github/workflows` and a root `action.yml` and nothing below
 * `.github/actions`, so an action pinned there is bumped by nothing unless an entry names its directory.
 */
const ACTIONS = join(ROOT, '.github', 'actions');
const COMPOSITE_DIRS = existsSync(ACTIONS)
  ? readdirSync(ACTIONS, { recursive: true, encoding: 'utf8' })
      .filter((f) => /(?:^|\/)action\.ya?ml$/.test(f))
      .map((f) => `/.github/actions/${dirname(f)}`)
      .sort()
  : [];

/** Whether a Dependabot directory names `dir`: `*` stands for one path segment and `**` for any number. */
function names(pattern: string, dir: string): boolean {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((p) => (p === '**' ? '.*' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(dir);
}

describe('dependabot covers every install in the repo', () => {
  it('found lockfiles and dependabot entries (an empty sweep would prove nothing)', () => {
    expect(LOCKFILE_DIRS.length).toBeGreaterThanOrEqual(2);
    expect(LOCKFILE_DIRS).toContain('/');
    expect(NPM_DIRS.size).toBeGreaterThanOrEqual(1);
    expect(ACTIONS_DIRS, 'no github-actions entry reads .github/workflows').toContain('/');
    expect(COMPOSITE_DIRS.length).toBeGreaterThanOrEqual(1);
  });

  it.each(LOCKFILE_DIRS)('%s', (dir) => {
    expect(
      NPM_DIRS.has(dir),
      `${dir === '/' ? '/' : dir + '/'}pnpm-lock.yaml exists but no dependabot npm entry names "${dir}" ` +
        `(entries: ${[...NPM_DIRS].join(', ')}). An install nothing updates is an install running the ` +
        'oldest dependencies in the repo, silently.',
    ).toBe(true);
  });

  it.each(COMPOSITE_DIRS)('%s', (dir) => {
    expect(
      [...ACTIONS_DIRS].some((pattern) => names(pattern, dir)),
      `${dir}/action.yml pins actions, but no dependabot github-actions entry names "${dir}" ` +
        `(entries: ${[...ACTIONS_DIRS].join(', ')}). The entry for / stops at .github/workflows.`,
    ).toBe(true);
  });
});
