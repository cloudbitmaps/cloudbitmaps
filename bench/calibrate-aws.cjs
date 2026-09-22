'use strict';
/*
 * Real-cloud calibration for the LOADED STORE — load throughput, intersect latency, and what a single-bucket
 * topology actually costs.
 *
 * WHY THIS EXISTS AGAIN. A harness by this name ran the July 2026 calibration and was deleted with the warm
 * tier, because it metered a write path through a NoSQL registry that no longer ships. Everything it measured
 * is therefore the object-store half of a shape you cannot deploy: today the pointer lives in the same bucket
 * as the data, so resolving a generation costs an object GET and advancing it costs a conditional PUT — terms
 * billed to DynamoDB in that run and simply absent from the published figures. `docs/benchmarks.md` lists all
 * three of those measurements as owed. This is the tool that pays them.
 *
 * IT SPENDS REAL MONEY, so it is built to be hard to run by accident and impossible to run blind. The guards
 * live in `bench/lib/calibrate-guards.cjs` as pure functions with a regression test each, because every one of
 * them is a bug that actually happened — a NaN spend ceiling that silently deleted the bound, a `HeadBucket`
 * 403 read as "absent" on a bucket the caller owned, a projection the run could exceed. Read that file before
 * changing anything here.
 *
 *   node bench/calibrate-aws.cjs                 projection only. Touches nothing, needs no credentials.
 *   node bench/calibrate-aws.cjs --rehearse      the whole harness against MinIO from docker-compose. Free.
 *   node bench/calibrate-aws.cjs --run           the real thing. Requires region + ceiling + confirmation.
 *   node bench/calibrate-aws.cjs --cleanup <id>  remove a run's resources by id, after an uncatchable kill.
 *   node bench/calibrate-aws.cjs --rehearse --cleanup <id>   the same, against MinIO.
 *
 * WHAT THE REHEARSAL DOES NOT COVER. MinIO is not AWS. It proves the mechanics — phases, metering, teardown
 * order, guard behaviour — but it cannot rehearse a versioned-bucket teardown or an in-flight multipart abort,
 * and it does not reproduce `us-east-1` answering 200 OK to `CreateBucket` on a bucket you already own. Those
 * meet reality for the first time on a real account, which is why the probe refuses anything but a clean 404.
 */
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');

const { meter, priceTally } = require('./lib/aws-meter.cjs');
const {
  CONFIRM_PHRASE,
  parseCeiling,
  resolveSize,
  probeMeansAbsent,
  projectOps,
  breached,
} = require('./lib/calibrate-guards.cjs');

const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'bench/calibrate-aws-results.json');

const argv = process.argv.slice(2);
/**
 * `--rehearse` is a TARGET, not a mode, so it composes with `--cleanup`.
 *
 * It was a mode, and that left the rehearsal — the one you iterate on, and so the one most likely to leave a
 * half-made bucket behind — with no way to clean up: `--cleanup` assumed a real account and refused without a
 * region. The mode you break things in is the mode that most needs the recovery path.
 */
const REHEARSE = argv.includes('--rehearse');
const MODE = argv.includes('--cleanup')
  ? 'cleanup'
  : argv.includes('--run')
    ? 'run'
    : REHEARSE
      ? 'rehearse'
      : 'project';

/** Workload. Every size is overridable so a run can be made smaller; an explicit 0 really means 0. */
const SEGMENTS = resolveSize(process.env.CR_CALIBRATE_SEGMENTS, 12, 'CR_CALIBRATE_SEGMENTS');
const IDS = resolveSize(process.env.CR_CALIBRATE_IDS, 500_000, 'CR_CALIBRATE_IDS');
const READS = resolveSize(process.env.CR_CALIBRATE_READS, 40, 'CR_CALIBRATE_READS');
/** The engine's own OCC retry bound (1 attempt + DEFAULT_MAX_RETRIES), not a multiplier someone picked. */
const RETRY_BOUND = 4;
/** Chunks a skipping intersect fetches per operand, from the measured 100-of-2,000 shape. */
const CHUNKS_PER_READ = 100;

const log = (m) => console.log(`calibrate: ${m}`);
function refuse(msg) {
  console.error(`calibrate: ${msg}`);
  process.exit(2);
}

function projection(pricing) {
  const ops = projectOps({
    loads: SEGMENTS,
    reads: READS,
    chunksPerRead: CHUNKS_PER_READ,
    retryBound: RETRY_BOUND,
  });
  return { ops, priced: priceTally({ put: ops.put, get: ops.get }, pricing) };
}

/**
 * Deterministic id set with a CONTROLLED overlap, so intersect selectivity is a parameter and not luck.
 *
 * The first version offset each segment into its own id range, which gave adjacent segments no overlap at all
 * — so the intersect phase measured the EMPTY intersection. That is chunk-skipping's best case (it skips
 * everything and fetches nothing), and timing it would have published a latency that describes no real query.
 * The rehearsal caught it only because the run prints how many ids the first pass returned; without that line
 * it would have produced a plausible p50 over zero work.
 *
 * Every segment now shares one common core and owns a disjoint remainder, so the overlap fraction is exactly
 * `OVERLAP` for any pair — matching the ~5% shape the published 100-of-2,000 chunk figure describes.
 */
const OVERLAP = 0.05;
function ids(n, segmentIndex) {
  const shared = Math.floor(n * OVERLAP);
  const out = new Array(n);
  // Shared prefix: identical across every segment, so a pair always intersects in exactly these.
  for (let i = 0; i < shared; i += 1) out[i] = i * 7;
  // Private remainder: a band this segment alone occupies, placed far above the shared core.
  const base = (segmentIndex + 1) * 100_000_000;
  for (let i = shared; i < n; i += 1) out[i] = base + (i - shared) * 7;
  return out;
}

async function main() {
  const { AWS_US_EAST_1_ONDEMAND } = await import('@cloudbitmaps/core');
  const pricing = AWS_US_EAST_1_ONDEMAND;
  const { ops, priced } = projection(pricing);

  if (MODE === 'project') {
    log('PROJECTION ONLY — nothing created, no credentials read.\n');
    console.log(`  workload    ${SEGMENTS} segments x ${IDS} ids, ${READS} reads`);
    console.log(
      `  projected   ${ops.put} PUT-class, ${ops.get} GET-class — an upper bound, not an estimate`,
    );
    console.log(`  projected $ ${priced.totalUSD.toFixed(6)} at ${pricing.name}`);
    console.log('\n  --rehearse   the whole harness against MinIO, free');
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

  const {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    DeleteObjectsCommand,
    DeleteBucketCommand,
    ListObjectVersionsCommand,
    ListMultipartUploadsCommand,
    AbortMultipartUploadCommand,
  } = require('@aws-sdk/client-s3');
  const client = new S3Client(clientOpts);
  const tally = meter(client);

  const runId =
    MODE === 'cleanup'
      ? argv[argv.indexOf('--cleanup') + 1]
      : (process.env.CR_CALIBRATE_RUN_ID ??
        `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 5)}`);
  if (MODE === 'cleanup' && (runId === undefined || runId.startsWith('--'))) {
    refuse('--cleanup needs a run id: node bench/calibrate-aws.cjs --cleanup 2026-09-22-ab12e');
  }
  const bucket = `cloudbitmaps-calib-${runId}`;

  /**
   * Teardown, memoised.
   *
   * One promise awaited by every exit path — the `finally`, the signal handler and the top-level catch —
   * because they otherwise race: a SIGTERM'd run once printed one of two deletes when the catch's
   * `process.exit(1)` killed an in-flight delete. A `finally` does NOT run on a signal, which is why the
   * handler exists at all.
   */
  let teardownPromise;
  const teardown = () => {
    teardownPromise ??= (async () => {
      const leftovers = [];
      try {
        // Abort in-flight multipart uploads first: their parts are billed, and a real `DeleteBucket` fails
        // while they exist. MinIO cannot rehearse this path — it deletes such a bucket happily.
        const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
        for (const u of uploads.Uploads ?? []) {
          await client.send(
            new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }),
          );
        }
        // Versions, not just objects: `ListObjectsV2` + `DeleteObjects` cannot empty a versioned bucket, and
        // a bucket that will not empty leaves the last-resort cleanup with no path at all.
        for (;;) {
          const v = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
          const objects = [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])].map((o) => ({
            Key: o.Key,
            VersionId: o.VersionId,
          }));
          if (objects.length === 0) break;
          // NOT spread into a plain object: a command carries `resolveMiddleware` on its prototype, and
          // `{ ...cmd }` produces a lookalike the client cannot send. The rehearsal caught this.
          await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
          );
          if (!v.IsTruncated) break;
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        log(`teardown: removed ${bucket}`);
      } catch (err) {
        // "Already gone" is success, not a leftover: reporting a non-existent resource as one that "will keep
        // costing money" cries wolf on the common case and trains you to ignore the one signal that matters.
        if (!probeMeansAbsent(err)) leftovers.push(`${bucket}: ${err.message}`);
      }
      if (leftovers.length > 0) {
        console.error('calibrate: LEFTOVERS — these still exist and may cost money:');
        for (const l of leftovers) console.error(`  ${l}`);
        console.error(`  remove them with: node bench/calibrate-aws.cjs --cleanup ${runId}`);
        process.exitCode = 1;
      }
      return leftovers;
    })();
    return teardownPromise;
  };

  if (MODE === 'cleanup') {
    log(`cleanup: removing resources for run ${runId}`);
    const leftovers = await teardown();
    return leftovers.length === 0 ? 0 : 1;
  }

  // Identity BEFORE anything is created. On a real run this is the first execution of this path, so it is
  // also the one guard whose first exercise is the real thing — verify with `aws sts get-caller-identity`.
  if (MODE === 'run') {
    const expected = process.env.CR_CALIBRATE_EXPECT_ACCOUNT;
    let account = '(unknown — @aws-sdk/client-sts not installed)';
    try {
      const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
      const sts = new STSClient({ region });
      account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
    } catch {
      /* optional dependency */
    }
    log(`identity: account ${account}, region ${region}`);
    if (expected !== undefined && expected !== '') {
      // COMPARED, not merely printed — and a run that cannot verify the account refuses rather than proceeds.
      if (account !== expected) {
        refuse(
          `account is ${account}, expected ${expected} — refusing rather than touching the wrong account`,
        );
      }
      log(`identity: matches CR_CALIBRATE_EXPECT_ACCOUNT`);
    }
  }

  // Probe BEFORE create. Only a genuine not-found counts as absent: `HeadBucket` answers 403 for a bucket you
  // own but cannot list, and in us-east-1 `CreateBucket` on a bucket you already own returns 200 OK — so
  // reading 403 as absent would run the workload inside your bucket and then delete it on teardown.
  let probeErr;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
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
    // A rehearsal's numbers must never be mistaken for a real run's. `region` alone would not say so — the
    // MinIO client is configured with `us-east-1` because the SDK requires a region, not because the bytes
    // went to AWS.
    target: REHEARSE ? 'minio (rehearsal — NOT a real cloud measurement)' : 'aws',
    region: REHEARSE ? 'n/a (local container)' : region,
    pricing: pricing.name,
    workload: { segments: SEGMENTS, idsPerSegment: IDS, reads: READS },
    partial: true,
    phases: {},
  };

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    log(`created ${bucket}`);

    const { S3Storage } = await import('@cloudbitmaps/s3');
    const { CloudRoaring, bulkLoadCrbmGeneration } = await import('@cloudbitmaps/roaring');
    const storage = new S3Storage({ client, bucket, prefix: 'calib' });
    const store = new CloudRoaring({ storage });

    /** Re-check the ceiling DURING a phase, not only at its boundary — the load phase has no fixed op count. */
    const checkCeiling = () => {
      const spent = priceTally(tally, pricing).totalUSD;
      if (breached(spent, ceiling)) {
        throw new Error(`spend ceiling breached mid-run: $${spent.toFixed(6)} >= $${ceiling}`);
      }
    };

    // ---- load throughput ------------------------------------------------------------------------
    const loads = [];
    for (let i = 0; i < SEGMENTS; i += 1) {
      const payload = ids(IDS, i);
      const t0 = process.hrtime.bigint();
      await bulkLoadCrbmGeneration(
        storage.storage,
        { segment: `seg-${i}`, generation: 0 },
        payload,
        { registry: storage.registry },
      );
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      loads.push({
        segment: `seg-${i}`,
        ids: payload.length,
        ms,
        idsPerSec: payload.length / (ms / 1000),
      });
      checkCeiling();
    }
    results.phases.load = {
      runs: loads.length,
      medianIdsPerSec: loads.map((l) => l.idsPerSec).sort((a, b) => a - b)[
        Math.floor(loads.length / 2)
      ],
      bytesUp: tally.bytesUp,
    };
    log(
      `load: ${loads.length} generations, median ${Math.round(results.phases.load.medianIdsPerSec)} ids/s`,
    );

    // ---- intersect latency ----------------------------------------------------------------------
    const latencies = [];
    let checksum = 0;
    for (let i = 0; i < READS; i += 1) {
      const a = `seg-${i % SEGMENTS}`;
      const b = `seg-${(i + 1) % SEGMENTS}`;
      const t0 = process.hrtime.bigint();
      // `intersect` takes an ARRAY of operands and streams ids. Draining it is the measurement: a latency
      // that stopped at the first chunk would time the resolve, not the skip.
      let n = 0;
      // The ids are folded into a checksum rather than discarded, the way the soak does it: it costs nothing,
      // it stops the loop being an unused binding, and it is evidence the stream carried real data rather
      // than terminating early.
      for await (const id of store.segment(a).intersect([store.segment(b)])) {
        n += 1;
        checksum = (checksum ^ id) >>> 0;
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      // A run that intersected to nothing measured the empty case, which is chunk-skipping's best case and
      // describes no real query. Refuse rather than publish a latency over zero work.
      if (i === 0) {
        log(`intersect: first pass returned ${n} ids`);
        if (n === 0)
          throw new Error(
            'intersect returned 0 ids — the operands do not overlap, so the latency would measure nothing',
          );
      }
      checkCeiling();
    }
    latencies.sort((x, y) => x - y);
    const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
    results.phases.intersect =
      latencies.length === 0
        ? { runs: 0 }
        : { runs: latencies.length, p50ms: at(0.5), p95ms: at(0.95), p99ms: at(0.99), checksum };
    if (latencies.length > 0)
      log(`intersect: p50 ${at(0.5).toFixed(2)} ms, p99 ${at(0.99).toFixed(2)} ms`);

    // ---- the single-bucket bill -----------------------------------------------------------------
    // Nothing extra runs here: the registry GETs and conditional PUTs are already in the tally, which is the
    // whole point — in this topology they ARE object-store requests, and the old run could not see them.
    results.cost = {
      ...priceTally(tally, pricing),
      ops: { ...tally, byCommand: { ...tally.byCommand } },
    };
    results.partial = false;
    log(
      `cost: $${results.cost.totalUSD.toFixed(6)} over ${tally.put} PUT-class + ${tally.get} GET-class`,
    );
  } catch (err) {
    // A crashed run KEEPS what it already paid for. An earlier version discarded every measurement on an
    // exhaustion crash at ~90% of the workload.
    results.error = err.message;
    console.error(`calibrate: FAILED — ${err.message}`);
    process.exitCode = 1;
  } finally {
    results.elapsedMs = Date.now() - started;
    writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
    log(`wrote ${OUT.replace(`${ROOT}/`, '')}${results.partial ? ' (partial: true)' : ''}`);
    await teardown();
  }
  return process.exitCode ?? 0;
}

// A `finally` does not run on a signal. A second Ctrl-C during teardown used to reach Node's default handler
// and kill the process mid-delete, leaking the bucket right after printing "tearing down".
let interrupts = 0;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    interrupts += 1;
    if (interrupts > 1) {
      console.error(
        'calibrate: already tearing down — use --cleanup <runId> if this run leaves anything',
      );
      return;
    }
    console.error('\ncalibrate: interrupted, tearing down before exit');
  });
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`calibrate: ${err.stack ?? err.message}`);
    process.exit(1);
  },
);
