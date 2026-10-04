'use strict';
/*
 * Writes `bench/expected-figures.json`: the figures the engine is EXPECTED to cost, which the site's figures gate
 * (`scripts/site-figures.cjs`) holds the pages to. They are derived from `bench/range-counts.json` (the requests the engine
 * makes, counted by running it) and `bench/results.json` with the BUILT estimator's prices, so they can only be computed
 * after a build; the committed file is what everything else reads, so the tests and the site gate need no build.
 *
 * Run: `pnpm build && node bench/expected-figures.cjs` to rewrite the file; `--check` (what
 * `pnpm bench:expected-figures:check` runs, after the build) fails if the committed file is not what the built estimator
 * gives. Nothing is measured on a cloud.
 */
const fs = require('node:fs');
const { computeExpectedFigures, FILE } = require('./lib/expected-figures.cjs');

const text = `${JSON.stringify(computeExpectedFigures(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const committed = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  if (committed !== text) {
    console.error(
      'expected-figures: bench/expected-figures.json is not what the built estimator gives from bench/range-counts.json and bench/results.json; run `pnpm bench:expected-figures`',
    );
    process.exit(1);
  }
  console.log('expected-figures: bench/expected-figures.json is what the built estimator gives');
} else {
  fs.writeFileSync(FILE, text);
  console.log(`expected-figures: wrote ${FILE}`);
}
