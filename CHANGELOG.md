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

The first two remove exports. The next eight make a call throw where it used to return: six of them fix a wrong
answer, and the entries under **Fixed** say what the call returned before; two hold a call to a rule the rest of
the library already kept. The five after them hold the store, the backends and the registry to what the library
itself takes and writes, stop checking for a local store's older directory layout, and give its errors the
library's own brand. The last two change what `estimateCost()` compares with and what a `CostReport` carries.

- **`RetryingStorageDriver` and `RetryingRegistryDriver` are no longer exported**, from `@cloudbitmaps/core` or
  `@cloudbitmaps/roaring`. Nothing in the library used them. The store's read retry is unchanged: every read of
  segment data goes through `RetryingStorageChunkSource`, which stays exported, with `RetryingOptions`, `withRetry`
  and `DEFAULT_RETRY_POLICY`, and the store's `retry` option is unchanged. The two removed wrappers retried every call of the driver they
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
  `@cloudbitmaps/roaring`. Load with `store.load(ref, ids, options)`, or `loadSegment(ref, ids, deps, options)` where
  you wire the drivers yourself. Either takes the next generation number itself and publishes, and returns a
  `LoadResult` whose `published` says whether the load took effect, where the removed result said `becameCurrent`.
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
    generation number from the caller.** `writeCrbmGeneration` and `publishGeneration` still do each of those, from bitmaps.
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

The first three of these make the library refuse what it used to ignore or accept, so that a wrong input fails
where it is written. The fourth drops the check for a local store's older directory layout, and the fifth renames
the error brands:

- **`new CloudRoaring(options)` refuses every key it does not take**, at the top level and inside `cache`,
  `encryption`, `retry`, `budget` and `seams`, with a `ValidationError` naming each one and the keys the store or
  the group takes. It refused a fixed list of spellings before, and ignored any other key. A group that is not an
  object is refused too — `null`, an array, a Map, a boxed primitive, `encryption: true` — and `false` is taken
  only by `retry` and `budget`.
- **`new S3Storage(options)`, `new GcsStorage(options)` and `new AzureBlobStorage(options)` refuse every key they do
  not take** the same way, and an options bag that is not an object. `GcsStorage` refused only `storage` before,
  and the other two ignored any key they did not take.
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

### Added

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
  drops its response; each failed before the fix. Two paths are unchanged: Azure Blob, whose SDK takes its retry
  policy from the client and has no per-request switch, and a GCS object above the threshold, which uploads as a
  resumable session that the SDK retries within.
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
