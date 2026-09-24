/*
 * What CloudBitmaps costs a small, a medium and a large deployment — three illustrative workloads, priced by the
 * SHIPPED estimator (`estimateCost`) at the default pricing, and written into `docs/guide/sizing.md`.
 *
 * The workloads are ours: made up to be typical, not measured from anyone's system, and the page says so. What is
 * not made up is the arithmetic. Every dollar figure on that page comes out of the same function a caller gets, so
 * the page cannot quote a bill the library would not, and `--check` fails CI when the page and the estimator
 * disagree — after a change to the model, the pricing or a profile, the tables must be regenerated, not edited.
 *
 * Nothing here is a latency. The loaded read path has not been timed inside a region, so the page publishes none.
 *
 * Run: `pnpm bench:sizing` (builds first) to rewrite the tables; `pnpm bench:sizing:check` to verify them.
 * `require()` loads @cloudbitmaps/roaring, which ships ESM only, through Node's `require(esm)`, as bench/run.cjs does.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { estimateCost, AWS_US_EAST_1_ONDEMAND } = require('@cloudbitmaps/roaring');

const ROOT = path.resolve(__dirname, '..');
const DOC = 'docs/guide/sizing.md';
const P = AWS_US_EAST_1_ONDEMAND;
const SECONDS_PER_MONTH = 730 * 3600; // the estimator's convention
const MB = 1_000_000;

/**
 * The three workloads. Each segment is sized like the calibration run's, about 500,000 ids spread over 2,000 chunks,
 * and each cold intersect shares 100 of them with its other operand, the run's shape — so `chunksPerIntersect` is
 * 200, the shared chunks read from each of two operands. Larger segments hold more ids, not more shared chunks.
 */
const PROFILES = [
  {
    id: 'small',
    name: 'Small',
    who: 'a product team keeping its user cohorts',
    segments: 200,
    segmentBytes: 1 * MB,
    intersectsPerMonth: 20_000,
    readsPerSec: 1,
    cacheHitRate: 0.5,
    loadsPerMonth: 6_000, // every segment reloaded once a day
    requestsPerLoad: 1, // a 1 MB object is one PUT
    readerProcesses: 1,
    hotPerProcess: 20,
  },
  {
    id: 'medium',
    name: 'Medium',
    who: 'an ad platform matching audiences',
    segments: 5_000,
    segmentBytes: 4 * MB,
    intersectsPerMonth: 2_628_000, // one a second, around the clock
    readsPerSec: 50,
    cacheHitRate: 0.8,
    loadsPerMonth: 150_000,
    requestsPerLoad: 1, // 4 MB fits one 8 MiB part
    readerProcesses: 3,
    hotPerProcess: 200,
  },
  {
    id: 'large',
    name: 'Large',
    who: 'a marketplace filtering its catalogue',
    segments: 200_000,
    segmentBytes: 10 * MB,
    intersectsPerMonth: 52_560_000, // twenty a second
    readsPerSec: 2_000,
    cacheHitRate: 0.95,
    loadsPerMonth: 6_000_000,
    requestsPerLoad: 4, // 10 MB is two 8 MiB parts: initiate, two parts, complete
    readerProcesses: 20,
    hotPerProcess: 1_000,
  },
];

/** One profile's workload, as the estimator takes it; `genTtlMs` is the store's `cache.genTtlMs`. */
function workloadOf(p, genTtlMs) {
  return {
    intersectsPerSec: p.intersectsPerMonth / SECONDS_PER_MONTH,
    chunksPerIntersect: 200,
    readsPerSec: p.readsPerSec,
    cacheHitRate: p.cacheHitRate,
    loadsPerMonth: p.loadsPerMonth,
    requestsPerLoad: p.requestsPerLoad,
    hotSegments: p.hotPerProcess,
    readerProcesses: p.readerProcesses,
    ...(genTtlMs === undefined ? {} : { genTtlMs }),
  };
}

function price(p, genTtlMs) {
  return estimateCost({
    segments: [{ sizeBytes: p.segmentBytes, count: p.segments }],
    workload: workloadOf(p, genTtlMs),
  });
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────
const int = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) =>
  n >= 100
    ? `$${Math.round(n).toLocaleString('en-US')}`
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bytes = (n) =>
  n >= 1e12 ? `${int(n / 1e12)} TB` : n >= 1e9 ? `${int(n / 1e9)} GB` : `${int(n / 1e6)} MB`;
const pct = (x) => `${Math.round(x * 100)}%`;
const against = (r) =>
  r.verdict === 'win-big'
    ? 'under a tenth of it'
    : r.verdict === 'win'
      ? 'under it'
      : `${(r.monthlyUSD.total / P.redis.monthlyUSD).toFixed(1)}× it`;

function render() {
  const inputs = [
    '| | who | segments | stored | cold intersects a month | point reads a second | loads a month | hot segments |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...PROFILES.map(
      (p) =>
        `| **${p.name}** | ${p.who} | ${int(p.segments)} of ${bytes(p.segmentBytes)} | ` +
        `${bytes(p.segments * p.segmentBytes)} | ${int(p.intersectsPerMonth)} | ` +
        `${int(p.readsPerSec)}, ${pct(p.cacheHitRate)} from cache | ${int(p.loadsPerMonth)} | ` +
        `${int(p.hotPerProcess)} in each of ${int(p.readerProcesses)} reader process${p.readerProcesses === 1 ? '' : 'es'} |`,
    ),
  ];

  const bill = [
    '| | cold intersects | point reads | pointer refresh | loads | storage | **a month** | against the $346 node |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...PROFILES.map((p) => {
      const r = price(p);
      const o = r.monthlyUSD.byOp;
      return (
        `| **${p.name}** | ${usd(o.intersects)} | ${usd(o.reads)} | ${usd(o.pointerRefresh)} | ` +
        `${usd(o.loads)} | ${usd(o.storage)} | **${usd(r.monthlyUSD.total)}** | ${against(r)} |`
      );
    }),
  ];

  const large = PROFILES.find((p) => p.id === 'large');
  const ttls = [
    [undefined, '2 s, the default'],
    [60_000, '1 minute'],
    [300_000, '5 minutes'],
  ];
  const levers = [
    '| `cache.genTtlMs` | pointer refresh | **a month** |',
    '|---|---:|---:|',
    ...ttls.map(([ttl, label]) => {
      const r = price(large, ttl);
      return `| ${label} | ${usd(r.monthlyUSD.byOp.pointerRefresh)} | **${usd(r.monthlyUSD.total)}** |`;
    }),
  ];

  return {
    INPUTS: inputs.join('\n'),
    BILL: bill.join('\n'),
    LEVERS: levers.join('\n'),
  };
}

// ── write / check ────────────────────────────────────────────────────────────────────────────────────
function regionsOf(text) {
  const out = {};
  for (const name of ['INPUTS', 'BILL', 'LEVERS']) {
    const start = `<!-- SIZING:${name}:START -->`;
    const end = `<!-- SIZING:${name}:END -->`;
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    if (i === -1 || j === -1 || j < i || text.indexOf(start, i + 1) !== -1) {
      throw new Error(`${DOC} must hold exactly one SIZING:${name} region`);
    }
    // A region inside a list item is indented with it; the table must be too, or it ends the list.
    const indent = text.slice(text.lastIndexOf('\n', i) + 1, i);
    out[name] = { i: i + start.length, j, indent };
  }
  return out;
}

function withRegions(text, rendered) {
  // Replace from the last region back, so earlier offsets stay valid.
  const at = regionsOf(text);
  let s = text;
  for (const name of Object.keys(at).sort((a, b) => at[b].i - at[a].i)) {
    const { i, j, indent } = at[name];
    const body = rendered[name]
      .split('\n')
      .map((line) => indent + line)
      .join('\n');
    s = s.slice(0, i) + '\n' + body + '\n' + indent + s.slice(j);
  }
  return s;
}

const file = path.join(ROOT, DOC);
const text = fs.readFileSync(file, 'utf8');
const next = withRegions(text, render());
if (process.argv.includes('--check')) {
  if (next !== text) {
    console.error(
      `bench:sizing:check: the tables in ${DOC} are not what the shipped estimator prices. ` +
        'Run `pnpm bench:sizing` rather than editing them by hand.',
    );
    process.exit(1);
  }
  console.log(`bench:sizing:check: every table in ${DOC} is what the shipped estimator prices.`);
} else {
  fs.writeFileSync(file, next);
  console.log(`  wrote ${DOC}`);
}
