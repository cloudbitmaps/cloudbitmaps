# Getting started

> **Status: `0.7.0` — pre-1.0.** Everything below is real and tested: it is what the engine actually
> exposes, covered by the test suite. The API may still change before `1.0`. Today the **in-memory** and
> **local-filesystem** tiers exist alongside **cold** object storage on **S3-compatible**, **GCS**, and
> **Azure Blob** (with
> chunk-skipping intersection), a **warm tier** on **DynamoDB**, **PostgreSQL**, **Redis**, **MongoDB**,
> **Cassandra/ScyllaDB**, and **MySQL/MariaDB**, the **segment registry**, **automatic retry/backoff**, a **crash-safe streaming
> compaction daemon**, and **encryption-at-rest + crypto-shred** — i.e. all of Phase 4 (Topology-B) plus the
> Phase 7 driver set; the full v1 experience is sketched in
> the usage walkthrough.

> **One package to install: `@cloudbitmaps/roaring`.** Every import below is the real specifier. It is the
> *roaring flavor* of the `@cloudbitmaps` family — the roaring codec +
> the `CloudRoaring` facade — and it depends on **`@cloudbitmaps/core`**, the codec-agnostic engine that holds
> every storage driver. Core arrives **transitively**: you never install or name it (each
> `@cloudbitmaps/roaring/<backend>` subpath re-exports core's driver of the same name, so
> `@cloudbitmaps/core/s3` is equivalent if you prefer it).

> **Every export at a glance:** for the complete list of everything you can import and call (across
> `@cloudbitmaps/roaring` and its `/s3`, `/gcs`, `/azure`, `/dynamodb`, `/postgres`, `/redis`, `/mongodb`,
> `/cassandra`, `/mysql` subpaths), see the **[API Reference](api-reference.md)** — it's
> kept in sync with the code by CI. This guide is the narrated walkthrough of that same surface.

## What works today

| Capability | Status |
|---|---|
| `add` / `addMany` / `remove` / `removeMany` / `has` / `count` / `iterate` | ✅ |
| **`intersect()` / `intersectInto()`** — chunk-skipping set intersection | ✅ |
| Tombstone-correct deletes, merged over an immutable Cold tier | ✅ |
| In-memory drivers (zero setup) | ✅ |
| Persistent **local filesystem** drivers (survive restart) | ✅ |
| **S3-compatible** cold storage — AWS S3 / MinIO (`@cloudbitmaps/roaring/s3`) | ✅ |
| **GCS + Azure Blob** cold storage (`@cloudbitmaps/roaring/gcs`, `@cloudbitmaps/roaring/azure`) — write-once immutable generations | ✅ |
| `.crbm` archive read/write + a bounded HOT cache | ✅ |
| **Bulk-load** a Cold generation from a large id stream (`bulkLoadCrbmGeneration`) | ✅ |
| **DynamoDB warm tier** (`@cloudbitmaps/roaring/dynamodb`) — real cross-process OCC | ✅ |
| **PostgreSQL warm tier** (`@cloudbitmaps/roaring/postgres`) — real cross-process SQL OCC; "use the Postgres you already run" (peer `pg` + `@types/pg` for TS; run `postgresWarmTableDDL()` once at deploy) | ✅ |
| **Redis warm tier** (`@cloudbitmaps/roaring/redis`) — sub-ms writes; OCC via an atomic Lua compare-and-set (peer `ioredis`) | ✅ |
| **MongoDB / DocumentDB warm tier** (`@cloudbitmaps/roaring/mongodb`) — per-document OCC; `ensureMongoWarmIndexes()` at deploy (peer `mongodb`) | ✅ |
| **Cassandra / ScyllaDB warm tier** (`@cloudbitmaps/roaring/cassandra`) — OCC via a lightweight transaction; `cassandraWarmTableDDL()` at deploy (peer `cassandra-driver`) | ✅ |
| **MySQL / MariaDB warm tier** (`@cloudbitmaps/roaring/mysql`) — plain-SQL OCC (`INSERT` + token-fenced `UPDATE`/`DELETE`); `mysqlWarmTableDDL()` at deploy (peer `mysql2`) | ✅ |
| **Automatic retry + backoff** for transient faults (on by default) | ✅ |
| **Segment registry** (memory / LocalFs / DynamoDB / **S3** — run read-mostly on S3 alone) — registry-resolved generation, no per-read scan | ✅ |
| **Crash-safe compaction daemon** (`compact-segments`) — 2-phase commit, version-fenced | ✅ |
| **Encryption-at-rest** (AES-256-GCM, BYOK keystore) **+ crypto-shred** (`destroySegment`/`eraseNamespace`) | ✅ |
| **Observability** — optional metrics sink (`IMetricsSink`): cold/warm/cache/retry/intersect/op/compaction events | ✅ |
| **Audit trail** — optional audit sink (`IAuditSink`): publish/compact/erase compliance events | ✅ |
| **Cost estimator** — `CloudRoaring.estimateCost()` (planning) + grounded `segment.costReport()` | ✅ |
| **Benchmark-as-test** — cost/perf claims are CI-gated; published [crossover chart](../benchmarks.md) | ✅ |
| **Subject access & erasure** (GDPR Art. 15/17: `subjectReport` / `eraseSubject`) — explicit-scope guarded | ✅ |
| **Per-op request budget** — denial-of-wallet ceiling on `count`/`iterate`/`intersect`/subject scans (on by default) | ✅ |
| **Cross-tier consistency check** (`checkConsistency()`) — [torn-restore](disaster-recovery.md) detection | ✅ |

### Choosing a registry

> **Only four backends ship a registry** — `MemoryRegistryDriver`, `LocalFsRegistryDriver`, `S3RegistryDriver`
> (`@cloudbitmaps/roaring/s3`), and `DynamoDbRegistryDriver` (`@cloudbitmaps/roaring/dynamodb`). The seven
> Phase-7 backends (`postgres` / `redis` / `mongodb` / `cassandra` / `mysql` warm; `gcs` / `azure` cold) are **tier-only — none
> ships a registry.** That matters because the crash-safe **compaction daemon** ([§8](#8-compaction-keeping-the-warm-tier-small))
> needs a registry for its atomic `LATEST`-pointer swap + per-segment lease. So a deployment that compacts (i.e.
> runs Topology-B) **must pair its tier with an S3 or DynamoDB registry** — e.g. an all-Redis or all-GCS
> deployment can't self-host compaction; it takes on a cross-cloud dependency (an S3/DynamoDB registry) that you
> must plan for. A **read-mostly** deployment that never compacts can run on **S3 alone** (§7). Full registry
> details are in [§7](#7-the-segment-registry-resolving-the-current-generation).

## 1. The simplest thing: in-memory

A `CloudRoaring` store is wired to a **warm** driver (live mutations) and a **cold** source (the immutable
archive) — **those two are the only required options**; a `registry`, encryption, and cache/retry tuning are
all optional and introduced as we go. A `segment` is one named bitmap. The in-memory drivers need no setup —
ideal for tests and a first look:

```ts
import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({
  warm: new MemoryWarmDriver(),
  cold: new MemoryColdChunkSource(),
});

const vips = store.segment('high-value-shoppers');

await vips.add(1_234_567_890);
await vips.addMany([5, 99_999, 2_000_000_000]); // grouped by chunk → one write per chunk
await vips.has(1_234_567_890); // → true

await vips.remove(1_234_567_890); // single-chunk tombstone — no scan, no rebuild
await vips.has(1_234_567_890); // → false, immediately

await vips.count(); // exact cardinality
for await (const id of vips.iterate()) {
  // ascending ids
}
```

IDs are integers in `[0, 2³²)`. Each is split into a 16-bit chunk key + a 16-bit remainder; `addMany`
groups by chunk first, so 10,000 ids spanning 12 chunks become **12 writes, not 10,000**.

`addMany`/`removeMany` accept a **sync or async iterable**, so a database cursor streams straight in:

```ts
async function* activeUsers() {
  for await (const page of athena.paginate(query)) for (const row of page) yield row.user_id;
}
await store.segment('active').addMany(activeUsers()); // no hand-batching page → addMany(page)
```

Streaming is an **input-shape** choice, never a cost choice. Ids are grouped by chunk and each chunk is written
**exactly once** however long the stream — pending ids are held compressed rather than buffered-and-flushed, so
a stream costs no more backend writes than the equivalent array. (Measured: 5M pending ids occupy ~11 MB as
bitmaps against ~212 MB held as plain numbers, which is what makes writing-once affordable.)

> **Batch whenever you have more than one id — it is the difference between cents and dollars.** A chunk covers
> 65,536 ids, and `addMany` issues one read-modify-write **per distinct chunk**, however many of that chunk's ids
> you set. `add()` is handed a single id, so it must do one read-modify-write every time. Writing ten million ids
> costs **~$7.50–$52** through `add()` in a loop (the $0.75/million rate is
> [measured](../benchmarks.md#real-cloud-calibration--aws) for rows ≤1 KiB; DynamoDB bills writes per 1 KiB and a
> chunk's delta grows as you fill it, so a full 8 KiB row is $5.25/million — density makes the loop *worse*)
> versus **~$0.001–$0.05** through `addMany()`, and **~$0.00001** via
> [bulk-load](#3-optional-bulk-load-a-cold-generation). Raising concurrency makes the loop *finish* sooner but
> costs exactly the same — the bill is per request, so only issuing fewer requests reduces it. And nothing fails
> if you get this wrong: every call succeeds and the answer is correct, so the mistake shows up on an invoice
> rather than in your logs. Use `add()` for a single id, `addMany()` for a batch, and bulk-load when you are
> replacing a segment rather than amending it — bulk-load rewrites the whole segment, so it cannot express "one
> more user" or a removal at all.
>
> **Streaming does not move this crossover.** Both `addMany` and bulk-load take an async iterable, so the same
> 11M-row cursor pipes into either — and the choice between them is unchanged by that. Amending a segment is
> `addMany`; *defining* one is bulk-load. Ids spread across the id space touch ~61,000 chunks, so `addMany`
> writes ~61,000 warm rows where bulk-load writes one immutable object. The convenience of streaming is exactly
> the situation in which it is easiest to reach for the wrong one.

## 2. Persistent: the local filesystem

Same API, but state lives on disk and survives a restart. Pass the **raw** `LocalFsColdDriver` as `cold` —
the store wraps it in the `.crbm` reader for you, so you wire each driver exactly once:

```ts
import { CloudRoaring, LocalFsWarmDriver, LocalFsColdDriver } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({
  warm: new LocalFsWarmDriver('./.cloudbitmaps/warm'),
  cold: new LocalFsColdDriver('./.cloudbitmaps/cold'), // raw driver → reads .crbm generations; empty until seeded
  cacheMaxChunks: 1024, // optional HOT-cache ceiling
});

const seg = store.segment('active-this-week');
await seg.add(42);
// ...a fresh process pointed at the same dirs sees 42 again — writes are durable.
```

> **The `cold` option takes either shape.** Usually you pass a **raw `IColdDriver`** (`LocalFsColdDriver`,
> `S3ColdDriver`, `MemoryColdDriver`) and the store builds the `.crbm` cold source — reading the
> `registry` / `keystore` / `requireEncryption` you pass alongside in the same config (§7 registry, §9
> encryption). Or pass an already-built **`ColdChunkSource`** — for a source-only backend (like the
> `MemoryColdChunkSource` in §1, which has no underlying driver) or a `CrbmColdChunkSource` you configured with
> advanced reader options (`tailBytes`, size caps). On that path, configure the registry/keystore **on the
> source itself** — passing them at the top level is rejected as a wiring mistake. Same config, two ways to fill
> the `cold` slot.

## 3. (Optional) bulk-load a Cold generation

> **This is an *import* path, not an initialization step.** Nothing needs seeding. A brand-new segment is usable
> the moment you construct the store: `addMany` / `has` / `remove` / `count` / `iterate` / `intersect` all work
> against a segment with no Cold generation and no registry row, because a read merges
> `(cold ∪ warm.adds) \ warm.removes` and an absent Cold tier just makes that merge trivial. Reach for bulk-load
> when you *already have* the data somewhere else — a warehouse query, a Redis migration, a nightly rebuild — and
> want it to land as a compact Cold archive instead of paying Warm write costs for the initial load.

The batch "seed/rebuild" path: build an immutable Cold archive directly from a (possibly huge, unsorted)
stream of ids with `bulkLoadCrbmGeneration`. It folds ids into per-chunk bitmaps as they stream — input is
consumed lazily and deduped, so you can pipe a query result or a file of billions of ids through it:

```ts
import {
  CloudRoaring,
  bulkLoadCrbmGeneration,
  LocalFsColdDriver,
  MemoryWarmDriver,
} from '@cloudbitmaps/roaring';

const cold = new LocalFsColdDriver('./.cloudbitmaps/cold');

// ids can be any sync or async iterable — an array, a generator, a DB cursor, a file stream…
const res = await bulkLoadCrbmGeneration(cold, { segment: 'active-this-week', generation: 1 }, [
  1, 2, 3, 1_000_000, 2_000_000_000,
]);
console.log(res); // { size, sha256, chunkCount, cardinality }

// Pass the same `cold` driver to the store — it serves that generation as the Cold base (warm deltas merge on top):
const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
await store.segment('active-this-week').count(); // → 5
```

> Pick a fresh `generation` number (on an empty segment, start at `0`); with no registry the store serves the
> **highest** generation present, and re-using an existing one throws `WriteConflictError` (write-once).
> For a generation you already hold as bitmaps, the lower-level `writeCrbmGeneration(driver, key, chunks)`
> takes `{ chunkKey, bitmap }` entries directly.

## 4. Cold on S3 (or any S3-compatible store)

The S3 cold driver lives at the **`@cloudbitmaps/roaring/s3`** subpath, so the AWS SDK is an **optional peer
dependency** — install it only when you use S3 (`npm i @aws-sdk/client-s3`); the main entry never pulls it.
You inject your own `S3Client`, so the driver works against AWS S3, MinIO, or any compatible backend just by
how you configure the client:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { CloudRoaring, MemoryWarmDriver, bulkLoadCrbmGeneration } from '@cloudbitmaps/roaring';
import { S3ColdDriver } from '@cloudbitmaps/roaring/s3';

const client = new S3Client({ region: 'us-east-1' }); // or { endpoint, forcePathStyle: true } for MinIO
const cold = new S3ColdDriver({ client, bucket: 'my-bitmaps', prefix: 'cloudroaring' });

// Seed a generation straight to S3, then query it through the engine:
await bulkLoadCrbmGeneration(cold, { segment: 'active-this-week', generation: 0 }, [1, 2, 3]);
const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold }); // raw S3 driver, wrapped for you
await store.segment('active-this-week').count(); // → 3, read from S3
```

It's the same `IColdDriver` contract as the local-filesystem driver (it passes the identical conformance
suite), so everything above — reads, `count`, `iterate`, `intersect`, generation pinning — works unchanged.
Generations are **write-once** (a conditional `If-None-Match:*` PUT; requires a backend that honors it — AWS
S3 or recent MinIO). Large objects upload via **S3 multipart automatically** (Phase 4f) — write memory stays
~one part (default 8 MiB); the object ceiling defaults to ≈80 GiB and grows via `partBytes` / `maxObjectBytes`
up to S3's 5 TiB max, with write-once preserved (conditional `CompleteMultipartUpload`).

## 5. Warm tier on DynamoDB

For a **live, durable, multi-writer** warm tier (vs the local-filesystem one), pass a `DynamoDbWarmDriver`
from the **`@cloudbitmaps/roaring/dynamodb`** subpath (`@aws-sdk/client-dynamodb` is an optional peer
dependency — `npm i @aws-sdk/client-dynamodb`). It gives **real cross-process optimistic concurrency** — concurrent
writers to the same chunk never lose updates — via DynamoDB conditional writes:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { DynamoDbWarmDriver } from '@cloudbitmaps/roaring/dynamodb';
import { S3ColdDriver } from '@cloudbitmaps/roaring/s3';
// …construct an s3 cold driver `cold` as in §4…

const warm = new DynamoDbWarmDriver({ client: new DynamoDBClient({ region: 'us-east-1' }), tableName: 'cloudbitmaps' });
const store = new CloudRoaring({ warm, cold });
await store.segment('active-this-week').add(42); // a conditional, conflict-safe write to DynamoDB
```

The table is a **single table** (`PK = ns#…|seg#…`, `SK = chunk#…`) you provision once with a `(PK, SK)`
string key schema. An optional `keyPrefix` lets several logical stores share one table. (DynamoDB-Local
works for development — just point the client's `endpoint` at it.)

## Production wiring for the cloud drivers

§4–§5 wired S3 and DynamoDB. The seven **Phase-7** backends follow the same shape — construct your own client,
hand it to the driver, run the one-time schema step — but each carries a production footgun worth pinning up
front. All seven are **tier-only** (no registry): a deployment that compacts must pair one with an S3 or
DynamoDB registry (see [Choosing a registry](#choosing-a-registry)). Pair each `warm` driver below with a
`cold` source (§1–§4) and a `registry` (§7); the cold drivers pair with a `warm` tier.

### Redis warm (`@cloudbitmaps/roaring/redis`)

```ts
import Redis from 'ioredis';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { RedisWarmDriver } from '@cloudbitmaps/roaring/redis';
// …construct a cold source `cold` (§4) + a registry `registry` (§7)…

const client = new Redis(process.env.REDIS_URL); // ioredis; OCC via an atomic Lua compare-and-set
const warm = new RedisWarmDriver({ client });
const store = new CloudRoaring({ warm, cold, registry });
```

> ⚠️ **Footgun — eviction + persistence (the sharpest in the driver set).** Redis MUST run with
> `maxmemory-policy noeviction` **and** AOF enabled (`appendonly yes`). The default `allkeys-lru` **silently
> evicts** chunk hashes and their index entries *independently* → dropped/ghosted chunks → **wrong membership
> answers, with no error raised**. Without AOF, a restart loses every un-compacted delta — and Redis is the one
> warm backend that may hold the **only** durable copy of recent writes until compaction flushes them to cold.
> (peer `ioredis`.)

### PostgreSQL warm (`@cloudbitmaps/roaring/postgres`)

```ts
import { Pool } from 'pg';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { PostgresWarmDriver, postgresWarmTableDDL } from '@cloudbitmaps/roaring/postgres';

const pool = new Pool({ connectionString: process.env.PG_URL });
await pool.query(postgresWarmTableDDL()); // run once at deploy — idempotent CREATE TABLE
const warm = new PostgresWarmDriver({ pool });
const store = new CloudRoaring({ warm, cold, registry });
```

> **Checklist.** Run `postgresWarmTableDDL()` once at deploy; peer `pg` (+ `@types/pg` for TS). Postgres'
> default collation is byte-exact, so keys match case-sensitively — if you ever pin a database collation, make
> it a **deterministic/binary** one (a non-deterministic ICU collation could collapse case-differing segment
> names).

### MySQL / MariaDB warm (`@cloudbitmaps/roaring/mysql`)

```ts
import { createPool } from 'mysql2/promise';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { MysqlWarmDriver, mysqlWarmTableDDL } from '@cloudbitmaps/roaring/mysql';

const pool = createPool(process.env.MYSQL_URL);
await pool.query(mysqlWarmTableDDL()); // run once at deploy — pins utf8mb4_bin + ROW_FORMAT=DYNAMIC
const warm = new MysqlWarmDriver({ pool });
const store = new CloudRoaring({ warm, cold, registry });
```

> **Checklist.** Run `mysqlWarmTableDDL()` once at deploy (peer `mysql2`); it pins `utf8mb4_bin` collation —
> MySQL's default `utf8mb4_0900_ai_ci` is **case-insensitive**, a correctness hole for case-differing segment
> names — and requires `ROW_FORMAT=DYNAMIC` (the MySQL 5.7+/8.0 default) so the composite primary key fits
> InnoDB's 3072-byte limit.

### MongoDB / DocumentDB warm (`@cloudbitmaps/roaring/mongodb`)

```ts
import { MongoClient } from 'mongodb';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { MongoWarmDriver, ensureMongoWarmIndexes } from '@cloudbitmaps/roaring/mongodb';

const db = (await MongoClient.connect(process.env.MONGO_URL)).db('cloudroaring');
await ensureMongoWarmIndexes(db); // run once at deploy — builds the listChunks index
const warm = new MongoWarmDriver({ db });
const store = new CloudRoaring({ warm, cold, registry });
```

> **Checklist.** Run `ensureMongoWarmIndexes(db)` at deploy (peer `mongodb`); the warm collection MUST use the
> **simple (binary) default collation** — a case-insensitive default collation can collapse case-differing
> segments on `_id` uniqueness (the driver pins `{ locale: 'simple' }` on its own read/update/delete/list ops,
> but the `_id`-index uniqueness follows the **collection** default). Point the `Db` at a **primary** read
> preference so OCC reads are strong.

### Cassandra / ScyllaDB warm (`@cloudbitmaps/roaring/cassandra`)

```ts
import { Client } from 'cassandra-driver';
import { CloudRoaring } from '@cloudbitmaps/roaring';
import { CassandraWarmDriver, cassandraWarmTableDDL } from '@cloudbitmaps/roaring/cassandra';

const client = new Client({ contactPoints: ['db'], localDataCenter: 'dc1', keyspace: 'cloudroaring' });
await client.connect();
await client.execute(cassandraWarmTableDDL('cloudroaring')); // run once at deploy — you own keyspace + RF
const warm = new CassandraWarmDriver({ client, keyspace: 'cloudroaring' });
const store = new CloudRoaring({ warm, cold, registry }); // retry is ON by default — keep it (see below)
```

> **Checklist.** Create the keyspace (you choose the replication factor) and run
> `cassandraWarmTableDDL(keyspace)` at deploy (peer `cassandra-driver`). OCC uses lightweight transactions
> (LWT): reads run at `LOCAL_SERIAL`, writes default to `SERIAL` / `LOCAL_QUORUM`. **Keep automatic retry
> enabled** (don't pass `retry: false`) — the store wraps `warm` in `RetryingWarmDriver` for you, and the raw
> Cassandra driver throws transient `WriteTimeout` under Paxos contention that the retry layer rides out; this
> matters more here than for the other four warm drivers. Each segment is a single partition → watch for hot
> partitions.

### GCS cold (`@cloudbitmaps/roaring/gcs`)

```ts
import { Storage } from '@google-cloud/storage';
import { CloudRoaring, MemoryWarmDriver } from '@cloudbitmaps/roaring';
import { GcsColdDriver } from '@cloudbitmaps/roaring/gcs';

const storage = new Storage(); // ADC; or { apiEndpoint } to point at fake-gcs-server locally
const cold = new GcsColdDriver({ storage, bucket: 'my-bitmaps', prefix: 'cloudroaring' });
const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold }); // pair a warm tier + registry per §5/§7
```

> **Checklist.** Peer `@google-cloud/storage`; generations are write-once via `ifGenerationMatch: 0` (both the
> simple and resumable upload paths). GCS ships **no registry** — pair with an S3 or DynamoDB registry to run
> compaction (see [Choosing a registry](#choosing-a-registry)).

### Azure Blob cold (`@cloudbitmaps/roaring/azure`)

```ts
import { BlobServiceClient } from '@azure/storage-blob';
import { CloudRoaring, MemoryWarmDriver } from '@cloudbitmaps/roaring';
import { AzureBlobColdDriver } from '@cloudbitmaps/roaring/azure';

const containerClient = BlobServiceClient.fromConnectionString(process.env.AZURE_CONN)
  .getContainerClient('bitmaps');
const cold = new AzureBlobColdDriver({ containerClient, prefix: 'cloudroaring' });
const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold }); // pair a warm tier + registry per §5/§7
```

> **Checklist.** Peer `@azure/storage-blob`; inject a container-scoped `ContainerClient`; generations are
> write-once via `If-None-Match: '*'`. Azure ships **no registry** — pair with an S3 or DynamoDB registry to run
> compaction.

Per-backend DR/backup guidance (RPO/RTO, point-in-time recovery, what to snapshot) lives in the
[disaster-recovery runbook](disaster-recovery.md).

> **Read cost knob — `warmReadConsistency`.** Reads (`has`/`count`/`iterate`/`intersect`) are strongly
> consistent by default (read-your-writes). For a read-heavy, staleness-tolerant workload, set
> `new CloudRoaring({ warm, cold, warmReadConsistency: 'eventual' })` — warm reads then bill **~½ the DynamoDB
> RCU** (a strong read costs 2× an eventual one), at the price of read-after-write. The compaction/OCC **write**
> path stays strongly consistent regardless, so correctness is unaffected; the in-memory/LocalFs drivers ignore
> it (always strong). **Write throughput knob — `writeConcurrency`** (default **4**): the distinct chunks of a
> wide `addMany`/`removeMany` are flushed in parallel, each being its own conflict-safe row. Set it to `1` for
> strictly serial writes, or higher if your backend is provisioned for the fan-out — 4 is chosen to stay well
> inside what the transient-retry path absorbs when a provisioned-capacity backend throttles the burst.

## 6. Reliability: retries, backoff & timeouts

Cloud storage throttles, returns 5xx, and drops connections. CloudBitmaps handles that for you: **every
warm/cold call automatically retries transient faults** (throttling, 5xx, dropped connections, request
timeouts) with bounded exponential backoff + full jitter. It's **on by default** — you don't have to do
anything:

```ts
const store = new CloudRoaring({ warm, cold }); // retries already enabled
```

Tune it, or turn it off, per store:

```ts
const store = new CloudRoaring({
  warm,
  cold,
  // Tune the policy (these are the defaults):
  retry: { maxAttempts: 4, baseDelayMs: 50, maxDelayMs: 2_000, backoffFactor: 2, jitter: 'full' },
  // …or `retry: false` to disable our wrappers entirely (e.g. your client already retries).
  onRetry: ({ attempt, delayMs, err }) => log.warn({ attempt, delayMs }, 'retrying transient fault'),
});
```

**What's retried vs not.** Only **transient** infrastructure faults are retried — surfaced as
`TransientError` (with `TimeoutError` a subclass). Deterministic errors are **never** retried (retrying them
can't help or would be wrong): `ValidationError` (bad input), `IntegrityError` (corrupt bytes),
`NotFoundError`, and `WriteConflictError` (an optimistic-concurrency conflict, which the engine resolves with
its own re-read-and-retry loop).

**Set a timeout on your client.** CloudBitmaps intentionally has no homegrown timeout (it would abandon
in-flight requests). Instead, give your injected S3/DynamoDB client a request timeout — the resulting timeout
is treated as transient and retried:

```ts
import { NodeHttpHandler } from '@smithy/node-http-handler';
const client = new DynamoDBClient({
  region: 'us-east-1',
  requestHandler: new NodeHttpHandler({ requestTimeout: 3_000, connectionTimeout: 1_000 }),
});
```

**Your data is safe across a retry.** A write that times out *after* it committed is detected on retry (the
OCC token has advanced → a clean `WriteConflictError`, never a double-apply); cold generations are write-once
(no half-written object a reader could pick up); and all bytes are checksum-verified before use. So a
transient outage costs you latency, not correctness.

> Writing your own driver? Throw `TransientError` for your backend's retryable faults and the shared retry
> layer handles the rest — or wrap any driver yourself with `RetryingWarmDriver` / `RetryingColdChunkSource`
> / `RetryingColdDriver`. The low-level `withRetry(op, policy, { clock, rng })` primitive is exported too.

## 7. The segment registry (resolving the current generation)

Each segment's Cold tier is a series of immutable, generation-numbered `.crbm` objects; reads need to know
**which generation is current**. Without a registry, the store finds it by *listing* every generation and
taking the max — one storage scan per segment. The **registry** replaces that with a single authoritative
record (`currentGen`) you read once:

```ts
import {
  CloudRoaring,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  LocalFsColdDriver,
  LocalFsRegistryDriver,
} from '@cloudbitmaps/roaring';

const cold = new LocalFsColdDriver('./.cloudbitmaps/cold');
const registry = new LocalFsRegistryDriver('./.cloudbitmaps/registry');

// Seed a generation AND publish it to the registry in one call:
await bulkLoadCrbmGeneration(cold, { segment: 'active', generation: 0 }, [1, 2, 3], { registry });

// Pass the raw driver + registry — the store resolves currentGen via the registry (no list-scan):
const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, registry });
await store.segment('active').count(); // → 3, generation resolved from the registry
```

The `registry` is **optional**: omit it and the store falls back to the list-scan (so the in-memory and
simple local setups keep working with no registry). **With a registry, a long-running store picks up a
newly-compacted generation automatically**: it re-resolves the current generation on a short TTL
(`coldGenTtlMs`, default **2000 ms**), so reads are **bounded eventually-consistent** — after a background
compaction commits a new generation, a reader may see the prior one for up to the TTL, then converges (tune it
down for fresher reads, up to trade a little staleness for fewer registry reads). Without a registry the
generation is pinned for the source's lifetime (single-process/local use — no separate daemon to cause drift).
For production, use the **DynamoDB** registry (co-located with your warm rows in the same table):

```ts
import { DynamoDbRegistryDriver } from '@cloudbitmaps/roaring/dynamodb';
const registry = new DynamoDbRegistryDriver({ client: dynamo, tableName: 'cloudbitmaps' });
```

**Registry backends** — `registry` is a pluggable seam (`IRegistryDriver`), independent of your warm/cold
choice; pick per deployment:

| Backend | Import | Use for |
| --- | --- | --- |
| `MemoryRegistryDriver` | `@cloudbitmaps/roaring` | tests / dev |
| `LocalFsRegistryDriver` | `@cloudbitmaps/roaring` | single node / on-prem |
| `DynamoDbRegistryDriver` | `@cloudbitmaps/roaring/dynamodb` | write-heavy (co-locate with warm in one table) |
| `S3RegistryDriver` | `@cloudbitmaps/roaring/s3` | **read-mostly on S3 alone — no DynamoDB** |

The **`S3RegistryDriver`** keeps the current-generation pointer as a tiny object in the *same bucket* as your
Cold data, using S3's conditional writes (`If-Match`) for the atomic generation swap — so a read-mostly
deployment runs on **S3 only**:

```ts
import { S3ColdDriver, S3RegistryDriver } from '@cloudbitmaps/roaring/s3';

const cold = new S3ColdDriver({ client: s3, bucket: 'my-bitmaps' });
const registry = new S3RegistryDriver({ client: s3, bucket: 'my-bitmaps' }); // same bucket, no DynamoDB
const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, registry });
```

> **S3 registry requirements:** the bucket backend must honor `If-Match` conditional writes (AWS S3; recent
> MinIO), the IAM principal needs **`s3:ListBucket`** (else a missing key returns `403` not `404`, and
> discovery can't list), and **don't put a lifecycle-expiration rule on the `registry/` prefix** (erase
> tombstones must persist for the pointer's ABA-safety). DynamoDB is the better fit when writes are frequent
> (single-digit-ms swaps vs an S3 GET+PUT). **Infra scales with the workload** — read-mostly needs only S3.

> **One lifecycle rule you should add:** **`AbortIncompleteMultipartUpload`**, on the bucket holding cold
> objects (a few days is plenty). A large generation is written as a multipart upload; the library aborts it on
> any error it survives to handle, but it cannot abort one whose process no longer exists — a killed container
> or an OOM leaves the parts behind. Those parts are **billed and invisible**: they never appear in an object
> listing, so nothing but the bill will tell you. This is the one case where cost can accumulate quietly, which
> matters more here than it would elsewhere, because a low idle bill is the point of the library.

The record also reserves `status`, `dirtyChunkCount` (compaction discovery), and a wrapped-DEK `keyId` slot
(encryption) — populated by the compaction daemon and crypto-shred in later phases. To publish a generation
you wrote yourself, call `publishGeneration(registry, { segment, generation })` (forward-only — it never
regresses the pointer).

## 8. Compaction: keeping the warm tier small

Every `add`/`remove` lands in a **warm** delta row. **Compaction** folds those deltas into a fresh immutable
**cold** generation and clears the warm rows. It's a separate background process (it never slows your app path),
and it's **crash-safe**: a 2-phase commit means a write that lands mid-compaction is never lost, and a crash at
any step recovers cleanly on the next run.

### Do you actually need it?

**Not for correctness — never.** A read always merges `(cold ∪ warm.adds) \ warm.removes`, so a segment that has
never been compacted answers `has` / `count` / `iterate` / `intersect` exactly as correctly as one that has. If
you skip compaction forever, your answers stay right.

Nor does read cost grow with the number of writes, which an earlier version of this section got wrong. There is
**one delta row per 65,536-id chunk**, not one per write: 20 rounds of 1,000 `addMany` ids leaves **one** row, and
`has()` reads one row per chunk however many rounds produced it. What grows is that row's *size*, not the count.

What compaction actually buys you:

| | Why |
|---|---|
| **Storage price** | Warm is DynamoDB/Redis-priced; Cold is S3-priced — 10–100× cheaper per byte. A long-lived segment wants its steady state in Cold. |
| **Smaller rewrites** | Once the bulk is in Cold, the Warm row holds only the recent delta, so each write re-serializes a small blob instead of a large one. This compounds: see the write-shape table in [Coming from Redis bitmaps?](#coming-from-redis-bitmaps) |
| **Free `count()`** | A compacted segment with no Warm deltas counts straight from the `.crbm` index — **zero payload reads**. A warm-only segment must fetch and merge every chunk. |

So: **skip it** for a write-once dated bucket that you retire with `dropSegment` (a dedup wave, a daily sent-list)
— that data never reaches a steady state worth moving. **Run it** for a long-lived, continuously-updated segment,
which is where all three columns above start to matter.

If you call `store.compact()` in-process rather than running the daemon, note that it also collects the generation
it supersedes — see the caveat at the end of this section.

The simplest way is the bundled CLI over the local filesystem:

```bash
# one cycle and exit (Lambda / cron):
CR_COMPACT_ROOT=./.cloudroaring CR_COMPACT_MODE=once npx compact-segments
# run forever, a cycle every 30s (K8s Deployment / ECS service):
CR_COMPACT_ROOT=./.cloudroaring CR_COMPACT_MODE=loop CR_COMPACT_INTERVAL_MS=30000 npx compact-segments
# scale out — worker 0 of 4, each owning a disjoint shard, ≤50 segments per cycle:
CR_COMPACT_ROOT=./.cloudroaring CR_COMPACT_SHARD=0 CR_COMPACT_TOTAL_SHARDS=4 CR_COMPACT_MAX_SEGMENTS=50 CR_COMPACT_MODE=loop npx compact-segments
```

For a cloud deployment you wire your own tiny handler (so the daemon uses *your* S3/DynamoDB clients) — the
two deploy modes are just "call once" vs "call on an interval":

```ts
import { runCompactionCycle, CountingMetricsSink } from '@cloudbitmaps/roaring';
import { S3ColdDriver } from '@cloudbitmaps/roaring/s3';
import { DynamoDbWarmDriver, DynamoDbRegistryDriver } from '@cloudbitmaps/roaring/dynamodb';

const metrics = new CountingMetricsSink(); // or your own IMetricsSink → CloudWatch / StatsD
const deps = {
  cold: new S3ColdDriver({ client: s3, bucket: 'my-bitmaps' }),
  warm: new DynamoDbWarmDriver({ client: dynamo, tableName: 'cloudbitmaps' }),
  registry: new DynamoDbRegistryDriver({ client: dynamo, tableName: 'cloudbitmaps' }),
  clock: { now: () => Date.now() },
  metrics, // ← wire a sink to receive the per-attempt `compaction` metric (gap #2)
};

// Lambda handler (once) — or wrap in setInterval for a long-running daemon:
export const handler = async (_event: unknown, context: { awsRequestId: string }) => {
  const cycle = await runCompactionCycle(deps, { owner: `lambda:${context.awsRequestId}`, keep: 1 });
  // cycle = { candidates, compacted, deferred, results }; metrics.snapshot().compaction has the counters.
  return { ...cycle, compaction: metrics.snapshot().compaction };
};
```

It discovers segments that have accumulated enough warm deltas, compacts each under a per-segment **lease**
(so multiple workers don't duplicate work), and garbage-collects superseded cold generations (keeping a small
grace window for in-flight readers). To compact a single segment directly, call
`compactSegment(ref, deps, { owner })`.

> ### ⚠️ Who collects the old generations
>
> Cold objects are immutable and generation-keyed, so **every compaction leaves its predecessor on disk.**
> Something has to delete them, and which "something" depends on how you compact:
>
> | You call | Old generations collected? |
> |---|---|
> | `runCompactionCycle` (the daemon / CLI above) | **Yes** — it calls `gcOrphanGenerations` each cycle |
> | `store.compact(ref, { owner })` (in-process facade) | **Yes**, best-effort after a successful commit, with the same `keep: 1` grace window |
> | `compactSegment(ref, deps, { owner })` (free function) | **No.** It is a single-responsibility primitive — call `gcOrphanGenerations(ref, { cold, registry }, { keep })` yourself |
>
> `store.compact` did **not** collect them in `0.7.0` and earlier, so a deployment that compacted in-process without
> running the daemon accumulated `.crbm` objects indefinitely. Reads stayed correct the whole time — `currentGen`
> always pointed at a live object — so the only symptom was a storage bill that never went down. If that describes
> your deployment, one `gcOrphanGenerations` pass per segment reclaims the backlog.

**Running a fleet of workers.** To scale past one worker, run N daemons and give each a disjoint **shard**: set
`CR_COMPACT_TOTAL_SHARDS=N` and worker _i_ `CR_COMPACT_SHARD=i` (or pass `shard`/`totalShards` to
`runCompactionCycle`). Segments are partitioned by a stable hash of their name — the shards are disjoint and
together cover the whole fleet, so no two workers ever drain or compact the same segment and no coordination is
needed. (Each worker still enumerates the registry to find its shard, so the segment-**listing** cost stays
proportional to the whole fleet per worker; sharding divides the expensive Warm drain and the compaction work,
not the initial listing. An indexed enumeration that would divide the listing too is on the roadmap.)
`CR_COMPACT_MAX_SEGMENTS` (`maxSegments`) caps the **compaction** work per cycle: the most-backed-up segments
(most dirty chunks first, oldest-compacted as the tiebreak) are compacted and the rest deferred to the next
cycle, so a burst on a few segments can't starve the tail. `runCompactionCycle` returns
`{ candidates, compacted, deferred, results }` for logging or alarming on a cycle's own throughput.

**Staying healthy.** A segment whose compaction keeps failing (say, one corrupt warm row) is **quarantined**
after a few consecutive failures and skipped until a cooldown passes, then retried once — one poison segment
can't wedge the worker or burn money on endless retries, and a success clears the streak. If you wire an
`IMetricsSink` into your deps (as the handler above does), every attempt emits a `compaction` metric (committed /
no-op / error, dirty-chunk count, rows purged, ms); either way, every commit stamps `lastCompactedAt` on the
registry record and each cycle logs its `{ candidates, compacted, deferred }` summary — a **dead-man's-switch**
to alarm on ("nothing compacted in the last hour" ⇒ the daemon is stuck or not running).

> **Picking up a new generation:** with a `registry` wired (see above), a `CrbmColdChunkSource` re-resolves the
> current generation on a short TTL (`coldGenTtlMs`, default 2000 ms) and keys its HOT cache by generation, so a
> long-running reader converges to a freshly-compacted generation within the TTL — no restart needed. Without a
> registry it pins its generation for the source's lifetime (single-process/local use). (If GC sweeps the exact
> generation a reader pinned while it's mid-read, the source detects it and re-resolves to the current generation
> rather than failing — so compaction's cleanup never breaks an in-flight query.)

## 9. Encryption at rest + crypto-shred

Encrypt the Cold `.crbm` objects so a leaked bucket reveals **neither ids nor cardinality** (payloads *and* the
chunk index are encrypted; the object's segment name + generation are still visible in its key, and its byte
size still implies a rough upper bound on size — no padding), and support **crypto-shred** — GDPR "right to
erasure" that works even on immutable/backed-up storage. Encryption is **opt-in**: pass a *keystore* and it's
on; omit it and everything stays cleartext (today's behaviour).

You hold one root key — a **KEK** (32 bytes) — and bring it yourself (BYOK); there's **no required cloud
dependency**. Each segment gets its own random **DEK** that's wrapped under your KEK and stored in the registry;
the Cold chunks + index are AES-256-GCM-encrypted with the DEK.

```ts
import { CloudRoaring, InProcessKeystore, bulkLoadCrbmGeneration } from '@cloudbitmaps/roaring';
import { LocalFsColdDriver, LocalFsWarmDriver, LocalFsRegistryDriver } from '@cloudbitmaps/roaring';

// Your KEK(s) — load from your secrets manager; keyId-aware so you can rotate without re-encrypting data.
const keystore = new InProcessKeystore({
  keys: { '2026-06': loadKekFromSecrets() }, // each value is a 32-byte Uint8Array
  activeKeyId: '2026-06',
  // recoveryKeyId: 'offline-escrow',         // optional: also wrap under an offline recovery KEK
});

const cold = new LocalFsColdDriver('./.cloudroaring');
const registry = new LocalFsRegistryDriver('./.cloudroaring');

// Seed encrypted (the DEK is minted + wrapped into the registry on first write):
await bulkLoadCrbmGeneration(cold, { segment: 'pii', generation: 0 }, ids, { registry, keystore });

// Read encrypted — pass the raw driver + registry + keystore; the store unwraps the DEK and decrypts transparently:
const store = new CloudRoaring({
  warm: new LocalFsWarmDriver('./.cloudroaring'),
  cold,
  registry,
  keystore,
});
await store.segment('pii').count(); // works; without the keystore this throws KeyUnavailableError
```

Pass the **same `keystore`** to your compaction deps (`runCompactionCycle`/`compactSegment`) so compaction can
reuse the segment's DEK. To enforce encryption everywhere, set `requireEncryption: true` (on the store config,
on `bulkLoadCrbmGeneration`, and on the compaction deps) — any cleartext write/read then throws.

### Crypto-shred (erase a segment / namespace)

```ts
import { destroySegment, eraseNamespace } from '@cloudbitmaps/roaring';

// Irreversible — you must name the exact segment as confirmation:
await destroySegment({ segment: 'pii' }, { registry, warm }, { confirmSegment: 'pii' });
// or a whole namespace:
await eraseNamespace('tenant-42', { registry, warm }, { confirmNamespace: 'tenant-42' });
```

This deletes the segment's wrapped DEK from the registry (a `destroyed` audit tombstone) and clears its Warm
rows. The encrypted Cold objects are left in place — but with the key gone they're **permanently unreadable,
everywhere, including backups**. The segment then reads as empty.

### ⚠️ Read this before you turn on encryption — key management

- **The KEK is the one thing to back up.** It's 32 bytes — store it in your secrets manager (Vault, AWS Secrets
  Manager, 1Password, an HSM) with versioning, exactly like a database password. The encrypted data and the
  wrapped DEKs are useless without it.
- **If you lose every KEK for a segment, its at-rest bytes are gone — by design.** There is no backdoor (that's
  the whole point — a leaked bucket has no backdoor either). This is also what makes crypto-shred *work*.
- **But it's usually not catastrophic:** CloudBitmaps segments are almost always **derived data** (audience /
  membership sets built from your primary datastore), so a lost KEK means **re-seed the segment from source**
  (`bulkLoadCrbmGeneration`), not permanent business-data loss.
- **Rotate, don't lose.** Add a new KEK, point `activeKeyId` at it, and **keep the old KEK** — old segments keep
  decrypting with no data re-encryption. Use a **recovery KEK** (kept offline) so losing the active one isn't
  fatal.
- **KMS/Vault later.** The default is dependency-free in-process BYOK; the `IKeystore` interface lets a
  KMS/Vault adapter drop in later (a future phase) — encryption never forces a cloud dependency on you.

## 10. Observability: metrics

CloudBitmaps can report what it's doing — cold GETs and bytes, warm reads/writes, cache hit rate, retries,
intersection efficiency, and op latency — through an optional **metrics sink**. It's **off by default** (a
no-op — emission is skipped entirely when unused); pass one and the library pushes typed events to it:

```ts
import { CloudRoaring, CountingMetricsSink } from '@cloudbitmaps/roaring';

const metrics = new CountingMetricsSink(); // a ready-made tally sink
const store = new CloudRoaring({ warm, cold, metrics });

await store.segment('users').has(42);
console.log(metrics.snapshot());
// { cold: { gets, bytes, totalMs }, warm: {…}, cache: { hits, misses }, retries: {…}, intersect: {…}, ops: {…} }
```

The library emits **vendor-neutral events** (`cold.get`, `cache`, `warm.read`, `warm.write`, `retry`,
`intersect`, `op`) so it isn't coupled to any telemetry system — you map the handful you care about. A quick
look in dev is one line:

```ts
const store = new CloudRoaring({ warm, cold, metrics: { onEvent: (e) => console.log(e) } });
```

**OpenTelemetry** (or Datadog, CloudWatch, …) is a ~12-line adapter you write — CloudBitmaps adds no telemetry
dependency of its own:

```ts
import { metrics as otel } from '@opentelemetry/api';
const meter = otel.getMeter('cloud-roaring');
const coldBytes = meter.createCounter('cloudroaring.cold.bytes');
const cacheHits = meter.createCounter('cloudroaring.cache.hits');

const store = new CloudRoaring({
  warm,
  cold,
  metrics: {
    onEvent(e) {
      if (e.kind === 'cold.get') coldBytes.add(e.bytes); // NB: see the label caveat below
      if (e.kind === 'cache' && e.hit) cacheHits.add(1);
      // …map the events you want to chart
    },
  },
});
```

Events carry **raw observations** (bytes, counts, ms); turning those into dollars is the cost estimator's job
(shipped in Phase 5b — see [§11 below](#11-cost-estimate-it-then-ground-it) and the usage guide §12). Two things to keep in mind:

- **`onEvent` runs synchronously on the I/O path** — keep it cheap and non-blocking; offload batching or
  network calls to your own async queue.
- **`segment` / `namespace` are your own strings** — they may be PII and are unbounded-cardinality. Don't map
  them to per-series metric labels/tags unless your names are known low-cardinality and PII-free (aggregate,
  bucket, or scrub inside the sink instead). Events never contain bitmap contents or ids — only names, counts,
  bytes, and timings.

A sink that throws can never break a read or write — its exceptions are swallowed (best-effort).

## 11. Cost: estimate it, then ground it

CloudBitmaps can tell you what a workload *will* cost — and, uniquely, what your **real** segments *are*
costing — because the library owns the storage + cache, so it can ground estimates no external calculator can.

**Planning** (pure, no instance needed — sizing, sales, what-if):

```ts
import { CloudRoaring } from '@cloudbitmaps/roaring';

const report = CloudRoaring.estimateCost({
  segments: [{ sizeBytes: 1.2e9 }], // or { cardinality } / { count }
  workload: { readsPerSec: 200, writesPerSec: 5, cacheHitRate: 0.8 },
  topology: 'B',
});
report.monthlyUSD.total; // ≈ 92 — ~$66 writes + ~$26 reads + a few cents storage, vs $346 flat Redis
report.verdict; // 'win' — 'win-big' | 'win' | 'lose-zone', never hides the lose case
report.redisCrossover; // { writesPerSec: ~26, readsPerSec: ~2633 } — at THIS report's 80% cache-hit rate
```

**Grounded** (real sizes from the `.crbm` index — exact, no payload reads):

```ts
const report = await store.segment('active-us').costReport({
  workload: { readsPerSec: 200, cacheHitRate: 0.8 },
});
report.assumptions.grounded; // true — storage is this segment's real, measured size
```

Rates are a pluggable `PricingProfile` (default `aws-us-east-1-ondemand`, from the fact-checked research);
override it for your region/cloud, or model a **provisioned** Warm tier (`wruPerMillion: 0`) to watch the write
crossover disappear. The report is honest: `verdict` always includes the lose-zone, and `assumptions.notes`
lists the model's simplifications (S3→same-region egress free; request cost from your supplied workload rates —
deriving it from live metrics is a later refinement).

### Past the write crossover

`redisCrossover.writesPerSec` is where the metered bill overtakes a flat node. It is not a ceiling on the
library — it is a property of **four inputs**, three of which default to their worst plausible value so the
published figure cannot flatter us, and two of which remove the crossover entirely:

| Input | Default | Change it and |
| --- | --- | --- |
| `avgItemKiB` | `8` | DynamoDB bills writes per KiB **rounded up**, so an 8 KiB chunk is 8 write units, not 1. Narrower delta rows move the crossover by the same factor. |
| `cacheHitRate` | `0` | Every read is billed. A working hot cache moves the *read* crossover by the reciprocal of the miss rate. |
| `pricing.warm.wruPerMillion` | on-demand | Set it to `0` and you have modelled a **provisioned or flat** Warm tier. `writesPerSec` returns `Infinity` — there is no per-request meter left to cross. |
| `topology` | `'B'` | `'A'` takes writes by bulk-load, so it carries **no per-op write charge at all**. `writesPerSec` returns `Infinity`. |

A flat Warm tier can be one of our own drivers — Redis, Postgres, MySQL, or anything else with cheap small
writes on an instance you already run. Note that Redis is a **Warm** driver: it holds recent chunk deltas while
the corpus stays in Cold object storage, so the node is sized for your write rate rather than for your whole
history. You keep tiering and chunk-skipping and stop paying per request; what you give up is the one property
a flat tier cannot have, which is costing nothing while idle.

Watch also for the `batchable-writes` advisory — it fires when the modelled write count far exceeds the number
of distinct Warm rows the data can occupy, which means the same row is being rewritten repeatedly and
`addMany()` would collapse it.

> **Model compaction — the usually-dominant cost.** Compaction re-reads a segment's whole Cold generation each
> cycle, so it often dwarfs live traffic. Set `workload.compactionsPerMonth` to fold it in (with
> `chunksPerCompaction`, default = the modeled cold set's chunk count, and an optional `dirtyChunksPerCompaction`
> for the Warm-purge term); it shows up as `monthlyUSD.byOp.compaction`. Left unset it stays `0`, but the report
> **discloses** the omission in `assumptions.notes` rather than quietly under-counting.

### `advisories` — is this cheaper than it needs to be?

`verdict` only ever compares you to the flat Redis baseline. That leaves a blind spot: a workload can beat Redis
by 40× and still be paying ~100× more than **this same library** would charge for the same outcome — and the
verdict calls that `win-big` and says nothing. `report.advisories` closes it.

```ts
const report = CloudRoaring.estimateCost({
  segments: [{ cardinality: 10_000_000 }],
  workload: { writesPerSec: 4 }, // ~10M writes/month, one id at a time
  topology: 'B',
});

report.verdict; // 'win' — still far under the $346 flat baseline
for (const a of report.advisories) {
  console.warn(a.code, a.message); // 'batchable-writes' — each Warm row rewritten ~150x
  a.currentUSD; // what the write term costs as modeled
  a.batchedFloorUSD; // the floor if those ids were batched one-write-per-chunk
}
```

- **`advisories` is always an array** — empty in the normal case, so you can iterate unconditionally.
- **Branch on `code`, not the message.** `'batchable-writes'` is the stable identity; the message carries the
  numbers that triggered it and is safe to log verbatim.
- **`batchedFloorUSD` is a floor, not a promise.** It assumes perfect batching into one write per chunk. Real
  batching lands somewhere between it and `currentUSD`, depending on how your ids actually arrive — which the
  estimator can't know.
- **It never changes the dollar figures**, only comments on them.
- **A hit is a prompt to check, not an accusation.** If those ids genuinely arrive one at a time — real-time
  qualification — then `add()` is the correct path and that is simply what it costs. The advisory fires on the
  *shape*; only you know the arrival pattern. See
  [picking the write path](../../README.md#picking-the-write-path).

**See it plotted.** The [benchmarks page](../benchmarks.md) charts exactly where pay-per-use beats a flat
Redis-HA node — drawn from this same `estimateCost()` and turned into build-breaking CI assertions, so the
numbers can never drift ahead of reality.

## 12. Audit trail: security & compliance events

Separate from metrics — which reports *volume* (bytes, latency, hit rate) — the **audit sink** records the
handful of **compliance-relevant state changes** an auditor cares about: when a segment's data was published,
compacted, or **erased**. It's the natural feed for an append-only audit log / SIEM, and doubles as your
GDPR Art. 30 "record of processing" for the erasure path. Like metrics, it's an injected `IAuditSink`, it's
**off by default** (a no-op), and a throwing sink can never break the operation it observes.

Unlike metrics, audit isn't a store-constructor option — the events fire from the **lifecycle operations**
(compaction, bulk-load, erasure), which are separate entry points, so you pass `audit` to each:

```ts
import { RecordingAuditSink, bulkLoadCrbmGeneration, destroySegment } from '@cloudbitmaps/roaring';

const audit = new RecordingAuditSink(); // a ready-made in-memory recorder (or bring your own onEvent)

// A generation is published (the segment is encrypted — a keystore is wired, see §9):
await bulkLoadCrbmGeneration(cold, { segment: 'users', generation: 0 }, ids, { registry, keystore, audit });
// A GDPR erasure (crypto-shred — the key wrappings are dropped):
await destroySegment({ segment: 'users' }, deps, { confirmSegment: 'users', audit });

audit.snapshot();
// [ { kind: 'segment.publish', segment: 'users', generation: 0 },
//   { kind: 'segment.erase',   segment: 'users' } ]
// (segment.erase fires only for an ENCRYPTED segment — a cleartext tombstone leaves the bytes readable.)
```

The events are **vendor-neutral** — four kinds, all carrying the segment/namespace name:

| Event | Fired when | Extra fields |
| --- | --- | --- |
| `segment.publish` | a bulk-load makes a generation the current one (needs a `registry`; not on a forward-only no-op) | `generation` |
| `segment.compact` | compaction **commits** a new generation (at the commit, before the Warm purge) | `generation` |
| `segment.erase` | a **genuine crypto-shred** — not the idempotent re-run, and not a cleartext tombstone (bytes stay readable) | — |
| `namespace.erase` | `eraseNamespace` runs; also one `segment.erase` per segment actually shredded | `segmentsShredded` |

Same two caveats as metrics apply: **`onEvent` runs synchronously** on the operation (keep it cheap; offload
network writes to your own queue), and **`segment`/`namespace` are your own strings** — treat them as
potentially-PII when you forward them. Events never contain ids or bitmap contents.

> **Not yet emitted — KEK rotation.** Rotating the key-encryption key here is *operator-side keystore
> reconfiguration* (wrappings are key-id-tagged and need no data re-encryption), so there's no library call to
> hook a `kek.rotate` event onto. Audit key changes at your keystore/KMS layer; a future per-segment
> `rewrapSegment()` op would add a library-side rotation event.

For a worked example that routes metrics, cost, and audit to real dashboards, see the
[dashboards guide](./dashboards.md).

## 13. Subject access & erasure (GDPR Art. 15 / 17)

Two admin helpers answer "what do you hold about this person?" and "forget this person everywhere." Both scan
the **registered** segments (no reverse index — nothing taxes the hot path), so they're complete over what's
registered and cost `O(registered segments)` per call. The scan fans out at a **bounded `concurrency`** (default
8; pass `{ concurrency }`) — parallel enough to stay quick over a large fleet, bounded so it can't stampede your
backend; `eraseSubject` isolates a per-segment fault so one bad segment never aborts the ledger.

**Scope is explicit.** Ids live in one **global u32 space shared across namespaces**, so a namespace-less call is
a *fleet-wide* sweep over every tenant. To keep that from being the accidental default, both helpers require
either a `namespace` (scope to one tenant) **or** an explicit `{ allNamespaces: true }` acknowledgement — a call
with neither throws `ValidationError`.

```ts
// Art. 15 — which segments is this id in? (scope to one tenant)
const report = await store.subjectReport(userId, { namespace: 'eu' });
report.segments; // [{ segment, namespace }, …]

// Art. 17 — remove the id everywhere, across all tenants (explicit fleet-wide ack)
const ledger = await store.eraseSubject(userId, { allNamespaces: true, owner: 'privacy-worker' });
ledger.erasedFrom; // [{ segment, namespace, removed: true, physicallyPurged: true, toGen }, …]
```

Both helpers **reuse the store's own drivers** — no `registry`/deps to re-pass. `eraseSubject` needs the store
built with a raw cold driver + a `registry` (it force-compacts); `subjectReport` needs only a `registry` (it just
enumerates + `has()`). A store missing what a helper needs throws `UnsupportedError` — a pre-built-`ColdChunkSource`
store can't run `eraseSubject` (use the `compactSegment` free function out-of-process). `eraseSubject` writes a
logical `remove` **and force-compacts** each affected segment on the spot, so the bit is physically gone from Cold
on return — even for an idle/archival segment the daemon would never revisit. The returned `erasedFrom` list is
your **erasure ledger** (proof of deletion) — a return value only, so persist it or route it to your audit sink.
One caveat: don't concurrently re-add the id while erasing it. A `physicallyPurged: false` entry means the
logical removal held but the physical purge didn't run this call — a live daemon lease (`note: 'leased-by-other'`,
the daemon finishes it) or an isolated fault (`note: 'error: …'`, per-segment faults are caught so one segment
can't discard the whole ledger); **recover it with `store.compact(ref)`** (re-running `eraseSubject` won't — a
written tombstone makes `has()` read false, so the segment is skipped). For whole-segment / whole-tenant erasure,
use crypto-shred (`destroySegment` / `eraseNamespace`, §9) — the only erasure that survives immutable backups.
See [`PRIVACY.md`](../../PRIVACY.md).

> **Compact on demand.** `await store.compact({ segment, namespace }, { owner: 'worker' })` folds a segment's
> Warm deltas into a fresh Cold generation in-process (same drivers, same `UnsupportedError` requirement) — a
> one-shot alternative to running the `compact-segments` daemon for occasional/manual compaction.

## 13.5 Retention, TTL and pruning — what exists and what doesn't

**There is no TTL.** No per-id expiry, no `expireAfter`, no "auto-prune" flag. An id you `add` stays until
something removes it, and a segment grows until you prune it. This is a design consequence, not a missing
feature — see below — but it is the first thing to know, and it means **retention is something you schedule,
not something you configure.**

> ⚠️ **Never enable your backend's native row expiry on the Warm table.** DynamoDB TTL, Redis `EXPIRE`,
> a MongoDB TTL index, a Postgres cleanup job — any of them will **silently lose writes.**
>
> Warm rows are **un-compacted deltas**: the `adds` and `removes` that have not yet been folded into a Cold
> generation. Compaction is what durably applies them, and it purges them itself, version-fenced. If the
> backend deletes a Warm row first, those adds and removes are simply gone — and the next read returns the
> Cold generation *without* them. **No error is raised**; the answer is just quietly wrong.
>
> "The Warm table is growing, I'll put a TTL on it" is a reasonable instinct and a data-loss bug. The correct
> answer to a growing Warm table is **run compaction more often** — that is precisely what it is for.

### Why there is no per-id TTL

A bitmap stores **ids, not `(id, timestamp)` pairs.** Expiring individual ids means keeping a timestamp
per id — 4–8 bytes each — which destroys the compression the whole design exists for. A contiguous range of a
million ids is a few bytes as a Roaring run; the same million with per-id timestamps is megabytes, and worse
than a plain list. So per-id aging isn't deferred work, it's incompatible with the data model.

### The pattern that gives you the same outcome

Put time in the **name** instead of in the data, and let set algebra do the window. Use a **namespace per
family and the date as the segment** — not one long name:

```ts
const bucket = (day: string) => store.segment(day, { namespace: 'active-daily' });

// Write into a bucket per day.
await bucket(today).addMany(idsSeenToday);

// "Active in the last 7 days" — a union over the buckets you still keep.
const [head, ...rest] = last7Days.map(bucket);
for await (const id of head.union(rest)) { /* … */ }

// Retention = dropping whole buckets, not aging bits.
```

> **Names are validated: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/`, for both the segment and the namespace.** So
> the tempting `active:2026-08-01` is **rejected** — no colons. Beyond legality, the namespace split is the
> better shape anyway: `registry.list('active-daily')` enumerates exactly that family's buckets, which is the
> list a retention sweep wants, and `eraseNamespace` can retire the whole family at once. One flat
> `active-2026-08-01` is legal too, but then finding "every daily bucket" means string-matching names.

`union` reads every chunk of every operand — it can't skip, and the guide says so in
[the operations table](#the-operations). If a 7-way union per read is too much, materialize the window — but
**materialize it into a fresh dated target, not a reused one**:

```ts
// Right: today's window is its own segment, and yesterday's is dropped when it ages out.
const window = store.segment(`w-${today}`, { namespace: 'active-7d' });
await days[0].unionInto(window, days.slice(1));
```

> ⚠️ **`unionInto` is purely additive — it never clears the destination.** Re-using one rolling `active-7d`
> segment day after day therefore *accumulates*: union `{07-01, 07-02}` then `{07-02, 07-03}` into the same
> target and you get `{07-01, 07-02, 07-03}`. The set grows monotonically and **silently stops being a 7-day
> window**, with no error. An earlier revision of this guide recommended exactly that; it was wrong.

**The best case for this pattern is a dedup or "already sent" window, where the bucket key _is_ the
semantics.** Suppose you send a daily wave and a user must not be sent to twice in the same local day. Then the
key is the window:

```ts
// The bucket IS the re-eligibility rule. `sent-daily` groups the family; the date names the bucket.
const sent = store.segment(localDay, { namespace: 'sent-daily' });
if (await sent.has(userId)) return; // already sent today
await sent.add(userId);
```

There is **no per-user expiry bookkeeping at all** — no timers, no sweep, no 9-million-entry TTL table. A user
becomes re-eligible the instant the wave moves to tomorrow's key, because tomorrow's segment is a different,
empty set. A tighter guard (a nightly wave needing ~10 minutes of protection) is still satisfied by a day-scoped
bucket, so the coarser key is usually the right one.

Reach for a genuine rolling window — *"sent in the last 4 hours"*, exactly — only when the approximation
actually matters. Then it is `remove`/`removeMany` aging individual ids out on a sweep, which is a real
tombstone write per id and costs accordingly. Dated buckets are cheaper, simpler and sufficient for anything
whose window is naturally a calendar boundary.

### Pruning a segment today — and the honest limits

**`store.dropSegment` is the one you want for a rolling window.** Three levers exist, and they answer
different questions:

| | what it does | when |
|---|---|---|
| **`store.dropSegment(ref, { confirmSegment })`** | tombstones the segment, deletes its **Warm** rows, deletes its Cold generations (re-swept, with any residual reported in `generationsRemaining`). Works on a cleartext segment; on an encrypted one it *also* discards the DEK, so it is a strict superset there. Afterwards the segment **reads as empty** — see the caveat below | **retiring a bucket and reclaiming the storage** |
| `destroySegment(ref, { registry, warm }, { confirmSegment })` | **crypto-shred**: discards the DEK so the Cold bytes are unreadable *everywhere including backups and WORM* — but leaves the objects in your bucket, still billed. **Requires encryption** (no key, nothing to shred) | erasure that must reach immutable copies |
| `gcOrphanGenerations(ref, { cold, registry }, { keep })` | deletes only **superseded** generations, keeping `keep` as a reader grace window | reclaiming compaction garbage, not live data |

Deleting an object does not reach a noncurrent version, a cross-region replica, or a PITR snapshot; discarding
the key does. So if your requirement is *"the data must become unreadable"* rather than *"stop paying for it"*,
encryption at rest (§9) is a prerequisite — and `dropSegment` on an encrypted segment gives you both at once.

### Retiring a bucket

`store.dropSegment` needs the store built with a **raw cold driver + a registry** (it has to enumerate and
delete generations, which a pre-built `ColdChunkSource` cannot do) — the same requirement as `compact` and
`eraseSubject` in §13. Without it you get an `UnsupportedError`.

```ts
// The namespace is part of the identity. Omit it and you address a DIFFERENT segment, and the call is a
// silent no-op returning { dropped: false, reason: 'absent' } — no throw. Check `reason` in a sweep.
const ref = { namespace: 'active-daily', segment: oldDay };

// Look before you leap — reports the generations it WOULD delete, changes nothing.
const preview = await store.dropSegment(ref, { confirmSegment: ref.segment, dryRun: true });
// `wouldDelete` is unbounded — it lists every generation still in Cold, and a segment compacted repeatedly
// without the daemon's generation GC accumulates them. Log the count and a sample, not the whole array.
const gens = preview.wouldDelete ?? [];
console.log(`would delete ${gens.length} generation(s): ${gens.slice(0, 10).join(', ')}${gens.length > 10 ? ' …' : ''}`);

// Then do it.
const result = await store.dropSegment(ref, { confirmSegment: ref.segment });
// → { dropped: true, warmRowsDeleted: 140, generationsDeleted: [0, 1],
//      generationsRemaining: [], cryptoShredded: false }
```

Then the whole retention job is a loop, and the dangerous part is inside the library:

```ts
for await (const rec of registry.list('active-daily')) {
  if (rec.segment >= cutoffDay) continue;              // ISO dates sort lexicographically
  const ref = { namespace: rec.namespace, segment: rec.segment };
  const res = await store.dropSegment(ref, { confirmSegment: ref.segment });
  // Non-empty means bytes survived — a compaction already in flight staged one more object after the
  // tombstone. The segment reads as empty either way, so this is a billing leak, not a correctness one;
  // re-run to collect it (a running compaction daemon also will).
  if (res.generationsRemaining.length > 0) {
    console.warn(`${ref.segment}: ${res.generationsRemaining.length} generation(s) not reclaimed`);
  }
}
```

**`confirmSegment` is a typo guard, not an authorization.** In the loop above the same value appears twice, so
it protects nothing — that is what `dryRun` is for. Run the sweep with `dryRun: true` first and log what it
would take; a retention bug you can read in a log is worth more than one you find in a bucket.

### Why the order inside it matters, and why you should not hand-roll it

`dropSegment` does Warm → registry → Cold, and each position is load-bearing:

1. **Warm first.** A tombstoned segment reads Cold as empty, but Warm is consulted *separately and earlier*, so
   a tombstone with live Warm deltas would still answer `true` for ids in those deltas.
2. **Registry second.** After the tombstone nothing resolves a generation, so no reader can reach for bytes
   about to disappear.
3. **Cold last, best-effort, and swept more than once.** Once the pointer is a tombstone the segment reads as
   empty and is *correct*, so a failure part-way through leaks **bytes, not correctness** — and re-running
   collects the remainder. The sweep repeats because a compaction that was already in flight when the tombstone
   landed still finishes *staging* a generation, built from data it read beforehand: its commit fails on the
   voided lease, but the object survives and holds the full effective set. **Check `generationsRemaining`** —
   non-empty means bytes are still there and the drop should be repeated. A running compaction daemon also
   collects them, since `gcOrphanGenerations` takes every generation of a tombstoned segment.

Two limits worth knowing before you automate it:

- **Writes must have stopped.** Nothing prevents a Warm write *after* step 1. The drop makes a second Warm pass
  after the tombstone, which converges for anything in flight — but a writer that keeps writing keeps
  resurrecting the segment, and compaction will not reap those rows (it refuses a destroyed segment).
- **"Reads as empty" needs a clock.** The `coldGenTtlMs` bound below applies to a reader whose cold source has a
  clock, a registry, *and* a positive TTL. Built without a clock, or with `coldGenTtlMs: 0` ("pin forever"), a
  reader holds its snapshot for its own lifetime and can answer `true` for a dropped segment indefinitely.

> ⚠️ **The tempting shortcut breaks reads: an object-store lifecycle rule alone.** It deletes the bytes while
> the registry still points at them, which is exactly the state
> [`checkConsistency()`](disaster-recovery.md) reports as **`missing-cold-generation`** — the torn-restore
> failure the DR guide says not to serve traffic on.
>
> **And it presents intermittently.** A read checks the hot LRU before Cold, so cached chunks answer correctly
> while uncached or evicted ones raise `NotFoundError`. It passes a warm-process test and starts failing after a
> restart or a deploy, looking like a transient cloud fault rather than a misconfiguration.
>
> A lifecycle rule is still a fine **backstop** for orphans left by a failed `dropSegment` — just set its
> expiry window comfortably longer than your retention window, so it can never get there first.

A first-class **segment-level retention** feature — a `retentionDays` the compaction daemon enforces — is
[on the roadmap](../ROADMAP.md#planned--exploring) and not built. If you need it, saying so on an issue is what
moves it.

## 14. Export / eject your data

Your data isn't locked in. `store.exportSegments(sink, options)` dumps **every registered segment's current effective
set** (tier-merged) through an injected sink, using only public read APIs — so it's readable **without
CloudBitmaps**. Two formats:

- `roaring` (default) — one **portable RoaringBitmap32** per segment (`<segment>.roaring`), loadable by any
  roaring library (Java/Go/Python/Rust/C++/…).
- `ndjson` — newline-delimited ids per segment (`<segment>.ndjson`), zero dependencies to read, streamed.

The `export-segments` CLI wraps it with a filesystem sink (each file written to a unique `.part` temp then
atomically renamed; artifacts are owner-only `0o600`) and writes a self-describing `manifest.json` **last** (also
atomically) — so a directory with a `manifest.json` means the run **finished** (a crash leaves none → just
re-run). It exits non-zero if any segment couldn't be read (see _fault isolation_ below):

```bash
CR_EXPORT_ROOT=./.cloudroaring CR_EXPORT_OUT=./dump npx export-segments
# → dump/manifest.json + dump/<namespace|_default>/<segment>.roaring   (CR_EXPORT_FORMAT=ndjson for .ndjson)
# CR_EXPORT_NAMESPACE=eu             scope the dump to one namespace
# CR_EXPORT_SEGMENTS=live,eu/vips    also export all-warm segments not yet in the registry (see below)
```

In-process (any store with a registry), with your own sink (an fs writer, an S3 upload, stdout, a test buffer):

```ts
import type { ExportSink } from '@cloudbitmaps/roaring';
const mySink: ExportSink = /* your sink: open(ref, ext) → { write, close, abort? } */;
const manifest = await store.exportSegments(mySink, {
  format: 'roaring', // or 'ndjson'
  candidates: [{ segment: 'live' }], // optional: include all-warm segments not yet in the registry
});
// manifest: { version, format, totalSegments, totalIds,
//             segments: [{ segment, namespace?, count, bytes }],
//             failed:   [{ segment, namespace?, error }] }   // segments that couldn't be read (see below)
// (the CLI's manifest.json also carries a `generatedAt` timestamp.)
```

Reading a `.roaring` file back needs **no CloudBitmaps** — any roaring library deserializes the portable format:

```ts
import { readFileSync } from 'node:fs';
import roaring from 'roaring';
const { RoaringBitmap32, DeserializationFormat } = roaring;
const ids = RoaringBitmap32.deserialize(readFileSync('dump/_default/vips.roaring'), DeserializationFormat.portable).toArray();
```

Notes: `exportSegments` needs a `registry` (throws `UnsupportedError` otherwise); warm deltas are folded into the
exported set; encrypted segments are **decrypted** transparently if the store has the keystore — so the export is
**cleartext** (protect it). Crypto-shredded segments are skipped.

**Warm-only segments.** Enumeration is the registry's known set — segments with a committed cold generation. A
brand-new segment written only via real-time `add()`/`remove()` (never compacted) isn't in the registry yet, so
it's **not** exported unless you name it in `candidates` (CLI: `CR_EXPORT_SEGMENTS`) or compact/bulk-load it once
first. (This mirrors the compaction daemon's discovery contract.)

**Fault isolation.** A segment that can't be read — a corrupt cold object, or an encrypted segment when the store
has no keystore (the CLI wires none, so it can't decrypt those) — is recorded in the manifest's `failed[]` and the
export **continues**; one bad segment never blocks the rest, and its partial output is discarded. So "a
`manifest.json` exists" means the run _finished_, not that every segment succeeded — always check `failed` (the CLI
also exits non-zero when it's non-empty).

Re-running overwrites the segments it re-exports but does **not** prune files for segments that have since
disappeared — export to a **fresh directory** for a clean dump. For a *current* dump, run against a freshly-built
store (a store's cold source pins each segment's generation for its lifetime — the CLI builds a fresh store per
run); for a *consistent* dump across segments, quiesce writes or export from a read-only replica. This is also a
building block for a **data-portability** response. See [`PRIVACY.md`](../../PRIVACY.md) and the README's "Your
data stays yours".

## 15. Cost ceiling: the per-op fan-out budget

On a shared/serverless backend, one pathological call — an `intersect` over two enormous barely-overlapping
segments, or a fleet-wide `eraseSubject` — can quietly run up a large bill (a "denial-of-wallet"). CloudBitmaps
caps the **number of backend calls a single operation may fan out to** (Cold chunk fetches, or segments scanned)
and refuses (throws `BudgetExceededError`) rather than running away:

```ts
import { CloudRoaring, BudgetExceededError } from '@cloudbitmaps/roaring';

// on by default — generous (1,000,000 units); set your own store-wide ceiling:
const store = new CloudRoaring({ warm, cold, budget: { maxRequests: 50_000 } }); // warm/cold: your drivers, §1–§5

try {
  for await (const id of store.segment('huge').intersect([store.segment('other')])) {
    /* … */
  }
} catch (e) {
  if (e instanceof BudgetExceededError) {
    /* the op would have fanned out past the ceiling — it was refused before doing the work */
  }
}
```

The store-level `budget` guards `count` / `iterate` / `intersect` / `subjectReport` / `eraseSubject` — the
operations whose cost scales with data size. The ops that take options — `intersect`, `subjectReport`,
`eraseSubject` — also accept a **per-op override** (a partial override inherits the store ceiling; it never
resets it to the generous default):

```ts
// tighten or lift the ceiling for a specific call:
await store.subjectReport(userId, { namespace: 'eu', budget: { maxRequests: 5_000 } });
for await (const _ of store.segment('a').intersect([store.segment('b')], { budget: false })) {
  /* trusted batch job — no ceiling for this call */
}
```

The ceiling is checked **once, before fan-out**, against the already-known work size, so it adds **nothing to the
hot path** (`add` / `has` / `remove` are single-call and never budgeted). Byte volume needs no separate limit:
every chunk read is size-capped by the safe deserializer, so bounding the fan-out transitively bounds bytes too.
(`count` on the default cold source is already cheap — clean chunks are counted straight from the `.crbm` index
with zero reads — so it only approaches the ceiling on a source that can't serve cardinalities.) Leave it on;
lower it on untrusted/multi-tenant surfaces; raise it (or `budget: false`) for trusted bulk jobs.

## 16. Disaster recovery: check cross-tier consistency

CloudBitmaps spans two independent stores — the **object store** (cold `.crbm` generations) and the **registry**
(which generation is current per segment). A restore that brings them back at **different points in time** can
leave the registry pointing at a cold generation that wasn't restored (its `currentGen` names a `.crbm` that
isn't there) — a torn restore that otherwise surfaces only as a failed read, much later. `checkConsistency()`
detects it up front:

```ts
const report = await store.checkConsistency();          // scan every registered segment
// { checked: 1284, inconsistent: [], errored: [] }      // healthy

if (report.inconsistent.length > 0) {
  // [{ segment, namespace?, currentGen, issue: 'missing-cold-generation' }, …]
  // → the registry is ahead of the object store: restore the missing generations,
  //   or roll the registry back to a generation that exists.
}
if (report.errored.length > 0) {
  // [{ segment, namespace?, error }, …] — couldn't be read this pass (a partial/transient object store
  // mid-restore is exactly when this runs). Not proof of a tear: re-run once the store is fully available.
}
```

Run it **after any restore** and as a periodic health check. It needs a raw cold driver + a `registry` (same
requirement as compaction; throws `UnsupportedError` otherwise) and fans out at a bounded `concurrency` (default
8). A single unreadable segment never aborts the scan — it lands in `errored` so you still get the full picture;
and each segment is checked against its authoritative **live** pointer (a strong read), not the enumeration
snapshot, so a concurrent compaction that advanced the generation during the scan isn't misreported as a tear.
See the [disaster-recovery runbook](disaster-recovery.md) for the full restore procedure, RPO/RTO guidance, and
why the registry must be point-in-time-recoverable alongside the object store.

## The operations

| Method | Returns | Notes |
|---|---|---|
| `add(id)` / `remove(id)` | `Promise<void>` | single id; `ValidationError` if `id ∉ [0, 2³²)`. One read-modify-write per call — **never loop this over a batch** ([why](#1-the-simplest-thing-in-memory)) |
| `addMany(ids)` / `removeMany(ids)` | `Promise<void>` | `ids` is a **sync or async** iterable; grouped by chunk ⇒ **one write per chunk, not per id**, however long the stream; **not atomic across chunks** |
| `has(id)` | `Promise<boolean>` | |
| `count()` | `Promise<number>` | exact cardinality; `budget`-guarded ([§15](#15-cost-ceiling-the-per-op-fan-out-budget)) |
| `iterate()` | `AsyncIterable<number>` | ascending; `budget`-guarded |
| `intersect(others, { exclude? })` | `AsyncIterable<number>` | ascending; chunk-skipping; `concurrency` + `budget` options. `exclude` subtracts suppression segments **in the same pass** |
| `union(others, { exclude? })` | `AsyncIterable<number>` | ascending. The one composite with **no** chunk-skipping — every chunk of every operand is read |
| `andNot(excludes)` | `AsyncIterable<number>` | ascending. Reads all of `this`; each suppression list **only where it overlaps** |
| `intersectInto` / `unionInto` / `andNotInto` `(dest, …)` | `Promise<void>` | materialize the result into `dest`; **not atomic** |

**What each combine has to read** — a property of the set operation, not of the implementation:

| | chunks read | can skip? |
| --- | --- | --- |
| `intersect` | keys present in **every** operand | yes — the crown jewel |
| `andNot` (`a \ s`) | every chunk of `a`; `s` **only where it overlaps `a`** | partly |
| `union` | every chunk of **every** operand | no |

All three are charged against the same per-op budget, so a wide `union` is refused rather than quietly billed.
To suppress the result of an intersection, pass `exclude` rather than chaining — chaining materializes an
intermediate segment and reads the suppression list in full.

Failures are **typed errors** (`ValidationError`, `WriteConflictError`, `IntegrityError`, …), never thrown
strings — so callers can branch on *why* something failed.

### Coming from Redis bitmaps?

**This is a durable, cloud-native alternative to Redis bitmaps for *set-shaped* workloads** — audiences, dedup,
suppression, membership — where the sets are large, mostly idle, have to survive a restart, and are written in
**batches**. That is the job it is built for, and it does it without an always-on cluster or a VPC for your
functions.

**It is not a drop-in replacement.** Two limits, stated up front rather than discovered later: there is no
addressable-bit surface (`BITPOS`, `BITFIELD`, byte-range `BITCOUNT`, `BITOP NOT`, or reading the raw bytes), and a
per-id write loop costs roughly **3,000×** a batched one. Both are detailed below.

There is no separate "plain bitmap" flavor and there is not going to be one, because this is it — a Roaring
bitmap **is** a plain bitset wherever a plain bitset is the right answer. Each 65,536-id chunk is stored in
whichever of three encodings is smallest for that chunk, and past **4,096 ids** in a chunk (6.25% of it) the
winner is a flat bit array: the same bytes you have now, chosen per chunk instead of assumed for all of them.
Below that threshold you stop paying for the empty span.

Your operations carry over one-for-one:

| Redis | Here | Difference |
|---|---|---|
| `SETBIT key id 1` / `SETBIT key id 0` | `add(id)` / `remove(id)` | none in meaning — an id is a bit offset, both `u32` |
| `GETBIT key id` | `has(id)` | none in meaning |
| `BITCOUNT key` | `count()` | exact, and served from the index without fetching payloads |
| `BITOP AND dst a b` | `a.intersect([b])` / `a.intersectInto(dst, [b])` | streams, and skips chunks that cannot contribute |
| `BITOP OR dst a b` | `a.union([b])` / `unionInto` | none in meaning |
| `BITOP DIFF dst a b` (Redis 8.2+) | `a.andNot([b])` / `andNotInto` | none in meaning; reads `b` only where it overlaps `a` |
| `BITOP ANDOR dst x y1 y2` (Redis 8.2+) | — | no single call; it is `x ∩ (y1 ∪ y2)` — `unionInto` a temp, then `intersect` |
| `BITOP XOR` | — | no single call; compose as `(a ∪ b) \ (a ∩ b)` |
| `BITOP NOT` · `BITOP ONE` | — | no equivalent |

**And one operation Redis has that needed building: `SETBIT` returning the prior bit.** That return value is not a
convenience — it is what makes a per-recipient *"have I already sent to this user?"* claim exactly-once when two
workers race the same id. `has()` then `add()` cannot do it: both read absent, both proceed.

| Redis | Here | Difference |
|---|---|---|
| `prior = SETBIT sent:wave id 1` | `const won = await sent.claimMany(ids)` | takes a **batch** and returns the ids it won. Exactly-once per id; one write per *chunk*, not per id |

```ts
// Exactly-once send, no always-on cluster.
const sent = store.segment(day, { namespace: 'sent-daily' });
const toSend = await sent.claimMany(candidateIds); // only the ids this worker won
for (const id of toSend) enqueue(id);              // ...so no other worker will send them
```

### The one thing not to port literally: one op per user

Redis `SETBIT` flips a single bit in place. Here, a Warm row holds **one roaring bitmap per 65,536-id chunk**, and
every write re-serializes and re-writes that whole blob. So the per-id loop is the single most expensive way to
use this library. Measured, same 5,000 ids, three write shapes:

| Shape | Warm writes | Bytes written |
|---|---|---|
| `add(id)` per user, 5,000× | **5,000** | **23,762 KB** |
| `addMany(ids)` in 500-id batches | 10 | 51 KB |
| one `addMany(ids)` | **1** | **8 KB** |

Nearly **3,000× more bytes** for the loop. Batch, and you are far cheaper than Redis; port the loop literally and
you are far more expensive. `claimMany` exists in batch form for exactly this reason.

**What that costs depends on your Warm backend's pricing model** — the write and byte counts are backend-independent
(they are what any driver receives), the bill is not:

- **Per-request metered** (DynamoDB on-demand, Astra, serverless KV): a direct line item. DynamoDB charges one write
  unit per **1 KB rounded up, per item**, so the ~4.75 KB average per-id write bills 5 units each — ~25,000 for the
  loop against 8 for one call.
- **Provisioned capacity**: not extra dollars until it is. It eats capacity you already pay for, so the first
  symptom is **throttling and retry latency**, and the bill only moves when you scale up to stop it.
- **Instance-priced** (ElastiCache/Redis, RDS Postgres/MySQL, Mongo Atlas, self-hosted Cassandra): no per-op charge
  at all, so it surfaces as IOPS, CPU and latency headroom rather than an invoice line — easier to miss, not cheaper.

Rates are region-specific and the vendor's to change; [benchmarks](../benchmarks.md#write-shape--the-cost-of-one-op-per-id)
uses the repo's default `aws-us-east-1-ondemand` profile, and `estimateCost()` takes a `PricingProfile` so you can
plug in your own contract rather than trusting ours.

Volume, by contrast, works in your favour: **200,000 ids spread over a 9M-id space cost 138 Warm rows**, not
200,000 — one row per 64K of id space you actually touch.

### You do not need a seed job, and compaction is optional

Two things the rest of this guide implies but never says plainly, because it leads with the scaling story:

- **A brand-new segment is immediately usable.** Construct a store and call `addMany` — `add` / `addMany` / `has`
  / `remove` / `count` / `iterate` / `intersect` / `union` / `andNot` all work on a segment with **no Cold
  generation and no registry row at all**, because a read merges `(cold ∪ warm.adds) \ warm.removes` and an
  absent Cold tier just makes that merge trivial. [§3](#3-optional-bulk-load-a-cold-generation) is an **import**
  path for data you already have somewhere else — not an initialization step.
- **Compaction is never required for correctness.** See [§8](#8-compaction-keeping-the-warm-tier-small). For a
  write-once dated bucket — a dedup wave, a daily sent-list — you can skip it entirely and `dropSegment` the
  segment when it expires.

`BITFIELD`, `BITPOS`, and the byte-range forms of `BITCOUNT` have no equivalent either. This is a set of ids,
not an addressable bit buffer, so anything that treats the key as a positional buffer does not port — and
`BITOP NOT` in particular has nothing to complement against, because there is no bounded universe here, only
the `u32` id space.

**What does not carry over: the raw bytes.** A `.crbm` object is not a flat bit array, so anything that reads
your Redis bitmap's underlying string — a job that `GET`s the key and indexes into it, a byte-for-byte backup,
another service that already parses that layout — will not read ours. Raw bit-position **import** (the
migration direction off Redis) and export are not built; the format field that would name them exists, and
whether they get built depends on someone saying they need them. Everything reached through bitmap
*operations* transfers today; everything reached through the bytes does not.

> Redis stays first-class as a **warm tier** underneath this
> ([`@cloudbitmaps/roaring/redis`](#redis-warm-cloudbitmapsroaringredis)) — the point above is about replacing
> `SETBIT`-on-one-giant-key as your *data model*, not about replacing Redis as infrastructure.

## Intersecting segments (the crown jewel)

`intersect` streams the ids present in **every** operand, ascending — and only ever downloads the Cold chunks
whose 16-bit key appears in *all* of them, so two huge segments that barely overlap transfer almost nothing:

```ts
const shoppers = store.segment('high-value-shoppers');
const active = store.segment('active-this-week');

// stream the ids in BOTH segments
for await (const id of shoppers.intersect([active])) {
  /* … */
}

// more than two: ids in all three
for await (const id of shoppers.intersect([active, store.segment('opted-in')])) {
  /* … */
}

// or materialize the result into a new segment
await shoppers.intersectInto(store.segment('campaign-targets'), [active]);
```

It holds only a bounded window of chunks in memory at a time (tune with `{ concurrency }`), so it runs over
enormous segments in a small/serverless process. `intersect` is commutative: `a.intersect([b])` ≡
`b.intersect([a])`.

## Deploying to AWS Lambda

CloudBitmaps' crown jewel is serverless chunk-skipping intersection, so Lambda is a first-class target — with
one thing to know. The bitmap math runs on **`roaring`, a native (C++) addon**, and it ships **no prebuilt
binary for the Lambda Node runtimes on Linux** (checked: `nodejs20`/`nodejs22`, arm64). So you can't just
`npm install` on the bare runtime — the addon must be **built for the target platform** (exactly like `sharp`
or `better-sqlite3`). This is a one-time build step, not a per-invocation cost.

Pick whichever you already use:

- **`sam build --use-container`** (or `--use-container` on your framework) — builds deps inside an Amazon
  Linux image matching the runtime, so `roaring` compiles for the target. The simplest path.
- **Container image Lambda** — `FROM public.ecr.aws/lambda/nodejs:22`, add a build toolchain
  (`dnf install -y gcc-c++ make python3`), `npm ci`, deploy the image.
- **A Lambda layer** — build `node_modules` once in an Amazon Linux 2023 container and ship it as a layer,
  reused across functions.

Match the **arch** (`arm64` Graviton vs `x86_64`) and **Node version** of your function when you build. Our
CI proves this path end-to-end with a `pnpm lambda-smoke` gate (builds `roaring` in an AL2023 container and
loads the package under both ESM and CJS). *(A prebuilt, drop-in Lambda layer ships too: `pnpm build-lambda-layer`
(Phase 8) produces `dist-lambda/cloud-roaring-lambda-layer.zip`.)*

## Troubleshooting

### `Cannot find module './build/Release/roaring.node'` after a successful install

If you install with **`--ignore-scripts`** — a common hardening default in CI — the install **exits 0** and the
package is then unusable at runtime:

```
$ npm i --ignore-scripts @cloudbitmaps/roaring
$ node -e "require('@cloudbitmaps/roaring')"
Error: Cannot find module './build/Release/roaring.node'
```

**Why.** The native dependency `roaring` publishes an npm tarball containing **no** compiled binary; it ships an
`install` script that downloads the right prebuilt binary for your platform from GitHub Releases. Disable install
scripts and that download never happens, so there is nothing for the addon loader to find. npm reports success
because the *install* did succeed — only the post-install step was skipped.

**Fixes, in order of preference:**

1. **Allow the install script for that one package.** Both npm and pnpm let you narrow the exception rather than
   re-enabling scripts globally — pnpm's `onlyBuiltDependencies`, or an npm install run scoped to it.
2. **`npm rebuild roaring`** after the ignore-scripts install; it runs the skipped step.
3. **Build from source** — `npm_config_build_from_source=true npm i` with a C/C++ toolchain present. Also the
   route on **Alpine/musl**, where no prebuilt binary is published at all.

**Check it at install time, not at 3am.** Because npm's exit code cannot tell you about this, add a startup or CI
assertion that the addon actually loads — `node -e "require('@cloudbitmaps/roaring')"` — so a broken install
fails your pipeline instead of your first request.

### `DEP0169 DeprecationWarning: url.parse() behavior is not standardized`

You will see this on stderr the first time the package is loaded:

```
(node:1234) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors
  at node_modules/@mapbox/node-pre-gyp/lib/util/versioning.js:338
  at node_modules/roaring/index.js:32
```

**Nothing is wrong, and it is not CloudBitmaps code.** The chain is `@cloudbitmaps/roaring` → `roaring` (the
CRoaring binding, the only native code involved) → `@mapbox/node-pre-gyp`, which locates the prebuilt binary for
your platform. Finding it also computes the URL the binary *would* be downloaded from, using Node's legacy
`url.resolve()`; that URL is then discarded, because the binary is already installed. So the warning is emitted
for a computation whose result is never used.

Specifics, so you can decide whether to care:

- **Emitted once per process**, on **stderr**, and the process exits normally.
- **Building from source does not avoid it.** `roaring` calls node-pre-gyp's lookup first and only falls back to
  a locally-built binary if that throws `MODULE_NOT_FOUND`, so the lookup — and the warning — happens either way.
- **It is not a stale dependency.** `@mapbox/node-pre-gyp` is at its latest published version; there is no
  upgrade that removes this. The real fix is upstream in `roaring`, migrating to a resolver that reads the
  filesystem without constructing URLs. Nothing in CloudBitmaps calls `url.parse()`.
- **Security:** the inputs are `roaring`'s own `package.json` fields, not runtime or user-controlled data, and no
  network request happens at load. The vulnerability class that motivated this deprecation — trusting a host
  parsed out of untrusted input — does not apply here.

**The one case where it actually matters.** If you run Node with **`--throw-deprecation`**, warnings become
thrown errors and **your process will exit non-zero**. The import itself still succeeds — deprecation warnings
are emitted asynchronously, so the throw lands after the module has loaded — but the process dies. If you use
that flag, either drop it for the process that loads CloudBitmaps or allow this one deprecation.

**What not to do:** `--no-deprecation` silences *every* deprecation warning in your application, including ones
about your own code. Suppressing a whole diagnostic channel to hide one known-benign line is a bad trade.

### Two different limits: `budget` (cost) and `maxWarmScanBytes` (memory)

They are separate on purpose, and it is worth knowing which one you just hit.

| | `budget` | `maxWarmScanBytes` |
| --- | --- | --- |
| bounds | **cost** — backend requests a single op may fan out into | **memory** — warm-delta bytes one segment scan holds resident |
| default | generous; `budget: false` disables it | **64 MiB**, and **`budget: false` does not disable it** |
| covers | `count` · `iterate` · `intersect` · `subjectReport` · `eraseSubject` | every read op, `intersect` included |

Why not one control? Because `intersect`'s budget is `common keys × operands` — a *product* — and a single wide
operand can legitimately hold far more warm rows than that product while staying entirely within contract. A
request budget therefore cannot express a memory bound for it. And `budget: false` is a reasonable choice ("I
know my fan-out"), which must not silently also mean "unbounded RAM".

**Neither limits how many ids a segment can hold.** That is worth saying plainly, because the names invite the
opposite reading. A segment holds up to the full 32-bit id space — ~4.29 billion members — and no ceiling here
changes that.

- `maxScanSegments` counts **segments** (distinct named bitmaps in the registry), not members. 500 audience
  segments count as 500, whatever their size; you would need a quarter of a million *distinct segments* to
  reach the default.
- `maxWarmScanBytes` counts **warm bytes written since the last compaction**, not the segment's size. Measured
  on randomly distributed ids: 1M members added between compactions is ~3.6 MiB (6% of the default) and 10M is
  ~20.7 MiB (32%). Once compaction runs, warm is empty and the data lives in Cold, which this ceiling does not
  touch — a compacted segment with a billion members scans **zero** warm bytes.

So if you ever do hit `maxWarmScanBytes`, read it as **"compaction is not keeping up"** rather than "this
segment is too large". Check the daemon before raising the number.

Both refuse with `BudgetExceededError`, and both abandon the scan at the ceiling rather than completing it —
so the error reports the limit rather than an exact total, because computing the total is the cost being
refused. If you hit the memory ceiling, raise `maxWarmScanBytes`, narrow the segment, or compact it so fewer
chunks carry warm deltas; raising `budget` will not help.

## What blocks the event loop, and where to run it

Node is single-threaded, so CPU-heavy work stalls **every** other request on that instance. Most of this library
is network-bound and irrelevant here — a warm `has()` spends ~0.04% of its time on bit math — but bulk-load and
compaction are genuinely CPU-heavy. Measured on an M3 Pro:

| path | cost | longest single stall | where it belongs |
| --- | --- | --- | --- |
| `bulkLoadCrbmGeneration` (1M ids) | ~256 ms | **~19 ms** | a batch job or worker; survivable off the request path |
| a compaction cycle | ~22 ms of bit math | ~19 ms | the `compact-segments` **daemon**, a separate process for exactly this reason |
| `add` / `remove` / `has` / `count` / `intersect` | microseconds of CPU; dominated by network | — | anywhere |

The **stall** column is the number that decides whether co-resident work survives, and it is not the same as
cost. Bulk-load yields the event loop periodically, so its ~256 ms is spent in ~19 ms slices with the loop free
in between — other requests interleave rather than queueing behind the whole load. Before that fix the two
columns were the same number: a 1M-id load blocked the loop for **450 ms straight**, long enough for a health
check to time out and the instance to be pulled from its load balancer.

Yielding is on by default for `@cloudbitmaps/roaring` users; there is nothing to configure. It needs a `Clock`,
which the flavor package pre-binds. If you call `@cloudbitmaps/core` directly, pass one (`clock`) or the load
runs uninterrupted as it did before.

**The rule is unchanged:** anything that touches a whole generation belongs out of the request path. Yielding
makes a load a well-behaved neighbour, not a cheap one — it still burns a core for a quarter-second and holds
the whole generation in memory. Use a job runner, a queue consumer, or a short-lived task, and run the
compaction daemon as the separate process it is meant to be.

## Where next

- [Roadmap](../ROADMAP.md) — what's shipped, the **validated envelope** (what's proven and what isn't), the
  path to `1.0`, and what we've deliberately said no to.
- Usage walkthrough — the full end-to-end user journey.
- Writing your own storage driver? A shared **conformance suite** (`packages/roaring/src/testing/conformance.ts`) is the bar
  every driver must pass. It remains an internal SDK helper (consumed in-repo via the `@/` alias) — it is not
  exported as a public `./testing` package subpath.
