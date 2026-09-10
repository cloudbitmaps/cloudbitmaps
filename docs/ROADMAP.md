# Roadmap

CloudBitmaps is a **loaded store** for Roaring Bitmaps on object storage. A set of hundreds of millions of IDs
is computed upstream, loaded as an immutable `.crbm` **generation** into S3 (or GCS, Azure Blob, a local disk),
and read from anywhere — `has`, `count`, `iterate`, and the centerpiece, **chunk-skipping intersection**: an
`A ∩ B` fetches only the 16-bit chunks that can possibly contribute, which is what makes a serverless read
cheap. The set lives at object-store prices instead of RAM prices; a bounded in-process LRU keeps the chunks a
process actually touches hot.

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
property-vs-oracle, conformance suites run against real backends (or a faithful emulator), coverage-guided
fuzzing of the untrusted-`.crbm` boundary, and mutation testing of the highest-risk core modules.

**Where it is headed (September 2026).** `1.0` centres on the **loaded store**: sets are computed upstream and
loaded as immutable generations, then read and chunk-skipping-intersected from anywhere — one bucket, one
registry row per segment, no background process. The **live tier** — per-call `add`/`remove` over a warm NoSQL
store, the compaction that folded those deltas into cold, and the partition leases that scheduled it — has left
this line in two steps. The first removed the lifecycle engine and the five non-AWS warm drivers; the second
(D2) removed the warm tier as a whole: the DynamoDB warm driver, compaction, the write verbs, and the write side
of the cost model. All of it is archived intact at the git tag `archive/live-warm-tier`, and `0.9.x` stays on
npm as the last line with a warm tier. Every roaring-based engine that needs freshness micro-batches into
immutable segments rather than mutating a stored bitmap per call; that is the shape this library builds. A
future live tier, if there is demand, would be immutable delta generations on the same bucket.

Where each piece sits today:

| | Status |
| --- | --- |
| Loads, reads, chunk-skipping combines, `*Into` materialisation, subject erasure as a rewrite, crypto-shred, disposal, retention, the DR check, export | **shipped** — [below](#shipped-today) |
| The live (warm) tier | **removed in D2**, archived at the git tag `archive/live-warm-tier` |
| Loaded-store benchmarks — load throughput, intersect latency, RSS soak | **owed**. The measured numbers on the [benchmarks page](benchmarks.md) are the S3-side figures of the July 2026 calibration run |
| The R11 empty guard and `load()` with `allowEmpty` / `guard` / rollback — covering the `*Into` verbs too | **next** |
| A public docs + site pass leading with the loaded store's strengths | **next** |
| WASM CRoaring research | **after** the loaded store |

Current install and publish status lives in the [README](../README.md) — this page deliberately doesn't
restate it, so the two can't drift. You install **one codec flavor** plus only the backend SDKs you use:

```bash
npm i @cloudbitmaps/roaring @aws-sdk/client-s3 @aws-sdk/client-dynamodb   # roaring on AWS: S3 cold + DynamoDB registry
```

`@cloudbitmaps/core` — the codec-agnostic engine and every storage driver, with **zero runtime
dependencies** — arrives transitively and is never installed directly.

## Shipped today

### The loaded store

- **One write path: the load.** `bulkLoadCrbmGeneration` builds a generation from an unsorted sync **or async**
  ID stream without holding the *input* in memory (memory is bounded by the distinct result set, not the input
  length), writes it as one write-once object, verifies it, and publishes it **forward-only** — a CAS on the
  registry pointer that never moves backwards. A segment larger than RAM wants the external-merge bulk load
  listed under [Planned](#planned--exploring).
- **Chunk-skipping intersection** — `intersect` aligns on chunk keys and fetches only the chunks present in
  *every* operand, with bounded read concurrency and a bounded streaming window.
- **Composable set reads** — `union`, `andNot`, and an `exclude` option on `intersect` that folds suppression
  into the same chunk-aligned pass, so `(a ∩ b) \ suppression` needs no intermediate segment. Each operation is
  honest about what it can skip: `intersect` prunes any key missing from an operand, `andNot` reads the
  suppression side only where it overlaps, and `union` can prune nothing at all — all three budgeted alike.
- **Materialised results.** `intersectInto` / `unionInto` / `andNotInto` write the result as a **new generation
  of a destination segment** — the destination is superseded, not appended to — and return
  `MaterializeResult { generation, cardinality, chunkCount, size }`. An empty result publishes an empty
  generation today; the guard for that is [next](#on-the-way-to-10).
- **Cheap counts.** `count()` sums per-chunk cardinality straight from the `.crbm` index, so a segment counts
  with **zero payload reads**.
- **Bounded memory, always.** A hard LRU ceiling on hot chunks, a byte-aware cold-reader cache, bounded fan-out
  on every admin path, and a default-on per-operation **request budget** that fails with `BudgetExceededError`
  rather than quietly running up a bill. Every registry scan — the DR consistency check, the retention sweep,
  the subject scans — refuses at its ceiling (`maxScanSegments`) instead of materialising the fleet.
- **Immutable, generation-keyed objects.** `segment.<gen>.crbm` + one registry pointer, never overwritten in
  place. `nextGeneration` picks the next number past both the pointer and whatever is in the bucket, so a crashed
  load's orphan cannot block a retry; `gcOrphanGenerations` collects superseded generations behind a grace window
  for in-flight readers.
- **A co-operative bulk-load.** Node has one thread, and building a generation is the one operation here that
  genuinely occupies it for a while. It hands the event loop back periodically, so a 1M-id load runs in ~19 ms
  slices instead of blocking everything on the instance for 450 ms straight — a co-resident server keeps
  answering. On by default; see "what blocks the event loop" in [getting started](guide/getting-started.md).

### Security & data protection

- **All stored bytes are untrusted.** The safe Roaring deserializer behind a hard size cap, per-chunk /
  per-index / per-footer CRC32C, and field validation on every `.crbm` header — a corrupt or hostile object
  fails closed with a typed error instead of reaching the native addon trustingly.
- **Optional encryption at rest** — AES-256-GCM over the payload *and* the index (so metadata is hidden),
  envelope-wrapped per-segment DEKs under operator-held KEKs, AAD binding each ciphertext to its
  `(namespace, segment, generation, chunk)`, KEK rotation, and an offline recovery KEK. Keys stay in your
  process; no cloud KMS dependency is forced on you.
- **Subject erasure as a rewrite.** `eraseSubject` finds every registered segment an id is in, rewrites each
  one's current generation without the id (one chunk in flight, one bit cleared), publishes it forward-only,
  and deletes the generation that held the bit before returning — **physical deletion on return**, with a
  per-segment ledger and a `segment.rewrite` audit event. `subjectReport` is the read side (access). What a
  rewrite cannot reach — backups, replicas, noncurrent versions — is what crypto-shred is for.
- **Crypto-shred erasure** — `destroySegment` / `eraseNamespace` discard the DEK for immediate, verifiable
  destruction that survives immutable backups and WORM.
- **Segment disposal** — `store.dropSegment` retires a segment and *reclaims its storage*: tombstone first, then
  every Cold generation, so a failure part-way leaves orphaned bytes and never a wrong answer. Works on
  cleartext (crypto-shred needs a key); on an encrypted segment it does both. `dryRun` previews. This is the
  retention **primitive**, and it exists so the ordering cannot be got wrong by a caller — record an `expiresAt`
  and `retireExpired` (below) drives it for you.
- **Segment-level retention** — `store.setRetention(ref, { expiresAt })` records *when* a segment becomes
  eligible for retirement, and `store.retireExpired()` is the sweep that acts on it, retiring each expired
  segment through `dropSegment` so the ordering above is inherited rather than reimplemented. The expiry is an
  **absolute instant the writer sets**, because every anchor the library could derive one from (`updatedAt`, the
  current generation) moves on every load — a daily bucket reloaded each morning would have its expiry pushed
  forward by the very refresh meant to keep it current. The sweep is bounded (`limit`, `maxScanSegments`),
  previewable (`dryRun`), shardable across replicas, reports a per-segment ledger instead of throwing, and
  cleans up the tombstone rows its own retirements leave. Setting a policy before the first load mints the
  registry row, so the policy is recorded ahead of the data.
- **Supply chain** — every GitHub Action SHA-pinned, a blocking dependency audit, npm **build provenance**
  on publish, and continuous coverage-guided fuzzing over the untrusted-`.crbm` boundary (nightly, plus a
  weekly deep run).
- Reporting: [`SECURITY.md`](../SECURITY.md). The trust boundary, retention/residency contracts, and a
  DPIA + Art. 30 template: [`PRIVACY.md`](../PRIVACY.md).

### Operating it

- **Observability without telemetry** — an injected metrics sink and a separate, off-by-default audit sink
  emitting compliance state changes. Nothing is sent anywhere by default; there is no phone-home.
- **Honest cost tooling** — `estimateCost` for planning and a grounded per-segment `costReport` from the
  segment's measured size, with a pluggable pricing profile that will tell you when CloudBitmaps *loses* to flat
  Redis. The crossover is a **read rate** at a given cache-hit rate, plus a loads term you size yourself. The
  published crossover chart is in [Benchmarks](benchmarks.md).
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

| Store | Backends |
| --- | --- |
| **Cold** (immutable objects) | S3 · Google Cloud Storage · Azure Blob Storage · local filesystem · in-memory |
| **Registry** (generation pointer, discovery, wrapped keys) | DynamoDB · S3 · local filesystem · in-memory |

Two things worth knowing before you pick:

- **The registry's cloud implementations are DynamoDB and S3 only** (plus local-filesystem and in-memory), so a
  non-AWS **cloud** deployment — say GCS cold — still needs an S3 or DynamoDB registry. Native registries on the
  other cloud backends are on the list below.
- **A registry is optional only for a cleartext, read-only store**, which list-scans the bucket for the latest
  generation. Encrypted segments, the `*Into` verbs and every lifecycle helper need one.

## The validated envelope — what's proven, and what isn't

We'd rather tell you the boundary than let you discover it. CloudBitmaps is **ready within a validated
envelope**:

| | Inside the envelope | Outside it (use with your own testing) |
| --- | --- | --- |
| **Workload** | read-mostly over loaded generations; loads as a batch job (a cron, a pipeline step, a Lambda on a schedule) | anything that needs per-call mutation — there is no write verb; micro-batch into a load |
| **Scale** | up to ~100K segments; tens of millions of IDs per segment | billions of IDs in one segment (wants the reserved 64-bit format + external-merge bulk load) |
| **Backends** | S3 cold + DynamoDB registry — the validated pair | the others (GCS, Azure Blob, and the S3 registry): conformance-passing and correctness-clean, but not envelope-validated |
| **Tenancy / region** | single-tenant, single-region | multi-tenant isolation; multi-region active/active |
| **Cost figures** | the **S3-side figures of the July 2026 calibration run** (`us-east-1`, 2026-07-25) — published prices applied to wire-metered requests — plus the estimator, all with published methodology | the invoice itself (a tagged Cost Explorer reconciliation follows each run); **in-region latency** beyond the one `has()` run; and every loaded-store figure listed as owed below |

**Measured, not asserted — and measured on what.** The figures on the [benchmarks page](benchmarks.md) are the
S3-side figures of the July 2026 calibration run: the cost of the object-store requests the engine actually
issued, and the in-region latency of a `has()`. The read path they exercise — one chunk GET behind the hot
cache — is unchanged, so they still describe a loaded-store read. The write-side figures of that run described
the removed warm tier and are no longer quoted. What is **not** yet measured is the loaded store's own shape —
load throughput, `intersect` and `*Into` latency, RSS under a soak — and those are owed before `1.0`; until they
exist this page quotes no number for them. Benchmark numbers come with their methodology — we never publish a
figure we haven't measured, and laptop/emulator numbers are labeled as such.

## On the way to 1.0

`1.0` is a commitment to the on-disk format, so it waits for evidence rather than a date. What stands
between here and there:

1. **Real-cloud calibration — the read side is done.**
   [$0.001911 measured](benchmarks.md#real-cloud-calibration--aws) for the calibration run's requests on real
   S3 + DynamoDB, and an in-region `has()` inside the single-digit-to-~25 ms target. What remains: a **Lambda**
   run, for the serverless figure with cold-start and init included — and the loaded-store benchmarks below.
2. **Loaded-store benchmarks — owed.** Load throughput (ids/s and bytes/s into the bucket, single-part and
   multipart), `intersect` / `*Into` latency by operand count and chunk overlap, and an RSS soak over a long
   read/load mix. Until they exist, the measured numbers on the benchmarks page are the S3-side figures of the
   July 2026 calibration run, and this page says so wherever it quotes one.
3. **The R11 empty guard and `load()` — next.** A first-class `load()` on the store with `allowEmpty` (an empty
   result is refused unless you say so), a `guard` over the result before it is published, and rollback of a
   refused load. It covers the `*Into` verbs too, which today publish an empty generation when a combine comes
   out empty.
4. **A public docs + site pass leading with the loaded store's strengths.** The README, the guide and the site
   were written for a tiered engine and still explain the loaded store as what is left after a warm tier was
   removed. They should lead with what it is: one bucket, immutable generations, cheap chunk-skipping reads from
   anywhere.
5. **`.crbm` format freeze** — the format already reserves space for 64-bit IDs and stamps a schema version on
   the registry row; freezing it is what makes cross-language ports and long-lived data safe.
6. **Adoption feedback** — real deployments finding the sharp edges that our own tests don't.
7. **Closing the named deferrals:** self-healing disaster recovery, an exclusion predicate on the retention
   sweep (legal hold), and an automated reconcile of unstamped tombstones. (Multi-tenant isolation is tracked
   separately, post-`1.0`.)

## Planned / exploring

None of these are committed and none have dates. If one matters to you,
[open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) and say so — that's the single best way to
move it up.

- **`analyze` — try it on your own data before adopting anything.** Point a command at a file of your IDs and it
  measures what actually matters (cardinality, compressed size, and above all **chunk density**), then tells you
  the object size, the read cost and the monthly figure that follow — **offline, with no cloud account and
  nothing created**. Today's cost tooling can only answer that once you're already a user, which is backwards. It
  would also answer what the native Roaring addon is buying you on your particular ids &mdash; which is a real
  question, since the answer ranges from 543x to nothing.
- **Multi-region active/active** — region-local by design for the `1.0` line; not ruled out beyond it.
- ~~**A generic `bitset` flavor** (`@cloudbitmaps/bitset`)~~ — **decided against, 2026-07-31.** It was the most
  likely item on this list for months. Then we measured the thing it was for: above roughly **6% density a
  Roaring chunk already *is* an uncompressed bitset**, so a plain codec has no size to win — on the workload
  built to favour it, a flat bitset comes out **2%** ahead, while Roaring wins the other shapes by 543×, 63× and
  1.88×. The genuine advantage a flat bitset has is random access — one shift-and-mask against a container
  lookup, worth 7–77× in CRoaring's own benchmarks — but that is roughly **20 nanoseconds** inside an operation
  where we spend **5 milliseconds** reaching storage. It would have been a plausible wrong turn: chosen for dense
  ids, which is exactly where Roaring has already become the same bitset. The codec seam stays; nothing is queued
  to fill it.
- **Native registry drivers** for GCS and Azure, so a non-AWS deployment needs no AWS dependency.
- **The billions-of-IDs axis** — 64-bit IDs (space is already reserved in the format) plus an external-merge
  bulk load that never buffers the distinct set.
- **Language ports** — Go, Python, Rust reading and writing the same `.crbm` objects. Strictly *after* the
  format freeze; a port before then would be a compatibility trap. One concrete requirement a port must meet,
  new in 0.6.0: cold generations now contain **run containers**, which they never did before. Runs are part of
  the standard portable Roaring format, but a bitmap that has any announces itself with a different header
  cookie (`SERIAL_COOKIE` rather than `SERIAL_COOKIE_NO_RUNCONTAINER`). Every maintained Roaring
  implementation reads both; a hand-rolled or cut-down reader may only have been tested against the cookie our
  objects used to carry, so "it parses our `.crbm` files" is now a claim to re-verify rather than inherit.
- **Cheaper reads** — coalesced GETs for adjacent chunks, scoped so they can't tax the hot path.
- **WASM CRoaring — research, after the loaded store.** A WebAssembly build of CRoaring as a second codec would
  remove the native addon from the install story (prebuilt binaries, musl, from-source builds on Alpine) and is
  the prerequisite for the edge-runtime item below. It is deliberately queued *behind* the loaded store's own
  work — the benchmarks, `load()`, the docs pass — and it ships only if the measured decode throughput is
  acceptable against the native addon on the shapes the benchmarks cover. Research, not a commitment.
- **Membership from an edge runtime — explicitly *not* supported today, and being explored.** A Cloudflare
  Worker answering "is id N in segment S?" against a cold generation in R2 is two ranged reads and a decode,
  which is the access pattern this format was designed for. What stops it is not the engine: `core/` imports no
  `node:*` builtin and has zero runtime dependencies, so the seam already loads in a V8 isolate. It is the
  **codec** — `roaring` is a native C++ addon, and no isolate can load one under any compatibility flag. So the
  first piece is a dependency-free JavaScript **reader** for the standard portable Roaring format, which now
  exists in the tree, is checked against the native library on 200 randomly-shaped bitmaps plus every container
  encoding, and is **not exported, not wired into anything, and not something you can use yet**. Read-only by
  design: loads stay in Node, where the native codec is the right tool. **We will not claim this works on any
  runtime until CI runs the conformance suite inside that runtime** — the project has been wrong about
  edge-runtime capabilities three times, and a claim is not a test.
- **A live tier, if there is demand** — immutable delta generations on the same bucket, read as base ∪ deltas at
  chunk granularity; never a mutable row store. Nothing is queued; an issue describing a workload that genuinely
  cannot micro-batch into a load is what would move it.

## Deliberately not planned

Saying no is part of the design:

- **A per-call write API.** `add`/`remove` over a mutable tier was this library's first shape, and it was
  removed rather than kept beside the loaded store: two write paths with different consistency stories doubled
  the surface every invariant had to hold across, and every roaring-based engine that needs freshness
  micro-batches anyway. Compute the set upstream and load it; if a workload genuinely cannot, see the live-tier
  note above.
- **A scheduler for the retention sweep.** Segment-level retention ships; the heartbeat that calls it stays yours,
  and that is a decision rather than a gap. A library that started a timer would behave differently in a Lambda, an
  edge isolate and a long-lived server — the first piece of API that works in some runtimes and not others — and it
  would *hide* the operational burden rather than remove it: a sweep failing silently inside an app server with no
  alarm is worse than a CronJob that shows up red in a dashboard. Nothing here is a daemon: the sweep is a call you schedule.
- **Per-id TTL.** A bitmap stores ids, not `(id, timestamp)` pairs; a timestamp per id costs 4–8 bytes each and
  takes the compression the whole design exists for. Not deferred — incompatible with the data model.
- **A hosted/managed CloudBitmaps service.** Never — this is a library. Your data stays in your account, in
  your buckets, under your keys.
- **Telemetry or phone-home.** Nothing is ever sent to us. Observability is an injected sink you own.
- **An `id → segments` reverse index.** It would cost a second inverted copy of all your data, rebuilt on every
  load, to speed up a rare subject-access request. `subjectReport` scans instead. It could return as an opt-in
  add-on if a real deployment needs sub-second lookups at billion scale.
- **Reimplementing the bit math.** CloudBitmaps wraps `roaring-node`/CRoaring. The object-store layout and the
  chunk-skipping reads are the contribution; the container algorithms are not ours to re-invent.
- **Any feature that taxes the hot path** (`has` / `count` / `intersect` / `union` / `andNot`) to speed up a
  rare operation. If it can't be pushed to wiring time, load time, a scheduled pass, an admin call, or the docs,
  it doesn't ship.

## A note on priorities

CloudBitmaps is built in the open by one maintainer, so priorities can and will shift, and nothing here is a
schedule or a commitment. The best way to influence what gets built next is to
[open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) — to discuss a use case, report a bug, or
tell us something behaved wrong. Contributions are welcome: start with
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
