import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The public repo describes the library from `0.10.0` on. No file in it names an earlier CloudBitmaps release: not
 * the docs, the READMEs, the site, the code or its comments (which ship in the `.d.ts` files and sourcemaps), the
 * tests, the benches or the scripts. The history before `0.10.0` is not in this repo, and the library is described
 * by what it is, not by what it used to be.
 *
 * A version is a `0.N.P` or `0.N.x` with N from 1 to 9, or a `v0.N`, so `0.5` in `minRetained: 0.5` is a number and
 * not a version, and `0.10.0` and later pass. An npm spec such as `pkg@0.3.1` names another package's version and
 * passes, and lockfiles, which carry nothing but other packages' versions, are not read.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A CloudBitmaps release before `0.10.0`, written as a version; neither a sentence's closing period nor a file extension hides one. */
const EARLIER_RELEASE =
  /(?<![\w.@])v?0\.[1-9]\.(?:\d+|x)(?!\w|\.\d)|(?<![\w.@])v0\.[1-9](?!\w|\.\d)/g;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'build',
  '.pack-tmp',
  '.rss-stage',
  // Sibling working trees hold other commits' files.
  '.worktrees',
]);
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
const EXTS = [
  '.ts',
  '.md',
  '.html',
  '.css',
  '.svg',
  '.xml',
  '.cjs',
  '.mjs',
  '.js',
  '.yml',
  '.yaml',
  '.json',
  '.txt',
  '.sh',
  '.py',
];

function repoFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
      const childRel = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, childRel)).isDirectory()) walk(childRel);
      else if (EXTS.some((e) => entry.endsWith(e))) out.push(childRel);
    }
  };
  walk('.');
  return out.sort();
}

/** Every earlier-release version in `text`, with its line. */
export function earlierReleases(text: string): Array<{ line: number; version: string }> {
  const found: Array<{ line: number; version: string }> = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(EARLIER_RELEASE)) found.push({ line: i + 1, version: m[0] });
  });
  return found;
}

// The planted versions are built, not written, so this file holds none of the spellings it refuses.
const v = (minor: number, rest: string): string => `0.${minor}${rest}`;

describe('no file names a CloudBitmaps release before 0.10.0', () => {
  it('the repo', () => {
    const offenders: string[] = [];
    for (const file of repoFiles()) {
      for (const { line, version } of earlierReleases(readFileSync(join(ROOT, file), 'utf8'))) {
        offenders.push(`${file}:${line} ${version}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('refuses each way an earlier release is written', () => {
    for (const text of [
      `from ${v(9, '.0')} on`,
      `the ${v(9, '.x')} line`,
      `tagged v${v(9, '.0')}`,
      `a v${v(9, '')} badge`,
      `\`${v(1, '.0')}\``,
      `(${v(7, '.3')})`,
      `${v(9, '.0')}.`,
      `cloudbitmaps-roaring-${v(9, '.0')}.tgz`,
      `${v(1, '.0')}-rc.0`,
    ]) {
      expect(earlierReleases(text), text).toHaveLength(1);
    }
  });

  it('passes the numbers and versions that are not an earlier release of this library', () => {
    for (const text of [
      'guard: { minRetained: 0.5 }',
      'an opacity of 0.95',
      'v0.10.0 and 0.11.0 and 1.0.0',
      'esbuild 0.28.1, TypeScript 5.9',
      `the dependency pkg@${v(3, '.1')}`,
      '0.10.x',
    ]) {
      expect(earlierReleases(text), text).toEqual([]);
    }
  });
});
