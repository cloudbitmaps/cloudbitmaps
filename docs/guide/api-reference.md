# API Reference — the complete surface

The single source of truth for **everything a user can import and call** across all entry points. Organized
user-first: the everyday surface at the top, the occasional operations next, the driver-author plumbing last, and
a flat **[Complete export index](#complete-export-index)** at the end that names every export.

> **Kept in sync by CI.** [`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts)
> extracts every exported name from **both** package barrels (`packages/roaring/src/index.ts` and the
> `packages/core/src/index.ts` it re-exports) plus each driver-subpath barrel under `packages/core/src/*/index.ts`,
> and fails the build if any is missing from this page. So a new export **cannot** merge without being documented
> here. (The guard is one-way — it catches undocumented _additions_, not stale entries for a _removed_ export;
> prune those in review.)

---

## Mental model: three nouns

```
a STORE  ──has many──▶  SEGMENTS  ──contain──▶  IDs (u32 integers, 0, 2³²))
CloudRoaring            store.segment('name')    add / has / remove / count / intersect …
```

## Entry points

You install **one flavor package** — `@cloudbitmaps/roaring` — and `@cloudbitmaps/core` arrives transitively.
Everything below is reachable from the flavor:

```
@cloudbitmaps/roaring            the store + memory/localfs drivers + every function & type
@cloudbitmaps/roaring/s3         S3ColdDriver, S3RegistryDriver          (peer: @aws-sdk/client-s3)
@cloudbitmaps/roaring/dynamodb   DynamoDbWarmDriver, DynamoDbRegistryDriver (peer: @aws-sdk/client-dynamodb)
@cloudbitmaps/roaring/gcs        GcsColdDriver                           (peer: @google-cloud/storage)
@cloudbitmaps/roaring/azure      AzureBlobColdDriver                     (peer: @azure/storage-blob)
@cloudbitmaps/roaring/postgres   PostgresWarmDriver, postgresWarmTableDDL (peer: pg)
@cloudbitmaps/roaring/redis      RedisWarmDriver                         (peer: ioredis)
@cloudbitmaps/roaring/mongodb    MongoWarmDriver, ensureMongoWarmIndexes  (peer: mongodb)
@cloudbitmaps/roaring/cassandra  CassandraWarmDriver, cassandraWarmTableDDL (peer: cassandra-driver)
@cloudbitmaps/roaring/mysql      MysqlWarmDriver, mysqlWarmTableDDL       (peer: mysql2)
CLIs (binaries):                 compact-segments, export-segments
```

**Where the code actually lives.** The flavor package is the roaring codec (`SafeBitmap` / `roaringCodec`), the
`CloudRoaring` facade, and the CLIs; its main barrel re-exports `@cloudbitmaps/core` wholesale and each
`/<backend>` barrel is a one-line re-export of `@cloudbitmaps/core/<backend>` — the drivers are codec-agnostic,
so one set in core serves every flavor. A flavor or driver author who depends on core directly imports the same
surface from `@cloudbitmaps/core` and its `/s3`, `/dynamodb`, `/gcs`, `/azure`, `/postgres`, `/redis`, `/mongodb`,
`/cassandra`, `/mysql` subpaths. Applications never need to name core.

---

## The everyday surface (what you'll call)

### Build a store — `new CloudRoaring(options)`

`cold` + `warm` are the only required options; add `registry` for eject / compaction / encryption (recommended
for anything beyond a first look). Everything else is optional tuning with sensible defaults — see
[`CloudRoaringOptions`](#construction--result-types).

Pick one driver per tier (all interchangeable; mix backends freely):

| Tier | in-memory | local disk | cloud |
|---|---|---|---|
| **cold** (durable base) | `MemoryColdDriver` · `MemoryColdChunkSource` | `LocalFsColdDriver` | `S3ColdDriver` · `GcsColdDriver` · `AzureBlobColdDriver` |
| **warm** (live deltas) | `MemoryWarmDriver` | `LocalFsWarmDriver` | `DynamoDbWarmDriver` · `PostgresWarmDriver` · `RedisWarmDriver` · `MongoWarmDriver` · `CassandraWarmDriver` · `MysqlWarmDriver` |
| **registry** (current-gen pointer) | `MemoryRegistryDriver` | `LocalFsRegistryDriver` | `DynamoDbRegistryDriver` · `S3RegistryDriver` |
| **keystore** (optional encryption) | `InProcessKeystore` (BYOK) | ← same | ← same |

### Get a segment — `store.segment(name, { namespace? })` → `Segment`

### The segment verbs (the ~90% of daily use)

| Call | Does |
|---|---|
| `seg.add(id)` · `seg.addMany(ids)` | add member(s); `addMany` groups by chunk (one write per chunk) |
| `seg.remove(id)` · `seg.removeMany(ids)` | remove member(s) — single-chunk tombstone, no scan |
| `seg.has(id)` → `Promise<boolean>` | membership test |
| `seg.count()` → `Promise<number>` | exact cardinality (cheap — from the cold index) |
| `seg.iterate()` → `AsyncIterable<number>` | stream all ids, ascending |
| `seg.intersect([other, …], { concurrency? })` → `AsyncIterable<number>` | **the crown jewel** — chunk-skipping intersection, streamed |
| `seg.intersectInto(dest, [other, …], { concurrency?, batchSize? })` → `Promise<void>` | materialize `this ∩ others` **into** another segment |

That's the whole daily surface: **1 constructor + pick 3 drivers + these 7 verbs.**

---

## Operations you call when you need them

### Store methods

| Call | Does |
|---|---|
| `store.subjectReport(id, { namespace? \| allNamespaces?, concurrency?, budget? })` → `SubjectReport` | GDPR Art. 15 — which registered segments is this id in? (needs an explicit namespace or an `allNamespaces` ack) |
| `store.eraseSubject(id, { owner, namespace? \| allNamespaces?, audit?, concurrency?, budget? })` → `EraseSubjectResult` | GDPR Art. 17 — remove an id everywhere + physically purge; returns a proof ledger |
| `store.compact(ref, { owner, leaseMs?, audit? })` → `CompactionResult` | fold warm deltas into a fresh cold generation (usually the daemon does this) |
| `store.checkConsistency({ namespace?, concurrency? })` → `ConsistencyReport` | DR: verify every segment's `currentGen` `.crbm` is present (catch a torn cross-tier restore) |
| `store.exportSegments(sink, { format?, namespace?, candidates? })` → `ExportManifest` | eject every segment to portable `roaring`/`ndjson` |
| `seg.costReport({ pricing?, workload?, topology? })` → `CostReport` | grounded $ cost for this segment (from its real cold size) |
| `CloudRoaring.estimateCost(input)` → `CostReport` | **static** — plan costs with no instance/data (sizing, what-if) |
| ↳ `report.advisories` → `readonly CostAdvisory[]` | **self-relative** hints (empty is normal) — where this workload pays more than *this library* would charge for the same outcome; `verdict` only compares against Redis |

### Standalone functions (imported, called directly)

| Call | Does |
|---|---|
| `bulkLoadCrbmGeneration(cold, { segment, generation }, ids, { registry })` → `BulkLoadResult` | seed a cold generation from a (huge, unsorted) id stream |
| `destroySegment(…)` → `DestroyResult` | crypto-shred one whole segment (key deleted → bytes unrecoverable) |
| `eraseNamespace(…)` | crypto-shred an entire namespace / tenant |
| `runCompactionCycle(deps, { owner, keep })` | one compaction pass — for a custom compaction worker (the CLI wraps this) |
| `runConsistencyCheck({ cold, registry }, { namespace?, concurrency? })` → `ConsistencyReport` | the free-function behind `store.checkConsistency` — run it over your own drivers |

### Optional plug-ins you construct and pass in

| Construct | Pass as | For |
|---|---|---|
| `new InProcessKeystore({ keys, activeKeyId })` | `keystore` | encryption-at-rest + crypto-shred (BYOK) |
| `new CountingMetricsSink()` (or your own `IMetricsSink`; `NOOP_METRICS` is the default) | `metrics` | observability — cold/warm/cache/retry/latency events |
| `new RecordingAuditSink()` (or your own `IAuditSink`; `NOOP_AUDIT` is the default) | `audit` (on erase/compact/bulk-load) | compliance trail — publish/compact/erase events |

### CLIs (run as binaries, env-configured)

| Binary | Does |
|---|---|
| `compact-segments` | run compaction once or in a loop (`CR_COMPACT_*`) |
| `export-segments` | eject all segments to a directory (`CR_EXPORT_*`) |

---

## Types in signatures

The option / result types the public methods above reference — you import these to annotate variables.

### Construction & result types

`CloudRoaringOptions` · `SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `CompactionOptions` · `CompactionResult` · `BulkLoadResult`

### Export / eject

`ExportSink` · `ExportWriter` · `ExportFormat` · `ExportOptions` · `ExportedSegment` · `ExportFailure` ·
`ExportManifest`

### Cost & observability

`CostReport` · `CostAdvisory` · `PricingProfile` · `Workload` · `SegmentSizing` · `EstimateInput` · `Topology` · `IMetricsSink` ·
`MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `IAuditSink` · `AuditEvent` · `AuditEventKind`

### The tier interfaces (used to type `cold` / `warm` / `registry`)

`IColdDriver` · `IWarmDriver` · `IRegistryDriver` · `ColdChunkSource` · `SegmentRef` · `IKeystore` · `RetryPolicy`
· `Clock` · `Rng`

---

## Advanced / driver-author surface

You **do not** import these to _use_ CloudBitmaps — only to **write a driver**, build tooling against the
on-disk format, or run out-of-process operations. This distinction is **docs-level by design**: a
separate `advanced` subpath split was considered and **deliberately not built** (marginal payoff, real cost,
net-new surface), so everything here still imports from the single
`@cloudbitmaps/roaring` barrel.

### `.crbm` on-disk format

| Symbol | What it does |
|---|---|
| `CrbmWriter` / `CrbmWriterOptions` | write the `.crbm` archive format |
| `CrbmReader` / `CrbmReaderOptions` | read it |
| `CrbmColdChunkSource` / `CrbmColdChunkSourceOptions` | the `.crbm` cold reader (the store builds this from a raw driver for you) |
| `writeCrbmGeneration` · `publishGeneration` | lower-level seed: write a generation from `SafeBitmap`s / flip the `LATEST` pointer |
| `BufferSink` · `BufferReader` · `BlobSink` · `BlobReader` | byte sink/reader impls + interfaces |
| `SafeBitmap` | size-capped wrapper over `RoaringBitmap32` (the roaring codec's `CodecBitmap`) |

### Bitmap-codec seam

The engine is **codec-agnostic** behind these; roaring is the flagship codec. You only touch them to plug in a
different codec (the `@cloudbitmaps/bitmap` / `@cloudbitmaps/soaring` flavors) — the `CloudRoaring` facade injects
`roaringCodec` for you.

| Symbol | What it does |
|---|---|
| `CodecInterface` | the factory the engine builds bitmaps through (`empty` / `fromValues` / `safeDeserialize`) |
| `CodecBitmap` | the value type a codec produces — a `u32` set with set algebra + portable (de)serialization. Optional `maximum?()` lets the engine range-check a chunk payload in O(1); a codec that can't answer cheaply omits it and the check is skipped |
| `roaringCodec` | the flagship (roaring) `CodecInterface`, delegating to `SafeBitmap`; the facade's default |

### Flavor-author kit (`@cloudbitmaps/core`)

**Added by the family split**. These are the pieces a **flavor** package (codec +
facade) or a **driver** author composes — `@cloudbitmaps/core`'s actual audience. An application never calls them:
it uses the flavor's `CloudRoaring` facade, which wires all of this for you. They are reachable from
`@cloudbitmaps/roaring` too, because the flavor re-exports core wholesale.

| Symbol | What it does |
|---|---|
| `SegmentEngine` / `EngineDeps` | the codec-agnostic tiered engine + its injected deps (**`codec` is required** — core has no default) |
| `BoundedLru` | the count+byte-bounded LRU the facade uses for the HOT chunk cache |
| `safeMetrics` | wrap a user `IMetricsSink` so a throwing sink can never break the data path |
| `groundedReport` | build a `CostReport` from measured segment sizes (backs `segment.costReport()`) |
| `validateCompactionOptions` | fail-fast validation of `owner`/`leaseMs` before a compaction run |
| `runExport` | the eject/export driver (**needs a `codec` for the `roaring` format**; the flavor binds it) |
| `splitId` / `joinId` | the id ⇄ `(chunkKey, remainder)` bit-routing pair |
| `mapWithConcurrency` | the bounded fan-out primitive (admin scans, write flusher, S3 registry list) |
| `resolveBudget` / `resolvePerOpBudget` / `checkBudget` | the denial-of-wallet budget plumbing |
| `validateSegmentRef` | boundary validation of a `SegmentRef` (untrusted-input posture) |

### Driver kit — what you need to *implement* a driver

| Symbol | What it does |
|---|---|
| `NO_ROW` | the create-if-absent sentinel every `IWarmDriver.putConditional` compares `expected` against (a `Symbol.for` registry symbol, so it stays identical across bundles) |
| `NoRow` · `Token` · `WarmRow` · `WarmReadOptions` | the warm-tier row/token/read-option shapes in `IWarmDriver` |
| `chunkRefKey` · `segmentKey` | the canonical key-string helpers (used by the conformance suite + fake drivers) |

### Compaction internals (out-of-process)

| Symbol | What it does |
|---|---|
| `compactSegment` · `gcOrphanGenerations` · `findCompactable` | compact one segment / GC old generations / discover candidates |
| `CompactionDeps` · `DiscoveryOptions` · `CompactionCandidate` · `CompactionCycleResult` | their deps / args / results |

### Resilience (the store wires this by default)

| Symbol | What it does |
|---|---|
| `withRetry` · `isTransient` · `DEFAULT_RETRY_POLICY` · `DEFAULT_OCC_BACKOFF` · `RetryDeps` | the retry primitive + classifier + defaults |
| `RetryingWarmDriver` · `RetryingColdDriver` · `RetryingColdChunkSource` · `RetryingRegistryDriver` · `RetryingOptions` | manual driver-wrapping decorators |

### Crypto seams

| Symbol | What it does |
|---|---|
| `NodeAead` · `Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `aadFor` | the AES-256-GCM implementation + the crypto interfaces the `.crbm` reader/writer use |
| `EraseDeps` | deps for the free-function erasure (`destroySegment` / `eraseNamespace`) |

### Low-level ports & capabilities (driver-author typing)

`ColdCaps` · `RegCaps` · `ChunkRef` · `GenKey` · `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` ·
`RegistryStatus` · `GovernanceMeta` · `SegmentSize`

### Driver option types (subpath entry points)

`MemoryRegistryDriverOptions` · `LocalFsRegistryDriverOptions` · `InProcessKeystoreOptions` ·
`S3ColdDriverOptions` · `S3RegistryDriverOptions` · `DynamoDbWarmDriverOptions` · `DynamoDbRegistryDriverOptions` ·
`GcsColdDriverOptions` · `AzureBlobColdDriverOptions` · `PostgresWarmDriverOptions` · `RedisWarmDriverOptions` ·
`MongoWarmDriverOptions` · `CassandraWarmDriverOptions` · `MysqlWarmDriverOptions`

---

## Errors (typed — you `catch` these)

`CloudRoaringError` (base) · `ValidationError` · `WriteConflictError` · `IntegrityError` · `NotFoundError` ·
`UnsupportedError` · `CapabilityError` · `TransientError` · `TimeoutError` · `KeyUnavailableError` ·
`BudgetExceededError` (a per-op denial-of-wallet budget was exceeded — 07 Decision #3 / T3)

**Bundle-safe predicates** — `isCloudRoaringError` · `isWriteConflictError` · `isTransientError` ·
`isNotFoundError` · `isIntegrityError` · `isValidationError`. Prefer these over `instanceof` when catching
errors that originate in a cloud driver (`@cloudbitmaps/roaring/s3` / `…/dynamodb`): those subpaths are
separate bundles, so a driver-thrown error is not `instanceof` the class object from the core entry in CJS. The
predicates match a `Symbol.for` brand + the runtime `name`, so they hold across bundles.

---

## Complete export index

Every export, by entry point. This section is the completeness anchor the sync test checks against.

### `@cloudbitmaps/roaring` — values

`CloudRoaring` · `Segment` · `MemoryColdDriver` · `MemoryWarmDriver` · `MemoryRegistryDriver` ·
`MemoryColdChunkSource` · `LocalFsColdDriver` · `LocalFsWarmDriver` · `LocalFsRegistryDriver` ·
`bulkLoadCrbmGeneration` · `writeCrbmGeneration` · `publishGeneration` · `CrbmColdChunkSource` · `compactSegment`
· `runCompactionCycle` · `findCompactable` · `gcOrphanGenerations` · `destroySegment` · `eraseNamespace` ·
`InProcessKeystore` · `NodeAead` · `aadFor` · `SafeBitmap` · `roaringCodec` · `withRetry` · `isTransient` ·
`SegmentEngine` · `BoundedLru` · `safeMetrics` · `groundedReport` · `validateCompactionOptions` · `runExport` ·
`splitId` · `joinId` · `mapWithConcurrency` · `resolveBudget` · `resolvePerOpBudget` · `checkBudget` ·
`validateSegmentRef` · `NO_ROW` · `chunkRefKey` · `segmentKey` ·
`DEFAULT_RETRY_POLICY` · `DEFAULT_OCC_BACKOFF` · `RetryingColdDriver` · `RetryingWarmDriver` ·
`RetryingRegistryDriver` · `RetryingColdChunkSource` · `CrbmWriter` · `CrbmReader` ·
`BufferSink` · `BufferReader` · `CountingMetricsSink` · `NOOP_METRICS` ·
`RecordingAuditSink` · `NOOP_AUDIT` · `estimateCost` ·
`DEFAULT_PRICING` · `AWS_US_EAST_1_ONDEMAND` · `runConsistencyCheck` · `DEFAULT_BUDGET` · `CloudRoaringError` ·
`ValidationError` · `WriteConflictError` · `IntegrityError` · `NotFoundError` · `UnsupportedError` ·
`CapabilityError` · `TransientError` · `TimeoutError` · `KeyUnavailableError` · `BudgetExceededError` ·
`isCloudRoaringError` · `isWriteConflictError` · `isTransientError` · `isNotFoundError` · `isIntegrityError` ·
`isValidationError` · `VERSION`

### `@cloudbitmaps/roaring` — types

`CloudRoaringOptions` · `SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `CompactionOptions` · `CompactionResult` · `CompactionDeps` · `DiscoveryOptions` ·
`CompactionCandidate` · `CompactionCycleResult` · `BulkLoadResult` · `CrbmColdChunkSourceOptions` · `MemoryRegistryDriverOptions` ·
`LocalFsRegistryDriverOptions` · `ExportFormat` · `ExportSink` · `ExportWriter` · `ExportOptions` ·
`ExportedSegment` · `ExportFailure` · `ExportManifest` · `IColdDriver` · `IWarmDriver` · `IRegistryDriver` ·
`ColdChunkSource` · `SegmentRef` · `ChunkRef` · `GenKey` · `ColdCaps` · `RegCaps` · `RegistryRecord` ·
`NewRegistryRecord` · `RegistryPatch` · `RegistryStatus` · `GovernanceMeta` · `SegmentSize` · `IKeystore` ·
`Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `InProcessKeystoreOptions` · `EraseDeps` · `DestroyResult`
· `RetryPolicy` · `RetryDeps` · `RetryingOptions` · `CrbmWriterOptions` · `CrbmReaderOptions` · `BlobReader` ·
`BlobSink` · `IMetricsSink` · `MetricEvent` · `MetricOpName` · `MetricsSnapshot` · `PricingProfile` ·
`CostReport` · `CostAdvisory` · `Workload` · `SegmentSizing` · `EstimateInput` · `Topology` · `IAuditSink` · `AuditEvent` ·
`AuditEventKind` · `Clock` · `Rng` · `Budget` · `BudgetOption` · `ConsistencyReport` · `ConsistencyIssue` ·
`ConsistencyErrorEntry` · `CodecInterface` · `CodecBitmap` · `EngineDeps` · `NoRow` · `Token` · `WarmRow` ·
`WarmReadOptions`

### `@cloudbitmaps/roaring/s3`

`S3ColdDriver` · `S3RegistryDriver` · `S3ColdDriverOptions` · `S3RegistryDriverOptions`

### `@cloudbitmaps/roaring/dynamodb`

`DynamoDbWarmDriver` · `DynamoDbRegistryDriver` · `DynamoDbWarmDriverOptions` · `DynamoDbRegistryDriverOptions`

### `@cloudbitmaps/roaring/gcs`

`GcsColdDriver` · `GcsColdDriverOptions` — the Google Cloud Storage cold driver (peer: `@google-cloud/storage`).

### `@cloudbitmaps/roaring/azure`

`AzureBlobColdDriver` · `AzureBlobColdDriverOptions` — the Azure Blob Storage cold driver (peer:
`@azure/storage-blob`). Inject a container-scoped `ContainerClient`; write-once via `ifNoneMatch: '*'`.

### `@cloudbitmaps/roaring/postgres`

`PostgresWarmDriver` · `PostgresWarmDriverOptions` · `postgresWarmTableDDL` — the PostgreSQL warm-tier driver
(peer: `pg`). Inject a `pg.Pool`; OCC via `INSERT … ON CONFLICT` + token-fenced `UPDATE`/`DELETE`.
`postgresWarmTableDDL(table?)` returns the idempotent `CREATE TABLE` to run once at deploy time.

### `@cloudbitmaps/roaring/redis`

`RedisWarmDriver` · `RedisWarmDriverOptions` — the Redis warm-tier driver (peer: `ioredis`). Inject an
`ioredis` client; OCC via an atomic Lua compare-and-set, with a per-segment sorted-set index for `listChunks`.

### `@cloudbitmaps/roaring/mongodb`

`MongoWarmDriver` · `MongoWarmDriverOptions` · `ensureMongoWarmIndexes` — the MongoDB / DocumentDB warm-tier
driver (peer: `mongodb`). Inject a `Db`; OCC per-document via a deterministic composite `_id` (create-if-absent)
+ token-fenced `updateOne`/`deleteOne`. `ensureMongoWarmIndexes(db, collection?)` builds the `listChunks` index.

### `@cloudbitmaps/roaring/cassandra`

`CassandraWarmDriver` · `CassandraWarmDriverOptions` · `cassandraWarmTableDDL` — the Cassandra / ScyllaDB
warm-tier driver (peer: `cassandra-driver`). Inject a connected `Client`; OCC via a lightweight transaction
(`INSERT … IF NOT EXISTS` + token-fenced `UPDATE`/`DELETE … IF tok = ?`). `cassandraWarmTableDDL(keyspace, table?)`
returns the deploy-time `CREATE TABLE`.

### `@cloudbitmaps/roaring/mysql`

`MysqlWarmDriver` · `MysqlWarmDriverOptions` · `mysqlWarmTableDDL` — the MySQL / MariaDB warm-tier driver
(peer: `mysql2`). Inject a `mysql2` promise `Pool`; OCC via plain SQL (`INSERT` for create-if-absent →
`ER_DUP_ENTRY` on conflict; token-fenced `UPDATE`/`DELETE … AND token = ?` with an `affectedRows` check).
`mysqlWarmTableDDL(table?)` returns the deploy-time `CREATE TABLE` (pinned `utf8mb4_bin` so keys match
case-sensitively — see the driver SDK contract in CONTRIBUTING).

---

## Keeping this in sync

- The **sync test** ([`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts))
  parses the eleven barrel files (both package barrels + the nine driver subpaths in core) and asserts each
  exported name appears (backtick-wrapped) somewhere on this page — so **adding an export without documenting it
  breaks CI**. It also fails if a barrel introduces an `export *` (which would let names slip past the guard),
  keeping every export explicit; the one allowed exception is the flavor barrel's
  `export * from '@cloudbitmaps/core'`, because core's own barrel is parsed too.
- When you add/rename/remove a public export: update the relevant section **and** the
  [Complete export index](#complete-export-index) in the same change (this is part of the standard
  [per-phase docs step](../../CONTRIBUTING.md)).
- This page catalogs the surface; the tutorial-style walkthrough with runnable snippets lives in the
  [getting-started guide](../guide/getting-started.md), and _why_ the surface is shaped this way is in the
  decision log.
