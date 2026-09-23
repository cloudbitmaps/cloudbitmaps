'use strict';
/*
 * Real-cloud calibration for the LOADED STORE — load throughput, cold intersect latency, and what a
 * single-bucket topology actually costs.
 *
 * WHY THIS EXISTS AGAIN. A harness by this name ran the July 2026 calibration and was deleted with the warm
 * tier, because it metered a write path through a NoSQL registry that no longer ships. Everything it measured
 * is therefore the object-store half of a shape you cannot deploy: today the pointer lives in the same bucket
 * as the data, so resolving a generation costs an object GET and advancing it costs a conditional PUT — terms
 * billed to DynamoDB in that run and simply absent from the published figures. `docs/benchmarks.md` lists
 * those measurements as owed. This is the tool that pays them.
 *
 * IT SPENDS REAL MONEY, so it is built to be hard to run by accident and impossible to run blind. The guards
 * live in `bench/lib/calibrate-guards.cjs` as pure functions with a regression test each, because every one of
 * them is a bug that actually happened. Read that file before changing anything here.
 *
 *   node bench/calibrate-aws.cjs                             projection only; touches nothing
 *   node bench/calibrate-aws.cjs --rehearse                  the workload against MinIO, free — no money guards
 *   node bench/calibrate-aws.cjs --run                       the real thing (region + ceiling + confirmation)
 *   node bench/calibrate-aws.cjs [--rehearse] --cleanup <id> remove a run's resources after a hard kill
 *   bash bench/calibrate-cloudshell.sh                       --run from AWS CloudShell, against the PUBLISHED
 *                                                            packages — the only way latency means anything
 *
 * WHAT A RUN CAN AND CANNOT CLAIM. Cost is location-independent: a request costs the same from anywhere. LATENCY
 * is not: from outside the region it measures internet transit, which is why the July run's wall-clock was
 * withheld and why the first run of this harness — from a laptop — produced a p50 of 112 ms that describes the
 * network, not the library. So every run now measures its own distance to the region (the round-trip floor of a
 * trivial request) and records it, and the results say whether the latency figures are in-region or not. A
 * number that cannot be told apart from the network is not a latency number.
 *
 * WHAT THE REHEARSAL DOES NOT COVER. MinIO is not AWS. It proves the mechanics — stages, metering, teardown
 * order, the probe, the end-of-run projection check, signal handling — but not the money guards. The region,
 * confirmation, spend-ceiling and account checks do not run in a rehearsal at all: the ceiling is parsed and
 * compared by pure functions with their own tests, and the rest are single comparisons made before anything is
 * created. Nor can it rehearse a versioned-bucket teardown or an in-flight multipart abort on a real account, or
 * reproduce `us-east-1` answering 200 OK to `CreateBucket` on a bucket you already own. Those meet reality for the
 * first time on a real account, which is why the probe refuses anything but a clean 404.
 */
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
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
  projectOps,
  exceedsProjection,
  breached,
  planLayout,
  layoutIds,
  maskAccount,
  resultsFile,
  checkRunId,
  TIMED_STORE,
  clientConfigs,
  bucketIsGone,
  uploadIsGone,
  TEARDOWN_PASSES,
  TEARDOWN_PUTS,
} = require('./lib/calibrate-guards.cjs');

const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
/**
 * `--rehearse` is a TARGET, not a mode, so it composes with `--cleanup`. It was a mode, and that left the
 * rehearsal — the one you iterate on, and so the one most likely to leave a half-made bucket — with no way to
 * clean up.
 */
const REHEARSE = argv.includes('--rehearse');
const MODE = argv.includes('--cleanup')
  ? 'cleanup'
  : argv.includes('--run')
    ? 'run'
    : REHEARSE
      ? 'rehearse'
      : 'project';

// ---- the workload ----------------------------------------------------------------------------------------------
// Every size is overridable so a run can be made smaller; an explicit 0 really means 0.
const SEGMENTS = resolveSize(process.env.CR_CALIBRATE_SEGMENTS, 10, 'CR_CALIBRATE_SEGMENTS');
const IDS = resolveSize(process.env.CR_CALIBRATE_IDS, 500_000, 'CR_CALIBRATE_IDS');
const READS = resolveSize(process.env.CR_CALIBRATE_READS, 40, 'CR_CALIBRATE_READS');
/**
 * Segments large enough to be uploaded MULTIPART — the other half of "load throughput, single-part and
 * multipart". The S3 driver uses a single conditional PUT for anything that fits one 8 MiB part, and the first
 * run's segments were ~450 KB, so it never exercised multipart at all. These are dense (a bitmap container per
 * chunk, 8 KiB each) and never intersected, so they cannot disturb the intersect workload.
 */
const LARGE = resolveSize(process.env.CR_CALIBRATE_LARGE, 2, 'CR_CALIBRATE_LARGE');
const LARGE_CHUNKS = 1_536; // x 8 KiB bitmap containers ≈ 12 MiB: two 8 MiB parts
const LARGE_IDS_PER_CHUNK = 8_192; // above roaring's 4,096 array→bitmap threshold, so every container is a bitmap
const PART_SIZE = 8 * 1024 * 1024; // the S3 driver's default part size
/** Trivial requests timed to find this client's round-trip floor to the region. */
const RTT_SAMPLES = 10;
/**
 * Below this floor the client is treated as in-region. An in-region S3 request is single-digit to low-tens of
 * milliseconds; a client on another continent cannot get under ~60 ms. The raw floor is recorded regardless, so
 * a reader can apply their own line — this only decides the label.
 */
const IN_REGION_FLOOR_MS = 30;

const log = (m) => console.log(`calibrate: ${m}`);
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
 * The run's worst case, in requests and dollars. It is checked against the ceiling before anything is created, and
 * the run is checked against it after teardown — so it has to be an upper bound, not an estimate.
 */
function projection(pricing, layout) {
  const ops = projectOps({
    loads: SEGMENTS,
    largeLoads: LARGE,
    partsPerLargeLoad: largePartsBound(),
    reads: READS,
    operandsPerRead: 2,
    chunksPerRead: layout.sharedChunks,
    retryBound: RETRY_BOUND,
    // The probe HEAD and the round-trip samples, one attempt each; the bucket's creation; and teardown's listings
    // at every attempt its retrying client may make (see TEARDOWN_PUTS).
    fixedGets: 1 + RTT_SAMPLES,
    fixedPuts: 1 /* CreateBucket */ + TEARDOWN_PUTS,
  });
  return { ops, priced: priceTally({ put: ops.put, get: ops.get }, pricing) };
}

/**
 * The commit the harness ran from, recorded in the results. `calibrate-cloudshell.sh` passes it in, because the
 * copy it runs sits in a scratch directory that is not a git checkout.
 */
function harnessRef() {
  if (process.env.CR_CALIBRATE_HARNESS_REF) return process.env.CR_CALIBRATE_HARNESS_REF;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '(unknown)';
  }
}

/**
 * Verify the caller's identity — and tell the two kinds of failure apart.
 *
 * The first version caught EVERY error and reported "@aws-sdk/client-sts not installed", so an expired SSO
 * session or a wrong profile would have been blamed on a missing module. And because an account pin compared
 * against that placeholder text, setting `CR_CALIBRATE_EXPECT_ACCOUNT` could never succeed — so the pin went
 * unused, which is how the first real run went unpinned.
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
// window. The first version of this handler printed "tearing down before exit" and did NEITHER — installing a
// SIGINT handler replaces Node's default exit, so Ctrl-C left the workload running while claiming otherwise.
let onInterrupt = async () => {};
let interrupts = 0;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    interrupts += 1;
    if (interrupts > 1) {
      // A second signal during teardown used to kill the process mid-delete, leaking the bucket. Warn instead.
      console.error('calibrate: already tearing down — if anything is left, use --cleanup <runId>');
      return;
    }
    console.error(`\ncalibrate: ${sig} — stopping`);
    Promise.resolve()
      .then(() => onInterrupt())
      .catch((err) => console.error(`calibrate: teardown after ${sig} failed: ${err.message}`))
      .finally(() => process.exit(130));
  });
}

async function main() {
  const { AWS_US_EAST_1_ONDEMAND, VERSION } = await import('@cloudbitmaps/roaring');
  const pricing = AWS_US_EAST_1_ONDEMAND;
  const layout = planLayout({ segments: SEGMENTS, idsPerSegment: IDS, ...DEFAULT_LAYOUT });
  const { ops, priced } = projection(pricing, layout);

  if (MODE === 'project') {
    log('PROJECTION ONLY — nothing created, no credentials read.\n');
    console.log(
      `  workload     ${SEGMENTS} x ${IDS} ids (${layout.chunksPerSegment} chunks each, ${layout.sharedChunks} shared)`,
    );
    console.log(
      `               + ${LARGE} multipart segments of ${LARGE_CHUNKS} dense chunks, ${READS} cold intersects`,
    );
    console.log(
      `  projected    ${ops.put} PUT-class, ${ops.get} GET-class — an upper bound, checked after the run`,
    );
    console.log(`  projected $  ${priced.totalUSD.toFixed(6)} at ${pricing.name}`);
    console.log('\n  --rehearse   the workload against MinIO, free — the money guards do not run');
    console.log('  --run        the real thing (needs region + ceiling + confirmation)');
    return 0;
  }

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
    if (process.env.CR_CALIBRATE_CONFIRM !== CONFIRM_PHRASE) {
      refuse(`set CR_CALIBRATE_CONFIRM=${CONFIRM_PHRASE} to authorise a run that spends money`);
    }
    try {
      ceiling = parseCeiling(process.env.CR_CALIBRATE_MAX_USD);
    } catch (err) {
      refuse(err.message);
    }
    // The projection is an upper bound, so refusing here means the run genuinely cannot fit the ceiling.
    if (breached(priced.totalUSD, ceiling)) {
      refuse(
        `projected $${priced.totalUSD.toFixed(6)} meets or exceeds the $${ceiling} ceiling — ` +
          'nothing was created. Raise CR_CALIBRATE_MAX_USD or shrink the workload.',
      );
    }
  }

  const s3 = require('@aws-sdk/client-s3');
  // Two clients, metered into one bill: the workload's makes one attempt per request, teardown's keeps its retries.
  // `clientConfigs` says why, and the tests drive both against a server that fails on purpose.
  const configs = clientConfigs(clientOpts);
  const client = new s3.S3Client(configs.work);
  const tally = meter(client);
  const admin = new s3.S3Client(configs.admin);
  meter(admin, tally);

  const runId =
    MODE === 'cleanup'
      ? argv[argv.indexOf('--cleanup') + 1]
      : (process.env.CR_CALIBRATE_RUN_ID ??
        `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 5)}`);
  if (MODE === 'cleanup' && (runId === undefined || runId.startsWith('--'))) {
    refuse('--cleanup needs a run id: node bench/calibrate-aws.cjs --cleanup 2026-09-22-ab12e');
  }
  try {
    checkRunId(runId);
  } catch (err) {
    refuse(err.message);
  }
  const bucket = `cloudbitmaps-calib-${runId}`;
  // One evidence file per real run, named by its id; a rehearsal's own file is ignored by git.
  const out = resolve(ROOT, resultsFile(REHEARSE, runId));
  // Evidence is write-once, like the generations it measures: a figure published from a run is checked against
  // the file under that run's id, and a second run given the same id would otherwise replace it. Refused before
  // the identity check, so nothing has been created and no credentials have been read.
  if (MODE === 'run' && !REHEARSE && existsSync(out)) {
    refuse(
      `${out.replace(`${ROOT}/`, '')} already exists — that run's evidence is committed. Choose another ` +
        'CR_CALIBRATE_RUN_ID, or leave it unset for a fresh one.',
    );
  }

  /**
   * Teardown, memoised: one promise awaited by every exit path — the `finally`, the signal handler, and the
   * top-level catch — because they otherwise race, and a racing exit once killed an in-flight delete.
   */
  let teardownPromise;
  const teardown = () => {
    teardownPromise ??= (async () => {
      const leftovers = [];
      try {
        // Abort in-flight multipart uploads first: their parts are billed, and a real `DeleteBucket` fails while
        // they exist. MinIO cannot rehearse this on a real account's terms. An upload already gone — completed by
        // the workload meanwhile, or aborted by an attempt whose answer was lost — is done, not an error.
        const uploads = await admin.send(new s3.ListMultipartUploadsCommand({ Bucket: bucket }));
        for (const u of uploads.Uploads ?? []) {
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
        // Versions, not just objects: `ListObjectsV2` + `DeleteObjects` cannot empty a versioned bucket. Each pass
        // lists what is left and deletes it, until nothing is listed. Bounded: a key that cannot be deleted is
        // reported inside a 200, where no retry sees it, and must end in LEFTOVERS rather than in a listing loop.
        for (let pass = 0; ; pass += 1) {
          const v = await admin.send(new s3.ListObjectVersionsCommand({ Bucket: bucket }));
          const objects = [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])].map((o) => ({
            Key: o.Key,
            VersionId: o.VersionId,
          }));
          if (objects.length === 0) break;
          if (pass === TEARDOWN_PASSES) {
            throw new Error(
              `${objects.length}${v.IsTruncated ? '+' : ''} object versions still listed after ${pass} delete passes`,
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
        // S3's own NoSuchBucket says so: an abort's NoSuchUpload is also a 404, and was once read as this answer.
        if (!bucketIsGone(err)) leftovers.push(`${bucket}: ${err.message}`);
      }
      if (leftovers.length > 0) {
        console.error('calibrate: LEFTOVERS — these still exist and may cost money:');
        for (const l of leftovers) console.error(`  ${l}`);
        console.error(
          `  remove them with: node bench/calibrate-aws.cjs${REHEARSE ? ' --rehearse' : ''} --cleanup ${runId}`,
        );
        process.exitCode = 1;
      }
      return leftovers;
    })();
    return teardownPromise;
  };

  if (MODE === 'cleanup') {
    log(`cleanup: removing resources for run ${runId}`);
    return (await teardown()).length === 0 ? 0 : 1;
  }

  // ---- identity, before anything is created -------------------------------------------------------------------
  if (MODE === 'run') {
    const expected = process.env.CR_CALIBRATE_EXPECT_ACCOUNT ?? '';
    let who;
    try {
      who = await identity(region);
    } catch (err) {
      refuse(
        `could not verify credentials (${err.name ?? 'error'}: ${err.message}) — every later request would fail ` +
          'the same way. Check the profile or re-authenticate, then run again.',
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
    // A human check that works even without a pin. Confirm the last four digits are the account you meant.
    log('Ctrl-C within 10 s to abort — nothing has been created yet.');
    await sleep(10_000);
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
      `could not prove ${bucket} is absent (${probeErr.name ?? probeErr.message}) — refusing rather than ` +
        'guessing. A 403 means a bucket you own but cannot list.',
    );
  }

  const started = Date.now();
  const results = {
    note: 'Written by bench/calibrate-aws.cjs. Regenerate with `pnpm calibrate:aws --run`.',
    runId,
    mode: MODE,
    // A rehearsal's numbers must never be mistaken for a real run's. The MinIO client is configured with a region
    // only because the SDK requires one.
    target: REHEARSE ? 'minio (rehearsal — NOT a real cloud measurement)' : 'aws',
    region: REHEARSE ? 'n/a (local container)' : region,
    measured: { packageVersion: VERSION, harness: harnessRef(), node: process.version },
    pricing: pricing.name,
    workload: {
      segments: SEGMENTS,
      idsPerSegment: IDS,
      chunksPerSegment: layout.chunksPerSegment,
      sharedChunks: layout.sharedChunks,
      largeSegments: LARGE,
      largeChunks: LARGE_CHUNKS,
      coldIntersects: READS,
    },
    projected: ops,
    partial: true,
    phases: {},
  };
  const writeResults = () => {
    results.elapsedMs = Date.now() - started;
    // The evidence directory may not exist yet: CloudShell runs this from a scratch copy of `bench/`.
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    log(`wrote ${out.replace(`${ROOT}/`, '')}${results.partial ? ' (partial: true)' : ''}`);
  };

  /**
   * The bill and the projection check, then the results — run AFTER teardown, so its requests are in the bill
   * too. Nothing extra ran for the bill: in this topology the pointer reads and conditional PUTs ARE object-store
   * requests, which the old run could not see. Both exits call this, the `finally` and an interrupt: the
   * interrupt path once wrote its results without it, losing the one figure the run had already paid for.
   */
  const settle = () => {
    results.cost = {
      ...priceTally(tally, pricing),
      ops: { ...tally, byCommand: { ...tally.byCommand } },
    };
    const over = exceedsProjection(tally, ops);
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
  });
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
    // Armed BEFORE the bucket exists: an interrupt while `CreateBucket` is in flight used to meet the do-nothing
    // handler and exit with no teardown. Tearing down a bucket that was never made is a clean NoSuchBucket.
    onInterrupt = async () => {
      if (running) results.interrupted = true;
      await teardown();
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
    };
    log(`network: round-trip floor ${floor.toFixed(1)} ms — ${results.network.client}`);

    const { S3Storage } = await import('@cloudbitmaps/s3');
    const { CloudRoaring, bulkLoadCrbmGeneration } = await import('@cloudbitmaps/roaring');
    const storage = new S3Storage({ client, bucket, prefix: 'calib' });

    /** Re-check the ceiling DURING a stage, not only at its end — loads have no fixed op count. */
    const checkCeiling = () => {
      const spent = priceTally(tally, pricing).totalUSD;
      if (breached(spent, ceiling))
        throw new Error(`spend ceiling breached mid-run: $${spent.toFixed(6)} >= $${ceiling}`);
    };

    // ---- load throughput: single-part and multipart ---------------------------------------------------------------
    const loads = [];
    const load = async (segment, ids, count) => {
      const before = snap();
      const t0 = process.hrtime.bigint();
      await bulkLoadCrbmGeneration(storage.storage, { segment, generation: 0 }, ids, {
        registry: storage.registry,
      });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const after = snap();
      const bytes = after.up - before.up;
      loads.push({
        segment,
        ids: count,
        ms,
        bytes,
        multipart: after.parts > before.parts,
        idsPerSec: count / (ms / 1000),
        bytesPerSec: bytes / (ms / 1000),
      });
      checkCeiling();
    };
    for (let i = 0; i < SEGMENTS; i += 1) await load(`seg-${i}`, layoutIds(layout, i, IDS), IDS);
    for (let i = 0; i < LARGE; i += 1)
      await load(`large-${i}`, largeIds(), LARGE_CHUNKS * LARGE_IDS_PER_CHUNK);

    // Medians per kind of load. A kind with no loads reports `runs: 0` and no figures, rather than zeros.
    const summarise = (xs) =>
      xs.length === 0
        ? { runs: 0 }
        : {
            runs: xs.length,
            medianIdsPerSec: median(xs.map((l) => l.idsPerSec)),
            medianBytesPerSec: median(xs.map((l) => l.bytesPerSec)),
            medianObjectBytes: median(xs.map((l) => l.bytes)),
          };
    results.phases.load = {
      singlePart: summarise(loads.filter((l) => !l.multipart)),
      multipart: summarise(loads.filter((l) => l.multipart)),
    };
    if (LARGE > 0 && results.phases.load.multipart.runs === 0) {
      // Half of the load measurement is void. Say so loudly rather than publish a table with a silent hole.
      console.error(
        'calibrate: WARNING — no load went multipart; the multipart figure is not measured',
      );
    }
    log(
      `load: ${results.phases.load.singlePart.runs} single-part, ${results.phases.load.multipart.runs} multipart ` +
        `(median ${Math.round(results.phases.load.singlePart.medianIdsPerSec ?? 0)} ids/s single-part)`,
    );

    // ---- cold intersects: every one fetches from the object store -------------------------------------------------
    // A FRESH store per intersect, so no cache can answer it. The first run reused one store, so after the first
    // pass most intersects were served from memory — 107 GETs across 40 reads — and its latency distribution mixed
    // cache hits with object-store fetches into a single, meaningless p50.
    const reads = [];
    for (let i = 0; i < READS; i += 1) {
      const a = `seg-${i % SEGMENTS}`;
      const b = `seg-${(i + 1) % SEGMENTS}`;
      // No retry of the store's own inside the timed window, and each pointer read exactly once however long the
      // intersect takes, so the request count describes the library rather than the network. `TIMED_STORE` says why.
      const store = new CloudRoaring({ storage, ...TIMED_STORE });
      const before = snap();
      const t0 = process.hrtime.bigint();
      let n = 0;
      let sum = 0;
      for await (const id of store.segment(a).intersect([store.segment(b)])) {
        n += 1;
        sum += id;
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const after = snap();
      // EXACT content, not a plausible count. Every pair intersects in precisely the planned ids, so anything else
      // from a real object store is a real finding about the read path — torn, partial or wrong.
      if (n !== layout.expected.count || sum !== layout.expected.sum) {
        throw new Error(
          `intersect ${a} ∩ ${b} returned ${n} ids (sum ${sum}); expected exactly ${layout.expected.count} ` +
            `(sum ${layout.expected.sum}). A read that is not exact must not produce a latency figure.`,
        );
      }
      reads.push({
        ms,
        gets: after.get - before.get,
        chunkReads: after.rangeN - before.rangeN,
        chunkBytes: after.rangeBytes - before.rangeBytes,
        tailReads: after.suffixN - before.suffixN,
        tailBytes: after.suffixBytes - before.suffixBytes,
        pointerReads: after.wholeN - before.wholeN,
      });
      checkCeiling();
    }
    // The value at index floor(N·p) — the same upper rule as `median`, and one rank above textbook nearest-rank
    // when N·p is whole. With the default 40 reads, p99 is simply the slowest read and p95 the second slowest:
    // read them as that, not as a tail estimate a sample this small cannot give.
    const q = (xs, p) => {
      const s = [...xs].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const ms = reads.map((r) => r.ms);
    const objectBytes = results.phases.load.singlePart.medianObjectBytes ?? Number.NaN;
    const chunkReads = median(reads.map((r) => r.chunkReads));
    results.phases.intersect =
      reads.length === 0
        ? { runs: 0 }
        : {
            runs: reads.length,
            cold: true,
            exact: true,
            p50ms: q(ms, 0.5),
            p95ms: q(ms, 0.95),
            p99ms: q(ms, 0.99),
            // Two operands, so per-operand figures are half the per-intersect ones.
            chunksFetchedPerOperand: chunkReads / 2,
            chunksPerSegment: layout.chunksPerSegment,
            // The published claim: payload bytes fetched as a share of the two objects. The tail read is NOT in it.
            payloadFraction: median(reads.map((r) => r.chunkBytes)) / (2 * objectBytes),
            // Reported apart, because it is a fixed cost per operand rather than a share of the data: the reader
            // takes a generous tail so the footer and index arrive in one round trip. On a ~1 MB segment it is a
            // large fraction of the bytes; on a large one it is noise. S3 bills per request, not per byte, so it
            // adds a request, not a meaningful cost.
            tailReadBytesPerOperand: median(reads.map((r) => r.tailBytes)) / 2,
            pointerReadsPerIntersect: median(reads.map((r) => r.pointerReads)),
            medianGets: median(reads.map((r) => r.gets)),
            // How the timed stores were built, because the request count depends on it: on the default pointer
            // refresh a slow intersect reads each pointer again.
            timedStore: TIMED_STORE,
          };
    if (reads.length > 0) {
      const it = results.phases.intersect;
      log(
        `intersect: ${reads.length} cold, all exact — p50 ${it.p50ms.toFixed(1)} ms, p99 ${it.p99ms.toFixed(1)} ms; ` +
          `${it.chunksFetchedPerOperand} of ${it.chunksPerSegment} chunks per operand ` +
          `(${(100 * it.payloadFraction).toFixed(1)}% of payload) + a ${Math.round(it.tailReadBytesPerOperand / 1024)} KiB tail read each`,
      );
    }
    results.partial = false;
    running = false;
  } catch (err) {
    running = false;
    // A crashed run KEEPS what it already paid for.
    results.error = err.message;
    console.error(`calibrate: FAILED — ${err.message}`);
    process.exitCode = 1;
  } finally {
    await teardown();
    settle();
  }
  return process.exitCode ?? 0;
}

// An interrupted run exits 130 whichever path gets here first — the signal handler's, or main's own, once the request
// that was in flight fails against a bucket the teardown has already removed.
main().then(
  (code) => process.exit(interrupts > 0 ? 130 : (code ?? 0)),
  (err) => {
    console.error(`calibrate: ${err.stack ?? err.message}`);
    process.exit(interrupts > 0 ? 130 : 1);
  },
);
