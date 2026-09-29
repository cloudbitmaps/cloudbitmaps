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
 * A bare `0.N`, plain or marked up as code or bold, is a number, as in `minRetained: 0.5`, unless the words around
 * it make it a release:
 * - a noun after it ("store", "line", "format", "-era");
 * - a noun or verb before it ("version", "releases", "CloudBitmaps", one of our package names, "shipped");
 * - a preposition before it ("in", "since", "until") and a stop after;
 * - "from 0.N on", or a range from it to `0.10` or to a full later version;
 * - a heading, `## [0.N]` or `## 0.N`.
 *
 * `0.10.0` and later pass. An npm spec such as `pkg@0.N.P` or `pkg@^0.N.P` names another package's version and
 * passes, but not one of ours: in a spec, a CDN URL or a manifest's dependencies, in any quoting, it is refused.
 * Matching runs across line breaks and the comment or quote marker that starts the next line, so where a line wraps
 * changes nothing. SVG path data (`d="…"`, `points="…"`) is not read.
 *
 * Every tracked file is read but the lockfile, which carries nothing but other packages' versions, and binary
 * files. The words around an ordinary number can make it read as a release: "until" before it and a comma after,
 * or "lines" after it. So can another package's `0.x.y` in a manifest or an action's pin comment. A sentence that
 * trips on one is reworded; the patterns stay.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** After a bare `0.N`: not another digit, and not the dot of a longer version. A full stop may follow. */
const END = String.raw`(?!\d|\.[\dx*])`;
/**
 * Between two words: spaces, or a line break with any spaces and the comment or quote marker (`//`, `*`, `>`, `#`)
 * that starts the next line. A marker counts only after a line break, so `before * 0.9` is not two words.
 */
const GAP = String.raw`(?:[^\S\n]+|[^\S\n]*\n[^\S\n]*(?:(?:\/\/+|\*|>|#+)[^\S\n]+)?)`;
/** Not inside SVG path data. */
const NOT_SVG = String.raw`(?<!\b(?:d|points)=["'][^"']*)`;

/** A release before `0.10.0`, written as a version. A digit, a dot or an `@` before it (a spec) hides it. */
const EARLIER_RELEASE = new RegExp(
  String.raw`(?<![\d.@])(?<!@[\^~=<>]+)${NOT_SVG}v?0\.[1-9]\.(?:\d+|x|\*)(?!\d|\.\d)` +
    String.raw`|(?<![\w.@])${NOT_SVG}v0\.[1-9]${END}`,
  'gi',
);

/** One of our packages at an earlier release: in an npm spec or CDN URL, or as a manifest's dependency. */
const OURS = String.raw`(?:@cloudbitmaps\/[\w.-]+|(?<![\w@.-])(?:cloudbitmaps|cloud-roaring))`;
const EARLIER = String.raw`[\^~=<>]*v?0\.[1-9](?:\.(?:\d+|x|\*))?(?!\d|\.\d)`;
const OURS_AT_EARLIER = new RegExp(
  String.raw`${OURS}@${EARLIER}|["']${OURS}["']?\s*:\s*["']?[^"'\n]*?(?<![\d.])${EARLIER}`,
  'gi',
);

/** A bare `0.N`, plain or marked up, and what the words around it make a release. */
const BARE = String.raw`(?<![\w.])(?:\x60|\*\*?|_|<code>)?v?0\.[1-9]${END}(?:\x60|\*\*?|_|<\/code>)?`;
/** Not a measure: `0.9 ms`, `0.5x`, `0.5 GiB`. */
const NOT_A_MEASURE = String.raw`(?!\s*(?:x|×|%|ms|µs|s|[KMG]i?B)\b|[x×])`;
/** A later release a range can end at: `0.10`, or a full `0.1N.P`. */
const LATER = String.raw`v?0\.(?:1\d\.(?:\d+|x|\*)(?!\d)|10${END})`;
const BARE_RELEASE = new RegExp(
  [
    String.raw`${BARE}${GAP}(?:stores?|lines?|releases?|series|era|builds?|packages?|APIs?|upgrades?|users?|clients?|formats?|layouts?)\b`,
    String.raw`${BARE}-era\b`,
    String.raw`(?:\b(?:versions?|releases?|released|shipped|tagged|cloudbitmaps|cloud-roaring)|@cloudbitmaps\/[\w.-]+\x60?)${GAP}${BARE}${NOT_A_MEASURE}`,
    String.raw`\b(?:in|since|until|before|after)${GAP}${BARE}(?=\s*(?:[,;:)]|\.(?!\d)|(?![\s\S])))`,
    String.raw`\bfrom${GAP}${BARE}${GAP}(?:on|onwards?)(?=\s*(?:[,;:)]|\.(?!\d)|$))`,
    String.raw`${BARE}${GAP}?(?:to|→|->|–)${GAP}?${LATER}`,
    String.raw`^#{1,6}\s*\[v?0\.[1-9](?:\.\d+)?\](?=[^\S\n]*(?:$|-|–))`,
    String.raw`^#{1,6}[^\S\n]+v?0\.[1-9][^\S\n]*$`,
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
      `it changed in \`${v(9, '')}\`.`,
      `the \`${v(9, '')}\` line`,
      `version \`${v(9, '')}\``,
      `since <code>${v(9, '')}</code>,`,
      `in **${v(9, '')}**,`,
      `versions ${v(8, '')} and ${v(9, '')}`,
      `releases ${v(1, '')} to ${v(9, '')}`,
      `released ${v(9, '')} last year`,
      `the ${v(9, '')} format`,
      `the ${v(9, '')}-era layout`,
      `\`@cloudbitmaps/roaring\` ${v(9, '')} wrote`,
      `upgrading from ${v(9, '')} to ${v(10, '.0')}`,
      `${v(9, '')} → ${v(10, '.x')}`,
      `migrate ${v(9, '')}–${v(10, '')}`,
      `## ${v(9, '')}`,
      `# the change landed in\n# ${v(9, '')}, and`,
      `the migration runs from ${v(9, '')}\n// to ${v(10, '')}`,
      `a ${v(9, '')}\n# store`,
      `https://cdn.jsdelivr.net/npm/cloudbitmaps@${v(9, '.0')}/+esm`,
      `"@cloudbitmaps/core": "^${v(10, '.0')} || ^${v(9, '')}"`,
      `'@cloudbitmaps/roaring': ^${v(9, '')}`,
      `"@cloudbitmaps/roaring": "workspace:^${v(9, '')}"`,
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
      'expect(after).toBeLessThan(before * 0.9);',
      'const cap = after * 0.5;',
      'const n = Math.ceil(0.9 * lines.length);',
      'if (version > 0.5) {',
      '<path d="M0 0 v0.5 h1"/>',
      '<path d="M1 1l-0.1.2"/>',
      `<path d="M1 1 ${v(1, '.2')}"/>`,
      `npx publint@^${v(3, '.1')}`,
      `npm i -D foo@~${v(3, '.1')}`,
      'the ratio climbs from 0.5 on the first pass to 0.9 on the last',
      'a false-positive rate from 0.1 to 0.12',
      'cloudbitmaps 0.9 ms against roaring 1.2 ms',
      'CloudBitmaps 0.5x the bytes of a sorted array',
      '# [0.5] is the default',
      'opacity 0.95 to 0.15',
    ]) {
      expect(earlierReleases(text), text).toEqual([]);
    }
  });
});
