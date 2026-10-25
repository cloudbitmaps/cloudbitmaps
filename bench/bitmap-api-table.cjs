/*
 * Writes the "against native" table of the public bitmap class into the pages that carry it, between
 * `<!-- BITMAP_API:TABLE:START -->` and `<!-- BITMAP_API:TABLE:END -->`, from `bench/bitmap-api-results.json`
 * (`bench/lib/bitmap-api-table.cjs` makes the text and says what a region may hold).
 *
 *   node bench/bitmap-api-table.cjs           rewrite the regions
 *   node bench/bitmap-api-table.cjs --check   change nothing; fail if a region is not what the record renders to,
 *                                             or the record's gate stops it
 *
 * `BITMAP_API_TABLE_ROOT` points either mode at a copy of the tree. While the record holds no pass the regions say the
 * table is not measured yet.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const table = require('./lib/bitmap-api-table.cjs');
const verdict = require('./lib/bitmap-api-verdict.cjs');

const ROOT = process.env.BITMAP_API_TABLE_ROOT || path.resolve(__dirname, '..');
const PAGES = ['docs/guide/api-reference.md', 'docs/guide/roaring-codec.md'];

const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/bitmap-api-results.json'), 'utf8'));
const check = process.argv.includes('--check');
let failed = false;

for (const problem of verdict.gateProblems(file.passes ?? [])) {
  if ((file.passes ?? []).length === 0) break;
  console.error(`bitmap-api-table: ${problem}`);
  failed = true;
}
for (const page of PAGES) {
  const abs = path.join(ROOT, page);
  const text = fs.readFileSync(abs, 'utf8');
  if (check) {
    for (const problem of table.problemsOf(page, text, file)) {
      console.error(`bitmap-api-table: ${problem}`);
      failed = true;
    }
    continue;
  }
  const next = table.withRegion(page, text, file);
  if (next !== text) {
    fs.writeFileSync(abs, next);
    console.log(`bitmap-api-table: wrote ${page}`);
  }
}
if (failed) process.exit(1);
if (check) console.log('bitmap-api-table --check: ok');
