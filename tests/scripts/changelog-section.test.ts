import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Guards the extractor that feeds GitHub Release notes. It runs on a tag push, where a silent
// mis-extraction publishes empty or wrong notes on a release nobody can quietly re-cut — so the failure
// modes it must have are "throw", never "return something plausible".
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const { extractSection } = require_(join(ROOT, 'scripts', 'changelog-section.cjs')) as {
  extractSection: (markdown: string, version: string) => string;
};

const SAMPLE = `# Changelog

Preamble that must never leak into release notes.

## [Unreleased]

_Nothing yet._

## [0.2.0] - 2026-08-01

### Added

- The newer thing.

## [0.1.0] - 2026-07-26

First public release.

### Added

- The original thing.

<!-- trailing comment -->
`;

describe('changelog-section', () => {
  it('extracts exactly one version, stopping at the next heading', () => {
    const out = extractSection(SAMPLE, '0.2.0');
    expect(out).toContain('The newer thing.');
    // The bug that matters: bleeding into the neighbouring release's notes.
    expect(out).not.toContain('The original thing.');
    expect(out).not.toContain('## [0.1.0]');
    expect(out).not.toContain('Preamble');
  });

  it('runs to the end of the file for the last section', () => {
    const out = extractSection(SAMPLE, '0.1.0');
    expect(out).toContain('First public release.');
    expect(out).toContain('The original thing.');
    expect(out).not.toContain('The newer thing.');
  });

  it('accepts a tag-style leading v, since that is what a tag push provides', () => {
    expect(extractSection(SAMPLE, 'v0.1.0')).toBe(extractSection(SAMPLE, '0.1.0'));
  });

  it('does not confuse a version that is a prefix of another', () => {
    const md = '## [0.1.0] - a\n\nTEN\n\n## [0.1.0-rc.0] - b\n\nRC\n';
    expect(extractSection(md, '0.1.0')).toBe('TEN');
    expect(extractSection(md, '0.1.0-rc.0')).toBe('RC');
  });

  it('throws on a missing version rather than emitting nothing', () => {
    expect(() => extractSection(SAMPLE, '9.9.9')).toThrow(/no "## \[9\.9\.9\]" section/);
  });

  it('throws on an empty section rather than publishing blank notes', () => {
    expect(() => extractSection('## [1.0.0]\n\n## [0.9.0]\n\nx\n', '1.0.0')).toThrow(/empty/);
  });

  it('strips trailing HTML comments, which the last section always absorbs', () => {
    // Invisible in rendered Markdown, so a leak here would never be caught by eye — but it is an editorial
    // note to the changelog's maintainer, not something to publish as release notes.
    const md = '## [1.0.0]\n\nReal notes.\n\n<!-- new work goes under [Unreleased] -->\n';
    expect(extractSection(md, '1.0.0')).toBe('Real notes.');
  });

  it('keeps an HTML comment that is genuinely mid-section', () => {
    const md = '## [1.0.0]\n\nA\n\n<!-- keep -->\n\nB\n';
    expect(extractSection(md, '1.0.0')).toContain('<!-- keep -->');
  });

  it("refuses a section too large for GitHub's release body, with a way forward", () => {
    const md = `## [1.0.0]\n\n${'x'.repeat(130_000)}\n`;
    expect(() => extractSection(md, '1.0.0')).toThrow(/over GitHub's 125000 limit/);
    // The message has to say what to do, because this fires on a tag that is already pushed.
    expect(() => extractSection(md, '1.0.0')).toThrow(/curated notes/);
  });

  it("extracts the real repo's 0.1.0 section cleanly", () => {
    const real = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const out = extractSection(real, '0.1.0');
    // It is enormous — 0.1.0 absorbed the whole pre-1.0 dev log — but it does fit GitHub's cap, so the
    // extractor must succeed. (The v0.1.0 release itself ships hand-curated notes anyway: "fits" and
    // "worth reading as release notes" are different bars, and only the first one is this script's job.)
    expect(out.length).toBeGreaterThan(50_000);
    expect(out).not.toContain('## [Unreleased]');
    expect(out).not.toContain('Keep a Changelog');
    // The trailing maintainer comment must not be in there.
    expect(out).not.toMatch(/<!--[^>]*Unreleased[^>]*-->\s*$/);
  });
});
