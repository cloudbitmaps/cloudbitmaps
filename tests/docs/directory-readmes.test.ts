import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The code directories each carry a README that lists every part of them. A README that lists files is exactly
// the thing this repository keeps being bitten by — a hand-kept list beside the thing it lists, which goes stale
// the day someone adds a script and nobody re-reads the list. So each README is checked against the directory
// it describes, in both directions:
//
//   FORWARD   every file (or directory, or page) that exists has a ROW — its path in the first cell of a table;
//   BACKWARD  every path in the first cell of a table row exists.
//
// A one-way check would let half the drift through: forward-only lets a README keep describing a deleted script,
// backward-only lets a new one go undocumented forever.
//
// A row, not a mention. The first version accepted a file named anywhere in the README, in backticks — and, failing
// that, its basename. So a row could be deleted outright and still pass, because the name survived in a sentence
// or a command elsewhere on the page; and a new `scripts/lib/leak-scan.cjs` passed on the strength of the row for
// `leak-scan.cjs`. A row is what makes a part findable, so a row is what is required.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every file that belongs to the repository — tracked, or new and not ignored — as a repo-relative path.
 *
 * Asked of git, not the filesystem. A filesystem walk reported a rehearsal's git-ignored results file as an
 * undocumented part of `bench/`, and would do the same with a Finder `.DS_Store`: noise that teaches people to
 * route around the gate. A script written but not yet committed is still listed, so it fails before the commit.
 * Existence is decided from the same list, so an ignored local file named in a table cannot pass here and then
 * fail in CI, where it does not exist.
 */
const REPO_FILES = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\0')
  .filter((f) => f !== '' && existsSync(join(ROOT, f)));

/** A path names something in the repository: a file, or a directory with a file under it. */
const inRepo = (rel: string): boolean => {
  const bare = rel.replace(/\/$/, '');
  return REPO_FILES.some((f) => f === bare || f.startsWith(`${bare}/`));
};

/** The repository's top-level directories, from git — so an empty local directory cannot change the answer. */
const TOP_LEVEL = new Set(
  REPO_FILES.filter((f) => f.includes('/')).map((f) => f.split('/')[0] ?? ''),
);

/** The files under `dir`, relative to it, excluding the README itself. */
function filesUnder(dir: string): string[] {
  return REPO_FILES.filter((f) => f.startsWith(`${dir}/`))
    .map((f) => f.slice(dir.length + 1))
    .filter((f) => f !== 'README.md')
    .sort();
}

interface Entries {
  /** Paths that have a row of their own: the backticked token is exactly one path. */
  readonly rows: Set<string>;
  /** Every path in a first cell, commands' paths included — each must exist. */
  readonly refs: string[];
  /** Path-shaped tokens this cannot read. Reported rather than skipped: a dropped token is a row nothing checks. */
  readonly bad: string[];
}

/**
 * What a README's tables say about paths, read from the FIRST cell of each row.
 *
 * Only a one-path token makes a row. A command like `node calibrate-aws.cjs --run` mentions a file; it does not
 * list it, so its paths are checked for existence but satisfy nothing. A one-word token with no `/` or `.` is a
 * path only when it names a file here (`_redirects`), so a table of environment variables is not read as a list
 * of missing files. A trailing `#anchor` or `:line` is dropped before the path is checked.
 *
 * Tables inside fenced code blocks and HTML comments are not tables, and are skipped. An indented row — under a
 * list item — still renders as one, and is read.
 */
function tableEntries(readme: string, localFiles: ReadonlySet<string>): Entries {
  const rows = new Set<string>();
  const refs: string[] = [];
  const bad: string[] = [];
  let inFence = false;
  for (const raw of readme.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.trimStart();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.startsWith('|') || /^\|\s*:?-/.test(line)) continue;
    const first = line.split(/(?<!\\)\|/)[1] ?? '';
    for (const m of first.matchAll(/`([^`\n]+)`/g)) {
      const words = (m[1] ?? '').trim().split(/\s+/);
      for (const word of words) {
        const w = word.replace(/^\.\//, '').replace(/(?:#[\w-]*|:\d+(?::\d+)?)$/, '');
        const pathShaped = w.includes('/') || /\.\w+$/.test(w);
        if (!/^[\w./-]+$/.test(w)) {
          if (pathShaped || /[\\/]/.test(word)) bad.push(word);
          continue;
        }
        if (!pathShaped && !(words.length === 1 && localFiles.has(w))) continue;
        refs.push(w);
        if (words.length === 1) rows.add(w);
      }
    }
  }
  return { rows, refs, bad };
}

/**
 * Does a listed path exist? Looked up against the README's own directories first — so `bench/` in the tests
 * README means `tests/bench/`, and a `scripts/site/…` file would be found where it lives — and against the
 * repository only when that fails and the path runs from a top-level directory INTO it (`scripts/site-figures.cjs`,
 * listed by `site/README.md`). A bare top-level name like `site/` is never repo-relative: in the tests README it
 * would otherwise pass as the real `site/` directory while naming a `tests/site/` that does not exist.
 */
function exists(token: string, roots: string[]): boolean {
  if (roots.some((r) => inRepo(`${r}/${token}`))) return true;
  const segments = token.split('/').filter(Boolean);
  return segments.length > 1 && TOP_LEVEL.has(segments[0] ?? '') && inRepo(token);
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('code-directory READMEs describe their directories, in both directions', () => {
  describe.each([
    { dir: 'bench', minimum: 12 },
    { dir: 'scripts', minimum: 20 },
  ])('$dir/README.md', ({ dir, minimum }) => {
    const readme = read(`${dir}/README.md`);
    const files = filesUnder(dir);
    const { rows, refs, bad } = tableEntries(readme, new Set(files));

    // Without this, a bad listing would make both checks below pass over an empty directory — and the `lib/`
    // half is asserted separately, because a listing that skipped subdirectories would still clear the count.
    it(`finds the directory's files (at least ${minimum}), lib/ included`, () => {
      expect(files.length).toBeGreaterThanOrEqual(minimum);
      expect(files.some((f) => f.startsWith('lib/'))).toBe(true);
    });

    it('gives every file in the directory a row', () => {
      expect(
        files.filter((f) => !rows.has(f)),
        `add a row for each of these to ${dir}/README.md`,
      ).toEqual([]);
    });

    it('lists only files that exist, in a form it can read', () => {
      expect(bad, `${dir}/README.md has paths this gate cannot read`).toEqual([]);
      const ghosts = refs.filter((p) => !exists(p, [dir]));
      expect(ghosts, `${dir}/README.md lists files that do not exist`).toEqual([]);
    });
  });

  describe('tests/README.md', () => {
    const readme = read('tests/README.md');
    const all = filesUnder('tests');
    const dirs = [
      ...new Set(all.filter((f) => f.includes('/')).map((f) => `${f.split('/')[0]}/`)),
    ].sort();
    const topLevel = all.filter((f) => !f.includes('/'));
    const gates = filesUnder('tests/docs').filter(
      (f) => !f.includes('/') && f.endsWith('.test.ts'),
    );
    const { rows, refs, bad } = tableEntries(readme, new Set([...topLevel, ...gates]));

    it('finds the test directories, the top-level files and the documentation gates', () => {
      expect(dirs.length).toBeGreaterThanOrEqual(10);
      expect(topLevel.length).toBeGreaterThanOrEqual(5);
      expect(gates.length).toBeGreaterThanOrEqual(15);
    });

    it('gives every test directory a row', () => {
      expect(
        dirs.filter((d) => !rows.has(d)),
        'add a row for each to tests/README.md',
      ).toEqual([]);
    });

    it('gives every top-level test file a row', () => {
      expect(
        topLevel.filter((f) => !rows.has(f)),
        'add a row for each to tests/README.md',
      ).toEqual([]);
    });

    // The docs gates are the least discoverable part of the repo — each one is a lesson about a way a document
    // drifted — so every one of them has its own row, including this one.
    it('gives every documentation gate a row', () => {
      expect(
        gates.filter((g) => !rows.has(g)),
        'add a row for each to the gates table in tests/README.md',
      ).toEqual([]);
    });

    it('lists only paths that exist, in a form it can read', () => {
      expect(bad, 'tests/README.md has paths this gate cannot read').toEqual([]);
      const ghosts = refs.filter((p) => !exists(p, ['tests', 'tests/docs']));
      expect(ghosts, 'tests/README.md lists paths that do not exist').toEqual([]);
    });
  });

  describe('site/README.md', () => {
    const readme = read('site/README.md');
    const all = filesUnder('site');
    const { rows, refs, bad } = tableEntries(readme, new Set(all));
    // Pages are listed one by one. `assets/` is listed as a directory: a row per favicon would be noise, and
    // nothing in it is a page someone could fail to find.
    const pages = all.filter((f) => f.endsWith('.html'));
    const loose = all.filter((f) => !f.endsWith('.html') && !f.startsWith('assets/'));

    it('finds the pages', () => {
      expect(pages.length).toBeGreaterThanOrEqual(5);
    });

    it('gives every page, every top-level file, and the assets directory a row', () => {
      expect(
        [...pages, ...loose, 'assets/'].filter((f) => !rows.has(f)),
        'add a row for each to site/README.md',
      ).toEqual([]);
    });

    it('lists only files that exist, in a form it can read', () => {
      expect(bad, 'site/README.md has paths this gate cannot read').toEqual([]);
      const ghosts = refs.filter((p) => !exists(p, ['site']));
      expect(ghosts, 'site/README.md lists files that do not exist').toEqual([]);
    });
  });
});
