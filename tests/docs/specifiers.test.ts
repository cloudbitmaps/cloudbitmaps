import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards that no user-facing file still tells a reader to install or import the RETIRED unscoped package name.
//
// `cloud-roaring` survives on npm only as a non-functional `0.0.0` placeholder; the real
// packages are `@cloudbitmaps/roaring` (+ `/s3`, `/dynamodb`, …) and `@cloudbitmaps/core`. A doc or site page
// that says `npm i cloud-roaring` or `from 'cloud-roaring'` hands the reader an empty package and a
// `Cannot find module`, and it is the *most* copy-pasted content we publish.
//
// This exists because the package split swept the source and the docs but missed all four `site/` pages —
// every install line and every import there stayed on the old name, invisible to the source-graph tests.
// The name is still legitimate as the GitHub repo name, a README keyword, and a prose mention of history, so
// this checks the *specifier* forms only.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'build',
  '.pack-tmp',
  '.rss-stage',
]);

/** User-facing files: the root docs, both package READMEs, everything under `docs/`, and every site page. */
function publicFacingFiles(): string[] {
  // Not filtered by `existsSync`: a renamed entry must fail loudly rather than vanish from the guard.
  const out: string[] = [
    'README.md',
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'SECURITY.md',
    'PRIVACY.md',
    'packages/core/README.md',
    'packages/roaring/README.md',
    'packages/roaring/PRIVACY.md',
  ];

  const walk = (rel: string, match: (name: string) => boolean): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue;
      const childRel = join(rel, entry);
      if (statSync(join(ROOT, childRel)).isDirectory()) walk(childRel, match);
      else if (match(entry)) out.push(childRel);
    }
  };
  // Everything under `docs/` is in scope. There is no allowlist: this repo contains only public-bound docs,
  // so every one of them is an instruction a reader will follow, and a stale specifier in any of them is
  // simply wrong. (An earlier version carried two exemptions for immutable historical records that lived in a
  // separate, private tree — dead weight here, and removed with it.)
  walk('docs', (n) => n.endsWith('.md'));
  walk('site', (n) => n.endsWith('.html'));
  walk('.github', (n) => n.endsWith('.md'));
  return out;
}

/**
 * The specifier forms only — `npm i cloud-roaring`, `from 'cloud-roaring'`, `require('cloud-roaring')`,
 * `'cloud-roaring/s3'`. Deliberately NOT matched: `github.com/cloudbitmaps/cloudbitmaps` (the repo), a bare
 * prose mention, or `cloud-roaring` as an npm keyword.
 */
const OFFENDERS: readonly RegExp[] = [
  /\bnpm(?:&nbsp;| )+(?:i|install|add)(?:&nbsp;| )+cloud-roaring\b/,
  /\bpnpm(?:&nbsp;| )+(?:i|install|add)(?:&nbsp;| )+cloud-roaring\b/,
  // `from 'cloud-roaring'` / `require("cloud-roaring/s3")`, tolerating the site's syntax-highlight spans
  // between the keyword and the quoted specifier.
  /(?:from|require\s*\()[^'"\n]{0,80}['"]cloud-roaring(?:\/[a-z0-9]+)?['"]/,
  // A bare quoted specifier, e.g. inside a highlighted <span class="s">'cloud-roaring/s3'</span>.
  /['"]cloud-roaring\/[a-z0-9]+['"]/,
];

describe('retired package specifier', () => {
  const files = publicFacingFiles();

  it('finds the files it is supposed to guard', () => {
    expect(files).toContain('README.md');
    expect(files.filter((f) => f.startsWith('site/')).length).toBeGreaterThanOrEqual(4);
    expect(files.filter((f) => f.startsWith(join('docs', 'guide'))).length).toBeGreaterThan(0);
  });

  it.each(files)('%s — never tells a reader to install/import `cloud-roaring`', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const hits: string[] = [];
    src.split('\n').forEach((line, i) => {
      if (OFFENDERS.some((re) => re.test(line)))
        hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
    });
    expect(hits).toEqual([]);
  });
});
