import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `CLAUDE.md` is a symlink to `AGENTS.md`, and stays one.
 *
 * WHY THIS EXISTS. The agent instructions live in `AGENTS.md`, the name most agents look for, and `CLAUDE.md`
 * points at it for the agents that look there. Two files would drift the day one of them was edited, and a
 * symlink turns into a file silently: an agent's own `init` writes a fresh `CLAUDE.md` over it, and so does
 * an editor that saves through a copy. Nothing else would notice, since both would still read as instructions.
 *
 * WHY IT READS GIT'S INDEX TOO. A checkout on a filesystem without symlinks has `CLAUDE.md` as a small text file
 * holding the path, and a commit made there could carry a real file back. The index records the mode (`120000`
 * is a symlink) and the link's target as the blob, whatever the working tree looks like.
 */

const ROOT = join(__dirname, '..', '..');
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

describe('AGENTS.md and CLAUDE.md', () => {
  it('commits CLAUDE.md as a symlink to AGENTS.md', () => {
    const [mode, blob] = git('ls-files', '--stage', '--', 'CLAUDE.md').split(/\s+/);
    expect(mode, 'CLAUDE.md is committed as a regular file, not a symlink').toBe('120000');
    expect(git('cat-file', '-p', blob ?? '')).toBe('AGENTS.md');
  });

  it('commits AGENTS.md as the file itself', () => {
    const [mode] = git('ls-files', '--stage', '--', 'AGENTS.md').split(/\s+/);
    expect(mode, 'AGENTS.md is not committed as a regular file').toBe('100644');
  });

  it('has CLAUDE.md on disk as the same symlink', () => {
    const path = join(ROOT, 'CLAUDE.md');
    expect(lstatSync(path).isSymbolicLink(), 'CLAUDE.md on disk is a regular file').toBe(true);
    expect(readlinkSync(path)).toBe('AGENTS.md');
  });
});
