import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A branch keeps every entry `[Unreleased]` has on `origin/main`. A bad merge-conflict resolution that takes only the
 * branch's side of `CHANGELOG.md` deletes another change's entries, and nothing else notices: the merge goes through
 * and the entries are gone. So the entries `[Unreleased]` had at the merge base with `origin/main` must all be in
 * `[Unreleased]` on the checked-out head, or in a released section of it that the base did not have that title in, which is where a release cut moves the whole
 * of `[Unreleased]`. An entry deleted outright fails, and names the entry.
 *
 * An entry is known by its bold title, the text between the first `**` pair at its start, or by its first line when it
 * has none, with whitespace collapsed, so a re-wrap does not matter. Rewording an entry's body keeps it. Changing its
 * title is a deletion and a new entry, so it fails: restore the title, or, when the old entry is meant to go (a change
 * reverted before it was released), name it in {@link DROPPED_ON_PURPOSE} with the reason. On `main` itself the merge
 * base is the head, so the gate passes.
 *
 * It needs the history and `origin/main`, so a shallow checkout, or one without that branch, fails with the command that
 * fetches them rather than passing with nothing to compare. CI checks out with `fetch-depth: 0`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const BASE = 'origin/main';

interface Dropped {
  /** The entry's title as {@link entryTitles} reads it. */
  readonly title: string;
  readonly reason: string;
}

/**
 * Entries a branch may drop from `[Unreleased]`, each with the reason. Nothing else may be: to drop an entry, add it
 * here in the change that does it.
 */
export const DROPPED_ON_PURPOSE: readonly Dropped[] = [];

const FETCH = `fetch the history and the base branch (\`git fetch --unshallow origin main\`, or check out with \`fetch-depth: 0\`)`;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The lines of `[Unreleased]` and the lines of every released section, each as one list. */
export function changelogSections(text: string): { unreleased: string[]; released: string[] } {
  const out = { unreleased: [] as string[], released: [] as string[] };
  let into: string[] | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (/^## \[Unreleased\]/i.test(line)) into = out.unreleased;
      else into = /^## \[\d+\.\d+\.\d+\]/.test(line) ? out.released : undefined;
      continue;
    }
    into?.push(line);
  }
  return out;
}

/**
 * The title of each entry in `lines`: the entry's bold lead, or its first line. An entry is a list item and what is
 * indented under it, or an unindented paragraph. A `###` heading ends one, and a one-line comment is not one.
 */
export function entryTitles(lines: readonly string[]): string[] {
  const titles: string[] = [];
  let current: string[] | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const text = collapse(current.join(' ').replace(/^\s*[-*]\s+/, ''));
    const bold = /^\*\*(.+?)\*\*/.exec(text);
    titles.push(
      bold?.[1] !== undefined
        ? collapse(bold[1])
        : collapse(current[0] ?? '').replace(/^[-*]\s+/, ''),
    );
    current = undefined;
  };
  for (const line of lines) {
    if (/^<!--.*-->\s*$/.test(line)) continue;
    if (line.startsWith('#')) flush();
    else if (/^[-*]\s/.test(line)) {
      flush();
      current = [line];
    } else if (line.trim() === '' || (/^\s/.test(line) && current !== undefined))
      current?.push(line);
    else {
      flush();
      current = [line];
    }
  }
  flush();
  return titles;
}

const tally = (titles: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
};

/**
 * The entries `base`'s `[Unreleased]` has that `head` has neither in its `[Unreleased]` nor in a released section a cut
 * newly made, as a message each, naming the entry. `allowed` are the drops made on purpose; each must have a reason and
 * must name an entry `base`'s `[Unreleased]` has, so a spent row is a failure and the list prunes itself.
 */
export function unreleasedDrift(
  base: string,
  head: string,
  allowed: readonly Dropped[] = DROPPED_ON_PURPOSE,
): string[] {
  const was = tally(entryTitles(changelogSections(base).unreleased));
  const now = changelogSections(head);
  const kept = tally(entryTitles(now.unreleased));
  // Only a title a cut newly put in a released section is a moved entry: one that was in a released section already is
  // another entry's, and does not account for this one.
  const releasedBefore = tally(entryTitles(changelogSections(base).released));
  const releasedNow = tally(entryTitles(now.released));
  const released = new Set(
    [...releasedNow].filter(([t, n]) => n > (releasedBefore.get(t) ?? 0)).map(([t]) => t),
  );
  const problems: string[] = [];
  for (const a of allowed) {
    if (a.reason.trim() === '') {
      problems.push(
        `DROPPED_ON_PURPOSE names "${a.title}" with no reason: say why the entry is meant to go.`,
      );
    }
    if (!was.has(a.title)) {
      problems.push(
        `DROPPED_ON_PURPOSE names "${a.title}", which is not in [Unreleased] on ${BASE}: remove the stale row.`,
      );
    }
  }
  for (const [title, n] of was) {
    if (released.has(title) || allowed.some((a) => a.title === title)) continue;
    const have = kept.get(title) ?? 0;
    if (have >= n) continue;
    problems.push(
      `[Unreleased] on ${BASE} has an entry that this branch's CHANGELOG.md lacks, in [Unreleased] and in every released ` +
        `section: "${title.length > 140 ? `${title.slice(0, 137)}...` : title}"` +
        `${n > 1 ? ` (${n - have} of ${n} copies)` : ''}. Restore it: a merge-conflict resolution that keeps only this ` +
        `branch's side of the file drops entries. If it is meant to go, name its title in DROPPED_ON_PURPOSE in this file.`,
    );
  }
  return problems;
}

/** `CHANGELOG.md` at the merge base of the checked-out head and {@link BASE}, in the repository at `cwd`. */
export function baseChangelog(cwd: string): { sha: string; text: string } {
  const fail = (why: string): never => {
    throw new Error(`${why}: ${FETCH}`);
  };
  if (git(cwd, 'rev-parse', '--is-shallow-repository').trim() !== 'false')
    fail('a shallow checkout');
  try {
    git(cwd, 'rev-parse', '--verify', '--quiet', `${BASE}^{commit}`);
  } catch {
    fail(`no ${BASE} to compare with`);
  }
  let sha = '';
  try {
    sha = git(cwd, 'merge-base', 'HEAD', BASE).trim();
  } catch {
    fail(`the head and ${BASE} share no history`);
  }
  try {
    return { sha, text: git(cwd, 'show', `${sha}:CHANGELOG.md`) };
  } catch {
    return fail(`the merge base ${sha} has no CHANGELOG.md`);
  }
}

/** What the repository at `cwd` drops from `[Unreleased]` on {@link BASE}: the problems, none when it keeps every entry. */
export function checkRepository(cwd: string): string[] {
  const { text } = baseChangelog(cwd);
  return unreleasedDrift(text, readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'));
}

const HEAD_TEXT = (unreleased: string, released = ''): string =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n${released}`;
const ENTRY_A =
  '- **A first change.** It does a thing,\n  over two lines.\n\n  And a second paragraph of the same entry.';
const ENTRY_B = '- **A second change.** It does another.';
const PLAIN = '- A plain entry with no bold title, kept by its first line';
const BASE_TEXT = HEAD_TEXT(`### Added\n\n${ENTRY_A}\n${ENTRY_B}\n${PLAIN}\n`);

describe('the entries of [Unreleased] on main are kept', () => {
  it('has the history and the base branch to compare with, and keeps every entry main has', () => {
    expect(
      git(ROOT, 'rev-parse', '--is-shallow-repository').trim(),
      `a shallow checkout: ${FETCH}`,
    ).toBe('false');
    expect(checkRepository(ROOT)).toEqual([]);
  });

  describe('as a check on copies of the file', () => {
    it('passes the unchanged file, and a head with entries added', () => {
      expect(unreleasedDrift(BASE_TEXT, BASE_TEXT)).toEqual([]);
      const more = BASE_TEXT.replace(
        '### Added\n',
        '### Added\n\n- **A new change.** Brand new.\n',
      );
      expect(unreleasedDrift(BASE_TEXT, more)).toEqual([]);
    });

    it('fails an entry deleted outright, and names it', () => {
      const problems = unreleasedDrift(BASE_TEXT, BASE_TEXT.replace(`${ENTRY_B}\n`, ''));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('"A second change."');
      expect(problems[0]).toContain('DROPPED_ON_PURPOSE');
    });

    it('fails a deleted entry that has no bold title, by its first line', () => {
      const problems = unreleasedDrift(BASE_TEXT, BASE_TEXT.replace(`${PLAIN}\n`, ''));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('A plain entry with no bold title');
    });

    it('fails every entry a conflict resolution dropped, not only the first', () => {
      expect(unreleasedDrift(BASE_TEXT, HEAD_TEXT('### Added\n'))).toHaveLength(3);
    });

    it('passes a release cut: the whole of [Unreleased] moved into a version section', () => {
      const cut = HEAD_TEXT(
        '',
        `## [0.17.0] — 2030-01-01\n\n### Added\n\n${ENTRY_A}\n${ENTRY_B}\n${PLAIN}\n`,
      );
      expect(unreleasedDrift(BASE_TEXT, cut)).toEqual([]);
    });

    it('passes a cut that also leaves new entries in [Unreleased]', () => {
      const cut = HEAD_TEXT(
        '- **After the cut.** Newer.\n',
        `## [0.17.0] — 2030-01-01\n\n${ENTRY_A}\n${ENTRY_B}\n${PLAIN}\n`,
      );
      expect(unreleasedDrift(BASE_TEXT, cut)).toEqual([]);
    });

    it('fails a cut that moves some entries and deletes another', () => {
      const cut = HEAD_TEXT('', `## [0.17.0] — 2030-01-01\n\n${ENTRY_A}\n${PLAIN}\n`);
      const problems = unreleasedDrift(BASE_TEXT, cut);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('"A second change."');
    });

    it('keeps an entry whose body is reworded or re-wrapped, since its title is what names it', () => {
      const reworded = BASE_TEXT.replace(
        '- **A second change.** It does another.',
        '- **A second change.** It now does the other\n  thing, said better.',
      );
      expect(reworded).not.toBe(BASE_TEXT);
      expect(unreleasedDrift(BASE_TEXT, reworded)).toEqual([]);
      expect(
        unreleasedDrift(
          BASE_TEXT,
          BASE_TEXT.replace(
            'It does a thing,\n  over two lines.',
            'It does a thing, over two lines.',
          ),
        ),
      ).toEqual([]);
    });

    it('fails an entry whose title is changed: that is a deletion and a new entry', () => {
      const retitled = BASE_TEXT.replace('**A second change.**', '**A renamed change.**');
      const problems = unreleasedDrift(BASE_TEXT, retitled);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('"A second change."');
    });

    it('passes an entry that moves between the groups of [Unreleased]', () => {
      const moved = HEAD_TEXT(`### Changed\n\n${ENTRY_A}\n${ENTRY_B}\n### Fixed\n\n${PLAIN}\n`);
      expect(unreleasedDrift(BASE_TEXT, moved)).toEqual([]);
    });

    it('fails a copy dropped when an entry stood twice', () => {
      const twice = HEAD_TEXT(`${ENTRY_B}\n${ENTRY_B}\n`);
      expect(unreleasedDrift(twice, HEAD_TEXT(`${ENTRY_B}\n`))).toHaveLength(1);
      expect(unreleasedDrift(twice, twice)).toEqual([]);
    });

    it('does not take an older released entry of the same title for the entry that was dropped', () => {
      const withOld = (text: string): string =>
        `${text}\n## [2.0.0] — 2030-01-01\n\n- **A second change.** An older release's entry of that title.\n`;
      const base = withOld(BASE_TEXT);
      const dropped = withOld(BASE_TEXT.replace(`${ENTRY_B}\n`, ''));
      const problems = unreleasedDrift(base, dropped);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('"A second change."');
      // and a cut of that title in this change is still a move
      const cut = withOld(
        HEAD_TEXT('', `## [3.0.0] — 2030-02-01\n\n${ENTRY_A}\n${ENTRY_B}\n${PLAIN}\n`),
      );
      expect(unreleasedDrift(base, cut)).toEqual([]);
    });

    it('fails a drop named without a reason, or for an entry main does not have', () => {
      const dropped = BASE_TEXT.replace(`${ENTRY_B}\n`, '');
      const blank = [{ title: 'A second change.', reason: '  ' }];
      expect(unreleasedDrift(BASE_TEXT, dropped, blank).join('\n')).toContain('with no reason');
      const stale = [{ title: 'A change main never had.', reason: 'reverted before release' }];
      const problems = unreleasedDrift(BASE_TEXT, BASE_TEXT, stale);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('stale row');
    });

    it('passes a drop named on purpose, and only that one', () => {
      const dropped = BASE_TEXT.replace(`${ENTRY_B}\n`, '').replace(`${PLAIN}\n`, '');
      const allowed = [{ title: 'A second change.', reason: 'reverted before release' }];
      const problems = unreleasedDrift(BASE_TEXT, dropped, allowed);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('A plain entry');
    });

    it('does not read a released section as [Unreleased], nor a base with no entries as dropping any', () => {
      const releasedOnly = HEAD_TEXT('', `## [2.0.0] — 2030-01-01\n\n${ENTRY_B}\n`);
      expect(unreleasedDrift(releasedOnly, HEAD_TEXT(''))).toEqual([]);
    });
  });

  describe('as a check on a repository', () => {
    const dirs: string[] = [];
    afterAll(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });
    const run = (cwd: string, ...args: string[]): string =>
      git(
        cwd,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      );

    /** A repository whose `origin/main` holds {@link BASE_TEXT}, on a branch of its own. */
    const repository = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'unreleased-kept-'));
      dirs.push(dir);
      run(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'CHANGELOG.md'), BASE_TEXT);
      run(dir, 'add', '.');
      run(dir, 'commit', '-q', '-m', 'base');
      run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      run(dir, 'checkout', '-q', '-b', 'feature');
      return dir;
    };
    const commit = (dir: string, text: string): void => {
      writeFileSync(join(dir, 'CHANGELOG.md'), text);
      run(dir, 'commit', '-q', '-am', 'change');
    };

    it('passes on main itself, and on a branch that adds an entry', () => {
      const dir = repository();
      expect(checkRepository(dir)).toEqual([]);
      commit(dir, BASE_TEXT.replace('### Added\n', '### Added\n\n- **A new change.** New.\n'));
      expect(checkRepository(dir)).toEqual([]);
    });

    it('fails a branch that deletes an entry main has', () => {
      const dir = repository();
      commit(dir, BASE_TEXT.replace(`${ENTRY_B}\n`, ''));
      expect(checkRepository(dir)).toHaveLength(1);
    });

    it('compares with the merge base, so an entry main gained after the branch left it is not missed', () => {
      const dir = repository();
      run(dir, 'checkout', '-q', 'main');
      commit(dir, BASE_TEXT.replace('### Added\n', '### Added\n\n- **Landed on main.** Later.\n'));
      run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      run(dir, 'checkout', '-q', 'feature');
      expect(checkRepository(dir)).toEqual([]);
    });

    it('passes a release cut into a version section', () => {
      const dir = repository();
      commit(dir, HEAD_TEXT('', `## [0.17.0] — 2030-01-01\n\n${ENTRY_A}\n${ENTRY_B}\n${PLAIN}\n`));
      expect(checkRepository(dir)).toEqual([]);
    });

    it('fails closed, naming the fetch, on a shallow checkout and on a checkout without origin/main', () => {
      const dir = repository();
      const shallow = mkdtempSync(join(tmpdir(), 'unreleased-kept-shallow-'));
      dirs.push(shallow);
      run(
        shallow,
        'clone',
        '-q',
        '--depth',
        '1',
        '--branch',
        'main',
        pathToFileURL(dir).href,
        join(shallow, 'c'),
      );
      expect(() => checkRepository(join(shallow, 'c'))).toThrow(
        /shallow checkout: fetch the history/,
      );
      run(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
      expect(() => checkRepository(dir)).toThrow(
        /no origin\/main to compare with: fetch the history/,
      );
    });
  });
});
