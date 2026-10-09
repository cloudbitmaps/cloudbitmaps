# Changelog

All notable, user-facing changes to CloudBitmaps are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Changes land under **[Unreleased]** and are cut into a version on release. For what is shipped and how far it is
proven see [`docs/ROADMAP.md`](docs/ROADMAP.md); for *why* a change is shaped the way it is, the entries below say
so, and so do the module headers in the code.

> **Pre-1.0 means the format and API can still move.** Breaking changes are possible in a minor bump until
> `1.0`, at which point the `.crbm` format freezes and normal SemVer guarantees apply.

## [Unreleased]

### Breaking

- **Registry rows are schema 4, and a store moves to 0.20 by loading its segments into a new prefix.** Every row 0.20
  writes is stamped `schemaVersion: 4` and carries `pointerId`, below, and 0.20 reads rows stamped 4 only. A row stamped
  1, 2 or 3 is refused with `UnsupportedError`, naming its key and saying what to do, by every read and write of it and
  by every `list()` that reaches it, so one such row stops each fleet-wide call that lists its namespace. A 0.19 process
  refuses a schema-4 row the same way. There is no upgrade in place and no downgrade: the rows of one prefix are all of
  one release. The library cannot delete, retire, drop or list a row stamped 1, 2 or 3, nor any namespace that holds
  one: `delete`, `dropSegment`, `retireExpired` and every sweep read the row first. Remove such rows with your storage's
  own tools, or point the store at a new prefix, as below. A token in any form but `<incarnation>.<counter>.<write>`
  is an `IntegrityError`, and a deleted row is removed wherever the registry reports `conditionalDelete`, whenever it
  was created. Move each store:
  1. With 0.19, export every segment (`store.exportSegments`, [the export guide](docs/guide/export.md)), and save beside
     each file the segment's row's whole `retention` and `residency` objects, read from `backend.registry` (`get`, or
     `list` for a namespace), keys of your own included, and its generation's `metadata` from `seg.stat()` if you load
     with metadata.
  2. With 0.20, on a new prefix and with the same `encryption` options, load each file
     (`store.load(ref, { serialized })` for a `roaring` file, its ids for an `ndjson` one) with its metadata. Then
     restore each row's retention and residency exactly: read the row the load created with
     `backend.registry.get(ref)`, and write
     `backend.registry.compareAndSwap(ref, row.token, { retention, residency })`, naming only the ones the old row had
     (`setRetention` writes `expiresAt` alone).
  3. Re-run, against the new prefix, every erasure (`eraseSubject`, `eraseNamespace`, a crypto-shred) processed since
     the export began: the export holds what each segment held when it was read.
  4. Move every reader and writer to the new prefix, then delete the old prefix, its noncurrent versions and delete
     markers included on a versioned bucket, and its soft-deleted objects where the storage keeps them.

  Re-loading from your own source instead of an export can bring back ids you erased from the store: re-run those
  erasures against the new prefix before it serves a read. Only each segment's current generation moves: the
  generations `keep` retained, and every lease, stay in the old prefix. A crypto-shredded segment is not exported
  (`manifest.skipped`), and its row, the store's record that it was destroyed, goes with the old prefix: keep your own
  record of it first.

- **A registry of your own sets `pointerId` on every row, and a summary names its object.** `RegistryRecord` gains the
  required `pointerId`: the token of the row's create, renewed to the token of every compare-and-swap whose patch names
  `currentGen`, `status`, `wrappedDeks`, `keyId` or `summary`, at any value, the one the row already has included, and
  kept by a write that names only `leases`, `retention`, `residency` or `keptGens`. `renewsPointer(patch)` and
  `RESOLVED_FIELDS` in `@cloudbitmaps/core/driver-kit` give the rule. A row a registry of your own returns without
  `pointerId` fails every read of its segment with `UnsupportedError`; a shipped registry reads a stored row without one
  as an `IntegrityError`. A clear `RegistrySummary` carries `fingerprint`, the `<size>:<crc>` of the object it
  describes, and a sealed one seals the count, the size and the checksum before the metadata, so it is at least 48
  bytes. The shipped registries refuse with `ValidationError` a write of a summary without it, and a `create` or a
  compare-and-swap that names `token` or `pointerId`; a stored summary without it is an `IntegrityError`. The
  conformance suite holds a driver to each: a create, a renewal by each resolved field, at a new value and at the one it
  has, the fields that do not renew, a same-value `currentGen` that keeps the summary, `keptGens` and `leases`, a lost
  compare-and-swap, and a write that names `pointerId`, beside a resolved field or as a value the row has had.

### Added

- **A storage driver can delete an object only while it is the one that was read: `StorageCaps.conditionalDelete`,
  `IStorageDriver.delete(key, { ifVersion })` and `getTail`'s `version`.** A tail read reports the object's version
  (`TailRead.version`: an S3 or Azure Blob ETag, a GCS object generation), and a driver that reports
  `conditionalDelete: true` deletes, given that version, only the object it names, by a precondition the backend
  applies (`If-Match`, `ifGenerationMatch`, `ifMatch`), refuses another object under the key with
  `WriteConflictError`, and treats an absent one as a no-op. A driver that reports `false`, or omits it, ignores the
  version. The in-memory driver reports `true`; the local-filesystem driver `false`, since a filesystem has no delete
  conditioned on which file is under a path; S3, GCS and Azure Blob as the backend's existing `conditionalDelete` option
  says, which now covers the storage half as well as the registry: on by default for S3 when its client sends to an AWS
  S3 host and for Azure Blob, off by default for GCS. All three parts are optional, so a driver of your own keeps
  compiling and deleting unconditionally until it implements them; the in-repo conformance suite's `conditional delete`
  case is the test ([driver kit](docs/guide/api-reference.md#driver-kit--what-you-need-to-implement-a-driver)). New
  types `TailRead` and `StorageDeleteOptions`, from `@cloudbitmaps/core`, its driver kit and `@cloudbitmaps/roaring`.
- **`@cloudbitmaps/core/driver-kit` exports `RESOLVED_FIELDS`, `renewsPointer`, `renewPointer` and `pointerIdOf`**: the
  fields a read resolves through, whether a patch renews a row's `pointerId`, the patch that renews it and changes
  nothing a read resolves (the pointer, named at the value it has), and a row's `pointerId`, refusing a row with none
  ([driver kit](docs/guide/api-reference.md#cloudbitmapscoredriver-kit)).
- **`@cloudbitmaps/tools`: the cost model, in a package of its own.** `estimateCost`, `groundedReport`, the price lists
  `AWS_US_EAST_1_ONDEMAND`, `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND` and `ONE_REDIS_HA_CLUSTER`, and their types
  (`CostReport`, `PricingProfile`, `RedisSizing`, `RedisNodeType`, `Workload`, `SegmentSizing`, `EstimateInput`) are
  here, unchanged in what they compute: `pnpm add @cloudbitmaps/tools`. It is offline tools that need nothing internal
  from a store: it reads and writes none, runs with nothing else installed, and depends on `@cloudbitmaps/core` alone,
  for the `ValidationError` it throws. It releases with the family, at the family's version. `groundedReport` takes
  `{ storageBytes, workload?, pricing? }`, where `storageBytes` is a measured byte count or `null`, which prices storage
  at $0 with `assumptions.grounded: false` and a note saying nothing was measured. The price lists are as old as the
  release that ships them, as before: pass your own profile for a decision that turns on the price
  ([the cost guide](docs/guide/cost.md)).
- **`stat()` reports `sizeBytes`: the bytes of the generation's object in storage.** `SegmentStat` gains the required
  `sizeBytes: number | null`, from the same resolution as the number, count and metadata beside it, so it is never
  another generation's: from the row's summary, which records the object's size, or, for a row with no summary to use,
  from the object's footer and index, with no payload read. A cold `stat()` stays one registry read, and a warm one
  sends nothing; a row with no summary to use adds a tail read of the object when cold. A pinned handle reports its
  pinned generation's. It is `null` for a segment with no generation, and on a store whose source cannot report a
  size. A grounded cost report is then `groundedReport({ storageBytes: (await seg.stat()).sizeBytes })`. A storage source
  provides it through a new optional `StorageChunkSource.stat`, which the `.crbm` source, the pinned source and the
  retrying wrapper implement; a source of your own without it reports its `sizeOf`, or `sizeBytes: null`
  ([`stat()`](docs/guide/reading.md#stat-the-generation-its-count-its-metadata-and-its-size)).
- **Every `segment.*` audit event carries `incarnation`**, the id of the segment's registry row as the operation found
  or wrote it. A name whose row was purged and created again starts its generations at `0` again, so a segment and a
  generation number could belong to two lives of the segment; the incarnation tells them apart.
  Within one life a number whose object was deleted can still be taken again by a later load. The field is absent when
  the row's token carries no incarnation id, for example from a registry of your own, and on a `segment.load-refused`
  from a load that found no row.
- **A `segment.collect` audit event for an erasure that rewrites nothing.** When `eraseSubject` finds the id only
  outside the current generation (a retained older generation, one above the pointer after a rollback, or an object
  left under a tombstone), it deletes the generations holding it and now emits `segment.collect { fromGeneration,
  collected }` once no generation holds the id. Every ledger entry with `erased: true` now has an event:
  `segment.rewrite` or `segment.collect`. `AuditEvent` gains the member, so an exhaustive `switch` on `kind` needs a
  case for it.
- **The export manifest lists the segments it skipped.** `ExportManifest.skipped` names each destroyed segment the
  export did not read, `{ segment, namespace?, reason: 'destroyed' }`, so `segments`, `failed` and `skipped` together
  account for every segment row the registry listed. `ExportSkipped` is exported, and the `export-segments` command's summary
  line counts them.

### Changed

- **`store.segment(name, options)` takes a plain object, and refuses `expiresAt` as it refuses any other key but
  `namespace`**: with `ValidationError` naming it, `segment: unknown option "expiresAt"; a handle takes { namespace }
  only`. Every own key is scanned, enumerable or not, and a class instance or an object built on another is refused,
  since it can carry an option no scan of its own keys sees. A plain object of any realm, and one with no prototype,
  is taken. A deadline on a set is recorded with `setRetention` and acted on by `retireExpired`, or checked where you
  read ([a deadline on a set](docs/guide/retention.md#a-deadline-on-a-set)).
- **A reader's caches key on the generation with the row's `pointerId`, not its token.** A lease taken or released, a
  `setRetention` or a `clearRetention` leaves a warm reader's open object and decoded chunks in place: a warm `has()`
  after one, once `cache.genTtlMs` lapses, is the registry read alone, where it was a registry read, a tail read and a
  chunk read. `pinnedAt.version` is `<generation>:<pointerId>`, so it stays the same across those writes, and leased
  pins of one generation share one open of its object. A publish, a rollback, an erasure's rewrite, a status or key
  change, and a compare-and-swap that names `currentGen` at the value it has renew `pointerId`, and a reader opens the
  object again after them.
- **Every open of the row's generation, where the row has a summary the store can use, holds the object's footer to
  the fingerprint the summary records**, before its index is read or decrypted and at no extra request. A row with no
  summary it can use is not checked, and a reader already open is not checked again until the row changes, it is
  evicted or it is invalidated.
  An object that is another one under the number (put back from outside the library, or restored beside a row that
  names another) is refused with `NotFoundError`, which says it is another object than its registry row names, and the
  read resolves the segment again once. An erasure reads the generation it rewrites the same way, so it fails with
  that `NotFoundError` and writes nothing rather than publish such an object as its rewrite, and a live `pin()` holds a
  reader an earlier `pinAt` opened to the row's summary before it shares it. `checkConsistency({ summaries: true })`
  reports such a row as `summary-mismatch`.

### Removed

- **The cost model from `@cloudbitmaps/core` and `@cloudbitmaps/roaring`, with `CloudRoaring.estimateCost` and
  `seg.costReport()`.** Core and the flavor no longer export `estimateCost`, `groundedReport`, the price lists or their
  types: import them from `@cloudbitmaps/tools`. `CloudRoaring.estimateCost(input)` is `estimateCost(input)` from there.
  `seg.costReport({ workload, pricing })` is `groundedReport({ storageBytes: (await seg.stat()).sizeBytes, workload,
  pricing })`; it priced the pointer refresh at the store's own `cache.genTtlMs`, so pass that as `workload.genTtlMs`
  if your store sets one. `groundedReport` no longer takes `grounded` or `extraNotes`: a `null` size is what marks a
  report ungrounded. What only the cost report read goes with it: `StorageChunkSource.pointerRefreshMs` and the
  `pointerRefreshMs` getters of `CrbmStorageChunkSource`, `PinnedStorageChunkSource` and `RetryingStorageChunkSource`,
  and `SegmentEngine`'s `pointerRefreshMs`, `supportsStorageSize` and `segmentSize`; a storage source of your own can
  drop its `pointerRefreshMs`.

### Fixed

- **An erasure no longer deletes a generation a load put, since its search, under the number of a holder above the
  pointer.** A number can be taken again once its object is deleted. While one erasure re-read the row before deleting
  a holder above the pointer, a second erasure of the same id could delete that holder, and a load take its number,
  write and publish; the first erasure's delete then removed the load's generation, and the pointer named a missing
  object. Each delete of a holder above the pointer now passes the version the erasure read when it searched that
  object, and on a driver that reports `conditionalDelete` the delete of another object is refused: the erasure stops
  deleting and reports `erased: true` when nothing left holds the id, or `'superseded'`. On a driver that does not
  report it (the local-filesystem driver, GCS by default, S3 on a host other than AWS S3 unless set) the window remains.
  The condition names the object, not the row, so a rollback onto the generation being deleted still leaves the pointer
  on a missing object; on S3, whose ETag is computed from the bytes of an object stored without SSE-KMS or SSE-C, a
  load that writes exactly the holder's bytes under its number is not told apart; and a refused rewrite's delete of
  its own object above the winner's pointer is not conditioned
  ([a number taken again during an erasure](docs/guide/erasure.md#how-it-stays-correct)).

## [0.19.1] — 2026-10-09

### Fixed

- **A live read no longer mixes the ids of two objects stored under one generation number.** A number can be taken
  again once its object is deleted: after a `rollback`, an erasure that deletes the generation above the pointer holding
  the id, and a load. A store that had cached chunks of the earlier object, and that read the row before those writes,
  as a `count()` answered from the row's summary does, opened the new object later under the version it had cached
  the earlier one's chunks by. Inside `cache.genTtlMs` a read then returned ids of both objects, the erased id among
  them, a set no generation ever held, and `has()` could answer for the erased id and a new one together. The store
  now names each generation it reads by the object it opened as well, its size and footer checksum, which the open
  reads anyway, so a chunk cached from one object is not served for another, as far as their sizes and footer checksums
  tell them apart. It costs no request: a count answered from the row still opens nothing, and a segment reopened after
  the reader cache let it go still reads its cached chunks. The version `CrbmStorageChunkSource.currentVersion()`
  returns, and the one each chunk of `getChunks()` carries, end with that fingerprint; compare versions for equality,
  as before.
- **A load that found no registry row is refused when a row appears before its publish, guarded or not.** A load with
  `allowEmpty: true` and neither `guard.minRetained` nor `guard.maxGrowth`, into a segment with no row, published with
  no fence at all: when another writer made the row first (another first load, a `setRetention`, a drop), it moved the
  pointer over that row anyway. Racing a subject erasure, that could leave the pointer naming a generation that is not
  in the bucket: the load's own object, which the erasure had just deleted because it held the erased id above the
  pointer. Every read of the segment then failed with `NotFoundError`, the state `checkConsistency` reports as
  `missing-storage-generation`. Every load that found no row now fences its publish on that absence, as a guarded load
  already did: it is refused with `reason: 'superseded'` and audited as `segment.load-refused`, and an `*Into` throws
  `WriteConflictError` for it, as a `materializeMany` output reports it. Of two first loads of one segment at once,
  at most one lands. The refused load's object is deleted when the row that appeared is a tombstone, or holds key
  material where the load wrote cleartext and the object's footer proves it the load's. Otherwise it stays in the
  bucket, still billed, until a later load's collection deletes it (the next load whose check meets it, and at the
  latest the listing a load runs every sixteenth generation: see
  [how a load stays correct](docs/guide/loading.md#how-it-stays-correct)), or `dropSegment` or the retention sweep
  removes the segment. A first load that meets another writer's row only at its publish, a drop's tombstone or a row whose keys
  do not match the object it wrote, now reports `superseded` instead of throwing `ValidationError` or
  `KeyUnavailableError`. One that meets that row before it writes still throws, as before, and writes nothing:
  `ValidationError` for a tombstone, `KeyUnavailableError` for a row with key material when it has no keystore, and
  `ValidationError` for a cleartext row under `requireEncryption`. The fence holds once every process that writes the segment runs this release: a process
  on an earlier release still moves the pointer over a row that appeared while its load ran.

## [0.19.0] — 2026-10-08

### Added

- **A predicate for every error class: `isUnsupportedError`, `isCapabilityError`, `isBudgetExceededError` and
  `isKeyUnavailableError`**, from `@cloudbitmaps/core` and `@cloudbitmaps/roaring`. These four classes had none, so a
  caller classifying them fell back on `instanceof`, which a second copy of the package or another realm defeats. Each
  matches the brand and the name, as the other predicates do, and holds under a minifying bundler.
  `@cloudbitmaps/core/driver-kit` exports `isIntegrityError` and `isTransientError` beside the classes it already
  exported, so a driver classifies every error it throws without the main entry.
- **`GuardRefusal` is exported from `@cloudbitmaps/core`**: the type of `judgeLoad`'s `wouldRefuse`, every
  `LoadRefusal` but `'superseded'`, which a caller could read but not name. `@cloudbitmaps/roaring`'s dry-run results
  keep their own name for the same set of refusals, `MaterializeRefusal`.
- **`materializeMany({ dryRun: true })`: look at a whole refresh before any of it is live.** Every output is computed
  exactly as the call would compute it and judged against its `dest` as its publish would be, and nothing is written: no
  object, no pointer, no audit event. Each result is `{ dryRun: true, published: false, cardinality, cardinalityBefore,
  wouldRefuse? }`, or `{ published: false, error }` for what would fail its publish; `wouldRefuse` is the `reason` a
  publish would give now. It reads what the publishing call reads, without the writes, and holds the memory a
  publish would, so it fails for memory where the publish would. A call with `dryRun: true`
  returns a `MaterializeManyDryRun`; a call without it keeps its types exactly, so no caller's code changes; and a
  `dryRun` held in a variable, a `boolean` or an optional one, returns either. Core gains
  `judgeLoad`, which a dry run runs for each output, and `CombineManyRequest.dryRun`, for a flavor built on
  `runCombineMany`. The guide shows how to publish what was reviewed, and recipes over
  a dry run: a growth ceiling with an absolute floor, and the overlap of each output with what is live. It also gives
  recipes for refusing a key shift on a single load and for keeping every generation of the last N hours.
- **`guard.maxGrowth`: refuse a load that grows a segment more than you allow.** The ceiling to `minRetained`'s floor,
  for a source that lands duplicated or joined on the wrong key: `guard: { maxGrowth: 1.5 }` refuses a generation larger
  than one and a half times the current one, with `published: false` and `reason: 'max-growth'`, and the previous
  generation stays current. It applies to `store.load`, the `*Into` verbs and each output of `materializeMany`. It does
  not judge a first load or a load onto an empty segment, `0` means no bound, and anything that is not a finite
  number of at least `1` is a `ValidationError` before any request. Setting it makes the load read the current size and fence its publish on it,
  with `allowEmpty: true` too. It is judged after the other bounds, so a load that breaks one of those as well keeps
  that reason. `LoadRefusal`, `MaterializeRefusal` and the `segment.load-refused` audit event's `reason` gain
  `'max-growth'`; it appears only when the bound is set, and a caller that switches exhaustively on `reason` adds a
  case. Every bound of a guard is now copied when the call begins, so a guard object changed while a load runs no
  longer changes what it is judged by, and a bound that is not a number is named by its type in the `ValidationError`.
- **`store.materializeMany` reports to the store's metrics sink, as the `*Into` calls do.** One `op` event per call,
  with `name: 'materializeMany'`, timed from its first request (the pins) to its last publish; a call its input checks
  refuse sends nothing and reports nothing. And one `storage.get` event per range request it sends, naming the operand's
  segment, with the range's bytes and time: a range serves every output of its group, so the events count the call's
  requests, which equal `stats.requests.rangeReads`. It reports no `cache` event, since it
  never looks up the chunk cache, and no `intersect` event, since an output is an expression over several operators;
  `stats.chunks.pruned` counts what it did not read. `MetricOpName` gains `'materializeMany'`, and
  `CountingMetricsSink`'s `ops` gains its tally: a sink that switches on `name` with an exhaustive `never` check adds a
  case (one with a `default` branch needs no change), and a `Record<MetricOpName, …>` built by hand, a
  `MetricsSnapshot` literal among them, adds the key. The `op` event also fires for a call that throws after its first
  request, such as a budget refusal. Core's `CombineManyDeps` gains an optional `metrics` sink, which receives the
  `storage.get` events.

### Changed

- **`GcsStorage` refuses, when it is built, a `client` it cannot send downloads through safely, where it used it as it
  was.** Its downloads now go through a second client built from the same class and settings (see Fixed), so:
  - a test double that is not a `Storage` client needs `retryOptions: { autoRetry: false }`, and is used as it is with
    it; with the SDK's module mocked, pass the mock as `client`;
  - a `Storage` whose `bucket` is stubbed on the instance, or whose class overrides `bucket` (a test double built on
    `Storage`), is refused: stub `Storage.prototype` instead, or use a double that does not extend `Storage`;
  - a `Storage` subclass whose constructor builds from its own configuration rather than the options it is given is
    refused, even with `autoRetry: false`: pass a plain `Storage`, or have the constructor pass its options on.
- **The driver contract says two more things a driver must do**, which the conformance suites the shipped drivers
  run now hold them to: a listing, of generations or of registry rows, yields every entry however many pages the
  service splits it into; and a registry over a bucket or container that does not exist fails a read, a listing and a
  write rather than answering an absent row. Both are in `IStorageDriver`'s and `IRegistryDriver`'s doc comments and
  the API reference's driver kit.
- **Combines on operands of a million to ten million ids, and the `*Into` verbs, are now measured on S3.** The first
  run of the calibration harness's large suite, from AWS CloudShell in `us-east-1` on 2026-10-07 (run
  `2026-10-07-88cd3`, against the published `0.18.3` packages), timed 40 cold reads of each combine at each size on two operands of about
  1,500 chunks each, 20 % shared. A cold `intersect` took 108.8 ms at the median in 6 GETs at about a million ids an
  operand, 140.0 ms in 8 at five million and 158.0 ms in 10 at ten million. A cold `union` took 203.5 ms in 8 GETs, 532.3 ms in 24
  and 682.7 ms in 26, and an `andNot` 144.9 ms in 7, 323.0 ms in 16 and 392.4 ms in 18. Five `intersectInto`, `unionInto`
  and `andNotInto` calls a size took between 259.8 ms and 1,392.4 ms at the median: a `unionInto` of 18.07 and 20.32 MB
  is written in 3 parts. A single-part load ran at 3.84 million ids a second at the median and a multipart load at 5.67
  million. Every stage made exactly the requests it was expected to, with no discarded sample: 173 PUT-class and 5,663
  GET-class requests in all, $0.0031302 at the default prices. The large suite drains each read with `.batches()`, so
  its latencies are not comparable with the default suite's, and latencies of different CloudShell sessions are not
  comparable either; it is one client with 128 sockets and 2 CPUs. `materializeMany` on S3 is still counted, not
  measured. The benchmarks page, the roadmap and the calibration READMEs quote it. No library code changes.

### Deprecated

- **The cost model, marked `@deprecated`: it moves to a package of its own, `@cloudbitmaps/tools`, in the minor after
  this one.** `CloudRoaring.estimateCost`, `segment.costReport`, core's `estimateCost` and `groundedReport`, and the
  price lists `AWS_US_EAST_1_ONDEMAND`, `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND` and `ONE_REDIS_HA_CLUSTER` keep working
  unchanged until then. They are a planning tool, not part of reading or writing a set, and a price list in the library
  is as old as the release that carries it. `stat()` gains the generation's byte size with the move, so a grounded report
  needs nothing internal.

### Removed

- **`expiresAt` on a handle: `store.segment(name, { expiresAt })` and `seg.expiresAt`.** A handle carried a deadline past
  which its reads answered empty, an expired operand emptied an `intersect` or left a `union`, and an expired exclusion
  or an `*Into` involving an expired handle threw. It reclaimed nothing and bound one handle, and every combine carried
  its rules. `expiresAt` among `store.segment`'s options now throws `ValidationError`, so a deadline is never silently
  dropped. For a set that must stop being served after a deadline, record it with `setRetention` and run
  `retireExpired`, or check the deadline where you read ([a deadline on a set](docs/guide/retention.md#a-deadline-on-a-set)).
  Retention's own `expiresAt` is unchanged. An older copy of `@cloudbitmaps/roaring` installed beside this one asks each
  handle whether it has expired, so a handle of this release passed to that copy's combine throws a `TypeError` there,
  and a handle of that copy carrying `expiresAt`, passed to this release, reads its data: keep one version of the package
  in an application.
- **Held operands: `store.memory`, `MemoryOperand`, and core's `prepareHeld`, `CombineManyHeld` and `HeldChunks`.** A held
  operand did what a feed does, with the whole set resident instead of one chunk key at a time. A set you hold goes into
  `materializeMany` as a feed: the guide's recipe walks the sets by chunk key and yields them in the feed's order
  ([a set you hold](docs/guide/loading.md#a-set-you-hold-feed-it)). `MaterializeManyOptions.operands` takes segments only,
  `mayBeEmpty` names fed operands only, and `StaleOperandError`'s `'erased'` applies to a fed call only.
  `CombineManyOperand` loses its `held` field.
- **`store.reapRegistryTombstones`, core's `reapRegistryTombstones` and the optional
  `IRegistryDriver.reapLegacyTombstones`.** Only a bucket a release before 0.12 wrote holds the `deleted: true` rows the
  reaper removed. The guide's recipe runs the reaper the 0.18 releases ship, once, from a scratch directory
  ([retention](docs/guide/retention.md#remove-the-deleted-rows-a-release-before-012-left)). A registry driver that
  implemented `reapLegacyTombstones` can drop it: nothing calls it. With the reaper go its option and result types
  (`ReapRegistryTombstonesOptions` and `ReapRegistryTombstonesResult` in both packages, `ReapLegacyTombstonesOptions`
  and `ReapLegacyTombstonesResult` in core), `ObjectStoreRegistry.reapLegacyTombstones` in `@cloudbitmaps/core/driver-kit`,
  and `ObjectRegistryStore.resolveCapabilities` there too: the reaper was the one caller of that optional store method,
  so a driver that implemented it can drop it.

### Fixed

- **A GCS client you pass no longer crashes the process on a retried download.** `@google-cloud/storage` 7.x and 8.x
  can throw `ERR_STREAM_UNABLE_TO_PIPE` outside any promise when they retry a download and the retry succeeds, which
  ends the process. `GcsStorage` sent the downloads of a supplied `client` on that client, so one built with the SDK's
  default retries could crash on any 503. Downloads now go through a twin of the client, built from its own class with the same credentials object, endpoint and settings and
  the SDK's retries off, and the driver retries them itself, as it does for the client it builds. The client's other
  requests keep its retries. A `Storage` client is always used through its twin, even one whose retries read off, since
  the SDK turns them off while a delete or an upload with no precondition is in flight. The twin's own retry settings
  are turned off over any its class set, and a twin that would use other credentials or another endpoint, as from a
  subclass that builds from options of its own, is refused when the backend is built. The client `GcsStorage` builds
  shares one credentials object with its download twin, so one token fetch serves both.
- **A read over a custom source that names generations but not versions no longer caches one generation's chunks as
  another's.** For such a source (`getChunks` and `currentGeneration`, no `currentVersion`), a read that found its
  segment had moved, on a chunk served from the cache, went on taking the rest of its open stream, which could still be
  reading the earlier generation, and cached those chunks under the generation it had moved to. A later read at that
  generation then served the earlier one's ids from the cache, an erased id among them, until the cache let them go.
  This held for a combine, `iterate`, `iterateBatches`, `everyNth` and a streamed `exclude`. Once a read moves, nothing
  more its open stream delivers is cached. The library's own sources name versions and were not affected.
- **`setSegmentRetention` from `@cloudbitmaps/core` shows its documentation again** in editors and the published
  `.d.ts`: its doc comment sat above another declaration, and TypeScript attached it there instead. Eleven more doc comments
  inside the packages had come apart from their declarations the same way, and a test now holds every one to its own.
- **`estimateCost` and `costReport` refuse an input of the wrong shape** with `ValidationError`: no input, `segments`
  that are not an array, a `null` entry or a hole in it, or a `pricing` with no storage price list threw a raw
  `TypeError` from inside the model, and a `workload` that is not an object (a string, an array) was ignored.
- **`materializeMany({ pin: null })` is refused**, as a `null` switch is on every other call; it ran as the default.
- **`retireExpired({ scan: 'index' })` holds at most `maxScanSegments` stray pointers a call.** Pointers whose
  segment is gone, left when removing them failed, were all held and checked in one call however many there were;
  those past the bound now wait for a later call, as the fleet scan's pointers already did. Every pointer is still
  read: a live expired segment behind any number of strays is retired in the same call.
- **Export, listing and feed edges.** `runExport` with a sink that has no `open()` failed every segment, one by one,
  into `failed`; it is a `ValidationError` before anything is read, and options of `null` read as none. The
  `export-segments` CLI reads an empty `CR_EXPORT_FORMAT`, an unset shell variable, as the default, as it already read
  an empty namespace, and its docs say it wires no keystore, so an encrypted segment lands in `failed[]`; the error
  for that names the store's `encryption.keystore` rather than an internal class. A registry `list('')` read as empty
  on the in-memory and object-store registries and threw on the local filesystem; every registry refuses it now. A
  refused `materializeMany` feed record is named by its position in the feed, not by its chunk key, which narrows the
  ids it holds to a range.
- **The cloud drivers check more of what they are told and what they are answered.** An S3 range answer of the
  right length from another place in the object, an S3 tail answer that is not the suffix asked for, and an S3 listing
  page that said more followed without saying how to ask for it, were believed; the first two are refused and the
  third is an `IntegrityError`, not a listing ended short. An S3 listing page, or a GCS registry listing page, that hands
  back the token it was asked with is an `IntegrityError` too, where the driver asked for the same page forever.
  An Azure Blob tail answer short of the bytes asked for, and a tail length of `NaN`, `1.5` or `Infinity`, are
  refused, and a registry compare-and-swap whose row was deleted since it was read is a lost race on a service that
  answers it `404`. `S3Storage` and `GcsStorage` refuse a `bucket` that is not a non-empty string and every backend a
  `now` that is not a function, when built; Azure Blob refuses a `blockBytes` above its 4,000 MiB block limit and a
  `maxObjectBytes` above 50,000 such blocks, and GCS a `maxObjectBytes` above its 5 TiB object limit.
- **The S3 and GCS storage drivers copy what they are given to write.** Their upload sinks kept a reference to the
  caller's buffer until the part or the upload was sent, so a writer that reused a buffer once `write()` resolved, as
  the in-memory sink and the Azure Blob driver allow, stored its later contents instead. The library's own writer
  passes a fresh buffer each time, so its loads were not affected; a custom writer through `putImmutable` was. The
  rule is now stated on `BlobSink`, and the conformance suite overwrites each buffer once its write resolves.
- **Three retention and read checks.** A retention `expiresAt` past the latest date a `Date` can hold (`1e300`) was
  stored, and no due-index bucket ever held it; it is a `ValidationError` now. A tombstone that a manual `dropSegment`
  or `destroySegment` writes no longer keeps the retention sweep's mark a restored or hand-edited row carried, so a
  sweep never purges a tombstone it did not write. A core storage source's `pinGeneration`, `pinGenerationAt` and
  `exists` refuse a name in the library's own bookkeeping namespace, as every other entry does.
- **Smaller fixes from the pre-release review.** A `KeyUnavailableError` listed every key id the keystore holds, and
  the message reaches `eraseSubject`'s ledger and logs; it names only the ids the wrappings reference now. A
  `count()` over a custom source's per-chunk counts added a count that was `NaN`, negative, fractional or past 65,536;
  it is refused as `IntegrityError`, as the key beside it already was, and a count of 0 still adds nothing. The `.crbm` writer accepted a generation past
  `Number.MAX_SAFE_INTEGER`, written as another number, and a chunk payload past the 1 MiB cap every reader refuses at
  open; both are `ValidationError` before anything is written. A range answered with the wrong length says how many
  bytes came back against how many were asked for, where it said "read short" of a long answer too.
- **A seam without its methods, and a retention policy that is not an object, are refused up front.** A
  `seams.clock` without `now()` and `sleep()`, a `seams.rng` without `next()` or an `encryption.keystore` without
  `createDek()` and `openDek()` built a store that threw a raw `TypeError` at its first load or read; each is now a
  `ValidationError` when the store is built. `setRetention(ref, null)` threw a raw `TypeError` too.
- **The driver conformance suites test what a driver could break and still pass.** A storage driver whose keys left
  out the namespace, folded `a/b` into `a_b`, listed generations by a bare prefix, checked for an object and then wrote
  it, or kept the bytes of a write whose writer failed passed every case, and a registry keyed by the segment name
  alone did too: through a store, the first serves one tenant's ids to another and the last publishes over another
  tenant's row. The suites now hold a driver to keeping every name and namespace apart, to write-once under two
  concurrent writers, and to storing nothing for a failed write. Every shipped driver passes, on the emulators too.
- **A refused load is reported as refused when deleting its object fails.** The refusal deleted the object it had
  written before answering, and a fault in that delete (a transient storage error) replaced the refusal, which is an
  answer and not an error, and dropped its `segment.load-refused` event; the same fault replaced a publish's own
  `ValidationError`. The delete is best-effort now: an object it leaves is above the pointer, where the next load
  collects it.
- **`rollback` onto a generation of a row with no pointer needs `allowForward`.** A row created by `setRetention`
  before the first load has nothing published, so an object in its bucket is a first load's that never published, as
  an object above a pointer is; the guard that asks for `allowForward` there skipped a row with no pointer.
- **A tombstone whose objects cannot be deleted no longer stops `retireExpired` retiring.** Each such tombstone was
  charged to `limit` like a purge that happened, so under a role without delete permission, where every retirement
  becomes one, enough of them past their grace left every new expiry unretired, call after call, and the collection's
  error was swallowed. It is now a refused purge: not charged, counted in `purgeFaults` with its cause in
  `firstPurgeFault` (also when the collection raised nothing and the objects stayed), and three in a row stop purging
  for the call, as a refused row delete already did.
- **`eraseSubject` searches a tombstoned segment.** A destroyed row was skipped as "already unreadable", but only a
  crypto-shred makes it so: a cleartext `destroySegment({ allowCleartext: true })`, a drop whose sweep left an object,
  or a write that landed after it leaves objects anyone can read, and an id in one stayed in the bucket while the
  ledger left the segment out. A tombstone's bucket is now listed; when a cleartext object holds the id, every object
  under the tombstone is deleted and the entry reads `erased: true`. An object sealed under the shredded key is not
  read. One listing per tombstone per call. A segment tombstoned while its rewrite runs is searched the same way.
- **An erasure that deletes a generation above the pointer refuses the load that wrote it.** When the id was only in a
  generation above the pointer, the erasure deleted it after checking the row, but a load that wrote it and had not
  yet published was fenced on a row nothing had changed, so it published afterwards and the row named a generation
  that was gone. The erasure now writes the row first (its `keptGens`), which the load's fence counts as another
  writer, so the load is refused. Pins written meanwhile are waited out, as every lease-aware writer waits them out.
- **An erasure searches the bucket of a segment that has no generation yet.** A row created by `setRetention` before
  the first load was answered `'no-generation'` without a look, so an object a first load wrote and never published,
  holding the id, stayed in the bucket and the ledger left the segment out. Its bucket is searched now; such an object
  is refused with `WriteConflictError` and kept, since its load may still publish it, and shows in `eraseSubject`'s
  ledger as an `error: …` entry. On an encrypted store the object is sealed under a key its load has not published,
  so it cannot be searched and is refused the same way; a row with nothing in its bucket is still `'no-generation'`
  under `requireEncryption`, not refused as cleartext.
- **An erasure rewrite that a `dropSegment` overtakes deletes what it wrote.** A drop that lands while `eraseSubject`
  rewrites a segment usually finishes its sweep before the rewrite's object is written, and that object, a full copy
  of the dropped segment less one id, in the clear on a cleartext segment, was left in the bucket and reported
  nowhere. Under a tombstone the rewrite now deletes it, as a refused load already did. A rewrite whose publish the
  drop refuses reports `'destroyed'`, as the guide says, where it reported `'superseded'`, whose advice to re-run finds
  nothing.
- **Whether a `materializeMany` output fits its budget no longer depends on where it sits in the call.** Each group
  keeps its plan, charged, until it starts, and those charges shrank the room every later output was judged against:
  three identical outputs at the budget a refusal named published the first two and refused the third, and later
  groups were cut short, re-reading their operands more often. Every output is now judged against the room the call's
  own plan leaves, and kept plans give way to any charge that needs their room.
- **`stats.chunks.pruned` counts an operand a group names and never reads.** An `and` with a disjoint side, or an
  opt-out list with nothing near what it subtracts from, skips every chunk of that operand, and none was counted, so
  the figure the guide offers for the saving of a long opt-out list reported `0` for the case it describes. Each such
  operand now adds all its index keys, once a group, and a group refused for memory no longer adds its pruning.
- **S3 refuses an object cap above 5 TiB and a part above 5 GiB**, S3's own limits, with `ValidationError` when the
  backend is built. A larger `maxObjectBytes`, such as `Number.MAX_SAFE_INTEGER` for "no limit", grew the part to
  cover it past S3's part limit, so a write held an object of up to hundreds of GiB in memory whole, copied it once
  more, and sent it as one `PutObject` that S3 refuses above 5 GiB.
- **Only an AWS S3 host turns S3 conditional deletes on by default.** Any host under an AWS domain with a label that
  started with `s3-` counted, so a load balancer named `s3-…` in front of MinIO, an API Gateway or an S3 website
  endpoint was taken for AWS S3, and the registry removed rows with a conditional delete the store behind it may
  ignore. A host now counts by its structure: a label that names S3 itself, followed only by `dualstack`, a region and
  `vpce`. Access-point, multi-region access-point, Object Lambda, Outposts and directory-bucket hosts still count.
- **Azure Blob reads a `409` or `412` as a lost race only when it is one.** Every `409` and `412` was taken as another
  writer winning, so a write-once (immutable) container's `BlobImmutableDueToPolicy` turned a load into
  `published: false, reason: 'superseded'`, and a blob leased in the portal (`LeaseIdMissing`) made a registry write
  spend its attempts and throw `WriteConflictError` as contention. Only `BlobAlreadyExists` and `ConditionNotMet`, or
  a `409` or `412` with no code, are a lost race now; any other reaches the caller as Azure's own error.
- **A GCS write that fails with `ECONNABORTED`, `EHOSTUNREACH`, `ENETUNREACH` or `ERR_STREAM_PREMATURE_CLOSE` is a
  `TransientError`**, as the same fault already was on a read. It reached the caller raw, so a registry write was not
  settled by reading what landed, and a caller keyed on `TransientError` did not run it again.
- **A GCS registry write can no longer delete the row it meant to replace.** The SDK checks an upload's checksum
  after the upload, and on a mismatch, or an answer that names no checksum (as some GCS-compatible servers send),
  deletes the object by name with no precondition. For a registry row that removed the live row, another writer's
  newer one included, and the segment then read as empty. The GCS registry now sends the row's CRC32C with the upload,
  so GCS checks it and stores nothing on a mismatch, and turns the SDK's after-the-fact check off. Generation uploads
  keep the SDK's check: a generation's name is written once, so the object it deletes is the one that write created.
- **An option held in a getter or inherited from a prototype is the option a call runs with.** `retireExpired` and
  `exportSegments` copied their options with a spread, which keeps only an object's own properties, so a `dryRun` or
  a `namespace` held in a class getter or on a prototype, which TypeScript accepts, was dropped after it was checked:
  `retireExpired(new SweepConfig())` with a `dryRun` getter ran a real sweep, and `exportSegments(sink, scope)` with
  a `namespace` getter exported every namespace. `costReport` dropped a `workload` field held the same way. Each now
  reads its options by name and runs with exactly what it checked.
- **A bucket or container that does not exist is an error, not an empty store.** The S3, GCS and Azure Blob drivers
  read a missing bucket as a missing object, so a misspelt, not yet created or deleted bucket answered `has` with
  `false`, `count` with `0` and a registry read with no row, with nothing to see. Each call now fails, as a load and
  a listing already did: S3 and Azure Blob with the service's own `NoSuchBucket` and `ContainerNotFound`. GCS answers
  a missing bucket and a missing object with the same `404`, so the GCS driver settles its first `404` with one
  object listing, which only a missing bucket answers with `404`, and remembers the bucket once seen; a missing one
  fails with `the GCS bucket does not exist: <bucket>`. A listing the identity may not make (`403`) is remembered as
  saying nothing; any other failed listing is asked again at the next `404`. A GCS generation delete in a missing bucket fails too, where
  it reported the object gone.
- **A registry row is read only under the name it was written for.** A row copied or restored to another segment's key
  or file read as that segment while naming the original, so a sweep that acts on the name a row carries (an
  erasure, a retention pass, a report) skipped a live, readable segment or acted on the original twice. Such a row
  is now refused with `IntegrityError`, on every driver.
- **The LocalFs drivers write every byte, and a refused registry row is named without the host's paths or its whole
  stored value.** One write to a file can write fewer bytes than asked and not fail (a full disk, a quota), and both
  drivers took it for the whole: `putImmutable` reported the size and digest of bytes it had not stored, and a registry
  write replaced a good row with a torn one, which then failed every listing that reached it. Each now writes until
  every byte is down, and a write that makes no progress fails as a full device; a failed registry write removes its
  temporary file. A row refused as malformed was named by its absolute path and quoted whatever its bad field held,
  however long; it is now named by its path under the store's root, and a stored value is shown to 64 characters.
- **The export CLI refuses a `CR_EXPORT_ROOT` that does not exist or is empty, and a re-run removes the last run's
  manifest first.** A root that was a typo, or a mount point whose volume was not mounted, exported nothing, wrote a
  manifest with `totalSegments: 0` and exited 0: a finished dump with no data in it. It now exits non-zero before
  writing anything. And a re-run into a directory holding an earlier run's `manifest.json` left it in place until the
  new one replaced it, so a run that stopped part way left a marker of a finished run, with the earlier run's counts.
- **Six more inputs of the wrong kind are refused where they changed what a call did.** An erasure or subject-report
  scope of `namespace: ''`, or a namespace that is not a string, scanned nothing and read as a clean erasure. A key
  given to `InProcessKeystore` or `NodeAead` as text of the right length became a key of printable characters with no
  key derivation. A retry `baseDelayMs`, `maxDelayMs` or `backoffFactor` of `NaN`, a negative delay, a factor below 1,
  an unknown `jitter` or an `onRetry` that is not a function made the backoff a hot retry loop; they are now checked
  when the store is built. `retireExpired`'s `shards` without `totalShards`, or a shard outside `0` to
  `totalShards - 1`, owned everything or nothing, so replicas numbered from 1 left shard 0 unswept. `exportSegments`'
  `ndjsonBatchBytes` of `NaN` or `Infinity` never flushed and one below 1 wrote once per id, and a `format` other than
  `'roaring'` or `'ndjson'` wrote `.ndjson` under the wrong name. `estimateCost`'s `cacheHitRate` above 1 (95 meant as
  95%) read as every read a hit. Each is now a `ValidationError` naming what is wrong.
- **A combine refuses an operand whose segment was dropped, retired or crypto-shredded, as it refuses one that never
  existed.** The check that refuses an operand naming no segment asked the registry whether a row was there, and a
  tombstone is a row, so an `exclude` that a drop or a retention sweep had retired passed the check, read as empty and
  suppressed nobody: `audience.andNot([optOut])` returned the opted-out ids once `optOut` was dropped, with no error,
  while `store.exists(optOut)` already answered `false`. It is now refused with `ValidationError` ("does not exist or
  was dropped"), on the combines, the `*Into` verbs and `materializeMany`; pass `allowAbsentOperands: true` to read it
  as empty on purpose. A row with no generation yet still exists.
- **The library's errors keep their names in an application bundled with a minifier.** Each error took its `name`
  from its class, which a minifying bundler renames (`WriteConflictError` became a letter or two), and the predicates
  (`isWriteConflictError`, `isNotFoundError` and the rest) match on that name: so in such a bundle the library's own
  handling went wrong, as a lost compare-and-swap thrown instead of retried, a read that heals off a collected
  generation thrown instead of healed, and a load refused under a dropped row leaving its object in the bucket. Each
  class now carries its name as a string no minifier touches, and a test bundles the library with esbuild's `minify`
  and holds every error class to its name and its predicate. An application's own subclass keeps its own name.
- **An audit or metrics sink without an `onEvent` method is refused.** A bare callback passed as `audit`
  (`audit: (e) => log(e)`), or a sink whose method is named `emit`, was accepted and received nothing: the guard that
  keeps a throwing sink from breaking an operation swallowed the error of calling it, so an erasure returned
  `erased: true` with no event delivered. Each is now a `ValidationError` before anything is written, from the store's
  verbs, core's lifecycle functions and each `materializeMany` output; a `metrics` option of the wrong shape is refused
  when the store is built.
- **Every call refuses an option it does not take, options that are not an object, and a switch that is not a
  boolean.** Only the store's constructor, `materializeMany` and the pins checked their options; every other call read
  a bag of the wrong shape as no options and ignored an unknown key, and that silently widened what it did:
  `retireExpired({ dryRun: 'true' })` and `dropSegment(ref, { confirmSegment, dryRun: 'true' })` deleted,
  `purgeTombstones: 'false'` purged the tombstones `false` keeps, `segments('tenantA')`, `exportSegments(sink,
  'tenantA')`, `retireExpired('tenantB')` and `checkConsistency('ns1')` reached every namespace, and
  `load(ref, ids, { minRetained: 0.5 })` (the bound outside `guard`) published the shrink it was meant to refuse. Each
  is now a `ValidationError` naming the call and the key, before anything is read or written, on the reads, the
  combines and `*Into` verbs, `load`, `rollback`, `dropSegment`, `retireExpired`, `subjectReport`, `eraseSubject`,
  `segments`, `checkConsistency`, `exportSegments` and `costReport`, and for an unknown bound inside `guard`.
  `undefined`, `null` and a key whose value is `undefined` still read as absent, except for a switch, which must be
  `true` or `false`: `dryRun: null`, read as absent, dropped for real. Code that passed a key a call does not
  take, such as an `*Into` call's `audit` handed to `intersect`, removes it. TypeScript compiled such a key when the
  options were a variable rather than a literal written in the call, for one object shared by `intersect` and
  `iterate`, so typed code can meet this refusal too.
- **`retireExpired` retires only a segment that is still expired when its tombstone is written, and claims only the
  tombstones it wrote.** The sweep re-read each row before retiring it, but the drop read it again and acted on what it
  found, so a retention extended or cleared between the two reads, or by a write the drop's own write lost to, was
  retired anyway, against the guide's promise that cancelling an expiry works on a sweep already in flight. And a
  tombstone someone else wrote in that window (a crypto-shred, a drop) was counted as retired and stamped as the
  sweep's, so a later sweep purged the row the shred left as its attestation. The expiry is now judged on every row the
  drop is about to replace, and the sweep's mark is written in the tombstone's own write; anything else is skipped
  with `policy-changed`. A retirement makes a read and a write fewer: 7 reads, 2 writes and a delete with
  `conditionalDelete` on, 6 reads and 2 writes with it off, and `estimateCost` prices it so.
- **An async metrics or audit sink that rejects no longer ends the process.** An `async onEvent` is assignable to the
  sinks' `onEvent(): void`, and its rejection (a telemetry or audit service that is down) escaped the guard that
  swallows a throwing sink, as an unhandled rejection, which ends a Node process by default: mid-erasure, with no
  ledger returned. Its rejection is now swallowed like a throw.
- **A read of ranges over more segments than the reader cache keeps no longer opens each object again per chunk.**
  Before it hands out a chunk, a combine or `iterate` checks that its segment has not moved. Once the reader cache had
  let the segment go, that check opened the generation again (a tail read and an index parse of up to about 1.3 MB)
  only to learn a version the registry row already names, so a read over more segments than `cache.readerMax` or
  `cache.readerMaxBytes` keeps (as on a small Lambda) paid that for every chunk. The check now learns the version from
  the registry row alone (on a store with no registry, a listing of the bucket), as a read of that chunk on its own
  would. A transient fault in it is retried through the store's retry, where it failed the read. A chunk served from
  the decoded-chunk cache is still checked through the segment's current version, which opens a segment the reader
  cache let go of again, so a warm read under reader-cache pressure still pays a registry read and an object open per
  cached chunk.
- **`cache.genTtlMs` that is not a finite number of 0 or more is refused.** `NaN` (from an unset environment variable),
  a negative number or a string turned the timed pointer refresh off as `0` does, silently, so another process's load
  or erasure never reached a long-lived reader. Each is now a `ValidationError` when the store is built. So is
  `Infinity`: a store meant never to refresh on a timer says so with `0`.
- **A `budget` that is not `{ maxRequests }` or `false` is refused.** A per-call `budget: 5`, `'5'` or
  `{ maxRequest: 5 }` read as no override, so the store's budget (1,000,000 requests by default) applied instead of the
  cap the caller wrote; the store's own `budget` was read the same way. Each is now a `ValidationError` naming what is
  wrong. A per-call `budget: null` now inherits the store's budget, where it put the default back on a store built with
  `budget: false`.
- **A read in progress re-resolves the segment before each chunk it serves from the cache, as it does for the rest.** A
  combine or `iterate` whose chunks were in the store's decoded-chunk cache served the generation it planned under for
  as long as it was pulled, past `cache.genTtlMs`: another process's load did not reach it, and an id that process
  erased could still be yielded, so the written bound on what a read in progress yields after an erasure held only
  for chunks read from storage. Each cached chunk a read serves is now checked against the segment's current version,
  a lookup and not a request within `genTtlMs`, and one of a generation since replaced is read as the segment is now.
  A point read resolves the version just before it asks, and is unchanged. Measured on a laptop over 2,000 cached
  chunks, the check adds about a microsecond a chunk. A read whose chunks were all cached, and that meets a move, reads
  the rest as one stream at the version now current, as a cold read does.
- **`store.segment` refuses an option it does not know, and options that are not an object.** A misspelt `namespace`
  (`{ nameSpace: tenant }`), or a namespace passed on its own (`store.segment('a', 'tenant')`), was read as no
  namespace, so the handle addressed the segment of that name in the default namespace: a read of another
  namespace's data, or an `*Into` that wrote outside the tenant's. Each is now a `ValidationError` naming the key; a
  key whose value is `undefined` is still read as absent, so a spread of options keeps working.
- **A `guard` that is not an object is refused, instead of being read as no bound.** `{ guard: 0.5 }` meant as
  `{ guard: { minRetained: 0.5 } }`, or a guard passed as a string or an array, read as no bound at all on
  `store.load`, the `*Into` verbs and `judgeLoad`, so a load the caller meant to refuse published. Each is now a
  `ValidationError` before any request. `store.materializeMany` refused it already.
- **An `exclude` that is not an array is refused, instead of being read as no exclusion.** A `Set` or a lone segment
  passed as `exclude` to `intersect`, `union`, `intersectInto` or `unionInto` was taken without an error and applied
  none of it, so the call streamed or published the ids it was meant to remove. The option's type is an array, so code
  that typechecks against it was not affected. Each of these calls now refuses such an `exclude` with a
  `ValidationError` before reading anything, and an operand list that is not an array (`a.intersect(b)` for
  `a.intersect([b])`) is refused the same way, where it failed with a raw `TypeError`. `store.materializeMany` checks
  its lists already.
- **An element of an operand list that is not a segment is refused with a `ValidationError`.** `intersect`, `union`,
  `andNot` and the `*Into` calls failed with a raw `TypeError` (`h.leaseError is not a function`) when an operand, an
  `exclude` or a destination was not a segment. They now refuse it before reading anything. A segment from another copy
  of the package is accepted, as before.
- **`store.materializeMany`'s `mayBeEmpty` with no feed says what is wrong with it.** The message was "mayBeEmpty names
  fed operands, and the call has no feed" for every name. It now names the first such
  entry and what it is (`"a", a stored operand`, `"x", which is not an operand of this call`, or something that is not
  a name), and a value that is not an array is refused as one. Code that matched the old text must match the new one.

## [0.18.3] — 2026-10-07

### Security

- **The S3, GCS and Azure drivers trim `prefix` in linear time.** The trim of a prefix's leading and trailing slashes
  used a regular expression that backtracked over every run of slashes not at the end, so a prefix holding a long run
  took time quadratic in its length, on every key a driver built (measured on a laptop: about 6 seconds a key for a
  run of 100,000). The prefix comes from the application's own driver options, never from a stored object or a
  caller's id. The keys built are unchanged.

## [0.18.2] — 2026-10-07

### Security

- **`export-segments` refuses a symlinked or foreign namespace directory in its output.** It writes only into
  directories it made, or ones an earlier run of it left (yours and owner-only). A symlink, a path that is not a
  directory, a directory of another user, or one open to group or others in a namespace directory's place is refused
  with a `ValidationError`.
- **`InProcessKeystore` checks `activeKeyId` and `recoveryKeyId` against the keys it was given.** A name every object
  inherits, such as `constructor`, was counted as a key and failed later in `createDek()` with a `TypeError`; it is now
  refused at construction with a `ValidationError`.
- **The Azure and GCS storage drivers use the same `prefix` check as the registries and S3.** Built directly, they
  accepted a prefix with a backslash, a DEL character or a percent-encoded `..`; each is now a `ValidationError`.
- **`LocalFsStorage` tells names apart by case on a case-insensitive filesystem.** On macOS and Windows defaults a
  namespace or segment that differed only by case opened the same file: it read as present, and a load wrote the next
  generation of the other name's segment. The driver now compares the name on disk exactly, so a name in another case
  reads as absent, and a write that would land on an existing case variant fails with a `ValidationError`. The on-disk
  layout is unchanged, and a case-sensitive filesystem pays nothing.
- **`LocalFsStorage` refuses a name too long for its file names with a `ValidationError`, before anything is written.**
  A segment name of about 208 characters or more passed the 256-character cap but made a temp file name past the 255
  bytes filesystems allow, and failed with a raw `ENAMETOOLONG` whose message carried the absolute storage root.
- **A registry row's `currentGen` must be a safe integer, and a load refuses a number past it.** A row holding a
  generation above `2^53 - 1` was accepted, and a load then published an object the reader could not open. The write and
  read checks now use `Number.isSafeInteger`. At the largest safe generation, `load`, `intersectInto`, `unionInto` and
  `andNotInto` throw an `IntegrityError` before writing anything, `materializeMany` returns that error on each output it
  could not publish, and `eraseSubject` returns `erased: false` with a note instead of rewriting.
- **GCS and S3 errors carry no request credential or live transport.** Both SDKs keep the request they sent on the
  errors they raise (the GCS SDK `response.request` and `config`, the AWS SDK `$response`), and through it the HTTP
  agent and its sockets, whose raw request text holds the bearer token or session token of calls still in flight. The
  drivers passed those errors on as the error or its `cause`. They now throw a copy that has the same prototype, name,
  message, stack, status, code and request id, and none of the request, agent, socket or configuration; the live SDK
  objects are never changed. This holds under `util.inspect` with `showHidden`, `JSON.stringify` and the stack. The
  Azure driver's errors were checked the same way and hold no credential.
- **The S3 and Azure drivers bound every response body they read.** A range read, a tail read and a registry row are read
  as a stream and counted, and the read fails with a typed error at the first byte past what was asked for (and at once
  when the response advertises more), instead of buffering a body from an endpoint that ignores `Range` or sends no
  length. The body is destroyed on the way out.
- **Error messages no longer carry an id.** A refused id (`has`, `load`, `store.memory`, `eraseSubject`,
  `subjectReport`), a bound (`after`, `through`, on `iterate` and `materializeMany`), an out-of-range chunk key or value
  in a load input, and a bare value passed as a load input were echoed in the `ValidationError` message, and applications
  log messages. The messages now say what is wrong without the value: `an id must be an integer from 0 to 4294967295`,
  `after must be an integer from 0 to 4294967295`. A message about a feed record still names its chunk key, a number
  from 0 to 65535 that 65,536 ids share, not an id.
  Code that matched the old text `id must be an integer in 0..4294967295; got <value>` must match the new one.

## [0.18.1] — 2026-10-07

### Fixed

- **`store.materializeMany` accepts an empty `mayBeEmpty` on any call.** A call with no feed and no held operand refused
  `mayBeEmpty: []` with a `ValidationError`, though an empty list names nothing and the same list was accepted beside a
  feed or a held operand. Code that always passes a computed list, empty when nothing may be empty, is no longer refused;
  naming an operand that is neither held nor fed is still a `ValidationError`.
- **Documentation corrections.** The package READMEs no longer say they describe `main` ahead of the release they ship in. The
  `roaring` README, the site's API lists and `llms.txt` name `store.materializeMany` and `store.memory`, and the guides say that
  `materializeMany` emits no `storage.get`, `cache`, `intersect` or `op` metrics event while its per-output audit events still
  fire. `StaleOperandError`'s doc comment says `'erased'` also applies to a held operand, and the pinned re-check's
  fingerprint compare is described as the code does it. A held operand's size is described by how it follows the ids' layout, and
  the roadmap names the registry row's schema as 3. The getting-started guide's Redis table maps `BITOP ANDOR` and `BITOP XOR` to
  one `store.materializeMany` expression, where it said neither has a single call.

## [0.18.0] — 2026-10-06

### Added

- **`store.memory(input)` holds ids in memory as an operand of `store.materializeMany`, and of no other verb.** It takes what
  `store.load` takes (ids as a sync or async iterable or a typed array, `{ bitmap }`, `{ serialized }`), checked the same way with the
  same errors: the size cap, the structure, the safe deserializer and each id's range. Only a real `Uint32Array`, by the typed
  array's own brand (a subclass, a shared-memory view and another realm's are real ones; a spoof and a proxy are not), skips the
  per-id range check, and any other typed array goes through it; an object with an `ascending` key is refused with a message that
  names the feed. The handle is a `MemoryOperand`: `release()` zeroes and drops its bytes, any later use throws, and a second
  release does nothing. A held operand is read from memory beside stored and fed ones with no request and never touches the shared
  chunk cache, and the output is byte for byte what the same operand stored would publish; its bytes count against
  `maxBufferedBytes` while the call runs and are the caller's between calls. An empty held operand is accepted by `store.memory`
  and refused by the call unless its name is in `mayBeEmpty`, which now names held operands as well as fed ones. A handle
  belongs to the store that made it, and an erasure that starts in that store after the handle began to be made, or is still
  running when it was (the counter `eraseSubject` moves), fails the outputs that read it with `StaleOperandError` (`reason: 'erased'`), before any request and
  again immediately before each publish; an erasure in another store or process is not seen. `operands` is now typed
  `Record<string, Segment | MemoryOperand>`. New: `MemoryOperand` from `@cloudbitmaps/roaring`; `prepareHeld`, `CombineManyHeld` and
  `HeldChunks` from `@cloudbitmaps/core`; `held` on `CombineManyOperand`. Nothing else changes.
  [Guide](docs/guide/loading.md#operands-held-in-memory-storememory).
- **`store.materializeMany` takes a feed: operands that arrive as records in chunk-key order, for conditions too many to hold or store.**
  `feed: { names, records, counts }` declares the fed operand names, an `AsyncIterable` of `{ key, operands: Record<string,
  Uint32Array> }` and the ids each name holds (an object, or a function called once after the last record), and an output names a fed operand as it names a stored
  one; the two mix in one call and one pass, and the outputs are byte for byte what the same operands stored would publish. A key may arrive as several records and each name at most once per key;
  every record is checked before the pass sees it (key in range and not below the last, every name declared, every value a real
  `Uint32Array` read through the typed array's own accessors, ids strictly ascending and inside the key), and a bad feed is
  refused, never read as fewer members, with a `ValidationError` that names the key and the operand and no id. Fed outputs are
  atomic: they publish only after the whole feed was read and the end-of-feed checks passed (`counts` equal to the ids seen, which
  catches a feed that ended early or skipped a key; a declared name that appeared in no record refused unless it is in
  `mayBeEmpty`), so a bad feed, a throwing iterator, a budget overrun while the feed is read or an erasure before the publishes
  begin refuses every fed output and publishes none of them, while outputs that name only stored operands are unaffected; after
  that each fed output publishes on its own: an erasure that lands before a publish refuses every fed output not yet
  published, and one whose object does not fit the budget at its publish is refused alone. A feed is read once, so the call runs as one group and
  `maxBufferedBytes` is required with it; each record is converted to compressed bitmaps as it arrives and the call fails as soon
  as the ledger passes the budget. Counted with 10,000 fed operands of 800 ids a key (32 MB a key as `Uint32Array`s): a ledger high
  water of 62 MB over five keys, two keys' worth. A call with a feed records the store's erasure counter, which `eraseSubject` moves at its start and
  its end, and is refused with `StaleOperandError` (`reason: 'erased'`, new) at its next record and before each fed publish once it
  moved, and at its first record when an erasure was already running as it began; a call with no feed never reads it. New types `MaterializeManyFeed` and `MaterializeManyFeedRecord`, and `CombineManyFeed`
  and `CombineManyFeedRecord` from `@cloudbitmaps/core`. Nothing existing changes except that `eraseSubject` moves the counter.
  [Guide](docs/guide/loading.md#operands-that-arrive-as-records-a-feed).
- **`store.materializeMany` writes many `*Into` outputs in a chunk-ordered pass that reads each operand once per group.** Each output is an expression
  (`and`, `or`, `andNot`, nested to 64 operators) over named stored operands, with an `exclude` list, published as a new
  generation of its own `dest` exactly as an `*Into` publishes. Every operand chunk is read once for all the outputs of a
  group that use it, an operand is read only at the chunks an output can hold (an exclude only where the left side can
  overlap it), and a nested expression needs no scratch segment. `run.outputs[i]` is what the output's `*Into` would have
  returned, or `{ published: false, error }` for what it would have thrown, so one output's refusal, lost race or damaged
  operand never stops another; the call throws `ValidationError` for bad input before any request. `keep` is required
  and an output's own overrides it. Every stored operand is pinned for the call by default, one generation per operand and
  not one instant across operands (`pin: false` reads live). Immediately before the publishes the call re-reads each
  pinned operand an output subtracts (in `exclude`, or after the first entry of an `andNot`), and an output whose subtracted operand was replaced, a name deleted and created again included, is not published: it carries the new
  `StaleOperandError` (`code: 'stale-operand'`, `operand`, `reason: 'moved'`). `maxBufferedBytes` (default 256 MiB)
  counts resident bytes, not serialized size (a native bitmap costs about 440 bytes over its serialized bytes), the plan
  included, and the outputs run in groups when they do not fit, enforced while the pass runs so an index that understates a
  chunk cannot grow a group past it. Process memory is more than the count: measured on the in-memory backend, resident set
  size grew 1.6 times the ledger's high water on Linux and 2.5 to 5 times on macOS (see the guide). The operands are read
  once per group, so the number of groups grows with the total output size over the budget: 100 operands of 3,000,000
  ids and 1,000 outputs of about 5 MB took 81 groups and 19,005 range reads at the default and 6 groups
  and 3,570 at 2 GiB (counted). Range requests are held to one window of 64 across all operands. A leased operand's lease and an
  operand's deadline are checked before each chunk key, and each `dest`'s again at its publish. Every chunk is decoded
  through the checks on untrusted bytes, and a listed key whose bytes are missing is an error for the outputs reading
  that operand, never an empty chunk. The pass does not touch the decoded-chunk cache. Requests of a refresh-shaped call, **counted in memory** by wrapping the storage and registry drivers (`bench/materialize-many-counts.cjs`, whose JSON the figures are held to), **not measured on S3**: 100 stored operands of 200,000 ids and 1,000 outputs of one or two levels with an opt-out excluded, each `dest` holding a generation, `keep: 12`. 1,000 `*Into` calls with scratch segments made 143,761 GET-class (137,037 range reads) and 3,404 PUT-class requests with 818 scratch segments; one `materializeMany` made 3,505 GET-class (590 range reads) and 1,768 PUT-class in 6 groups at the default budget. The new types (`Expr`, `MaterializeManyOptions`, `MaterializeManyOutput`,
  `MaterializeManyOutcome`, `MaterializeManyRun`, `MaterializeManyStats`, `MaterializeManyOperandStats`,
  `MaterializeManyOutputStats`), `StaleOperandError` and `isStaleOperandError` are exported from
  `@cloudbitmaps/roaring`, and `compileCombineMany`, `rebindCombineMany` and `runCombineMany` with their types from `@cloudbitmaps/core`.
  Nothing existing changes. [Guide](docs/guide/loading.md#many-outputs-from-one-pass-materializemany).
- **A CI gate holds the public signatures.** `scripts/api-surface.cjs` compares the type declarations the build emits
  for every public entry point with a committed snapshot, `api-surface/surface.json`. It fails a removed or changed
  public signature, or a required member added to an existing interface, unless a reason row added in the same pull
  request, in `api-surface/allowed.json`, excuses it; an addition passes. It runs after the build
  (`pnpm api:surface:check`), in the release job, and on every pull request against its base branch
  (`.github/workflows/api-surface-base.yml`). `pnpm api:surface` regenerates the snapshot. No library behaviour changes.

- **The calibration harness has a large suite.** `--suite large` (or `CR_CALIBRATE_SUITE=large`) measures combines on
  operands of about a million, five million and ten million ids, which the default suite's layout refuses: two operand
  segments a size, about 1,500 chunks each with 20 % shared. Its stages load the six operands through `store.load()`,
  then run uncached intersects, unions and `andNot`s and repeated `intersectInto`, `unionInto` and `andNotInto` calls
  onto a destination of their own, 40 reads and 5 `*Into` calls a size by default (`CR_CALIBRATE_LARGE_READS`,
  `CR_CALIBRATE_LARGE_INTOS`). Each stage is held to the exact PUT-class and GET-class requests the real engine makes of
  these layouts, counted in memory before anything is created: at the default plan 169 PUT-class and 5,652 GET-class,
  about $0.0031. The pre-flight bound bounds each range request by the object's bytes, not by its chunks, at most
  `ceil(bytes / 256 KiB) + 1` ranges an object, which a property test holds the engine to; the bound is 663 PUT-class
  and 28,919 GET-class, $0.0149, under the five-cent ceiling, which is unchanged. The suite has its own evidence
  directory, `bench/calibration/large/`, which the default suite's figures and report gates do not read, and it
  refuses to start on a machine with under 768 MiB of memory or 256 MiB of disk free, after printing what the machine
  has. The default suite's stages, projection, expected counts and evidence are unchanged. Nothing is measured on a
  cloud yet: the suite has been rehearsed against MinIO only. No library code, package or version changes.
- **The calibration harness measures a steady `store.load()`.** A new last stage, `steadyLoad`, loads one small segment
  18 times at `keep: 12` and records each load's requests by class (PUT, GET, HEAD, LIST, DELETE), its bytes and its
  time. Each load is held to the requests of its kind on S3's request shape: the first load, the loads up to generation
  12 that collect nothing, a load that deletes by name (2 PUT-class, 4 GET-class and a delete) and the load at
  generation 16 that lists. The stage is bounded as a load is, and the default run's projection is 567 PUT-class and
  106,894 GET-class requests, $0.0455926 against the $0.05 ceiling. Before it creates anything the harness checks, in
  memory, that the installed library collects by name at that `keep`, and refuses one that does not. The figures
  derivation holds a run that recorded the stage to the counts of each kind and states each kind's price; a run of an
  earlier release is not asked for it. The meter no longer counts the `ContentLength` of a `HeadObject` as bytes read.

### Changed

- **The checks on untrusted tier data are one module.** The engine's checks on chunk keys, chunk cardinalities and
  chunk payloads (the safe decode under the size cap and the payload range check) moved, unchanged, into one core
  module that is not exported, so every reader of stored bytes goes through the same checks. The error classes and
  messages are the same, and a timing of the hot path, old build against new, showed no measurable difference.

- **A steady `store.load()` at `keep: 12` is now measured on S3, and so is a reload.** A run from AWS CloudShell in
  `us-east-1` on 2026-10-06 (run `2026-10-06-9d36b`) loaded one segment 18 times. The first load made 2 PUT + 3 GET,
  $11.20 per million at the default prices. Each of 12 reloads made 2 PUT + 2 GET, $0.0000108. A load that
  deletes by name costs $11.60 per million: 2 PUT-class + 4 GET-class and a delete, 7 requests, in each of 4 loads. The load at generation
  16, which lists, made 3 PUT-class + 5 GET-class and a delete, $0.0000170. Averaged over a cycle of 16 loads, a
  million single-part loads cost $11.94, derived from the two measured kinds. The same run measured a cold intersect
  of two segments sharing 100 chunks that lie together at 99.80 ms at the median in 6 GETs, an `andNot` against ten
  excludes at 351.64 ms in 33, and a single-part load at 2.59 million ids a second; its requests cost $0.0027548. Its
  request counts are those of the stages the earlier run timed. Latencies of runs from different CloudShell sessions
  are not comparable, so none is set against another's. The requests at a `keep` other than 12 stay counted, not
  measured. Both READMEs, the benchmarks page, the roadmap, the guides and the site quote it, and the calibration gate
  holds the steady figures to the run's evidence.

## [0.17.0] — 2026-10-05

### Breaking

- **Registry rows are schema 3, and there is no going back: stop every 0.16 process that writes a store before the first
  0.17 write.** Every row a 0.17 registry writes, whether a create, a compare-and-swap or a tombstone, is stamped
  `schemaVersion: 3`, whatever it holds, and 0.17 reads rows stamped 1, 2 or 3. A 0.16 process refuses a schema-3 row
  with `UnsupportedError`: a load, an `*Into`, a `rollback`, a `setRetention` or a drop of that row throws, and so does
  every `list()` that reaches it, in its namespace and in every unscoped listing, so a single 0.17 write stops each
  0.16 call that lists the registry: `retireExpired`, `eraseSubject`, `subjectReport`, `eraseNamespace`,
  `checkConsistency`, `store.segments()` and the `export-segments` CLI. It fails closed and typed, and never misreads
  a row. Every process that writes a store moves together. Upgrade in this order:
  1. Upgrade the processes that only read to 0.17 first: those that call `count`, `has`, `iterate`, the combines or
     `pin`, and those that list, `store.segments()` and `subjectReport`. 0.17 reads every row 0.16 wrote.
  2. Stop every 0.16 process that writes, runs a retention sweep, erases, checks consistency or exports, then start
     the 0.17 ones. A 0.16 `eraseSubject` cannot complete once a schema-3 row exists in a namespace it lists (every
     namespace, for an unscoped run), so schedule erasure runs around the cut-over.
  3. There is no downgrade. After the first 0.17 write, 0.16 cannot read the registry; the only way back is a
     registry restore to a point before that write (the disaster-recovery guide), which loses every write since.

  Schema 3 adds the record's optional `keptGens` and `leases`, below. A row stamped 2 may hold only what schema 2 could: a
  `keptGens` or a `leases` on one is an `IntegrityError`. A registry of your own must store and return the field, and drop it on a
  patch that moves `currentGen` without naming it; the conformance suite holds a driver to both.

- **`runExport`'s `reader` must offer `pin()`.** A caller that passes its own reader to `runExport` (from
  `@cloudbitmaps/core`) needs `segment(name, { namespace? })` to return a handle with `pin(): Promise<{ iterate():
  AsyncIterable<number> }>`, the `SegmentReader` type, now exported. A reader without it no longer type-checks, and at
  runtime `runExport` throws a `ValidationError` naming the missing method before it opens any file. `store.exportSegments`
  and the `export-segments` command pass a store, which has `pin()`, and are unaffected.

### Added

- **`pin({ leaseUntil })` and `pinAt(at, { leaseUntil })`: a bounded lease on a pin.** A leased pin keeps its generation out of a load's collection until
  `leaseUntil`, an epoch-millisecond instant at most 14 days out (`MAX_LEASE_MS`), whatever `keep` says and whichever
  process loads the segment: the lease is a `leases` field of the segment's registry row (schema 3, beside `keptGens`),
  which every collection reads from the row it already holds. `snap.lease` is `{ holder, until }`, and `snap.release()` ends
  it early and is idempotent. A read of the handle after the lease, or after a release, throws the new `LeaseExpiredError`
  at every read site, never empty: `has`, `count`, `stat`, `iterate`, `batches()`, `everyNth`, `costReport`, and a leased handle used
  as an operand or an `exclude` of a combine or as the target of an `*Into`. A stream checks the lease each time it reads
  a chunk. A segment holds at most 64 live leases (`MAX_LEASES_PER_SEGMENT`); the next throws `LeaseLimitError` with
  nothing written. A collector holds a lease for `LEASE_SKEW_MS` (60 seconds) after it ends, which covers clocks that differ
  by that much in either direction. A leased generation takes no `keep` slot, and the next listing pass after the lease ends
  takes it: within 16 later loads of that segment. A leased pin costs one conditional write to the row more than a pin,
  taken before the generation is opened. That write moves the row's token, and a load's publish, an erasure rewrite, a
  rollback, a retention write and a shred or drop are fenced on it, so each goes on past a row that differs from the one it
  read only in its leases, after a jittered wait and without redoing its work, up to 136 such changes (a take and a release by each of
  the 64 holders, and a few more); a change of anything else refuses as ever. A load's publish drops the leases that have
  ended from the row in its own write, and a load with no clock reads none. **A lease keeps superseded generations,
  including ids a newer load removed, until it ends, and erasure ignores it:** `eraseSubject`, `eraseIdFromSegment`,
  `destroySegment`, `dropSegment` and retention expiry delete a leased generation, a rewrite, a shred and a drop clear the
  row's leases, and `PRIVACY.md` and the erasure guide say so. The registry
  `RegistryRecord.leases` and `RegistryPatch.leases` are new, and a registry of your own must store and return the field and
  keep it when a patch moves `currentGen`; the conformance suite holds a driver to both. The holder id is drawn from the
  store's `Rng`. New exports: `LeaseExpiredError`, `LeaseLimitError`, `isLeaseExpiredError`, `isLeaseLimitError`,
  `LEASE_SKEW_MS`, `MAX_LEASE_MS`, `MAX_LEASES_PER_SEGMENT`, `PinOptions`, `Lease`, `LeaseEntry`, and from core `takeLease`,
  `releaseLease`, `PinLease`, `LeaseDeps`, `LeaseTake` and `TakenLease`.
- **`store.reapRegistryTombstones({ namespace?, dryRun?, confirmNoLegacyWriters?, limit? })`, an admin call that removes the `deleted: true` rows with no incarnation id from an object-store registry.** A release before 0.12.0 kept a deleted row as an envelope whose token is a bare counter, and a 0.12.0 or later release does the same when it deletes a row born before 0.12.0; no call removes one, and every full listing still reads each (a GET apiece). The call removes a row only if it is `deleted: true` with no incarnation id, whatever its `status`: never a live row, a `destroyed` row that is not `deleted`, or a deleted row that has an incarnation id. A real run needs `confirmNoLegacyWriters: true`, your statement that no process on a release before 0.12.0 writes the registry (without it, a `ValidationError` and no request); `dryRun` counts what a real run would remove and needs no confirmation. Each delete is conditioned on the version read, so a `create` that lands over the envelope first wins and the row is counted `skipped.raced` (a row already gone counts there too); a `create` that had already read the envelope and meets the removal throws `WriteConflictError`, which the library does not retry. A registry whose `conditionalDelete` is off (GCS by default, S3 on a custom endpoint) throws `CapabilityError` before any request, and the in-memory and local-filesystem registries `UnsupportedError`; on an endpoint that ignores `If-Match` (MinIO, fake-gcs-server), a `conditionalDelete: true` you set makes it an unfenced delete, so run it with every writer stopped. It costs `ceil(R / 1000)` LIST, R GET and E DELETE requests over R rows read and E removed. `limit` (default 1,000) bounds the removals, not the reads: a run is not resumable, each lists and reads from the start, a dry run with a `limit` shows the same first rows, and `limited` is `true` whenever the limit was spent with keys left. An object it cannot read stops the run with an error naming its key; a `namespace` scope gets past one. It returns `{ dryRun, examined, reaped, wouldReap, limited, skipped: { live, destroyed, incarnated, raced } }`. **It does not clean a bucket completely**: a tombstone `dropSegment` leaves is a `destroyed` row with no stamp, and stays, as does every live row written before 0.12.0 and a tombstone a 0.12.0 or later release wrote while `conditionalDelete` was off (it has an incarnation id, and the call refuses to run on that registry). Also `reapRegistryTombstones(registry, options)` as a free function, the optional `IRegistryDriver.reapLegacyTombstones` member that `ObjectStoreRegistry` implements, the optional `ObjectRegistryStore.resolveCapabilities`, and the types `ReapRegistryTombstonesOptions`, `ReapRegistryTombstonesResult`, `ReapLegacyTombstonesOptions` and `ReapLegacyTombstonesResult`.

- **An advisory event when an S3 client's socket pool is smaller than a combine needs.** A store with a `metrics` sink
  now sends it one `{ kind: 'advisory', code: 'socket-pool-below-window', driver, bucket, maxSockets, threshold,
  concurrency }` event, once, after the first S3 read, when the client's pool is under 64 sockets (twice the default
  `concurrency` of 32: a client you pass keeps the SDK's 50). Nothing is logged or printed and the check sends no
  request. It reads the SDK's default handler and agents you give it, and says nothing for a handler it cannot read
  (your own, HTTP/2, Fetch). `MetricEvent` gains the `advisory` variant, so a sink that ends its `switch` on `kind` with a
  `never` check needs a case for it. `StorageBackend` gains an optional `attachMetrics(sink)`, which a store calls with its
  sink, and `@cloudbitmaps/core/driver-kit` re-exports `IMetricsSink` and `MetricEvent`.

- **`pin.everyNth(n, range?)`, the ids at ranks `n`, `2n`, `3n` …, on a pinned handle.** It yields the id at each 1-based
  rank counted over the ids in `(after, through]`, ascending, and nothing for a last partial window, so a send cut into
  windows of 1,000 reads its boundaries without decoding the chunks that hold none. It places each boundary from the
  index's per-chunk counts and reads only the chunks that hold one, each once, through `iterate`'s coalesced stream, window and
  budget. A live handle throws `UnsupportedError`, a bad `n` `ValidationError`, and a chunk that is read and decodes to a different size than the
  index says `IntegrityError`; the index's counts are trusted for chunks not read, as `count()` trusts them. The paging recipe in the reading guide finds its window ends with a `.batches()` stride, and points at
  `everyNth` for the boundary case.

- **`seg.pinAt({ generation, fingerprint })`, a pin at a named generation.** It reopens a generation an earlier pin recorded
  in its `pinnedAt`, as a pinned handle like the one `pin()` returns, for a second task of one job. Identify a pin by its `generation` and `fingerprint`: the handle's `pinnedAt.version` can differ from the earlier pin's. The fingerprint is required, since a
  generation number is taken again after a purge and re-create, so a bare number, or a key `pinAt` does not know, throws `ValidationError`. A generation that is
  collected, purged, on a crypto-shredded segment, above the row's pointer, or another object than the fingerprint names throws `NotFoundError`, and the call never reads empty. It costs
  one registry read and one tail read, and it holds nothing unless leased: how long a generation can be reopened is how long `keep` retains it, or how long
  `pinAt(at, { leaseUntil })` holds it.
  Exported as the `PinAt` type, with a method on `CrbmStorageChunkSource` that does the open.

- **`deserializePortable(bytes)`, and the loading guide's recipe for the parts of one segment built in separate processes.**
  `deserializePortable` decodes portable Roaring bytes you hold into a `RoaringBitmap32` through the check a
  `{ serialized }` load makes first (the size cap, the structural check, exactly one bitmap), and throws
  `ValidationError` for bytes that fail it, before the native decoder runs. `@cloudbitmaps/core` exports
  `decodeSerialized(bytes, codec, what?)`, the one check both go through. The recipe has each process serialize its part,
  and one process decode each with `deserializePortable`, join them with `RoaringBitmap32.orMany`, refuse parts that
  overlap by comparing the union's size with the sum of the parts', and load the union once, in the requests of one
  load. A property test runs the recipe from the guide: the generation is byte for byte the one a load of the whole set
  writes, wherever the ranges are cut.

### Changed

- **Each segment's export (`store.exportSegments`, `runExport`) is one instant.** The export pins a segment when it
  begins it, reading its generation from the registry then and only that generation's object for the whole segment, so
  a load that publishes while a long segment is being exported can no longer leave chunks of two generations in one
  exported file, and a warm store exports the generation current when each segment's export begins. A cold store makes
  one registry read and one tail read per segment, as before; a warm store makes one registry read per segment, which
  the live read skipped. The pin holds nothing, so if a collection or an erasure removes the pinned generation before
  the segment has been read, that segment fails with the error a pinned read gets, is recorded in the manifest's
  `failed[]` with its partial output discarded, and never reads the newer generation. Different segments are still
  different instants, so a dump of many is not a snapshot of the store.

- **Behaviour change: an expired exclusion now throws; it used to exclude nothing.** `a.andNot([stale])`,
  `a.intersect([b], { exclude: [stale] })` and `a.union([b], { exclude: [stale] })`, with a range, `.batches()` or on
  pinned handles, reject with `ValidationError` (`andNot: refusing to read while these exclusions have expired — <name>`)
  when an exclusion's `expiresAt` has passed, before any request is made. They skipped it without reading it, so a
  suppression or opt-out list that lapsed stopped excluding and the opted-out ids were included. The check is made when
  the combine is called, ahead of the rules for operands, so an expired exclusion is refused even where the combine would
  read empty, and one that names a segment that does not exist is refused as expired, not as an absent operand. A stream
  already being read is not re-checked when its exclusion expires part-way. Renew the exclusion's `expiresAt`, open it
  without one, or leave it out of the call. Unchanged: an expired `self` or include operand is empty or dropped, an
  absent operand is refused unless `allowAbsentOperands` is set, and an `*Into` involving an expired handle throws
  `ValidationError`.
- **`store.load()` collects by name at any `keep` up to 64.** The segment's row records the generations a load keeps
  (`keptGens`, ascending, each below the pointer, at most 64 written and 256 read). A load writes the new list in the
  same compare-and-swap that moves the pointer, derived from the row that write is conditioned on, then deletes the
  generations that fell out of it by name, re-reading the row before each delete and stopping unless the pointer is
  still at or above the publish, the name is below it, and the row's own list does not name it. It lists the segment on
  every 16th generation, which deletes every generation below the pointer that the row does not name (an object a crashed
  or refused load left, one a failed delete left), when its check of its number met an object, when the current object
  was found gone, for a `keep` above 64, and for a row that records no list: the first load of a row an earlier release
  wrote, or one a rollback moved. That load keeps the newest `keep` generations it finds below the pointer and records
  them with one more write on the row it just published, so a derived writer in flight on the row meets a lost fence
  once and re-derives. A `keep` of 12 therefore makes the requests a `keep` of 1 makes, about $11.94 per million
  single-part loads at the default prices, expected and not measured; a load with a `keep` above 64 lists on every load. A
  subject-erasure rewrite records that nothing below its pointer is kept. `LoadResult.collected` names every generation
  the pass asked to delete. A load whose publish has landed does not throw from its collection because another writer moved the row
  meanwhile: the pass spares what the row names then and stops where it cannot prove a delete. A malformed `keptGens` on a
  stored row is an `IntegrityError` naming the row, like a malformed `summary`; one with an entry at or above `currentGen` is read and not used.
- **A segment's first `store.load()` is now measured on S3, on `0.16.0`.** A run from AWS CloudShell in `us-east-1` on
  2026-10-05 measured what the benchmarks page had only counted from the engine: every one of the load stage's 25 loads was
  a segment's first, and made 2 PUT + 3 GET single-part and, for a multipart load, 5 PUT-class + 3 GET: $11.20 and $26.20 per million
  at the default prices. A single-part load ran at 3.28 million ids a second. The same run measured a cold intersect of two
  segments sharing 100 chunks that lie together at 92.63 ms at the median in 6 GETs, and an `andNot` against ten
  excludes at 255.60 ms in 33. Its requests cost $0.0025506. A reload and a load from the third on stay expected, since
  the run measured neither. Its rounds sit above the engine's rounds model, which assumes no socket limit; it did not
  vary its client's 128 sockets, and no stage held more than 11 requests in flight, so it does not say why. Both READMEs,
  the benchmarks page, the roadmap, the guides and the site quote it.

### Fixed

- **An empty object on S3 is read as an empty object, not as a range error.** A tail read of a zero-byte generation, an
  empty replacement for one, made S3 answer `InvalidRange` (416), which the driver raised as a `ValidationError` about a
  range. The driver now confirms the size with a `HEAD` and returns an empty tail of size 0, as the GCS driver does, so
  opening that object fails as any object too short to be a generation does, with an `IntegrityError`. A 416 on an
  object that has bytes stays a `ValidationError`.

## [0.16.0] — 2026-10-04

### Added

- **`loadSegmentChunks(ref, chunks, deps, options?)`, the form of `loadSegment` for a result already held as chunks.**
  `chunks` is an `AsyncIterable<{ chunkKey, bitmap }>` ascending by key, and each bitmap is written as it is, so no id is
  built for a value. The `*Into` verbs call it. Its options, result and refusals are `loadSegment`'s. Each chunk is checked
  before anything is written: its bitmap must be one the `codec` made (the new optional `CodecInterface.owns?(bitmap)`,
  which the roaring codec implements; a codec without it has every chunk refused), its key an integer in `[0, 65535]`
  above the one before, and its values 16-bit, or it is a `ValidationError`. The load consumes the bitmaps it is given:
  writing may re-encode one in place for size, never changing its members. `load()` and `loadSegment()` take no chunk input.
- **`IRegistryDriver.create` and `compareAndSwap` take an optional `options?: RegistryWriteOptions`, and a load makes one registry request fewer.** Its `held` is the row the caller read and is writing against: the record a `get` of that registry returned, or `null` when the caller found none. A registry that keeps the version of the object it read can then send its conditional write at once, without reading the row first. It is a hint and never the fence: the write is still conditioned on the store's own version of the row (`If-Match` on S3 and Azure Blob, `ifGenerationMatch` on GCS, create-only for a row that was absent), so a `held` row that changed since fails the write with `WriteConflictError`, exactly as a lost race does, and a driver that does not recognise the record, or that ignores the option, reads the row. `ObjectStoreRegistry`, and so the S3, GCS and Azure Blob registries, does this; the in-memory and local-filesystem registries accept it and read no more for it. A load, an `*Into` and an erasure's rewrite pass the row their publish acts on; a write that gets no answer is settled by reading the row, never by `held`. `RegistryWriteOptions` is exported from `@cloudbitmaps/core` and `@cloudbitmaps/roaring`, and the registry conformance suite checks that a driver honours a correct `held`, refuses a stale one as a lost race, and treats a missing one as before. The requests a load makes at the registry: a segment's first load reads the row twice and writes it once, a load of an existing segment reads it once and writes it once, and one that collects by name reads it once more before it deletes; the cost model prices a load at those counts.

### Changed

- **`intersectInto`, `unionInto` and `andNotInto` write the combine's chunks straight into the new generation.** The
  combine hands over each chunk's result as the bitmap it already is, in ascending key order, and the load encodes it as it
  is, so no id is built for a value. The generation is byte for byte what the ids
  would write (a cleartext object; an encrypted one holds the same chunks, each under its own nonce), and the requests,
  metric events, audit events, return values and refusals are unchanged: a budget refusal still throws before anything is
  written, and a read that fails part-way writes nothing. The write holds the result's chunks until the object is written,
  as a load of ids does.
- **A combine or an `iterate` over chunks the cache already holds opens no stream and looks each chunk up once.** A stream opens at the first chunk the cache lacks, over the uncached chunks from there on (the cached ones after it are looked up again when served), and a chunk the cache loses mid-read, to an invalidation or the LRU, is then read on its own, one request each.
- **The published in-region figures are now measured on `0.15.0`.** A run from AWS CloudShell in `us-east-1` on
  2026-10-04 measured what the benchmarks page had only counted from the engine: a cold intersect of two segments
  sharing 100 chunks that lie together took 95.03 ms at the median and made 6 GETs, and an `andNot` against ten
  excludes took 269.74 ms and made 33, the counts the engine predicts. The run's requests cost $0.0025670. Its rounds
  sit above the engine's rounds model, which assumes no socket limit; it did not vary its client's 128 sockets, and no
  stage held more than 11 requests in flight, so it does not say why. The README, the benchmarks page, the roadmap, the
  sizing guide and the site quote it; `iterate`'s 3 GETs stay expected, since the run did not time it.

## [0.15.0] — 2026-10-04

### Added

- **`StorageChunkSource.getChunks(ref, keys, options?)`, optional, for the authors of a chunk source.** It reads several
  chunks of one segment from one generation as a stream, in key order, and yields each chunk with the version of the
  generation it came from (`ChunkRead`). `options.onRequest` hears of every range request the stream sends, once, when it
  settles (taken, still in flight when the consumer stopped, or failed), with the bytes it moved, the gaps between
  chunks included, and how long it took, so a caller can count what it is billed for. `CrbmStorageChunkSource`, which the stores the library ships read through,
  implements it by merging chunks that sit within 256 KiB of each other into one range read, up to 1 MiB, and checks
  each chunk exactly as a read of it alone is checked; a custom source that cannot read a range omits it. The stream
  holds at most `options.concurrency` ranges at once (32 by default), in flight or landed and not yet taken, however
  many keys it is given, so its memory is that many times the largest range; a consumer that stops early stops the
  reads (the requests in flight finish and are not retried), and a stream that fails raises at once. Nothing is read
  until the first chunk is asked for. If the generation is swept, or its object replaced, while the stream runs, it
  waits for the requests in flight (so a heal never opens a second window beside them; one that never answers delays
  the heal until the driver's read timeout, and never an error), then carries on with the keys not yet yielded from
  the generation that is current, and each chunk says which version it came from. A plain chunk may be a view sharing
  a buffer of up to 1 MiB with its neighbours, so do not write to it, and copy one to keep it. `ReadChunksOptions.ramp` may be a number, the width the window opens at.

### Changed

- **A read of a small generation, whose chunks all arrived with its tail, makes no further request for them.** When a
  reader's tail read returns the whole object, and the chunk region is at most the reader cache's share per reader
  (`cache.readerMaxBytes` divided by `cache.readerMax`, 64 KiB by default), the reader keeps a copy of that region, and
  `getChunk` and `getChunks` serve from it: a cold `has()` of such a segment is its pointer read and its tail read, and a
  cold intersect of two of them reads two pointers and two tails and no chunk, where a segment over the share, or an object
  larger than the tail read, reads its chunks by range. **Small generations' chunk bytes stay with their reader**, up
  to the reader cache's existing byte bound (64 MiB by default, so up to 64 MiB of a store's memory can be chunk bytes,
  alongside any decoded copies in the chunk cache); lower `cache.readerMaxBytes` to shrink both the bound and the share.
  A kept chunk is checked exactly as a range-read one is (CRC32C against the index, decryption under its own associated
  data on an encrypted segment, the payload cap), and a read returns a copy, so a write to it changes nothing of the next
  read. A chunk read from kept bytes is no request: a point read, a combine and `iterate` report a `storage.get` only for
  a request a source sent, and a source's `getChunks` calls no `onRequest` for one it served from memory. The point read
  of a source that has `getChunks` is a one-key stream, and its chunk is cached under the version the stream says it came
  from. The kept bytes count in the reader's `retainedBytes`, so the reader cache's count and byte bounds hold;
  `invalidate()`, eviction and erasure drop the reader and the bytes with it, and a pin keeps them as long as it holds its
  reader. Like a chunk-cache hit, a kept chunk is served from the one verified generation the reader opened, so a sweep of
  that generation is not noticed by a read it serves, and the timed pointer refresh moves the read on within
  `cache.genTtlMs`. A store with no timed refresh (`cache.genTtlMs: 0`, or no registry) keeps nothing. There is no new
  option: the limit follows `cache.readerMax` and `cache.readerMaxBytes`.
- **Erasing an id reads its segment in a few range requests rather than one request per chunk.** The rewrite reads
  the generation it rewrites through the reader's coalesced chunk stream: chunks within 256 KiB of each other share one
  range request of at most 1 MiB, still in key order, each chunk checked exactly as before (CRC32C, AEAD with its own
  associated data on an encrypted segment, the payload cap), each range retried on its own under the store's read
  retry. A segment of 2,000 chunks of about 8 KiB takes about 16 range requests to read, where it took 2,000 (expected,
  from a test that counts them); 100 such chunks take 1, where they took 100. What the rewrite writes, how it publishes
  (fenced), the ledger and the receipt are unchanged. The stream holds at most 4 ranges at once, so an erasure holds at
  most 4 × (1 MiB + 28 B) = 4 MiB + 112 B of a segment (`concurrency` times that for `eraseSubject`, 32 MiB + 224 B at the default 8), below the 32 MiB a
  corrupt segment could make the per-chunk path hold; a well-formed segment of chunks of about 8 KiB reads ahead up to
  4 MiB, where the per-chunk path held about 256 KiB. The requests an `eraseSubject` can have open fall to
  `concurrency` × 4, and are ranges.
- **Combines and `iterate` read each operand's chunks as coalesced ranges, so a cold read makes far fewer requests.**
  `intersect`, `union` and `andNot`, their `.batches()` forms, `iterate` and the `*Into` verbs that read them now open one
  stream per operand through `getChunks` (every store the library ships reads through a source that has it), over the
  chunks they need that the chunk cache does not hold. Chunks that sit within 256 KiB of each other are one request, up to
  1 MiB, and each is checked exactly as before. A cold intersect of two segments of about 2,000 chunks that share 100 lying together is
  6 requests (a pointer and a tail read an operand, and one range each) where it was 204; an `andNot` of one such
  segment against ten that share 100 of its chunks is 33 where it was 3,021; an `iterate` of 1,999 chunks is 3 where it was
  2,001. These are counts from running the engine, expected and not measured on a cloud. An `exclude` that waits on an AND of two or more
  includes, `count` and a source with no `getChunks` are read chunk by chunk, and a point read is a stream of one
  chunk.
- **A read of chunks spread over an object reads most of it.** The bytes between two chunks within 256 KiB are read and never
  looked at, so chunks that are spread over a segment can be read in a few requests that together cover most of its
  object. In the bucket's region S3 Standard does not bill the bytes; across regions and to the internet it does, and the
  transfer can cost more than the requests saved. There is no setting for the 256 KiB or the 1 MiB; run readers in the
  bucket's region, and see [the sizing guide](docs/guide/sizing.md#how-much-the-overlap-matters).
- **`concurrency` counts range requests held ahead per operand, not chunk keys.** Its default (32) and its type are
  unchanged, and so is the bound on memory (`concurrency × operands × chunk`: a range is at most the 1 MiB a chunk may be);
  on a source that reads chunk by chunk it still means chunk keys. A combine's stream opens 4 ranges wide and `iterate`'s 1,
  doubling as ranges are taken, so a read that stops early has asked for little past where it stopped, though a range is up
  to 1 MiB where a chunk was a few hundred bytes.
- **A running combine or `iterate` re-resolves its segment where a read of one chunk does.** Before it serves each chunk
  the stream resolves the segment again: a `cache.genTtlMs` boundary after a publish, the reader cache evicting the
  segment, a sweep of its generation or an object replaced under its number, and an invalidation (the store's own
  `load`, `rollback`, `eraseSubject` and `*Into` writes, `dropSegment`, `retireExpired`, and `invalidate()`) each move
  the rest of the read to the generation then current, and the ranges already requested of the earlier one are dropped,
  not served. What a read can yield from the earlier generation is what it had already taken. The unit of read-ahead is
  what changes: up to `concurrency` range requests per operand are held ahead (32 by default), where it was chunk keys.
  A running read holds the reader of the generation it is reading outside `cache.readerMax` and `cache.readerMaxBytes`,
  one per streamed operand, until it ends or moves on.
- **A combine's or `iterate`'s requests for chunks are not shared with another read that needs the same chunks.** Two point
  reads of one chunk still share one request. Two cold combines that need the same chunks each make their own few range requests.
- **`storage.get` is one event per request for chunks**, a range of a combine or `iterate` or the one chunk of a point read,
  its retries included; `bytes` is the range's, gaps between its chunks included, and 0 for one that failed. Every range
  request a read sent is reported, including those still in flight when it stopped, which are billed all the same. The per-op budget still counts chunk reads, which is an
  upper bound on the requests a coalesced read makes.
- **The cost model's `chunksPerIntersect` is the chunk range requests of an intersect**, not the chunks it needs; the field
  keeps its name. `bench/range-counts.cjs` counts them from the engine, and the sizing and cost pages, their charts and the
  calibration harness's expected counts are derived from that. The published measurements of the previous engine stay as
  they were, labelled as its, and the figures for this one are expected until a calibration run measures them.
- **A load starts its existence check and its key unwrap while it encodes, and asks the keystore for a segment's key
  once.** The check that numbers the generation and the unwrap of an encrypted segment's key no longer wait for the
  ids to be bucketed and encoded: they are sent first and joined where the write needs them, so their round trips
  overlap the encoding. A guarded load of an encrypted segment used to unwrap the same key twice, once to read the
  current generation and once to write; it now unwraps once, for that load only (nothing is kept between loads). The
  requests a load makes are the same on success, and so is their order where a fence rests on it: the guard's row read
  comes first, the row a first load or an encrypted segment reads again still comes after the ids, and the publish is
  still fenced on the row the guard judged. What changes is how a failure surfaces: a failed existence check (and its
  listing fallback) is now raised after the ids are consumed, so the encoding's error or the second row read's refusal
  can be raised instead, and a load of an existing encrypted segment asks the keystore for its key even when it then
  fails or is refused (never for a crypto-shredded row). Nothing is written or published in any of these cases, and an
  abandoned check or unwrap leaves no unhandled rejection. A load that throws may have consumed its input, so retry
  with a fresh source.
- **`eraseNamespace` shreds eight segments at a time instead of one.** Each segment keeps its own read and
  compare-and-swap, a fault in one is recorded against it and stops no other, and `destroyed` comes back in the
  listing's order. The `segment.erase` events are now emitted as each segment finishes, so their order is no longer the
  listing's; `namespace.erase` is still last, with the same count.
- **A registry listing reads 48 rows at a time instead of 16** on the S3, GCS and Azure Blob registries. A full scan
  of a large fleet takes about a third of the round trips in sequence; 48 stays under the 50 sockets an SDK client has
  by default. `checkConsistency`'s own default of 8 is unchanged.
- **The erasure of one id looks through the other generations for a holder a few at a time.** The answer is the same as
  the one-at-a-time scan's: the newest holder, and the first fault in newest-first order, with none from past a holder.

### Fixed

- **A GCS read that is refused or let go mid-body no longer prints `MaxListenersExceededWarning`.** A read of a response
  that was still arriving when the driver refused it (an advertised or actual length past the cap) or let it go printed
  "11 error listeners added to [PassThrough]" and the same for `close` on stderr. It was not a leak: the SDK and its HTTP
  layer each run a pipeline over the one response body, which holds eleven or twelve listeners while it is in flight, one
  past Node's default of ten, and every attempt has a body of its own, so the count never grew with retries or reads. The
  limit is raised on that one body, and nothing else.

## [0.14.0] — 2026-10-04

### Added

- **`.batches()` on every streaming read: the same ids, one `Uint32Array` per chunk.** `iterate`, `intersect`, `union`
  and `andNot` (a pinned handle's included) return an `IdStream`, which is still an `AsyncIterable<number>` that
  `for await` reads one id at a time exactly as before (it is still the same single-use generator), and now has `.batches()`, yielding each chunk's ids as one ascending array: the
  same ids in the same order, a range cut at its edges the same way, no empty arrays. It reads the same chunks, charges
  the same budget and stops the same way on `break`; each array is at most 65,536 ids (256 KiB) and is the caller's to
  keep. Measured locally, on an in-memory segment of 10 million ids, the per-id stream ran at about 6 million ids per
  second and `.batches()` at about 90 million; an `andNot` of a tenth of it ran at about 5.7 and 90 million. The per-id
  throughput is unchanged. `CodecBitmap` gains an optional `toUint32Array()`, which the roaring codec implements; a
  codec without it is read through its iterator. See [Read a chunk at a time](docs/guide/reading.md#read-a-chunk-at-a-time-batches).

### Changed

- **The client `S3Storage` builds allows 128 sockets, up from the AWS SDK's default of 50, and a new `maxSockets`
  option sets it.** At the library's default `concurrency` of 32, one two-operand `intersect` keeps up to 64 reads
  open, so the built client queued the library behind its own socket pool; a many-exclude `andNot` ran 23% faster on
  128 sockets (measured locally against a latency-modelled source). `maxSockets` is a positive integer, applies to
  `https` and plain-`http` endpoints alike, and is refused beside `client`, as `region`, `endpoint`, `pathStyle` and
  `credentials` are. Only the socket limit differs from the SDK's own client: its request handler, defaults-mode timeouts,
  keep-alive, retry and the separate connection for a part of 2 MiB or more (`Expect: 100-continue`) are the SDK's, and
  a client you pass is never changed: it keeps its own limit, so raise it there. Release a built client's sockets with
  `store.client.destroy()`. `eraseSubject`'s 256 reads at once need `maxSockets: 256` or a
  lower `concurrency`.

- **The published in-region latencies are now measured on `0.13.0`.** A run from AWS CloudShell in `us-east-1` on
  2026-10-04 measured the wider combine window that the benchmarks page had only derived from a model: a cold
  intersect of two segments sharing 100 chunks took 290.06 ms at the median, and an `andNot` against ten excludes
  3,335.85 ms, with the same requests and the same bill as the previous release's run. The run's rounds sit a fifth to a half above the engine's rounds model, which assumes no socket limit; it did not vary its client's 50 sockets, so it
  does not say why. The README, the
  benchmarks page, the roadmap and the site quote it, and the benchmarks page sets the measurement against the model.

## [0.13.0] — 2026-10-03

### Breaking

- **The default `concurrency` rises from 8 to 32, so a call can have four times as many reads open.** A two-operand
  combine can hold up to 64 open, and `eraseSubject` up to 256 (`concurrency` segments at once, 8 by default, each
  with a window of 32 chunk reads), against the S3 SDK's default of 50 sockets. On S3 the wait for a socket counts
  against `readTimeoutMs`, so a deployment that sets `readTimeoutMs` should raise `maxSockets` (256 covers four
  two-operand combines or one `eraseSubject`) or pass a lower `concurrency`. See the combine and erasure entries under
  `Changed`.

- **The reader refuses, when it opens an object, an index entry longer than the decode cap: 1 MiB, plus 28 bytes when
  encrypted.** One oversized entry makes the whole object unreadable, and a custom codec that raises `maxBitmapBytes`
  above 1 MiB must also set `maxPayloadBytes` on the chunk source. See the payload-cap entry under `Fixed`.

### Changed

- **Concurrent cold reads of one chunk make one storage request.** Callers that missed the cache on the same chunk of
  the same generation at the same time each made their own request: 50 concurrent cold `has()` of one chunk made 50
  GETs, and every caller made one after each publish or cache eviction. They now wait on the one request already
  open, with or without a `cache`, and a failure is delivered to every caller waiting on it (the next call reads
  again). A different generation of the chunk is a different request. `andNot(a, [a])` and any combine that names a
  segment as both include and exclude no longer read each of its chunks twice (6 GETs for 3 chunks, now 3; measured
  locally on the in-memory driver). `store.invalidate(ref)` also forgets the segment's open reads: a caller already
  waiting on one still gets its answer, a call made after the invalidation starts its own read, and the read it
  dropped is not written to the cache. Metrics: one `storage.get` per request; a caller that waits on an open read
  still counts a `cache` miss, so `misses` can exceed the `storage.get` count, which is the number of requests.
- **Erasing an id reads ahead through a window of 32 chunks instead of one at a time.** The erasure rewrite
  (`eraseSubject`, `eraseIdFromSegment`) used to read each chunk of the generation after the one before it, so a
  segment of `n` chunks took `n` request times. It now keeps up to 32 reads open ahead of the writer and takes them in
  key order, so it takes about `n / 32`. Modelled at 26 ms per request, erasing one id from a segment of 50, 200 and
  2,000 chunks takes about 1.4 s, 5.5 s and 54 s before and 0.14 s, 0.27 s and 1.9 s after (modelled, not measured
  on S3). The requests are the same ones as before, so the request count and the cost are unchanged, and the order, the retry
  of each read, the refusal of a chunk that is not decodable or holds a value above 65,535, and the chunk it names
  are as before: each chunk is decoded as the writer reaches it. Memory is bounded by the window, not the segment:
  up to 32 raw chunk payloads are held ahead of the writer, about 8 KiB each for a well-formed segment, and for a corrupt
  object no more than the reader's cap of 1 MiB each, so 32 MiB per segment and `concurrency` × 32 MiB for
  `eraseSubject`. `eraseSubject`, which erases up to `concurrency` segments at once (8 by default),
  can have up to `concurrency × 32` range reads open together, 256 by default.
- **A long combine or `iterate` takes far fewer round trips: the default `concurrency` is 32, up from 8.** The
  default `concurrency` of `intersect`, `union` and `andNot` (and of the `*Into` reads that run through them) is 32
  chunk keys, and so is the most `iterate` and the storage-path `count` read ahead. A read of `n` chunks takes about
  `n / 32` request times in sequence where it took `n / 8`; the requests themselves are the same, apart from the duplicates the first entry removes, so the cost and the
  per-op budget are unchanged. A combine's window opens 8 keys wide (or `concurrency` wide, if that is lower) and
  doubles with each key taken until it is `concurrency` wide, so a combine that stops in its first few keys fetches no
  further ahead than it did, and `concurrency: 8` is the window the previous release had. `iterate` and `count` keep
  their ramp, 1, 2, 4 and on up to 32. The cost is a read that stops early: it has requested up to 32 keys per operand
  past the last one it used, where it had requested up to 8 (a page of 50 ids from an `intersect` is modelled at 66 to
  114 requests, and from `iterate` at 17 to 41). Pass a lower `concurrency` to a combine to bound it. Memory is still
  bounded by `concurrency × operands × chunk`, now 4 times larger by default, and a two-operand combine can hold up to
  64 reads open against the S3 SDK's default of 50 sockets; on S3 the extra wait for a socket counts against `readTimeoutMs`
  (see [production](docs/guide/production.md)). The chunks a read had already requested when its segment re-resolved
  are the earlier generation's: up to 32 for `iterate` and `count`, up to `concurrency` for a combine.
- **`andNot`, and `union` with `exclude`, read an exclude's chunk in the same round trip as the include's.** Where the
  include side cannot come out empty, which is one include or a union, the excludes that hold the key no longer wait
  for the includes. An `intersect` of two or more includes still reads its excludes only after the AND, which may be
  empty, and then no exclude is read. The requests are the same, apart from the duplicates the first entry removes, and each key takes one round trip
  fewer.

  **For the combine entry above and this one, measured on 0.12.0:** `andNot` of a 1,999-chunk segment against ten excludes took 8,687.10 ms at the median, with
  3,021 GETs (1,999 include chunks, 100 shared chunks times ten excludes, and 22 index reads) at a mean of 10.3
  requests in flight. That was bounded by the window of 8 keys, about 250 rounds of about 27 ms, and not by the
  network. **Derived, not measured on S3:** a model with lognormal GET latency (median 26 ms) and 50 sockets, sending
  the same requests, puts the same `andNot` at 13.1 s with a window of 8 and 3.7 s with this release's; `andNot`
  against one opt-out list that holds every chunk at 18.2 s and 3.9 s; an `intersect` sharing 128 chunks at 866 ms and
  338 ms, and 1,000 chunks at 6.3 s and 2.1 s; `iterate` over 1,999 chunks at 10.8 s and 3.6 s. A run in region
  measures the release.

- **The calibration harness models the new window.** The expected depth of a cold intersect is a pointer, a tail and
  then the rounds a window that opens 8 wide and widens to 32 takes, stepped from the engine's constants. A run of
  0.12.0 or earlier is read against the fixed window of 8 it ran with.

### Fixed

- **A chunk too large to decode is refused when the object is opened, not after it is read.** The `.crbm` reader accepted
  an index entry of up to 16 MiB, while every chunk is decoded under a 1 MiB cap, so a corrupt or hostile object could
  make each slot of a read window hold up to 16 MiB that was then refused. The reader's cap is now the decode cap
  (1 MiB), plus the 28 bytes of nonce and tag on an encrypted object, so an entry the decoder would refuse is refused at
  open as an `IntegrityError` naming the chunk and the cap, before any payload is read. What a read window holds for
  such an object is bounded by the window times 1 MiB per operand, where it was the window times 16 MiB. One oversized
  entry now makes the whole object refuse to open: a read or an erasure of another chunk of it fails at open too, and
  `checkConsistency` reports it as an integrity error. No object written by the codec is affected: a chunk it writes
  serializes to at most about 8.2 KiB. A caller who raises `maxBitmapBytes` above 1 MiB (a custom codec) must also set
  `maxPayloadBytes` on the chunk source, or the object is refused at open.

## [0.12.0] — 2026-10-03

### Breaking

- **`CostReport.monthlyUSD.byOp` gains the required `retention`**, so a `CostReport` you build yourself must carry it. It
  is the retention sweep's cost, 0 unless `workload.retirementsPerMonth` or `purgesPerMonth` is set (see `Added`).

- **A registry needs permission to delete under its own prefix: its deletes now remove rows.** Where the backend's
  `conditionalDelete` is on (below), every registry delete of a row created by 0.12, the retention sweep's purge of a
  tombstone among them, is a delete under a precondition, where it was an overwrite with a tombstone: `DeleteObject` on
  S3, an object delete on GCS, Delete Blob on Azure. A policy that lets the backend delete only under the segments'
  prefix makes each such delete fail with the provider's access error: a purge then leaves the row and reports the
  error in its ledger entry, and the due index keeps a pointer it meant to remove. Grant `s3:DeleteObject`,
  `storage.objects.delete` or a role that may delete blobs on `<prefix>registry/`, or set `conditionalDelete: false`
  on the backend to keep writing tombstones. A refused purge does not hold the sweep up: see `purgeFaults`, below.

- **A byte array passed as ids is refused: `store.load` and `loadSegment` throw `ValidationError` for a `Uint8Array`,
  a `Uint8ClampedArray` or a `Buffer` where ids go**, before any request. A byte array is an iterable of numbers, so
  until now each byte was loaded as an id: `store.load(ref, bitmap.serialize('portable'))` published the
  serialization's byte values as the segment, with `published: true`. Pass portable Roaring bytes as
  `{ serialized }` (below), and ids as a `Uint32Array` or an array of numbers; every other typed array is still ids.
  An input that is neither ids nor one of the two bitmap forms now throws `ValidationError` too, where it threw a
  `TypeError` from inside the load.

- **A reader before 0.12 refuses an object written with `metadata`.** A generation that carries metadata has an
  extension block its footer flags (`Added`, below), and a 0.11 reader does not know the flag, so it refuses the object
  rather than read past what it cannot see. A load that passes no `metadata` writes the object it always wrote, which
  every reader opens. Until every process that reads a segment is on 0.12, do not pass `metadata` to it.

- **`CrbmReader.open` refuses a cleartext object when it is given a `crypto`.** It used to ignore the key and read the
  object in the clear. Tooling that passes a `crypto` for every object it opens must pass it only for encrypted ones,
  which an object's footer says (its `FLAG_ENCRYPTED` bit); nothing in the packages, the scripts or the CLI does. See
  the `Fixed` entry on cleartext objects under an encrypted segment for why.

- **Registry rows are schema 2, and there is no going back: stop every 0.11 process before the first 0.12 write.**
  Every row a 0.12 registry writes, whether a create, a compare-and-swap or a tombstone, is stamped
  `schemaVersion: 2`, whatever it holds, and 0.12 reads rows stamped 1 or 2. A 0.11 process refuses a schema-2 row
  with `UnsupportedError`: a load, an `*Into`, a `rollback`, a `setRetention` or a drop of that row throws, and so does
  every `list()` that reaches it, in its namespace and in every unscoped listing, so a single 0.12 write stops each
  0.11 call that lists the registry: `retireExpired`, `eraseSubject`, `subjectReport`, `eraseNamespace`,
  `checkConsistency`, `store.segments()` and the `export-segments` CLI. It fails closed and typed, and never misreads
  a row. Upgrade in this order:
  1. Upgrade the processes that only read to 0.12 first: those that call `count`, `has`, `iterate`, the combines or
     `pin`, and those that list, `store.segments()` and `subjectReport`. 0.12 reads every row 0.11 wrote.
  2. Stop every 0.11 process that writes, runs a retention sweep, erases, checks consistency or exports, then start
     the 0.12 ones. A 0.11 `eraseSubject` cannot complete once a schema-2 row exists in a namespace it lists (every
     namespace, for an unscoped run), so schedule erasure runs around the cut-over.
  3. There is no downgrade. After the first 0.12 write, 0.11 cannot read the registry; the only way back is a
     registry restore to a point before that write (the disaster-recovery guide), which loses every write since.

  Schema 2 adds the record's optional `summary` and the new token form, both below. A row stamped 1 may hold only
  what schema 1 could: a `summary` or a token with a write part on one is an `IntegrityError`.

- **`@cloudbitmaps/s3` needs `@aws-sdk/client-s3` 3.700.0 or later, where it took 3.645.0.** Install it before upgrading if you pin the SDK; the reason is under `Fixed`.

- **A registry token is now `<incarnation>.<counter>.<write>`, and no two writes under a name are given the same
  one.** The incarnation is a 128-bit id as 32 lowercase hex digits, drawn from the platform's Web Crypto when a row
  is created; the counter advances on every write and carries on across a tombstone; the write part is 64 bits as 16
  lowercase hex digits, drawn for every write. Both random parts make the tokens unique with overwhelming probability, where a counter
  alone was not: two incarnations of one name meet with probability 2^-128 for any pair (about n² / 2^129 among n of them), and two writes
  at one counter after a restore with probability 2^-64:
  - once a row's object was gone entirely (a tombstone removed by an object-store delete or a lifecycle rule), a
    re-create restarted its counter at 0 and re-issued the earlier row's tokens. A warm store at the same generation
    took the new row for the old one and kept serving the deleted ids; a publish fenced on a token read from the
    earlier row (`expectToken`, as an erasure rewrite publishes) landed on the new one; and a collection pass over a
    `destroyed` segment, which goes on only while the row's token is unchanged, took the new row for the old one and
    deleted every generation, the new current included;
  - after a registry restore from a backup, a row was back at an older counter, so its next writes were given the
    tokens the writes after the backup had, and a store that skipped the restore's restart served the generation
    the restore took away from its cache.

  A row written before 0.12 keeps its bare decimal token (`"7"`) until its first 0.12 write, which gives it
  `<counter>.<write>`; it gains no incarnation, since only a create starts one. No two of the three forms compare
  equal. The library compares tokens only for equality; code of your own that read a shipped registry's token as a
  number breaks. The in-memory backend's tokens take the same form, its counter still global to the backend.

### Added

- **The cost model prices the retention sweep.** `Workload` gains `retirementsPerMonth`, `purgesPerMonth` and
  `conditionalDelete` (default `true`; a `GcsStorage` reports `false` unless its option is set), and `CostReport.monthlyUSD.byOp` gains `retention`. The requests are the ones a
  store that counts its requests measured, per segment: with the registry's `conditionalDelete` on, a retirement is 9
  reads, 3 writes and a delete, a purge is 4 reads and 2 deletes, and a later sweep reads nothing of a purged segment;
  with it off, a retirement is 8 reads and 3 writes, a purge is 3 reads and a write, and every later full sweep reads
  two objects for each purged segment, which the estimator leaves out, since how often you sweep is yours. Reads are
  priced as GETs, writes as PUT-class requests, and a delete at nothing, as S3 bills none: at the default prices a
  segment retired and purged costs $20.20 per million with the gate on and $24.40 per million with it off. The report's
  notes say what it priced. The cost guide gives both, a sweep at fleet scale, and the cost of
  `checkConsistency({ summaries: true })`, one tail read per segment on top of the listing the default check makes.

- **A cold `count()` is one request, and `seg.stat()` says what the generation is.** The registry row records the
  current generation's id count, so a count reads the pointer and nothing else: no read of the object, cleartext or
  encrypted, and none however wide the index is (an index longer than the 256 KiB tail read took a third request). A
  cold count on S3 and GCS makes 1 request where it made 2, and on Azure Blob 1 where it made 4 (derived from the
  driver ports, held by a test that counts them; one wire request on each emulator in the integration lane). Within
  `cache.genTtlMs` it makes none, and a refresh that finds the same generation under a changed row (a `setRetention`)
  costs it no re-open. `seg.stat()` returns `{ generation, cardinality, metadata? }` from the same resolution:
  the generation's number, its id count and the metadata it was loaded with, one request when cold and none when warm
  or pinned (`pin().stat()`), and `{ generation: null, cardinality: 0 }` for a segment with no generation. The current
  entry of `store.generations(ref)` carries `cardinality` and `metadata` from the row it already reads, with no extra
  request (an encrypted segment's need a keystore that opens its key), and the other entries carry only their number.
  A snapshot is now a resolved target with a reader opened on first use, so a `count` and the `has` after it read one
  generation. **What a count trusts:** the row's summary, used only for the generation it names, on an active row, in the
  shape the keys call for (a sealed one only if it opens under that generation's associated data), with
  `requireEncryption` applied as it is to a read. It is not confirmed on the cold path, so a party who can write the
  registry row can make a count wrong, as they can already repoint the generation. Whenever a read opens the object
  anyway (a `has`, an `iterate`, a combine, a `pin()`), the store holds the row's count and metadata against the object
  at no extra request; a disagreement, including a row with metadata over an object with none, stops that store using
  that row's summary for that generation, and fails no read. A row with no summary it can use (written before rows
  carried one, naming another generation, or sealed and not opening) sends the count to the index as before, with the
  tail read. `checkConsistency({ summaries: true })` opens each current object (one tail read each) and reports
  `summary-mismatch` where a row's summary disagrees with it; a sealed summary needs the store's keystore, and is counted
  in `summariesUnchecked` without one. The default check lists only, as before. The cost model, calibration
  expectations and the benchmark and cost pages state a cold count as one pointer read.

- **`load` and the `*Into` verbs take `metadata`: a small record of your own, written with the generation and with the
  pointer.** A flat object of string keys and string or finite-number values, at most 1,024 bytes as canonical JSON
  and no key over 128 bytes: the record a definition's version, a landing time or a run id fits in. A record that
  breaks a rule is a `ValidationError` before the load makes a request (nothing is read, nothing written), on a load of
  ids, a load of a bitmap and each `*Into`; `undefined` and `{}` store nothing and write the object a load without
  metadata writes. The record is copied when you call, so what is stored is what you passed whatever the load's id
  source takes to run. It goes into the generation's object, and the write that moves the pointer carries the row's
  summary of the generation, its id count and the metadata, in the same compare-and-swap, so a reader that sees
  generation N as current sees N's metadata. It never changes: a new generation is how it does, and a load does not
  inherit the last one's. A rollback writes its target's own into the row. It makes the one tail read it already makes to check the target (and
  a range read when the index is longer than that read), and that read now also opens the target's index and metadata
  when the store has the segment's key: a target whose index or metadata does not open is refused, where only a footer
  that failed its own checks was. An encrypted target on a store with no keystore, or whose key it cannot open for any
  reason (an unreachable key service included), still rolls back and leaves the row with no summary. The undo of a rollback whose
  target was collected meanwhile puts back the summary the old row had, and an `allowForward` rollback re-reads its
  target after the swap and puts the pointer back, with `NotFoundError`, when an erasure and a load replaced the object
  under that number in between. An erasure's rewrite carries the source's
  metadata into the new object as it is, and the row's summary of it, built from what was written, counts one id fewer;
  it does not scan the metadata, so never put a subject's id in it. On an encrypted segment, a source with no metadata
  block whose row's sealed summary has metadata is rewritten with the row's, since the block's presence is not
  authenticated and the summary is; the erasure still goes through. A crypto-shred and a drop clear the summary, and a
  retention policy or a sweep that finds a segment not yet due leaves it. On an encrypted segment the object's block
  and the row's summary are sealed, the summary as a fixed-width 64-bit count then the metadata, bound to its
  namespace, segment and generation under a scope of its own, so its length reveals only the metadata's size and a copy
  moved to another generation's row does not open. Whether an encrypted object has the block is still not
  authenticated, and the row's sealed summary is the copy that says there was one. `LoadOptions.metadata`,
  `MaterializeOptions.metadata`; `GenerationListDeps.keystore` for `rollbackSegment`. `seg.stat()` and the current entry of `store.generations()`
  read the metadata back (see the entry on a cold `count()`).

- **The due index carries a pointer to each retirement's tombstone, so `scan: 'index'` purges as well as retires, on a
  registry that reports `conditionalDelete`.** A retirement files it under the day the tombstone's grace ends, its
  stamp plus `tombstoneGraceMs`; no field of the row records that day. An index scan reads it back with the expiry
  pointers and hands the row to the same purge the fleet scan runs, which removes every pointer it read to the row,
  once the row is gone, and never after a delete whose outcome is unknown. A registry that only tombstones files none,
  since nothing it purges is removed for good: there the fleet scan purges, and what a retirement and a purge cost is
  what it was. Per segment, counted with a store that counts requests: a retirement is 9 reads, 3 writes and a delete
  with the pointer where it was 8 reads and 3 writes (one read and one delete more), and a purge is 4 reads and 2
  deletes where it was 3 reads and a write (one read and two deletes more, a write fewer). On S3 a delete is not
  billed and a tombstone's write is.

- **`RegCaps.conditionalDelete`, and a `conditionalDelete` option on `S3Storage`, `GcsStorage` and
  `AzureBlobStorage` and their registry drivers.** `true` says a registry's `delete` removes a row from its backend for
  good, only while the row is still the version the delete read, so a full `list` no longer reads it; `false` or
  absent, every delete leaves a tombstone. The cloud registries remove a row with `DeleteObject` under `If-Match` (sent
  once, as a registry write is), a GCS delete under `ifGenerationMatch`, and Delete Blob under `ifMatch`, each set to the
  version the registry read; a precondition that no longer holds, or an object already gone, is a
  `WriteConflictError`, and the registry re-reads. The option defaults to `true` for Azure Blob and for an S3 client whose resolved host is an
  AWS S3 host, and to `false` for GCS, the public endpoint included, and for an S3 client that sends anywhere else.
  GCS is off because no run against real GCS has verified that it applies `ifGenerationMatch` to a delete; set `true`
  to remove rows for good. MinIO and fake-gcs-server accept the precondition on a delete and ignore it, and on such a
  store two sweepers and a re-create of the name could delete a live row. The S3 host is the one the SDK
  resolves, so an endpoint set by `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` or an `endpoint_url` in the shared config
  file counts as a constructor `endpoint` does, and an AWS regional, FIPS, dual-stack or VPC interface host is AWS. It is
  read from the client once, before the registry's first request, without sending one; until then
  `capabilities().conditionalDelete` reads `false` unless the option is set. A value that is not a boolean is refused with
  `ValidationError`. The in-memory and local-filesystem registries report `true`. For driver authors,
  `ObjectRegistryStore` may implement `delete(key, { version })` and set `conditionalDelete: true` to say its backend
  applies the precondition; with both, `ObjectStoreRegistry` removes rows rather than tombstoning them. Real S3 refuses a stale
  precondition: `tests/integration/real-cloud-conditional-delete.test.ts` passed against AWS S3 on 2026-10-03, on an
  unversioned and a versioned bucket. The same probe has not been run against real GCS, which is why GCS is off by
  default; it is skipped unless a bucket is named.

- **`readTimeoutMs` on `GcsStorage` cuts off a GCS read that stalls; it is off unless you set it.** A client's own
  `timeout` does not bound a download on `@google-cloud/storage` 8.x, so a read whose server stops answering waited
  for it forever. With `readTimeoutMs` set, one deadline bounds each read as a whole (a generation's tail with the
  metadata read it falls back on for an empty object, a range of it, a registry row): every attempt the driver makes
  and the backoff between them, timed from the call into the driver, so a credential fetch counts, to the end of the
  body, so a stall after the headers is cut off too. When it passes, the read throws `TransientError` naming the read
  and the timeout and no further attempt starts; the store's read retry runs it again, so at `2_000` a read that stalls
  on every attempt fails after about 8.35 s (measured: 8.1 to 8.2 s). It counts time the process spends busy, so a
  synchronous stretch longer than the timeout fails the reads in flight. Uploads, deletes, listings and the
  conditional writes are not timed. `0`, the default, sets no timeout; a value that is not a non-negative safe integer
  no larger than 2,147,483,647 is refused with `ValidationError`. The SDK cannot cancel a request whose response has
  not begun, so a read that times out before its server answers leaves that connection open until the server answers
  or closes it: one per read, up to four per call through the store's retry (on 7.x, checked on 7.22.0, a read cut off
  after its response began keeps its connection open too). A 404 whose error body arrives after the deadline is a
  `TransientError`, not `NotFoundError`. The GCS storage and registry drivers take the option too.

- **`LoadDeps.collectByListing` makes `loadSegment` collect by listing whatever `keep` is.** Absent, a load that numbered
  its generation with one existence check and keeps at most one generation deletes by name the one generation its
  publish pushed out of the window (see Changed). Set, it lists the segment's objects after its publish instead and
  deletes every generation below the new one beyond `keep`, as every load did. The `*Into` verbs set it, because their
  `keep` is how an operator clears a destination that earlier materialisations kept in full. `store.load` does not
  take it: its options are unchanged.

- **A load takes a bitmap as well as ids: `store.load(ref, { bitmap })` and `store.load(ref, { serialized })`.**
  `{ bitmap }` is anything with `serialize('portable')`, such as `roaring`'s `RoaringBitmap32`, and is loaded as
  `{ serialized: bitmap.serialize('portable') }`, serialized once at the call, so changing the bitmap afterwards does
  not change what is loaded. `{ serialized }` is one 32-bit bitmap in the portable Roaring format, the one the
  `'roaring'` export writes. A bare `RoaringBitmap32` from the `roaring` this package uses, passed where ids go, is
  loaded the same way.

  Every bitmap input takes one path, all of it before the load's first request: the bytes are capped at
  537,403,396 (more than any canonical 32-bit bitmap serializes to), must hold exactly one bitmap, are checked
  structurally the way every stored chunk is, and are decoded by the safe deserializer. Malformed or oversized
  bytes, and bytes after the bitmap's end (two serializations concatenated, say), throw `ValidationError`, and
  nothing is read or written. The bytes are read through the typed array's own accessors, and a
  `SharedArrayBuffer`'s are copied first; a `{ bitmap }` that can report its size is refused over the cap before it
  serializes.

  The chunks are then cut from the bitmap's own containers, per container and per byte and never per id, and the
  generation is byte for byte the one the same ids write. A golden object written by the id path before this change
  is reproduced by every input; a property test and a fixed corpus (run containers of 2 to 2,048 runs, the run
  cookie at 65,536 containers) hold it over every container shape; and every existing test file that calls a load
  runs a second time with its loads handed `{ serialized }`, the segments it seeds through the fixture loader included,
  except the few that depend on when a load reads its ids (they inject races from inside the id stream, or count
  the id path's own yields). Every guarantee of an id load holds: write-once, the fenced publish, `guard`, `keep`,
  the empty refusal, encryption and the same `LoadResult`.

  A test counts the per-id routes during a 12M-member load from a bitmap (iteration, building from values, the id
  split) and finds none. Two whole-bitmap steps do not yield, each for a time that grows with the bytes: the input
  check and the native decode at the call, and the re-encode before the write; at the cap they take about 400 ms or
  more and about 250 ms (derived: twice a 256 MiB load of bitsets on an Apple M3 Pro). Around and after them the
  load yields the event loop, and every 1,024 containers while it writes. As it writes, it checks every container
  of the bitmap again, so a buffer another thread was still writing during the call (an unfinished `fs.read` into
  it, say), which can decode into bytes the first check never saw, throws `IntegrityError` and publishes nothing.
  `pnpm bench:load-input` measures the time, and its figures are not recorded yet. `loadSegment` takes the same
  inputs (the trailing-byte refusal with a codec that honours `whole`, below); `LoadInput` and `PortableBitmap` are
  the new types.

  **For a codec author**, `CodecBitmap.encodeChunks?()` and `EncodedChunk`: a codec that implements it hands a load
  its chunks as stored bytes, ascending, each exactly what `fromValues` of that chunk's low 16 bits, `optimize()` and
  `serialize()` give, which is how a bitmap load writes without touching an id. Optional: a codec without it loads a
  bitmap input through its ids. The roaring codec implements it. `CodecInterface.safeDeserialize` takes an optional
  third argument, `{ whole }`, which a load passes for a caller's bytes: a codec must then refuse bytes after the
  bitmap's end, since core cannot read the format, and one that ignores the option loads two concatenated bitmaps
  as the first of them. A codec with the two-argument signature still type-checks.

- **A `.crbm` generation can carry its metadata, in an extension block its footer flags.** The format stays 1.0. A
  generation written with metadata gets one extension block between its last payload and its index, and its footer
  sets a new flag bit, `FLAG_EXTENSION` (`1 << 3`); the block is found from a 12-byte trailer just before the index
  (the sections' length, their CRC32C, and `CRBX`), and holds typed sections of a u32 length each.
  Section 1 is the metadata's canonical JSON, at most 1 KiB, by the same rules and in the same form as a registry
  summary's (`GenerationMetadata`): RFC 8785 for a flat object of strings and finite numbers, with vectors in
  `tests/golden/metadata-canonical.json`, RFC 8785 Appendix B's number samples among them, for other languages to
  check against. On an encrypted segment its content is
  sealed under the segment's key like the index, bound to its namespace, segment and generation; that the block is
  there is not, so whoever can write the object can remove it. A generation without metadata is written byte for
  byte as before, flag clear, so every object written so far, and every one written without metadata, is unchanged.
  A reader before 0.12 does not know the flag and refuses an object with metadata (see `Breaking`). This build reads the block in the request that reads the index (one more only when the tail read ends
  inside the block). It refuses with `IntegrityError` a block whose
  trailer, CRC, 4 KiB cap or sections do not hold, metadata that breaks a rule or is not exactly its canonical form,
  a flag with no valid block, and a payload that runs into the block, and it skips a section type it does not know,
  so a later build can add one. The reader cache's byte bound (`cache.readerMaxBytes`) counts a reader's metadata with its index. For
  tooling: `CrbmReader`'s `metadata` is the generation's metadata, and `aadFor` takes the scope `'metadata'`; a
  `CrbmCrypto` of your own must map that scope as `aadFor` does to open an encrypted object with metadata. `load` and the
  `*Into` verbs take a `metadata` option that writes it (above).

- **A registry record can carry a `summary` of its current generation** (`RegistryRecord.summary`, for driver
  authors). In the clear on a cleartext segment, `{ generation, cardinality, metadata? }`, with `cardinality` an
  integer from 0 to 2^32 and `metadata` string keys to string or finite-number values, at most 1 KiB as canonical
  JSON (`GenerationMetadata`); sealed on an encrypted one, `{ generation, sealed }`, base64 of a nonce, the count
  sealed as a fixed-width u64 with the metadata after it, and a tag, so its length reveals only the metadata's size.
  Each shape is checked at both registry boundaries: `ValidationError` on a write, `IntegrityError` naming the row
  on a read. It names the generation it describes and follows the pointer and the keys: a patch that moves
  `currentGen`, or changes `wrappedDeks` so the shape no longer agrees, without mentioning it drops the old one, and
  one a write gives must name the `currentGen` and agree with the keys (sealed with wrapped keys, clear without) the
  row will have. A stored row that disagrees is still read, so one such row cannot stop every listing, and whatever
  reads the summary must not use it then. The registry stores a frozen copy of the summary it was called with. A
  crypto-shred clears it. Every write that moves a pointer writes one, a load's guard and a cold `count()` read it, and a row
  without one is correct and is read from its object. Every
  shipped registry round-trips it, and the registry conformance suite now requires a driver of your own to as well.
  Types: `RegistrySummary`, `ClearRegistrySummary`, `SealedRegistrySummary`, `GenerationMetadata`.

- **`Entropy`, the seam a registry draws its tokens' random parts from** (`(length) => Uint8Array`, from
  `@cloudbitmaps/core`). `ObjectStoreRegistry` takes one as an optional fourth constructor argument and defaults to
  Web Crypto. It is not the `Rng` seam, which is seedable for simulation: a seeded source hands every process the
  same ids. Inject one only to make a test replayable. On a runtime with no Web Crypto a shipped registry still
  reads and refuses every write with `UnsupportedError`.

- **`RegCaps.canWrite`, an optional registry capability: `false` says the registry cannot write.** Absent means
  writable, so an existing driver is unchanged. A shipped registry reports `false` on a runtime with no Web Crypto,
  and a registry of your own may report it the same way. A load and an erasure rewrite check it before their first
  request, so they refuse with `UnsupportedError` before they write an object.

- **`AzureBlobStorage` can time each read: `readTimeoutMs`, off unless set.** With it set, every read request the
  Azure Blob storage and registry drivers send, a range read, a tail read's properties and its ranged download, each
  on its own, and a registry row's read, has `readTimeoutMs` to finish, the response body included, or it is aborted
  and throws `TransientError` ("Azure Blob download timed out after 2000 ms"), which the store's read retry runs
  again. No client setting bounds an Azure read whose body stalls: the SDK's per-try timer stops at the response
  headers. The timer starts at the call into the SDK, so waiting for a socket or a credential's token counts; the
  HTTP agent the SDK builds sets no socket limit. Writes, block commits, deletes and listings are not timed. `0`, the
  default, turns it off, and a value that is not an integer from 0 to 2,147,483,647 is refused with
  `ValidationError`. The drivers take it too (`AzureBlobStorageDriver`, `AzureBlobRegistryDriver`). The SDK's default
  retry waits 4 s before its second retry of a 500 or 503, so a timeout below that cuts it off, and the read throws the
  timeout instead of the 503 for the store's retry to run again. Tests run a real `@azure/storage-blob` client against
  a stub that stalls before the headers, after them and mid-body, and a child process checks that a read leaves no
  timer behind.

- **`S3Storage` can time each read: `readTimeoutMs`, off unless you set it.** The default is `0`, no timeout, until
  in-region measurements justify one. Set, it bounds every `GetObject` and `HeadObject` the S3 storage and registry
  drivers send, from the moment the read is handed to the SDK until its body is read: a read still running after that
  many ms is aborted, which releases its connection, and throws `TransientError` ("S3 GetObject timed out after
  N ms"), which the store's read retry runs again. The AWS SDK sets no timeout by default, so an untimed read on a
  connection that stops answering waits as long as the connection stays open. The clock counts the time a read waits
  for one of the client's sockets (50 by default) and the time spent fetching credentials, and under
  `retryMode: 'adaptive'` the SDK's rate-limiter wait, so a burst of concurrent reads larger than the socket pool can
  time out with nothing slow on the wire: against a local stub answering each request in 50 ms, 8,000 concurrent
  `has()` calls with `readTimeoutMs: 2_000` lost most of their reads. Size it above the worst queueing your concurrency
  implies, or raise `maxSockets`. AWS's S3 guidance is to retry a GET of under 512 KB after about 2 seconds; with
  `readTimeoutMs: 2_000` and the store's default retry, a read whose request stalls on every attempt fails after about
  8.35 s (4 × 2,000 ms plus up to 350 ms of backoff, derived rather than measured). Writes, multipart uploads, deletes
  and listings are never timed, and a `client` you pass gets the timeout without being changed. A value that is not
  an integer from 0 to 2,147,483,647 is refused with `ValidationError` (a longer Node timer fires after 1 ms).

- **`PricingProfile.storage.requestsPerPointerRead` prices a pointer read apart from a tail read.** It is the requests
  one pointer read costs, 1 by default, and the cost model charges it for each operand of an intersection, for the
  pointer reads a load makes and for each pointer refresh. `requestsPerSizedRead` keeps its name and its default
  of 1, and now prices tail reads only: each operand's index read, since a load reads no index of its own. A pointer read is one
  request on S3, GCS and Azure Blob alike, so every shipped backend leaves `requestsPerPointerRead` at 1; S3 and GCS
  leave `requestsPerSizedRead` at 1 too, and an Azure Blob profile sets `requestsPerSizedRead: 2`, for its two-request
  tail read. An Azure profile that already sets `requestsPerSizedRead: 2` is priced one request lower for each pointer
  read, which is what an Azure pointer read now costs. A value that is not a finite number of at least 0 is refused
  with `ValidationError`, as `requestsPerSizedRead` is.

### Changed

- **A cold `count()` of a torn restore answers instead of throwing.** A segment whose pointer names an object that is
  gone (a registry restored ahead of its bucket, or an object a lifecycle rule removed) counts the number its row
  records, which is true of the generation the row names, where the count opened the object and threw `NotFoundError`.
  A `has`, an `iterate` or a combine still throws, so a count alone no longer shows the tear: `checkConsistency()` is
  what finds it. `exists()` and `count()` say so in their documentation, as the disaster-recovery guide does.

- **A steady `store.load()` is 8 requests, where 0.11.2 made 14.** A load reads its segment's row once, checks that its
  next generation number is free instead of listing for it, sizes the current generation from the row's summary
  instead of reading its index, and deletes by name the one generation its publish pushed out of the window, listing
  only on every 16th generation.
  - *The row is read once.* A load read its registry row four times before its publish. On a cleartext segment it now
    reads it once, and the guard, the generation number, the write's refusal of a `destroyed` segment, and the
    publish's first attempt all decide from that read. The publish is fenced on that row, on its token, on the pointer
    a guarded load judged, or on its absence, so a row that changes in between makes the publish lose rather than land
    on the stale read. A load that found no row, or found an encrypted one, reads it again after its ids and before its
    write, so a first load still sees a row another writer created meanwhile, and an encrypted segment's key is
    unwrapped only from a row read after the ids.
  - *The number is checked, not listed.* It is `currentGen + 1` when one existence check finds no object holding it (a
    zero-byte tail read: `HeadObject` on S3, the object's metadata on GCS, the blob's properties on Azure Blob, one
    request on each). When the check meets an object, such as a crashed load's or the generations a rollback left
    above the pointer, or cannot answer (silently: nothing records it), the load lists the segment and numbers above
    everything in it. A load can therefore take a number below an object above the pointer, never one an object holds.
  - *The guard's size comes from the row.* The guard needs how many ids the segment holds, and a row that carries a
    summary for the generation it names gives it that, so the load opens no object for it. A row with none (one
    written before rows carried it, a summary that names another generation, or a sealed one that does not open) is
    read from the object's index, and its next load writes a summary. A load that takes the size from the summary also
    opens nothing to learn that the current object is gone from the bucket, which is how it would find a segment whose
    object a lifecycle rule or a partial restore removed, so a load with a `keep` of 1 that is about to delete by name
    looks for the current object first with one zero-byte read (the check it already makes that the next number is
    free) and lists unless it finds it. A load with a `keep` of 0 deletes the generation it supersedes, which is the
    one in question, and a load that lists anyway, one the guard refuses or one with no guard makes no such look. A row
    that names an object that is gone still remembers the size, so a repair load is judged against it, and a repair
    smaller than `guard.minRetained` allows is refused. Repair without `minRetained`: `allowEmpty: true` does not lift
    it. A guarded load over a current object that is present but corrupt, whose row has a summary, does not fail at the
    guard, which does not open it: the look for the object proves it is there, not that it is intact, and a read of it
    still fails closed.
  - *Collection is by name.* A load that numbered its generation with one existence check, which found it free, and
    keeps at most one generation, the default `keep: 1` or 0, deletes `generation - keep - 1` after re-reading the
    row, and lists nothing. It lists the segment on every generation divisible by 16, whenever the check met an object
    above the pointer or could not answer, whenever the current generation's object was found gone, and whenever
    `keep` is 2 or more: a window of 2 or more counts the generations that are in the bucket, which a name cannot
    know, since a refused load leaves a gap and deleting by name would take a generation the window promised to keep.
    What the name-only loads leave behind is collected by the listing within 16 generations: the generations an
    earlier, wider `keep` held, an object a refused load left below the pointer, a generation a rollback or an erasure
    stranded. The count is of generation numbers, so a rollback starts it again from the generation it moves to. A
    fault can break the premise that the object the row named is in the bucket (a lifecycle rule or a partial restore
    removing it, or an erasure deleting the object of a load whose publish then landed), and the load that repairs the
    segment lists, and keeps the older generation. A load with `allowEmpty` and no `minRetained` looks at nothing,
    cannot tell, and deletes that older generation by name.

    The safety rules are the listing pass's. The row is re-read before the delete. A row that is gone, or a pointer
    that has fallen below the generation the load published (a rollback, or a name purged and re-created that has not
    loaded as far), deletes nothing and returns `collected: []`: the publish already landed, so the load returns as
    published. A fault, a registry read or a delete that throws, still rejects the load, after its publish landed and
    with the pointer at the published generation. The generation deleted is always below the one published, so the
    current generation is never touched. `LoadResult.collected` names the generation deleted by name, which may have
    been gone already: a delete of an absent object succeeds on every backend and says nothing, so the list is not a
    receipt, as a listing's is not either. Two things to know. A destination that `*Into` calls fed with the default
    `keep`, which keeps every generation, and that `store.load` then loads, no longer has everything below the load's
    pointer collected by that load: it deletes one generation, and the rest go at the destination's next generation
    divisible by 16. An `*Into` given a `keep` still lists the destination and clears every generation below the new
    one beyond it, however many earlier calls kept. And a `keep` at least the generation published collects nothing
    and asks for nothing, so a default `*Into` makes no collection request.

  Counts, measured against MinIO and counted at the driver ports (GCS and Azure Blob make the same requests; 0.11.2 made more on Azure Blob, where its pointer reads and tail read were two requests each; a check
  being one request on each, derived from their drivers, which delete an absent object without failing as S3 does): a
  steady single-part load on S3 is 2 PUT-class requests (the object, the row), 5 GET-class (three row reads, the check
  that the next number is free, and the check that the current object is there) and a delete, 8 requests, where 0.11.2
  made 4, 9 and a delete, 14. A segment's first load is 2 and 4 and deletes nothing, where it made 4 and 7, and its
  second is 2 and 3, where it made 4 and 8. A load on every 16th generation lists, and is 3 and 6. `costReport()` and
  `estimateCost()` price a load at those counts, averaged over the cadence, the checks at one request on every backend
  whatever `requestsPerPointerRead` and `requestsPerSizedRead` say: $12.34 per million steady single-part loads at the
  default prices, where it was $23.60, which is $12.00 when a load does not list and $17.40 when it lists (every 16th
  generation), and $11.60 for a segment's first load, where it was $22.80, and $11.20 for its second. The average has
  a sixteenth of a listing and two pointer reads, less a check, a load in it. `requestsPerSizedRead` no longer prices
  a load. An encrypted segment's load reads its row once more, which the cost model leaves out: it prices a cleartext
  segment's load, as its docs say. Collection by name relies on a delete of an absent key succeeding without touching
  its neighbours, so the storage conformance suite gains a case that holds every driver to it (`'delete of an absent
  key beside its neighbours'`, a new member of the exported `StorageDriverCase`), and holds a driver's zero-byte tail
  read of a missing object to `NotFoundError`, as the port documents for every tail read.

  What else moves with it:
  - **A drop or a shred that lands while a load is consuming its ids.** A load that read a present cleartext row
    before a `dropSegment` (or a retention sweep's drop) now writes its object, is refused at the publish
    (`published: false`, `reason: 'superseded'`) and deletes that object itself, since every generation of a
    `destroyed` segment is garbage; it threw `ValidationError` before writing. Only a load whose process stops
    between its write and its refusal, or whose publish fails without a definite answer (a lost response, a
    timeout), leaves the object behind, for a re-run of the drop. An encrypted segment, or a load that found no row,
    is refused with `ValidationError` before it writes, as before. An `*Into` whose destination is dropped while it
    runs now throws `WriteConflictError` ("Re-read the destination and re-run"), where it threw `ValidationError`; a
    re-run gets the `ValidationError`.
  - **A cleartext write is never published onto an encrypted row.** A load with no keystore that wrote cleartext
    while another writer created the segment encrypted is refused at its publish with `KeyUnavailableError` and told
    to re-run with the keystore; a keystore load that mints a key while another writer publishes first is refused with
    `ValidationError`, whose message says to re-run the write, which then uses the segment's key. Nor does a cleartext
    object stay in an encrypted segment's bucket: a definite refusal (a guard, a `false` from the fenced publish, or a
    refusal the publish throws) deletes the load's object when the fresh row carries key material and the load wrote
    cleartext, once the object's footer proves it the load's own (a re-created incarnation can have written its own
    object under the same number), as when a cleartext segment is dropped, purged and re-created encrypted while a
    load streams its ids. A thrown refusal reclaims the object on the same terms as a `false` one; a transient fault,
    which may still land, leaves it.
  - **A number whose object was deleted can be taken again.** A refused load's number could be, and a number an
    erasure freed with nothing above it; now a load also numbers under an object that survives above the pointer,
    after an erasure of the generations above a rolled-back pointer or a collection pass that stopped part-way. A live
    reader that still holds the old object's index used to fail such a read with `IntegrityError`; on an
    `IntegrityError` or a range `ValidationError` it now reads the object's footer, as a pin does, and when the object
    is another one, or gone, it re-reads the segment and answers from the new object. Caches key on the number and the
    row's token, and pins on the object's fingerprint.
  - **Disaster recovery.** After a registry restore, re-running the load takes the number after the restored pointer
    while no object holds it, so the first re-runs can number below the generations published after the restore point
    and leave them above the pointer until a load's check meets one; the guide says to load until the pointer is above
    them. The re-runs below the strays count toward `keep` too, so keeping the restored generation as a rollback
    target takes a `keep` of at least the highest stray minus the restored pointer, plus one. A re-run load takes again
    the numbers collection freed, but its writes are given tokens the row never had, so no cache takes a re-run's
    generation for an earlier one under the same number; step 9's restart or invalidation of every store moves a store
    that read the segment before the disaster onto the restored generation without waiting for its refresh.
  - **The calibration harness** expects each load's counts: 2 PUT-class and 4 GET-class requests for a segment's first
    load, 2 and 3 for a reload, 3 and 6 for a load that lists, and its rehearsal fixtures are re-captured. Its
    projection of a load's GET-class requests is `5 + 2 × retryBound`, since a load whose check meets an object still
    reads the pointer before and after its listing and before its delete. The default workload's expected bill falls
    from 183 PUT-class and 92,948 GET-class requests, $0.038094, to 101 and 92,825, $0.037635.

- **`retireExpired` counts the deletes the registry refuses, and a refused purge no longer holds the retirements behind
  it.** `RetireExpiredResult` gains `purgeFaults`, the number of purges and due-index pointer removals refused for a
  reason other than a lost race (a policy that denies delete, an Azure blob with a snapshot, which answers `409
  SnapshotsPresent`, any raw provider error), and `firstPurgeFault`, the first one's ledger reason. A refused purge was
  charged to `limit`, so with `limit` or more stuck tombstones ahead of them in scan order every call spent its whole
  budget on purges that could not succeed and no expired segment was retired; one refused purge now costs nothing
  against `limit`, and retirements go on. Purging stops for the rest of the call after three refused purges in a row, and
  a purge that succeeds starts the count again, so a blanket refusal costs three attempts a call and a refusal particular
  to one row holds nothing behind it. Its ledger entry stays `skipped`, with the provider's message, and the next call
  tries again. A pointer removal the registry refuses is counted too, where it left no trace. A lost race (`failed: contended`) is not a fault, and is charged to
  `limit` as before.

- **The retention sweep removes a due-index pointer whose segment has no row**, where an index scan skipped it on every
  scan that read its day and a fleet scan never could. An index scan removes it from the days it reads. An **unscoped**
  fleet scan (no `namespace`) now keeps the pointers its listing already reads, and removes a pointer to nothing from
  every day, and the purge removes every pointer it read to the row: a pointer survives a purge that ran with another
  `tombstoneGraceMs` than the sweep that filed it, a delete that landed and lost its response, and a day older than
  `lookbackBuckets`, and its key spells out the namespace and segment name. A removal re-reads the segment, is fenced
  on the pointer's token, covers the sweep's own shards, never runs under `dryRun`, and is bounded: at most `limit`
  pointers per call, each costing four reads and a delete from an index scan (the listing's read of the pointer
  included) and two reads and a delete beyond the listing's from a fleet scan. A scan limited to a `namespace` lists no
  pointers and removes none. A registry that only tombstones does none of this, since a removed pointer would stay as a
  tombstone every scan reads.

- **The retention sweep's purge removes a tombstone's row for good, where the registry reports
  `conditionalDelete`.** It rewrote the row as a tombstone that every later full listing read, so a sweep of a
  namespace that churns short-lived segments made one registry read for every name the namespace had ever held. It
  now makes one for each segment that is live or inside its grace: after 10,000 segments are created, retired and
  purged, a namespace-scoped or unscoped sweep makes one registry read, for the one live row, where it made 10,001 or
  20,001. The delete is fenced on the token the purge judged and applied by the store only to the version it read, so
  a write or a re-create of the name that lands first makes it fail (`failed: contended` in the ledger) and leaves the
  newer row. A row written by a release before 0.12 is still tombstoned: its token is a bare counter, and a process on
  that release re-creating the name over nothing would issue those counters again. Tombstones already in a bucket
  stay. Every registry `delete` follows the same rule, so a due-index pointer a retirement or a `setRetention` removes
  is removed for good too. The local-filesystem registry unlinks the row of one born with an incarnation id, under
  the row's lock, and tombstones one a release before 0.12 wrote. A purge costs 4 reads and 2 deletes, and each later
  sweep reads nothing of a purged segment; with the gate off, a purge rewrites the row as a tombstone.

- **A write-once object that S3 or GCS throttles is sent again, and a registry write that gets no answer is settled by
  reading the row, and sent again from it if nothing changed.** A load that met a throttle on its object, or a response
  lost on its row, failed with `TransientError`, and a failure on the row left the caller guessing whether it had landed.
  Now:
  - *The object.* The S3 driver sends the write-once `PutObject`, or a multipart upload's `CompleteMultipartUpload`, again
    after a `503 SlowDown` (or any `503`), and the GCS driver sends a single-request upload again after a `429` or
    `503`: up to three more times, after a random wait under 500 ms, then 1 s, then 2 s. A lost response, a timeout and a
    `500` are not sent again. Every S3 object now carries a random id in its user metadata (`x-amz-meta-cbwid`, set when a
    multipart upload starts), and every GCS single-request upload carries one in its custom metadata, as a resumable
    upload always has: a service does not promise that a request it throttled was not applied, so a precondition
    failure on a re-send (or, for a completion, a `409` or an upload S3 no longer knows) reads the object back with one
    request, and an object with this write's own id is a success, while any other, or one with no id, is a
    `WriteConflictError`, as a collision always was. With nothing stored, a `409` or an unknown upload is an unknown
    outcome, a `TransientError`: the first send may still be applying. Throttled on every send, the write throws
    `TransientError`, and nothing is deleted; a multipart upload is aborted, which never tears an object, since S3
    completes an upload atomically. Azure Blob is unchanged: its client already sends a write again after a
    `503 ServerBusy` or a `500 OperationTimedOut`, and every write's id tells its replay apart. The in-memory and
    local-filesystem drivers have nothing to throttle. A bare `429`, which AWS S3 does not send but some S3-compatible
    services do, is not retried and is not classified transient on S3: it surfaces as the SDK's own error.
  - *The row.* The drivers still send each row write once. When a `create` or compare-and-swap ends without an answer (a
    throttle, a lost response, a timeout), the publish reads the row once and decides. A pointer at the load's number,
    on the incarnation the write was made against, over the object the load wrote, proved by one footer read, is the
    load's own landed write: `published: true`. The incarnation is the id in the row's token, so two incarnations
    created in the same millisecond are told apart exactly; a row without an id (one 0.11 wrote, or a registry of your
    own) is told by its creation stamp, and the footer proof decides the rest. A row still as the write found it means the write did not land or is on
    its way, so the publish sends a **new** compare-and-swap from the version it just read, after a wait on the store's
    clock: at most three, after under 500 ms, then 1 s, then 2 s (spread by the store's random source, whether or not its reads retry). It is a request
    of its own, not a replay, carrying the version the first one did, so under the registry's fence at most one of the two
    lands, and a request delayed past the fresh one is refused. Each is settled the same way, and still unanswered the
    load throws the registry's own `TransientError`, with its object kept: no load deletes its object after an ambiguous
    outcome, so a write that reaches the registry after the load returned always finds its object there. Any other row has
    moved past what the write was conditioned on, so the write can never land, and the load goes on as after a lost race.
    `load`, the `*Into` verbs, the erasure rewrite and a bulk load publish this way, and each proves its own object by its
    footer, so an erasure whose write went unanswered cannot report `erased: true` over another incarnation's generation.
    A caller that gives the publish no clock gets no fresh write: an unanswered write throws at once. On Azure Blob the
    client's own retry policy runs under each fresh write, so a registry that never answers costs up to four times the
    policy's tries (sixteen requests at its default) before the load throws: about 16 s per write at the SDK's default schedule (it waits 0, 4 s, then 12 s between tries), so about 64 s for the four writes, plus up to 3.5 s of the publish's own waits (derived from that schedule, not measured).
  - *Audit and errors.* A `segment.load-refused` event that follows a registry write which went unanswered carries
    `unanswered: true` (an optional field, absent otherwise): that write may have landed and the generation been current
    for a while before another writer replaced it. The materialisation error no longer says the result never became
    current: it says the generation was written and is not current.
  - *A write that landed and was overwritten.* On Azure Blob a write the client sent again reads the blob back to tell
    its replay from a conflict, and a row is overwritten by compare-and-swap, so another writer's write on top of the
    load's own (a retention change, say) made it report `WriteConflictError`, and the load would have returned
    `published: false`, `reason: 'superseded'` over a pointer that named its generation. The publish reads the row
    after a conflict and recognises its own write by its effect, as it does after any unanswered write, so the load
    returns `published: true`. Tests run a real `@azure/storage-blob` client against a stub that applies the write,
    lands another on top, and then answers `503`.
  - *Requests.* A throttle only adds requests. A publish that is not throttled sends the requests of a write with no
    id (the write id travels in the object's own request), so `costReport()` and `estimateCost()` price a load at its
    unthrottled counts. The
    calibration harness treats a load that absorbed a transient fault on its pointer write as a missed expected count,
    since it made more requests than a steady load, rather than as a clean sample; a fault on any other request of a
    load still fails the run.

- **The roaring codec's `optimize()` is canonical: `removeRunCompression()`, then `runOptimize()`.** Where a
  container's run and array encodings are the same size (three values in one run, five in two, and so on), CRoaring's
  `runOptimize()` alone keeps whichever kind the container already has, so the same chunk could be stored as two
  different byte strings. Now a chunk's bytes depend on its members alone, which is what makes a load from a bitmap
  byte-identical to one from ids. No load's bytes change, since a chunk built from ids has no run compression to
  undo. The one place they can: an erasure that rewrites a stored run chunk down to a tie now stores it as the array a
  load writes, the same members in a payload 7 bytes larger (a one-container bitmap's header is 16 bytes, against 9
  under the run cookie).

- **A registry row whose token is in no form the library writes is refused when it is read**, with an
  `IntegrityError` naming the row's key, where it used to pass the read and fail at its next write. A row stamped 1
  must hold a decimal counter, and one stamped 2 a token with a write part.

- **Azure Blob reads a registry pointer in one request, where it made two.** A pointer read was the blob's
  properties and then a download pinned to the ETag they named; it is now one GET of the whole blob, taking the ETag
  (the version fence) and the length from the response that carries the bytes, so the pair describes one version and a
  concurrent overwrite is seen as the older row or the newer one, never split between two requests. The response is
  untrusted: one that is not a `200`, that has no ETag or an empty one, that has no length, or whose length is over the
  1 MiB row cap is refused with `IntegrityError` before a byte of its body is read, and the body is counted as it
  arrives and refused at the first byte past its length. A refused response is let go: the SDK throws on a response
  with no ETag or no length and leaves its socket open, and the driver aborts the request, which closes it. The read
  asks the SDK not to re-request the rest of a body cut off part-way, so the bytes come from one response or the read
  fails, with a `TransientError` the store's read retry repeats. An answer from a host other than the container's own,
  which is where a client set with `retryOptions.secondaryHost` sends a retried read, is refused as transient too, so
  the registry never takes a geo-replica's older row for the current one. A `404` is still absence. Writes, listings and the tombstoning delete are unchanged, and a tail read stays two
  requests, since Azure Blob takes no suffix range. Price an Azure deployment with `storage.requestsPerSizedRead: 2`
  and `requestsPerPointerRead` at its default of 1.

### Fixed

- **`@cloudbitmaps/s3` requires `@aws-sdk/client-s3` 3.700.0 or later, where it took 3.645.0, and its registry checks
  that the SDK sends the headers it relies on.** An SDK sends only the conditional headers it models and drops one it
  does not, without an error. The registry's create sends `If-None-Match` and its compare-and-swap `If-Match` on
  `PutObject`, and its conditional delete sends `If-Match` on `DeleteObject`. The published serializers of 3.645.0 to
  3.699.0 omit `If-Match` on `PutObject`, so on those versions a compare-and-swap lands as a plain overwrite and a
  concurrent writer's change is lost, with no error on either side, and a conditional delete removes whatever is there.
  3.700.0 is the first version that sends it (and `DeleteObject`'s, from 3.698.0). `If-None-Match`, which write-once
  relies on, is modelled from 3.641.0, as before. A fresh install already resolves far above the floor, but a `client`
  the caller passes, or an SDK a package manager pins, can still be older. So before its first request the registry
  serialises each of the three requests through a second client built from its configuration, sending nothing and
  running none of the caller's own middleware, and refuses a write the SDK would send without its precondition
  (`ValidationError` naming the header; upgrade `@aws-sdk/client-s3`), and leaves a row tombstoned when a `DeleteObject`
  would go out without `If-Match`, whatever `conditionalDelete` says. A client it cannot read (a test double) is not
  refused.

- **A GCS download that fails part-way no longer resets the other requests in flight, uploads included.** When a
  download's body was cut off, or the driver refused or cut off the response, the SDK destroyed the HTTP agent it went
  out on, and its default agent is one keep-alive pool shared by every request in the process, so every other request
  on it was reset: with no timeout set, a body the server cut off part-way failed a concurrent 64-byte upload and a
  registry write on another backend with `ECONNRESET`, and a sent-once write so failed may or may not have landed.
  Every download now goes out on Node's global agent, which the SDK never destroys, so a destroyed download closes its
  own connection and nothing else. The cost: Node's global agent closes a connection idle for 5 seconds, where the
  SDK's pool kept it, so a read after a longer pause opens a new connection, with its TCP and TLS handshake, and the
  downloads share that agent with any other `http` or `https` request in the process. Raising
  `https.globalAgent.options.timeout` keeps idle connections longer.

- **A GCS range read buffers at most the bytes it asked for, and checks the response is those bytes.** It is one GET
  through the same path as the tail read: a response longer than the range is refused as soon as its length shows,
  where the whole response was downloaded before its length was checked, and a 206 must name the requested bytes in
  `Content-Range`, while a 200 (a server that ignored the range) is accepted only for a range that starts at 0.

- **A cleartext `.crbm` object under an encrypted segment is refused, not believed.** A read of a segment whose row
  carries wrapped keys opened such an object as if it were the segment's: the footer's encrypted flag alone decided,
  and the key the read was given went unused, so a cleartext object written over a generation by anyone able to
  write the bucket, with no key, answered `count()` with whatever its index claimed. Such an object was never one of
  the segment's generations: a publish never adds a key to a lineage that has generations, and now refuses a
  cleartext object onto a row with a key (see the `Changed` entry on the requests of `store.load()`). So it is a
  forgery, corruption, a cleartext write that never published (a store with no keystore that crashed between its
  write and its publish, before the segment's first keyed load), or one an earlier release published while racing
  that first keyed load. `CrbmReader.open` given a `crypto` now refuses an object that is not encrypted with
  `IntegrityError` naming the generation, before it reads its index, and the live read, a pin and a load's guard all
  open that way. The other paths that meet one:
  - **An erasure** looks in it without the key, since it may hold the subject in the clear: it asks the object's
    footer first, on that path alone, and deletes the object when it holds the id, as it deletes any holder, above
    the pointer or below it. An id it does not hold is `not-member`, as before.
  - **A `rollback`** onto it is refused with `IntegrityError` before the pointer moves, from one read of its footer,
    and so is a rollback onto an encrypted object under a cleartext segment.
  - **Its way out**: a load's collection takes it once it is below the pointer and outside `keep` (one load, or two
    when it sits above the pointer), and `dropSegment`, an erasure of an id it holds, or deleting the object by hand
    also remove it.

  Tests forge a cleartext object in place of an encrypted segment's generation, erase ids from a cleartext write
  that never published below and above an encrypted pointer, roll back onto one, race a cleartext load against a
  first keyed load, and open cleartext objects with and without metadata with a key.

- **An Azure Blob range or tail read that fails part-way is a `TransientError`, and lets go of a response the SDK
  refuses.** When the connection drops part-way through the body, the SDK fails it with an `AbortError`, which reached
  the caller as it was, so the store's read retry did not run it again and a `has()`, `count()` or erasure failed on one
  dropped connection; the registry already read the same fault as transient. Tests drop the connection mid-body on a
  range read and a tail read, with the timeout off and on, and through the store. The SDK refuses a download with no
  ETag or no length by throwing a `RangeError`, and leaves the body unread with its socket open; the read now aborts
  its request when it fails, which closes the socket, with or without a timeout.

- **A calibration run survives a transient fault in a timed sample.** The workload's client makes one attempt per
  request and every timed store runs with its own retry off, so a single transient fault anywhere in a run's requests
  (up to ~94,600 GET-class and 364 PUT-class at the default workload) failed the whole run, and a partial run is not
  evidence. One in-region run failed on a single transient connection fault after about 86,300 requests; at that rate
  a run of this size would finish about a third of the time. A timed sample that meets a transient fault (a cold
  intersect, a cold point read, an `andNot` call or the warm stage's priming pass) is now discarded whole and run again
  from the start, from a state the failed attempt left nothing cached in: on a fresh store, except a first `count()`,
  which runs again on its store once the store has forgotten the segment, and a `has()` on an open segment, which runs
  again on the same store. At most three samples a run and two a stage are discarded; one more, or a fault in a load,
  fails the run as before. A transient fault is the library's `TransientError` or anything the installed SDK's own
  retry would retry. The harness waits for the failed sample's requests still in flight, counts them against it, and
  records each discard beside its stage: the sample, the error's name, the transport code beneath it, the SDK's
  attempt count, how long the attempt ran and the requests it made. Those requests are billed and stay in the stage's,
  and each stage's expected count is held to what its kept samples made. The projection allows three discarded samples
  at the costliest sample's bound, so the default workload's projected upper bound is 364 PUT-class and 106,624
  GET-class requests, $0.044470, under the $0.05 ceiling the README's example sets (`CR_CALIBRATE_MAX_USD` has no
  default, and `--run` refuses without one). `bench/lib/calibration-figures.cjs` treats a run with discards within the
  harness's bounds as evidence and requires its report to state how many it discarded. Wherever the harness records an
  error it now keeps the name, the code and the message: the SDK's HTTP handler renames `ECONNRESET`, `EPIPE` and
  `ETIMEDOUT` alike to `TimeoutError`, so the name alone could not say which it was. `CR_CALIBRATE_FAULT_GETS` makes a
  rehearsal fail the GetObject requests it lists, once each, as a reset socket or (`:denied`) as a 403 that is not
  transient, and is refused in every other mode. A test in the integration lane runs the harness itself through such a
  rehearsal against MinIO, so the integration job now builds the packages first. This is repository work on the
  calibration harness, outside the packages.

- **An S3 registry row refused for its size no longer holds its connection open.** A row whose response declares
  more than the 1 MiB cap is refused with `IntegrityError` before a byte of its body is read, and the body was left
  unread, so each refusal kept its socket until the server gave up on it. The driver now destroys the body on every
  way out of the read that leaves it unread, which closes the connection, with or without `readTimeoutMs`. A test
  refuses three such rows against a stub endpoint and checks that no connection is left open.

- **An S3 registry read whose body is cut off part-way is a `TransientError`.** It reached the caller as the
  SDK's raw connection error, which the store's read retry does not repeat; the storage driver already mapped the
  same fault.

- **One transient read fault no longer fails a whole load or erasure.** A load's guard read of the current
  generation (of a row with no summary), and an erasure's reads (the generation it rewrites and each of its chunks, the read-back that verifies
  the generation it wrote, and any other generation that may still hold the id) went to the raw driver once, so a
  single throttle or reset there failed the call. They now run under the store's read retry (`retry`, on by default),
  with its policy and `onRetry`; `loadSegment` and `eraseIdFromSegment` take it as an optional `readRetry` dep, and
  without one each read is made once. This holds on every backend, with or without a
  read timeout. Tests fault each of those reads once, transiently and otherwise.

- **The production guide's S3 client-timeout sample set a timeout that only logs.** It built the client with
  `NodeHttpHandler({ requestTimeout: 3_000 })`, and on `@smithy/node-http-handler` 4.12.1 `requestTimeout` on its own
  logs a warning when it passes and leaves the request running; it ends the request only beside
  `throwOnRequestTimeout: true`. The sample sets `socketTimeout`, which ends a request whose connection has carried
  nothing for that long and leaves an upload that is still sending alone.

## [0.11.2] — 2026-10-01

**Upgrade if you read from GCS.** In 0.10.0 to 0.11.1, a GCS read that the SDK retried after a 408, 429 or 5xx could
end the process with `ERR_STREAM_UNABLE_TO_PIPE`, whatever the caller wrapped around it. This release sends every
GCS download once and retries it in the driver instead. It also makes a GCS pointer read and tail read one request
each, holds a reader's parsed index in typed arrays whose memory is counted exactly, and has `iterate` fetch up to 8
chunks at a time. No public API changes. The CloudShell entry is repository work on the calibration harness,
outside the packages.

### Changed

- **GCS reads a registry pointer and a generation's tail in one request each, where it made two.** A pointer read was
  a metadata request and then a download pinned to the generation it named; a tail read was a metadata request for the
  size and then a ranged download. The pointer read is now one GET, taking the version fence from `x-goog-generation`
  and capping the length before it buffers; the tail read is one suffix-range GET (`Range: bytes=-N`), taking the
  object's size from `Content-Range`, and an object shorter than the range comes back whole. Both refuse a header that
  is missing, malformed or at odds with the bytes received: a pointer read answers `IntegrityError` and a tail read
  `ValidationError`, where before the driver trusted whatever the second request returned. An empty object's tail is
  the exception to one request: GCS refuses a suffix of nothing with a `416`, and the metadata then confirms the object
  is empty, so it takes two. A pointer read can no longer lose its generation to a concurrent write between its two
  requests. The bytes returned and the registry's behaviour are unchanged. GCS now costs what S3 does per sized read, so `storage.requestsPerSizedRead: 2` in a pricing profile is
  for Azure Blob alone; leave it at its default of 1 for GCS.
- **`iterate` and the storage path of `count` fetch eight chunks at a time instead of one.** A cold full read of a
  segment waited for each chunk's GET before it asked for the next, so a 2,000-chunk read was 2,000 round trips in a
  row. `iterate` (with or without a range) now keeps up to 8 chunk fetches open ahead of the one it is yielding, and
  still yields every id in ascending order. The window opens 1, 2, 4, 8 wide, so a read the caller stops after a few
  ids has fetched a handful of chunks past where it stopped (none, if it stops in the first chunk), and an error in a
  later chunk surfaces only when the read reaches that chunk. `count` takes the storage path only for a custom chunk
  source that cannot serve cardinalities from an index; the shipped backends serve them, so their `count` reads no
  payload and is unchanged. The request total, the per-op budget and the memory ceiling (at most 8 decoded chunks held
  ahead) are unchanged, and there is no new option. A read still resolves one generation before it fetches, but a
  segment that re-resolves mid-read (a TTL boundary, an eviction, a sweep, an invalidation such as the store's own
  `eraseSubject`) now leaves up to 8 chunks already requested from the earlier generation, where a one-at-a-time read
  left only the chunk it was on; `intersect` has always read ahead this way. A fetch started ahead is not cancelled
  when the caller stops.
  Measured against an in-memory source with 10 ms of added latency per chunk read, 500 chunks, load average about 6.5:
  `iterate` 5.93 s to 0.77 s, `count` 5.92 s to 0.75 s; per-id cost on a warm segment is unchanged (about 180 ns an
  id before and after).

### Fixed

- **The CloudShell calibration script no longer stops in silence while it installs Node.** CloudShell ships Node 20, so
  the script installs Node 22 with nvm. nvm is not written for `set -eu`: sourcing `nvm.sh` returns 3 while no default
  Node is installed, and the script's `set -e` ended it there after printing "installing Node 22 with nvm", every time.
  It now runs nvm with those options off, restores them, and checks the result itself, stopping with a message if Node
  22 is still missing, and with another if nvm itself cannot be downloaded. A test runs the script's own bootstrap under its own shell options against an `nvm.sh` that returns 3.
- **A reader's memory bound counted less than its parsed index held.** `cache.readerMaxBytes` weighs each open
  reader by a fixed size per index entry, 160 B, and a measurement of the heap found 186–200 B retained per entry,
  so a cache could hold more index than its budget said. The reader now keeps its parsed index as typed arrays
  (key, cardinality, length, CRC and offset at their own widths) and reports their byte length: 20 B per entry,
  exact, and a test measures the retained memory against it. A 2,000-entry index also parses in about 45 µs where it
  took about 185 µs (Node 24, Apple M3 Pro, both versions bundled and timed under plain Node; inside a test runner
  the gap is nearer 1.7×). A chunk lookup is a binary search over
  the sorted keys. Nothing a caller sees changes except that the same budget now holds about eight times as many
  index entries; the sizing guide's reader table is regenerated at 20 B.
- **A GCS read the SDK retried could crash the process.** With `@google-cloud/storage` 7.x and 8.x (checked on 7.22.0 and
  8.1.0), when a download got any status the SDK retries (408, 429, 500, 502, 503 or 504) and the SDK's own retry then succeeded, the
  SDK threw `ERR_STREAM_UNABLE_TO_PIPE` ("Cannot pipe to a closed or destroyed stream") outside any promise and Node
  exited with code 1, whatever the caller wrapped around the call. It hit every read through `GcsStorage` on the client
  it built itself (tail, range and registry reads), in 0.10.0 and later. `GcsStorage` now builds a second client with
  the SDK's request retries off and sends every download through it, and the driver retries a download itself, up to
  three more times with backoff, after a connection fault (refused, reset, timed out, a DNS failure, a body cut off) or a 408, 429, 500, 502, 503 or 504: what the SDK retried, and not a missing credentials file or a TLS
  failure, which would fail the same way again. A store built with `retry: false` still gets it. What still fails is a `TransientError`. The client's other
  requests (uploads, listings, metadata reads) keep the default retries. A `client` you pass is used as given: build it
  with `retryOptions: { autoRetry: false }`, which also turns off the SDK's retries of listings, metadata reads and
  resumable uploads on that client.

## [0.11.1] — 2026-10-01

The package READMEs on npm say how to install on npm 12. npm 12 runs a dependency's install script only where the
project allows it, and `roaring`'s is the one that fetches its native binary, so a plain `npm i` installed a package
whose first `import` throws. The code in every package is unchanged from 0.11.0: only each package's README and its
version moved. Of the entries below, the install docs are the packages' change; the rest is repository work on the
calibration harness, outside the packages.

### Added

- **The calibration figures refuse a run for what it reports as wrong itself.** A run that timed `store.load()` is
  refused as evidence when teardown left anything behind, when it missed an expected count, when a stage's requests
  are not the ones the stage table expected, or when the shell ran in another region than the bucket's. Its latency is
  labelled in-region only when the round-trip floor is under the line and the shell's region is proven to be the
  bucket's, since a floor under 30 ms keeps another continent out but not a neighbouring region.
- **The calibration harness runs the stages an in-region run needs.** `pnpm calibrate:aws` now runs seven stages and
  records each one's own requests by class and by kind of read: loads through `store.load()`, cold intersects over
  the calibration layout, the same overlap with its shared chunks spread uniformly over each segment (a pure layout
  from a fixed seed, `bench/lib/calibrate-spread.cjs`), a sweep over how many chunks the operands share
  (`CR_CALIBRATE_SWEEP`, default 1,000 and 2,000), warm intersects, `count()` and `has()` as a first read, `has()` on a
  segment already open, both again warm, and `andNot` of one segment against ten. A warm read that makes a request fails its stage. One table names the stages and bounds
  each (`bench/lib/calibrate-stages.cjs`): the pre-flight projection prints every stage's bound, the finished run is
  held to each, and a test fails when the harness runs a stage the table does not name. Each load records its own
  requests, and `bench/lib/calibration-figures.cjs` prices a `store.load()` run from them and from each stage's own
  counts, refusing a file whose stages do not add up to what was billed.
- **The calibration harness measures how deep each cold read ran, and what it ran on.** Each cold intersect and each
  `andNot` call records the requests in flight at their peak, the mean in flight, and how many it waited for one after
  another, beside the engine's model of that, so a latency can be read against the number of round trips behind it.
  Every run also records the AWS SDK and HTTP handler versions and the handler's socket cap.

### Fixed

- **The install docs said npm needs nothing extra; npm 12 blocks `roaring`'s install script.** On npm 12 a plain
  `npm i @cloudbitmaps/roaring` exits 0 with the native binary missing, and the first `import` throws
  `Cannot find module './build/Release/roaring.node'`, as pnpm 10 does. The README, the getting-started guide and
  every package README now give one `package.json` block for both clients,
  `{ "allowScripts": { "roaring": true }, "pnpm": { "onlyBuiltDependencies": ["roaring"] } }`, and say that npm 11
  runs the script but warns until it is allowed the same way. The troubleshooting entry covers npm 12's
  `npm install-scripts approve roaring`, which records the approval but runs nothing, so `npm rebuild roaring`
  follows it.
- **The calibration harness runs from the CloudShell script's scratch directory.** It read the version it measured from
  `packages/roaring/package.json`, which a scratch directory that installed the published packages does not have, so
  `bash bench/calibrate-cloudshell.sh` stopped with `ENOENT` before it did anything. It now reads the installed
  package's version there and the checkout's own from a checkout, and a test runs the harness, in projection mode,
  from a directory holding only the files the script copies.
- **The CloudShell script installs a working `roaring` on npm 12, and refuses a run it cannot label.** npm 12 runs a
  dependency's install script only where the project allows it, and `roaring`'s is the one that fetches its native
  binary, so the scratch install exited 0 and the first import threw. The script now allows it, and stops before
  creating anything if the addon still does not load. It also refuses a shell that does not say which region it runs in,
  a requested region other than the shell's own, and a rehearse flag other than `1`, and it measures the release this
  clone's expectations were written for unless `CR_CALIBRATE_PACKAGE_VERSION` names another.

### Changed

- **Calibration results files carry every fractional number to nine decimals.** That is below a nanosecond for a time
  in milliseconds and a billionth of a dollar for a cost. A ratio's binary tail otherwise runs to 17 digits, and one of
  exactly 12 is a run the leak scan refuses, so a file could not be committed by chance.
- **The default calibration workload is 20 single-part and 5 multipart loads, and every segment is loaded once.** A
  segment's first load is what the projection bounds, so the harness refuses to load a name twice.

## [0.11.0] — 2026-10-01

Reading by id range, and a store that refuses what it would otherwise get wrong. `iterate`, `intersect`, `union`,
`andNot` and the `*Into` verbs read an id range `(after, through]` and fetch only the chunks it overlaps, so a large
segment pages by keyset. The public surface is trimmed to what callers use, a backend class is the one way to build
storage, and the store and the three cloud backends refuse every option key they do not take. Untrusted bytes get the
full structural check, a conditional write is sent once or settled by reading it back, and a subject erasure reaches
every generation that holds the id. Read the Breaking list before upgrading.

### Breaking

The first changes what two combines return, with no error. The next two narrow what an application sees: `@cloudbitmaps/roaring` exports a list of names in place of all of
core's, and a `Segment` can no longer be constructed. The four after them remove exports: the first deletes names
nothing in the library would still call, the second takes names off the public entries or moves them to the package
that uses them, and the third and fourth remove the retrying driver wrappers and the bulk loader. The two after those
make a backend class the one way an application builds its storage: the size settings move onto the backend options,
and the separate storage and registry halves and `createBackend` are no longer exported. The tenth makes
the collection refuse a `keep` it used to accept. The next twelve make a call throw where it used to return: seven of
them fix a wrong answer, and the entries under **Fixed** say what the call returned before; one changes when a pin fails;
three hold a call to a rule the rest of the library already kept; the last of the twelve refuses a namespace the library keeps for its own
rows, and says in its own entry what the call returned before. The six after them hold the store, the backends and the registry to what the library itself takes and writes, stop
checking for a local store's older directory layout, and give its errors the library's own brand. The two after them
change what `estimateCost()` compares with and what a `CostReport` carries. The last holds `eraseSubject` to its
budget for the generations it opens.

- **An expired exclusion excludes nothing, in every shape of combine.** `a.intersect([b], { exclude: [stale] })` and
  `a.union([b], { exclude: [stale] })` subtracted the ids of an `exclude` handle whose `expiresAt` had passed, and now
  return what they would with that handle left out of `exclude`, as `a.andNot([stale])` and a `union` whose other
  operands had all expired already did. The same holds with a range (`after`, `through`) and on pinned handles. An
  expired exclusion is skipped without being read, so one that names a segment that does not exist is no longer
  refused as an absent operand. Expiry treats an expired segment as gone, and an exclusion that is gone removes
  nothing; the answer used to depend on how the combine was spelled. A result that used to leave out a lapsed
  opt-out list's ids now includes them, so renew the list's `expiresAt`, or leave the deadline off it, where it
  must keep suppressing. Unchanged: an expired `self` or include operand is empty or dropped, an absent operand is
  refused unless `allowAbsentOperands` is set, and an `*Into` involving an expired handle, an exclusion included,
  throws `ValidationError`.
- **`@cloudbitmaps/roaring` exports an explicit list of names, not everything `@cloudbitmaps/core` exports.** An
  application installs the flavor and sees the store, the errors, the types its signatures name, the backends'
  shared types, and the constants and helpers a user calls. Every name below stays on `@cloudbitmaps/core`, which
  flavor and driver authors still import, and core's main entry and `@cloudbitmaps/core/driver-kit` are unchanged.
  - **Engine internals:** `SegmentEngine`, `EngineDeps`, `EngineCombineOptions` and `BoundedLru`. The engine was
    reachable from the flavor only to build a `Segment`, which can no longer be built (next entry).
  - **Metrics, budget and retry internals:** `safeMetrics`, `NOOP_METRICS`, `resolveBudget`, `resolvePerOpBudget`,
    `collectWithinBudget`, `DEFAULT_BUDGET`, `checkBudget`, `withRetry`, `RetryDeps`, `RetryingStorageChunkSource`
    and `RetryingOptions`. Omit `metrics` for the no-op sink, set `budget` and `retry` on the store, and retry a call
    of your own with a loop that backs off while `isTransientError(err)` holds. `Budget` and `DEFAULT_RETRY_POLICY`
    stay on the flavor.
  - **Other internals:** `groundedReport` (use `seg.costReport()`), `splitId`, `mapWithConcurrency`, `segmentKey`
    (use `seg.key()`), `isStorageBackend` and `PinnedStorageChunkSource` (use `seg.pin()`).
  - **The standalone forms of store methods:** `listGenerations` (use `store.generations`), `rollbackSegment`
    (`store.rollback`, which takes `allowForward`), `segmentExists` (`store.exists`), `listSegments`
    (`store.segments`), `setSegmentRetention`, `getSegmentRetention` and `clearSegmentRetention`
    (`store.setRetention`, `store.getRetention`, `store.clearRetention`), `runConsistencyCheck`
    (`store.checkConsistency`), `runExport` (`store.exportSegments`), `dropSegment` (`store.dropSegment`),
    `retireExpired` (`store.retireExpired`), `estimateCost` (`CloudRoaring.estimateCost`), `loadSegment`
    (`store.load`), and the types `GenerationListDeps`, `RetentionDeps`, `DropDeps` and `LoadDeps`. The flavor's own
    `loadSegment` and `runExport`, which bound the roaring codec, are deleted: core's versions take a `codec`, and the
    flavor no longer exports one. An application writes through the store's methods, on a store built on a backend
    class (`MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or `AzureBlobStorage`); composing a backend
    from drivers of your own is a driver author's job, done with `brandAsBackend` from
    `@cloudbitmaps/core/driver-kit`. Every result type these produce stays exported,
    because a store method returns it.
  - **Erasure:** `eraseIdFromSegment`, `EraseIdDeps` and `EraseIdResult`. `store.eraseSubject` is the one erasure
    verb.
  - **Still on the flavor:** `destroySegment` and `eraseNamespace`, which take only a registry and have no store
    method, and every other name in `@cloudbitmaps/roaring`'s export index.
- **A `Segment` has no public constructor.** It took the store's internals (a `SegmentEngine`, a metrics sink, and
  the functions that wire it to the store's write path), so `new Segment(…)` could not build a working handle
  outside the store. Get one from `store.segment(name, options)`, or from `seg.pin()`. `Segment` stays exported for
  `instanceof` and to annotate a variable, and `new Segment(…)` from JavaScript throws `ValidationError`.
  `seg.key()`, an opaque string naming the handle's segment that is equal across a live handle and its pins, is
  documented in the API reference.
- **`TimeoutError`, `AuditEventKind`, `VERSION` and `MemoryStorageChunkSource` are deleted.** Nothing in the
  library would still call them.
  - `TimeoutError` was never constructed or thrown by any package: a request timeout a shipped driver recognises
    already reached you as a plain `TransientError`, which is what to catch, and a driver of your own throws that too,
    with the cause attached.
  - `AuditEventKind` was `AuditEvent['kind']`; write that.
  - `VERSION`, which `@cloudbitmaps/roaring` exported, is gone: your lockfile and the installed package's
    `package.json` say which version you run.
  - `MemoryStorageChunkSource` was a test double that skipped `.crbm`, seeded chunk by chunk. Use a `MemoryStorage`
    backend and fill it with `store.load()`; to hand a store a `StorageChunkSource` of your own, implement that
    interface.
- **Names are off the public entries, and `@cloudbitmaps/core/driver-kit` sheds the helpers nothing outside core
  uses.** Each was a lower-level step that `store.load()` or the driver packages already take, a second spelling of
  a name that stays, or a helper one package uses.
  - `writeCrbmGeneration`, `publishGeneration`, `nextGeneration`, `gcOrphanGenerations` and `GenerationDeps` are no
    longer exported, from `@cloudbitmaps/core` or `@cloudbitmaps/roaring`. `writeCrbmGeneration` was kept on purpose
    until now. Load with `store.load(ref, ids, options)`, which takes the
    generation number, writes the object, publishes and collects. Collect with `keep` on `load` and on the `*Into`
    verbs, or retire a segment with `store.dropSegment()` or the retention sweep.
  - `SafeBitmap` and `roaringCodec` are no longer exported from `@cloudbitmaps/roaring`. Every call that takes a
    `codec` has it bound for you, so nothing needs them. An author of another flavor implements `CodecInterface`.
  - `DEFAULT_PRICING` is no longer exported. It was another name for `AWS_US_EAST_1_ONDEMAND`, which stays: clone
    and adjust that one.
  - `registryPrefix`, `registryObjectKey`, `registryListPrefix` and `parseRegistryKey` are no longer exported from
    `@cloudbitmaps/core/driver-kit`. No driver package calls them: `ObjectStoreRegistry` builds every registry key,
    and a driver built on it needs nothing else.
  - `errorName`, `httpStatus`, `isNetworkOrTimeout`, `isSdkRetryable` and `isServerSide` moved out of
    `@cloudbitmaps/core/driver-kit` into `@cloudbitmaps/s3`, the only package that uses them, and are not exported
    from it. A driver of your own classifies its SDK's errors itself.
  - `encodeNameForPath` and `namespacePathPart` moved from `@cloudbitmaps/core` and `@cloudbitmaps/roaring` to
    `@cloudbitmaps/core/driver-kit`, beside `encodeNameForKey` and `namespaceKeyPart`. Import them from there.
  - `validateSegmentRef` is exported from `@cloudbitmaps/core/driver-kit` only. It was also on `@cloudbitmaps/core`
    and `@cloudbitmaps/roaring`.
- **`RetryingStorageDriver` and `RetryingRegistryDriver` are no longer exported**, from `@cloudbitmaps/core` or
  `@cloudbitmaps/roaring`. Nothing in the library used them. The store's read retry is unchanged: the reads that
  answer a query go through `RetryingStorageChunkSource`, which stays on `@cloudbitmaps/core`, with `RetryingOptions`
  and `withRetry`, and the store's `retry` option and `DEFAULT_RETRY_POLICY` are unchanged. The two removed wrappers retried every call of the driver they
  wrapped, writes included, and a retried conditional write can report a write that landed as a conflict: when a
  write-once put or a compare-and-swap lands and its response is lost, the replay finds that write already there,
  so the put throws `WriteConflictError` and a load reports `superseded`, for the caller's own write; a load whose
  pointer write was replayed can report `superseded` while its own generation is current. Each also collected a whole
  `list` before yielding any of it. To retry a write, re-run the call, passing the ids again through a fresh
  iterator: a re-run `load` takes a fresh generation number and re-reads the row, so once the first attempt has
  settled it publishes whenever that attempt would have, whether or not it landed. Each attempt whose object landed
  takes a `keep` slot, so under the default `keep: 1` the re-run collects the generation the segment held before the
  load; pass a `keep` one above the number of attempts that landed to keep it. To learn whether an attempt landed,
  compare `store.generations(ref)` with what it listed before the call rather than replaying the request.
- **`bulkLoadCrbmGeneration` and `BulkLoadResult` are no longer exported**, from `@cloudbitmaps/core` or
  `@cloudbitmaps/roaring`. Load with `store.load(ref, ids, options)`, which
  takes the next generation number itself and publishes, and returns a `LoadResult` whose `published` says whether the load took effect, where the removed result said `becameCurrent`.
  Five more differences can change what a job does:
  - **A load collects.** Once it publishes, it deletes the generations the publish superseded, keeping the newest
    `keep` below the new pointer (default `1`). The removed loader deleted nothing, so a job that keeps older
    generations as `rollback` targets passes the `keep` it needs.
  - **An empty result over a non-empty segment is refused**, as `published: false` with `reason: 'empty'`. Pass
    `allowEmpty: true` when emptying the segment is the point.
  - **A load fences its publish on the row it read**, so a `setRetention`, a `rollback` or an erasure that lands
    while it writes makes it report `reason: 'superseded'`, where the removed loader published forward regardless.
  - **A load reads the current generation's size to guard it**, so a current object that will not open throws
    `IntegrityError`. A load with `allowEmpty: true` and no `guard.minRetained` does not read it.
  - **Neither can be told to write a generation without publishing it, to write one with no registry, or to take its
    generation number from the caller.** Nothing exported can: `writeCrbmGeneration` and `publishGeneration`, which
    could, are no longer exported either (see above).
- **The size settings are options of the backend classes, where they were options of the separate storage halves.**
  Set each one on the backend; a backend refuses the settings of another backend by name, as it refuses any key it
  does not take, and a setting keeps the name and default it had. Each must be a positive safe integer, and a value
  that is not throws `ValidationError` naming the option, from the backend's constructor. `S3Storage` and
  `GcsStorage` used to accept `NaN`, zero, a negative or a fraction for these and size their writes from it.
  - `S3Storage` takes `partBytes`, the multipart part size (default 8 MiB; a smaller value is raised to S3's 5 MiB
    minimum, and the part size grows so 10,000 parts cover `maxObjectBytes`), and `maxObjectBytes`, the largest
    object it writes and advertises (default `partBytes` × 10,000, about 80 GiB). They were options of
    `S3StorageDriver`.
  - `GcsStorage` takes `simpleUploadThresholdBytes`, the size up to which an object is one simple request (default
    8 MiB), and `maxObjectBytes` (default 5 TiB, GCS's maximum). They were options of `GcsStorageDriver`.
  - `AzureBlobStorage` takes `blockBytes`, the staged block size (default 8 MiB), and `maxObjectBytes` (default
    `blockBytes` × 50,000, about 400 GiB). They were options of `AzureBlobStorageDriver`.
  - `MemoryStorage` and `LocalFsStorage` had no size settings, and take none.
- **The separate storage and registry halves, their options types and `createBackend` are no longer exported.** An
  application gets both halves from one backend class and never names one. Removed from `@cloudbitmaps/core` and
  `@cloudbitmaps/roaring`: `MemoryStorageDriver`, `MemoryRegistryDriver`, `MemoryRegistryDriverOptions`,
  `LocalFsStorageDriver`, `LocalFsRegistryDriver`, `LocalFsRegistryDriverOptions` and `createBackend`. Removed from
  `@cloudbitmaps/s3`: `S3StorageDriver`, `S3RegistryDriver`, `S3StorageDriverOptions` and `S3RegistryDriverOptions`;
  from `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob`, the same four with their own prefix.
  - **Use a backend class instead:** `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage` or
    `AzureBlobStorage`. The size settings are options of those classes (previous entry). A backend's `.storage` and
    `.registry` are typed as the `IStorageDriver` and `IRegistryDriver` ports, including on `MemoryStorage` and
    `LocalFsStorage`, where they were typed as the concrete classes.
  - **To wrap a backend's half, or to pair it with a registry of your own** (tenant scoping, auditing, a registry in a
    database you already run), build the backend with `brandAsBackend({ storage, registry })` from
    `@cloudbitmaps/core/driver-kit`, in place of `createBackend`. It takes a plain object and returns it, branded. It
    now checks what `createBackend` checked: `storage` needs a `putImmutable` and `registry` a `compareAndSwap`, and
    it throws `ValidationError` naming the half that has neither. A store that refuses a hand-assembled
    `{ storage, registry }` now names the backend classes and `brandAsBackend`, where it named `createBackend`.

- **The collection refuses a `keep` that is not a non-negative integer**, with `ValidationError`. `load` and the
  `*Into` verbs already refused one before writing anything. The collection itself, which `gcOrphanGenerations`
  exposed, read `NaN` as a window that keeps nothing, so it collected the whole grace window, and a negative
  `keep` as `0`. A `keep` that is negative, fractional, `NaN` or infinite now throws on every path that takes one,
  and deletes nothing. Pass a whole number of generations, `0` to keep none below the new pointer.
- **On S3, and on GCS for the registry and for objects up to `simpleUploadThresholdBytes`, a conditional write that
  fails transiently throws `TransientError`**, where the SDK used to send it again and the call could return: a
  dropped connection, a timeout, a 5xx, throttling, and on S3 a signature refused for a clock minutes out, which the
  SDK corrects before the next request. These writes are a generation's write-once put, which `store.load`, the
  `*Into` verbs and an erasure's rewrite make, and the registry's create, compare-and-swap and delete, which writes a
  tombstone, one of which every publish, `rollback`, `setRetention`, drop, crypto-shred and retention sweep makes. The write may or may not have landed: re-run the call, and
  check what landed before treating the write as lost, since `store.generations(ref)` lists what the bucket holds with
  the current generation marked. Every other request keeps the SDK's retry, and a client you pass keeps its
  configuration.
- **A pinned read of a segment whose row is gone or destroyed throws `NotFoundError`**, where it read empty,
  part-way through a call included. Catch it where a pin can outlive its segment: across a `dropSegment`, a
  `retireExpired` or a crypto-shred.
- **A combine that holds one segment at two generations throws `ValidationError`** when it is read: pins of two
  generations, pins of one generation number that are two different objects, or a pin and a live handle, as in
  `live.intersect([snap])` with nothing moved since the pin. Materialise one side first, with
  `intersectInto(dest, [])`.
- **`pin()` opens the generation it pins**, so it fails where the pin's first read used to: `NotFoundError` for a
  pointer at a missing object, `IntegrityError` for a damaged one. Handle both where you call `pin()`, as you did
  around the pin's first read.
- **An object whose footer names another generation is refused with `IntegrityError`** wherever it is opened, a pin
  included, so a default load onto a segment whose current generation is misfiled fails its guard. To move past it,
  roll the segment back to an earlier generation that opens, or load with `allowEmpty: true` and no
  `guard.minRetained`, which then does not read the current generation.
- **A chunk payload that is not a well-formed roaring bitmap is refused with `IntegrityError`**, by every read and
  every erasure that decodes it, and by `SafeBitmap.safeDeserialize` and `roaringCodec.safeDeserialize`, where the
  native deserializer accepted it: containers or values out of order or listed twice, runs that overlap,
  touch or run past their container, a run container with no runs, a bitset whose header cardinality disagrees with
  its bits, and an offset header that disagrees with where the containers are. Nothing the library writes has any of
  these shapes, so a segment it loaded reads as it did.
- **An object whose index is not internally consistent is refused with `IntegrityError` when it is opened**, so
  every call that opens it throws: `has`, `count`, `iterate`, every combine, a load's guard, a pin, an erasure and
  `checkConsistency`. Two shapes were accepted and are now refused: an index entry whose payload runs past the end
  of the payload region, into the index, and an encrypted object's entry whose payload is too short to hold its
  nonce and tag. `count()` summed such an index and returned; a read of the chunk failed later, on its checksum or
  its authentication tag. Nothing the library writes has either shape, so a segment it loaded reads as it did. To move
  past one, roll the segment back to an earlier generation that opens, or load with `allowEmpty: true` and no
  `guard.minRetained`, which then does not read the current generation; a default load fails its guard.
- **A combine whose other operands have all expired checks its own segment as every combine does.**
  `seg.union([expired])` and `seg.andNot([expired])` read `seg` alone, and now refuse a `seg` that names no segment
  with `ValidationError`, as `seg.union([live])` already did, where they returned no ids; `allowAbsentOperands: true`
  still reads it as empty. They also now take the call's `concurrency` and `budget`, so `concurrency: 0` throws and a
  per-op budget too small for `seg` refuses the read. The error, the budget refusal and the `intersect` metrics event
  of such an `andNot` name the verb `union`.
- **A custom `StorageChunkSource` that lists one chunk key twice is refused with `IntegrityError`** by every read
  that lists a segment's chunks: `iterate`, every combine, and a `count` with no index to sum. A combine used to drop
  the duplicate. The sources the library ships never list a key twice; make a custom one's `listChunkKeys` return
  each key once.
- **A read whose pointer refresh fails with anything but a transient fault throws that error**, where it kept
  serving. A `has`, `count`, `iterate` or combine, or a `costReport`'s size read, that finds its segment's pointer
  due for a re-read (once `cache.genTtlMs` has passed) and gets an access denial, an `IntegrityError` for a row
  that will not parse, or any other error that is not a `TransientError` now fails with it, and the reader's
  snapshot is dropped, so the next read resolves the segment afresh. A transient fault is unchanged: the reader
  keeps serving, now with a retry after 500 ms rather than after a whole `cache.genTtlMs`. A dropped or shredded
  row, which the registry reports as no row, still reads empty. See **Fixed**.
- **`eraseNamespace` throws `BudgetExceededError` for a namespace of more than 250,000 segments**, where it erased
  it. It listed the whole namespace with no bound, holding every row resident, when every other fleet scan stops at
  a ceiling. It now holds its listing to `DEFAULT_MAX_SCAN_SEGMENTS` (250,000), and the error tells you to raise
  the new `maxScanSegments` option on the call when the namespace really is that large and the memory is there,
  without the other scans' advice to narrow with a `namespace`, since the call already is one. The call lists the whole namespace before it destroys anything, so the refusal comes first and
  nothing is erased. A `maxScanSegments` that is not a finite number of at least 1 throws `ValidationError`, also
  before anything is destroyed. `eraseNamespace` is a free function over a registry, so no store method forwards
  the option.
- **A namespace starting with `cbm.due.` is refused with `ValidationError`**, in every segment ref and in every
  `namespace` option: `store.segment`, `load`, `exists`, `generations`, `rollback`, `dropSegment`, `setRetention`,
  `getRetention`, `clearRetention`, `invalidate`, `segments`, `retireExpired`, `checkConsistency`, `exportSegments`,
  `subjectReport` and `eraseSubject`, and the free function `eraseNamespace`. The library
  keeps its due index in `cbm.due.<day>`, and every fleet-wide scan skips a row there as bookkeeping, so a segment
  of yours in a namespace such as `cbm.due.eu` was invisible to the calls that scan: `eraseSubject` and
  `subjectReport` returned an empty ledger with `scannedSegments: 0` even with that namespace named, so an erasure
  reported nothing to erase while the id was still in the segment; the unscoped `retireExpired` and
  `checkConsistency` never saw it; `exportSegments` left it out and `segments()` did not list it. Only that exact
  prefix is reserved: `cbm.dueX`, `cbm.due` and `cbmdue.eu` are ordinary namespaces, and a segment name is not
  restricted. The library's own writes to the reserved namespace go through the drivers and are unchanged: a
  driver takes the prefix, since `validateSegmentRef` on `@cloudbitmaps/core/driver-kit` checks the name rules
  only. A segment that already sits in such a namespace stays where it is, but no call names it after the upgrade:
  before upgrading, copy each into another namespace (`iterate()` its ids and `load` them there) and `dropSegment`
  the old one.

The first four of these make the library refuse what it used to ignore or accept, so that a wrong input fails
where it is written. The fifth drops the check for a local store's older directory layout, and the sixth renames
the error brands:

- **`new CloudRoaring(options)` refuses every key it does not take**, at the top level and inside `cache`,
  `encryption`, `retry`, `budget` and `seams`, with a `ValidationError` naming each one and the keys the store or
  the group takes. It refused a fixed list of spellings before, and ignored any other key. A group that is not an
  object is refused too — `null`, an array, a Map, a boxed primitive, `encryption: true` — and `false` is taken
  only by `retry` and `budget`.
- **`new S3Storage(options)`, `new GcsStorage(options)` and `new AzureBlobStorage(options)` refuse every key they do
  not take** the same way, and an options bag that is not an object. `GcsStorage` refused only `storage` before,
  and the other two ignored any key they did not take.
- **`new S3Storage(options)` and `new GcsStorage(options)` refuse a connection setting given beside a `client`.**
  `S3Storage` refuses `region`, `endpoint`, `pathStyle` and `credentials`, and `GcsStorage` refuses `projectId` and
  `apiEndpoint`, with a `ValidationError` naming each one given. They were ignored before: a `client` carries its own
  region, endpoint and credentials, so an `endpoint` meant for MinIO beside a client built for AWS sent the store's
  traffic to AWS. Configure those settings on the client, or drop `client` and let the store build one from them.
  `bucket`, `prefix`, `now` and the size settings (`maxObjectBytes`, `partBytes`, `simpleUploadThresholdBytes`) are still
  taken beside a `client`, as is a setting set to `undefined`. A `client` of
  `null` counts as none, so the settings build one; `AzureBlobStorage` reads a `containerClient` of `null` the same
  way, which throws `ValidationError` at construction unless `connectionString` and `container` are given, where it
  used to build a store that failed on its first read.
- **`RegistryStatus` is `'active' | 'destroyed'`.** A stored registry row with another status, a field its record
  or its envelope does not declare, or no `schemaVersion` is refused on read with `IntegrityError`, and so is every
  `list()` of a registry that holds one, which the retention sweep, `checkConsistency` and subject erasure run. Every
  row a store created at `0.10.0` or later writes passes. A row last written before `0.10.0` does not, nor does a
  tombstone `0.10.0` wrote over one, since the tombstone keeps the row's fields, nor a row a caller set to
  `compacting` or `erasing` through the registry driver: load such a store's segments into a new one from their
  source. The registry drivers also refuse to write any status but `active` and `destroyed`, with `ValidationError`.
- **`LocalFsStorage` does not look for a `cold/` directory.** A root keeps its generations in `storage/`, and one
  that holds them anywhere else opens like any other with its generations missing: a read throws `NotFoundError`,
  and `checkConsistency` reports `missing-storage-generation`. Move a root's generations before you upgrade, while
  `<root>/storage` does not exist yet, with `mv <root>/cold <root>/storage`: the objects inside are unchanged, and until they move, that report is the path,
  not a torn restore.
- **The error brands are `Symbol.for('cloudbitmaps.error')` and `Symbol.for('cloudbitmaps.error.transient')`.**
  Upgrade every `@cloudbitmaps` package together: a package from an earlier release brings its own copy of core,
  and neither your error predicates nor the store's own error handling recognise that copy's errors.

These two change what `estimateCost()` reports:

- **`estimateCost()` compares with the Redis that would hold your data, not one $346 cluster.** The default
  verdict, rationale and read crossover are now against the cheapest ElastiCache for Redis OSS cluster that holds
  the report's stored bytes at their compressed size: enough shards, each a primary and two replicas, with 25%
  of each node's memory reserved, at AWS's us-east-1 on-demand prices from its price list of 2026-09-14, and the
  burstable `t4g` nodes priced only as one shard. One cluster was the wrong size in both directions: 200 MB fits
  three `cache.t4g.micro` nodes at $35.04 a month, and 2 TB does not fit it at all — three `cache.r6gd.16xlarge`
  data-tiering nodes hold it, at about $27,325. The report names what it priced in the new `redisBaseline`,
  `{ basis: 'fixed', monthlyUSD }` or `{ basis: 'sized-to-data', monthlyUSD, cluster: { nodeType, shards, nodes,
  dataTiering } }`, and in the last of its notes. It is the cheapest cluster of one kind, not the least Redis could
  cost: the compressed size is a floor on the memory Redis needs, since a native Redis bitmap is sized by its
  highest id, but reserved nodes, one replica a shard, or ElastiCache for Valkey all cost less than it prices.

  **To keep the old comparison**, pass `pricing: { ...AWS_US_EAST_1_ONDEMAND, redis: ONE_REDIS_HA_CLUSTER }`.
  `ONE_REDIS_HA_CLUSTER` is the $346 cluster the benchmarks page still charts. What else changes:

  - A default report has a different baseline at every data size, so a different crossover, and it can have a
    different verdict.
  - `pricing.redis` must give exactly one of `{ monthlyUSD }` and `{ sizedToData: RedisSizing }`, and one giving
    both is refused with a `ValidationError`, where a key set to `undefined` gives nothing. So is a spread of the
    default's `redis` with a price, `{ ...AWS_US_EAST_1_ONDEMAND.redis, monthlyUSD: 500 }`, since the spread now
    carries the default's `sizedToData` too; it is refused rather than read one way.
  - JavaScript that reads `AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD` gets `undefined`, and a ratio built on it is
    `NaN`. Read `report.redisBaseline.monthlyUSD` instead, or `ONE_REDIS_HA_CLUSTER.monthlyUSD` for the one
    cluster. TypeScript types it `number | undefined`, so under `strictNullChecks` a ratio built on it does not
    compile.
  - A hand-built `CostReport` must carry `redisBaseline`, which is required.
  - `segment.costReport()` sizes the Redis to that one segment — $35.04 for any segment up to 384 MiB, a tenth of
    $346 — so per-segment verdicts move toward the lose-zone, and the baselines of a store's segments do not add up
    to the store's. To judge a store, price all its segments in one `estimateCost()`. To alarm, sum the segments'
    totals and compare the sum with the Redis you would run for the store, as the cost gauge in the dashboards
    guide now does: a per-segment verdict against that whole price fires only when one segment alone costs more than
    all of it.
  - The catalogue is `ELASTICACHE_REDIS_US_EAST_1_ONDEMAND`, with the types `RedisSizing` and `RedisNodeType`. It,
    `ONE_REDIS_HA_CLUSTER` and the default profile are frozen, so a caller that changes one no longer changes every
    other caller's estimates: the change throws in strict mode, as in every ES module, and is ignored in a
    sloppy-mode script.
  - A report with no bytes to size to — nothing stored, or a storage source that cannot measure — compares with the
    catalogue's cheapest cluster, and its rationale and notes say that no bytes were counted.
  - The benchmarks page's line is still drawn against the $346 cluster, and now says that this is 2.4 times the
    $142.35 Redis the default prices for its 1.2 GiB reference set, against which the line would sit at 135.42 reads
    a second. `pnpm bench:check` fails CI when the chart, the page or `bench/results.json` drifts from the
    estimator.
- **`CostReport.monthlyUSD.byOp` gains the required `pointerRefresh`**, so a `CostReport` you build yourself must
  set it, and `estimateCost()` refuses an `operandsPerIntersect` below 1 with `ValidationError`. The rationale names
  intersections, loads and the refresh in new words, and the notes gain lines for intersections, the refresh and a
  hot set larger than the reader cache, and its loads line is reworded, so a check that matches either's text needs
  its new wording. The entry
  under **Fixed** says what the estimator counts now.
This one changes what an erasure charges its budget for:

- **`eraseSubject` charges its budget for the generations it opens, and reports a segment that runs it out.** A
  segment whose current generation lacks the id is searched in every generation still in its bucket, which is one
  open each and, with the keep-everything default of the `*Into` verbs, one for every generation the segment ever
  had. The budget counted one unit for the segment, and the guide and the API reference said the call was
  `O(registered segments)`. It now charges one unit per segment and one for each generation opened beyond the one
  the segment's row names, so the call is `O(registered segments + superseded generations)`; a rewrite of a segment
  that holds the id, and the read that verifies it, are not charged beyond the segment's unit. The default,
  1,000,000, still covers a normal fleet. A segment that runs the budget out is listed with `erased: false` and
  an `error:` note carrying the budget refusal's message, before it deletes anything (the one refusal that can come after a rewrite is
  the last check for a generation a concurrent writer left behind), and the
  scan goes on: the call does not throw for it, so the ledger of the erasures that did happen is not lost. A call
  that listed nothing for such a segment, because the id was in none of its generations, therefore now lists an
  error entry for it. Re-run with a higher `budget`, per call or per store, or `budget: false`.

### Added

- **The guide is split into topic pages, and getting started is the 10-minute path.** The README leads with what the
  library is, a plain definition of segment, generation and pointer, a first run on `MemoryStorage` that can be saved
  and run, and a choice of backend. Getting started goes from install to a bucket, with a glossary. The detail moves
  to new pages in `docs/guide/`: `production.md` (a before-production checklist, with the permissions the library
  issues, the bucket lifecycle rules, and a timeout sample that passes the client to `S3Storage`), `loading.md`,
  `reading.md`, `retention.md`, `encryption.md`, `erasure.md`, `observability.md`, `export.md` and `cost.md`. Each
  page puts what a user does first and the mechanism last. The package READMEs share one template, and
  `site/llms.txt` carries a worked example. The docs also say plainly that the `export-segments` command reads a
  local-filesystem store only, and that an S3, GCS or Azure Blob store exports with `store.exportSegments(sink)`.
- **`IRegistryDriver.delete` takes an optional expected token: `delete(ref, expected?)`.** Without it, nothing
  changes: deleting an absent row is a no-op. With it, the delete lands only while the row still carries that
  token, and otherwise (another token, or no live row) throws `WriteConflictError` and leaves the row, as a
  compare-and-swap does. The memory, local-filesystem and `ObjectStoreRegistry` registries, and so the S3, GCS and
  Azure Blob ones, implement it. **For a third-party registry driver the change is additive:** the parameter is
  optional, so a driver that ignores it still compiles and keeps the unfenced delete. Implement it to make the library's own deletes safe against a concurrent re-create; the
  registry conformance suite now holds every registry to it.
- **The driver ports state the contracts callers rely on, and a conformance suite holds every storage driver to
  them.** `IStorageDriver` and `IRegistryDriver` now say, in their doc comments, the driver kit's header and the
  API reference: `putImmutable` is write-once and throws `WriteConflictError` on a collision; a missing object
  makes `getRange` and `getTail` throw `NotFoundError`; an out-of-range read throws `ValidationError`; `getTail`
  reports the true total size; `delete` is idempotent; `list` is strongly consistent, read-after-delete; a driver
  never replays a conditional write without telling the replay apart, by sending it once or by recognising its
  own write on the read-back; a transient fault is a `TransientError`. The new `storageDriverConformance` suite
  runs each of these against the memory and local-filesystem drivers in the unit suite and the S3 (MinIO), GCS
  (fake-gcs-server) and Azure Blob (Azurite) drivers in the integration suite. A registry fixture whose write lands
  and then fails proves the registry reports that fault and neither retries the write nor reports a conflict.

- **An id-range read: `iterate({ after, through })`, and the same two options on `intersect`, `union`, `andNot` and
  the `*Into` verbs.** A read yields only the ids in `(after, through]`, ascending, and fetches only the chunks the
  range overlaps, on every operand and every `exclude` of a combine, so a keyset page bounded by `through` costs the
  chunks of its window rather than a walk from the first id. The per-op budget is charged once, before the first
  fetch, for every chunk in the range, so with `after` alone it is charged to the end of the segment. Each bound is
  optional and an integer in `0..4294967295`, or the read throws `ValidationError` when first read; `after >= through`
  is an empty read, which fetches nothing. A pinned read fails with `NotFoundError` for any chunk it must fetch from a
  generation that has since been collected, as a full pinned read does. `IdRange` (`{ after?, through? }`) is
  exported, and `BaseCombineOptions` extends it. The `intersect` metrics event, which every combine emits, counts in
  `fetchedChunks` and `skippedChunks` only the chunk keys inside the range.

- **`PinnedAt` names the object a pin holds.** It gains an optional `fingerprint`: the pinned object's size and
  footer checksum, which `seg.pin()` records. `PinnedObject` (`{ version, fingerprint? }`) is exported beside it.
  `CrbmReader` gains `fingerprint`, and `CrbmReader.sameObject(blob, fingerprint)`, which says from one footer's
  worth, with no key, whether the object behind `blob` is the one a fingerprint names. A fingerprint is opaque:
  compare two for equality, and do not parse one.
- **What it saves, and where it doesn't**, a new guide page, `docs/guide/why-cloudbitmaps.md`, and the README now
  opens with the same comparison. It sets CloudBitmaps against an always-on Redis: what each is for, where each
  bill's money goes, what each grows with, and where each costs less, with two charts that `bench/sizing.cjs` draws
  from the estimator, in a light and a dark file each, and `pnpm bench:sizing:check` holds to it, byte for byte.
  It says what the comparison assumes, and how far a Redis bought another way moves the saving: as ElastiCache for
  Valkey, with one replica a shard, or on a reserved term, each priced from the AWS price list the estimator's
  catalogue cites. Bought all three ways, on three years paid upfront, the medium and large deployments' Redis
  costs less than CloudBitmaps. It says where CloudBitmaps loses — small data queried hard, latency, S3's
  per-prefix rate, and overlap — and lists the planned work that addresses them, none of it built yet; the roadmap
  holds the same directions. `pnpm bench:sizing:check` now also refuses, outside the generated regions of a page that
  says its figures are generated, what could be a figure no gate compares: a digit in any form Unicode counts as a
  number, but in a few names, definitions and link targets it lists, such as `us-east-1`; a number word from two up,
  but in a few phrases it lists, such as "the three deployments"; a share or a multiple's sign, a currency sign, and
  any character but plain ASCII, `§` and `—`; HTML, an image, a code fence, or an emoji GitHub shows as a digit; and
  a share, a multiple, a half or a dollar amount in words, in the spellings it knows. It is a check against drift, an
  honest edit that types a figure by hand, and not a bar to one written on purpose in a form it has never seen: on
  those pages it reads no markdown structure, and refuses what it cannot read. It reads the README's section from its
  one `## Why CloudBitmaps` line, and refuses another heading that would show as that one, in markdown or in HTML,
  HTML or a fence above it, and a heading that shows nothing where it ends. It keeps the rest of the README to the
  phrases it lists, each a measurement quoted where it is explained, and refuses a share or a multiple there however
  emphasis, an escape, a link, a footnote, a blockquote's wrap, an invisible character or HTML falls across it; it
  refuses an entity GitHub decodes, a legacy name without its semicolon included, on any page it writes into, and an
  image under `bench/` that a page shows and no generator draws; it holds each region's END marker to ending its
  line; and `scripts/site-figures.cjs` reads `SIZING` markers with the same reader, which takes every comment shaped
  like a marker for one.
- **What it costs at your size**, a new guide page, `docs/guide/sizing.md`. It prices a small, a medium and a
  large deployment with `estimateCost()`, term by term, against the Redis that would hold each one's data, and says
  how much room each has before its bill meets that Redis: illustrative workloads, labelled as such, with every
  dollar figure generated by `bench/sizing.cjs` from the shipped estimator and `pnpm bench:sizing:check` failing CI
  when the page and the estimator disagree. It says what moves the large deployment's bill, the pointer refresh and
  cold intersects, and where a standing cache still wins: a hot path of hundreds of cold intersects a second, and
  the per-prefix request rate S3 documents. There is no latency on it, because none has been measured in-region.
- **The single-bucket bill, measured on AWS.** The calibration harness's first publishable run,
  `2026-09-23-94416`, put the topology that ships on real S3 in `us-east-1` — the registry pointer in the same
  bucket as the data — and the benchmarks page now publishes what it costs. The median cold intersect of two
  500,000-id segments sharing 100 of 1,999 chunks made **206 GETs, $82.40 per million**; with each pointer read
  once, as inside the region, it is expected at 204 GETs, $81.60 per million. Writing and publishing a segment is **2 PUTs and
  3 GETs, $11.20 per million**, pointer included, and $26.20 per million multipart; `store.load()`, which also
  lists and collects, is expected at about twice that, from a test that counts its requests. All 40 cold
  intersects were exact, and each requested only the 100 shared chunks per segment: chunk-skipping, shown on real S3
  at a shape that tests it. The run was driven from a laptop outside the region, so its latency and upload figures
  measured the connection and are not published as the library's. The in-region run is still owed.

  The run's evidence is committed unedited as `bench/calibration/2026-09-23-94416.json`, beside a report that
  explains every figure with a diagram, labels each one measured, derived or expected, and says what the run does
  not establish. A new gate, `tests/docs/calibration-reports.test.ts`, derives every figure from that evidence
  through `bench/lib/calibration-figures.cjs` and holds the report and the benchmarks page's section to it in both
  directions. A missing headline figure fails it, and so does any dollar amount, percentage, duration, byte size,
  bit rate or ratio, or any number written before the request, chunk, id or load it counts, that the evidence cannot
  account for at the precision it is written — or that stands beside the words for another claim, such as the
  expected intersect's cost called measured. It refuses evidence that does not reconcile with itself or that more
  than one commit has touched, and checks the report's bill, its request ledger and its table of cost by overlap
  row by row. `bench/calibration/` has a README of its own, and the directory README gate now lets such a
  subdirectory take one row in its parent's.

  The figure this supersedes, $5.88 per million publishes, left the pointer out: it came from a run that kept the
  pointer in a NoSQL table. The site, both READMEs, `llms.txt` and the roadmap now quote the single-bucket
  figures. `scripts/site-figures.cjs` checks the dollar amounts in `llms.txt`, the READMEs, the roadmap and
  `docs/benchmarks.md` as well as the site's pages, none of which was checked before, and every figure in any
  paragraph, list item or table row on those pages that quotes the run, rates and counts included. It allows the superseded
  figure only on the benchmarks page, which says it is superseded, and either July figure only beside the pointer
  it leaves out. The home page's headline is now the measured cold intersect rather than the July `count()`
  figure.

  Checking the run against the code found that `estimateCost()` under-quoted both operations in this topology;
  it now counts what they send, as the entry under **Fixed** below says. The benchmarks page's claim for the
  estimator is narrowed to what its tests prove: it never quotes fewer chunk reads than the engine makes, and its
  other request counts are held to the engine's.

- **A real-cloud calibration harness for the loaded store** — `pnpm calibrate:aws`. The previous one was
  deleted with the warm tier because it metered a write path through a NoSQL registry that no longer ships,
  which is why load throughput, in-region intersect latency and the single-bucket bill were all listed as owed
  on the benchmarks page. This is the tool that pays them.

  It spends money, so it defaults to a projection that touches nothing, rehearses its workload against MinIO for
  free (the money guards have nothing to guard there, so a rehearsal does not exercise them), and refuses a run
  that cannot state its region, its spend ceiling and its intent separately. The
  guards are pure functions in `bench/lib/calibrate-guards.cjs` with a regression test each, because every one
  is a bug that actually happened — including a `NaN` spend ceiling that silently deleted the bound, and a
  `HeadBucket` 403 read as "absent" for a bucket the caller owned, which in `us-east-1` would have run the
  workload inside a real bucket and deleted it on teardown.

  Its first real run was against a real account from a laptop, and it was more useful for what it exposed than
  for its numbers. Every run now **measures its own distance to the region** and labels latency as in-region or
  network-dominated, because from outside the region a p50 describes internet transit. Intersects are **cold** —
  a fresh store each time, so no cache answers them — and each must return **exactly** the planned ids, count
  and sum, or the run refuses to report a latency. The workload now reproduces the published shape (100 of
  ~2,000 chunks per operand) instead of the three chunks the first run touched, and uploads two segments large
  enough to go **multipart**, which the first run never did. Fetched bytes are split into chunk reads and the
  reader's fixed 256 KiB tail read for the footer and index, which a single "fraction fetched" had merged into a
  misleading 29.8%. `bash bench/calibrate-cloudshell.sh` runs all of it in-region against the published
  packages. A rehearsal writes its own results file, which git ignores, so a plain `git add` cannot commit a
  free run against MinIO as the evidence behind a published figure.

  Fixed before it could matter: **Ctrl-C did not stop a run.** The signal handler printed "tearing down" and
  then did nothing, and since installing a handler replaces Node's default exit, the workload kept spending. It
  now tears down, writes the results — every phase it had finished, and the cost — and exits 130, whichever exit
  path gets there first — proven by interrupting runs mid-load, mid-intersect, twice in quick succession during
  teardown, and inside the new 10-second abort window of a real run.

  Also fixed before it could matter: **the request meter did not count SDK retries.** It sits outside the SDK's
  retry loop, so it counted each call once however many attempts the call took — which undercounts exactly the
  requests a spend ceiling most needs to see. It now reads every attempt from the SDK's own count. The workload
  makes one attempt per request, and the timed intersects run with the store's own read retry off, so the
  projection stays a true upper bound and no retry's backoff lands unseen inside a latency sample. Teardown keeps
  its retries, on a second client metered into the same bill, so a single transient error cannot leave the
  bucket behind — and it now reads only S3's own `NoSuchBucket` as "already removed". It read any 404 that way,
  so an abort retried after a lost answer, which gets back 404 `NoSuchUpload`, made teardown skip the deletes and
  report nothing. Its delete passes are bounded, too: a key that could never be deleted kept it listing, and
  billing, until the process was killed.

### Changed

- **The calibration harness counts what the library does, not what the network does.** Each timed intersect now
  turns off its store's timed pointer refresh (`cache.genTtlMs: 0`). On the default 2 s refresh, an intersect slower than that reads
  each pointer again, so run `2026-09-23-94416` — 83 ms from the region — counted 206 GETs for its median
  intersect, where the same intersect inside the region is expected to make 204, and that used up the projection's
  whole allowance for an intersect. The projection now also allows every pointer read a load can make: three with
  nothing racing it, and up to twelve if every publish attempt loses, where it had allowed one per attempt. Each load
  records its object's size apart from what it uploaded: the harness had recorded the upload, the object plus its
  pointer's 161-byte body, under the object's name.
- **A run's evidence is its own file, and nothing replaces it.** A real run writes `bench/calibration/<runId>.json`,
  where every run used to overwrite one results file. It refuses an id whose evidence exists before it reads any
  credentials, and a run whose name is taken while it runs writes `<runId>.<start>.partial.json` beside it and says
  so. A run that does not finish writes `<runId>.partial.json`, which git ignores and no gate reads. The run id is
  checked before anything uses it, since it names both the bucket and the file: a real date, so that runs sort into
  order, then a label, with none of the suffixes S3 reserves.
- **A calibration run stops cleanly, and leaves nothing behind that it does not report.** A signal now stops the
  workload's client and waits for the requests already sent, before teardown lists anything: teardown used to run
  while loads were still writing, and in two of four rehearsals interrupted during their loads a PUT landed after
  its listing and left the bucket behind. A hang-up, a closed terminal or a dropped session, now tears down like a
  Ctrl-C, where it used to end the run with nothing removed; the harness opens its terminal streams at startup,
  since on macOS Node opening one on a terminal that has hung up never returns. `calibrate-cloudshell.sh` runs the
  harness as a job of its own and passes every signal on to it: a SIGTERM or a closed CloudShell tab used to stop
  the script at once, delete the scratch directory under the harness mid-teardown and copy nothing, and a SIGTERM to
  the script alone never reached the harness. Teardown now lists every upload and object before it touches any, and
  refuses a bucket holding a key the harness did not write; its requests time out rather than hang; a signal during
  `--cleanup` waits for it; and a workload is refused past 500 segments, the most one teardown listing reaches.
  `--cleanup` checks the account pin; a real run is refused outside `us-east-1`, the one region it has prices for;
  error text is printed and stored with ARNs removed and account ids masked; and a harness with uncommitted edits is
  recorded as `-dirty`.
- **The hard RSS ceiling is now a published figure rather than an owed one.** `pnpm rss-gate` records its run
  to `bench/rss-gate-results.json`, and `docs/benchmarks.md` plus the benchmarks page state the ceiling a
  sustained read + combine + re-load workload over 400 segments survives: **384 MiB**, swap disabled, no
  OOM-kill. The gate had been measuring this on every PR and discarding it — the soak inside the container ran
  without `SOAK_INJECT`, so its verdict reached container stdout and nothing else, and the stage directory is
  deleted on exit. What is published is the **ceiling**, not a reader-RSS reading: the ceiling is a property of
  the workload, an RSS number is a property of the machine.

  `docs/benchmarks.md` also gains **What RSS is, and why it is the number we bound** — what resident set size
  actually is, why a JS-heap sample cannot see the roaring addon's off-heap allocations (and so cannot evidence
  the bounded-memory invariant), and why the published figure is a ceiling rather than a reading.

### Fixed

- **`count()` answers from the index, and an open did not check every rule the index must keep.** The per-chunk
  cardinalities the `.crbm` index records are summed with no payload decoded, so a corrupt index changes the answer
  where `iterate()` and the combines, which decode the payloads, return what the payloads hold. An open already refused a key that
  repeats, falls out of order or passes `0xffff`, a cardinality outside `1..65536`, an empty or oversized payload,
  and, on an unencrypted object, a footer chunk count or total that disagrees with the index. It now also refuses an
  entry whose payload runs into the index rather than ending where the index starts, and an encrypted entry too short
  for its nonce and tag (see **Breaking**), once per open and never per call. A corrupt index that is still
  internally consistent still yields a wrong count, and that is now stated where `count()` is described: the guide,
  the API reference, the README, `SECURITY.md` and the TSDoc. The same index feeds a load's `cardinalityBefore` and
  the chunk keys an `intersect` plans from. `iterate()` the segment where the count must be confirmed against the
  payloads.
- **A rollback whose undo failed said the pointer "could NOT be put back", which it could not know.** When the
  target generation was collected while the pointer moved, the rollback swaps the pointer back and throws. If
  that swap threw, the message stated that the pointer still named the missing generation, but a swap that
  applied and lost its response also throws, and then the pointer is already back. The message now says the pointer
  *may* still name it, and the recovery guide says to check which generation is current before acting.
- **An erasure whose sweep of the other generations found an object gone threw a bare `NotFoundError` where the
  pointer had moved.** When the id was not in the current generation, the sweep's rejection bypassed the handler
  that re-reads the row and reports `reason: 'superseded'`, so a storage driver that signals a missing object
  from `delete` could turn a lost race into an error. It now reports `'superseded'`, and still throws when the
  pointer has not moved, because the object is then genuinely absent.
- **A throwing `retry.onRetry` hook replaced the read's error and stopped the retry.** The hook is observability,
  so an error it throws is now swallowed: the retry goes on, and the read fails with its own error, as the option
  documents.
- **`subjectReport` could miss a load or an erasure made by another process.** The access report read through the
  store's cached generation, which can be up to `cache.genTtlMs` behind the registry, and never catches up with
  `genTtlMs: 0`. It now compares each listed segment's row (its generation and its token) with the version the
  store holds, and re-resolves only a segment that differs, so a report sees another process's change at once,
  including a segment retired, purged and loaded again from generation 0, and costs no extra read when nothing
  moved.
- **The retention sweep's row deletes could tombstone a row created after the sweep decided to delete.** The
  tombstone purge decided from the row it scanned, which can be minutes old on a large fleet, and then deleted
  whatever was under the name, so a segment purged and re-created in that window, which is live data, was tombstoned
  and its name fenced. The purge now deletes with the scanned row's token and reports the entry as
  `failed: contended` when the row has changed. The removal of the row of a segment that held nothing now reads the
  row it tombstoned and deletes it only while it is still that `destroyed` row, at that token. A delete the row refuses leaves it, and the entry stays `retired`.
- **A failed pointer refresh served the old generation, and the key it unwrapped, for as long as the registry
  stayed unreadable.** A reader that could not re-read a segment's pointer kept its reader and stamped it fresh,
  so during a registry outage, or after an access denial, a crypto-shredded or dropped segment could keep
  answering well past the `cache.genTtlMs` that `PRIVACY.md` states. Only a transient fault is ridden out now, and
  the bound has the shape the privacy note gives: while the registry cannot be read, a reader keeps serving the
  generation it had, retrying the refresh after 500 ms (never longer than `cache.genTtlMs`) and at most once per
  segment at a time; any other error reaches the reader. Reads inside the TTL, and the one registry read a refresh
  makes, are unchanged.
- **Two local-filesystem backends on one root in one process could both advance a registry row from the same
  token.** The row's compare-and-swap was serialized by a lock each `LocalFsStorage` (or
  `LocalFsRegistryDriver`) kept for itself, so two instances on one root, or a store and a CLI call in one
  process, could both read token T, both pass the check and both return T+1 for different writes.
  That broke the token's promise never to be reused and the erasure's `expectFrom` fence: an erasure's
  collection with `keep: 0` could delete a generation whose load had reported `published: true`. The lock is
  now one per row for the whole process, keyed by the row's resolved path, so a root reached through a symlink
  or a relative path takes the same lock, and an entry lives only while an operation on its row is in flight.
  A root is for one process: two processes on one root are still not fenced, and the guide and the API
  reference now say so.
- **`purgeTombstones: false` kept every tombstone but one.** The option's contract is that the sweep deletes no row
  of a retirement it made, yet a retired segment that held nothing (a `setRetention` on a name that was never
  loaded, or a mistyped one) had its row deleted in the same pass whatever the option said. With `false` that row
  now stays, stamped like the sweep's other tombstones, so a later sweep with purging on deletes it once
  `tombstoneGraceMs` has passed. While it stays it fences the name against every writer, as a kept tombstone does.
  The ledger entry and the `segment.dispose` event are the same either way, and a later sweep with purging off
  skips the row without re-processing it. The default, `purgeTombstones: true`, deletes the row as before. A
  caller that passes `false` and relied on an empty segment's name being free again after the sweep must pass
  `true` for the sweep that should free it.
  With the default, an empty segment's row that the sweep could not delete (a registry fault) is stamped and kept
  too, where it stayed unstamped, which no sweep would ever purge; a later sweep now deletes it after the grace period.
- **A subject erasure could report `erased: true` while another generation of the segment still held the id.**
  `PRIVACY.md` promises that an `erased: true` entry means the id is physically gone from every generation that
  held it. Three cases broke that promise:
  - **Several holders above the pointer, after a `rollback`.** The erasure searched the other generations newest
    first, deleted the first one holding the id and stopped, so an older one stayed in the bucket, one
    `rollback({ allowForward: true })` from being served again. It now reads every generation above the pointer
    and deletes each one that holds the id, re-reading the row before each delete and stopping if the pointer has
    moved. When the current generation does not hold the id, the generations up there that never held it stay as rollback targets.
  - **A `rollback` onto a holder between a rewrite's publish and its collection.** Collection stopped at the lower
    pointer, so the entry said `erased: true` while the segment served the id from the generation rolled back
    onto. The call now throws `WriteConflictError`, which `eraseSubject` records as an `error: …` entry, and a
    re-run erases the id.
  - **Two erasures of different ids racing on one segment.** When the loser took its generation number after the
    winner's object was in the bucket, its refused rewrite sat above the winner's pointer, still holding the
    winner's id, because it was derived from the generation the winner replaced. The loser now deletes it before
    it returns `superseded`.

  An entry says `erased: true` only after the call has listed the bucket and read every generation it has not
  already seen without the id. That adds one `list` to each erasure that succeeds, on the erasure path only;
  reads are unchanged. A `rollback` that lands while the call deletes generations above the pointer is reported as
  `reason: 'superseded'` (`note: 'superseded'` in the ledger). `EraseIdResult.collected` then lists every holder
  the call deleted, and `fromGeneration` names the newest of them.
- **A chunk payload listing its roaring containers out of order read as ids the segment does not hold.** The 16-bit
  range check on a chunk reads `maximum()`, which roaring answers from the last container, and the native deserializer
  accepts containers in any order. So a payload with container 1 before container 0 passed the check, and `iterate`
  and every combine yielded container 1's values masked into the chunk: ids `has()` denied, and missing
  from a range read over the same ids. The native deserializer bounds its reads and checks nothing else —
  CRoaring leaves the rest to its caller, and `roaring` never does it — so the same gap took more shapes: values or
  runs out of order, listed twice or overlapping, which `has()` denied and `size` counted twice; a run past the end of
  its container, which wrapped `maximum()` past the range check the same way; a run container with no runs, which
  crashed the process when iterated, intersected or unioned; and a bitset whose header understated its bits, whose
  `remove()` overflowed the native heap. An erasure over such a chunk reported `erased: true` and carried the
  corruption into the generation it wrote. `SafeBitmap.safeDeserialize` now checks the structure before the native
  addon sees the bytes and refuses each of these with `IntegrityError` (see **Breaking**). The check runs once per
  chunk fetched, never per id or on a cache hit, and costs a third to a half of the CRC32C the `.crbm` reader already
  computes over the same payload: about 0.7 µs for a 2 KB chunk and 2.5 to 3.2 µs for an 8 KB one, measured on an M3
  Pro.
- **`store.checkConsistency` told a caller to raise an option it does not take.** Past its ceiling of 250,000
  registry rows its `BudgetExceededError` said to raise `maxScanSegments`, which `store.checkConsistency` does not
  take, though `runConsistencyCheck` does. It now names `runConsistencyCheck`, over the backend's `storage` and
  `registry`, as the call that raises it, beside narrowing the scan with `namespace`.
- **`store.rollback(ref, generation, { allowForward: true })` did not compile.** Its options type took `audit`
  alone, though the call passed `allowForward` through to `rollbackSegment` and the docs showed it for undoing a
  rollback. The type now takes `allowForward`, as `rollbackSegment`'s does.
- **A conditional write that landed and lost its response was reported as a conflict, on S3 and on GCS.** Each SDK
  sends a request again when its response does not arrive, after a timeout, a reset connection or a 5xx, and a
  conditional write sent again meets the one that landed and fails its own precondition. So a load reported
  `published: false, reason: 'superseded'` for a generation it had just made current, and collected nothing; an
  `*Into` verb threw `WriteConflictError` for a generation that was current; a load whose write-once put landed
  reported that nothing was written, and left the object above the pointer; `rollback` threw `WriteConflictError`
  after moving the pointer; and a crypto-shred reported `cryptoShredded: false, reason: 'already'`, and emitted no
  `segment.erase` event, for a shred that had happened. The S3 driver now sends each conditional write once: it
  replaces the client's retry step for that one command, so a client you pass, whatever its retry strategy or
  `maxAttempts`, is otherwise unchanged. The GCS driver uploads the registry's rows, and objects up to
  `simpleUploadThresholdBytes`, as one request with no retry loop around it, where `file.save()` wrapped the same
  request in one. Tests drive both drivers through the real SDK, over a stub transport that applies a write and then
  drops its response; each failed before the fix. Azure Blob and a GCS object above the threshold have no per-request
  switch, and the next entry says how they tell a replay from a lost race.
- **On Azure Blob, and on GCS for an object above `simpleUploadThresholdBytes`, a conditional write that landed and lost
  its response was reported as a conflict.** The Azure SDK takes its retry policy from the client, and a GCS
  object above the threshold uploads as a resumable session that the SDK retries within, so neither has a
  per-request switch to turn the retry off. The write sent again met the one that landed, and the answer, a 409
  or 412, reached the same wrong outcomes as on S3: a load reporting `superseded` for a generation it had made
  current, an `*Into` verb or `rollback` throwing `WriteConflictError` after the write, a crypto-shred reporting
  `already`. Each such write now tags its blob or object with a random id in its metadata, outside the `.crbm` bytes and
  outside the registry row's body, so neither format changes. When the write reports a conflict, the driver reads
  the stored copy back, one metadata read, and reports success when it carries the write's own id and
  `WriteConflictError` otherwise. The read is made only on a conflict, and it works with a client you pass. A
  generation's `.crbm` object is never overwritten, so its read-back is definitive. A registry row is
  overwritten by compare-and-swap, so a writer that swaps in over a write that landed, before the read-back, makes
  that write report `WriteConflictError`. The callers re-read or report it, and none deletes a generation on it: a load's cleanup
  removes its generation only while the row's token is still the one it started from, which the write it landed has advanced. A read-back that fails transiently throws `TransientError`, neither a success nor a
  conflict.
- **`PRIVACY.md` said subject erasure is physical on return for more segments than it is.** Its table row, and
  the copy npm ships in `@cloudbitmaps/roaring`, said "on return" holds for every segment whose ledger entry is not
  `error: …`. An entry can also say `erased: false, note: 'superseded'`, when a racing writer overtook the rewrite:
  no error, and the id may still be in that segment. The row now says "on return" holds for every segment whose
  entry says `erased: true`, as the detailed text further down already did. `eraseSubject`'s doc comment also said
  that after a collection fault a re-run reports nothing for the segment, leaving the old generation to
  `gcOrphanGenerations` or a sweep; a re-run searches the superseded generations and collects it, as
  `SubjectErasureEntry.note` says.
- **`LoadOptions.keep`'s doc said a wider window "buys nothing a pinned read would not do better".** A pin is never
  re-resolved, so a pinned read fails with `NotFoundError` once its generation is collected, and for a job pinned
  across loads `keep` is what keeps it readable. The doc now says so, and getting-started's "Sizing `keep`" table
  has a row for a long job on a pinned handle: keep at least one generation for every one that can be written above
  the pinned one while it runs, on every writer that loads the segment.
- **A load that lost its generation number to another load emitted no audit event.** Every other refusal emits
  `segment.load-refused`, and this one reported `reason: 'superseded'` to the caller alone, so an audit trail could
  not tell the replacement it asked for had not happened. It now emits `segment.load-refused` with `reason:
  'superseded'` and `cardinality: 0`, since it wrote nothing.

- **A pinned handle could read chunks of another generation than the one it pinned.** A live read of the same
  segment on the same store cached each chunk it fetched under the version it had resolved when it began — but if,
  before the fetch, a publish had landed and `cache.genTtlMs` had lapsed, the reader cache had evicted the segment,
  a sweep had made the read heal forward, or the store had invalidated the segment (its own `load`, `rollback` and
  erasure do), the chunk came from another generation, and was cached under the key of the one the read began on. A
  handle pinned at that generation read the same key, so it was handed the other generation's chunk: its
  `iterate()` mixed two generations while its `count()` still reported the pinned one's total, and, after a sweep
  had collected its generation, a pinned `has()` answered from the newer one where it should have failed. A pinned
  handle now caches its chunks under keys of its own, which no live read writes, and fills them only from the object
  it pinned. Live reads make no extra call for it. What it costs:
  - a pin pays one GET for a chunk that a live read of its generation had already cached, which it used to share;
  - a pin's entries share the chunk cache's bound with the live ones, so under a small `cache.maxChunks` each can
    evict the other;
  - a pin whose generation has been swept now fails even for a chunk a live read had cached from it, where it could
    answer from that entry before.

  Unpinned reads were not affected: every way the library moves a read to another generation also makes it the one
  later reads resolve. Six tests reproduce it, across `iterate`, `intersect` and `has` and all four ways a read can
  move to another generation, and each failed before the fix.
- **A combine that held one segment at two generations answered for one of them.** One call reads a segment at one
  generation, and a combine keyed its pins by segment, so `snap0.andNot([snap1])` — the difference between two
  snapshots of one segment — returned no ids at all, and `live.andNot([snap])` read the live handle at the pin. Such
  a combine is now refused with `ValidationError`, pointing at `intersectInto(dest, [])` to materialise one side
  first. So is one holding two pins of one generation number that are two different objects; two pins of one object
  combine as before. The refusal comes when the combine is read, as its other errors do, and before an `*Into`
  materialisation reads anything; a combine with no pin in it checks nothing. It includes `live.intersect([snap])`
  when nothing has moved since the pin, which answered correctly by chance and now throws.
- **A pin held across a purge and re-load read the new segment as its own.** A name purged and loaded again starts
  again at generation 0, and a pin knew its object only by generation number, so a pin of the old segment opened the
  new one's object of the same number. Once its reader was evicted, its `count()` gave the new total while
  `iterate()` returned chunks of both; while the reader stayed open, its uncached chunks failed with an
  `IntegrityError` that read as damage, or a `ValidationError` when the new object was smaller; and on a store with
  no registry, a new pin of the name was handed the old
  pin's reader and cached chunks. `pin()` now records the object it pins, its size and footer checksum, and a pin
  reads that object only: what it has already read still answers, as the instant it pinned, and anything it would
  have to fetch from a replaced object fails with `NotFoundError`, as a swept pin's does. A pin tells a replacement
  from damage by reading the object's footer, which needs no key; an object of another size counts as another
  object, damaged or not. A replacement written under a key the store lacks is therefore found too, including after
  the pin's reader was dropped. The reads that ask at once share that footer read, and once found, a replacement
  costs later reads no request until the store forgets it: an invalidation of the pin's segment does, as does a later
  `pin()` of the same version that opens the pinned object again, and the store remembers at most `cache.readerMax`
  of them. So once a restore puts the object back, invalidate the pin's store: the pin then reads it again, and a
  pin taken after that reads the object then stored as its generation. An object found gone is not remembered,
  since a 404 can pass. Two pins of one generation number in two incarnations never share a reader or a cached
  chunk, with a registry or without one.
- **A pin whose segment was dropped or destroyed went empty part-way through a read.** A pinned `iterate()` that
  straddled `dropSegment` on its store returned the ids it had read so far and stopped, with no error, and its
  `count()` then said 0. A pin describes one instant, so its read of a segment whose row is gone or destroyed now
  fails with `NotFoundError`. A pin keeps the key its reader unwrapped while that reader stays open, and answers from
  the chunks it decoded while they stay cached. The pin's own store invalidates it:
  - a `load`, a `rollback` or an `*Into` invalidates a pin of the segment it writes;
  - `dropSegment` invalidates a pin of the segment it drops, and `retireExpired` a pin of each segment its ledger
    lists, retired or not, neither on a dry run;
  - `eraseSubject` invalidates a pin of each segment it scans that is not already destroyed.

  An invalidated pin opens its object again, and fails if that object is gone or replaced, or its row is gone or
  destroyed.
  Anything else leaves the pin as it is: after a `destroySegment` beside the pin's store, or an erasure, a drop or a
  retirement through another store, in the same process or another, the pin answers from what it holds until its
  store's reader cache evicts the pin's reader and the store's chunk cache evicts the chunks the pin decoded, or
  `invalidate()` is called on the pin's store. Where the object the
  pin reads has been deleted, by an erasure, a drop or a sweep, a chunk the pin has not cached fails at once. The
  privacy notes now say so.
- **Pinned reads were not retried.** A pinned handle's engine read the storage source directly, so a transient fault
  that a live read retries failed a pinned read, and every live operand of a combine that included a pin. Pinned
  reads now go through the store's retries, and so does `pin()`'s own read of the row. `pin()` also opens the pinned
  generation's reader as it pins, and reads the row once to do both; opening a pinned generation read the row twice.
  With a registry, pins of one generation taken while its row is unchanged share that reader while the store keeps
  it open, as they did before, pins taken at the same moment included, so only the first costs a tail read, and a
  key unwrap for an encrypted segment, even if it is never read. Without a registry every `pin()` lists the segment's
  objects and makes the tail read, since only the object can tell two incarnations of a name apart there.
  A `pin()` whose generation is swept before it can
  open it, as a publish and a `keep: 0` sweep can do, pins the generation current then rather than fail.
- **A store read its own materialisation's predecessor.** `intersectInto`, `unionInto` and `andNotInto` published a
  new generation of `dest` without dropping what the store held of the old one, so the same store went on answering
  from the old generation: until `cache.genTtlMs` lapsed, and indefinitely with no timed refresh. They now
  invalidate `dest` as `load()` does, and what that costs a pin is what a `load()` costs it: a pin of `dest` on the
  same store drops its open reader and decoded chunks at each of them, one its guard refuses included, and reads
  them again. If that call's `keep` collected its generation, it then fails even for a chunk it had read.
- **A cold `has()` could fail with `NotFoundError` when a publish and a `keep: 0` sweep landed as it began.** Before
  it fetches a chunk, a read looks up each operand's version, and that lookup did not heal a swept generation the
  way a chunk fetch and `currentGeneration()` do. `count`, `iterate` and `intersect` survived the same race, since
  their index read heals first; a `has()` failed. Id erasure passes `keep: 0`, so its sweep can land microseconds
  after the publish. The lookup now re-resolves once and reads the newer generation; a second miss still fails the
  read, as it does everywhere else.
- **A generation whose footer names another generation is refused.** Every writer stamps a generation's footer with
  its key's number, and the chunk cache is keyed by it, so an object that disagrees — written under another key, or
  altered — now fails with `IntegrityError` wherever it is opened: by a read, a pin, the load guard, the erasure
  rewrite and its search of superseded generations, and a write's re-read of what it wrote. It was read as the
  generation its footer claimed, and the erasure rewrite republished its content. A default load onto a segment
  whose current generation is misfiled now fails in its guard: roll the segment back to an earlier generation that
  opens, or load with `allowEmpty: true` and no `guard.minRetained`, which then does not read the current
  generation. Such an object was written under one generation and stored under another, and was never a valid
  object.
- **`estimateCost()` counts the pointer, the index and the pointer refresh, which it had left out.** On a
  single-bucket store, the topology that ships, it under-quoted two of the operations it prices: a load as its object's
  PUT-class requests alone, and an intersect as its chunk reads alone.
  - **A load** now adds what `store.load()` makes around the object's write — two listings and the pointer's
    write, and nine GETs — so a single-part load prices at about $23.60 per million at the default rates, where it
    had been quoted at $5.
  - **A cold intersect** adds a pointer read and an index read for each operand (`operandsPerIntersect`, 2 by
    default, `exclude` operands included), so two segments sharing k chunks price at 4 + 2k GETs.
  - **A new term prices the pointer refresh**: `hotSegments`, the segments each long-lived reader keeps reading,
    in each of `readerProcesses` readers, each re-reading its pointer at most every `genTtlMs` (the store's
    `cache.genTtlMs`, 2 s by default), and the term at most once a point read: about $0.53 a segment a month. It is
    reported as `byOp.pointerRefresh`, disclosed in the notes when a report prices point reads without it, and taken out of the read
    crossover's baseline when it is. `segment.costReport()` prices it at the store's own TTL.
  - **GCS and Azure Blob** read an object's metadata before its bytes, so a pointer read or a tail read is two
    requests there, where it is one on S3. A pricing profile's new `storage.requestsPerSizedRead` (1 by default;
    set it to 2 for those two) doubles those reads.

  `chunksPerIntersect` and `requestsPerLoad` keep the meaning they had in `0.10.0`, the chunks an intersect fetches
  and the object's own PUT-class requests: if you followed the docs' and the site's advice, between the
  single-bucket run's publication and this fix, to fold the pointer into them, pass the plain counts again. Each
  count the estimator adds is held by a test to the requests the real engine makes. What this changes in the
  report's type and text is under **Breaking**.

## [0.10.0] — 2026-09-21

The loaded store. A segment is a set of write-once `.crbm` generations in object storage behind one registry
pointer. Data enters by loading a whole new generation, and a read resolves one generation and fetches only the
chunks it needs.

- **Five packages, versioned together.** `@cloudbitmaps/roaring` is the codec and the `CloudRoaring` store;
  `@cloudbitmaps/s3`, `@cloudbitmaps/gcs` and `@cloudbitmaps/azure-blob` are one storage service each, depending on
  its SDK. `@cloudbitmaps/core` arrives transitively, and `@cloudbitmaps/core/driver-kit` is the contract a driver
  package builds against.
- **One backend per service, carrying both halves.** `MemoryStorage`, `LocalFsStorage`, `S3Storage`, `GcsStorage`
  and `AzureBlobStorage` each keep the generations and the registry pointer in the same store, so a deployment needs
  one bucket and no second database.
- **Loading, `store.load()`.** It takes the next generation number, writes one immutable object, refuses an empty
  result over a non-empty segment, publishes it, and collects the generations the publish superseded, keeping one
  by default. The `*Into` verbs write through the same path and the same empty-result guard, but collect nothing
  unless given `keep`. A subject erasure publishes only over the generation it read, and collects with `keep: 0`.
- **Reads.** `has`, `count` (summed from the index, with no payload reads), `iterate`, chunk-skipping `intersect`
  with `exclude`, `union` and `andNot`; and `intersectInto`, `unionInto` and `andNotInto`, which write their result
  as a new generation of a destination, under the same empty-result guard as a load.
- **`segment.pin()`** holds a segment at one generation for the life of a handle.
- **Options** `storage`, `metrics` and `budget`, and four groups: `cache`, `encryption`, `retry` and `seams`.
- **Lifecycle.** `rollback`, `generations`, `exists` and `segments`; retention with `setRetention` and the
  `retireExpired` sweep; `dropSegment`; subject erasure with `eraseSubject` and `subjectReport`; `exportSegments`;
  and `checkConsistency`.
- **Encryption at rest** (AES-256-GCM, with envelope keys from a keystore you hold) and crypto-shred.
- **Cost.** `CloudRoaring.estimateCost()` for planning, and `segment.costReport()` from a segment's real size.
- **ESM only, Node ≥ 22.12.**

<!-- New work goes under [Unreleased] at the top. -->
