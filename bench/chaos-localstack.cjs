/*
 * Chaos drills against LocalStack (test-strategy T8).
 *
 * Complements the deterministic simulator (which searches interleavings + crash-at-every-2PC-step in-process)
 * by injecting REAL infrastructure faults at the real AWS SDK drivers and asserting the store rides them out
 * with no lost/corrupted committed data and full recovery.
 *
 *   C1  THROTTLE     Inject `ThrottlingException` at the DynamoDB client (below the driver, SDK retries off) at
 *                    a seeded rate, with the store's own retry layer ON. Concurrent disjoint-CHUNK writers ⇒ a
 *                    deterministic oracle; assert the retry layer rides the throttles out with NO lost update.
 *                    (This is exactly the resilience the #73 cross-bundle fix restored in the CJS package.)
 *   C2  OUTAGE       `docker pause` LocalStack mid-write-loop (a freeze longer than a single request), then
 *                    `docker unpause`. Ops block on the frozen backend and resume on unpause (or fail
 *                    transiently and are re-driven if the freeze outlasts the retry budget); assert the outage
 *                    measurably stalled the run, every intended write lands, and `checkConsistency` is clean
 *                    afterward — a ride-through with no lost/corrupted committed data.
 *
 * NOT covered here, honestly: kill-daemon-mid-2PC is proven by the in-process crash-at-every-step sweep
 * (DECISIONS #18 / sim), which pins an exact step a real-backend kill can't; disk-full isn't cleanly injectable
 * on ephemeral LocalStack S3 (the analogous write-failure path is exercised by C1/C2 + the write-once
 * conditional-PUT tests). See 95-TEST-STRATEGY.
 *
 * Offline + needs LocalStack + `docker` on PATH — NOT a CI gate. Bring LocalStack up first:
 * `docker compose -f docker-compose.localstack.yml up -d --wait`. Run: `pnpm chaos`.
 *   Env: LS_ENDPOINT  CHAOS_CONTAINER=cloud-roaring-localstack  CHAOS_WRITERS=12  CHAOS_OPS=80
 *        CHAOS_THROTTLE=0.3  CHAOS_SEED=1  CHAOS_PAUSE_MS=2500  CHAOS_INJECT=1 (persist results)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} = require('@aws-sdk/client-dynamodb');
const { CloudRoaring, isTransientError } = require('@cloudbitmaps/roaring');
const { S3ColdDriver } = require('@cloudbitmaps/core/s3');
const { DynamoDbWarmDriver, DynamoDbRegistryDriver } = require('@cloudbitmaps/core/dynamodb');

const ROOT = path.resolve(__dirname, '..');
const ENDPOINT = process.env.LS_ENDPOINT || 'http://127.0.0.1:4566';
const CONTAINER = process.env.CHAOS_CONTAINER || 'cloud-roaring-localstack';
const WRITERS = int(process.env.CHAOS_WRITERS, 12);
const OPS = int(process.env.CHAOS_OPS, 80);
const THROTTLE = num(process.env.CHAOS_THROTTLE, 0.3);
const SEED = int(process.env.CHAOS_SEED, 1);
const PAUSE_MS = int(process.env.CHAOS_PAUSE_MS, 2500);
const BUCKET = 'cloud-roaring-chaos';
const TABLE = 'cloud-roaring-chaos';
const RUN = String(process.env.CHAOS_RUN || Date.now());

function int(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}
function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function docker(...args) {
  execFileSync('docker', args, { stdio: 'ignore' });
}

function clients() {
  const common = {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1, // SDK retries OFF — we are testing CloudRoaring's own retry layer, not the SDK's.
  };
  const s3 = new S3Client({
    ...common,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const dynamo = new DynamoDBClient(common);
  return { s3, dynamo };
}

/** Add a middleware that throws a retryable ThrottlingException before `rate` of DynamoDB calls (seeded). */
function installThrottle(dynamo, rate, rand, counter) {
  dynamo.middlewareStack.add(
    (next) => async (args) => {
      if (rand() < rate) {
        counter.injected += 1;
        const err = new Error('injected ThrottlingException (chaos)');
        err.name = 'ThrottlingException'; // classified transient by the DynamoDb driver ⇒ retried by the store
        throw err;
      }
      return next(args);
    },
    { step: 'initialize', name: 'chaosThrottle', priority: 'high' },
  );
}

function store(dynamo, s3, deps) {
  const cold = new S3ColdDriver({ client: s3, bucket: BUCKET, prefix: `cold-${RUN}` });
  const warm = new DynamoDbWarmDriver({
    client: dynamo,
    tableName: TABLE,
    keyPrefix: `warm${RUN}`,
  });
  const registry = new DynamoDbRegistryDriver({
    client: dynamo,
    tableName: TABLE,
    keyPrefix: `reg${RUN}`,
    now: () => Date.now(),
  });
  // Generous retry so a burst of injected throttles is ridden out (a bench, not a gate — avoid flakes).
  const cr = new CloudRoaring({
    warm,
    cold,
    registry,
    retry: { maxAttempts: 15, baseDelayMs: 10, maxDelayMs: 200, backoffFactor: 2, jitter: 'full' },
  });
  Object.assign(deps, { cold, warm, registry });
  return cr;
}

async function ensureBackend(s3, dynamo) {
  await retry('CreateBucket', () => s3.send(new CreateBucketCommand({ Bucket: BUCKET })), [
    'BucketAlreadyOwnedByYou',
    'BucketAlreadyExists',
  ]);
  await retry(
    'CreateTable',
    () =>
      dynamo.send(
        new CreateTableCommand({
          TableName: TABLE,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
          ],
        }),
      ),
    ['ResourceInUseException'],
  );
  for (let i = 0; i < 40; i++) {
    const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: TABLE }));
    if (Table && Table.TableStatus === 'ACTIVE') return;
    await sleep(200);
  }
}
async function retry(label, fn, ok) {
  for (let i = 0; i < 40; i++) {
    try {
      return await fn();
    } catch (err) {
      if (ok.includes((err && err.name) || '')) return;
      if (i === 39) throw new Error(`${label} failed: ${String(err)}`);
      await sleep(500);
    }
  }
}
async function members(cr, seg) {
  const out = [];
  for await (const id of cr.segment(seg).iterate()) out.push(id);
  return out.sort((a, b) => a - b);
}

// ── C1: throttle injection — the store's retry layer must ride it out with no lost update ──
async function chaos1() {
  const { s3, dynamo } = clients();
  const counter = { injected: 0 };
  const cr = store(dynamo, s3, {});
  await ensureBackend(s3, dynamo); // set up the bucket/table on a CLEAN client…
  installThrottle(dynamo, THROTTLE, rng(SEED), counter); // …then start injecting throttles into the workload.

  const seg = 'throttle';
  // Each writer owns a DISTINCT chunk (its own Warm row) so there is no OCC contention — the injected throttle
  // is the ONLY fault under test (OCC-under-contention is T4 S2's job). The oracle is each writer's last-op-per-id.
  const oracle = new Set();
  const plans = [];
  for (let w = 0; w < WRITERS; w++) {
    const rand = rng(SEED + w * 2654435761);
    const base = (100 + w) * 65536; // writer w → chunk 100+w
    const ops = [];
    for (let o = 0; o < OPS; o++) {
      const id = base + ((rand() * 4000) | 0);
      const add = rand() < 0.7;
      ops.push({ id, add });
      if (add) oracle.add(id);
      else oracle.delete(id);
    }
    plans.push(ops);
  }
  const t = process.hrtime.bigint();
  await Promise.all(
    plans.map(async (ops) => {
      for (const op of ops) {
        if (op.add) await cr.segment(seg).add(op.id);
        else await cr.segment(seg).remove(op.id);
      }
    }),
  );
  const ms = round(Number(process.hrtime.bigint() - t) / 1e6, 0);
  const final = await members(cr, seg);
  const oracleArr = [...oracle].sort((a, b) => a - b);
  const converged = final.length === oracleArr.length && final.every((v, i) => v === oracleArr[i]);
  return {
    writers: WRITERS,
    opsPerWriter: OPS,
    totalOps: WRITERS * OPS,
    throttleRate: THROTTLE,
    injectedThrottles: counter.injected,
    ms,
    finalCardinality: final.length,
    oracleCardinality: oracleArr.length,
    convergedNoLostUpdate: converged,
  };
}

// ── C2: backend outage — pause LocalStack mid-loop; ops block/resume; recover fully + consistent after unpause ──
async function chaos2() {
  const { s3, dynamo } = clients();
  const cr = store(dynamo, s3, {});
  await ensureBackend(s3, dynamo);
  const seg = 'outage';
  const N = 400;
  const ids = Array.from({ length: N }, (_, i) => 5 * 65536 + i); // disjoint from C1's chunk
  const intended = new Set(ids);
  const deferred = [];
  let transientFailures = 0;
  let otherFailures = 0;

  // Pause LocalStack partway through the write loop, then unpause — a partition longer than the retry budget.
  const chaos = (async () => {
    await sleep(400);
    docker('pause', CONTAINER);
    await sleep(PAUSE_MS);
    docker('unpause', CONTAINER);
  })();

  const t = process.hrtime.bigint();
  for (const id of ids) {
    try {
      await cr.segment(seg).add(id);
    } catch (err) {
      if (isTransientError(err)) transientFailures += 1;
      else otherFailures += 1;
      deferred.push(id); // no committed data lost — just re-drive after recovery
    }
  }
  const loopMs = round(Number(process.hrtime.bigint() - t) / 1e6, 0);
  await chaos;
  // Recovery: re-drive any ops that surfaced a failure during the outage; they must now succeed.
  await retry(
    'post-outage warmup',
    () => dynamo.send(new DescribeTableCommand({ TableName: TABLE })),
    [],
  );
  for (const id of deferred) await cr.segment(seg).add(id);

  const final = new Set(await members(cr, seg));
  const allLanded = ids.every((id) => final.has(id)) && final.size === intended.size;
  // Cross-tier consistency after the outage (not just a read-back): registry currentGen ↔ cold generations.
  const report = await cr.checkConsistency();
  const consistent = report.inconsistent.length === 0 && report.errored.length === 0;
  // The outage measurably stalled the workload if the loop took at least ~the pause duration — the 2.5s frozen
  // window was absorbed into the run (ops blocked on the frozen backend and resumed on unpause, or failed
  // transiently and were re-driven). Either path is a valid ride-through; what must hold is that no COMMITTED
  // data is lost/corrupted and the fleet stays consistent + recovers.
  const chaosActuallyHappened = loopMs >= PAUSE_MS * 0.8;
  return {
    ids: N,
    pauseMs: PAUSE_MS,
    loopMs,
    consistentAfterRecovery: consistent,
    opsFailedDuringOutage: deferred.length,
    transientFailures,
    otherFailures,
    recoveredAllWrites: allLanded,
    finalCardinality: final.size,
    chaosActuallyHappened,
  };
}

async function main() {
  const out = {
    note: 'Generated by `pnpm chaos` against LocalStack. Real fault injection (throttle + docker pause). Not a CI gate.',
    endpoint: ENDPOINT,
  };
  console.log(`Chaos vs LocalStack (${ENDPOINT})`);

  out.c1 = await chaos1();
  console.log(
    `  C1 throttle: ${out.c1.totalOps} ops, ${out.c1.injectedThrottles} throttles injected (rate ${out.c1.throttleRate}); converged (no lost update)=${out.c1.convergedNoLostUpdate} [${out.c1.finalCardinality}==${out.c1.oracleCardinality}]`,
  );

  out.c2 = await chaos2();
  console.log(
    `  C2 outage: paused ${out.c2.pauseMs}ms (loop absorbed it → ${out.c2.loopMs}ms); ${out.c2.opsFailedDuringOutage} ops surfaced failures (${out.c2.transientFailures} typed-transient, ${out.c2.otherFailures} other); recovered all writes=${out.c2.recoveredAllWrites}; consistent=${out.c2.consistentAfterRecovery}; outage impacted run=${out.c2.chaosActuallyHappened}`,
  );

  const pass =
    out.c1.convergedNoLostUpdate &&
    out.c2.recoveredAllWrites &&
    out.c2.consistentAfterRecovery &&
    out.c2.otherFailures === 0 &&
    out.c2.chaosActuallyHappened;
  out.pass = pass;
  console.log(
    `  chaos ${pass ? 'PASS' : 'FAIL'} — no lost/corrupted committed data under throttle + outage`,
  );

  if (process.env.CHAOS_INJECT === '1') {
    fs.writeFileSync(
      path.join(ROOT, 'bench/chaos-localstack-results.json'),
      JSON.stringify(out, null, 2) + '\n',
    );
    console.log('  wrote bench/chaos-localstack-results.json');
  } else {
    console.log('  (dry run — set CHAOS_INJECT=1 to persist bench/chaos-localstack-results.json)');
  }
  if (!pass) process.exit(1);
}

main().catch((e) => {
  // Best-effort: make sure we never leave LocalStack paused on a crash.
  try {
    docker('unpause', CONTAINER);
  } catch {
    /* already running */
  }
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
