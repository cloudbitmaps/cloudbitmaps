import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The public repo describes the library from `0.10.0` on. No file in it names an earlier CloudBitmaps release: not
 * the docs, the READMEs, the site, the code or its comments (which ship in the `.d.ts` files and sourcemaps), the
 * tests, the benches, the scripts, or the files every tarball carries. The history before `0.10.0` is not in this
 * repo, and the library is described by what it is, not by what it used to be.
 *
 * A version is a `0.N.P`, `0.N.x` or `0.N.*` with N from 1 to 9, in any case and with any suffix, or a `v0.N`.
 * A bare `0.N` is a number, as in `minRetained: 0.5`, unless the words around it make it a release: a noun after it
 * ("store", "line", "release"), or a preposition before it ("in", "since") and a stop after. `0.10.0` and later
 * pass. An npm spec such as `pkg@0.N.P` names another package's version and passes, but not one of ours, which is
 * refused. Every tracked file is read but the lockfiles, which carry nothing but other packages' versions, and
 * binary files.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A release before `0.10.0`, written as a version. A letter before it does not hide one; a digit or a dot does. */
const EARLIER_RELEASE =
  /(?<![\d.@])v?0\.[1-9]\.(?:\d+|x|\*)(?!\d|\.\d)|(?<![\w.@])v0\.[1-9](?![\d.]|\.\d)/gi;

/** One of our packages at an earlier release, where the `@` would otherwise mark another package's version. */
const OURS_AT_EARLIER =
  /(?:@cloudbitmaps\/[\w.-]+|(?<![\w/@.-])(?:cloudbitmaps|cloud-roaring))@v?0\.[1-9](?:\.(?:\d+|x|\*))?(?!\d|\.\d)/gi;

/** A bare `0.N` the words around it make a release: a noun after it, or a preposition before it and a stop after. */
const BARE_RELEASE = new RegExp(
  String.raw`(?<![\w.])v?0\.[1-9](?![\d.])\s+(?:stores?|lines?|releases?|series|era|builds?|packages?|APIs?|upgrades?|users?|clients?)\b` +
    String.raw`|\b(?:in|from|since|until|before|after|on)\s+v?0\.[1-9](?![\d.%])(?=\s*(?:[,;:)]|$))`,
  'gim',
);

/** Binary files, which carry no prose. */
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|gz|tgz|zip|crbm|wasm|node)$/i;
const LOCKFILE = /(?:^|\/)pnpm-lock\.yaml$/;

/** Every tracked file, the extensionless ones included: `LICENSE` and `NOTICE` ship in every tarball. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && !LOCKFILE.test(f) && !BINARY.test(f))
    .sort();
}

/** Every earlier-release version in `text`, with its line. */
export function earlierReleases(text: string): Array<{ line: number; version: string }> {
  const found: Array<{ line: number; version: string }> = [];
  text.split('\n').forEach((line, i) => {
    for (const re of [EARLIER_RELEASE, OURS_AT_EARLIER, BARE_RELEASE]) {
      for (const m of line.matchAll(re)) found.push({ line: i + 1, version: m[0].trim() });
    }
  });
  return found;
}

// The planted versions are built, not written, so this file holds none of the spellings it refuses.
const v = (minor: number, rest: string): string => `0.${minor}${rest}`;

describe('no file names a CloudBitmaps release before 0.10.0', () => {
  it('the repo', () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (text.includes('\0')) continue;
      for (const { line, version } of earlierReleases(text)) {
        offenders.push(`${file}:${line} ${version}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads the files every tarball carries, and the site', () => {
    const files = trackedFiles();
    for (const f of ['LICENSE', 'README.md', 'packages/roaring/package.json', 'site/llms.txt']) {
      expect(files).toContain(f);
    }
  });

  it('refuses each way an earlier release is written', () => {
    for (const text of [
      `from ${v(9, '.0')} on`,
      `the ${v(9, '.x')} line`,
      `the ${v(9, '.X')} line`,
      `${v(9, '.*')}`,
      `tagged v${v(9, '.0')}`,
      `tagged V${v(9, '.0')}`,
      `a v${v(9, '')} badge`,
      `\`${v(1, '.0')}\``,
      `(${v(7, '.3')})`,
      `${v(9, '.0')}.`,
      `cloudbitmaps-roaring-${v(9, '.0')}.tgz`,
      `${v(1, '.0')}-rc.0`,
      `v${v(9, '.0')}rc1`,
      `${v(9, '.0')}a`,
      `${v(9, '.0')}_beta`,
      `release${v(9, '.0')}`,
      `npm i @cloudbitmaps/roaring@${v(9, '.0')}`,
      `@cloudbitmaps/roaring@${v(9, '')}`,
      `cloudbitmaps@${v(9, '.0')}`,
      `https://unpkg.com/@cloudbitmaps/core@${v(8, '.2')}/dist/index.js`,
      `a ${v(9, '')} store holding one`,
      `the ${v(9, '')} line`,
      `it changed in ${v(9, '')},`,
      `since ${v(4, '')})`,
    ]) {
      expect(earlierReleases(text), text).toHaveLength(1);
    }
  });

  it('passes the numbers and versions that are not an earlier release of this library', () => {
    for (const text of [
      'guard: { minRetained: 0.5 }',
      'an opacity of 0.95',
      'a share from 0.5 to 0.9 of the segment',
      'in 0.5 seconds',
      'on 0.5% of reads',
      'v0.10.0 and 0.11.0 and 1.0.0',
      'esbuild 0.28.1, TypeScript 5.9',
      `the dependency pkg@${v(3, '.1')}`,
      `left-pad@${v(3, '.1')}`,
      '0.10.x',
      '/sitemap/0.9',
      '<priority>0.9</priority>',
    ]) {
      expect(earlierReleases(text), text).toEqual([]);
    }
  });
});
