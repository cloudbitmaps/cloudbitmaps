'use strict';
/*
 * The figures the engine is EXPECTED to cost, derived from the counts in `bench/range-counts.json`
 * (the requests the engine makes, taken by running it over the in-memory backend) and the shipped estimator's prices.
 *
 * Nothing here is measured on a cloud: the request counts are the code's, and a dollar is a count times the default
 * pricing profile's list price. The pages that quote these figures label them expected, and `scripts/site-figures.cjs`
 * holds each page to the strings this module gives, so a figure cannot be retyped on a page without a count behind it.
 * A calibration run on a real object store is what would measure them (`bench/calibrate-aws.cjs` expects the same counts).
 */
const fs = require('node:fs');
const path = require('node:path');

const COUNTS = path.join(__dirname, '..', 'range-counts.json');
const RESULTS = path.join(__dirname, '..', 'results.json');
const FILE = path.join(__dirname, '..', 'expected-figures.json');
const SECONDS_PER_MONTH = 730 * 3600;
/** A dollar amount as a page writes it: cents to two places, or, below a cent, to its last significant digit. */
const usd = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toFixed(10)).toString()}`);
const MB = 1_000_000;
/** Decimal units: kilobytes below a megabyte, else megabytes. */
const mb = (n) => (n < MB ? `${Math.round(n / 1000)} KB` : `${Number((n / MB).toFixed(1))} MB`);

/** The GETs a cold intersect makes when it makes `chunkRequests` range requests of its two operands in all. */
function intersectGets(chunkRequests) {
  const { estimateCost, AWS_US_EAST_1_ONDEMAND } = require('@cloudbitmaps/core');
  const GET_USD = AWS_US_EAST_1_ONDEMAND.storage.getPerMillion / 1e6;
  const r = estimateCost({
    segments: [],
    workload: { intersectsPerSec: 1, chunksPerIntersect: chunkRequests, operandsPerIntersect: 2 },
    pricing: AWS_US_EAST_1_ONDEMAND,
  });
  const gets = r.monthlyUSD.byOp.intersects / (SECONDS_PER_MONTH * GET_USD);
  if (Math.abs(gets - Math.round(gets)) > 1e-6) throw new Error(`${gets} GETs is not a count`);
  return Math.round(gets);
}

/**
 * The figures, each as the string a page states and the number behind it, computed from the counts and the BUILT
 * estimator. `bench/expected-figures.cjs` writes them to `bench/expected-figures.json`; everything else reads that file.
 */
function computeExpectedFigures() {
  const { AWS_US_EAST_1_ONDEMAND } = require('@cloudbitmaps/core');
  const GET_USD = AWS_US_EAST_1_ONDEMAND.storage.getPerMillion / 1e6;
  const counts = JSON.parse(fs.readFileSync(COUNTS, 'utf8'));
  const small = counts.profiles.small.coldIntersect;
  const at = (shared, layout) => small.find((c) => c.shared === shared && c.layout === layout);
  const packed = at(100, 'packed');
  const spread = at(100, 'spread');
  const cold = intersectGets(2 * packed.rangesPerOperand);
  const coldSpread = intersectGets(2 * spread.rangesPerOperand);
  const a = counts.andNot;
  const andNot = a.getRange + a.getTail + a.pointer;
  const it = counts.iterate;
  const iterate = it.getRange + it.getTail + it.pointer;
  const per = (gets) => ({
    gets,
    getsText: `${gets} GETs`,
    each: usd(gets * GET_USD),
    perMillion: usd(gets * GET_USD * 1e6),
  });
  return {
    coldIntersect: per(cold),
    coldIntersectSpread: {
      ...per(coldSpread),
      bytesPerOperand: mb(spread.rangeBytesPerOperand),
      neededBytesPerOperand: mb(100 * counts.profiles.small.chunkBytes),
    },
    andNot: per(andNot),
    iterate: per(iterate),
    // How many of these cold intersects a second the standing Redis-HA line buys: its crossover in GETs a second over the
    // GETs one makes (`bench/results.json`, from the shipped estimator).
    redisLineIntersectsPerSec: (
      JSON.parse(fs.readFileSync(RESULTS, 'utf8')).readCrossoverPerSec / cold
    ).toFixed(1),
  };
}

/** The committed figures (`bench/expected-figures.json`): readable with no build, which the tests and the site gate need. */
function expectedFigures() {
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

module.exports = { expectedFigures, computeExpectedFigures, intersectGets, usd, FILE };
