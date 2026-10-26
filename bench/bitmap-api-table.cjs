/*
 * Writes the "against native" table of the public bitmap class into the pages that carry it, between
 * `<!-- BITMAP_API:TABLE:START -->` and `<!-- BITMAP_API:TABLE:END -->`, from `bench/bitmap-api-results.json`
 * (`bench/lib/bitmap-api-table.cjs` makes the text and says what a region may hold).
 *
 *   node bench/bitmap-api-table.cjs           rewrite the regions
 *   node bench/bitmap-api-table.cjs --check   change nothing; fail if a region is not what the record renders to,
 *                                             the record's gate stops it, or a public page says "close to native"
 *
 * The gate is applied first, with the count kernels' own decision read live (`node bench/count-kernels.cjs --gate`),
 * and nothing is written when it stops the record (exit 1, or 5 when the record holds passes and none is complete:
 * only a complete pass is ever published from). `BITMAP_API_TABLE_ROOT` points either mode at a copy of the tree. While
 * the record holds no pass the regions say the table is not measured yet.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const table = require('./lib/bitmap-api-table.cjs');
const verdict = require('./lib/bitmap-api-verdict.cjs');
const count = require('./lib/bitmap-api-count.cjs');
const { REGION_PAGES, otherPages } = require('./lib/bitmap-api-pages.cjs');

const ROOT = process.env.BITMAP_API_TABLE_ROOT || path.resolve(__dirname, '..');

const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/bitmap-api-results.json'), 'utf8'));
const passes = file.passes ?? [];
const check = process.argv.includes('--check');
let failed = false;

const gate = { countResult: passes.length > 0 ? count.readResult(ROOT) : undefined };
for (const problem of verdict.gateProblems(passes, gate)) {
  console.error(`bitmap-api-table: ${problem}`);
  failed = true;
}
if (!failed && verdict.gateExit(passes, gate) === verdict.EXIT.partial) {
  console.error(
    'bitmap-api-table: the record holds no complete pass (a pass from --only, a part of the run or a smoke pass is never published from)',
  );
  process.exit(verdict.EXIT.partial);
}
for (const page of REGION_PAGES) {
  const abs = path.join(ROOT, page);
  const text = fs.readFileSync(abs, 'utf8');
  if (check) {
    for (const problem of table.problemsOf(page, text, file)) {
      console.error(`bitmap-api-table: ${problem}`);
      failed = true;
    }
    continue;
  }
  if (failed) continue;
  const next = table.withRegion(page, text, file);
  if (next !== text) {
    fs.writeFileSync(abs, next);
    console.log(`bitmap-api-table: wrote ${page}`);
  }
}
if (check) {
  for (const page of otherPages(ROOT)) {
    for (const problem of table.phraseProblems(
      page,
      fs.readFileSync(path.join(ROOT, page), 'utf8'),
    )) {
      console.error(`bitmap-api-table: ${problem}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
if (check) console.log('bitmap-api-table --check: ok');
