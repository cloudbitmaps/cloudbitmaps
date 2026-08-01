import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The site's version badge drifts silently, and this test exists because it did.
//
// Cutting 0.1.3 bumped both manifests and the exported `VERSION` constant — the latter caught by
// `tests/index.test.ts`, which is why that one has never been wrong. The site pages carry the same number in
// two places each, guarded by nothing, and were still advertising 0.1.2. Nobody would have noticed: the pages
// render fine, CI is green, and the only symptom is a visitor being told the current release is one they
// cannot install the features of.
//
// Documentation that is WRONG is worse than documentation that is missing, and a version badge is the single
// most load-bearing number on a landing page — it is what a reader checks to decide whether a feature they
// just read about exists yet. So it gets the same treatment as every other public claim in this repo: pinned
// by a test rather than by remembering.
//
// It covers two surfaces, `site/` and the markdown docs, because the hole it was written to close turned out
// to be in both. See MARKDOWN_DOCS for why the second half is scoped differently from the first.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = join(ROOT, 'site');

const version = (
  JSON.parse(readFileSync(join(ROOT, 'packages/roaring/package.json'), 'utf8')) as {
    version: string;
  }
).version;

/**
 * A version-ish string. The `v` is optional on purpose — see {@link FOREIGN_VERSIONS}.
 */
const VERSION_RE = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g;

/**
 * Versions on the site that are deliberately NOT ours, each with the reason it is here.
 *
 * This allowlist is the whole design. Two earlier drafts tried to identify our badges by what sits NEAR them
 * and both under-reached:
 *
 *   1. anchored on `pre-1.0` — reached 1 of 7 pages, because only benchmarks.html put that string on the same
 *      line as a version.
 *   2. added `Apache-2.0` — reached all 7 pages, and was believed to be complete. It was not: it still missed
 *      4 of 19 occurrences, because the hero eyebrows (`roaring shipped · v0.5.0`, `Usage ·
 *      @cloudbitmaps/roaring v0.5.0`) name the release with neither anchor beside them, and flavors.html's
 *      status pill wrote it BARE (`Shipped 0.5.0`) where a `v`-prefixed regex could not see it at all. All four
 *      were nonetheless bumped correctly through several releases — by hand, which is exactly the property a
 *      gate is supposed to remove.
 *
 * Both drafts failed the same way: an opt-IN match, where a version is only checked if it looks the way the
 * test author expected. New copy is then unguarded by default and nothing says so. So the polarity is
 * inverted — every version-shaped token on a site page is assumed to be OURS and must equal the release, and
 * the exceptions are enumerated here. New copy is guarded by default; the failure mode is a loud false
 * positive that gets an entry added, not silent staleness.
 */
const FOREIGN_VERSIONS = new Map<string, string>([
  [
    '24.14.1',
    'the Node version in the benchmarks methodology — a fact about the measurement, not a release',
  ],
  [
    '0.0.0',
    "README's license section: the placeholder published to reserve the unscoped `cloud-roaring` npm name",
  ],
]);

/**
 * Version tokens a reader can actually see, excluding HTML comments.
 *
 * Comments are stripped because they are not rendered, so they cannot mislead anyone — and because they
 * legitimately discuss other releases ("until 0.6.0, this table offered nothing to check it against"), which a
 * bare-token match would otherwise flag forever.
 */
function badgeVersions(html: string): string[] {
  return [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(VERSION_RE)]
    .map((m) => m[1] as string)
    .filter((v) => !FOREIGN_VERSIONS.has(v));
}

/**
 * Every page under `site/`, nested ones included.
 *
 * This was `readdirSync(SITE)` — one level, no recursion — which was correct only for as long as the site was
 * flat. Moving the roaring page to `site/flavors/roaring.html` (so the `/flavors/roaring` URL it has always
 * advertised as its canonical actually resolves) would have dropped it out of this suite entirely: the loop
 * below would have found six pages, passed, and left the flagship flavor page free to advertise any version at
 * all. That is the same hole this file was rewritten to close, reopened by a directory move rather than by a
 * wording change — so the enumeration is now structural rather than depth-one.
 */
function htmlPagesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return htmlPagesUnder(join(dir, entry.name), rel);
    return entry.name.endsWith('.html') ? [rel] : [];
  });
}

const pages = htmlPagesUnder(SITE);

/**
 * Non-HTML files that also name the release.
 *
 * `llms.txt` is the machine-readable summary served to crawlers and assistants, and it sat at `v0.1.0` through
 * three releases — invisible because this suite only ever read `*.html`. A version gate that covers some of the
 * files carrying a version is a gate with a hole in it, and this is what fell through.
 */
const VERSIONED_TEXT_FILES = ['llms.txt'];

/**
 * Markdown that describes the CURRENT release, and therefore must name the current release.
 *
 * The third hole in the same gate. It has now grown twice for the same reason — once for `llms.txt` (a
 * versioned file that was not `*.html`) and once for nested pages (a versioned file the walk could not reach) —
 * and both times the note left behind said that a version gate covering *some* of the files carrying a version
 * is a gate with a hole in it. The markdown was the rest of that hole: `README.md` and the getting-started
 * guide both advertised `0.1.1` while the packages shipped `0.6.0`, across five releases, because nothing in
 * here had ever opened a `.md`.
 *
 * The site half's polarity does **not** transfer wholesale, and that is the part worth reading. On the site
 * every version token is a badge — a claim about what you can install right now — so "assume ours, allowlist
 * the exceptions" is right. In markdown it is not: `docs/ROADMAP.md` is *about* past releases ("other cloud
 * backends are post-`0.1.0`"), and at the repo root `CHANGELOG.md`, `RELEASING.md` and `SECURITY.md` are a
 * release history, worked examples, and third-party advisory pins respectively. Pointing an assume-ours rule at
 * those yields nothing but false positives, and the allowlist absorbing them would grow until it exempted the
 * numbers that actually matter.
 *
 * So the scope is per-FILE and by kind — files whose job is to describe the library as it is *now*. Inside
 * them the site polarity applies unchanged. The set is derived by walking `docs/` rather than enumerated, so a
 * new page is covered the day it is added; `ROADMAP.md` is the one carve-out and it has to name itself here.
 */
const HISTORICAL_DOCS = new Set([
  'docs/ROADMAP.md', // a release history by design — every version in it is deliberately not the current one
]);

function markdownUnder(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return markdownUnder(join(dir, entry.name), rel);
    return entry.name.endsWith('.md') && !HISTORICAL_DOCS.has(rel) ? [rel] : [];
  });
}

const MARKDOWN_DOCS = ['README.md', ...markdownUnder(join(ROOT, 'docs'), 'docs')];

describe('site version badges', () => {
  it('finds the pages at all, so a rename cannot turn this suite into a no-op', () => {
    // Without this, moving or renaming site/ leaves zero pages, every it.each below generates zero cases,
    // and the file passes while checking nothing — the vacuous-guard failure mode.
    expect(pages.length).toBeGreaterThan(0);
  });

  it('reaches pages in subdirectories, not just the top level', () => {
    // Named explicitly because the depth-one version of this suite passed while silently excluding a nested
    // page. "Every page" has to mean every page at any depth, and the assertion that says so should fail if the
    // walk ever regresses to one level — not merely cover fewer files without comment.
    const nested = pages.filter((p) => p.includes('/'));
    expect(
      nested.length,
      `no nested page found under site/ — did the walk stop recursing?`,
    ).toBeGreaterThan(0);
  });

  it.each(VERSIONED_TEXT_FILES)('%s advertises the current version', (file) => {
    const found = [...readFileSync(join(SITE, file), 'utf8').matchAll(VERSION_RE)].map(
      (m) => m[1] as string,
    );
    expect(
      found.length,
      `${file} names no version at all — did its wording change?`,
    ).toBeGreaterThan(0);
    for (const v of found) {
      expect(v, `${file} names v${v}, but the packages are at ${version}`).toBe(version);
    }
  });

  it.each(pages)('%s advertises the current version everywhere it names one', (page) => {
    const found = badgeVersions(readFileSync(join(SITE, page), 'utf8'));
    for (const v of found) {
      expect(
        v,
        `${page} names ${v}, but the packages are at ${version}. If ${v} is a third-party version ` +
          `rather than ours, add it to FOREIGN_VERSIONS with the reason.`,
      ).toBe(version);
    }
  });

  it('every page carries the release at least once', () => {
    // Guards the inverse mistake: the per-page loop above is vacuously true for a page with no badge at all,
    // so deleting one would pass. Every page currently names the release in a footer line, and a page that
    // stops doing so is either a copy regression or a deliberate change that should come here first.
    for (const p of pages) {
      expect(
        badgeVersions(readFileSync(join(SITE, p), 'utf8')).length,
        `${p} names no version anywhere — was a footer badge dropped?`,
      ).toBeGreaterThan(0);
    }
  });

  it('every FOREIGN_VERSIONS entry is still somewhere it is needed', () => {
    // An allowlist nobody prunes is how the check quietly widens: the day the benchmark methodology is re-run
    // on a newer Node, `24.14.1` stops appearing and its entry starts silently exempting nothing — or worse,
    // exempts that number if it ever becomes OUR version. Entries must justify themselves every run.
    //
    // Read across BOTH surfaces, because the map is shared by both. Scoped to the site alone this would fail
    // the moment a markdown-only exemption was added, and the tempting fix — a second parallel allowlist — is
    // how one rule becomes two that drift.
    const all = [
      ...[...pages, ...VERSIONED_TEXT_FILES].map((f) => readFileSync(join(SITE, f), 'utf8')),
      ...MARKDOWN_DOCS.map((f) => readFileSync(join(ROOT, f), 'utf8')),
    ].join('\n');
    for (const [v, why] of FOREIGN_VERSIONS) {
      expect(all, `FOREIGN_VERSIONS has a stale entry: ${v} (${why}) no longer appears`).toContain(
        v,
      );
      expect(
        v,
        `FOREIGN_VERSIONS exempts ${v}, which is now OUR version — remove the entry`,
      ).not.toBe(version);
    }
  });

  it('matches the exported VERSION constant, so all three sources agree', async () => {
    // package.json ↔ VERSION is already pinned by tests/index.test.ts; this closes the triangle so the site
    // cannot agree with one and disagree with the other.
    const { VERSION } = (await import('@/index')) as { VERSION: string };
    expect(VERSION).toBe(version);
  });
});

describe('markdown version claims', () => {
  it('reaches the two front doors, so a move cannot silently shrink the scope', () => {
    // README and the getting-started guide are the files a reader meets first and the two that were actually
    // wrong. The derived walk protects against a page being ADDED and missed; this protects against one being
    // MOVED and dropped, which the walk cannot see. Both were stale for five releases, so a rename has to fail
    // loudly here rather than quietly reduce what is checked.
    expect(MARKDOWN_DOCS).toContain('README.md');
    expect(MARKDOWN_DOCS).toContain('docs/guide/getting-started.md');
  });

  it('is not vacuous — the covered docs name a version somewhere', () => {
    // Every per-file assertion below is a loop over the tokens found, so a scope that matched only
    // version-free files would pass while checking nothing. That is exactly how the markdown went unguarded in
    // the first place, so it gets an assertion rather than an assumption.
    const total = MARKDOWN_DOCS.reduce(
      (n, f) => n + badgeVersions(readFileSync(join(ROOT, f), 'utf8')).length,
      0,
    );
    expect(
      total,
      'no covered markdown doc names a version — is the scope still right?',
    ).toBeGreaterThan(0);
  });

  it('excludes only docs that exist, so a stale carve-out cannot linger', () => {
    // HISTORICAL_DOCS is an exemption list and gets the same treatment as FOREIGN_VERSIONS: if ROADMAP.md is
    // renamed, the entry stops excluding anything and should be deleted rather than left as a comment about a
    // file that is gone.
    for (const f of HISTORICAL_DOCS) {
      expect(
        existsSync(join(ROOT, f)),
        `HISTORICAL_DOCS carves out ${f}, which no longer exists`,
      ).toBe(true);
    }
  });

  it.each(MARKDOWN_DOCS)('%s names the current version wherever it names one', (file) => {
    for (const v of badgeVersions(readFileSync(join(ROOT, file), 'utf8'))) {
      expect(
        v,
        `${file} names ${v}, but the packages are at ${version}. If ${v} is a third-party or historical ` +
          `version rather than a claim about the current release, add it to FOREIGN_VERSIONS with the reason ` +
          `— or, if the whole file is a release history, to HISTORICAL_DOCS.`,
      ).toBe(version);
    }
  });
});
