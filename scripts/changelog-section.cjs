'use strict';
/*
 * Print one version's section from CHANGELOG.md, for GitHub Release notes.
 *
 * The release workflow feeds this straight into `gh release create --notes-file`, so the release notes and the
 * changelog cannot drift: there is one source of truth and the tag just quotes it. Hand-written release notes
 * are the alternative, and they rot immediately.
 *
 * Kept as a tested script rather than inline `awk` in the workflow for one reason: a silent mis-extraction
 * publishes wrong or empty notes on a tag, and a workflow one-liner is exactly the kind of thing nobody can
 * test before the tag is already pushed. Failing loudly beats emitting an empty file.
 *
 * Usage:
 *   node scripts/changelog-section.cjs 0.1.0
 *   node scripts/changelog-section.cjs v0.1.0     # a leading `v` is accepted (tags carry it)
 *   node scripts/changelog-section.cjs 0.1.0 --file path/to/CHANGELOG.md
 */
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');

// GitHub's hard cap on a release body. The margin leaves room for anything a caller appends.
const MAX_BODY_LIMIT = 125_000;
const MAX_BODY = 120_000;

/**
 * Extract the body of `## [<version>] …` up to (not including) the next `## ` heading.
 * Returns the trimmed body; throws if the version has no section or the section is empty.
 */
function extractSection(markdown, version) {
  const v = String(version).replace(/^v/, '');
  const lines = markdown.split('\n');
  // Match `## [0.1.0] - 2026-07-26`, `## [0.1.0]`, or `## 0.1.0` — the brackets are Keep-a-Changelog style
  // but not universal, and a release must not fail over a formatting variant.
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) throw new Error(`no "## [${v}]" section in the changelog`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  let body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();

  // Drop trailing HTML comments. They are editorial notes to whoever maintains the changelog ("new work goes
  // under [Unreleased]"), and the last section inevitably absorbs the ones parked at the end of the file.
  // Invisible in rendered Markdown, so this would never be caught by eye.
  body = body.replace(/(?:\s*<!--[\s\S]*?-->)+\s*$/, '').trim();

  if (body === '') throw new Error(`the "## [${v}]" section is empty`);

  // GitHub rejects a release body over 125,000 characters. Fail here, with the actual number and a way
  // forward, rather than letting `gh release create` fail opaquely after the tag is already public.
  if (body.length > MAX_BODY) {
    throw new Error(
      `the "## [${v}]" section is ${body.length} characters, over GitHub's ${MAX_BODY_LIMIT} limit for a ` +
        `release body. Write curated notes for this release instead and link to the changelog — a section ` +
        `this large is usually an accumulated pre-1.0 dev log, not something anyone reads in a release.`,
    );
  }
  return body;
}

module.exports = { extractSection };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  const file = fileIdx === -1 ? resolve(ROOT, 'CHANGELOG.md') : argv[fileIdx + 1];
  const version = argv.find((a) => !a.startsWith('--') && a !== file);

  if (!version) {
    console.error('usage: node scripts/changelog-section.cjs <version> [--file <changelog>]');
    process.exit(2);
  }
  try {
    process.stdout.write(extractSection(readFileSync(file, 'utf8'), version) + '\n');
  } catch (err) {
    console.error(`changelog-section: ${(err && err.message) || err}`);
    process.exit(1);
  }
}
