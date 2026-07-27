# Roadmap

CloudBitmaps maps each 16-bit Roaring Bitmap chunk onto tiered, pluggable cloud storage — **hot** RAM LRU,
**warm** NoSQL/SQL deltas, **cold** immutable `.crbm` objects in an object store — so a set of hundreds of
millions of IDs lives in S3 at object-store prices instead of in RAM at RAM prices. The centerpiece is
**chunk-skipping intersection**: an `A ∩ B` fetches only the chunks that can possibly contribute, which is
what makes a serverless read cheap.

This page is a high-level view of what works today, what's proven to what degree, and where it's headed.
It's a living document, not a promise — see [the note at the bottom](#a-note-on-priorities).

## Table of contents

- [Where it stands](#where-it-stands)
- [Shipped today](#shipped-today)
- [Storage drivers](#storage-drivers)
- [The validated envelope — what's proven, and what isn't](#the-validated-envelope--whats-proven-and-what-isnt)
- [On the way to 1.0](#on-the-way-to-10)
- [Planned / exploring](#planned--exploring)
- [Deliberately not planned](#deliberately-not-planned)
- [A note on priorities](#a-note-on-priorities)

## Where it stands

**`0.1.0` is the first release line, and it is pre-1.0 on purpose.** `1.0` is earned by real-cloud cost
calibration, real adoption, and freezing the `.crbm` on-disk format (see
[On the way to 1.0](#on-the-way-to-10)) — until then the public API and the on-disk format stay evolvable.
Everything described under [Shipped today](#shipped-today) is implemented and covered by tests — unit,
property-vs-oracle, a deterministic fault-injecting simulator, conformance suites run against real backends
(or a faithful emulator), coverage-guided fuzzing of the untrusted-`.crbm` boundary, and mutation testing of
the highest-risk core modules.

Current install and publish status lives in the [README](../README.md) — this page deliberately doesn't
restate it, so the two can't drift. You install **one codec flavor** plus only the backend SDKs you use:

```bash
npm i @cloudbitmaps/roaring @aws-sdk/client-s3 @aws-sdk/client-dynamodb   # roaring on AWS
npm i @cloudbitmaps/roaring pg                                            # roaring on Postgres
```

`@cloudbitmaps/core` — the codec-agnostic engine and every storage driver, with **zero runtime
dependencies** — arrives transitively and is never installed directly.

## Shipped today

### The tiered engine

- **A real `remove()`.** Each chunk carries `adds` **and** `removes`; the effective set is
  `(cold ∪ warm.adds) \ warm.removes`. Deletion is a first-class operation, not an approximation.
- **Chunk-skipping intersection** — `intersect` / `intersectInto` align on effective chunk keys and fetch
  only cold chunks present in *every* operand, with bounded read concurrency and a bounded streaming window.
- **Bounded memory, always.** A hard LRU ceiling on hot chunks, a byte-aware cold-reader cache, bounded
  fan-out on every admin path, and a default-on per-operation **request budget** that fails with
  `BudgetExceededError` rather than quietly running up a bill. Since **0.3.0** that also covers the *enumerations* those bounds feed: a warm scan is capped by `maxWarmScanBytes` (independent of `budget`, and still enforced when `budget: false`), and every registry scan — including the DR consistency check — refuses at its ceiling instead of materialising the fleet. Before that, the per-op budget bounded fan-out but not the list it was computed from, so a tight budget could be exceeded in memory before it could refuse in requests.
- **Cheap counts.** `count()` sums per-chunk cardinality straight from the `.crbm` footer index for chunks
  with no warm delta, so a fully compacted segment counts with **zero payload reads**.
- **Bulk load** — build a cold generation from an unsorted sync or async ID stream, without holding the
  *input* in memory. Memory is bounded by the distinct result set, not the input length; a segment larger than
  RAM wants the external-merge bulk load listed under [Planned](#planned--exploring).

### Correctness under concurrency

- **Generation + per-chunk version fencing.** Cold objects are generation-keyed and **immutable**
  (`segment.<gen>.crbm` + a registry pointer) — never overwritten in place. Compaction purges warm rows
  *conditionally* on the version it archived, so a write racing a compaction survives.
- **Optimistic concurrency at every warm driver**, each held to the same shared conformance suite against a
  real backend — including ABA-safe tombstones and lossless compare-and-set.
- **A crash-safe compaction daemon** — two-phase commit (lease → pin → reconcile orphaned generations →
  merge cold ∪ warm → stage → verify → atomic pointer swap → version-fenced purge → superseded-generation
  GC), a stealable per-segment lease, poison-segment
  quarantine, and shardable, budgeted, urgency-ordered discovery. Run it one-shot for Lambda/cron
  (`CR_COMPACT_MODE=once compact-segments`) or as a loop for K8s/ECS. The shipped CLI is deliberately
  SDK-free and covers the local-filesystem backend; a cloud deployment calls `runCompactionCycle` from its own
  short handler. Crash-at-every-durable-step recovers to the oracle in tests.
- **A deterministic simulator** — a seeded RNG and scheduler gate every driver call, so a concurrency or
  fault-injection failure replays from its seed and becomes a committed regression.

### Security & data protection

- **All tier bytes are untrusted.** The safe Roaring deserializer behind a hard size cap, per-chunk /
  per-index / per-footer CRC32C, and field validation on every `.crbm` header — a corrupt or hostile object
  fails closed with a typed error instead of reaching the native addon trustingly.
- **Optional encryption at rest** — AES-256-GCM over the payload *and* the index (so metadata is hidden),
  envelope-wrapped per-segment DEKs under operator-held KEKs, AAD binding each ciphertext to its
  `(namespace, segment, generation, chunk)`, KEK rotation, and an offline recovery KEK. Keys stay in your
  process; no cloud KMS dependency is forced on you.
- **Crypto-shred erasure** — `destroySegment` / `eraseNamespace` discard the DEK for immediate, verifiable
  destruction, plus `subjectReport` (access) and `eraseSubject` (erasure) with a truthful return-value
  ledger.
- **Supply chain** — every GitHub Action SHA-pinned, a blocking dependency audit, npm **build provenance**
  on publish, and continuous coverage-guided fuzzing over the untrusted-`.crbm` boundary (nightly, plus a
  weekly deep run).
- Reporting: [`SECURITY.md`](../SECURITY.md). The trust boundary, retention/residency contracts, and a
  DPIA + Art. 30 template: [`PRIVACY.md`](../PRIVACY.md).

### Operating it

- **Observability without telemetry** — an injected metrics sink and a separate, off-by-default audit sink
  emitting compliance state changes. Nothing is sent anywhere by default; there is no phone-home.
- **Honest cost tooling** — `estimateCost` for planning and a grounded per-segment `costReport` from
  measured op counts, with a pluggable pricing profile that will tell you when CloudBitmaps *loses* to flat
  Redis. The published crossover chart is in [Benchmarks](benchmarks.md).
- **An exit path.** `exportSegments` and the `export-segments` CLI dump every segment to portable
  `roaring` / `ndjson` that is readable **without** this library, with per-segment fault isolation. If the
  project vanished tomorrow, nothing of yours is locked up.
- **Disaster recovery** — `checkConsistency` detects a torn restore or a missing cold generation, exercised
  end-to-end as a gated drill against the [DR runbook](guide/disaster-recovery.md).
- **Serverless-ready** — a hard cgroup-RSS ceiling in CI, an AWS Lambda / Amazon Linux 2023 deployability
  smoke test, and a prebuilt Lambda layer builder.

## Storage drivers

Every driver is held to the same shared conformance suite for its seam, run against a real backend (or a
faithful emulator) — an implementation isn't "done" until it passes.

| Tier | Backends |
| --- | --- |
| **Cold** (immutable objects) | S3 · Google Cloud Storage · Azure Blob Storage · local filesystem · in-memory |
| **Warm** (deltas, OCC) | DynamoDB · PostgreSQL · MySQL / MariaDB · Redis · MongoDB · Cassandra / ScyllaDB · local filesystem · in-memory |
| **Registry** (generation pointer, discovery) | DynamoDB · S3 · local filesystem · in-memory |

Two things worth knowing before you pick:

- **The warm and registry tiers are separate seams.** The registry's *cloud* implementations are DynamoDB
  and S3 only (plus local-filesystem and in-memory), so a non-AWS **cloud** deployment — say Postgres warm
  with GCS cold — still needs an S3 or DynamoDB registry for the compaction daemon. Native registries on the
  other cloud backends are post-`0.1.0`.
- **Some backends need specific settings to be durable** — most notably Redis, where the default eviction
  policy will silently drop warm deltas. Per-driver required settings are documented in
  [Getting started](guide/getting-started.md).

## The validated envelope — what's proven, and what isn't

We'd rather tell you the boundary than let you discover it. CloudBitmaps is **ready within a validated
envelope**:

| | Inside the envelope | Outside it (use with your own testing) |
| --- | --- | --- |
| **Workload** | read-mostly; hot + cold, warm deltas compacted by the daemon | write-heavy hot-spotting on a single chunk |
| **Scale** | up to ~100K segments; tens of millions of IDs per segment | billions of IDs in one segment (wants the reserved 64-bit format + external-merge bulk load) |
| **Backends** | S3 cold + DynamoDB warm/registry — the validated pair | the others (GCS, Azure Blob, Postgres, MySQL, Redis, Mongo, Cassandra, and the S3 registry): conformance-passing and correctness-clean, but not envelope-validated |
| **Tenancy / region** | single-tenant, single-region | multi-tenant isolation; multi-region active/active |
| **Cost figures** | **calibrated against real S3 + DynamoDB** (`us-east-1`, 2026-07-25) — published prices applied to wire-metered requests, with DynamoDB capacity from AWS's own `ConsumedCapacity`; plus the estimator and a LocalStack run, all with published methodology | the invoice itself (a tagged Cost Explorer reconciliation follows each run); **in-region latency** — the calibration client sat outside the region, so its latency figures are network-dominated |

Measured, not asserted: retained heap stays flat (~7–8 MiB) from 1K → 10K → 100K segments; compaction
discovery is `O(total segments)` today, not `O(dirty)`; a 50 M-ID single segment counts exactly, with the
Roaring containers held off-heap by the native addon. Benchmark numbers come with their methodology — we
never publish a figure we haven't measured, and laptop/emulator numbers are labeled as such.

## On the way to 1.0

`1.0` is a commitment to the on-disk format, so it waits for evidence rather than a date. What stands
between here and there:

1. **Real-cloud calibration — done, both halves.** Cost:
   [$0.001911 measured](benchmarks.md#real-cloud-calibration--aws) for 2,000 writes + 20 publishes + 2,000 reads
   on real S3 + DynamoDB. Latency: the first client sat ~96 ms of internet away, so its figures measured network
   transit rather than the engine; a
   [second run from inside `us-east-1`](benchmarks.md#in-region-latency--measured-2026-07-27) puts a warm
   `has()` at **p50 5.27 ms / p99 12.71 ms** (n=2,000), inside the single-digit-to-~25 ms target. What remains
   here is narrower than it was: a **Lambda** run, for the serverless figure with cold-start and init included.
2. **`.crbm` format freeze** — the format already reserves space for 64-bit IDs and stamps a schema version
   on warm deltas and the registry; freezing it is what makes cross-language ports and long-lived data safe.
3. **Adoption feedback** — real deployments finding the sharp edges that our own tests don't.
4. **Closing the named deferrals:** an `O(dirty)` discovery cursor instead of today's `O(total segments)`
   scan, lease-aware publishing, per-segment write sharding, and self-healing disaster recovery.
   (Multi-tenant isolation is tracked separately, post-`1.0`.)

## Planned / exploring

None of these are committed and none have dates. If one matters to you,
[open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) and say so — that's the single best way to
move it up.

- **`analyze` — try it on your own data before adopting anything.** Point a command at a file of your IDs and it
  measures what actually matters (cardinality, compressed size, and above all **chunk density**), then tells you
  the topology, the write path, and the monthly cost that follow — **offline, with no cloud account and nothing
  created**. Today's cost tooling can only answer that once you're already a user, which is backwards. It would
  also answer whether you need the native Roaring addon at all: if your IDs compress no better than a plain
  bitset, you can skip it and deploy to edge runtimes.
- **Multi-region active/active** — region-local by design for the `1.0` line; not ruled out beyond it.
- **A generic `bitmap` flavor** (`@cloudbitmaps/bitmap`) — the same cloud engine behind a plain bitset codec
  instead of Roaring. The codec seam that makes this a drop-in already exists; this is the committed
  fast-follow after `1.0`, on validated demand.
- **Native registry drivers** for GCS, Azure, Postgres, and Redis, so a non-AWS deployment can run the
  compaction daemon without an AWS dependency.
- **The billions-of-IDs axis** — 64-bit IDs (space is already reserved in the format) plus an external-merge
  bulk load that never buffers the dirty set.
- **Language ports** — Go, Python, Rust reading and writing the same `.crbm` objects. Strictly *after* the
  format freeze; a port before then would be a compatibility trap.
- **Cheaper reads** — a warm-chunk cache and coalesced merge GETs, both scoped so they can't tax the hot
  path.

## Deliberately not planned

Saying no is part of the design:

- **A hosted/managed CloudBitmaps service.** Never — this is a library. Your data stays in your account, in
  your buckets, under your keys.
- **Telemetry or phone-home.** Nothing is ever sent to us. Observability is an injected sink you own.
- **An `id → segments` reverse index.** It would cost roughly 2× write amplification and a second inverted
  copy of all your data — paid on every write, to speed up a rare subject-access request. `subjectReport`
  scans instead. It could return as an opt-in add-on if a real deployment needs sub-second lookups at
  billion scale.
- **Reimplementing the bit math.** CloudBitmaps wraps `roaring-node`/CRoaring. The cloud tiering is the
  contribution; the container algorithms are not ours to re-invent.
- **Any feature that taxes the hot path** (`add` / `has` / `remove` / `count` / `intersect`) to speed up a
  rare operation. If it can't be pushed to wiring time, the daemon, an admin call, or the docs, it doesn't
  ship.

## A note on priorities

CloudBitmaps is built in the open by one maintainer, so priorities can and will shift, and nothing here is a
schedule or a commitment. The best way to influence what gets built next is to
[open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) — to discuss a use case, report a bug, or
tell us something behaved wrong. Contributions are welcome: start with
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
