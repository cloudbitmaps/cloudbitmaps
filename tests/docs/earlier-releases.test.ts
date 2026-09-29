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
 * ("store", "line", "release"), a noun before it ("version", "CloudBitmaps"), a preposition before it ("in",
 * "since") and a stop after, a range ("from 0.N on", "0.N to 0.1N"), or a changelog heading. `0.10.0` and later
 * pass. An npm spec such as `pkg@0.N.P` names another package's version and passes, but not one of ours, in a spec
 * or a manifest, which is refused. Matching runs across line breaks, so where a line wraps changes nothing. Every
 * tracked file is read but the lockfiles, which carry nothing but other packages' versions, and binary files.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** After a bare `0.N`: not another digit, and not the dot of a longer version. A full stop may follow. */
const END = String.raw`(?!\d|\.[\dx*])`;
/** Between two words: spaces, and a line break with the comment or quote marker that starts the next line. */
const GAP = String.raw`(?:\s+(?:(?:\/\/+|\*|>)\s+)?)`;

/**
 * A release before `0.10.0`, written as a version. A word before a `0.N.P` does not hide it, but a digit, a dot,
 * or a lone SVG path command (`l0.1.2` in path data) does.
 */
const EARLIER_RELEASE = new RegExp(
  String.raw`(?<![\d.@])(?<!(?:^|[^A-Za-z])[MLHVCSQTAZ])v?0\.[1-9]\.(?:\d+|x|\*)(?!\d|\.\d)` +
    String.raw`|(?<![\w.@])v0\.[1-9]${END}`,
  'gi',
);

/** One of our packages at an earlier release, in an npm spec or a manifest's dependencies. */
const OURS = String.raw`(?:@cloudbitmaps\/[\w.-]+|(?<![\w/@.-])(?:cloudbitmaps|cloud-roaring))`;
const EARLIER = String.raw`[\^~=<>]*v?0\.[1-9](?:\.(?:\d+|x|\*))?(?!\d|\.\d)`;
const OURS_AT_EARLIER = new RegExp(
  String.raw`${OURS}@${EARLIER}|"${OURS}"\s*:\s*"${EARLIER}`,
  'gi',
);

/** A bare `0.N` the words around it make a release. */
const BARE = String.raw`(?<![\w.])v?0\.[1-9]${END}`;
const BARE_RELEASE = new RegExp(
  [
    String.raw`${BARE}${GAP}(?:stores?|lines?|releases?|series|era|builds?|packages?|APIs?|upgrades?|users?|clients?)\b`,
    String.raw`\b(?:version|release|cloudbitmaps|cloud-roaring)${GAP}${BARE}`,
    String.raw`\b(?:in|since|until|before|after)${GAP}${BARE}(?=\s*(?:[,;:)]|\.(?!\d)|(?![\s\S])))`,
    String.raw`\bfrom${GAP}${BARE}${GAP}(?:on|onwards?)\b`,
    String.raw`${BARE}\s*(?:to|→|->)${GAP}v?0\.1\d(?![\d.])`,
    String.raw`^#{1,6}\s*\[v?0\.[1-9](?:\.\d+)?\]`,
  ].join('|'),
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

/** Every earlier-release version in `text`, with the line it starts on; two patterns matching one version count once. */
export function earlierReleases(text: string): Array<{ line: number; version: string }> {
  const spans: Array<{ start: number; end: number; version: string }> = [];
  for (const re of [EARLIER_RELEASE, OURS_AT_EARLIER, BARE_RELEASE]) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      spans.push({ start, end: start + m[0].length, version: m[0].trim().replace(/\s+/g, ' ') });
    }
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  const found: Array<{ line: number; version: string }> = [];
  let reach = -1;
  for (const s of spans) {
    if (s.start < reach) continue;
    reach = s.end;
    found.push({ line: text.slice(0, s.start).split('\n').length, version: s.version });
  }
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
      `tagged v${v(9, '.')}`,
      `shipped in v${v(9, '')}.`,
      `it changed in ${v(9, '')}.`,
      `it changed in ${v(9, '')}`,
      `version ${v(9, '')}`,
      `release ${v(9, '')} is`,
      `CloudBitmaps ${v(9, '')} reads`,
      `## [${v(9, '')}]`,
      `## [${v(9, '.1')}] - 2026-01-01`,
      `"@cloudbitmaps/roaring": "${v(9, '')}"`,
      `"@cloudbitmaps/core": "^${v(9, '.0')}"`,
      `@cloudbitmaps/roaring@^${v(9, '')}`,
      `@cloudbitmaps/roaring@~${v(9, '')}`,
      `from ${v(9, '')} to ${v(10, '')}`,
      `from ${v(9, '')} onward`,
      `the change landed in\n// ${v(9, '')}, and`,
      `a ${v(9, '')}\n * store`,
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
      'falls from 0.9, the default, to 0.5',
      '(maxShrink on 0.5)',
      'a ratio from 0.5 to 0.95',
      'it drops the share\n// from 0.9\n// to 0.5 of the segment',
      'a delay in 0.5\nseconds',
      `<path d="M0 0l${v(1, '.2')}h3"/>`,
      `<path d="M${v(1, '.2')}"/>`,
      'thresholds: [0.5]',
    ]) {
      expect(earlierReleases(text), text).toEqual([]);
    }
  });
});
