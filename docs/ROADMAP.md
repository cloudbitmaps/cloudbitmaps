# Roadmap

CloudBitmaps is a **loaded store** for Roaring Bitmaps on object storage. A set of hundreds of millions of IDs
is computed upstream, loaded as an immutable `.crbm` **generation** into S3 (or GCS, Azure Blob, a local disk),
and read from anywhere — `has`, `count`, `iterate`, and the centerpiece, **chunk-skipping intersection**: an
`A ∩ B` fetches only the 16-bit chunks that can possibly contribute, which is what makes a serverless read
cheap. The set lives at object-store prices instead of RAM prices; a bounded in-process LRU keeps the chunks a
process actually touches.

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

**The line is pre-1.0 on purpose.** `1.0` is earned by real-cloud
calibration (the AWS runs are in; Lambda and the other clouds are not), real adoption, and freezing the `.crbm` on-disk format (see
[On the way to 1.0](#on-the-way-to-10)) — until then the public API and the on-disk format stay evolvable.
Everything described under [Shipped today](#shipped-today) is implemented and covered by tests — unit,
property-vs-oracle, conformance suites run against real backends (or a faithful emulator), coverage-guided
fuzzing of the untrusted-`.crbm` boundary, and mutation testing of the highest-risk core modules.

**Where it is headed (October 2026).** `1.0` centres on the **loaded store**: sets are computed upstream and
loaded as immutable generations, then read and chunk-skipping-intersected from anywhere — one bucket, one
registry row per segment, no background process. Every roaring-based engine that needs freshness micro-batches
into immutable segments rather than mutating a stored bitmap per call; that is the shape this library builds.
Per-call freshness, if there is demand, would be immutable delta generations on the same bucket.

Where each piece sits today. A bare **shipped** is in `0.26.0` or earlier; anything on `main` after it is
marked with the release it is to ship in, and sits under `[Unreleased]` in the [changelog](../CHANGELOG.md#unreleased):

| | Status |
| --- | --- |
| Loads, reads, chunk-skipping combines, `*Into` materialization, subject erasure as a rewrite, crypto-shred, disposal, retention, the DR check, export | **shipped** — [below](#shipped-today) |
| `intersectCount`, `unionCount` and `andNotCount`: the size of a combine of stored segments without streaming its ids | **shipped** — an intersection decodes every key its operands share and is exact, making its stream's requests; in a union or a difference a key only one operand holds is answered from its index and not read and every other key is decoded as the stream reads it, so they make no more requests and read fewer bytes where the operands share few chunks (counted over the in-memory backend: 2,165,888 bytes and 6 requests against 33,339,872 and 36 for a packed union of two 10,000,000-id segments); a union or a difference trusts the index for keys it does not decode, as `count()` does, and an intersection trusts none. [Guide](guide/reading.md#count-a-combine) |
| Wider read windows (`concurrency` 32), concurrent cold reads of one chunk sharing one request (point reads and chunk-by-chunk sources only), erasure read-ahead, `andNot` excludes read in the same round trip, and an oversized index entry refused at open | **shipped** — measured on S3 in-region by run `2026-10-13-b329d`: the `andNot` against ten excludes took 297.13 ms and the cold intersect 104.88 ms ([the run, on the benchmarks page](benchmarks.md#the-in-region-run--run-2026-10-13-b329d)) |
| Coalesced chunk reads — combines and `iterate` read each operand's chunks as ranges through the optional `getChunks` port method | **shipped, measured on S3 in-region** by run `2026-10-13-b329d` — chunks within 256 KiB of each other are one range request, up to 1 MiB, and each is checked as before; a cold intersect of two segments sharing 100 chunks that lie together took 104.88 ms at the median and made 6 GETs, $2.40 per million, and an `andNot` against ten excludes took 297.13 ms and made 33, as [`bench/range-counts.cjs`](../bench/range-counts.cjs) counts from the engine and CI holds it to; `concurrency` counts range requests held ahead per operand; spread layouts read most of an object (a range of 1,022,196 bytes, against 51,600 when the chunks lie together), which matters outside the bucket's region. `iterate`'s 3 GETs are [expected, not measured](benchmarks.md#expected-not-measured): the run did not time it |
| `*Into` written from the combine's chunks, through `loadSegmentChunks` | **shipped** — `intersectInto`, `unionInto` and `andNotInto` hand each chunk's result to the encoder as the bitmap it is, so no id is built for a value; the generation holds chunk for chunk what the ids would write (its footer carries its own write identity), and the load writes only bitmaps the store's codec made |
| `materializeMany`: many `*Into` outputs, each operand read once per group | **shipped** — a batch of expression outputs (`and`, `or`, `andNot`, nested) over named stored operands, each published as an `*Into` would publish it, with every operand chunk read once per group, stored operands pinned for the call, every pinned operand an output subtracts re-checked before the publishes, and a resident-bytes memory budget that regroups. Its request counts are the engine's, counted in memory, not measured on S3, and it is outside the [validated envelope](#the-validated-envelope--whats-proven-and-what-isnt) like the `*Into` verbs. [Guide](guide/loading.md#many-outputs-from-one-pass-materializemany) |
| `materializeMany` with a feed: operands that arrive as records in chunk-key order | **shipped** — conditions too many to hold or store are fed to the batch as records, one chunk key resident at a time, beside stored operands; every record is checked before the pass sees it, a bad feed (or an early-ended one, caught by `counts`) refuses every fed output and publishes none, a declared name that never appears is refused unless it may be empty, the call runs as one group under a required budget enforced while the feed is read, and an erasure in the store refuses a fed call. Counted in memory, not measured on S3. [Guide](guide/loading.md#operands-that-arrive-as-records-a-feed) |
| A set the caller holds, as an operand of `materializeMany` | **shipped: through the feed only** — a set you hold is fed as a one-name feed, the guide's recipe ([a set you hold](guide/loading.md#a-set-you-hold-feed-it)) |
| `materializeMany({ dryRun: true })`: a refresh looked at before any of it is live | **shipped** — every output computed and judged against its `dest` as its publish would be, with nothing written; each result says how many ids it would hold, what its `dest` holds now, and the bound its publish would be refused for. The guide shows how to publish what was reviewed, with the erasure caveat of a replayed feed ([a dry run](guide/loading.md#look-before-you-publish-a-dry-run)) |
| `materializeMany` reported to the metrics sink | **shipped** — one `op` event named `materializeMany` per call, and a `storage.get` event per range request it sends, as the `*Into` verbs report; no `cache` event, since the call never looks the cache up ([observability](guide/observability.md)) |
| A deadline on a set — `setRetention` with `retireExpired`, or a check where you read | **shipped** — `store.segment(name, options)` takes `{ namespace }` only, a plain object, and refuses any other key, `expiresAt` included, with `ValidationError`, so a deadline is never dropped in silence ([a deadline on a set](guide/retention.md#a-deadline-on-a-set)) |
| A registry write sent on the row the load read | **shipped** — [a publish passes the row it read](guide/correctness.md#write-goes-out-on-the-row-read), so the S3, GCS and Azure Blob registries send their conditional write with no read of the row first; the store's own condition still refuses a row another writer changed; measured on S3 in-region by run `2026-10-13-b329d`: a segment's first single-part load made 2 PUT + 3 GET, and a multipart one 5 PUT-class + 3 GET ([the run](benchmarks.md#the-in-region-run--run-2026-10-13-b329d)) |
| Loaded-store benchmarks — load throughput, intersect latency | **partly owed**: the rest is below. What is measured, on S3 in-region by run `2026-10-13-b329d` from AWS CloudShell in `us-east-1`: a single-part load ran at 2.72 million ids a second, a segment's first single-part `store.load()` made 2 PUT + 3 GET, $11.20 per million at the default prices, and each kind of steady `store.load()` at `keep: 12` had its requests measured, on the release the run installed (on the native codec; the TypeScript codec has not been run in region) — the [benchmarks page](benchmarks.md#the-in-region-run--run-2026-10-13-b329d) publishes it, and the [report](../bench/calibration/2026-10-13-b329d.md) explains every figure. Run `2026-10-07-88cd3` measured cold combines and the `*Into` verbs on the large suite's operands ([benchmarks](benchmarks.md#large-operands--run-2026-10-07-88cd3)). Still owed: a steady `store.load()` at a `keep` other than 12 on S3, Lambda cold start, `materializeMany` on S3, other combine shapes, and in-region GCS and Azure runs. The **RSS ceiling** is measured and published — it needs no cloud account, because a cgroup limit is enforceable locally |
| `load()` with the empty guard and `guard: { minCardinality, minRetained, maxGrowth }` | **shipped** — `store.load(ref, ids)` is the write path in one call: next generation → write → guard → publish → collect. A refusal is reported (`published: false` + `reason`), not thrown, unless a rollback moved the pointer onto the object the refusal deleted, which throws `NotFoundError` ([a rollback that races a collection](guide/correctness.md#a-rollback-that-races-a-collection)); and it deletes the object it wrote while the segment's row is unchanged, changed only in its leases, or `destroyed`, and, once one read of its footer matches, while the row is gone or holds key material over a cleartext object; once another write has changed the row, it leaves the object for collection, and until it goes a rollback onto it needs `allowUnknown` ([an orphan is collected later](guide/correctness.md#how-a-load-stays-correct)). It reads the segment's row once, checks that its next number is free instead of listing for it, and at any `keep` up to 64 collects by name, deleting the generations its publish pushed out of the window that its row records and listing the segment only every 16th generation: a steady single-part load on S3 makes 2 PUT-class requests, 5 GET-class and a delete, 8 requests, held by a test and measured on S3 at `keep: 12` only, by run `2026-10-13-b329d` |
| `guard.maxGrowth`: a ceiling on how much a load may grow a segment | **shipped** — the ceiling to `minRetained`'s floor, for a source that lands duplicated or joined on the wrong key: a generation larger than `maxGrowth` times the current one is refused with `reason: 'max-growth'`, on `load`, the `*Into` verbs and each `materializeMany` output. It does not judge a first load or a load onto an empty segment, and setting it reads the current size and fences the publish on it, `allowEmpty: true` or not ([when a load is refused](guide/correctness.md#when-a-load-is-refused)) |
| A public bitmap class — `RoaringBitmap`, from `@cloudbitmaps/roaring` | **shipped** — a mutable set of unsigned 32-bit ids with the portable Roaring bytes, in TypeScript with no native code: build, `add`, `addMany`, `remove`, `removeMany`, `clear`, `clone`, `andInPlace`, `orInPlace`, `xorInPlace`, `andNotInPlace`, the statics `and`, `or`, `xor`, `andNot` and `orMany` that return a new bitmap, the counts and comparisons `andCardinality`, `orCardinality`, `xorCardinality`, `andNotCardinality`, `intersects`, `isSubset` and `isEqual`, `has`, `size`, `minimum`, `maximum`, iteration, `toArray`, `toUint32Array`, `serialize`, `runOptimize`. A write into a run container keeps it a run container while that is the smaller form: a group of one to four ids of an `addMany` goes into the container it meets without a container built for the group, a union of a run container with an array merges into the run list, and one whose result cannot sensibly be a run container (about a thousand runs and ids or more, and runs too many for the size rule) is written through words instead, the same container either way. `isEqual` compares eight values a step (two at a time through a 32-bit view from 512 values), `orMany` ORs four bitsets at a time into its accumulator, and `deserialize` with no options skips the option checks. Every id argument is checked and a refusal never repeats the value. `RoaringBitmap.deserialize(bytes)` is the one door for bytes: capped, structurally checked, one whole bitmap, an empty buffer refused, the result owning its storage. The earlier read-only decode function and its type are removed ([CHANGELOG](../CHANGELOG.md)). It loads with the package's main entry, and so runs where the package runs ([the codec page](guide/roaring-codec.md#using-it-by-itself)). What is left is under "What is next" below |
| A load from a bitmap — `{ bitmap }`, `{ serialized }` | **shipped** — a caller holding the result as an in-memory Roaring bitmap loads it as one: the bytes are checked before anything is written, the chunks are cut from the bitmap's own containers with no per-id work, and the generation holds chunk for chunk what its ids write (its footer carries its own write identity). `RoaringBitmap.deserialize(bytes)` decodes portable bytes through the same check, for bytes that crossed a process boundary, into a mutable `RoaringBitmap` that owns its storage. Its time against the id path is measured by `pnpm bench:load-input`, whose figures are not recorded yet |
| Registry rows at schema 5: a ledger of the generations a row made current (`knownGens`), a random token for every write, and the row's `pointerId` | **shipped** — a row carries an optional summary of its current generation that names the generation's object by its fingerprint (its size and checksum) and records `tailBytes` (a cold open of a cleartext generation sizes its tail read from it, so a wide segment's index comes in one request), the ledger of the generations it made current with each object's footer checksum (the window its loads keep, drawn from the order they were made current, the generations a live lease holds, and what a rollback left), its live leases (`leases`), a token with a random incarnation id and a random part for every write, and `pointerId`, the token of the last write that named a field a read resolves through (the pointer, the status, the keys or the summary), at any value. A reader keys what it caches on the generation with the row's `pointerId`, so a lease or a retention write leaves its caches warm, and every open of a row with a summary holds the object to its fingerprint. A store reads rows stamped 5 only: a row stamped 1 to 4 is refused with `UnsupportedError`, and moving a store means loading its segments into a new prefix ([export your data](guide/export.md)) |
| A generation's metadata, and a row that describes its current generation — `metadata` on `load` and the `*Into` verbs | **shipped** — [below](#the-loaded-store) |
| A cold `count()` in one request, and `seg.stat()` | **shipped** — [below](#the-loaded-store) |
| The cost model in a package of its own, `@cloudbitmaps/tools`, and `stat()` reporting the generation's size | **shipped** — `estimateCost`, `groundedReport` and the price lists are in `@cloudbitmaps/tools`, offline tools that need nothing internal from a store, released with the family; the library carries no prices. `stat()` reports `sizeBytes`, the bytes of the current generation's object, which the row's summary records, so a grounded report is `groundedReport({ storageBytes: (await seg.stat()).sizeBytes })` and a cold `stat()` is one registry read ([the cost guide](guide/cost.md), [`stat()`](guide/reading.md#stat-the-generation-its-count-its-metadata-and-its-size)) |
| A throttled write sent again, and a registry write that gets no answer settled by reading the row | **shipped** — [below](#the-loaded-store) |
| A purged registry row removed for good, and `scan: 'index'` that purges as well as retires | **shipped**, where the registry reports `conditionalDelete` — [below](#security--data-protection) |
| Read timeouts on S3, GCS and Azure Blob (`readTimeoutMs`) | **shipped**, off unless set |
| `generations()` + `rollback()` | **shipped** — see what a segment has been and put the pointer back, the one write that is not forward-only. Refuses a target the row's `knownGens` does not name and one whose footer checksum is not the recorded one (with or without a key), unless `allowUnknown` is passed, which is audited; a collected target, a destroyed segment (crypto-shredded, destroyed in the clear or dropped); rolling to the current generation checks its object is there and is the recorded one, and [a swap that met a conflict or got no answer is settled by reading the row](guide/correctness.md#rollback-settles-its-swap), by the write token on a registry that reports them |
| No character rules on names | **shipped** — a name is any non-empty string; each storage layer escapes what it cannot take literally rather than the library rejecting it, Windows device names like `con` and names ending in a dot included on the local filesystem. Three limits remain: 256 characters once encoded for storage, where escaping makes a name longer than it looks (anything outside `[A-Za-z0-9._-]`, and on the local filesystem the device names and trailing dots above); well-formed UTF-16, since an unpaired surrogate has no UTF-8 encoding; and a namespace starting with `cbm.due.`, which the retention index keeps its own rows in and every fleet-wide scan skips |
| `exists()` + `segments()` | **shipped** — `exists()` is one point read of the registry, and `segments()` streams the registry's own enumeration, namespace-scoped, admin-path. Neither is inferred from `count()`, which cannot tell *never loaded* from *loaded and empty*, and neither needs a list of names kept beside the store |
| Extending the load guard to the `*Into` verbs | **shipped** — a materialization routes through the same guarded write path as `load()`, so an empty or implausible combine is refused (`published: false` + `reason`) instead of replacing `dest`. `allowEmpty: true` publishes an empty result where emptying the destination is the intent; `guard: { minCardinality, minRetained, maxGrowth }` adds the plausibility bounds, judged against what `dest` held |
| A lease on a pin — `pin({ leaseUntil })` keeps the pinned generation out of a load's collection until the lease ends, and a read after it throws `LeaseExpiredError` at every site, never empty | **shipped** — recorded in the registry row's `leases` field (beside `knownGens`); erasure, shred, drop and retention ignore it; see [Hold a generation for a job](guide/reading.md#hold-a-generation-for-a-job-a-lease) |
| A snapshot handle, so a long job reads one instant | **shipped** — `segment.pin()` resolves the generation once and holds it, so an export or a reconciliation describes a single instant. Only that segment is pinned; an ordinary handle still re-resolves on `cache.genTtlMs`. `segment.pinAt({ generation, fingerprint })` reopens a generation an earlier pin recorded (`NotFoundError` if it is gone or another object, never empty), and `pin({ leaseUntil })` and `pinAt(at, { leaseUntil })` hold the generation out of every load's collection for up to 14 days, besides sizing `keep` |
| Id-range reads for keyset paging — `iterate({ after, through })` and the same bounds on every combine | **shipped**. Yields only the ids in `(after, through]` and fetches only the chunks the range overlaps |
| A public docs + site pass leading with the loaded store's strengths | **shipped** |
| Playbooks: one runnable, end-to-end page per job, each run by the tests, in [`playbooks/`](playbooks/README.md) | **partly written** — the standalone `RoaringBitmap`, audience segments, feature flags, dedup, permissions, getting ids into dense integers, suppression at send time, a membership check in a service, privacy requests, reproducible audiences, "is this the right tool", a set per user, counting a combine with and without streaming it, moving a Redis workload, faceted filters, serverless intersection on Lambda (with no figure, because none is measured) and funnels as a page of limits (a set carries no order or time) are in; still to come are exact counts, overlap reports, active users and retention by cohort now that a direct count of a combine has shipped, handing bitmaps to other engines once their byte layout is checked, vector-search pre-filters and dataset splits |
| Reading a chunk at a time — `.batches()` on `iterate`, `intersect`, `union` and `andNot` | **shipped** — the same ids in the same order as one `Uint32Array` per chunk, reading the same chunks; see [Read a chunk at a time](guide/reading.md#read-a-chunk-at-a-time-batches) |
| The ids at ranks `n`, `2n`, `3n` … of a pin — `pin.everyNth(n, range?)` | **shipped** — places each boundary from the index's per-chunk counts and reads only the chunks that hold one, each once, through `iterate`'s stream, window and budget; a live handle is refused, and a chunk that is read must match its count ([reading guide](guide/reading.md#every-nth-id-of-a-pin-everynth)) |
| Each driver's tests run every night at the lowest SDK version of each alternative of its range | **shipped** — S3 `3.700.0`, GCS `8.1.0` and Azure Blob `12.23.0`, each the lowest version its tests were measured to pass on (GCS: 8.0.1 fails an integration test, and 8.0.0 and every 7.x release tried fail the unit tests); a range written with `||` gets one run per alternative. A negative control runs the S3 driver one release below its floor and requires the registry's refusal of an unfenced write. The integration half runs against the emulators in the same job. [CONTRIBUTING](../CONTRIBUTING.md) |
| The built S3 client allows 128 sockets, and `maxSockets` sets it | **shipped** — twice the SDK's 50, so one two-operand `intersect` at the default `concurrency` does not queue behind its own socket pool. A store with a `metrics` sink gets one `advisory` event when the client's pool is under 64 sockets, as a client you pass with the SDK's 50 is ([observability](guide/observability.md)). The in-region run's client had 128 sockets |
| Deferred | **not built** — `generations({ describe: true })`, an `op` metric for `store.load`, an unscoped listing that skips the due index's pointers, one generation from parts built in several processes, the reconcile for `setRetention` and shred writes, and the resend of a `rollback` swap the row shows did not land: [On the way to 1.0](#on-the-way-to-10), item 9, says what each is |
| WASM CRoaring research | **not planned** — the store's codec is Roaring in TypeScript, so there is no native addon for a WebAssembly build to replace (a WebAssembly module for this codec's own dense word kernels is a separate item, under Planned / exploring) |
| A large suite of the calibration harness, for combines on operands of a million to ten million ids and the `*Into` verbs; one module for the engine's checks on untrusted tier data; a CI gate that holds the public signatures | **shipped** — no library behaviour changes: the large suite has run against real S3, run `2026-10-07-88cd3`, whose figures are on the [benchmarks page](benchmarks.md#large-operands--run-2026-10-07-88cd3) |

**What is next:** the table of the public bitmap API against the native binding is built and published ([the codec page](guide/roaring-codec.md#the-public-class-against-native-in-memory)); what stays is its re-measure on each release build. A method more than 10 times slower than native on some data set ships only on the maintainer's decision; the two there are the union of 64 dense bitmaps with `orMany` and the first `deserialize` in a fresh process, and both ship with their figures shown. Ranges, `rank` and `select` are not planned yet, because each needs container-level fast paths or a running count per container that taxes every write, and are built when a user asks; the batch stage (a refresh-shaped `materializeMany` measured on S3), a Lambda run, other combine shapes, and in-region GCS and Azure runs. [On the way to 1.0](#on-the-way-to-10) lists everything that stands before `1.0`.

Current install and publish status lives in the [README](../README.md) — this page deliberately doesn't
restate it, so the two can't drift. You install **one codec flavor plus the one storage package you need**,
and each storage package brings its own SDK — so no install carries an SDK for a service you do not use:

```bash
pnpm add @cloudbitmaps/roaring @cloudbitmaps/s3   # roaring on AWS: one bucket, storage + registry
# npm i @cloudbitmaps/roaring @cloudbitmaps/s3     # the same, with npm
```

`@cloudbitmaps/core` — the codec-agnostic engine, with **zero runtime dependencies and no cloud SDK** —
is a dependency of both, installed directly only to name a driver port's type from `@cloudbitmaps/core/driver-kit`
([the storage interfaces](guide/api-reference.md#the-storage-interfaces-used-to-type-storage--registry) say how, or how to derive the type instead). The storage drivers are their own packages
(`@cloudbitmaps/s3` · `/gcs` · `/azure-blob`), each depending on its SDK for real. `@cloudbitmaps/tools`, the offline
cost model, is an optional sixth package that needs neither a flavor nor a driver.

## Shipped today

### The loaded store

- **One write path: the load.** `store.load` builds a generation from an unsorted sync **or async**
  ID stream without holding the *input* in memory (memory is bounded by the distinct result set, not the input
  length), writes it as one write-once object, judges it against the guard, and publishes it with a
  compare-and-swap on the registry row. A load that finds a row fences on the row's token, and one that finds none
  on that absence, guarded or not; a default load also fences on the pointer it judged; and a duplicate publish is an
  idempotent no-op. Ids that already ascend load with `sorted: true`, which writes them one chunk at a time while the
  object uploads, so the load holds one chunk and the writer's index (up to about 7 MiB, about 8 MiB for an encrypted
  segment, derived) whatever the segment's size, and writes the same object, byte for byte under the same write
  identity; an error the ids raise reaches the caller as the very object raised. Unsorted ids for a segment larger than
  RAM want the external-merge bulk
  load listed under [Planned](#planned--exploring). A load also takes a whole
  bitmap, `{ bitmap }` (anything with `serialize('portable')`) or `{ serialized }` portable Roaring bytes: checked
  structurally and safely deserialized before anything is written, then written from the bitmap's own containers,
  never id by id, into chunks holding what the same ids write. A byte array passed as ids is refused rather than loaded byte
  by byte.
- **A throttled write is sent again, and never lands twice**. On S3 and GCS a write-once object the service answers
  as throttled (`503` or a bare `429` on S3; `429` or `503` on GCS) is sent again, up to three more times with backoff ([why that is safe](guide/correctness.md#object-write-resent); [the SDK's own retry](guide/correctness.md#sdk-retry)), and a random write
  id in its metadata tells a first send that landed from another writer's object; on Azure Blob the client's retry does
  the same, with the same id. On S3 and GCS a registry row is sent once by the driver; on Azure Blob the client's retry can replay it, and a replay that meets a conflict is read back by its id, which is not definitive for a row. When its write gets no answer, the load reads
  the row and reports its own landed write as published (proved by the tokens the registry reported for the writes it
  sent, or, on a registry of your own that does not report tokens, by the object's footer); and when the row is as it
  was, the load sends a fresh compare-and-swap from the version it read, at most three times with backoff on the
  injected clock, under the registry's fence, so at most one copy lands. Throttling that never clears throws the
  registry's `TransientError` with the object kept: nothing is deleted after an ambiguous outcome, because a write may
  still land.
  A throttle only adds requests, so the cost model is unchanged. **Proven against** stubbed services under each real
  SDK (the throttle answers, a request applied and then refused, one applied after the load gave up, a request delayed
  past the fresh one) and, for the objects, against MinIO and fake-gcs-server with the throttle injected at the client.
  **Not yet captured** from the real services: whether S3, GCS and Azure apply a request they answered as throttled is
  not documented, so correctness rests on the write id, the write's token and the registry's fence, never on that, and
  the in-region calibration is where real throttle answers are measured. A bare `429` from an
  S3-compatible service counts as a throttle on S3, as a `503` does.
- **Metadata on a generation, and a row that describes its current generation**. `load` and the `*Into` verbs take a
  small record of your own (`metadata`: string keys, string or finite-number values, at most 1,024 bytes as canonical
  JSON), checked before the first request and stored in the generation's object. The write that moves the pointer also
  writes the row's summary of the generation, its id count and the metadata, sealed on an encrypted segment, so a reader
  that sees a generation as current sees its metadata. A rollback writes its target's own, an erasure's rewrite carries
  it over, a shred and a drop clear the summary, and a guarded load sizes the current generation from it and opens no
  object for that. A load that does so looks for the current object with one zero-byte read before it deletes by name,
  so a segment whose current object was removed from outside keeps the one generation left to roll back to; that look
  stands in for the tail read, so a steady single-part load on S3 makes 2 PUT-class requests, 5 GET-class and a delete, 8 requests
  (held by a test, and measured on S3 at `keep: 12` only). **Proven against** the in-memory and local-file drivers and the real registry
  protocol over counting stores, with every decision mutation-checked.
- **A one-request cold `count()`, and `stat()`**. A cold `count()` is the pointer read and nothing else: the row records
  the current generation's id count, so no object is read, cleartext or encrypted, whatever the index's width (derived
  from the driver ports and held by a test; one wire request on each emulator in the integration lane). `seg.stat()`
  returns the generation's number, count and metadata, and its object's
  size beside them, from the same row: a cold `stat()` is the pointer read too, and a row with no summary to use adds a
  tail read of the object; the current entry of `store.generations()` carries the number, count and metadata from the
  row it already reads. A snapshot is a
  resolved target with a reader opened on first use, so a `count` and the `has` after it read one generation. The row's
  summary is used only for the generation it names, in the shape the keys call for, and is held against the object
  whenever a read opens it anyway. Every open holds the object to the fingerprint the summary records, and an object
  that is not the row's is refused when it is opened; a disagreement in count stops that store using the summary and fails nothing, and
  `checkConsistency({ summaries: true })` reports it as `summary-mismatch`. **Proven against** the in-memory and
  local-file drivers over counting stores, random sequences of loads, materialisations, rollbacks, erasures and
  retention writes, and each emulator, with every decision mutation-checked.
- **Chunk-skipping intersection** — `intersect` aligns on chunk keys and fetches only the chunks present in
  *every* operand, with bounded read concurrency (32 range requests held ahead per operand by default, chunk keys on a source that reads chunk by chunk, where concurrent cold reads of a chunk share one request) and a bounded streaming window.
- **Id-range reads for keyset paging** —
  `iterate`, and every combine, take `after` / `through` and yield only the ids in `(after, through]`, fetching
  only the chunks the range overlaps, on a live or a pinned handle.
- **One store per combine.** A combine, an `*Into` verb and `materializeMany` take only segments made by the store
  the call runs on, and refuse a segment of another store, of a second store object over the same backend or of
  another installed copy of the package with a `ValidationError` before any request.
- **Composable set reads** — `union`, `andNot`, and an `exclude` option on `intersect` that folds suppression
  into the same chunk-aligned pass, so `(a ∩ b) \ suppression` needs no intermediate segment. Each operation is
  honest about what it can skip: `intersect` prunes any key missing from an operand, `andNot` reads the
  suppression side only where it overlaps, and `union` can prune nothing at all — all three budgeted alike.
- **Materialized results.** `intersectInto` / `unionInto` / `andNotInto` write the result as a **new generation
  of a destination segment** — the destination is superseded, not appended to — and return
  `MaterializeResult { generation, published, reason?, cardinality, cardinalityBefore, chunkCount, size,
  collected }`. An empty or implausible result over a non-empty destination is **refused** rather than
  published, with `allowEmpty` / `guard` to override — the same guard `load()` takes. Unlike `load()` it
  collects nothing by default, so a `rollback` target survives the materialization.
- **Many materializations in a pass per group.** `store.materializeMany` computes many `*Into` outputs together: expressions over
  named stored operands, each operand read once per group, one result per output that is exactly what its `*Into` returns
  or throws, and a required `keep`. See [the guide](guide/loading.md#many-outputs-from-one-pass-materializemany).
- **Cheap counts.** `count()` answers from the registry row's summary of the current generation (one request when cold),
  else sums per-chunk cardinality from the `.crbm` index, so a segment counts with **zero payload reads**.
- **Bounded memory, always.** A hard LRU ceiling on cached chunks, a byte-aware storage-reader cache, bounded fan-out
  on every admin path, and a default-on per-operation **request budget** that fails with `BudgetExceededError`
  rather than quietly running up a bill. Every registry scan has a ceiling by default: the DR consistency check,
  the retention sweep and `eraseNamespace` refuse past `maxScanSegments` (250,000 rows by default), and the subject scans
  (`subjectReport`, `eraseSubject`) refuse past the request budget, `budget.maxRequests`, which `eraseSubject` also charges for each superseded generation it opens, and both for each object they open under a destroyed segment. `budget: false`, on the
  call or on the store, lifts that ceiling, and a subject scan then holds every row it lists.
- **Immutable, generation-keyed objects.** `segment.<gen>.crbm` + one registry pointer, never overwritten in
  place. A load takes the next number past both the pointer and whatever is in the bucket, so a crashed
  load's orphan cannot block a retry, and collects superseded generations behind a grace window (`keep`)
  for in-flight readers.
- **A co-operative bulk-load.** Node has one thread, and building a generation is the one operation here that
  genuinely occupies it for a while. It hands the event loop back periodically, so a co-resident server keeps
  answering while a load runs; a test holds a load to yielding. On by default. The guide's
  [what blocks the event loop](guide/production.md#what-blocks-the-event-loop-and-where-to-run-it) has the
  timings it reports for one machine, measured by `bench/event-loop.cjs` on the native codec (before the TypeScript codec) and checked against its committed results in CI; they are to be re-measured on the TypeScript codec.

### Security & data protection

- **All stored bytes are untrusted.** The safe Roaring deserializer behind a hard size cap and a structural check
  of every payload (containers and values in order, runs disjoint, cardinalities matching the bits), per-chunk /
  per-index / per-footer CRC32C, and field validation on every `.crbm` header — a corrupt or hostile object
  fails closed with a typed error instead of reaching the decoder trustingly.
- **Optional encryption at rest** — AES-256-GCM over the payload *and* the index (so metadata is hidden),
  envelope-wrapped per-segment DEKs under operator-held KEKs, AAD binding each ciphertext to its
  `(namespace, segment, generation, chunk)`, KEK rotation, and an offline recovery KEK. Keys stay in your
  process; no cloud KMS dependency is forced on you.
- **Subject erasure as a rewrite.** `eraseSubject` finds every registered segment an id is in, [rewrites each
  one's current generation without the id](guide/correctness.md#erasure-is-a-rewrite) (read through the coalesced
  chunk stream, at most 4 ranges ahead of the writer, one bit cleared), [publishes it fenced on the generation it
  streamed](guide/correctness.md#which-fence), and [deletes every generation that held the
  bit](guide/correctness.md#every-holder-goes) before returning, above the pointer as well as below it, and a
  first load's object on a segment with no generation yet —
  **physical deletion on return** for every segment its ledger reports `erased: true`, with a
  per-segment ledger and an audit event per segment erased: `segment.rewrite`, or `segment.collect` where only other
  generations held the id, which is also emitted, with no `fromGeneration`, for a segment where the erasure deleted only
  objects no read of it can open. `subjectReport` is the read side (access), and it finds the objects a cleartext destroy left, which the erasure deletes. What a
  rewrite cannot reach — backups, replicas, noncurrent versions — is what crypto-shred is for. A holder an erasure
  deletes by name, above the pointer or on a segment with no generation yet, is deleted only while it is the object
  the erasure read, on a storage driver that reports
  `conditionalDelete` (in-memory, Azure Blob, S3 on an AWS host, GCS when set), so a load that took its number since
  keeps its generation ([the limits](guide/correctness.md#how-an-erasure-stays-correct)); the local-filesystem driver cannot.
- **Crypto-shred erasure** — `destroySegment` / `eraseNamespace` remove the wrapped DEK from the segment's current
  registry row in one compare-and-swap, which reaches immutable backups and WORM copies of the objects once no
  retained copy of the row holds it, or once every KEK that wrapped it is destroyed
  ([encryption & DR](guide/disaster-recovery.md#encryption--dr)).
- **Segment disposal** — `store.dropSegment` retires a segment and *reclaims its storage*: tombstone first, then
  every Storage generation, so a failure part-way leaves orphaned bytes and never a wrong answer. Works on
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
  purges the tombstone rows its own retirements leave. On a registry that can delete a row only while it is
  unchanged (S3 when its client sends to an AWS S3 host and Azure Blob by default, GCS when you set
  `conditionalDelete: true`, by `If-Match` / `ifGenerationMatch`), the purge removes the row for good, so a full sweep reads what is live and inside its grace
  rather than every name a namespace ever held, and `scan: 'index'` purges as well as retires, by a pointer each
  retirement files under the day its tombstone's grace ends. A refused delete is counted (`purgeFaults`) and holds no
  retirement back. Setting a policy before the first load mints the registry row, so the policy is recorded ahead of the data.
- **Supply chain** — every third-party GitHub Action SHA-pinned, a blocking dependency audit, npm **build provenance**
  on publish, and continuous coverage-guided fuzzing over the untrusted-`.crbm` boundary (nightly, plus a
  weekly deep run).
- Reporting: [`SECURITY.md`](../SECURITY.md). The trust boundary, retention/residency contracts, and a
  DPIA + Art. 30 template: [`PRIVACY.md`](../PRIVACY.md).

### Operating it

- **Observability without telemetry** — an injected metrics sink and a separate, off-by-default audit sink
  emitting compliance state changes. Nothing is sent anywhere by default; there is no phone-home.
- **Honest cost tooling** — `estimateCost` for planning and `groundedReport` for a segment's measured size, which
  `stat()` reports, in `@cloudbitmaps/tools`, with a pluggable pricing
  profile that will tell you when CloudBitmaps *loses* to flat Redis. The crossover is a **read rate** at a given
  cache-hit rate, net of storage and the pointer refresh a long-lived reader pays, with a loads term that counts what
  `store.load()` sends. Each request count is held to the engine by a test. The published crossover chart is in
  [Benchmarks](benchmarks.md).
- **An exit path.** `exportSegments` and the `export-segments` CLI dump every segment to portable
  `roaring` / `ndjson` that is readable **without** this library, with per-segment fault isolation. If the
  project vanished tomorrow, nothing of yours is locked up.
- **Disaster recovery** — `checkConsistency` detects a torn restore, a missing storage generation and, with
  `generations: true`, an object under a known generation number that is not the one the row recorded, exercised
  end-to-end as a gated drill against the [DR runbook](guide/disaster-recovery.md).
- **Serverless-ready** — a hard cgroup-RSS ceiling in CI, an AWS Lambda / Amazon Linux 2023 deployability
  smoke test, and a prebuilt Lambda layer builder.

## Storage drivers

Every driver is held to the same shared conformance suite for its seam, run against a real backend (or a
faithful emulator) — an implementation isn't "done" until it passes.

| Store | Backends |
| --- | --- |
| **Storage** (immutable objects) | S3 · Google Cloud Storage · Azure Blob Storage · local filesystem · in-memory |
| **Registry** (generation pointer, discovery, wrapped keys) | S3 · Google Cloud Storage · Azure Blob Storage · local filesystem · in-memory |

Two things worth knowing before you pick:

- **Every cloud backend can host the registry itself**, so a deployment needs exactly one cloud account: storage
  generations and the pointer live in the same bucket or container. Each native registry rides its own store's
  conditional-write primitive — S3 `If-None-Match`/`If-Match`, GCS `ifGenerationMatch`, Azure
  `If-None-Match`/`If-Match` — so the compare-and-swap is enforced by the service, not by the client. Each reads a
  pointer in one GET, whose version fence comes back with the bytes, so a pointer read costs the same on all three. A
  segment's tail read is one request on S3 and GCS, and two on Azure Blob, which takes no suffix range. To keep
  the pointer off the object store entirely, implement `IRegistryDriver` against a database you already run (the port
  and its record types are in `@cloudbitmaps/core/driver-kit`).
- **A registry is optional only for a cleartext, read-only store**, which list-scans the bucket for the latest
  generation. Encrypted segments, the `*Into` verbs and every lifecycle helper need one.

## The validated envelope — what's proven, and what isn't

We'd rather tell you the boundary than let you discover it. CloudBitmaps is **ready within a validated
envelope**:

| | Inside the envelope | Outside it (use with your own testing) |
| --- | --- | --- |
| **Workload** | read-mostly over loaded generations; loads as a batch job (a cron, a pipeline step, a Lambda on a schedule) | anything that needs per-call mutation — there is no write verb; micro-batch into a load |
| **Scale** | up to ~100K segments; reads and combines of operands up to 10,000,000 ids on S3 (run `2026-10-07-88cd3`), the largest with published evidence, and loads up to the 12,582,912-id segments the calibration run wrote and did not read | larger segments: an unsorted load holds them in RAM as their distinct ids (an external-merge bulk load is planned), and a sorted one (`sorted: true`) holds one chunk and the writer's index, measured in a unit test up to 10,000,000 ids and not yet run on a cloud; and ids past 2³²−1, which want the reserved 64-bit format |
| **Backends** | S3 storage — the validated tier | the GCS and Azure Blob registries and storage: conformance-passing and correctness-clean, but not envelope-validated. The S3 registry has a published in-region run, for cost and latency: the 2026-10-13 calibration run kept its pointer in the same bucket as the data |
| **Tenancy / region** | single-tenant, single-region | multi-tenant isolation; multi-region active/active |
| **Cost figures** | the **in-region run `2026-10-13-b329d`** (`us-east-1`, from CloudShell: a cold intersect and a load, pointer included, and their latency) and the **large run `2026-10-07-88cd3`** (combines and the `*Into` verbs on the large suite's operands, their requests and latency) — published prices applied to wire-metered requests — plus the estimator, all with published methodology | the invoice itself; Lambda cold start; `materializeMany` on S3; other combine shapes; and GCS and Azure on a real account |

**Measured, not asserted — and measured on what.** The cloud figures on the [benchmarks page](benchmarks.md) are
the requests the engine actually issued and the time they took, from the 2026-10-13 run in `us-east-1`, driven from
inside the region. It measured the topology that ships, with the pointer in the same bucket as the data: what a cold
intersect and a load cost, pointer included, how long they take, and how fast a load runs. The 2026-10-07 large run,
from the same place, measured combines and the `*Into` verbs on operands of about 1, 5 and 10 million ids. What is **not** yet
measured is [what is still owed](benchmarks.md#what-is-still-owed): a Lambda's cold start, `materializeMany` on S3, other
combine shapes, and GCS and Azure on a real account. RSS under a soak is measured and published
as a ceiling. There is no stress, tail-latency or chaos harness for the loaded store. Benchmark numbers come with their methodology: the benchmarks page and each run's report say,
section by section, whether a figure is measured, derived, modelled or expected, and laptop and emulator numbers
are labelled as such.

## On the way to 1.0

`1.0` is a commitment to the on-disk format, so it waits for evidence rather than a date. What stands
between here and there:

1. **Real-cloud calibration — measured on S3, in-region.**
   The [in-region run](benchmarks.md#the-in-region-run--run-2026-10-13-b329d) of 2026-10-13 is published:
   40 of 40 cold intersects exact, with every request counted;
   single-part loads at 2.72 million ids a second, a segment's first single-part load in 2 PUT + 3 GET, and a steady load at `keep: 12`, each kind of it in the requests the benchmarks page lists. Its
   [report](../bench/calibration/2026-10-13-b329d.md) explains every figure, and a gate holds each one to the
   run's committed results file. Its rounds sit above the engine's rounds model, which assumes no socket limit; the run did not vary its client's 128 sockets, and no stage held more than 11 requests in flight, so it does not say why. What remains: a
   **Lambda** run for the serverless figure with cold-start and init included, which needs a run from inside a
   function; in-region **GCS** and **Azure** runs; and a **real-GCS run of the conditional-delete probe**
   (`tests/integration/real-cloud-conditional-delete.test.ts`, skipped unless a bucket is named). The probe shows
   whether a real service refuses a delete whose precondition no longer holds, and whether a name the registry removed
   can be created again over the delete marker a versioned bucket leaves. It passed on real AWS S3 on 2026-10-03, five
   of five checks on an unversioned and a versioned bucket in us-east-1, so S3 defaults on for an AWS host. GCS has not
   been run, so GCS defaults off and needs the probe before its default turns on; the emulators the integration lane
   runs ignore the precondition, so CI cannot show it. [`bench/README.md`](../bench/README.md#real-cloud-calibration) describes the harness.
2. **Loaded-store benchmarks — partly owed.** Load throughput and `intersect` latency are measured in-region (the
   run above, with a sweep to 2,000 shared chunks). `*Into` latency and combines on operands of a million to ten million ids
   are measured on S3 by the harness's [large suite](../bench/README.md#the-large-suite) (`node bench/calibrate-aws.cjs --suite large`),
   run `2026-10-07-88cd3`; `materializeMany` on S3, `intersect` over more than two
   operands and other overlaps are not measured.
   `iterate`'s request count is expected from the engine, not measured: the harness does not time it.
   **The RSS soak is measured:** `pnpm rss-gate` records its run, and
   the measured ceiling — a sustained read + combine + re-load workload over 400 segments inside a hard
   384 MiB cgroup limit with swap off, no OOM — is published on the
   [benchmarks page](benchmarks.md#what-rss-is-and-why-it-is-the-number-we-bound). Until they exist, the only cloud measurements on the
   benchmarks page are the one published in-region run's, and this page says so wherever it quotes one.
3. **The empty-load guard and `load()` — ✅ Shipped.** `load()` on the store with `allowEmpty` (an empty
   result over a non-empty segment is refused unless you say so), a `guard` over the result before it is
   published, and a refused load that deletes the object it wrote while the segment's row is unchanged or gone,
   and leaves it for collection once another write has changed the row. It covers the `*Into` verbs too: a combine that comes out empty over a
   non-empty destination is refused rather than published.
4. **A snapshot handle — one instant for a long job. ✅ Shipped.** `segment.pin()` resolves the current
   generation once and reads from it for as long as the handle lives, so an export, a reconciliation or a send
   describes a single instant rather than whichever generations happened to be current as it went. `segment.pinAt({ generation, fingerprint })` reopens a generation an earlier pin recorded, and, unless leased, holds nothing alive. Generation
   GC's grace window (`keep`) never provided this: of the four things that move a long read to another
   generation, a larger `keep` removes one, the sweep's heal, except after an erasure, whose rewrite collects the
   erased generation whatever `keep` says; it leaves the TTL, an eviction (of the reader on a store with no timed
   refresh, of the segment's resolution on one with), and invalidations.
   Size `keep` past your longest pinned job, or lease the pin (`pin({ leaseUntil })`, up to 14 days) — a pinned read
   does not heal forward, it fails, which is the honest failure for a caller that asked for one instant.
5. **A curated public surface — ✅ Shipped.** `@cloudbitmaps/core`'s main entry exports what the library
   supports and not what it merely happens to reach: the due-index scheduler, `.crbm` construction internals,
   object-key layout and defaults stated in prose are not importable. `1.0` freezes the format; a small surface is
   the other half of that promise, and a name is far cheaper to *add* later than to take away. A symbol stays when
   a public type or field needs it to be produced, parsed or consumed, which is why `readRetentionPolicy` is
   exported (a registry row's `retention` field is public, and this is its supported parse), and that is the test
   worth applying to any surface reduction. The API reference guard runs in both directions. `@cloudbitmaps/core`'s
   main entry has since become internal, outside the stability promise and out of the signature snapshot; the public
   surface is `@cloudbitmaps/roaring`, the drivers, the tools and `@cloudbitmaps/core/driver-kit`. `@cloudbitmaps/roaring`
   exports the names an application uses and nothing else, and driver-kit is the one home of the driver
   contracts: every type a driver, a registry, a read source or a keystore of your own names is exported there.
6. **A public docs + site pass leading with the loaded store's strengths — ✅ Shipped.** The README, the guide,
   the API reference and the site lead with what this is: one bucket, immutable generations, cheap
   chunk-skipping reads from anywhere. A gate derives the site's driver counts from the driver classes in the
   code, and another refuses a count of third-party dependencies that does not name the package it counts.
7. **`.crbm` format freeze** — [the format reference](format.md) documents the layout, the registry row and the questions
   the freeze review decides; the format already reserves space for 64-bit IDs and stamps a schema version on
   the registry row; freezing it is what makes cross-language ports and long-lived data safe. The row is at schema
   5: an optional cached summary of the current generation (its id count,
   its object's fingerprint, its tail size and its metadata, sealed on an encrypted segment), a ledger of the
   generations it made current, each with its object's footer checksum, and its
   live leases, a token that carries a random 128-bit incarnation id and a random part for every write, so a
   re-created name is told apart from its earlier incarnations even once their rows are gone, and a row restored from
   a backup from the tokens it had before, and a `pointerId`, the token of the last write that named a field a read
   resolves through (the pointer, the status, the keys or the summary), at any value.
   The object format stays 1.0: a generation written with metadata carries it in an extension block of typed
   sections, flagged in its footer (a reader skips a section type it does not know); a generation without metadata has
   no block and no flag.
   Every generation's footer also carries a random write identity: the `indexNonce` field holds the index's AEAD
   nonce on an encrypted generation and 12 bytes its writer drew on a cleartext one, covered by the footer checksum, so
   two loads of the same ids are two objects with two fingerprints.
8. **Adoption feedback** — real deployments finding the sharp edges that our own tests don't.
9. **Closing the named deferrals.** None of these is built:
   - self-healing disaster recovery;
   - an exclusion predicate on the retention sweep (legal hold);
   - an automated reconcile of unstamped tombstones;
   - an unscoped listing that skips the due index's pointers before reading them;
   - `generations({ describe: true })`, which would open every listed generation to describe it;
   - an `op` metric for `store.load`, which the metrics sink does not time;
   - sending a lifecycle write again when the row shows it did not land. Every write reads back its row or its object
     when it gets no answer ([how a row write is settled](guide/correctness.md#row-write-settled),
     [what each helper settles](guide/correctness.md#settle-by-read-back)) and goes on from one that landed.
     Only the publish of a load, an `*Into` or an erasure's rewrite, and an erasure's write to the row, send one again
     ([publish is forward-only](guide/correctness.md#publish-is-forward-only)). The others throw the `TransientError`,
     and a re-run is safe: a crypto-shred, a drop's tombstone, `setRetention`, `clearRetention`, a rollback's move and
     move back, a sweep's deletes, and a storage delete;
   - a record of a crypto-shred whose answer and read-back were both lost. The tombstone does not say which call wrote it
     or that it was a crypto-shred, so the re-run answers `'already'` and emits no `segment.erase`;
   - a delete that lands after the read that checked it, and a registry that reports no write tokens. Both end as the fault the call reports; running the call again is safe;
   - a rollback's move back restores the ledger the row had before the move, so a ledger-only write made in between (a
     prune) is undone with it;
   - a `rollback` with no key at hand (no keystore, or one that cannot open the key) below the pointer of an encrypted
     segment whose row has no usable `knownGens`, or onto a number below a full list's oldest entry, which opens nothing:
     it checks that the object is in the bucket and, from its footer, that it is encrypted exactly when the row has
     keys, so it can still move onto an object sealed under a key no row holds, which then fails every read and which
     `checkConsistency` does not flag. Every other target is held to the row's recorded footer checksum, or needs
     `allowUnknown` and the key;
   - the parts stretch, under [Planned](#planned--exploring);
   - the lifecycle check's gaps. An abort-incomplete-upload rule on one namespace's keys silences that advice for every
     namespace of the store. On GCS a `403` that is a billing or network-perimeter refusal gets the permission advice,
     which would not fix it. With no `prefix` it judges every rule it can read as if it covered the store, with no match
     against the key layout. S3's separate Intelligent-Tiering archive configuration is not read;
   - `preflight()`'s accepted limits. Its cleanup delete after a failed write is unconditional, and a conflict whose
     error cannot be read counts as a failure rather than another run's object, so a probe left at the same 48-bit
     number by another run can be removed. A
     listing pages through every leftover probe and names the first few. A `LocalFsStorage` host path can appear in an
     `EACCES` detail. The steps that follow a failed write read `no object was written`, which a write that lost its response
     could contradict;
   - the one round trip between a tombstone collection's last re-proof of the row and its delete by number: a name
     purged and created again inside it can lose a generation under that number, and the pass does not see it, since
     no read of the row follows its last delete. Only a conditional delete from the listing's object
     versions closes it. A read of the row after the last delete, held to the row's incarnation, would report the loss
     rather than prevent it: today a loss after an earlier delete shows at the next re-proof as a changed row, a lost
     race; after the last it is unseen, and if the re-created name still has objects the sweep counts a purge fault
     (the tombstone's objects were still there after its collection), while with none left its row delete loses its
     fence and is a lost race. On a registry whose tokens carry no incarnation id (none that this library ships), a
     name purged, created again and itself destroyed, sharing one creation stamp, is accepted as the tombstone a pass was
     asked for: its leftovers are deleted, which the collection rule allows, but the erasure's event names them as the
     asked-for row's, since the event carries no incarnation to tell the two apart;
   - on Azure Blob a load that loses an ordinary race at the registry carries `unanswered: true` on its
     `segment.load-refused` event too, since the driver cannot see its client's retry and so marks every conflict of a
     row write as one that may follow the write's own landing. A narrower mark would read the counter in the row's token
     (tokens are `incarnation.counter.write`): after a compare-and-swap's conflict, a row at counter n+1 under another
     token in the same incarnation proves this write did not land, from a read the publish already makes. That holds for
     a compare-and-swap only: a create starts a new incarnation, so it has no counter to compare. The SDK exposes no
     request counter to read instead;
   - on Azure Blob a create's only condition is `ifNoneMatch: '*'`, its client's retry sends it again, and a success has
     no read-back. Inside the retry window after a `setRetention`, a retirement and its purge, the replay finds the row
     absent and creates it again with the token it was first written with and, on a first load that minted a key, the
     wrapped key a shred removed, and the load reports itself published. Rare, since only the retention sweep deletes a
     segment row. To fix;
   - the erasure's own collections on an active row, which are not held to the row they worked from (one round trip,
     and the collection spares what the row names): they should decline quietly when the row changed;
   - the erasure's two passes over a tombstone: an erasure that finds the row tombstoned mid-call (the first pass
     started on an active row) searches again under the tombstone and merges the two passes without checking that both
     saw one incarnation of the name, so a purge and re-creation between them mixes `collected` and `fromGeneration` from two.

   Multi-tenant isolation is tracked separately, post-`1.0`.
10. **The cost model in a package of its own — ✅ Shipped.** `estimateCost`,
    `groundedReport` and the price lists are in `@cloudbitmaps/tools`, a package of offline tools that need nothing
    internal from a store, and the library carries none of them. `stat()` reports the generation's byte size, so a
    grounded report needs nothing internal, and a price list for S3, GCS or Azure is a change to that package alone,
    which ships with the family's next release.
11. **A segment's resolution kept apart from its reader — ✅ Shipped.** A store with
    a timed refresh keeps each segment's resolution (the fields of its row a read resolves through: the generation, the
    `pointerId`, the wrapped keys and the summary, never an unwrapped key) for `cache.genTtlMs` from the instant the
    registry read was sent, whether or not the segment's reader is still open, in a cache bounded by
    8 × `cache.readerMax` entries and `cache.readerMaxBytes` / 16 bytes. A store reading more segments at once than its
    reader cache keeps (as on a small Lambda) does not ask the registry again for a segment whose reader was let go,
    and every chunk of a read agrees on one generation until the refresh, unless the resolution cache lets the
    resolution go or a read of the segment heals it (finding its generation swept or another object under its number)
    or fails to open it. An eviction costs only the reopen a read needs: where the row has a summary the store can use,
    the version a cached chunk is checked against comes from it, since it names the object, so a `has()` of a cached
    chunk, a `count()` and a `stat()` open nothing, while `iterate` and the combines open the object for its index. On
    an encrypted segment the key is unwrapped again. A store with no timed refresh keeps no resolution, and an eviction re-resolves there.

## Planned / exploring

None of these are committed and none have dates. If one matters to you,
[open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) and say so — that's the single best way to
move it up.

- **A construction-time check that refuses mixed `@cloudbitmaps/*` versions.** Today a flavor beside a driver of another version installs with no warning and fails to compile (two copies of `core`). A check when the store is built could refuse it at run time with a message naming both versions, or an exact `peerDependencies` entry could make the install itself refuse. Considered in a later release.
- **Answer an encrypted leftover object from its first tail read.** The search `subjectReport` and `eraseSubject` make
  under a destroyed segment reads an encrypted object's tail twice (the open, then the footer that says it is
  encrypted), 20 reads for a crypto-shred that left 10 objects, paid by every report that scopes it for as long as the
  objects stay. The footer is already in the first tail read, so one read would halve it in the report and the erasure
  alike.
- **A fenced in-place update of a segment from its own content.** Today an `*Into` into one of its own sources, and a
  `load` of ids read from the segment it writes, are refused, because a result built from a stale view must not replace
  another writer's newer load; the way to update a segment is to write a new one and point readers at it. The planned
  form reads the source at a pin and publishes only if the segment is still at the generation it read, a conflict
  otherwise.
- **A plain copy verb.** Copying a segment into another is `materializeMany` with the segment as its one operand today,
  which reads once at one instant but is a batch call; a single verb would say it directly.
- **`analyze` — try it on your own data before adopting anything.** Point a command at a file of your IDs and it
  measures what actually matters (cardinality, compressed size, and above all **chunk density**), then tells you
  the object size, the read cost and the monthly figure that follow — **offline, with no cloud account and
  nothing created**. Today's cost tooling can only answer that once you're already a user, which is backwards. It
  would also answer what Roaring is buying you on your particular ids &mdash; which is a real
  question, since the answer ranges from 543x to nothing.
- **A data key per generation.** A segment seals every generation under one data key for its whole life, so the count
  of seals under that key grows with every load and erasure rewrite, and a full-width segment reloaded every few minutes
  passes the 2³² seals below which a repeated random nonce is negligibly unlikely
  ([how many seals one key takes](guide/correctness.md#seal-count)). Deriving a key per generation from the segment's
  key bounds each key to one generation's seals. It changes how a generation is sealed and the keystore port, so it is
  decided at the `1.0` format freeze, not before.
- **A scope of its own for un-namespaced segments.** A segment loaded with no `namespace` is reached by
  `subjectReport`, `eraseSubject` and `retireExpired` only when the call covers every namespace (`allNamespaces: true`,
  or no `namespace` on a sweep), because the registry port cannot list the absent namespace alone, and `'_default'`
  names an ordinary namespace. A scope for just those segments needs a filter on the registry port.
- **Multi-region active/active** — region-local by design for the `1.0` line; not ruled out beyond it.
- **A ledger that tells a generation a load published from one a seed recorded.** A rollback refuses a generation the
  row's `knownGens` does not name, but a publish over a row with no usable ledger seeds one from the bucket, an orphan or
  stray included, so a rollback accepts a seeded orphan as it accepts any known generation. A footer now names one write
  (it carries a write identity), so the ledger's footer checksum tells a generation from another write's object under
  its number, but a ledger seeded from the bucket records an orphan's footer as it records any other
  ([an orphan is collected later](guide/correctness.md#how-a-load-stays-correct)). Telling a published generation from a seeded
  orphan takes a record of which load published it.
- **One generation from parts built in several processes.** Several workers, each owning a disjoint range of the id
  space, publishing one generation together without re-encoding. The format already allows it (a chunk's checksum
  and its encryption are bound to the chunk, not its position); what it needs is a server-side compose on every
  storage driver, a protocol for reserving the generation and sharing its key, and collection of the parts. In one
  process it needs nothing: `orInPlace` over the parts one at a time (or `RoaringBitmap.orMany` when every part fits in memory at once), then one load, as the
  [loading guide](guide/loading.md#what-a-load-accepts) shows.
- **The billions-of-IDs axis** — 64-bit IDs (space is already reserved in the format) plus an external-merge
  bulk load that never buffers the distinct set of unsorted ids (ids that already ascend need none: `sorted: true`).
- **Language ports** — Go, Python, Rust reading and writing the same `.crbm` objects. Strictly *after* the
  format freeze; a port before then would be a compatibility trap. One concrete requirement a port must meet:
  storage generations contain **run containers**. Runs are part of the standard portable Roaring format, but a
  bitmap that has any announces itself with a different header cookie (`SERIAL_COOKIE` rather than
  `SERIAL_COOKIE_NO_RUNCONTAINER`). Every maintained Roaring implementation reads both; a hand-rolled or cut-down
  reader has to be tested against both.
- **The weaknesses, and a direction for each** — the [what it saves](guide/why-cloudbitmaps.md#what-is-planned-for-each-weakness)
  page has them side by side. None is built; each will be proposed in an issue on this repo before it is, and one that
  changes the public API agreed there first.
  - **A chunk cache sized by bytes.** The chunk cache is bounded by count today, so the same setting holds very
    different amounts of memory for sparse and dense chunks; bounding it by bytes lets a repeat intersect read no
    chunks however small they are.
  - **A shared cache tier, by composition** — a port that a Valkey, Redis or local-disk adapter package implements,
    holding the hot set's immutable bytes for a fleet of stateless readers, with nothing added to a store that does
    not use it.
  - **Push invalidation for the pointer refresh** — object-store events telling readers a segment changed, with the
    refresh kept as a longer backstop, and an `expire(ref)` that costs one lookup where `invalidate` scans the cache.
  - **Retrying at one layer.** The SDKs retry throttling and the library retries it again, so one slow request can
    become a dozen; throttling belongs to the SDK's retry alone.
- **Membership from an edge runtime — explicitly *not* supported today, and being explored.** A Cloudflare
  Worker answering "is id N in segment S?" against a storage generation in R2 is two ranged reads and a decode,
  which is the access pattern this format was designed for. What stops it is not the engine: core's main entry,
  with every module it reaches, imports no `node:*` builtin and has zero runtime dependencies, and `pnpm smoke` loads
  the built entry, bundled for a platform with no builtin, in a `node:vm` context holding only web-platform globals,
  with string code generation off and random values, timers and `fetch` refused at global scope (two rules Workers
  documents), on every CI run. That is as close to an isolate as CI gets today, and it is a load, not a run. It is not
  the codec either: the store's codec is TypeScript, with no native addon. The flavor's entry imports Node builtins
  (`node:crypto`, `node:fs`) for its in-memory and local-disk backends and its entropy, and no runtime but Node is
  tested. So the first piece is a dependency-free JavaScript **reader** for the standard portable Roaring format, which is in
  the tree, is checked against the native library on 200 randomly-shaped bitmaps plus every container
  encoding, refuses the same malformed bytes the codec's decoder does because the two share one structural check, and
  is **not exported, not wired into anything, and not something you can use yet**. Read-only by
  design: loads stay in Node. **We will not claim this works on any
  runtime until CI runs the conformance suite inside that runtime**: what a runtime can load is easy to get
  wrong, and a claim is not a test. Running the conformance suite inside an isolate also needs an in-memory backend that
  loads there. `MemoryStorage` hashes with `node:crypto`, so it is exported by `@cloudbitmaps/core/node` and not the
  main entry. Porting that hash to Web Crypto and returning the backend to the main entry means re-measuring the two
  benches that time loads onto it, since the hash would then settle on the thread pool.
- **An optional WebAssembly module for the dense word kernels.** The union of many dense bitmaps and the counts over dense
  containers are among the cells that stay far from the native binding in plain JavaScript, because they are loops over
  2,048 words that WebAssembly can run several words at a time. In the published table the union of 64 dense bitmaps
  reads about 11 times native and the dense counts about 8 (7.8 and 8.5); the cold first `deserialize` is further (about 14.6 times)
  and is a cost of the first call in a fresh process. The union and the first `deserialize` are the two methods above 10 times native, and both ship with their
  figures shown. An optional module, loaded only by a caller that asks for
  it, would leave the default install with nothing to compile. Whether it is worth its size and its second code path is
  decided from the published table.
- **Incremental writes, if there is demand** — immutable delta generations on the same bucket, read as base ∪ deltas at
  chunk granularity; never a mutable row store. Nothing is queued; an issue describing a workload that genuinely
  cannot micro-batch into a load is what would move it.

## Deliberately not planned

Saying no is part of the design:

- **A WebAssembly build of CRoaring.** The store's codec is Roaring in TypeScript: no install script, no prebuilt
  binary and nothing to compile, so a WebAssembly build of CRoaring as a second codec would replace no native addon.
  (Alpine is not measured; the [codec page](guide/roaring-codec.md) says what is and is not.)
- **Combining segments of two stores.** Not supported: a combine resolves each operand by name in its own store, so a
  handle of another store would be read as the receiver's segment of that name. It is refused, never bridged. Load
  both segments into one store, or read each store and combine the ids upstream; for two store objects over one
  backend, open both with one store's `segment()`.
- **A per-call write API.** `add`/`remove` over a mutable tier is not built beside the loaded store: two write
  paths with different consistency stories would double the surface every invariant has to hold across, and every
  roaring-based engine that needs freshness micro-batches anyway. Compute the set upstream and load it; if a
  workload genuinely cannot, see the incremental-writes note above.
- **A scheduler for the retention sweep.** Segment-level retention ships; the heartbeat that calls it stays yours,
  and that is a decision rather than a gap. A library that started a timer would behave differently in a Lambda, an
  edge isolate and a long-lived server — the first piece of API that works in some runtimes and not others — and it
  would *hide* the operational burden rather than remove it: a sweep failing silently inside an app server with no
  alarm is worse than a CronJob that shows up red in a dashboard. Nothing here is a daemon: the sweep is a call you schedule.
- **A time floor on generation GC.** "Collect nothing superseded less than 24 hours ago" would read as a
  durability guarantee and would not be one. An ordinary read already heals forward: if the generation it is
  reading is swept, the fetch re-resolves the pointer and retries once, serving the newer committed generation —
  so a floor buys an avoided round trip, not a saved query. A job that genuinely must not change generations
  needs a snapshot handle (above), and a window merely wide enough to hope with is a different, weaker promise
  wearing the same words. A job with a known end can lease that handle (`pin({ leaseUntil })`, up to 14 days), which
  holds the one generation it names, never delays any other, and ends in a typed error. The cost side — generations piling up because nothing collects them — is what `keep`
  is for; sizing it is in the
  [guide](guide/loading.md#generations-and-keep).
- **Per-id TTL.** A bitmap stores ids, not `(id, timestamp)` pairs; a timestamp per id costs 4–8 bytes each and
  takes the compression the whole design exists for. Not deferred — incompatible with the data model.
- **A hosted/managed CloudBitmaps service.** Never — this is a library. Your data stays in your account, in
  your buckets, under your keys.
- **Telemetry or phone-home.** Nothing is ever sent to us. Observability is an injected sink you own.
- **An `id → segments` reverse index.** It would cost a second inverted copy of all your data, rebuilt on every
  load, to speed up a rare subject-access request. `subjectReport` scans instead. It could return as an opt-in
  add-on if a real deployment needs sub-second lookups at billion scale.
- **A generic `bitset` flavor** (`@cloudbitmaps/bitset`). Above about **6% density** a Roaring chunk is already
  stored as an uncompressed bitset, or as runs where those are smaller, so a plain codec has no size to win. In the
  encoded sizes [`bench/encoding.cjs`](../bench/encoding.cjs) measures on four shapes of ids, a bitset over the
  ids' span is about **2%** smaller than Roaring on the one built to favour it, a half-dense block. On the other
  three Roaring is smaller than the best fixed form for each shape: 543× and 63× smaller than a bitset over the
  span on the dense and the clustered shapes, and 1.88× smaller than a sorted array of 32-bit ids on the sparse
  one, where a bitset would be larger still. What a flat bitset keeps is faster random access, one shift-and-mask against a
  container lookup: CPU time inside an operation that waits on an object-storage request. The codec seam stays;
  nothing is queued to fill it.
- **New container algorithms.** The store's codec implements the Roaring format and the algorithms of Lemire et al., with
  CRoaring as the reference its tests compare it against. The object-store layout and the chunk-skipping reads are the
  contribution; the container algorithms are not ours to re-invent.
- **Any feature that taxes the hot path** (`has` / `count` / `intersect` / `union` / `andNot`) to speed up a
  rare operation. If it can't be pushed to wiring time, load time, a scheduled pass, an admin call, or the docs,
  it doesn't ship.

## A note on priorities

CloudBitmaps is built in the open by one maintainer, so priorities can and will shift, and nothing here is a
schedule or a commitment. The best way to influence what gets built next is to
[open an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) — to discuss a use case, report a bug, or
tell us something behaved wrong. Contributions are welcome: start with
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
