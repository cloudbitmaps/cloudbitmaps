'use strict';
/*
 * The detector behind the smoke test's check that every import a reader copies out of the docs compiles against
 * the built packages. Kept out of `scripts/smoke.cjs` so `tests/arch` can fire it at planted inputs in both
 * directions: a scanner that silently stops matching leaves the check green with nothing compiled.
 *
 * WHY THE CHECK EXISTS. The smoke test already compiles every `exports` entry, so a lost entry or a broken `.d.ts`
 * fails it. It cannot see a sample in a guide that imports a name its package does not export: that sample
 * fails on the first line a reader copies, and nothing else in the repository compiles it.
 *
 * WHAT IT READS. The pages a reader copies samples from: the root README, every page of `docs/guide/`, every
 * package's README, and the site (every `.html` page under `site/`, read through its markup, and `site/llms.txt`).
 * In each, every import from a workspace package: named bindings (`import { … }` or `import type { … }`, on one line
 * or across lines, indented, in a block quote or after a comment's `//`), a namespace import (`import * as x`) and a
 * default import. And it reports, for the check to fail on, every line that starts an import whose statement quotes
 * a workspace specifier and does not parse as one of those forms: a sample with a missing brace is a sample nobody
 * compiles, and must not pass as one.
 *
 * WHAT IT DOES NOT READ, so nobody over-trusts it: a `require(…)`, a dynamic `import(…)`, a malformed import that does
 * not start its line, and every page outside those places (the changelog, the other docs, the contributor guides). A
 * sample that uses a name it does not import is not compiled either: the check compiles the import alone.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Every `.html` file under `dir` (relative to `root`), sorted, subdirectories included. */
function htmlPages(root, dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlPages(root, rel));
    else if (e.name.endsWith('.html')) out.push(rel);
  }
  return out.sort();
}

/**
 * The pages, relative to `root`: the README, then the guide's pages, then each package's README, then the site's HTML
 * pages and its `llms.txt`, each group sorted.
 */
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
  return [
    'README.md',
    ...guides,
    ...packages,
    ...htmlPages(root, 'site'),
    path.join('site', 'llms.txt'),
  ];
}

/**
 * An HTML page's text as a reader sees it: without its tags, and with its quotes and brackets decoded. A tag that
 * spans lines (a comment, an attribute list) leaves its line breaks, so a line number still points into the page.
 */
function stripMarkup(html) {
  return html
    .replace(/<[^>]*>/g, (tag) => tag.replace(/[^\n]/g, ''))
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A page's text as `docImports` reads it: an HTML page through `stripMarkup`, any other as it is. */
function pageText(root, rel) {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  return rel.endsWith('.html') ? stripMarkup(raw) : raw;
}

/**
 * An import from a workspace package: named bindings, a namespace import, or a default import with or without named
 * bindings. Named bindings may span lines, but not a blank line, a `;`, a backtick or another brace, so an import with a
 * brace missing cannot run on to the next import's closing brace and swallow the page between them. The specifier stops
 * at a quote, a line break or an ellipsis, so a placeholder such as `@cloudbitmaps/…` in prose is not one.
 */
const BINDINGS = /\{(?:[^{};\x60\n]|\n(?![ \t>]*\n))*\}/.source;
const IMPORT = new RegExp(
  String.raw`\bimport\s+(?:type\s+)?(?:${BINDINGS}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:\s*,\s*${BINDINGS})?)` +
    String.raw`\s*from\s*(['"])(@cloudbitmaps\/[^'"\n…]+)\1\s*;?`,
  'g',
);

/**
 * Every such import in `text`, as `{ line, specifier, statement }`: the line it starts on, the package specifier,
 * and the statement as a reader copies it, with each continuation line's indentation and block-quote marker removed.
 */
function docImports(text) {
  const out = [];
  for (const m of text.matchAll(IMPORT)) {
    const line = text.slice(0, m.index).split('\n').length;
    const statement = m[0]
      .split('\n')
      .map((l, i) => (i === 0 ? l : l.replace(/^[ \t>]*/, '')))
      .join('\n');
    out.push({ line, specifier: m[2], statement });
  }
  return out;
}

/** A line that starts an import, after any indentation or block-quote marker. */
const STARTS_AN_IMPORT = /^[ \t>]*import\b/;

/**
 * Every line of `text` that starts an import of a workspace package which `docImports` does not read, as
 * `{ line, text }`. The import's statement is its line and the lines after it, up to the first that ends in `;`, a
 * blank line or a code fence; it is one of a workspace package when it quotes a specifier that starts
 * `@cloudbitmaps/`. A line on which `docImports` found an import is never reported.
 */
function unparsedImports(text) {
  const lines = text.split('\n');
  const read = new Set(docImports(text).map((i) => i.line));
  const out = [];
  lines.forEach((l, i) => {
    if (!STARTS_AN_IMPORT.test(l) || read.has(i + 1)) return;
    let statement = l;
    for (let j = i + 1; !/;\s*$/.test(statement) && j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() === '' || /^[ \t>]*```/.test(next)) break;
      statement += `\n${next}`;
    }
    if (/['"]@cloudbitmaps\//.test(statement)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

module.exports = { docImportPages, docImports, pageText, stripMarkup, unparsedImports };
