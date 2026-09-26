#!/usr/bin/env node
/*
 * Hold the estimator's on-demand catalogue, and bench/lib/elasticache-prices.cjs's reserved terms, to AWS's price
 * list. Download the version the catalogue cites and pass its path:
 *
 *   curl -o ec.json https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/20260914063714/us-east-1/index.json
 *   node bench/check-elasticache-prices.cjs ec.json
 *
 * Offline in CI by design: the list is 2 MB and a new version lands most months, so CI tests the reader
 * (tests/bench/elasticache-prices.test.ts) and a person runs this when the cited version moves.
 */
'use strict';

const fs = require('node:fs');
const { ELASTICACHE_REDIS_US_EAST_1_ONDEMAND: CATALOGUE } = require('@cloudbitmaps/core');
const { RESERVED, nodePrices } = require('./lib/elasticache-prices.cjs');

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node bench/check-elasticache-prices.cjs <offer.json>');
  process.exit(2);
}
const offer = JSON.parse(fs.readFileSync(file, 'utf8'));
const wrong = [];
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
for (const { name, hourlyUSD } of CATALOGUE.nodeTypes) {
  const redis = nodePrices(offer, name, 'Redis');
  const valkey = nodePrices(offer, name, 'Valkey');
  const row = RESERVED[name];
  if (redis.hourlyUSD !== hourlyUSD) {
    wrong.push(
      `${name}: on demand ${redis.hourlyUSD} an hour, where the catalogue says ${hourlyUSD}`,
    );
  }
  if (row === undefined) {
    wrong.push(`${name}: no reserved row`);
    continue;
  }
  for (const term of ['oneYear', 'threeYearsUpfront']) {
    if (redis[term] !== row[term])
      wrong.push(`${name}: ${term} is ${redis[term]}, where RESERVED says ${row[term]}`);
    // RESERVED's header says Valkey's reserved price is Redis's less a fifth, exactly: held, not assumed.
    if (!near(valkey[term], 0.8 * redis[term])) {
      wrong.push(
        `${name}: Valkey's ${term} is ${valkey[term]}, not four fifths of Redis's ${redis[term]}`,
      );
    }
  }
  if (redis.threeYearsHourly !== 0) {
    wrong.push(`${name}: three years paid upfront also charges ${redis.threeYearsHourly} an hour`);
  }
}
for (const name of Object.keys(RESERVED)) {
  if (!CATALOGUE.nodeTypes.some((n) => n.name === name))
    wrong.push(`${name}: a reserved row for no catalogue node`);
}
if (wrong.length > 0) {
  console.error(`check-elasticache-prices: ${file} disagrees:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `check-elasticache-prices: all ${CATALOGUE.nodeTypes.length} node types agree with ${file}`,
);
