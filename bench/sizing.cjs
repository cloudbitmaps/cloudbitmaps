/*
 * What CloudBitmaps costs a small, a medium and a large deployment — three illustrative workloads, priced by the
 * SHIPPED estimator (`estimateCost`) at the default pricing, and written into `docs/guide/sizing.md`.
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
const fs = require('node:fs');
const path = require('node:path');
const { estimateCost, AWS_US_EAST_1_ONDEMAND } = require('@cloudbitmaps/roaring');

const ROOT = path.resolve(__dirname, '..');
const DOC = 'docs/guide/sizing.md';
const P = AWS_US_EAST_1_ONDEMAND;
const REDIS = P.redis.monthlyUSD;
const SECONDS_PER_MONTH = 730 * 3600; // the estimator's convention
const MB = 1_000_000;
const MIB = 1024 * 1024;

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

/** PUT-class requests one object write makes on S3: one PUT, or initiate + the parts + complete. */
function writeRequests(objectBytes) {
  const parts = Math.ceil(objectBytes / S3_PART_BYTES);
  return parts <= 1 ? 1 : parts + 2;
}

/** AWS's documented request rate per partitioned prefix, for GETs: at least this many a second. Not ours to check. */
const S3_PREFIX_GETS_PER_SEC = 5500;

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

function price(p, options) {
  return estimateCost({
    segments: [{ sizeBytes: p.segmentBytes, count: p.segments }],
    workload: workloadOf(p, options),
  });
}

/** How often one reader reads one of its hot segments, in seconds, with the point reads spread evenly. */
const readEverySec = (p) => (p.hotPerProcess * p.readerProcesses) / p.readsPerSec;

/** The smallest number of shared chunks at which a profile's bill passes the cluster's price. */
function breakEvenShared(p) {
  for (let k = 1; k <= CHUNKS_PER_SEGMENT; k++) {
    if (price(p, { shared: k }).monthlyUSD.total > REDIS) return k;
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
const share = (x) => (x >= 1 ? `${x.toFixed(1)}×` : `${x < 0.01 ? '<1' : Math.round(x * 100)}%`);
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
    `| | index a reader holds open | against the default \`cache.readerMaxBytes\` (${mib(READER_MAX_BYTES)}) | chunks in its hot set | against the default \`cache.maxChunks\` (${int(CACHE_MAX_CHUNKS)}) |`,
    '|---|---:|---|---:|---|',
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
        `${int(Math.round(chunks / CACHE_MAX_CHUNKS))}× it |`
      );
    }),
  ];

  const bill = [
    `| | cold intersects | point reads | pointer refresh | loads | storage | **a month** | against one $${int(REDIS)} Redis-HA cluster |`,
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...PROFILES.map((p) => {
      const r = price(p);
      const o = r.monthlyUSD.byOp;
      return (
        `| **${p.name}** | ${usd(o.intersects)} | ${usd(o.reads)} | ${usd(o.pointerRefresh)} | ` +
        `${usd(o.loads)} | ${usd(o.storage)} | **${usd(r.monthlyUSD.total)}** | ${share(r.monthlyUSD.total / REDIS)} |`
      );
    }),
  ];

  const overlaps = [SHARED_CHUNKS, 1000, CHUNKS_PER_SEGMENT];
  const overlap = [
    `| shared chunks, of ${int(CHUNKS_PER_SEGMENT)} | GETs a cold intersect | ${['medium', 'large'].map((id) => `${byId(id).name}, a month`).join(' | ')} |`,
    '|---:|---:|---:|---:|',
    ...overlaps.map((k) => {
      const cells = ['medium', 'large'].map((id) => {
        const r = price(byId(id), { shared: k });
        return `${usd(r.monthlyUSD.total)} (${share(r.monthlyUSD.total / REDIS)})`;
      });
      return `| ${int(k)}${k === SHARED_CHUNKS ? ' (the tables above)' : ''} | ${int(4 + 2 * k)} | ${cells.join(' | ')} |`;
    }),
  ];
  const breakEven = breakEvenShared(byId('medium'));
  const overlapNote =
    `The medium deployment's bill passes the cluster's price at **${int(breakEven)} shared chunks**, ` +
    `about ${pct(breakEven / CHUNKS_PER_SEGMENT)} of a segment's.`;

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
    '| `cache.genTtlMs` | pointer refresh | **a month** |',
    '|---|---:|---:|',
    ...ttls.map((ttl) => {
      const r = price(large, { genTtlMs: ttl === GEN_TTL_MS ? undefined : ttl });
      const label = ttl === GEN_TTL_MS ? `${ttlLabel(ttl)}, the default` : ttlLabel(ttl);
      return `| ${label} | ${usd(r.monthlyUSD.byOp.pointerRefresh)} | **${usd(r.monthlyUSD.total)}** |`;
    }),
  ];

  // The large deployment's GETs a second on its one data prefix: every chunk and tail read, and the point reads
  // that miss the cache. Pointer reads go to the registry's own prefix, beside it.
  const dataGets =
    (large.intersectsPerMonth / SECONDS_PER_MONTH) * (2 * SHARED_CHUNKS + 2) +
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
    'report.assumptions.notes; // what it modeled, and what it did not',
    '```',
  ];

  return {
    SHAPE: shape,
    REFRESH: refresh,
    INPUTS: inputs.join('\n'),
    READERS: readers.join('\n'),
    BILL: bill.join('\n'),
    OVERLAP: overlap.join('\n'),
    OVERLAP_NOTE: overlapNote,
    LEVERS: levers.join('\n'),
    PREFIX: prefix,
    SAMPLE: sample.join('\n'),
  };
}

// ── write / check ────────────────────────────────────────────────────────────────────────────────────
function regionsOf(text, names) {
  const out = {};
  for (const name of names) {
    const start = `<!-- SIZING:${name}:START -->`;
    const end = `<!-- SIZING:${name}:END -->`;
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    // Exactly one of each: a second copy is one this check would never compare.
    if (
      i === -1 ||
      j === -1 ||
      j < i ||
      text.indexOf(start, i + 1) !== -1 ||
      text.indexOf(end, j + 1) !== -1
    ) {
      throw new Error(`${DOC} must hold exactly one SIZING:${name} region`);
    }
    // A region inside a list item is indented with it; the table must be too, or it ends the list.
    const indent = text.slice(text.lastIndexOf('\n', i) + 1, i);
    out[name] = { i: i + start.length, j, indent };
  }
  return out;
}

function withRegions(text, rendered) {
  const at = regionsOf(text, Object.keys(rendered));
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

const file = path.join(ROOT, DOC);
// Line endings are not content: a checkout that turns them into CRLF must not fail the check.
const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const next = withRegions(text, render());
if (process.argv.includes('--check')) {
  if (next !== text) {
    console.error(
      `bench:sizing:check: the generated figures in ${DOC} are not what the shipped estimator and the library's ` +
        'defaults give. Run `pnpm bench:sizing` rather than editing them by hand.',
    );
    process.exit(1);
  }
  console.log(`bench:sizing:check: every generated figure in ${DOC} is current.`);
} else {
  fs.writeFileSync(file, next);
  console.log(`  wrote ${DOC}`);
}
