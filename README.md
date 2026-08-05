# CloudBitmaps

[![npm](https://img.shields.io/npm/v/@cloudbitmaps/roaring?logo=npm&label=%40cloudbitmaps%2Froaring)](https://www.npmjs.com/package/@cloudbitmaps/roaring)
[![CI](https://github.com/cloudbitmaps/cloudbitmaps/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudbitmaps/cloudbitmaps/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/@cloudbitmaps/roaring)](https://nodejs.org)

<!-- The npm + Node badges read the registry, so they stay "not found" until the launch publish (Stage 5 of) — expected, not broken. The CI badge needs the repo public to render for
     anonymous readers; both it and the npm link carry the repo/package home, so they are on the launch
     runbook's URL-rewrite list. -->

> Take the [Roaring Bitmap](https://roaringbitmap.org/) — the compressed-bitmap data structure behind
> Lucene, ClickHouse, Druid, and Spark — and make it **distributed, durable, and cloud-scale**, without
> giving up the fast, familiar in-memory API. Bitmaps too big for one machine's RAM live across tiered
> cloud storage; you still just call `add`, `has`, `remove`, and `intersect`.

> **Status: `0.8.2` — published, and pre-1.0 on purpose.** `1.0` is earned by real-cloud
> cost calibration, real adoption, and freezing the `.crbm` on-disk format, so until then the public API
> and the on-disk format stay evolvable. Everything under *Works today* is implemented and covered by
> tests — unit, property-vs-oracle, a deterministic fault-injecting simulator, conformance suites run
> against real backends (or a faithful emulator), coverage-guided fuzzing of the untrusted-`.crbm`
> boundary, and mutation testing of the highest-risk core modules. What's proven to what degree — and
> what isn't — is set out in the [validated envelope](docs/ROADMAP.md#the-validated-envelope--whats-proven-and-what-isnt).
> **Works today:** the core engine over **in-memory** and **local-filesystem** tiers, with every cloud driver on
> its own `@cloudbitmaps/roaring/<backend>` subpath — **cold** object storage on **S3-compatible** (`/s3`), **GCS**
> (`/gcs`), and **Azure Blob** (`/azure`); a **warm** tier on **DynamoDB** (`/dynamodb`), **PostgreSQL**
> (`/postgres`), **Redis** (`/redis`), **MongoDB** (`/mongodb`), **Cassandra/ScyllaDB**
> (`/cassandra`), and **MySQL/MariaDB** (`/mysql`); a **segment registry**
> (memory / LocalFs / DynamoDB / **S3** — so a read-mostly deployment runs on **S3 alone**), and a
> **crash-safe compaction daemon** (`compact-segments`) — `add` / `addMany` /
> `remove` / `removeMany` / `claimMany` / `has` / `count` / `iterate` / **`intersect` (chunk-skipping)** / `union` / `andNot`, tombstone-correct
> deletes, bulk-load, the `.crbm` archive format, a bounded HOT cache, real cross-process optimistic-concurrency
> writes, **automatic retry with backoff** that rides out transient cloud faults without losing data,
> registry-resolved generation pointers (no per-read scan), **2-phase-commit compaction** that folds warm
> deltas into fresh immutable cold generations (version-fenced — never loses a concurrent write, recovers from a
> crash at any step), and **encryption-at-rest** (opt-in AES-256-GCM, bring-your-own-key, **no required cloud
> dependency**) with **crypto-shred** erasure, plus an optional **observability metrics sink** (`IMetricsSink` —
> cold/warm/cache/retry/intersect/op events, no-op by default, no telemetry dependency), and a **cost
> estimator** (`estimateCost` planning + grounded `costReport` from real segment sizes, with a pluggable
> pricing profile and an honest win/lose verdict), and an optional **audit sink** (`IAuditSink` — publish /
> compact / crypto-shred events for an append-only audit log or SIEM, a truthful GDPR Art. 30 erasure trail).
> **Pre-1.0.** The public API and the `.crbm` on-disk format may still change before `1.0` — that version
> is earned by real-cloud cost calibration, real adoption, and a format freeze, not by a date.

## Why it exists

A Roaring Bitmap is a brilliant way to hold a huge set of integer IDs — *"which of my 1.2 billion customer
IDs are in the `high-value-shoppers` segment?"* — in very little space, with microsecond membership tests
and set operations. But the established libraries (the C/Java/Go implementations and the `roaring`
Node bindings) are **local, in-process data structures**: a bitmap is bounded by one machine's RAM and
disappears when the process dies.

So today, if you want big bitmap-backed **audience segments** or **membership/feature-flag sets** that are
shared across services and survive restarts, you reach for something like an always-on Redis cluster —
which is fast, but **expensive to keep running** and **forgets everything on restart** unless you bolt on
persistence. You're paying for RAM, 24/7, to hold sets that are mostly read.

**CloudBitmaps** keeps the bitmap engine and the developer experience, but puts the *storage* on a tiered,
pluggable, cloud-native architecture: cheap and durable at rest (cents/month in object storage), fast where
it needs to be, and able to answer set queries over enormous bitmaps from small, stateless functions.

## Your data stays yours

A fair question before you build on any storage library: *if I put billions of IDs across thousands of
segments into this and the library breaks, am I stuck?* Short answer — **no** — and here's why, by construction:

- **It's a library, not a service.** Your data lives in **your** S3 bucket, **your** DynamoDB table, **your**
  filesystem — accounts and stores you own. CloudBitmaps never sees or holds it (you're the data controller;
  see [`PRIVACY.md`](PRIVACY.md)). If the project vanished tomorrow, nothing is deleted or held hostage — the
  objects are still in your bucket.
- **The durable tier is an open, standard format.** Cold `.crbm` objects are a **documented container**
  (format spec — a footer index + CRC32C, nothing proprietary) wrapping
  **standard portable RoaringBitmap serialization** — the exact bytes every roaring library (Java, Go, Python,
  C++, Rust, C#) already reads. "Get my data out" = read the index, hand each chunk payload to any roaring
  library. The escape hatch is the format itself.
- **Immutable + versioned + checksummed — a bug can't quietly eat your data.** Cold objects are write-once and
  generation-numbered; the registry's `currentGen` pointer is the only thing that makes one "live." The worst a
  compaction bug can do is write a *new* bad generation — the previous one is intact, and you roll the pointer
  back. Every chunk, index and footer carries a **CRC32C that is verified before the bytes reach the
  deserializer**, so corruption is **detected and rejected, never served as a wrong answer**. A write also
  returns the object's **SHA-256** for you to record if you want an end-to-end check of your own — but be
  clear on the scope: that digest is *not* stored by the library and *not* re-checked on read. The read-path
  integrity guarantee is the CRC32C.
- **A one-command exit.** `store.exportSegments(sink)` (and the `export-segments` CLI) dumps every registered
  segment's current effective set to a portable file — `roaring` (loadable by any roaring library) or `ndjson`
  (zero-dependency) — so leaving is a command, not a research project (and it's a building block for a
  data-portability request). A segment it can't read is recorded in the manifest's `failed[]` and the run
  continues, so one bad segment never blocks the dump.

**Honest caveats.** If you'd rather migrate by copying the **raw storage** than by running `exportSegments`
(which folds warm deltas for you), note the warm-delta rows and the registry are in CloudBitmaps' own
(documented) schema, not a universal interchange format — so that route means first running a **compaction**
(folds warm deltas into standard cold `.crbm`), then reading the cold. And `exportSegments` enumerates the
**registry** (segments with a committed cold generation): a brand-new all-warm segment (only ever `add()`-ed,
never compacted) must be named via `candidates` / `CR_EXPORT_SEGMENTS`, or compacted once, to be included. And the real risks of a young library are
**operational** (a bug affects live ops — recoverable, since the bytes are immutable and yours) and **maturity**
(single-maintainer, pre-1.0); we document the
case against adopting it too. Contrast the
alternatives: pure roaring libraries have zero lock-in *because they don't manage storage at all* (you persist
the bytes; same format as ours); bitmap **databases/services** (FeatureBase/Pilosa, ClickHouse, Doris, Redis)
manage storage for you but keep your data in *their* engine, exited via *their* export. CloudBitmaps is the
unusual middle — a library orchestrating *your own* cloud storage.

## How it works

**Key routing.** Every 32-bit ID is split into a **16-bit chunk key** (the top half) and a **16-bit
remainder** (the bottom half). Each chunk is itself a small Roaring bitmap holding up to 65,536 members.
This is the unit of storage and transfer — you never load a whole segment to touch one ID, and bulk
operations group by chunk first (10,000 IDs spanning 12 chunks become **12 writes, not 10,000**).

**Three storage tiers, behind pluggable drivers.** The engine is storage-agnostic — it talks to driver
*interfaces*, never a specific cloud SDK — so the same code runs on local files, AWS, GCP, Azure, or MinIO:

```text
  add / remove ─► HOT (RAM + bounded LRU)
                     │ flush
                     ▼
                  WARM (NoSQL: one small delta row per dirty chunk, under optimistic concurrency)
                     │ compaction daemon (background, separate process)
                     ▼
                  COLD (immutable .crbm archive objects in object storage)
  has(id) ─► HOT? ─► WARM? ─► COLD? (single-chunk byte-range read)
  intersect(A,B) ─► align chunk indexes ─► fetch only the chunks present in BOTH ─► stream IDs
```

- **Hot** — a bounded in-RAM LRU of decoded chunks (a hard memory ceiling; performance only, never truth).
- **Warm** — live mutations as small per-chunk delta rows in a NoSQL store (DynamoDB, etc.), written under
  an **optimistic-concurrency** token so concurrent writers never lose updates.
- **Cold** — the durable base: immutable, generation-keyed `.crbm` archive objects in object storage (S3,
  etc.), with a footer index that makes `count()` and single-chunk reads cheap.

**Deletes are real and O(1).** Removing an ID doesn't rebuild or rescan a segment — it sets a bit in that
one chunk's **tombstone** layer. Reads compute the effective set `(Cold ∪ adds) \ removes`, so a removed ID
reads as absent *immediately*, even while its bit still physically sits in the cold archive (it's dropped
later, lazily, during compaction). GDPR "forget me," unsubscribes, and rolling "active-this-week" segments
are all just per-ID `remove`s — never a table scan.

**The crown jewel: serverless, chunk-skipping intersection** *(the engine shipped in Phase 3a; S3-backed Cold in 3c)*. To find the IDs in *both* of two
billion-ID segments, CloudBitmaps reads only the two small chunk **index maps**, aligns their 16-bit keys,
and fetches **only the chunks present in both** — so two 100 MB segments overlapping in 5% of chunks
transfer ~10 MB, not 200 MB, and the whole thing runs inside a 128 MB Lambda. This is the capability no
embeddable OSS bitmap library offers off the shelf.

**Compaction** *(shipped, Phase 4d)*. A background daemon (`compact-segments`) periodically stitches the
accumulated warm delta rows into a fresh immutable cold generation and purges the warm rows via a **2-phase
commit** — checksum-verified, **version-fenced** (a write that lands mid-compaction is never lost), and
recoverable from a crash at any step. It **streams** the merge straight into a multipart cold upload, so its
memory footprint stays **flat on the cold side** (the warm delta set is still buffered — a deferred fix), and it runs as a separate process (`once` for
Lambda/cron, `loop` for K8s/ECS), so it never slows your application path.

**Encrypted at rest, with real erasure** *(shipped, Phase 4e)*. Turn on encryption by passing a **keystore** —
the cold `.crbm` objects (payloads *and* index) are **AES-256-GCM**-encrypted, so a leaked bucket reveals
neither ids nor cardinality. It's **bring-your-own-key with no required cloud dependency**: you supply 32-byte
keys; a per-segment data key is wrapped under yours and kept in the registry (KMS/Vault adapters can drop in
later via the `IKeystore` seam). **Crypto-shred** (`destroySegment` / `eraseNamespace`) deletes that key, making
the encrypted bytes permanently unrecoverable *everywhere, including backups* — GDPR erasure that doesn't depend
on reaching every copy. Rotate keys without re-encrypting data, and wrap under an offline **recovery key** so a
lost key isn't fatal.

**Resilient by default — a blip never loses data.** Cloud storage throttles, returns 5xx, and drops
connections; CloudBitmaps treats that as normal. Every warm/cold call automatically **retries transient
faults** (throttle / 5xx / dropped connection / request timeout) with bounded exponential backoff + full
jitter — on by default, tunable, or `retry: false` to defer to your client's own retry. Crucially, retries
are **safe**: the optimistic-concurrency token makes a timed-out-but-committed write detectable (no
double-apply, no lost update), cold generations are write-once (no torn object a reader could pick up), and
all tier bytes are checksum-verified before use (corruption is rejected, never returned as a wrong answer).
The deterministic simulator injects transient faults on storage calls — and races a compaction against the
live read/write path, crashing it mid-2PC — proving the engine's effective set still matches an oracle at
every quiescent point: **a transient blip or a mid-compaction crash never loses or corrupts a
write**. Set a request timeout on your injected
S3/DynamoDB client (it's retried as transient); see the
[getting-started guide](docs/guide/getting-started.md) for tuning.

## What it costs — measured on real AWS

Most libraries in this space quote a model. This one has a bill. Run
[`2026-07-25-60291`] drove the real S3 + DynamoDB drivers
against a real AWS account in `us-east-1` — 20 segments, 2,000 incremental writes, 20 segment publishes, 2,000
reads — and cost **$0.001911** across 6,355 billed requests:

| Operation | Measured cost | | Always-on Redis-HA |
|---|---|---|---|
| Incremental `add()` | **$0.75 / million** | | **$346 / month**, standing |
| `count()` on a published segment | **$0.14 / million** | | whether you send traffic or not |
| Segment publish (bulk-load → one S3 PUT) | **$5.88 / million** | | |

DynamoDB capacity comes from AWS's own `ConsumedCapacity`, read off every response — not a size→ceiling
estimate. The same run also measured the things a cost model can only assume: **zero retry billing** (HTTP
attempts equalled commands, 6,355 = 6,355), a **2.65% write-conflict rate** under 16-way concurrency, **zero
LIST calls** on the read path (LIST bills at 12.5× a GET — a stray list-per-read is this design's classic cost
blowup), and **22 S3 GETs serving 2,000 reads** as the bounded hot cache did its job.

**On latency, the honest version:** that run's client sat ~96 ms of internet from the region (measured, not
inferred), so its p50s are network transit — a read is one round trip, a write is two. It calibrates **cost**,
not in-region latency, and we don't publish an in-region latency figure until an in-region run happens. Full
numbers, method, and an explicit list of what the run does *not* establish:
**[benchmarks](docs/benchmarks.md#real-cloud-calibration--aws)**.

## Install & entry points

```bash
npm i @cloudbitmaps/roaring    # the engine + in-memory & local drivers (one third-party dep: roaring)
npm i @aws-sdk/client-s3       # only if you use the S3 tier
npm i @aws-sdk/client-dynamodb # only if you use the DynamoDB tier
```

**You install one package.** `@cloudbitmaps/roaring` is the *flavor* — the roaring codec + the `CloudRoaring`
facade — and it depends on **`@cloudbitmaps/core`**, the codec-agnostic engine that holds every storage driver.
Core arrives **transitively** — you never install it, and the subpaths below re-export its drivers so
`@cloudbitmaps/roaring` stays the one package name to know (importing `@cloudbitmaps/core/s3` is equivalent if you
prefer). `core` itself has **zero runtime dependencies**.

| Import | Gives you | Peer dep |
|---|---|---|
| `@cloudbitmaps/roaring` | `CloudRoaring` + all in-memory/local drivers, seeding, compaction, crypto, cost/metrics/audit seams, errors | — (pulls `roaring` + `@cloudbitmaps/core`) |
| `@cloudbitmaps/roaring/s3` | `S3ColdDriver`, `S3RegistryDriver` | `@aws-sdk/client-s3` |
| `@cloudbitmaps/roaring/dynamodb` | `DynamoDbWarmDriver`, `DynamoDbRegistryDriver` | `@aws-sdk/client-dynamodb` |
| `@cloudbitmaps/roaring/gcs` | `GcsColdDriver` (Google Cloud Storage cold tier) | `@google-cloud/storage` |
| `@cloudbitmaps/roaring/azure` | `AzureBlobColdDriver` (Azure Blob cold tier) | `@azure/storage-blob` |
| `@cloudbitmaps/roaring/postgres` | `PostgresWarmDriver`, `postgresWarmTableDDL` (Postgres warm tier) | `pg` (+ `@types/pg` for TS) |
| `@cloudbitmaps/roaring/redis` | `RedisWarmDriver` (Redis warm tier) | `ioredis` |
| `@cloudbitmaps/roaring/mongodb` | `MongoWarmDriver`, `ensureMongoWarmIndexes` (MongoDB/DocumentDB warm tier) | `mongodb` |
| `@cloudbitmaps/roaring/cassandra` | `CassandraWarmDriver`, `cassandraWarmTableDDL` (Cassandra/ScyllaDB warm tier) | `cassandra-driver` |
| `@cloudbitmaps/roaring/mysql` | `MysqlWarmDriver`, `mysqlWarmTableDDL` (MySQL/MariaDB warm tier) | `mysql2` |
| `compact-segments` (CLI bin) | the out-of-process compaction daemon (`once` \| `loop`) | — |
| `export-segments` (CLI bin) | eject every segment to portable files (`roaring` \| `ndjson`) — your exit path | — |

The cloud SDKs are **optional peer dependencies** — the main entry never imports a cloud SDK (CI-enforced), so
you pull one in only for the tier you use.

> **Alpine / musl:** `roaring` — the one third-party runtime dep — ships prebuilt binaries for common **glibc**
> targets (incl. Amazon Linux, which CI proves each run). It has **no musl prebuilt**, so on an Alpine base image
> it compiles from source at install — add a toolchain first (`apk add --no-cache build-base python3`), or use a
> glibc image (`node:22-slim`). This is a `roaring` install-time requirement, not a runtime dependency of
> CloudBitmaps.

## Quick taste (works today)

The in-memory drivers need zero setup — ideal for a first look or a test:

```ts
import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@cloudbitmaps/roaring';

const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold: new MemoryColdChunkSource() });
const seg = store.segment('high-value-shoppers');

await seg.add(1_234_567_890);
await seg.addMany([5, 99_999, 2_000_000_000]); // grouped by chunk → one write per chunk
await seg.has(1_234_567_890); // → true

await seg.remove(1_234_567_890); // single-chunk tombstone — no scan, no segment rebuild
await seg.has(1_234_567_890); // → false, immediately

await seg.count(); // exact cardinality
for await (const id of seg.iterate()) {
  /* ascending IDs */
}
```

Swap the in-memory drivers for the local-filesystem ones (`LocalFsWarmDriver` + `LocalFsColdDriver`, passed
straight in — the store wraps the cold driver in its `.crbm` reader for you) and the same code persists to disk
and survives a restart — see the **[getting-started guide](docs/guide/getting-started.md)** for that and the
full operation reference.

For the cloud, you pass **raw drivers** and wire each once — e.g. read-mostly on **S3 alone** (cold + registry
on S3, warm in RAM; no DynamoDB):

```ts
import { CloudRoaring, MemoryWarmDriver } from '@cloudbitmaps/roaring';
import { S3ColdDriver, S3RegistryDriver } from '@cloudbitmaps/roaring/s3';
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });
const store = new CloudRoaring({
  warm: new MemoryWarmDriver(),
  cold: new S3ColdDriver({ client: s3, bucket: 'bitmaps' }), // raw driver — wrapped for you
  registry: new S3RegistryDriver({ client: s3, bucket: 'bitmaps' }),
});
```

## Choosing drivers

Each tier is an independent, swappable driver — all pass the same conformance suite, so the same application
code runs on any mix:

| Tier | in-memory | local filesystem | cloud |
|---|---|---|---|
| **Cold** (durable base) | `MemoryColdDriver` · `MemoryColdChunkSource` | `LocalFsColdDriver` | `S3ColdDriver` · `GcsColdDriver` · `AzureBlobColdDriver` |
| **Warm** (live deltas) | `MemoryWarmDriver` | `LocalFsWarmDriver` | `DynamoDbWarmDriver` · `PostgresWarmDriver` · `RedisWarmDriver` · `MongoWarmDriver` · `CassandraWarmDriver` · `MysqlWarmDriver` |
| **Registry** (current-gen pointer) | `MemoryRegistryDriver` | `LocalFsRegistryDriver` | `DynamoDbRegistryDriver` · `S3RegistryDriver` |
| **Keystore** (optional encryption) | `InProcessKeystore` (BYOK) | ← same | ← same (KMS/Vault adapters are a future package) |

Mix freely: cold + registry on **S3** with warm in RAM = read-mostly on **S3 alone**; cold on S3 with warm +
registry co-located in **one DynamoDB table** = write-heavy.

## The API at a glance

**One config object** — pass raw drivers; the store wires them once (`cold` also accepts a pre-built
`ColdChunkSource` for source-only backends or advanced reader options):

```ts
new CloudRoaring({
  cold, warm,          // required
  registry, keystore,  // optional (registry: current-gen pointer + wrapped keys; keystore: encryption)
  cacheMaxChunks, cacheTtlMs, retry, metrics, // optional tuning (resilience is on by default)
});
```

**Per-segment ops** — `store.segment(name, { namespace? })`:

| Method | Does |
|---|---|
| `add` · `addMany` · `remove` · `removeMany` | mutate (grouped by chunk; single-chunk atomic) |
| `claimMany(ids)` → `number[]` | **claim ids atomically** — adds them, returns only those not already present. The durable `SETBIT`-returns-prior-bit primitive for exactly-once dedup. One write per chunk |
| `has` · `count` · `iterate` | read (tier-merged; `count` = 0 payload reads on compacted chunks) |
| `intersect(others, { exclude? })` · `intersectInto(dest, …)` | chunk-skipping set intersection, streamed. `exclude` subtracts suppression segments **in the same pass** — no intermediate segment |
| `union(others, { exclude? })` · `unionInto(dest, …)` | set union, streamed. The one composite with **no** chunk-skipping — every chunk of every operand is read |
| `andNot(excludes)` · `andNotInto(dest, excludes)` | set difference. Reads all of `this`, but each suppression list **only where it overlaps** |
| `costReport({ workload, pricing })` | grounded cost from the segment's real `.crbm` size |

**Store admin** (reuse the store's own drivers; need a raw cold driver + registry):

| Method | Does |
|---|---|
| `store.compact(ref, { owner })` | fold Warm deltas into a fresh Cold generation, in-process |
| `store.dropSegment(ref, { confirmSegment, dryRun? })` | retire a segment and reclaim its storage — Warm rows, tombstone, then every Cold generation. `dryRun` previews |
| `store.eraseSubject(id, { owner, namespace })` | GDPR Art. 17 — remove an id everywhere + physical purge + erasure ledger |
| `store.subjectReport(id, { namespace })` | GDPR Art. 15 — which segments an id is in |
| `store.exportSegments(sink, { format })` | eject every segment to `roaring`/`ndjson` via an injected sink (your exit path) |
| `CloudRoaring.estimateCost(input)` | planning estimate (static, no data) |

**Out-of-process** free functions (wire their own deps — for daemons, CLIs, seed jobs):
`bulkLoadCrbmGeneration` (seed a generation), `compactSegment` / `runCompactionCycle` (compaction),
`destroySegment` / `eraseNamespace` (crypto-shred), `dropSegment` (retire + reclaim storage). The
`compact-segments` CLI wraps the compaction path.

### A durable alternative to Redis bitmaps

If you are reaching for `SETBIT` on a big key — audiences, dedup, suppression lists, "have I already sent to this
user?" — this is built for that job, without an always-on cluster and without a VPC for your functions. The
operation mapping is one-for-one for everything set-shaped, `count()` is exact and free on a compacted segment, and
`intersect` does something Redis cannot do at any price: skip the chunks that cannot contribute.

**It is not a drop-in replacement, and two limits are worth knowing before you port anything:**

- **There is no addressable-bit surface.** `BITPOS`, `BITFIELD`, byte-range `BITCOUNT` and `BITOP NOT` have no
  equivalent. This is a *set of ids*, not a positional bit buffer — and `NOT` in particular has nothing to
  complement against, because there is no bounded universe here, only the `u32` id space. Raw-bytes
  interoperability is likewise absent: a `.crbm` object is not a flat bit array.
- **Do not port a per-id write loop.** `SETBIT` flips one bit in place and is genuinely O(1); here a Warm write
  re-serializes a whole 65,536-id chunk, so **5,000 ids added one at a time cost 5,000 writes and 23,762 KB against
  1 write and 8 KB batched** — ~3,000× the bytes. Batch and you are far cheaper than Redis; port the loop literally
  and you are far more expensive.

Redis also stays first-class *underneath* this as a warm tier, so "replacing Redis bitmaps" means replacing
`SETBIT`-on-one-giant-key as your **data model**, not necessarily replacing Redis as infrastructure.

### Picking the write path

Three ways in, billing on **three different axes**. Picking the wrong one is the single most expensive mistake
available in this library, so it's worth thirty seconds:

| | `add(id)` | `addMany(ids)` | `bulkLoadCrbmGeneration(ids)` |
|---|---|---|---|
| Work per call | one read-modify-write | one read-modify-write **per distinct chunk touched** | one `.crbm` build + S3 PUT(s) |
| Cost scales with | **the number of calls** | **chunks touched**, not ids | the segment's **compressed size** |
| Writes to | warm tier (delta) | warm tier (deltas) | a fresh immutable cold generation + pointer flip |
| Expresses a delta? | yes | yes | **no** — it replaces the whole segment |
| Takes a stream? | — | **yes** — sync *or* async iterable | **yes** — sync *or* async iterable |
| Reach for it when | one id changed — a user just qualified | you have a batch of ids in hand | you're building or refreshing a segment |

**The measured spread, because "the most expensive mistake available" deserves a number.** Same 5,000 ids:

| Shape | Warm writes | Bytes written |
|---|---|---|
| `add(id)` per id, 5,000× | 5,000 | 23,762 KB |
| `addMany(ids)` in 500-id batches | 10 | 51 KB |
| one `addMany(ids)` | 1 | 8 KB |

~3,000× the bytes for the per-id loop, because each write re-serializes the whole 65,536-id chunk bitmap. **If you
are porting a Redis `SETBIT` loop, this is the line to read twice** — `SETBIT` is genuinely O(1) per call, so the
natural Redis shape is the worst shape here. See [benchmarks](docs/benchmarks.md#write-shape--the-cost-of-one-op-per-id).

Both batch entry points accept an **`AsyncIterable`**, so a database cursor goes straight in — no hand-batching
`page → addMany(page)`. That is an ergonomic change only: ids are grouped by chunk and each chunk is written
**exactly once** however long the stream, so streaming never costs more than passing an array.

Which one to stream *into* is still the expensive decision, and it does not change with the stream length. If
you are **amending** a segment, `addMany`. If you are **rebuilding** one — the 11M-row query that defines the
whole segment — `bulkLoadCrbmGeneration`, because `addMany` would write one warm row per touched chunk (~61,000
of them for ids spread across the id space) where bulk-load writes a single immutable object.

#### Why batching matters so much

An id is split into a **16-bit chunk key + a 16-bit remainder**, so one chunk covers **65,536 ids** and the
whole 32-bit space is at most 65,536 chunks. `addMany` groups ids by chunk *before* touching the backend, so it
issues **one read-modify-write per distinct chunk** — however many of that chunk's ids you're setting. Ten
million ids therefore land in somewhere between **153 chunks** (contiguous) and **65,536** (scattered across the
whole space), never ten million.

`add()` can't do that. It's handed one id, so it must do one read-modify-write, every time.

#### Ten million ids, three ways

| Path | Backend ops | Cost | Basis |
|---|---|---|---|
| `add()` in a loop | 10,000,000 read-modify-writes | **~$7.50 – $52** | measured rate; range is row size |
| `addMany()` in batches | 153 chunk writes (contiguous) → 65,536 (scattered) | **~$0.001 – $0.05** | derived |
| `bulkLoadCrbmGeneration()` | a handful of S3 PUTs | **~$0.00001** | derived |

The arithmetic, so you can check it rather than trust it. Each read-modify-write is one `GetItem` + one
conditional `UpdateItem`; DynamoDB on-demand bills $0.125/M read units (1 per 4 KiB) and $0.625/M write units
(1 per **1 KiB** — the cost driver). **The per-write price therefore depends on how big the warm row already
is**, which is why the loop is a range rather than a number:

- **`add()` × 10M** — a small row (≤1 KiB) is 1 RRU + 1 WRU = **$0.75/million**, the figure
  [measured](docs/benchmarks.md#real-cloud-calibration--aws) on real AWS ⇒ $7.50. But a chunk's delta *grows as
  you fill it*: once it reaches a full ~8 KiB roaring bitmap the same call is 2 RRU + 8 WRU = **$5.25/million**
  ⇒ ~$52. Denser data costs more per `add()`, so the loop is worst exactly where bulk-load was most obviously
  the right call.
- **`addMany()`, contiguous** — 153 chunks, each one full ~8 KiB write ⇒ $0.00000525/chunk ⇒ **~$0.0008**.
- **`addMany()`, scattered** — 65,536 chunks holding ~153 ids each, well under 1 KiB ⇒ 1 RRU + 1 WRU ⇒
  **~$0.05**. Even the worst case for batching beats the *best* case for the loop by 150×.
- **bulk-load** — ids compress into a few MB of `.crbm`; S3 bills **per PUT, not per id**, at $5.00/M.

#### Two things that trip people up

**Concurrency fixes the *time*, never the *cost*.** The instinct on seeing "10M writes takes over a day" is to
raise concurrency — and that works, because throughput is concurrency ÷ latency. But the bill is **per request**,
so parallelising a 10M-call loop still costs $7.50; you just reach it faster. Only reducing the *number of
requests* reduces the bill, which is what batching does.

**Nothing fails when you get it wrong.** The loop compiles, every call succeeds, the answer is correct, and the
metrics sink dutifully reports each write. There is no error, no warning, and no anomaly in any single
observation — the mistake is only visible in aggregate, on an invoice, later. That's why this section exists
instead of a runtime check: detecting it live would mean taxing every `add()` on the hot path to catch a mistake
made once.

#### It cuts the other way too

Bulk-load rewrites the **entire** segment. It can't express "one more user" on a ten-million-user segment — you'd
need all ten million ids in hand just to say it — and it can't express a **deletion** at all. So it isn't a
cheaper version of `add()`; it's a different operation. That's exactly what the warm tier, its
optimistic-concurrency path, and first-class tombstones exist for.

**The rule: `add()` for one id, `addMany()` whenever you have a batch, bulk-load when you're replacing a segment
rather than amending it.**

Full signatures and per-tier setup are in the **[getting-started guide](docs/guide/getting-started.md)**.

## When to reach for it

- **You have large ID sets** (audience segments, membership/eligibility, feature-flag cohorts, "seen"
  sets) that you want **durable and cheap at rest**, not pinned in always-on RAM.
- **You need fast membership + set algebra** (union/intersection/difference) over those sets — including
  intersecting very large sets from stateless/serverless workers.
- **You want to own your storage** (your S3/DynamoDB, your costs, your residency) rather than a managed
  bitmap service, and to keep a clean, embeddable API.

**Why the shape works at segmentation scale.** Per-operation latency is the wrong lens for a workload with
millions of users per segment, because the operations that govern it don't scale with N:

- **Building or refreshing a segment** is one bulk-load → **a single (or multipart) S3 PUT**, bounded by the
  bitmap's compressed bytes rather than by the number of users in it.
- **`count()` is free** — 0 payload reads on a published segment, summed from the `.crbm` index. Counting a
  ten-million-user audience costs the same as counting a thousand.
- **Membership checks come from RAM** once warm — measured at 22 S3 GETs across 2,000 reads.
- **Intersections skip** — two 2,000,000-id segments intersect by fetching only the shared chunks (100 of 2,000
  each, 25.3 ms). This is the case an always-on RAM store pays for by keeping both bitmaps resident.

It is **not** a general database, a full-text index, or a replacement for Redis as a low-latency cache —
it's a specialized engine for big, durable, cloud-resident bitmaps. A single membership check that misses the
hot cache costs a **network round trip to your warm tier**, where an in-process RAM store costs a memory read —
so if you need a sub-millisecond p99 on a working set that fits a bounded hot cache, that's the right tool and
this isn't. (We deliberately publish no in-region latency *figure* until an in-region run measures one — see
[benchmarks](docs/benchmarks.md#what-it-cost-in-latency--and-why-the-number-is-what-it-is).) Honest cost/performance
trade-offs (and where Redis or a columnar store wins instead) are documented as part of the design, not buried.

**Already using Redis bitmaps?** That paragraph is about Redis as a *cache*; this is about `SETBIT`-on-one-giant-key
as a *data model*, which is a different question. Your operations carry over one-for-one — `SETBIT`/`GETBIT` →
`add`/`has`, `BITCOUNT` → `count`, `BITOP AND`/`OR`/`DIFF` → `intersect`/`union`/`andNot` — and you are not giving
up the bitmap: past **4,096 ids** in a 65,536-id chunk (6.25% of it) Roaring stores that chunk *as* a flat bit
array, byte for byte what you have now. What does **not** carry over is the raw bytes: a `.crbm` is not a flat bit
array, so anything reading your Redis key's underlying string won't read ours, and `BITFIELD` / `BITPOS` /
`BITOP NOT` have no equivalent. The full mapping, including what's unbuilt, is in the
[guide](docs/guide/getting-started.md#coming-from-redis-bitmaps).

## Status & where it's headed

Built in phases, each shipped behind tests and an adversarial review:

- **M1 — local end-to-end** *(complete)*: the core engine + `.crbm` format + local-filesystem drivers +
  a shared driver conformance suite + a deterministic, seed-replayable concurrency simulator. No cloud needed.
- **M2 — Topology-A (the showcase)** *(complete)*: the S3 cold driver, bulk load, and the chunk-skipping
  intersection engine — the first shippable, the centerpiece.
- **M3 — Topology-B** *(complete)*: the DynamoDB warm driver, live writes, a crash-safe **streaming** compaction daemon (cold-side constant memory; the warm delta set is still buffered — a deferred fix), and **encryption-at-rest + crypto-shred**.
- **M4 — production-grade** *(complete)*: an observability metrics sink, an honest cost estimator, a
  **benchmark-as-test** harness that turns the cost/perf claims into build-breaking CI assertions, a
  **cheap `count()`** (0 payload reads on a compacted segment), an **audit sink** (`IAuditSink` — a truthful
  GDPR Art. 30 erasure trail), and the **compliance & governance** layer — [`PRIVACY.md`](PRIVACY.md),
  **subject access & erasure** (`subjectReport` / `eraseSubject` with a physical-deletion guarantee), and
  legal-hold guidance — have all landed. See the [benchmarks & crossover chart](docs/benchmarks.md) and the
  [dashboards guide](docs/guide/dashboards.md).
- **M5**: a hardened, benchmarked, trademarked **v1.0** public launch.

Beyond the milestones, the pre-1.0 **hardening backlog + an 8-discipline testing frontier** (soak · mutation ·
fuzz · stress · DR · security · load/tail-latency · chaos) are complete, and the production-readiness re-assessment
lands at **ready within a validated envelope** (read-mostly / large-fleet / single-tenant / single-region; the
scale/tenancy deferrals are tracked openly). **Phase 7 — additional storage drivers** is complete: **GCS + Azure
Blob cold and PostgreSQL + Redis + MongoDB + Cassandra/ScyllaDB + MySQL warm drivers have all shipped** (the
object-store story is complete on AWS + GCP + Azure, and Postgres/Redis/Mongo/Cassandra/MySQL are non-AWS warm
tiers — "use the datastore you already run"). Security and supply-chain hardening is in place: npm build
provenance on every release, SHA-pinned Actions, a hard cgroup-RSS ceiling in CI, a native OS matrix, a
prebuilt Lambda layer, and continuous coverage-guided fuzzing.

The library ships as the **`@cloudbitmaps`** family — one shared engine, pluggable codecs. The repo is a
pnpm workspace of `@cloudbitmaps/core` (the codec-agnostic engine + every driver, zero runtime
dependencies) and `@cloudbitmaps/roaring` (the roaring codec, the `CloudRoaring` facade, and the two
CLIs). You install one flavor; core arrives transitively.

## Documentation

- **Usage walkthrough** — how you actually use it, end to end: the mental model,
  local → cloud wiring, the operations, the real flows (seed, match, campaign targeting, compaction,
  encryption), and where cost + observability fit.
- **[Getting started](docs/guide/getting-started.md)** — the exhaustive, per-tier reference with every signature.
- **[Benchmarks](docs/benchmarks.md)** — the CloudBitmaps-vs-flat-Redis crossover chart + the gated cost/perf anchors.
- **[Privacy & shared responsibility](PRIVACY.md)** — the trust boundary (you are the controller; nothing is sent to us), the erasure/retention/residency contracts, and a DPIA + Art. 30 template.
- **[Roadmap](docs/ROADMAP.md)** — what's shipped, the **validated envelope** (what's proven and what isn't), what stands between here and `1.0`, and what we've deliberately said no to.
- **[Changelog](CHANGELOG.md)** — what's changed (newest first; everything under `[Unreleased]` until v1.0).
- Design specs, the detailed roadmap, and the decision log live under [`docs/`](docs/) for contributors.

## Building & contributing

A fresh clone passes the full gate with no manual setup. You need **Node ≥ 20** (`.nvmrc` pins 22) and
**pnpm 9**; Docker is needed only for the integration lane.

```bash
pnpm install
pnpm lint && pnpm lint:arch && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm smoke
pnpm test:integration   # spins up every backend via `docker compose` — no cloud account needed
```

**[`CONTRIBUTING.md`](CONTRIBUTING.md)** is the canonical record of how we work — branching & merge
conventions, the per-phase build-with-tests + adversarial-review process, the documentation map, and code
style. ([`CLAUDE.md`](CLAUDE.md) is the AI-agent operating manual; it embeds the engineering principles +
hard correctness invariants and defers to `CONTRIBUTING.md` for the process.)

## License

**Apache-2.0.** The unscoped `cloud-roaring` name is reserved on npm (a `0.0.0` placeholder) and the
`@cloudbitmaps` scope is where the packages publish; the name is trademarked at the public launch.
