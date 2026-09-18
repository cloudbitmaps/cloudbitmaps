import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * While the storage packages are unpublished, every page that tells a reader to install one must say so —
 * and the moment they ship, that caveat must be gone.
 *
 * WHY THIS FILE EXISTS. The published site's primary call to action was `npm i @cloudbitmaps/roaring
 * @cloudbitmaps/s3`, in eight places, while `@cloudbitmaps/s3`, `/gcs` and `/azure-blob` did not exist on
 * npm — the driver split landed in the repo a release before it landed on the registry. The first command a
 * visitor ran returned a 404, on a page badging itself with a version whose packaging it was not describing.
 *
 * A temporary note is the honest fix, but temporary notes are exactly what a release forgets: it would have
 * to be removed by hand from eight files, in the same change that bumps five versions and binds three new
 * Trusted Publishers. So it is not left to memory. This guard is BIDIRECTIONAL and keys off the workspace
 * version, which the release bump has to touch anyway:
 *
 *   - before `0.10.0` — every file advertising a driver install MUST carry the caveat;
 *   - from `0.10.0` — NO file may, and the release cannot go green until each one is removed.
 *
 * It reads the version rather than the registry on purpose: a test that hit npm would be non-deterministic,
 * offline-hostile, and would start failing for reasons that have nothing to do with this repo.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees', 'build', 'golden']);
const EXTS = ['.md', '.html', '.txt'];

/** This file names the caveat in order to define it; CHANGELOG entries are history. */
const DEFINES_THE_RULE = new Set([join('tests', 'docs', 'unreleased-install-caveat.test.ts')]);
const HISTORY = new Set(['CHANGELOG.md', 'MIGRATING.md']);

/** The canonical wording. One string, so a page cannot half-comply with a paraphrase. */
const CAVEAT = 'land in 0.10.0';
/** Telling a reader to install a driver package. */
const ADVERTISES_INSTALL = /npm i [^\n]*@cloudbitmaps\/(?:s3|gcs|azure-blob)/;

const version = (
  JSON.parse(readFileSync(join(ROOT, 'packages/roaring/package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** `0.10.0` is where the driver packages first exist on npm. Compare numerically, not as strings. */
const driversPublished = ((): boolean => {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major > 0 || minor >= 10;
})();

function textFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      if (SKIP.has(entry)) continue;
      const child = rel === '.' ? entry : join(rel, entry);
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (EXTS.some((e) => entry.endsWith(e))) out.push(child);
    }
  };
  walk('.');
  return out.filter((f) => !DEFINES_THE_RULE.has(f) && !HISTORY.has(f));
}

describe('the unreleased-driver install caveat tracks the version that makes it true', () => {
  const files = textFiles();
  const advertising = files.filter((f) =>
    ADVERTISES_INSTALL.test(readFileSync(join(ROOT, f), 'utf8')),
  );

  it('still finds the pages that advertise a driver install', () => {
    // A guard that stopped reaching these would pass silently while the site told people to install a 404.
    expect(advertising).toContain('README.md');
    expect(advertising.some((f) => f.startsWith(join('site', '')))).toBe(true);
    expect(advertising.length).toBeGreaterThanOrEqual(6);
  });

  if (driversPublished) {
    it.each(advertising)('%s no longer carries the pre-release caveat', (rel) => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(
        src.includes(CAVEAT),
        `${rel} still says "${CAVEAT}", but this workspace is ${version} — the storage packages ship now. ` +
          `Remove the caveat as part of the release.`,
      ).toBe(false);
    });
  } else {
    it.each(advertising)('%s says the storage packages are not on npm yet', (rel) => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(
        src.includes(CAVEAT),
        `${rel} tells a reader to \`npm i\` a storage package, but this workspace is ${version} and those ` +
          `packages are not published until 0.10.0 — that command 404s. Add the caveat: "${CAVEAT}".`,
      ).toBe(true);
    });
  }
});
