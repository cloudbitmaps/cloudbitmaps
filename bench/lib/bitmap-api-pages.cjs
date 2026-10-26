/*
 * The pages of the repository a reader sees, as the table's phrase check reads them: the two pages that carry the
 * generated table (`REGION_PAGES`), and every other public page, which carries no table and may not say "close to
 * native" at all: the README, every Markdown page under `docs/`, and each package's README.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The pages that carry a generated region. */
const REGION_PAGES = ['docs/guide/api-reference.md', 'docs/guide/roaring-codec.md'];

/** Every Markdown file under a folder, as paths relative to `root`, sorted. */
function markdownUnder(root, dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.md')) out.push(next);
    }
  };
  if (fs.existsSync(path.join(root, dir))) walk(dir);
  return out.sort();
}

/** Every public page that carries no generated region, as paths relative to `root`. */
function otherPages(root) {
  const packages = fs.existsSync(path.join(root, 'packages'))
    ? fs
        .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join('packages', d.name, 'README.md'))
        .filter((f) => fs.existsSync(path.join(root, f)))
    : [];
  const pages = [
    ...(fs.existsSync(path.join(root, 'README.md')) ? ['README.md'] : []),
    ...markdownUnder(root, 'docs'),
    ...packages,
  ];
  return pages.filter((p) => !REGION_PAGES.includes(p));
}

module.exports = { REGION_PAGES, otherPages };
