'use strict';
/*
 * The detector behind the smoke test's check that every import a reader copies out of the docs compiles against
 * the built packages. Kept out of `scripts/smoke.cjs` so `tests/arch` can fire it at planted inputs in both
 * directions: a scanner that silently stops matching leaves the check green with nothing compiled.
 *
 * WHY THE CHECK EXISTS. The smoke test already compiles every `exports` entry, so a lost entry or a broken `.d.ts`
 * fails it. It cannot see a sample in a guide that imports a name the package no longer exports: that sample
 * fails on the first line a reader copies, and nothing else in the repository compiles it.
 *
 * WHAT IT READS. The pages a reader copies samples from: the root README, every page of `docs/guide/` and every
 * package's README. In each, a line that starts an import of named bindings from a workspace package
 * (`import { … } from '@cloudbitmaps/…'`, or `import type { … }`), its bindings on that line or on the lines that
 * follow, indented or inside a block quote, since a sample in a list item or a quote is copied too.
 *
 * WHAT IT DOES NOT READ, so nobody over-trusts it: a default or namespace import, a `require(…)`, an import that
 * does not start its line (one quoted mid-sentence in prose), and every page outside those three places (the
 * site, the changelog, the other docs). A sample that uses a name it does not import is not compiled either: the
 * check compiles the import alone.
 */
const fs = require('node:fs');
const path = require('node:path');

/** The pages, relative to `root`: the README, then the guide's pages, then each package's README, each sorted. */
function docImportPages(root) {
  const guide = path.join('docs', 'guide');
  const guides = fs
    .readdirSync(path.join(root, guide))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(guide, f));
  const packages = fs
    .readdirSync(path.join(root, 'packages'))
    .filter((d) => fs.existsSync(path.join(root, 'packages', d, 'README.md')))
    .sort()
    .map((d) => path.join('packages', d, 'README.md'));
  return ['README.md', ...guides, ...packages];
}

/**
 * A line that starts an import of named bindings from a workspace package. The bindings may span lines (`[^}]`
 * crosses them); the leading `[ \t>]*` takes the indentation of a list item and the marker of a block quote.
 */
const IMPORT =
  /^[ \t>]*(import\s+(?:type\s+)?\{[^}]*\}\s*from\s*(['"])(@cloudbitmaps\/[^'"\n]+)\2\s*;?)/gm;

/**
 * Every such import in `text`, as `{ line, specifier, statement }`: the line it starts on, the package specifier,
 * and the statement as a reader copies it, with each continuation line's indentation and block-quote marker removed.
 */
function docImports(text) {
  const out = [];
  for (const m of text.matchAll(IMPORT)) {
    const line = text.slice(0, m.index).split('\n').length;
    const statement = (m[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^[ \t>]*/, ''))
      .join('\n');
    out.push({ line, specifier: m[3], statement });
  }
  return out;
}

module.exports = { docImportPages, docImports };
