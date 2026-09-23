import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `CLAUDE.md` is a symlink to `AGENTS.md`, and stays one.
 *
 * WHY THIS EXISTS. The agent instructions live in `AGENTS.md`, the name most agents look for, and `CLAUDE.md`
 * points at it for the agents that look there. Two files would drift from the first edit, and a symlink turns into
 * a file without anyone deciding it should: a tool or editor that saves by writing a new file and renaming it over
 * the old one replaces the link with a copy. (A plain write goes through the link and lands in `AGENTS.md`, which
 * is harmless.) Both files would still read as instructions, so nothing else would notice.
 *
 * WHY IT READS GIT'S INDEX. The index records the mode (`120000` is a symlink) and the link's target as the blob,
 * whatever the working tree looks like. On a checkout without symlink support (`core.symlinks=false`, Git for
 * Windows' default) `CLAUDE.md` is a small text file holding the path, and git stages whatever it holds as the
 * link's target, so the target check is what catches an edit made there. The on-disk check is skipped on such a
 * checkout, where it cannot hold, and runs everywhere else, CI included.
 */

const ROOT = join(__dirname, '..', '..');
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** `core.symlinks` is unset on most systems, which means true. */
function symlinksCheckedOut(): boolean {
  try {
    return git('config', '--get', 'core.symlinks').trim() !== 'false';
  } catch {
    return true;
  }
}

describe('AGENTS.md and CLAUDE.md', () => {
  it('commits CLAUDE.md as a symlink to AGENTS.md', () => {
    const [mode, blob] = git('ls-files', '--stage', '--', 'CLAUDE.md').trim().split(/\s+/);
    expect(mode, 'CLAUDE.md is committed as a regular file, not a symlink').toBe('120000');
    // Not trimmed: the target is the blob's exact bytes, and `AGENTS.md\n` names a file that does not exist.
    expect(git('cat-file', '-p', blob ?? '')).toBe('AGENTS.md');
  });

  it('commits AGENTS.md as the file itself', () => {
    const [mode] = git('ls-files', '--stage', '--', 'AGENTS.md').trim().split(/\s+/);
    expect(mode, 'AGENTS.md is not committed as a regular file').toBe('100644');
    expect(existsSync(join(ROOT, 'AGENTS.md')), 'AGENTS.md is missing from the checkout').toBe(
      true,
    );
  });

  it.skipIf(!symlinksCheckedOut())('has CLAUDE.md on disk as the same symlink', () => {
    const path = join(ROOT, 'CLAUDE.md');
    expect(
      lstatSync(path).isSymbolicLink(),
      'CLAUDE.md on disk is a regular file: restore it with `git checkout -- CLAUDE.md`',
    ).toBe(true);
    expect(readlinkSync(path)).toBe('AGENTS.md');
  });
});
