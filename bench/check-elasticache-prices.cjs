#!/usr/bin/env node
/*
 * Hold the estimator's on-demand catalogue, and bench/lib/elasticache-prices.cjs's reserved terms, to AWS's price
 * list. Download the version the catalogue cites and pass its path:
 *
 *   curl -o ec.json https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/20260914063714/us-east-1/index.json
 *   node bench/check-elasticache-prices.cjs ec.json
 *
 * Offline in CI by design: the list is 2 MB and a new version lands most months, so CI tests the reader and every
 * rule this holds (tests/bench/elasticache-prices.test.ts), and a person runs this when the cited version moves.
 */
'use strict';

const fs = require('node:fs');
const { ELASTICACHE_REDIS_US_EAST_1_ONDEMAND: CATALOGUE } = require('@cloudbitmaps/core');
const { citedVersion, disagreements } = require('./lib/elasticache-prices.cjs');

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node bench/check-elasticache-prices.cjs <offer.json>');
  process.exit(2);
}
const offer = JSON.parse(fs.readFileSync(file, 'utf8'));
// The list the catalogue cites, by the version its source names: a newer list is checked when the citation moves.
let cited;
try {
  cited = citedVersion(CATALOGUE.source);
} catch (err) {
  console.error(`check-elasticache-prices: ${err.message}`);
  process.exit(2);
}
const wrong = disagreements(offer, CATALOGUE.nodeTypes, undefined, cited);
if (wrong.length > 0) {
  console.error(`check-elasticache-prices: ${file} disagrees:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `check-elasticache-prices: all ${CATALOGUE.nodeTypes.length} node types agree with ${file}`,
);
