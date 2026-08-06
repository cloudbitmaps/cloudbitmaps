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

### Get a segment — `store.segment(name, { namespace?, expiresAt? })` → `Segment`

`expiresAt` is an absolute epoch-**milliseconds** deadline, declared where the segment is named. Past it, every
read through **that handle** answers empty — `has` → `false`, `count` → `0`, `iterate` → nothing — as one integer
compare against the injected clock, with **no I/O, on every backend**. Set algebra stays coherent with it: an
expired operand makes an `intersect` empty, is dropped from a `union`, and excludes nothing in an `andNot`.

It does **not** reclaim the bytes (`retireExpired` does, so `count()` reporting 0 while rows still exist is the
expected state in that window) and it does **not** apply to other handles — record the policy with
`setRetention` to make it durable, fleet-visible and reclaimable. A seconds-shaped value is refused at the
handle rather than silently making the segment permanently empty. `seg.expiresAt` reads it back.

### The segment verbs (the ~90% of daily use)

| Call | Does |
|---|---|
| `seg.add(id)` · `seg.addMany(ids)` | add member(s); `addMany` takes a **sync or async** iterable and groups by chunk (one write per chunk, however long the stream) |
| `seg.remove(id)` · `seg.removeMany(ids)` | remove member(s) — single-chunk tombstone, no scan |
| `seg.claimMany(ids)` → `number[]` | **atomically claim ids: add them and return only the ones not already present.** The durable analogue of Redis `SETBIT` returning the prior bit — what exactly-once *"already sent to this id?"* needs, which `has()` + `add()` cannot give you. One OCC write per **chunk**, not per id. Exactly-once holds per id; like `addMany` it is not atomic across chunks, and re-running is safe |
| `seg.has(id)` → `Promise<boolean>` | membership test |
| `seg.count()` → `Promise<number>` | exact cardinality (cheap — from the cold index) |
| `seg.iterate()` → `AsyncIterable<number>` | stream all ids, ascending |
| `seg.intersect([other, …], { concurrency?, exclude? })` → `AsyncIterable<number>` | **the crown jewel** — chunk-skipping intersection, streamed. `exclude` subtracts suppression segments **in the same pass** |
| `seg.union([other, …], { concurrency?, exclude? })` → `AsyncIterable<number>` | `this ∪ others`, streamed. The one composite with **no chunk-skipping** — every chunk of every operand is read |
| `seg.andNot([sup, …], { concurrency? })` → `AsyncIterable<number>` | `this \ (sup…)`. Reads all of `this`, but each exclude **only where it overlaps** |
| `seg.intersectInto` · `seg.unionInto` · `seg.andNotInto` `(dest, …, { batchSize? })` → `Promise<void>` | materialize the result **into** another segment |

That's the whole daily surface: **1 constructor + pick 3 drivers + these verbs.**

**Which chunks each combine has to read** — this is the cost model, and it is a property of the set operation
rather than of the implementation:

| | chunks read | can skip? |
| --- | --- | --- |
| `intersect` | keys present in **every** operand | **yes** — the crown jewel |
| `andNot` (`a \ s`) | every chunk of `a`; `s` **only where it overlaps `a`** | partly — the suppression side |
| `union` | every chunk of **every** operand | no — an id in any operand belongs to the result |

All three are charged against the same per-op budget, so a wide union is refused rather than quietly billed.

> **To suppress the result of an intersection, do not chain.** `a.intersect([b], { exclude: [s] })` folds the
> subtraction into one pass; `intersectInto` a temp segment followed by `andNot` materializes an intermediate
> nobody wants — and reads `s` in full rather than only where it overlaps.

---

## Operations you call when you need them

### Store methods

| Call | Does |
|---|---|
| `store.subjectReport(id, { namespace? \| allNamespaces?, concurrency?, budget? })` → `SubjectReport` | GDPR Art. 15 — which registered segments is this id in? (needs an explicit namespace or an `allNamespaces` ack) |
| `store.eraseSubject(id, { owner, namespace? \| allNamespaces?, audit?, concurrency?, budget? })` → `EraseSubjectResult` | GDPR Art. 17 — remove an id everywhere + physically purge; returns a proof ledger |
| `store.compact(ref, { owner, leaseMs?, audit? })` → `CompactionResult` | fold warm deltas into a fresh cold generation (usually the daemon does this) |
| `store.dropSegment(ref, { confirmSegment, dryRun?, audit? })` → `DropResult` | **retire a segment and reclaim its storage** — tombstone + Warm rows + Cold generations (re-swept; **check `generationsRemaining`** — non-empty means bytes survived and the drop should be re-run). Branch on `dropped`; `reason` is `'warm-only'` for an accumulator segment (no registry row, no Cold — retired by clearing Warm; a segment carrying a **retention policy** has a row, so it takes the ordinary tombstoned path instead), `'already'` if tombstoned, `'absent'` only when **nothing existed**, which is the one worth alerting on. Needs a raw cold driver + registry. Reads become empty within `coldGenTtlMs`, for a reader that has a clock. `dryRun` previews `wouldDelete` / `wouldDeleteWarmRows` / `wouldCryptoShred` without touching anything |
| `store.setRetention(ref, { expiresAt })` → `SetRetentionResult` | **record when this segment becomes eligible for retirement** — one registry write, nothing deleted, nothing scheduled. `expiresAt` is an absolute epoch-**ms you compute** (a duration the library derived would be anchored to `updatedAt`/`currentGen`, both of which compaction rewrites, so a busy segment would never expire). On an accumulator it mints the registry row (`createdRow: true`) with **no Cold generation**, which is what makes the segment enumerable — and therefore sweepable — without changing any read. Rejects a value below `MIN_EXPIRES_AT_MS` (almost certainly epoch *seconds*, which would read as already-expired) and refuses a crypto-shredded segment |
| `store.getRetention(ref)` → `RetentionPolicy \| null \| 'invalid'` | the stored policy; `null` for none, `'invalid'` for a present-but-unusable `expiresAt` (a hand-edited row, a restore) so a malformed policy is visible rather than reading as "never expires" |
| `store.clearRetention(ref)` → `boolean` | cancel the expiry; returns whether one was actually removed. A separate verb from setting one on purpose — "never expire" as a magic value passed to the setter is how a typo becomes a deletion |
| `store.retireExpired({ namespace?, now?, limit?, dryRun?, maxScanSegments?, purgeTombstones?, tombstoneGraceMs?, audit? })` → `RetireExpiredResult` | **the retention sweep** — retire every segment whose `expiresAt` has passed, each through `dropSegment` (one implementation of the Warm → registry → Cold ordering, not two). **A call, not a daemon**: you schedule it (EventBridge, CronJob, cron, a queue job), and from **one** process — there is no shard option. Returns a per-segment ledger; a per-segment *fault* is an `entries` row rather than a throw, though a bad argument throws `ValidationError` and a fleet past `maxScanSegments` throws `BudgetExceededError`. `limit` (default 100) caps **attempts**, so a partial outage cannot march through the fleet; `limited: true` means more are eligible, re-run. `dryRun` is the real preview (`confirmSegment` is vacuous in a loop) and reports `wouldRetire`, leaving `retired` at 0. Retirements are sequential (~8 round trips each), so `limit` is also a wall-clock knob. Also deletes the tombstone rows **it stamped itself**, after `tombstoneGraceMs` (default 24 h) and only once Warm and Cold are provably empty (collecting a straggler generation first); a `destroyed` row it did not create — a GDPR crypto-shred — is never touched. Needs a raw cold driver + registry |
| `store.checkConsistency({ namespace?, concurrency? })` → `ConsistencyReport` | DR: verify every segment's `currentGen` `.crbm` is present (catch a torn cross-tier restore) |
| `store.exportSegments(sink, { format?, namespace?, candidates? })` → `ExportManifest` | eject every segment to portable `roaring`/`ndjson` |
| `seg.costReport({ pricing?, workload?, topology? })` → `CostReport` | grounded $ cost for this segment (from its real cold size) |
| `CloudRoaring.estimateCost(input)` → `CostReport` | **static** — plan costs with no instance/data (sizing, what-if) |
| ↳ `report.advisories` → `readonly CostAdvisory[]` | **self-relative** hints (empty is normal) — where this workload pays more than *this library* would charge for the same outcome; `verdict` only compares against Redis |

### Standalone functions (imported, called directly)

| Call | Does |
|---|---|
| `bulkLoadCrbmGeneration(cold, { segment, generation }, ids, { registry })` → `BulkLoadResult` | seed a cold generation from a (huge, unsorted) id stream |
| `destroySegment(…)` → `DestroyResult` | crypto-shred one whole segment (key deleted → bytes unrecoverable); leaves the objects in the bucket, needs encryption |
| `dropSegment(ref, { registry, warm, cold }, { confirmSegment, dryRun? })` → `DropResult` | **dispose of a segment** — tombstone + delete Warm rows + delete every Cold generation. Works on cleartext; also crypto-shreds an encrypted one. `store.dropSegment` is the wired form |
| `eraseNamespace(…)` | crypto-shred an entire namespace / tenant |
| `runCompactionCycle(deps, { owner, keep })` | one compaction pass — for a custom compaction worker (the CLI wraps this) |
| `drainRegistry(registry, { namespace?, maxScanSegments, op })` → `RegistryRecord[]` | the one bounded drain of `registry.list()` — shared by `checkConsistency` and `retireExpired`; refuses past the ceiling rather than exhausting memory |
| `runConsistencyCheck({ cold, registry }, { namespace?, concurrency? })` → `ConsistencyReport` | the free-function behind `store.checkConsistency` — run it over your own drivers |
| `setSegmentRetention(ref, { registry }, { expiresAt })` → `SetRetentionResult` | the free-function behind `store.setRetention` — for a scheduler/CLI that holds only a registry driver. `getSegmentRetention` / `clearSegmentRetention` are its read/cancel siblings |
| `readRetentionPolicy(record.retention)` → `RetentionPolicy \| null \| 'invalid'` | parse a policy out of a row you already have (a `list()` sweep does this — no extra read per segment) |
| `retireExpired({ registry, warm, cold }, { now, … })` → `RetireExpiredResult` | the free-function behind `store.retireExpired` — for a scheduled worker that wires its own drivers. `now` is explicit here (core takes its time from the caller) |
| `runLeaseCycle(state, { registry, clock }, { owner, partitions?, ttlMs? })` → `LeaseCycleResult` | **partition leases** — one cycle of the coordination protocol that lets N processes run the *same* maintenance code with no coordinator and no per-process config. Renews what you hold, claims what is free or dead, and takes at most **one** partition from an over-share owner (toward `ceil(partitions/workers)`, and never leaving a worker below `floor(partitions/workers)` — stealing only from an owner over the *ceiling* starves a late joiner permanently, and stealing from anyone over the *floor* oscillates forever). Liveness is decided by whether the row's OCC **token** moved since you last looked — never by comparing `leaseExpiresAt` against your own clock, which would make clock skew a correctness bug. Carry the returned `state` into the next cycle; anything in `lost` you must stop working on **immediately**. `held` is what *this worker believes*, not a mutual-exclusion guarantee: a rebalance takes a live lease and its previous holder only finds out at its next renew, so the conditional write at the resource is what actually prevents two workers committing. `sinceLastCycleMs` greater than `ttlMs` means you are polling too slowly and your own leases are being judged dead |
| `releaseAll(state, { registry })` → `{ released, state }` | release every held lease on a graceful stop, so the next worker picks the partition up on its next cycle instead of waiting out `ttlMs`. Best-effort: a failed release is not an error, because the TTL is the backstop. **Returns the emptied state** — use it, or a trailing in-flight cycle re-takes everything you just gave up |
| `emptyLeaseState()` → `LeaseState` | the starting state for a fresh worker |
| `leaseRef(partition)` / `partitionOfLeaseRow(segment)` | the registry ref for a partition's lease row, and its inverse (`null` for any row we did not write — a foreign row in the reserved namespace is ignored, never adopted) |
| `leaseRenewIntervalMs(ttlMs?)` → `number` | how long to wait between cycles: a third of the TTL, so one lost round trip is survivable |
| `isReservedRow(record)` / `excludingReservedRows(listing)` | the coordination-row filter, as a predicate and as a stream wrapper. **Every unscoped fleet-wide enumeration must apply one of them** — a lease is not a segment. Both are exported because a caller writing their own fleet pass needs the same filter, not a second definition (the first cut of this had three call sites missed, including `subjectReport`, where the rows consumed an Art. 15 request's budget) |
| `dueBucket(expiresAt)` · `dueNamespace(bucket)` · `dueBucketsAt(now, lookbackBuckets)` | **the due index** — a time-bucketed set of the segments that carry an expiry, so a retention cycle costs what is *expiring* rather than what the fleet *holds*. A bucket is a **day index** (`Math.floor(expiresAt / 86_400_000)`) and becomes a namespace, because `list()` filters by namespace and nothing else — that single constraint is what shapes the design. `dueBucketsAt` includes past buckets so a sweep that did not run leaves nothing stranded, bounded by `lookbackBuckets` so a long outage costs a bounded number of list calls |
| `dueIndexRef(bucket, ref)` · `encodeDueName(ref)` · `decodeDueName(name)` · `canIndex(ref)` · `isDueIndexRow(record)` | the pointer rows. A name is `${namespaceLength}.${namespace}${segment}` — **length-prefixed, not delimited**, because every character the grammar allows is legal *inside* a name, so no separator could be unambiguous. `canIndex` is false only for a ref whose encoding would exceed the 256-character cap; that is **not an error and not "never retired"** — the repair scan still sees the segment's own row, so it expires on the repair cadence instead of the fast one |
| `DUE_NAMESPACE_PREFIX` · `DUE_BUCKET_MS` · `MAX_NAME_LENGTH` | `cbm.due.` · one day · 256. **The index is a fast path, never the source of truth**: the sweep re-reads the live segment row before acting, so a stale pointer is a wasted read and nothing worse, and the full `registry.list()` scan remains as a periodic **repair** pass, so a missing pointer is slower, never never |
| types: `LeaseState` · `LeaseOptions` · `LeaseDeps` · `LeaseCycleResult` | the carried-between-cycles state, the per-worker options (`owner` must differ between live processes), the two ports the protocol needs (`registry` + `clock`), and the cycle's report (`held` · `claimed` · `lost` · `stolen` · `workers` · `target`) |

### Optional plug-ins you construct and pass in

| Construct | Pass as | For |
|---|---|---|
| `new InProcessKeystore({ keys, activeKeyId })` | `keystore` | encryption-at-rest + crypto-shred (BYOK) |
| `new CountingMetricsSink()` (or your own `IMetricsSink`; `NOOP_METRICS` is the default) | `metrics` | observability — cold/warm/cache/retry/latency events |
| `new RecordingAuditSink()` (or your own `IAuditSink`; `NOOP_AUDIT` is the default) | `audit` (on erase/compact/bulk-load) | compliance trail — publish/compact/erase events |

### CLIs (run as binaries, env-configured)

| Binary | Does |
|---|---|
| `compact-segments` | run compaction once or in a loop (`CR_COMPACT_*`, plus `CR_RETIRE*` for the opt-in retention sweep) |
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

### Combine options (used to type `intersect` / `union` / `andNot`)

`BaseCombineOptions` · `CombineOptions` · `CombineIntoOptions`

---

## Advanced / driver-author surface

You **do not** import these to _use_ CloudBitmaps — only to **write a driver**, build tooling against the
on-disk format, or run out-of-process operations. This distinction is **docs-level by design**: a
separate `advanced` subpath split was considered and **deliberately not built** (marginal payoff, real cost,
net-new surface), so everything here still imports from the single
`@cloudbitmaps/roaring` barrel.

### `.crbm` on-disk format

**`CRBM` stands for Chunked Remote BitMap** — chunked because 16-bit chunks are the data model, remote because
every structural choice exists for storage that is far away and billed per request (range-GET a single chunk,
`count()` straight from the footer index without reading payloads, a speculative tail read that collapses `open()`
to one GET), and bitmap because that is what a chunk holds.

The name is deliberately **not** tied to a codec. `.crbm` is the shared container for every flavor — the footer
index, the CRC32C checksums, the AES-GCM framing and the generation model are all codec-independent, and only the
chunk payload bytes differ. A future `@cloudbitmaps/bitset` writes the same format.

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
different codec (the `@cloudbitmaps/bitset` / `@cloudbitmaps/soaring` flavors) — the `CloudRoaring` facade injects
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
| `DEFAULT_MAX_SCAN_SEGMENTS` | default ceiling (250,000) on registry records one `checkConsistency` holds resident — raise via its `maxScanSegments` option |
| `DEFAULT_MAX_WARM_SCAN_BYTES` | default ceiling (64 MiB) on the warm-delta bytes one segment scan may hold resident — see `maxWarmScanBytes` |
| `DEFAULT_WRITE_CONCURRENCY` | default number (4) of warm chunk writes in flight per `addMany`/`removeMany` — see `writeConcurrency` |
| `DEFAULT_RETIRE_LIMIT` | default cap (100) on segments one `retireExpired` cycle **attempts** — `limited: true` when it bites |
| `DEFAULT_TOMBSTONE_GRACE_MS` | default delay (24 h) before the sweep deletes a tombstone row it stamped itself |
| `LEASE_NAMESPACE` | the reserved registry namespace (`cbm.leases`) holding one row per partition. Excluded from every **unscoped** fleet-wide drain — a lease is not a segment. Do not use it for your own segments |
| `DEFAULT_LEASE_TTL_MS` | default partition-lease TTL (60 s). A holder renews at a third of it, so two renewals may be missed before it looks dead |
| `DEFAULT_PARTITIONS` | default partition count (**1**). The registry scan is not partitioned, so N workers each still list the fleet — partitions buy work throughput, not scan cost. Raise it when per-segment work dominates |
| `MAX_PARTITIONS` / `MIN_LEASE_TTL_MS` / `LEASE_RENEW_DIVISOR` | the bounds: 1,024 partitions (a cycle reads one row each), a 1 s TTL floor (below it, an ordinary GC pause reads as death), and 3 renewals per TTL |
| `MIN_EXPIRES_AT_MS` | floor (1,000,000,000,000 — 2001-09-09) on `expiresAt` **and** on the sweep's `now`: anything smaller is almost certainly epoch *seconds*, which reads as already-expired |
| `collectWithinBudget` | drain an async iterable into an array, refusing **as soon as** the budget is exceeded rather than after — so resident memory is `O(budget)`, not `O(source)` |
| `validateSegmentRef` | boundary validation of a `SegmentRef` (untrusted-input posture) |

### Driver kit — what you need to *implement* a driver

| Symbol | What it does |
|---|---|
| `NO_ROW` | the create-if-absent sentinel every `IWarmDriver.putConditional` compares `expected` against (a `Symbol.for` registry symbol, so it stays identical across bundles) |
| `NoRow` · `Token` · `WarmRow` · `WarmReadOptions` | the warm-tier row/token/read-option shapes in `IWarmDriver` |
| `chunkRefKey` · `segmentKey` | the canonical key-string helpers (used by the conformance suite + fake drivers) |

**`currentGen` is nullable, and `null` is a value — not a missing field.** A `RegistryRecord` with
`currentGen: null` says *this segment exists and has no Cold generation yet*: the shape of a **warm-only
accumulator** (written to, never bulk-loaded, never compacted) that has a row purely so fleet-wide operations —
`checkConsistency`, `eraseNamespace`, compaction discovery, retention sweeps — can see it at all. Resolution maps
it onto the same path a segment with no row takes, so Cold contributes the empty set and the Warm delta alone
answers the read. An `IRegistryDriver` must therefore:

- round-trip `null` through `create`, `compareAndSwap`, `get` **and** `list` — serialization is where it gets
  silently dropped (`JSON.stringify` keeps `null` but omits `undefined`) or coerced to `0`, which is the
  forbidden `missing-cold-generation` state;
- apply a patch that sets `currentGen: null`, and leave the stored value alone when a patch omits the field. The
  trap is merging with `patch.currentGen ?? previous`, which treats a deliberate `null` as absent and silently
  keeps pointing at the old generation — use an own-property check (`'currentGen' in patch`);
- keep `status: 'active'` meaningful for such a row: a null pointer is a **live** segment, not a tombstone.

Conformance case **R8** gates all of the above; every first-party registry driver passes it.

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
| `DropDeps` | `EraseDeps` plus `cold` — `dropSegment` deletes the objects, so it needs the cold driver |

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
· `runCompactionCycle` · `findCompactable` · `gcOrphanGenerations` · `destroySegment` · `dropSegment` · `eraseNamespace` ·
`InProcessKeystore` · `NodeAead` · `aadFor` · `SafeBitmap` · `roaringCodec` · `withRetry` · `isTransient` ·
`SegmentEngine` · `BoundedLru` · `safeMetrics` · `groundedReport` · `validateCompactionOptions` · `runExport` ·
`splitId` · `joinId` · `mapWithConcurrency` · `resolveBudget` · `resolvePerOpBudget` · `checkBudget` ·
`collectWithinBudget` · `DEFAULT_MAX_WARM_SCAN_BYTES` · `DEFAULT_WRITE_CONCURRENCY` · `DEFAULT_MAX_SCAN_SEGMENTS` ·
`validateSegmentRef` · `NO_ROW` · `chunkRefKey` · `segmentKey` ·
`setSegmentRetention` · `getSegmentRetention` · `clearSegmentRetention` · `readRetentionPolicy` ·
`MIN_EXPIRES_AT_MS` · `retireExpired` · `DEFAULT_RETIRE_LIMIT` · `DEFAULT_TOMBSTONE_GRACE_MS` ·
`drainRegistry` · `validateMaxScanSegments` ·
`runLeaseCycle` · `releaseAll` · `emptyLeaseState` · `leaseRef` · `partitionOfLeaseRow` · `leaseRenewIntervalMs` ·
`LEASE_NAMESPACE` · `DEFAULT_LEASE_TTL_MS` · `DEFAULT_PARTITIONS` · `MAX_PARTITIONS` · `MIN_LEASE_TTL_MS` ·
`LEASE_RENEW_DIVISOR` · `isReservedRow` · `excludingReservedRows` ·
`dueBucket` · `dueBucketsAt` · `dueNamespace` · `dueIndexRef` · `encodeDueName` · `decodeDueName` ·
`canIndex` · `isDueIndexRow` · `DUE_NAMESPACE_PREFIX` · `DUE_BUCKET_MS` · `MAX_NAME_LENGTH` ·
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
`Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `InProcessKeystoreOptions` · `EraseDeps` · `DropDeps` · `DestroyResult` · `DropResult` ·
`RetentionPolicy` · `RetentionDeps` · `SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` · `RetireEntry`
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
