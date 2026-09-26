/*
 * What CloudBitmaps costs a small, a medium and a large deployment — three illustrative workloads, priced by the
 * SHIPPED estimator (`estimateCost`) at the default pricing, against the Redis that would hold each one's data, and
 * written into the pages listed in `DOCS`.
 *
 * The workloads are ours: made up to be typical, not measured from anyone's system, and the page says so. What is
 * not made up is the arithmetic. Every figure on that page that depends on the model, the prices, the library's
 * defaults or a profile is written by this script into a generated region, and `--check` fails CI when a region
 * and this script disagree — so after a change to any of those, the page is regenerated, not edited. The library's
 * defaults are read out of its source rather than restated, as `bench/lib/calibration-figures.cjs` does.
 *
 * Nothing here is a latency. The loaded read path has not been timed inside a region, so the page publishes none.
 *
 * Run: `pnpm bench:sizing` (builds first) to rewrite the regions; `pnpm bench:sizing:check` to verify them.
 * `require()` loads @cloudbitmaps/core, which ships ESM only, through Node's `require(esm)`, as bench/run.cjs does:
 * core, not the flavor, since this is arithmetic and the flavor would load the native addon for nothing.
 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
  ONE_REDIS_HA_CLUSTER,
} = require('@cloudbitmaps/core');

const ROOT = path.resolve(__dirname, '..');
const { DOCS, CHARTS } = require('./lib/sizing-pages.cjs');
const P = AWS_US_EAST_1_ONDEMAND;
const CATALOGUE = ELASTICACHE_REDIS_US_EAST_1_ONDEMAND;
/** The same Redis without its data-tiering nodes: every byte held in memory. */
const IN_MEMORY = {
  ...P,
  redis: {
    sizedToData: {
      ...CATALOGUE,
      nodeTypes: CATALOGUE.nodeTypes.filter((n) => n.ssdGiB === undefined),
    },
  },
};
const MB = 1_000_000;
const MIB = 1024 * 1024;
/** Small counts as words, as the guide writes them. */
const words = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);

/** Every match of a global regex in a library source file, which must be exactly one. */
function sourceMatch(rel, re, what) {
  const all = [...fs.readFileSync(path.join(ROOT, rel), 'utf8').matchAll(re)];
  if (all.length !== 1) {
    throw new Error(`sizing: expected one ${what} in ${rel}, found ${all.length} — did it move?`);
  }
  return all[0];
}

/**
 * A library default, read from its source so a change to it changes this page. Anchored to a declaration at the start
 * of a line and required to be the only one, so a comment that quotes an old value is never read in its place.
 */
function sourceConstant(rel, name) {
  const re = new RegExp(`^\\s*(?:export\\s+)?const ${name}\\s*=\\s*([\\d_ *]+);`, 'gm');
  return sourceMatch(rel, re, name)[1]
    .replace(/_/g, '')
    .split('*')
    .reduce((a, b) => a * Number(b.trim()), 1);
}
const GEN_TTL_MS = sourceConstant(
  'packages/core/src/core/reader-defaults.ts',
  'DEFAULT_CURRENT_GEN_TTL_MS',
);
const READER_MAX = sourceConstant(
  'packages/core/src/core/reader-defaults.ts',
  'DEFAULT_MAX_OPEN_SEGMENTS',
);
const READER_MAX_BYTES = sourceConstant(
  'packages/core/src/core/reader-defaults.ts',
  'DEFAULT_MAX_OPEN_INDEX_BYTES',
);
const INDEX_BYTES_PER_CHUNK = sourceConstant(
  'packages/core/src/core/crbm/reader.ts',
  'RETAINED_BYTES_PER_INDEX_ENTRY',
);
const CACHE_MAX_CHUNKS = sourceConstant(
  'packages/roaring/src/index.ts',
  'DEFAULT_CACHE_MAX_CHUNKS',
);
const S3_PART_BYTES = sourceConstant('packages/s3/src/storage.ts', 'S3_PART_BYTES');
const INTERSECT_CONCURRENCY = sourceConstant(
  'packages/core/src/core/engine.ts',
  'DEFAULT_INTERSECT_CONCURRENCY',
);
const { esc, logChart } = require('./lib/log-chart.cjs');
const {
  CODE_SPAN,
  FENCE_OPEN,
  closesFence,
  markersOf,
  regionsOf,
  withRegions,
} = require('./lib/sizing-markers.cjs');
const { plain } = require('./lib/calibration-figures.cjs');
/** The estimator's month, read from it: AWS's 730 hours, of 3,600 seconds. */
const COST_TS = 'packages/core/src/core/cost.ts';
const HOURS_PER_MONTH = sourceConstant(COST_TS, 'HOURS_PER_MONTH');
const SECONDS_PER_MONTH =
  HOURS_PER_MONTH *
  Number(
    sourceMatch(
      COST_TS,
      /^const SECONDS_PER_MONTH = HOURS_PER_MONTH \* (\d+);/gm,
      'SECONDS_PER_MONTH',
    )[1],
  );
/** Operands a cold intersect reads when the workload does not say: the estimator's own default. */
const OPERANDS = Number(
  sourceMatch(
    COST_TS,
    /input\.workload\.operandsPerIntersect \?\? (\d+)/g,
    'operandsPerIntersect default',
  )[1],
);
/**
 * The one cluster the benchmarks page charts, as its own declaration's trailing comment describes it — the comment
 * scripts/site-figures.cjs holds the site to — so the words here cannot drift from the ones there.
 */
const ONE_CLUSTER_SHAPE = (() => {
  const [, , topology] = sourceMatch(
    COST_TS,
    /export const ONE_REDIS_HA_CLUSTER\b[^=]*=\s*(?:deepFreeze\()?\{\s*monthlyUSD:\s*(\d+)\s*\}\)?;\s*\/\/\s*ElastiCache HA:\s*([^;]+);/g,
    'ONE_REDIS_HA_CLUSTER',
  );
  const m = /^1 primary \+ (\d+) replicas \((cache\.[\w.]+)\)$/.exec(topology.trim());
  if (m === null)
    throw new Error(
      `sizing: ONE_REDIS_HA_CLUSTER's comment no longer reads as a topology: ${topology}`,
    );
  return { replicas: Number(m[1]), nodes: 1 + Number(m[1]), nodeType: m[2] };
})();

/** PUT-class requests one object write makes on S3: one PUT, or initiate + the parts + complete. */
function writeRequests(objectBytes) {
  const parts = Math.ceil(objectBytes / S3_PART_BYTES);
  return parts <= 1 ? 1 : parts + 2;
}

/** AWS's documented request rate per partitioned prefix, for GETs: at least this many a second. Not ours to check. */
const S3_PREFIX_GETS_PER_SEC = 5500;
/**
 * ElastiCache's default quota of nodes in one cluster, which AWS raises on request to at most 500 on Redis OSS 5.0.6
 * to 7.1 or Valkey 7.2 and later: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Shards.html. Not ours to
 * check.
 */
const DEFAULT_NODES_PER_CLUSTER = 90;
/** The most nodes AWS raises one cluster to, on Redis OSS 5.0.6 to 7.1 or Valkey 7.2 and later (the same page). */
const MAX_NODES_PER_CLUSTER = 500;
/**
 * ElastiCache's default quota of nodes in one Region, across every cluster in it, also raised on request:
 * https://docs.aws.amazon.com/general/latest/gr/elasticache-service.html#limits_elasticache. Not ours to check.
 */
const DEFAULT_NODES_PER_REGION = 300;
const SHARDS_URL = 'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Shards.html';
const QUOTAS_URL =
  'https://docs.aws.amazon.com/general/latest/gr/elasticache-service.html#limits_elasticache';

/**
 * The shape every segment has: the calibration run's, about 2,000 chunks, and each cold intersect sharing 100 of them
 * with its other operand, so `chunksPerIntersect` is 200. A larger segment is modelled as holding its ids more densely,
 * not as sharing more chunks — the most favourable choice for large segments, which the overlap table below undoes.
 * Only up to a point: a chunk holds at most 65,536 ids and takes at most MAX_CHUNK_BYTES whatever ids it holds, since a
 * write keeps each chunk in its smallest form. That ceiling is a bitmap of 65,536 bits, 8,192 bytes, and the 16-byte
 * header of its portable encoding: every other id of a chunk, which no run shortens, measures 8,208 bytes. A full chunk
 * is one run and measures 15. So a deployment whose segments are larger than CHUNKS_PER_SEGMENT chunks at that
 * ceiling is refused rather than priced on a shape it cannot have.
 */
const CHUNKS_PER_SEGMENT = 2000;
const MAX_CHUNK_BYTES = 65536 / 8 + 16;
const SHARED_CHUNKS = 100;

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
    readerProcesses: 20,
    hotPerProcess: 1_000,
  },
];
const byId = (id) => PROFILES.find((p) => p.id === id);

/** One profile's workload, as the estimator takes it; `genTtlMs` is the store's `cache.genTtlMs`. */
function workloadOf(p, { genTtlMs, shared = SHARED_CHUNKS } = {}) {
  return {
    intersectsPerSec: p.intersectsPerMonth / SECONDS_PER_MONTH,
    chunksPerIntersect: 2 * shared,
    readsPerSec: p.readsPerSec,
    cacheHitRate: p.cacheHitRate,
    loadsPerMonth: p.loadsPerMonth,
    requestsPerLoad: writeRequests(p.segmentBytes),
    hotSegments: p.hotPerProcess,
    readerProcesses: p.readerProcesses,
    ...(genTtlMs === undefined ? {} : { genTtlMs }),
  };
}

function price(p, options = {}) {
  return estimateCost({
    segments: [{ sizeBytes: p.segmentBytes, count: p.segments }],
    workload: workloadOf(p, options),
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
  });
}

/** The Redis each profile is priced against: the cheapest cluster that holds its data, whatever its workload. */
const redisOf = (p, pricing) => price(p, { pricing }).redisBaseline;

/**
 * The GETs one cold intersect makes when its operands share `k` chunks: the estimator's own count, read back out of
 * the bill it gives one intersect a second, rather than restated here.
 */
function intersectGets(k) {
  const r = estimateCost({
    segments: [],
    workload: { intersectsPerSec: 1, chunksPerIntersect: 2 * k },
    pricing: P,
  });
  const gets = r.monthlyUSD.byOp.intersects / ((SECONDS_PER_MONTH * P.storage.getPerMillion) / 1e6);
  // A whole number of GETs, or this division is not the one the estimator made.
  if (Math.abs(gets - Math.round(gets)) > 1e-6)
    throw new Error(`sizing: ${gets} GETs is not a count`);
  return Math.round(gets);
}

/** What the estimator itself says it compared with — the stored size and the cluster — from its own rationale. */
function estimatorWords(report) {
  const m = /Redis that would hold (.+?) \((.+?)\); dominated by/.exec(report.rationale);
  if (m === null)
    throw new Error(`sizing: the rationale no longer names its Redis: ${report.rationale}`);
  return { holds: m[1], cluster: m[2] };
}

/** The cold-intersect rate at which a profile's bill meets its Redis, every other term held where it is. */
function breakEvenRate(p) {
  const idle = price({ ...p, intersectsPerMonth: 0 }).monthlyUSD.total;
  const perRate = price({ ...p, intersectsPerMonth: SECONDS_PER_MONTH }).monthlyUSD.total - idle;
  return (redisOf(p).monthlyUSD - idle) / perRate;
}

/** How often one reader reads one of its hot segments, in seconds, with the point reads spread evenly. */
const readEverySec = (p) => (p.hotPerProcess * p.readerProcesses) / p.readsPerSec;

/** The smallest number of shared chunks at which a profile's bill passes its Redis. */
function breakEvenShared(p) {
  const redis = redisOf(p).monthlyUSD;
  for (let k = 1; k <= CHUNKS_PER_SEGMENT; k++) {
    if (price(p, { shared: k }).monthlyUSD.total > redis) return k;
  }
  // Rendered as a number, a missing break-even would publish as "0 shared chunks".
  throw new Error(
    `sizing: the ${p.id} deployment's bill never passes its Redis at any overlap — rewrite OVERLAP_NOTE`,
  );
}

/** The library's attempts at a request, from its default retry policy. */
const LIBRARY_ATTEMPTS = Number(
  sourceMatch(
    'packages/core/src/core/retry.ts',
    /^export const DEFAULT_RETRY_POLICY: RetryPolicy = \{\s*maxAttempts: (\d+),/gm,
    'DEFAULT_RETRY_POLICY.maxAttempts',
  )[1],
);
/**
 * The AWS SDK's default attempts in its standard retry mode, which the S3 driver's client keeps:
 * https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html. Not ours to check.
 */
const SDK_ATTEMPTS = 3;
const SDK_RETRY_URL = 'https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html';
/** How many segments the library has been validated at, as the roadmap's envelope states it. */
const VALIDATED_SEGMENTS =
  Number(
    sourceMatch(
      'docs/ROADMAP.md',
      /\*\*Scale\*\* \| up to ~(\d+)K segments/g,
      "the roadmap's envelope",
    )[1],
  ) * 1000;
/** How many superseded generations `load()` keeps by default: read from the code rather than restated. */
const LOAD_KEEPS = Number(
  sourceMatch(
    'packages/core/src/core/load.ts',
    /options\.keep \?\? (\d+)/g,
    "load()'s default keep",
  )[1],
);
const ELASTICACHE_PRICING_URL = 'https://aws.amazon.com/elasticache/pricing/';
// What each catalogue node type costs reserved, read from AWS's price list on its full key and held to it by
// bench/check-elasticache-prices.cjs. A type missing there is refused when priced, never priced on demand unsaid.
const { RESERVED, VALKEY_DISCOUNT } = require('./lib/elasticache-prices.cjs');
/** A term's cost an hour: the hourly charge, or the upfront one spread over the term's 3 × 8,760 hours. */
const RESERVED_TERMS = {
  oneYear: (r) => r.oneYear,
  threeYearsUpfront: (r) => r.threeYearsUpfront / (3 * 8760),
};
function reservedHourly(nodeType, term) {
  const r = RESERVED[nodeType];
  if (r === undefined) {
    throw new Error(
      `sizing: no reserved price for ${nodeType}; add it to RESERVED from the price list`,
    );
  }
  return RESERVED_TERMS[term](r);
}
/**
 * The default pricing, with its Redis bought another way: as ElastiCache for Valkey, with fewer replicas, or on
 * a reserved term (`'oneYear'` or `'threeYearsUpfront'`).
 */
function redisPricedAs({ valkey = false, replicas = CATALOGUE.replicasPerShard, reserved } = {}) {
  const hourly = (n) =>
    (reserved === undefined ? n.hourlyUSD : reservedHourly(n.name, reserved)) *
    (valkey ? 1 - VALKEY_DISCOUNT : 1);
  return {
    ...P,
    redis: {
      sizedToData: {
        ...CATALOGUE,
        replicasPerShard: replicas,
        nodeTypes: CATALOGUE.nodeTypes.map((n) => ({ ...n, hourlyUSD: hourly(n) })),
      },
    },
  };
}

/** Redis bought every cheaper way the pages price: as Valkey, with one replica a shard, on `term`. */
const cheapestRedis = (term) => redisPricedAs({ valkey: true, replicas: 1, reserved: term });
/**
 * The deployments whose Redis, bought every cheaper way on three years paid upfront, costs less than they do: the
 * ones where the verdict reverses. Computed once, so every page that says where it reverses says the same thing.
 */
const REVERSED = PROFILES.filter(
  (p) => price(p).monthlyUSD.total > redisOf(p, cheapestRedis('threeYearsUpfront')).monthlyUSD,
).map((p) => p.id);
/** "medium", "medium and large", "small, medium and large". */
const andList = (items) =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** A pure cold-intersect workload of the calibration run's shape, at one size of data. */
function coldAt(sizeBytes, perSec) {
  return estimateCost({
    segments: [{ sizeBytes }],
    workload: { intersectsPerSec: perSec, chunksPerIntersect: 2 * SHARED_CHUNKS },
  });
}
/** The cold intersects a second at which that workload's bill meets the Redis that holds `sizeBytes`. */
function meetsAt(sizeBytes) {
  const r = coldAt(sizeBytes, 1);
  return (r.redisBaseline.monthlyUSD - r.monthlyUSD.byOp.storage) / r.monthlyUSD.byOp.intersects;
}
/** The explainer's losing example: a dashboard running cold intersects hard over a small set. */
const HOT = { sizeBytes: 5e9, perSec: 100 };
/** The guide's planning example: its inputs are the guide's, and every figure in its comments is the estimator's. */
const GUIDE_EXAMPLE_INPUT = {
  segments: [{ sizeBytes: 6e8, count: 2 }],
  workload: {
    readsPerSec: 200,
    cacheHitRate: 0.8,
    intersectsPerSec: 1,
    chunksPerIntersect: 20,
    loadsPerMonth: 30,
    hotSegments: 2,
  },
};
/** A deployment's data, all its segments together. */
const sizeOf = (p) => p.segments * p.segmentBytes;
/** One cold intersect's GETs on its segments' data prefix: every chunk and tail read, not the pointers beside it. */
const DATA_GETS_PER_INTERSECT =
  intersectGets(SHARED_CHUNKS) - OPERANDS * (P.storage.requestsPerSizedRead ?? 1);
/** A deployment's GETs a second on its one data prefix, the point reads that miss the cache included. */
const dataGetsOf = (p) =>
  (p.intersectsPerMonth / SECONDS_PER_MONTH) * DATA_GETS_PER_INTERSECT +
  p.readsPerSec * (1 - p.cacheHitRate);

// What the pages say of every deployment and of the example, checked rather than assumed: a page that said a
// deployment had room, or sat below the line, after the model had moved it past, would still render, and pass.
for (const p of PROFILES) {
  const now = p.intersectsPerMonth / SECONDS_PER_MONTH;
  if (p.segmentBytes > CHUNKS_PER_SEGMENT * MAX_CHUNK_BYTES) {
    throw new Error(
      // Formatted by hand: the premises run before the page's formatters are defined.
      `sizing: the ${p.id} deployment's segments are larger than ` +
        `${CHUNKS_PER_SEGMENT.toLocaleString('en-US')} chunks can take`,
    );
  }
  if (!(breakEvenRate(p) > now)) {
    throw new Error(
      `sizing: the ${p.id} deployment's bill already meets its Redis, where the pages say it has room`,
    );
  }
  if (!(now < meetsAt(sizeOf(p)))) {
    throw new Error(`sizing: the ${p.id} deployment is no longer below the line the chart draws`);
  }
}
// A bill at least twice its Redis is past the line where the two meet, so the multiple is the one thing to check.
if (
  !(
    coldAt(HOT.sizeBytes, HOT.perSec).monthlyUSD.total >=
    2 * coldAt(HOT.sizeBytes, HOT.perSec).redisBaseline.monthlyUSD
  )
) {
  throw new Error(
    'sizing: the hot dashboard no longer loses to Redis by a multiple, as the pages say',
  );
}

/** The charts' span of data, and what they draw across it: computed once, for the charts and for their words. */
const CHART_X = { min: 1e8, max: 2e13 };
let chartDataMemo;
function chartData() {
  if (chartDataMemo !== undefined) return chartDataMemo;
  const SAMPLES = 1200;
  const xs = Array.from(
    { length: SAMPLES + 1 },
    (_, i) => CHART_X.min * (CHART_X.max / CHART_X.min) ** (i / SAMPLES),
  );
  const reports = xs.map((b) => coldAt(b, 1));
  const redisLine = xs.map((b, i) => [b, reports[i].redisBaseline.monthlyUSD]);
  const cbLine = xs.map((b, i) => [b, reports[i].monthlyUSD.total]);
  const crossAt = xs.findIndex((_, i) => redisLine[i][1] >= cbLine[i][1]);
  // The words say the bills cross once, inside the chart: not at its edge, and never back.
  if (crossAt <= 0) throw new Error('sizing: the bills no longer cross inside the chart');
  if (redisLine.slice(crossAt).some(([, v], j) => v < cbLine[crossAt + j][1])) {
    throw new Error(
      'sizing: the bills cross more than once, where the charts say they cross near one size',
    );
  }
  const meets = xs.map((b, i) => [
    b,
    (reports[i].redisBaseline.monthlyUSD - reports[i].monthlyUSD.byOp.storage) /
      reports[i].monthlyUSD.byOp.intersects,
  ]);
  /** The cold intersects a second that fill one data prefix's documented GET rate. */
  const prefixRate = S3_PREFIX_GETS_PER_SEC / DATA_GETS_PER_INTERSECT;
  chartDataMemo = { xs, redisLine, cbLine, cross: xs[crossAt], crossAt, meets, prefixRate };
  return chartDataMemo;
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────
const int = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) =>
  n < 0.005
    ? 'under $0.01'
    : n >= 100
      ? `$${Math.round(n).toLocaleString('en-US')}`
      : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Decimal units, with one decimal place below ten where it is not a whole number: 2.5 GB, not 2 GB. */
const bytes = (n) => {
  const [unit, per] = n >= 1e12 ? ['TB', 1e12] : n >= 1e9 ? ['GB', 1e9] : ['MB', 1e6];
  const v = n / per;
  const shown = v < 10 && Math.abs(v - Math.round(v)) >= 0.05 ? v.toFixed(1) : int(v);
  return `${shown} ${unit}`;
};
const mib = (n) => `${int(n / MIB)} MiB`;
const kib = (n) => `${Math.round(n / 1024)} KiB`;
const pct = (x) => `${Math.round(x * 100)}%`;
/** Dollars and cents, rounded as `usd` rounds them. */
const usd2 = (n) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A share to two significant figures, for the small ones a whole percent would round to nothing. */
const share = (x) => (x >= 1 ? '100%' : `${Number((x * 100).toPrecision(2))}%`);
/** How a bill compares with the Redis that holds the same data. */
// Two decimals just past parity, where one would print 1.03 as "1.0× as much" and hide that it costs more.
const versus = (total, redis) =>
  total < redis
    ? `${Math.round((1 - total / redis) * 100)}% less`
    : `${(total / redis).toFixed(total / redis < 1.1 ? 2 : 1)}× as much`;
/** "3 × r6g.xlarge", or "285 × r6g.xlarge, 95 shards". */
function clusterLabel(b) {
  const { nodeType, shards, nodes } = b.cluster;
  const node = nodeType.replace(/^cache\./, '');
  return shards === 1 ? `${nodes} × ${node}` : `${nodes} × ${node}, ${shards} shards`;
}
/** A rate a second, to two significant figures below one, and one decimal below ten. */
const rate = (n) => (n < 1 ? n.toPrecision(2) : n < 10 ? n.toFixed(1) : int(n));
/** A multiple to two significant figures: 21×, 3.9×. */
const times = (n) => `${Number(n.toPrecision(2))}×`;
/** A rate to three figures, for a table whose reader divides one column by another. An exact rate stays as it is. */
const rate3 = (n) => (n < 100 ? String(Number(n.toPrecision(3))) : int(n));
/** A headroom row's rates and multiple, refused unless the rates as shown divide to the multiple shown. */
function headroomRow(now, even) {
  const shown = [rate3(now), rate3(even), times(even / now)];
  if (times(Number(shown[1]) / Number(shown[0])) !== shown[2]) {
    throw new Error(
      `sizing: ${shown[1]} ÷ ${shown[0]} does not show as ${shown[2]}, the headroom it is printed beside`,
    );
  }
  return shown;
}
/** The words each chart's image is described by, in the page and in its own aria-label. */
function chartWords() {
  const d = chartData();
  const [first, last] = [(l) => l[0][1], (l) => l[l.length - 1][1]];
  return {
    bill:
      'The monthly bill as the data grows, on log scales: the Redis that holds the data climbs in steps from ' +
      `${usd(first(d.redisLine))} a month at ${bytes(CHART_X.min)} to ${usd(last(d.redisLine))} at ${bytes(CHART_X.max)}, ` +
      `while CloudBitmaps at one cold intersect a second goes from ${usd(first(d.cbLine))} to ${usd(last(d.cbLine))}. ` +
      `They cross near ${bytes(d.cross)}.`,
    where:
      'Where each costs less, on log scales: the line where the bills meet rises from ' +
      `${rate(first(d.meets))} cold intersects a second at ${bytes(CHART_X.min)} to ${rate(last(d.meets))} at ` +
      `${bytes(CHART_X.max)}. Below it CloudBitmaps costs less, and above it Redis does. The three illustrative ` +
      'deployments sit below it; the example, a dashboard running ' +
      `${int(HOT.perSec)} cold intersects a second over ${bytes(HOT.sizeBytes)}, sits above it. A dashed rule marks ` +
      `the cold intersects that fill one data prefix's documented GET rate: ${rate(d.prefixRate)} a second.`,
  };
}
const secs = (s) => (s % 60 === 0 && s >= 60 ? `${s / 60} min` : `${int(s)} s`);
const ttlLabel = (ms) =>
  ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;

function render() {
  const inputs = [
    '| | who | segments | stored | cold intersects a month | point reads a second | loads a month | hot segments | each read every |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...PROFILES.map(
      (p) =>
        `| **${p.name}** | ${p.who} | ${int(p.segments)} of ${bytes(p.segmentBytes)} | ` +
        `${bytes(p.segments * p.segmentBytes)} | ${int(p.intersectsPerMonth)} | ` +
        `${int(p.readsPerSec)}, ${pct(p.cacheHitRate)} from cache | ${int(p.loadsPerMonth)} | ` +
        `${int(p.hotPerProcess)} in each of ${int(p.readerProcesses)} reader process${p.readerProcesses === 1 ? '' : 'es'} | ` +
        `${secs(readEverySec(p))} |`,
    ),
  ];

  const readers = [
    `| | index a reader holds open, at ${int(INDEX_BYTES_PER_CHUNK)} B a chunk | against the default \`cache.readerMaxBytes\` (${mib(READER_MAX_BYTES)}) | chunks in its hot set | what they hold | against the default \`cache.maxChunks\` (${int(CACHE_MAX_CHUNKS)}) | reads it answers, spread evenly |`,
    '|---|---:|---|---:|---:|---|---:|',
    ...PROFILES.map((p) => {
      const index = p.hotPerProcess * CHUNKS_PER_SEGMENT * INDEX_BYTES_PER_CHUNK;
      const fits =
        p.hotPerProcess > READER_MAX
          ? `more segments than the default ${int(READER_MAX)}`
          : index <= READER_MAX_BYTES * 0.9
            ? 'fits'
            : index <= READER_MAX_BYTES
              ? 'at the limit: raise it'
              : `${(index / READER_MAX_BYTES).toFixed(1)}× it: raise it, or ${int(Math.floor(READER_MAX_BYTES / (CHUNKS_PER_SEGMENT * INDEX_BYTES_PER_CHUNK)))} stay open`;
      const chunks = p.hotPerProcess * CHUNKS_PER_SEGMENT;
      return (
        `| **${p.name}** | ${mib(index)} | ${fits} | ${int(chunks)} | ` +
        `${bytes(p.hotPerProcess * p.segmentBytes)} | ${int(Math.round(chunks / CACHE_MAX_CHUNKS))}× it | ` +
        `${share(CACHE_MAX_CHUNKS / chunks)} |`
      );
    }),
  ];

  const bill = [
    '| | cold intersects | point reads | pointer refresh | loads | storage | **a month** | the Redis that holds it | **against it** |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...PROFILES.map((p) => {
      const r = price(p);
      const o = r.monthlyUSD.byOp;
      const b = r.redisBaseline;
      return (
        `| **${p.name}** | ${usd(o.intersects)} | ${usd(o.reads)} | ${usd(o.pointerRefresh)} | ` +
        `${usd(o.loads)} | ${usd(o.storage)} | **${usd(r.monthlyUSD.total)}** | ` +
        `${usd(b.monthlyUSD)} (${clusterLabel(b)}) | **${versus(r.monthlyUSD.total, b.monthlyUSD)}** |`
      );
    }),
  ];

  // What the Redis column priced, and what the tiered one would be all in memory.
  const tieredProfiles = PROFILES.filter((p) => redisOf(p).cluster.dataTiering);
  const replicas = CATALOGUE.replicasPerShard;
  const replicaWords = `${words(replicas)} replica${replicas === 1 ? '' : 's'}`;
  const reserve = pct(CATALOGUE.reservedMemoryFraction);
  const redis =
    `Each deployment's Redis is the cheapest cluster that holds its data at its compressed size, at the prices ` +
    `the estimator ships (${CATALOGUE.source}): every shard a primary and ${replicaWords}, each node keeping back ` +
    `the ${reserve} of its memory ElastiCache reserves by default. ` +
    tieredProfiles
      .map((p) => {
        const m = redisOf(p, IN_MEMORY);
        const quota =
          m.cluster.nodes > DEFAULT_NODES_PER_CLUSTER
            ? `, past ElastiCache's default quota of ${DEFAULT_NODES_PER_CLUSTER} nodes a cluster`
            : '';
        return (
          `The ${p.id} deployment's is a data-tiering cluster, which keeps the values read least recently on its ` +
          'SSD, and which AWS recommends for workloads that regularly read up to 20% of their data. Kept all in ' +
          `memory it would be **${usd(m.monthlyUSD)}** a month (${clusterLabel(m)}${quota}), and CloudBitmaps ` +
          `**${versus(price(p).monthlyUSD.total, m.monthlyUSD)}**.`
        );
      })
      .join(' ');

  // Which way the catalogue's policy leans. The words that restate one of its settings are built from that setting;
  // the policies it cannot state for itself are asserted here, so a change to them fails rather than goes stale.
  const oneShard = CATALOGUE.nodeTypes.filter((n) => n.maxShards === 1).map((n) => n.name);
  if (oneShard.length === 0 || !oneShard.every((n) => n.startsWith('cache.t4g.'))) {
    throw new Error(
      'sizing: the one-shard rows are no longer the burstable t4g nodes — rewrite the leanings',
    );
  }
  if (!CATALOGUE.source.startsWith('ElastiCache for Redis OSS,')) {
    throw new Error('sizing: the catalogue is no longer Redis OSS — rewrite the leanings');
  }
  const leanings =
    'It is the cheapest cluster of one kind, not the least Redis could cost, and its choices lean both ways. ' +
    'Toward Redis: the data is held at its compressed size, where a native Redis bitmap is sized by its highest ' +
    'id, so sparse ids take more memory than this; among node types the cheapest fit wins; a data-tiering node ' +
    'counts its SSD in full, though ElastiCache ' +
    '[moves no item larger than 128 MiB](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/data-tiering.html) ' +
    `to it; and every node keeps back only the ${reserve} reserved by default, where AWS ` +
    '[advises 30% on small nodes and 50% on micro ones](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/redis-memory-management.html) ' +
    `in production. Toward CloudBitmaps: the nodes are on-demand, every shard has ${replicaWords}, the engine is ` +
    'Redis OSS, and burstable `t4g` nodes are priced only as one shard. Reserved nodes, fewer replicas, or ' +
    '[ElastiCache for Valkey](https://aws.amazon.com/elasticache/pricing/), which AWS prices 20% lower a node, each ' +
    'cost less, and against them the saving is smaller' +
    (REVERSED.length === 0
      ? '.'
      : `: bought all three ways, on three years paid upfront, the Redis of [the ${andList(REVERSED)} ` +
        `${REVERSED.length === 1 ? 'deployment' : 'deployments'}](why-cloudbitmaps.md#the-short-answer) costs ` +
        'less than CloudBitmaps.');
  const leaningsSizing =
    `**Which way the Redis price leans.** ${leanings} To compare with one cluster you name, pass ` +
    '`pricing.redis: { monthlyUSD }`; to price Redis your own way, `pricing.redis: { sizedToData }`.';
  const exampleTotal = estimateCost(GUIDE_EXAMPLE_INPUT).monthlyUSD.total;
  const exampleCheaper = [
    ['oneYear', 'on one year with nothing upfront'],
    ['threeYearsUpfront', 'on three years paid upfront'],
  ]
    .map(([term, words]) => ({
      words,
      usd: estimateCost({ ...GUIDE_EXAMPLE_INPUT, pricing: cheapestRedis(term) }).redisBaseline
        .monthlyUSD,
    }))
    .filter((t) => t.usd < exampleTotal);
  const exampleReverses =
    exampleCheaper.length === 0
      ? ''
      : ' So does the Redis of the planning example above: bought all three ways, it costs ' +
        `${exampleCheaper.map((t) => `${usd2(t.usd)} a month ${t.words}`).join(', and ')}, where ` +
        `CloudBitmaps costs ${usd2(exampleTotal)}.`;
  const leaningsGuide =
    `${leanings}${exampleReverses} It prices nodes, not quotas: a cluster of more than ${int(DEFAULT_NODES_PER_CLUSTER)} nodes ` +
    "needs AWS to raise ElastiCache's " +
    `[default quota](${QUOTAS_URL}), ` +
    `which it [raises to at most ${int(MAX_NODES_PER_CLUSTER)} nodes a cluster](${SHARDS_URL}) ` +
    'on Redis OSS 5.0.6 to 7.1 or Valkey 7.2 and later, and data that needs more is several clusters, at the same ' +
    'price a node.';

  const headroom = [
    '| | cold intersects a second | where the bill meets its Redis | headroom |',
    '|---|---:|---:|---:|',
    ...PROFILES.map((p) => {
      const now = p.intersectsPerMonth / SECONDS_PER_MONTH;
      const even = breakEvenRate(p);
      const [a, b, room] = headroomRow(now, even);
      return `| **${p.name}** | ${a} | ${b} | ${room} |`;
    }),
  ];

  const overlaps = [SHARED_CHUNKS, 1000, CHUNKS_PER_SEGMENT];
  const overlap = [
    `| shared chunks, of ${int(CHUNKS_PER_SEGMENT)} | GETs a cold intersect | ${['medium', 'large'].map((id) => `${byId(id).name}, a month | against its Redis`).join(' | ')} |`,
    '|---:|---:|---:|---:|---:|---:|',
    ...overlaps.map((k) => {
      const cells = ['medium', 'large'].map((id) => {
        const r = price(byId(id), { shared: k });
        return `${usd(r.monthlyUSD.total)} | ${versus(r.monthlyUSD.total, r.redisBaseline.monthlyUSD)}`;
      });
      return `| ${int(k)}${k === SHARED_CHUNKS ? ' (the tables above)' : ''} | ${int(intersectGets(k))} | ${cells.join(' | ')} |`;
    }),
  ];
  const perChunk = intersectGets(1) - intersectGets(0);
  const overlapIntro =
    `A cold intersect costs ${int(intersectGets(0))} + ${int(perChunk)}k GETs for k shared chunks, so what two ` +
    "segments share sets the price, far more than their size. The tables above use the calibration run's overlap. " +
    'Segments that are filters over the same catalogue or the same audience can share most of their chunks:';
  const [evenMedium, evenLarge] = ['medium', 'large'].map((id) => breakEvenShared(byId(id)));
  const overlapNote =
    `The medium deployment's bill passes its Redis at **${int(evenMedium)} shared chunks**, about ` +
    `${pct(evenMedium / CHUNKS_PER_SEGMENT)} of a segment's, and the large one's at **${int(evenLarge)}**, about ` +
    `${pct(evenLarge / CHUNKS_PER_SEGMENT)}.`;

  const multipart = PROFILES.filter((p) => writeRequests(p.segmentBytes) > 1).map(
    (p) =>
      `The ${p.id} deployment's ${bytes(p.segmentBytes)} segments load as ${int(Math.ceil(p.segmentBytes / S3_PART_BYTES))}-part ` +
      `uploads, ${int(writeRequests(p.segmentBytes))} PUT-class requests each, since the S3 driver uploads in ` +
      `${mib(S3_PART_BYTES)} parts.`,
  );
  const shape =
    `Every segment has the shape of the [calibration run's](../../bench/calibration/2026-09-23-94416.md): its ids ` +
    `spread over about ${int(CHUNKS_PER_SEGMENT)} chunks, and every cold intersect of two segments sharing ` +
    `${int(SHARED_CHUNKS)} of them, so each fetches the shared chunks from both. A larger segment is modeled as ` +
    `holding its ids more densely, up to the ${bytes(CHUNKS_PER_SEGMENT * MAX_CHUNK_BYTES)} its chunks can take, ` +
    `about ${kib(MAX_CHUNK_BYTES)} each, the most one takes whatever ids it holds, not as ` +
    'sharing more chunks, which is the most favourable choice for large segments; ' +
    '[the overlap table](#how-much-the-overlap-matters) undoes it. **Hot segments** are the ones a ' +
    'long-lived reader keeps open, each reader its own; the last column is how often one reader reads each of them, ' +
    `with the point reads spread evenly. ${multipart.join(' ')}`;
  const readsEvery = readEverySec(byId('large'));
  if (readsEvery < GEN_TTL_MS / 1000) {
    throw new Error(
      `sizing: each large reader reads each hot segment every ${readsEvery} s, within the default ` +
        `${GEN_TTL_MS / 1000} s TTL, so the point reads no longer set the refresh — rewrite REFRESH`,
    );
  }
  const refresh =
    "- **The pointer refresh.** A reader re-reads a segment's pointer on its first read of it after " +
    `\`cache.genTtlMs\` has passed, ${ttlLabel(GEN_TTL_MS)} by default. Here each reader reads each hot segment ` +
    `only every ${secs(readsEvery)}, so at the default every point read re-reads a pointer, and the ` +
    'point reads are what the refresh costs. Trusting a pointer longer cuts it, at the price of a new load taking ' +
    'up to that long to be seen:';

  const large = byId('large');
  const ttls = [GEN_TTL_MS, 60_000, 300_000];
  const levers = [
    '| `cache.genTtlMs` | pointer refresh | **a month** | against its Redis |',
    '|---|---:|---:|---:|',
    ...ttls.map((ttl) => {
      const r = price(large, { genTtlMs: ttl === GEN_TTL_MS ? undefined : ttl });
      const label = ttl === GEN_TTL_MS ? `${ttlLabel(ttl)}, the default` : ttlLabel(ttl);
      return (
        `| ${label} | ${usd(r.monthlyUSD.byOp.pointerRefresh)} | **${usd(r.monthlyUSD.total)}** | ` +
        `${versus(r.monthlyUSD.total, r.redisBaseline.monthlyUSD)} |`
      );
    }),
  ];

  // The large deployment's GETs a second on its one data prefix: every chunk and tail read, and the point reads
  // that miss the cache. Pointer reads, one sized read an operand, go to the registry's own prefix beside it.
  const dataGets = dataGetsOf(large);
  const prefix =
    `And S3 has a rate of its own. AWS documents [at least ${int(S3_PREFIX_GETS_PER_SEC)} GET requests a second ` +
    'per partitioned prefix](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html), ' +
    "and scales a prefix's partitions as its request rate grows, answering `503 Slow Down` while it does. A " +
    "namespace's segments share one data prefix, with their pointers under another beside it.\n\n" +
    `The large deployment's reads average **${int(dataGets)} GETs a second** on its one data prefix, ` +
    `**${pct(dataGets / S3_PREFIX_GETS_PER_SEC)}** of that documented rate, before any peak.`;

  const medium = byId('medium');
  const sample = [
    '```ts',
    "import { estimateCost } from '@cloudbitmaps/roaring';",
    '',
    'const report = estimateCost({',
    `  segments: [{ sizeBytes: ${medium.segmentBytes.toLocaleString('en-US').replace(/,/g, '_')}, count: ${medium.segments.toLocaleString('en-US').replace(/,/g, '_')} }],`,
    '  workload: {',
    `    intersectsPerSec: ${medium.intersectsPerMonth / SECONDS_PER_MONTH}, // priced cold`,
    `    chunksPerIntersect: ${2 * SHARED_CHUNKS}, // the chunks each intersect fetches, both operands`,
    `    readsPerSec: ${medium.readsPerSec},`,
    `    cacheHitRate: ${medium.cacheHitRate},`,
    `    loadsPerMonth: ${medium.loadsPerMonth.toLocaleString('en-US').replace(/,/g, '_')},`,
    `    hotSegments: ${medium.hotPerProcess}, // in each reader process…`,
    `    readerProcesses: ${medium.readerProcesses}, // …of ${medium.readerProcesses}`,
    '  },',
    "  // pricing: your region's rates; on GCS or Azure Blob, set storage.requestsPerSizedRead to 2.",
    '});',
    `report.monthlyUSD.total; // ${usd(price(medium).monthlyUSD.total)}, the medium deployment above`,
    `report.redisBaseline; // ${usd(redisOf(medium).monthlyUSD)} a month: ${estimatorWords(price(medium)).cluster}`,
    'report.assumptions.notes; // what it modeled, and what it did not',
    '```',
  ];

  // The guide's examples of what the default prices: three data sizes, alone, with no workload.
  const at = (sizeBytes) => estimateCost({ segments: [{ sizeBytes }] }).redisBaseline;
  const example = (label, b) =>
    `${label} as ${words(b.cluster.nodes)} \`${b.cluster.nodeType}\` nodes at ${usd(b.monthlyUSD)} a month`;
  const [s200, m20, l2] = [200 * MB, 20e9, 2e12].map(at);
  const practice =
    replicas === 2 ? ", AWS's best practice" : replicas === 1 ? ', the least Multi-AZ allows' : '';
  const compares =
    `Every shard is a primary and ${replicaWords}${practice}, and each node keeps back the ${reserve} of its ` +
    "memory ElastiCache reserves by default, at AWS's us-east-1 on-demand prices " +
    '(`ELASTICACHE_REDIS_US_EAST_1_ONDEMAND`). ' +
    `So ${example('200 MB is priced', s200)}, ${example('20 GB', m20)}, and ${example('2 TB', l2)}` +
    (l2.cluster.dataTiering
      ? ': a data-tiering node, which keeps the values read least recently on its SSD.'
      : '.');
  // The one cluster the benchmarks page charts, in the shape its own declaration gives, beside the catalogue's node
  // that AWS gives the same memory. The catalogue must not list the anchor's node type, or the sentence is false.
  if (CATALOGUE.nodeTypes.some((n) => n.name === ONE_CLUSTER_SHAPE.nodeType)) {
    throw new Error(
      `sizing: the catalogue now lists ${ONE_CLUSTER_SHAPE.nodeType} — rewrite ONE_CLUSTER`,
    );
  }
  const m6g = CATALOGUE.nodeTypes.find((n) => n.name === 'cache.m6g.large');
  if (m6g === undefined)
    throw new Error('sizing: the catalogue has no cache.m6g.large — rewrite ONE_CLUSTER');
  const anchorNodes = ONE_CLUSTER_SHAPE.nodes;
  const oneCluster =
    '`ONE_REDIS_HA_CLUSTER` is the one the benchmarks page charts: a primary and ' +
    `${words(ONE_CLUSTER_SHAPE.replicas)} replica${ONE_CLUSTER_SHAPE.replicas === 1 ? '' : 's'} of ` +
    `\`${ONE_CLUSTER_SHAPE.nodeType}\`, $${int(ONE_REDIS_HA_CLUSTER.monthlyUSD)} a month. The catalogue leaves that ` +
    `node type out: ${words(anchorNodes)} \`cache.m6g.large\` of ${m6g.memoryGiB} GiB each cost ` +
    `${usd(anchorNodes * m6g.hourlyUSD * HOURS_PER_MONTH)}, so it is a fixed point to compare with, not a price the ` +
    'estimator picks.';

  const guide = GUIDE_EXAMPLE_INPUT;
  const g = estimateCost(guide);
  const uncached = estimateCost({ ...guide, workload: { ...guide.workload, cacheHitRate: 0 } });
  const w = guide.workload;
  const [seg] = guide.segments;
  const approx = (n) => `≈${Number(n.toPrecision(3))}`;
  const o = g.monthlyUSD.byOp;
  const guideWords = estimatorWords(g);
  const guideExample = [
    '```ts',
    "import { CloudRoaring } from '@cloudbitmaps/roaring';",
    '',
    'const report = CloudRoaring.estimateCost({',
    `  segments: [{ sizeBytes: ${seg.sizeBytes.toExponential().replace('e+', 'e')}, count: ${seg.count} }], // or { cardinality }`,
    '  workload: {',
    `    readsPerSec: ${w.readsPerSec}, // point reads; each cache miss is one GET`,
    `    cacheHitRate: ${w.cacheHitRate}, // hits are free`,
    `    intersectsPerSec: ${w.intersectsPerSec}, // priced cold: each operand's pointer and index are read too`,
    `    chunksPerIntersect: ${w.chunksPerIntersect}, // the chunks it fetches: ${OPERANDS} operands × ${w.chunksPerIntersect / OPERANDS} shared chunks`,
    `    loadsPerMonth: ${w.loadsPerMonth}, // one store.load() a day, single-part`,
    `    hotSegments: ${w.hotSegments}, // segments a long-lived reader keeps reading: each refreshes its pointer every ${ttlLabel(GEN_TTL_MS)}`,
    '  },',
    '});',
    `report.monthlyUSD.byOp; // { reads: ${approx(o.reads)}, intersects: ${approx(o.intersects)}, storage: ${approx(o.storage)}, loads: ${approx(o.loads)}, pointerRefresh: ${approx(o.pointerRefresh)} }`,
    `report.monthlyUSD.total; // ${approx(g.monthlyUSD.total)}`,
    `report.redisBaseline; // ${usd2(g.redisBaseline.monthlyUSD)} a month: the cheapest cluster in the catalogue that holds ${guideWords.holds}, ${guideWords.cluster}`,
    `report.verdict; // '${g.verdict}' — 'win-big' | 'win' | 'lose-zone', never hides the lose case`,
    `report.redisCrossover.readsPerSec; // ≈ ${int(g.redisCrossover.readsPerSec)} sustained reads/s at THIS report's ${pct(w.cacheHitRate)} cache-hit rate (≈ ${int(uncached.redisCrossover.readsPerSec)} at 0%)`,
    '```',
  ];

  // ── the explainer page, and the README's section ────────────────────────────────────────────────────
  const three = PROFILES.map((p) => {
    const report = price(p);
    return {
      p,
      report,
      total: report.monthlyUSD.total,
      redis: report.redisBaseline,
      inMemory: redisOf(p, IN_MEMORY),
    };
  });
  const list3 = ([a, b, c]) => `${a}, ${b} and ${c}`;

  const whySizes = [
    '| | data | CloudBitmaps a month | the Redis that holds it | CloudBitmaps costs |',
    '|---|---:|---:|---:|---:|',
    ...three.map(
      ({ p, total, redis: b }) =>
        `| **${p.name}** — ${p.who} | ${bytes(sizeOf(p))} | ${usd(total)} | ${usd(b.monthlyUSD)} | **${versus(total, b.monthlyUSD)}** |`,
    ),
  ];

  // A dot plot on a log scale, $1 to $100,000, ten characters a decade. A bar measured from $1 would invite reading
  // its length as the price, which on a log scale it is not.
  const DECADES = 5;
  const PER_DECADE = 10;
  const dotAt = (usdValue) => {
    const col = Math.round(Math.max(0, Math.log10(usdValue)) * PER_DECADE);
    if (col > DECADES * PER_DECADE) throw new Error(`sizing: ${usdValue} is past the plot's scale`);
    return `${' '.repeat(col)}●`;
  };
  const plotWidth = DECADES * PER_DECADE + 3;
  const scale = ['$1', '$10', '$100', '$1K', '$10K', '$100K'];
  const plotRows = [];
  for (const { p, total, redis: b, inMemory } of three) {
    const rows = [
      ['CloudBitmaps', total],
      ['Redis', b.monthlyUSD],
      ...(b.cluster.dataTiering ? [['Redis in RAM', inMemory.monthlyUSD]] : []),
    ];
    rows.forEach(([who, v], n) => {
      plotRows.push(
        `${(n === 0 ? p.name : '').padEnd(8)}${who.padEnd(14)}${dotAt(v).padEnd(plotWidth)}${usd(v)}`,
      );
    });
  }
  const tiered = three.filter(({ redis: b }) => b.cluster.dataTiering);
  const whyDeployments = [
    '```text',
    `${''.padEnd(22)}${scale
      .map((t) => t.padEnd(PER_DECADE))
      .join('')
      .trimEnd()}   a month, log scale`,
    `${''.padEnd(22)}${scale
      .map(() => '│'.padEnd(PER_DECADE))
      .join('')
      .trimEnd()}`,
    ...plotRows,
    '```',
    '',
    ...three.map(
      ({ p, total, redis: b }) =>
        `- **${p.name}**, ${bytes(sizeOf(p))}: ${usd(total)} a month against ${usd(b.monthlyUSD)} ` +
        `for ${clusterLabel(b)}, so CloudBitmaps costs **${versus(total, b.monthlyUSD)}**.`,
    ),
    ...tiered.map(
      ({ p, total, inMemory }) =>
        `- The ${p.id} deployment's Redis keeps the values read least recently on its SSD. All in memory it ` +
        `would be ${usd(inMemory.monthlyUSD)} a month, and CloudBitmaps ${versus(total, inMemory.monthlyUSD)}.`,
    ),
  ];

  // What the comparison assumes, said where the savings are: the kind of Redis, and how far each other kind moves
  // the saving; the overlap every figure rests on; and the one deployment past what has been validated.
  const againstEach = (pricing) =>
    list3(three.map(({ p, total }) => versus(total, redisOf(p, pricing).monthlyUSD)));
  // Reserved nodes stack on Valkey and one replica, and at three years they can reverse the verdict: say where, in
  // words the numbers decide, rather than leave "1.30× as much" for the reader to notice in a list.
  const reservedNote =
    'Reserved nodes cost less again, and stack on both: on a one-year term with nothing upfront, CloudBitmaps costs ' +
    `${againstEach(cheapestRedis('oneYear'))}, and on three years paid upfront, ` +
    `${againstEach(cheapestRedis('threeYearsUpfront'))}` +
    (REVERSED.length === 0
      ? '.'
      : `, so a Redis bought all three ways costs less than CloudBitmaps at the ${andList(REVERSED)} ` +
        `${REVERSED.length === 1 ? 'size' : 'sizes'}.`);
  const redisKind =
    "Each Redis is the cheapest on-demand ElastiCache for Redis OSS cluster in the estimator's catalogue that holds " +
    `the data, every shard a primary and ${words(CATALOGUE.replicasPerShard)} replicas: the cheapest of one kind, not ` +
    `the least Redis could cost. Against [ElastiCache for Valkey](${ELASTICACHE_PRICING_URL}), which AWS prices ` +
    `${pct(VALKEY_DISCOUNT)} lower a node, CloudBitmaps costs ${againstEach(redisPricedAs({ valkey: true }))}; with ` +
    `one replica a shard, ${againstEach(redisPricedAs({ replicas: 1 }))}; with both, ` +
    `${againstEach(redisPricedAs({ valkey: true, replicas: 1 }))}. ${reservedNote}`;
  if (!(large.segments > VALIDATED_SEGMENTS)) {
    throw new Error(
      "sizing: the large deployment is inside the roadmap's envelope; rewrite the envelope note",
    );
  }
  const envelope = (guide) =>
    `The large deployment's ${int(large.segments)} segments are past the roughly ${int(VALIDATED_SEGMENTS)} the library has ` +
    'been validated at, and its readers would need an index budget and a chunk cache far past their defaults ' +
    `([what each reader holds](${guide}sizing.md#what-each-reader-holds)), in memory not priced here.`;
  const [medium1000, large1000] = ['medium', 'large'].map((id) => {
    const r = price(byId(id), { shared: 1000 });
    return times(r.monthlyUSD.total / r.redisBaseline.monthlyUSD);
  });
  const [mediumPasses, largePasses] = ['medium', 'large'].map((id) => breakEvenShared(byId(id)));
  const whyCaveats = [
    redisKind,
    '',
    `All three assume that two segments share ${int(SHARED_CHUNKS)} of their ${int(CHUNKS_PER_SEGMENT)} chunks, and ` +
      'filters over one catalogue or one audience can share most of theirs: at ' +
      `${int(1000)} shared chunks, the medium and large deployments cost ${medium1000} and ${large1000} their Redis, ` +
      `and their bills pass it at ${int(mediumPasses)} and ${int(largePasses)} shared chunks.`,
    '',
    envelope('docs/guide/'),
  ];
  const whyLeanings = [redisKind, '', envelope('')];

  const getPerMillion = P.storage.getPerMillion;
  const box = (lines) => {
    const w = 60;
    for (const [inside] of lines) {
      if (inside.length > w) {
        throw new Error(`sizing: a line of the money diagram is wider than its box: ${inside}`);
      }
    }
    return [
      ` ┌${'─'.repeat(w + 2)}┐`,
      ...lines.map(
        ([inside, outside]) => ` │ ${inside.padEnd(w)} │${outside ? ` ──► ${outside}` : ''}`,
      ),
      ` └${'─'.repeat(w + 2)}┘`,
    ];
  };
  const storages = three.map(({ report }) => report.monthlyUSD.byOp.storage);
  const money = [
    '```text',
    ' REDIS: all your data on its nodes, billed around the clock',
    ...box([
      [
        'all your data ──► memory, on a primary and its replicas',
        'billed every hour, queried or not',
      ],
      ['(a data-tiering node moves the least recently read to SSD)'],
      [
        `${int(CATALOGUE.replicasPerShard)} replicas a shard; ${pct(CATALOGUE.reservedMemoryFraction)} of each node's memory kept back`,
      ],
    ]),
    '',
    ' CLOUDBITMAPS: every byte in object storage, each read paid for',
    ...box([
      [
        `all your data   ──► S3, $${P.storage.storagePerGiBMonth} a GiB-month`,
        `${usd(Math.min(...storages))} to ${usd(Math.max(...storages))} a month here`,
      ],
      ["the hot part    ──► your readers' memory, a slice of it", 'your own machines'],
      [
        `each cold read  ──► S3 GETs, $${getPerMillion.toFixed(2)} a million`,
        'grows with the queries',
      ],
      [
        "each refresh    ──► a reader's pointer GET, after genTtlMs",
        'at most one a read, and one a genTtlMs',
      ],
      [
        'each load       ──► S3 PUTs and LISTs, GETs, a pointer write',
        'grows with how often the data changes',
      ],
    ]),
    '```',
  ];

  const shareOf = (id, term) => {
    const { report, total } = three.find(({ p }) => p.id === id);
    return share(report.monthlyUSD.byOp[term] / total);
  };
  // What the storage share would be with the generations `load()` keeps besides the current one, which the
  // estimator prices as one copy.
  const kept =
    LOAD_KEEPS === 1
      ? 'the generation it replaced'
      : `the ${words(LOAD_KEEPS)} generations before the current one`;
  const retained = (() => {
    const { report, total } = three.find(({ p }) => p.id === 'large');
    const stored = report.monthlyUSD.byOp.storage;
    return share(((1 + LOAD_KEEPS) * stored) / (total + LOAD_KEEPS * stored));
  })();
  const whyMoves = [
    '- **Redis grows with how much data you have**: in steps while the data fits a few nodes, then in proportion to ' +
      'it, every replica with it.',
    `- **CloudBitmaps grows with its reads.** Storage is ${shareOf('large', 'storage')} of the large deployment's ` +
      `bill, for one copy of its data; \`load()\` also keeps ${kept} by default, which would make it ` +
      `${retained}. The rest is the cold reads that miss a reader's cache; the pointer refresh, at most one a read ` +
      'and one per segment per reader each `cache.genTtlMs`, which is ' +
      `${shareOf('large', 'pointerRefresh')} of the large bill and ${shareOf('medium', 'pointerRefresh')} of the ` +
      `medium's; and the loads, ${shareOf('large', 'loads')} of the large bill ` +
      '([what moves the large bill](sizing.md#what-moves-the-large-bill)).',
  ];

  const sizes = [200 * MB, 1e9, 5e9, 20e9, 200e9, 2e12, 20e12];
  const pastQuota = sizes
    .map((b) => ({ b, nodes: coldAt(b, 1).redisBaseline.cluster.nodes }))
    .filter(({ nodes }) => nodes > DEFAULT_NODES_PER_CLUSTER);
  for (const { b, nodes } of pastQuota) {
    // Past the most one cluster can have, the data is several clusters, which the note below does not say.
    if (nodes > MAX_NODES_PER_CLUSTER) {
      throw new Error(
        `sizing: the ${bytes(b)} cluster's ${nodes} nodes are more than one cluster holds`,
      );
    }
  }
  const quotas = (nodes) =>
    nodes > DEFAULT_NODES_PER_REGION
      ? `default quotas](${QUOTAS_URL}) of ${int(DEFAULT_NODES_PER_CLUSTER)} nodes a cluster and ${int(DEFAULT_NODES_PER_REGION)} a Region`
      : `default quota](${QUOTAS_URL}) of ${int(DEFAULT_NODES_PER_CLUSTER)} nodes a cluster`;
  const grows = [
    '| data stored | the Redis that holds it | its nodes | CloudBitmaps, one cold intersect a second | where the bill meets the Redis |',
    '|---:|---:|---|---:|---:|',
    ...sizes.map((b) => {
      const r = coldAt(b, 1);
      return (
        `| ${bytes(b)} | ${usd(r.redisBaseline.monthlyUSD)} | ${clusterLabel(r.redisBaseline)} | ` +
        `${usd(r.monthlyUSD.total)} | ${rate(meetsAt(b))} a second |`
      );
    }),
    ...(pastQuota.length === 0
      ? []
      : [
          '',
          pastQuota
            .map(
              ({ b, nodes }) =>
                `The ${bytes(b)} cluster's ${int(nodes)} nodes are past ElastiCache's [${quotas(nodes)}.`,
            )
            .join(' ') +
            ` AWS raises them on request, a cluster to [at most ${int(MAX_NODES_PER_CLUSTER)} nodes](${SHARDS_URL}) ` +
            'on Redis OSS 5.0.6 to 7.1 or Valkey 7.2 and later.',
        ]),
  ];

  const whyLine =
    "The line is the table's last column. It climbs with the data because the Redis it is measured against does. " +
    'In this model an extra cold intersect costs CloudBitmaps the same at any size: every segment keeps the ' +
    `[calibration run](../../bench/calibration/2026-09-23-94416.md)'s shape, ${int(CHUNKS_PER_SEGMENT)} chunks with ` +
    `${int(SHARED_CHUNKS)} shared, so a larger store is more segments of that shape, not larger ones. Segments that grow by sharing ` +
    'more chunks cost more, as [overlap](#where-it-loses) shows. The chart counts cold intersects alone; the three ' +
    'deployments also make point reads and refresh pointers, which ' +
    '[the next section](#how-much-room-each-deployment-has) counts in.';

  const whyRoom = [
    '| | data | cold intersects a second | where the bill meets its Redis | room |',
    '|---|---:|---:|---:|---:|',
    ...PROFILES.map((p) => {
      const now = p.intersectsPerMonth / SECONDS_PER_MONTH;
      const even = breakEvenRate(p);
      const [a, b, room] = headroomRow(now, even);
      return `| **${p.name}** | ${bytes(sizeOf(p))} | ${a} | ${b} | **${room}** |`;
    }),
  ];

  const hotReport = coldAt(HOT.sizeBytes, HOT.perSec);
  const hot =
    `A dashboard running ${int(HOT.perSec)} cold intersects a second over ${bytes(HOT.sizeBytes)} costs ` +
    `**${usd(hotReport.monthlyUSD.total)}** a month, where the Redis that holds ${bytes(HOT.sizeBytes)} costs ` +
    `**${usd(hotReport.redisBaseline.monthlyUSD)}** (${clusterLabel(hotReport.redisBaseline)}): CloudBitmaps ` +
    `costs **${Math.round(hotReport.monthlyUSD.total / hotReport.redisBaseline.monthlyUSD)}×** as much there, ` +
    'and Redis answers from memory. That is priced cold, as if nothing repeated. A dashboard that repeats its queries is ' +
    `served from the chunk cache when their chunks fit it, ${int(CACHE_MAX_CHUNKS)} by default, and then pays only ` +
    "for its pointer reads, once each `cache.genTtlMs`; one that ranges over more than a reader's cache holds is " +
    "Redis's ground, or a cache's in front of CloudBitmaps.";

  // The engine keeps a window of INTERSECT_CONCURRENCY chunks in flight and starts the next as the OLDEST finishes, so
  // at an even latency the shared chunks take ceil(shared ÷ window) request times, after the pointers and indexes.
  const chain = 2 + Math.ceil(SHARED_CHUNKS / INTERSECT_CONCURRENCY);
  const depth =
    `A cold intersect of two segments sharing ${int(SHARED_CHUNKS)} chunks waits on a chain of requests ` +
    `**${int(chain)} deep**: both operands' pointers, then both indexes, then the shared chunks, ` +
    `${int(INTERSECT_CONCURRENCY)} at a time, each read from both operands together, so ` +
    `${int(OPERANDS * INTERSECT_CONCURRENCY)} requests are in flight, and the next chunk starts as the oldest finishes. At an ` +
    `even latency that is ${int(chain)} request times end to end. A slow request holds up those queued behind it, ` +
    'so what the chain takes is for a measurement to say. A repeat served from the chunk cache makes no request ' +
    'within `cache.genTtlMs`, and one round of pointer reads after it.';

  const whyPrefix =
    `AWS documents [at least ${int(S3_PREFIX_GETS_PER_SEC)} GET requests a second per partitioned prefix]` +
    '(https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html), and answers ' +
    "`503 Slow Down` while it scales one. A namespace's segments share one data prefix. The large deployment's " +
    `reads average **${int(dataGets)} GETs a second** on it, **${pct(dataGets / S3_PREFIX_GETS_PER_SEC)}** of that ` +
    `documented rate before any peak, and would reach it at ${times(S3_PREFIX_GETS_PER_SEC / dataGets)} its load: ` +
    'spread segments across namespaces, and expect throttling at peaks. A throttled GET is retried by the ' +
    `[AWS SDK](${SDK_RETRY_URL}), ${int(SDK_ATTEMPTS)} attempts by default, inside each of the library's ` +
    `${int(LIBRARY_ATTEMPTS)}: up to ${int(SDK_ATTEMPTS * LIBRARY_ATTEMPTS)} requests for one.`;

  const base = intersectGets(0);
  const whyOverlap =
    `A cold intersect costs ${int(base)} + ${int(intersectGets(1) - base)}k GETs for k shared chunks, so segments ` +
    'that share most of their chunks cost far more to intersect than their size suggests. At ' +
    `${int(1000)} shared chunks of ${int(CHUNKS_PER_SEGMENT)}, where the tables above assume ` +
    `${int(SHARED_CHUNKS)}, the medium deployment's bill comes to **${medium1000}** its Redis's price, and the ` +
    `large one's to **${large1000}**; they pass it at ${int(mediumPasses)} and ${int(largePasses)} shared chunks.`;

  // Each chart, picked for the reader's theme, with words that say what it shows.
  const chartText = chartWords();
  const picture = (file, alt) =>
    [
      '<picture>',
      `  <source media="(prefers-color-scheme: dark)" srcset="../../bench/${file}-dark.svg">`,
      `  <img alt="${esc(alt)}" src="../../bench/${file}.svg">`,
      '</picture>',
    ].join('\n');

  return {
    WHY_SIZES: whySizes.join('\n'),
    WHY_CAVEATS: whyCaveats.join('\n'),
    WHY_DEPLOYMENTS: whyDeployments.join('\n'),
    WHY_LEANINGS: whyLeanings.join('\n'),
    MONEY: money.join('\n'),
    WHY_MOVES: whyMoves.join('\n'),
    WHY_CHART_BILL: picture('bill-as-data-grows', chartText.bill),
    GROWS: grows.join('\n'),
    WHY_CHART_WHERE: picture('where-each-costs-less', chartText.where),
    WHY_LINE: whyLine,
    WHY_ROOM: whyRoom.join('\n'),
    HOT: hot,
    DEPTH: depth,
    WHY_PREFIX: whyPrefix,
    WHY_OVERLAP: whyOverlap,
    GUIDE_EXAMPLE: guideExample.join('\n'),
    COMPARES: compares,
    GUIDE_LEANINGS: leaningsGuide,
    LEANINGS: leaningsSizing,
    OVERLAP_INTRO: overlapIntro,
    ONE_CLUSTER: oneCluster,
    SHAPE: shape,
    REFRESH: refresh,
    INPUTS: inputs.join('\n'),
    READERS: readers.join('\n'),
    BILL: bill.join('\n'),
    REDIS: redis,
    HEADROOM: headroom.join('\n'),
    OVERLAP: overlap.join('\n'),
    OVERLAP_NOTE: overlapNote,
    LEVERS: levers.join('\n'),
    PREFIX: prefix,
    SAMPLE: sample.join('\n'),
  };
}

// ── the charts ───────────────────────────────────────────────────────────────────────────────────────
/** Both charts, each in the light theme and the dark one, as the files CHARTS lists. */
function charts() {
  const d = chartData();
  const words_ = chartWords();
  const xAxis = {
    ...CHART_X,
    // 10 TB's gridline without its label, which would run into the 20 TB that names the axis's end.
    ticks: [
      ...[1e8, 1e9, 1e10, 1e11, 1e12].map((at) => ({ at, text: bytes(at) })),
      { at: 1e13, text: '' },
      { at: CHART_X.max, text: bytes(CHART_X.max) },
    ],
    title: 'data stored, log scale',
  };
  const redisKind = `${P.name} · Redis: the cheapest on-demand Redis OSS cluster that holds the data`;
  const shape = `two ${int(CHUNKS_PER_SEGMENT)}-chunk segments sharing ${int(SHARED_CHUNKS)}`;
  const rates = [0.001, 0.01, 0.1, 1, 10, 100, 1000, 10000];
  const out = {};
  for (const [suffix, theme] of [
    ['', 'light'],
    ['-dark', 'dark'],
  ]) {
    out[`bench/bill-as-data-grows${suffix}.svg`] = logChart(
      {
        title: 'The monthly bill as the data grows',
        subtitle: [redisKind, `CloudBitmaps: one cold intersect a second, of ${shape}`],
        label: words_.bill,
        x: xAxis,
        y: {
          min: 10,
          max: 1e6,
          ticks: ['$10', '$100', '$1K', '$10K', '$100K', '$1M'].map((text, n) => ({
            at: 10 ** (n + 1),
            text,
          })),
          title: 'a month, log scale',
        },
        lines: [
          { points: d.redisLine, color: 'redis', text: 'the Redis that holds it' },
          {
            points: d.cbLine,
            color: 'cloudbitmaps',
            text: 'CloudBitmaps, one cold intersect a second',
            textAt: [3e10, 110],
          },
        ],
        markers: [
          {
            at: [d.cross, d.cbLine[d.crossAt][1]],
            text: `they cross near ${bytes(d.cross)}`,
            anchor: 'end',
            dy: -14,
          },
        ],
      },
      theme,
    );
    out[`bench/where-each-costs-less${suffix}.svg`] = logChart(
      {
        title: 'Where each costs less',
        subtitle: [redisKind, `cold intersects of ${shape} · the deployments are illustrative`],
        label: words_.where,
        x: xAxis,
        y: {
          min: rates[0],
          max: rates[rates.length - 1],
          ticks: rates.map((at) => ({ at, text: at < 1 ? String(at) : int(at) })),
          title: 'cold intersects a second, log scale',
        },
        areas: [
          {
            points: d.meets,
            toward: 'min',
            color: 'cloudbitmaps',
            text: 'CloudBitmaps costs less',
            textAt: [2e11, 0.004],
          },
          {
            points: d.meets,
            toward: 'max',
            color: 'redis',
            text: 'Redis costs less',
            textAt: [1.25e8, 2500],
          },
        ],
        lines: [
          { points: d.meets, color: 'ink', text: 'where the bills meet' },
          {
            points: [
              [CHART_X.min, d.prefixRate],
              [CHART_X.max, d.prefixRate],
            ],
            color: 'ink',
            dashed: true,
            text: `one prefix's GETs: ${rate(d.prefixRate)} intersects a second`,
            // Below the rule: above it, the example's dot leaves no room.
            textAt: [1.3e8, d.prefixRate / 2.3],
          },
        ],
        markers: [
          ...PROFILES.map((p) => {
            const at = [sizeOf(p), p.intersectsPerMonth / SECONDS_PER_MONTH];
            // A deployment near the dashed rule is labelled on the far side of its dot from it, with its own rate in
            // place of its size, which the axis gives: a dot that all but touches the rule would otherwise read as
            // sitting on it.
            const near = Math.abs(Math.log10(at[1] / d.prefixRate)) < 0.3;
            if (!near) return { at, text: `${p.name}, ${bytes(sizeOf(p))}` };
            return {
              at,
              text: `${p.name}: ${rate(at[1])} a second`,
              dy: at[1] < d.prefixRate ? 10 : -10,
            };
          }),
          {
            at: [HOT.sizeBytes, HOT.perSec],
            text: `example: ${int(HOT.perSec)} a second over ${bytes(HOT.sizeBytes)}`,
            hollow: true,
          },
        ],
      },
      theme,
    );
  }
  return out;
}

// ── write / check ────────────────────────────────────────────────────────────────────────────────────
/**
 * A figure outside every region of a page that says its figures are generated: money, a share, a multiple, a count of
 * requests, or the overlap formula. Nothing compares one with the estimator, so none may stand in the prose. Matched
 * on the text `prose()` leaves, with its entities decoded and its fullwidth forms folded, so `&#36;5`, `&#57;&#48;%`,
 * `９０％` and `3&times;` are figures, and in the words a page might use as well as its signs: `90 percent`, `90 pct`,
 * `66 times`, `three times`, `66x`, `66-fold`, `tenfold`, `twice as much`, `half the bill`, `40 cents`, `40¢`, `€5`,
 * `21,445 USD`, `4,140 requests`, `200 chunk reads`, `4.1k GETs`, `12 LISTs`. These are the spellings it knows, not
 * every one there is. "S3 times out", a version's number, "HTTP/2 requests" and "can double as" are not figures.
 */
const NUMBER_WORD = String.raw`(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|fifty|a\s+hundred|a\s+thousand)`;
const SHARE_OR_MULTIPLE = [
  String.raw`\d[\d,.]*\s*[%‰×✕✖⨯]`,
  String.raw`[×✕✖⨯]\s?\d`,
  // Not after a letter or a dot: "S3 times out" is no multiple, nor is the 2 of a version, 7.2.4.
  String.raw`(?<![\w.])\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:x\b|per[\s-]?cent\b|pct\b|times\b(?!\s+out\b)|-?fold\b|-times\b)`,
  String.raw`\bper[\s-]?cent\b(?!-)`,
  String.raw`\d(?:[\d,.]*\d)?\s*percentage\s+points?\b`,
  String.raw`\bby\s+a\s+factor\s+of\s+(?:\d|${NUMBER_WORD}\b)`,
  String.raw`\b(?:twice|thrice|double|triple|half)\s+(?:as\s+(?:much|many|large|big|high|long|expensive|costly|cheap|fast|slow)|the\s+(?:bill|cost|price|requests|GETs|rate|reads|bytes|size|money|load|figure|time|latency|memory|storage))\b`,
  String.raw`\b${NUMBER_WORD}(?:\s+times\b(?!\s+out\b)|fold\b)`,
];
/** A count of requests: of anything the bill counts, by its noun, whole or in thousands and millions. */
const REQUEST_COUNT = String.raw`(?<![\w./])\d(?:[\d,]*\d)?(?:\.\d+\s*(?:k|M|million|billion|thousand)\b|\s*(?:k|M|million|billion|thousand)\b)?\s+(?:(?:S3|pointer|chunk|index|tail|range|ranged|sized|conditional|object)\s+)?(?:GETs?|requests?|reads?)\b`;
const FIGURE = new RegExp(
  [
    String.raw`(?:\$|\bUS\$|\bUSD)\s*\d`,
    String.raw`\d\s*[¢$€£¥]|[¢€£¥]\s*\d`,
    ...SHARE_OR_MULTIPLE,
    String.raw`(?<![\w.])\d[\d,]*(?:\.\d+)?\s*(?:USD\b|(?:US\s+)?dollars?\b|cents?\b)`,
    String.raw`\b\d+\s*\+\s*\d+\s*[·×*]?\s*k\b`,
    String.raw`\b\d+\s*[·×*]?\s*k\s*\+\s*\d+\b`,
    REQUEST_COUNT,
  ].join('|'),
  'i',
);
/** A count of S3's other requests, which are only ever written in capitals: "1 list" is a word, "12 LISTs" a count. */
const WRITE_COUNT =
  /(?<![\w./])\d(?:[\d,]*\d)?\s*(?:k|M)?\s+(?:S3\s+)?(?:PUT|LIST|HEAD|DELETE|POST)s?\b/;
/** The first figure in `text`, whichever pattern finds it. */
function figureIn(text) {
  const hits = [FIGURE.exec(text), WRITE_COUNT.exec(text)].filter((m) => m !== null);
  return hits.length === 0 ? null : hits.reduce((a, b) => (b.index < a.index ? b : a));
}
/**
 * The pages that say so, and the part of each that does: the whole page, or one section of it. A page whose
 * section alone is generated keeps the rest of itself to the phrases listed here, each a measurement or a definition
 * quoted where it is explained, once: a share or multiple anywhere else in it, a second copy of a listed phrase
 * included, is refused, so one moved out of the section is refused there too. A listed phrase the page no longer
 * says is refused as well, rather than left to allow a figure nobody is quoting. Its dollar amounts are
 * `scripts/site-figures.cjs`'s to check. Its request counts are measured figures its calibration section quotes,
 * which neither gate compares.
 */
const GENERATED_PROSE = {
  'docs/guide/why-cloudbitmaps.md': null,
  'docs/guide/sizing.md': null,
  'README.md': {
    section: 'Why CloudBitmaps',
    elsewhere: [
      'overlapping in 5% of chunks',
      'LIST bills at 12.5× a GET',
      '65,536-id chunk (6.25% of it)',
      'about twice the load figure',
    ],
  },
};
for (const doc of Object.keys(GENERATED_PROSE)) {
  if (DOCS[doc] === undefined)
    throw new Error(`sizing: GENERATED_PROSE names ${doc}, which DOCS does not list`);
}
/** A page with every region's text blanked where it stands, so offsets into the page still hold. */
function blankRegions(doc, text) {
  const at = regionsOf(doc, text, DOCS[doc] ?? [], DOCS);
  let s = text;
  for (const { i, j } of Object.values(at)) {
    s = s.slice(0, i) + s.slice(i, j).replace(/[^\n]/g, ' ') + s.slice(j);
  }
  return { text: s, at };
}
/** A reference definition's line: a label, a colon, an address, and at most a quoted title. */
/**
 * A reference definition: a label, a colon, an address and at most a title, alone on a line. A label holds at least one
 * character that is not a space, and an escaped bracket does not close it: `[Large\]: $5` and `[ ]: $5` are text.
 */
const REF_DEF =
  /^ {0,3}\[(?!\^)(?!\s*\])(?:[^\]\\\n]|\\.)+\]:[ \t]*(?:<[^>\n]*>|[^\s<>]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;
/** A tag as HTML has one: a name, then attributes by HTML's rules. `<about 95% at 2 TB>` is text, and is shown. */
const TAG =
  /<\/?[a-z][a-z0-9-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/gi;
/** Tags a renderer lays out inside a line of text, so the words either side of one run on: `time<b>s</b>`. */
const INLINE_TAG =
  /^(?:a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|i|img|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/;
const codePoint = (entity, n) => (n <= 0x10ffff ? String.fromCodePoint(n) : entity);
/**
 * The named entities a figure could be spelled with: signs, spaces, invisible characters and the punctuation markup is
 * made of. Any other name is left as it stands, as a renderer shows an entity it does not know.
 */
const ENTITIES = {
  dollar: '$',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  curren: '¤',
  percnt: '%',
  permil: '‰',
  pertenk: '‱',
  times: '×',
  Cross: '⨯',
  divide: '÷',
  asymp: '≈',
  approx: '≈',
  thickapprox: '≈',
  plus: '+',
  minus: '−',
  equals: '=',
  nbsp: ' ',
  NonBreakingSpace: ' ',
  ensp: ' ',
  emsp: ' ',
  emsp13: ' ',
  emsp14: ' ',
  numsp: ' ',
  puncsp: ' ',
  thinsp: ' ',
  ThinSpace: ' ',
  hairsp: ' ',
  VeryThinSpace: ' ',
  MediumSpace: ' ',
  shy: '',
  ZeroWidthSpace: '',
  NegativeVeryThinSpace: '',
  NegativeThinSpace: '',
  NegativeMediumSpace: '',
  NegativeThickSpace: '',
  zwnj: '',
  zwj: '',
  lrm: '',
  rlm: '',
  NoBreak: '',
  InvisibleTimes: '',
  it: '',
  InvisibleComma: '',
  ic: '',
  ApplyFunction: '',
  af: '',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  comma: ',',
  period: '.',
  colon: ':',
  semi: ';',
  num: '#',
  sol: '/',
  bsol: '\\',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrack: '[',
  rbrack: ']',
  ast: '*',
  midast: '*',
  lowbar: '_',
  UnderBar: '_',
  grave: '`',
  excl: '!',
  quest: '?',
  commat: '@',
  Hat: '^',
  hyphen: '‐',
  dash: '‐',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  mldr: '…',
};
/** Each entity decoded, once: `&#38;#36;5` shows `&#36;5`, so what an entity spells is inert markup, and no entity. */
const decodeEntities = (text, hold) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (entity, d, h, name) => {
    const c =
      d !== undefined
        ? codePoint(entity, Number(d))
        : h !== undefined
          ? codePoint(entity, Number.parseInt(h, 16))
          : (ENTITIES[name] ?? entity);
    return c === entity ? c : c.replace(ASCII_PUNCTUATION, hold);
  });
/** A character held where no rule reads it as markup until the reading is done: an escaped `\<` opens no tag. */
const inert = (c) => String.fromCharCode(0xe000 + c.charCodeAt(0));
const INERT = /[-]/g;
/** Every ASCII punctuation character, none of which opens anything inside code. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** Markdown's own punctuation, which an HTML block leaves as text: links, images, emphasis, code and escapes. */
const MARKDOWN_PUNCTUATION = /[!()*[\\\]_`]/g;
/** A line that opens an HTML block whose end is its closing tag rather than a blank line. */
const HTML_RAW_OPEN = /^ {0,3}<(pre|script|style|textarea)(?:\s|>|$)/i;
/** Whether a comment opened at `at` in `line` also closes on it: `<!-->`, `<!--->`, or a `-->` after it. */
const commentCloses = (line, at) => /^(?:>|->|[\s\S]*?-->)/.test(line.slice(at + 4));
/**
 * The blocks of some markdown, line by line, as CommonMark reads them. A fenced code block is shown as it stands, so
 * every mark in it is held inert and its fences go. An HTML block shows its text and its tags are tags, but markdown in
 * it is text, so markdown's punctuation is held inert. A comment block is kept for the comment rule. A reference
 * definition goes, where a renderer drops one: not in the middle of a paragraph.
 */
function blocks(text) {
  const out = [];
  let fence = null;
  let html = null; // 'blank' for a block a blank line ends, 'comment', or the tag whose closing ends it
  let paragraph = false; // whether the line before continues a paragraph, which a definition cannot interrupt
  for (const line of text.split('\n')) {
    if (fence !== null) {
      const closes = closesFence(line, fence);
      out.push(closes ? '' : line.replace(ASCII_PUNCTUATION, inert));
      if (closes) fence = null;
      continue;
    }
    if (html !== null) {
      if (html === 'comment') {
        out.push(line);
        if (line.includes('-->')) html = null;
        continue;
      }
      if (html === 'blank' && line.trim() === '') {
        html = null;
        out.push(line);
        paragraph = false;
        continue;
      }
      out.push(line.replace(MARKDOWN_PUNCTUATION, inert));
      if (html !== 'blank' && new RegExp(`</${html}\\s*>`, 'i').test(line)) html = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = open[1] ?? open[2];
      out.push('');
      paragraph = false;
      continue;
    }
    const comment = /^ {0,3}<!--/.exec(line);
    if (comment !== null) {
      out.push(line);
      if (!commentCloses(line, comment[0].length - 4)) html = 'comment';
      paragraph = false;
      continue;
    }
    const raw = HTML_RAW_OPEN.exec(line);
    if (raw !== null || HTML_BLOCK_TAG.test(line) || (!paragraph && HTML_LONE_TAG.test(line))) {
      out.push(line.replace(MARKDOWN_PUNCTUATION, inert));
      html = raw === null ? 'blank' : raw[1].toLowerCase();
      if (raw !== null && new RegExp(`</${html}\\s*>`, 'i').test(line)) html = null;
      paragraph = false;
      continue;
    }
    if (!paragraph && REF_DEF.test(line)) {
      out.push('');
      continue;
    }
    out.push(line);
    paragraph = line.trim() !== '' && !/^ {0,3}#{1,6}(?:\s|$)/.test(line);
  }
  return out.join('\n');
}
/**
 * What a reader is given of some markdown, and only that: what a renderer takes away is taken away, and everything it
 * shows is kept. This reads markdown with rules, not a parser, for the constructs these pages use:
 * - code, fenced or in a span, is shown as it stands, and so is markdown inside an HTML block;
 * - comments go, `<!-->` and `<!--->` among them, but not one inside code;
 * - a reference definition goes where a renderer drops one, which is not in the middle of a paragraph, and a
 *   footnote's `[^1]:` line stays, since it is shown;
 * - a link or an image is read as its text, so what follows it is read as it stands;
 * - a backslash escape shows the character it escapes, and that character opens nothing: `\<span>` is text;
 * - autolinks and bare addresses go, a bare one ending at a space, a quote, a bracket, a table cell's edge, a dash
 *   or an escape;
 * - tags go, and only tags: a `<` that opens none hides nothing, and neither does an entity or an escape spelling one.
 *   An inline tag joins the words either side of it, and an image's `alt` text is read, as a markdown image's is;
 * - entities are decoded once, fullwidth forms folded, invisible characters dropped, and emphasis around a word undone.
 * A page that needs more than this should move it to a markdown parser.
 */
function prose(text) {
  const marked = blocks(text)
    .replace(CODE_SPAN, (_, ticks, body) => body.replace(ASCII_PUNCTUATION, inert))
    .replace(/(?<=(?:^|[^\\])(?:\\\\)*)<!--(?:>|->|[\s\S]*?-->)/g, '')
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => inert(c))
    .replace(
      /!?\[([^\]\n]*)\]\(\s*(?:<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g,
      '$1',
    )
    .replace(/<(?:https?|mailto):[^>\s-]*>/g, '')
    .replace(/\bhttps?:\/\/[^\s<>"'()[\]|–—-]+/g, '')
    .replace(TAG, (tag) => {
      const name = /^<\/?([a-z][a-z0-9-]*)/i.exec(tag)[1].toLowerCase();
      const alt =
        name === 'img' ? /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag) : null;
      const shown = alt === null ? '' : (alt[1] ?? alt[2] ?? alt[3]);
      return INLINE_TAG.test(name) ? shown : ` ${shown} `;
    });
  const read = decodeEntities(marked, inert).replace(
    /(?<=[\w%‰×$¢€£¥])(?:\*\*|__|\*|_)+|(?:\*\*|__|\*|_)+(?=[\w$¢€£¥×])/g,
    '',
  );
  return plain(read)
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Zs}/gu, ' ')
    .replace(INERT, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
}
/** A line that opens an HTML block with one of CommonMark's block tags, which may interrupt a paragraph. */
const HTML_BLOCK_TAG = new RegExp(
  String.raw`^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|` +
    String.raw`details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|` +
    String.raw`hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|` +
    String.raw`section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)`,
  'i',
);
/** A whole tag alone on a line, which opens an HTML block too, but only after a blank line. */
const HTML_LONE_TAG = /^ {0,3}(?:<[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|<\/[a-z][a-z0-9-]*\s*>)\s*$/i;
/**
 * Where a section runs in `text`: from its `## ` heading to the next one. A line inside a code fence, an HTML comment,
 * a `<pre>` or any other HTML block is not a heading, so a quoted `## ` cannot cut the section short and leave what
 * follows it unchecked. An HTML block runs to the next blank line; comments and `<pre>` blocks are blanked where they
 * stand, so the offsets are still the page's.
 */
function sectionOf(doc, text, title) {
  const headings = text.replace(/<!--(?:>|->|[\s\S]*?-->)|<pre\b[\s\S]*?<\/pre>/gi, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  let at = 0;
  let fence = null;
  let start = -1;
  let html = false;
  let blank = true;
  for (const line of headings.split('\n')) {
    const open = fence === null ? FENCE_OPEN.exec(line) : null;
    if (html) {
      if (line.trim() === '') html = false;
    } else if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
    } else if (open !== null) fence = open[1] ?? open[2];
    else if (HTML_BLOCK_TAG.test(line) || (blank && HTML_LONE_TAG.test(line))) html = true;
    else if (line.startsWith('## ')) {
      if (start >= 0) return { start, end: at };
      if (line === `## ${title}`) start = at;
    }
    blank = line.trim() === '';
    at += line.length + 1;
  }
  if (start < 0)
    throw new Error(`sizing: ${doc} no longer has the section whose figures are generated`);
  return { start, end: text.length };
}
/**
 * A number alone in a hand-written table cell, whose unit its header or its row gives: on a page whose figures are
 * all generated, it is a figure like any other. Code is not a table, so a pipe in a code block is not read as one.
 */
function tableFigure(text) {
  for (const line of blocks(text).split('\n')) {
    if (!/^ {0,3}\|/.test(line)) continue;
    for (const cell of line.split('|')) {
      const m = /^\s*(\d(?:[\d,.]*\d)?)\s*$/.exec(prose(cell));
      if (m !== null) return [m[1]];
    }
  }
  return null;
}
/** The first figure in a page's prose that nothing checks, and where it stands, or null. */
function proseFigure(doc, text) {
  const scope = GENERATED_PROSE[doc];
  const { text: blank, at } = blankRegions(doc, text);
  if (scope === null) {
    const hit = figureIn(prose(blank)) ?? tableFigure(blank);
    return hit === null ? null : { figure: hit[0], where: 'outside its SIZING regions' };
  }
  const { start, end } = sectionOf(doc, blank, scope.section);
  for (const [name, { i, j }] of Object.entries(at)) {
    if (i < start || j > end) {
      throw new Error(
        `sizing: ${doc}'s ${name} region sits outside its "${scope.section}" section`,
      );
    }
  }
  const inside = figureIn(prose(blank.slice(start, end)));
  if (inside !== null) {
    return {
      figure: inside[0],
      where: `outside its SIZING regions, in its "${scope.section}" section`,
    };
  }
  let rest = prose(blank.slice(0, start) + blank.slice(end));
  for (const phrase of scope.elsewhere) {
    if (!rest.includes(phrase)) {
      throw new Error(
        `sizing: ${doc} no longer says "${phrase}", which GENERATED_PROSE lets it say outside its ` +
          `"${scope.section}" section: take it off that list`,
      );
    }
    rest = rest.replace(phrase, ' '); // once: a second copy is a figure like any other
  }
  const m = new RegExp(SHARE_OR_MULTIPLE.join('|'), 'i').exec(rest);
  return m === null
    ? null
    : {
        figure: m[0],
        where: `outside its "${scope.section}" section, which lists what may stand there`,
      };
}
/**
 * The images under bench/ a page shows: in a markdown image, an <img> or a <source srcset>, in any case and however
 * its path is spelled, since `bench/%68and.SVG`, `bench&#47;hand.svg` and `bench/hand\.svg` are images a browser
 * shows too. A path with a space in it is not read.
 */
const shownCharts = (text) => [
  ...new Set(
    decodeEntities(
      text.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16))),
      (c) => c,
    )
      .replace(/\\([!-/:-@[-`{-~])/g, '$1')
      .match(/\bbench\/[\p{L}\p{N}_./~+@()-]+\.(?:svg|png|jpe?g|webp|gif|avif)\b/giu) ?? [],
  ),
];

const rendered = render();
// A figure that failed to compute must not reach a page as a word.
for (const [name, text] of Object.entries(rendered)) {
  const bad = /\b(?:NaN|undefined|null|Infinity)\b/.exec(text);
  if (bad !== null) throw new Error(`sizing: region ${name} renders "${bad[0]}"`);
}
const claimed = Object.values(DOCS).flat();
for (const name of Object.keys(rendered)) {
  if (claimed.filter((n) => n === name).length !== 1) {
    throw new Error(`sizing: region ${name} must be written into exactly one page in DOCS`);
  }
}
for (const name of claimed) {
  if (rendered[name] === undefined)
    throw new Error(`sizing: DOCS lists ${name}, which nothing renders`);
}
const check = process.argv.includes('--check');
// A region in a page DOCS does not list would never be written or checked, so every tracked page is looked at — in
// every format a page here is written in. The check needs git; a write from a tarball warns and goes on.
let tracked = [];
try {
  tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.md', '*.mdx', '*.html', '*.htm', '*.txt'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter((doc) => doc !== '' && DOCS[doc] === undefined && fs.existsSync(path.join(ROOT, doc)));
} catch (err) {
  if (check) throw err;
  console.warn('  (not a git checkout: pages outside DOCS were not scanned for SIZING markers)');
}
for (const doc of tracked) {
  if (markersOf(doc, fs.readFileSync(path.join(ROOT, doc), 'utf8')).length > 0) {
    throw new Error(
      `sizing: ${doc} holds SIZING regions, but DOCS does not list it, so nothing writes them`,
    );
  }
}
const stale = [];
for (const [doc, names] of Object.entries(DOCS)) {
  const file = path.join(ROOT, doc);
  // Line endings are not content: a checkout that turns them into CRLF must not fail the check.
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const next = withRegions(doc, text, Object.fromEntries(names.map((n) => [n, rendered[n]])), DOCS);
  const figure = GENERATED_PROSE[doc] === undefined ? null : proseFigure(doc, next.text);
  if (figure !== null) {
    throw new Error(
      `sizing: ${doc} states "${figure.figure}" ${figure.where}, where no gate compares it with the ` +
        'estimator — generate it into a region',
    );
  }
  for (const chart of shownCharts(next.text)) {
    // The benchmarks chart is drawn and checked by bench/run.cjs; every other chart a page shows, by this script.
    if (chart !== 'bench/crossover.svg' && !CHARTS.includes(chart)) {
      throw new Error(
        `sizing: ${doc} shows ${chart}, which no generator draws, so no check compares it`,
      );
    }
  }
  if (check) {
    if (next.text !== text) stale.push(`${doc} (${next.changed.join(', ')})`);
  } else {
    fs.writeFileSync(file, next.text);
    console.log(`  wrote ${doc}`);
  }
}
const drawn = charts();
{
  const unlisted = Object.keys(drawn).filter((c) => !CHARTS.includes(c));
  const undrawn = CHARTS.filter((c) => drawn[c] === undefined);
  if (unlisted.length > 0 || undrawn.length > 0) {
    throw new Error(
      `sizing: the charts drawn are not the ones CHARTS lists: drawn but not listed [${unlisted.join(', ')}], ` +
        `listed but not drawn [${undrawn.join(', ')}]`,
    );
  }
}
for (const [rel, svg] of Object.entries(drawn)) {
  const file = path.join(ROOT, rel);
  if (check) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (now !== svg) stale.push(rel);
  } else {
    fs.writeFileSync(file, svg);
    console.log(`  wrote ${rel}`);
  }
}
if (check) {
  if (stale.length > 0) {
    console.error(
      `bench:sizing:check: these generated regions and charts are not what the shipped estimator and the library's ` +
        `defaults give: ${stale.join('; ')}. Run \`pnpm bench:sizing\` rather than editing them by hand.`,
    );
    process.exit(1);
  }
  console.log(
    `bench:sizing:check: every generated figure in ${Object.keys(DOCS).join(', ')}, and the charts ` +
      `${CHARTS.join(', ')}, is current, and no figure stands outside a region.`,
  );
}
