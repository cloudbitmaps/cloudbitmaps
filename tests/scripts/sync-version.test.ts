import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the script that moves the `VERSION` constant after a version bump. VERSION ships as a literal in
// the published `.d.ts`, so a wrong value is immutable once released — which makes "return something
// plausible" the one behaviour this script must never have. Every failure mode below is a throw.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const { resolveVersion, rewrite, readManifests } = require_(
  join(ROOT, 'scripts', 'sync-version.cjs'),
) as {
  resolveVersion: (manifests: { name: string; version: string }[]) => string;
  rewrite: (source: string, want: string) => string;
  readManifests: (packagesDir: string) => { name: string; version: string }[];
};

const five = (version: string) =>
  ['core', 'roaring', 's3', 'gcs', 'azure-blob'].map((name) => ({ name, version }));

describe('sync-version', () => {
  describe('resolveVersion', () => {
    it('returns the single version the family agrees on', () => {
      expect(resolveVersion(five('0.11.0'))).toBe('0.11.0');
    });

    it('refuses when the manifests disagree, and names the offenders', () => {
      const skewed = [...five('0.11.0'), { name: 'newthing', version: '0.10.0' }];
      expect(() => resolveVersion(skewed)).toThrow(/disagree.*newthing@0\.10\.0/s);
    });

    // The vacuous-green case: a comparison over an empty or short list passes having checked nothing. This
    // repo has shipped that shape more than once — a lockstep check covering 2 of 5 packages, a guard whose
    // glob matched zero files and looped zero times.
    it('refuses a list too short to be the family', () => {
      expect(() => resolveVersion([])).toThrow(/at least 5 packages/);
      expect(() => resolveVersion(five('0.11.0').slice(0, 4))).toThrow(/found 4/);
    });
  });

  describe('rewrite', () => {
    it('replaces the constant', () => {
      const src = "foo\nexport const VERSION = '0.10.0';\nbar\n";
      expect(rewrite(src, '0.11.0')).toBe("foo\nexport const VERSION = '0.11.0';\nbar\n");
    });

    it('accepts either quote style', () => {
      expect(rewrite('export const VERSION = "0.10.0";', '0.11.0')).toBe(
        'export const VERSION = "0.11.0";',
      );
    });

    it('is idempotent', () => {
      const src = "export const VERSION = '0.11.0';";
      expect(rewrite(rewrite(src, '0.11.0'), '0.11.0')).toBe(src);
    });

    it('leaves the rest of the file alone', () => {
      const src = "const OTHER = '0.10.0';\nexport const VERSION = '0.10.0';\n";
      expect(rewrite(src, '0.11.0')).toBe(
        "const OTHER = '0.10.0';\nexport const VERSION = '0.11.0';\n",
      );
    });

    // Renamed, moved, or reformatted past the pattern. Silently returning the source unchanged would ship a
    // stale VERSION behind a green run, which is strictly worse than a failed bump.
    it('refuses a source with no VERSION constant', () => {
      expect(() => rewrite('export const NOPE = 1;', '0.11.0')).toThrow(/no .*VERSION/);
    });
  });

  describe('readManifests', () => {
    // Read off the real tree rather than a fixture: the point of the derivation is that it tracks this
    // workspace, so a fixture would prove the opposite of what matters.
    it('finds the whole family in this repo, all at one version', () => {
      const manifests = readManifests(join(ROOT, 'packages'));
      expect(manifests.length).toBeGreaterThanOrEqual(5);
      expect(manifests.map((m) => m.name)).toContain('roaring');
      expect(resolveVersion(manifests)).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
