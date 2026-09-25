'use strict';
/*
 * The figures a real-cloud calibration run lets this project publish — each one DERIVED from the run's evidence
 * file, the pricing profile the run names, and the library's own constants. None is typed in.
 *
 * WHY THIS EXISTS. A run report is the one document whose numbers a reader cannot check for themselves: they come
 * from a bill for a run nobody else saw. So the report, and every page that quotes the run, is held to the evidence
 * by `tests/docs/calibration-reports.test.ts` in both directions: each headline figure must appear, and no money,
 * percentage, duration, byte size, bit rate, ratio or count may appear that this module cannot derive. The tables
 * are checked row by row, so right numbers on the wrong rows fail too. `scripts/site-figures.cjs` takes the site's
 * figures from the same derivation and checks them with the same matcher.
 *
 * THREE KINDS OF FIGURE, and the report labels each.
 *   measured  straight from the evidence: request counts by command, bytes, chunk counts, timings.
 *   derived   measured counts times the pricing profile's list prices, or arithmetic over measured counts.
 *   expected  what the code predicts for a case the run did not measure, such as the same intersect inside the
 *             region, or `store.load()`, whose requests a test counts. Each is built from measured or tested
 *             parts; the report says which.
 *
 * AND IT REFUSES EVIDENCE THAT DOES NOT ADD UP. Before anything is derived, the file must be a complete, cold and
 * exact real run whose parts reconcile: the per-command counts sum to the billed classes, each class's price
 * reproduces its recorded cost, the chunk and tail reads match the planned layout and the library's tail size, the
 * median intersect's GETs are its chunk, tail and pointer reads, the bytes read back and sent up sum to their
 * parts, and the uncategorised reads divide evenly across the loads. A figure derived from a file that fails any of
 * those would be about a run that did not happen the way it says.
 *
 * WHAT THE REVERSE CHECK CAN AND CANNOT SEE. It reads a figure by its unit, or by the noun it counts, and accepts it
 * only at the precision it is written. A value the evidence holds is not enough where the same number could make
 * two claims: the measured and the expected intersect, a byte share and a chunk share, what a load uploaded and
 * what the object holds. Those values are BOUND to the words that must be nearest them in the same clause (see
 * `WORDS`), and a request shape ("2 PUT + 3 GET") must be one the run has. What it cannot see: a number written as a
 * word, a figure with no unit or counted noun beside it, and a claim bound to nothing that happens to state a value
 * the evidence holds.
 */
const fs = require('node:fs');
const path = require('node:path');

const { classify } = require('./aws-meter.cjs');
const { planLayout, DEFAULT_LAYOUT, EVIDENCE_DIR, CHUNK_SPAN } = require('./calibrate-guards.cjs');

/**
 * What `store.load()` bills, in requests, as `tests/bench/calibrate-guards.test.ts` counts them against local
 * drivers and the real registry protocol — which the harness does not time, since it calls
 * `bulkLoadCrbmGeneration` with the generation given. PUT-class: the object, two listings (one to choose the
 * generation, one to collect after the publish) and the pointer. GETs: seven pointer reads on a segment's first
 * load; a reload also reads the current generation's index; from the third load on, the collection pass re-reads
 * the pointer before its delete. The test asserts these numbers, so the prices below cannot drift from what runs.
 */
const STORE_LOAD_REQUESTS = Object.freeze({
  first: Object.freeze({ put: 4, get: 7 }),
  reload: Object.freeze({ put: 4, get: 8 }),
  collecting: Object.freeze({ put: 4, get: 9 }),
});

/** Roaring's portable format stores a chunk of at most this many ids as an array: a header, then 2 bytes an id. */
const ARRAY_CONTAINER_MAX = 4096;
/** A roaring bitmap container: one bit for each of a chunk's ids. */
const BITMAP_CONTAINER_BYTES = CHUNK_SPAN / 8;

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
  const readerDefaults = read('packages/core/src/core/reader-defaults.ts');
  const engine = read('packages/core/src/core/engine.ts');
  const profile = need(
    /name:\s*'([\w-]+)',\s*storage:\s*\{\s*getPerMillion:\s*([\d.]+),\s*putPerMillion:\s*([\d.]+),\s*storagePerGiBMonth:\s*([\d.]+)\s*\},/,
    cost,
    'the default pricing profile in packages/core/src/core/cost.ts',
  );
  // A run's crossover is against one Redis-HA cluster, whatever the data size; the default profile sizes Redis
  // to the data instead, which is the estimator's verdict and not a run's.
  const cluster = need(
    /export const ONE_REDIS_HA_CLUSTER\b[^=]*=\s*\{\s*monthlyUSD:\s*(\d+)\s*\}/,
    cost,
    'ONE_REDIS_HA_CLUSTER in packages/core/src/core/cost.ts',
  );
  const hours = need(/const HOURS_PER_MONTH = (\d+);/, cost, 'HOURS_PER_MONTH');
  const month = need(
    /const SECONDS_PER_MONTH = HOURS_PER_MONTH \* (\d+);/,
    cost,
    'SECONDS_PER_MONTH',
  );
  const tail = need(
    /export const DEFAULT_TAIL_BYTES = (\d+) \* (\d+);/,
    format,
    'DEFAULT_TAIL_BYTES',
  );
  const footer = need(/export const FOOTER_BYTES = (\d+);/, format, 'FOOTER_BYTES');
  const preamble = need(/export const PREAMBLE_BYTES = (\d+);/, format, 'PREAMBLE_BYTES');
  const ttl = need(
    /const DEFAULT_CURRENT_GEN_TTL_MS = (\d+);/,
    readerDefaults,
    'DEFAULT_CURRENT_GEN_TTL_MS',
  );
  const fanOut = need(
    /const DEFAULT_INTERSECT_CONCURRENCY = (\d+);/,
    engine,
    'DEFAULT_INTERSECT_CONCURRENCY',
  );
  return {
    pricing: {
      name: profile[1],
      getPerMillion: Number(profile[2]),
      putPerMillion: Number(profile[3]),
      storagePerGiBMonth: Number(profile[4]),
      redisMonthlyUSD: Number(cluster[1]),
    },
    secondsPerMonth: Number(hours[1]) * Number(month[1]),
    tailBytes: Number(tail[1]) * Number(tail[2]),
    footerBytes: Number(footer[1]),
    preambleBytes: Number(preamble[1]),
    genTtlMs: Number(ttl[1]),
    intersectConcurrency: Number(fanOut[1]),
  };
}

/**
 * Every committed run, oldest first. A partial file — a run that did not finish — is not evidence and is skipped.
 * Order is the time a run started where its file records one, and its id otherwise: the id starts with the date,
 * but two runs on one date differ only by a random suffix, which says nothing about which came later. A file from
 * before the start was recorded counts as starting at the beginning of its date. Its bare date once sorted after
 * every later run started the same day, because `T` sorts before `|`.
 */
function evidenceFiles(root) {
  const dir = path.join(root, EVIDENCE_DIR);
  if (!fs.existsSync(dir)) return [];
  const runs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.partial.json'))
    .map((f) => {
      const rel = path.join(EVIDENCE_DIR, f);
      let startedAt = '';
      try {
        startedAt = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).startedAt ?? '';
      } catch {
        // An unreadable file sorts by name; the gate that reads it reports why.
      }
      return { rel, key: `${startedAt || `${f.slice(0, 10)}T00:00:00.000Z`}|${f}` };
    });
  return runs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((r) => r.rel);
}

const GIB = 1024 ** 3;

// ── formatting, for the figures a page must state verbatim ──────────────────────────────────────────────────────
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
  const refuseIfAny = () => {
    if (problems.length > 0) {
      throw new Error(`calibration evidence ${run.runId}: ${problems.join('; ')}`);
    }
  };
  const it = run.phases?.intersect ?? {};
  check(run.mode === 'run' && run.target === 'aws', 'it is not a real run against AWS');
  check(
    run.partial === false && run.interrupted !== true && run.error === undefined,
    'the run did not finish',
  );
  check(run.projectionExceeded === undefined, 'the run exceeded its own projection');
  check(it.cold === true && it.exact === true, 'its intersects are not recorded as cold and exact');
  check(
    run.pricing === src.pricing.name,
    `it was priced with "${run.pricing}", which is not the library's profile "${src.pricing.name}"`,
  );
  refuseIfAny();

  const w = run.workload;
  const single = run.phases.load.singlePart;
  const multi = run.phases.load.multipart;
  const ops = run.cost.ops;
  const cmd = ops.byCommand;
  const rd = ops.reads;
  const n = (name) => cmd[name] ?? 0;
  const getUSD = src.pricing.getPerMillion / 1e6;
  const putUSD = src.pricing.putPerMillion / 1e6;
  const close = (a, b) => Math.abs(a - b) < 1e-12;

  // ── the evidence has to reconcile with itself ───────────────────────────────────────────────────────────────
  const byClass = { put: 0, get: 0, free: 0 };
  for (const [name, count] of Object.entries(cmd)) byClass[classify(name)] += count;
  check(
    byClass.put === ops.put && byClass.get === ops.get && byClass.free === (ops.free ?? 0),
    `its per-command counts (${byClass.put} PUT-class, ${byClass.get} GET-class) do not sum to the billed ` +
      `classes (${ops.put}, ${ops.get})`,
  );
  // Each class on its own: a total can reconcile while its two halves are moved against each other.
  check(
    close(ops.put * putUSD, run.cost.putUSD) &&
      close(ops.get * getUSD, run.cost.getUSD) &&
      close(run.cost.putUSD + run.cost.getUSD, run.cost.totalUSD),
    `its requests at today's prices do not reproduce the cost it recorded — the pricing profile changed, or the ` +
      'file did, and every dollar figure derived from it would be wrong',
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
  // The meter files every ranged read as a chunk read. This harness's layouts keep each index inside the tail read,
  // so every ranged read here is a chunk; a layout whose index outgrew the tail would add an index read per operand
  // to this count, and the check would refuse the file until the meter told the two apart.
  check(
    rd.range.n === operandReads * it.chunksFetchedPerOperand &&
      it.chunksFetchedPerOperand === w.sharedChunks,
    `its chunk reads (${rd.range.n}) are not ${w.sharedChunks} per operand of ${it.runs} intersects`,
  );
  check(
    rd.suffix.n === operandReads &&
      it.tailReadBytesPerOperand === src.tailBytes &&
      rd.suffix.bytes === rd.suffix.n * src.tailBytes,
    `its tail reads are not one of the library's ${src.tailBytes} bytes per operand`,
  );
  // The headline count, held to the ledger: an intersect's GETs are its chunk reads, its tail reads and its pointer
  // reads, and it reads each operand's pointer at least once.
  const chunkReadsPerIntersect = rd.range.n / it.runs;
  const tailReadsPerIntersect = rd.suffix.n / it.runs;
  check(
    Number.isInteger(it.pointerReadsPerIntersect) &&
      it.pointerReadsPerIntersect >= 2 &&
      rd.whole.n >= 2 * it.runs &&
      it.medianGets ===
        chunkReadsPerIntersect + tailReadsPerIntersect + it.pointerReadsPerIntersect,
    `its median intersect's ${it.medianGets} GETs are not its chunk, tail and pointer reads ` +
      `(${chunkReadsPerIntersect} + ${tailReadsPerIntersect} + ${it.pointerReadsPerIntersect})`,
  );
  check(
    ops.bytesDown === rd.whole.bytes + rd.suffix.bytes + rd.range.bytes,
    'the bytes it read back are not the sum of its pointer, tail and chunk reads',
  );
  // What went up is the loads' uploads. The file records medians, so the sum is checked to a thousandth: tight
  // enough to catch an edit, loose enough for loads of one kind that differ by a byte or two.
  const uploadOf = (phase) => phase.medianUploadBytes ?? phase.medianObjectBytes;
  const uploaded = single.runs * uploadOf(single) + multi.runs * uploadOf(multi);
  check(
    Math.abs(ops.bytesUp - uploaded) <= ops.bytesUp / 1000,
    `the ${ops.bytesUp} bytes it sent up are not its loads' uploads (${uploaded})`,
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
  const pointerBytesPerRead = rd.whole.bytes / rd.whole.n;
  // The payload fraction as the harness computed it, from its own byte field — a check of its arithmetic.
  check(
    Math.abs(rd.range.bytes / it.runs / (2 * single.medianObjectBytes) - it.payloadFraction) < 1e-9,
    'its payload fraction is not its chunk bytes over the two objects',
  );
  refuseIfAny();

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
  const meanPointerReads = rd.whole.n / it.runs;
  // Expected, from the engine: an intersect resolves each operand's pointer, then reads its tail, both operands at
  // once; then it keeps `DEFAULT_INTERSECT_CONCURRENCY` shared chunks in flight, each read from both operands at
  // once. So its requests queue this many deep. A pointer refresh part-way through holds every chunk read that
  // starts while it is in flight, so each one the median intersect made adds one more.
  const refreshes = (measuredGets - expectedGets) / 2;
  const requestsDeepPinned = 2 + Math.ceil(chunksPerOperand / src.intersectConcurrency);
  const requestsDeep = requestsDeepPinned + refreshes;

  // ── bytes ───────────────────────────────────────────────────────────────────────────────────────────────────
  // What an object holds. Harnesses up to e42c27f recorded the bytes a load UPLOADED under `medianObjectBytes`:
  // the object and its pointer's body, since the meter counts every request. A later harness records the two
  // apart (`medianUploadBytes`). For a file from an earlier one, the pointer's body is the size the pointer reads
  // returned — the same object. A multipart segment's name is two characters longer, so its figure is two bytes
  // high; nothing is stated to that precision.
  const recordsUploads = 'medianUploadBytes' in single;
  const objectOf = (phase) =>
    recordsUploads ? phase.medianObjectBytes : phase.medianObjectBytes - pointerBytesPerRead;
  const object = objectOf(single);
  const multipartObject = objectOf(multi);
  const objects = 2 * object;
  const chunkBytesPerRead = rd.range.bytes / rd.range.n;
  const chunkBytes = rd.range.bytes / it.runs;
  const tailBytes = rd.suffix.bytes / it.runs;
  const pointerBytes = rd.whole.bytes / it.runs;
  // What left the two objects: chunk and tail reads, which do not overlap in this layout (the shared chunks sit at
  // the front of each object, the tail at its end). A pointer is an object of its own, so its bytes are not a share
  // of these two.
  const fetched = chunkBytes + tailBytes;
  // A large segment's ids. A later harness records them; for an earlier file they come back from its two rates —
  // ids a second over bytes a second, times the bytes — which is exact to well under one id, and is checked. The
  // rate is of what went UP, the object and its pointer's body, so it is paired with the upload and not with the
  // object: paired with the object, it refused every file a harness recording the two apart would write.
  const idsFromRates = (uploadOf(multi) * multi.medianIdsPerSec) / multi.medianBytesPerSec;
  const multipartIds = w.largeIdsPerSegment ?? Math.round(idsFromRates);
  if (Math.abs(idsFromRates - multipartIds) > 0.5) {
    throw new Error(
      `calibration evidence ${run.runId}: its multipart rates imply ${idsFromRates} ids a segment, not ${multipartIds}`,
    );
  }

  // A roaring chunk of at most 4,096 ids is one array container: a 16-byte portable header, then 2 bytes an id.
  // Checked against the chunk bytes the run actually read before anything leans on it — and only then is the
  // index size derived, as the object minus its preamble, footer and payload.
  const HEADER = 16;
  const PER_ID = 2;
  const payloadOf = (chunks, ids) => HEADER * chunks + PER_ID * ids;
  const arrayChunks = w.idsPerSegment / w.chunksPerSegment <= ARRAY_CONTAINER_MAX;
  const formulaHolds =
    arrayChunks && payloadOf(w.sharedChunks, layout.shared) === rd.range.bytes / operandReads;
  const payload = formulaHolds ? payloadOf(w.chunksPerSegment, w.idsPerSegment) : null;
  const index = payload === null ? null : object - src.preambleBytes - src.footerBytes - payload;
  const indexPerChunk = index === null ? null : index / w.chunksPerSegment;
  const tailHoldsChunks =
    indexPerChunk === null ? null : Math.floor((src.tailBytes - src.footerBytes) / indexPerChunk);
  // On a segment this small the tail read reaches back past the index into the payload: bytes of chunks the
  // intersect never requested, downloaded with the index and never decoded.
  const tailPayloadBytes = index === null ? null : src.tailBytes - src.footerBytes - index;
  const tailPayloadChunks =
    tailPayloadBytes === null ? null : tailPayloadBytes / (payload / w.chunksPerSegment);

  // ── money ───────────────────────────────────────────────────────────────────────────────────────────────────
  const cost = (gets, puts = 0) => gets * getUSD + puts * putUSD;
  const measuredIntersectUSD = cost(measuredGets);
  const expectedIntersectUSD = cost(expectedGets);
  const singleLoadUSD = cost(getsPerLoad, putsPerSingle);
  const multipartLoadUSD = cost(getsPerLoad, putsPerMultipart);
  const storeLoadUSD = Object.fromEntries(
    Object.entries(STORE_LOAD_REQUESTS).map(([k, r]) => [k, cost(r.get, r.put)]),
  );
  const monthUSD = (bytes) => (bytes / GIB) * src.pricing.storagePerGiBMonth;
  const redis = src.pricing.redisMonthlyUSD;
  // One pointer read per segment per refresh window, while the segment is being read — a standing cost of the
  // default refresh that no single cold intersect shows. Expected, from the code's `genTtlMs`.
  const pointerRefreshUSD = (src.secondsPerMonth / (src.genTtlMs / 1000)) * getUSD;
  const kRows = [1, 10, chunksPerOperand, 1000, w.chunksPerSegment].map((k) => ({
    k,
    gets: coldGets(k),
    usd: cost(coldGets(k)),
  }));
  const perMonth = (each) => redis / each;
  const perSec = (each) => redis / each / src.secondsPerMonth;

  const f = {
    runId: run.runId,
    date: run.runId.slice(0, 10),
    region: run.region,
    packageVersion: run.measured.packageVersion,
    harness: run.measured.harness,
    node: run.measured.node,
    remote: !/^in-region/.test(run.network.client),
    workload: { ...w, sharedIds: layout.shared, overlap: DEFAULT_LAYOUT.overlap },
    intersects: it.runs,
    chunksPerOperand,
    chunksPerSegment: w.chunksPerSegment,
    chunksSkipped: w.chunksPerSegment - chunksPerOperand,
    shareFetched: chunksPerOperand / w.chunksPerSegment,
    payloadFraction: chunkBytes / objects,
    fixedGets,
    coldGets,
    expectedGets,
    measuredGets,
    meanPointerReads,
    pointerReadsMeasured: it.pointerReadsPerIntersect,
    refreshes,
    requestsDeep,
    requestsDeepPinned,
    intersectConcurrency: src.intersectConcurrency,
    projected: { ...run.projected },
    getsPerLoad,
    putsPerSingle,
    putsPerMultipart,
    partsPerMultipart,
    loads,
    storeLoad: STORE_LOAD_REQUESTS,
    byCommand: { ...cmd },
    ledger: {
      chunkReads: rd.range.n,
      tailReads: rd.suffix.n,
      pointerReads: rd.whole.n,
      loadPointerReads: loadGets,
      put: ops.put,
      get: ops.get,
      free: ops.free ?? 0,
    },
    bytes: {
      object,
      multipartObject,
      objects,
      chunkBytesPerRead,
      chunkBytes,
      tailBytes,
      tailBytesPerRead: src.tailBytes,
      pointerBytesPerRead,
      pointerBytes,
      fetched,
      // What a single-part load uploaded, which earlier harnesses recorded under the object's name.
      uploadPerLoad: uploadOf(single),
      down: ops.bytesDown,
      up: ops.bytesUp,
      payload,
      index,
      indexPerChunk,
      tailPayloadBytes,
      chunkBytesPerOperand: rd.range.bytes / operandReads,
      arrayHeader: HEADER,
      arrayPerId: PER_ID,
      perIdSingle: object / w.idsPerSegment,
      perIdMultipart: multipartObject / multipartIds,
    },
    multipartIds,
    largeIdsPerChunk: multipartIds / w.largeChunks,
    tailHoldsChunks,
    tailPayloadChunks,
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
      overFloor: it.p50ms / run.network.rttFloorMs,
      // The median intersect's time over the requests that had to wait for one another: what each one took.
      perRequestOnPath: it.p50ms / requestsDeep,
    },
    upload: {
      singleBytesPerSec: single.medianBytesPerSec,
      multipartBytesPerSec: multi.medianBytesPerSec,
      // A load's time, from its rate: the whole call — building the object, then every request, one after another.
      singleSeconds: w.idsPerSegment / single.medianIdsPerSec,
      multipartSeconds: multipartIds / multi.medianIdsPerSec,
      // A single-part load's requests wait for one another: a pointer read, the object, two more, the pointer.
      sequentialFloorMs: (putsPerSingle + getsPerLoad) * run.network.rttFloorMs,
    },
    elapsedMs: run.elapsedMs,
    price: { getUSD, putUSD, ...src.pricing },
    genTtlMs: src.genTtlMs,
    secondsPerMonth: src.secondsPerMonth,
    preambleBytes: src.preambleBytes,
    footerBytes: src.footerBytes,
    usd: {
      run: run.cost.totalUSD,
      runPut: run.cost.putUSD,
      runGet: run.cost.getUSD,
      measuredIntersect: measuredIntersectUSD,
      expectedIntersect: expectedIntersectUSD,
      singleLoad: singleLoadUSD,
      multipartLoad: multipartLoadUSD,
      storeLoad: storeLoadUSD,
      singleLoadPuts: cost(0, putsPerSingle),
      loadGets: cost(getsPerLoad),
      // The reads after a load's first one, which re-read what it read: the most folding them could save.
      loadRereads: cost(getsPerLoad - 1),
      segmentMonth: monthUSD(object),
      multipartMonth: monthUSD(multipartObject),
      pointerRefreshMonth: pointerRefreshUSD,
    },
    parity: {
      intersectsPerMonth: perMonth(measuredIntersectUSD),
      intersectsPerSec: perSec(measuredIntersectUSD),
      loadsPerMonth: perMonth(singleLoadUSD),
      kTen: { perMonth: perMonth(cost(coldGets(10))), perSec: perSec(cost(coldGets(10))) },
    },
    kRows,
  };
  f.anchors = anchorsOf(f);
  f.rows = rowsOf(f);
  f.shapes = shapesOf(f);
  f.values = valuesOf(f, { withLatency: true });
  // What a page other than the report may state: a remote run's timings measured its client, and the report is
  // the one place they are recorded, beside the reason they are not the library's.
  f.pageValues = f.remote ? valuesOf(f, { withLatency: false }) : f.values;
  return f;
}

/** The figures a run report must state, in the form a reader sees. Each is matched as a whole figure. */
function anchorsOf(f) {
  return [
    ['run id', f.runId],
    ['region', f.region],
    ['package version', f.packageVersion],
    ['harness commit', f.harness],
    ['exact cold intersects', `${f.intersects} of ${f.intersects}`],
    ['chunks fetched', `${f.chunksPerOperand} of ${int(f.chunksPerSegment)} chunks`],
    ['chunks skipped', `${int(f.chunksSkipped)} chunks`],
    ['share fetched, by count', `${pct(f.shareFetched, 1)} of them by count`],
    ['share skipped, by count', `${pct(1 - f.shareFetched, 1)} of the chunks`],
    ['payload share, by bytes', `${pct(f.payloadFraction, 1)} of the two objects`],
    ['GETs the median cold intersect made', `${int(f.measuredGets)} GETs`],
    ['a cold intersect, measured', usd(f.usd.measuredIntersect, 7)],
    ['per million cold intersects, measured', usd(1e6 * f.usd.measuredIntersect, 2)],
    ['GETs a cold intersect makes with each pointer read once', `${int(f.expectedGets)} GETs`],
    [
      'per million cold intersects with each pointer read once',
      usd(1e6 * f.usd.expectedIntersect, 2),
    ],
    ['a single-part write and publish', `${f.putsPerSingle} PUT + ${f.getsPerLoad} GET`],
    ['per million single-part write-and-publishes', usd(1e6 * f.usd.singleLoad, 2)],
    ['per million multipart write-and-publishes', usd(1e6 * f.usd.multipartLoad, 2)],
    ["per million of a segment's first store.load()", usd(1e6 * f.usd.storeLoad.first, 2)],
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

/**
 * The cells a table of the run's operations must hold, keyed by the requests cell, with the words the operation's
 * own cell must carry to say which intersect it is. The rest of its wording is free; its numbers are not, and
 * neither is the label the report gives it.
 */
function rowsOf(f) {
  const put = (n) => (n === 2 ? `${n} PUT` : `${n} PUT-class`);
  return [
    {
      requests: `${int(f.measuredGets)} GET`,
      one: usd(f.usd.measuredIntersect, 7),
      perMillion: usd(1e6 * f.usd.measuredIntersect, 2),
      label: 'derived',
      says: /\bmedian\b|\bmeasured\b/i,
    },
    {
      requests: `${int(f.expectedGets)} GET`,
      one: usd(f.usd.expectedIntersect, 7),
      perMillion: usd(1e6 * f.usd.expectedIntersect, 2),
      label: 'expected',
      says: /\bonce\b|\bexpected\b|\binside the region\b/i,
    },
    {
      requests: `${put(f.putsPerSingle)} + ${f.getsPerLoad} GET`,
      one: usd(f.usd.singleLoad, 7),
      perMillion: usd(1e6 * f.usd.singleLoad, 2),
      label: 'derived',
      says: /\bpublish/i,
    },
    {
      requests: `${put(f.putsPerMultipart)} + ${f.getsPerLoad} GET`,
      one: usd(f.usd.multipartLoad, 7),
      perMillion: usd(1e6 * f.usd.multipartLoad, 2),
      label: 'derived',
      says: /\bmultipart\b/i,
    },
    {
      requests: `${put(f.storeLoad.first.put)} + ${f.storeLoad.first.get} GET`,
      one: usd(f.usd.storeLoad.first, 7),
      perMillion: usd(1e6 * f.usd.storeLoad.first, 2),
      label: 'expected',
      says: /store\.load\(\)/,
    },
  ];
}

/** Every request shape the run has, as `[PUT-class, GET]`: a stated "N PUT + M GET" must be one of them. */
function shapesOf(f) {
  return [
    [f.putsPerSingle, f.getsPerLoad],
    [f.putsPerMultipart, f.getsPerLoad],
    ...Object.values(f.storeLoad).map((r) => [r.put, r.get]),
  ];
}

// ── claim bindings ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The words that say which claim a number makes. A bound value passes only where the nearest of its group's words,
 * in the same clause, table row or diagram line, is one of the words it allows: 206 GETs is the measured median,
 * so "the median made 204 GETs" fails, and 4.9% is a share of bytes, so "4.9% of the chunks" fails. A table row with
 * none of the words takes them from its table's caption and header.
 */
const WORDS = {
  measured: /\bmedian\b|\bmeasured\b|\bthis run\b|\bas the run\b|\blaptop\b/gi,
  expected:
    /\bexpected\b|\bread once\b|\binside the region\b|\bin-region\b|\bpinned\b|\bpins\b|\bwould\b|\bshould\b/gi,
  chunkShare: /\bchunks?\b|\bby count\b|\bof them\b/gi,
  byteShare: /\bobjects?'?|\bbytes?\b|\bpayload\b|\btail\b|\bMB\b|\bKB\b|\bKiB\b|\bleft S3\b/gi,
  getShare: /\bGETs?\b|\bbill\b|\brequests?\b/gi,
  upload: /\buploa\w*/gi,
  overlap: /\bshar\w*|\boverlap\w*|\bidentical\b|\bk = /gi,
  puts: /\bPUTs?\b|\bPUT-class\b/g,
  gets: /\bGETs?\b|\bpointer reads?\b/g,
  rereads: /\bre-?reads?\b|\bfold\w*|\bsave\w*/gi,
  dollar: /\bdollar\b|\bbuys?\b/gi,
  write: /\bwrit\w*|\bpublish\w*/gi,
  once: /\bonce\b|\binside the region\b|\bin-region\b|\bpinned\b|\bpins\b/gi,
  object: /\bobjects?'?/gi,
  storeLoad: /store\.load\(\)|\bloadSegment\b/g,
  median: /\bmedian\b/gi,
};
/**
 * A bound value: the claim it makes is the nearest word of `group`'s families, which must be one `allow` names.
 * `require` fails a value with none of the words near it; without it, only the wrong words fail. `also` holds more
 * bindings the value must meet at once, for a value that can be misread two ways: the dollar's worth of cold
 * intersects needs the words of buying, and must not stand beside "inside the region".
 */
const bind = (v, group, allow, require = true, also = []) => ({ v, group, allow, require, also });
const MEASURED = ['measured', 'expected'];
const SHARES = ['chunkShare', 'byteShare', 'getShare'];
const measuredValue = (v) => bind(v, MEASURED, ['measured'], false);
const expectedValue = (v) => bind(v, MEASURED, ['expected']);

/** Every value a page may state for this run, by unit and by counted noun — what the reverse check accepts. */
function valuesOf(f, { withLatency }) {
  const b = f.bytes;
  const ms = [f.network.rttFloorMs, f.network.rttMedianMs, f.network.thresholdMs, f.genTtlMs];
  const u = f.upload;
  if (withLatency) {
    ms.push(f.latency.p50, f.latency.p95, f.latency.p99, f.elapsedMs, f.latency.perRequestOnPath);
    ms.push(u.singleSeconds * 1000, u.multipartSeconds * 1000, u.sequentialFloorMs);
  }
  const sl = f.storeLoad;
  const get = [
    // Per operand: one pointer read, one tail read, the shared chunks. Per intersect: their sums, with one or both
    // indexes too large for the tail read; the median as measured, and each pointer read once, expected.
    1,
    f.chunksPerOperand,
    2 * f.chunksPerOperand,
    f.fixedGets,
    f.fixedGets + 1,
    f.fixedGets + 2,
    measuredValue(f.measuredGets),
    // The table of cost by overlap is expected throughout; its row for the run's overlap is the expected intersect.
    ...f.kRows.map((r) => expectedValue(r.gets)),
    // Per load, as measured; per store.load(), as counted; the run's totals, and what it projected.
    f.getsPerLoad,
    sl.first.get,
    sl.reload.get,
    sl.collecting.get,
    f.ledger.get,
    f.byCommand.GetObjectCommand,
    f.projected.get,
  ];
  const put = [1, f.putsPerSingle, f.putsPerMultipart, sl.first.put, f.ledger.put, f.projected.put];
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
      bind(1e6 * f.usd.singleLoadPuts, ['puts', 'gets'], ['puts']),
      bind(1e6 * f.usd.loadGets, ['puts', 'gets'], ['gets']),
      bind(1e6 * f.usd.loadRereads, ['rereads'], ['rereads']),
      ...[f.usd.measuredIntersect, 1e6 * f.usd.measuredIntersect].map(measuredValue),
      ...f.kRows.flatMap((r) => [r.usd, 1e6 * r.usd]).map(expectedValue),
      // The write and the publish, which is not store.load(): the same pages price that at about twice, so a load's
      // price stated without either word reads as store.load()'s.
      ...[f.usd.singleLoad, f.usd.multipartLoad]
        .flatMap((v) => [v, 1e6 * v])
        .map((v) => bind(v, ['write'], ['write'])),
      // store.load() is counted by a test, not measured: stated near "measured", it is wrong.
      ...Object.values(f.usd.storeLoad)
        .flatMap((v) => [v, 1e6 * v])
        .map((v) =>
          // Nor is it the write and the publish, which the same pages price at about half.
          bind(v, MEASURED, ['expected'], false, [
            { group: ['write', 'storeLoad'], allow: ['storeLoad'], require: false },
          ]),
        ),
    ],
    pct: [
      1,
      f.workload.overlap,
      bind(f.shareFetched, SHARES, ['chunkShare']),
      bind(1 - f.shareFetched, SHARES, ['chunkShare']),
      ...[
        f.payloadFraction,
        1 - f.payloadFraction,
        b.tailBytes / b.objects,
        b.fetched / b.objects,
        1 - b.fetched / b.objects,
      ].map((v) => bind(v, SHARES, ['byteShare'])),
      ...[
        (2 * f.chunksPerOperand) / f.measuredGets,
        (2 * f.chunksPerOperand) / f.expectedGets,
        (f.getsPerLoad * f.price.getUSD) / f.usd.singleLoad,
      ].map((v) => bind(v, SHARES, ['getShare'])),
    ],
    ms,
    s: [...ms.map((v) => v / 1000), f.secondsPerMonth],
    min: ms.map((v) => v / 60_000),
    h: [f.secondsPerMonth / 3600],
    bytes: [
      // What an object holds, which is not what a load uploaded: the reverse of the upload's binding below.
      bind(b.object, ['upload', 'object'], ['object'], false),
      b.multipartObject,
      bind(b.objects, ['upload', 'object'], ['object'], false),
      b.chunkBytesPerRead,
      b.chunkBytes,
      b.tailBytes,
      b.tailBytesPerRead,
      b.pointerBytesPerRead,
      b.pointerBytes,
      b.fetched,
      b.objects - b.fetched,
      bind(b.uploadPerLoad, ['upload'], ['upload']),
      f.preambleBytes,
      f.footerBytes,
      b.down,
      b.up,
      b.perIdSingle,
      b.perIdMultipart,
      b.chunkBytesPerOperand,
      BITMAP_CONTAINER_BYTES,
      ...(withLatency ? [f.upload.singleBytesPerSec, f.upload.multipartBytesPerSec] : []),
      ...(b.index === null
        ? []
        : [b.payload, b.index, b.indexPerChunk, b.arrayHeader, b.arrayPerId, b.tailPayloadBytes]),
    ],
    bits: withLatency ? [8 * f.upload.singleBytesPerSec, 8 * f.upload.multipartBytesPerSec] : [],
    ratio: [
      2, // two operands
      f.price.putPerMillion / f.price.getPerMillion,
      b.multipartObject / b.object,
      f.usd.storeLoad.first / f.usd.singleLoad,
      ...(withLatency
        ? [f.latency.overFloor, f.latency.perRequestOnPath / f.network.rttFloorMs]
        : []),
    ],
    counts: {
      get,
      put,
      requests: [
        ...get,
        ...put,
        f.ledger.put + f.ledger.get,
        f.ledger.put + f.ledger.get + f.ledger.free,
        f.putsPerSingle + f.getsPerLoad,
        f.putsPerMultipart + f.getsPerLoad,
        ...Object.values(sl).map((r) => r.put + r.get),
        // The median's depth, with its pointer re-read, is not the depth with each pointer read once.
        bind(f.requestsDeep, ['once'], [], false),
        // The depth without the pointer re-read: the median intersect, which re-read it, was a request deeper.
        bind(f.requestsDeepPinned, ['once'], ['once']),
      ],
      chunks: [
        f.chunksPerOperand,
        f.chunksSkipped,
        f.chunksPerSegment,
        f.workload.largeChunks,
        f.intersectConcurrency,
        // The table's overlaps: a count of chunks the two segments SHARE, and nothing else.
        ...f.kRows.map((r) => bind(r.k, ['overlap'], ['overlap'])),
        Math.round(f.chunksPerSegment / 100), // the chunk-skipping diagram's scale: a hundred squares
        ...(f.tailHoldsChunks === null ? [] : [f.tailHoldsChunks]),
        ...(f.tailPayloadChunks === null ? [] : [f.tailPayloadChunks]),
      ],
      ids: [
        f.workload.idsPerSegment,
        f.workload.sharedIds,
        f.multipartIds,
        f.largeIdsPerChunk,
        ARRAY_CONTAINER_MAX,
        CHUNK_SPAN,
      ],
      loads: [f.loads, f.workload.segments, f.workload.largeSegments],
      // The run's count, the parity figures, and how many cold intersects a dollar buys: whole ones, measured, and
      // at each overlap in the table as a rate.
      intersects: [
        f.intersects,
        f.parity.intersectsPerMonth,
        // At ten shared chunks the table is expected throughout, so none of it is "as measured".
        bind(f.parity.kTen.perMonth, MEASURED, ['expected'], false),
        // Whole cold intersects a dollar buys: measured, and so not "inside the region".
        bind(Math.floor(1 / f.usd.measuredIntersect), ['dollar'], ['dollar'], true, [
          { group: MEASURED, allow: ['measured'], require: false },
        ]),
        // …and at each overlap in the table, expected, and whole ones: a dollar does not buy a fraction.
        ...f.kRows.map((r) => bind(Math.floor(1 / r.usd), MEASURED, ['expected'], false)),
      ],
      segments: [f.workload.segments, f.workload.largeSegments, 1],
      pointerReads: [
        f.ledger.pointerReads,
        f.ledger.loadPointerReads,
        f.pointerReadsMeasured,
        // 3.8 an intersect is the mean; the median read 4.
        bind(f.meanPointerReads, ['median'], [], false),
        f.getsPerLoad,
        2,
        1,
      ],
      tailReads: [f.ledger.tailReads, 2, 1],
      chunkReads: [f.ledger.chunkReads, 2 * f.chunksPerOperand, f.chunksPerOperand],
      getObjects: [
        f.byCommand.GetObjectCommand,
        f.ledger.loadPointerReads,
        f.ledger.pointerReads,
        f.ledger.tailReads,
        f.ledger.chunkReads,
      ],
      putObjects: [f.byCommand.PutObjectCommand, f.workload.segments, f.loads],
    },
    pairs: {
      chunks: [[f.chunksPerOperand, f.chunksPerSegment]],
      intersects: [[f.intersects, f.intersects]],
    },
    shapes: f.shapes,
    // The parity at ten shared chunks is from the table of cost by overlap, expected throughout, so it is never "as
    // measured", in millions or a second.
    million: [
      f.parity.intersectsPerMonth / 1e6,
      f.parity.loadsPerMonth / 1e6,
      bind(f.parity.kTen.perMonth / 1e6, MEASURED, ['expected'], false),
    ],
    perSecond: [
      f.parity.intersectsPerSec,
      bind(f.parity.kTen.perSec, MEASURED, ['expected'], false),
    ],
  };
}

/**
 * Values another source accounts for, in the shape `valuesOf` returns, read out of the figures that source states:
 * `$346` is 346 dollars, `1.2 GiB` is its bytes. `scripts/site-figures.cjs` merges these with a run's, so a block of
 * a page that quotes the run and the estimator together is checked against both.
 */
function valuesFromFigures(figures, extra = {}) {
  const out = { counts: {}, pairs: {}, shapes: [] };
  const add = (key, v) => {
    out[key] = [...(out[key] ?? []), v];
  };
  for (const figure of figures) {
    const t = normalize(figure);
    for (const { re, key, scale } of CLASSES) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) {
        if (key === 'counts') continue;
        const x = Number((numberOf(m, key) ?? '').replace(/,/g, ''));
        if (Number.isFinite(x)) add(key, x * scale(m));
      }
    }
  }
  for (const [key, vs] of Object.entries(extra)) for (const v of vs) add(key, v);
  return out;
}

/**
 * The same values with their bindings dropped: what a figure may be, wherever it stands. For a check that reads a
 * figure without the sentence around it; the sentence is then checked on its own, with its words.
 */
function unbound(values) {
  const plain = (list) => list.map((c) => (typeof c === 'number' ? c : c.v));
  const out = { ...values, counts: {} };
  for (const [key, list] of Object.entries(values)) {
    if (Array.isArray(list) && key !== 'shapes') out[key] = plain(list);
  }
  for (const [noun, list] of Object.entries(values.counts)) out.counts[noun] = plain(list);
  return out;
}

/** Two value sets as one: every unit's and every noun's values from both. */
function mergeValues(a, b) {
  const out = { ...a, counts: { ...a.counts }, pairs: { ...a.pairs } };
  for (const [key, vs] of Object.entries(b)) {
    if (key === 'counts' || key === 'pairs') {
      for (const [k, list] of Object.entries(vs)) out[key][k] = [...(out[key][k] ?? []), ...list];
    } else if (key === 'shapes') {
      out.shapes = [...(out.shapes ?? []), ...vs];
    } else {
      out[key] = [...(out[key] ?? []), ...vs];
    }
  }
  return out;
}

// ── the reverse check, shared by the report gate and the site gate ─────────────────────────────────────────────

/**
 * The same text with the spellings a figure can hide behind made plain: entities, emphasis and code marks around a
 * number, inline tags, link targets and titles, and every run of whitespace, line breaks included — a figure
 * wrapped across two lines is still one figure.
 */
function normalize(text) {
  return (
    text
      // A link's target and title, and an element's id, name a place, not a figure: `#3-bytes-on-the-wire` is not
      // 3 bytes, and a tooltip is not the text a reader is given.
      .replace(/\]\([^)]*\)/g, ']')
      .replace(
        /\s(?:href|id|src|class|for|name|title|alt|aria-labelledby|aria-describedby)="[^"]*"/g,
        '',
      )
      .replace(/<\/?(?:strong|b|em|i|span|code|mark|sup|sub|small|abbr)\b[^>]*>/gi, '')
      .replace(/&#0*36;|&#x0*24;|&dollar;/gi, '$')
      .replace(/&#0*37;|&#x0*25;|&percnt;/gi, '%')
      .replace(/&#0*8776;|&#x2248;|&asymp;|&thickapprox;/gi, '≈')
      .replace(/&times;|&#0*215;|&#xd7;/gi, '×')
      .replace(/&cent;|&#0*162;|&#xa2;/gi, '¢')
      .replace(
        /&nbsp;|&#0*160;|&#xa0;|&#x202f;|&thinsp;|&#8201;|&ensp;|&emsp;|\u00a0|\u202f|\u2009|\u2002|\u2003/gi,
        ' ',
      )
      .replace(/&#0*44;|&#x2c;/gi, ',')
      .replace(/`/g, '')
      // Emphasis that opens before a number, or closes after one: `**25.6** KiB`, `_99.5%_`, `$**82**`.
      .replace(/(^|[^\w])(?:\*\*|__|\*|_)+(?=[$\d.])/g, '$1')
      .replace(/([\d%])(?:\*\*|__|\*|_)+(?=[^\w]|$)/g, '$1')
      .replace(/(US\$|USD|\$)\s*(?:\*\*|__|\*|_)+\s*(?=[\d.])/g, '$1')
      .replace(/\s+/g, ' ')
  );
}

/** What a reader sees: the text without its comments. An anchor hidden in a comment is not stated. */
function visible(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

// Not a digit inside a word: `S3 PUTs` states no count of PUTs, and `v0.10.0` no amount.
const NUM = String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?|\.\d+)`;
const HEDGE = String.raw`(?:(about|around|roughly|nearly|almost|approximately|~|≈)\s?)?`;
const BYTE_UNITS = {
  B: 1,
  byte: 1,
  bytes: 1,
  kB: 1e3,
  KB: 1e3,
  kb: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  kilobyte: 1e3,
  kilobytes: 1e3,
  megabyte: 1e6,
  megabytes: 1e6,
  gigabyte: 1e9,
  gigabytes: 1e9,
};
const MULTIPLIER = { k: 1e3, K: 1e3, M: 1e6, million: 1e6, B: 1e9, billion: 1e9 };
const BYTE_UNIT = Object.keys(BYTE_UNITS)
  .sort((a, b) => b.length - a.length)
  .join('|');
// Longest first, so "chunk reads" is read as chunk reads and not as chunks.
const COUNTED = [
  ['pointer reads?|pointer GETs?', 'pointerReads'],
  ['tail reads?|tail GETs?', 'tailReads'],
  ['chunk reads?|chunk GETs?', 'chunkReads'],
  ['cold intersects?|intersects?', 'intersects'],
  ['GetObjects?', 'getObjects'],
  ['PutObjects?', 'putObjects'],
  ['GET-class|GETs?', 'get'],
  ['PUT-class|PUTs?', 'put'],
  ['requests?', 'requests'],
  ['chunks?', 'chunks'],
  ['ids?', 'ids'],
  ['loads?', 'loads'],
  ['segments?', 'segments'],
];
/** Words that may stand between a count and its noun without changing what it counts. */
const COUNT_ADJECTIVES = String.raw`(?:(?:shared|cold|single-part|multipart|dense|new|planned|private|uncategorised|more|other)\s)?`;

/**
 * The classes of figure the reverse check reads, in the order they claim a number — a number one class has read,
 * another does not read again, so "1.6 cold intersects a second" is a rate, not a count of 1.6 intersects. Each has
 * the value set it is checked against, and the factor that turns its written unit into that set's (`256 KiB` is
 * 262,144 bytes). Money may carry a multiplier (`$4.2M`), and a count a million (`4.2M intersects`) — not a
 * thousand, since `4 + 2k GETs` is a formula, not two thousand GETs.
 */
const CLASSES = [
  {
    re: new RegExp(
      String.raw`${HEDGE}(?:US\$|\$|USD\s?)\s?${NUM}(?:\s?(k|K|M|B|million|billion)\b)?`,
      'g',
    ),
    key: 'usd',
    scale: (m) => MULTIPLIER[m[3]] ?? 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}\s?(?:USD|dollars?)\b`, 'g'),
    key: 'usd',
    scale: () => 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}\s?(?:¢|cents?\b)`, 'g'),
    key: 'usd',
    scale: () => 0.01,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}\s?(?:%|percent\b|per cent\b)`, 'g'),
    key: 'pct',
    scale: () => 0.01,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}[\s-]?(?:ms|msec|msecs|milliseconds?)\b`, 'g'),
    key: 'ms',
    scale: () => 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}(?:[\s-]?(?:sec|secs|seconds?)|[\s-]s)\b`, 'g'),
    key: 's',
    scale: () => 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}[\s-]?(?:min|mins|minutes?)\b`, 'g'),
    key: 'min',
    scale: () => 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}[\s-]?(?:h|hrs?|hours?)\b`, 'g'),
    key: 'h',
    scale: () => 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}[\s-]?(${BYTE_UNIT})(?![A-Za-z])`, 'g'),
    key: 'bytes',
    scale: (m) => BYTE_UNITS[m[3]],
  },
  {
    re: new RegExp(
      String.raw`${HEDGE}${NUM}[\s-]?(Mbit/s|Mbps|Mb/s|Gbit/s|Gbps|Gb/s|kbit/s|kbps|kb/s)`,
      'g',
    ),
    key: 'bits',
    scale: (m) => (/^G/.test(m[3]) ? 1e9 : /^k/.test(m[3]) ? 1e3 : 1e6),
  },
  { re: new RegExp(String.raw`${HEDGE}${NUM}[\s-]million\b`, 'g'), key: 'million', scale: () => 1 },
  {
    re: new RegExp(
      String.raw`${HEDGE}${NUM} (?:[^\s.,;:]+ ){0,3}?(?:a|every|per|each) second\b|${HEDGE}${NUM}\s?(?:[^\s/.,;:]+\s?){0,3}?/\s?s\b`,
      'g',
    ),
    key: 'perSecond',
    scale: () => 1,
  },
  {
    re: new RegExp(String.raw`${HEDGE}${NUM}\s?(?:×|x\b)|${HEDGE}${NUM} times\b`, 'g'),
    key: 'ratio',
    scale: () => 1,
  },
  {
    re: new RegExp(
      String.raw`${HEDGE}${NUM}(?:\s?(M)\b)?[\s-]${COUNT_ADJECTIVES}(${COUNTED.map(([alt]) => alt).join('|')})\b`,
      'g',
    ),
    key: 'counts',
    scale: (m) => MULTIPLIER[m[3]] ?? 1,
  },
];

/** The hedge and the number a class's match captured: the per-second and ratio patterns have two alternatives. */
function hedgeOf(m, key) {
  return key === 'perSecond' || key === 'ratio' ? (m[1] ?? m[3]) : m[1];
}
function numberOf(m, key) {
  return key === 'perSecond' || key === 'ratio' ? (m[2] ?? m[4]) : m[2];
}

/**
 * Does a stated number round-match one the evidence supports? It must be that value at the precision it is written
 * to — `$0.0000816`, `$0.000082` and `$82` all state 0.0000816 at their own precision — and within 5% of it, so a
 * precision too coarse to mean anything (`$0`, `$0.0001`) cannot pass on a technicality. An integer that ends in
 * zeros may stand for a rounding to its last non-zero digit only when a hedge says so: "about 26,000" for 26,204,
 * but not "2,000 chunks" for 1,999. A bound candidate also needs its words (see `WORDS`) where it stands.
 */
function accounted(token, candidates, { hedged = false, context } = {}) {
  const plain = token.replace(/,/g, '');
  const x = Number(plain);
  if (!Number.isFinite(x)) return false;
  const dp = plain.includes('.') ? (plain.split('.')[1] ?? '').length : 0;
  const zeros = dp === 0 && hedged ? (/0+$/.exec(plain)?.[0].length ?? 0) : 0;
  return candidates.some((c) => {
    const v = typeof c === 'number' ? c : c.v;
    if (!(v > 0) || Math.abs(x - v) / v > 0.05) return false;
    let matches = v.toFixed(dp) === x.toFixed(dp);
    for (let z = 1; !matches && z <= zeros; z += 1)
      matches = Math.round(v / 10 ** z) * 10 ** z === x;
    return matches && (typeof c === 'number' || boundHolds(c, context));
  });
}

/** Whether a bound value's words stand where it does. No context means no binding can be judged: it fails. */
function boundHolds(c, context) {
  return [c, ...(c.also ?? [])].every((b) => holdsOne(b, context));
}

function holdsOne(c, context) {
  if (context === undefined) return !c.require;
  const nearest = (text, at) => {
    let best = null;
    for (const family of c.group) {
      for (const m of text.matchAll(WORDS[family])) {
        const d = m.index >= at ? m.index - at : at - (m.index + m[0].length);
        if (best === null || d < best.d) best = { d, family };
      }
    }
    return best;
  };
  const found = nearest(context.text, context.at) ?? nearest(context.caption ?? '', 0);
  if (found === null) return !c.require;
  return c.allow.includes(found.family);
}

// ── the units a figure is read in ──────────────────────────────────────────────────────────────────────────────

const cellsOf = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
/** The unit a table's column header gives its bare numbers: a `GETs` column's `204` is 204 GETs. */
function unitOfHeader(header) {
  const h = header.replace(/\*\*|`/g, '');
  for (const [re, unit] of [
    [/\bGETs?\b/, 'GETs'],
    [/\bPUTs?\b/, 'PUTs'],
    [/\bchunks?\b/, 'chunks'],
    [/\bids?\b/, 'ids'],
    [/\bms\b/, 'ms'],
    [/\bbytes\b/, 'bytes'],
  ]) {
    if (re.test(h)) return unit;
  }
  return null;
}
function withHeaderUnits(row, headers) {
  const cells = cellsOf(row);
  return `| ${cells
    .map((cell, i) => {
      const unit = unitOfHeader(headers[i] ?? '');
      const bare = cell.replace(/\*\*/g, '').trim();
      return unit !== null && /^[\d,.]+$/.test(bare) ? `${bare} ${unit}` : cell;
    })
    .join(' | ')} |`;
}

/**
 * A text's units of meaning: each sentence of a paragraph or list item, each row of a table — which carries its
 * table's caption and header, for a binding the row's own words do not settle — and each line of a diagram.
 */
function unitsOf(text) {
  const out = [];
  const lines = text.split('\n');
  let fence = false;
  let block = [];
  let lastProse = '';
  const flush = () => {
    if (block.length === 0) return;
    const joined = block.join(' ');
    lastProse = joined;
    // A sentence, or a clause after a semicolon: each makes a claim of its own, so a byte share in the next clause
    // cannot stand nearer a chunk share than the chunks its own clause names.
    for (const s of joined.split(/(?<=[.!?])\s+(?=[A-Z0-9*$(["“'])|(?<=;)\s+/)) {
      out.push({ text: s, caption: '' });
    }
    block = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) {
      if (line.trim() !== '') out.push({ text: line, caption: '' });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const table = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) table.push(lines[i++] ?? '');
      i -= 1;
      const isTable = table.length >= 2 && /^\s*\|[\s:|-]+\|\s*$/.test(table[1] ?? '');
      const header = isTable ? (table[0] ?? '') : '';
      const headers = isTable ? cellsOf(header) : [];
      for (const row of isTable ? table.slice(2) : table) {
        out.push({ text: withHeaderUnits(row, headers), caption: `${lastProse} ${header}` });
      }
      continue;
    }
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      flush();
      out.push({ text: line, caption: '' });
      lastProse = line;
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) flush();
    block.push(line.trim());
  }
  flush();
  return out;
}

/** Every figure in `text` that `values` cannot account for, as written, with the words beside it. */
function unaccounted(text, values) {
  const out = [];
  for (const unit of unitsOf(text)) {
    const t = normalize(unit.text);
    const caption = normalize(unit.caption);
    const claimed = new Set();
    for (const { re, key, scale } of CLASSES) {
      for (const m of t.matchAll(re)) {
        const token = numberOf(m, key) ?? '';
        const at = m.index + m[0].indexOf(token);
        if (claimed.has(at)) continue;
        claimed.add(at);
        // "1M loads" is the unit a price is quoted per — "$11.20 / 1M loads" — not a count of a million loads.
        if (key === 'counts' && m[3] === 'M' && token === '1') continue;
        let candidates;
        if (key === 'counts') {
          const noun = COUNTED.find(([alt]) => new RegExp(`^(?:${alt})$`).test(m[4] ?? ''))?.[1];
          const s = scale(m);
          candidates = (values.counts[noun] ?? []).map((c) =>
            typeof c === 'number' ? c / s : { ...c, v: c.v / s },
          );
        } else {
          const s = scale(m);
          candidates = (values[key] ?? []).map((c) =>
            typeof c === 'number' ? c / s : { ...c, v: c.v / s },
          );
        }
        const context = { text: t, at, caption };
        if (!accounted(token, candidates, { hedged: hedgeOf(m, key) !== undefined, context })) {
          out.push(m[0].trim());
        }
      }
    }
    // "N of M chunks" and "N of M intersects": the two numbers, together.
    for (const [re, pairs] of [
      [/(\d[\d,]*) of (?:the |its |their |all )?(\d[\d,]*) chunks\b/g, values.pairs.chunks ?? []],
      [
        /(\d[\d,]*) of (?:the |all )?(\d[\d,]*) (?:cold )?intersects\b/g,
        values.pairs.intersects ?? [],
      ],
    ]) {
      for (const m of t.matchAll(re)) {
        const a = Number(m[1].replace(/,/g, ''));
        const b = Number(m[2].replace(/,/g, ''));
        if (!pairs.some(([x, y]) => x === a && y === b)) out.push(m[0]);
      }
    }
    // "N PUT + M GET": a request shape the run has, both halves together.
    for (const m of t.matchAll(
      /(\d+)\s?PUTs?(?:-class)?(?:\s+requests?)?,?\s*(?:\+|and|plus)\s*(\d+)\s?GETs?\b/g,
    )) {
      const p = Number(m[1]);
      const g = Number(m[2]);
      if (!(values.shapes ?? []).some(([x, y]) => x === p && y === g)) out.push(m[0]);
    }
  }
  return out;
}

/** Whether `text` states `figure` as a whole figure — not inside a longer number, as `5.0%` is inside `95.0%`. */
function statesFigure(text, figure) {
  const escaped = normalize(figure).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.,])${escaped}(?![\\d])`).test(normalize(visible(text)));
}

// ── where a document talks about a run ─────────────────────────────────────────────────────────────────────────

const RUN_ID_IN_TEXT = /\b\d{4}-\d{2}-\d{2}-[a-z0-9]+\b/g;

/**
 * The part of a markdown document about one run: from the heading that names it, down to the next heading at its
 * level or above — or to any heading, at any depth, that names a different run, since a subsection about another
 * run is not about this one. Null when no heading names the run.
 */
function runSection(doc, runId) {
  const lines = doc.split('\n');
  const heading = /^(#{1,6}) /;
  const at = lines.findIndex((l) => heading.test(l) && l.includes(runId));
  if (at === -1) return null;
  const level = heading.exec(lines[at])[1].length;
  const end = lines.findIndex((l, i) => {
    const h = i > at ? heading.exec(l) : null;
    if (h === null) return false;
    return h[1].length <= level || (l.match(RUN_ID_IN_TEXT) ?? []).some((other) => other !== runId);
  });
  return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

/**
 * Every paragraph of `doc` that names the run — by its id in the text a reader sees, a link's target aside, or by
 * one of the names a page calls it — a list item counting as a paragraph of its own. A figure beside a run's name is
 * a claim about that run, and the other items of a list it sits in are not.
 */
function paragraphsNaming(doc, runId, aliases = []) {
  const names = (block) => {
    const seen = visible(block).replace(/\]\([^)]*\)/g, ']');
    return seen.includes(runId) || aliases.some((a) => seen.includes(a));
  };
  return doc
    .split(/\n\s*\n/)
    .flatMap((block) => block.split(/\n(?=\s*(?:[-*+]|\d+\.) )/))
    .filter(names)
    .join('\n\n');
}

/**
 * What a markdown page says about a run: its section, and every other paragraph that names it, other runs'
 * sections aside — a paragraph about the July run that mentions the September one is still about July.
 */
function claimsAbout(doc, runId, aliases = []) {
  const section = runSection(doc, runId);
  let rest = section === null ? doc : doc.replace(section, '');
  const others = new Set(
    doc
      .split('\n')
      .filter((l) => /^#{1,6} /.test(l))
      .flatMap((l) => l.match(RUN_ID_IN_TEXT) ?? [])
      .filter((id) => id !== runId),
  );
  for (const other of others) {
    const theirs = runSection(rest, other);
    if (theirs !== null) rest = rest.replace(theirs, '');
  }
  return { section, elsewhere: paragraphsNaming(rest, runId, aliases) };
}

module.exports = {
  readSources,
  evidenceFiles,
  derive,
  unaccounted,
  accounted,
  statesFigure,
  normalize,
  visible,
  unitsOf,
  runSection,
  paragraphsNaming,
  claimsAbout,
  valuesFromFigures,
  mergeValues,
  unbound,
  STORE_LOAD_REQUESTS,
  format: { int, fixed, usd, pct },
};
