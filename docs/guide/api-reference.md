# API Reference — the complete surface

The single source of truth for **everything a user can import and call** across all entry points. Organized
user-first: the everyday surface at the top, the occasional operations next, the driver-author plumbing last, and
a flat **[Complete export index](#complete-export-index)** at the end that names every export.

> **Kept in sync by CI.** [`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts)
> extracts every exported name from **both** package barrels (`packages/roaring/src/index.ts` and the
> `packages/core/src/index.ts` it re-exports) plus each driver-subpath barrel under `packages/core/src/*/index.ts`
> and `packages/roaring/src/*/index.ts`, and fails the build if any is missing from this page. So a new export
> **cannot** merge without being documented here. (The guard is one-way — it catches undocumented _additions_, not
> stale entries for a _removed_ export; prune those in review.)

---

## Mental model: three nouns, one way in

```
a STORE  ──has many──▶  SEGMENTS  ──each is──▶  write-once GENERATIONS (.crbm objects) behind ONE registry pointer
CloudRoaring            store.segment('name')    <segment>.<gen>.crbm  ·  registry row: { currentGen }
```

A segment holds **IDs** (`u32` integers, `[0, 2³²)`). Data enters a segment **only as a new generation**: a load
(`bulkLoadCrbmGeneration`) writes one immutable object and then publishes it — a forward-only compare-and-swap of
the pointer. Every other write in the library is a load in disguise: the `*Into` verbs write a new generation of
their destination, and a subject erasure rewrites the current generation without one id. Reads (`has` / `count` /
`iterate` / `intersect` / `union` / `andNot`) resolve the current generation once and read whole, checksum-verified
chunks from it. There is no `add`, no `remove`, and no mutable tier.

## Entry points

You install **one flavor package** — `@cloudbitmaps/roaring` — and `@cloudbitmaps/core` arrives transitively.
Everything below is reachable from the flavor:

```
@cloudbitmaps/roaring            the store + memory/localfs drivers + every function & type
@cloudbitmaps/roaring/s3         S3ColdDriver, S3RegistryDriver          (peer: @aws-sdk/client-s3)
@cloudbitmaps/roaring/dynamodb   DynamoDbRegistryDriver                  (peer: @aws-sdk/client-dynamodb)
@cloudbitmaps/roaring/gcs        GcsColdDriver                           (peer: @google-cloud/storage)
@cloudbitmaps/roaring/azure      AzureBlobColdDriver                     (peer: @azure/storage-blob)
CLI (binary):                    export-segments
```

**Where the code actually lives.** The flavor package is the roaring codec (`SafeBitmap` / `roaringCodec`), the
`CloudRoaring` facade, and the `export-segments` CLI; its main barrel re-exports `@cloudbitmaps/core` wholesale and each
`/<backend>` barrel is a one-line re-export of `@cloudbitmaps/core/<backend>` — the drivers are codec-agnostic,
so one set in core serves every flavor. A flavor or driver author who depends on core directly imports the same
surface from `@cloudbitmaps/core` and its `/s3`, `/dynamodb`, `/gcs`, `/azure` subpaths. Applications never need to name core.

---

## The everyday surface (what you'll call)

### Build a store — `new CloudRoaring(options)`

`cold` is the **only required option**; add `registry` for one-read generation resolution, encrypted segments,
the `*Into` verbs and every lifecycle helper (recommended for anything beyond a first look). Everything else is
optional tuning with sensible defaults — see [`CloudRoaringOptions`](#construction--result-types).

Pick one driver per slot (all interchangeable; mix backends freely):

| Slot | in-memory | local disk | cloud |
|---|---|---|---|
| **cold** (the `.crbm` generations) | `MemoryColdDriver` · `MemoryColdChunkSource` | `LocalFsColdDriver` | `S3ColdDriver` · `GcsColdDriver` · `AzureBlobColdDriver` |
| **registry** (the `currentGen` pointer + wrapped keys) | `MemoryRegistryDriver` | `LocalFsRegistryDriver` | `DynamoDbRegistryDriver` · `S3RegistryDriver` |
| **keystore** (optional encryption) | `InProcessKeystore` (BYOK) | ← same | ← same |

Pass a **raw** `IColdDriver` as `cold` and the store builds the `.crbm` reader (`CrbmColdChunkSource`) over it with
your `registry` / `keystore`; or pass a pre-built `ColdChunkSource` (`MemoryColdChunkSource`, or a
`CrbmColdChunkSource` you configured yourself) and it is used as-is — the top-level `registry` / `keystore` /
`requireEncryption` are then rejected as a wiring mistake (configure them on the source). A store built on a
pre-built source is **read-only**: the `*Into` verbs and the lifecycle helpers need the raw driver and throw
`UnsupportedError`.

### Get a segment — `store.segment(name, { namespace?, expiresAt? })` → `Segment`

`expiresAt` is an absolute epoch-**milliseconds** deadline, declared where the segment is named. Past it, every
read through **that handle** answers empty — `has` → `false`, `count` → `0`, `iterate` → nothing — as one integer
compare against the injected clock, with **no I/O, on every backend**. Set algebra stays coherent with it: an
expired operand makes an `intersect` empty, is dropped from a `union`, and excludes nothing in an `andNot`.

It does **not** reclaim the bytes (`retireExpired` does, so `count()` reporting 0 while objects still exist is the
expected state in that window) and it does **not** apply to other handles — record the policy with
`setRetention` to make it durable, fleet-visible and reclaimable. A seconds-shaped value is refused at the
handle rather than silently making the segment permanently empty. `seg.expiresAt` reads it back.

### Load a generation — `bulkLoadCrbmGeneration(cold, { segment, namespace?, generation }, ids, { registry, … })`

**The write path.** Streams `ids` — any sync **or async** iterable, unsorted, duplicates welcome — into one
immutable `.crbm` object at `generation`, then publishes it through `registry` (forward-only). Returns a
`BulkLoadResult` — `{ size, sha256, chunkCount, cardinality, becameCurrent? }`. Take the generation number from
`nextGeneration(ref, { cold, registry })`; a re-used number throws `WriteConflictError` (write-once), and a
publish that would move the pointer backwards is a no-op, so a rerun is safe and a crash before the publish never
moves the pointer. Options: `registry?` (publish; required for encryption), `keystore?` (write encrypted — mints
the segment's DEK on its **first** generation, reuses it afterwards, and never encrypts a segment whose existing
generations are cleartext), `requireEncryption?`, `audit?` (emits `segment.publish`), `codec?` and `clock?` (both
pre-bound by `@cloudbitmaps/roaring`; the clock is what makes a long load yield the event loop). Memory is bounded
by the **distinct set** being built, not by the input length — a batch job's shape, not a request handler's.

`becameCurrent` says whether this generation is now the segment's current one; it is absent when no `registry`
was wired, since there is then no pointer to move. **`false` means the object is durable and the load did not
take effect** — a concurrent writer published a higher generation first, so yours is an orphan no reader will
resolve. Branch on it if two writers can target one segment; the orphan is collected by
`gcOrphanGenerations`/the retention sweep.

### The segment verbs (the ~90% of daily use)

| Call | Does |
|---|---|
| `seg.has(id)` → `Promise<boolean>` | membership: the hot cache, else **one** ranged GET of that id's chunk |
| `seg.count()` → `Promise<number>` | exact cardinality, summed from the `.crbm` index — **zero payload reads** on a loaded segment |
| `seg.iterate()` → `AsyncIterable<number>` | stream all ids, ascending, one chunk at a time |
| `seg.pin()` → `Promise<Segment>` | **hold this segment at the generation current right now**, for the life of the returned handle — so a long export, reconciliation or send describes **one instant** instead of whichever generations happened to be current as it ran. An ordinary handle re-resolves on `coldGenTtlMs`; a pinned one does not. Only *this* segment is pinned: `snap.intersect([other])` reads `snap` at its pin and `other` live, so pin each segment to hold a whole query — and a pinned handle used as an operand is still read at its pin, never live. **A hold, not a lease**: nothing stops `gcOrphanGenerations` deleting the generation underneath you, and a pinned read deliberately does *not* heal forward (silently serving a different generation is what a pin exists to prevent), so it fails instead — size `keep` past your longest pinned job. The pinned reader lives in the same bounded LRU as every other, so a pin costs a generation number, not a retained index. A segment with no current generation pins nothing and reads empty. A pin taken before a crypto-shred stops reading when the shred lands: the row's `status` is re-checked every time the pinned reader opens. Needs the `.crbm` cold source (`UnsupportedError` otherwise) |
| `seg.intersect([other, …], { concurrency?, budget?, exclude? })` → `AsyncIterable<number>` | **the crown jewel** — chunk-skipping intersection, streamed. `exclude` subtracts suppression segments **in the same pass** |
| `seg.union([other, …], { concurrency?, budget?, exclude? })` → `AsyncIterable<number>` | `this ∪ others`, streamed. The one composite with **no chunk-skipping** — every chunk of every operand is read |
| `seg.andNot([sup, …], { concurrency?, budget? })` → `AsyncIterable<number>` | `this \ (sup…)`. Reads all of `this`, but each exclude **only where it overlaps** |
| `seg.intersectInto(dest, [other, …], opts?)` · `seg.unionInto(dest, [other, …], opts?)` · `seg.andNotInto(dest, [sup, …], opts?)` → `Promise<MaterializeResult>` | materialize the result as a **new generation of `dest`** — `dest`'s previous contents are superseded, not added to. Streaming, bounded memory, published forward-only, so readers of `dest` see the old generation or the new one, never a partial. An empty result publishes an empty generation, **except** that a call involving an expired handle is refused (`ValidationError`) rather than wiping `dest`. Throws `WriteConflictError` if a concurrent writer publishes a higher generation of `dest` first, rather than returning a generation that never became current. `opts.audit` emits `segment.publish` for the generation it lands. Needs a raw cold driver + registry |
| `seg.costReport({ pricing?, workload? })` → `Promise<CostReport>` | grounded $ report from the segment's **real** `.crbm` size (no payload reads) |
| `seg.expiresAt` | the handle's deadline, if one was declared |

That's the whole daily surface: **1 constructor + a cold driver + a registry + one load function + these verbs.**

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

**Read consistency.** Every read op resolves the segment's current generation **once** and reads every chunk from
that generation. With a `registry` wired, a long-lived store re-resolves the pointer on a short TTL
(`coldGenTtlMs`, default 2000 ms), so after a load publishes, a reader may serve the previous generation for at most
that long, then converges; the hot cache is keyed by generation, so a new generation is never served from stale
decoded chunks.

---

## Operations you call when you need them

### Store methods

| Call | Does |
|---|---|
| `store.subjectReport(id, { namespace? \| allNamespaces?, concurrency?, budget? })` → `SubjectReport` | GDPR Art. 15 — which registered segments is this id in? (needs an explicit namespace or an `allNamespaces` ack) |
| `store.eraseSubject(id, { namespace? \| allNamespaces?, audit?, concurrency?, budget? })` → `EraseSubjectResult` | GDPR Art. 17 — for every registered segment the id is in, **rewrite the current generation without it**, publish fenced on the generation it streamed, and delete the generation that held the bit, so it is physically gone from the bucket on return. Returns the erasure ledger: one `SubjectErasureEntry` per segment the id was found in (`erased`, `fromGeneration`, `generation`, and a `note` — `'superseded'` when another writer moved the pointer mid-rewrite, meaning *this call* did not erase the id rather than that the id is still there, or `error: …` for an isolated fault; re-run either). Emits `segment.rewrite` per rewrite when `audit` is passed. Do not load the segment while erasing from it. Needs a raw cold driver + registry |
| `store.dropSegment(ref, { confirmSegment, dryRun?, audit? })` → `DropResult` | **retire a segment and reclaim its storage** — registry tombstone first, then every Cold generation (swept up to three passes; **check `generationsRemaining`** — non-empty means bytes survived and the drop should be re-run). Branch on `dropped`; `reason` is `'already'` if it was already a tombstone (a re-drop still re-sweeps Cold), `'absent'` only when **nothing existed** — the one worth alerting on. On an encrypted segment it also drops the DEK (`cryptoShredded: true`). `dryRun` previews `wouldDelete` / `wouldCryptoShred` without touching anything. Reads become empty within `coldGenTtlMs` for a reader that has a clock and a registry. Needs a raw cold driver + registry |
| `store.setRetention(ref, { expiresAt })` → `SetRetentionResult` | **record when this segment becomes eligible for retirement** — one registry write, nothing deleted, nothing scheduled. `expiresAt` is an absolute epoch-**ms you compute** (a duration the library derived would be anchored to `updatedAt`/`currentGen`, both of which every load rewrites, so a busy segment would never expire). Works **before the first load**: it mints the registry row (`createdRow: true`) with `currentGen: null` — no Cold generation — so the segment is enumerable by the sweep and the first publish lands on that row. `indexed` says whether the due-index pointer was written (false is a degradation: the fleet scan still retires it). Rejects a value below `MIN_EXPIRES_AT_MS` (almost certainly epoch *seconds*) and refuses a crypto-shredded segment |
| `store.getRetention(ref)` → `RetentionPolicy \| null \| 'invalid'` | the stored policy; `null` for none, `'invalid'` for a present-but-unusable `expiresAt` (a hand-edited row, a restore) so a malformed policy is visible rather than reading as "never expires" |
| `store.clearRetention(ref)` → `boolean` | cancel the expiry; returns whether one was actually removed. A separate verb from setting one on purpose — "never expire" as a magic value passed to the setter is how a typo becomes a deletion |
| `store.retireExpired({ namespace?, now?, limit?, dryRun?, scan?, lookbackBuckets?, shards?, totalShards?, maxScanSegments?, purgeTombstones?, tombstoneGraceMs?, audit? })` → `RetireExpiredResult` | **the retention sweep** — retire every segment whose `expiresAt` has passed, each through `dropSegment` (one implementation of the registry → Cold ordering, not two). **A call, not a daemon**: you schedule it (EventBridge, CronJob, cron, a queue job). Returns a per-segment ledger; a per-segment *fault* is an `entries` row rather than a throw, though a bad argument throws `ValidationError` and a fleet past `maxScanSegments` throws `BudgetExceededError`. `limit` (default 100) caps **attempts**, so a partial outage cannot march through the fleet; `limited: true` means more are eligible, re-run. `dryRun` is the real preview (`confirmSegment` is vacuous in a loop) and reports `wouldRetire`, leaving `retired` at 0. **`scan: 'index'`** reads only the due buckets of the due index — cost tracks what is *expiring*, not the fleet — re-reading each live row before acting; it is the **fast half of a pair**, so run the default `'fleet'` periodically as the repair pass (`lookbackBuckets`, default 7, is how many past days a fast scan also reads). `shards` / `totalShards` give each replica a disjoint slice by a stable hash of the segment key. Also deletes the tombstone rows **it stamped itself**, after `tombstoneGraceMs` (default 24 h) and only once Cold is provably empty (collecting a straggler generation first); a `destroyed` row it did not create — a GDPR crypto-shred — is never touched. Needs a raw cold driver + registry |
| `store.checkConsistency({ namespace?, concurrency? })` → `ConsistencyReport` | DR: verify every segment's `currentGen` `.crbm` is present (catch a torn cross-store restore). Needs a raw cold driver + registry |
| `store.exportSegments(sink, { format?, namespace?, ndjsonBatchBytes? })` → `ExportManifest` | eject every registered segment's current generation to portable `roaring`/`ndjson` through your sink. Needs a registry |
| `CloudRoaring.estimateCost(input)` → `CostReport` | **static** — plan costs with no instance/data (sizing, what-if) |

### Standalone functions (imported, called directly)

The out-of-process forms: a scheduled job or CLI wires its own drivers and calls these. Where a store method exists,
it is the same function over the store's own drivers.

| Call | Does |
|---|---|
| `bulkLoadCrbmGeneration(cold, key, ids, { registry?, keystore?, requireEncryption?, audit?, codec?, clock? })` → `BulkLoadResult` | **load** a generation from a (huge, unsorted, sync or async) id stream and publish it — see [above](#load-a-generation--bulkloadcrbmgenerationcold--segment-namespace-generation--ids--registry) |
| `nextGeneration(ref, { cold, registry })` → `number` | the generation number a writer should take next: one above the highest the registry points at **or** that is present in Cold (a load that wrote its object and crashed before publishing leaves an object above `currentGen`; skipping past it keeps the retry trivial). A segment with no row and no objects starts at `0` |
| `gcOrphanGenerations(ref, { cold, registry }, { keep? })` → `number[]` | delete superseded generations — everything below `currentGen` except the newest `keep` (default 1) as a grace window for in-flight readers. Never touches `currentGen` or anything above it, and deletes nothing while `currentGen` is `null`. **Exception:** on a `destroyed` segment every generation is garbage and all are collected. Nothing schedules this: the erasure rewrite calls it with `keep: 0`, the retention sweep calls it on tombstones, and a caller writing generations by hand collects on its own cadence. Returns the generations deleted |
| `publishGeneration(registry, key, { wrappedDeks?, expectFrom? })` → `boolean` | point `currentGen` at `key.generation`. **Forward-only and idempotent**: creates the row if absent, advances via CAS, returns `false` (a no-op) if a newer generation is already current, refuses a `destroyed` row. Separated from the object write so a caller publishes only after the object is durable. `expectFrom` makes it a **read-modify-write**: the publish lands only while `currentGen` is still exactly that number, and returns `false` otherwise — which is what a writer whose content was *derived* from a particular generation needs (the erasure rewrite), as against a load, whose ids come from upstream and lose nothing by winning. New key material is refused on an advance: a segment's encryption is decided at its first generation |
| `writeCrbmGeneration(driver, key, chunks, { crypto?, clock? })` → `{ size, sha256 }` | the lower-level seed primitive: write one generation from pre-grouped `{ chunkKey, bitmap }` entries (empty bitmaps skipped). Does **not** publish |
| `eraseIdFromSegment(ref, id, { cold, registry, keystore?, requireEncryption?, codec?, clock?, maxBitmapBytes? }, { audit? })` → `EraseIdResult` | remove **one id** from one segment by rewriting its current generation without it (streamed, one chunk in flight), verifying the rewrite, publishing it fenced on the generation it streamed, and collecting the superseded generation (`keep: 0`). `erased: true` means the bit is physically gone on return; otherwise `reason` is `'absent'` · `'destroyed'` · `'no-generation'` · `'not-member'` · `'superseded'` (another writer moved the pointer off `fromGeneration` while the rewrite was in flight — a load, or another erasure. It means *this call* did not erase the id, not that the id is still there: re-run, and if a racing erasure of the same id got there first the re-run reports `'not-member'`. A racing erasure collects with `keep: 0`, so it can delete the generation this call was streaming or the object it had just written; the reason is read off the row, so a row tombstoned mid-rewrite reports `'destroyed'` and one purged by the retention sweep reports `'absent'`. A `NotFoundError` is raised only when the pointer still names the missing object — the forbidden `missing-cold-generation` state, which no re-run fixes). `collected` lists the generations it deleted — the evidence for the physical half of an Art. 17 erasure, and what to keep if you are building a proof-of-deletion artifact. A publish that could not collect **throws** rather than report `erased: true` over bytes still there, and a chunk holding an out-of-range value throws `IntegrityError` rather than being re-encoded into the new generation (a corrupt segment is reported as corrupt, not erased). `store.eraseSubject` runs this over every registered segment |
| `destroySegment(ref, { registry }, { confirmSegment, allowCleartext?, audit? })` → `DestroyResult` | crypto-shred one whole segment (key deleted → bytes unrecoverable everywhere, backups included); leaves the objects in the bucket, needs encryption unless `allowCleartext` |
| `eraseNamespace(namespace, { registry }, { confirmNamespace, allowCleartext?, audit? })` → `{ destroyed: DestroyResult[] }` | crypto-shred an entire namespace / tenant; per-segment faults land in the ledger (`reason: 'contended'` / `` `failed: …` ``) — **inspect it** |
| `dropSegment(ref, { registry, cold }, { confirmSegment, dryRun?, audit? })` → `DropResult` | **dispose of a segment** — tombstone, then delete every Cold generation. Works on cleartext; also crypto-shreds an encrypted one. `store.dropSegment` is the wired form |
| `drainRegistry(registry, { namespace?, maxScanSegments, op })` → `RegistryRecord[]` | the one bounded drain of `registry.list()` — shared by `checkConsistency` and `retireExpired`; refuses past the ceiling rather than exhausting memory. `validateMaxScanSegments(value, op)` is its fail-fast check |
| `runConsistencyCheck({ cold, registry }, { namespace?, concurrency? })` → `ConsistencyReport` | the free function behind `store.checkConsistency` — run it over your own drivers |
| `setSegmentRetention(ref, { registry }, { expiresAt })` → `SetRetentionResult` | the free function behind `store.setRetention` — for a scheduler/CLI that holds only a registry driver. `getSegmentRetention(ref, { registry })` / `clearSegmentRetention(ref, { registry })` are its read/cancel siblings |
| `readRetentionPolicy(record.retention)` → `RetentionPolicy \| null \| 'invalid'` | parse a policy out of a row you already have (a `list()` sweep does this — no extra read per segment) |
| `retireExpired({ registry, cold }, { now, … })` → `RetireExpiredResult` | the free function behind `store.retireExpired` — for a scheduled worker that wires its own drivers. `now` is explicit here (core takes its time from the caller) |
| `runExport(reader, registry, sink, { format?, namespace?, ndjsonBatchBytes?, codec? })` → `ExportManifest` | the free function behind `store.exportSegments`; the flavor pre-binds the codec |
| `isReservedRow(record)` / `excludingReservedRows(listing)` | the bookkeeping-row filter (the due-index pointers), as a predicate and as a stream wrapper. **Every unscoped fleet-wide enumeration skips these** |
| `dueBucket(expiresAt)` · `dueNamespace(bucket)` · `dueBucketsAt(now, lookbackBuckets)` | **the due index** — a time-bucketed set of the segments that carry an expiry, so a retention cycle costs what is *expiring* rather than what the fleet *holds*. A bucket is a **day index** (`Math.floor(expiresAt / 86_400_000)`) and becomes a namespace, because `list()` filters by namespace and nothing else — that single constraint is what shapes the design. `dueBucketsAt` includes past buckets so a sweep that did not run leaves nothing stranded, bounded by `lookbackBuckets` so a long outage costs a bounded number of list calls |
| `dueIndexRef(bucket, ref)` · `encodeDueName(ref)` · `decodeDueName(name)` · `canIndex(ref)` · `isDueIndexRow(record)` | the pointer rows. A name is `${namespaceLength}.${namespace}${segment}` — **length-prefixed, not delimited**, because every character the grammar allows is legal *inside* a name, so no separator could be unambiguous. `canIndex` is false only for a ref whose encoding would exceed the 256-character cap; that is **not an error and not "never retired"** — the repair scan still sees the segment's own row, so it expires on the repair cadence instead of the fast one |
| `DUE_NAMESPACE_PREFIX` · `DUE_BUCKET_MS` · `MAX_NAME_LENGTH` | `cbm.due.` · one day · 256. **The index is a fast path, never the source of truth**: the sweep re-reads the live segment row before acting, so a stale pointer is a wasted read and nothing worse, and the full `registry.list()` scan remains as a periodic **repair** pass, so a missing pointer is slower, never never |
| `estimateCost({ segments, workload?, pricing? })` → `CostReport` | the free function behind the static `CloudRoaring.estimateCost` |
| `groundedReport({ coldBytes, grounded?, workload?, pricing?, extraNotes? })` → `CostReport` | build a report from a **measured** byte total (backs `segment.costReport()`) |

### Optional plug-ins you construct and pass in

| Construct | Pass as | For |
|---|---|---|
| `new InProcessKeystore({ keys, activeKeyId, recoveryKeyId? })` | `keystore` (store, `bulkLoadCrbmGeneration`, `eraseIdFromSegment`) | encryption-at-rest + crypto-shred (BYOK) |
| `new CountingMetricsSink()` (or your own `IMetricsSink`; `NOOP_METRICS` is the default) | `metrics` | observability — `cold.get` / `cache` / `retry` / `intersect` / `op` events |
| `new RecordingAuditSink()` (or your own `IAuditSink`; `NOOP_AUDIT` is the default) | `audit` (on load / erasure / drop / sweep) | compliance trail — `segment.publish` / `segment.rewrite` / `segment.erase` / `segment.dispose` / `namespace.erase` |

### CLIs (run as binaries, env-configured)

| Binary | Does |
|---|---|
| `export-segments` | eject all registered segments from a local-filesystem store to a directory. Env: `CR_EXPORT_ROOT` (holds `cold/` + `registry/`), `CR_EXPORT_OUT`, `CR_EXPORT_FORMAT` (`roaring` \| `ndjson`), `CR_EXPORT_NAMESPACE` |

---

## Types in signatures

The option / result types the public methods above reference — you import these to annotate variables.

### Construction & result types

`CloudRoaringOptions` · `SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `MaterializeResult` (`{ generation, cardinality, chunkCount, size }` — what an `*Into` verb
wrote) · `BulkLoadResult` (`{ size, sha256, chunkCount, cardinality, becameCurrent? }` — `becameCurrent` is absent with no `registry`, and `false` means the object is durable but a concurrent writer published a higher generation first, so the load did not take effect)

`CloudRoaringOptions`, in full: `cold` (required) · `registry?` · `keystore?` · `requireEncryption?` · `clock?` ·
`rng?` · `cacheMaxChunks?` (hot-cache ceiling, default 1024 decoded chunks) · `cacheTtlMs?` · `coldGenTtlMs?`
(default 2000 — the bound on read staleness after a publish; needs a registry) · `coldReaderCacheMax?` (open
`.crbm` readers, default 1024) · `coldReaderCacheMaxBytes?` (their parsed indices, default 64 MiB) · `retry?`
(`RetryPolicy` or `false`) · `onRetry?` · `metrics?` · `budget?` (`{ maxRequests }` or `false`).

### Generation bookkeeping & erasure

`PinnedAt` (`{ generation, version }` — what a pin holds for one segment; `generation: null` means the segment had none to pin and the handle reads empty, **not** that pinning is unsupported) · `PinnedColdChunkSource` (a `ColdChunkSource` view holding one segment at one generation and passing every other segment through to the live source — what `seg.pin()` is built on) · `GenerationDeps` (`{ cold, registry }` — what `nextGeneration` / `gcOrphanGenerations` take) · `EraseIdDeps` ·
`EraseIdResult` · `EraseDeps` · `DropDeps` · `DestroyResult` · `DropResult`

### Retention

`RetentionPolicy` · `RetentionDeps` · `SetRetentionResult` · `RetireExpiredOptions` · `RetireExpiredResult` ·
`RetireEntry`

### Export / eject

`ExportSink` · `ExportWriter` · `ExportFormat` · `ExportOptions` · `ExportedSegment` · `ExportFailure` ·
`ExportManifest`

### Cost & observability

`CostReport` · `PricingProfile` · `Workload` · `SegmentSizing` · `EstimateInput` · `IMetricsSink` · `MetricEvent` ·
`MetricOpName` · `MetricsSnapshot` · `IAuditSink` · `AuditEvent` · `AuditEventKind`

The cost model has no per-id write term — data arrives as generations, and a generation is a load.
`PricingProfile` is `{ name, cold: { getPerMillion, putPerMillion, storagePerGiBMonth }, redis: { monthlyUSD } }`;
`Workload` is `{ readsPerSec?, intersectsPerSec?, cacheHitRate?, chunksPerIntersect?, loadsPerMonth?, requestsPerLoad? }`;
`CostReport.monthlyUSD.byOp` is `{ reads, intersects, storage, loads }`, and `redisCrossover.readsPerSec` is the
sustained read rate at which pay-per-use passes the flat baseline (≈329 reads/s at the default profile with a 0%
cache-hit rate). `MetricOpName` is `'has' | 'count' | 'intersectInto' | 'unionInto' | 'andNotInto'`;
`MetricsSnapshot` is `{ cold, cache, retries: { transient }, intersect, ops }`.

### The storage interfaces (used to type `cold` / `registry`)

`IColdDriver` · `IRegistryDriver` · `ColdChunkSource` · `SegmentRef` · `IKeystore` · `RetryPolicy` · `Clock` · `Rng`

### Combine options (used to type `intersect` / `union` / `andNot` and the `*Into` verbs)

`BaseCombineOptions` (`{ concurrency?, budget?, audit? }` — `audit` is read only by the `*Into` verbs, which publish; the streaming verbs write nothing and emit nothing) · `CombineOptions` (adds `exclude?: Segment[]`)

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
| `CrbmReader` / `CrbmReaderOptions` | read it (`tailBytes`, `maxPayloadBytes`, `maxIndexBytes`, `crypto`) |
| `CrbmColdChunkSource` / `CrbmColdChunkSourceOptions` | the `.crbm` cold reader over an `IColdDriver` (the store builds this from a raw driver for you); options add `registry`, `keystore`, `requireEncryption`, `clock`, `currentGenTtlMs`, `maxOpenSegments`, `maxOpenIndexBytes` |
| `writeCrbmGeneration` · `publishGeneration` | lower-level load: write a generation from `SafeBitmap`s / advance the pointer |
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

These are the pieces a **flavor** package (codec + facade) or a **driver** author composes — `@cloudbitmaps/core`'s
actual audience. An application never calls them: it uses the flavor's `CloudRoaring` facade, which wires all of
this for you. They are reachable from `@cloudbitmaps/roaring` too, because the flavor re-exports core wholesale.

| Symbol | What it does |
|---|---|
| `SegmentEngine` / `EngineDeps` | the codec-agnostic **read** engine over a `ColdChunkSource` (`has` / `count` / `iterate` / `intersect` / `union` / `andNot`, plus `supportsColdSize` / `segmentSize` for grounded cost) + its injected deps (**`codec` is required** — core has no default; `cache?`, `maxBitmapBytes?`, `clock?`, `metrics?`, `budget?`). Read-only by design — there are no `*Into` verbs here |
| `EngineCombineOptions` | the engine-level `{ concurrency?, budget?, exclude?: SegmentRef[] }` (the facade's `CombineOptions` maps `Segment` handles down to these refs) |
| `BoundedLru` | the count+byte-bounded LRU the facade uses for the HOT chunk cache and the `.crbm` reader cache |
| `safeMetrics` | wrap a user `IMetricsSink` so a throwing sink can never break the data path |
| `groundedReport` | build a `CostReport` from measured segment sizes (backs `segment.costReport()`) |
| `runExport` | the eject/export driver (**needs a `codec` for the `roaring` format**; the flavor binds it) |
| `splitId` / `joinId` | the id ⇄ `(chunkKey, remainder)` bit-routing pair |
| `mapWithConcurrency` | the bounded, order-preserving fan-out primitive (admin scans, the Cold sweep) |
| `resolveBudget` / `resolvePerOpBudget` / `checkBudget` | the denial-of-wallet budget plumbing |
| `DEFAULT_MAX_SCAN_SEGMENTS` | default ceiling (250,000) on registry records one fleet scan holds resident — raise via `maxScanSegments` |
| `DEFAULT_RETIRE_LIMIT` | default cap (100) on segments one `retireExpired` cycle **attempts** — `limited: true` when it bites |
| `DEFAULT_TOMBSTONE_GRACE_MS` | default delay (24 h) before the sweep deletes a tombstone row it stamped itself |
| `DEFAULT_LOOKBACK_BUCKETS` | default number (7) of past due buckets an `'index'` scan also reads |
| `MIN_EXPIRES_AT_MS` | floor (1,000,000,000,000 — 2001-09-09) on `expiresAt` **and** on the sweep's `now`: anything smaller is almost certainly epoch *seconds*, which reads as already-expired |
| `collectWithinBudget` | drain an async iterable into an array, refusing **as soon as** the budget is exceeded rather than after — so resident memory is `O(budget)`, not `O(source)` |
| `validateSegmentRef` | boundary validation of a `SegmentRef` (untrusted-input posture) |

### Driver kit — what you need to *implement* a driver

| Symbol | What it does |
|---|---|
| `Token` | the registry's opaque compare-and-swap token — unique per write, compared by equality only (ABA-safe across delete→recreate) |
| `chunkRefKey` · `segmentKey` | the canonical key-string helpers (used by the conformance suite and the memory drivers) |

**`currentGen` is nullable, and `null` is a value — not a missing field.** A `RegistryRecord` with
`currentGen: null` says *this segment exists and has no Cold generation yet*: the row `setRetention` mints when a
policy is recorded **before the first load**, so fleet-wide operations — `checkConsistency`, `eraseNamespace`,
the retention sweep — can see the segment at all. Resolution maps it onto the same path a segment with no row
takes (every read answers empty), and the first publish advances the pointer onto it. An `IRegistryDriver` must
therefore:

- round-trip `null` through `create`, `compareAndSwap`, `get` **and** `list` — serialization is where it gets
  silently dropped (`JSON.stringify` keeps `null` but omits `undefined`) or coerced to `0`, which is the
  forbidden `missing-cold-generation` state;
- apply a patch that sets `currentGen: null`, and leave the stored value alone when a patch omits the field. The
  trap is merging with `patch.currentGen ?? previous`, which treats a deliberate `null` as absent and silently
  keeps pointing at the old generation — use an own-property check (`'currentGen' in patch`);
- keep `status: 'active'` meaningful for such a row: a null pointer is a **live** segment, not a tombstone;
- yield `destroyed` tombstones from `list()` — the sweep can only purge a row it can see.

### Resilience (the store wires this by default)

| Symbol | What it does |
|---|---|
| `withRetry` · `isTransient` · `DEFAULT_RETRY_POLICY` · `RetryDeps` | the retry primitive + classifier + defaults (4 attempts, 50 ms base, ×2, 2 s cap, full jitter) |
| `RetryingColdChunkSource` · `RetryingColdDriver` · `RetryingRegistryDriver` · `RetryingOptions` | manual driver-wrapping decorators |

### Crypto seams

| Symbol | What it does |
|---|---|
| `NodeAead` · `Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `aadFor` | the AES-256-GCM implementation + the crypto interfaces the `.crbm` reader/writer use; `aadFor` binds each chunk/index to `(segment, generation)` |
| `EraseDeps` | `{ registry }` — deps for the free-function crypto-shred (`destroySegment` / `eraseNamespace`) |
| `DropDeps` | `EraseDeps` plus `cold` — `dropSegment` deletes the objects, so it needs the cold driver |

### Low-level ports & capabilities (driver-author typing)

`ColdCaps` · `RegCaps` · `ChunkRef` · `GenKey` · `RegistryRecord` · `NewRegistryRecord` · `RegistryPatch` ·
`RegistryStatus` (`'active' | 'compacting' | 'erasing' | 'destroyed'` — the middle two are reserved and set by no
writer in this build) · `GovernanceMeta` · `SegmentSize`

### Driver option types (subpath entry points)

`MemoryRegistryDriverOptions` · `LocalFsRegistryDriverOptions` · `InProcessKeystoreOptions` ·
`S3ColdDriverOptions` · `S3RegistryDriverOptions` · `DynamoDbRegistryDriverOptions` ·
`GcsColdDriverOptions` · `AzureBlobColdDriverOptions`

---

## Errors (typed — you `catch` these)

Every error this library throws extends `CloudRoaringError`, and each one tells you which of three things to do:
**fix your call**, **retry**, or **investigate the data**. Nothing throws a bare `Error`.

| Error | Fires when | What to do | Retry? |
|---|---|---|---|
| `ValidationError` | your input is malformed — a bad id, an illegal segment name, an out-of-range option. Raised **before any storage call** | fix the call | no — deterministic |
| `WriteConflictError` | a write-once generation number was claimed twice, or a registry compare-and-swap lost every retry | re-read the pointer and re-derive: take a fresh `nextGeneration`, or re-run the operation | no — but the *operation* is safe to re-run |
| `IntegrityError` | bytes from storage are corrupt, oversized, fail a checksum, or fail AEAD authentication | **investigate** — this says "this segment is corrupt", not "try again". Names the chunk. Re-loading the segment from source is the repair | no |
| `NotFoundError` | an object or row the caller named does not exist. Thrown by the persistent drivers; the in-memory drivers return `null` instead | usually the library handles it internally (a swept generation heals forward). Reaching you means the pointer names an object that is *permanently* absent — a torn restore. See [disaster recovery](disaster-recovery.md) | no |
| `UnsupportedError` | (a) the bytes are well-formed but this build cannot read them — an unknown `.crbm` major version; or (b) this store's wiring cannot perform the operation, e.g. a lifecycle helper on a store built without a raw cold driver + registry | wire the store with what the operation needs, or upgrade the library | no |
| `CapabilityError` | a driver cannot meet a capability the topology requires — e.g. a Cold driver without range reads. Raised **fail-fast at wiring time**, never mid-operation | use a driver that supports it | no |
| `BudgetExceededError` | the operation would exceed its per-op denial-of-wallet budget — too many backend requests for one call. Refused **before** fanning out (hard invariant 6). Carries the projected count and the limit, never data | narrow the operation, raise `budget`, or set `budget: false`. If it fires on a normal call, something is wider than you think | no — refused by policy, not by luck |
| `KeyUnavailableError` | an encrypted segment's DEK cannot be unwrapped: the keystore holds none of the KEKs its wrappings reference — never configured, rotated away without keeping the old key, or lost | restore the KEK. **Without it the data is unreadable**, which is what crypto-shred relies on | no |
| `TransientError` | a driver-classified transient fault — throttling, a 5xx, a connection reset. The raw SDK error is preserved in `cause` | the retry layer already retried it; reaching you means it kept failing | **yes** — the only class the retry layer retries |
| `TimeoutError` | a single attempt exceeded its time budget. Subclass of `TransientError` | as above. Setting a request timeout on your injected client is the recommended way to bound a hang | yes |

Two things worth knowing:

- **The retry layer retries `TransientError` and nothing else.** Retrying a `ValidationError`, `IntegrityError`,
  `NotFoundError` or `WriteConflictError` is pointless or wrong, so it never happens.
- **`TransientError.cause` is the raw SDK error** and may carry operational metadata (endpoint host, request
  ids, `$metadata`). The library's own `message` is identifier-only and safe to log; serializing the whole error
  *chain* includes that metadata.

**Bundle-safe predicates** — `isCloudRoaringError` · `isWriteConflictError` · `isTransientError` ·
`isNotFoundError` · `isIntegrityError` · `isValidationError`. Prefer these over `instanceof` when catching
errors that originate in a cloud driver (`@cloudbitmaps/roaring/s3` / `…/dynamodb`): those subpaths are
separate bundles, so a driver-thrown error is not `instanceof` the class object from the core entry in CJS. The
predicates match a `Symbol.for` brand + the runtime `name`, so they hold across bundles.

---

## Complete export index

Every export, by entry point. This section is the completeness anchor the sync test checks against.

### `@cloudbitmaps/roaring` — values

`CloudRoaring` · `Segment` · `MemoryColdDriver` · `MemoryRegistryDriver` · `MemoryColdChunkSource` ·
`LocalFsColdDriver` · `LocalFsRegistryDriver` · `bulkLoadCrbmGeneration` · `writeCrbmGeneration` ·
`publishGeneration` · `CrbmColdChunkSource` · `nextGeneration` · `gcOrphanGenerations` · `eraseIdFromSegment` ·
`destroySegment` · `dropSegment` · `eraseNamespace` · `InProcessKeystore` · `NodeAead` · `aadFor` · `SafeBitmap` ·
`roaringCodec` · `withRetry` · `isTransient` · `SegmentEngine` · `BoundedLru` · `safeMetrics` · `groundedReport` ·
`runExport` · `splitId` · `joinId` · `mapWithConcurrency` · `resolveBudget` · `resolvePerOpBudget` · `checkBudget` ·
`collectWithinBudget` · `DEFAULT_MAX_SCAN_SEGMENTS` · `validateSegmentRef` · `chunkRefKey` · `segmentKey` ·
`setSegmentRetention` · `getSegmentRetention` · `clearSegmentRetention` · `readRetentionPolicy` ·
`MIN_EXPIRES_AT_MS` · `retireExpired` · `DEFAULT_RETIRE_LIMIT` · `DEFAULT_TOMBSTONE_GRACE_MS` ·
`drainRegistry` · `validateMaxScanSegments` · `DEFAULT_LOOKBACK_BUCKETS` ·
`isReservedRow` · `excludingReservedRows` ·
`dueBucket` · `dueBucketsAt` · `dueNamespace` · `dueIndexRef` · `encodeDueName` · `decodeDueName` ·
`canIndex` · `isDueIndexRow` · `DUE_NAMESPACE_PREFIX` · `DUE_BUCKET_MS` · `MAX_NAME_LENGTH` ·
`DEFAULT_RETRY_POLICY` · `RetryingColdDriver` · `RetryingRegistryDriver` · `RetryingColdChunkSource` ·
`CrbmWriter` · `CrbmReader` · `BufferSink` · `BufferReader` · `CountingMetricsSink` · `NOOP_METRICS` ·
`RecordingAuditSink` · `NOOP_AUDIT` · `estimateCost` · `DEFAULT_PRICING` · `AWS_US_EAST_1_ONDEMAND` ·
`runConsistencyCheck` · `DEFAULT_BUDGET` · `CloudRoaringError` · `ValidationError` · `WriteConflictError` ·
`IntegrityError` · `NotFoundError` · `UnsupportedError` · `CapabilityError` · `TransientError` · `TimeoutError` ·
`KeyUnavailableError` · `BudgetExceededError` · `isCloudRoaringError` · `isWriteConflictError` ·
`isTransientError` · `isNotFoundError` · `isIntegrityError` · `isValidationError` · `VERSION`

### `@cloudbitmaps/roaring` — types

`CloudRoaringOptions` · `SegmentOptions` · `SubjectReport` · `SubjectSegmentRef` · `SubjectErasureEntry` ·
`EraseSubjectResult` · `MaterializeResult` · `BaseCombineOptions` · `CombineOptions` · `EngineCombineOptions` ·
`BulkLoadResult` · `CrbmColdChunkSourceOptions` · `GenerationDeps` · `EraseIdDeps` · `EraseIdResult` ·
`MemoryRegistryDriverOptions` · `LocalFsRegistryDriverOptions` · `ExportFormat` · `ExportSink` · `ExportWriter` ·
`ExportOptions` · `ExportedSegment` · `ExportFailure` · `ExportManifest` · `IColdDriver` · `IRegistryDriver` ·
`ColdChunkSource` · `SegmentRef` · `ChunkRef` · `GenKey` · `ColdCaps` · `RegCaps` · `RegistryRecord` ·
`NewRegistryRecord` · `RegistryPatch` · `RegistryStatus` · `GovernanceMeta` · `SegmentSize` · `IKeystore` ·
`Aead` · `AeadSealed` · `WrappedDek` · `CrbmCrypto` · `InProcessKeystoreOptions` · `EraseDeps` · `DropDeps` ·
`DestroyResult` · `DropResult` · `RetentionPolicy` · `RetentionDeps` · `SetRetentionResult` ·
`RetireExpiredOptions` · `RetireExpiredResult` · `RetireEntry` · `RetryPolicy` · `RetryDeps` · `RetryingOptions` ·
`CrbmWriterOptions` · `CrbmReaderOptions` · `BlobReader` · `BlobSink` · `IMetricsSink` · `MetricEvent` ·
`MetricOpName` · `MetricsSnapshot` · `PricingProfile` · `CostReport` · `Workload` · `SegmentSizing` ·
`EstimateInput` · `IAuditSink` · `AuditEvent` · `AuditEventKind` · `Clock` · `Rng` · `Budget` · `BudgetOption` ·
`ConsistencyReport` · `ConsistencyIssue` · `ConsistencyErrorEntry` · `CodecInterface` · `CodecBitmap` ·
`EngineDeps` · `Token`

### `@cloudbitmaps/roaring/s3`

`S3ColdDriver` · `S3RegistryDriver` · `S3ColdDriverOptions` · `S3RegistryDriverOptions`

### `@cloudbitmaps/roaring/dynamodb`

`DynamoDbRegistryDriver` · `DynamoDbRegistryDriverOptions` — the DynamoDB registry (peer: `@aws-sdk/client-dynamodb`).
This subpath ships a registry only; DynamoDB is not a cold backend.

### `@cloudbitmaps/roaring/gcs`

`GcsColdDriver` · `GcsColdDriverOptions` — the Google Cloud Storage cold driver (peer: `@google-cloud/storage`).

### `@cloudbitmaps/roaring/azure`

`AzureBlobColdDriver` · `AzureBlobColdDriverOptions` — the Azure Blob Storage cold driver (peer:
`@azure/storage-blob`). Inject a container-scoped `ContainerClient`; write-once via `ifNoneMatch: '*'`.

## Keeping this in sync

- The **sync test** ([`tests/docs/api-reference-sync.test.ts`](../../tests/docs/api-reference-sync.test.ts))
  parses the ten barrel files (both package barrels + the four driver subpaths in each package) and asserts each
  exported name appears (backtick-wrapped) somewhere on this page — so **adding an export without documenting it
  breaks CI**. It also fails if a barrel introduces an `export *` (which would let names slip past the guard),
  keeping every export explicit; the allowed exceptions are the flavor barrels re-exporting core's same-named
  barrel, because core's barrels are parsed too.
- When you add/rename/remove a public export: update the relevant section **and** the
  [Complete export index](#complete-export-index) in the same change (this is part of the standard
  [keep-the-docs-current step](../../CONTRIBUTING.md#documentation--keeping-it-current)).
- This page catalogs the surface; the tutorial-style walkthrough with runnable snippets lives in the
  [getting-started guide](../guide/getting-started.md). For _why_ the surface is shaped this way, read the module
  headers — each one states the decision it encodes and what the alternative cost — and the
  [hard correctness invariants](../../CLAUDE.md#hard-correctness-invariants), which are the protocol rules the
  shape follows from.
