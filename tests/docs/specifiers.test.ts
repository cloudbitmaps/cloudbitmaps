import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards that no user-facing file tells a reader to install or import the unscoped `cloud-roaring` package.
//
// `cloud-roaring` is on npm only as a non-functional `0.0.0` placeholder; the real packages are
// `@cloudbitmaps/roaring`, the storage packages (`@cloudbitmaps/s3`, `/gcs`, `/azure-blob`) and
// `@cloudbitmaps/core`. A doc or site page that says `npm i cloud-roaring` or `from 'cloud-roaring'` hands the
// reader an empty package and a `Cannot find module`, and it is the *most* copy-pasted content we publish.
//
// It reads the site pages and the package **source** as well as the docs. The site is invisible to the
// source-graph tests, and a doc-comment is copy-pasted exactly like a README (an editor shows it on hover, and
// it ships in the `.d.ts`), so every `site/` page and each package's `src` tree is in scope.
// The name is still legitimate as a README keyword and in prose, so this checks the *specifier* forms only.
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

/**
 * User-facing files: the root docs, both package READMEs, everything under `docs/`, every site page — and every
 * `.ts` under each package's `src`, whose doc-comments reach users through hover and the published `.d.ts`.
 */
function publicFacingFiles(): string[] {
  // Not filtered by `existsSync`: a renamed entry must fail loudly rather than vanish from the guard.
  const out: string[] = [
    'README.md',
    'CONTRIBUTING.md',
    'AGENTS.md',
    'SECURITY.md',
    'PRIVACY.md',
    ...packageReadmes(),
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
  // The published source. Its doc-comments are user-facing twice over — on hover in an editor, and inside the
  // `.d.ts` files and sourcemaps that ship in the tarball.
  // EVERY package's src, derived: all five publish `.d.ts` and sourcemaps, so all five are user-facing.
  for (const pkg of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (pkg.isDirectory()) walk(`packages/${pkg.name}/src`, (n) => n.endsWith('.ts'));
  }
  return out;
}

/**
 * Every package's README, derived from the workspace rather than listed.
 *
 * Derived so that a new package's README — the highest-risk copy in the repo for a stale specifier, since it
 * is new and carries runnable import examples — is inside the guard from its first commit.
 */
function packageReadmes(): string[] {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'README.md')))
    .map((e) => `packages/${e.name}/README.md`)
    .sort();
}

/**
 * The specifier forms only — `npm i cloud-roaring`, `from 'cloud-roaring'`, `require('cloud-roaring')`,
 * `'cloud-roaring/x'`. Deliberately NOT matched: `github.com/cloudbitmaps/cloudbitmaps` (the repo), a bare
 * prose mention, or `cloud-roaring` as an npm keyword.
 */
const OFFENDERS: readonly RegExp[] = [
  // Every client people actually use: a pattern that matched `npm i` on one line would miss `pnpm add`,
  // `yarn add`, the `npm install` long form, and a command that wraps its package onto the next line.
  /\b(?:npm|pnpm|yarn|bun)(?:&nbsp;| |\s)+(?:i|install|add)(?:&nbsp;| |\s)+cloud-roaring\b/,
  // `from 'cloud-roaring'` / `require("cloud-roaring/x")`, tolerating the site's syntax-highlight spans
  // between the keyword and the quoted specifier.
  /(?:from|require\s*\()[^'"\n]{0,80}['"]cloud-roaring(?:\/[a-z0-9]+)?['"]/,
  // A bare quoted specifier, e.g. inside a highlighted <span class="s">'cloud-roaring/x'</span>.
  //
  // The SUBPATH is required, and stays required. Dropping it to catch a bare `'cloud-roaring'` would flag a
  // string such as an OpenTelemetry meter name, which is a label a user chooses and not a module specifier at
  // all. A quoted string is only evidence of an import when it names a subpath; otherwise the `from` /
  // `require(` / `import(` forms below are what identify one.
  /['"]cloud-roaring\/[a-z0-9]+['"]/,
  // `await import('cloud-roaring')` — a real import, and neither `from` nor `require`.
  /\bimport\s*\(\s*['"]cloud-roaring(?:\/[a-z0-9]+)?['"]/,
];

describe('the placeholder package specifier', () => {
  const files = publicFacingFiles();

  it('finds the files it is supposed to guard', () => {
    expect(files).toContain('README.md');
    expect(files.filter((f) => f.startsWith('site/')).length).toBeGreaterThanOrEqual(4);
    expect(files.filter((f) => f.startsWith(join('docs', 'guide'))).length).toBeGreaterThan(0);
  });

  it.each(files)('%s — never tells a reader to install/import `cloud-roaring`', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const hits: string[] = [];
    // Whole text, not line by line: an install command wraps like any other prose, and which half the
    // package name lands in is decided by the width of the words before it.
    for (const re of OFFENDERS) {
      const m = new RegExp(re.source, `${re.flags.replace('g', '')}g`).exec(src);
      if (m) {
        const line = src.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${line}  ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
