'use strict';
/*
 * Real-cloud calibration for the LOADED STORE — load throughput, cold intersect latency, and what a
 * single-bucket topology actually costs.
 *
 * WHY THIS EXISTS. The pointer lives in the same bucket as the data, so resolving a generation costs an object
 * GET and advancing it costs a conditional PUT, and a published bill has to include both. `docs/benchmarks.md`
 * publishes what a run measured and lists what is still owed. This is the tool that measures it.
 *
 * IT SPENDS REAL MONEY, so it is built to be hard to run by accident and impossible to run blind. The guards live
 * in `bench/lib/calibrate-guards.cjs` as pure functions, and `tests/bench/calibrate-guards.test.ts` holds each one
 * to the defect it exists for. Read that file before changing anything here.
 *
 *   node bench/calibrate-aws.cjs                             projection only; touches nothing
 *   node bench/calibrate-aws.cjs --rehearse                  the workload against MinIO, free — no money guards
 *   node bench/calibrate-aws.cjs --run                       the real thing (region + ceiling + confirmation)
 *   node bench/calibrate-aws.cjs [--rehearse] --cleanup <id> remove a run's resources after a hard kill
 *   bash bench/calibrate-cloudshell.sh                       --run from AWS CloudShell, against the PUBLISHED
 *                                                            packages — the only way latency means anything
 *
 * WHAT A RUN CAN AND CANNOT CLAIM. A request costs the same from anywhere, and the timed stores never re-read their
 * pointers on a timer, so the request count does too (on the default 2 s pointer refresh, a slow client re-reads
 * it); what a client far from the region adds to the bill is transfer out, which this harness does not meter.
 * LATENCY is location-dependent: from outside the region it measures internet transit, and a p50 measured from a
 * laptop describes the network, not the library. So every run measures its own distance to the region (the
 * round-trip floor of a trivial request) and records it, and the results say whether the latency figures are
 * in-region or not. A number that cannot be told apart from the network is not a latency number.
 *
 * WHAT THE REHEARSAL DOES NOT COVER. MinIO is not AWS. It proves the mechanics — stages, metering, teardown
 * order, the probe, the end-of-run projection check, signal handling — but not the money guards. The region,
 * confirmation, spend-ceiling and account checks do not run in a rehearsal at all: the ceiling is parsed and
 * compared by pure functions with their own tests, and the rest are single comparisons made before anything is
 * created. Nor can it rehearse a versioned-bucket teardown or an in-flight multipart abort on a real account, or
 * reproduce `us-east-1` answering 200 OK to `CreateBucket` on a bucket you already own. Those meet reality for the
 * first time on a real account, which is why the probe refuses anything but a clean 404.
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const { meter, priceTally } = require('./lib/aws-meter.cjs');
const {
  CONFIRM_PHRASE,
  RETRY_BOUND,
  CHUNK_SPAN,
  DEFAULT_LAYOUT,
  parseCeiling,
  resolveSize,
  probeMeansAbsent,
  exceedsProjection,
  breached,
  firstLoads,
  planLayout,
  planSweepLayout,
  layoutIds,
  maskAccount,
  redact,
  resultsFile,
  stampOf,
  checkRunId,
  checkRunRegion,
  TIMED_STORE,
  warmStore,
  clientConfigs,
  bucketIsGone,
  uploadIsGone,
  TEARDOWN_PASSES,
  TEARDOWN_PUTS,
  checkCleanupId,
  evidenceConflict,
  checkWorkload,
  STORE_PREFIX,
  foreignKeys,
  MAX_LISTING_PAGES,
  leftoversHint,
} = require('./lib/calibrate-guards.cjs');
const { planSpread, spreadIds } = require('./lib/calibrate-spread.cjs');
const {
  DISCARDS_PER_RUN,
  DISCARDS_PER_STAGE,
  transientFault,
  quiesce,
  discardLedger,
  discardedRequests,
  keptRequests,
  parseFaultGets,
  injectFaults,
} = require('./lib/calibrate-samples.cjs');
const {
  STAGES,
  parseSweep,
  coldIntersectGets,
  modelRounds,
  projectStages,
  expectedReads,
  firstLoadRequests,
} = require('./lib/calibrate-stages.cjs');
const {
  interruptGate,
  failureOf,
  stopThenTearDown,
  exitCodeAfterSignal,
  holdTerminal,
  silenceTerminal,
  writeResultsFile,
  resultsJson,
  harnessRef,
  measuredVersion,
  measuredSdk,
  sdkFaultClasses,
  describeFault,
  SDK_DEFAULT_MAX_SOCKETS,
} = require('./lib/calibrate-process.cjs');

const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
/**
 * `--rehearse` is a TARGET, not a mode, so it composes with `--cleanup`. As a mode it would leave the rehearsal —
 * the one you iterate on, and so the one most likely to leave a half-made bucket — with no way to clean up.
 */
const REHEARSE = argv.includes('--rehearse');
// A rehearsal touches no cloud account and `--run` is the one mode that spends money, so the pair asks for two
// targets at once and is refused before anything else is read.
if (REHEARSE && argv.includes('--run')) {
  console.error(
    'calibrate: --rehearse and --run are exclusive — a rehearsal touches no cloud account',
  );
  process.exit(2);
}
const MODE = argv.includes('--cleanup')
  ? 'cleanup'
  : argv.includes('--run')
    ? 'run'
    : REHEARSE
      ? 'rehearse'
      : 'project';

// ---- the workload ----------------------------------------------------------------------------------------------
// Every size is overridable so a run can be made smaller; an explicit 0 really means 0.
const SEGMENTS = resolveSize(process.env.CR_CALIBRATE_SEGMENTS, 20, 'CR_CALIBRATE_SEGMENTS');
const IDS = resolveSize(process.env.CR_CALIBRATE_IDS, 500_000, 'CR_CALIBRATE_IDS');
const READS = resolveSize(process.env.CR_CALIBRATE_READS, 40, 'CR_CALIBRATE_READS');
/** The spread layout's segments and cold intersects: the calibration overlap, with the shared chunks scattered. */
const SPREAD_SEGMENTS = resolveSize(
  process.env.CR_CALIBRATE_SPREAD_SEGMENTS,
  10,
  'CR_CALIBRATE_SPREAD_SEGMENTS',
);
const SPREAD_READS = resolveSize(
  process.env.CR_CALIBRATE_SPREAD_READS,
  40,
  'CR_CALIBRATE_SPREAD_READS',
);
/** The spread layout's seed. Fixed, so a rehearsal and a real run read the same keys. */
const SPREAD_SEED = 1;
/** How many segments each overlap in the sweep loads for itself; its intersects pair them in turn. */
const SWEEP_SEGMENTS = resolveSize(
  process.env.CR_CALIBRATE_SWEEP_SEGMENTS,
  3,
  'CR_CALIBRATE_SWEEP_SEGMENTS',
);
/** The calibration segments the point reads open: each read from its first shared chunk to its last. */
const POINT_SEGMENTS = resolveSize(
  process.env.CR_CALIBRATE_POINT_SEGMENTS,
  Math.min(SEGMENTS, 10),
  'CR_CALIBRATE_POINT_SEGMENTS',
);
/** `andNot` calls, each of one calibration segment against this many others. */
const ANDNOT_CALLS = resolveSize(
  process.env.CR_CALIBRATE_ANDNOT_CALLS,
  10,
  'CR_CALIBRATE_ANDNOT_CALLS',
);
const ANDNOT_EXCLUDES = resolveSize(
  process.env.CR_CALIBRATE_ANDNOT_EXCLUDES,
  10,
  'CR_CALIBRATE_ANDNOT_EXCLUDES',
);
/**
 * Segments large enough to be uploaded MULTIPART — the other half of "load throughput, single-part and
 * multipart". The S3 driver uses a single conditional PUT for anything that fits one 8 MiB part, and the intersect
 * workload's segments are far smaller, so without these a run never exercises multipart at all. These are dense (a
 * bitmap container per chunk, 8 KiB each) and never intersected, so they cannot disturb the intersect workload.
 */
const LARGE = resolveSize(process.env.CR_CALIBRATE_LARGE, 5, 'CR_CALIBRATE_LARGE');
const LARGE_CHUNKS = 1_536; // x 8 KiB bitmap containers ≈ 12 MiB: two 8 MiB parts
const LARGE_IDS_PER_CHUNK = 8_192; // above roaring's 4,096 array→bitmap threshold, so every container is a bitmap
const PART_SIZE = 8 * 1024 * 1024; // the S3 driver's default part size
/** Trivial requests timed to find this client's round-trip floor to the region. */
const RTT_SAMPLES = 10;
/**
 * How long an interrupted run waits for the requests it already sent before tearing down anyway. A request that
 * never answers must not hold the teardown forever; one that answers later than this can still land in the bucket,
 * and teardown's listings are what find it.
 */
const DRAIN_MS = 30_000;
/**
 * Below this floor the client is treated as in-region. An in-region S3 request is single-digit to low-tens of
 * milliseconds; a client on another continent cannot get under ~60 ms. The raw floor is recorded regardless, so
 * a reader can apply their own line — this only decides the label.
 */
const IN_REGION_FLOOR_MS = 30;

const log = (m) => console.log(`calibrate: ${m}`);
/**
 * Where a discarded sample runs again, for the two that do not get a fresh store: a point read that assumes a store
 * in a given state runs again on that store, put back in that state (the pointReads stage says why).
 */
const RUN_AGAIN = Object.freeze({
  'count() first read': 'on its store, once the store has forgotten the segment',
  'has() on an open segment': 'on the same store, which still holds the segment open',
});
function refuse(msg) {
  console.error(`calibrate: ${msg}`);
  process.exit(2);
}

/** The ids of large segment `i`: a bitmap-dense run of chunks, generated rather than materialised. */
function* largeIds() {
  for (let c = 0; c < LARGE_CHUNKS; c += 1) {
    for (let j = 0; j < LARGE_IDS_PER_CHUNK; j += 1) yield c * CHUNK_SPAN + j * 8;
  }
}

/** An upper bound on the parts a large segment needs: bitmap payloads plus a generous allowance for the index. */
function largePartsBound() {
  const bytes = LARGE_CHUNKS * (8_192 + 64) + 64 * 1024;
  return Math.ceil(bytes / PART_SIZE) + 1;
}

/**
 * What each stage loads and reads, from the layouts: the one input both the projection and the stages' own
 * expectations are computed from.
 */
function planWorkload({ layout, spread, sweep }) {
  const sharedChunks = layout.sharedChunks;
  return {
    loads: { segments: SEGMENTS, largeSegments: LARGE, partsBound: largePartsBound() },
    intersect: { reads: READS, sharedChunks },
    spread: {
      segments: spread === null ? 0 : SPREAD_SEGMENTS,
      reads: spread === null ? 0 : SPREAD_READS,
      sharedChunks: spread === null ? 0 : spread.sharedChunks,
    },
    sweep: { segments: SWEEP_SEGMENTS, entries: sweep },
    // The warm stage repeats the calibration intersects' pairs, which touch this many segments.
    warm: { segments: READS === 0 ? 0 : Math.min(SEGMENTS, READS + 1), sharedChunks },
    pointReads: { segments: POINT_SEGMENTS, sharedChunks },
    andNot: {
      calls: ANDNOT_CALLS,
      excludes: ANDNOT_EXCLUDES,
      includeChunks: layout.chunksPerSegment,
      sharedChunks,
    },
    retryBound: RETRY_BOUND,
    // The samples a run may discard after a transient fault, and run again (`calibrate-samples.cjs`).
    discards: { perRun: DISCARDS_PER_RUN, perStage: DISCARDS_PER_STAGE },
    // The probe HEAD and the round-trip samples, one attempt each; the bucket's creation; and teardown's listings
    // at every attempt its retrying client may make (see TEARDOWN_PUTS).
    fixedGets: 1 + RTT_SAMPLES,
    fixedPuts: 1 /* CreateBucket */ + TEARDOWN_PUTS,
  };
}

/**
 * The run's worst case, in requests and dollars: every stage's bound, and the fixed requests. It is checked against
 * the ceiling before anything is created, and the run is checked against it after teardown — so it has to be an upper
 * bound, not an estimate.
 */
function projection(pricing, workload) {
  const { stages, discards, costliestSample, total } = projectStages(workload);
  return {
    ops: total,
    stages,
    discards,
    costliestSample,
    priced: priceTally({ put: total.put, get: total.get }, pricing),
  };
}

/**
 * Verify the caller's identity — and tell the two kinds of failure apart.
 *
 * Only a missing module is reported as one. Catching EVERY error as "@aws-sdk/client-sts not installed" would blame
 * an expired SSO session or a wrong profile on a missing module — and an account pin compared against that
 * placeholder text could never succeed, so setting `CR_CALIBRATE_EXPECT_ACCOUNT` would stop every run, and the pin
 * would go unused.
 */
async function identity(region) {
  let sts;
  try {
    sts = require('@aws-sdk/client-sts');
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') return { verified: false, reason: 'module' };
    throw err;
  }
  // A failure HERE is a credentials problem, and every later request would fail the same way. Say so now.
  const out = await new sts.STSClient({ region }).send(new sts.GetCallerIdentityCommand({}));
  return { verified: true, account: out.Account };
}

// A `finally` does not run on a signal, so the handler has to do the teardown itself. It is replaced once there
// is something to tear down; until then an interrupt simply stops the run, which is the point of the abort
// window. Installing a SIGINT handler replaces Node's default exit, so a handler that only prints "tearing down
// before exit" does NEITHER: Ctrl-C leaves the workload running while claiming otherwise.
let onInterrupt = async () => {};
let interrupts = 0;
// Set once the workload has finished. A signal after that interrupts only teardown, so the run keeps its own exit
// code.
let workFinished = false;
// SIGHUP too: a closed terminal or a dropped CloudShell session sends it, and unhandled it kills a run with no
// teardown and no results. The terminal's streams are opened first, while there is a terminal (`holdTerminal`).
holdTerminal();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    // Nothing reads the terminal after a hang-up, so nothing more is written to it.
    if (sig === 'SIGHUP') silenceTerminal();
    interrupts += 1;
    if (interrupts > 1) {
      // A second signal during teardown must not kill the process mid-delete, leaking the bucket. Warn instead.
      console.error('calibrate: already tearing down — if anything is left, use --cleanup <runId>');
      return;
    }
    console.error(`\ncalibrate: ${sig} — stopping`);
    Promise.resolve()
      .then(() => onInterrupt())
      .catch((err) =>
        console.error(`calibrate: teardown after ${sig} failed: ${redact(err.message)}`),
      )
      .finally(() =>
        process.exit(exitCodeAfterSignal({ finished: workFinished, code: process.exitCode })),
      );
  });
}

async function main() {
  // Everything that can be refused from the inputs alone is refused first, before the library is even imported, so a
  // refusal holds on a checkout that has not been built and costs nothing to test.
  let sweep = [];
  try {
    // A cleanup loads nothing, so no workload setting can refuse it.
    if (MODE !== 'cleanup') {
      sweep = parseSweep(process.env.CR_CALIBRATE_SWEEP);
      checkWorkload({
        segments: SEGMENTS,
        largeSegments: LARGE,
        reads: READS,
        spreadSegments: SPREAD_SEGMENTS,
        spreadReads: SPREAD_READS,
        sweepSegments: SWEEP_SEGMENTS,
        sweepEntries: sweep.length,
        pointSegments: POINT_SEGMENTS,
        andNotCalls: ANDNOT_CALLS,
        andNotExcludes: ANDNOT_EXCLUDES,
      });
    }
  } catch (err) {
    refuse(err.message);
  }

  // A rehearsal's test-only fault hook: refused in every other mode, before anything, since a real run must never fail
  // a request on purpose, and a projection would apply it to nothing.
  let faultGets = [];
  if (process.env.CR_CALIBRATE_FAULT_GETS !== undefined) {
    if (MODE !== 'rehearse') {
      refuse('CR_CALIBRATE_FAULT_GETS is for a rehearsal only (--rehearse); unset it');
    }
    try {
      faultGets = parseFaultGets(process.env.CR_CALIBRATE_FAULT_GETS);
    } catch (err) {
      refuse(err.message);
    }
  }

  // The run id, and everything that depends only on it: a bad id, or one whose evidence is already committed, is
  // refused in every mode, projection included, before anything reads a credential. `--cleanup` takes any id that
  // names a legal bucket, because it writes no file.
  const runId =
    MODE === 'cleanup'
      ? argv[argv.indexOf('--cleanup') + 1]
      : (process.env.CR_CALIBRATE_RUN_ID ??
        `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 5)}`);
  if (MODE === 'cleanup' && (runId === undefined || runId.startsWith('--'))) {
    refuse('--cleanup needs a run id: node bench/calibrate-aws.cjs --cleanup 2026-09-22-ab12e');
  }
  try {
    if (MODE === 'cleanup') checkCleanupId(runId);
    else checkRunId(runId);
  } catch (err) {
    refuse(err.message);
  }
  // One evidence file per real run, named by its id; a run that does not finish writes a partial file beside it,
  // and a rehearsal writes its own. `resultsFile` says where each goes, and `.gitignore` ignores all but the first.
  const out = MODE === 'cleanup' ? null : resolve(ROOT, resultsFile(REHEARSE, runId));
  const outPartial =
    MODE === 'cleanup' ? null : resolve(ROOT, resultsFile(REHEARSE, runId, { partial: true }));
  const conflict =
    out === null ? null : evidenceConflict({ rehearse: REHEARSE, file: out, exists: existsSync });
  if (conflict !== null) refuse(conflict.replace(`${ROOT}/`, ''));

  let ceiling = Number.POSITIVE_INFINITY;
  let region = 'us-east-1';
  let clientOpts = {
    endpoint: 'http://127.0.0.1:9000',
    region,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true,
  };

  if (!REHEARSE && (MODE === 'run' || MODE === 'cleanup')) {
    // Each of these refuses BEFORE anything exists. A run that cannot state its region, its ceiling and its
    // intent in three separate places is a run someone started by accident.
    region = process.env.CR_CALIBRATE_REGION ?? '';
    if (region === '')
      refuse('CR_CALIBRATE_REGION must be set explicitly — refusing to guess a region');
    clientOpts = { region };
  }
  if (MODE === 'run') {
    try {
      checkRunRegion(region);
    } catch (err) {
      refuse(err.message);
    }
    // The ceiling is parsed before the confirmation is read: both are inputs alone, and this order lets a test reach
    // each refusal without ever holding the phrase.
    try {
      ceiling = parseCeiling(process.env.CR_CALIBRATE_MAX_USD);
    } catch (err) {
      refuse(err.message);
    }
    if (process.env.CR_CALIBRATE_CONFIRM !== CONFIRM_PHRASE) {
      refuse(`set CR_CALIBRATE_CONFIRM=${CONFIRM_PHRASE} to authorise a run that spends money`);
    }
  }

  // A cleanup needs neither the library nor a projection, so it also runs on a checkout that has not been built.
  let pricing;
  let packageVersion;
  let sdk;
  let layout;
  let spread = null;
  let sweepLayouts = [];
  let plan;
  let ops;
  let stageBounds;
  let discardBound;
  let costliestSample;
  let priced;
  if (MODE !== 'cleanup') {
    let AWS_US_EAST_1_ONDEMAND;
    ({ AWS_US_EAST_1_ONDEMAND } = await import('@cloudbitmaps/roaring'));
    packageVersion = measuredVersion(ROOT);
    sdk = measuredSdk(ROOT);
    pricing = AWS_US_EAST_1_ONDEMAND;
    layout = planLayout({ segments: SEGMENTS, idsPerSegment: IDS, ...DEFAULT_LAYOUT });
    // The spread layout has the calibration layout's overlap: the same shared chunks, the same ids in every chunk.
    if (SPREAD_SEGMENTS > 0) {
      spread = planSpread({
        segments: SPREAD_SEGMENTS,
        sharedChunks: layout.sharedChunks,
        privateChunks: layout.privateChunks,
        idsPerChunk: Math.max(1, Math.round(IDS / layout.chunksPerSegment)),
        stride: DEFAULT_LAYOUT.stride,
        seed: SPREAD_SEED,
      });
    }
    sweepLayouts = sweep.map((e) =>
      planSweepLayout({
        segments: SWEEP_SEGMENTS,
        sharedChunks: e.k,
        privateIds: layout.priv,
        stride: DEFAULT_LAYOUT.stride,
      }),
    );
    plan = planWorkload({ layout, spread, sweep });
    ({
      ops,
      stages: stageBounds,
      discards: discardBound,
      costliestSample,
      priced,
    } = projection(pricing, plan));
  }

  if (MODE === 'project') {
    log('PROJECTION ONLY — nothing created, no credentials read.\n');
    console.log(
      `  workload     ${SEGMENTS} x ${IDS} ids (${layout.chunksPerSegment} chunks each, ${layout.sharedChunks} shared)` +
        ` + ${LARGE} multipart segments of ${LARGE_CHUNKS} dense chunks`,
    );
    const rows = {
      load: `${SEGMENTS + LARGE} loads through store.load()`,
      intersect: `${READS} cold intersects, k = ${layout.sharedChunks}`,
      spread: `${plan.spread.segments} segments, ${plan.spread.reads} cold intersects, k = ${plan.spread.sharedChunks} spread over ${spread?.span ?? 0} keys`,
      sweep:
        sweep.length === 0
          ? 'none'
          : sweep
              .map((e) => `${e.intersects} at k = ${e.k}`)
              .join(', ')
              .concat(` (${SWEEP_SEGMENTS} segments each)`),
      warm: `${READS} repeats of the calibration pairs from memory, asserted at 0 GET`,
      pointReads: `count() cold and warm on ${POINT_SEGMENTS} segments, then has() on every shared chunk: open segment, warm, first read`,
      andNot: `${ANDNOT_CALLS} calls, one segment against ${ANDNOT_EXCLUDES}`,
    };
    for (const name of STAGES) {
      const b = stageBounds[name];
      console.log(
        `  ${name.padEnd(11)} ${String(b.put).padStart(4)} PUT-class ${String(b.get).padStart(7)} GET-class  ${rows[name]}`,
      );
    }
    console.log(
      `  ${'discards'.padEnd(11)} ${String(discardBound.put).padStart(4)} PUT-class ${String(discardBound.get).padStart(7)} GET-class  ` +
        `up to ${DISCARDS_PER_RUN} samples run again after a transient fault, each at most the costliest sample's ${costliestSample}`,
    );
    console.log(
      `  fixed        ${String(plan.fixedPuts).padStart(4)} PUT-class ${String(plan.fixedGets).padStart(7)} GET-class  bucket, probe, round-trip samples, teardown`,
    );
    console.log(
      `  projected    ${ops.put} PUT-class, ${ops.get} GET-class — an upper bound, checked after the run`,
    );
    console.log(`  projected $  ${priced.totalUSD.toFixed(6)} at ${pricing.name}`);
    console.log('\n  --rehearse   the workload against MinIO, free — the money guards do not run');
    console.log('  --run        the real thing (needs region + ceiling + confirmation)');
    return 0;
  }

  if (MODE === 'run') {
    // The projection is an upper bound, so refusing here means the run genuinely cannot fit the ceiling.
    if (breached(priced.totalUSD, ceiling)) {
      refuse(
        `projected $${priced.totalUSD.toFixed(6)} meets or exceeds the $${ceiling} ceiling — ` +
          'nothing was created. Raise CR_CALIBRATE_MAX_USD or shrink the workload.',
      );
    }
  }

  const s3 = require('@aws-sdk/client-s3');
  // What counts as a transient fault, from the SDK that sends the requests (`sdkFaultClasses`). Read before anything is
  // created: a harness that could not tell one would fail the run on the first.
  const sdkFaults = MODE === 'cleanup' ? null : sdkFaultClasses(ROOT);
  // Two clients, metered into one bill: the workload's makes one attempt per request, teardown's keeps its retries.
  // `clientConfigs` says why, and the tests drive both against a server that fails on purpose.
  const configs = clientConfigs(clientOpts);
  const client = new s3.S3Client(configs.work);
  const tally = meter(client);
  // A rehearsal's injected faults, on the workload's client alone; refused above in every other mode.
  if (faultGets.length > 0) injectFaults(client, faultGets);
  // A signal stops the workload's client before teardown lists anything: `interruptGate` says why. Teardown's own
  // client is never gated.
  const gate = interruptGate(client);
  const admin = new s3.S3Client(configs.admin);
  meter(admin, tally);

  const bucket = `cloudbitmaps-calib-${runId}`;

  /**
   * Teardown, memoised: one promise awaited by every exit path — the `finally`, the signal handler, and the
   * top-level catch — because they otherwise race, and a racing exit can kill an in-flight delete.
   */
  let teardownPromise;
  const teardown = ({ unanswered = false } = {}) => {
    teardownPromise ??= (async () => {
      const leftovers = [];
      // Set when the bucket holds keys the harness never writes: `--cleanup` would only refuse it again.
      let notOurs = false;
      const listUploads = (marker = {}) =>
        admin.send(new s3.ListMultipartUploadsCommand({ Bucket: bucket, ...marker }));
      const listVersions = (marker = {}) =>
        admin.send(new s3.ListObjectVersionsCommand({ Bucket: bucket, ...marker }));
      const versionsOf = (page) =>
        [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((o) => ({
          Key: o.Key,
          VersionId: o.VersionId,
        }));
      // Every page of a listing, from its first. A bucket this harness made fits one page, so the rest are read only
      // for a bucket it did not make, and no more than MAX_LISTING_PAGES of them.
      const allPages = async (first, list, after) => {
        const pages = [first];
        while (pages[pages.length - 1].IsTruncated) {
          if (pages.length === MAX_LISTING_PAGES) {
            throw new Error(
              `its listing runs past ${MAX_LISTING_PAGES} pages, which no bucket this harness made does — ` +
                'refusing to touch anything in it; inspect it by hand',
            );
          }
          pages.push(await list(after(pages[pages.length - 1])));
        }
        return pages;
      };
      // A key the harness did not write means this is not the harness's bucket, whatever its name says.
      const refuseForeign = (keys) => {
        const foreign = foreignKeys(keys);
        if (foreign.length === 0) return;
        notOurs = true;
        throw new Error(
          `it holds ${foreign.length} key(s) outside ${STORE_PREFIX}/, which this harness never writes, such as ` +
            `"${String(foreign[0])}" — refusing to touch anything in it; inspect it by hand`,
        );
      };
      try {
        // Everything teardown would touch is listed, and checked, before anything is aborted or deleted: an upload
        // may be someone else's as much as an object may. Checked as it goes, teardown would abort a foreign upload
        // before the objects were checked, and find a foreign key on a later page only after a page of objects had
        // gone.
        const uploads = (
          await allPages(await listUploads(), listUploads, (page) => ({
            KeyMarker: page.NextKeyMarker,
            UploadIdMarker: page.NextUploadIdMarker,
          }))
        ).flatMap((page) => page.Uploads ?? []);
        const first = await listVersions();
        const pages = await allPages(first, listVersions, (page) => ({
          KeyMarker: page.NextKeyMarker,
          VersionIdMarker: page.NextVersionIdMarker,
        }));
        refuseForeign([
          ...uploads.map((u) => u.Key),
          ...pages.flatMap(versionsOf).map((o) => o.Key),
        ]);
        // Abort in-flight multipart uploads first: their parts are billed, and a real `DeleteBucket` fails while
        // they exist. MinIO cannot rehearse this on a real account's terms. An upload already gone — completed by
        // the workload meanwhile, or aborted by an attempt whose answer was lost — is done, not an error.
        for (const u of uploads) {
          try {
            await admin.send(
              new s3.AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: u.Key,
                UploadId: u.UploadId,
              }),
            );
          } catch (err) {
            if (!uploadIsGone(err)) throw err;
          }
        }
        // Versions, not just objects: `ListObjectsV2` + `DeleteObjects` cannot empty a versioned bucket. The first
        // pass deletes what the first listing showed, and each later pass lists what is left, until nothing is.
        // Bounded: a key that cannot be deleted is reported inside a 200, where no retry sees it, and must end in
        // LEFTOVERS rather than in a listing loop.
        let listing = first;
        for (let pass = 0; ; pass += 1) {
          if (pass > 0) listing = await listVersions();
          const objects = versionsOf(listing);
          if (objects.length === 0) break;
          // Anything written since the first listing is held to the same rule.
          refuseForeign(objects.map((o) => o.Key));
          if (pass === TEARDOWN_PASSES) {
            throw new Error(
              `${objects.length}${listing.IsTruncated ? '+' : ''} object versions still listed after ${pass} delete passes`,
            );
          }
          // NOT spread into a plain object: a command carries `resolveMiddleware` on its prototype.
          await admin.send(
            new s3.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
          );
        }
        await admin.send(new s3.DeleteBucketCommand({ Bucket: bucket }));
        log(`teardown: removed ${bucket}`);
      } catch (err) {
        // "Already gone" is success, not a leftover — crying wolf trains you to ignore the one real signal. Only
        // S3's own NoSuchBucket says so: an abort's NoSuchUpload is also a 404, and is not this answer. Unless a
        // request was still unanswered when teardown began: if that was the bucket's creation, the bucket can
        // appear after teardown looked, with nothing else to say so.
        if (!bucketIsGone(err)) leftovers.push(`${bucket}: ${redact(err.message)}`);
        else if (unanswered) {
          leftovers.push(
            `${bucket}: not there when teardown looked, but a request was still unanswered; if it was the ` +
              "bucket's creation, the bucket may exist now",
          );
        }
      }
      if (leftovers.length > 0) {
        console.error('calibrate: LEFTOVERS — these still exist and may cost money:');
        for (const l of leftovers) console.error(`  ${l}`);
        console.error(leftoversHint({ notOurs, rehearse: REHEARSE, runId }));
        process.exitCode = 1;
      }
      return leftovers;
    })();
    return teardownPromise;
  };

  // ---- identity, before anything is created or deleted -------------------------------------------------------------
  // A cleanup is checked too: it permanently deletes every version of every key in the bucket it is given, so the
  // account pin holds for it as for the mode that creates.
  if (!REHEARSE && (MODE === 'run' || MODE === 'cleanup')) {
    const expected = process.env.CR_CALIBRATE_EXPECT_ACCOUNT ?? '';
    let who;
    try {
      who = await identity(region);
    } catch (err) {
      refuse(
        `could not verify credentials (${err.name ?? 'error'}: ${redact(err.message)}) — every later request ` +
          'would fail the same way. Check the profile or re-authenticate, then run again.',
      );
    }
    if (!who.verified && expected !== '') {
      refuse(
        'CR_CALIBRATE_EXPECT_ACCOUNT is set but @aws-sdk/client-sts is not installed, so it cannot be checked',
      );
    }
    if (who.verified && expected !== '' && who.account !== expected) {
      // Compared in full, printed masked: the comparison needs the id, the log does not.
      refuse(
        `account is ${maskAccount(who.account)}, expected ${maskAccount(expected)} — refusing`,
      );
    }
    log(
      `identity: account ${who.verified ? maskAccount(who.account) : '(not verified — install @aws-sdk/client-sts)'}` +
        `, region ${region}${expected !== '' ? ', matches CR_CALIBRATE_EXPECT_ACCOUNT' : ''}`,
    );
    if (MODE === 'run') {
      // A human check that works even without a pin. Confirm the last four digits are the account you meant.
      log(
        `projected $${priced.totalUSD.toFixed(6)} (an upper bound) against the $${ceiling} ceiling`,
      );
      log('Ctrl-C within 10 s to abort — nothing has been created yet.');
      await sleep(10_000);
    }
  }

  if (MODE === 'cleanup') {
    // A signal waits for the cleanup it interrupts, which then reports what it left. The default handler would exit
    // at once, mid-delete, with every object still there and nothing said.
    onInterrupt = async () => {
      await teardown();
    };
    log(`cleanup: removing resources for run ${runId}`);
    return (await teardown()).length === 0 ? 0 : 1;
  }

  // ---- probe BEFORE create --------------------------------------------------------------------------------------
  // Only a genuine not-found counts as absent: `HeadBucket` answers 403 for a bucket you own but cannot list,
  // and in us-east-1 `CreateBucket` on a bucket you already own returns 200 OK — so reading 403 as absent would
  // run the workload inside your bucket and then delete it on teardown.
  let probeErr;
  try {
    await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    probeErr = err;
  }
  if (probeErr === undefined)
    refuse(`${bucket} already exists — refusing to touch a pre-existing bucket`);
  if (!probeMeansAbsent(probeErr)) {
    refuse(
      `could not prove ${bucket} is absent (${probeErr.name ?? redact(probeErr.message)}) — refusing rather than ` +
        'guessing. A 403 means a bucket you own but cannot list.',
    );
  }

  const started = Date.now();
  const results = {
    note: "Written by bench/calibrate-aws.cjs. A real run's evidence is write-once: a new run gets a new id.",
    runId,
    // Run order, when two runs share a date: the id's suffix is random, so it cannot say which came later.
    startedAt: new Date(started).toISOString(),
    mode: MODE,
    // A rehearsal's numbers must never be mistaken for a real run's. The MinIO client is configured with a region
    // only because the SDK requires one.
    target: REHEARSE ? 'minio (rehearsal — NOT a real cloud measurement)' : 'aws',
    region: REHEARSE ? 'n/a (local container)' : region,
    measured: {
      packageVersion,
      harness: harnessRef(ROOT),
      node: process.version,
      // The AWS SDK that sent every request, and the socket cap of its handler, which bounds how many a stage can have
      // in flight. The cap is the SDK's own default and the harness does not set it.
      sdk,
      maxSockets: SDK_DEFAULT_MAX_SOCKETS,
      maxSocketsSource: 'the SDK default, not set by the harness',
    },
    pricing: pricing.name,
    workload: {
      segments: SEGMENTS,
      idsPerSegment: IDS,
      chunksPerSegment: layout.chunksPerSegment,
      sharedChunks: layout.sharedChunks,
      largeSegments: LARGE,
      largeChunks: LARGE_CHUNKS,
      largeIdsPerSegment: LARGE_CHUNKS * LARGE_IDS_PER_CHUNK,
      coldIntersects: READS,
      // Everything every stage loads and reads, as the projection was computed from it.
      plan,
    },
    projected: ops,
    projectedStages: stageBounds,
    // What the samples a run may discard can cost, beside the stages' bounds: each at the costliest sample's bound.
    projectedDiscards: { ...discardBound, costliestSample },
    // A rehearsal's injected faults, each a GetObject request and the fault it met.
    ...(faultGets.length > 0 ? { injectedFaults: faultGets } : {}),
    partial: true,
    phases: {},
  };
  const writeResults = () => {
    results.elapsedMs = Date.now() - started;
    // Only a run that finished is evidence. One that did not goes to the partial file, which the figures gates skip.
    const finished = results.partial === false && results.interrupted !== true;
    const file = finished ? out : outPartial;
    // Nothing is replaced: the check before the run is not the last word, and two runs under one id must not both
    // win. A run whose name was taken meanwhile goes beside it, under a name carrying its start (`writeResultsFile`).
    const fallback = REHEARSE
      ? undefined
      : resolve(ROOT, resultsFile(false, runId, { stamp: stampOf(results.startedAt) }));
    const rel = (f) => f.replace(`${ROOT}/`, '');
    const wrote = writeResultsFile({
      file,
      fallback,
      text: resultsJson(results),
      overwrite: REHEARSE,
    });
    if (wrote !== file) {
      console.error(
        `calibrate: ${rel(file)} already exists, so this run's results went to ${rel(wrote)} — nothing was replaced`,
      );
      process.exitCode = 1;
    }
    log(`wrote ${rel(wrote)}${finished ? '' : ' (partial: true)'}`);
  };

  /**
   * The bill and the projection check, then the results — run AFTER teardown, so its requests are in the bill
   * too. Nothing extra ran for the bill: in this topology the pointer reads and conditional PUTs ARE object-store
   * requests, so the meter already counts them. Both exits call this, the `finally` and an interrupt: an interrupt
   * path that wrote its results without it would lose the one figure the run had already paid for.
   */
  // Once only: both exits can reach it, the signal handler's and main's own, and the results are the same either way.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    results.cost = {
      ...priceTally(tally, pricing),
      ops: { ...tally, byCommand: { ...tally.byCommand } },
    };
    const over = exceedsProjection(tally, ops);
    // Each stage against its own bound too, so a stage that overspent is named even when the run as a whole did not. A
    // stage's bound is for the samples it kept; the ones every stage discarded are held together to the allowance for
    // discards, the cut-short stage's included.
    for (const name of STAGES) {
      const record = results.phases[name];
      if (record === undefined) continue;
      const kept = keptRequests(record);
      const used = {
        put: kept.put + (record.setup?.requests.put ?? 0),
        get: kept.get + (record.setup?.requests.get ?? 0),
      };
      for (const m of exceedsProjection(used, stageBounds[name])) over.push(`${name}: ${m}`);
    }
    const discarded = discardedRequests([
      ...STAGES.flatMap((name) => results.phases[name]?.discarded ?? []),
      ...(discards.unfinished?.discarded ?? []),
    ]);
    for (const m of exceedsProjection(discarded, discardBound)) {
      over.push(`discarded samples: ${m}`);
    }
    // How many samples the run discarded, against its bounds; and a stage a failure cut short, with what it discarded
    // before it, since a stage records its own discards only when it finishes.
    results.discards = {
      count: discards.count,
      perRun: discards.perRun,
      perStage: discards.perStage,
      ...(discards.unfinished === null ? {} : { unfinished: discards.unfinished }),
    };
    if (over.length > 0) {
      // The projection is only a ceiling if the run cannot exceed it. It just did, so the next change is to the
      // projection — before this harness is trusted with another pre-flight check.
      results.projectionExceeded = over;
      console.error(`calibrate: PROJECTION EXCEEDED — ${over.join('; ')}`);
      process.exitCode = 1;
    }
    log(
      `cost: $${results.cost.totalUSD.toFixed(6)} over ${tally.put} PUT-class + ${tally.get} GET-class`,
    );
    writeResults();
  };

  // The meter's counters at one instant. A stage's requests and bytes are the difference between two snapshots.
  const snap = () => ({
    put: tally.put,
    get: tally.get,
    up: tally.bytesUp,
    down: tally.bytesDown,
    parts: tally.byCommand.UploadPartCommand ?? 0,
    rangeN: tally.reads.range.n,
    rangeBytes: tally.reads.range.bytes,
    suffixN: tally.reads.suffix.n,
    suffixBytes: tally.reads.suffix.bytes,
    wholeN: tally.reads.whole.n,
    wholeBytes: tally.reads.whole.bytes,
    requestMs: tally.requestMs,
  });
  // What was sent between two snapshots, in the shape the meter's own tally has, so a stage's file can be read the
  // way the run's totals are.
  const requestsBetween = (a, b) => ({
    put: b.put - a.put,
    get: b.get - a.get,
    bytesUp: b.up - a.up,
    bytesDown: b.down - a.down,
    parts: b.parts - a.parts,
    reads: {
      whole: { n: b.wholeN - a.wholeN, bytes: b.wholeBytes - a.wholeBytes },
      suffix: { n: b.suffixN - a.suffixN, bytes: b.suffixBytes - a.suffixBytes },
      range: { n: b.rangeN - a.rangeN, bytes: b.rangeBytes - a.rangeBytes },
    },
  });
  /** Re-check the ceiling DURING a stage, not only at its end — loads have no fixed op count. */
  const checkCeiling = () => {
    const spent = priceTally(tally, pricing).totalUSD;
    if (breached(spent, ceiling))
      throw new Error(`spend ceiling breached mid-run: $${spent.toFixed(6)} >= $${ceiling}`);
  };

  // Every timed sample runs through this ledger: one that meets a transient fault is discarded whole, its requests
  // recorded beside its stage, and run again from the start (on a fresh store, or a point read on its store put back
  // in the state it assumes: RUN_AGAIN), for at most DISCARDS_PER_RUN samples a run and DISCARDS_PER_STAGE a stage
  // (`calibrate-samples.cjs`). A cleanup times nothing, and returned above.
  const discards = discardLedger({
    isTransient: (err) => transientFault(err, sdkFaults),
    snap,
    between: requestsBetween,
    // The failed sample's other requests answer first, so each is counted against it and not against the next sample.
    settle: () =>
      quiesce({
        activity: () => ({ inFlight: tally.inFlight, sent: tally.put + tally.get + tally.free }),
        maxMs: DRAIN_MS,
      }),
    onDiscard: (d, at) => {
      console.error(
        `calibrate: DISCARDED — ${at.stage}: ${d.of} ${d.sample}, ${describeFault(d)}, after ` +
          `${d.requests.put} PUT-class + ${d.requests.get} GET-class; running it again ${RUN_AGAIN[d.of] ?? 'on a fresh store'} ` +
          `(${at.count} of ${DISCARDS_PER_RUN} this run, ${at.stageCount} of ${DISCARDS_PER_STAGE} this stage)`,
      );
      // Its requests were billed, so the ceiling is checked against them as against any other.
      checkCeiling();
    },
  });
  const sample = (of, index, attempt) => discards.sample(of, index, attempt);

  // A value the run actually observed, never an interpolation: for an even count, the upper of the two middles.
  const median = (xs) => {
    if (xs.length === 0) return undefined;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // True while the workload runs; cleared when it finishes or fails. A signal after that interrupts nothing that
  // was measured, and must not relabel the run.
  let running = true;
  try {
    // Armed BEFORE the bucket exists: armed after, an interrupt while `CreateBucket` is in flight would meet the
    // do-nothing handler and exit with no teardown. Tearing down a bucket that was never made is a clean NoSuchBucket.
    // Nothing may still be writing when teardown lists the bucket, and a CreateBucket in flight must land first.
    onInterrupt = async () => {
      await stopThenTearDown({
        gate,
        drainMs: DRAIN_MS,
        teardown,
        results,
        cutShort: running,
        log,
      });
      settle();
    };
    log(`creating ${bucket}`);
    await client.send(new s3.CreateBucketCommand({ Bucket: bucket }));
    log(`created ${bucket}`);

    // ---- how far away is this client? ---------------------------------------------------------------------------
    // The floor over several trivial requests is the network's share of every figure below. Recorded raw, so no
    // latency number in this file can be read without it.
    const rtts = [];
    for (let i = 0; i < RTT_SAMPLES; i += 1) {
      const t0 = process.hrtime.bigint();
      await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
      rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const floor = Math.min(...rtts);
    results.network = {
      rttFloorMs: floor,
      rttMedianMs: median(rtts),
      client: REHEARSE
        ? 'local container'
        : floor < IN_REGION_FLOOR_MS
          ? 'in-region'
          : 'REMOTE — latency below is network-dominated',
      inRegionThresholdMs: IN_REGION_FLOOR_MS,
      // The region the shell ran in, as the CloudShell script states it; null for a run that was not started from it.
      clientRegion: process.env.CR_CALIBRATE_CLIENT_REGION ?? null,
    };
    log(`network: round-trip floor ${floor.toFixed(1)} ms — ${results.network.client}`);

    const { S3Storage } = await import('@cloudbitmaps/s3');
    const { CloudRoaring } = await import('@cloudbitmaps/roaring');
    // `readTimeoutMs: 0` stated, not left to the default: a timed request must not be cut short, whatever the S3
    // package's default becomes.
    const storage = new S3Storage({ client, bucket, prefix: STORE_PREFIX, readTimeoutMs: 0 });

    // A value the run observed at index floor(N·p): the same upper rule as `median`, and one rank above textbook
    // nearest-rank when N·p is whole. With 40 reads, p99 is simply the slowest and p95 the second slowest: read
    // them as that, not as a tail estimate a sample this small cannot give.
    const q = (xs, p) => {
      const s = [...xs].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const spreadOf = (xs) => ({
      n: xs.length,
      p50ms: q(xs, 0.5),
      p95ms: q(xs, 0.95),
      p99ms: q(xs, 0.99),
    });
    const msSince = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
    // The depth of one timed read, from the meter: its peak requests in flight, the sum of its requests' own times, how
    // many requests on average were in flight over its wall time, and so how many it waited for one after another
    // (its requests times its wall time over the time they took between them). Each read starts its peak afresh.
    const startDepth = () => {
      tally.peakInFlight = tally.inFlight;
    };
    const depthOf = (before, after, ms) => {
      const requestMs = after.requestMs - before.requestMs;
      return {
        peakInFlight: tally.peakInFlight,
        requestMs,
        meanInFlight: requestMs / ms,
        rounds: ((after.get - before.get) * ms) / requestMs,
      };
    };

    // The store a timed read uses, one per intersect so no cache can answer it: its own retry is off and its pointer
    // refresh is off (`TIMED_STORE`). Every store that times a read is built through here or through `warmStore`.
    const timedStore = () => new CloudRoaring({ storage, ...TIMED_STORE });

    // ---- the stages ---------------------------------------------------------------------------------------------------
    // Each stage records the requests it made, by class and by kind of read, beside what the engine is expected to
    // make and what the projection allows. `setup` is what a stage loads for itself, kept apart from what it times.
    // `discarded` is every sample it discarded after a transient fault: those requests are in `requests`, since they
    // were billed, and out of what the stage is held to, which is what its kept samples made (`keptRequests`).
    const expectedByStage = expectedReads(plan);
    const stage = async (name, { setup, run }) => {
      if (!STAGES.includes(name)) throw new Error(`${name} is not a stage the projection covers`);
      const s0 = snap();
      const prepared = setup === undefined ? undefined : await setup();
      const s1 = snap();
      const discarded = discards.begin(name);
      const phase = await run(prepared);
      discards.end();
      const s2 = snap();
      const record = { ...phase, requests: requestsBetween(s1, s2), discarded };
      if (prepared !== undefined) {
        record.setup = { ...prepared.record, requests: requestsBetween(s0, s1) };
      }
      results.phases[name] = record;
      const kept = keptRequests(record);
      const expected = name === 'load' ? phase.expected?.get : expectedByStage[name];
      if (expected !== undefined) {
        record.expectedGets = expected;
        if (kept.get !== expected) {
          (results.expectedMissed ??= []).push(
            `${name}: ${kept.get} GET-class kept, expected ${expected}`,
          );
          console.error(
            `calibrate: EXPECTED COUNT MISSED — ${name}'s kept samples made ${kept.get} GET-class requests, ` +
              `the engine is expected to make ${expected}`,
          );
        }
      }
      log(
        `${name}: ${record.requests.put} PUT-class + ${record.requests.get} GET-class` +
          (expected === undefined ? '' : ` (expected ${expected} GET-class)`) +
          (discarded.length === 0
            ? ''
            : `, of which ${discarded.length} discarded sample${discarded.length === 1 ? '' : 's'} made ` +
              `${record.requests.get - kept.get} GET-class and the kept ones ${kept.get}`),
      );
      return record;
    };

    // ---- load throughput: single-part and multipart ---------------------------------------------------------------
    // `TIMED_STORE` changes nothing a load does: a load reads and writes through the drivers themselves, not the
    // store's retrying, cached read path. It is spread so every store in the harness is built the same way.
    const loader = new CloudRoaring({ storage, ...TIMED_STORE });
    // The projection bounds a segment's FIRST load, so no segment is loaded twice (`firstLoads` says why).
    const claimFirstLoad = firstLoads();
    const load = async (segment, ids, count, into) => {
      claimFirstLoad(segment);
      const before = snap();
      const t0 = process.hrtime.bigint();
      // The whole write path, as a user runs it: the next generation number, the object, the publish, the collection.
      const { size, published, reason } = await loader.load({ segment }, ids);
      if (!published) throw new Error(`load of ${segment} was refused: ${reason}`);
      const ms = msSince(t0);
      const after = snap();
      const sent = requestsBetween(before, after);
      // Two different byte counts, kept apart. What went up is the object AND the pointer's body, since the meter
      // counts every request; the object is what the store holds. Recorded under the object's name, the first
      // would put the pointer's bytes into every figure derived from an object's size.
      const uploaded = after.up - before.up;
      into.push({
        segment,
        ids: count,
        ms,
        objectBytes: size,
        uploadBytes: uploaded,
        multipart: after.parts > before.parts,
        // This load's own requests, so each one is priced from what it made and not from a median's guess.
        put: sent.put,
        get: sent.get,
        parts: sent.parts,
        idsPerSec: count / (ms / 1000),
        bytesPerSec: uploaded / (ms / 1000),
      });
      checkCeiling();
    };
    const perLoad = (xs) =>
      xs.map((l) => ({
        segment: l.segment,
        kind: l.multipart ? 'multipart' : 'single',
        put: l.put,
        get: l.get,
        parts: l.parts,
        objectBytes: l.objectBytes,
        uploadBytes: l.uploadBytes,
      }));
    // Medians per kind of load. A kind with no loads reports `runs: 0` and no figures, rather than zeros.
    const summarise = (xs) =>
      xs.length === 0
        ? { runs: 0 }
        : {
            runs: xs.length,
            medianIdsPerSec: median(xs.map((l) => l.idsPerSec)),
            medianBytesPerSec: median(xs.map((l) => l.bytesPerSec)),
            medianObjectBytes: median(xs.map((l) => l.objectBytes)),
            medianUploadBytes: median(xs.map((l) => l.uploadBytes)),
          };

    await stage('load', {
      run: async () => {
        const loads = [];
        for (let i = 0; i < SEGMENTS; i += 1)
          await load(`seg-${i}`, layoutIds(layout, i), IDS, loads);
        for (let i = 0; i < LARGE; i += 1)
          await load(`large-${i}`, largeIds(), LARGE_CHUNKS * LARGE_IDS_PER_CHUNK, loads);
        if (LARGE > 0 && !loads.some((l) => l.multipart)) {
          // Half of the load measurement is void. Say so loudly rather than publish a table with a silent hole.
          console.error(
            'calibrate: WARNING — no load went multipart; the multipart figure is not measured',
          );
        }
        // What the engine is expected to make for these loads, each by its own parts.
        const expected = loads.reduce(
          (acc, l) => {
            const r = firstLoadRequests(l.multipart ? l.parts : 0);
            return { put: acc.put + r.put, get: acc.get + r.get };
          },
          { put: 0, get: 0 },
        );
        const single = loads.filter((l) => !l.multipart);
        const multi = loads.filter((l) => l.multipart);
        log(
          `load: ${single.length} single-part, ${multi.length} multipart ` +
            `(median ${Math.round(summarise(single).medianIdsPerSec ?? 0)} ids/s single-part)`,
        );
        return {
          // Which load was timed, and each load's own requests, which the figures code prices from.
          via: 'store.load()',
          singlePart: summarise(single),
          multipart: summarise(multi),
          perLoad: perLoad(loads),
          expected,
        };
      },
    });
    const objectBytes = results.phases.load.singlePart.medianObjectBytes ?? Number.NaN;

    // ---- cold intersects: every one fetches from the object store -------------------------------------------------
    // A FRESH store per intersect, so no cache can answer it. With one store reused, most intersects after the
    // first pass are served from memory, and the latency distribution mixes cache hits with object-store fetches
    // into a single, meaningless p50. Pairs are segment i with segment i + 1, round the set.
    const coldIntersects = async ({ names, count, expected, label }) => {
      const reads = [];
      for (let i = 0; i < count; i += 1) {
        const a = names[i % names.length];
        const b = names[(i + 1) % names.length];
        // One sample: a transient fault discards it, and it runs again from here on a fresh store.
        const read = await sample(`${label} cold intersect`, i, async () => {
          // No retry of the store's own inside the timed window, and each pointer read exactly once however long the
          // intersect takes, so the request count describes the library rather than the network.
          const store = timedStore();
          const before = snap();
          startDepth();
          const t0 = process.hrtime.bigint();
          let n = 0;
          let sum = 0;
          for await (const id of store.segment(a).intersect([store.segment(b)])) {
            n += 1;
            sum += id;
          }
          const ms = msSince(t0);
          const after = snap();
          // EXACT content, not a plausible count. Every pair intersects in precisely the planned ids, so anything else
          // from a real object store is a real finding about the read path — torn, partial or wrong.
          if (n !== expected.count || sum !== expected.sum) {
            throw new Error(
              `${label} intersect ${a} ∩ ${b} returned ${n} ids (sum ${sum}); expected exactly ${expected.count} ` +
                `(sum ${expected.sum}). A read that is not exact must not produce a latency figure.`,
            );
          }
          return {
            ms,
            gets: after.get - before.get,
            chunkReads: after.rangeN - before.rangeN,
            chunkBytes: after.rangeBytes - before.rangeBytes,
            tailReads: after.suffixN - before.suffixN,
            tailBytes: after.suffixBytes - before.suffixBytes,
            pointerReads: after.wholeN - before.wholeN,
            ...depthOf(before, after, ms),
          };
        });
        reads.push(read);
        checkCeiling();
      }
      return reads;
    };
    // The figures of a set of cold intersects. Two operands, so per-operand figures are half the per-intersect ones.
    const describeReads = (reads, { sharedChunks, chunksPerSegment, withPayload = false }) => {
      if (reads.length === 0) return { runs: 0 };
      const ms = reads.map((r) => r.ms);
      const expectedGets = coldIntersectGets(sharedChunks);
      return {
        runs: reads.length,
        cold: true,
        exact: true,
        p50ms: q(ms, 0.5),
        p95ms: q(ms, 0.95),
        p99ms: q(ms, 0.99),
        chunksFetchedPerOperand: median(reads.map((r) => r.chunkReads)) / 2,
        chunksPerSegment,
        // The published claim: payload bytes fetched as a share of the two objects. The tail read is NOT in it.
        ...(withPayload
          ? { payloadFraction: median(reads.map((r) => r.chunkBytes)) / (2 * objectBytes) }
          : {}),
        // Reported apart, because it is a fixed cost per operand rather than a share of the data: the reader
        // takes a generous tail so the footer and index arrive in one round trip. On a ~1 MB segment it is a
        // large fraction of the bytes; on a large one it is noise. Inside the region S3 bills a read by the
        // request and not by the byte, so there it adds a request, not a meaningful cost; read from outside the
        // region, its bytes are transfer out.
        tailReadBytesPerOperand: median(reads.map((r) => r.tailBytes)) / 2,
        pointerReadsPerIntersect: median(reads.map((r) => r.pointerReads)),
        medianGets: median(reads.map((r) => r.gets)),
        // Depth, measured: requests in flight at once, and how many an intersect waited for one after another, against
        // the engine's model of a pointer, a tail and a window of chunks at a time.
        medianPeakInFlight: median(reads.map((r) => r.peakInFlight)),
        medianMeanInFlight: median(reads.map((r) => r.meanInFlight)),
        medianRounds: median(reads.map((r) => r.rounds)),
        modelRounds: modelRounds(sharedChunks),
        expectedGets,
        // Intersects whose request count was not the one the engine is expected to make: zero unless a read found
        // something.
        offExpected: reads.filter((r) => r.gets !== expectedGets).length,
        // How the timed stores were built, because the request count depends on it: on the default pointer
        // refresh a slow intersect reads each pointer again.
        timedStore: TIMED_STORE,
      };
    };
    const summarising = (it) => {
      if (it.runs > 0) {
        log(
          `  ${it.runs} cold, all exact — p50 ${it.p50ms.toFixed(1)} ms, p99 ${it.p99ms.toFixed(1)} ms; ` +
            `${it.chunksFetchedPerOperand} of ${it.chunksPerSegment} chunks per operand, median ${it.medianGets} GETs`,
        );
      }
      return it;
    };

    const calibrationNames = Array.from({ length: SEGMENTS }, (_, i) => `seg-${i}`);
    await stage('intersect', {
      run: async () =>
        summarising(
          describeReads(
            await coldIntersects({
              names: calibrationNames,
              count: READS,
              expected: layout.expected,
              label: 'calibration-layout',
            }),
            {
              sharedChunks: layout.sharedChunks,
              chunksPerSegment: layout.chunksPerSegment,
              withPayload: true,
            },
          ),
        ),
    });

    // ---- the spread layout: the same overlap, the shared chunks scattered over each segment -----------------------
    await stage('spread', {
      setup: async () => {
        const loads = [];
        for (let i = 0; i < plan.spread.segments; i += 1)
          await load(`spread-${i}`, spreadIds(spread, i), spread.idsPerSegment, loads);
        return {
          record: {
            segments: plan.spread.segments,
            seed: SPREAD_SEED,
            span: spread?.span,
            idsPerChunk: spread?.idsPerChunk,
            sharedChunks: plan.spread.sharedChunks,
            perLoad: perLoad(loads),
          },
        };
      },
      run: async () =>
        spread === null
          ? { runs: 0 }
          : summarising(
              describeReads(
                await coldIntersects({
                  names: Array.from({ length: plan.spread.segments }, (_, i) => `spread-${i}`),
                  count: plan.spread.reads,
                  expected: spread.expected,
                  label: 'spread-layout',
                }),
                { sharedChunks: spread.sharedChunks, chunksPerSegment: spread.chunksPerSegment },
              ),
            ),
    });

    // ---- the overlap sweep: how the bill and the depth grow with the chunks two segments share -------------------
    await stage('sweep', {
      setup: async () => {
        const entries = [];
        for (const [e, L] of sweep.map((entry, j) => [entry, sweepLayouts[j]])) {
          const loads = [];
          for (let i = 0; i < SWEEP_SEGMENTS; i += 1)
            await load(`sweep-${e.k}-${i}`, layoutIds(L, i), L.shared + L.priv, loads);
          entries.push({ k: e.k, perLoad: perLoad(loads) });
        }
        return { record: { segmentsEach: SWEEP_SEGMENTS, entries } };
      },
      run: async () => {
        const entries = [];
        for (const [e, L] of sweep.map((entry, j) => [entry, sweepLayouts[j]])) {
          log(`sweep k = ${e.k}:`);
          entries.push({
            k: e.k,
            intersects: e.intersects,
            ...summarising(
              describeReads(
                await coldIntersects({
                  names: Array.from({ length: SWEEP_SEGMENTS }, (_, i) => `sweep-${e.k}-${i}`),
                  count: e.intersects,
                  expected: L.expected,
                  label: `sweep k = ${e.k}`,
                }),
                { sharedChunks: L.sharedChunks, chunksPerSegment: L.chunksPerSegment },
              ),
            ),
          });
        }
        return { entries };
      },
    });

    // ---- warm intersects: one store answers the calibration pairs again from memory ------------------------------
    // The store trusts each pointer for the whole stage and holds every shared chunk it reads (`warmStore`), so a read
    // after the priming pass has nothing to fetch. A warm intersect that makes a request FAILS the stage: a
    // regression that re-reads must not pass with a slower number.
    await stage('warm', {
      run: async () => {
        if (READS === 0) return { runs: 0 };
        const pair = async (store, i) => {
          const a = calibrationNames[i % calibrationNames.length];
          const b = calibrationNames[(i + 1) % calibrationNames.length];
          let n = 0;
          let sum = 0;
          for await (const id of store.segment(a).intersect([store.segment(b)])) {
            n += 1;
            sum += id;
          }
          if (n !== layout.expected.count || sum !== layout.expected.sum) {
            throw new Error(
              `warm intersect ${a} ∩ ${b} returned ${n} ids (sum ${sum}); expected exactly ` +
                `${layout.expected.count} (sum ${layout.expected.sum})`,
            );
          }
          return `${a} ∩ ${b}`;
        };
        // The priming pass reads each segment once, cold, and is counted: it is what the warm reads then spare. It is
        // one sample, on a store of its own: a fault part-way leaves that store holding some chunks and not others, so
        // the pass is discarded whole, with its store, and runs again on a fresh one. The warm reads make no request,
        // so they cannot meet a fault; one that does make a request fails the stage.
        const { store, priming } = await sample('priming pass', 0, async () => {
          const fresh = new CloudRoaring({
            storage,
            ...warmStore(2 * plan.warm.segments * plan.warm.sharedChunks),
          });
          const p0 = snap();
          for (let i = 0; i < READS; i += 1) {
            await pair(fresh, i);
            checkCeiling();
          }
          return { store: fresh, priming: requestsBetween(p0, snap()) };
        });
        const ms = [];
        for (let i = 0; i < READS; i += 1) {
          const before = snap();
          const t0 = process.hrtime.bigint();
          const which = await pair(store, i);
          const took = msSince(t0);
          const after = snap();
          if (after.get !== before.get || after.put !== before.put) {
            throw new Error(
              `warm intersect ${which} made ${after.get - before.get} GET-class and ${after.put - before.put} ` +
                'PUT-class requests; a warm intersect makes none, so a read that goes back to the store is a failure ' +
                'to be found, not a slower number',
            );
          }
          ms.push(took);
        }
        log(`  ${READS} warm, all exact, 0 requests — p50 ${q(ms, 0.5).toFixed(2)} ms`);
        return {
          runs: READS,
          exact: true,
          warmGets: 0,
          ...spreadOf(ms),
          priming: { requests: priming },
          store: warmStore(2 * plan.warm.segments * plan.warm.sharedChunks),
        };
      },
    });

    // ---- point reads: count() and has(), three ways ---------------------------------------------------------------
    // One id from each shared chunk of each segment. `count()` on a store is answered from the segment's pointer row
    // alone: one request. Then, on that same store, the first `has()` of a segment opens it, a tail and a chunk read,
    // and every other `has()` is one chunk read, the chunk not being cached (`openSegment`); repeated they are none
    // (`warm`). And for the first read the plan names, each of the same
    // pairs is read once more on a store of its own, which makes a pointer, a tail and a chunk read (`firstRead`).
    await stage('pointReads', {
      run: async () => {
        if (POINT_SEGMENTS === 0) return { segments: 0 };
        const names = calibrationNames.slice(0, POINT_SEGMENTS);
        const chunks = layout.sharedChunks;
        const pointConfig = warmStore(2 * POINT_SEGMENTS * chunks);
        const point = () =>
          new CloudRoaring({ storage, ...warmStore(2 * POINT_SEGMENTS * chunks) });
        // A phase is held to its count softly (a cold one that differs is a finding, and must not abort the stages
        // after it) and a warm one hard (a request from memory fails the stage).
        const softCheck = (name, gets, expected) => {
          if (gets === expected) return;
          (results.expectedMissed ??= []).push(
            `pointReads ${name}: ${gets} GET-class, expected ${expected}`,
          );
          console.error(
            `calibrate: EXPECTED COUNT MISSED — pointReads ${name} made ${gets} GET-class requests, expected ${expected}`,
          );
        };
        // A call is a sample when `of` names it: a cold read that meets a transient fault is discarded and run again,
        // and `call(rerun)` is told when it is a re-run. A warm read makes no request, so it is not one.
        const timedCalls = async (calls, check, of) => {
          const ms = [];
          let gets = 0;
          for (const [i, call] of calls.entries()) {
            const timed = async (rerun) => {
              const g0 = snap().get;
              const t0 = process.hrtime.bigint();
              const got = await call(rerun);
              const took = msSince(t0);
              check(got);
              return { took, gets: snap().get - g0 };
            };
            const one = of === undefined ? await timed(0) : await sample(of, i, timed);
            ms.push(one.took);
            gets += one.gets;
            checkCeiling();
          }
          return { gets, ...spreadOf(ms) };
        };
        const mustMake = (name, phase, gets) => {
          if (phase.gets !== gets) {
            throw new Error(`${name} made ${phase.gets} GET-class requests; expected ${gets}`);
          }
        };
        const counts = (got) => {
          if (got !== IDS) throw new Error(`count() returned ${got}; expected ${IDS}`);
        };
        const present = (got) => {
          if (got !== true) throw new Error('has() of a shared id returned false');
        };
        // count(): cardinality from the pointer row, so a segment's first read is its pointer and nothing else. A first
        // read that failed left the store holding nothing of that segment (the store forgets a snapshot that failed to
        // resolve); a re-run tells it to forget the segment too, so the re-run is a first read by construction.
        const counted = point();
        const firstCount = (name) => (rerun) => {
          if (rerun > 0) counted.invalidate({ segment: name });
          return counted.segment(name).count();
        };
        const countCold = {
          ...(await timedCalls(names.map(firstCount), counts, 'count() first read')),
          expectedGets: POINT_SEGMENTS,
          store: pointConfig,
        };
        softCheck('count() first read', countCold.gets, countCold.expectedGets);
        const countWarm = {
          ...(await timedCalls(
            Array.from(
              { length: chunks * POINT_SEGMENTS },
              (_, i) => () => counted.segment(names[i % names.length]).count(),
            ),
            counts,
          )),
          expectedGets: 0,
          store: pointConfig,
        };
        mustMake('a warm count()', countWarm, 0);
        // has(): the first id of each shared chunk, present in every segment.
        const idIn = (c) => Math.ceil((c * CHUNK_SPAN) / layout.stride) * layout.stride;
        const ids = Array.from({ length: chunks }, (_, c) => idIn(c));
        for (const id of ids) {
          if (id >= layout.shared * layout.stride || id >>> 16 !== Math.floor(id / CHUNK_SPAN)) {
            throw new Error(
              `id ${id} is not in the shared core; the point reads would not be present ids`,
            );
          }
        }
        const pairs = names.flatMap((name) => ids.map((id) => [name, id]));
        // On the store count() resolved: every has() is one ranged read, and the first of each segment adds the tail read
        // that opens it. A re-run is on the same store, which a failed chunk read leaves with the segment open and
        // nothing cached for it, so it is one ranged read again; telling the store to forget the segment would drop the
        // chunks this phase read, which the warm phase is held to.
        const openSegment = {
          ...(await timedCalls(
            pairs.map(
              ([name, id]) =>
                () =>
                  counted.segment(name).has(id),
            ),
            present,
            'has() on an open segment',
          )),
          expectedGets: pairs.length + POINT_SEGMENTS,
          store: pointConfig,
        };
        softCheck('has() on an open segment', openSegment.gets, openSegment.expectedGets);
        const hasWarm = {
          ...(await timedCalls(
            pairs.map(
              ([name, id]) =>
                () =>
                  counted.segment(name).has(id),
            ),
            present,
          )),
          expectedGets: 0,
          store: pointConfig,
        };
        mustMake('a warm has()', hasWarm, 0);
        // The first read of a segment: each pair on a store of its own. A pointer, a tail and a chunk.
        const fresh = [];
        const firstMs = [];
        for (const [j, [name, id]] of pairs.entries()) {
          // One sample, on a store of its own: a transient fault discards it, and it runs again on another.
          const read = await sample('has() first read', j, async () => {
            const store = timedStore();
            const g0 = snap().get;
            const t0 = process.hrtime.bigint();
            const got = await store.segment(name).has(id);
            const took = msSince(t0);
            present(got);
            return { took, gets: snap().get - g0 };
          });
          firstMs.push(read.took);
          fresh.push(read.gets);
          checkCeiling();
        }
        const firstRead = {
          gets: fresh.reduce((n, g) => n + g, 0),
          expectedGets: 3 * pairs.length,
          offExpected: fresh.filter((g) => g !== 3).length,
          // Each first read's own count, so a run that misses 3 shows which reads differed and by how much.
          getsPerRead: fresh,
          store: TIMED_STORE,
          ...spreadOf(firstMs),
        };
        softCheck('has() first read', firstRead.gets, firstRead.expectedGets);
        log(
          `  has() on an open segment p50 ${openSegment.p50ms.toFixed(2)} ms, first read p50 ${firstRead.p50ms.toFixed(2)} ms, ` +
            `warm p50 ${hasWarm.p50ms.toFixed(2)} ms; count() first read p50 ${countCold.p50ms.toFixed(2)} ms`,
        );
        return {
          segments: POINT_SEGMENTS,
          sharedChunks: chunks,
          count: { cold: countCold, warm: countWarm },
          has: { openSegment, firstRead, warm: hasWarm },
        };
      },
    });

    // ---- andNot with a large exclude -----------------------------------------------------------------------------
    // One calibration segment against ANDNOT_EXCLUDES others. `andNot` reads every chunk of the segment it filters
    // and each exclude only where it overlaps it, so what it costs scales with the include operand.
    await stage('andNot', {
      run: async () => {
        if (ANDNOT_CALLS === 0) return { runs: 0 };
        const include = 'seg-0';
        const excludes = Array.from({ length: ANDNOT_EXCLUDES }, (_, i) => `seg-${i + 1}`);
        // Everything in the first segment but the shared core: exact, like every other read.
        const expected = {
          count: layout.priv,
          sum: layout.ownSums[0],
        };
        const reads = [];
        for (let i = 0; i < ANDNOT_CALLS; i += 1) {
          // One sample: a transient fault discards the call, and it runs again from here on a fresh store.
          const read = await sample('andNot call', i, async () => {
            const store = timedStore();
            const before = snap();
            startDepth();
            const t0 = process.hrtime.bigint();
            let n = 0;
            let sum = 0;
            for await (const id of store
              .segment(include)
              .andNot(excludes.map((name) => store.segment(name)))) {
              n += 1;
              sum += id;
            }
            const ms = msSince(t0);
            const after = snap();
            if (n !== expected.count || sum !== expected.sum) {
              throw new Error(
                `andNot returned ${n} ids (sum ${sum}); expected exactly ${expected.count} (sum ${expected.sum}). ` +
                  'A read that is not exact must not produce a latency figure.',
              );
            }
            return {
              ms,
              gets: after.get - before.get,
              chunkReads: after.rangeN - before.rangeN,
              tailReads: after.suffixN - before.suffixN,
              pointerReads: after.wholeN - before.wholeN,
              ...depthOf(before, after, ms),
            };
          });
          reads.push(read);
          checkCeiling();
        }
        const ms = reads.map((r) => r.ms);
        log(
          `  ${reads.length} andNot calls, all exact — p50 ${q(ms, 0.5).toFixed(1)} ms, median ${median(reads.map((r) => r.gets))} GETs`,
        );
        return {
          runs: reads.length,
          exact: true,
          excludes: ANDNOT_EXCLUDES,
          includeChunks: layout.chunksPerSegment,
          ...spreadOf(ms),
          medianGets: median(reads.map((r) => r.gets)),
          chunkReadsPerCall: median(reads.map((r) => r.chunkReads)),
          tailReadsPerCall: median(reads.map((r) => r.tailReads)),
          pointerReadsPerCall: median(reads.map((r) => r.pointerReads)),
          medianPeakInFlight: median(reads.map((r) => r.peakInFlight)),
          medianMeanInFlight: median(reads.map((r) => r.meanInFlight)),
          medianRounds: median(reads.map((r) => r.rounds)),
          timedStore: TIMED_STORE,
        };
      },
    });
    results.partial = false;
    running = false;
    workFinished = true;
  } catch (err) {
    running = false;
    // A crashed run KEEPS what it already paid for. Only the gate refusing a send, because the run is stopping, is
    // not a failure: the handler has said so, and the run is marked interrupted (`failureOf`).
    const failure = failureOf(err);
    if (failure !== null) {
      // Its name, the transport code beneath it and the SDK's attempts, not the message alone (`faultOf`).
      results.error = failure;
      console.error(`calibrate: FAILED — ${describeFault(failure)}`);
      process.exitCode = 1;
    }
  } finally {
    // The same order as an interrupt's: the work stops, and what it sent answers, before teardown lists anything.
    await stopThenTearDown({ gate, drainMs: DRAIN_MS, teardown, results, cutShort: false, log });
    settle();
  }
  return process.exitCode ?? 0;
}

// A run a signal cut short exits 130 whichever path gets here first — the signal handler's, or main's own, once the
// request that was in flight fails against a bucket the teardown has already removed. One whose workload had finished
// keeps its own code (`exitCodeAfterSignal`).
main().then(
  (code) =>
    process.exit(
      interrupts > 0 ? exitCodeAfterSignal({ finished: workFinished, code }) : (code ?? 0),
    ),
  (err) => {
    console.error(`calibrate: ${redact(err.stack ?? err.message)}`);
    process.exit(interrupts > 0 ? 130 : 1);
  },
);
