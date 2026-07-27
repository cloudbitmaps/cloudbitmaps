import { readFileSync, readdirSync } from 'node:fs';
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
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = join(ROOT, 'site');

const version = (
  JSON.parse(readFileSync(join(ROOT, 'packages/roaring/package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** A version-ish string: `v1.2.3`, tolerating an optional prerelease suffix. */
const VERSION_RE = /\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g;

/**
 * The project's own badges, and only those.
 *
 * A first draft matched every `vX.Y.Z` anywhere on a page and immediately failed on `v24.14.1` — the **Node**
 * version in the benchmark methodology, which is a fact about the measurement and has nothing to do with the
 * release. A guard that fires on correct content trains people to ignore it, so the match is anchored on what
 * actually distinguishes a badge: both shapes the site uses — the header `CloudBitmaps v0.1.3 · pre-1.0` and
 * the footer `pre-1.0 v0.1.3` — carry `pre-1.0` on the same line. Third-party versions never do.
 */
function badgeVersions(html: string): string[] {
  return html
    .split('\n')
    .filter((line) => line.includes('pre-1.0'))
    .flatMap((line) => [...line.matchAll(VERSION_RE)].map((m) => m[1] as string));
}

const pages = readdirSync(SITE).filter((f) => f.endsWith('.html'));

describe('site version badges', () => {
  it('finds the pages at all, so a rename cannot turn this suite into a no-op', () => {
    // Without this, moving or renaming site/ leaves zero pages, every it.each below generates zero cases,
    // and the file passes while checking nothing — the vacuous-guard failure mode.
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages)('%s advertises the current version everywhere it names one', (page) => {
    const found = badgeVersions(readFileSync(join(SITE, page), 'utf8'));
    // A page with no version badge is fine — not every page has one. A page with the WRONG one is not.
    for (const v of found) {
      expect(v, `${page} names v${v}, but the packages are at ${version}`).toBe(version);
    }
  });

  it('at least one page actually carries a badge', () => {
    // Guards the inverse mistake: deleting every badge would make the per-page assertion vacuously true.
    const total = pages.reduce(
      (n, p) => n + badgeVersions(readFileSync(join(SITE, p), 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it('matches the exported VERSION constant, so all three sources agree', async () => {
    // package.json ↔ VERSION is already pinned by tests/index.test.ts; this closes the triangle so the site
    // cannot agree with one and disagree with the other.
    const { VERSION } = (await import('@/index')) as { VERSION: string };
    expect(VERSION).toBe(version);
  });
});
