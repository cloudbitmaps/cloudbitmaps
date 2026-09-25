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
 * `require()` loads @cloudbitmaps/roaring, which ships ESM only, through Node's `require(esm)`, as bench/run.cjs does.
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
} = require('@cloudbitmaps/roaring');

const ROOT = path.resolve(__dirname, '..');
/** Each page this script writes, and the generated regions it holds: every region lives in exactly one page. */
const DOCS = {
  'docs/guide/sizing.md': [
    'SHAPE',
    'REFRESH',
    'INPUTS',
    'READERS',
    'BILL',
    'REDIS',
    'HEADROOM',
    'OVERLAP',
    'OVERLAP_NOTE',
    'LEVERS',
    'PREFIX',
    'SAMPLE',
  ],
  'docs/guide/getting-started.md': ['GUIDE_EXAMPLE', 'COMPARES', 'ONE_CLUSTER'],
};
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
const GIB = 1024 ** 3;
/** Small counts as words, as the guide writes them. */
const words = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);

/** A library default, read from its source so a change to it changes this page. */
function sourceConstant(rel, name) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = new RegExp(`const ${name} = ([\\d_ *]+);`).exec(text);
  if (m === null) throw new Error(`sizing: could not read ${name} from ${rel} — did it move?`);
  return m[1]
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
/** The estimator's month, read from it: AWS's 730 hours. */
const HOURS_PER_MONTH = sourceConstant('packages/core/src/core/cost.ts', 'HOURS_PER_MONTH');
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

/** PUT-class requests one object write makes on S3: one PUT, or initiate + the parts + complete. */
function writeRequests(objectBytes) {
  const parts = Math.ceil(objectBytes / S3_PART_BYTES);
  return parts <= 1 ? 1 : parts + 2;
}

/** AWS's documented request rate per partitioned prefix, for GETs: at least this many a second. Not ours to check. */
const S3_PREFIX_GETS_PER_SEC = 5500;
/** ElastiCache's default quota of nodes in one cluster, which AWS raises on request up to 500. Not ours to check. */
const DEFAULT_NODES_PER_CLUSTER = 90;

/**
 * The shape every segment has: the calibration run's, about 2,000 chunks, and each cold intersect sharing 100 of them
 * with its other operand, so `chunksPerIntersect` is 200. A larger segment is modelled as holding its ids more densely,
 * not as sharing more chunks — the most favourable choice for large segments, which the overlap table below undoes.
 */
const CHUNKS_PER_SEGMENT = 2000;
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
  });
  return Math.round(
    r.monthlyUSD.byOp.intersects / ((SECONDS_PER_MONTH * P.storage.getPerMillion) / 1e6),
  );
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
  return null;
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────
const int = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) =>
  n < 0.005
    ? 'under $0.01'
    : n >= 100
      ? `$${Math.round(n).toLocaleString('en-US')}`
      : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bytes = (n) =>
  n >= 1e12 ? `${int(n / 1e12)} TB` : n >= 1e9 ? `${int(n / 1e9)} GB` : `${int(n / 1e6)} MB`;
const mib = (n) => `${int(n / MIB)} MiB`;
const pct = (x) => `${Math.round(x * 100)}%`;
/** A share to two significant figures, for the small ones a whole percent would round to nothing. */
const share = (x) => (x >= 1 ? '100%' : `${Number((x * 100).toPrecision(2))}%`);
/** How a bill compares with the Redis that holds the same data. */
const versus = (total, redis) =>
  total < redis
    ? `${Math.round((1 - total / redis) * 100)}% less`
    : `${(total / redis).toFixed(1)}× more`;
/** "3 × r6g.xlarge", or "285 × r6g.xlarge, 95 shards". */
function clusterLabel(b) {
  const { nodeType, shards, nodes } = b.cluster;
  const node = nodeType.replace(/^cache\./, '');
  return shards === 1 ? `${nodes} × ${node}` : `${nodes} × ${node}, ${shards} shards`;
}
/** "1 shard of 3 cache.r6g.xlarge nodes", or "95 shards, 285 cache.r6g.xlarge nodes", as the estimator says it. */
function clusterWords(b) {
  const { nodeType, shards, nodes } = b.cluster;
  const all = `${int(nodes)} ${nodeType} node${nodes === 1 ? '' : 's'}`;
  return shards === 1 ? `1 shard of ${all}` : `${int(shards)} shards, ${all}`;
}
/** A rate a second, to two significant figures below one, and one decimal below ten. */
const rate = (n) => (n < 1 ? n.toPrecision(2) : n < 10 ? n.toFixed(1) : int(n));
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
  const redis =
    `Each deployment's Redis is the cheapest cluster that holds its data at its compressed size, at the prices ` +
    `the estimator ships (${CATALOGUE.source}): every shard a primary and ${int(CATALOGUE.replicasPerShard)} ` +
    `replicas, with ${pct(CATALOGUE.reservedMemoryFraction)} of each node's memory reserved, as ElastiCache does ` +
    'by default. ' +
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

  const headroom = [
    '| | cold intersects a second | where the bill meets its Redis | headroom |',
    '|---|---:|---:|---:|',
    ...PROFILES.map((p) => {
      const now = p.intersectsPerMonth / SECONDS_PER_MONTH;
      const even = breakEvenRate(p);
      return `| **${p.name}** | ${rate(now)} | ${rate(even)} | ${Math.round(even / now)}× |`;
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
    'holding its ids more densely, not as sharing more chunks, which is the most favourable choice for large ' +
    'segments; [the overlap table](#how-much-the-overlap-matters) undoes it. **Hot segments** are the ones a ' +
    'long-lived reader keeps open, each reader its own; the last column is how often one reader reads each of them, ' +
    `with the point reads spread evenly. ${multipart.join(' ')}`;
  const refresh =
    "- **The pointer refresh.** A reader re-reads a segment's pointer on its first read of it after " +
    `\`cache.genTtlMs\` has passed, ${ttlLabel(GEN_TTL_MS)} by default. Here each reader reads each hot segment ` +
    `only every ${secs(readEverySec(byId('large')))}, so at the default every point read re-reads a pointer, and the ` +
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
  // that miss the cache. Pointer reads, one an operand, go to the registry's own prefix beside it: an intersect
  // that shares no chunks makes only its operands' pointer and tail reads, so half of those are pointer reads.
  const pointerGets = intersectGets(0) / 2;
  const dataGets =
    (large.intersectsPerMonth / SECONDS_PER_MONTH) * (intersectGets(SHARED_CHUNKS) - pointerGets) +
    large.readsPerSec * (1 - large.cacheHitRate);
  const prefix =
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
    `report.redisBaseline; // ${usd(redisOf(medium).monthlyUSD)} a month: ${clusterWords(redisOf(medium))}`,
    'report.assumptions.notes; // what it modeled, and what it did not',
    '```',
  ];

  // The guide's examples of what the default prices: three data sizes, alone, with no workload.
  const at = (sizeBytes) => estimateCost({ segments: [{ sizeBytes }] }).redisBaseline;
  const example = (label, b) =>
    `${label} as ${words(b.cluster.nodes)} \`${b.cluster.nodeType}\` nodes at ${usd(b.monthlyUSD)} a month`;
  const [s200, m20, l2] = [200 * MB, 20e9, 2e12].map(at);
  const compares =
    `So ${example('200 MB is priced', s200)}, ${example('20 GB', m20)}, and ${example('2 TB', l2)}` +
    (l2.cluster.dataTiering
      ? ': a data-tiering node, which keeps the values read least recently on its SSD.'
      : '.');
  // The one cluster the benchmarks page charts, beside the catalogue's node with the same memory.
  const m6g = CATALOGUE.nodeTypes.find((n) => n.name === 'cache.m6g.large');
  if (m6g === undefined)
    throw new Error('sizing: the catalogue has no cache.m6g.large — rewrite ONE_CLUSTER');
  const shardNodes = 1 + CATALOGUE.replicasPerShard;
  const oneCluster =
    '`ONE_REDIS_HA_CLUSTER` is the one the benchmarks page charts: a primary and two replicas of ' +
    `\`cache.m7g.large\`, $${int(ONE_REDIS_HA_CLUSTER.monthlyUSD)} a month. The catalogue leaves that node type ` +
    `out, since ${words(shardNodes)} \`cache.m6g.large\` with the same memory cost ` +
    `${usd(shardNodes * m6g.hourlyUSD * HOURS_PER_MONTH)}, so it is a fixed point to compare with, not a price ` +
    'the estimator picks.';

  // The guide's planning example: its inputs are the guide's, and every figure in its comments is the estimator's.
  const guide = {
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
  const g = estimateCost(guide);
  const uncached = estimateCost({ ...guide, workload: { ...guide.workload, cacheHitRate: 0 } });
  const w = guide.workload;
  const [seg] = guide.segments;
  const approx = (n) => `≈${Number(n.toPrecision(3))}`;
  const o = g.monthlyUSD.byOp;
  const stored = (seg.sizeBytes * seg.count) / GIB;
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
    `    chunksPerIntersect: ${w.chunksPerIntersect}, // the chunks it fetches: 2 operands × ${w.chunksPerIntersect / 2} shared chunks`,
    `    loadsPerMonth: ${w.loadsPerMonth}, // one store.load() a day, single-part`,
    `    hotSegments: ${w.hotSegments}, // segments a long-lived reader keeps reading: each refreshes its pointer every ${ttlLabel(GEN_TTL_MS)}`,
    '  },',
    '});',
    `report.monthlyUSD.byOp; // { reads: ${approx(o.reads)}, intersects: ${approx(o.intersects)}, storage: ${approx(o.storage)}, loads: ${approx(o.loads)}, pointerRefresh: ${approx(o.pointerRefresh)} }`,
    `report.monthlyUSD.total; // ${approx(g.monthlyUSD.total)}`,
    `report.redisBaseline; // $${g.redisBaseline.monthlyUSD.toFixed(2)} a month: the cheapest Redis that holds ${stored.toFixed(2)} GiB, ${clusterWords(g.redisBaseline)}`,
    `report.verdict; // '${g.verdict}' — 'win-big' | 'win' | 'lose-zone', never hides the lose case`,
    `report.redisCrossover.readsPerSec; // ≈ ${int(g.redisCrossover.readsPerSec)} sustained reads/s at THIS report's ${pct(w.cacheHitRate)} cache-hit rate (≈ ${int(uncached.redisCrossover.readsPerSec)} at 0%)`,
    '```',
  ];

  return {
    GUIDE_EXAMPLE: guideExample.join('\n'),
    COMPARES: compares,
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

// ── write / check ────────────────────────────────────────────────────────────────────────────────────
/** Any comment that opens with SIZING, however it is cased or spaced. Only the strict form is ever written. */
const ANY_MARKER = /<!--\s*sizing\b[\s\S]*?-->/gi;
const MARKER = /^<!-- SIZING:([A-Z][A-Z0-9_]*):(START|END) -->$/;

/** A page's markers, in order. A malformed one throws: no check would ever compare the region it meant. */
function markersOf(doc, text) {
  return [...text.matchAll(ANY_MARKER)].map((m) => {
    const strict = MARKER.exec(m[0]);
    if (strict === null) {
      throw new Error(
        `${doc}: malformed marker ${JSON.stringify(m[0])} — write <!-- SIZING:NAME:START --> or ` +
          '<!-- SIZING:NAME:END --> exactly',
      );
    }
    return { name: strict[1], edge: strict[2], at: m.index, end: m.index + m[0].length };
  });
}

function regionsOf(doc, text, names) {
  const markers = markersOf(doc, text);
  const out = {};
  // Markers pair up in order, a START and then the END of the same name: a region inside another, or two that
  // overlap, would be written one over the other.
  for (let n = 0; n < markers.length; n += 2) {
    const open = markers[n];
    const close = markers[n + 1];
    if (open.edge !== 'START' || close?.edge !== 'END' || close.name !== open.name) {
      throw new Error(
        `${doc}: SIZING markers must pair up in order, each START with the END of its name, never nested or ` +
          `overlapping (at SIZING:${open.name}:${open.edge})`,
      );
    }
    if (!names.includes(open.name)) {
      throw new Error(`${doc} holds a SIZING:${open.name} region nothing writes`);
    }
    // Exactly one of each: a second copy is one this check would never compare.
    if (out[open.name] !== undefined) {
      throw new Error(`${doc} must hold exactly one SIZING:${open.name} region`);
    }
    // A region inside a list item is indented with it; the table must be too, or it ends the list.
    const indent = text.slice(text.lastIndexOf('\n', open.at) + 1, open.at);
    out[open.name] = { i: open.end, j: close.at, indent };
  }
  for (const name of names) {
    if (out[name] === undefined)
      throw new Error(`${doc} must hold exactly one SIZING:${name} region`);
  }
  return out;
}

function withRegions(doc, text, rendered) {
  const at = regionsOf(doc, text, Object.keys(rendered));
  let s = text;
  // Replace from the last region back, so earlier offsets stay valid.
  for (const name of Object.keys(at).sort((a, b) => at[b].i - at[a].i)) {
    const { i, j, indent } = at[name];
    const body = rendered[name]
      .split('\n')
      .map((line) => (line === '' ? line : indent + line))
      .join('\n');
    s = s.slice(0, i) + '\n' + body + '\n' + indent + s.slice(j);
  }
  return s;
}

const rendered = render();
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
// A region in a page DOCS does not list would never be written or checked: every tracked page is looked at.
const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.html'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter((doc) => doc !== '' && DOCS[doc] === undefined && fs.existsSync(path.join(ROOT, doc)));
for (const doc of tracked) {
  if (markersOf(doc, fs.readFileSync(path.join(ROOT, doc), 'utf8')).length > 0) {
    throw new Error(
      `sizing: ${doc} holds SIZING regions, but DOCS does not list it, so nothing writes them`,
    );
  }
}
const check = process.argv.includes('--check');
let stale = [];
for (const [doc, names] of Object.entries(DOCS)) {
  const file = path.join(ROOT, doc);
  // Line endings are not content: a checkout that turns them into CRLF must not fail the check.
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const next = withRegions(doc, text, Object.fromEntries(names.map((n) => [n, rendered[n]])));
  if (check) {
    if (next !== text) stale.push(doc);
  } else {
    fs.writeFileSync(file, next);
    console.log(`  wrote ${doc}`);
  }
}
if (check) {
  if (stale.length > 0) {
    console.error(
      `bench:sizing:check: the generated figures in ${stale.join(', ')} are not what the shipped estimator and ` +
        "the library's defaults give. Run `pnpm bench:sizing` rather than editing them by hand.",
    );
    process.exit(1);
  }
  console.log(
    `bench:sizing:check: every generated figure in ${Object.keys(DOCS).join(', ')} is current.`,
  );
}
