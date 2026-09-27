/*
 * Which generated SIZING regions live on which page, and which charts bench/sizing.cjs draws. One list, read by the
 * script that writes them and by scripts/site-figures.cjs, which leaves exactly these regions to
 * `pnpm bench:sizing:check` and refuses any other SIZING marker: a region nothing writes would be a figure no gate
 * reads.
 */
'use strict';

/** Each page bench/sizing.cjs writes, and the regions it holds: every region lives in exactly one page. */
const DOCS = {
  'docs/guide/sizing.md': [
    'SHAPE',
    'REFRESH',
    'INPUTS',
    'READERS',
    'BILL',
    'REDIS',
    'HEADROOM',
    'LEANINGS',
    'OVERLAP_INTRO',
    'OVERLAP',
    'OVERLAP_NOTE',
    'LEVERS',
    'PREFIX',
    'SAMPLE',
  ],
  'docs/guide/getting-started.md': ['GUIDE_EXAMPLE', 'COMPARES', 'GUIDE_LEANINGS', 'ONE_CLUSTER'],
  'docs/guide/why-cloudbitmaps.md': [
    'WHY_DEPLOYMENTS',
    'WHY_LEANINGS',
    'MONEY',
    'WHY_MOVES',
    'WHY_CHART_BILL',
    'GROWS',
    'WHY_CHART_WHERE',
    'WHY_LINE',
    'WHY_ROOM',
    'HOT',
    'DEPTH',
    'WHY_PREFIX',
    'WHY_OVERLAP',
  ],
  'README.md': ['WHY_SIZES', 'WHY_CAVEATS'],
};

/** Each chart bench/sizing.cjs draws, in each theme: compared byte for byte by `--check`, like the regions. */
const CHARTS = [
  'bench/bill-as-data-grows.svg',
  'bench/bill-as-data-grows-dark.svg',
  'bench/where-each-costs-less.svg',
  'bench/where-each-costs-less-dark.svg',
];

module.exports = { DOCS, CHARTS };
