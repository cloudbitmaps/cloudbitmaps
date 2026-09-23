'use strict';
/*
 * The figures a real-cloud calibration run lets this project publish — each one DERIVED from the run's evidence
 * file, the pricing profile the run names, and the library's own constants. None is typed in.
 *
 * WHY THIS EXISTS. A run report is the one document whose numbers a reader cannot check for themselves: they come
 * from a bill for a run nobody else saw. So the report, and every page that quotes the run, is held to the evidence
 * by `tests/docs/calibration-reports.test.ts` in both directions: each headline figure must appear, and no dollar
 * amount, percentage, duration or byte size may appear that this module cannot derive. `scripts/site-figures.cjs`
 * uses the same derivation, so the site and the report cannot disagree about a run.
 *
 * THREE KINDS OF FIGURE, and the report labels each.
 *   measured  straight from the evidence: request counts by command, bytes, chunk counts, timings.
 *   derived   measured counts times the pricing profile's list prices, or arithmetic over measured counts.
 *   expected  what the code predicts for a case the run did not measure, such as the same intersect inside the
 *             region. Each is computed from measured parts; the report says which ones.
 *
 * AND IT REFUSES EVIDENCE THAT DOES NOT ADD UP. Before anything is derived, the file must be a complete real run
 * whose parts reconcile: the per-command counts sum to the billed classes, the prices reproduce the recorded cost,
 * the chunk reads match the planned layout, and the tail read is the library's own. A figure derived from a file
 * that fails any of those would be a figure about a run that did not happen the way the file says.
 */
const fs = require('node:fs');
const path = require('node:path');

const { classify } = require('./aws-meter.cjs');
const { planLayout, DEFAULT_LAYOUT } = require('./calibrate-guards.cjs');

/**
 * The library constants a run's figures depend on, read out of the source rather than restated, so a change to one
 * changes the figures it moves and fails the reports that quoted the old ones.
 */
function readSources(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const need = (re, text, what) => {
    const m = re.exec(text);
    if (m === null)
      throw new Error(`calibration-figures: could not read ${what} — did its source move?`);
    return m;
  };
  const cost = read('packages/core/src/core/cost.ts');
  const format = read('packages/core/src/core/crbm/format.ts');
  const source = read('packages/core/src/core/crbm-storage-source.ts');
  const profile = need(
    /name:\s*'([\w-]+)',\s*storage:\s*\{\s*getPerMillion:\s*([\d.]+),\s*putPerMillion:\s*([\d.]+),\s*storagePerGiBMonth:\s*([\d.]+)\s*\},\s*redis:\s*\{\s*monthlyUSD:\s*(\d+)\s*\}/,
    cost,
    'the default pricing profile in packages/core/src/core/cost.ts',
  );
  const month = need(/const SECONDS_PER_MONTH = (\d+) \* (\d+);/, cost, 'SECONDS_PER_MONTH');
  const tail = need(
    /export const DEFAULT_TAIL_BYTES = (\d+) \* (\d+);/,
    format,
    'DEFAULT_TAIL_BYTES',
  );
  const footer = need(/export const FOOTER_BYTES = (\d+);/, format, 'FOOTER_BYTES');
  const preamble = need(/export const PREAMBLE_BYTES = (\d+);/, format, 'PREAMBLE_BYTES');
  const ttl = need(
    /const DEFAULT_CURRENT_GEN_TTL_MS = (\d+);/,
    source,
    'DEFAULT_CURRENT_GEN_TTL_MS',
  );
  return {
    pricing: {
      name: profile[1],
      getPerMillion: Number(profile[2]),
      putPerMillion: Number(profile[3]),
      storagePerGiBMonth: Number(profile[4]),
      redisMonthlyUSD: Number(profile[5]),
    },
    secondsPerMonth: Number(month[1]) * Number(month[2]),
    tailBytes: Number(tail[1]) * Number(tail[2]),
    footerBytes: Number(footer[1]),
    preambleBytes: Number(preamble[1]),
    genTtlMs: Number(ttl[1]),
  };
}

/** Every committed run, oldest first. The id starts with the date, so its order is the run order. */
function evidenceFiles(root) {
  const dir = path.join(root, 'bench', 'calibration');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join('bench', 'calibration', f));
}

const GIB = 1024 ** 3;

// ── formatting, for the anchors a page must state verbatim ──────────────────────────────────────────────────────
const int = (n) => Math.round(n).toLocaleString('en-US');
const fixed = (n, dp) =>
  n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usd = (n, dp) => `$${fixed(n, dp)}`;
const pct = (fraction, dp) => `${fixed(100 * fraction, dp)}%`;

/**
 * Everything a run lets a page state, from one evidence file. Throws when the file is not evidence of a complete,
 * self-consistent real run — see the header.
 */
function derive(run, src) {
  const problems = [];
  const check = (ok, what) => {
    if (!ok) problems.push(what);
  };
  check(run.mode === 'run' && run.target === 'aws', 'it is not a real run against AWS');
  check(
    run.partial === false && run.interrupted !== true && run.error === undefined,
    'the run did not finish',
  );
  check(run.projectionExceeded === undefined, 'the run exceeded its own projection');
  check(
    run.pricing === src.pricing.name,
    `it was priced with "${run.pricing}", which is not the library's profile "${src.pricing.name}"`,
  );
  if (problems.length > 0) {
    throw new Error(`calibration evidence ${run.runId}: ${problems.join('; ')}`);
  }

  const w = run.workload;
  const it = run.phases.intersect;
  const single = run.phases.load.singlePart;
  const multi = run.phases.load.multipart;
  const ops = run.cost.ops;
  const cmd = ops.byCommand;
  const rd = ops.reads;
  const n = (name) => cmd[name] ?? 0;
  const getUSD = src.pricing.getPerMillion / 1e6;
  const putUSD = src.pricing.putPerMillion / 1e6;

  // ── the evidence has to reconcile with itself ───────────────────────────────────────────────────────────────
  const byClass = { put: 0, get: 0, free: 0 };
  for (const [name, count] of Object.entries(cmd)) byClass[classify(name)] += count;
  check(
    byClass.put === ops.put && byClass.get === ops.get && byClass.free === (ops.free ?? 0),
    `its per-command counts (${byClass.put} PUT-class, ${byClass.get} GET-class) do not sum to the billed ` +
      `classes (${ops.put}, ${ops.get})`,
  );
  const priced = ops.put * putUSD + ops.get * getUSD;
  check(
    Math.abs(priced - run.cost.totalUSD) < 1e-12,
    `its requests at today's prices come to $${priced}, not the $${run.cost.totalUSD} it recorded — ` +
      'the pricing profile changed, so every dollar figure derived from it would be restated at new prices',
  );
  const layout = planLayout({
    segments: w.segments,
    idsPerSegment: w.idsPerSegment,
    ...DEFAULT_LAYOUT,
  });
  check(
    layout.chunksPerSegment === w.chunksPerSegment && layout.sharedChunks === w.sharedChunks,
    `its workload (${w.chunksPerSegment} chunks, ${w.sharedChunks} shared) is not the harness's layout ` +
      `(${layout.chunksPerSegment}, ${layout.sharedChunks})`,
  );
  const operandReads = 2 * it.runs;
  check(
    rd.range.n === operandReads * it.chunksFetchedPerOperand &&
      it.chunksFetchedPerOperand === w.sharedChunks,
    `its chunk reads (${rd.range.n}) are not ${w.sharedChunks} per operand of ${it.runs} intersects`,
  );
  check(
    rd.suffix.n === operandReads && it.tailReadBytesPerOperand === src.tailBytes,
    `its tail reads are not one of the library's ${src.tailBytes} bytes per operand`,
  );
  const loads = single.runs + multi.runs;
  const loadGets = n('GetObjectCommand') - (rd.whole.n + rd.suffix.n + rd.range.n);
  check(
    loads > 0 && loadGets % loads === 0,
    `its ${loadGets} uncategorised reads do not divide evenly across ${loads} loads`,
  );
  check(
    n('PutObjectCommand') === 2 * single.runs + multi.runs &&
      n('CreateMultipartUploadCommand') === multi.runs &&
      n('CompleteMultipartUploadCommand') === multi.runs,
    'its PUTs are not one object and one pointer per load',
  );
  if (problems.length > 0) {
    throw new Error(`calibration evidence ${run.runId}: ${problems.join('; ')}`);
  }

  // ── requests ────────────────────────────────────────────────────────────────────────────────────────────────
  const getsPerLoad = loadGets / loads;
  const partsPerMultipart = n('UploadPartCommand') / multi.runs;
  const putsPerSingle = 2; // the object, then the pointer — reconciled above
  const putsPerMultipart = 2 + partsPerMultipart + 1; // create, the parts, complete — then the pointer
  const chunksPerOperand = it.chunksFetchedPerOperand;
  const tailPerOperand = rd.suffix.n / operandReads;
  // Expected, from measured parts: each operand's pointer read once, as the library does when an intersect ends
  // inside its pointer refresh (`genTtlMs`) — which one inside the region does, and which the harness now pins.
  const fixedGets = 2 * (1 + tailPerOperand);
  const coldGets = (k) => fixedGets + 2 * k;
  const expectedGets = coldGets(chunksPerOperand);
  const measuredGets = it.medianGets;
  const meanGets = (rd.whole.n + rd.suffix.n + rd.range.n) / it.runs;

  // ── bytes ───────────────────────────────────────────────────────────────────────────────────────────────────
  const object = single.medianObjectBytes;
  const objects = 2 * object;
  const chunkBytesPerRead = rd.range.bytes / rd.range.n;
  const chunkBytes = rd.range.bytes / it.runs;
  const tailBytes = rd.suffix.bytes / it.runs;
  const pointerBytesPerRead = rd.whole.bytes / rd.whole.n;
  const pointerBytes = rd.whole.bytes / it.runs;
  const fetched = chunkBytes + tailBytes + pointerBytes;
  check(
    Math.abs(chunkBytes / objects - it.payloadFraction) < 1e-9,
    'its payload fraction is not its chunk bytes over the two objects',
  );

  // A roaring chunk of at most 4,096 ids is one array container: a 16-byte portable header, then 2 bytes an id.
  // Checked against the chunk bytes the run actually read before anything leans on it — and only then is the
  // index size derived, as the object minus its preamble, footer and payload.
  const HEADER = 16;
  const PER_ID = 2;
  const payloadOf = (chunks, ids) => HEADER * chunks + PER_ID * ids;
  const arrayChunks = w.idsPerSegment / w.chunksPerSegment <= 4096;
  const formulaHolds =
    arrayChunks && payloadOf(w.sharedChunks, layout.shared) === rd.range.bytes / operandReads;
  const index = formulaHolds
    ? object - src.preambleBytes - src.footerBytes - payloadOf(w.chunksPerSegment, w.idsPerSegment)
    : null;
  const indexPerChunk = index === null ? null : index / w.chunksPerSegment;
  const tailHoldsChunks =
    indexPerChunk === null ? null : Math.floor((src.tailBytes - src.footerBytes) / indexPerChunk);

  // ── money ───────────────────────────────────────────────────────────────────────────────────────────────────
  const cost = (gets, puts = 0) => gets * getUSD + puts * putUSD;
  const intersectUSD = cost(expectedGets);
  const measuredIntersectUSD = cost(measuredGets);
  const singleLoadUSD = cost(getsPerLoad, putsPerSingle);
  const multipartLoadUSD = cost(getsPerLoad, putsPerMultipart);
  const monthUSD = (bytes) => (bytes / GIB) * src.pricing.storagePerGiBMonth;
  const redis = src.pricing.redisMonthlyUSD;
  // One pointer read per segment per refresh window, while the segment is being read — a standing cost of the
  // default refresh that no single cold intersect shows. Expected, from the code's `genTtlMs`.
  const pointerRefreshUSD = (src.secondsPerMonth / (src.genTtlMs / 1000)) * getUSD;
  const K_TABLE = [1, 10, chunksPerOperand, 1000, w.chunksPerSegment];
  const kRows = K_TABLE.map((k) => ({ k, gets: coldGets(k), usd: cost(coldGets(k)) }));

  const f = {
    runId: run.runId,
    date: run.runId.slice(0, 10),
    region: run.region,
    packageVersion: run.measured.packageVersion,
    harness: run.measured.harness,
    node: run.measured.node,
    workload: { ...w, sharedIds: layout.shared, overlap: DEFAULT_LAYOUT.overlap },
    intersects: it.runs,
    exact: it.exact === true && it.cold === true,
    chunksPerOperand,
    chunksPerSegment: w.chunksPerSegment,
    chunksSkipped: w.chunksPerSegment - chunksPerOperand,
    shareFetched: chunksPerOperand / w.chunksPerSegment,
    payloadFraction: it.payloadFraction,
    fixedGets,
    coldGets,
    expectedGets,
    measuredGets,
    meanGets,
    pointerReadsMeasured: it.pointerReadsPerIntersect,
    getsPerLoad,
    putsPerSingle,
    putsPerMultipart,
    partsPerMultipart,
    loads,
    byCommand: { ...cmd },
    ledger: {
      chunkReads: rd.range.n,
      tailReads: rd.suffix.n,
      pointerReads: rd.whole.n,
      loadPointerReads: loadGets,
      headBucket: n('HeadBucketCommand'),
      putObject: n('PutObjectCommand'),
      createMultipart: n('CreateMultipartUploadCommand'),
      uploadPart: n('UploadPartCommand'),
      completeMultipart: n('CompleteMultipartUploadCommand'),
      createBucket: n('CreateBucketCommand'),
      listMultipartUploads: n('ListMultipartUploadsCommand'),
      listObjectVersions: n('ListObjectVersionsCommand'),
      deleteObjects: n('DeleteObjectsCommand'),
      deleteBucket: n('DeleteBucketCommand'),
      put: ops.put,
      get: ops.get,
      free: ops.free ?? 0,
    },
    bytes: {
      object,
      multipartObject: multi.medianObjectBytes,
      objects,
      chunkBytesPerRead,
      chunkBytes,
      tailBytes,
      tailBytesPerRead: src.tailBytes,
      pointerBytesPerRead,
      pointerBytes,
      fetched,
      down: ops.bytesDown,
      up: ops.bytesUp,
      index,
      indexPerChunk,
      payload: payloadOf(w.chunksPerSegment, w.idsPerSegment),
      chunkBytesPerOperand: rd.range.bytes / operandReads,
      arrayHeader: HEADER,
      arrayPerId: PER_ID,
      perIdSingle: object / w.idsPerSegment,
      // Both multipart segments hold the same ids, so the median run's ids and bytes come from one load.
      perIdMultipart: multi.medianBytesPerSec / multi.medianIdsPerSec,
    },
    multipartIds: Math.round(
      (multi.medianObjectBytes * multi.medianIdsPerSec) / multi.medianBytesPerSec,
    ),
    tailHoldsChunks,
    network: {
      rttFloorMs: run.network.rttFloorMs,
      rttMedianMs: run.network.rttMedianMs,
      thresholdMs: run.network.inRegionThresholdMs,
      client: run.network.client,
    },
    latency: {
      p50: it.p50ms,
      p95: it.p95ms,
      p99: it.p99ms,
      roundTrips: it.p50ms / run.network.rttFloorMs,
    },
    upload: {
      singleBytesPerSec: single.medianBytesPerSec,
      multipartBytesPerSec: multi.medianBytesPerSec,
    },
    elapsedMs: run.elapsedMs,
    price: { getUSD, putUSD, ...src.pricing },
    genTtlMs: src.genTtlMs,
    usd: {
      run: run.cost.totalUSD,
      runPut: run.cost.putUSD,
      runGet: run.cost.getUSD,
      intersect: intersectUSD,
      measuredIntersect: measuredIntersectUSD,
      singleLoad: singleLoadUSD,
      multipartLoad: multipartLoadUSD,
      singleLoadPuts: cost(0, putsPerSingle),
      loadGets: cost(getsPerLoad),
      // The reads after a load's first one, which re-read what it read: the most folding them could save.
      loadRereads: cost(getsPerLoad - 1),
      segmentMonth: monthUSD(object),
      multipartMonth: monthUSD(multi.medianObjectBytes),
      pointerRefreshMonth: pointerRefreshUSD,
      // What `estimateCost()` charges a load by default: `requestsPerLoad` PUT-class requests, 1 unless set.
      estimatorLoadDefault: putUSD,
    },
    parity: {
      intersectsPerMonth: redis / intersectUSD,
      intersectsPerSec: redis / intersectUSD / src.secondsPerMonth,
      loadsPerMonth: redis / singleLoadUSD,
      kTen: {
        perMonth: redis / cost(coldGets(10)),
        perSec: redis / cost(coldGets(10)) / src.secondsPerMonth,
      },
    },
    kRows,
  };
  f.anchors = anchorsOf(f);
  f.values = valuesOf(f);
  return f;
}

/** The figures a run report must state, in the form a reader sees. */
function anchorsOf(f) {
  return [
    ['run id', f.runId],
    ['region', f.region],
    ['package version', f.packageVersion],
    ['harness commit', f.harness],
    ['exact cold intersects', `${f.intersects} of ${f.intersects}`],
    ['chunks fetched', `${f.chunksPerOperand} of ${int(f.chunksPerSegment)} chunks`],
    ['chunks skipped', `${int(f.chunksSkipped)} chunks`],
    ['share fetched, by count', pct(f.shareFetched, 1)],
    ['share skipped, by count', pct(1 - f.shareFetched, 1)],
    ['payload share, by bytes', pct(f.payloadFraction, 1)],
    ['GETs per cold intersect', `${int(f.expectedGets)} GETs`],
    ['GETs this run measured', `${int(f.measuredGets)} GETs`],
    ['pointer reads per load', `${f.getsPerLoad} GETs`],
    ['cold intersect', usd(f.usd.intersect, 7)],
    ['per million cold intersects', usd(1e6 * f.usd.intersect, 2)],
    ['per million single-part loads', usd(1e6 * f.usd.singleLoad, 2)],
    ['per million multipart loads', usd(1e6 * f.usd.multipartLoad, 2)],
    ['the run', usd(f.usd.run, 7)],
    ['round-trip floor', `${int(f.network.rttFloorMs)} ms`],
    ['tail read', `${f.bytes.tailBytesPerRead / 1024} KiB`],
    [
      'cold intersects the Redis line buys a month',
      `${fixed(f.parity.intersectsPerMonth / 1e6, 1)} million`,
    ],
    ['loads the Redis line buys a month', `${fixed(f.parity.loadsPerMonth / 1e6, 1)} million`],
  ];
}

/** Every value a page may state for this run, by unit — what the reverse check accepts. */
function valuesOf(f) {
  const b = f.bytes;
  const ms = [
    f.network.rttFloorMs,
    f.network.rttMedianMs,
    f.network.thresholdMs,
    f.latency.p50,
    f.latency.p95,
    f.latency.p99,
    f.genTtlMs,
    f.elapsedMs,
  ];
  return {
    usd: [
      f.price.getUSD,
      f.price.putUSD,
      f.price.getPerMillion,
      f.price.putPerMillion,
      f.price.storagePerGiBMonth,
      f.price.redisMonthlyUSD,
      f.usd.run,
      f.usd.runPut,
      f.usd.runGet,
      f.usd.segmentMonth,
      f.usd.multipartMonth,
      f.usd.pointerRefreshMonth,
      f.usd.estimatorLoadDefault,
      1e6 * f.usd.estimatorLoadDefault,
      1e6 * f.usd.singleLoadPuts,
      1e6 * f.usd.loadGets,
      1e6 * f.usd.loadRereads,
      ...[f.usd.intersect, f.usd.measuredIntersect, f.usd.singleLoad, f.usd.multipartLoad].flatMap(
        (v) => [v, 1e6 * v],
      ),
      ...f.kRows.flatMap((r) => [r.usd, 1e6 * r.usd]),
    ],
    pct: [
      1,
      f.workload.overlap,
      f.shareFetched,
      1 - f.shareFetched,
      f.payloadFraction,
      1 - f.payloadFraction,
      b.tailBytes / b.objects,
      b.fetched / b.objects,
      1 - b.fetched / b.objects,
      (2 * f.chunksPerOperand) / f.measuredGets,
      (2 * f.chunksPerOperand) / f.expectedGets,
      (f.getsPerLoad * f.price.getUSD) / f.usd.singleLoad,
    ],
    ms,
    s: ms.map((v) => v / 1000),
    bytes: [
      b.object,
      b.multipartObject,
      b.objects,
      b.chunkBytesPerRead,
      b.chunkBytes,
      b.tailBytes,
      b.tailBytesPerRead,
      b.pointerBytesPerRead,
      b.pointerBytes,
      b.fetched,
      b.down,
      b.up,
      b.perIdSingle,
      b.perIdMultipart,
      f.upload.singleBytesPerSec,
      f.upload.multipartBytesPerSec,
      b.chunkBytesPerOperand,
      ...(b.index === null
        ? []
        : [b.index, b.indexPerChunk, b.payload, b.arrayHeader, b.arrayPerId]),
    ],
    bits: [8 * f.upload.singleBytesPerSec, 8 * f.upload.multipartBytesPerSec],
  };
}

module.exports = { readSources, evidenceFiles, derive, format: { int, fixed, usd, pct } };
