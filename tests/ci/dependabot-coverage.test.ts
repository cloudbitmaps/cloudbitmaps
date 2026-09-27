import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { ROOT, compositeActionFiles } from '../helpers/workflows';

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
  updates?: {
    'package-ecosystem'?: string;
    directory?: string;
    directories?: string[];
    groups?: Record<string, { 'group-by'?: string; 'update-types'?: string[] }>;
  }[];
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
const COMPOSITE_DIRS = compositeActionFiles().map((f) => `/${dirname(f)}`);

/**
 * Whether a Dependabot directory names `dir`. Dependabot expands the glob with Ruby's `Dir.glob`, dotfiles included:
 * `**` followed by a slash spans any number of path segments, and `*` stays inside one, as does a `**` with no slash
 * after it. Dotfiles included means `.` too, so a pattern whose last segment matches `.`, as a `*` does, also names
 * the directory that segment is in, as `dir/.`. A `*` before the last that matches `.` is not modelled, so a directory
 * only it would name fails this test. Any other glob syntax is read literally, so it makes this test fail rather than wave a directory
 * through.
 */
function names(pattern: string, dir: string): boolean {
  const source = pattern
    .split(/(\*\*\/|\*+)/)
    .map((p) =>
      p === '**/'
        ? '(?:[^/]+/)*'
        : p.startsWith('*')
          ? '[^/]*'
          : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  const re = new RegExp(`^${source}$`);
  return re.test(dir) || re.test(`${dir === '/' ? '' : dir}/.`);
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

  it('reads a directory glob as Dependabot does: `*` is one path segment, `**/` any number', () => {
    const cases: [string, string, boolean][] = [
      ['/', '/', true],
      ['/.github/actions/*', '/.github/actions/docker-images-save', true],
      ['/.github/actions/*', '/.github/actions/group/one', false],
      // `Dir.glob('.github/actions/*', File::FNM_DOTMATCH)` returns `.github/actions/.` as well.
      ['/.github/actions/*', '/.github/actions', true],
      ['/.github/actions', '/.github/actions/docker-images-save', false],
      ['/.github/actions/*', '/.github/actions/docker-images-save/more', false],
      // Ruby reads a `**` with no slash after it as a `*`: only `**/` recurses.
      ['/.github/actions/**', '/.github/actions/docker-images-save', true],
      ['/.github/actions/**', '/.github/actions/group/one', false],
      ['/.github/actions/**/*', '/.github/actions/docker-images-save', true],
      ['/.github/actions/**/*', '/.github/actions/group/one', true],
      ['/.github/actions/**/*', '/.github/actions/a/b/c', true],
      ['/.github/actions/**/*', '/.github/actions', true],
      ['/.github/actions/*', '/.github', false],
      // Only the last `*` names the directory it is in: `Dir.glob` returns `.github/actions/a/b`, not `…/./.`.
      ['/.github/actions/*/*', '/.github/actions', false],
      ['/*', '/', true],
      ['/fuzz', '/fuzzy', false],
      ['/a.b', '/axb', false],
      // Glob syntax this does not model reads literally, so the test fails rather than wave a directory through.
      ['/.github/action?', '/.github/actions', false],
      ['/.github/actions/docker-images-savee?', '/.github/actions/docker-images-save', false],
    ];
    for (const [pattern, dir, want] of cases)
      expect(names(pattern, dir), `${pattern} ~ ${dir}`).toBe(want);
  });

  it('bumps a major of an action in one pull request across every directory that pins it', () => {
    // The restore and save actions pin one action. Split by directory, a major of it arrives as a pull request each,
    // and merging one leaves the two a major apart, which the cache would not survive.
    const actions = (config.updates ?? []).filter(
      (u) => u['package-ecosystem'] === 'github-actions',
    );
    const majors = actions.flatMap((u) =>
      Object.values(u.groups ?? {}).filter((g) => g['update-types']?.includes('major')),
    );
    expect(majors.length).toBeGreaterThan(0);
    for (const g of majors) expect(g['group-by']).toBe('dependency-name');
  });

  it.each(COMPOSITE_DIRS)('%s', (dir) => {
    expect(
      [...ACTIONS_DIRS].some((pattern) => names(pattern, dir)),
      `${dir}/action.yml pins actions, but no dependabot github-actions entry names "${dir}" ` +
        `(entries: ${[...ACTIONS_DIRS].join(', ')}). The entry for / stops at .github/workflows.`,
    ).toBe(true);
  });
});
