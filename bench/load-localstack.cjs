/*
 * Load + tail-latency harness against LocalStack (test-strategy T7).
 *
 * Drives the REAL AWS SDK drivers — S3ColdDriver + DynamoDbWarmDriver + DynamoDbRegistryDriver — against a
 * LocalStack S3+DynamoDB endpoint (per the owner decision: LocalStack, not a real AWS account). Three phases,
 * each timed per-op so we report throughput AND tail latency (p50/p99/p999), not just an average:
 *   WRITE   add() → one OCC read-modify-write per op on the DynamoDB Warm row.
 *   PUBLISH bulkLoadCrbmGeneration → an immutable .crbm PUT to S3 per segment (the Topology-A ingest path).
 *   READ    count() → tier-merging read (S3 cold ∪ DynamoDb warm), exercising cold GETs + warm reads.
 *
 * Cost calibration: a metrics sink tallies the ACTUAL S3/DynamoDB ops (+ bytes) the workload generated; we then
 * apply the published `AWS_US_EAST_1_ONDEMAND` pricing to those measured counts. LocalStack has no bill — this
 * grounds the cost MODEL against real driver behaviour (real op-mix → real $ at AWS prices), and prints the
 * always-on Redis baseline for contrast.
 *
 * Offline + endpoint/latency-dependent — NOT a CI gate (like bench/run.cjs / soak.cjs / stress.cjs). Needs
 * LocalStack up: `docker compose -f docker-compose.localstack.yml up -d --wait`. Run: `pnpm load`.
 *   Env: LS_ENDPOINT (http://127.0.0.1:4566)  LOAD_SEGMENTS=20  LOAD_WRITES=2000  LOAD_READS=2000
 *        LOAD_CONCURRENCY=16  LOAD_INJECT=1 (persist bench/load-localstack-results.json)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises'); // promise sleep (avoids a bare setTimeout global)
const { int, round, stats, pct, drive, costOf } = require('./lib/measure.cjs');
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  CloudRoaring,
  bulkLoadCrbmGeneration,
  AWS_US_EAST_1_ONDEMAND,
} = require('@cloudbitmaps/roaring');
// The AWS SDK drivers live in the optional peer-dep subpaths (core stays SDK-free), so require them from there.
const { S3ColdDriver } = require('@cloudbitmaps/core/s3');
const { DynamoDbWarmDriver, DynamoDbRegistryDriver } = require('@cloudbitmaps/core/dynamodb');

const ROOT = path.resolve(__dirname, '..');
const ENDPOINT = process.env.LS_ENDPOINT || 'http://127.0.0.1:4566';
const SEGMENTS = int(process.env.LOAD_SEGMENTS, 20);
const WRITES = int(process.env.LOAD_WRITES, 2000);
const READS = int(process.env.LOAD_READS, 2000);
const CONCURRENCY = int(process.env.LOAD_CONCURRENCY, 16);
const BUCKET = 'cloud-roaring-load';
const TABLE = 'cloud-roaring-load';
// A per-run id isolates each run within the shared (persistent) LocalStack bucket + table, so re-runs don't
// collide with a prior run's write-once cold generations. `Date.now()` is fine here — this is an offline bench,
// not `core/` (which is determinism-linted). Override with LOAD_RUN for a reproducible key namespace.
const RUN = String(process.env.LOAD_RUN || Date.now());

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
  for (let i = 0; i < 30; i++) {
    const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: TABLE }));
    if (Table && Table.TableStatus === 'ACTIVE') return;
    await sleep(200);
  }
}

async function retry(label, fn, okErrorNames) {
  for (let i = 0; i < 30; i++) {
    try {
      return await fn();
    } catch (err) {
      const name = (err && err.name) || '';
      if (okErrorNames.includes(name)) return;
      if (i === 29) throw new Error(`${label} failed: ${String(err)}`);
      await sleep(500); // LocalStack warmup / transient
    }
  }
}

/**
 * Tally the real S3/DynamoDB ops (+ bytes) the workload issues, so cost is grounded in measured behaviour.
 * COVERAGE CAVEAT: the metrics seam emits `warm.read`/`warm.write`/`cold.get` but has **no `cold.put` event**,
 * and the registry driver isn't wired to the sink — so the PUBLISH phase's **S3 PUTs and registry writes are
 * NOT metered**. The reported $ is therefore the **read + warm-write side** of the workload; the (few, cheap
 * relative to the headline) publish-side writes are excluded. Disclosed in the result + the docs.
 */
function makeMeter() {
  const t = {
    'warm.write': { n: 0, bytes: 0 },
    'warm.read': { n: 0, bytes: 0 },
    'cold.get': { n: 0, bytes: 0 },
  };
  return {
    tally: t,
    sink: {
      onEvent(e) {
        const slot = t[e.kind];
        if (slot) {
          slot.n += 1;
          slot.bytes += e.bytes || 0;
        }
      },
    },
  };
}

function world(meter) {
  const s3 = new S3Client({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
    // LocalStack 3.8.1's S3 doesn't fully implement the AWS SDK's default flexible checksums (CRC32 headers),
    // so the SDK's response validation trips on it. Ask for checksums only when required — a LocalStack-compat
    // knob for this harness, NOT needed against real S3 or MinIO (the integration lane), which support them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const dynamo = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
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
  const store = new CloudRoaring({ warm, cold, registry, metrics: meter.sink });
  return { s3, dynamo, cold, warm, registry, store };
}

const seg = (i) => `load-${i}`;

async function main() {
  const meter = makeMeter();
  const w = world(meter);
  await ensureBackend(w.s3, w.dynamo);

  // PHASE 1 — WRITE: add() one id per op, spread across segments (one OCC read-modify-write on a Warm row each).
  const write = await drive(
    WRITES,
    (i) => w.store.segment(seg(i % SEGMENTS)).add(1000 + i),
    CONCURRENCY,
  );

  // PHASE 2 — PUBLISH: bulk-load an immutable .crbm generation per segment to S3 (Topology-A ingest → cold PUT).
  const publish = await drive(
    SEGMENTS,
    (i) => {
      const base = i * 100_000;
      const ids = Array.from({ length: 500 }, (_, k) => base + k * 7);
      return bulkLoadCrbmGeneration(w.cold, { segment: seg(i), generation: 0 }, ids, {
        registry: w.registry,
      });
    },
    Math.min(CONCURRENCY, SEGMENTS),
  );

  // PHASE 3 — READ: count() tier-merges S3 cold ∪ DynamoDb warm (cold GET(s) + warm read per segment).
  const read = await drive(READS, (i) => w.store.segment(seg(i % SEGMENTS)).count(), CONCURRENCY);

  const pricing = AWS_US_EAST_1_ONDEMAND;
  const out = {
    note: 'Generated by `pnpm load` against LocalStack. Latency/throughput are endpoint-dependent; $ is a projection at published AWS prices applied to MEASURED op counts (LocalStack itself has no bill). Not a CI gate.',
    endpoint: ENDPOINT,
    config: { segments: SEGMENTS, writes: WRITES, reads: READS, concurrency: CONCURRENCY },
    write: stats(write.latencies, write.wallMs),
    publish: stats(publish.latencies, publish.wallMs),
    read: stats(read.latencies, read.wallMs),
    measuredOps: meter.tally,
    cost: {
      pricing: pricing.name,
      covers:
        'read + warm-write side only; PUBLISH S3 PUTs + registry writes are not metered (no cold.put metric event). ALSO NOTE the counts are IMetricsSink events = LOGICAL chunk reads, not billed HTTP requests: the .crbm reader answers most getChunk() calls from its cached index or as an absent chunk without any request, so cold.get OVER-counts S3 GETs by ~90x here (1901 events carrying ~1016 bytes total). Wire-metered figures come from `pnpm calibrate:aws`;',
      workloadUSD: round(costOf(meter.tally, pricing).totalUSD, 6),
      breakdownUSD: (() => {
        const c = costOf(meter.tally, pricing);
        return {
          s3Get: round(c.s3GetUSD, 6),
          dynamoRead: round(c.dynamoReadUSD, 6),
          dynamoWrite: round(c.dynamoWriteUSD, 6),
        };
      })(),
      redisAlwaysOnMonthlyUSD: pricing.redis.monthlyUSD,
    },
  };

  console.log(
    `Load vs LocalStack (${ENDPOINT}) — ${SEGMENTS} segments, concurrency ${CONCURRENCY}`,
  );
  const line = (label, s) =>
    console.log(
      `  ${label}: ${s.ops} ops @ ${s.opsPerSec}/s; p50 ${pct(s.p50)} · p99 ${pct(s.p99)} · p999 ${pct(s.p999)} · max ${pct(s.max)}`,
    );
  line('WRITE (add→DynamoDB OCC)  ', out.write);
  line('PUBLISH (bulk-load→S3 PUT)', out.publish);
  line('READ  (count→S3∪DynamoDB) ', out.read);
  console.log(
    `  measured ops: warm.write=${meter.tally['warm.write'].n} warm.read=${meter.tally['warm.read'].n} cold.get=${meter.tally['cold.get'].n}`,
  );
  console.log(
    `  cost of this workload @ ${pricing.name}: $${out.cost.workloadUSD} (S3 GET $${out.cost.breakdownUSD.s3Get} · Dynamo R $${out.cost.breakdownUSD.dynamoRead} · Dynamo W $${out.cost.breakdownUSD.dynamoWrite}); Redis always-on baseline $${pricing.redis.monthlyUSD}/mo`,
  );
  console.log(
    '  (cost = read + warm-write side; PUBLISH S3 PUTs + registry writes are not metered)',
  );

  if (process.env.LOAD_INJECT === '1') {
    fs.writeFileSync(
      path.join(ROOT, 'bench/load-localstack-results.json'),
      JSON.stringify(out, null, 2) + '\n',
    );
    console.log('  wrote bench/load-localstack-results.json');
  } else {
    console.log('  (dry run — set LOAD_INJECT=1 to persist bench/load-localstack-results.json)');
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
