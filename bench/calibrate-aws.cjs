/*
 * Real-cloud $/latency calibration (Phase 9, Stage 2) — the run that turns the estimator + LocalStack figures
 * into measured ones. It drives the SAME workload shape as `bench/load-localstack.cjs` against a REAL AWS
 * account: S3ColdDriver + DynamoDbWarmDriver + DynamoDbRegistryDriver, three phases (WRITE / PUBLISH / READ),
 * each op timed, every SDK command metered at the wire (see `lib/aws-meter.cjs`).
 *
 * THIS COMMAND SPENDS REAL MONEY AND CREATES REAL RESOURCES. It is therefore built to be hard to run by
 * accident and impossible to run blind:
 *
 *   1. **Dry run by default.** With no `--run` it projects the op counts and the dollar cost from the configured
 *      workload size and exits without touching AWS at all.
 *   2. **Typed confirmation.** `--run` additionally requires CR_CALIBRATE_CONFIRM=spend-real-money, and a
 *      present-but-EMPTY CR_CALIBRATE_ENDPOINT is rejected rather than silently meaning "real AWS".
 *   3. **Explicit region.** No default. A silent fall-back to us-east-1 is how you bill the wrong account.
 *   4. **Spend ceiling, two layers.** CR_CALIBRATE_MAX_USD (default 1.00, and a malformed value is an error
 *      rather than a removed ceiling) is checked against a pre-flight projection derived from the engine's own
 *      OCC retry bound, and then re-checked against MEASURED cost during and between phases — because a static
 *      projection is a guess about contention and two earlier versions of it were not actually bounds.
 *   5. **Identity, resolved once and optionally enforced.** Both clients must resolve the same credentials, and
 *      CR_CALIBRATE_EXPECT_ACCOUNT (when set) is compared against the real account rather than merely printed.
 *      Without the optional `@aws-sdk/client-sts` the account cannot be shown at all — the run says so.
 *   6. **Fresh, tagged, uniquely-named resources.** A run id in every name. Both existence probes run before
 *      either resource is created, and a probe that FAILS (a 403 is not a 404) stops the run instead of reading
 *      as "absent" — in us-east-1, creating over a bucket you already own succeeds silently.
 *   7. **Teardown on every path** — the `finally`, SIGINT/SIGTERM (including a repeat signal, which used to kill
 *      the process mid-delete), the top-level catch, and `--cleanup <runId>` for an uncatchable kill. It aborts
 *      in-flight multipart uploads and deletes object versions, so a versioned bucket is not a dead end.
 *      Anything left is printed with the exact recovery command and a non-zero exit.
 *   8. **A crashed run still persists what it measured** — you were billed for those requests.
 *
 * Why the dollar figure is defensible: the DynamoDB half comes from AWS's own `ConsumedCapacity`, and the S3
 * half counts every request the SDK actually issued — including the PUTs the library's metrics seam structurally
 * cannot see, and each retry attempt, since AWS bills per attempt. What it is NOT is a literal invoice: billing
 * data lags hours and has no per-run granularity. Every resource is therefore tagged so the run can be
 * reconciled against Cost Explorer the next day; the method doc spells that out, along with what is excluded
 * (egress, storage in the measured total, compaction, intersection, encryption).
 *
 * Verify the mechanics for free first: CR_CALIBRATE_ENDPOINT=http://127.0.0.1:4566 runs the whole thing against
 * LocalStack, so the real-account run has no untested moving parts.
 *
 * Run:  pnpm calibrate:aws                        # dry run — projection only
 *       CR_CALIBRATE_REGION=us-east-1 CR_CALIBRATE_CONFIRM=spend-real-money pnpm calibrate:aws --run
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { round, stats, pct, drive, costOf } = require('./lib/measure.cjs');
const { createAwsMeter, deltaOf } = require('./lib/aws-meter.cjs');
/**
 * The AWS SDK and the LIBRARY ITSELF are loaded lazily by `loadDeps()`, into the bindings below.
 *
 * `@cloudbitmaps/roaring` resolves to `packages/roaring/dist`, which does not exist until `pnpm build` — and CI
 * runs `pnpm test` BEFORE `pnpm build`. A top-level require therefore made every argument-validation guard fail
 * with MODULE_NOT_FOUND in CI while passing locally, where an earlier build had left `dist` behind. Validation
 * must not depend on a build: `--run` without a region should be refused by a script that has not loaded a byte
 * of the library.
 */
let S3Client;
let CreateBucketCommand;
let HeadBucketCommand;
let DeleteObjectsCommand;
let DeleteBucketCommand;
let PutBucketTaggingCommand;
let ListObjectVersionsCommand;
let ListMultipartUploadsCommand;
let AbortMultipartUploadCommand;
let DynamoDBClient;
let CreateTableCommand;
let DescribeTableCommand;
let DeleteTableCommand;
let waitUntilTableExists;
let CloudRoaring;
let bulkLoadCrbmGeneration;
let AWS_US_EAST_1_ONDEMAND;
let S3ColdDriver;
let DynamoDbWarmDriver;
let DynamoDbRegistryDriver;

function loadDeps() {
  if (S3Client !== undefined) return;
  ({
    S3Client,
    CreateBucketCommand,
    HeadBucketCommand,
    DeleteObjectsCommand,
    DeleteBucketCommand,
    PutBucketTaggingCommand,
    ListObjectVersionsCommand,
    ListMultipartUploadsCommand,
    AbortMultipartUploadCommand,
  } = require('@aws-sdk/client-s3'));
  ({
    DynamoDBClient,
    CreateTableCommand,
    DescribeTableCommand,
    DeleteTableCommand,
    waitUntilTableExists,
  } = require('@aws-sdk/client-dynamodb'));
  ({
    CloudRoaring,
    bulkLoadCrbmGeneration,
    AWS_US_EAST_1_ONDEMAND,
  } = require('@cloudbitmaps/roaring'));
  ({ S3ColdDriver } = require('@cloudbitmaps/core/s3'));
  ({ DynamoDbWarmDriver, DynamoDbRegistryDriver } = require('@cloudbitmaps/core/dynamodb'));
}

const ROOT = path.resolve(__dirname, '..');
const RUN = process.argv.includes('--run');
const CLEANUP = process.argv.includes('--cleanup');
// Accept the documented positional form (`--cleanup <runId>`) as well as CR_CALIBRATE_RUN_ID.
const CLEANUP_ID = CLEANUP ? process.argv[process.argv.indexOf('--cleanup') + 1] : undefined;
const REGION = process.env.CR_CALIBRATE_REGION;
const ENDPOINT = process.env.CR_CALIBRATE_ENDPOINT; // LocalStack rehearsal only
// `CR_CALIBRATE_ENDPOINT=$LOCALSTACK` with `LOCALSTACK` unset expands to EMPTY, which used to read as "no
// endpoint" and therefore "real AWS" — turning a copy-pasted free rehearsal (whose documented command line
// already carries CR_CALIBRATE_CONFIRM=spend-real-money) into a billed run against the default credential
// chain. For `--cleanup` it would have aimed a DELETION at a real account. Present-but-empty is now an error.
if (process.env.CR_CALIBRATE_ENDPOINT === '') {
  console.error(
    'calibrate-aws: CR_CALIBRATE_ENDPOINT is set but EMPTY, which would mean "real AWS" — almost certainly not\n' +
      '               what you meant (an unset shell variable is the usual cause). Unset it to target real AWS\n' +
      '               deliberately, or give it the rehearsal endpoint.',
  );
  process.exit(2);
}
const CONFIRM = process.env.CR_CALIBRATE_CONFIRM;
/** Optional but ENFORCED when set: refuse to run unless the resolved account matches. A printed account that
 *  nobody reads is not a guard; this one is checked. */
const EXPECT_ACCOUNT = process.env.CR_CALIBRATE_EXPECT_ACCOUNT || undefined;
const MAX_USD = Number(process.env.CR_CALIBRATE_MAX_USD ?? '1.00');
// `1,00`, `$1.00`, `1USD` all parse to NaN, and `total > NaN` is FALSE — which would silently DELETE the spend
// ceiling on a money-spending script. Refuse instead.
if (!Number.isFinite(MAX_USD) || MAX_USD <= 0) {
  console.error(
    `calibrate-aws: CR_CALIBRATE_MAX_USD must be a positive number (got ${JSON.stringify(process.env.CR_CALIBRATE_MAX_USD)}).`,
  );
  process.exit(2);
}
/**
 * Workload size. Deliberately NOT `measure.cjs`'s `int()`, which maps 0 (and anything non-numeric) to the
 * default — so someone shrinking a real run with `CR_CALIBRATE_WRITES=0` would silently get the full 2000. Here
 * 0 means 0, and a malformed value is an error rather than a surprise bill.
 */
const size = (name, d) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return d;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(
      `calibrate-aws: ${name} must be a non-negative integer (got ${JSON.stringify(raw)}).`,
    );
    process.exit(2);
  }
  return n;
};
const SEGMENTS = size('CR_CALIBRATE_SEGMENTS', 20);
const WRITES = size('CR_CALIBRATE_WRITES', 2000);
const READS = size('CR_CALIBRATE_READS', 2000);
const IDS_PER_SEGMENT = size('CR_CALIBRATE_IDS', 500);
const CONCURRENCY = Math.max(1, size('CR_CALIBRATE_CONCURRENCY', 16));
/**
 * `DEFAULT_MAX_RETRIES` from packages/core/src/core/engine.ts — the engine's OCC retry bound. Mirrored (it is not
 * exported) so the projection can be a genuine ceiling: the worst case per write is one attempt plus this many
 * retries, and every round issues a GetItem + UpdateItem pair.
 */
const ENGINE_MAX_OCC_RETRIES = 16;

/** A short, sortable id so every resource and the cost-allocation tag identify this exact run. */
// `||` on purpose: an EMPTY env var counts as absent, so `CR_CALIBRATE_RUN_ID=` cannot name the resources
// `cloudbitmaps-calib-` with a bare suffix. The positional `--cleanup <runId>` wins when present.
const ENV_RUN_ID = process.env.CR_CALIBRATE_RUN_ID || undefined;
const POSITIONAL_RUN_ID =
  CLEANUP_ID !== undefined && CLEANUP_ID !== '' && !CLEANUP_ID.startsWith('-')
    ? CLEANUP_ID
    : undefined;
const RUN_ID =
  POSITIONAL_RUN_ID ?? ENV_RUN_ID ?? `${new Date().toISOString().slice(0, 10)}-${process.pid}`;
const BUCKET = `cloudbitmaps-calib-${RUN_ID}`.toLowerCase();
const TABLE = `cloudbitmaps-calib-${RUN_ID}`;
const TAG = { Key: 'cloudbitmaps-calibration', Value: RUN_ID };

/** Cleanup thunks registered by `main()`, so the top-level catch can await teardown instead of racing it. */
const finishers = [];

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`calibrate-aws: ${msg}`);
  process.exit(2);
};

/**
 * Projected billable ops for the configured workload, derived from the same op-mix the phases will issue.
 * Deliberately an OVER-estimate where uncertain — a ceiling check must never be optimistic.
 */
function project(PRICING) {
  // WRITE: each add() is one OCC read-modify-write, and every retry round issues ANOTHER GetItem + UpdateItem
  // pair — so measured reads and writes track each other almost exactly (observed 237/231, 318/312, 481/474).
  // Two earlier versions were NOT bounds: ×2 left writes within one request of the projection, and giving reads
  // a smaller multiplier than writes meant the read slot breached first (measured 237 vs projected 186). Both
  // now derive from the engine's own retry bound, which makes this a real ceiling rather than a guess about
  // contention — and the between-op runtime check below covers the case where even that is wrong.
  const attemptsPerWrite = 1 + ENGINE_MAX_OCC_RETRIES;
  const warmWrite = WRITES * attemptsPerWrite;
  const warmRead = warmWrite + READS * 3;
  // PUBLISH: one .crbm PUT per segment (small ⇒ single PUT, not multipart) + a registry write, + bucket/table setup.
  const coldPut = SEGMENTS * 2 + 4;
  // READ: count() may fetch cold chunks per segment; assume every read misses cache.
  const coldGet = READS + SEGMENTS * 2;
  const tally = {
    'cold.get': { n: coldGet, bytes: coldGet * 8 * 1024 },
    'cold.put': { n: coldPut, bytes: coldPut * 8 * 1024 },
    'cold.list': { n: SEGMENTS + 8, bytes: 0 },
    'warm.read': { n: warmRead, bytes: warmRead * 8 * 1024 },
    'warm.write': { n: warmWrite, bytes: warmWrite * 8 * 1024 },
  };
  const cost = costOf(tally, PRICING);
  // Storage for a handful of small objects held for minutes — a rounding error, but included so the CEILING
  // bounds slightly MORE than the run can cost. Note the measured result reports requests only, so the
  // projection and the published figure are not the same quantity (documented in the method doc).
  const storageUSD =
    ((SEGMENTS * IDS_PER_SEGMENT * 8) / 1024 ** 3) * PRICING.cold.storagePerGiBMonth;
  return { tally, cost, storageUSD, totalUSD: cost.totalUSD + storageUSD };
}

async function main() {
  // `--cleanup` — remove a previous run's resources by run id. The escape hatch for a SIGKILL, a crashed
  // machine, or a teardown that itself failed: those leave a bucket accruing storage charges with no process
  // left to clean it up.
  if (CLEANUP) {
    if (REGION === undefined || REGION === '') fail('--cleanup needs CR_CALIBRATE_REGION.');
    if (POSITIONAL_RUN_ID === undefined && ENV_RUN_ID === undefined) {
      fail('--cleanup needs a run id: `--cleanup <runId>` or CR_CALIBRATE_RUN_ID=<runId>.');
    }
    const rehearse = ENDPOINT !== undefined && ENDPOINT !== '';
    const cfg = rehearse
      ? {
          region: REGION,
          endpoint: ENDPOINT,
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          forcePathStyle: true,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        }
      : { region: REGION };
    loadDeps();
    log(`calibrate-aws --cleanup: removing s3://${BUCKET} and dynamodb:${TABLE} in ${REGION}`);
    await teardown(new S3Client(cfg), new DynamoDBClient(cfg), { bucket: true, table: true });
    return;
  }

  // Validate the run flags BEFORE loading anything — a refusal should not depend on a build, and it also means
  // `--run` with a missing region fails immediately instead of printing a projection first.
  if (RUN) {
    if (REGION === undefined || REGION === '') {
      fail('CR_CALIBRATE_REGION is required for a real run — there is deliberately no default.');
    }
    if (CONFIRM !== 'spend-real-money') {
      fail("--run requires CR_CALIBRATE_CONFIRM=spend-real-money (you're about to be billed).");
    }
  }

  loadDeps();
  const PRICING = AWS_US_EAST_1_ONDEMAND;
  const p = project(PRICING);
  log(`calibrate-aws — projection for ${SEGMENTS} segments / ${WRITES} writes / ${READS} reads`);
  log(
    `  projected billable ops: cold.get=${p.tally['cold.get'].n} cold.put=${p.tally['cold.put'].n} ` +
      `cold.list=${p.tally['cold.list'].n} warm.read=${p.tally['warm.read'].n} warm.write=${p.tally['warm.write'].n}`,
  );
  log(
    `  projected cost @ ${PRICING.name}: $${round(p.totalUSD, 6)} ` +
      `(S3 GET $${round(p.cost.s3GetUSD, 6)} · S3 PUT/LIST $${round(p.cost.s3PutUSD, 6)} · ` +
      `Dynamo R $${round(p.cost.dynamoReadUSD, 6)} · Dynamo W $${round(p.cost.dynamoWriteUSD, 6)})`,
  );
  log(`  ceiling: $${MAX_USD.toFixed(2)} (CR_CALIBRATE_MAX_USD)`);

  if (p.totalUSD > MAX_USD) {
    fail(
      `projected $${round(p.totalUSD, 6)} exceeds the $${MAX_USD.toFixed(2)} ceiling — ` +
        'lower the workload or raise CR_CALIBRATE_MAX_USD deliberately.',
    );
  }

  if (!RUN) {
    log('\n  DRY RUN — nothing was created and no AWS call was made.');
    log('  To run for real:');
    log(
      '    CR_CALIBRATE_REGION=<region> CR_CALIBRATE_CONFIRM=spend-real-money pnpm calibrate:aws --run',
    );
    log('  To rehearse against LocalStack for free:');
    log('    CR_CALIBRATE_ENDPOINT=http://127.0.0.1:4566 CR_CALIBRATE_REGION=us-east-1 \\');
    log('      CR_CALIBRATE_CONFIRM=spend-real-money pnpm calibrate:aws --run');
    return;
  }

  const rehearsal = ENDPOINT !== undefined && ENDPOINT !== '';
  const common = rehearsal
    ? {
        region: REGION,
        endpoint: ENDPOINT,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }
    : { region: REGION };

  const meter = createAwsMeter();
  const s3 = new S3Client({
    ...common,
    // Rehearsal-only compat: LocalStack's S3 doesn't fully implement the SDK's default flexible checksums, so
    // response validation trips on a ranged GET. A REAL run leaves validation ON — end-to-end checksum
    // integrity is one of the things a calibration run should be exercising, not switching off.
    ...(rehearsal
      ? {
          forcePathStyle: true,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        }
      : {}),
  });
  const dynamo = new DynamoDBClient(common);

  // Identity BEFORE anything is created, and outside the meter — you must see which account this is.
  if (!rehearsal) {
    await announceIdentity(s3, dynamo);
  } else {
    log(`\n  REHEARSAL against ${ENDPOINT} — no real AWS resources, no cost.`);
  }
  log(`  resources: s3://${BUCKET}  ·  dynamodb:${TABLE}  ·  tag ${TAG.Key}=${TAG.Value}`);

  meter.attach(s3, 's3');
  meter.attach(dynamo, 'dynamodb');

  const created = { bucket: false, table: false };
  const results = {};

  // A `finally` does NOT run on a signal. Ctrl-C (SIGINT) or a `timeout`/SIGTERM would otherwise abandon a live
  // bucket and table — and S3 storage is the one charge that keeps accruing after the process is gone. Observed
  // in testing: a SIGTERM'd run left both resources behind. Catch the signals and tear down before exiting.
  // (SIGKILL is uncatchable by definition — `--cleanup <runId>` exists for that case.)
  // ONE teardown promise, memoised, awaited by every exit path. Three of them race otherwise: the `finally`,
  // the signal handler, and `main().catch()`. Observed: a SIGTERM'd run printed only one of the two "deleted"
  // lines because the in-flight workload rejected the moment the bucket went, and the top-level catch's
  // `process.exit(1)` then killed the process mid-`DeleteTable`. On LocalStack the delete still landed; on real
  // AWS `DeleteTable` is a slower control-plane call, which is exactly where a table would survive.
  let teardownOnce;
  const tearDownIdempotent = () => {
    teardownOnce ??= teardown(s3, dynamo, created);
    return teardownOnce;
  };
  finishers.push(tearDownIdempotent);

  let signalHandled = false;
  const onSignal = (sig) => {
    if (signalHandled) {
      console.error(
        `calibrate-aws: ${sig} again — teardown is IN PROGRESS. Killing it now leaks real resources.\n` +
          `               If you must, clean up afterwards with:\n` +
          `               CR_CALIBRATE_REGION=${REGION ?? '<region>'} pnpm calibrate:aws --cleanup ${RUN_ID}`,
      );
      return;
    }
    signalHandled = true;
    void (async () => {
      console.error(`\ncalibrate-aws: ${sig} received — tearing down before exit.`);
      try {
        await tearDownIdempotent();
      } finally {
        process.exit(130);
      }
    })();
  };
  // `process.on`, NOT `once`: with `once` the handler is consumed by the first signal, so an impatient second
  // Ctrl-C — the natural reaction to "nothing is happening", and teardown is 4+ network round trips on real AWS
  // — reached Node's default handler and killed the process mid-delete, leaking the bucket, its objects and the
  // table with no warning at all. A repeat signal now says so instead of dying.
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await createFresh(s3, dynamo, rehearsal, created);

    const store = new CloudRoaring({
      warm: new DynamoDbWarmDriver({ client: dynamo, tableName: TABLE }),
      cold: new S3ColdDriver({ client: s3, bucket: BUCKET }),
      registry: new DynamoDbRegistryDriver({ client: dynamo, tableName: TABLE }),
    });
    const cold = new S3ColdDriver({ client: s3, bucket: BUCKET });
    const registry = new DynamoDbRegistryDriver({ client: dynamo, tableName: TABLE });
    const seg = (i) => `calib-${i}`;

    /**
     * Enforce the spend ceiling from MEASURED ops, between phases. The pre-flight projection is a static guess
     * about retry behaviour; this is the actual number. If a phase blows the budget the run aborts and the
     * `finally` tears everything down, so a pathological workload cannot quietly run up a bill.
     */
    const assertUnderCeiling = (phase) => {
      const soFar = costOf(meter.tally, PRICING).totalUSD;
      if (soFar > MAX_USD) {
        throw new Error(
          `spend ceiling exceeded after ${phase}: measured $${round(soFar, 6)} > $${MAX_USD.toFixed(2)} ` +
            '(CR_CALIBRATE_MAX_USD). Aborting and tearing down.',
        );
      }
      return soFar;
    };

    const beforeWrite = meter.snapshot();
    // `onProgress` matters most here: WRITE is the one phase whose op count is unbounded (each OCC retry round
    // issues another read + write), so checking only at the phase boundary left it a single unchecked window.
    const write = await drive(
      WRITES,
      (i) => store.segment(seg(i % SEGMENTS)).add(1000 + i),
      CONCURRENCY,
      {
        onProgress: () => assertUnderCeiling('WRITE (in progress)'),
      },
    );
    const afterWrite = meter.snapshot();
    assertUnderCeiling('WRITE');

    const publish = await drive(
      SEGMENTS,
      (i) => {
        const base = i * 100_000;
        const ids = Array.from({ length: IDS_PER_SEGMENT }, (_, k) => base + k * 7);
        return bulkLoadCrbmGeneration(cold, { segment: seg(i), generation: 0 }, ids, { registry });
      },
      Math.min(CONCURRENCY, SEGMENTS),
    );
    const afterPublish = meter.snapshot();
    assertUnderCeiling('PUBLISH');

    const read = await drive(READS, (i) => store.segment(seg(i % SEGMENTS)).count(), CONCURRENCY);
    const afterRead = meter.snapshot();
    assertUnderCeiling('READ');

    const cost = costOf(meter.tally, PRICING);
    // `billableOps` is deliberately NOT called `ops` — `stats()` already returns `ops` as the operation COUNT,
    // and overwriting it with the per-phase op breakdown printed `[object Object] ops`.
    results.phases = {
      write: {
        ...stats(write.latencies, write.wallMs),
        billableOps: deltaOf(beforeWrite, afterWrite),
      },
      publish: {
        ...stats(publish.latencies, publish.wallMs),
        billableOps: deltaOf(afterWrite, afterPublish),
      },
      read: {
        ...stats(read.latencies, read.wallMs),
        billableOps: deltaOf(afterPublish, afterRead),
      },
    };
    // A SNAPSHOT, not the live tally: teardown issues metered ListObjectsV2 + DeleteObjects in the `finally`,
    // which would otherwise appear in the published op counts *after* cost was computed from them — so anyone
    // recomputing cost from the published counts would get a different (higher) number than the published cost.
    const finalOps = meter.snapshot();
    results.measuredOps = finalOps.tally;
    results.commands = finalOps.commands;
    results.attempts = finalOps.attempts;
    results.failedAttempts = finalOps.failures;
    results.cost = {
      pricing: PRICING.name,
      capacityUnits: cost.capacityUnits,
      s3GetUSD: round(cost.s3GetUSD, 6),
      s3PutListUSD: round(cost.s3PutUSD, 6),
      dynamoReadUSD: round(cost.dynamoReadUSD, 6),
      dynamoWriteUSD: round(cost.dynamoWriteUSD, 6),
      totalUSD: round(cost.totalUSD, 6),
      redisAlwaysOnMonthlyUSD: PRICING.redis.monthlyUSD,
    };

    log('');
    const line = (label, s) =>
      log(
        `  ${label}: ${s.ops} ops @ ${s.opsPerSec}/s; p50 ${pct(s.p50)} · p99 ${pct(s.p99)} · p999 ${pct(s.p999)} · max ${pct(s.max)}`,
      );
    line('WRITE (add→DynamoDB OCC)  ', results.phases.write);
    line('PUBLISH (bulk-load→S3 PUT)', results.phases.publish);
    line('READ  (count→S3∪DynamoDB) ', results.phases.read);
    log(
      `  measured ops: cold.get=${meter.tally['cold.get'].n} cold.put=${meter.tally['cold.put'].n} ` +
        `cold.list=${meter.tally['cold.list'].n} warm.read=${meter.tally['warm.read'].n} warm.write=${meter.tally['warm.write'].n}`,
    );
    log(
      `  DynamoDB capacity units (${cost.capacityUnits.source}): read ${round(cost.capacityUnits.read, 2)} · write ${round(cost.capacityUnits.write, 2)}`,
    );
    // `attempts > commands` means the SDK retried, or OCC conflicted and the engine re-tried — AWS bills each
    // attempt, so the request counts above are attempts while capacity is per command. Worth seeing.
    const totalAttempts = Object.values(meter.attempts).reduce((a, b) => a + b, 0);
    const totalCommands = Object.values(meter.commands).reduce((a, b) => a + b, 0);
    const totalFailed = Object.values(meter.failures).reduce((a, b) => a + b, 0);
    log(
      `  requests: ${totalAttempts} HTTP attempts for ${totalCommands} commands` +
        (totalFailed > 0 ? ` (${totalFailed} attempt(s) returned an error — still billed)` : ''),
    );
    // Consistency check, not an assumption. DynamoDB is documented to report ConsumedCapacity on every
    // data-plane response when asked, so units should track the request count. Against LocalStack they do NOT
    // (observed: 156 units reported across 291 write requests), and if that also happened on real AWS the
    // DynamoDB cost term would be silently understated. Surface it rather than trusting the number.
    const ddbRequests = meter.tally['warm.read'].n + meter.tally['warm.write'].n;
    const unitBearing = cost.capacityUnits.read + cost.capacityUnits.write;
    if (ddbRequests > 0 && unitBearing < ddbRequests * 0.95) {
      console.error(
        `  ⚠ capacity under-reported: ${round(unitBearing, 2)} units across ${ddbRequests} DynamoDB requests.\n` +
          '    Each request should report at least ~1 unit, so the DynamoDB cost term is a FLOOR, not the figure.\n' +
          '    Expected against LocalStack; if you see it on a real run, do not publish the DynamoDB cost.',
      );
      results.cost.capacityWarning = `only ${round(unitBearing, 2)} units reported across ${ddbRequests} requests — DynamoDB cost is a floor`;
    }
    log(
      `  measured cost of this workload @ ${PRICING.name}: $${results.cost.totalUSD} ` +
        `(S3 GET $${results.cost.s3GetUSD} · S3 PUT/LIST $${results.cost.s3PutListUSD} · ` +
        `Dynamo R $${results.cost.dynamoReadUSD} · Dynamo W $${results.cost.dynamoWriteUSD})`,
    );
    log(`  always-on Redis baseline for contrast: $${PRICING.redis.monthlyUSD}/mo`);
  } catch (err) {
    // A paid run that crashes late (OCC exhaustion at ~90% of the workload is reproducible) must NOT throw away
    // the phases that already completed — you were billed for those requests. Persist what exists, flagged
    // partial, then rethrow so the exit code and teardown still happen.
    results.partial = true;
    results.error = String(err?.message ?? err);
    throw err;
  } finally {
    await tearDownIdempotent();
    writeResult(rehearsal, results);
  }
}

/**
 * Persist the run. Called from the `finally`, so a run that CRASHED still writes what it measured — those
 * requests were billed, and throwing the completed phases away was pure loss.
 */
function writeResult(rehearsal, results) {
  const out = {
    note: rehearsal
      ? 'REHEARSAL against LocalStack — mechanics only. Latency and cost here are NOT the calibrated figures.'
      : 'Measured against real AWS by `pnpm calibrate:aws --run`. Latency is region/instance-dependent; cost is published on-demand pricing applied to WIRE-METERED op counts, with DynamoDB units taken from AWS ConsumedCapacity. Reconcile against Cost Explorer via the tag below.',
    rehearsal,
    region: REGION,
    runId: RUN_ID,
    costAllocationTag: `${TAG.Key}=${TAG.Value}`,
    at: new Date().toISOString(),
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}` },
    config: {
      segments: SEGMENTS,
      writes: WRITES,
      reads: READS,
      idsPerSegment: IDS_PER_SEGMENT,
      concurrency: CONCURRENCY,
    },
    ...results,
  };
  const dest = path.join(
    ROOT,
    'bench',
    rehearsal ? 'calibrate-aws-rehearsal.json' : 'calibrate-aws-results.json',
  );
  fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
  log(
    `\n  wrote ${path.relative(ROOT, dest)}${out.partial === true ? ' (PARTIAL — the run did not finish)' : ''}`,
  );
  if (!rehearsal && out.partial !== true) {
    log(`  reconcile tomorrow: Cost Explorer, filter tag ${TAG.Key}=${TAG.Value}`);
  }
}

/**
 * Print who we are about to bill, using the SAME credential chain the run will use — not a separate shell
 * command that might resolve a different profile.
 *
 * `@aws-sdk/client-sts` is NOT a dependency of this repo (nothing in the library needs it, and adding a
 * dependency for one bench line isn't worth it), so it is loaded opportunistically: present → the real account
 * id; absent → the resolved access-key id, masked, which still distinguishes one profile from another. Either
 * way the run refuses to be silent about whose money it is spending.
 */
async function announceIdentity(s3, dynamo) {
  // Resolve ONCE and share, so the identity shown is the identity used. Each client resolves the chain
  // independently, and a mismatch between them would mean the printed identity described a different principal
  // than the one doing the work.
  let creds;
  try {
    creds = await dynamo.config.credentials();
  } catch (err) {
    fail(`could not resolve AWS credentials (${err?.name ?? err}). Nothing was created.`);
  }
  try {
    const s3Creds = await s3.config.credentials();
    if (s3Creds?.accessKeyId !== creds?.accessKeyId) {
      fail(
        'the S3 and DynamoDB clients resolved DIFFERENT credentials — refusing to run, because the identity ' +
          'printed below would not describe both halves of the workload.',
      );
    }
  } catch (err) {
    fail(`could not resolve AWS credentials for S3 (${err?.name ?? err}). Nothing was created.`);
  }

  const id = creds?.accessKeyId ?? '';
  const masked = id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '(hidden)';

  // `@aws-sdk/client-sts` is not a dependency of this repo — nothing in the library needs it, and adding one for
  // a single bench line isn't worth it — so the account id is a best-effort extra. Distinguish "not installed"
  // from "the call failed": printing the former when a token has expired is actively misleading.
  let sts;
  try {
    sts = require('@aws-sdk/client-sts');
  } catch {
    sts = undefined;
  }
  if (sts !== undefined) {
    try {
      const client = new sts.STSClient({ region: REGION, credentials: creds });
      const who = await client.send(new sts.GetCallerIdentityCommand({}));
      log(`\n  account ${who.Account}  ·  region ${REGION}  ·  arn ${who.Arn}`);
      if (EXPECT_ACCOUNT !== undefined && who.Account !== EXPECT_ACCOUNT) {
        fail(
          `account ${who.Account} does not match CR_CALIBRATE_EXPECT_ACCOUNT=${EXPECT_ACCOUNT}. Nothing was created.`,
        );
      }
      return;
    } catch (err) {
      log(`\n  region ${REGION}  ·  access key ${masked}`);
      log(
        `  NOTE: sts:GetCallerIdentity failed (${err?.name ?? err}) — the ACCOUNT could not be confirmed.`,
      );
      if (EXPECT_ACCOUNT !== undefined) {
        fail(
          'CR_CALIBRATE_EXPECT_ACCOUNT was set but the account could not be verified. Refusing to run.',
        );
      }
      return;
    }
  }
  log(`\n  region ${REGION}  ·  access key ${masked}`);
  log(
    '  NOTE: @aws-sdk/client-sts is not installed, so the ACCOUNT ID could not be shown — and under SSO or\n' +
      '        assume-role the key above is ephemeral and identifies no account. Confirm the target yourself:\n' +
      '          aws sts get-caller-identity',
  );
  if (EXPECT_ACCOUNT !== undefined) {
    fail(
      'CR_CALIBRATE_EXPECT_ACCOUNT was set, but @aws-sdk/client-sts is not installed so the account cannot be ' +
        'verified. Install it or unset the variable — a guard that cannot check is worse than no guard.',
    );
  }
}

/**
 * Create the bucket + table, refusing to touch anything that already exists.
 *
 * BOTH existence probes run BEFORE either resource is created, and `created` is a caller-owned object mutated
 * in place. Two leaks the earlier shape had:
 *   - probing the table only after creating the bucket meant a pre-existing table left an ORPHANED BUCKET — and
 *     it bailed via `process.exit`, which skips `finally`, so nothing was even printed about it;
 *   - returning a fresh `created` object meant a signal arriving during `waitUntilTableExists` (up to 120 s on
 *     real AWS) found the caller's `created` still all-false, so teardown deleted nothing.
 * It throws rather than exiting, so the caller's `finally` always runs.
 */
async function createFresh(s3, dynamo, rehearsal, created) {
  /**
   * "Does this already exist?" — where swallowing an error is a hazard, not a convenience.
   *
   * `HeadBucket` answers **403, not 404**, for a bucket you own but cannot `s3:ListBucket` (an SCP or bucket
   * policy is enough). Reading that as "absent" was dangerous rather than merely wrong: in **us-east-1** — this
   * doc's own example region — `CreateBucket` on a bucket you ALREADY OWN returns **200 OK** rather than
   * `BucketAlreadyOwnedByYou`, so the run would have written into your bucket and teardown would then have
   * emptied and deleted it. Only a genuine not-found counts as absent; anything else stops the run.
   */
  const NOT_FOUND = new Set(['NotFound', 'NoSuchBucket', 'ResourceNotFoundException', 'NoSuchKey']);
  const exists = async (what, probe) => {
    try {
      await probe();
      return true;
    } catch (err) {
      const name = err?.name ?? err?.Code ?? '';
      if (NOT_FOUND.has(name) || err?.$metadata?.httpStatusCode === 404) return false;
      throw new Error(
        `cannot determine whether ${what} already exists (${name || err}). Refusing to continue — a permissions ` +
          'error looks identical to "absent" here, and creating over a bucket you already own would let teardown ' +
          'delete it.',
        { cause: err },
      );
    }
  };

  // --- probe everything first: nothing is created until BOTH checks pass ---
  if (await exists(`s3://${BUCKET}`, () => s3.send(new HeadBucketCommand({ Bucket: BUCKET })))) {
    throw new Error(
      `bucket ${BUCKET} already exists — refusing to write into a pre-existing bucket.`,
    );
  }
  if (
    await exists(`dynamodb:${TABLE}`, () =>
      dynamo.send(new DescribeTableCommand({ TableName: TABLE })),
    )
  ) {
    throw new Error(`table ${TABLE} already exists — refusing to write into a pre-existing table.`);
  }

  // --- now create ---
  // Flag BEFORE the call: a lost response (socket hangup, control-plane timeout) can still have created the
  // resource, and teardown must know to try. A false positive costs a wasted delete; a false negative leaks.
  created.bucket = true;
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  if (!rehearsal) {
    // Cost-allocation tag: the only way to reconcile this run against the real bill later.
    await s3.send(new PutBucketTaggingCommand({ Bucket: BUCKET, Tagging: { TagSet: [TAG] } }));
  }

  created.table = true;
  await dynamo.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST', // on-demand, so the run is billed per request with nothing left provisioned
      // `PK`/`SK` (upper-case) is the single-table layout DynamoDbWarmDriver + DynamoDbRegistryDriver expect
      // — the same schema bench/load-localstack.cjs creates. Lower-case names get a ValidationException
      // ("One of the required keys was not given a value") on the first driver read.
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      ...(rehearsal ? {} : { Tags: [TAG] }),
    }),
  );
  await waitUntilTableExists({ client: dynamo, maxWaitTime: 120 }, { TableName: TABLE });
}

/**
 * Remove everything this run created. Reached four ways — the `finally`, a SIGINT/SIGTERM handler, `--cleanup`,
 * and the top-level catch — because storage is the one charge that keeps accruing after the process is gone.
 *
 * Three things it has to get right that the obvious version doesn't:
 *   1. **Abort in-flight multipart uploads.** Their parts ARE billed as storage, and real S3 refuses to delete a
 *      bucket with an upload in progress. `S3MultipartSink.abort()` is best-effort, so a crash mid-publish can
 *      leave one behind. LocalStack cannot rehearse this — it deletes such a bucket happily.
 *   2. **Delete object VERSIONS and delete-markers**, not just current objects. `ListObjectsV2` + `DeleteObjects`
 *      cannot empty a versioned bucket, so an org SCP or Config rule that enables versioning on new buckets would
 *      have left the last-resort cleanup tool with no path at all.
 *   3. **"Already gone" is SUCCESS.** Reporting a non-existent resource as a leftover that "will keep costing
 *      money" — which `--cleanup` did on every clean run — trains the operator to ignore the one signal that
 *      actually matters.
 */
async function teardown(s3, dynamo, created) {
  const leftovers = [];
  const GONE = new Set(['NoSuchBucket', 'NotFound', 'ResourceNotFoundException', 'NoSuchUpload']);
  const isGone = (err) => GONE.has(err?.name ?? '') || err?.$metadata?.httpStatusCode === 404;

  if (created.bucket) {
    try {
      for (;;) {
        const ups = await s3.send(new ListMultipartUploadsCommand({ Bucket: BUCKET }));
        const list = ups.Uploads ?? [];
        if (list.length === 0) break;
        for (const u of list) {
          await s3.send(
            new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: u.Key, UploadId: u.UploadId }),
          );
        }
        if (ups.IsTruncated !== true) break;
      }

      for (;;) {
        const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET }));
        const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((o) => ({
          Key: o.Key,
          VersionId: o.VersionId,
        }));
        if (objects.length === 0) break;
        await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } }));
        if (listed.IsTruncated !== true) break;
      }

      await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
      log(`  teardown: deleted s3://${BUCKET}`);
    } catch (err) {
      if (isGone(err)) log(`  teardown: s3://${BUCKET} already gone`);
      else leftovers.push(`s3://${BUCKET} (${err?.name ?? err})`);
    }
  }

  if (created.table) {
    try {
      await dynamo.send(new DeleteTableCommand({ TableName: TABLE }));
      log(`  teardown: deleted dynamodb:${TABLE}`);
    } catch (err) {
      if (isGone(err)) log(`  teardown: dynamodb:${TABLE} already gone`);
      else leftovers.push(`dynamodb:${TABLE} (${err?.name ?? err})`);
    }
  }

  if (leftovers.length > 0) {
    console.error(
      `\ncalibrate-aws: TEARDOWN INCOMPLETE — these still exist and will keep costing money:\n  ${leftovers.join('\n  ')}\n` +
        `\n  Retry with:  CR_CALIBRATE_REGION=${REGION ?? '<region>'} pnpm calibrate:aws --cleanup ${RUN_ID}`,
    );
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error(err);
  // Await any registered teardown BEFORE exiting — `process.exit()` here used to kill an in-flight delete.
  for (const finish of finishers) {
    try {
      await finish();
    } catch (cleanupErr) {
      console.error('calibrate-aws: cleanup also failed:', cleanupErr);
    }
  }
  process.exitCode =
    process.exitCode === 0 || process.exitCode === undefined ? 1 : process.exitCode;
});
